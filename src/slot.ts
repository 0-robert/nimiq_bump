/**
 * The slot.
 *
 * One Durable Object is the whole game. Because a Durable Object runs single
 * threaded, two people bumping in the same second are serialised by the
 * platform: the race condition does not need guarding because it cannot happen.
 */

import { addressesMatch, normaliseAddress, nextPrice, nimToLuna, sanitiseName, CLAIM_TOKEN_BYTES, MAX_NAME_LENGTH } from './nimiq.ts';
import { findPayment, rpc } from './verify.ts';
import { screen } from './moderate.ts';

export const MAX_MESSAGE_LENGTH = 140;
const POLL_MS = 3_000;
const MAX_HISTORY = 50;
/**
 * A transaction is dead once it passes its validity window, 7200 blocks at
 * roughly a block a second. Watching stops there.
 */
const WATCH_MS = 7_200_000;
/** Stored per round; the wallet list is for the public counter, not an audit log. */
const MAX_TRACKED_WALLETS = 2_000;
/** Kept for the tape. Older entries are dropped, not archived. */
const MAX_EVENTS = 60;
/**
 * A bump inside the final two minutes pushes the close out by two minutes, so
 * the day cannot be won by arriving one second before it ends.
 */
const SNIPE_MS = 120_000;
const DAY_MS = 86_400_000;

export interface Holder {
  address: string;
  name: string;
  message: string;
  paidNim: number;
  takenAt: number;
  txHash: string;
  settled: boolean;
}

export interface ActiveClaim {
  token: string;
  createdAt: number;
  recipient: string;
  valueLuna: number;
  priceNim: number;
  message: string;
  name: string;
  bidder: string;
  expiresAt: number;
  startBlock: number;
}

export interface TapeEvent {
  at: number;
  kind: 'open' | 'take' | 'won';
  day: number;
  actor: string;
  actorName: string;
  from: string | null;
  fromName: string | null;
  amount: number;
}

export interface Winner {
  round: number;
  address: string;
  name: string;
  message: string;
  paidNim: number;
  wonAt: number;
  txHash: string;
}

interface Stored {
  /** Days are the round here: one winner a day, one entry in the hall of fame. */
  round: number;
  closesAt: number | null;
  events: TapeEvent[];
  priceNim: number;
  holder: Holder | null;
  /**
   * Every claim still worth watching, not just the one holding the lock.
   *
   * The lock lasts a minute but a transaction stays valid for two hours. If a
   * claim were dropped the moment its lock expired, someone who confirmed in
   * their wallet a second too late would have paid and got nothing back, with
   * no record left to match the payment against.
   */
  claims: ActiveClaim[];
  winners: Winner[];
  totals: { bumps: number; nimMoved: number; wallets: string[] };
}

export class Slot {
  private state: DurableObjectState;
  private env: Env;
  private clients = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private encoder = new TextEncoder();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private get floor(): number { return Number(this.env.FLOOR_NIM ?? 100); }
  private get claimMs(): number { return Number(this.env.CLAIM_SECONDS ?? 60) * 1000; }
  private get networkId(): number { return Number(this.env.NETWORK_ID ?? 24); }
  private get closeHour(): number { return Number(this.env.CLOSE_HOUR_UTC ?? 19); }

  /**
   * The next daily close, in UTC. A fixed hour rather than a timer from the
   * last bump: everyone knows when the day ends, the countdown is always
   * running, and there is one winner a day instead of one every few minutes.
   */
  private nextClose(from: number): number {
    const close = new Date(from);
    close.setUTCHours(this.closeHour, 0, 0, 0);
    return close.getTime() <= from ? close.getTime() + DAY_MS : close.getTime();
  }

  private async load(): Promise<Stored> {
    const stored = await this.state.storage.get<Partial<Stored>>('slot');
    const blank: Stored = {
      round: 1,
      priceNim: this.floor,
      closesAt: null,
      events: [],
      holder: null,
      claims: [],
      winners: [],
      totals: { bumps: 0, nimMoved: 0, wallets: [] },
    };
    if (!stored) return blank;

    /**
     * Merged against a blank rather than trusted as-is. A Durable Object keeps
     * its storage across a deploy, so state written by an earlier version of
     * this file outlives it, and a field that has since been added or renamed
     * arrives undefined and takes the whole object down on first read.
     */
    return {
      ...blank,
      ...stored,
      events: stored.events ?? [],
      claims: stored.claims ?? [],
      winners: stored.winners ?? [],
      totals: { ...blank.totals, ...(stored.totals ?? {}) },
    };
  }

  private async save(slot: Stored): Promise<void> {
    await this.state.storage.put('slot', slot);
  }

  /**
   * What the client sees. Deliberately not the stored shape: the live claim's
   * token stays server side, or anyone watching the stream could settle
   * somebody else's bump.
   */
  private view(slot: Stored) {
    const now = Date.now();
    const lock = this.lock(slot);
    return {
      round: slot.round,
      price: slot.priceNim,
      payout: nextPrice(slot.priceNim),
      holder: slot.holder && {
        address: slot.holder.address,
        name: slot.holder.name,
        message: slot.holder.message,
        paid: slot.holder.paidNim,
        takenAt: slot.holder.takenAt,
        txHash: slot.holder.txHash,
        settled: slot.holder.settled,
      },
      endsIn: slot.closesAt ? Math.max(0, slot.closesAt - now) : null,
      closesAt: slot.closesAt,
      events: slot.events.slice(0, 20),
      locked: Boolean(lock),
      lockedFor: lock ? Math.max(0, lock.expiresAt - now) : 0,
      winners: slot.winners.slice(0, 12),
      totals: {
        bumps: slot.totals.bumps,
        nimMoved: slot.totals.nimMoved,
        wallets: slot.totals.wallets.length,
      },
      floor: this.floor,
      serverTime: now,
    };
  }

  /** The claim currently holding the slot, if any. Expired claims keep being watched. */
  private lock(slot: Stored): ActiveClaim | undefined {
    const now = Date.now();
    return slot.claims.find((claim) => claim.expiresAt > now);
  }

  /** Who the next payment goes to: the current holder, or the last round's winner. */
  private payee(slot: Stored): string {
    if (slot.holder) return slot.holder.address;
    const previous = slot.winners[0];
    return previous ? previous.address : normaliseAddress(this.env.GENESIS_ADDRESS);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/api/state':  return this.json(this.view(await this.tick(await this.load())));
      case '/api/claim':  return this.claim(request);
      case '/api/cancel': return this.cancel(request);
      case '/api/stream': return this.stream();
      default:            return new Response('not found', { status: 404 });
    }
  }

  /** Issue a claim: reserve the slot for 60 seconds at a fixed price and recipient. */
  private async claim(request: Request): Promise<Response> {
    const body = await request.json<{ message?: string; address?: string; name?: string }>().catch(() => ({}));
    const message = (body.message ?? '').trim();
    const bidder = normaliseAddress(body.address ?? '');
    const name = sanitiseName(body.name ?? '');

    if (!message) return this.fail(400, 'no-message', 'Enter a message first.');
    if (message.length > MAX_MESSAGE_LENGTH) {
      return this.fail(400, 'too-long', `Messages are limited to ${MAX_MESSAGE_LENGTH} characters.`);
    }
    if ((body.name ?? '').trim() && !name) {
      return this.fail(400, 'bad-name', `Names are limited to ${MAX_NAME_LENGTH} characters and cannot be a wallet address.`);
    }
    if (!/^NQ[0-9A-Z]{34}$/.test(bidder)) return this.fail(400, 'bad-address', 'Invalid wallet address.');

    const slot = await this.tick(await this.load());
    const now = Date.now();

    if (this.lock(slot)) {
      return this.fail(409, 'locked', 'Someone else is paying right now. Try again in a few seconds.');
    }
    if (slot.holder && addressesMatch(slot.holder.address, bidder)) {
      return this.fail(409, 'already-yours', 'Your message is already up.');
    }

    // Screen before the wallet is ever opened, so a blocked message costs nobody
    // anything. The name goes through the same check: it sits in the public tape.
    const verdict = await screen(this.env, name ? `${name}: ${message}` : message);
    if (!verdict.ok) return this.fail(422, 'blocked', verdict.reason);

    const recipient = this.payee(slot);
    if (addressesMatch(recipient, bidder)) {
      return this.fail(409, 'self-pay', 'You cannot replace your own message.');
    }

    const issued: ActiveClaim = {
      token: this.token(),
      createdAt: now,
      recipient,
      valueLuna: nimToLuna(slot.priceNim),
      priceNim: slot.priceNim,
      message,
      name,
      bidder,
      expiresAt: now + this.claimMs,
      startBlock: await this.head(),
    };
    slot.claims.push(issued);

    await this.save(slot);
    await this.state.storage.setAlarm(now + POLL_MS);
    this.broadcast(slot);

    return this.json({
      token: issued.token,
      recipient: issued.recipient,
      value: issued.valueLuna,
      price: issued.priceNim,
      expiresIn: this.claimMs,
    });
  }

  /** Release the lock when someone declines at the wallet sheet, rather than making everyone wait. */
  private async cancel(request: Request): Promise<Response> {
    const body = await request.json<{ token?: string }>().catch(() => ({}));
    const slot = await this.load();
    const before = slot.claims.length;
    // Backing out at the wallet sheet means no payment was broadcast, so this
    // claim is safe to forget entirely rather than keep watching.
    slot.claims = slot.claims.filter((claim) => claim.token !== body.token);
    if (slot.claims.length !== before) {
      await this.save(slot);
      this.broadcast(slot);
    }
    return this.json({ ok: true });
  }

  /**
   * Advance anything the clock owes: expire a dead claim, close a finished round.
   * Called before every read so state is never stale, even between alarms.
   */
  private async tick(slot: Stored): Promise<Stored> {
    const now = Date.now();
    let changed = false;

    // Only claims past the transaction validity window are dropped. A claim
    // whose lock has expired is still watched, because its payment may yet land.
    const live = slot.claims.filter((claim) => now - claim.createdAt < WATCH_MS);
    if (live.length !== slot.claims.length) {
      slot.claims = live;
      changed = true;
    }
    if (slot.closesAt === null) {
      slot.closesAt = this.nextClose(now);
      changed = true;
    }
    while (slot.closesAt <= now) {
      this.closeDay(slot, slot.closesAt);
      slot.closesAt = this.nextClose(slot.closesAt);
      changed = true;
    }
    if (changed) await this.save(slot);
    return slot;
  }

  /**
   * The day ended. Whoever was holding keeps their message for good, the price
   * drops back to the floor, and tomorrow opens.
   *
   * A day with no holder still advances. Nobody wins a day nobody played.
   */
  private closeDay(slot: Stored, at: number): void {
    if (slot.holder) {
      slot.winners.unshift({
        round: slot.round,
        address: slot.holder.address,
        name: slot.holder.name,
        message: slot.holder.message,
        paidNim: slot.holder.paidNim,
        wonAt: at,
        txHash: slot.holder.txHash,
      });
      slot.winners = slot.winners.slice(0, MAX_HISTORY);
      this.record(slot, {
        at, kind: 'won', day: slot.round,
        actor: slot.holder.address, actorName: slot.holder.name,
        from: null, fromName: null, amount: slot.holder.paidNim,
      });
    }
    slot.round += 1;
    slot.priceNim = this.floor;
    slot.holder = null;
    slot.claims = [];
  }

  private record(slot: Stored, event: TapeEvent): void {
    slot.events.unshift(event);
    slot.events = slot.events.slice(0, MAX_EVENTS);
  }

  /**
   * The polling loop. Runs only while a claim is outstanding or a round is
   * running, so an idle slot costs nothing.
   */
  /**
   * The polling loop. Runs while any claim is still worth watching or a round
   * is running, so an idle slot costs nothing.
   */
  async alarm(): Promise<void> {
    const slot = await this.tick(await this.load());
    const now = Date.now();
    let changed = false;
    let pollAgain = false;

    for (const claim of [...slot.claims]) {
      // Whoever already holds the slot on this claim's transaction is settled
      // business; nothing left to watch.
      const outcome = await findPayment(this.env.RPC_URL, claim, this.networkId);

      if (outcome.status === 'rejected') {
        // Paid the wrong address, underpaid, or the transaction failed on
        // chain. Nothing about that will improve by looking again.
        slot.claims = slot.claims.filter((c) => c.token !== claim.token);
        changed = true;
        continue;
      }

      if (outcome.status === 'pending') {
        pollAgain = true;
        continue;
      }

      const settled = outcome.status === 'confirmed';
      const alreadyApplied = slot.holder?.txHash === outcome.tx.hash;

      if (!alreadyApplied) {
        this.applyBump(slot, claim, outcome.tx.hash, settled);
        changed = true;
      } else if (settled && slot.holder && !slot.holder.settled) {
        slot.holder.settled = true;
        changed = true;
      }

      if (settled) {
        slot.claims = slot.claims.filter((c) => c.token !== claim.token);
        changed = true;
      } else {
        // Included but not yet final. Keep looking until a macro block confirms it.
        pollAgain = true;
      }
    }

    if (changed) {
      await this.save(slot);
      this.broadcast(slot);
    }

    let next: number | null = pollAgain ? now + POLL_MS : null;
    if (slot.closesAt) next = next === null ? slot.closesAt : Math.min(next, slot.closesAt);
    if (next !== null) await this.state.storage.setAlarm(next);
  }

  private applyBump(slot: Stored, claim: ActiveClaim, txHash: string, settled: boolean): void {
    const previous = slot.holder;
    slot.holder = {
      address: claim.bidder,
      name: claim.name,
      message: claim.message,
      paidNim: claim.priceNim,
      takenAt: Date.now(),
      txHash,
      settled,
    };
    const now = Date.now();
    const takenFrom = claim.recipient;

    this.record(slot, {
      at: now,
      kind: previous ? 'take' : 'open',
      day: slot.round,
      actor: claim.bidder,
      actorName: claim.name,
      from: previous ? takenFrom : null,
      fromName: previous ? previous.name : null,
      amount: claim.priceNim,
    });

    // Anti-snipe. Taking it in the last two minutes buys everyone else two more.
    if (slot.closesAt !== null && slot.closesAt - now < SNIPE_MS) slot.closesAt = now + SNIPE_MS;

    slot.priceNim = nextPrice(claim.priceNim);
    slot.totals.bumps += 1;
    slot.totals.nimMoved += claim.priceNim;
    if (!slot.totals.wallets.includes(claim.bidder) && slot.totals.wallets.length < MAX_TRACKED_WALLETS) {
      slot.totals.wallets.push(claim.bidder);
    }
  }

  private async head(): Promise<number> {
    try {
      return await rpc<number>(this.env.RPC_URL, 'getBlockNumber');
    } catch {
      // Only used to record where to start looking, so a miss costs nothing.
      return 0;
    }
  }

  private token(): string {
    const bytes = new Uint8Array(CLAIM_TOKEN_BYTES);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Live updates over Server Sent Events. WebSocket is not confirmed to work
   * inside the Nimiq Pay WebView; SSE is already running in production in
   * another Mini App there. The heartbeat keeps intermediaries from closing an
   * idle stream, and the client resyncs on reconnect rather than trusting that
   * the stream survived being backgrounded.
   */
  private async stream(): Promise<Response> {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    this.clients.add(writer);

    const slot = await this.tick(await this.load());
    this.send(writer, this.view(slot));

    const heartbeat = setInterval(() => {
      writer.write(this.encoder.encode(': ping\n\n')).catch(() => {
        clearInterval(heartbeat);
        this.clients.delete(writer);
      });
    }, 25_000);

    return new Response(readable, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      },
    });
  }

  /**
   * Fire and forget on purpose. Awaiting a write blocks until the stream has a
   * reader, and the first write happens before the Response is returned, so
   * awaiting it deadlocks the connection it is trying to open.
   */
  private send(writer: WritableStreamDefaultWriter<Uint8Array>, payload: unknown): void {
    writer.write(this.encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)).catch(() => {
      this.clients.delete(writer);
    });
  }

  private broadcast(slot: Stored): void {
    const payload = this.view(slot);
    for (const writer of this.clients) this.send(writer, payload);
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }

  private fail(status: number, code: string, message: string): Response {
    return this.json({ error: code, message }, status);
  }
}
