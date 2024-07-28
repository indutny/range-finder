import { type Buffer } from 'node:buffer';

// TODO: Switch to node:stream once
// https://github.com/nodejs/node/commit/50695e5d gets into Electron.
import { Transform } from 'readable-stream';

/**
 * @internal
 */
export default class SkipTransform extends Transform {
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
