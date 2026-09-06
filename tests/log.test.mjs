/**
 * The bookkeeping: what a room holds, and what a joiner is owed.
 *
 * Run with: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Log } from '../dist/log.js';
import { behind, merge, observe, seen } from '../dist/version.js';

const op = (agent, seq, body = null) => ({ id: { agent, seq }, body });

test('an operation is recorded once', () => {
  const log = new Log();

  assert.equal(log.append(op('a', 0)), true);
  assert.equal(log.append(op('a', 0)), false, 'accepted a duplicate');
  assert.equal(log.size, 1);
});

test('an author\'s operations are recorded in that author\'s order', () => {
  // "Seen agent A up to 41" is only a complete statement if there are no holes
  // below 41. Accepting seq 5 before seq 4 puts one there.
  const log = new Log();

  assert.equal(log.append(op('a', 0)), true);
  assert.equal(log.append(op('a', 2)), false, 'accepted an operation out of order');
  assert.equal(log.append(op('a', 1)), true);
  assert.equal(log.append(op('a', 2)), true);
  assert.deepEqual(log.version, { a: 2 });
});

test('different authors do not block one another', () => {
  const log = new Log();

  assert.equal(log.append(op('a', 0)), true);
  assert.equal(log.append(op('b', 0)), true);
  assert.deepEqual(log.version, { a: 0, b: 0 });
});

test('a joiner is sent only what it lacks', () => {
  const log = new Log();
  for (let i = 0; i < 5; i++) log.append(op('a', i));
  log.append(op('b', 0));

  assert.equal(log.since({}).length, 6, 'a new client should get everything');
  assert.equal(log.since({ a: 4, b: 0 }).length, 0, 'a caught-up client gets nothing');
  assert.deepEqual(
    log.since({ a: 2 }).map((e) => `${e.id.agent}${e.id.seq}`),
    ['a3', 'a4', 'b0'],
  );
});

test('a client ahead of the server is not sent its own operations back', () => {
  const log = new Log();
  log.append(op('a', 0));

  assert.deepEqual(log.since({ a: 5 }), []);
});

test('a restored log holds what was saved', () => {
  const log = new Log();
  for (let i = 0; i < 3; i++) log.append(op('a', i));

  const restored = Log.restore(log.snapshot());

  assert.equal(restored.size, 3);
  assert.deepEqual(restored.version, log.version);
});

test('a corrupted file cannot produce a log the server would refuse', () => {
  // Rebuilt through append rather than assigned, so a reordered or duplicated
  // file is filtered by exactly the rules that applied when it was written.
  const restored = Log.restore([op('a', 0), op('a', 2), op('a', 1), op('a', 1)]);

  assert.equal(restored.size, 2);
  assert.deepEqual(restored.version, { a: 1 });
});

test('the server never looks inside an operation', () => {
  // The body is opaque on purpose: a server that understood the data type
  // would need redeploying every time a client learned a new one.
  const log = new Log();
  const body = { anything: ['at', 'all'], nested: { deeply: true } };

  log.append({ id: { agent: 'a', seq: 0 }, body });
  assert.deepEqual(log.since({})[0].body, body);
});

test('version arithmetic', () => {
  assert.equal(seen({ a: 3 }, { agent: 'a', seq: 3 }), true);
  assert.equal(seen({ a: 3 }, { agent: 'a', seq: 4 }), false);
  assert.equal(seen({}, { agent: 'b', seq: 0 }), false);

  assert.deepEqual(observe({ a: 4 }, { agent: 'a', seq: 1 }), { a: 4 },
    'a late arrival moved the mark backwards');
  assert.deepEqual(observe({ a: 4 }, { agent: 'a', seq: 5 }), { a: 5 });

  assert.deepEqual(merge({ a: 1, b: 9 }, { a: 4 }), { a: 4, b: 9 });
});

test('behind answers what the first argument lacks, not the second', () => {
  // The argument order is the entire meaning. Reversed, a sync runs, reports
  // success, and sends nothing.
  assert.deepEqual(behind({ a: 1 }, { a: 3 }), { a: 2 });
  assert.deepEqual(behind({ a: 3 }, { a: 1 }), {});
});
