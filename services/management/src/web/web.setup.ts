import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * AdminLTE UI (PDF §12), served by this service: no third backend. Everything the browser receives is
 * static assets or server-rendered page shells; data always goes through /api/* so the browser never
 * sees database access or credentials (PDF §11). `ui/` sits beside `src/` so the UI stays separate
 * from domain code; the same path works from src/ (vitest) and dist/ (nest build).
 */
export const UI_DIR = fileURLToPath(new URL('../../ui/', import.meta.url));
const require = createRequire(import.meta.url);
const pkgDir = (name: string) => dirname(require.resolve(`${name}/package.json`));

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", // Bootstrap components set inline style attributes; Google Fonts serves AdminLTE's Source Sans 3
  "img-src 'self' data:",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export function configureWeb(app: NestExpressApplication) {
  app.setBaseViewsDir(`${UI_DIR}views`);
  app.setViewEngine('ejs');
  app.use((_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  const serve = (dir: string, maxAge: string) => express.static(dir, { index: false, maxAge, etag: true });
  app.use('/assets', serve(`${UI_DIR}public`, '0')); // our own scripts/styles: always revalidated (ETag), so a rebuild never runs stale JS against new pages
  app.use('/vendor/adminlte', serve(`${pkgDir('admin-lte')}/dist`, '1d'));
  app.use('/vendor/bootstrap', serve(`${pkgDir('bootstrap')}/dist`, '1d'));
  app.use('/vendor/bootstrap-icons', serve(`${pkgDir('bootstrap-icons')}/font`, '1d'));
  return app;
}
