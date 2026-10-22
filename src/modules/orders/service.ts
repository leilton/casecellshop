import { AppError } from '../../shared/errors';
import type { OrdersRepository } from './repository';
import type { OrderStatusResponse } from './schemas';

export interface OrdersService {
  getStatus(orderId: string): Promise<OrderStatusResponse>;
}

export function createOrdersService(deps: { repo: OrdersRepository }): OrdersService {
  return {
    async getStatus(orderId) {
      const order = await deps.repo.findStatus(orderId);
      if (!order) throw new AppError('ORDER_NOT_FOUND', 404, `Order ${orderId} not found`);
      return order;
    },
  };
}
