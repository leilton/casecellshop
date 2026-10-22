import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PORT: z.coerce.number().int().positive().default(3000),
  METRICS_PORT: z.coerce.number().int().positive().default(9464),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  AWS_REGION: z.string().default('us-east-1'),
  SQS_ENDPOINT: z.string().url().optional(),
  CHECKOUT_QUEUE_URL: z.string().url(),
  CHECKOUT_DLQ_URL: z.string().url(),

  ERP_BASE_URL: z.string().url(),
  ERP_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),

  CACHE_TTL_PRICE_S: z.coerce.number().int().positive().default(60),
  CACHE_TTL_STOCK_S: z.coerce.number().int().positive().default(5),
  CACHE_STALE_IF_ERROR_S: z.coerce.number().int().nonnegative().default(120),
  CACHE_LOCK_TTL_MS: z.coerce.number().int().positive().default(5000),

  CATALOG_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),

  // Peak protection on POST /checkout (ADR 0009). Only trust X-Forwarded-For behind a proxy we control.
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  CHECKOUT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  CHECKOUT_RATE_LIMIT_WINDOW_S: z.coerce.number().int().positive().default(10),
  CHECKOUT_MAX_CONCURRENCY: z.coerce.number().int().positive().default(16),
  CHECKOUT_MAX_QUEUE: z.coerce.number().int().nonnegative().default(100),
  CHECKOUT_QUEUE_TIMEOUT_MS: z.coerce.number().int().positive().default(1000),

  RESERVATION_TTL_S: z.coerce.number().int().positive().default(900),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  WORKER_BACKOFF_BASE_S: z.coerce.number().int().positive().default(2),
  WORKER_BACKOFF_MAX_S: z.coerce.number().int().positive().default(60),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().max(10).default(10),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  INVOICING_STUCK_AFTER_S: z.coerce.number().int().positive().default(120),
  INVOICING_LEASE_S: z.coerce.number().int().positive().default(15),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}

let cached: Config | undefined;

export function config(): Config {
  cached ??= loadConfig();
  return cached;
}
