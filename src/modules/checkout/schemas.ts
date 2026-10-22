import { z } from 'zod';
import { skuSchema } from '../catalog/schemas';

export const MAX_ITEMS = 10;
export const MAX_QUANTITY = 5;

export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'only letters, digits and . _ : - are allowed');

export const checkoutItemSchema = z
  .object({
    sku: skuSchema,
    quantity: z.number().int().min(1).max(MAX_QUANTITY),
  })
  .strict();

export const checkoutBodySchema = z
  .object({
    items: z
      .array(checkoutItemSchema)
      .min(1)
      .max(MAX_ITEMS)
      .refine((items) => new Set(items.map((i) => i.sku)).size === items.length, {
        message: 'each sku may appear only once; use quantity instead',
      }),
  })
  .strict();
export type CheckoutBody = z.infer<typeof checkoutBodySchema>;
export type CheckoutItem = z.infer<typeof checkoutItemSchema>;

export const orderStatusSchema = z.enum(['PENDING', 'RESERVED', 'INVOICING', 'INVOICED', 'FAILED', 'CANCELLED']);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

export const checkoutAcceptedSchema = z.object({
  orderId: z.string().uuid(),
  status: orderStatusSchema,
  statusUrl: z.string(),
});
export type CheckoutAccepted = z.infer<typeof checkoutAcceptedSchema>;

/** Payload of the `OrderPlaced` outbox event / SQS message. */
export const orderPlacedMessageSchema = z.object({
  orderId: z.string().uuid(),
  correlationId: z.string().optional(),
  trace: z.record(z.string()).optional(),
});
export type OrderPlacedMessage = z.infer<typeof orderPlacedMessageSchema>;
