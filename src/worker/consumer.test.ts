import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../../tests/support/fakes';
import type { HandleResult } from '../modules/invoicing/service';
import { currentContext } from '../shared/context';
import { createQueueConsumer } from './consumer';

const ORDER = '0f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a';

function fakeSqs(messages: Message[]) {
  const sent: unknown[] = [];
  const send = vi.fn(async (command: unknown) => {
    sent.push(command);
    if (command instanceof ReceiveMessageCommand) return { Messages: messages };
    return {};
  });
  return { send, sent };
}

function message(body: unknown, receiptHandle = 'rh-1'): Message {
  return {
    MessageId: 'm-1',
    ReceiptHandle: receiptHandle,
    Body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function setup(messages: Message[], handle: (orderId: string) => Promise<HandleResult>) {
  const sqs = fakeSqs(messages);
  const consumer = createQueueConsumer({
    name: 'test',
    sqs,
    queueUrl: 'http://sqs/queue',
    concurrency: 5,
    waitTimeS: 0,
    handle: vi.fn(handle),
    logger: silentLogger,
  });
  return { consumer, sqs };
}

describe('queue consumer', () => {
  it('deletes the message only after the handler acked it', async () => {
    const { consumer, sqs } = setup([message({ orderId: ORDER })], async () => ({ action: 'ack', reason: 'ok' }));

    expect(await consumer.pollOnce()).toBe(1);
    const del = sqs.sent.find((c) => c instanceof DeleteMessageCommand) as DeleteMessageCommand | undefined;
    expect(del?.input).toEqual({ QueueUrl: 'http://sqs/queue', ReceiptHandle: 'rh-1' });
  });

  it('keeps the message and delays its next delivery on retry', async () => {
    const { consumer, sqs } = setup([message({ orderId: ORDER })], async () => ({
      action: 'retry',
      delayS: 8,
      reason: 'erp down',
    }));

    await consumer.pollOnce();

    expect(sqs.sent.some((c) => c instanceof DeleteMessageCommand)).toBe(false);
    const change = sqs.sent.find((c) => c instanceof ChangeMessageVisibilityCommand) as
      | ChangeMessageVisibilityCommand
      | undefined;
    expect(change?.input.VisibilityTimeout).toBe(8);
  });

  it('discards a malformed (poison) message without calling the handler', async () => {
    const handle = vi.fn(async (): Promise<HandleResult> => ({ action: 'ack', reason: 'ok' }));
    const { consumer, sqs } = setup([message('{not json'), message({ orderId: 'not-a-uuid' }, 'rh-2')], handle);

    await consumer.pollOnce();

    expect(handle).not.toHaveBeenCalled();
    expect(sqs.sent.filter((c) => c instanceof DeleteMessageCommand)).toHaveLength(2);
  });

  it('leaves the message untouched when the handler throws (it reappears after the visibility timeout)', async () => {
    const { consumer, sqs } = setup([message({ orderId: ORDER })], async () => {
      throw new Error('db down');
    });

    await expect(consumer.pollOnce()).resolves.toBe(1);
    expect(sqs.sent.filter((c) => !(c instanceof ReceiveMessageCommand))).toHaveLength(0);
  });

  it('runs the handler inside the message correlation context', async () => {
    let seen: ReturnType<typeof currentContext>;
    const { consumer } = setup([message({ orderId: ORDER, correlationId: 'corr-42' })], async () => {
      seen = currentContext();
      return { action: 'ack', reason: 'ok' };
    });

    await consumer.pollOnce();

    expect(seen).toEqual({ correlationId: 'corr-42', orderId: ORDER });
  });

  it('returns 0 when the queue is empty', async () => {
    const { consumer } = setup([], async () => ({ action: 'ack', reason: 'ok' }));

    expect(await consumer.pollOnce()).toBe(0);
  });
});
