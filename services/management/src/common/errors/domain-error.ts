/**
 * One error type for business rule violations. The HTTP filter maps it to a stable envelope:
 * { error: { code, message, details, correlationId } }
 */
export class DomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }

  static notFound(what: string, id: string) {
    return new DomainError(404, 'not_found', `${what} ${id} not found`, { id });
  }
  static conflict(code: string, message: string, details?: Record<string, unknown>) {
    return new DomainError(409, code, message, details);
  }
  static invalid(code: string, message: string, details?: Record<string, unknown>) {
    return new DomainError(422, code, message, details);
  }
  /** Stale expectedVersion: the client must refresh and retry (PDF §11 concurrency). */
  static stale(currentVersion: number, expectedVersion: number) {
    return new DomainError(409, 'version_conflict', `expected version ${expectedVersion} but current version is ${currentVersion}`, { currentVersion, expectedVersion });
  }
}
