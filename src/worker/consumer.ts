import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { orderPlacedMessageSchema } from '../modules/checkout/schemas';
import type { HandleResult } from '../modules/invoicing/service';
import { runWithContext } from '../shared/context';
import type { Logger } from '../shared/logger';
import { extractTraceContext, runInContext } from '../shared/tracing';

export interface ConsumerOptions {
  name: string;
  sqs: Pick<SQSClient, 'send'>;
  queueUrl: string;
  /** Messages processed in parallel per receive (SQS caps a receive at 10). */
  concurrency: number;
  waitTimeS?: number;
  handle: (orderId: string) => Promise<HandleResult>;
  logger: Logger;
}

export interface QueueConsumer {
  /** One long-poll receive plus processing of what came back; returns the number of messages seen. */
  pollOnce(): Promise<number>;
}

export function createQueueConsumer(opts: ConsumerOptions): QueueConsumer {
  async function settle(message: Message, result: HandleResult) {
    if (result.action === 'ack') {
      // Deleted only after the handler committed its DB changes; a crash before this line means redelivery.
      await opts.sqs.send(new DeleteMessageCommand({ QueueUrl: opts.queueUrl, ReceiptHandle: message.ReceiptHandle }));
      return;
    }
    // Not deleting is what feeds the redrive policy; the visibility change only schedules the next try.
    await opts.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: opts.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: result.delayS,
      }),
    );
  }

  async function processMessage(message: Message) {
    let body: unknown;
    try {
      body = JSON.parse(message.Body ?? '');
    } catch {
      body = undefined;
    }
    const parsed = orderPlacedMessageSchema.safeParse(body);
    if (!parsed.success) {
      // A poison message would otherwise cycle until the DLQ, and the DLQ handler cannot settle it either.
      opts.logger.error({ consumer: opts.name, messageId: message.MessageId }, 'malformed message discarded');
      await settle(message, { action: 'ack', reason: 'malformed' });
      return;
    }
    const { orderId, correlationId, trace } = parsed.data;
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);

    await runInContext(extractTraceContext(trace), () =>
      runWithContext({ correlationId: correlationId ?? orderId, orderId }, async () => {
        try {
          const result = await opts.handle(orderId);
          opts.logger.debug({ consumer: opts.name, receiveCount, result }, 'message handled');
          await settle(message, result);
        } catch (err) {
          // Infrastructure failure (DB down, etc.): leave the message; it reappears after the visibility timeout.
          opts.logger.error({ consumer: opts.name, err, receiveCount }, 'message handling failed');
        }
      }),
    );
  }

  return {
    async pollOnce() {
      const out = await opts.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: opts.queueUrl,
          MaxNumberOfMessages: Math.min(10, opts.concurrency),
          WaitTimeSeconds: opts.waitTimeS ?? 20,
          MessageAttributeNames: ['All'],
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }),
      );
      const messages = out.Messages ?? [];
      await Promise.all(messages.map((m) => processMessage(m)));
      return messages.length;
    },
  };
}
