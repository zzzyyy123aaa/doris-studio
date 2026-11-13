import { appendFile, mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const minute = 60_000;
const day = 24 * 60 * minute;
const retention = 30 * day;
const ranges = new Map([
  ['24h', [day, 5 * minute]],
  ['7d', [7 * day, 30 * minute]],
  ['30d', [retention, 2 * 60 * minute]],
]);
const dailyFile = /^\d{4}-\d{2}-\d{2}\.ndjson$/;

function filenameFor(at) {
  return `${new Date(at).toISOString().slice(0, 10)}.ndjson`;
}

function validSample(sample) {
  return sample != null && Number.isSafeInteger(sample.at) && sample.at >= 0
    && sample.at <= 253_402_300_799_999
    && Number.isFinite(sample.seconds) && sample.seconds >= 0
    && (sample.qps === null || (Number.isFinite(sample.qps) && sample.qps >= 0 && sample.seconds > 0))
    && Number.isSafeInteger(sample.latencyCount) && sample.latencyCount >= 0
    && (sample.latencyMs === null
      || (Number.isFinite(sample.latencyMs) && sample.latencyMs >= 0 && sample.latencyCount > 0));
}

export function createMonitoringHistory(directory) {
  const days = new Map();
  const needsSeparator = new Set();
  let persistentError = false;
  let latestAt = 0;
  let lastPruned;
  let loadPromise;
  let storageWork = Promise.resolve();

  function add(filename, sample) {
    if (!days.has(filename)) days.set(filename, []);
    days.get(filename).push(sample);
  }

  function enqueue(operation) {
    storageWork = storageWork.then(operation).catch(() => { persistentError = true; });
    return storageWork;
  }

  async function pruneFiles(cutoff, files) {
    for (const file of files) {
      if (file.isFile() && dailyFile.test(file.name) && file.name < cutoff) {
        try {
          await unlink(join(directory, file.name));
        } catch (error) {
          if (error.code !== 'ENOENT') persistentError = true;
        }
        needsSeparator.delete(file.name);
      }
    }
    lastPruned = cutoff;
  }

  function load(nowMs = Date.now()) {
    latestAt = Math.max(latestAt, nowMs);
    if (!directory) return Promise.resolve();
    loadPromise ??= enqueue(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const files = await readdir(directory, { withFileTypes: true });
      const cutoff = filenameFor(nowMs - retention);
      await pruneFiles(cutoff, files);
      for (const file of files) {
        if (!file.isFile() || !dailyFile.test(file.name) || file.name < cutoff
          || file.name > filenameFor(nowMs)) continue;
        let contents;
        try {
          contents = await readFile(join(directory, file.name), 'utf8');
        } catch {
          persistentError = true;
          needsSeparator.add(file.name);
          continue;
        }
        if (contents && !contents.endsWith('\n')) needsSeparator.add(file.name);
        for (const line of contents.split('\n')) {
          if (!line.trim()) continue;
          try {
            const sample = JSON.parse(line);
            if (!validSample(sample) || filenameFor(sample.at) !== file.name) {
              persistentError = true;
              continue;
            }
            if (sample.at > nowMs - retention) add(file.name, sample);
          } catch {
            persistentError = true;
          }
        }
      }
    });
    return loadPromise;
  }

  async function record(sample) {
    if (!validSample(sample)) return;
    const { at, qps, seconds, latencyMs, latencyCount } = sample;
    latestAt = Math.max(latestAt, at);
    if (at <= latestAt - retention) return;

    const entry = { at, qps, seconds, latencyMs, latencyCount };
    const filename = filenameFor(at);
    const cutoff = filenameFor(latestAt - retention);
    add(filename, entry);
    for (const name of days.keys()) {
      if (name < cutoff) days.delete(name);
    }
    if (!directory) return;

    await enqueue(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const separator = needsSeparator.has(filename) ? '\n' : '';
      try {
        await appendFile(join(directory, filename), `${separator}${JSON.stringify(entry)}\n`, { mode: 0o600 });
        needsSeparator.delete(filename);
      } catch (error) {
        needsSeparator.add(filename);
        throw error;
      }
      if (lastPruned !== cutoff) {
        await pruneFiles(cutoff, await readdir(directory, { withFileTypes: true }));
      }
    });
  }

  function points(range, nowMs = Date.now()) {
    const [duration, width] = ranges.get(range);
    const start = nowMs - duration;
    const firstFile = filenameFor(start);
    const buckets = Array.from({ length: duration / width }, () => ({
      queryWeight: 0, querySum: 0, latencyWeight: 0, latencySum: 0,
    }));
    for (const [name, samples] of days) {
      if (name < firstFile) continue;
      for (const sample of samples) {
        if (sample.at <= start || sample.at > nowMs) continue;
        const bucket = buckets[Math.ceil((sample.at - start) / width) - 1];
        if (sample.qps !== null) {
          bucket.queryWeight += sample.seconds;
          bucket.querySum += sample.qps * sample.seconds;
        }
        if (sample.latencyMs !== null) {
          bucket.latencyWeight += sample.latencyCount;
          bucket.latencySum += sample.latencyMs * sample.latencyCount;
        }
      }
    }
    return buckets.map((bucket, index) => ({
      at: new Date(start + (index + 1) * width).toISOString(),
      qps: bucket.queryWeight ? bucket.querySum / bucket.queryWeight : null,
      latencyMs: bucket.latencyWeight ? bucket.latencySum / bucket.latencyWeight : null,
    }));
  }

  return { load, record, points, get persistentError() { return persistentError; } };
}
