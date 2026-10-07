import type { ConfigService } from '@nestjs/config';
import { Strategy as PassportGoogleStrategy, type Profile, type VerifyCallback } from 'passport-google-oauth20';
import type { Env } from '../config/env.js';
import type { IdentityService } from '../identity/identity.service.js';

/**
 * Google OAuth 2.0 (passport-google-oauth20). We only ask for `profile` and `email`; the verify step maps
 * the Google identity to a workspace user (auto-enrolled, role from ADMIN_EMAILS). No token is stored.
 */
export class GoogleStrategy {
  constructor(private readonly config: ConfigService<Env, true>, private readonly identity: IdentityService) {}

  strategy() {
    return new PassportGoogleStrategy(
      { clientID: this.config.get('GOOGLE_CLIENT_ID'), clientSecret: this.config.get('GOOGLE_CLIENT_SECRET'), callbackURL: this.config.get('GOOGLE_CALLBACK_URL'), scope: ['profile', 'email'] },
      (_accessToken: string, _refreshToken: string, profile: Profile, done: VerifyCallback) => this.verify(profile).then((u) => done(null, u), (e) => done(e)),
    );
  }

  /** Separated so it can be unit-tested with a fake profile. */
  async verify(profile: Pick<Profile, 'id' | 'displayName' | 'emails'>) {
    const email = profile.emails?.find((e) => (e as { verified?: boolean | string }).verified !== false && (e as { verified?: boolean | string }).verified !== 'false')?.value ?? profile.emails?.[0]?.value;
    if (!email) throw new Error('google_profile_without_email');
    return this.identity.upsertGoogleUser({ id: profile.id, email, name: profile.displayName });
  }
}
