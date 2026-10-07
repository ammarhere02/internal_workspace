import { Body, Controller, HttpCode, Ip, Post, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { DomainError } from '../common/errors/domain-error.js';
import type { Env } from '../config/env.js';
import { IdentityService } from '../identity/identity.service.js';
import type { UserDoc } from '../identity/identity.types.js';
import { landingFor } from './auth.controller.js';
import { LoginDto, RegisterDto } from './dto/auth.dto.js';
import { JWT_COOKIE, signToken } from './jwt.js';
import { policyFrom, slideExpiry } from './session-policy.js';
import { hashPassword, verifyPassword } from './password.js';
import { RateLimiter } from './rate-limit.js';

/**
 * E-mail + password sign-in (employees; admins may use it too if allow-listed) issuing a JWT.
 * The token is returned in the body (for API clients: `Authorization: Bearer`) and set as an HttpOnly
 * cookie (for the browser). Unknown e-mail and wrong password produce the same 401 so accounts cannot be
 * enumerated; attempts are rate-limited per IP and per e-mail.
 */
@Controller('auth')
export class LocalAuthController {
  private readonly perIp = new RateLimiter(20, 15 * 60_000);
  private readonly perEmail = new RateLimiter(5, 15 * 60_000);

  constructor(private readonly identity: IdentityService, private readonly config: ConfigService<Env, true>) {}

  private secret() { return this.config.get('JWT_SECRET') || this.config.get('SESSION_SECRET'); }

  private issue(res: Response, user: UserDoc) {
    const now = Date.now();
    const expMs = slideExpiry(now, now, policyFrom(this.config));
    const token = signToken({ sub: user._id, ws: user.workspaceId, role: user.role }, this.secret(), { authAtMs: now, expMs });
    res.cookie(JWT_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: this.config.get('GOOGLE_CALLBACK_URL').startsWith('https://'), maxAge: expMs - now, path: '/' });
    res.setHeader('x-session-expires', new Date(expMs).toISOString());
    return { token, tokenType: 'Bearer', expiresIn: Math.floor((expMs - now) / 1000), sessionExpiresAt: new Date(expMs).toISOString(), user: { id: user._id, name: user.name, email: user.email, role: user.role }, landing: landingFor(user) };
  }

  private throttle(ip: string, email: string) {
    const wait = Math.max(this.perIp.hit(ip), this.perEmail.hit(email.toLowerCase()));
    if (wait > 0) throw new DomainError(429, 'too_many_attempts', `too many attempts; try again in ${wait}s`, { retryAfterSec: wait });
  }

  @Post('register') @HttpCode(201)
  async register(@Body() dto: RegisterDto, @Ip() ip: string, @Res({ passthrough: true }) res: Response) {
    if (!this.config.get('LOCAL_SIGNUP_ENABLED')) throw new DomainError(403, 'signup_disabled', 'self-registration is disabled; ask an administrator');
    this.throttle(ip, dto.email);
    const user = await this.identity.createLocalUser({ name: dto.name, email: dto.email, passwordHash: await hashPassword(dto.password) });
    return this.issue(res, user);
  }

  @Post('login') @HttpCode(200)
  async login(@Body() dto: LoginDto, @Ip() ip: string, @Res({ passthrough: true }) res: Response) {
    this.throttle(ip, dto.email);
    const user = await this.identity.findByEmail(dto.email);
    // always run the hash comparison so timing does not reveal whether the e-mail exists
    const ok = await verifyPassword(dto.password, user?.passwordHash ?? null);
    if (!user || !ok || !user.active) throw new DomainError(401, 'invalid_credentials', 'e-mail or password is incorrect');
    this.perEmail.reset(dto.email.toLowerCase());
    await this.identity.touchLogin(user._id);
    return this.issue(res, user);
  }

  /** Clears the JWT cookie; the token itself stays valid until expiry (stateless), so keep TTLs short. */
  @Post('logout/token') @HttpCode(204)
  logoutToken(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(JWT_COOKIE, { path: '/' });
  }
}
