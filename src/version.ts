/**
 * How much of each author's history a replica holds.
 *
 * The value is the highest sequence number seen, and because an author's
 * operations are numbered without gaps, that one number stands in for the
 * whole run. Two parties work out exactly what to send each other by swapping
 * these maps — no listing of what is already held, and no per-operation
 * acknowledgement.
 */
export type Version = Record<string, number>;

/** An operation's identity. The server reads only this much of it. */
export interface OpId {
  readonly agent: string;
  readonly seq: number;
}

export const seen = (version: Version, id: OpId): boolean =>
  (version[id.agent] ?? -1) >= id.seq;

/**
 * Moves a version forward. Never backwards: an operation arriving late must
 * not undo the record that a later one was already received.
 */
export function observe(version: Version, id: OpId): Version {
  const current = version[id.agent] ?? -1;
  return id.seq > current ? { ...version, [id.agent]: id.seq } : version;
}

/**
 * What `local` lacks that `remote` has, per author, as the first sequence
 * number needed.
 *
 * The argument order is the entire meaning of this function. Reversed, a sync
 * runs, reports success and sends nothing.
 */
export function behind(local: Version, remote: Version): Record<string, number> {
  const gaps: Record<string, number> = {};

  for (const [agent, theirs] of Object.entries(remote)) {
    const ours = local[agent] ?? -1;
    if (theirs > ours) gaps[agent] = ours + 1;
  }

  return gaps;
}

export const merge = (a: Version, b: Version): Version => {
  const out: Version = { ...a };
  for (const [agent, seq] of Object.entries(b)) {
    if ((out[agent] ?? -1) < seq) out[agent] = seq;
  }
  return out;
};
