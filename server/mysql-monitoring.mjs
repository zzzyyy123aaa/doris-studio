import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createMonitoringHistory } from './monitoring-history.mjs';

const intervalMs = 30_000;
const maxIntervalMs = 90_000;
const statusNames = [
  'Uptime', 'Uptime_since_flush_status', 'Questions', 'Com_commit', 'Com_rollback',
  'Bytes_received', 'Bytes_sent', 'Threads_connected', 'Threads_running', 'Slow_queries',
  'Innodb_buffer_pool_read_requests', 'Innodb_buffer_pool_reads',
];
const variableNames = ['max_connections', 'server_uuid'];
const statusSql = `SHOW GLOBAL STATUS WHERE Variable_name IN (${statusNames.map((name) => `'${name}'`).join(', ')})`;
const variablesSql = `SHOW GLOBAL VARIABLES WHERE Variable_name IN (${variableNames.map((name) => `'${name}'`).join(', ')})`;
const storageSql = `SELECT COUNT(*) AS tableCount, SUM(DATA_LENGTH + INDEX_LENGTH) AS bytes
FROM information_schema.tables
WHERE TABLE_TYPE = 'BASE TABLE'
  AND TABLE_SCHEMA NOT IN ('information_schema', 'mysql', 'sys', 'performance_schema')`;
const emptyMetrics = {
  qps: null, tps: null, connections: null, maxConnections: null, connectionUsagePercent: null,
  threadsRunning: null, slowQueriesPerSecond: null, bufferPoolHitPercent: null, uptimeSeconds: null,
  storageBytes: null, networkBytesPerSecond: null,
  latencyMs: null, cpuPercent: null, memoryPercent: null, diskPercent: null, storageTotalBytes: null,
};
const storageScope = '表大小仅统计当前账号可见的业务表及索引估算值。';

function integer(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value !== 'string' || !/^\d{1,30}$/.test(value)) return null;
  return BigInt(value);
}

function safeNumber(value) {
  return value !== null && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function variables(result) {
  if (result.truncated || !Array.isArray(result.rows)) throw new Error('Incomplete MySQL status response');
  const values = new Map();
  for (const row of result.rows) {
    const fields = Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]));
    if (typeof fields.variable_name === 'string') values.set(fields.variable_name.toLowerCase(), fields.value);
  }
  return values;
}

function delta(current, previous, name) {
  const next = integer(current.get(name));
  const before = integer(previous.get(name));
  return next !== null && before !== null && next >= before ? next - before : null;
}

function rate(current, previous, seconds, names) {
  let total = 0n;
  for (const name of names) {
    const difference = delta(current, previous, name);
    if (difference === null) return null;
    total += difference;
  }
  return Number(total) / seconds;
}

function continuous(current, previous) {
  if (!previous || current.at <= previous.at || current.at - previous.at > maxIntervalMs
    || current.serverUuid !== previous.serverUuid) return false;
  const uptime = delta(current.status, previous.status, 'uptime');
  if (uptime === null) return false;
  const seconds = (current.at - previous.at) / 1000;
  // Uptime also detects a new server whose counters already exceed the old baseline.
  if (Math.abs(Number(uptime) - seconds) > 5) return false;
  const flushed = integer(current.status.get('uptime_since_flush_status'));
  const priorFlush = integer(previous.status.get('uptime_since_flush_status'));
  return flushed === null || priorFlush === null || flushed >= priorFlush;
}

function summarize(current, previous) {
  const { status, settings } = current;
  const connections = safeNumber(integer(status.get('threads_connected')));
  const maximum = safeNumber(integer(settings.get('max_connections')));
  const maxConnections = maximum > 0 ? maximum : null;
  const metrics = {
    ...emptyMetrics, connections, maxConnections,
    connectionUsagePercent: connections !== null && maxConnections !== null ? 100 * connections / maxConnections : null,
    threadsRunning: safeNumber(integer(status.get('threads_running'))),
    uptimeSeconds: safeNumber(integer(status.get('uptime'))),
  };
  const hasBaseline = continuous(current, previous);
  if (hasBaseline) {
    const seconds = (current.at - previous.at) / 1000;
    metrics.qps = rate(status, previous.status, seconds, ['questions']);
    metrics.tps = rate(status, previous.status, seconds, ['com_commit', 'com_rollback']);
    metrics.networkBytesPerSecond = rate(status, previous.status, seconds, ['bytes_received', 'bytes_sent']);
    metrics.slowQueriesPerSecond = rate(status, previous.status, seconds, ['slow_queries']);
    const requests = delta(status, previous.status, 'innodb_buffer_pool_read_requests');
    const reads = delta(status, previous.status, 'innodb_buffer_pool_reads');
    if (requests > 0n && reads !== null && reads <= requests) {
      metrics.bufferPoolHitPercent = 100 * Number(requests - reads) / Number(requests);
    }
  }
  return { metrics, hasBaseline };
}

function alertValues(current) {
  const { qps, connectionUsagePercent, threadsRunning, slowQueriesPerSecond } = current;
  return { qps, connectionUsagePercent, threadsRunning, slowQueriesPerSecond };
}

export function createMysqlMonitoring({ client, directory, clusterKey, onSample, now = Date.now }) {
  const namespace = createHash('sha256').update(`mysql:${clusterKey}`).digest('hex').slice(0, 24);
  const history = createMonitoringHistory(directory ? join(directory, namespace) : '');
  let timer;
  let pending;
  let pendingAlert;
  let closed = false;
  let previous;
  let snapshot = { sampledAt: null, sourceStatus: 'unavailable', message: '正在等待首次 MySQL 采样。',
    metricScope: 'mysql', current: { ...emptyMetrics } };

  function notify(next) {
    if (!onSample || pendingAlert) return;
    pendingAlert = Promise.resolve().then(() => onSample(next, alertValues(next.current)))
      .catch(() => {
        // Alert delivery and persistence must not stop database sampling.
      }).finally(() => { pendingAlert = undefined; });
  }

  async function readStatus() {
    return client.withConnection(async (run) => {
      const status = variables(await run(statusSql, { maxRows: statusNames.length, timeoutMs: 4_000 }));
      const at = now();
      let settings = new Map();
      if (closed) return { status, settings, at, serverUuid: null };
      try {
        settings = variables(await run(variablesSql, { maxRows: variableNames.length, timeoutMs: 3_000 }));
      } catch {
        // Preserve status values when global variables cannot be read.
      }
      const uuid = settings.get('server_uuid');
      const serverUuid = typeof uuid === 'string' && uuid.length <= 128 ? uuid : null;
      return { status, settings, at, serverUuid };
    });
  }

  async function readStorage() {
    try {
      const result = await client.withConnection((run) => run(storageSql, { maxRows: 1, timeoutMs: 3_000 }));
      if (result.truncated || result.rows.length !== 1) return null;
      const fields = Object.fromEntries(Object.entries(result.rows[0]).map(([key, value]) => [key.toLowerCase(), value]));
      return integer(fields.tablecount) === 0n ? 0 : safeNumber(integer(fields.bytes));
    } catch {
      return null;
    }
  }

  async function sample() {
    let sample;
    try {
      sample = await readStatus();
    } catch {
      if (closed) return;
      previous = undefined;
      snapshot = { sampledAt: new Date(now()).toISOString(), sourceStatus: 'unavailable',
        message: '无法读取 MySQL 全局状态，请检查连接和账号的可见范围。',
        metricScope: 'mysql', current: { ...emptyMetrics } };
      notify(snapshot);
      return;
    }
    if (closed) return;
    const { metrics, hasBaseline } = summarize(sample, previous);
    metrics.storageBytes = await readStorage();
    if (closed) return;
    const issues = [];
    if (!hasBaseline) issues.push('正在建立采样基线，速率指标需要连续两轮有效采样。');
    if (['connections', 'maxConnections', 'connectionUsagePercent', 'threadsRunning', 'uptimeSeconds']
      .some((name) => metrics[name] === null)) issues.push('部分连接或运行状态指标未返回。');
    if (hasBaseline && ['qps', 'tps', 'networkBytesPerSecond', 'slowQueriesPerSecond']
      .some((name) => metrics[name] === null)) issues.push('部分速率计数器缺失或已重置。');
    if (['innodb_buffer_pool_read_requests', 'innodb_buffer_pool_reads']
      .some((name) => integer(sample.status.get(name)) === null)) {
      issues.push('InnoDB 缓冲池指标未返回。');
    }
    if (metrics.storageBytes === null) issues.push('当前账号可见表的大小暂不可用。');
    const available = ['connections', 'threadsRunning', 'uptimeSeconds'].some((name) => metrics[name] !== null);
    snapshot = {
      sampledAt: new Date(sample.at).toISOString(), sourceStatus: available ? issues.length ? 'partial' : 'ok' : 'unavailable',
      message: [...issues, storageScope].join(' '), metricScope: 'mysql', current: metrics,
    };
    const prior = previous;
    previous = sample;
    if (metrics.qps !== null) {
      await history.record({ at: sample.at, qps: metrics.qps, seconds: (sample.at - prior.at) / 1000,
        latencyMs: null, latencyCount: 0 });
    }
    if (!closed) notify(snapshot);
  }

  function queueSample(task = sample) {
    if (!pending && !closed) {
      pending = Promise.resolve().then(task).catch(() => {
        previous = undefined;
        if (!closed) {
          snapshot = { sampledAt: new Date(now()).toISOString(), sourceStatus: 'unavailable',
            message: 'MySQL 监控采样失败，等待下一轮采样。', metricScope: 'mysql', current: { ...emptyMetrics } };
          notify(snapshot);
        }
      }).finally(() => { pending = undefined; });
    }
    return pending;
  }

  function start() {
    if (closed) return Promise.resolve();
    if (timer) return pending ?? Promise.resolve();
    timer = setInterval(queueSample, intervalMs);
    timer.unref();
    return queueSample(async () => {
      await history.load(now());
      if (!closed) await sample();
    });
  }

  function read(range) {
    const stale = snapshot.sampledAt !== null && now() - Date.parse(snapshot.sampledAt) > maxIntervalMs;
    const current = stale ? { ...emptyMetrics } : { ...snapshot.current };
    const message = stale ? 'MySQL 监控样本已过期，等待下一轮采样。' : snapshot.message;
    return { ...snapshot, current, ...(stale ? { sourceStatus: 'unavailable' } : {}),
      message: history.persistentError ? `${message} 监控历史存储出现错误，请检查数据目录权限和磁盘空间。` : message,
      history: history.points(range, now()) };
  }

  async function close() {
    closed = true;
    clearInterval(timer);
    await pending;
    await pendingAlert;
  }

  return { start, read, close };
}
