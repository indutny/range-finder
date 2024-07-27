import test from 'ava';
import { Readable } from 'node:stream';
import { once } from 'node:events';

import RangeFinder, { DefaultStorage } from '../src/index';

const TEST_DATA = '0123456789abcdefghijABCDEFGHIJ';
const CHUNK_SIZE = 10;

test('it caches streams', async (t) => {
  let streamCount = 0;

  const storage = new DefaultStorage(
    () => {
      streamCount++;

      const buffer = [];
      for (let i = 0; i < TEST_DATA.length; i += CHUNK_SIZE) {
        buffer.push(TEST_DATA.slice(i, i + CHUNK_SIZE));
      }
      return Readable.from(buffer);
    },
    {
      maxSize: 100,
    },
  );
  const r = new RangeFinder(storage);

  async function getChunk(start: number, size: number): Promise<void> {
    const stream = r.get(start);

    await once(stream, 'readable');
    const chunk = stream.read(size)?.toString();
    const expected = TEST_DATA.slice(start, start + size);
    t.is(chunk, expected);

    stream.destroy();
    await once(stream, 'close');
  }

  // Read a chunk.
  await getChunk(0, CHUNK_SIZE);
  t.is(streamCount, 1);

  // Reuse the last stream, but don't read the buffered data.
  {
    const stream = r.get(CHUNK_SIZE);
    t.is(streamCount, 1);

    await once(stream, 'readable');
    stream.destroy();
    await once(stream, 'close');
  }

  // Start a bit early to force new stream creation
  await getChunk(CHUNK_SIZE - 2, 2);
  t.is(streamCount, 2);

  // Start a bit late to reuse the 2nd stream, but skip a bit of data
  await getChunk(2 * CHUNK_SIZE - 5, 5);
  t.is(streamCount, 2);

  // Pick up the 1st stream again
  await getChunk(CHUNK_SIZE, CHUNK_SIZE);
  t.is(streamCount, 2);
});
