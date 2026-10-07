import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { MongoServerError } from 'mongodb';
import { redactSecrets } from '../redact.js';
import { DomainError } from './domain-error.js';

/** Every error leaves the service in the same shape, with the correlation id so a user can quote it. */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger('http');

  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request & { id?: string }>();
    const correlationId = String(req.id ?? '');
    let status = 500;
    let code = 'internal_error';
    let message = 'internal error';
    let details: unknown;

    if (err instanceof DomainError) {
      ({ status, code, message, details } = err);
    } else if (err instanceof HttpException) {
      status = err.getStatus();
      const body = err.getResponse();
      code = status === 400 ? 'validation_error' : status === 404 ? 'not_found' : `http_${status}`;
      message = typeof body === 'string' ? body : ((body as { message?: string | string[] }).message as string) ?? err.message;
      if (typeof body === 'object' && Array.isArray((body as { message?: unknown }).message)) {
        details = { violations: (body as { message: string[] }).message };
        message = 'request validation failed';
      }
    } else if (err instanceof MongoServerError && err.code === 11000) {
      status = 409;
      code = 'duplicate_key';
      message = 'a record with the same unique value already exists';
      details = { keys: Object.keys(err.keyPattern ?? {}) };
    } else {
      this.log.error({ correlationId, err: redactSecrets(String((err as Error)?.stack ?? err)) }, 'unhandled error');
    }
    res.status(status).json({ error: { code, message, details, correlationId } });
  }
}
