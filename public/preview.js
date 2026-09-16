/**
 * Preview mode, reached with ?preview.
 *
 * A Mini App only has a wallet inside Nimiq Pay, so on a desktop browser the
 * screen is correctly inert: there is nothing to connect to. Anyone opening the
 * link on a laptop, which includes judges, would otherwise see a dead button
 * and no way to tell what the app does.
 *
 * This runs the whole loop against an in-memory slot with a stand-in wallet.
 * It fakes the client's view only. No payment is requested, nothing reaches the
 * chain, and the server has no matching mode, so there is no path from here to
 * a real bump.
 */

const ME = 'NQ55 PREV 1EWW ALLE T0NL Y0000 0000 0000'.replace(/\s+/g, '').slice(0, 36);
const RIVAL = 'NQ31 R1VA L0000 0000 0000 0000 0000 0000'.replace(/\s+/g, '').slice(0, 36);

const FLOOR = 100;
const ROUND_MS = 60_000;   // shortened from five minutes so the loop is watchable
const next = (n) => Math.ceil((n * 3) / 2);

const slot = {
  round: 1, price: FLOOR, holder: null, endsAt: null,
  winners: [], totals: { bumps: 0, nimMoved: 0, wallets: new Set() },
};

const listeners = new Set();

function view() {
  return {
    round: slot.round,
    price: slot.price,
    payout: next(slot.price),
    holder: slot.holder,
    endsIn: slot.endsAt ? Math.max(0, slot.endsAt - Date.now()) : null,
    locked: false,
    lockedFor: 0,
    winners: slot.winners.slice(0, 12),
    totals: { ...slot.totals, wallets: slot.totals.wallets.size },
    floor: FLOOR,
    serverTime: Date.now(),
  };
}

const push = () => listeners.forEach((fn) => fn(view()));

function take(address, message) {
  slot.holder = {
    address, message, paid: slot.price,
    takenAt: Date.now(), txHash: Math.random().toString(16).slice(2).padEnd(64, '0'),
    settled: false,
  };
  slot.totals.bumps += 1;
  slot.totals.nimMoved += slot.price;
  slot.totals.wallets.add(address);
  slot.price = next(slot.price);
  slot.endsAt = Date.now() + ROUND_MS;
  push();

  // Stand in for the wait between inclusion and the macro block that finalises it.
  setTimeout(() => { if (slot.holder) { slot.holder.settled = true; push(); } }, 2200);
}

function closeRound() {
  if (!slot.holder) return;
  slot.winners.unshift({
    round: slot.round, address: slot.holder.address, message: slot.holder.message,
    paidNim: slot.holder.paid, wonAt: Date.now(), txHash: slot.holder.txHash,
  });
  slot.round += 1;
  slot.price = FLOOR;
  slot.holder = null;
  slot.endsAt = null;
  push();
}

setInterval(() => {
  if (slot.endsAt && Date.now() >= slot.endsAt) closeRound();
}, 500);

/** Someone takes it back off you, so the payout moment is part of the demo. */
function scheduleRival() {
  setTimeout(() => {
    if (slot.holder && slot.holder.address === ME) take(RIVAL, 'taken off you, and you just got paid');
  }, 9000);
}

export function install() {
  const banner = document.createElement('p');
  banner.className = 'status';
  banner.dataset.tone = 'live';
  banner.style.marginBottom = '1rem';
  banner.textContent = 'Preview. A stand-in wallet, no real NIM, nothing sent to the chain.';
  document.querySelector('.shell').prepend(banner);

  globalThis.nimiqPay = { language: 'en' };
  globalThis.nimiq = {
    listAccounts: async () => [ME],
    sendBasicTransactionWithData: async ({ data }) => {
      await new Promise((r) => setTimeout(r, 700));
      const pending = globalThis.__previewClaim;
      if (pending?.token === data) {
        take(ME, pending.message);
        scheduleRival();
      }
      return Math.random().toString(16).slice(2).padEnd(64, '0');
    },
  };

  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const url = String(input?.url ?? input);
    if (url.includes('/api/state')) return Response.json(view());
    if (url.includes('/api/cancel')) return Response.json({ ok: true });
    if (url.includes('/api/claim')) {
      const body = JSON.parse(init?.body ?? '{}');
      globalThis.__previewClaim = { token: 'preview', message: body.message };
      return Response.json({ token: 'preview', recipient: RIVAL, value: slot.price * 100_000, price: slot.price, expiresIn: 60_000 });
    }
    return realFetch(input, init);
  };

  globalThis.EventSource = class {
    constructor() {
      this.readyState = 1;
      const send = (state) => this.onmessage?.({ data: JSON.stringify(state) });
      listeners.add(send);
      setTimeout(() => send(view()), 0);
    }
    close() { this.readyState = 2; }
  };
}
