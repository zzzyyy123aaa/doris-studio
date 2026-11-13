import { createHmac } from 'node:crypto';
import { ApiError } from './errors.mjs';

const origin = 'https://open.feishu.cn';
const webhookOrigin = /^https:\/\/open\.feishu\.cn(\/.*)$/i;
const webhookPath = /^\/open-apis\/bot\/v2\/hook\/(?!(?:\.|\.\.)$)[a-zA-Z0-9._~-]{1,256}$/;
const maxRequestBytes = 20 * 1024;
const maxResponseBytes = 16 * 1024;
const timeoutMs = 5_000;

export function parseFeishuWebhook(value) {
  const match = typeof value === 'string' && webhookOrigin.exec(value.trim());
  if (!match || !webhookPath.test(match[1])) {
    throw new ApiError(400, '请输入飞书群自定义机器人的 HTTPS Webhook 地址。');
  }
  return origin + match[1];
}

async function readResponse(body) {
  if (!body) throw new Error();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  for await (const chunk of body) {
    bytes += chunk.byteLength;
    if (bytes > maxResponseBytes) throw new Error();
    text += decoder.decode(chunk, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}

function responseError(code) {
  switch (code) {
    case 19021:
      return '飞书机器人签名校验失败，请检查签名密钥和服务器时间。';
    case 19022:
      return '飞书机器人拒绝了服务器的出口 IP，请检查机器人 IP 白名单。';
    case 19024:
      return '飞书机器人拒绝了消息，请检查机器人设置的关键词。';
    case 11232:
      return '飞书机器人发送过于频繁，请稍后重试。';
    default:
      return '飞书机器人未接受消息，请检查 Webhook 地址和机器人设置。';
  }
}

export async function sendFeishuWebhook({ webhook, secret, text }, { request = fetch, now = Date.now } = {}) {
  const url = parseFeishuWebhook(webhook);
  if (secret != null && (typeof secret !== 'string' || !secret.isWellFormed() || Buffer.byteLength(secret) > 4096)) {
    throw new ApiError(400, '飞书机器人签名密钥格式不正确。');
  }
  if (typeof text !== 'string' || text.length > maxRequestBytes || !text.trim() || !text.isWellFormed()) {
    throw new ApiError(400, '飞书消息为空、格式不正确或超过 20 KB。');
  }

  const payload = { msg_type: 'text', content: { text } };
  if (secret) {
    const timestamp = Math.floor(now() / 1000);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new ApiError(503, '服务器时间异常，无法生成飞书机器人签名。');
    }
    payload.timestamp = String(timestamp);
    // Feishu uses the timestamp and secret as the HMAC key and signs an empty message.
    payload.sign = createHmac('sha256', `${timestamp}\n${secret}`).digest('base64');
  }
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > maxRequestBytes) {
    throw new ApiError(400, '飞书消息请求超过 20 KB。');
  }

  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  let result;
  try {
    response = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body,
      redirect: 'error',
      signal,
    });
    if (response.ok) result = await readResponse(response.body);
    else await response.body?.cancel();
  } catch {
    if (signal.aborted) throw new ApiError(504, '等待飞书响应超时。');
    throw new ApiError(502, '无法发送飞书通知，请检查服务器到飞书的网络和 Webhook 地址。');
  }

  if (!response.ok) throw new ApiError(502, responseError(response.status === 429 ? 11232 : undefined));
  const code = result?.code === undefined ? result?.StatusCode : result.code;
  if (code !== 0) throw new ApiError(502, responseError(code));
}
