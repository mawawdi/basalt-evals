/**
 * Apply an async function to each item, with at most `limit` calls at the same time. The results
 * keep the order of the items. If calls fail, all calls finish first, and then the failure of the
 * first failed item rejects the result. Thus the result is the same as that of a sequential loop.
 */
export async function mapInOrder<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const outcomes: Array<{ value: R } | { error: unknown }> = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        outcomes[index] = await fn(items[index]!).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      }
    }),
  );
  const failure = outcomes.find((outcome) => "error" in outcome);
  if (failure && "error" in failure) throw failure.error;
  return outcomes.map((outcome) => (outcome as { value: R }).value);
}
