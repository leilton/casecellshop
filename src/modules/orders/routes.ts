import type { FastifyPluginAsync } from 'fastify';
import { parseOrThrow } from '../../api/validation';
import { setContextOrderId } from '../../shared/context';
import { orderIdParamsSchema } from './schemas';
import type { OrdersService } from './service';

export const ordersRoutes: FastifyPluginAsync<{ service: OrdersService }> = async (app, { service }) => {
  app.get('/orders/:id/status', async (req, reply) => {
    const { id } = parseOrThrow(orderIdParamsSchema, req.params);
    setContextOrderId(id);
    const order = await service.getStatus(id);
    // Status changes asynchronously; clients poll, so intermediaries must not cache it.
    reply.header('cache-control', 'no-store');
    return order;
  });
};
