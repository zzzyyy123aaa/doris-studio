import { isIP } from 'node:net';

const cpuModes = ['user', 'nice', 'system', 'idle', 'iowait', 'irq', 'soft_irq', 'steal'];
const selectedMetrics = new Set([
  'doris_fe_query_total', 'doris_fe_query_latency_ms_sum', 'doris_fe_query_latency_ms_count',
  'doris_fe_meminfo', 'system_meminfo', 'doris_be_cpu',
  'doris_be_network_receive_bytes', 'doris_be_network_send_bytes',
  'doris_be_disks_local_used_capacity', 'doris_be_disks_total_capacity', 'doris_be_disks_state',
  'doris_be_disks_avail_capacity',
]);
const legacyFeMetrics = new Set(['doris_fe_qps', 'node_info', 'doris_fe_tablet_num']);
const sampleLine = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:[ \t]*\{([^}]*)\})?\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(?:\s|$)/;
const maxMetricsBytes = 4 * 1024 * 1024;

export function metricsUrl({ host, httpPort }) {
  const address = host.replace(/^\[([^\]]+)\]$/, '$1');
  const ipVersion = isIP(address);
  const hostname = /^(?=.{1,253}\.?$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/i;
  if ((!ipVersion && !hostname.test(address)) || !Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535) return null;
  return URL.parse(`http://${ipVersion === 6 ? `[${address}]` : address}:${httpPort}/metrics`);
}

function readSamples(text, extraMetrics) {
  const samples = new Map();
  for (const line of text.split('\n')) {
    const match = sampleLine.exec(line);
    if (!match || (!selectedMetrics.has(match[1]) && !extraMetrics?.has(match[1]))) continue;
    const [, name, rawLabels = '', rawValue] = match;
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value < 0) continue;
    const labels = Object.fromEntries(Array.from(rawLabels.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g), ([, key, label]) => [key, label]));
    if (!samples.has(name)) samples.set(name, []);
    samples.get(name).push({ labels, value, hasLabels: Boolean(rawLabels.trim()) });
  }
  return samples;
}

function unlabelled(samples, name) {
  return samples.get(name)?.find(({ hasLabels }) => !hasLabels)?.value ?? null;
}

function labelledValues(samples, metric, label) {
  return new Map((samples.get(metric) ?? [])
    .filter(({ labels }) => labels[label])
    .map(({ labels, value }) => [labels[label], value]));
}

function readCpu(samples) {
  const devices = new Map();
  for (const { labels: { device, mode }, value } of samples.get('doris_be_cpu') ?? []) {
    if (!/^cpu\d*$/.test(device) || !cpuModes.includes(mode)) continue;
    if (!devices.has(device)) devices.set(device, new Map());
    devices.get(device).set(mode, value);
  }
  if (devices.has('cpu')) return new Map([['cpu', devices.get('cpu')]]);
  return devices;
}

function readBeStorage(samples) {
  const usedByPath = labelledValues(samples, 'doris_be_disks_local_used_capacity', 'path');
  const totalByPath = labelledValues(samples, 'doris_be_disks_total_capacity', 'path');
  const stateByPath = labelledValues(samples, 'doris_be_disks_state', 'path');
  const paths = new Set([...usedByPath.keys(), ...totalByPath.keys()]);
  const sizes = new Set();
  let used = 0;
  let total = 0;
  let pathsRead = 0;
  let complete = true;
  let capacityKnown = true;
  let sharedCapacityPossible = false;
  for (const path of paths) {
    if (stateByPath.get(path) === 0) {
      complete = false;
      continue;
    }
    const pathUsed = usedByPath.get(path);
    const pathTotal = totalByPath.get(path);
    if (!Number.isSafeInteger(pathUsed) || (pathTotal > 0 && pathUsed > pathTotal)) {
      complete = false;
      continue;
    }
    pathsRead++;
    used += pathUsed;
    if (!Number.isSafeInteger(pathTotal) || pathTotal <= 0) {
      capacityKnown = false;
      continue;
    }
    // Two equal capacities can describe two directories on the same filesystem.
    if (sizes.has(pathTotal)) sharedCapacityPossible = true;
    sizes.add(pathTotal);
    total += pathTotal;
  }
  if (!pathsRead) return null;
  return { used, total: complete && capacityKnown && !sharedCapacityPossible ? total : null, complete, sharedCapacityPossible };
}

function readBePeakDisk(samples) {
  const totalByPath = labelledValues(samples, 'doris_be_disks_total_capacity', 'path');
  const availableByPath = labelledValues(samples, 'doris_be_disks_avail_capacity', 'path');
  const stateByPath = labelledValues(samples, 'doris_be_disks_state', 'path');
  if (!totalByPath.size) return null;
  let peak = 0;
  for (const [path, total] of totalByPath) {
    const available = availableByPath.get(path);
    if (stateByPath.get(path) === 0 || !(total > 0) || !Number.isFinite(available) || available > total) return null;
    peak = Math.max(peak, (total - available) * 100 / total);
  }
  return peak;
}

function frontendSamples(samples) {
  const queries = unlabelled(samples, 'doris_fe_query_total');
  const latencySum = unlabelled(samples, 'doris_fe_query_latency_ms_sum');
  const latencyCount = unlabelled(samples, 'doris_fe_query_latency_ms_count');
  const memory = labelledValues(samples, samples.has('doris_fe_meminfo') ? 'doris_fe_meminfo' : 'system_meminfo', 'name');
  const memoryTotal = memory.get('memory_total');
  const memoryAvailable = memory.get('memory_available');
  const memoryUsage = memoryTotal > 0 && memoryAvailable >= 0 && memoryAvailable <= memoryTotal
    ? { used: memoryTotal - memoryAvailable, total: memoryTotal }
    : null;
  return { queries, latencyCount, latencyMean: latencyCount > 0 && latencySum !== null ? latencySum / latencyCount : null, memoryUsage };
}

function backendAddresses(samples, total) {
  if (total === null || total > 128) return [];
  const tablets = labelledValues(samples, 'doris_fe_tablet_num', 'backend');
  const isLeader = samples.get('node_info')?.some(({ labels, value }) => labels.type === 'is_master' && value === 1);
  const nodes = new Map();
  for (const [address, count] of tablets) {
    const match = /^(?:\[([^\]]+)\]|([^:\s]+)):(\d{1,5})$/.exec(address);
    if (!match) continue;
    const host = match[1] || match[2];
    const port = Number(match[3]);
    const endpoint = metricsUrl({ host, httpPort: port });
    if (!endpoint) continue;
    nodes.set(endpoint.href, { host, port, alive: null, tablets: isLeader && Number.isSafeInteger(count) ? String(count) : null });
  }
  // Metrics may retain labels from older membership. Only show a complete, bounded inventory.
  return nodes.size === total ? [...nodes.values()] : [];
}

export function parseLegacyFeMetrics(text) {
  const samples = readSamples(text, legacyFeMetrics);
  const nodeInfo = samples.get('node_info');
  const nodeCount = (type, state) => {
    const value = nodeInfo?.find(({ labels }) => labels.type === type && labels.state === state)?.value;
    return Number.isSafeInteger(value) ? value : null;
  };
  const frontendTotal = nodeCount('fe_node_num', 'total');
  const backendTotal = nodeCount('be_node_num', 'total');
  const backendOnline = nodeCount('be_node_num', 'alive');
  const qps = unlabelled(samples, 'doris_fe_qps');
  const { queries, latencyCount, latencyMean, memoryUsage } = frontendSamples(samples);
  if ([frontendTotal, backendTotal, qps, queries, latencyCount, memoryUsage].every(value => value === null)) return null;
  return { qps, latencyMean, memoryUsage, frontendTotal, backendTotal, backendOnline,
    backends: backendAddresses(samples, backendTotal) };
}

export function parseDorisMetrics(text, type) {
  const samples = readSamples(text);
  if (type === 'fe') {
    const metrics = frontendSamples(samples);
    return metrics.queries === null && metrics.latencyCount === null && !metrics.memoryUsage ? null : metrics;
  }

  const cpu = readCpu(samples);
  const received = labelledValues(samples, 'doris_be_network_receive_bytes', 'device');
  const sent = labelledValues(samples, 'doris_be_network_send_bytes', 'device');
  const storage = readBeStorage(samples);
  const diskPeak = readBePeakDisk(samples);
  received.delete('lo');
  sent.delete('lo');
  if (!cpu.size && !received.size && !sent.size && !storage && diskPeak === null) return null;
  return { cpu, received, sent, storage, diskPeak };
}

export async function readDorisHttpText(url, signal, request, maxBytes = maxMetricsBytes) {
  const timeout = AbortSignal.timeout(3_000);
  const response = await request(url, {
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    return null;
  }
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) return null;
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

export async function scrapeDorisMetrics(url, type, signal, fetchMetrics) {
  const text = await readDorisHttpText(url, signal, fetchMetrics);
  return text === null ? null : parseDorisMetrics(text, type);
}

export function counterDelta(current, previous) {
  return Number.isFinite(current) && Number.isFinite(previous) && current >= previous ? current - previous : null;
}

export function cpuDelta(current, previous) {
  if (!current.size || current.size !== previous.size) return null;
  let total = 0;
  let busy = 0;
  for (const [device, modes] of current) {
    const prior = previous.get(device);
    if (!prior || !modes.has('idle') || !modes.has('user') || !modes.has('system') || modes.size !== prior.size) return null;
    for (const [mode, value] of modes) {
      const delta = counterDelta(value, prior.get(mode));
      if (delta === null) return null;
      total += delta;
      if (mode !== 'idle' && mode !== 'iowait') busy += delta;
    }
  }
  return total > 0 ? { busy, total } : null;
}

function networkDelta(current, previous) {
  if (!current.size || current.size !== previous.size) return null;
  let bytes = 0;
  for (const [device, value] of current) {
    const delta = counterDelta(value, previous.get(device));
    if (delta === null) return null;
    bytes += delta;
  }
  return bytes;
}

export function networkRate(current, previous, seconds) {
  const received = networkDelta(current.received, previous.received);
  const sent = networkDelta(current.sent, previous.sent);
  return received === null || sent === null ? null : (received + sent) / seconds;
}
