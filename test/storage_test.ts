import test from 'ava';
import { Readable } from 'node:stream';

import { DefaultStorage } from '../src/index';

test('it does not crash on stream removal', (t) => {
  const storage = new DefaultStorage<string>(
    () => {
      return Readable.from('');
    },
    {
      maxSize: 1,
    },
  );

  const entry = {
    stream: storage.createStream('1'),
    offset: 0,
    unmanage: () => {},
  };

  storage.put(entry, '1');
  storage.remove(entry, '1');

  // Force cleanup
  storage.put(entry, '2');
  storage.remove(entry, '2');

  storage.put(entry, '1');
  storage.put(entry, '3');
  t.pass();
});
