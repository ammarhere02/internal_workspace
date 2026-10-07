import type { NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import express from 'express';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
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
  app.use(compression()); // gzip HTML, JSON and the large vendor CSS/JS
  const serve = (dir: string, maxAge: string, immutable = false) => express.static(dir, { index: false, maxAge, etag: true, immutable });
  // Pages load our scripts from /assets/v/<content hash>/: relative module imports stay inside that versioned path, so the
  // browser caches the whole module graph for good (no per-file revalidation waterfall) and a new build gets new URLs.
  const version = assetVersion(`${UI_DIR}public`);
  app.setLocal('assets', `/assets/v/${version}`);
  app.use(`/assets/v/${version}`, serve(`${UI_DIR}public`, '365d', true));
  app.use('/assets', serve(`${UI_DIR}public`, '0')); // unversioned path: always revalidated (ETag)
  app.use('/vendor/adminlte', serve(`${pkgDir('admin-lte')}/dist`, '7d'));
  app.use('/vendor/bootstrap', serve(`${pkgDir('bootstrap')}/dist`, '7d'));
  app.use('/vendor/bootstrap-icons', serve(`${pkgDir('bootstrap-icons')}/font`, '7d'));
  return app;
}

/** Short content hash of every file under dir: changes exactly when a deploy changes the UI. */
function assetVersion(dir: string) {
  const hash = createHash('sha256');
  for (const f of readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)).sort()) hash.update(f.slice(dir.length)).update(readFileSync(f));
  return hash.digest('hex').slice(0, 12);
}
