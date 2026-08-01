// Bounded-concurrency map, shared by every engine that fans work out.
//
// Why not `Promise.all` over fixed-size batches: a batch cannot start its
// successor until its slowest member finishes, so one slow item leaves most
// slots idle for the rest of that batch. A pool refills each slot the moment
// it frees, which keeps all `limit` of them busy until the work runs out.

// Runs `worker` over `items` with at most `limit` in flight, and returns the
// results in *input* order however they finished — callers index straight back
// into their own arrays.
//
// A worker that throws rejects the whole call, and workers already in flight
// keep running to completion with their results discarded. Where one bad item
// must not cost the rest, catch inside the worker and return a result that
// says so, which is what both engines do.
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  // One runner per slot, each pulling the next index until the list is spent.
  // Never more runners than items, and never fewer than one — a limit of 0
  // would otherwise hang rather than fail.
  const width = Math.max(1, Math.min(Math.floor(limit), items.length));
  let next = 0;

  const runners = Array.from({ length: width }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}
