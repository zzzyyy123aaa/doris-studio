import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { counterDelta, cpuDelta, metricsUrl, networkRate, scrapeDorisMetrics } from './doris-metrics.mjs';
import { createMonitoringHistory } from './monitoring-history.mjs';

const intervalMs = 30_000;
const maxIntervalMs = 90_000;
const concurrentScrapes = 8;
const maxTargets = 128;
const legacyBeHttpPort = 8040;
const emptyMetrics = {
  qps: null,
  latencyMs: null,
  storageBytes: null,
  storageTotalBytes: null,
  diskPercent: null,
  cpuPercent: null,
  memoryPercent: null,
  networkBytesPerSecond: null,
};

function groupHealth(group) {
  if (group.summary) return group.summary;
  if (group.error) return null;
  return {
    total: group.nodes.length,
    online: group.nodes.filter(({ alive }) => alive === true).length,
    unknown: group.nodes.filter(({ alive }) => alive === null).length,
  };
}

function knownOffline(group) {
  if (!group || group.online === null || group.unknown !== 0) return null;
  return group.total - group.online;
}

function storageBytes(text) {
  const match = /^(\d+(?:\.\d+)?)\s*(B|[KMGTPE]I?B)?$/i.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  const power = match[2] ? 'BKMGTPE'.indexOf(match[2][0].toUpperCase()) : 0;
  const bytes = value * 1024 ** power;
  return Number.isFinite(bytes) ? Math.round(bytes) : null;
}

function summarizeStorage(nodes) {
  let used = 0;
  let total = 0;
  let count = 0;
  for (const node of nodes) {
    if (node.alive !== true) continue;
    const dataBytes = storageBytes(node.diskUsed);
    const diskBytes = storageBytes(node.diskTotal);
    if (dataBytes === null || !(diskBytes > 0) || dataBytes > diskBytes) continue;
    used += dataBytes;
    total += diskBytes;
    count++;
  }
  return { used: count ? used : null, total: count ? total : null, count };
}

function summarizeBeStorage(reports) {
  if (!reports.length) return { used: null, total: null, count: 0, sharedCapacityPossible: false };
  return {
    used: reports.reduce((sum, report) => sum + report.used, 0),
    total: reports.every(({ total }) => total !== null) ? reports.reduce((sum, report) => sum + report.total, 0) : null,
    count: reports.filter(({ complete }) => complete).length,
    sharedCapacityPossible: reports.some(({ sharedCapacityPossible }) => sharedCapacityPossible),
  };
}

function totalRatio(pairs, numerator) {
  let top = 0;
  let bottom = 0;
  for (const pair of pairs) {
    top += pair[numerator];
    bottom += pair.total;
  }
  return bottom > 0 ? 100 * top / bottom : null;
}

function perTargetDeltas(entry, previous) {
  if (!previous || (entry.node.lastStartTime && previous.node.lastStartTime &&
      entry.node.lastStartTime !== previous.node.lastStartTime)) return null;
  const elapsed = entry.at - previous.at;
  if (elapsed <= 0 || elapsed > maxIntervalMs) return null;
  return { previous: previous.metrics, seconds: elapsed / 1000 };
}

function normalizeHost(host) {
  return host.toLowerCase().replace(/^\[|\]$|\.$/g, '');
}

function fullyCovered(hostMetrics, nodes) {
  return nodes.length > 0 && nodes.every(({ host }) => hostMetrics.has(normalizeHost(host)));
}

function summarize(topology, collected, previous) {
  const { frontends, backends } = topology;
  const singleFe = frontends.code === 'legacy-permission';
  const legacyBe = backends.code === 'legacy-permission';
  const feMetrics = topology.feMetrics;
  const beStorageReports = [];
  const coverage = {
    fe: feMetrics ? 1 : 0, feTotal: singleFe ? frontends.summary?.total ?? 0 : frontends.nodes.length,
    be: 0, beTotal: legacyBe ? backends.summary?.total ?? backends.nodes.length : backends.nodes.length,
  };
  const cpu = new Map();
  const memory = new Map();
  const network = new Map();
  const bePeaks = [];
  let qps = 0;
  let qpsContributors = 0;
  let latencyCount = 0;
  let latencySum = 0;
  let latencyContributors = 0;
  for (const [key, entry] of collected) {
    const { node, type, metrics } = entry;
    const host = normalizeHost(node.host);
    const delta = perTargetDeltas(entry, previous.get(key));
    coverage[type]++;
    if (type === 'fe') {
      if (metrics.memoryUsage && !memory.has(host)) memory.set(host, metrics.memoryUsage);
      if (!delta) continue;
      const queries = counterDelta(metrics.queries, delta.previous.queries);
      if (queries !== null) {
        qps += queries / delta.seconds;
        qpsContributors++;
      }
      const newSamples = counterDelta(metrics.latencyCount, delta.previous.latencyCount);
      if (newSamples === null || (newSamples > 0 && metrics.latencyMean === null)) continue;
      latencyContributors++;
      if (newSamples > 0) {
        // Doris exports reservoir mean × lifetime count. Only the count is cumulative.
        latencySum += metrics.latencyMean * newSamples;
        latencyCount += newSamples;
      }
    } else {
      if (legacyBe && metrics.storage) beStorageReports.push(metrics.storage);
      if (Number.isFinite(metrics.diskPeak)) bePeaks.push(metrics.diskPeak);
      if (delta) {
        const usage = cpuDelta(metrics.cpu, delta.previous.cpu);
        const rate = networkRate(metrics, delta.previous, delta.seconds);
        if (usage && !cpu.has(host)) cpu.set(host, usage);
        if (rate !== null && !network.has(host)) network.set(host, rate);
      }
    }
  }

  const storage = legacyBe ? summarizeBeStorage(beStorageReports) : summarizeStorage(backends.nodes);
  const diskValues = legacyBe ? bePeaks : backends.nodes.filter(({ alive }) => alive === true).map(({ diskMaxUsedPercent }) => diskMaxUsedPercent);
  const diskPercent = coverage.beTotal > 0 && diskValues.length === coverage.beTotal && diskValues.every(Number.isFinite) ? Math.max(...diskValues) : null;
  return {
    coverage,
    storage,
    beCpuCount: cpu.size,
    beNetworkCount: network.size,
    qpsComplete: qpsContributors > 0 && qpsContributors === coverage.feTotal,
    latencyComplete: latencyContributors > 0 && latencyContributors === coverage.feTotal,
    cpuComplete: legacyBe ? coverage.beTotal > 0 && cpu.size === coverage.beTotal : !backends.error && fullyCovered(cpu, backends.nodes),
    memoryComplete: singleFe ? Boolean(feMetrics?.memoryUsage) : !frontends.error && fullyCovered(memory, frontends.nodes),
    storageComplete: storage.count > 0 && storage.count === coverage.beTotal,
    resourcesComplete: fullyCovered(memory, frontends.nodes) && fullyCovered(cpu, backends.nodes) && fullyCovered(network, backends.nodes),
    latencyCount,
    current: {
      qps: singleFe ? feMetrics?.qps ?? null : qpsContributors ? qps : null,
      latencyMs: singleFe ? feMetrics?.latencyMean ?? null : latencyCount ? latencySum / latencyCount : null,
      storageBytes: storage.used,
      storageTotalBytes: storage.total,
      diskPercent,
      cpuPercent: totalRatio(cpu.values(), 'busy'),
      memoryPercent: singleFe && feMetrics?.memoryUsage ? totalRatio([feMetrics.memoryUsage], 'used') : totalRatio(memory.values(), 'used'),
      networkBytesPerSecond: network.size ? [...network.values()].reduce((sum, rate) => sum + rate, 0) : null,
    },
  };
}

async function collectMetrics(topology, signal, fetchMetrics, now) {
  const targets = new Map();
  const ambiguous = new Set();
  for (const [type, group] of [['fe', topology.frontends], ['be', topology.backends]]) {
    const legacy = type === 'be' && group.code === 'legacy-permission' && group.nodeSource === 'fe-metrics';
    if (group.error && !legacy) continue;
    for (const node of group.nodes) {
      const url = metricsUrl(legacy ? { host: node.host, httpPort: legacyBeHttpPort } : node);
      if (!url) continue;
      const key = `${legacy ? 'legacy-be' : type}:${url.href}`;
      if (legacy && (targets.has(key) || ambiguous.has(key))) {
        // A default HTTP port cannot identify which BE to monitor on a shared host.
        ambiguous.add(key);
        targets.delete(key);
        continue;
      }
      targets.set(key, { url, type, node });
    }
  }
  const queue = [...targets.entries()].slice(0, maxTargets);
  const collected = new Map();
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  let next = 0;
  async function scrape() {
    while (next < queue.length && !deadline.aborted) {
      const [key, target] = queue[next++];
      try {
        const metrics = await scrapeDorisMetrics(target.url, target.type, deadline, fetchMetrics);
        if (metrics) collected.set(key, { ...target, metrics, at: now() });
      } catch {
        // A blocked or restarted node should not hide other sources.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrentScrapes, queue.length) }, scrape));
  return { collected, ambiguousHosts: ambiguous.size };
}

function legacyBeStatus(backends, summary, hasPrevious, ambiguousHosts) {
  if (backends.code !== 'legacy-permission') return null;
  const { coverage, storage, beCpuCount, beNetworkCount } = summary;
  const reachable = coverage.be;
  const total = coverage.beTotal;
  const issues = [];
  if (ambiguousHosts) issues.push('同一地址对应多个 BE，默认 HTTP 端口无法区分。');
  if (!backends.nodes.length && (total > 0 || !backends.summary)) {
    issues.push('FE 指标未提供完整 BE 地址，暂无法采集 BE 指标。');
  } else if (reachable < total) {
    issues.push('部分 BE 指标未采集，可检查 BE 默认 HTTP 端口 8040 的 /metrics。');
  }
  if (storage.sharedCapacityPossible) issues.push('BE 数据目录可能共用磁盘，暂不汇总总容量。');
  else if (reachable && (storage.count < reachable || storage.total === null)) issues.push('部分 BE 存储指标未返回。');
  if (reachable && !hasPrevious) issues.push('CPU 和网络速率将在下一轮采样后显示。');
  else if (reachable && (beCpuCount < reachable || beNetworkCount < reachable)) issues.push('部分 BE CPU 或网络指标缺少有效样本。');
  return { port: legacyBeHttpPort, reachable, total, issue: issues.join(' ') || null };
}

function describeSample(topology, summary, hasPrevious) {
  const { coverage, current, storageComplete, resourcesComplete, qpsComplete, latencyComplete, latencyCount } = summary;
  const issues = [];
  const permissionLimited = [topology.frontends, topology.backends].some(({ code }) => code === 'legacy-permission' || code === 'permission');
  if (permissionLimited) issues.push('节点明细受当前 Doris 账号的权限限制。');
  else if (topology.frontends.error || topology.backends.error) issues.push('部分节点列表无法读取，请查看集群节点中的错误。');
  if (topology.frontends.code === 'legacy-permission' && !topology.feMetrics) {
    issues.push('当前 FE 的 /metrics 暂不可用，可检查默认 HTTP 端口 8030。');
  }
  if ((!topology.frontends.error && coverage.fe < coverage.feTotal) || (!topology.backends.error && coverage.be < coverage.beTotal)) {
    issues.push('部分节点的 /metrics 无法读取，请检查内网服务器到 FE 和 BE 的 HTTP 端口。');
  } else if (!permissionLimited && (coverage.feTotal === 0 || coverage.beTotal === 0)) {
    issues.push('没有可采集的 FE 或 BE 节点。');
  } else if (!permissionLimited && !hasPrevious) {
    issues.push('正在建立采样基线，速率指标会在下一轮采样后显示。');
  }
  if (!permissionLimited && hasPrevious && (!storageComplete || !resourcesComplete || !qpsComplete || !latencyComplete)) {
    issues.push('部分指标缺少有效样本，已返回的数值仅覆盖可采集节点。');
  }
  const available = Boolean(topology.frontends.summary || topology.backends.summary) || Object.values(current).some((value) => value !== null);
  if (!issues.length && !available) issues.push('暂未收到有效的 Doris 监控指标。');
  const sourceStatus = available ? (issues.length ? 'partial' : 'ok') : 'unavailable';
  const message = issues.join(' ') || (latencyComplete && latencyCount === 0 ? '本轮没有新的查询耗时记录。' : null);
  return { sourceStatus, message };
}

export function createMonitoring({ getTopology, directory, clusterKey, onSample, fetchMetrics = fetch, now = Date.now }) {
  const namespace = createHash('sha256').update(clusterKey).digest('hex').slice(0, 24);
  const historyDirectory = directory ? join(directory, namespace) : '';
  const history = createMonitoringHistory(historyDirectory);
  let connectedFeHistory;
  const controller = new AbortController();
  let timer;
  let pending;
  let pendingAlert;
  let previous = new Map();
  let previousAt = null;
  let snapshot = {
    sampledAt: null,
    sourceStatus: 'unavailable',
    message: '正在等待首次采样。',
    metricScope: 'cluster',
    current: emptyMetrics,
    coverage: { fe: 0, feTotal: 0, be: 0, beTotal: 0 },
    health: null,
    beMetrics: null,
  };

  async function sample() {
    const topology = await getTopology();
    if (controller.signal.aborted) return;
    const { collected, ambiguousHosts } = await collectMetrics(topology, controller.signal, fetchMetrics, now);
    if (controller.signal.aborted) return;
    const at = now();
    const metricScope = topology.frontends.code === 'legacy-permission' ? 'connected-fe' : 'cluster';
    const elapsed = previousAt === null || snapshot.metricScope !== metricScope ? 0 : at - previousAt;
    const summary = summarize(topology, collected, previous);
    const { current, coverage, qpsComplete, latencyComplete, latencyCount } = summary;
    snapshot = {
      sampledAt: new Date(at).toISOString(), current, coverage, metricScope,
      beMetrics: legacyBeStatus(topology.backends, summary, [...previous.values()].some(({ type }) => type === 'be'), ambiguousHosts),
      health: { fe: groupHealth(topology.frontends), be: groupHealth(topology.backends) },
      ...describeSample(topology, summary, Boolean(previous.size)),
    };
    previous = collected;
    previousAt = at;
    if (onSample && !pendingAlert) {
      const values = {
        feOffline: knownOffline(snapshot.health.fe), beOffline: knownOffline(snapshot.health.be),
        cpuPercent: summary.cpuComplete ? current.cpuPercent : null,
        memoryPercent: summary.memoryComplete ? current.memoryPercent : null,
        diskPercent: current.diskPercent,
        qps: metricScope === 'connected-fe' || qpsComplete ? current.qps : null,
        latencyMs: metricScope === 'connected-fe' || latencyComplete ? current.latencyMs : null,
      };
      pendingAlert = Promise.resolve().then(() => onSample(snapshot, values)).catch(() => {
        // Alert storage or delivery cannot interrupt monitoring samples.
      }).finally(() => { pendingAlert = undefined; });
    }
    if (metricScope === 'connected-fe') {
      connectedFeHistory ??= createMonitoringHistory(historyDirectory ? join(historyDirectory, 'connected-fe') : '');
      await connectedFeHistory.load(at);
      if (current.qps !== null || current.latencyMs !== null) {
        // QPS is the FE gauge. Weight latency by snapshots because the exporter count is lifetime.
        await connectedFeHistory.record({ at, qps: current.qps, seconds: intervalMs / 1000,
          latencyMs: current.latencyMs, latencyCount: current.latencyMs === null ? 0 : 1 });
      }
      return;
    }
    if (elapsed > 0 && elapsed <= maxIntervalMs && (qpsComplete || (latencyComplete && latencyCount > 0))) {
      await history.record({
        at,
        qps: qpsComplete ? current.qps : null,
        seconds: elapsed / 1000,
        latencyMs: latencyComplete ? current.latencyMs : null,
        latencyCount: latencyComplete ? latencyCount : 0,
      });
    }
  }

  function queueSample(task = sample) {
    if (!pending && !controller.signal.aborted) {
      pending = task().catch(() => {
        previous = new Map();
        previousAt = null;
        snapshot = { ...snapshot, sampledAt: new Date(now()).toISOString(), current: emptyMetrics,
          coverage: { fe: 0, feTotal: 0, be: 0, beTotal: 0 }, health: null, beMetrics: null, sourceStatus: 'unavailable',
          message: 'Doris 监控采样失败，请稍后刷新。' };
      }).finally(() => { pending = undefined; });
    }
    return pending;
  }

  function start() {
    if (timer || controller.signal.aborted) return;
    timer = setInterval(queueSample, intervalMs);
    timer.unref();
    return queueSample(async () => {
      await history.load(now());
      if (!controller.signal.aborted) await sample();
    });
  }

  async function close() {
    clearInterval(timer);
    controller.abort();
    await pending;
    await pendingAlert;
  }

  function read(range) {
    const scopedHistory = snapshot.metricScope === 'connected-fe' ? connectedFeHistory ?? history : history;
    const message = scopedHistory.persistentError
      ? [snapshot.message, '监控历史存储出现错误，请检查数据目录权限和磁盘空间。'].filter(Boolean).join(' ')
      : snapshot.message;
    return { ...snapshot, message, history: scopedHistory.points(range, now()) };
  }

  return { start, close, read };
}
