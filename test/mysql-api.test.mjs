import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { createDorisApi } from '../server/doris-api.mjs';
import { createSourceRegistry, parseSourceInput } from '../server/data-sources.mjs';
import { createAlertStore } from '../server/alert-store.mjs';
import { createAlerts } from '../server/alerts.mjs';

const fixtureKey = Symbol.for('doris-studio.mysql-api-test');
const hook = registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'mysql2' ? { url: 'mysql-api:driver', shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return url === 'mysql-api:driver' ? { format: 'module', shortCircuit: true,
      source: 'export default {createPool(options) { return globalThis[Symbol.for("doris-studio.mysql-api-test")](options); }};' }
      : next(url, context);
  },
});
after(() => { hook.deregister(); delete globalThis[fixtureKey]; });

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const input = { type: 'mysql', name: 'MySQL 测试实例', host: 'mysql.test', username: 'monitor', password: 'fixture-only' };

async function fixture(context, environment = {}) {
  const directory = await mkdtemp(join(project, '.mysql-api-test-'));
  const queries = [];
  const pools = [];
  globalThis[fixtureKey] = (options) => {
    const pool = { closed: false, getConnection(callback) {
      const connection = {
        release() {}, destroy() {},
        query({ sql }) {
          queries.push({ sql, host: options.host, port: options.port });
          const stream = new EventEmitter();
          queueMicrotask(() => {
            let record = [];
            if (sql.startsWith('SELECT VERSION()')) {
              record = [{ version: options.host === 'doris.test' ? '5.7.99' : '8.0.40',
                comment: options.host === 'doris.test' ? 'Apache Doris 4.0' : 'MySQL Community Server - GPL' }];
            } else if (sql.startsWith('SELECT @@version_comment')) record = [{ version: 'Apache Doris 4.0' }];
            else if (sql === 'SELECT 1 AS ok') record = [{ ok: 1 }];
            else if (sql.startsWith('SHOW GLOBAL STATUS')) {
              record = Object.entries({ Uptime: 100, Questions: 50, Threads_connected: 4, Threads_running: 1,
                Com_commit: 10, Com_rollback: 0, Bytes_received: 1000, Bytes_sent: 2000, Slow_queries: 0,
                Innodb_buffer_pool_read_requests: 100, Innodb_buffer_pool_reads: 5 })
                .map(([Variable_name, Value]) => ({ Variable_name, Value: String(Value) }));
            } else if (sql.startsWith('SHOW GLOBAL VARIABLES')) {
              record = [{ Variable_name: 'max_connections', Value: '200' }, { Variable_name: 'server_uuid', Value: 'instance-a' }];
            } else if (sql === 'SHOW DATABASES') record = [{ Database: 'business_db' }, { Database: 'information_schema' }];
            else if (/SUM\(/i.test(sql)) record = [{ bytes: '8192', storageBytes: '8192', storage_bytes: '8192', total_bytes: '8192' }];
            else if (sql.includes('TABLE_SCHEMA AS db')) {
              record = [{ db: 'business_db', name: 'orders', model: 'BASE TABLE', label: '', total: 1, bytes: 8192 }];
            } else if (sql.startsWith('SHOW FULL COLUMNS')) record = [{ Field: 'id', Type: 'bigint', Comment: '', Key: 'PRI' }];
            else if (sql.startsWith('SHOW CREATE TABLE')) record = [{ Table: 'orders', 'Create Table': 'CREATE TABLE orders (id BIGINT)' }];
            else if (sql.startsWith('SELECT')) record = [{ id: 1 }];
            const columns = Object.keys(record[0] ?? {});
            stream.emit('fields', columns.map((name) => ({ name })));
            for (const row of record) stream.emit('result', columns.map((name) => row[name]));
            stream.emit('end');
          });
          return stream;
        },
      };
      queueMicrotask(() => callback(null, connection));
    }, end(callback) { this.closed = true; callback(); } };
    pools.push(pool);
    return pool;
  };
  const api = createDorisApi({ STUDIO_MODE: 'live', STUDIO_MONITORING_DIR: directory, ...environment });
  context.after(async () => {
    await api.close();
    assert.ok(pools.every(({ closed }) => closed));
    assert.ok(directory.startsWith(project + sep));
    await rm(directory, { recursive: true, force: true });
  });
  async function request(path, { method = 'GET', sourceId, body } = {}) {
    const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    stream.method = method;
    stream.headers = { 'sec-fetch-site': 'same-origin',
      ...(sourceId ? { 'x-doris-source': sourceId } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}) };
    const response = { setHeader() {}, writeHead(code) { this.status = code; return this; },
      end(value) { this.body = JSON.parse(value); } };
    await api.handle(stream, response, new URL(path, 'http://localhost'));
    return response;
  }
  return { api, directory, queries, request };
}

test('MySQL source creation, status, catalog and SQL use the normal API without Doris statements', async (context) => {
  const { api, request, queries } = await fixture(context);
  const created = await request('/api/sources', { method: 'POST', body: input });
  assert.equal(created.status, 201);
  const source = created.body.source;
  assert.equal(source.type, 'mysql');
  assert.equal(source.port, 3306);
  assert.equal(Object.hasOwn(source, 'password'), false);
  await api.start();
  const status = await request('/api/status', { sourceId: source.id });
  assert.equal(status.body.connected, true);
  assert.equal(status.body.type, 'mysql');
  const tables = await request('/api/tables', { sourceId: source.id });
  assert.equal(tables.status, 200);
  assert.equal(tables.body.tables[0].name, 'orders');
  const query = await request('/api/query', { sourceId: source.id, method: 'POST', body: { sql: 'SELECT 1' } });
  assert.equal(query.status, 200);
  assert.equal(query.body.rows[0].id, 1);
  assert.ok(queries.some(({ sql }) => sql === 'SET SESSION TRANSACTION READ ONLY'));
  assert.ok(queries.some(({ sql }) => sql === 'SET SESSION max_execution_time = 15000'));
  assert.equal(queries.some(({ sql }) => /SET query_timeout|SHOW FRONTENDS|SHOW BACKENDS|internal\.information_schema/.test(sql)), false);
  const denied = await request('/api/query', { sourceId: source.id, method: 'POST', body: { sql: 'DELETE FROM orders' } });
  assert.equal(denied.status, 400);
  const alerts = await request('/api/alerts', { sourceId: source.id });
  assert.equal(alerts.body.sourceType, 'mysql');
  assert.equal(alerts.body.config.thresholds.connectionUsagePercent, null);
  const saved = await request('/api/alerts', { sourceId: source.id, method: 'PUT',
    body: { ...alerts.body.config, thresholds: { ...alerts.body.config.thresholds, connectionUsagePercent: 80, threadsRunning: 10 } } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.config.thresholds.threadsRunning, 10);
});

test('mixed source registries survive restart and reject a Doris service added as MySQL', async (context) => {
  const { directory, request, queries } = await fixture(context, {
    DORIS_HOST: 'doris.test', DORIS_PORT: '9030', DORIS_USER: 'reader', DORIS_PASSWORD: 'fixture-only',
  });
  const created = await request('/api/sources', { method: 'POST', body: input });
  assert.equal(created.status, 201);
  const list = await request('/api/sources');
  assert.deepEqual(list.body.sources.map(({ type }) => type), ['doris', 'mysql']);
  const dorisStatus = await request('/api/status', { sourceId: 'default' });
  assert.equal(dorisStatus.body.type, 'doris');
  assert.equal(dorisStatus.body.connected, true);
  const mysqlStatus = await request('/api/status', { sourceId: created.body.source.id });
  assert.equal(mysqlStatus.body.type, 'mysql');
  assert.ok(queries.some(({ sql, host }) => sql === 'SELECT @@version_comment AS version' && host === 'doris.test'));
  const reopened = createSourceRegistry({ directory: join(directory, 'sources'), initialConfig: null });
  await reopened.load();
  assert.equal(reopened.list()[0].type, 'mysql');
  const wrong = await request('/api/sources', { method: 'POST', body: { ...input, host: 'doris.test', name: '错误类型' } });
  assert.equal(wrong.status, 422);
  assert.equal((await request('/api/sources')).body.sources.length, 2);
  assert.throws(() => parseSourceInput({ ...input, feEndpoints: 'peer.test:9030' }), { status: 400 });
});

test('MySQL rules persist their metric scope and deliver through the shared bot', async (context) => {
  const { directory } = await fixture(context);
  const rulesDirectory = join(directory, 'rules');
  const store = createAlertStore(rulesDirectory);
  const sent = [];
  let at = Date.now();
  const alerts = createAlerts(store, {
    channel: { get: async () => ({ configured: true, webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/fixture-only', secret: null }) },
    listSourceIds: () => ['default'], now: () => at, send: async (message) => { sent.push(message); },
  });
  const current = await alerts.read('default');
  await alerts.update('default', { ...current.config, enabled: true, consecutiveSamples: 1,
    thresholds: { ...current.config.thresholds, qps: 10, connectionUsagePercent: 80, threadsRunning: 10, slowQueriesPerSecond: 1 } });
  const source = { id: 'default', name: 'MySQL 业务库' };
  await alerts.sample(source, { sampledAt: new Date(at).toISOString(), metricScope: 'mysql' },
    { qps: 20, connectionUsagePercent: 90, threadsRunning: 12, slowQueriesPerSecond: 2 });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /MySQL 业务库/);
  assert.match(sent[0].text, /MySQL SQL 请求速率/);
  assert.match(sent[0].text, /MySQL 连接使用率/);
  const reloaded = await createAlertStore(rulesDirectory).get('default');
  assert.equal(reloaded.runtime.rules.qps.scope, 'mysql');
  assert.equal(reloaded.runtime.rules.threadsRunning.notified, true);
  at += 30_000;
  await alerts.sample(source, { sampledAt: new Date(at).toISOString(), metricScope: 'mysql' },
    { qps: null, connectionUsagePercent: null, threadsRunning: null, slowQueriesPerSecond: null });
  assert.equal(sent.length, 1, 'Missing metrics cannot recover existing alerts');
  at += 30_000;
  await alerts.sample(source, { sampledAt: new Date(at).toISOString(), metricScope: 'mysql' },
    { qps: 1, connectionUsagePercent: 10, threadsRunning: 1, slowQueriesPerSecond: 0 });
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /告警恢复/);
});
