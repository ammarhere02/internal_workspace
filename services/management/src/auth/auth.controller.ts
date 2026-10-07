import { Controller, Get, Next, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import passport from 'passport';
import type { Env } from '../config/env.js';
import type { UserDoc } from '../identity/identity.types.js';
import { JWT_COOKIE, verifyToken } from './jwt.js';

/**
 * Login page + Google OAuth round trip. After sign-in, ADMIN lands on the dashboard and EMPLOYEE on "My Work".
 * In AUTH_MODE=dev the login page simply explains that the dev identity is in use.
 */
@Controller()
export class AuthController {
  constructor(private readonly config: ConfigService<Env, true>) {}

  @Get('login')
  login(@Req() req: Request & { user?: UserDoc; cookies?: Record<string, string>; query: { error?: string } }, @Res() res: Response) {
    if (req.user) return res.redirect(landingFor(req.user));
    const claims = req.cookies?.[JWT_COOKIE] ? verifyToken(req.cookies[JWT_COOKIE]!, this.config.get('JWT_SECRET') || this.config.get('SESSION_SECRET')) : null;
    if (claims) return res.redirect(landingFor(claims));
    return res.render('pages/login', { page: 'login', title: 'Sign in', authMode: this.config.get('AUTH_MODE'), signup: this.config.get('LOCAL_SIGNUP_ENABLED'), error: typeof req.query.error === 'string' ? req.query.error : '' });
  }

  @Get('register')
  register(@Req() req: Request & { user?: UserDoc; cookies?: Record<string, string> }, @Res() res: Response) {
    if (req.user) return res.redirect(landingFor(req.user));
    if (this.config.get('AUTH_MODE') !== 'google' || !this.config.get('LOCAL_SIGNUP_ENABLED')) return res.redirect('/login');
    return res.render('pages/register', { page: 'register', title: 'Register' });
  }

  @Get('auth/google')
  google(@Req() req: Request, @Res() res: Response, @Next() next: NextFunction) {
    if (this.config.get('AUTH_MODE') !== 'google') return res.redirect('/login?error=google_disabled');
    return passport.authenticate('google', { scope: ['profile', 'email'], prompt: 'select_account' })(req, res, next);
  }

  @Get('auth/google/callback')
  callback(@Req() req: Request, @Res() res: Response, @Next() next: NextFunction) {
    if (this.config.get('AUTH_MODE') !== 'google') return res.redirect('/login?error=google_disabled');
    return passport.authenticate('google', { failureRedirect: '/login?error=google_failed' }, (err: unknown, user: UserDoc | false) => {
      if (err || !user) return res.redirect(`/login?error=${encodeURIComponent(errorCode(err))}`);
      req.logIn(user, (e) => (e ? next(e) : res.redirect(landingFor(user))));
    })(req, res, next);
  }

  @Post('auth/logout')
  logout(@Req() req: Request, @Res() res: Response, @Next() next: NextFunction) {
    res.clearCookie(JWT_COOKIE, { path: '/' }); // e-mail/password session
    if (typeof req.logout !== 'function') return res.redirect('/login');
    req.logout((err) => { if (err) return next(err); req.session?.destroy(() => { res.clearCookie('tm.sid'); res.redirect('/login'); }); });
  }
}

/** Separate redirection for the two roles (the point of the feature). */
export const landingFor = (user: Pick<UserDoc, 'role'>) => (user.role === 'ADMIN' ? '/' : '/my');
const errorCode = (err: unknown) => (err && typeof err === 'object' && 'code' in err ? String((err as { code: string }).code) : 'google_failed');
