import type { Counter, Histogram } from 'prom-client';

/** Current value of a counter for an exact label set (0 when the series does not exist yet). */
export async function counterValue<T extends string>(
  metric: Counter<T>,
  labels: Partial<Record<T, string>>,
): Promise<number> {
  const { values } = await metric.get();
  const match = values.find((v) =>
    Object.entries(labels).every(([k, val]) => (v.labels as Record<string, unknown>)[k] === val),
  );
  return match?.value ?? 0;
}

export async function histogramCount<T extends string>(
  metric: Histogram<T>,
  labels: Partial<Record<T, string>>,
): Promise<number> {
  const { values } = await metric.get();
  const match = values.find(
    (v) =>
      v.metricName?.endsWith('_count') &&
      Object.entries(labels).every(([k, val]) => (v.labels as Record<string, unknown>)[k] === val),
  );
  return match?.value ?? 0;
}
