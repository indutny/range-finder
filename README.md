# @indutny/range-finder

[![npm](https://img.shields.io/npm/v/@indutny/range-finder)](https://www.npmjs.com/package/@indutny/range-finder)
![CI Status](https://github.com/indutny/range-finder/actions/workflows/test.yml/badge.svg)

[API docs](https://indutny.github.io/range-finder).

Reuse readable streams while serving range requests.

Typically range requests are made for a data directly available on the file
system. However, for the cases where the data at rest is encrypted and not
easily indexable, serving range request still requires decrypting file from the
beginning. This can become a bottleneck for situations where a video has to be
served to a browser, since for a 100MB video Chromium would typically make
hundreds of requests, turning a 100MB video into tens of gigabytes of read and
decrypted data. While this module is not a silver bullet, it can cut number of
the created streams in half in such cases.

This module is an aid for this (perhaps niche) cases. Instead of creating a
brand new stream for every request it stores and tracks previously created
streams that were no fully read, and attempts to reuse them when requesting
subsequent data.

## Installation

```sh
npm install @indutny/range-finder
```

## Usage

```js
import { RangeFinder, DefaultStorage } from '@indutny/range-finder';
import { createReadStream } from 'node:fs';

const storage = new DefaultStorage(() => createReadStream('/tmp/1.txt'), {
  maxSize: 100,
});

const finder = new RangeFinder(storage);

const startOffset = 123;
finder.get(startOffset).pipe(process.stdout);
```

## LICENSE

This software is licensed under the MIT License.
