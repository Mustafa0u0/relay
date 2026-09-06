import { createServer, type Server as HttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { WebSocketServer, type WebSocket } from 'ws';

import { MAX_MESSAGE_BYTES, parseClientMessage } from './protocol.js';
import { Rooms } from './rooms.js';
import { RoomStore } from './store.js';

export interface RelayOptions {
  readonly port?: number;
  /** Where rooms are written. Omit to keep everything in memory. */
  readonly dataDir?: string;
  /** Static files to serve alongside the socket, for the demo page. */
  readonly publicDir?: string;
  /** How long between saves, in milliseconds. */
  readonly saveEvery?: number;
}

export interface Relay {
  readonly port: number;
  readonly rooms: Rooms;
  close(): Promise<void>;
}

/**
 * Starts the relay.
 *
 * Returns once the port is actually listening, so a test can connect
 * immediately rather than guessing at a delay.
 */
export async function start(options: RelayOptions = {}): Promise<Relay> {
  const store = options.dataDir ? new RoomStore(options.dataDir) : null;
  const dirty = new Set<string>();

  const rooms = new Rooms((room) => {
    if (store) dirty.add(room);
  });

  // Per server, not per module. Held at module scope this is shared between
  // every instance in the process: a second server would believe a room was
  // already loaded and serve it empty. One server per process hides that in
  // production and it fails immediately in a test, which is the better place
  // to find out.
  const hydrated = new Set<string>();

  // Saved on a timer rather than on every operation. A document being typed
  // into produces an operation per keystroke, and writing the whole room to
  // disk that often would make the server slower the longer it stays up.
  const saving = store
    ? setInterval(() => {
        void flush(rooms, store, dirty);
      }, options.saveEvery ?? 2000)
    : null;
  saving?.unref();

  const http = createServer((request, response) => {
    void serveStatic(request.url ?? '/', options.publicDir, response);
  });

  const sockets = new WebSocketServer({ server: http, maxPayload: MAX_MESSAGE_BYTES });

  sockets.on('connection', (socket: WebSocket) => {
    socket.on('message', (raw) => {
      const message = parseClientMessage(raw.toString());

      if ('error' in message) {
        socket.send(JSON.stringify({ type: 'error', reason: message.error }));
        return;
      }

      if (message.type === 'join') {
        if (store) {
          // Loaded on first join rather than at start-up: a server with a
          // thousand saved rooms should not read a thousand files to answer
          // its first request.
          void hydrate(rooms, store, hydrated, message.room).then(() =>
            rooms.join(socket, message.room, message.have),
          );
        } else {
          rooms.join(socket, message.room, message.have);
        }
        return;
      }

      rooms.push(socket, message.ops);
    });

    socket.on('close', () => rooms.leave(socket));
    socket.on('error', () => rooms.leave(socket));
  });

  const port = await listen(http, options.port ?? 0);

  return {
    port,
    rooms,
    close: async () => {
      if (saving) clearInterval(saving);
      if (store) await flush(rooms, store, dirty);

      // Sockets first: closing the HTTP server while connections are open
      // leaves the process alive until they time out.
      for (const client of sockets.clients) client.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

async function hydrate(
  rooms: Rooms,
  store: RoomStore,
  hydrated: Set<string>,
  room: string,
): Promise<void> {
  if (hydrated.has(room)) return;
  hydrated.add(room);

  const entries = await store.load(room);
  if (entries.length > 0) rooms.restore(room, entries);
}

async function flush(rooms: Rooms, store: RoomStore, dirty: Set<string>): Promise<void> {
  for (const room of [...dirty]) {
    dirty.delete(room);
    await store.save(room, rooms.logFor(room).snapshot());
  }
}

function listen(server: HttpServer, port: number): Promise<number> {
  return new Promise((resolve) => {
    server.listen(port, () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    });
  });
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

async function serveStatic(
  url: string,
  publicDir: string | undefined,
  response: import('node:http').ServerResponse,
): Promise<void> {
  if (!publicDir) {
    response.writeHead(404).end('no static files served');
    return;
  }

  // Only the basename is used, so a request for ../../etc/passwd cannot climb
  // out of the directory being served.
  const name = url === '/' ? 'index.html' : url.split('/').pop() ?? 'index.html';
  const path = join(publicDir, name.split('?')[0] ?? 'index.html');

  try {
    const body = await readFile(path);
    response
      .writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' })
      .end(body);
  } catch {
    response.writeHead(404).end('not found');
  }
}
