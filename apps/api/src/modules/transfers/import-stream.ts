import { createReadStream } from 'node:fs';
import { chain } from 'stream-chain';
import { parser } from 'stream-json';
import { pick } from 'stream-json/filters/pick.js';
import { streamArray } from 'stream-json/streamers/stream-array.js';
import { ApiException } from '../../common/api-exception.js';
const arrays = new Set(['projects', 'tasks', 'entries', 'logs', 'ledger', 'taskEntries']);
const rootKeys = new Set([
  ...arrays,
  'schema',
  'schemaVersion',
  'exportedAt',
  'sourceNamespace',
  'timezone',
  'settings',
]);
export async function scanImport(file: string) {
  const source = chain([createReadStream(file), parser()]);
  let depth = 0,
    key = '',
    stringBytes = 0,
    first = true;
  const keys = new Set<string>(),
    metadata: Record<string, unknown> = {};
  try {
    for await (const raw of source) {
      const token = raw as { name: string; value?: unknown };
      if (first) {
        first = false;
        if (token.name !== 'startObject') throw new Error('根必须为对象');
      }
      if (token.name === 'startString' || token.name === 'startKey') stringBytes = 0;
      if (token.name === 'stringChunk') {
        stringBytes += Buffer.byteLength(String(token.value));
        if (stringBytes > 128 * 1024) throw new ApiException('PAYLOAD_TOO_LARGE', '单个字符串过大');
      }
      if (token.name === 'keyValue') {
        const name = String(token.value);
        if (['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('危险键');
        if (depth === 1) {
          if (!rootKeys.has(name) || keys.has(name)) throw new Error('未知或重复根字段');
          keys.add(name);
          key = name;
        }
      }
      if (
        depth === 1 &&
        ['stringValue', 'numberValue', 'trueValue', 'falseValue', 'nullValue'].includes(token.name)
      ) {
        if (arrays.has(key)) throw new Error('实体集合必须为数组');
        metadata[key] = token.name === 'numberValue' ? Number(token.value) : token.value;
      }
      if (token.name === 'startArray' || token.name === 'startObject') {
        if (depth === 1 && arrays.has(key) && token.name !== 'startArray')
          throw new Error('实体集合必须为数组');
        if (++depth > 20) throw new Error('嵌套过深');
      }
      if (token.name === 'endArray' || token.name === 'endObject') depth--;
    }
  } catch (error) {
    source.destroy();
    if (error instanceof ApiException) throw error;
    throw new ApiException('MALFORMED_REQUEST', 'JSON格式错误、结构或危险键不符合要求');
  }
  const version = metadata['schemaVersion'] ?? metadata['schema'];
  if (version !== 1 && version !== 2)
    throw new ApiException('IMPORT_VERSION_UNSUPPORTED', '仅支持schema=1或schemaVersion=2');
  return { version: version as 1 | 2, metadata, keys };
}
export async function* importRows(file: string, field: string) {
  const source = chain([createReadStream(file), parser(), pick({ filter: field }), streamArray()]);
  try {
    for await (const raw of source) yield (raw as { value: unknown }).value;
  } finally {
    source.destroy();
  }
}
