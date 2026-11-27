import assert from 'node:assert/strict';
import { mkdtemp, readdir, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createMysqlMonitoring } from '../server/mysql-monitoring.mjs';

const baseTime = Date.parse('2026-11-27T00:00:00.000Z');
const status = {
  Uptime: '1000', Uptime_since_flush_status: '1000', Questions: '10000',
  Com_commit: '100', Com_rollback: '10', Bytes_received: '1000', Bytes_sent: '2000',
  Threads_connected: '12', Threads_running: '3', Slow_queries: '5',
  Innodb_buffer_pool_read_requests: '1000', Innodb_buffer_pool_reads: '10',
};
const settings = { max_connections: '100', server_uuid: 'fixture-server-a' };
const denied = Object.assign(new Error('fixture password must never reach API output'), { code: 'ER_ACCESS_DENIED_ERROR' });

function show(values) {
  return { columns: ['VARIABLE_NAME', 'vAlUe'], truncated: false,
    rows: Object.entries(values).map(([Variable_name, Value]) => ({ VARIABLE_NAME: Variable_name, vAlUe: Value })) };
}

function harness(context, options = {}) {
  const timers = new Set();
  const monitors = [];
  const calls = [];
  const alerts = [];
  let frame = { status, settings, storage: { tableCount: '2', bytes: '4096' } };
  let at = baseTime;
  let active = 0;
  let maximumActive = 0;
  context.mock.method(globalThis, 'setInterval', (callback, interval) => {
    assert.equal(interval, 30_000);
    const timer = { callback, unref() {} };
    timers.add(timer);
    return timer;
  });
  context.mock.method(globalThis, 'clearInterval', (timer) => timers.delete(timer));
  const client = {
    async withConnection(work) {
      active++;
      maximumActive = Math.max(maximumActive, active);
      try {
        return await work(async (sql, limits) => {
          calls.push({ sql, limits });
          assert.ok(limits.timeoutMs > 0 && limits.timeoutMs <= 4_000);
          if (sql.startsWith('SHOW GLOBAL STATUS')) {
            assert.match(sql, /WHERE Variable_name IN/);
            assert.equal(limits.maxRows, 12);
            if (frame.statusWait) await frame.statusWait;
            if (frame.statusError) throw frame.statusError;
            return frame.statusResult ?? show(frame.status);
          }
          if (sql.startsWith('SHOW GLOBAL VARIABLES')) {
            assert.match(sql, /WHERE Variable_name IN/);
            assert.equal(limits.maxRows, 2);
            if (frame.variablesError) throw frame.variablesError;
            return show(frame.settings);
          }
          assert.match(sql, /^SELECT COUNT\(\*\) AS tableCount, SUM\(DATA_LENGTH \+ INDEX_LENGTH\) AS bytes/);
          assert.match(sql, /FROM information_schema.tables/);
          assert.match(sql, /TABLE_SCHEMA NOT IN/);
          assert.equal(limits.maxRows, 1);
          if (frame.storageError) throw frame.storageError;
          return { truncated: false, rows: [frame.storage] };
        });
      } finally {
        active--;
      }
    },
  };
  function create(overrides = {}) {
    const monitor = createMysqlMonitoring({ client, clusterKey: 'fixture-source', now: () => at,
      onSample: async (snapshot, values) => { alerts.push({ snapshot, values }); },
      ...options, ...overrides });
    monitors.push(monitor);
    return monitor;
  }
  context.after(async () => {
    for (const monitor of monitors) await monitor.close();
    assert.equal(timers.size, 0);
    assert.equal(active, 0);
  });
  return {
    calls, alerts, create,
    setFrame(next = {}) { frame = { status, settings, storage: { tableCount: '2', bytes: '4096' }, ...next }; },
    setTime(next) { at = next; },
    async tick(milliseconds = 30_000) {
      at += milliseconds;
      await Promise.all([...timers].map(({ callback }) => callback()));
      await setImmediate();
    },
    get maximumActive() { return maximumActive; },
  };
}

async function temporaryDirectory(context) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const directory = await mkdtemp(join(root, '.mysql-monitoring-test-'));
  async function remove(path) {
    assert.ok(path.startsWith(directory));
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await remove(child);
      else await unlink(child);
    }
    await rmdir(path);
  }
  context.after(() => remove(directory));
  return directory;
}

test('MySQL monitoring is lazy and first sample exposes gauges with unavailable rates', async (context) => {
  const mock = harness(context);
  const monitor = mock.create();
  assert.equal(mock.calls.length, 0);
  assert.equal(monitor.read('24h').sourceStatus, 'unavailable');
  assert.ok(monitor.read('24h').history.every(({ qps, latencyMs }) => qps === null && latencyMs === null));
  await monitor.start();
  await setImmediate();
  const sample = monitor.read('24h');
  assert.equal(sample.metricScope, 'mysql');
  assert.equal(sample.sourceStatus, 'partial');
  assert.equal(sample.current.connections, 12);
  assert.equal(sample.current.maxConnections, 100);
  assert.equal(sample.current.connectionUsagePercent, 12);
  assert.equal(sample.current.threadsRunning, 3);
  assert.equal(sample.current.uptimeSeconds, 1000);
  assert.equal(sample.current.storageBytes, 4096);
  for (const key of ['qps', 'tps', 'slowQueriesPerSecond', 'networkBytesPerSecond', 'bufferPoolHitPercent',
    'latencyMs', 'cpuPercent', 'memoryPercent', 'diskPercent', 'storageTotalBytes']) {
    assert.equal(sample.current[key], null, key);
  }
  assert.deepEqual(mock.alerts[0].values, { qps: null, connectionUsagePercent: 12, threadsRunning: 3, slowQueriesPerSecond: null });
  assert.equal(mock.calls.length, 3);
  await monitor.start();
  assert.equal(mock.calls.length, 3, 'Calling start twice must not create another sampler');
});

test('rates use exact deltas above 2^53 and buffer hit ratio covers the sample interval', async (context) => {
  const mock = harness(context);
  const huge = 9_007_199_254_740_993_000n;
  const first = { ...status, Questions: String(huge), Com_commit: String(huge), Com_rollback: String(huge),
    Bytes_received: String(huge), Bytes_sent: String(huge), Slow_queries: String(huge),
    Innodb_buffer_pool_read_requests: String(huge), Innodb_buffer_pool_reads: String(huge) };
  mock.setFrame({ status: first });
  const monitor = mock.create();
  await monitor.start();
  const next = { ...first, Uptime: '1030', Uptime_since_flush_status: '1030', Questions: String(huge + 90n),
    Com_commit: String(huge + 90n), Com_rollback: String(huge + 30n),
    Bytes_received: String(huge + 900n), Bytes_sent: String(huge + 600n), Slow_queries: String(huge + 3n),
    Innodb_buffer_pool_read_requests: String(huge + 1000n), Innodb_buffer_pool_reads: String(huge + 10n) };
  mock.setFrame({ status: next });
  await mock.tick();
  const sample = monitor.read('24h');
  assert.equal(sample.sourceStatus, 'ok');
  assert.equal(sample.current.qps, 3);
  assert.equal(sample.current.tps, 4);
  assert.equal(sample.current.networkBytesPerSecond, 50);
  assert.equal(sample.current.slowQueriesPerSecond, 0.1);
  assert.equal(sample.current.bufferPoolHitPercent, 99);
  assert.equal(sample.history.filter(({ qps }) => qps === 3).length, 1);
  assert.ok(sample.history.every(({ latencyMs }) => latencyMs === null));
  assert.equal(mock.alerts.at(-1).values.slowQueriesPerSecond, 0.1);
  sample.current.qps = -1;
  assert.equal(monitor.read('24h').current.qps, 3, 'Read results may not mutate the sampler');
  mock.setFrame({ status: { ...next, Uptime: '1060', Uptime_since_flush_status: '1060' } });
  await mock.tick();
  assert.equal(monitor.read('24h').current.qps, 0);
  assert.equal(monitor.read('24h').current.bufferPoolHitPercent, null, 'An idle interval has no buffer read ratio');
});

test('restart, flush reset, instance changes and long gaps each establish a new baseline', async (context) => {
  const mock = harness(context);
  const monitor = mock.create();
  await monitor.start();
  mock.setFrame({ status: { ...status, Uptime: '5', Uptime_since_flush_status: '5', Questions: '20000' } });
  await mock.tick();
  assert.equal(monitor.read('24h').current.qps, null);
  mock.setFrame({ status: { ...status, Uptime: '35', Uptime_since_flush_status: '35', Questions: '20090' } });
  await mock.tick();
  assert.equal(monitor.read('24h').current.qps, 3);
  mock.setFrame({ status: { ...status, Uptime: '65', Uptime_since_flush_status: '1', Questions: '20180' } });
  await mock.tick();
  assert.equal(monitor.read('24h').current.qps, null);
  mock.setFrame({ status: { ...status, Uptime: '95', Uptime_since_flush_status: '31', Questions: '20270' },
    settings: { ...settings, server_uuid: 'fixture-server-b' } });
  await mock.tick();
  assert.equal(monitor.read('24h').current.qps, null);
  mock.setFrame({ status: { ...status, Uptime: '215', Uptime_since_flush_status: '151', Questions: '20630' },
    settings: { ...settings, server_uuid: 'fixture-server-b' } });
  await mock.tick(120_000);
  assert.equal(monitor.read('24h').current.qps, null);
  mock.setFrame({ status: { ...status, Uptime: '245', Uptime_since_flush_status: '181', Questions: '20720' },
    settings: { ...settings, server_uuid: 'fixture-server-b' } });
  await mock.tick();
  assert.equal(monitor.read('24h').current.qps, 3);
  mock.setTime(baseTime + 360_001);
  const stale = monitor.read('24h');
  assert.equal(stale.sourceStatus, 'unavailable');
  assert.ok(Object.values(stale.current).every((value) => value === null));
});

test('decreasing or missing counters produce unknown rates while valid gauges remain available', async (context) => {
  const mock = harness(context);
  const monitor = mock.create();
  await monitor.start();
  mock.setFrame({ status: { ...status, Uptime: '1030', Uptime_since_flush_status: '1030',
    Questions: '1', Com_commit: '1', Bytes_sent: '1', Slow_queries: '-1',
    Innodb_buffer_pool_reads: 'not-a-number' } });
  await mock.tick();
  const sample = monitor.read('24h');
  assert.equal(sample.sourceStatus, 'partial');
  assert.equal(sample.current.connections, 12);
  for (const key of ['qps', 'tps', 'networkBytesPerSecond', 'slowQueriesPerSecond', 'bufferPoolHitPercent']) {
    assert.equal(sample.current[key], null, key);
  }
  assert.equal(mock.alerts.at(-1).values.qps, null);
  assert.equal(mock.alerts.at(-1).values.slowQueriesPerSecond, null);
});

test('denied status does not expose driver text or turn missing metrics into healthy zeroes', async (context) => {
  const mock = harness(context);
  const monitor = mock.create();
  await monitor.start();
  mock.setFrame({ statusError: denied });
  const before = mock.calls.length;
  await mock.tick();
  assert.equal(mock.calls.length, before + 1, 'No optional queries should follow a failed status query');
  const unavailable = monitor.read('24h');
  assert.equal(unavailable.sourceStatus, 'unavailable');
  assert.ok(Object.values(unavailable.current).every((value) => value === null));
  assert.ok(!JSON.stringify(unavailable).includes(denied.message));
  assert.deepEqual(mock.alerts.at(-1).values, { qps: null, connectionUsagePercent: null, threadsRunning: null, slowQueriesPerSecond: null });
  mock.setFrame({ status: { ...status, Uptime: '1060', Uptime_since_flush_status: '1060', Questions: '10180' } });
  await mock.tick();
  assert.equal(monitor.read('24h').current.qps, null, 'A failed sample breaks the previous rate baseline');
});

test('optional metadata failures preserve status and empty visibility reports zero table estimate', async (context) => {
  const mock = harness(context);
  mock.setFrame({ variablesError: denied, storageError: denied });
  const monitor = mock.create();
  await monitor.start();
  let sample = monitor.read('24h');
  assert.equal(sample.sourceStatus, 'partial');
  assert.equal(sample.current.connections, 12);
  assert.equal(sample.current.maxConnections, null);
  assert.equal(sample.current.connectionUsagePercent, null);
  assert.equal(sample.current.storageBytes, null);
  mock.setFrame({ status: { ...status, Uptime: '1030', Uptime_since_flush_status: '1030', Questions: '10090' },
    variablesError: denied, storage: { tableCount: '0', bytes: null } });
  await mock.tick();
  sample = monitor.read('24h');
  assert.equal(sample.current.qps, 3);
  assert.equal(sample.current.storageBytes, 0);
  mock.setFrame({ status: {}, storage: { tableCount: '0', bytes: null } });
  await mock.tick();
  assert.equal(monitor.read('24h').sourceStatus, 'unavailable', 'Settings and a table estimate are not live status');
});

test('truncated status is discarded and monitoring calls never overlap', async (context) => {
  const mock = harness(context);
  mock.setFrame({ statusResult: { ...show(status), truncated: true } });
  const monitor = mock.create();
  await monitor.start();
  assert.equal(monitor.read('24h').sourceStatus, 'unavailable');
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  mock.setFrame({ statusWait: wait });
  const first = mock.tick();
  const second = mock.tick();
  await setImmediate();
  assert.equal(mock.maximumActive, 1);
  const close = monitor.close();
  let completed = false;
  close.then(() => { completed = true; });
  await setImmediate();
  assert.equal(completed, false, 'Close should drain the in-flight status call');
  const before = mock.calls.length;
  release();
  await Promise.all([first, second, close]);
  assert.equal(mock.calls.length, before, 'Close must stop optional reads after the pending status resolves');
  await monitor.start();
  await mock.tick();
  assert.equal(mock.calls.length, before);
});

test('QPS history persists across restart and remains separated by MySQL source', async (context) => {
  const directory = await temporaryDirectory(context);
  const mock = harness(context, { directory });
  const monitor = mock.create();
  await monitor.start();
  mock.setFrame({ status: { ...status, Uptime: '1030', Uptime_since_flush_status: '1030', Questions: '10300' } });
  await mock.tick();
  assert.ok(monitor.read('30d').history.some(({ qps }) => qps === 10));
  await monitor.close();
  const reopened = mock.create();
  await reopened.start();
  assert.ok(reopened.read('30d').history.some(({ qps }) => qps === 10));
  assert.equal(reopened.read('24h').current.qps, null, 'Rate baselines must not be restored from chart history');
  const other = mock.create({ clusterKey: 'different-source' });
  await other.start();
  assert.ok(other.read('30d').history.every(({ qps }) => qps === null));
  assert.equal((await readdir(directory)).length, 2);
  await reopened.close();
  await other.close();
});

test('rejected alert callbacks do not interrupt later valid monitoring samples', async (context) => {
  const mock = harness(context);
  let attempts = 0;
  const monitor = mock.create({ onSample: async () => { attempts++; throw new Error('fixture delivery failure'); } });
  await monitor.start();
  await setImmediate();
  mock.setFrame({ status: { ...status, Uptime: '1030', Uptime_since_flush_status: '1030', Questions: '10300' } });
  await mock.tick();
  assert.equal(monitor.read('24h').current.qps, 10);
  assert.equal(attempts, 2);
});
