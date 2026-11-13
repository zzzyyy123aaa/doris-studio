import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSecret } from './alert-store.mjs';
import { ApiError } from './errors.mjs';
import { parseFeishuWebhook } from './feishu-webhook.mjs';

const filename = 'webhook.json';
const schemaVersion = 1;
const unreadable = '无法读取全局飞书配置，请检查告警保存目录。';
const unwritable = '无法保存全局飞书配置，请检查告警保存目录是否可写。';

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseWebhook(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 2048) {
    throw new ApiError(400, '请输入飞书群自定义机器人的 HTTPS Webhook 地址。');
  }
  return parseFeishuWebhook(value);
}

function parseDelivery(value) {
  if (value === null) return null;
  if (!object(value)) throw new Error('Invalid global delivery state');
  const { at, kind, ok, message } = value;
  if (typeof at !== 'string' || at.length > 30 || !Number.isFinite(Date.parse(at))
    || kind !== 'test' || typeof ok !== 'boolean'
    || typeof message !== 'string' || message.length > 256 || /[\p{Cc}\p{Cs}]/u.test(message)) {
    throw new Error('Invalid global delivery state');
  }
  return { at, kind, ok, message };
}

function parseRecord(contents) {
  const { version, configured, webhook, secret, lastDelivery, revision } = JSON.parse(contents);
  if (version !== schemaVersion || typeof configured !== 'boolean' || !Number.isSafeInteger(revision)
    || (configured ? revision < 1 : revision !== 0 || webhook !== null || secret !== null)
    || (webhook === null && secret !== null)) {
    throw new Error('Invalid global webhook storage schema');
  }
  return {
    configured, webhook: parseWebhook(webhook), secret: parseSecret(secret),
    lastDelivery: parseDelivery(lastDelivery), revision,
  };
}

export function createGlobalWebhookStore(directory) {
  const file = directory ? join(directory, filename) : null;
  const empty = { configured: false, webhook: null, secret: null, lastDelivery: null, revision: 0 };
  let record;
  let pending = Promise.resolve();

  async function read() {
    if (record) return record;
    if (!file) return empty;
    try {
      record = parseRecord(await readFile(file, 'utf8'));
      return record;
    } catch (error) {
      if (error.code === 'ENOENT') return empty;
      throw new ApiError(503, unreadable);
    }
  }

  async function persist(next) {
    if (!file) throw new ApiError(503, unwritable);
    const temporary = join(directory, `.${filename}.${randomUUID()}.tmp`);
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
    record = next;
    return structuredClone(next);
  }

  function queue(operation) {
    const work = pending.then(operation);
    pending = work.catch(() => {});
    return work;
  }

  function get() {
    return queue(async () => structuredClone(await read()));
  }

  function save(input, fallbackCredentials) {
    return queue(async () => {
      if (!object(input)) throw new ApiError(400, '请提供有效的全局飞书配置。');
      const current = await read();
      const previous = current.configured ? current : fallbackCredentials;
      const previousWebhook = previous?.webhook ?? null;
      const previousSecret = previousWebhook ? previous?.secret ?? null : null;
      const hasWebhook = Object.hasOwn(input, 'webhook');
      const hasSecret = Object.hasOwn(input, 'secret');
      if (!hasWebhook && !hasSecret) {
        if (current.configured) return structuredClone(current);
        if (!previousWebhook) throw new ApiError(400, '请先输入全局飞书 Webhook 地址。');
      }
      const webhook = parseWebhook(hasWebhook ? input.webhook : previousWebhook);
      const retainedSecret = webhook === previousWebhook ? previousSecret : null;
      const requestedSecret = parseSecret(hasSecret ? input.secret : retainedSecret);
      if (!webhook && requestedSecret && !hasWebhook) {
        throw new ApiError(400, '设置飞书签名密钥前请先配置 Webhook 地址。');
      }
      const secret = webhook ? requestedSecret : null;
      const credentialsChanged = webhook !== previousWebhook || secret !== previousSecret;
      if (current.configured && !credentialsChanged) return structuredClone(current);
      return persist({
        configured: true, webhook, secret, revision: current.revision + 1,
        lastDelivery: credentialsChanged ? null : current.lastDelivery,
      });
    });
  }

  function saveDelivery(input) {
    return queue(async () => {
      const current = await read();
      let lastDelivery;
      try {
        lastDelivery = parseDelivery(input);
      } catch {
        throw new ApiError(400, '请提供有效的飞书测试发送状态。');
      }
      if (JSON.stringify(lastDelivery) === JSON.stringify(current.lastDelivery)) return structuredClone(current);
      return persist({ ...current, lastDelivery });
    });
  }

  return { get, save, saveDelivery };
}
