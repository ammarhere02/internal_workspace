import { Transform, plainToInstance } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsString, Min, MinLength, validateSync } from 'class-validator';

/**
 * Every environment variable the service reads, validated once at startup.
 * A typo in .env fails fast here instead of surfacing as a weird runtime error.
 */
export class Env {
  @IsString() @MinLength(10) MONGODB_URI!: string;
  @IsString() @MinLength(1) MANAGEMENT_DB_NAME: string = 'management_db';
  @IsString() @MinLength(1) NATS_URL: string = 'nats://localhost:4222';
  @IsInt() @Min(1) PORT: number = 3000;
  @IsString() @MinLength(1) WORKSPACE_SLUG: string = 'dev';
  @IsIn(['fatal', 'error', 'warn', 'info', 'debug', 'trace']) LOG_LEVEL: string = 'info';
  @IsInt() @Min(100) MONGO_TIMEOUT_MS: number = 5000;
  @IsInt() @Min(100) NATS_REQUEST_TIMEOUT_MS: number = 2000;
  @IsInt() @Min(100) OUTBOX_POLL_MS: number = 500;
  // implicit conversion would turn the string 'false' into true; parse booleans explicitly
  @Transform(({ obj, key }) => { const v = obj[key]; return typeof v === 'string' ? ['true', '1', 'yes'].includes(v.toLowerCase()) : v ?? true; })
  @IsBoolean() OUTBOX_RELAY_ENABLED: boolean = true;
  @IsInt() @Min(1) OUTBOX_BATCH: number = 50;
  @IsInt() @Min(1) OUTBOX_MAX_ATTEMPTS: number = 10;
  @IsString() CONTRACTS_DIR: string = '';
  // ---- authentication (phase 6b). dev = seeded identities + x-dev-user header (tests, credential-less demo);
  // google = Passport Google OAuth 2.0 with server-side sessions; requires the three GOOGLE_* values.
  @IsIn(['dev', 'google']) AUTH_MODE: 'dev' | 'google' = 'dev';
  @IsString() GOOGLE_CLIENT_ID: string = '';
  @IsString() GOOGLE_CLIENT_SECRET: string = '';
  @IsString() GOOGLE_CALLBACK_URL: string = 'http://localhost:3100/auth/google/callback';
  @IsString() SESSION_SECRET: string = '';
  /** Comma-separated emails that become ADMIN on sign-in; everyone else is EMPLOYEE. Seeded usr_admin is always ADMIN. */
  @IsString() ADMIN_EMAILS: string = '';
  /** Secret for e-mail/password JWTs; defaults to SESSION_SECRET. */
  @IsString() JWT_SECRET: string = '';
  @Transform(({ obj, key }) => { const v = obj[key]; return typeof v === 'string' ? ['true', '1', 'yes'].includes(v.toLowerCase()) : v ?? true; })
  @IsBoolean() LOCAL_SIGNUP_ENABLED: boolean = true;
}

export function validateEnv(raw: Record<string, unknown>): Env {
  const env = plainToInstance(Env, raw, { enableImplicitConversion: true, exposeDefaultValues: true });
  const errors = validateSync(env, { whitelist: true });
  if (env.AUTH_MODE === 'google' && (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || env.SESSION_SECRET.length < 16)) {
    throw new Error('AUTH_MODE=google requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and a SESSION_SECRET of at least 16 characters');
  }
  if (errors.length) {
    // Never print values: MONGODB_URI contains the password.
    const names = errors.map((e) => e.property).join(', ');
    throw new Error(`Invalid environment configuration: ${names}`);
  }
  return env;
}
