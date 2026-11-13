import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError } from './errors.mjs';
import { parseFeishuWebhook } from './feishu-webhook.mjs';

const sourceIdPattern = /^(?:default|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const schemaVersion = 1;
const thresholdsByDefault = {
  feOffline: 1,
  beOffline: 1,
  cpuPercent: 85,
  memoryPercent: 85,
  diskPercent: 85,
  qps: null,
  latencyMs: null,
};
const thresholdNames = {
  feOffline: 'FE 离线数量',
  beOffline: 'BE 离线数量',
  cpuPercent: 'CPU 使用率',
  memoryPercent: '内存使用率',
  diskPercent: '存储使用率',
  qps: 'QPS',
  latencyMs: '查询延迟',
};
const ruleKeys = Object.keys(thresholdsByDefault);
const deliveryKinds = new Set(['alert', 'recovery', 'test']);
const unreadable = '无法读取告警配置，请检查告警保存目录。';
const unwritable = '无法保存告警配置，请检查告警保存目录是否可写。';

function defaultRecord() {
  return {
    config: {
      enabled: false,
      notifyRecovery: true,
      consecutiveSamples: 2,
      cooldownMinutes: 30,
      thresholds: { ...thresholdsByDefault },
      webhook: null,
      secret: null,
    },
    runtime: { rules: {}, lastDelivery: null },
    revision: 0,
  };
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseThresholds(input) {
  if (!object(input)) throw new ApiError(400, '请提供有效的告警阈值。');
  const thresholds = {};
  for (const key of ruleKeys) {
    const value = input[key];
    if (value !== null) {
      const name = thresholdNames[key];
      if (key.endsWith('Offline')) {
        if (!Number.isSafeInteger(value) || value < 1) {
          throw new ApiError(400, `${name}必须是大于或等于 1 的整数。`);
        }
      } else if (key.endsWith('Percent')) {
        if (!Number.isFinite(value) || value <= 0 || value > 100) {
          throw new ApiError(400, `${name}必须大于 0 且不超过 100%。`);
        }
      } else if (!Number.isFinite(value) || value <= 0) {
        throw new ApiError(400, `${name}必须大于 0。`);
      }
    }
    thresholds[key] = value;
  }
  return thresholds;
}

function parseWebhook(input) {
  if (input === null) return null;
  if (typeof input !== 'string' || !input.trim() || input.length > 2048) {
    throw new ApiError(400, '请输入有效的飞书自定义机器人 Webhook 地址。');
  }
  try {
    return parseFeishuWebhook(input.trim());
  } catch {
    throw new ApiError(400, '请输入有效的飞书自定义机器人 Webhook 地址。');
  }
}

export function parseSecret(input) {
  if (input === null) return null;
  if (typeof input !== 'string' || !input.trim() || Buffer.byteLength(input) > 512
    || /[\p{Cc}\p{Cs}]/u.test(input)) {
    throw new ApiError(400, '请输入有效的飞书签名密钥，长度不能超过 512 字节。');
  }
  return input;
}

function parseConfig(input, previous, allowLegacyCredentials = false) {
  if (!object(input)) throw new ApiError(400, '请提供有效的告警配置。');
  const { enabled, notifyRecovery, consecutiveSamples, cooldownMinutes } = input;
  if (typeof enabled !== 'boolean' || typeof notifyRecovery !== 'boolean') {
    throw new ApiError(400, '请设置告警和恢复通知的启用状态。');
  }
  if (!Number.isInteger(consecutiveSamples) || consecutiveSamples < 1 || consecutiveSamples > 20) {
    throw new ApiError(400, '连续采样次数必须是 1 至 20 之间的整数。');
  }
  if (!Number.isInteger(cooldownMinutes) || cooldownMinutes < 1 || cooldownMinutes > 1440) {
    throw new ApiError(400, '告警冷却时间必须是 1 至 1440 分钟之间的整数。');
  }
  const thresholds = parseThresholds(input.thresholds);
  if (!allowLegacyCredentials && (Object.hasOwn(input, 'webhook') || Object.hasOwn(input, 'secret'))) {
    throw new ApiError(400, '请在全局飞书机器人中配置 Webhook 和签名密钥。');
  }
  const webhook = allowLegacyCredentials ? parseWebhook(input.webhook) : previous.webhook;
  const secret = allowLegacyCredentials ? parseSecret(input.secret) : previous.secret;
  return {
    enabled, notifyRecovery, consecutiveSamples, cooldownMinutes, thresholds,
    webhook, secret: webhook ? secret : null,
  };
}

function validDate(value) {
  return typeof value === 'string' && value.length <= 30 && Number.isFinite(Date.parse(value));
}

function parseRuntime(input) {
  if (!object(input) || !object(input.rules)) throw new Error('Invalid alert runtime');
  const rules = {};
  for (const [key, rule] of Object.entries(input.rules)) {
    if (!Object.hasOwn(thresholdsByDefault, key) || !object(rule)) throw new Error('Invalid alert rule state');
    const { streak, activeSince, notified, lastSentAt, pendingRecovery, scope, destination } = rule;
    if (!Number.isSafeInteger(streak) || streak < 0
      || (activeSince !== null && !validDate(activeSince))
      || typeof notified !== 'boolean'
      || (lastSentAt !== null && (!Number.isSafeInteger(lastSentAt) || lastSentAt < 0))
      || (scope !== undefined && scope !== 'cluster' && scope !== 'connected-fe')
      || (destination !== undefined && destination !== null
        && (typeof destination !== 'string' || !/^[a-f0-9]{64}$/.test(destination)))
      || typeof pendingRecovery !== 'boolean') {
      throw new Error('Invalid alert rule state');
    }
    rules[key] = { streak, activeSince, notified, lastSentAt, pendingRecovery, ...(scope ? { scope } : {}), ...(destination !== undefined ? { destination } : {}) };
  }
  let lastDelivery = null;
  if (input.lastDelivery !== null) {
    if (!object(input.lastDelivery)) throw new Error('Invalid alert delivery state');
    const { at, kind, ok, message } = input.lastDelivery;
    if (!validDate(at) || !deliveryKinds.has(kind) || typeof ok !== 'boolean'
      || typeof message !== 'string' || message.length > 256 || /[\p{Cc}\p{Cs}]/u.test(message)) {
      throw new Error('Invalid alert delivery state');
    }
    lastDelivery = { at, kind, ok, message };
  }
  return { rules, lastDelivery };
}

function parseRecord(contents) {
  const { version, config, runtime, revision } = JSON.parse(contents);
  if (version !== schemaVersion || !Number.isSafeInteger(revision) || revision < 0
    || !object(config) || !Object.hasOwn(config, 'webhook') || !Object.hasOwn(config, 'secret')) {
    throw new Error('Invalid alert storage schema');
  }
  return { config: parseConfig(config, defaultRecord().config, true), runtime: parseRuntime(runtime), revision };
}

function updatedRuntime(previous, config) {
  const { config: oldConfig, runtime: { rules, lastDelivery } } = previous;
  if (oldConfig.enabled !== config.enabled || oldConfig.webhook !== config.webhook
    || oldConfig.secret !== config.secret || oldConfig.consecutiveSamples !== config.consecutiveSamples) {
    return { rules: {}, lastDelivery };
  }
  const nextRules = {};
  for (const [key, rule] of Object.entries(rules)) {
    if (oldConfig.thresholds[key] === config.thresholds[key]) {
      nextRules[key] = config.notifyRecovery ? rule : { ...rule, pendingRecovery: false };
    }
  }
  return { rules: nextRules, lastDelivery };
}

export function publicAlert({ config, runtime }) {
  const { enabled, notifyRecovery, consecutiveSamples, cooldownMinutes, thresholds } = config;
  const active = Object.entries(runtime.rules)
    .filter(([, rule]) => rule.activeSince !== null)
    .map(([key, { activeSince, notified }]) => ({ key, since: activeSince, notified }));
  return {
    config: {
      enabled, notifyRecovery, consecutiveSamples, cooldownMinutes,
      thresholds: { ...thresholds },
    },
    status: { active, lastDelivery: runtime.lastDelivery && { ...runtime.lastDelivery } },
  };
}

export function createAlertStore(directory) {
  const records = new Map();
  const writes = new Map();

  function filename(sourceId) {
    if (typeof sourceId !== 'string' || !sourceIdPattern.test(sourceId)) {
      throw new ApiError(404, '找不到所选数据源。');
    }
    return directory ? join(directory, `${sourceId}.json`) : null;
  }

  async function read(sourceId, file) {
    if (records.has(sourceId)) return records.get(sourceId);
    if (!file) return defaultRecord();
    try {
      const record = parseRecord(await readFile(file, 'utf8'));
      if (!records.has(sourceId)) records.set(sourceId, record);
      return records.get(sourceId);
    } catch (error) {
      if (error.code === 'ENOENT') return records.get(sourceId) ?? defaultRecord();
      throw new ApiError(503, unreadable);
    }
  }

  async function persist(sourceId, file, next) {
    if (!file) throw new ApiError(503, unwritable);
    const temporary = join(directory, `.${sourceId}.${randomUUID()}.tmp`);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, `${JSON.stringify({ version: schemaVersion, ...next })}\n`, {
        mode: 0o600, flag: 'wx', flush: true,
      });
      await rename(temporary, file);
    } catch {
      await unlink(temporary).catch(() => {});
      throw new ApiError(503, unwritable);
    }
    records.set(sourceId, next);
  }

  function mutate(sourceId, operation) {
    const file = filename(sourceId);
    const work = (writes.get(sourceId) ?? Promise.resolve()).then(async () => {
      const current = await read(sourceId, file);
      return operation(current, file);
    });
    const pending = work.catch(() => {}).finally(() => {
      if (writes.get(sourceId) === pending) writes.delete(sourceId);
    });
    writes.set(sourceId, pending);
    return work;
  }

  async function get(sourceId) {
    const file = filename(sourceId);
    await writes.get(sourceId);
    return structuredClone(await read(sourceId, file));
  }

  async function save(sourceId, input) {
    return mutate(sourceId, async (current, file) => {
      const config = parseConfig(input, current.config);
      if (JSON.stringify(config) === JSON.stringify(current.config)) return structuredClone(current);
      const next = { config, runtime: updatedRuntime(current, config), revision: current.revision + 1 };
      await persist(sourceId, file, next);
      return structuredClone(next);
    });
  }

  async function saveRuntime(sourceId, revision, input) {
    return mutate(sourceId, async (current, file) => {
      if (revision !== current.revision) return false;
      const runtime = parseRuntime(input);
      if (JSON.stringify(runtime) === JSON.stringify(current.runtime)) return true;
      await persist(sourceId, file, { ...current, runtime });
      return true;
    });
  }

  return { get, save, saveRuntime };
}
