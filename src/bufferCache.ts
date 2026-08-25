export const DEFAULT_AVATAR_BUFFER_CACHE_MAX_BYTES = 32 * 1024 * 1024;

export type AvatarBufferCacheStats = {
  entries: number;
  pendingEntries: number;
  successfulEntries: number;
  successfulBytes: number;
  maxBytes: number;
};

type CacheEntry = {
  promise: Promise<ArrayBuffer>;
  buffer: ArrayBuffer | null;
};

/**
 * Concurrent-request cache with an LRU byte budget for successful buffers.
 * Pending entries are shared but never counted or evicted midway through a
 * request; rejected entries are removed immediately.
 */
export class AvatarBufferCache {
  readonly maxBytes: number;
  private readonly entries = new Map<string, CacheEntry>();
  private successfulBytes = 0;

  constructor(maxBytes = DEFAULT_AVATAR_BUFFER_CACHE_MAX_BYTES) {
    this.maxBytes =
      Number.isFinite(maxBytes) && maxBytes >= 0
        ? Math.floor(maxBytes)
        : DEFAULT_AVATAR_BUFFER_CACHE_MAX_BYTES;
  }

  get(
    key: string,
    load: () => ArrayBuffer | Promise<ArrayBuffer>
  ): Promise<ArrayBuffer> {
    const existing = this.entries.get(key);
    if (existing) {
      this.touch(key, existing);
      return existing.promise;
    }

    let entry: CacheEntry;
    const promise = Promise.resolve()
      .then(load)
      .then(
        (buffer) => {
          if (this.entries.get(key) !== entry) return buffer;
          entry.buffer = buffer;
          this.successfulBytes += buffer.byteLength;
          this.touch(key, entry);
          this.evictToBudget();
          return buffer;
        },
        (error: unknown) => {
          if (this.entries.get(key) === entry) this.entries.delete(key);
          throw error;
        }
      );
    entry = { buffer: null, promise };
    this.entries.set(key, entry);
    return promise;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  clear(): void {
    this.entries.clear();
    this.successfulBytes = 0;
  }

  stats(): AvatarBufferCacheStats {
    let pendingEntries = 0;
    for (const entry of this.entries.values()) {
      if (entry.buffer === null) pendingEntries += 1;
    }
    return {
      entries: this.entries.size,
      pendingEntries,
      successfulEntries: this.entries.size - pendingEntries,
      successfulBytes: this.successfulBytes,
      maxBytes: this.maxBytes,
    };
  }

  private touch(key: string, entry: CacheEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private evictToBudget(): void {
    if (this.successfulBytes <= this.maxBytes) return;
    for (const [key, entry] of this.entries) {
      if (entry.buffer === null) continue;
      this.entries.delete(key);
      this.successfulBytes -= entry.buffer.byteLength;
      if (this.successfulBytes <= this.maxBytes) break;
    }
  }
}
