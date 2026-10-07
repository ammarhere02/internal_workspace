import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import MongoStore from 'connect-mongo';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import passport from 'passport';
import type { Env } from '../config/env.js';
import { MongoService } from '../infra/mongo/mongo.module.js';
import { IdentityService } from '../identity/identity.service.js';
import { GoogleStrategy } from './google.strategy.js';

/**
 * AUTH_MODE=google: server-side sessions (cookie holds only a session id; the session, stored in
 * management_db.sessions, holds only the user id) + Passport with the Google OAuth 2.0 strategy.
 * AUTH_MODE=dev: nothing is installed; IdentityMiddleware keeps using the seeded dev identities.
 */
export function configureAuth(app: NestExpressApplication) {
  const config = app.get(ConfigService<Env, true>);
  app.use(cookieParser()); // JWT cookie for e-mail/password sign-in (both modes)
  if (config.get('AUTH_MODE') !== 'google') return app;
  const mongo = app.get(MongoService);
  const identity = app.get(IdentityService);
  app.set('trust proxy', 1);
  app.use(session({
    name: 'tm.sid',
    secret: config.get('SESSION_SECRET'),
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ client: mongo.client, dbName: config.get('MANAGEMENT_DB_NAME'), collectionName: 'sessions', ttl: 8 * 3600, autoRemove: 'native' }),
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.get('GOOGLE_CALLBACK_URL').startsWith('https://'), maxAge: 8 * 3600 * 1000 },
  }));
  passport.use(new GoogleStrategy(config, identity).strategy());
  passport.serializeUser((user, done) => done(null, (user as { _id: string })._id)); // session stores the id only
  passport.deserializeUser(async (id: string, done) => { try { done(null, (await identity.findActive(id)) ?? false); } catch (e) { done(e as Error); } });
  app.use(passport.initialize());
  app.use(passport.session());
  return app;
}
