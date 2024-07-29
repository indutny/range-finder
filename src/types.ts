import { type Readable } from 'node:stream';

export type StorageEntry = Readonly<{
  /**
   * The managed readable stream created with `storage.createStream()`
   */
  stream: Readable;

  /**
   * Read offset at which the stream currently is (taking in account the
   * buffered data).
   */
  offset: number;

  /** @internal */
  unmanage: () => void;
}>;

/**
 * Interface for the storage required by `RangeFinder`.
 *
 * @see {@link DefaultStorage} for a default implementation.
 */
export interface Storage<Context = void> {
  /**
   * Create a new stream for a given context.
   *
   * @param context - Typically a file path, but could be an arbitrary object.
   * @returns A readable stream.
   */
  createStream(context: Context): Readable;

  /**
   * Take stored stream out of the storage (and remove it). The returned entry
   * MUST have an `entry.offset` less or equal to `startOffset`.
   *
   * Ideally, it should be as close as possible to `startOffset`.
   *
   * @param startOffset - Starting offset into the stream.
   * @param context - A context reference that was provided to `put()`.
   * @returns Stored entry or `undefined`.
   */
  take(startOffset: number, context: Context): StorageEntry | undefined;

  /**
   * Put managed stream into the storage.
   *
   * @param entry - Entry to be stored.
   * @param context - Context reference.
   */
  put(entry: StorageEntry, context: Context): void;

  /**
   * Remove managed stream from the storage. Called when managed stream gets
   * destroyed.
   *
   * @param entry - Entry to be removed.
   * @param context - A context reference that was provided to `put()`.
   */
  remove(entry: StorageEntry, context: Context): void;

  /**
   * Get a cache key from a given Context. Useful when context object is rich
   * and not unique, but a sub-property of it (e.g. `context.path`) uniquely
   * represents the cached value.
   *
   * @param context - Typically a file path, but could be an arbitrary object.
   * @returns An arbitrary string or object to be used as a key for an `Map`
   */
  getCacheKey(context: Context): unknown;
}
