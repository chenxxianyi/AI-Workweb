import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { serviceWorkerSource } from './src/offline/service-worker-source.ts';

/**
 * 开发服务器与 API 同源：浏览器访问 5173，/api 由 Vite 代理到后端 3001。
 * 这样 cookie 会话与 CSRF 校验在开发期与生产同源形态一致（ADR-0003 第 5 条）。
 */
const webPort = Number(process.env.WEB_PORT ?? 5173);
const apiPort = Number(process.env.API_PORT ?? 3001);

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'aiwb-dev-viewport-acceptance',
      apply: 'serve',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          if (url.pathname !== '/__acceptance') return next();
          const width = [375, 768, 1440].includes(Number(url.searchParams.get('width')))
            ? Number(url.searchParams.get('width'))
            : 375;
          const requested = url.searchParams.get('path') ?? '/today',
            path = /^\/[a-z0-9/-]*$/.test(requested) ? requested : '/today';
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(
            '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>本机响应式验收</title></head><body style="margin:0;background:#ddd"><iframe title="验收工作台" src="' +
              path +
              '" style="display:block;border:0;width:' +
              width +
              'px;height:812px"></iframe></body></html>',
          );
        });
      },
    },
    {
      name: 'aiwb-private-safe-shell',
      apply: 'build',
      enforce: 'post',
      generateBundle(_options, bundle) {
        const files = Object.keys(bundle).filter(
          (name) => !name.endsWith('.map') && /\.(js|css|html|svg|woff2?)$/.test(name),
        );
        const digest = createHash('sha256');
        digest.update(serviceWorkerSource('template', []));
        for (const name of files) {
          const asset = bundle[name]!;
          digest.update(name);
          digest.update(asset.type === 'chunk' ? asset.code : String(asset.source));
        }
        for (const name of ['manifest.webmanifest', 'app-icon.svg'])
          digest.update(readFileSync(new URL('./public/' + name, import.meta.url)));
        const version = digest.digest('hex').slice(0, 16);
        this.emitFile({
          type: 'asset',
          fileName: 'sw.js',
          source: serviceWorkerSource(version, [
            ...files.map((name) => '/' + name),
            '/manifest.webmanifest',
            '/app-icon.svg',
          ]),
        });
      },
    },
  ],
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } },
  },
});
