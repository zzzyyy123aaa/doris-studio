import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { ApiError } from './errors.mjs';

const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const maxEndpoints = 8;

export function parseFeHost(value) {
  const host = typeof value === 'string' ? value.trim() : '';
  const message = '请输入数据库的 IP 地址或主机名。';
  if (!host || host.length > 254) throw new ApiError(400, message);
  const bracketed = host.startsWith('[') && host.endsWith(']');
  const ip = bracketed ? host.slice(1, -1) : host;
  if (bracketed ? isIP(ip) === 6 : isIP(ip) !== 0) return ip;
  if (/[\\/:?#@%\[\]\s\p{Cc}\p{Cs}]/u.test(host)) throw new ApiError(400, message);
  const ascii = domainToASCII(host);
  const labels = ascii.endsWith('.') ? ascii.slice(0, -1) : ascii;
  if (labels.length > 253 || isIP(labels) || !labels.split('.').every((label) => dnsLabel.test(label))) {
    throw new ApiError(400, message);
  }
  return ascii.toLowerCase();
}

export function parseFeEndpoints(input) {
  if (input === undefined || input === '') return [];
  const values = typeof input === 'string' ? input.split(',') : input;
  if (!Array.isArray(values) || values.length > maxEndpoints) {
    throw new ApiError(400, `最多可填写 ${maxEndpoints} 个同一集群的备用 FE 地址。`);
  }
  const endpoints = new Map();
  for (const value of values) {
    let host;
    let port;
    if (typeof value === 'string') {
      const match = /^(\[[^\]]+\]|[^:\s]+):(\d+)$/.exec(value.trim());
      if (!match) throw new ApiError(400, '备用 FE 请使用 host:port 格式，多个地址用逗号分隔，IPv6 地址使用方括号。');
      [, host, port] = match;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      ({ host, port } = value);
    }
    const number = typeof port === 'string' && /^\d+$/.test(port) ? Number(port) : port;
    if (!Number.isInteger(number) || number < 1 || number > 65535) {
      throw new ApiError(400, '备用 FE 的查询端口必须是 1 至 65535 之间的整数。');
    }
    const endpoint = { host: parseFeHost(host), port: number };
    endpoints.set(JSON.stringify([endpoint.host, endpoint.port]), endpoint);
  }
  return [...endpoints.values()];
}
