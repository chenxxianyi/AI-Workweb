import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';

/** 正式构建同源服务；API永不落入SPA，源码/点文件不对外提供。 */
export function serveWeb(app: NestExpressApplication, directory: string): void {
  const root = resolve(directory);
  if (!existsSync(resolve(root, 'index.html'))) throw new Error('WEB_DIST_DIR缺少正式构建');
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
    );
    res.setHeader('Cache-Control', 'no-cache');
    next();
  });
  app.useStaticAssets(root, {
    dotfiles: 'deny',
    index: false,
    setHeaders: (res, file) => {
      if (file.includes('/assets/') || file.includes('\\assets\\'))
        res.setHeader('Cache-Control', 'public,max-age=31536000,immutable');
    },
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api') || !['GET', 'HEAD'].includes(req.method)) return next();
    if (req.path.includes('.') || req.path.startsWith('/assets/') || req.path.startsWith('/__')) {
      res.status(404).end();
      return;
    }
    res.sendFile('index.html', { root });
  });
}
