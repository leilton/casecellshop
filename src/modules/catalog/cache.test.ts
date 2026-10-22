import { describe, expect, it, type Mock, vi } from 'vitest';
import { connectionRefused, fakeClock, MemoryCacheStore, silentLogger } from '../../../tests/support/fakes';
import { counterValue } from '../../../tests/support/metrics';
import { cacheRequests } from '../../shared/metrics';
import { type CachedLoaderOptions, createCachedLoader } from './cache';

let seq = 0;

function setup(
  overrides: Partial<Omit<CachedLoaderOptions<number>, 'load'>> & { load?: Mock<() => Promise<number>> } = {},
) {
  const clock = fakeClock();
  const store = new MemoryCacheStore(clock.now);
  seq += 1;
  const name = `test-${seq}`;
  let value = 0;
  const load =
    overrides.load ??
    vi.fn(async () => {
      value += 1;
      return value;
    });
  const loader = createCachedLoader<number>({
    name,
    key: `k:${name}`,
    store,
    load,
    freshTtlS: 10,
    staleTtlS: 30,
    lockTtlMs: 1000,
    lockWaitMs: 200,
    logger: silentLogger,
    now: clock.now,
    sleep: async (ms) => clock.advance(ms),
    ...overrides,
  });
  return { clock, store, load, loader, name };
}

describe('createCachedLoader', () => {
  it('loads on a miss and serves hits until the fresh TTL expires', async () => {
    const { loader, load, clock } = setup();

    expect(await loader.get()).toMatchObject({ value: 1, result: 'miss' });
    clock.advance(9_000);
    expect(await loader.get()).toMatchObject({ value: 1, result: 'hit', ageS: 9 });
    expect(load).toHaveBeenCalledTimes(1);

    clock.advance(1_001);
    expect(await loader.get()).toMatchObject({ value: 2, result: 'miss' });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent misses into a single source call (single-flight)', async () => {
    const { loader, load, name } = setup({ load: vi.fn(async () => 42) });

    const results = await Promise.all(Array.from({ length: 50 }, () => loader.get()));

    expect(load).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.value === 42)).toBe(true);
    // Each caller is one lookup for the metrics, even though only one refresh ran.
    expect(await counterValue(cacheRequests, { cache: name, result: 'miss' })).toBe(50);
  });

  it('shares one failure among concurrent callers and releases the lock afterwards', async () => {
    const failing = vi.fn(async () => {
      throw new Error('ERP down');
    });
    const { loader, store, name } = setup({ load: failing });

    const results = await Promise.allSettled(Array.from({ length: 10 }, () => loader.get()));

    expect(failing).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(store.data.has(`k:${name}:lock`)).toBe(false);
  });

  it('serves the previous value as stale when the source fails (stale-if-error)', async () => {
    const { loader, clock, load, name } = setup();
    await loader.get();
    load.mockRejectedValueOnce(new Error('ERP down'));
    clock.advance(15_000);

    expect(await loader.get()).toMatchObject({ value: 1, result: 'stale', ageS: 15 });
    expect(await counterValue(cacheRequests, { cache: name, result: 'stale' })).toBe(1);
  });

  it('stops serving stale once the stale window is over and surfaces the error', async () => {
    const { loader, clock, load } = setup();
    await loader.get();
    load.mockRejectedValue(new Error('ERP down'));
    clock.advance(41_000); // fresh 10s + stale 30s

    await expect(loader.get()).rejects.toThrow('ERP down');
  });

  it('serves the soft-expired value while another instance holds the refresh lock', async () => {
    const { loader, clock, store, load, name } = setup();
    await loader.get();
    clock.advance(11_000);
    await store.acquireLock(`k:${name}:lock`, 5_000);

    expect(await loader.get()).toMatchObject({ value: 1, result: 'hit' });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('waits for another instance to fill an empty cache instead of stampeding the source', async () => {
    const { loader, store, load, name, clock } = setup({ lockWaitMs: 500 });
    await store.acquireLock(`k:${name}:lock`, 5_000);
    const pending = loader.get();
    // The other instance finishes its refresh while we poll.
    await store.set(
      `k:${name}`,
      JSON.stringify({ value: 7, loadedAt: clock.now(), freshUntil: clock.now() + 10_000 }),
      40_000,
    );

    expect(await pending).toMatchObject({ value: 7, result: 'hit' });
    expect(load).not.toHaveBeenCalled();
  });

  it('loads by itself if the lock holder never fills the cache', async () => {
    const { loader, store, load, name } = setup({ lockWaitMs: 200 });
    await store.acquireLock(`k:${name}:lock`, 60_000);

    expect(await loader.get()).toMatchObject({ value: 1, result: 'miss' });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('bypasses the cache when the store is unreachable (Redis down degrades, does not fail)', async () => {
    const { loader, store, load } = setup();
    store.failWith = connectionRefused();

    expect(await loader.get()).toMatchObject({ value: 1, result: 'miss' });
    expect(await loader.get()).toMatchObject({ value: 2, result: 'miss' });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('treats a Redis client that is still connecting as unavailable, not as a bug', async () => {
    const { loader, store } = setup();
    store.failWith = new Error("Stream isn't writeable and enableOfflineQueue options is false");

    expect(await loader.get()).toMatchObject({ value: 1, result: 'miss' });
  });

  it('propagates unexpected store errors instead of hiding bugs', async () => {
    const { loader, store } = setup();
    store.failWith = new TypeError('bad reply');

    await expect(loader.get()).rejects.toThrow('bad reply');
  });

  it('ignores a corrupt cache entry and reloads', async () => {
    const { loader, store, name, load } = setup();
    await store.set(`k:${name}`, '{not json', 10_000);

    expect(await loader.get()).toMatchObject({ value: 1, result: 'miss' });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('invalidate() forces the next read to go to the source', async () => {
    const { loader, load } = setup();
    await loader.get();
    await loader.invalidate();

    expect(await loader.get()).toMatchObject({ value: 2, result: 'miss' });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
