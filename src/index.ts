import assert from 'node:assert';
import { Buffer } from 'node:buffer';
import { type Readable } from 'node:stream';

import { type StorageEntry, type Storage } from './types.d';
import SkipTransform from './skip-transform';
import { DefaultStorage, DefaultStorageOptions } from './default-storage';

export { StorageEntry, Storage, DefaultStorage, DefaultStorageOptions };

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
