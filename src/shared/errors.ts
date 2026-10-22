export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_JSON'
  | 'MISSING_IDEMPOTENCY_KEY'
  | 'INVALID_IDEMPOTENCY_KEY'
  | 'ROUTE_NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'PRODUCT_NOT_FOUND'
  | 'ORDER_NOT_FOUND'
  | 'OUT_OF_STOCK'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'UNKNOWN_SKU'
  | 'CATALOG_UNAVAILABLE'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly httpStatus: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** Infrastructure failure (DB, Redis, queue down) that the caller cannot fix by changing the request. */
export class DependencyError extends Error {
  constructor(
    readonly dependency: string,
    cause: unknown,
  ) {
    super(`${dependency} unavailable`, { cause });
    this.name = 'DependencyError';
  }
}

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
  '08000',
  '08001',
  '08003',
  '08006',
]);

/** True when the error means "the dependency is unreachable", not "the query is wrong". */
export function isConnectionError(err: unknown): boolean {
  if (err instanceof DependencyError) return true;
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && CONNECTION_ERROR_CODES.has(code)) return true;
  const message = (err as { message?: unknown }).message;
  return (
    typeof message === 'string' && /Connection terminated|connect ECONNREFUSED|Connection is closed/i.test(message)
  );
}
