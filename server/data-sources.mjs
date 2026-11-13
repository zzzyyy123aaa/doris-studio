import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { domainToASCII } from 'node:url';
import { ApiError } from './errors.mjs';
import { quoteIdentifier } from './sql-policy.mjs';

const defaultId = 'default';
const defaultName = '公司内网 Doris';
const maxNameLength = 48;
const maxStudioSources = 16;
const schemaVersion = 1;
const registryFilename = 'sources.json';
const unreadable = '无法读取 Doris 连接配置，请检查连接保存目录和配置文件。';
const unwritable = '无法保存 Doris 连接配置，请检查连接保存目录是否可写。';
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const sourceId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function textField(value, maxLength, message) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || [...text].length > maxLength || /[\p{Cc}\p{Cs}]/u.test(text)) {
    throw new ApiError(400, message);
  }
  return text;
}

function sourceName(value) {
  return textField(value, maxNameLength, '请输入 1 至 48 个字符的连接名称。');
}

function sourceHost(value) {
  const message = '请输入 Doris FE 的 IP 地址或主机名。';
  const host = textField(value, 254, message);
  const bracketed = host.startsWith('[') && host.endsWith(']');
  const ip = bracketed ? host.slice(1, -1) : host;
  if (bracketed ? isIP(ip) === 6 : isIP(ip) !== 0) return ip;
  if (/[\\/:?#@%\[\]\s]/u.test(host)) throw new ApiError(400, message);
  const ascii = domainToASCII(host);
  const labels = ascii.endsWith('.') ? ascii.slice(0, -1) : ascii;
  if (labels.length > 253 || isIP(labels) || !labels.split('.').every((label) => dnsLabel.test(label))) {
    throw new ApiError(400, message);
  }
  return ascii;
}

function sourcePort(value) {
  const text = typeof value === 'string' ? value.trim() : value;
  if (text === '' || text === undefined) return 9030;
  const port = typeof text === 'string' && /^\d+$/.test(text) ? Number(text) : text;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ApiError(400, '查询端口必须是 1 至 65535 之间的整数。');
  }
  return port;
}

export function parseSourceInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ApiError(400, '请提供有效的 Doris 连接配置。');
  }
  const name = sourceName(input.name);
  const host = sourceHost(input.host);
  const port = sourcePort(input.port);
  const user = textField(input.username, 128, '请输入 1 至 128 个字符的 Doris 用户名。');
  const { password, tls = false } = input;
  if (typeof password !== 'string' || !password.isWellFormed() || Buffer.byteLength(password) > 4096) {
    throw new ApiError(400, '请提供有效的 Doris 密码，长度不能超过 4096 字节。');
  }
  if (typeof tls !== 'boolean') throw new ApiError(400, '请选择是否启用 Doris TLS。');
  if (input.database !== undefined && typeof input.database !== 'string') {
    throw new ApiError(400, '请提供有效的 Doris 默认库名。');
  }
  const database = input.database?.trim() || '';
  if (database) quoteIdentifier(database);
  return { name, config: { host, port, user, password, database, tls } };
}

function publicSource({ id, name, config: { host, port, database, tls } }) {
  return { id, name, host, port, database, tls, managedBy: id === defaultId ? 'environment' : 'studio' };
}

function storedState(contents) {
  const { version, environmentName, sources } = JSON.parse(contents);
  if (version !== schemaVersion || !Array.isArray(sources) || sources.length > maxStudioSources) {
    throw new Error('Invalid source registry schema');
  }
  const ids = new Set();
  const names = new Set();
  const validatedSources = sources.map((entry) => {
    if (typeof entry?.id !== 'string' || !sourceId.test(entry.id) || ids.has(entry.id)) {
      throw new Error('Invalid stored source identifier');
    }
    const { config, name } = parseSourceInput({ ...entry.config, name: entry.name, username: entry.config?.user });
    if (names.has(name.toLowerCase())) throw new Error('Duplicate stored source name');
    ids.add(entry.id);
    names.add(name.toLowerCase());
    return Object.freeze({ id: entry.id, name, config: Object.freeze(config) });
  });
  return {
    version,
    environmentName: environmentName === null ? null : sourceName(environmentName),
    sources: validatedSources,
  };
}

export function createSourceRegistry({ directory, initialConfig }) {
  const file = directory ? join(directory, registryFilename) : null;
  const environmentConfig = initialConfig ? Object.freeze({ ...initialConfig }) : null;
  let state = { version: schemaVersion, environmentName: null, sources: [] };
  let loaded = false;
  let loadWork;
  let mutationWork = Promise.resolve();
  let storageError = file ? null : unwritable;

  function environmentSource() {
    if (!environmentConfig) return undefined;
    const preferred = state.environmentName ?? defaultName;
    const names = new Set(state.sources.map(({ name }) => name.toLowerCase()));
    let name = preferred;
    for (let index = 2; names.has(name.toLowerCase()); index++) {
      const suffix = ` (${index})`;
      name = [...preferred].slice(0, maxNameLength - suffix.length).join('') + suffix;
    }
    return { id: defaultId, name, config: environmentConfig };
  }

  function list() {
    const environment = environmentSource();
    return (environment ? [environment, ...state.sources] : state.sources).map(publicSource);
  }

  function get(id) {
    return id === defaultId ? environmentSource() : state.sources.find((source) => source.id === id);
  }

  async function readState() {
    try {
      state = storedState(await readFile(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        storageError = unreadable;
        return;
      }
    }
    loaded = true;
    storageError = null;
  }

  async function load() {
    if (!file || loaded) return;
    loadWork ??= readState().finally(() => { loadWork = undefined; });
    await loadWork;
  }

  async function persist(next) {
    const temporary = join(directory, `.${registryFilename}.${randomUUID()}.tmp`);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600, flag: 'wx', flush: true });
      await rename(temporary, file);
    } catch {
      await unlink(temporary).catch(() => {});
      storageError = unwritable;
      throw new ApiError(503, storageError);
    }
    state = next;
    storageError = null;
  }

  function mutate(update) {
    const work = mutationWork.then(async () => {
      await load();
      if (!loaded) throw new ApiError(503, storageError);
      return update();
    });
    mutationWork = work.catch(() => {});
    return work;
  }

  function requireUnique(name, id) {
    if (list().some((entry) => entry.id !== id && entry.name.toLowerCase() === name.toLowerCase())) {
      throw new ApiError(409, '已有同名连接，请使用其他名称。');
    }
  }

  async function add(input) {
    const { name, config } = parseSourceInput(input);
    return mutate(async () => {
      requireUnique(name);
      if (state.sources.length >= maxStudioSources) {
        throw new ApiError(409, `最多可保存 ${maxStudioSources} 个新增的 Doris 连接。`);
      }
      const entry = Object.freeze({ id: randomUUID(), name, config: Object.freeze(config) });
      await persist({ ...state, sources: [...state.sources, entry] });
      return publicSource(entry);
    });
  }

  async function renameSource(id, input) {
    const name = sourceName(input);
    return mutate(async () => {
      const entry = get(id);
      if (!entry) throw new ApiError(404, '找不到指定的 Doris 连接。');
      if (entry.name === name) return publicSource(entry);
      requireUnique(name, id);
      const renamed = Object.freeze({ ...entry, name });
      const next = id === defaultId
        ? { ...state, environmentName: name }
        : { ...state, sources: state.sources.map((source) => source.id === id ? renamed : source) };
      await persist(next);
      return publicSource(renamed);
    });
  }

  return {
    load, list, get, add, rename: renameSource,
    get defaultId() { return environmentConfig ? defaultId : state.sources[0]?.id ?? null; },
    get storageError() { return storageError; },
  };
}
