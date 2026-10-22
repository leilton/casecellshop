import { AppError } from './errors';

export interface ConcurrencyLimits {
  /** Requests allowed to run at once on this instance. */
  max: number;
  /** Requests allowed to wait for a slot; beyond that they are shed immediately. */
  maxQueue: number;
  /** How long a waiting request keeps its place before it is shed. */
  queueTimeoutMs: number;
}

export interface LimiterObserver {
  onChange?: (state: { inflight: number; waiting: number }) => void;
}

export interface ConcurrencyLimiter {
  run<T>(fn: () => Promise<T>): Promise<T>;
  readonly inflight: number;
  readonly waiting: number;
}

interface Waiter {
  grant: () => void;
  timer: NodeJS.Timeout;
}

/** Seconds a shed client should wait: long enough for the queue ahead of it to drain, never less than 1. */
function retryAfterS(queueTimeoutMs: number): number {
  return Math.max(1, Math.ceil(queueTimeoutMs / 1000));
}

function overloaded(queueTimeoutMs: number): AppError {
  return new AppError('OVERLOADED', 503, 'Checkout is at capacity, retry later with the same Idempotency-Key', {
    retryAfterS: retryAfterS(queueTimeoutMs),
  });
}

/**
 * In-process semaphore with a short FIFO wait queue (a light "virtual queue"). It caps how many checkouts compete
 * for the Postgres pool on this instance, so a spike gets fast 503s instead of every request timing out together.
 * Per instance on purpose (ADR 0009): no extra network hop on the hot path, and a crashed request cannot leak a slot.
 */
export function createConcurrencyLimiter(
  limits: ConcurrencyLimits,
  observer: LimiterObserver = {},
): ConcurrencyLimiter {
  let inflight = 0;
  const queue: Waiter[] = [];
  const notify = () => observer.onChange?.({ inflight, waiting: queue.length });

  function acquire(): Promise<void> {
    if (inflight < limits.max) {
      inflight++;
      notify();
      return Promise.resolve();
    }
    if (queue.length >= limits.maxQueue) return Promise.reject(overloaded(limits.queueTimeoutMs));
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        // The releasing request hands its slot over directly, so `inflight` never dips and nobody jumps the line.
        grant: () => {
          clearTimeout(waiter.timer);
          resolve();
        },
        timer: setTimeout(() => {
          queue.splice(queue.indexOf(waiter), 1);
          notify();
          reject(overloaded(limits.queueTimeoutMs));
        }, limits.queueTimeoutMs),
      };
      queue.push(waiter);
      notify();
    });
  }

  function release(): void {
    const next = queue.shift();
    if (next) next.grant();
    else inflight--;
    notify();
  }

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
    get inflight() {
      return inflight;
    },
    get waiting() {
      return queue.length;
    },
  };
}
