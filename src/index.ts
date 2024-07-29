import assert from 'node:assert';
import { Buffer } from 'node:buffer';
import { type Readable } from 'node:stream';

import { type StorageEntry, type Storage } from './types';
import SkipTransform from './skip-transform';
import { DefaultStorage, DefaultStorageOptions } from './default-storage';

export { StorageEntry, Storage, DefaultStorage, DefaultStorageOptions };

/** @internal */
type ActiveStream = {
  stream: Readable;
  offset: number;
  refCount: number;

  untrack: () => void;
};

/**
 * RangeFinder is the main API workhorse of the module. It manages the `storage`
 * object and is responsible for tracking the number of bytes read and written
 * from the source stream so that it could be reused for other requests.
 */
export class RangeFinder<Context = void> {
  private readonly activeStreams = new Map<unknown, Set<ActiveStream>>();

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
    const cacheKey = this.storage.getCacheKey(context);

    // Get existing stream if possible
    const maybeActive = this.getActiveStream(cacheKey, startOffset);

    let active: ActiveStream;
    if (maybeActive === undefined) {
      active = this.getCachedOrCreate(startOffset, context);
    } else {
      active = maybeActive;
    }

    const transform = new SkipTransform(startOffset - active.offset);

    const onError = (err: Error): void => {
      transform.destroy(err);
    };

    active.stream.pipe(transform);
    active.stream.once('error', onError);

    // Listen for a same tick destroy to unpipe the stream before further data
    // will come through and be dropped because of the destroyed destination.
    transform.once('destroy', () => {
      active.refCount--;

      // Untrack early, otherwise the data will keep flowing because of the
      // 'data' listener.
      if (active.refCount === 0) {
        active.untrack();
      }
      active.stream.removeListener('error', onError);
      active.stream.unpipe(transform);

      if (active.refCount !== 0) {
        return;
      }

      this.deleteActiveStream(cacheKey, active);

      // Fully consumed
      if (active.stream.readableEnded) {
        return;
      }

      // If transform still has buffered data - unshift it back onto the stream.
      transform.removeAllListeners('data');
      while (transform.readableLength) {
        const chunk = transform.read();
        assert(chunk, 'Must have a chunk when readableLength != 0');

        active.offset -= chunk.byteLength;
        active.stream.unshift(chunk);
      }

      const unmanage = () => {
        active.stream.removeListener('error', onManagedClose);
        active.stream.removeListener('close', onManagedClose);
      };

      const newEntry = {
        stream: active.stream,
        offset: active.offset,
        unmanage,
      };

      const onManagedClose = () => {
        unmanage();
        this.storage.remove(newEntry, context);
      };

      active.stream.on('error', onManagedClose);
      active.stream.on('close', onManagedClose);

      this.storage.put(newEntry, context);
    });

    return transform;
  }

  private getCachedOrCreate(
    startOffset: number,
    context: Context,
  ): ActiveStream {
    const cacheKey = this.storage.getCacheKey(context);
    const entry = this.storage.take(startOffset, context);

    let stream: Readable;
    let offset: number;
    if (entry !== undefined) {
      entry.unmanage();

      offset = entry.offset;
      assert(
        startOffset >= offset,
        'Storage returned entry with invalid offset',
      );

      stream = entry.stream;
    } else {
      offset = 0;
      stream = this.storage.createStream(context);
      stream.setMaxListeners(0);
    }

    // If we created the stream - track its offset
    const onData = (chunk: string | Buffer): void => {
      active.offset += Buffer.byteLength(chunk);
    };
    const onClose = () => this.deleteActiveStream(cacheKey, active);
    stream.on('data', onData);
    stream.on('close', onClose);
    stream.on('error', onClose);

    const untrack = () => {
      stream.removeListener('data', onData);
      stream.removeListener('close', onClose);
      stream.removeListener('error', onClose);
    };

    const active = {
      stream,
      offset,

      refCount: 1,
      untrack,
    };
    this.addActiveStream(cacheKey, active);

    return active;
  }

  /** @internal */
  private addActiveStream(cacheKey: unknown, stream: ActiveStream): void {
    let set = this.activeStreams.get(cacheKey);
    if (set === undefined) {
      set = new Set();
      this.activeStreams.set(cacheKey, set);
    }
    set.add(stream);
  }

  /** @internal */
  private deleteActiveStream(cacheKey: unknown, stream: ActiveStream): void {
    const set = this.activeStreams.get(cacheKey);
    if (set === undefined) {
      return;
    }
    set.delete(stream);
    if (set.size === 0) {
      this.activeStreams.delete(cacheKey);
    }
  }

  /** @internal */
  private getActiveStream(
    cacheKey: unknown,
    startOffset: number,
  ): ActiveStream | undefined {
    const set = this.activeStreams.get(cacheKey);
    if (!set) {
      return undefined;
    }

    for (const active of set) {
      if (active.offset > startOffset) {
        continue;
      }
      active.refCount++;
      return active;
    }
    return undefined;
  }
}

export default RangeFinder;
