import { readFile } from 'node:fs/promises';
import { ApiError } from './errors.mjs';
import { quoteIdentifier } from './sql-policy.mjs';
import { parseFeEndpoints } from './fe-endpoints.mjs';

const connectionLimit = 4;
const maxResultBytes = 4 * 1024 * 1024;
const reconnectCodes = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND',
  'EAI_AGAIN', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'PROTOCOL_ENQUEUE_AFTER_QUIT', 'ER_SERVER_SHUTDOWN', 'ER_SERVER_OFFLINE_MODE',
]);

function canReconnect(error) {
  if (reconnectCodes.has(error?.code)) return true;
  return error?.code === 'ER_UNKNOWN_ERROR' && /\bFE is not ready\b|\bno master\b|\bmaster (?:is )?not ready\b|\bfailed to forward\b.*\bmaster\b/i.test(error.message ?? '');
}

function makeUniqueColumns(fields) {
  const assigned = new Set();
  return fields.map(({ name }, index) => {
    const label = name || `列 ${index + 1}`;
    let unique = label;
    let suffix = 2;
    while (assigned.has(unique)) unique = `${label} (${suffix++})`;
    assigned.add(unique);
    return unique;
  });
}

function normalizeValue(value) {
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`;
  if (typeof value === 'bigint') return value.toString();
  if (value && typeof value === 'object') {
    return JSON.stringify(value, (_, field) => typeof field === 'bigint' ? field.toString() : field);
  }
  return value;
}

function queryRows(connection, discard, sql, { maxRows = 1000, timeoutMs = 18_000 } = {}) {
  return new Promise((resolve, reject) => {
    let columns = [];
    let bytes = 0;
    let finished = false;
    const rows = [];

    function finish(error, truncated = false) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error || truncated) discard();
      if (error) reject(error);
      else resolve({ columns, rows, truncated });
    }

    const timer = setTimeout(() => finish(new ApiError(504, '等待 Doris 响应超时。')), timeoutMs);
    try {
      const query = connection.query({ sql, rowsAsArray: true });
      query.on('fields', (fields) => {
        // mysql2 emits undefined fields for OK packets, including SET and USE.
        if (finished || !fields) return;
        columns = makeUniqueColumns(fields);
        bytes = Buffer.byteLength(JSON.stringify(columns));
        if (bytes > maxResultBytes) finish(new ApiError(422, '查询返回了过多字段，请缩小查询范围。'));
      });
      query.on('result', (row) => {
        if (finished || !Array.isArray(row)) return;
        if (rows.length >= maxRows) {
          finish(null, true);
          return;
        }
        try {
          const record = Object.fromEntries(columns.map((column, index) => [column, normalizeValue(row[index])]));
          bytes += Buffer.byteLength(JSON.stringify(record)) + 1;
          if (bytes > maxResultBytes) finish(null, true);
          else rows.push(record);
        } catch {
          finish(new ApiError(422, 'Doris 返回了无法显示的数据。'));
        }
      });
      query.on('error', (error) => finish(error));
      query.once('end', () => finish());
    } catch (error) {
      finish(error);
    }
  });
}

async function loadTls(config) {
  if (!config.tls) return undefined;
  const ssl = { rejectUnauthorized: true, verifyIdentity: true };
  if (config.caFile) {
    try {
      ssl.ca = await readFile(config.caFile);
    } catch {
      throw new ApiError(503, '无法读取 DORIS_TLS_CA_FILE 指定的 CA 证书。');
    }
  }
  return ssl;
}

export function createDorisClient(config) {
  const pools = new Map();
  const failures = new Map();
  const primary = { host: config.host, port: config.port };
  const configured = [primary, ...parseFeEndpoints(config.feEndpoints)];
  let discovered = [];
  let preferred = primary;
  let connectedEndpoint;
  let closed = false;
  let active = 0;

  const endpointKey = ({ host, port }) => JSON.stringify([host, port]);

  async function makePool(endpoint) {
    let mysql;
    try {
      mysql = (await import('mysql2')).default;
    } catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND') {
        throw new ApiError(503, 'Doris 驱动尚未安装，请在项目目录安装依赖。');
      }
      throw error;
    }
    return mysql.createPool({
      host: endpoint.host,
      port: endpoint.port,
      user: config.user,
      password: config.password,
      database: config.database || undefined,
      ssl: await loadTls(config),
      charset: 'utf8mb4',
      connectTimeout: 5_000,
      connectionLimit,
      maxIdle: 2,
      idleTimeout: 30_000,
      waitForConnections: false,
      multipleStatements: false,
      flags: ['-LOCAL_FILES'],
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
    });
  }

  function getPool(endpoint) {
    const key = endpointKey(endpoint);
    if (!pools.has(key)) {
      const work = makePool(endpoint).catch((error) => {
        pools.delete(key);
        throw error;
      });
      pools.set(key, work);
    }
    return pools.get(key);
  }

  async function runAt(endpoint, work, database, discardAfterUse, deadline) {
    let connection;
    let discarded = false;
    const databaseChanged = database !== config.database;
    function discard() {
      if (discarded) return;
      discarded = true;
      connection?.destroy();
    }

    try {
      const pool = await getPool(endpoint);
      if (closed) throw new ApiError(503, 'Doris Studio 正在关闭。');
      connection = await new Promise((resolve, reject) => {
        pool.getConnection((error, client) => error ? reject(error) : resolve(client));
      });
      preferred = endpoint;
      connectedEndpoint = endpoint;
      const run = (sql, options) => queryRows(connection, discard, sql, {
        ...options, timeoutMs: Math.max(1, Math.min(options?.timeoutMs ?? 18_000, deadline - Date.now())),
      });
      if (databaseChanged) {
        await run(`USE ${quoteIdentifier(database)}`, { timeoutMs: 5_000 });
      }
      const result = await work(run);
      failures.delete(endpointKey(endpoint));
      return result;
    } finally {
      if (connection && !discarded) {
        // Do not return connections whose database or session settings were changed.
        if (databaseChanged || discardAfterUse) discard();
        else connection.release();
      }
    }
  }

  // Callbacks contain read-only SQL and connection-local SET/USE statements.
  // Replay the whole callback so a replacement connection receives its session settings.
  async function withConnection(work, database = config.database, { discardAfterUse = false, retryTimeout = false } = {}) {
    if (closed) throw new ApiError(503, 'Doris Studio 正在关闭。');
    if (active >= connectionLimit) throw new ApiError(503, '当前查询较多，请稍后重试。');
    active++;
    try {
      const deadline = Date.now() + 18_000;
      const unique = new Map([preferred, ...configured, ...discovered].map((endpoint) => [endpointKey(endpoint), endpoint]));
      const candidates = [...unique.values()];
      const healthy = candidates.filter((endpoint) => (failures.get(endpointKey(endpoint)) ?? 0) <= Date.now());
      const cooling = candidates.filter((endpoint) => !healthy.includes(endpoint));
      const endpoints = candidates.length === 1 ? [candidates[0], candidates[0]] : [...healthy, ...cooling].slice(0, 3);
      for (const endpoint of endpoints) {
        try {
          return await runAt(endpoint, work, database, discardAfterUse, deadline);
        } catch (error) {
          const timedOut = error instanceof ApiError && error.status === 504;
          if (closed || (!canReconnect(error) && !(timedOut && retryTimeout))) throw error;
          failures.set(endpointKey(endpoint), Date.now() + 30_000);
          if (Date.now() + 5_000 >= deadline) break;
        }
      }
      throw new ApiError(503, '已知的 Doris FE 暂时均无法连接。主节点切换后可配置同一集群的备用 FE 地址，再重试。');
    } finally {
      active--;
    }
  }

  function rememberFrontends(nodes) {
    const endpoints = [];
    for (const node of nodes) {
      if (node.alive !== true || node.joined !== true) continue;
      try {
        endpoints.push(...parseFeEndpoints([{ host: node.host, port: node.port }]));
      } catch {
        // Only valid MySQL endpoints from the source's own topology can be tried.
      }
      if (endpoints.length === 8) break;
    }
    discovered = endpoints;
  }

  async function close() {
    closed = true;
    await Promise.all([...pools.values()].map(async (work) => {
      const pool = await work.catch(() => undefined);
      if (pool) await new Promise((resolve) => pool.end(resolve));
    }));
  }

  return { withConnection, rememberFrontends, close,
    get endpoint() { return connectedEndpoint ? { ...connectedEndpoint } : null; } };
}
