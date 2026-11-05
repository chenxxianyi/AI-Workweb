import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { data } from './native.mjs';
// 仅本机合成stage验收代理：重写为已授权stage同源，丢弃一次已提交的项目响应。
let dropped = false;
const server = createServer(async (req, res) => {
  try {
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) {
      res.writeHead(400).end();
      return;
    }
    const chunks = [];
    let bytes = 0;
    for await (const b of req) {
      bytes += b.length;
      if (bytes > 1024 * 1024) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(b);
    }
    const body = Buffer.concat(chunks),
      headers = { ...req.headers, origin: 'http://127.0.0.1:3003' };
    delete headers.host;
    delete headers.connection;
    delete headers['content-length'];
    const result = await fetch('http://127.0.0.1:3003' + req.url, {
        method: req.method,
        headers,
        redirect: 'manual',
        ...(['GET', 'HEAD'].includes(req.method) ? {} : { body }),
      }),
      payload = Buffer.from(await result.arrayBuffer());
    if (
      !dropped &&
      req.method === 'POST' &&
      /^\/api\/v1\/workspaces\/[^/]+\/projects$/.test(req.url) &&
      result.status === 201
    ) {
      dropped = true;
      await fs.writeFile(
        path.join(data, 'project-browser-drop.json'),
        JSON.stringify({
          dropped: true,
          upstreamStatus: result.status,
          at: new Date().toISOString(),
          projectId: JSON.parse(payload.toString()).data.id,
        }),
      );
      res.destroy();
      return;
    }
    res.statusCode = result.status;
    for (const [name, value] of result.headers)
      if (
        ![
          'content-length',
          'content-encoding',
          'transfer-encoding',
          'connection',
          'set-cookie',
        ].includes(name)
      )
        res.setHeader(name, value);
    const cookies = result.headers.getSetCookie();
    if (cookies.length) res.setHeader('set-cookie', cookies);
    res.end(payload);
  } catch {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  }
});
server.listen(3006, '127.0.0.1', () =>
  console.log(
    'stage loss proxy 127.0.0.1:3006 ready; one committed project response will be dropped',
  ),
);
process.on('SIGTERM', () => server.close());
