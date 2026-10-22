import { AppError } from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import { type CancelOutcome, orderCancellations } from '../../shared/metrics';
import type { OrdersRepository } from './repository';
import type { OrderStatusResponse } from './schemas';

export const CUSTOMER_CANCEL_REASON = 'cancelled by customer';

export interface OrdersService {
  getStatus(orderId: string): Promise<OrderStatusResponse>;
  /** Cancels a RESERVED order and releases its stock; cancelling a CANCELLED order again is a no-op. */
  cancel(orderId: string): Promise<OrderStatusResponse>;
}

export function createOrdersService(deps: { repo: OrdersRepository; logger: Logger }): OrdersService {
  function count(outcome: CancelOutcome) {
    orderCancellations.inc({ outcome });
  }

  async function getStatus(orderId: string): Promise<OrderStatusResponse> {
    const order = await deps.repo.findStatus(orderId);
    if (!order) throw new AppError('ORDER_NOT_FOUND', 404, `Order ${orderId} not found`);
    return order;
  }

  return {
    getStatus,

    async cancel(orderId) {
      const result = await deps.repo.cancelReserved(orderId, CUSTOMER_CANCEL_REASON);
      switch (result.kind) {
        case 'not_found':
          count('not_found');
          throw new AppError('ORDER_NOT_FOUND', 404, `Order ${orderId} not found`);
        case 'not_cancellable':
          count('not_cancellable');
          throw new AppError('ORDER_NOT_CANCELLABLE', 409, `Order is ${result.status} and can no longer be cancelled`, {
            status: result.status,
          });
        case 'already_cancelled':
          // Idempotent by state: a retried or double-clicked cancel answers like the first one.
          count('already_cancelled');
          break;
        case 'cancelled':
          count('cancelled');
          deps.logger.info({ orderId }, 'order cancelled by customer, stock released');
          break;
      }
      return getStatus(orderId);
    },
  };
}
