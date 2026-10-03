/** Reads prom-client metric values of a container (tests assert on counters and gauges by label). */

interface MetricLike {
  get(): Promise<{ values: { value: number; labels: Partial<Record<string, string | number>> }[] }>;
}

/** Sum of the samples whose labels include `labels` (0 when none). */
export async function metricValue(metric: MetricLike, labels: Record<string, string> = {}): Promise<number> {
  const { values } = await metric.get();
  return values
    .filter((sample) =>
      Object.entries(labels).every(([name, value]) => String(sample.labels[name]) === value),
    )
    .reduce((sum, sample) => sum + sample.value, 0);
}
