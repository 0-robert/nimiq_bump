/**
 * The slot.
 *
 * One Durable Object is the whole game. Because a Durable Object runs single
 * threaded, two people bumping in the same second are serialised by the
 * platform: the race condition does not need guarding because it cannot happen.
 */

import { addressesMatch, normaliseAddress, nextPrice, nimToLuna, CLAIM_TOKEN_BYTES } from './nimiq.ts';
import { findPayment, VALIDITY_WINDOW } from './verify.ts';
import { screen } from './moderate.ts';

export const MAX_MESSAGE_LENGTH = 140;
const POLL_MS = 3_000;
const MAX_HISTORY = 50;

export interface Holder {
  address: string;
  message: string;
  paidNim: number;
  takenAt: number;
  txHash: string;
  settled: boolean;
}

export interface ActiveClaim {
  token: string;
  recipient: string;
  valueLuna: number;
  priceNim: number;
  message: string;
  bidder: string;
  expiresAt: number;
  startBlock: number;
}

export interface Winner {
  round: number;
  address: string;
  message: string;
  paidNim: number;
  wonAt: number;
  txHash: string;
}

interface Stored {
  round: number;
  priceNim: number;
  holder: Holder | null;
  claim: ActiveClaim | null;
  roundEndsAt: number | null;
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
  private get roundMs(): number { return Number(this.env.ROUND_SECONDS ?? 300) * 1000; }
  private get claimMs(): number { return Number(this.env.CLAIM_SECONDS ?? 60) * 1000; }
  private get networkId(): number { return Number(this.env.NETWORK_ID ?? 24); }

  private async load(): Promise<Stored> {
    const stored = await this.state.storage.get<Stored>('slot');
    if (stored) return stored;
    return {
      round: 1,
      priceNim: this.floor,
      holder: null,
      claim: null,
      roundEndsAt: null,
      winners: [],
      totals: { bumps: 0, nimMoved: 0, wallets: [] },
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
    return {
      round: slot.round,
      price: slot.priceNim,
      payout: nextPrice(slot.priceNim),
      holder: slot.holder && {
        address: slot.holder.address,
        message: slot.holder.message,
        paid: slot.holder.paidNim,
        takenAt: slot.holder.takenAt,
        txHash: slot.holder.txHash,
        settled: slot.holder.settled,
      },
      endsIn: slot.roundEndsAt ? Math.max(0, slot.roundEndsAt - now) : null,
      locked: Boolean(slot.claim && slot.claim.expiresAt > now),
      lockedFor: slot.claim ? Math.max(0, slot.claim.expiresAt - now) : 0,
      winners: slot.winners.slice(0, 12),
      totals: {
        bumps: slot.totals.bumps,
        nimMoved: slot.totals.nimMoved,
        wallets: slot.totals.wallets.length,
      },
      floor: this.floor,
      roundMs: this.roundMs,
      serverTime: now,
    };
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
    const body = await request.json<{ message?: string; address?: string }>().catch(() => ({}));
    const message = (body.message ?? '').trim();
    const bidder = normaliseAddress(body.address ?? '');

    if (!message) return this.fail(400, 'no-message', 'Write something first.');
    if (message.length > MAX_MESSAGE_LENGTH) {
      return this.fail(400, 'too-long', `Keep it under ${MAX_MESSAGE_LENGTH} characters.`);
    }
    if (!/^NQ[0-9A-Z]{34}$/.test(bidder)) return this.fail(400, 'bad-address', 'That address does not look right.');

    const slot = await this.tick(await this.load());
    const now = Date.now();

    if (slot.claim && slot.claim.expiresAt > now) {
      return this.fail(409, 'locked', 'Someone else is bumping right now. Give it a few seconds.');
    }
    if (slot.holder && addressesMatch(slot.holder.address, bidder)) {
      return this.fail(409, 'already-yours', 'You already have it. Let someone take it off you.');
    }

    // Screen before the wallet is ever opened, so a blocked message costs nobody anything.
    const verdict = await screen(this.env, message);
    if (!verdict.ok) return this.fail(422, 'blocked', verdict.reason);

    const recipient = this.payee(slot);
    if (addressesMatch(recipient, bidder)) {
      return this.fail(409, 'self-pay', 'You would be paying yourself. Wait for someone else to take it.');
    }

    const head = await this.head();
    slot.claim = {
      token: this.token(),
      recipient,
      valueLuna: nimToLuna(slot.priceNim),
      priceNim: slot.priceNim,
      message,
      bidder,
      expiresAt: now + this.claimMs,
      startBlock: head,
    };

    await this.save(slot);
    await this.state.storage.setAlarm(now + POLL_MS);
    this.broadcast(slot);

    return this.json({
      token: slot.claim.token,
      recipient: slot.claim.recipient,
      value: slot.claim.valueLuna,
      price: slot.claim.priceNim,
      expiresIn: this.claimMs,
    });
  }

  /** Release the lock when someone declines at the wallet sheet, rather than making everyone wait. */
  private async cancel(request: Request): Promise<Response> {
    const body = await request.json<{ token?: string }>().catch(() => ({}));
    const slot = await this.load();
    if (slot.claim && slot.claim.token === body.token) {
      slot.claim = null;
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

    if (slot.claim && slot.claim.expiresAt <= now) {
      slot.claim = null;
      changed = true;
    }
    if (slot.roundEndsAt && slot.roundEndsAt <= now && slot.holder) {
      this.closeRound(slot);
      changed = true;
    }
    if (changed) await this.save(slot);
    return slot;
  }

  /** The clock ran out. The holder keeps their message, and the price drops to the floor. */
  private closeRound(slot: Stored): void {
    const holder = slot.holder!;
    slot.winners.unshift({
      round: slot.round,
      address: holder.address,
      message: holder.message,
      paidNim: holder.paidNim,
      wonAt: Date.now(),
      txHash: holder.txHash,
    });
    slot.winners = slot.winners.slice(0, MAX_HISTORY);
    slot.round += 1;
    slot.priceNim = this.floor;
    slot.holder = null;
    slot.roundEndsAt = null;
    slot.claim = null;
  }

  /**
   * The polling loop. Runs only while a claim is outstanding or a round is
   * running, so an idle slot costs nothing.
   */
  async alarm(): Promise<void> {
    const slot = await this.tick(await this.load());
    const now = Date.now();
    let next: number | null = null;

    if (slot.claim) {
      const outcome = await findPayment(this.env.RPC_URL, slot.claim, this.networkId);

      if (outcome.status === 'confirmed' || outcome.status === 'settling') {
        const settled = outcome.status === 'confirmed';
        const alreadyHolding = slot.holder?.txHash === outcome.tx.hash;

        if (!alreadyHolding) this.applyBump(slot, outcome.tx.hash, settled);
        else if (settled && slot.holder) slot.holder.settled = true;

        if (settled) slot.claim = null;
        else next = now + POLL_MS;

        await this.save(slot);
        this.broadcast(slot);
      } else if (outcome.status === 'rejected') {
        slot.claim = null;
        await this.save(slot);
        this.broadcast(slot);
      } else if (slot.claim.expiresAt > now) {
        next = now + POLL_MS;
      } else if (await this.stillWorthWatching(slot)) {
        // The lock is gone but the payment may still land. Keep looking until it
        // cannot confirm at all, so nobody pays and gets nothing.
        next = now + POLL_MS * 4;
      }
    }

    if (slot.roundEndsAt) next = Math.min(next ?? Infinity, slot.roundEndsAt);
    if (next && next !== Infinity) await this.state.storage.setAlarm(next);
  }

  /** A transaction past its validity window can never confirm, so stop waiting. */
  private async stillWorthWatching(slot: Stored): Promise<boolean> {
    if (!slot.claim) return false;
    const head = await this.head();
    return head - slot.claim.startBlock < VALIDITY_WINDOW;
  }

  private applyBump(slot: Stored, txHash: string, settled: boolean): void {
    const claim = slot.claim!;
    slot.holder = {
      address: claim.bidder,
      message: claim.message,
      paidNim: claim.priceNim,
      takenAt: Date.now(),
      txHash,
      settled,
    };
    slot.priceNim = nextPrice(claim.priceNim);
    slot.roundEndsAt = Date.now() + this.roundMs;
    slot.totals.bumps += 1;
    slot.totals.nimMoved += claim.priceNim;
    if (!slot.totals.wallets.includes(claim.bidder)) slot.totals.wallets.push(claim.bidder);
  }

  private async head(): Promise<number> {
    try {
      const { rpc } = await import('./verify.ts');
      return await rpc<number>(this.env.RPC_URL, 'getBlockNumber');
    } catch {
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
