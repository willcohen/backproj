import { LRUCache } from 'lru-cache';

const MB = 1024 * 1024;
const DEFAULT_MAX_MB = 200;

export interface TileCacheOptions {
  maxBytes?: number;
}

export function createTileCache(options?: TileCacheOptions): LRUCache<string, ArrayBuffer> {
  const maxSize = options?.maxBytes ?? DEFAULT_MAX_MB * MB;
  return new LRUCache<string, ArrayBuffer>({
    maxSize,
    sizeCalculation: (value) => value.byteLength || 1,
  });
}
