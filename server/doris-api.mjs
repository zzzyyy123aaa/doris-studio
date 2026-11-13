import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { ApiError, publicError } from './errors.mjs';
import { createDorisClient } from './doris-client.mjs';
import { readClusterStatus } from './cluster-status.mjs';
import { createMonitoring } from './monitoring.mjs';
import { createSourceRegistry, parseSourceInput } from './data-sources.mjs';
import { quoteIdentifier, readOnlyStatement } from './sql-policy.mjs';
import { createAlertStore } from './alert-store.mjs';
import { createGlobalWebhookStore } from './global-webhook-store.mjs';
import { createAlerts } from './alerts.mjs';

const liveKeys = [
  'DORIS_HOST', 'DORIS_PORT', 'DORIS_DATABASE', 'DORIS_USER', 'DORIS_PASSWORD',
  'DORIS_TLS', 'DORIS_TLS_CA_FILE',
];
const internalDatabases = ['information_schema', 'mysql', 'sys', 'performance_schema', '__internal_schema'];
const maxBodyBytes = 128 * 1024;
const maxCatalogRows = 4096;
const catalogQuery = `SELECT TABLE_SCHEMA AS db, TABLE_NAME AS name, TABLE_TYPE AS model,
       TABLE_COMMENT AS label, TABLE_ROWS AS total, DATA_LENGTH AS bytes
FROM internal.information_schema.tables
WHERE TABLE_CATALOG = 'internal'
  AND TABLE_SCHEMA NOT IN (${internalDatabases.map((name) => `'${name}'`).join(', ')})
ORDER BY TABLE_SCHEMA, TABLE_NAME
LIMIT ${maxCatalogRows + 1}`;

function loadConfig(env, database) {
  const host = env.DORIS_HOST?.trim();
  const user = env.DORIS_USER?.trim();
  const password = env.DORIS_PASSWORD;
  if (!host || !user || password === undefined) {
    throw new ApiError(503, '请配置 DORIS_HOST、DORIS_USER 和 DORIS_PASSWORD。');
  }
  const portValue = env.DORIS_PORT?.trim() || '9030';
  const port = Number(portValue);
  if (!/^\d+$/.test(portValue) || port < 1 || port > 65535) {
    throw new ApiError(503, 'DORIS_PORT 必须是 1 至 65535 之间的整数。');
  }
  const tlsValue = env.DORIS_TLS?.trim().toLowerCase() || 'false';
  if (!['true', 'false'].includes(tlsValue)) {
    throw new ApiError(503, 'DORIS_TLS 必须是 true 或 false。');
  }
  const tls = tlsValue === 'true';
  const caFile = env.DORIS_TLS_CA_FILE?.trim();
  if (caFile && !tls) throw new ApiError(503, '指定 CA 证书时请同时设置 DORIS_TLS=true。');
  if (database) {
    try {
      quoteIdentifier(database);
    } catch {
      throw new ApiError(503, 'DORIS_DATABASE 不是有效的库名。');
    }
  }
  return { host, port, user, password, database, tls, caFile };
}

function sendJson(response, status, payload) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (status === 413 || status === 415) headers.Connection = 'close';
  response.writeHead(status, headers).end(JSON.stringify(payload));
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    throw new ApiError(415, '请使用 application/json 发送请求。');
  }
  const oversized = () => new ApiError(413, '请求内容超过 128 KiB。');
  if (Number(request.headers['content-length']) > maxBodyBytes) throw oversized();

  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBodyBytes) throw oversized();
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new ApiError(400, '请求必须是有效的 JSON 对象。');
  }
}

function displayedCount(value) {
  return /^\d+$/.test(String(value)) ? BigInt(value).toLocaleString('en-US') : '—';
}

function displayedSize(value) {
  if (!/^\d+$/.test(String(value))) return '—';
  const bytes = Number(value);
  if (bytes < 1024) return `${bytes} B`;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** unit).toFixed(1)} ${units[unit]}`;
}

function requireComplete(result) {
  if (result.truncated) throw new ApiError(422, '目录或表结构超过显示上限。');
  return result;
}

function listTables(client) {
  return client.withConnection(async (run) => {
    const { columns, rows } = requireComplete(await run('SHOW DATABASES', { maxRows: maxCatalogRows }));
    const databases = rows.map((row) => String(row[columns[0]] ?? ''))
      .filter((name) => name && !internalDatabases.includes(name.toLowerCase()));
    if (!databases.length) return { databases: [], tables: [] };

    const result = await run(catalogQuery, { maxRows: maxCatalogRows });
    const visible = new Set(databases);
    const tables = requireComplete(result).rows.filter((row) => visible.has(row.db)).map((row) => ({
      db: row.db,
      name: row.name,
      label: row.label || row.name,
      model: row.model || '—',
      total: displayedCount(row.total),
      size: displayedSize(row.bytes),
    }));
    return { databases, tables };
  });
}

function tableDetails(client, url) {
  const table = `${quoteIdentifier(url.searchParams.get('db'))}.${quoteIdentifier(url.searchParams.get('name'))}`;
  const tab = url.searchParams.get('tab') || 'preview';
  if (!['preview', 'schema', 'ddl'].includes(tab)) throw new ApiError(400, '无效的表详情类型。');

  return client.withConnection(async (run) => {
    if (tab === 'schema') {
      const { rows } = requireComplete(await run(`SHOW FULL COLUMNS FROM ${table}`, { maxRows: 2048 }));
      return {
        columns: rows.map((row) => ({
          name: row.Field,
          type: row.Type,
          comment: row.Comment || '',
          key: ['YES', 'PRI', 'UNI', 'MUL'].includes(String(row.Key).toUpperCase()),
        })),
      };
    }
    if (tab === 'ddl') {
      const { columns, rows } = requireComplete(await run(`SHOW CREATE TABLE ${table}`, { maxRows: 1 }));
      const ddl = rows[0]?.[columns[1]];
      if (typeof ddl !== 'string') throw new ApiError(404, 'Doris 未返回建表语句。');
      return { ddl };
    }
    const limitValue = url.searchParams.get('limit') || '20';
    const limit = Number(limitValue);
    if (!/^\d+$/.test(limitValue) || limit < 1 || limit > 100) {
      throw new ApiError(400, '预览行数必须是 1 至 100 之间的整数。');
    }
    return run(`SELECT * FROM ${table} LIMIT ${limit}`, { maxRows: limit });
  });
}

async function runQuery(client, request, defaultDatabase) {
  const body = await readJson(request);
  const sql = readOnlyStatement(body.sql);
  const database = body.database === undefined || body.database === '' ? defaultDatabase : body.database;
  if (database !== '') quoteIdentifier(database);
  return client.withConnection(async (run) => {
    // Doris applies this limit on the FE even if the client disconnects.
    await run('SET query_timeout = 15', { timeoutMs: 5_000 });
    const start = performance.now();
    const result = await run(sql);
    return { ...result, duration: Math.max(1, Math.round(performance.now() - start)) };
  }, database);
}

function pingDoris(client, requireVersion = false) {
  return client.withConnection(async (run) => {
    await run('SELECT 1 AS ok', { maxRows: 1, timeoutMs: 4_000 });
    const result = await run('SELECT @@version_comment AS version', { maxRows: 1, timeoutMs: 4_000 })
      .catch((error) => {
        if (requireVersion) throw error;
      });
    const version = result?.rows[0]?.version;
    if (requireVersion && !/doris/i.test(String(version ?? ''))) {
      throw new ApiError(422, '此地址未返回 Apache Doris 版本，请检查 FE 查询端口。');
    }
    return version ? String(version) : undefined;
  });
}

export function createDorisApi(env) {
  const mode = liveKeys.some((key) => env[key] !== undefined) ? 'live' : 'demo';
  const database = env.DORIS_DATABASE?.trim() || '';
  const monitoringDirectory = env.STUDIO_MONITORING_DIR?.trim();
  let configError;
  let initialConfig = null;
  if (mode === 'live') {
    try {
      initialConfig = loadConfig(env, database);
    } catch (error) {
      configError = publicError(error);
    }
  }
  const registry = mode === 'live' ? createSourceRegistry({
    directory: resolve(monitoringDirectory || 'studio-data', 'sources'),
    initialConfig,
  }) : null;
  const alertDirectory = resolve(monitoringDirectory || 'studio-data', 'alerts');
  const alerts = registry ? createAlerts(createAlertStore(alertDirectory), {
    channel: createGlobalWebhookStore(alertDirectory),
    listSourceIds: () => registry.list().map(({ id }) => id),
  }) : null;
  const sessions = new Map();
  let registryReady;
  let closing = false;

  function prepareRegistry() {
    registryReady ??= registry.load();
    return registryReady;
  }

  function sourceSession(source) {
    if (!sessions.has(source.id)) {
      if (closing) throw new ApiError(503, 'Doris Studio 正在关闭。');
      const { config } = source;
      const client = createDorisClient(config);
      const endpoint = [config.host, config.port];
      const readTopology = (includeMetrics = false) => readClusterStatus(client, { host: config.host, includeMetrics });
      const monitoring = createMonitoring({
        getTopology: () => readTopology(true),
        directory: monitoringDirectory,
        clusterKey: JSON.stringify(source.id === 'default' ? endpoint : [source.id, ...endpoint]),
        onSample: (snapshot, values) => alerts.sample(registry.get(source.id) ?? source, snapshot, values),
      });
      sessions.set(source.id, { client, monitoring, readTopology, ready: monitoring.start() });
    }
    return { ...sessions.get(source.id), source };
  }

  function listSources() {
    return { sources: registry.list(), defaultId: registry.defaultId, storageError: registry.storageError };
  }

  async function addSource(request) {
    const input = await readJson(request);
    const { config } = parseSourceInput(input);
    const client = createDorisClient(config);
    try {
      await pingDoris(client, true);
    } finally {
      await client.close();
    }
    return { source: await registry.add(input) };
  }

  async function renameSource(request) {
    const { id, name } = await readJson(request);
    return { source: await registry.rename(id, name) };
  }

  async function status({ client, source }) {
    const info = { mode, sourceId: source.id, database: source.config.database };
    try {
      return { ...info, connected: true, version: await pingDoris(client) };
    } catch (error) {
      return { ...info, connected: false, error: publicError(error).message };
    }
  }

  function monitoringStatus(monitoring, url) {
    const range = url.searchParams.get('range') || '24h';
    if (!['24h', '7d', '30d'].includes(range)) throw new ApiError(400, '请选择 24h、7d 或 30d。');
    return monitoring.read(range);
  }

  const routes = new Map([
    ['/api/status', { GET: (_, __, session) => status(session) }],
    ['/api/cluster', { GET: (_, __, { readTopology }) => readTopology() }],
    ['/api/monitoring', { GET: (_, url, { monitoring }) => monitoringStatus(monitoring, url) }],
    ['/api/alerts', {
      GET: (_, __, { source }) => alerts.read(source.id),
      PUT: async (request, _, { source }) => alerts.update(source.id, await readJson(request)),
    }],
    ['/api/tables', { GET: (_, __, { client }) => listTables(client) }],
    ['/api/table', { GET: (_, url, { client }) => tableDetails(client, url) }],
    ['/api/query', { POST: (request, _, { client, source }) => runQuery(client, request, source.config.database) }],
  ]);
  const globalRoutes = new Map([
    ['/api/sources', { GET: listSources, POST: addSource, PATCH: renameSource }],
    ['/api/alerts/webhook', {
      GET: () => alerts.readChannel(),
      PUT: async (request) => alerts.updateChannel(await readJson(request)),
    }],
    ['/api/alerts/webhook/test', { POST: async (request) => {
      await readJson(request);
      return alerts.testChannel();
    } }],
  ]);

  async function handle(request, response, url) {
    try {
      const global = globalRoutes.get(url.pathname);
      const route = global ?? routes.get(url.pathname);
      if (!route) throw new ApiError(404, '找不到此 API。');
      if (!Object.hasOwn(route, request.method)) {
        response.setHeader('Allow', Object.keys(route).join(', '));
        throw new ApiError(405, '此 API 不支持该请求方法。');
      }
      if (mode === 'demo') {
        if (url.pathname === '/api/status') return sendJson(response, 200, { mode });
        throw new ApiError(503, '当前为演示模式，尚未配置真实 Doris 连接。');
      }
      await prepareRegistry();
      const run = route[request.method];
      if (request.method !== 'GET' && (global || url.pathname === '/api/alerts')) {
        const fetchSite = request.headers['sec-fetch-site'];
        if (fetchSite && fetchSite !== 'same-origin') throw new ApiError(403, '请从 Doris Studio 页面修改配置或发送测试消息。');
      }
      if (global) {
        return sendJson(response, url.pathname === '/api/sources' && request.method === 'POST' ? 201 : 200, await run(request));
      }

      const requestedSource = request.headers['x-doris-source'];
      const source = registry.get(requestedSource ?? registry.defaultId);
      if (!source) {
        if (requestedSource !== undefined) throw new ApiError(404, '找不到所选数据源。');
        const error = configError || new ApiError(503, '请先添加 Doris 数据源。');
        if (url.pathname === '/api/status') {
          return sendJson(response, 200, { mode, connected: false, database, error: error.message });
        }
        throw error;
      }
      sendJson(response, 200, await run(request, url, sourceSession(source)));
    } catch (error) {
      const { status, message } = publicError(error);
      if (!response.destroyed) sendJson(response, status, { error: message });
    }
  }

  return {
    mode,
    handle,
    async start() {
      if (!registry) return;
      await prepareRegistry();
      const source = registry.get(registry.defaultId);
      const startSource = async ({ id }) => {
        if (id !== source?.id && !await alerts.configured(id).catch(() => false)) return;
        const entry = registry.get(id);
        if (entry && !closing) await sourceSession(entry).ready;
      };
      await Promise.all(registry.list().map(startSource));
    },
    async close() {
      closing = true;
      await Promise.all([...sessions.values()].map(async ({ client, monitoring }) => {
        await monitoring.close();
        await client.close();
      }));
    },
  };
}
