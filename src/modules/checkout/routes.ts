import type { FastifyPluginAsync } from 'fastify';
import { toFieldIssues } from '../../api/validation';
import { currentContext, setContextOrderId } from '../../shared/context';
import { AppError } from '../../shared/errors';
import { checkoutRequests } from '../../shared/metrics';
import { checkoutBodySchema, idempotencyKeySchema } from './schemas';
import type { CheckoutService } from './service';

function invalid(
  code: 'MISSING_IDEMPOTENCY_KEY' | 'INVALID_IDEMPOTENCY_KEY' | 'VALIDATION_ERROR',
  message: string,
  details?: unknown,
) {
  checkoutRequests.inc({ outcome: 'invalid' });
  return new AppError(code, 400, message, details);
}

export const checkoutRoutes: FastifyPluginAsync<{ service: CheckoutService }> = async (app, { service }) => {
  app.post('/checkout', async (req, reply) => {
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

    const { accepted } = await service.place({
      idempotencyKey: key.data,
      items: body.data.items,
      correlationId: currentContext()?.correlationId ?? req.id,
    });
    setContextOrderId(accepted.orderId);
    return reply.code(202).header('location', accepted.statusUrl).send(accepted);
  });
};
