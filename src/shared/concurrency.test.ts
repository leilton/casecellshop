import { describe, expect, it } from 'vitest';
import { createConcurrencyLimiter } from './concurrency';
import { AppError } from './errors';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('createConcurrencyLimiter', () => {
  it('never runs more than max at once and queues the rest', async () => {
    const limiter = createConcurrencyLimiter({ max: 2, maxQueue: 10, queueTimeoutMs: 1000 });
    const gate = deferred();
    let running = 0;
    let peak = 0;
    const jobs = Array.from({ length: 6 }, () =>
      limiter.run(async () => {
        running++;
        peak = Math.max(peak, running);
        await gate.promise;
        running--;
      }),
    );
    await tick();
    expect(limiter.inflight).toBe(2);
    expect(limiter.waiting).toBe(4);
    gate.resolve();
    await Promise.all(jobs);
    expect(peak).toBe(2);
    expect(limiter.inflight).toBe(0);
    expect(limiter.waiting).toBe(0);
  });

  it('grants slots in arrival order', async () => {
    const limiter = createConcurrencyLimiter({ max: 1, maxQueue: 10, queueTimeoutMs: 1000 });
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        limiter.run(async () => {
          order.push(n);
          await tick();
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('sheds immediately with OVERLOADED and a retry hint when the queue is full', async () => {
    const limiter = createConcurrencyLimiter({ max: 1, maxQueue: 1, queueTimeoutMs: 2500 });
    const gate = deferred();
    const first = limiter.run(() => gate.promise);
    const second = limiter.run(() => gate.promise);
    const third = limiter.run(() => gate.promise);

    await expect(third).rejects.toMatchObject({
      code: 'OVERLOADED',
      httpStatus: 503,
      details: { retryAfterS: 3 },
    });
    gate.resolve();
    await Promise.all([first, second]);
  });

  it('sheds a waiter whose place in the queue times out, without disturbing the others', async () => {
    const limiter = createConcurrencyLimiter({ max: 1, maxQueue: 5, queueTimeoutMs: 20 });
    const gate = deferred();
    const first = limiter.run(() => gate.promise);
    const waiting = limiter.run(async () => 'never');

    await expect(waiting).rejects.toBeInstanceOf(AppError);
    expect(limiter.waiting).toBe(0);
    gate.resolve();
    await first;
    expect(limiter.inflight).toBe(0);
    await expect(limiter.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('releases the slot when the job throws', async () => {
    const limiter = createConcurrencyLimiter({ max: 1, maxQueue: 0, queueTimeoutMs: 1000 });
    await expect(limiter.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(limiter.inflight).toBe(0);
    await expect(limiter.run(async () => 42)).resolves.toBe(42);
  });

  it('reports inflight and waiting to the observer', async () => {
    const states: Array<{ inflight: number; waiting: number }> = [];
    const limiter = createConcurrencyLimiter(
      { max: 1, maxQueue: 1, queueTimeoutMs: 1000 },
      { onChange: (s) => states.push(s) },
    );
    await Promise.all([limiter.run(tick), limiter.run(tick)]);
    expect(states).toEqual([
      { inflight: 1, waiting: 0 },
      { inflight: 1, waiting: 1 },
      { inflight: 1, waiting: 0 },
      { inflight: 0, waiting: 0 },
    ]);
  });
});
