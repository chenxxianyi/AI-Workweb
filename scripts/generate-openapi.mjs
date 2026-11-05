import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  require = createRequire(path.join(root, 'apps/api/package.json'));
require('reflect-metadata');
const { z } = require('zod'),
  { AppModule } = await import(pathToFileURL(path.join(root, 'apps/api/dist/app.module.js')).href);
const visited = new Set(),
  controllers = new Set();
function collect(value) {
  const module = value.module ?? value;
  if (visited.has(module)) return;
  visited.add(module);
  for (const c of Reflect.getMetadata('controllers', module) ?? []) controllers.add(c);
  for (const imported of Reflect.getMetadata('imports', module) ?? [])
    if (imported) collect(imported);
}
collect(AppModule);
const methods = ['get', 'post', 'put', 'delete', 'patch', 'all', 'options', 'head'],
  paths = {},
  index = [];
function schema(pipe) {
  if (!pipe?.schema) return undefined;
  try {
    return z.toJSONSchema(pipe.schema, { io: 'input', unrepresentable: 'any' });
  } catch {
    return undefined;
  }
}
for (const controller of controllers) {
  const prefix = Reflect.getMetadata('path', controller) ?? '',
    proto = controller.prototype;
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    const handler = Object.getOwnPropertyDescriptor(proto, name)?.value;
    if (typeof handler !== 'function') continue;
    const number = Reflect.getMetadata('method', handler),
      method = methods[number];
    if (number === undefined || !method) continue;
    const suffix = Reflect.getMetadata('path', handler) ?? '',
      routes = Array.isArray(suffix) ? suffix : [suffix];
    for (const route of routes) {
      const url = ('/' + [prefix, route].filter((v) => v && v !== '/').join('/')).replace(
          /:([A-Za-z0-9_]+)/g,
          '{$1}',
        ),
        isPublic =
          Reflect.getMetadata('aiwb:public', handler) ??
          Reflect.getMetadata('aiwb:public', controller) ??
          false,
        csrfExempt =
          Reflect.getMetadata('aiwb:csrf-exempt', handler) ??
          Reflect.getMetadata('aiwb:csrf-exempt', controller) ??
          false,
        role =
          Reflect.getMetadata('aiwb:workspace-role', handler) ??
          Reflect.getMetadata('aiwb:workspace-role', controller) ??
          null,
        status = Reflect.getMetadata('__httpCode__', handler) ?? (method === 'post' ? 201 : 200),
        parameters = [],
        args = Reflect.getMetadata('__routeArguments__', controller, name) ?? {};
      let body;
      for (const [key, arg] of Object.entries(args)) {
        const kind = Number(key.split(':')[0]),
          value = (arg.pipes ?? []).map(schema).find(Boolean);
        if (kind === 3) body = value ?? {};
        if (kind === 6 && arg.data) {
          parameters.push({
            name: arg.data,
            in: 'header',
            required: ['if-match', 'idempotency-key'].includes(String(arg.data).toLowerCase()),
            schema: value ?? { type: 'string' },
          });
        }
        if (kind === 4) {
          if (arg.data)
            parameters.push({
              name: arg.data,
              in: 'query',
              required: false,
              schema: value ?? { type: 'string' },
            });
          else if (value?.properties)
            for (const [name, property] of Object.entries(value.properties))
              parameters.push({
                name,
                in: 'query',
                required: value.required?.includes(name) ?? false,
                schema: property,
              });
        }
      }
      for (const match of url.matchAll(/\{([^}]+)\}/g))
        parameters.push({
          name: match[1],
          in: 'path',
          required: true,
          schema: { type: 'string', ...(match[1].endsWith('Id') ? { format: 'uuid' } : {}) },
        });
      if (!['get', 'head', 'options'].includes(method) && !csrfExempt)
        parameters.push({
          name: 'X-CSRF-Token',
          in: 'header',
          required: true,
          schema: { type: 'string' },
          description: '从当前同源GET /auth/csrf取得；与当前Cookie和会话绑定',
        });
      const operation = {
        operationId: controller.name + '_' + name,
        tags: [controller.name.replace(/Controller$/, '')],
        summary: name,
        security: isPublic ? [] : [{ sessionCookie: [] }],
        ...(role ? { 'x-workspace-min-role': role } : {}),
        parameters,
        responses: {
          [status]: {
            description: '实际Controller成功状态；data字段见配套接口说明',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } },
          },
          default: {
            description: '统一错误信封；400/401/403/404/409/412/422/428/429/503按具体操作出现',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      };
      if (body)
        operation.requestBody = {
          required: true,
          content: { 'application/json': { schema: body } },
        };
      if (url.endsWith('/imports/preview'))
        operation.requestBody = {
          required: true,
          content: {
            'application/octet-stream': {
              schema: {
                type: 'string',
                format: 'binary',
                description: 'JSON文件字节，≤512MiB；实体≤25万；不使用multipart',
              },
            },
          },
        };
      if (url.endsWith('/download'))
        operation.responses[status] = {
          description: '经过权限校验的附件下载，no-store；不是静态公开目录',
          content: {
            'application/json': { schema: { type: 'string', format: 'binary' } },
            'application/zip': { schema: { type: 'string', format: 'binary' } },
          },
        };
      paths[url] ??= {};
      if (paths[url][method]) throw Error('重复路由 ' + method + ' ' + url);
      paths[url][method] = operation;
      index.push({
        method: method.toUpperCase(),
        path: '/api/v1' + url,
        public: isPublic,
        minRole: role,
        handler: controller.name + '.' + name,
      });
    }
  }
}
const document = {
  openapi: '3.1.0',
  'x-contract-status': 'implemented-route-and-request-schema',
  'x-generator':
    'scripts/generate-openapi.mjs; Nest metadata, Zod input schemas; no app/database started',
  info: {
    title: 'AI编程工作台实际API索引',
    version: '0.1.0-local',
    description:
      '从当前编译Controller和Zod请求管道生成。覆盖实际路由、请求字段、条件/幂等/CSRF头及角色。响应data为通用信封，具体业务结构见docs/api各说明与services类型；本索引不能直接生成完整强类型SDK。原F03草案保留为openapi-planned-v2.yaml。Cookie名称随环境配置，公开GET /auth/csrf-cookie-name可查询；本机HTTP、HttpOnly/Lax，公网需HTTPS。',
  },
  servers: [
    { url: 'http://127.0.0.1:3000/api/v1', description: '本机正式' },
    { url: 'http://127.0.0.1:3003/api/v1', description: '本机预发布' },
    { url: 'http://127.0.0.1:5173/api/v1', description: '开发同源代理' },
  ],
  paths,
  components: {
    securitySchemes: {
      sessionCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: 'aiwb_production',
        description: '生产默认；stage=aiwb_stage，开发=sfs_session；只通过同源Cookie会话使用',
      },
    },
    schemas: {
      Envelope: {
        type: 'object',
        required: ['data', 'requestId'],
        properties: { data: {}, meta: {}, requestId: { type: 'string' } },
      },
      ApiError: {
        type: 'object',
        required: ['error', 'requestId'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              fieldErrors: { type: 'object' },
              details: {},
            },
          },
          requestId: { type: 'string' },
        },
      },
    },
  },
};
for (const [url, operations] of Object.entries(paths))
  for (const operation of Object.values(operations)) {
    const expected = [...url.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    for (const value of expected)
      if (!operation.parameters.some((p) => p.in === 'path' && p.name === value && p.required))
        throw Error('缺失path参数');
  }
await fs.writeFile(
  path.join(root, 'docs/api/openapi.yaml'),
  JSON.stringify(document, null, 2) + '\n',
);
await fs.writeFile(
  path.join(root, 'docs/api/route-index.json'),
  JSON.stringify(
    index.sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method)),
    null,
    2,
  ) + '\n',
);
console.log(
  JSON.stringify({
    controllers: controllers.size,
    paths: Object.keys(paths).length,
    operations: index.length,
    requestBodies: Object.values(paths)
      .flatMap(Object.values)
      .filter((o) => o.requestBody).length,
    result: 'generated-and-path-checked',
  }),
);
