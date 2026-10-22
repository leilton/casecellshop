import { randomUUID } from 'node:crypto';

const TEST_DB_NAME = 'shop_test';

export function testDatabaseUrl(): string {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL is required to run the tests (run them with `make test`)');
  const url = new URL(base);
  url.pathname = `/${TEST_DB_NAME}`;
  return url.toString();
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required to run the tests (run them with \`make test\`)`);
  return value;
}

/** Short random suffix so parallel test files never collide on SKUs, keys or queues. */
export function uniqueId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;
}
