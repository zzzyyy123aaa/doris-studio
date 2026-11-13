import { ApiError } from './errors.mjs';

const maxSqlBytes = 64 * 1024;
const identifierPattern = /^[^\p{Cc}]{1,128}$/u;
const deniedWords = new Set(['INTO', 'OUTFILE', 'DUMPFILE']);

export function quoteIdentifier(name) {
  if (typeof name !== 'string' || !identifierPattern.test(name) || !name.trim()) {
    throw new ApiError(400, '请提供有效的 Doris 库名或表名。');
  }
  return '`' + name.replaceAll('`', '``') + '`';
}

function quotedEnd(sql, start) {
  const quote = sql[start];
  let index = start + 1;
  while (index < sql.length) {
    const character = sql[index++];
    if (quote !== '`' && character === '\\') {
      // A doubled quote is unambiguous even with NO_BACKSLASH_ESCAPES enabled.
      if (sql[index] === quote) {
        throw new ApiError(400, '字符串中的引号请写成两个连续的引号。');
      }
      index++;
    } else if (character === quote) {
      if (sql[index] !== quote) return index;
      index++;
    }
  }
  throw new ApiError(400, 'SQL 中的引号未闭合。');
}

function commentEnd(sql, start) {
  if (/^\/\*(?:[!+]|M!)/i.test(sql.slice(start, start + 4))) {
    throw new ApiError(400, '只读工作台不接受执行型注释或查询提示。');
  }
  let depth = 1;
  for (let index = start + 2; index < sql.length - 1; index++) {
    if (sql.startsWith('/*', index)) {
      depth++;
      index++;
    } else if (sql.startsWith('*/', index)) {
      depth--;
      if (depth === 0) return index + 2;
      index++;
    }
  }
  throw new ApiError(400, 'SQL 中的块注释未闭合。');
}

function readStatement(sql) {
  const tokens = [];
  const parts = [];
  const word = /[a-z0-9_$\u0080-\uFFFF]+/iy;
  const lineComment = /--(?:\\\n|[^\r\n])*/y;
  let depth = 0;
  let ended = false;
  let previous = '';
  for (let index = 0; index < sql.length;) {
    const character = sql[index];
    if (/[ \t\r\n]/.test(character)) {
      parts.push(character);
      index++;
      continue;
    }
    if (sql.startsWith('--', index)) {
      lineComment.lastIndex = index;
      index += lineComment.exec(sql)[0].length;
      parts.push(' ');
      continue;
    }
    if (sql.startsWith('/*', index)) {
      index = commentEnd(sql, index);
      parts.push(' ');
      continue;
    }
    if (ended || (character === ';' && depth !== 0)) {
      throw new ApiError(400, '每次只可执行一条 SQL。');
    }
    if (character === ';') {
      ended = true;
      index++;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      const end = quotedEnd(sql, index);
      parts.push(sql.slice(index, end));
      if (!depth) tokens.push(character === '`' ? '<identifier>' : '<string>');
      index = end;
      previous = '';
      continue;
    }
    word.lastIndex = index;
    const match = word.exec(sql);
    if (match) {
      const token = match[0].toUpperCase();
      if (deniedWords.has(token) || (previous === 'FOR' && ['UPDATE', 'SHARE'].includes(token))) {
        throw new ApiError(400, '只读工作台不支持导出到文件或锁定数据。');
      }
      if (!depth) tokens.push(token);
      parts.push(match[0]);
      index = word.lastIndex;
      previous = token;
      continue;
    }
    if (sql.startsWith(':=', index)) throw new ApiError(400, '只读工作台不支持变量赋值。');
    if (character === '(') {
      if (!depth) tokens.push('<group>');
      depth++;
    } else if (character === ')') {
      if (!depth) throw new ApiError(400, 'SQL 中的括号不匹配。');
      depth--;
    } else if (!depth) {
      tokens.push(character);
    }
    parts.push(character);
    previous = '';
    index++;
  }
  if (depth) throw new ApiError(400, 'SQL 中的括号未闭合。');
  return { tokens, statement: parts.join('').trim() };
}

function isIdentifier(token) {
  return token === '<identifier>' || (token !== undefined && /^[a-z0-9_$\u0080-\uFFFF]+$/i.test(token));
}

function isQualifiedTable(tokens) {
  return (tokens.length === 1 && isIdentifier(tokens[0])) ||
    (tokens.length === 3 && isIdentifier(tokens[0]) && tokens[1] === '.' && isIdentifier(tokens[2]));
}

function isCteSelect(tokens) {
  let index = tokens[1] === 'RECURSIVE' ? 2 : 1;
  while (isIdentifier(tokens[index++])) {
    if (tokens[index] === '<group>') index++;
    if (tokens[index++] !== 'AS' || tokens[index++] !== '<group>') return false;
    if (tokens[index] !== ',') return tokens[index] === 'SELECT';
    index++;
  }
  return false;
}

function isMetadataStatement(tokens) {
  const [first, second, third] = tokens;
  if (first === 'DESC' || first === 'DESCRIBE') return isQualifiedTable(tokens.slice(1));
  if (first !== 'SHOW') return false;
  if (second === 'DATABASES') return tokens.length === 2;
  if (second === 'CREATE' && third === 'TABLE') return isQualifiedTable(tokens.slice(3));

  const tableIndex = second === 'FULL' ? 2 : 1;
  if (tokens[tableIndex] !== 'TABLES') return false;
  const tail = tokens.slice(tableIndex + 1);
  return tail.length === 0 || (tail.length === 2 && ['FROM', 'IN'].includes(tail[0]) && isIdentifier(tail[1]));
}

export function readOnlyStatement(sql) {
  if (typeof sql !== 'string' || !sql.trim() || sql.includes('\0')) {
    throw new ApiError(400, '请输入有效的 SQL。');
  }
  if (Buffer.byteLength(sql) > maxSqlBytes) throw new ApiError(413, '单条 SQL 最多 64 KiB。');

  const { tokens, statement } = readStatement(sql);
  const first = tokens[0];
  if (first === 'SELECT' || (first === 'WITH' && isCteSelect(tokens)) || isMetadataStatement(tokens)) {
    return statement;
  }
  throw new ApiError(400, '只支持 SELECT、WITH … SELECT、SHOW DATABASES / TABLES / CREATE TABLE 和 DESC。');
}
