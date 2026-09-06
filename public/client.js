/**
 * The half that understands the document.
 *
 * The server relays operations and keeps a log; everything about what an
 * operation *means* lives here. That split is the point of the project: the
 * same server would carry a spreadsheet or a drawing without a line changing.
 */

const key = (id) => `${id.agent}:${id.seq}`;
const sameId = (a, b) =>
  a === b || (a !== null && b !== null && a.agent === b.agent && a.seq === b.seq);

/** A replicated string. Deletions mark; nothing is ever removed. */
class Doc {
  constructor(agent) {
    this.agent = agent;
    this.start = null;
    this.byId = new Map();
    this.next = 0;
    this.version = {};
    this.held = new Map();

    // Everything applied, in order. Kept because a client that was offline has
    // to be able to say what the *server* is missing — not only what it is
    // missing itself.
    this.log = [];
  }

  get text() {
    let out = '';
    for (let item = this.start; item; item = item.right) {
      if (!item.deleted) out += item.value;
    }
    return out;
  }

  has(id) {
    return this.byId.has(key(id));
  }

  /** Local edit: returns the operations to send. */
  insert(at, text) {
    const made = [];
    let left = this.itemAt(at - 1);
    const right = this.itemAt(at);

    for (const ch of text) {
      const op = {
        id: { agent: this.agent, seq: this.next++ },
        body: {
          k: 'i',
          v: ch,
          l: left ? left.id : null,
          r: right ? right.id : null,
        },
      };
      this.apply(op);
      made.push(op);
      left = this.byId.get(key(op.id)) ?? left;
    }

    return made;
  }

  delete(at, count) {
    const made = [];
    for (let i = 0; i < count; i++) {
      const target = this.itemAt(at);
      if (!target) break;
      const op = {
        id: { agent: this.agent, seq: this.next++ },
        body: { k: 'd', t: target.id },
      };
      this.apply(op);
      made.push(op);
    }
    return made;
  }

  /** Applies one operation, or holds it until it can be placed. */
  apply(op) {
    if ((this.version[op.id.agent] ?? -1) >= op.id.seq) return;

    const blocker = this.blockedBy(op);
    if (blocker) {
      const bucket = this.held.get(blocker) ?? [];
      bucket.push(op);
      this.held.set(blocker, bucket);
      return;
    }

    this.commit(op);
    this.release(op.id);
  }

  applyAll(ops) {
    for (const op of ops) this.apply(op);
  }

  /** The one thing standing between this operation and being applied. */
  blockedBy(op) {
    const previous = op.id.seq - 1;
    // An author's operations are applied in that author's order, whatever
    // order they arrive in. Otherwise "seen up to 41" has holes below it and
    // a late arrival is mistaken for a duplicate.
    if ((this.version[op.id.agent] ?? -1) !== previous) {
      return `${op.id.agent}:${previous}`;
    }

    const b = op.body;
    if (b.k === 'd') return this.has(b.t) ? null : key(b.t);
    if (b.l && !this.has(b.l)) return key(b.l);
    if (b.r && !this.has(b.r)) return key(b.r);
    return null;
  }

  commit(op) {
    const b = op.body;
    if (b.k === 'i') {
      this.integrate(op.id, b.v, b.l, b.r);
    } else {
      const target = this.byId.get(key(b.t));
      if (target) target.deleted = true;
    }
    this.version = { ...this.version, [op.id.agent]: op.id.seq };
    this.log.push(op);
  }

  release(id) {
    const queue = [key(id)];
    while (queue.length) {
      const done = queue.pop();
      const woken = this.held.get(done);
      if (!woken) continue;
      this.held.delete(done);

      for (const op of woken) {
        if ((this.version[op.id.agent] ?? -1) >= op.id.seq) continue;
        const blocker = this.blockedBy(op);
        if (blocker) {
          const bucket = this.held.get(blocker) ?? [];
          bucket.push(op);
          this.held.set(blocker, bucket);
          continue;
        }
        this.commit(op);
        queue.push(key(op.id));
      }
    }
  }

  /**
   * Where a concurrently typed character belongs.
   *
   * Carrying the right-hand neighbour as well as the left is what keeps two
   * words typed at the same spot whole. Ordering character by character is
   * convergent and turns "hello" and "world" into "hwelolrold".
   */
  integrate(id, value, originLeft, originRight) {
    const leftItem = originLeft ? this.byId.get(key(originLeft)) : null;
    const rightItem = originRight ? this.byId.get(key(originRight)) : null;

    let left = leftItem ?? null;
    let scan = leftItem ? leftItem.right : this.start;

    const scanned = new Set();
    const conflicting = new Set();

    while (scan && scan !== rightItem) {
      scanned.add(scan);
      conflicting.add(scan);

      if (sameId(originLeft, scan.originLeft)) {
        if (scan.id.agent < id.agent) {
          left = scan;
          conflicting.clear();
        } else if (sameId(originRight, scan.originRight)) {
          break;
        }
      } else if (scan.originLeft) {
        const runOrigin = this.byId.get(key(scan.originLeft));
        if (runOrigin && scanned.has(runOrigin)) {
          if (!conflicting.has(runOrigin)) {
            left = scan;
            conflicting.clear();
          }
        } else break;
      } else break;

      scan = scan.right;
    }

    const item = {
      id, value, originLeft, originRight, deleted: false,
      left, right: left ? left.right : this.start,
    };

    if (item.right) item.right.left = item;
    if (left) left.right = item; else this.start = item;

    this.byId.set(key(id), item);
  }

  /**
   * Everything this replica holds that `theirs` does not.
   *
   * The mirror of what the server does on join. Without it, sync only ever
   * runs downwards: a client that edited while disconnected reconnects, is
   * told what it missed, and never mentions what it did — so the two sides
   * agree that they are in sync while holding different documents.
   */
  missingFor(theirs) {
    const gaps = {};
    for (const [agent, seq] of Object.entries(this.version)) {
      const ours = theirs[agent] ?? -1;
      if (seq > ours) gaps[agent] = ours + 1;
    }
    if (!Object.keys(gaps).length) return [];

    return this.log.filter((op) => {
      const from = gaps[op.id.agent];
      return from !== undefined && op.id.seq >= from;
    });
  }

  itemAt(visible) {
    if (visible < 0) return null;
    let seen = -1;
    for (let item = this.start; item; item = item.right) {
      if (item.deleted) continue;
      if (++seen === visible) return item;
    }
    return null;
  }

  get weight() {
    return this.byId.size;
  }
}

/** What changed in the box, narrowed to the part that actually moved. */
function change(before, after) {
  if (before === after) return null;

  let start = 0;
  const shortest = Math.min(before.length, after.length);
  while (start < shortest && before[start] === after[start]) start++;

  let end = 0;
  while (
    end < shortest - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) end++;

  return {
    at: start,
    remove: before.length - start - end,
    insert: after.slice(start, after.length - end),
  };
}

// --- wiring ----------------------------------------------------------------

const el = (id) => document.getElementById(id);
const box = el('text');

const agent = `${Math.random().toString(36).slice(2, 8)}`;
const doc = new Doc(agent);
el('me').textContent = agent;

let socket = null;
let sent = 0;
let got = 0;

/** Set while the reader has deliberately cut the wire, so a close is not
 *  mistaken for a network fault and quietly reconnected. */
let unplugged = false;

function paint() {
  const caret = box.selectionStart;
  if (box.value !== doc.text) {
    box.value = doc.text;
    box.setSelectionRange(caret, caret);
  }
  el('sent').textContent = sent;
  el('got').textContent = got;
  el('held').textContent = doc.weight;
}

function setState(on, detail) {
  el('bar').classList.toggle('on', on);
  el('state').textContent = on ? 'connected' : 'offline';
  el('detail').textContent = detail;
}

function connect() {
  unplugged = false;
  el('wire').textContent = 'Cut the wire';
  socket?.close();

  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  socket = new WebSocket(url);

  socket.addEventListener('open', () => {
    setState(true, 'edits reach the other windows');
    // Says what it already has, so the server sends the gap and not the
    // document.
    socket.send(JSON.stringify({
      type: 'join',
      room: el('room').value || 'doc',
      have: doc.version,
    }));
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'error') {
      setState(false, message.reason);
      return;
    }
    if (message.type === 'welcome' || message.type === 'ops') {
      got += message.ops.length;
      doc.applyAll(message.ops);

      // The welcome carries where the server got to, which is the only moment
      // this client can tell what the server never received — anything typed
      // while the wire was cut.
      if (message.type === 'welcome') push(doc.missingFor(message.version));

      paint();
    }
  });

  socket.addEventListener('close', () =>
    setState(false, unplugged
      ? 'keep typing — nothing is lost, it catches up on reconnect'
      : 'connection dropped'));
  socket.addEventListener('error', () => setState(false, 'connection failed'));
}

function push(ops) {
  if (!ops.length) return;
  sent += ops.length;
  // Nothing is queued if the socket is down: the operations are already in the
  // local document, and the next join tells the server where this client got
  // to, so they are sent as part of catching up rather than replayed by hand.
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'push', ops }));
  }
}

box.addEventListener('input', () => {
  const edit = change(doc.text, box.value);
  if (!edit) return;

  const ops = [];
  if (edit.remove > 0) ops.push(...doc.delete(edit.at, edit.remove));
  if (edit.insert) ops.push(...doc.insert(edit.at, edit.insert));

  push(ops);
  paint();
});

function disconnect() {
  unplugged = true;
  el('wire').textContent = 'Reconnect';
  socket?.close();
  setState(false, 'keep typing — nothing is lost, it catches up on reconnect');
}

el('wire').addEventListener('click', () =>
  (socket?.readyState === WebSocket.OPEN ? disconnect() : connect()));
el('room').addEventListener('change', connect);

connect();
paint();
