import assert from 'node:assert';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';

import test from 'ava';

import RangeFinder, { DefaultStorage } from '../src/index';

const TEST_DATA = randomBytes(1024 * 1024);
const CHUNK_SIZE = 4 * 1024;

test('it passes stress test', async (t) => {
  let created = 0;
  const storage = new DefaultStorage<void>(
    () => {
      const chunks = [];
      for (let i = 0; i < TEST_DATA.byteLength; i += CHUNK_SIZE) {
        chunks.push(TEST_DATA.slice(i, i + CHUNK_SIZE));
      }
      created++;
      return Readable.from(chunks);
    },
    {
      maxSize: 100,
      ttl: 10,
    },
  );
  const r = new RangeFinder(storage);

  const RUN_COUNT = 10;
  const WORKER_COUNT = 10;
  const RANGE_COUNT = 10;

  const worker = async (i: number) => {
    if (i >= RUN_COUNT) {
      return;
    }

    // Create a sorted list of random indices into the TEST_DATA
    const indices = new Array<number>();
    for (let i = 0; i < 2 * RANGE_COUNT; i++) {
      indices.push(Math.round(TEST_DATA.length * Math.random()));
    }
    indices.sort((a, b) => a - b);

    for (let i = 0; i < indices.length; i += 2) {
      const start = indices[i];
      const end = indices[i + 1];
      assert(start !== undefined && end !== undefined);

      await new Promise((resolve) => setTimeout(resolve, 10 * Math.random()));

      const stream = r.get(start);

      let actual = Buffer.alloc(0);
      while (actual.byteLength < end - start) {
        await once(stream, 'readable');
        const chunk = stream.read();
        if (!chunk) {
          continue;
        }
        actual = Buffer.concat([actual, chunk]);
      }
      const expected = TEST_DATA.slice(start, start + actual.byteLength);
      t.is(actual.toString('hex'), expected.toString('hex'));
      stream.destroy();
    }

    return worker(i + 1);
  };

  await Promise.all(Array.from({ length: WORKER_COUNT }).map(() => worker(0)));

  // In practice it should be significantly less
  t.assert(created < RANGE_COUNT * RUN_COUNT * WORKER_COUNT);
});
