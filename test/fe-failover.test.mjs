import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createDorisClient } from '../server/doris-client.mjs';
import { readClusterStatus } from '../server/cluster-status.mjs';
import { createSourceRegistry, parseSourceInput } from '../server/data-sources.mjs';
import { parseFeEndpoints } from '../server/fe-endpoints.mjs';
import { createAlertStore } from '../server/alert-store.mjs';
import { createAlerts } from '../server/alerts.mjs';

const fixtureSymbol = Symbol.for('doris-studio.fe-failover-test');
const driverUrl = 'doris-fixture:mysql2';
const driverHook = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === 'mysql2' ? { url: driverUrl, shortCircuit: true } : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url !== driverUrl) return nextLoad(url, context);
    return { format: 'module', shortCircuit: true,
      source: 'export default { createPool(options) { return globalThis[Symbol.for("doris-studio.fe-failover-test")].createPool(options); } };' };
  },
});
after(() => {
  driverHook.deregister();
  delete globalThis[fixtureSymbol];
});

const primary = { host: 'primary.test', port: 9030 };
const peer = { host: 'peer.test', port: 9130 };
const config = { ...primary, user: 'reader', password: 'fixture-only', database: '', tls: false };
const result = (columns, rows) => ({ columns, rows });
const select = (client) => client.withConnection((run) => run('SELECT 1 AS ok'));
const failure = (code, message = code) => Object.assign(new Error(message), { code });
const keyFor = ({ host, port }) => `${host}:${port}`;
const silent = Symbol('silent-query');

async function temporaryDirectory(context) {
  const directory = await mkdtemp(join(fileURLToPath(new URL('../', import.meta.url)), '.fe-failover-test-'));
  context.after(async () => {
    for (const file of await readdir(directory)) await unlink(join(directory, file));
    await rmdir(directory);
  });
  return directory;
}

function fixture(context, servers) {
  const pools = [];
  const connections = [];
  const events = [];
  const clients = [];
  let nextConnection = 1;
  globalThis[fixtureSymbol] = {
    createPool(options) {
      const endpoint = keyFor(options);
      const state = servers[endpoint];
      assert.ok(state, `Unexpected endpoint ${endpoint}`);
      const idle = [];
      const pool = {
        options, endpoint, closed: false,
        getConnection(callback) {
          events.push({ type: 'connect', endpoint });
          queueMicrotask(() => {
            const error = typeof state.connectError === 'function' ? state.connectError() : state.connectError;
            if (error) return callback(error);
            assert.equal(pool.closed, false, 'Closed pool reused');
            let connection = idle.pop();
            if (!connection) {
              connection = {
                id: nextConnection++, endpoint, database: options.database ?? '', destroyed: false,
                release() {
                  assert.equal(this.destroyed, false, 'Destroyed connection released');
                  events.push({ type: 'release', endpoint, id: this.id });
                  idle.push(this);
                },
                destroy() {
                  this.destroyed = true;
                  events.push({ type: 'destroy', endpoint, id: this.id });
                },
                query({ sql, rowsAsArray }) {
                  assert.equal(rowsAsArray, true);
                  assert.equal(this.destroyed, false, 'Destroyed connection queried');
                  events.push({ type: 'query', endpoint, id: this.id, sql });
                  const stream = new EventEmitter();
                  queueMicrotask(() => {
                    let response;
                    try {
                      response = state.query?.(sql, this) ?? result(['ok'], [[1]]);
                    } catch (error) {
                      stream.emit('error', error);
                      return;
                    }
                    if (response === silent) return;
                    if (sql.startsWith('USE ')) this.database = sql.slice(4);
                    stream.emit('fields', response.columns?.map((name) => ({ name })));
                    for (const row of response.rows) stream.emit('result', row);
                    stream.emit('end');
                  });
                  return stream;
                },
              };
              connections.push(connection);
            }
            callback(null, connection);
          });
        },
        end(callback) {
          assert.equal(pool.closed, false, 'Pool closed more than once');
          pool.closed = true;
          events.push({ type: 'end', endpoint });
          callback();
        },
      };
      pools.push(pool);
      return pool;
    },
  };
  async function close() {
    for (const client of clients.splice(0)) await client.close();
    assert.ok(pools.every(({ closed }) => closed), 'A created pool was left open');
  }
  context.after(close);
  return {
    pools, connections, events, close,
    client(input = config) {
      const client = createDorisClient(input);
      clients.push(client);
      return client;
    },
    queried(endpoint) { return events.filter((event) => event.type === 'query' && event.endpoint === keyFor(endpoint)).map(({ sql }) => sql); },
    connected() { return events.filter(({ type }) => type === 'connect').map(({ endpoint }) => endpoint); },
  };
}

test('connect failure tries a configured peer and keeps the replacement for later reads', async (context) => {
  const mock = fixture(context, {
    [keyFor(primary)]: { connectError: failure('ECONNREFUSED') },
    [keyFor(peer)]: {},
  });
  const client = mock.client({ ...config, feEndpoints: [peer] });
  assert.deepEqual((await select(client)).rows, [{ ok: 1 }]);
  assert.deepEqual(client.endpoint, peer);
  await select(client);
  assert.deepEqual(mock.connected(), [keyFor(primary), keyFor(peer), keyFor(peer)]);
  assert.equal(mock.pools.length, 2);
  const replacement = mock.pools.find(({ endpoint }) => endpoint === keyFor(peer));
  assert.equal(replacement.options.database, undefined);
  assert.equal(replacement.options.user, config.user);
  assert.equal(replacement.options.password, config.password);
  assert.equal(replacement.options.multipleStatements, false);
  assert.deepEqual(replacement.options.flags, ['-LOCAL_FILES']);
});

test('a reset during read replays USE and session SET on a new connection', async (context) => {
  const mock = fixture(context, {
    [keyFor(primary)]: {
      query(sql) {
        if (sql.startsWith('SELECT')) throw failure('ECONNRESET');
        return result(undefined, []);
      },
    },
    [keyFor(peer)]: {},
  });
  const client = mock.client({ ...config, feEndpoints: [peer] });
  let attempts = 0;
  const actual = await client.withConnection(async (run) => {
    attempts++;
    await run('SET query_timeout = 15');
    return run('SELECT DATABASE() AS ok');
  }, '业务库', { discardAfterUse: true });
  assert.equal(attempts, 2);
  assert.deepEqual(actual.rows, [{ ok: 1 }]);
  const expected = ['USE `业务库`', 'SET query_timeout = 15', 'SELECT DATABASE() AS ok'];
  assert.deepEqual(mock.queried(primary), expected);
  assert.deepEqual(mock.queried(peer), expected);
  assert.ok(mock.connections.every(({ destroyed }) => destroyed));
  await select(client);
  assert.equal(mock.connections.at(-1).database, '', 'An altered database leaked from a previous attempt');
});

test('single endpoint reconnect replaces a failed connection without requiring seed migration', async (context) => {
  let broken = true;
  const mock = fixture(context, {
    [keyFor(primary)]: { query() {
      if (broken) {
        broken = false;
        throw failure('PROTOCOL_CONNECTION_LOST');
      }
    } },
  });
  const client = mock.client();
  await select(client);
  assert.deepEqual(mock.connected(), [keyFor(primary), keyFor(primary)]);
  assert.equal(mock.connections.length, 2);
  assert.equal(mock.connections[0].destroyed, true);
  assert.deepEqual(client.endpoint, primary);
});

test('a silent SELECT 1 health check times out and retries the configured peer', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const mock = fixture(context, {
    [keyFor(primary)]: { query: () => silent },
    [keyFor(peer)]: {},
  });
  const client = mock.client({ ...config, feEndpoints: [peer] });
  const ping = client.withConnection((run) => run('SELECT 1 AS ok', { timeoutMs: 4_000 }),
    undefined, { retryTimeout: true });
  await setImmediate();
  context.mock.timers.tick(4_001);
  assert.deepEqual((await ping).rows, [{ ok: 1 }]);
  assert.equal(mock.connections[0].destroyed, true);
  assert.deepEqual(client.endpoint, peer);
  assert.deepEqual(mock.connected(), [keyFor(primary), keyFor(peer)]);
});

test('permission, credentials, SQL syntax and slow-query errors preserve their error and do not change FE', async (context) => {
  const errors = [
    failure('ER_ACCESS_DENIED_ERROR'),
    failure('ER_SPECIFIC_ACCESS_DENIED_ERROR', 'ADMIN/OPERATOR privilege required'),
    failure('ER_PARSE_ERROR'),
    failure('ER_BAD_DB_ERROR'),
    failure('ER_QUERY_TIMEOUT'),
    failure('ER_UNKNOWN_ERROR', 'A user table named master is unavailable'),
    failure('CERT_HAS_EXPIRED'),
  ];
  let current;
  const mock = fixture(context, {
    [keyFor(primary)]: { query() { throw current; } },
    [keyFor(peer)]: {},
  });
  const client = mock.client({ ...config, feEndpoints: [peer] });
  for (const error of errors) {
    current = error;
    await assert.rejects(select(client), (actual) => actual === error);
  }
  assert.ok(mock.connected().every((endpoint) => endpoint === keyFor(primary)));
  assert.equal(mock.pools.length, 1);
});

test('known Doris election errors retry a read on another FE', async (context) => {
  const mock = fixture(context, {
    [keyFor(primary)]: { query() { throw failure('ER_UNKNOWN_ERROR', 'Master FE is not ready. You may need to check FE status'); } },
    [keyFor(peer)]: {},
  });
  const client = mock.client({ ...config, feEndpoints: [peer] });
  await select(client);
  assert.deepEqual(client.endpoint, peer);
  assert.deepEqual(mock.connected(), [keyFor(primary), keyFor(peer)]);
});

test('topology learns only alive joined FE query endpoints from that source', async (context) => {
  let unavailable = false;
  const columns = ['Host', 'Alive', 'Join', 'QueryPort', 'HttpPort'];
  const rows = [
    [primary.host, 'true', 'true', primary.port, 8030],
    ['dead.test', 'false', 'true', 9030, 8030],
    ['not-joined.test', 'true', 'false', 9030, 8030],
    ['bad/address', 'true', 'true', 9030, 8030],
    [peer.host, 'true', 'true', peer.port, 8130],
  ];
  const mock = fixture(context, {
    [keyFor(primary)]: {
      connectError: () => unavailable ? failure('ECONNREFUSED') : null,
      query(sql) {
        if (sql === 'SHOW FRONTENDS') return result(columns, rows);
        if (sql === 'SHOW BACKENDS') return result(['Host', 'Alive'], []);
        return result(undefined, []);
      },
    },
    [keyFor(peer)]: {},
  });
  const client = mock.client();
  const topology = await readClusterStatus(client);
  assert.equal(topology.frontends.error, null);
  unavailable = true;
  await select(client);
  assert.deepEqual(client.endpoint, peer);
  assert.equal(mock.pools.length, 2);
  assert.ok(mock.pools.every(({ endpoint }) => [keyFor(primary), keyFor(peer)].includes(endpoint)));
});

test('legacy metrics follow a newly connected peer even when SHOW is forbidden', async (context) => {
  const mock = fixture(context, {
    [keyFor(primary)]: { connectError: failure('ECONNREFUSED') },
    [keyFor(peer)]: { query(sql) {
      if (sql.startsWith('SHOW')) throw failure('ER_SPECIFIC_ACCESS_DENIED_ERROR', 'Access denied; ADMIN/OPERATOR required');
      return result(undefined, []);
    } },
  });
  const client = mock.client({ ...config, feEndpoints: [peer] });
  const urls = [];
  const topology = await readClusterStatus(client, { host: primary.host, includeMetrics: true,
    request: async (url) => {
      urls.push(new URL(url));
      return new Response(new URL(url).pathname === '/api/health'
        ? JSON.stringify({ code: 0, data: { online_backend_num: 2, total_backend_num: 3 } })
        : 'node_info{type="fe_node_num",state="total"} 3\nnode_info{type="be_node_num",state="total"} 3\ndoris_fe_qps 7\n');
    },
  });
  assert.equal(topology.frontends.code, 'legacy-permission');
  assert.equal(topology.backends.summary.online, 2);
  assert.equal(topology.feMetrics.qps, 7);
  assert.equal(urls.length, 2);
  assert.ok(urls.every(({ hostname }) => hostname === peer.host), 'Fallback metrics still use the failed primary');
});

test('each source keeps an independent discovered roster and pool set', async (context) => {
  const other = { host: 'other.test', port: 9030 };
  const mock = fixture(context, {
    [keyFor(primary)]: { connectError: failure('ECONNREFUSED') },
    [keyFor(peer)]: {},
    [keyFor(other)]: { connectError: failure('ECONNREFUSED') },
  });
  const first = mock.client();
  const second = mock.client({ ...config, ...other });
  first.rememberFrontends([{ ...peer, alive: true, joined: true }]);
  await select(first);
  await assert.rejects(select(second), { status: 503 });
  assert.deepEqual(first.endpoint, peer);
  assert.equal(second.endpoint, null);
  assert.equal(mock.connected().filter((endpoint) => endpoint === keyFor(peer)).length, 1);
});

test('configured seeds survive a source registry restart and legacy configs remain readable', async (context) => {
  const directory = await temporaryDirectory(context);
  const oldSource = { id: 'b445e213-a7a0-4e1e-a831-76dcecb2f004', name: '旧连接',
    config: { ...config } };
  await writeFile(join(directory, 'sources.json'), JSON.stringify({ version: 1, environmentName: null, sources: [oldSource] }));
  const registry = createSourceRegistry({ directory, initialConfig: null });
  await registry.load();
  assert.equal(registry.storageError, null);
  assert.deepEqual(registry.get(oldSource.id).config, { ...config, type: 'doris' });
  const { id } = await registry.add({ name: '有备用 FE', ...primary, username: config.user,
    password: config.password, feEndpoints: `${peer.host}:${peer.port}` });
  const reopened = createSourceRegistry({ directory, initialConfig: null });
  await reopened.load();
  assert.deepEqual(reopened.get(id).config.feEndpoints, [peer]);
  const contents = await readFile(join(directory, 'sources.json'), 'utf8');
  assert.equal(JSON.parse(contents).version, 1);
  const mock = fixture(context, {
    [keyFor(primary)]: { connectError: failure('ECONNREFUSED') },
    [keyFor(peer)]: {},
  });
  await select(mock.client(reopened.get(id).config));
  assert.deepEqual(mock.connected(), [keyFor(primary), keyFor(peer)]);
});

test('FE seed parsing accepts explicit ports and IPv6 and rejects URLs or malformed input', () => {
  assert.deepEqual(parseFeEndpoints('peer.test:9130,[2001:db8::1]:9030,peer.test:9130'),
    [peer, { host: '2001:db8::1', port: 9030 }]);
  assert.deepEqual(parseFeEndpoints(undefined), []);
  const base = { name: '旧格式', ...primary, username: config.user, password: config.password };
  assert.equal(Object.hasOwn(parseSourceInput(base).config, 'feEndpoints'), false);
  for (const value of ['https://peer.test:9030', 'peer.test', 'peer.test:0', 'peer.test:65536', 'a/b:9030', '2001:db8::1:9030', null]) {
    assert.throws(() => parseFeEndpoints(value), { status: 400 });
  }
  assert.throws(() => parseFeEndpoints(Array.from({ length: 9 }, () => peer)), { status: 400 });
});

test('reconnect attempts stay bounded and close releases every created pool', async (context) => {
  const extras = [{ host: 'third.test', port: 9030 }, { host: 'fourth.test', port: 9030 }];
  const endpoints = [primary, peer, ...extras];
  const mock = fixture(context, Object.fromEntries(endpoints.map((endpoint) =>
    [keyFor(endpoint), { connectError: failure('ECONNREFUSED') }])));
  const client = mock.client({ ...config, feEndpoints: [peer, ...extras] });
  await assert.rejects(select(client), { status: 503 });
  assert.equal(mock.connected().length, 3);
  await mock.close();
  assert.ok(mock.pools.every(({ closed }) => closed));
  const count = mock.connected().length;
  await assert.rejects(select(client), { status: 503 });
  assert.equal(mock.connected().length, count);
});

test('switching the connected FE resets only its alert baseline and persists the metric identity', async (context) => {
  const directory = await temporaryDirectory(context);
  const source = { id: 'default', name: '测试集群' };
  const sent = [];
  const channel = { get: async () => ({ configured: true,
    webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/fixture', secret: null }) };
  let at = Date.parse('2026-11-24T00:00:00.000Z');
  const engine = () => createAlerts(createAlertStore(directory), {
    channel, listSourceIds: () => [source.id], now: () => at,
    send: async (message) => { sent.push(message); },
  });
  let alerts = engine();
  const { config: settings } = await alerts.read(source.id);
  await alerts.update(source.id, { ...settings, enabled: true, thresholds: {
    feOffline: null, beOffline: null, cpuPercent: null, diskPercent: null,
    memoryPercent: 85, qps: 200, latencyMs: 500,
  } });
  const primarySource = JSON.stringify(primary);
  const peerSource = JSON.stringify(peer);
  const high = { memoryPercent: 90, qps: 250, latencyMs: 750 };
  const healthy = { memoryPercent: 30, qps: 50, latencyMs: 100 };
  async function sample(metricSource, values) {
    at += 30_000;
    await alerts.sample(source, { sampledAt: new Date(at).toISOString(),
      metricScope: 'connected-fe', metricSource }, values);
  }
  await sample(primarySource, high);
  await sample(peerSource, high);
  assert.equal(sent.length, 0, 'Different FEs were counted as consecutive samples');
  await sample(peerSource, high);
  assert.equal(sent.length, 1);
  assert.equal((await alerts.read(source.id)).status.active.length, 3);
  const saved = JSON.parse(await readFile(join(directory, 'default.json'), 'utf8'));
  assert.ok(Object.values(saved.runtime.rules).every(({ metricSource }) => metricSource === peerSource));
  alerts = engine();
  await sample(primarySource, healthy);
  assert.equal(sent.length, 1, 'A healthy replacement FE falsely recovered the previous FE');
  assert.equal((await alerts.read(source.id)).status.active.length, 0);
  await sample(primarySource, high);
  assert.equal(sent.length, 1);
  await sample(primarySource, high);
  assert.equal(sent.length, 2, 'New FE did not establish its own alert baseline');
});
