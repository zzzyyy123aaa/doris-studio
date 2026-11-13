import { ApiError, publicError } from './errors.mjs';
import { metricsUrl, parseLegacyFeMetrics, readDorisHttpText } from './doris-metrics.mjs';

const queryOptions = { maxRows: 4096, timeoutMs: 5_000 };

function fieldText(value) {
  return String(value ?? '').trim();
}

function flag(value) {
  const text = fieldText(value).toLowerCase();
  if (['true', '1', 'yes'].includes(text)) return true;
  if (['false', '0', 'no'].includes(text)) return false;
  return null;
}

function portNumber(value) {
  const text = fieldText(value);
  const number = Number(text);
  return /^\d+$/.test(text) && number >= 1 && number <= 65535 ? number : null;
}

function percentage(value) {
  const match = /^(\d+(?:\.\d+)?)\s*%?$/.exec(fieldText(value));
  if (!match) return null;
  const number = Number(match[1]);
  return number <= 100 ? number : null;
}

function commonNode(fields, { id, role, port }) {
  return {
    id: fieldText(fields[id]),
    host: fieldText(fields.host),
    role: fieldText(fields[role]),
    port: portNumber(fields[port]),
    httpPort: portNumber(fields.httpport),
    alive: flag(fields.alive),
    lastStartTime: fieldText(fields.laststarttime),
    lastHeartbeat: fieldText(fields.lastheartbeat),
    version: fieldText(fields.version),
  };
}

function frontend(fields) {
  return {
    ...commonNode(fields, { id: 'name', role: 'role', port: 'queryport' }),
    leader: flag(fields.ismaster),
    joined: flag(fields.join),
  };
}

function backend(fields) {
  const tablets = fieldText(fields.tabletnum);
  return {
    ...commonNode(fields, { id: 'backendid', role: 'noderole', port: 'heartbeatport' }),
    decommissioned: flag(fields.systemdecommissioned),
    tablets: /^\d+$/.test(tablets) ? tablets : null,
    diskUsed: fieldText(fields.datausedcapacity),
    diskTotal: fieldText(fields.totalcapacity),
    diskUsedPercent: percentage(fields.usedpct),
    diskMaxUsedPercent: percentage(fields.maxdiskusedpct),
  };
}

async function readNodes(client, type, sql, formatNode) {
  let readingNodes = false;
  try {
    const result = await client.withConnection(async (run) => {
      // Doris formats SHOW heartbeat strings using this connection's session time zone.
      await run("SET SESSION time_zone = 'Asia/Shanghai'", queryOptions);
      readingNodes = true;
      return run(sql, queryOptions);
    }, undefined, { discardAfterUse: true });
    if (result.truncated) throw new ApiError(422, '节点信息超过显示上限。');
    const columns = new Set(result.columns.map((name) => name.toLowerCase()));
    if (!columns.has('host') || !columns.has('alive')) {
      throw new ApiError(422, 'Doris 返回的节点信息缺少地址或在线状态字段。');
    }
    const nodes = result.rows.map((row) => {
      const fields = Object.fromEntries(Object.entries(row).map(([name, value]) => [name.toLowerCase(), value]));
      return formatNode(fields);
    });
    return { nodes, error: null };
  } catch (error) {
    const failure = publicError(error);
    if (readingNodes && failure.status === 403) {
      if (error?.code === 'ER_SPECIFIC_ACCESS_DENIED_ERROR' && /\bADMIN\s*\/\s*OPERATOR\b/i.test(error.message)) {
        return { nodes: [], code: 'legacy-permission',
          error: `此 Doris 版本的 ${sql} 需要全局 ADMIN_PRIV 或 NODE_PRIV。` };
      }
      return { nodes: [], code: 'permission', error: `当前 Doris 账号无权执行 ${sql}，请让管理员核对该版本的节点查询权限。` };
    }
    return { nodes: [], error: `读取 ${type} 节点失败。${failure.message}` };
  }
}

function backendSummary(online, total, source) {
  if (!Number.isSafeInteger(online) || !Number.isSafeInteger(total) || online < 0 || total < online) return null;
  return { online, total, unknown: 0, source };
}

async function readBackendHealth(base, request) {
  try {
    const text = await readDorisHttpText(new URL('/api/health', base), undefined, request, 16 * 1024);
    if (text === null) return null;
    const result = JSON.parse(text);
    if (result?.code !== 0) return null;
    return backendSummary(result.data?.online_backend_num, result.data?.total_backend_num, 'fe-health');
  } catch {
    return null;
  }
}

async function readLegacyFe(base, request) {
  try {
    const text = await readDorisHttpText(base, undefined, request);
    return text === null ? null : parseLegacyFeMetrics(text);
  } catch {
    return null;
  }
}

export async function readClusterStatus(client, { host, request = fetch, includeMetrics = false } = {}) {
  const [frontends, backends] = await Promise.all([
    readNodes(client, 'FE', 'SHOW FRONTENDS', frontend),
    readNodes(client, 'BE', 'SHOW BACKENDS', backend),
  ]);
  const feDenied = frontends.code === 'legacy-permission';
  const beDenied = backends.code === 'legacy-permission';
  const base = host && (feDenied || beDenied) ? metricsUrl({ host, httpPort: 8030 }) : null;
  let feMetrics;
  if (base) {
    const [metrics, health] = await Promise.all([readLegacyFe(base, request), beDenied ? readBackendHealth(base, request) : null]);
    if (feDenied && metrics) {
      const { frontendTotal, qps, latencyMean, memoryUsage } = metrics;
      if (frontendTotal !== null) frontends.summary = { online: null, total: frontendTotal, unknown: frontendTotal, source: 'fe-metrics' };
      if (includeMetrics) feMetrics = { qps, latencyMean, memoryUsage };
    }
    if (beDenied) {
      const summary = health || backendSummary(metrics?.backendOnline, metrics?.backendTotal, 'fe-metrics');
      if (summary) backends.summary = summary;
      else backends.error += '暂未取得 BE 在线数量，可检查 FE 默认 HTTP 端口 8030 的 /api/health。';
      if (metrics?.backends.length && (!summary || summary.total === metrics.backends.length)) {
        backends.nodes = metrics.backends;
        backends.nodeSource = 'fe-metrics';
      }
    }
  }
  return { sampledAt: new Date().toISOString(), frontends, backends, ...(feMetrics ? { feMetrics } : {}) };
}
