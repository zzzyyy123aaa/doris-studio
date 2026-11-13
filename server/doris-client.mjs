import { readFile } from 'node:fs/promises';
import { ApiError } from './errors.mjs';
import { quoteIdentifier } from './sql-policy.mjs';

const connectionLimit = 4;
const maxResultBytes = 4 * 1024 * 1024;

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
  let poolPromise;
  let active = 0;

  async function makePool() {
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
      host: config.host,
      port: config.port,
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

  function getPool() {
    poolPromise ??= makePool().catch((error) => {
      poolPromise = undefined;
      throw error;
    });
    return poolPromise;
  }

  async function withConnection(work, database = config.database, { discardAfterUse = false } = {}) {
    if (active >= connectionLimit) throw new ApiError(503, '当前查询较多，请稍后重试。');
    active++;
    let connection;
    let discarded = false;
    const databaseChanged = database !== config.database;
    function discard() {
      if (discarded) return;
      discarded = true;
      connection.destroy();
    }

    try {
      const pool = await getPool();
      connection = await new Promise((resolve, reject) => {
        pool.getConnection((error, client) => error ? reject(error) : resolve(client));
      });
      const run = (sql, options) => queryRows(connection, discard, sql, options);
      if (databaseChanged) {
        await run(`USE ${quoteIdentifier(database)}`, { timeoutMs: 5_000 });
      }
      return await work(run);
    } finally {
      active--;
      if (connection && !discarded) {
        // Do not return connections whose database or session settings were changed.
        if (databaseChanged || discardAfterUse) discard();
        else connection.release();
      }
    }
  }

  async function close() {
    const pool = await poolPromise?.catch(() => undefined);
    if (pool) await new Promise((resolve) => pool.end(resolve));
  }

  return { withConnection, close };
}
