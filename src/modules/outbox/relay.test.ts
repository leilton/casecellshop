import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../../../tests/support/fakes';
import { createOutboxRelay } from './relay';
import type { OutboxRepository, OutboxRow } from './repository';

const rows: OutboxRow[] = [
  { id: '1', aggregateId: 'a', eventType: 'OrderPlaced', payload: { orderId: 'a', correlationId: 'c-a' } },
  { id: '2', aggregateId: 'b', eventType: 'OrderPlaced', payload: { orderId: 'b' } },
];

function setup(response: { Successful?: Array<{ Id: string }>; Failed?: Array<{ Id: string; Code: string }> }) {
  const marked: string[][] = [];
  const repo: OutboxRepository = {
    publishBatch: vi.fn(async (_limit, publish) => {
      const ids = await publish(rows);
      marked.push(ids);
      return ids.length;
    }),
  };
  const send = vi.fn(async (_command: unknown) => response);
  const relay = createOutboxRelay({
    repo,
    sqs: { send },
    queueUrl: 'http://sqs/q',
    batchSize: 10,
    logger: silentLogger,
  });
  return { relay, send, marked };
}

describe('outbox relay', () => {
  it('publishes the payload with correlation attributes and marks every successful row', async () => {
    const { relay, send, marked } = setup({ Successful: [{ Id: '1' }, { Id: '2' }] });

    expect(await relay.runOnce()).toBe(2);
    const command = send.mock.calls[0]?.[0] as SendMessageBatchCommand;
    expect(command).toBeInstanceOf(SendMessageBatchCommand);
    expect(command.input.Entries?.[0]).toMatchObject({
      Id: '1',
      MessageBody: JSON.stringify({ orderId: 'a', correlationId: 'c-a' }),
      MessageAttributes: { correlationId: { DataType: 'String', StringValue: 'c-a' } },
    });
    expect(command.input.Entries?.[1]?.MessageAttributes).not.toHaveProperty('correlationId');
    expect(marked).toEqual([['1', '2']]);
  });

  it('leaves rows that SQS rejected unpublished so the next run retries them', async () => {
    const { relay, marked } = setup({ Successful: [{ Id: '1' }], Failed: [{ Id: '2', Code: 'InternalError' }] });

    expect(await relay.runOnce()).toBe(1);
    expect(marked).toEqual([['1']]);
  });
});
