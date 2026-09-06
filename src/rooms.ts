import { Log, type Entry } from './log.js';
import type { Version } from './version.js';

/** Anything that can be sent a message. Kept abstract so the rooms can be
 *  tested without a socket. */
export interface Sink {
  send(payload: string): void;
}

interface Member {
  readonly sink: Sink;
  readonly room: string;
}

/**
 * Who is in which room, and what each room holds.
 *
 * Separated from the WebSocket layer on purpose: everything interesting here —
 * catching a joiner up, refusing a duplicate, not echoing an operation back to
 * its author — is testable without opening a port.
 */
export class Rooms {
  private readonly logs = new Map<string, Log>();
  private readonly members = new Map<Sink, Member>();

  constructor(private readonly onChange?: (room: string, log: Log) => void) {}

  get roomCount(): number {
    return this.logs.size;
  }

  memberCount(room: string): number {
    let count = 0;
    for (const member of this.members.values()) {
      if (member.room === room) count++;
    }
    return count;
  }

  logFor(room: string): Log {
    let log = this.logs.get(room);
    if (!log) {
      log = new Log();
      this.logs.set(room, log);
    }
    return log;
  }

  restore(room: string, entries: Entry[]): void {
    this.logs.set(room, Log.restore(entries));
  }

  /**
   * Puts a client in a room and tells it what it missed.
   *
   * The whole catch-up is one message. A client that has been away for a week
   * and one that has never connected are the same question with a different
   * answer, and neither needs a round trip per operation.
   */
  join(sink: Sink, room: string, have: Version): void {
    // Leaving first makes a second join on the same socket a move rather than
    // a client silently belonging to two rooms and receiving both.
    this.leave(sink);

    this.members.set(sink, { sink, room });
    const log = this.logFor(room);

    send(sink, { type: 'welcome', ops: log.since(have), version: log.version });
  }

  leave(sink: Sink): void {
    this.members.delete(sink);
  }

  /**
   * Records operations and passes them on.
   *
   * Only what was genuinely new is broadcast. A client that retries a push
   * after a dropped connection would otherwise send every other client a
   * second copy of operations they already applied.
   */
  push(sink: Sink, ops: Entry[]): void {
    const member = this.members.get(sink);
    if (!member) {
      send(sink, { type: 'error', reason: 'push before join' });
      return;
    }

    const log = this.logFor(member.room);
    const fresh = ops.filter((op) => log.append(op));
    if (fresh.length === 0) return;

    for (const other of this.members.values()) {
      // Not echoed to the author: it already applied them locally the moment
      // they were made, which is what makes the editor feel immediate.
      if (other.room !== member.room || other.sink === sink) continue;
      send(other.sink, { type: 'ops', ops: fresh });
    }

    this.onChange?.(member.room, log);
  }
}

function send(sink: Sink, message: unknown): void {
  try {
    sink.send(JSON.stringify(message));
  } catch {
    // A socket that has gone away mid-broadcast must not stop the rest of the
    // room from being told.
  }
}
