import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Entry } from './log.js';

/**
 * Keeps rooms on disk so a restart does not lose a document.
 *
 * One file per room, written whole. That is the wrong shape for a million
 * operations and exactly right for a document a few people are editing — and
 * it makes a partial write impossible to observe: either the new file is
 * there or the old one is.
 */
export class RoomStore {
  constructor(private readonly directory: string) {}

  async load(room: string): Promise<Entry[]> {
    try {
      const raw = await readFile(this.pathFor(room), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as Entry[]) : [];
    } catch {
      // A room that has never been saved, or a file that will not parse. Both
      // mean the same thing to a server starting up: begin empty rather than
      // refuse to start.
      return [];
    }
  }

  async save(room: string, entries: Entry[]): Promise<void> {
    await mkdir(this.directory, { recursive: true });

    // Written to a temporary file and renamed, because rename is atomic on a
    // POSIX filesystem. Writing in place means a crash halfway leaves a file
    // that is neither the old document nor the new one.
    const temporary = `${this.pathFor(room)}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(entries), 'utf8');
    await rename(temporary, this.pathFor(room));
  }

  /**
   * A room name has to become a filename without being able to escape the
   * directory. `../../etc/passwd` is a legal string and must not be a legal
   * path.
   */
  private pathFor(room: string): string {
    const safe = Buffer.from(room, 'utf8').toString('base64url');
    return join(this.directory, `${safe}.json`);
  }
}
