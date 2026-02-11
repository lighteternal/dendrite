import { LRUCache } from "lru-cache";

export function createTTLCache<
  K extends NonNullable<unknown>,
  V extends NonNullable<unknown>,
>(
  ttlMs: number,
  max = 500,
): LRUCache<K, V> {
  return new LRUCache<K, V>({
    max,
    ttl: ttlMs,
    updateAgeOnGet: true,
    updateAgeOnHas: true,
  });
}
