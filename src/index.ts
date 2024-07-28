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

/** @internal */
type ActiveAndPending = Readonly<{
  active: ActiveStream;
  pending: ReadonlyArray<Buffer> | undefined;
}>;

/**
 * RangeFinder is the main API workhorse of the module. It manages the `storage`
 * object and is responsible for tracking the number of bytes read and written
 * from the source stream so that it could be reused for other requests.
 */
export class RangeFinder<Context = void> {
  private readonly activeStreams = new Set<ActiveStream>();

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
    // Get existing stream if possible
    const maybeActive = this.getActiveStream(startOffset);

    let active: ActiveStream;
    let pending: ReadonlyArray<Buffer> | undefined;
    if (maybeActive === undefined) {
      ({ active, pending } = this.getCachedOrCreate(startOffset, context));
    } else {
      active = maybeActive;
    }

    const transform = new SkipTransform(startOffset - active.offset);
    if (pending !== undefined) {
      for (const buf of pending) {
        transform.write(buf);
      }
    }

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

      this.activeStreams.delete(active);

      // Fully consumed
      if (active.stream.readableEnded) {
        return;
      }

      // If transform still has buffered data - unshift it back onto the stream.
      const readableBuffer = [];
      transform.removeAllListeners('data');
      while (transform.readableLength) {
        const chunk = transform.read();
        assert(chunk, 'Must have a chunk when readableLength != 0');

        readableBuffer.push(chunk);
        active.offset -= chunk.byteLength;
      }

      const unmanage = () => {
        active.stream.removeListener('error', onManagedClose);
        active.stream.removeListener('close', onManagedClose);
      };

      const newEntry = {
        stream: active.stream,
        offset: active.offset,
        pending: readableBuffer,
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
  ): ActiveAndPending {
    const entry = this.storage.take(startOffset, context);

    let stream: Readable;
    let offset: number;
    let pending: ReadonlyArray<Buffer> | undefined;
    if (entry !== undefined) {
      entry.unmanage();

      offset = entry.offset;
      assert(
        startOffset >= offset,
        'Storage returned entry with invalid offset',
      );

      pending = entry.pending;
      for (const buf of pending) {
        offset += buf.byteLength;
      }

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
    const onClose = () => this.activeStreams.delete(active);
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
    this.activeStreams.add(active);

    return { active, pending };
  }

  /** @internal */
  private getActiveStream(startOffset: number): ActiveStream | undefined {
    for (const active of this.activeStreams) {
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
