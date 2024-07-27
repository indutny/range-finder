import assert from 'node:assert';
import { type Readable } from 'node:stream';

// TODO: Switch to node:stream once
// https://github.com/nodejs/node/commit/50695e5d gets into Electron.
import { Transform } from 'readable-stream';

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
  prepend: ReadonlyArray<Buffer>;
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
}

/**
 * RangeFinder is the main API workhorse of the module. It manages the `storage`
 * object and is responsible for tracking the number of bytes read and written
 * from the source stream so that it could be reused for other requests.
 */
export class RangeFinder<Context = void> {
  constructor(private readonly storage: Storage<Context>) {}

  /**
   * Create a new stream or take a cached stream from the storage and skip
   * bytes up to `startOffset`
   *
   * @param startOffset - Starting offset into the stream. All previous bytes
   *                      will be skipped from the returned wrapper.
   * @param context - A reference that will be passed down to all `storage`
   *                  methods.
   * @returns The wrapped readable stream that should be consumed or destroyed.
   */
  public get(startOffset: number, context: Context): Readable {
    const entry = this.storage.take(startOffset, context);
    let transform: SkipTransform;
    let stream: Readable;
    let offset: number;

    if (entry) {
      entry.unmanage();

      offset = entry.offset;
      assert(startOffset >= offset, 'Invalid entry');

      stream = entry.stream;

      for (const buf of entry.prepend) {
        offset += buf.byteLength;
      }

      transform = new SkipTransform(startOffset - offset);
      for (const buf of entry.prepend) {
        transform.write(buf);
      }
    } else {
      offset = 0;
      transform = new SkipTransform(startOffset);
      stream = this.storage.createStream(context);
    }

    const onData = (chunk: string): void => {
      offset += Buffer.byteLength(chunk);
    };
    const onError = (err: Error): void => {
      transform.destroy(err);
    };

    stream.pipe(transform);
    stream.on('data', onData);
    stream.once('error', onError);

    // Listen for a same tick destroy to unpipe the stream before further data
    // will come through and be dropped because of the destroyed destination.
    transform.once('destroy', () => {
      stream.removeListener('data', onData);
      stream.removeListener('error', onError);
      stream.unpipe(transform);

      // Fully consumed
      if (stream.readableEnded) {
        return;
      }

      // If transform still has buffered data - unshift it back onto the stream.
      const prepend = [];

      while (transform.readableLength) {
        const chunk = transform.read();

        // Failed to extract the readable buffer, but the `offset` is still
        // accurate.
        if (!chunk) {
          break;
        }

        prepend.push(chunk);
        offset -= chunk.byteLength;
      }

      const unmanage = () => {
        stream.removeListener('error', onManagedClose);
        stream.removeListener('close', onManagedClose);
      };

      const newEntry = {
        stream,
        offset,
        prepend,
        unmanage,
      };

      const onManagedClose = () => {
        unmanage();
        this.storage.remove(newEntry, context);
      };

      stream.on('error', onManagedClose);
      stream.on('close', onManagedClose);

      this.storage.put(newEntry, context);
    });

    return transform;
  }
}

export default RangeFinder;

export type DefaultStorageOptions = Readonly<{
  /**
   * Maximum number of stored streams. When this number is reached - the oldest
   * stream from the oldest accessed `Context` gets removed.
   */
  maxSize: number;

  /**
   * If present and non-zero - a TTL timeout in milliseconds for stored streams.
   */
  ttl?: number;
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
 * @see {@link RagneFinder} for details.
 */
export class DefaultStorage<Context = void> implements Storage<Context> {
  private readonly cache = new Map<Context, Array<StorageEntry>>();
  private readonly recentContexts = new Set<Context>();
  private readonly ttlTimerMap = new WeakMap<StorageEntry, NodeJS.Timeout>();
  private size = 0;

  /**
   * Create a new storage.
   *
   * @param createStream - a factory function for creating new streams. Note
   *                       that the stream is fully managed while stored.
   * @param options - configuration options.
   */
  constructor(
    public readonly createStream: (context: Context) => Readable,
    private readonly options: DefaultStorageOptions,
  ) {}

  public take(startOffset: number, context: Context): StorageEntry | undefined {
    const list = this.cache.get(context);
    if (!list) {
      return undefined;
    }

    let bestOffset = 0;
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
      this.cache.delete(context);
    }

    this.clearTTLTimer(entry);

    this.size -= 1;
    return entry;
  }

  public put(entry: StorageEntry, context: Context): void {
    const list = this.cache.get(context);

    // Move the context down the list
    this.recentContexts.delete(context);
    this.recentContexts.add(context);

    if (list) {
      list.push(entry);
    } else {
      this.cache.set(context, [entry]);
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
    const list = this.cache.get(context);
    if (!list) {
      return;
    }

    const index = list.indexOf(entry);
    if (index === -1) {
      return;
    }
    list.splice(index, 1);

    this.clearTTLTimer(entry);
    this.ttlTimerMap.delete(entry);
  }

  private cleanup(): void {
    const oldestContext = this.recentContexts.values().next();
    assert(!oldestContext.done);
    const list = this.cache.get(oldestContext.value);
    assert(list);
    const entry = list.shift();
    assert(entry);
    this.size -= 1;

    entry.stream.destroy();
    this.clearTTLTimer(entry);
  }

  private clearTTLTimer(entry: StorageEntry): void {
    const timer = this.ttlTimerMap.get(entry);
    if (timer === undefined) {
      return;
    }
    clearTimeout(timer);
  }
}

/**
 * @internal
 */
class SkipTransform extends Transform {
  constructor(private skip: number) {
    super({
      readableHighWaterMark: 0,
      // We can't extract data from the write buffer so try to minimize chances
      // of anything being put there.
      writableHighWaterMark: 0,
    });
  }

  public override _transform(
    data: Buffer,
    _enc: unknown,
    callback: () => void,
  ) {
    const chunk = data.subarray(this.skip);
    this.skip = Math.max(0, this.skip - data.byteLength);
    if (chunk.byteLength) {
      this.push(chunk);
    }
    callback();
  }

  public override _destroy(
    err: Error | null,
    callback: (error: Error | null) => void,
  ) {
    this.emit('destroy');
    return super._destroy(err, callback);
  }
}
