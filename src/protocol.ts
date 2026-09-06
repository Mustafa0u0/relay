import type { Entry } from './log.js';
import type { Version } from './version.js';

/**
 * What a client and the server say to each other.
 *
 * Four message types and no more. A protocol grows a fifth the moment somebody
 * wants a feature, and every one of them is a version-compatibility problem
 * for as long as an old client exists — so the bar for adding one is high.
 */
export type ClientMessage =
  /** "I am joining this room and this is what I already have." */
  | { readonly type: 'join'; readonly room: string; readonly have: Version }
  /** "Here are operations I made." */
  | { readonly type: 'push'; readonly ops: Entry[] };

export type ServerMessage =
  /** Everything the joiner was missing, and where the room now stands. */
  | { readonly type: 'welcome'; readonly ops: Entry[]; readonly version: Version }
  /** Operations from somebody else in the room. */
  | { readonly type: 'ops'; readonly ops: Entry[] }
  /** Something was wrong with what the client sent. */
  | { readonly type: 'error'; readonly reason: string };

/** The largest message the server will accept, in bytes. */
export const MAX_MESSAGE_BYTES = 256 * 1024;

/** The most operations one push may carry. */
export const MAX_OPS_PER_PUSH = 500;

/**
 * Reads a message off the wire.
 *
 * Every field is checked. This is the one place untrusted input enters the
 * server, and a malformed message has to produce a refusal rather than a
 * crash — a server that can be stopped by a single bad frame can be stopped
 * by anybody who sends one.
 */
export function parseClientMessage(raw: string): ClientMessage | { error: string } {
  if (raw.length > MAX_MESSAGE_BYTES) return { error: 'message too large' };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { error: 'not JSON' };
  }

  if (typeof value !== 'object' || value === null) return { error: 'not an object' };
  const message = value as Record<string, unknown>;

  switch (message['type']) {
    case 'join': {
      const room = message['room'];
      if (typeof room !== 'string' || room.length === 0 || room.length > 128) {
        return { error: 'bad room' };
      }
      const have = asVersion(message['have']);
      if (have === null) return { error: 'bad version' };
      return { type: 'join', room, have };
    }

    case 'push': {
      const ops = asEntries(message['ops']);
      if (ops === null) return { error: 'bad ops' };
      if (ops.length > MAX_OPS_PER_PUSH) return { error: 'too many ops' };
      return { type: 'push', ops };
    }

    default:
      return { error: 'unknown type' };
  }
}

function asVersion(value: unknown): Version | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

  const out: Version = {};
  for (const [agent, seq] of Object.entries(value)) {
    // A non-integer or negative sequence would corrupt the gap arithmetic, and
    // could make the server resend its whole log on every join.
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return null;
    if (agent.length === 0 || agent.length > 64) return null;
    out[agent] = seq;
  }
  return out;
}

function asEntries(value: unknown): Entry[] | null {
  if (!Array.isArray(value)) return null;

  const out: Entry[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const entry = item as Record<string, unknown>;

    const id = entry['id'];
    if (typeof id !== 'object' || id === null) return null;
    const { agent, seq } = id as Record<string, unknown>;

    if (typeof agent !== 'string' || agent.length === 0 || agent.length > 64) return null;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return null;

    // `body` is deliberately not inspected beyond existing. The server does not
    // know what an operation means and does not need to.
    if (!('body' in entry)) return null;

    out.push({ id: { agent, seq }, body: entry['body'] });
  }

  return out;
}
