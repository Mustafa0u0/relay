import { behind, merge, observe, seen, type OpId, type Version } from './version.js';

/**
 * One operation, as far as the server is concerned.
 *
 * The `body` is opaque and stays that way. This server relays operations for
 * conflict-free replicated data types without knowing whether it is moving
 * text edits, a spreadsheet, or a drawing — the type is the client's business,
 * and a server that understood it would need redeploying every time the client
 * learned a new one.
 */
export interface Entry {
  readonly id: OpId;
  readonly body: unknown;
}

/**
 * A room's operations, in the order they were accepted.
 *
 * Append-only. Nothing is ever rewritten, because a client that has already
 * been told about an operation cannot be told it never happened.
 */
export class Log {
  private readonly entries: Entry[] = [];
  private _version: Version = {};

  get version(): Version {
    return this._version;
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * Records an operation, or ignores it as a duplicate.
   *
   * Returns true only when this was new — the caller uses that to decide
   * whether to broadcast, so a message delivered twice does not reach every
   * other client twice.
   */
  append(entry: Entry): boolean {
    if (seen(this._version, entry.id)) return false;

    // An author's operations have to be recorded in the order that author made
    // them, or the version map stops being a truthful summary: "seen agent A
    // up to 41" is only complete if there are no holes below 41.
    const expected = (this._version[entry.id.agent] ?? -1) + 1;
    if (entry.id.seq !== expected) return false;

    this.entries.push(entry);
    this._version = observe(this._version, entry.id);
    return true;
  }

  /**
   * Everything the holder of `theirs` has not seen, oldest first.
   *
   * Worked out from the two version maps alone. A client that has been away
   * for a week and a client that has never connected are the same question
   * with a different answer, and neither has to enumerate what it holds.
   */
  since(theirs: Version): Entry[] {
    const gaps = behind(theirs, this._version);
    if (Object.keys(gaps).length === 0) return [];

    return this.entries.filter((entry) => {
      const from = gaps[entry.id.agent];
      return from !== undefined && entry.id.seq >= from;
    });
  }

  /** For persistence: the whole log, to be written and read back. */
  snapshot(): Entry[] {
    return [...this.entries];
  }

  static restore(entries: Entry[]): Log {
    const log = new Log();
    for (const entry of entries) {
      // Rebuilt through append rather than assigned, so a corrupted or
      // reordered file cannot produce a log the server would never have
      // accepted while running.
      log.append(entry);
    }
    return log;
  }

  /** Only used when a client reports a version ahead of the server's. */
  observeAll(theirs: Version): void {
    this._version = merge(this._version, theirs);
  }
}
