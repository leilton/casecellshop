import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { testDatabaseUrl } from './env';

/**
 * Integration tests get their own database, rebuilt from the real schema on every run. The compose worker
 * keeps polling `shop`, so sharing it would let it publish and invoice the orders our assertions look at.
 */
export default async function setup(): Promise<void> {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) throw new Error('DATABASE_URL is required to run the tests (run them with `make test`)');
  const testUrl = new URL(testDatabaseUrl());
  const dbName = testUrl.pathname.slice(1);

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }

  const schema = await readFile(path.resolve(__dirname, '../../infra/postgres/init.sql'), 'utf8');
  const client = new pg.Client({ connectionString: testUrl.toString() });
  await client.connect();
  try {
    await client.query(schema);
  } finally {
    await client.end();
  }
}
