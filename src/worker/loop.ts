import type { Logger } from '../shared/logger';

/**
 * Runs `fn` until `signal` aborts. `fn` returns how much work it did: when it did some, loop again at once
 * (drain a backlog); when idle or failing, wait `intervalMs` so a broken dependency is not hammered.
 */
export async function runLoop(
  name: string,
  fn: () => Promise<number | undefined>,
  opts: { intervalMs: number; signal: AbortSignal; logger: Logger },
): Promise<void> {
  while (!opts.signal.aborted) {
    let worked = 0;
    try {
      worked = (await fn()) ?? 0;
    } catch (err) {
      opts.logger.error({ loop: name, err }, 'loop iteration failed');
    }
    if (worked > 0) continue;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, opts.intervalMs);
      opts.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
