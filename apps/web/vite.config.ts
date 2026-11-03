import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 开发服务器与 API 同源：浏览器访问 5173，/api 由 Vite 代理到后端 3001。
 * 这样 cookie 会话与 CSRF 校验在开发期与生产同源形态一致（ADR-0003 第 5 条）。
 */
const webPort = Number(process.env.WEB_PORT ?? 5173);
const apiPort = Number(process.env.API_PORT ?? 3001);

export default defineConfig({
  plugins: [react()],
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
});
