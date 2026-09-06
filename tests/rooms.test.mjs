/**
 * Who hears what. Tested without a socket, because everything interesting
 * here is about membership rather than transport.
 *
 * Run with: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Rooms } from '../dist/rooms.js';

/** A client that records what it was sent. */
function client() {
  const received = [];
  return {
    received,
    send: (payload) => received.push(JSON.parse(payload)),
    last: () => received[received.length - 1],
    ofType: (type) => received.filter((m) => m.type === type),
  };
}

const op = (agent, seq, body = null) => ({ id: { agent, seq }, body });

test('a joiner is welcomed with what it missed', () => {
  const rooms = new Rooms();
  const alice = client();
  const bob = client();

  rooms.join(alice, 'doc', {});
  rooms.push(alice, [op('alice', 0, 'x'), op('alice', 1, 'y')]);

  rooms.join(bob, 'doc', {});

  assert.equal(bob.last().type, 'welcome');
  assert.equal(bob.last().ops.length, 2);
  assert.deepEqual(bob.last().version, { alice: 1 });
});

test('an operation reaches the others and not its author', () => {
  // The author already applied it locally the moment it was made, which is
  // what makes typing feel immediate. Echoing it back would apply it twice.
  const rooms = new Rooms();
  const alice = client();
  const bob = client();

  rooms.join(alice, 'doc', {});
  rooms.join(bob, 'doc', {});
  rooms.push(alice, [op('alice', 0)]);

  assert.equal(bob.ofType('ops').length, 1);
  assert.equal(alice.ofType('ops').length, 0, 'the author was echoed to');
});

test('rooms do not leak into one another', () => {
  const rooms = new Rooms();
  const here = client();
  const elsewhere = client();

  rooms.join(here, 'one', {});
  rooms.join(elsewhere, 'two', {});
  rooms.push(here, [op('a', 0)]);

  assert.equal(elsewhere.ofType('ops').length, 0);
  assert.equal(rooms.roomCount, 2);
});

test('a duplicate push is not rebroadcast', () => {
  // A client retrying after a dropped connection would otherwise send every
  // other client a second copy of operations they have already applied.
  const rooms = new Rooms();
  const alice = client();
  const bob = client();

  rooms.join(alice, 'doc', {});
  rooms.join(bob, 'doc', {});

  rooms.push(alice, [op('alice', 0)]);
  rooms.push(alice, [op('alice', 0)]);

  assert.equal(bob.ofType('ops').length, 1);
});

test('pushing before joining is refused rather than dropped silently', () => {
  const rooms = new Rooms();
  const stray = client();

  rooms.push(stray, [op('a', 0)]);

  assert.equal(stray.last().type, 'error');
  assert.match(stray.last().reason, /before join/);
});

test('joining a second room moves a client rather than doubling it', () => {
  const rooms = new Rooms();
  const wanderer = client();
  const stayer = client();

  rooms.join(stayer, 'one', {});
  rooms.join(wanderer, 'one', {});
  rooms.join(wanderer, 'two', {});

  rooms.push(stayer, [op('s', 0)]);

  assert.equal(wanderer.ofType('ops').length, 0, 'still hearing the old room');
  assert.equal(rooms.memberCount('one'), 1);
  assert.equal(rooms.memberCount('two'), 1);
});

test('leaving stops the broadcasts', () => {
  const rooms = new Rooms();
  const alice = client();
  const bob = client();

  rooms.join(alice, 'doc', {});
  rooms.join(bob, 'doc', {});
  rooms.leave(bob);
  rooms.push(alice, [op('alice', 0)]);

  assert.equal(bob.ofType('ops').length, 0);
  assert.equal(rooms.memberCount('doc'), 1);
});

test('a client that throws on send does not stop the room', () => {
  // One socket going away mid-broadcast must not deprive everybody else.
  const rooms = new Rooms();
  const alice = client();
  const broken = { send: () => { throw new Error('gone'); } };
  const bob = client();

  rooms.join(alice, 'doc', {});
  rooms.join(broken, 'doc', {});
  rooms.join(bob, 'doc', {});

  rooms.push(alice, [op('alice', 0)]);

  assert.equal(bob.ofType('ops').length, 1);
});

test('a room is only told about operations it accepted', () => {
  const rooms = new Rooms();
  const alice = client();
  const bob = client();

  rooms.join(alice, 'doc', {});
  rooms.join(bob, 'doc', {});

  // seq 1 arrives without seq 0, so it is not acceptable yet.
  rooms.push(alice, [op('alice', 1)]);
  assert.equal(bob.ofType('ops').length, 0);

  rooms.push(alice, [op('alice', 0), op('alice', 1)]);
  assert.deepEqual(
    bob.ofType('ops')[0].ops.map((e) => e.id.seq),
    [0, 1],
  );
});
