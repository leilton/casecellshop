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

// Stryker disable next-line ArrayDeclaration,StringLiteral: only used for inferred types, never parsed at runtime
export const orderStatusSchema = z.enum(['PENDING', 'RESERVED', 'INVOICING', 'INVOICED', 'FAILED', 'CANCELLED']);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

// Stryker disable next-line ObjectLiteral: only used for the inferred type, never parsed at runtime
export const checkoutAcceptedSchema = z.object({
  orderId: z.string().uuid(),
  status: orderStatusSchema,
  statusUrl: z.string(),
});
export type CheckoutAccepted = z.infer<typeof checkoutAcceptedSchema>;

/** One SKU that could not be reserved, with what is left so the storefront can offer "only 2 left". */
export interface StockShortage {
  sku: string;
  requested: number;
  available: number;
}

/** `details` of a `409 OUT_OF_STOCK`; `skus` is kept for clients written before `items` existed. */
export interface OutOfStockDetails {
  skus: string[];
  items: StockShortage[];
}

/** Payload of the `OrderPlaced` outbox event / SQS message. */
export const orderPlacedMessageSchema = z.object({
  orderId: z.string().uuid(),
  correlationId: z.string().optional(),
  trace: z.record(z.string()).optional(),
});
export type OrderPlacedMessage = z.infer<typeof orderPlacedMessageSchema>;
