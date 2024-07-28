import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';

export function chunkedReadable(
  data: Buffer | string,
  chunkSize: number,
): Readable {
  const buffer = Buffer.from(data);
  const chunks = [];
  for (let i = 0; i < buffer.length; i += chunkSize) {
    chunks.push(buffer.slice(i, i + chunkSize));
  }
  return Readable.from(chunks);
}
