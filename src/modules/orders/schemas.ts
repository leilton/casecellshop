import { z } from 'zod';
import { orderStatusSchema } from '../checkout/schemas';

export const orderIdParamsSchema = z.object({ id: z.string().uuid('id must be a UUID') });

export const orderEventSchema = z.object({
  from: orderStatusSchema.nullable(),
  to: orderStatusSchema,
  at: z.string(),
  detail: z.unknown().optional(),
});

export const orderStatusResponseSchema = z.object({
  orderId: z.string().uuid(),
  status: orderStatusSchema,
  totalCents: z.number().int().nonnegative(),
  items: z.array(z.object({ sku: z.string(), quantity: z.number().int().positive(), priceCents: z.number().int() })),
  invoiceId: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  reservedUntil: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  history: z.array(orderEventSchema),
});
export type OrderStatusResponse = z.infer<typeof orderStatusResponseSchema>;
