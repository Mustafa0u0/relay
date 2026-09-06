import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { start } from './server.js';

const here = dirname(fileURLToPath(import.meta.url));

const relay = await start({
  port: Number(process.env['PORT'] ?? 8080),
  dataDir: process.env['DATA_DIR'] ?? join(here, '..', '.rooms'),
  publicDir: join(here, '..', 'public'),
});

process.stdout.write(`relay listening on http://localhost:${relay.port}\n`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  // Rooms are flushed on the way out, so stopping the server does not lose
  // whatever was typed in the last couple of seconds.
  process.on(signal, () => {
    void relay.close().then(() => process.exit(0));
  });
}
