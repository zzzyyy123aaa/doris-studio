import { createHash } from 'node:crypto';
import { ApiError } from './errors.mjs';
import { publicAlert } from './alert-store.mjs';
import { sendFeishuWebhook } from './feishu-webhook.mjs';

const labels = {
  feOffline: ['FE 离线节点', ' 个'], beOffline: ['BE 离线节点', ' 个'],
  cpuPercent: ['BE 主机 CPU', '%'], memoryPercent: ['FE 主机内存', '%'],
  diskPercent: ['BE 数据盘最高使用率', '%'], qps: ['查询吞吐量', ' QPS'], latencyMs: ['平均查询耗时（采样估算）', ' ms'],
};
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'medium', hourCycle: 'h23',
});
const formatNumber = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const maxSampleGap = 90_000;
const failureDelay = 60_000;
const testDelay = 15_000;
const feRules = new Set(['memoryPercent', 'qps', 'latencyMs']);
const initialRule = () => ({ streak: 0, activeSince: null, notified: false, lastSentAt: null, pendingRecovery: false });

function title(key, scope) {
  const base = labels[key][0];
  return scope === 'connected-fe' && feRules.has(key) ? `${base}（当前 FE）` : base;
}

function messageText(source, at, kind, scope, lines = []) {
  const action = { alert: '监控告警', recovery: '告警恢复', test: '机器人测试消息' }[kind];
  return [
    `Doris Studio · ${action}`,
    ...(source ? [`数据源：${source.name.replace(/[<>]/g, (character) => character === '<' ? '＜' : '＞')}`] : []),
    `时间：${dateFormat.format(at)}（北京时间）`,
    ...(kind === 'test' ? ['全局飞书机器人已收到测试消息。'] : lines.map(({ key, value, threshold }) => {
      const unit = labels[key][1];
      return `${title(key, scope)}：${formatNumber.format(value)}${unit}（阈值 ${formatNumber.format(threshold)}${unit}）`;
    })),
  ].join('\n');
}

function destinationFor({ webhook, secret }) {
  return webhook ? createHash('sha256').update(JSON.stringify([webhook, secret ?? null])).digest('hex') : null;
}

export function createAlerts(store, { channel, listSourceIds, send = sendFeishuWebhook, now = Date.now }) {
  const queues = new Map();
  const attempts = new Map();
  const lastSamples = new Map();
  const channelQueue = Symbol('channel');
  let nextTestAt = 0;

  function serial(sourceId, action) {
    const work = (queues.get(sourceId) ?? Promise.resolve()).then(action);
    const done = work.catch(() => {}).finally(() => {
      if (queues.get(sourceId) === done) queues.delete(sourceId);
    });
    queues.set(sourceId, done);
    return work;
  }

  async function deliver(source, credentials, kind, scope, lines) {
    const at = now();
    let failure = null;
    try {
      await send({ webhook: credentials.webhook, secret: credentials.secret, text: messageText(source, at, kind, scope, lines) });
    } catch (error) {
      failure = error instanceof ApiError ? error : new ApiError(502, '飞书消息发送失败。');
    }
    return { failure, delivery: { at: new Date(at).toISOString(), kind, ok: !failure, message: failure?.message ?? '飞书已接收消息。' } };
  }

  async function legacyChannel() {
    const records = await Promise.all(listSourceIds().map((id) => store.get(id).catch(() => null)));
    const configs = records.filter((record) => record?.config.webhook).map(({ config }) => config);
    const [first] = configs;
    const legacyConflict = Boolean(first && (records.includes(null)
      || configs.some(({ webhook, secret }) => webhook !== first.webhook || secret !== first.secret)));
    return { legacyConfigured: Boolean(first), legacyConflict, credentials: legacyConflict ? null : first ?? null };
  }

  async function channelSettings() {
    const record = await channel.get();
    const legacy = record.configured ? { legacyConfigured: false, legacyConflict: false, credentials: null } : await legacyChannel();
    const credentials = record.configured ? record : legacy.credentials;
    return { record, credentials, legacyConfigured: legacy.legacyConfigured, legacyConflict: legacy.legacyConflict };
  }

  function publicChannel({ record, credentials, legacyConfigured, legacyConflict }) {
    return {
      globalConfigured: record.configured, webhookConfigured: Boolean(credentials?.webhook),
      secretConfigured: Boolean(credentials?.secret), legacyConfigured, legacyConflict, lastDelivery: record.lastDelivery,
    };
  }

  async function effectiveChannel(config) {
    const global = await channel.get();
    return global.configured ? global : config;
  }

  async function evaluate(source, snapshot, values) {
    const { id } = source;
    const record = await store.get(id);
    const { config, runtime, revision } = record;
    if (!config.enabled) return;
    const credentials = await effectiveChannel(config);
    const destination = destinationFor(credentials);
    const legacyDestination = destinationFor(config);
    const at = Date.parse(snapshot.sampledAt);
    if (!Number.isFinite(at)) return;
    const previous = lastSamples.get(id);
    if (previous && previous.revision === revision && at <= previous.at) return;
    const contiguous = previous?.revision === revision && previous.destination === destination && previous.scope === snapshot.metricScope && at - previous.at <= maxSampleGap;
    lastSamples.set(id, { at, revision, scope: snapshot.metricScope, destination });
    const before = JSON.stringify(runtime);
    const alerts = [];
    const recoveries = [];
    for (const [key, threshold] of Object.entries(config.thresholds)) {
      if (threshold === null) continue;
      const value = values[key];
      const state = runtime.rules[key] ?? initialRule();
      const previousDestination = Object.hasOwn(state, 'destination') ? state.destination : legacyDestination;
      if (previousDestination !== destination) {
        Object.assign(state, { notified: false, lastSentAt: null, pendingRecovery: false });
      }
      state.destination = destination;
      if (Number.isFinite(value) && feRules.has(key)) {
        if (state.scope && state.scope !== snapshot.metricScope) Object.assign(state, initialRule());
        state.scope = snapshot.metricScope;
      }
      if (!contiguous && !state.activeSince) state.streak = 0;
      if (!Number.isFinite(value)) {
        state.streak = 0;
      } else if (value >= threshold) {
        if (state.pendingRecovery) state.notified = false;
        state.pendingRecovery = false;
        state.streak = Math.min(config.consecutiveSamples, state.streak + 1);
        if (state.streak >= config.consecutiveSamples && !state.activeSince) state.activeSince = snapshot.sampledAt;
        if (state.activeSince && !state.notified && (state.lastSentAt === null || at - state.lastSentAt >= config.cooldownMinutes * 60_000)) {
          alerts.push({ key, value, threshold });
        }
      } else {
        if (state.activeSince && state.notified && config.notifyRecovery) state.pendingRecovery = true;
        state.streak = 0;
        state.activeSince = null;
        state.notified = false;
        if (state.pendingRecovery) recoveries.push({ key, value, threshold });
      }
      if (state.streak || state.activeSince || state.pendingRecovery || state.lastSentAt !== null) runtime.rules[key] = state;
      else delete runtime.rules[key];
    }
    const successfulAttempts = [];
    const deliveries = destination ? [['alert', alerts], ['recovery', recoveries]] : [];
    for (const [kind, lines] of deliveries) {
      const attemptKey = `${id}:${kind}`;
      const previousAttempt = attempts.get(attemptKey);
      if (!lines.length || (previousAttempt?.destination === destination && now() < previousAttempt.at)) continue;
      // Avoid a queued delivery to a bot that was replaced while evaluating rules.
      if (destinationFor(await effectiveChannel(config)) !== destination) break;
      attempts.set(attemptKey, { at: now() + failureDelay, destination });
      const { failure, delivery } = await deliver(source, credentials, kind, snapshot.metricScope, lines);
      runtime.lastDelivery = delivery;
      if (!failure) {
        successfulAttempts.push(attemptKey);
        for (const { key } of lines) {
          const state = runtime.rules[key];
          if (kind === 'recovery') state.pendingRecovery = false;
          else {
            state.notified = true;
            state.lastSentAt = at;
          }
        }
      }
    }
    if (before !== JSON.stringify(runtime)) await store.saveRuntime(id, revision, runtime);
    for (const key of successfulAttempts) attempts.delete(key);
  }

  return {
    async configured(id) { return (await store.get(id)).config.enabled; },
    async read(id) { return publicAlert(await store.get(id)); },
    update(id, input) {
      return serial(id, async () => {
        const before = await store.get(id);
        if (input.enabled && !before.config.enabled && !(await effectiveChannel(before.config)).webhook) {
          throw new ApiError(400, '启用告警前请先保存全局飞书机器人。');
        }
        const updated = await store.save(id, input);
        if (updated.revision !== before.revision) {
          attempts.delete(`${id}:alert`);
          attempts.delete(`${id}:recovery`);
        }
        return publicAlert(updated);
      });
    },
    async readChannel() { return publicChannel(await channelSettings()); },
    updateChannel(input) {
      return serial(channelQueue, async () => {
        const current = await channelSettings();
        if (current.legacyConflict && !Object.hasOwn(input, 'webhook')) {
          throw new ApiError(400, '无法自动沿用旧机器人，请填写要统一使用的 Webhook。');
        }
        const record = await channel.save(input, current.credentials);
        return publicChannel({ record, credentials: record, legacyConfigured: false, legacyConflict: false });
      });
    },
    testChannel() {
      return serial(channelQueue, async () => {
        const current = await channelSettings();
        if (!current.credentials?.webhook) throw new ApiError(400, '请先保存飞书机器人 Webhook。');
        if (now() < nextTestAt) throw new ApiError(429, '请间隔至少 15 秒再发送测试消息。');
        nextTestAt = now() + testDelay;
        const { failure, delivery } = await deliver(null, current.credentials, 'test');
        const record = await channel.saveDelivery(delivery);
        if (failure) throw failure;
        return publicChannel({ ...current, record });
      });
    },
    sample(source, snapshot, values) {
      return serial(source.id, () => evaluate(source, snapshot, values));
    },
  };
}
