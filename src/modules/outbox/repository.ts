import { type Db, withTx } from '../../shared/db';

export interface OutboxRow {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface OutboxRepository {
  /**
   * Locks a batch of unpublished rows, hands them to `publish`, and marks as published only the ids it returns.
   * `SKIP LOCKED` lets several relays run side by side without publishing the same row twice.
   */
  publishBatch(limit: number, publish: (rows: OutboxRow[]) => Promise<string[]>): Promise<number>;
}

export function createOutboxRepository(db: Db): OutboxRepository {
  return {
    publishBatch: (limit, publish) =>
      withTx(db, async (tx) => {
        const { rows } = await tx.query<{
          id: string;
          aggregate_id: string;
          event_type: string;
          payload: Record<string, unknown>;
        }>(
          `SELECT id, aggregate_id, event_type, payload FROM outbox
           WHERE published_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
          [limit],
        );
        if (rows.length === 0) return 0;
        const published = await publish(
          rows.map((r) => ({ id: r.id, aggregateId: r.aggregate_id, eventType: r.event_type, payload: r.payload })),
        );
        if (published.length > 0) {
          await tx.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[])', [published]);
        }
        return published.length;
      }),
  };
}
