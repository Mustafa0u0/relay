/**
 * The server as a client meets it: a real socket, real JSON, real frames.
 *
 * Mocking the transport here would test the mock. These open ports.
 *
 * Run with: npm test
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import WebSocket from 'ws';

import { start } from '../dist/server.js';

const started = [];
const temps = [];

async function relay(options = {}) {
  const server = await start(options);
  started.push(server);
  return server;
}

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'relay-'));
  temps.push(dir);
  return dir;
}

after(async () => {
  for (const server of started) await server.close();
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

/** A connected client that collects messages and can wait for one. */
async function connect(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const received = [];
  const waiters = [];

  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    received.push(message);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(message)) waiters.splice(i, 1)[0].resolve(message);
    }
  });

  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  return {
    socket,
    received,
    send: (message) => socket.send(JSON.stringify(message)),
    /** Waits for the next message of a type, however long the round trip takes. */
    await: (type) =>
      new Promise((resolve, reject) => {
        const found = received.find((m) => m.type === type);
        if (found) return resolve(found);
        const timer = setTimeout(() => reject(new Error(`no ${type} arrived`)), 4000);
        waiters.push({
          match: (m) => m.type === type,
          resolve: (m) => { clearTimeout(timer); resolve(m); },
        });
      }),
    close: () => socket.close(),
  };
}

const op = (agent, seq, body = null) => ({ id: { agent, seq }, body });

test('two clients in a room see each other', async () => {
  const server = await relay();
  const alice = await connect(server.port);
  const bob = await connect(server.port);

  alice.send({ type: 'join', room: 'doc', have: {} });
  bob.send({ type: 'join', room: 'doc', have: {} });
  await Promise.all([alice.await('welcome'), bob.await('welcome')]);

  alice.send({ type: 'push', ops: [op('alice', 0, 'hello')] });

  const heard = await bob.await('ops');
  assert.equal(heard.ops[0].body, 'hello');

  alice.close();
  bob.close();
});

test('a client that joins late is caught up in one message', async () => {
  const server = await relay();
  const alice = await connect(server.port);

  alice.send({ type: 'join', room: 'doc', have: {} });
  await alice.await('welcome');
  alice.send({ type: 'push', ops: [op('alice', 0, 'a'), op('alice', 1, 'b')] });

  // Give the push time to land before the second client asks for the room.
  await new Promise((r) => setTimeout(r, 60));

  const bob = await connect(server.port);
  bob.send({ type: 'join', room: 'doc', have: {} });

  const welcome = await bob.await('welcome');
  assert.equal(welcome.ops.length, 2);
  assert.deepEqual(welcome.version, { alice: 1 });

  alice.close();
  bob.close();
});

test('a client that drops and returns gets only what it missed', async () => {
  const server = await relay();
  const alice = await connect(server.port);
  const bob = await connect(server.port);

  alice.send({ type: 'join', room: 'doc', have: {} });
  bob.send({ type: 'join', room: 'doc', have: {} });
  await Promise.all([alice.await('welcome'), bob.await('welcome')]);

  alice.send({ type: 'push', ops: [op('alice', 0)] });
  await bob.await('ops');

  bob.close();
  alice.send({ type: 'push', ops: [op('alice', 1), op('alice', 2)] });
  await new Promise((r) => setTimeout(r, 60));

  // Back, saying what it already had.
  const again = await connect(server.port);
  again.send({ type: 'join', room: 'doc', have: { alice: 0 } });

  const welcome = await again.await('welcome');
  assert.equal(welcome.ops.length, 2, 'sent the whole log instead of the gap');
  assert.deepEqual(welcome.ops.map((e) => e.id.seq), [1, 2]);

  alice.close();
  again.close();
});

test('a malformed frame is refused and the connection survives', async () => {
  // A server that can be stopped by one bad frame can be stopped by anybody.
  const server = await relay();
  const client = await connect(server.port);

  client.socket.send('not json at all');
  const problem = await client.await('error');
  assert.match(problem.reason, /not JSON/);

  client.send({ type: 'join', room: 'doc', have: {} });
  await client.await('welcome');

  client.close();
});

test('nonsense in the version map is refused', async () => {
  const server = await relay();
  const client = await connect(server.port);

  client.send({ type: 'join', room: 'doc', have: { alice: -1 } });
  const problem = await client.await('error');
  assert.match(problem.reason, /bad version/);

  client.close();
});

test('a room survives a restart', async () => {
  const dataDir = await tempDir();

  const first = await start({ dataDir, saveEvery: 30 });
  const alice = await connect(first.port);
  alice.send({ type: 'join', room: 'doc', have: {} });
  await alice.await('welcome');
  alice.send({ type: 'push', ops: [op('alice', 0, 'persisted')] });
  await new Promise((r) => setTimeout(r, 120));
  alice.close();
  await first.close();

  const second = await start({ dataDir });
  started.push(second);
  const bob = await connect(second.port);
  bob.send({ type: 'join', room: 'doc', have: {} });

  const welcome = await bob.await('welcome');
  assert.equal(welcome.ops.length, 1, 'the room was lost on restart');
  assert.equal(welcome.ops[0].body, 'persisted');

  bob.close();
});

test('a room name cannot escape the data directory', async () => {
  // "../../etc/passwd" is a legal string and must not be a legal path.
  const dataDir = await tempDir();
  const server = await relay({ dataDir, saveEvery: 30 });
  const client = await connect(server.port);

  client.send({ type: 'join', room: '../../escaped', have: {} });
  await client.await('welcome');
  client.send({ type: 'push', ops: [op('a', 0)] });
  await new Promise((r) => setTimeout(r, 120));

  const { readdir } = await import('node:fs/promises');
  const written = await readdir(dataDir);

  assert.equal(written.length, 1);
  assert.ok(!written[0].includes('..'), `wrote ${written[0]}`);

  client.close();
});
