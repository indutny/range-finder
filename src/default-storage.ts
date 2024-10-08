import assert from 'node:assert';
import { type Readable } from 'node:stream';

import { type StorageEntry, type Storage } from './types';

export type DefaultStorageOptions<Context = void> = Readonly<{
  /**
   * Maximum number of stored streams. When this number is reached - the oldest
   * stream from the oldest accessed `Context` gets removed.
   */
  maxSize: number;

  /**
   * If present and non-zero - a TTL timeout in milliseconds for stored streams.
   */
  ttl?: number;

  /**
   * Get a cache key from a given Context. Useful when context object is rich
   * and not unique, but a sub-property of it (e.g. `context.path`) uniquely
   * represents the cached value.
   *
   * @param context - Typically a file path, but could be an arbitrary object.
   * @returns An arbitrary string or object to be used as a key for an `Map`
   */
  cacheKey?(context: Context): unknown;
}>;

/**
 * A sensible (if not optimized) default storage implementation for the
 * `RangeFinder` class.
 *
 * Available features:
 *
 * - LRU-like limiting behavior.
 * - TTL for stored streams.
 *
 * @see {@link RangeFinder} for details.
 */
export class DefaultStorage<Context = void> implements Storage<Context> {
  private readonly cache = new Map<unknown, Array<StorageEntry>>();
  private readonly recentKeys = new Set<unknown>();
  private readonly ttlTimerMap = new WeakMap<StorageEntry, NodeJS.Timeout>();
  private size = 0;

  /**
   * Create a new storage.
   *
   * @param createStream - a factory function for creating new streams. Note
   *                       that the stream is fully managed while stored.
   * @param options - configuration options.
   *
   * @see {@link DefaultStorageOptions} for configuration details.
   */
  constructor(
    public readonly createStream: (context: Context) => Readable,
    private readonly options: DefaultStorageOptions<Context>,
  ) {}

  public take(startOffset: number, context: Context): StorageEntry | undefined {
    const cacheKey = this.getCacheKey(context);
    const list = this.cache.get(cacheKey);
    if (!list) {
      return undefined;
    }

    let bestOffset = -1;
    let bestIndex = -1;
    for (const [i, entry] of list.entries()) {
      // Too far in, can't be reused for this request
      if (entry.offset > startOffset) {
        continue;
      }

      // The closer we are to the `startOffset` - the less data is wasted.
      if (entry.offset <= bestOffset) {
        continue;
      }

      bestOffset = entry.offset;
      bestIndex = i;
    }

    if (bestIndex === -1) {
      return undefined;
    }

    const entry = list.at(bestIndex);
    assert(entry);

    list.splice(bestIndex, 1);
    if (list.length === 0) {
      this.removeKey(cacheKey);
    }

    this.clearTTLTimer(entry);

    this.size -= 1;
    return entry;
  }

  public put(entry: StorageEntry, context: Context): void {
    const cacheKey = this.getCacheKey(context);
    const list = this.cache.get(cacheKey);

    // Move the context down the list
    this.recentKeys.delete(cacheKey);
    this.recentKeys.add(cacheKey);

    if (list) {
      list.push(entry);
    } else {
      this.cache.set(cacheKey, [entry]);
    }

    if (this.options.ttl) {
      assert(!this.ttlTimerMap.has(entry), 'TTL timer already set');
      this.ttlTimerMap.set(
        entry,
        setTimeout(() => entry.stream.destroy(), this.options.ttl),
      );
    }

    this.size += 1;
    if (this.size <= this.options.maxSize) {
      return;
    }

    this.cleanup();
  }

  public remove(entry: StorageEntry, context: Context): void {
    const cacheKey = this.getCacheKey(context);
    const list = this.cache.get(cacheKey);
    if (list === undefined) {
      return;
    }

    const index = list.indexOf(entry);
    if (index === -1) {
      return;
    }
    list.splice(index, 1);
    if (list.length === 0) {
      this.removeKey(cacheKey);
    }

    this.clearTTLTimer(entry);
    this.size -= 1;
  }

  public getCacheKey(context: Context): unknown {
    return this.options.cacheKey ? this.options.cacheKey(context) : context;
  }

  /** @internal */
  private cleanup(): void {
    const oldestKey = this.recentKeys.values().next();
    assert(!oldestKey.done);
    const cacheKey = oldestKey.value;
    const list = this.cache.get(cacheKey);
    assert(list);
    const entry = list.shift();
    assert(entry);
    this.size -= 1;

    if (list.length === 0) {
      this.removeKey(cacheKey);
    }

    entry.stream.destroy();
    this.clearTTLTimer(entry);
  }

  /** @internal */
  private clearTTLTimer(entry: StorageEntry): void {
    const timer = this.ttlTimerMap.get(entry);
    this.ttlTimerMap.delete(entry);
    if (timer === undefined) {
      return;
    }
    clearTimeout(timer);
  }

  /** @internal */
  private removeKey(cacheKey: unknown): void {
    this.cache.delete(cacheKey);
    this.recentKeys.delete(cacheKey);
  }
}
