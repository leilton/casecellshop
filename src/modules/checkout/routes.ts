import type { FastifyPluginAsync } from 'fastify';
import { toFieldIssues } from '../../api/validation';
import type { ConcurrencyLimiter } from '../../shared/concurrency';
import { currentContext, setContextOrderId } from '../../shared/context';
import { AppError } from '../../shared/errors';
import { checkoutRequests } from '../../shared/metrics';
import { checkoutBodySchema, idempotencyKeySchema } from './schemas';
import type { CheckoutService } from './service';

export interface CheckoutRateLimit {
  max: number;
  windowS: number;
}

export interface CheckoutRouteOptions {
  service: CheckoutService;
  limiter: ConcurrencyLimiter;
  rateLimit: CheckoutRateLimit;
}

function invalid(
  code: 'MISSING_IDEMPOTENCY_KEY' | 'INVALID_IDEMPOTENCY_KEY' | 'VALIDATION_ERROR',
  message: string,
  details?: unknown,
) {
  checkoutRequests.inc({ outcome: 'invalid' });
  return new AppError(code, 400, message, details);
}

export const checkoutRoutes: FastifyPluginAsync<CheckoutRouteOptions> = async (
  app,
  { service, limiter, rateLimit },
) => {
  const routeConfig = {
    // Runs on onRequest, before the body is parsed: an abusive client costs one Redis call, not a transaction.
    rateLimit: {
      max: rateLimit.max,
      timeWindow: rateLimit.windowS * 1000,
      onExceeded: () => checkoutRequests.inc({ outcome: 'rate_limited' }),
      errorResponseBuilder: (_req: unknown, ctx: { after: string }) =>
        new AppError('RATE_LIMITED', 429, `Too many checkout attempts, retry in ${ctx.after}`),
    },
  };

  app.post('/checkout', { config: routeConfig }, async (req, reply) => {
    const rawKey = req.headers['idempotency-key'];
    if (rawKey === undefined) {
      throw invalid('MISSING_IDEMPOTENCY_KEY', 'Idempotency-Key header is required');
    }
    const key = idempotencyKeySchema.safeParse(rawKey);
    if (!key.success) {
      throw invalid('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key header is invalid', toFieldIssues(key.error));
    }
    const body = checkoutBodySchema.safeParse(req.body);
    if (!body.success) {
      throw invalid('VALIDATION_ERROR', 'Request is invalid', toFieldIssues(body.error));
    }

    // Shedding happens before the service runs, so a 503 never leaves a reservation behind and a retry with the
    // same Idempotency-Key is always safe.
    const { accepted } = await limiter
      .run(() =>
        service.place({
          idempotencyKey: key.data,
          items: body.data.items,
          // Stryker disable next-line LogicalOperator,OptionalChaining: the onRequest hook always creates the context
          correlationId: currentContext()?.correlationId ?? req.id,
        }),
      )
      .catch((err: unknown) => {
        if (err instanceof AppError && err.code === 'OVERLOADED') checkoutRequests.inc({ outcome: 'shed' });
        throw err;
      });
    setContextOrderId(accepted.orderId);
    return reply.code(202).header('location', accepted.statusUrl).send(accepted);
  });
};
