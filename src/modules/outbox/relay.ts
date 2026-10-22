import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { Logger } from '../../shared/logger';
import { withSpan } from '../../shared/tracing';
import type { OutboxRepository } from './repository';

export interface OutboxRelay {
  /** Publishes one batch; returns how many rows were published. */
  runOnce(): Promise<number>;
}

/**
 * Transactional outbox → SQS. If the process dies between SendMessage and the UPDATE, the row is published
 * again on the next run: delivery is at-least-once and the consumer is idempotent by design.
 */
export function createOutboxRelay(deps: {
  repo: OutboxRepository;
  sqs: Pick<SQSClient, 'send'>;
  queueUrl: string;
  batchSize: number;
  logger: Logger;
}): OutboxRelay {
  return {
    runOnce: () =>
      deps.repo.publishBatch(deps.batchSize, (rows) =>
        withSpan('outbox.publish', { 'outbox.batch_size': rows.length }, async () => {
          const out = await deps.sqs.send(
            new SendMessageBatchCommand({
              QueueUrl: deps.queueUrl,
              Entries: rows.map((r) => {
                const correlationId = typeof r.payload.correlationId === 'string' ? r.payload.correlationId : undefined;
                return {
                  Id: r.id,
                  MessageBody: JSON.stringify(r.payload),
                  MessageAttributes: {
                    eventType: { DataType: 'String', StringValue: r.eventType },
                    ...(correlationId ? { correlationId: { DataType: 'String', StringValue: correlationId } } : {}),
                  },
                };
              }),
            }),
          );
          for (const failed of out.Failed ?? []) {
            deps.logger.warn({ outboxId: failed.Id, code: failed.Code }, 'outbox row not published, will retry');
          }
          return (out.Successful ?? []).flatMap((s) => (s.Id ? [s.Id] : []));
        }),
      ),
  };
}
