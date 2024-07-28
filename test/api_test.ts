import test from 'ava';
import { once } from 'node:events';

import RangeFinder, { DefaultStorage } from '../src/index';
import { chunkedReadable } from './_helpers';

const TEST_DATA = '0123456789abcdefghijABCDEFGHIJ';
const CHUNK_SIZE = 10;

test('it caches streams', async (t) => {
  let streamCount = 0;

  const storage = new DefaultStorage(
    () => {
      streamCount++;
      return chunkedReadable(TEST_DATA, CHUNK_SIZE);
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

test('it reuses active streams', async (t) => {
  let streamCount = 0;

  const storage = new DefaultStorage(
    () => {
      streamCount++;

      return chunkedReadable(TEST_DATA, CHUNK_SIZE);
    },
    {
      maxSize: 100,
    },
  );
  const r = new RangeFinder(storage);

  const a = r.get(0);
  const b = r.get(10);
  t.is(streamCount, 1);

  await once(a, 'readable');
  const aChunk = a.read()?.toString();
  t.is(aChunk, TEST_DATA.slice(0, CHUNK_SIZE));
  a.destroy();
  await once(a, 'close');

  await once(b, 'readable');
  const bChunk = b.read()?.toString();
  t.is(bChunk, TEST_DATA.slice(CHUNK_SIZE, 2 * CHUNK_SIZE));
  b.destroy();
  await once(b, 'close');
});

test('it handles errors', async (t) => {
  const storage = new DefaultStorage(
    () => {
      const result = chunkedReadable(TEST_DATA, CHUNK_SIZE);
      process.nextTick(() => {
        result.emit('error', new Error('aborted'));
      });
      return result;
    },
    {
      maxSize: 100,
    },
  );

  const r = new RangeFinder(storage);

  const a = r.get(0);
  await t.throwsAsync(once(a, 'data'), { message: 'aborted' });
});

test('it handles close on managed stream', async (t) => {
  const storage = new DefaultStorage(
    () => {
      const result = chunkedReadable(TEST_DATA, CHUNK_SIZE);
      process.nextTick(() => {
        result.destroy();
      });
      return result;
    },
    {
      maxSize: 100,
    },
  );

  const r = new RangeFinder(storage);

  const a = r.get(0);
  a.destroy();
  await once(a, 'close');

  t.pass();
});

test('it does not reuse active stream that is too far ahead', async (t) => {
  let streamCount = 0;

  const storage = new DefaultStorage(
    () => {
      streamCount++;
      return chunkedReadable(TEST_DATA, CHUNK_SIZE);
    },
    {
      maxSize: 100,
    },
  );
  const r = new RangeFinder(storage);

  const a = r.get(0);
  t.is(streamCount, 1);
  await once(a, 'readable');
  const aChunk = a.read()?.toString();
  t.is(aChunk, TEST_DATA.slice(0, CHUNK_SIZE));

  // This should not reuse the last stream
  r.get(0);
  t.is(streamCount, 2);
});
