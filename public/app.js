/**
 * The screen.
 *
 * Holds no truth of its own: every number comes from the server, and the only
 * thing computed locally is the countdown, which ticks between updates so the
 * clock stays smooth without a request per second.
 */

import {
  init, call, looksLikeNimiqPay, normaliseAddress, shortAddress,
  formatNim, formatClock,
} from './wallet.js';

// Preview mode lets the screen be explored in a normal browser, where there is
// no wallet to connect to. Loaded only when asked for, so it costs nothing here.
if (new URLSearchParams(location.search).has('preview')) {
  await (await import('./preview.js')).install();
}

const $ = (id) => document.getElementById(id);
const el = {
  slot: $('slot'), fill: $('slot-fill'), message: $('message'), meta: $('meta'),
  price: $('price'), payout: $('payout'), clock: $('clock'), holder: $('holder'),
  action: $('action'), compose: $('compose'), draft: $('draft'), count: $('count'),
  cancel: $('cancel'), status: $('status'), past: $('past'), winners: $('winners'),
  totals: $('totals'),
};

const MAX_MESSAGE = 140;

let provider = null;
let address = null;
let view = null;
let clockOffset = 0;      // serverTime minus local clock
let endsAt = null;        // absolute local time the round ends
let mode = 'idle';        // idle | composing | paying | waiting
let lastTxHash = null;

/* ---------- rendering ---------- */

function say(text, tone = 'plain') {
  el.status.textContent = text;
  el.status.dataset.tone = tone;
}

function render(next) {
  const previous = view;
  view = next;

  clockOffset = next.serverTime - Date.now();
  endsAt = next.endsIn === null ? null : Date.now() + next.endsIn;

  const holder = next.holder;
  const mine = holder && address && normaliseAddress(holder.address) === address;

  if (holder) {
    el.message.textContent = holder.message;
    el.message.classList.remove('slot-empty');
    el.holder.textContent = mine ? 'You' : shortAddress(holder.address);
    el.meta.innerHTML = '';
    el.meta.append(badge(holder.settled));
  } else {
    el.message.textContent = 'Nobody has it yet.';
    el.message.classList.add('slot-empty');
    el.holder.textContent = 'Nobody';
    el.meta.innerHTML = '';
  }

  // Replay the landing animation only when the holder actually changed.
  const changed = holder?.txHash && holder.txHash !== previous?.holder?.txHash;
  if (changed) {
    el.fill.dataset.justLanded = 'true';
    setTimeout(() => delete el.fill.dataset.justLanded, 450);
    if (previous?.holder && address && normaliseAddress(previous.holder.address) === address) {
      say(`You were bumped. ${formatNim(holder.paid)} NIM is on its way to you.`, 'paid');
    }
  }

  el.price.textContent = `${formatNim(next.price)} NIM`;
  el.payout.textContent = `${formatNim(next.payout)} NIM`;

  renderWinners(next.winners);
  renderTotals(next.totals);
  tickClock();
  renderAction();
}

function badge(settled) {
  const span = document.createElement('span');
  span.className = `badge ${settled ? 'badge-settled' : 'badge-settling'}`;
  span.textContent = settled ? 'Settled' : 'Settling';
  if (!settled) span.title = 'Included in a block. Waiting for the batch that makes it final.';
  return span;
}

function renderWinners(winners) {
  el.past.hidden = !winners?.length;
  if (!winners?.length) return;
  el.winners.replaceChildren(...winners.map((win) => {
    const li = document.createElement('li');
    const index = document.createElement('span');
    index.className = 'index';
    index.textContent = String(win.round).padStart(2, '0');
    const message = document.createElement('span');
    message.className = 'past-message';
    message.textContent = win.message;
    const meta = document.createElement('span');
    meta.className = 'spec past-meta';
    meta.textContent = `${shortAddress(win.address)} · ${formatNim(win.paidNim)} NIM`;
    li.append(index, message, meta);
    return li;
  }));
}

function renderTotals(totals) {
  if (!totals?.bumps) { el.totals.hidden = true; return; }
  el.totals.hidden = false;
  el.totals.textContent =
    `${formatNim(totals.bumps)} bumps · ${formatNim(totals.nimMoved)} NIM moved · ${formatNim(totals.wallets)} wallets`;
}

function tickClock() {
  if (!endsAt) { el.clock.textContent = 'Not started'; el.clock.dataset.urgent = 'false'; return; }
  const left = endsAt - Date.now();
  el.clock.textContent = formatClock(left);
  const urgent = left <= 30_000;
  el.clock.dataset.urgent = String(urgent);
  el.slot.dataset.state = left <= 0 ? 'won' : urgent ? 'urgent' : 'live';
}

function renderAction() {
  const button = el.action;
  button.disabled = false;

  if (!looksLikeNimiqPay()) {
    button.textContent = 'Open this in Nimiq Pay';
    button.disabled = true;
    return;
  }
  if (!address) { button.textContent = 'Connect wallet'; return; }

  if (mode === 'paying') { button.textContent = 'Confirm in your wallet'; button.disabled = true; return; }
  if (mode === 'waiting') { button.textContent = 'Waiting for the chain'; button.disabled = true; return; }

  const mine = view?.holder && normaliseAddress(view.holder.address) === address;
  if (mine) { button.textContent = 'You have it'; button.disabled = true; return; }

  if (view?.locked && mode !== 'composing') {
    button.textContent = 'Someone is bumping';
    button.disabled = true;
    return;
  }

  button.textContent = `Take it for ${formatNim(view?.price ?? 0)} NIM`;
}

/* ---------- live updates ---------- */

/*
  Server Sent Events rather than WebSocket: WebSocket is not confirmed to work
  inside the Nimiq Pay WebView, and SSE is already running in production in
  another Mini App there. Mobile WebViews suspend when backgrounded, so the
  client refetches state on reconnect instead of assuming the stream survived.
*/
function listen() {
  let stream;
  let backoff = 1000;

  const open = () => {
    stream = new EventSource('/api/stream');
    stream.onmessage = (event) => {
      backoff = 1000;
      render(JSON.parse(event.data));
    };
    stream.onerror = () => {
      stream.close();
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 15_000);
    };
  };

  open();

  // Coming back from the background: resync rather than trust the stream.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    resync();
    if (stream?.readyState === EventSource.CLOSED) open();
  });
}

async function resync() {
  try {
    render(await (await fetch('/api/state', { cache: 'no-store' })).json());
  } catch {
    // The stream or the next resync will catch up.
  }
}

/* ---------- the bump ---------- */

async function connect() {
  try {
    provider ??= await init({ timeout: 10_000 });
    const accounts = await call(() => provider.listAccounts());
    address = normaliseAddress(accounts[0]);
    say('Connected. Write something and take the slot.');
    renderAction();
  } catch (error) {
    say(error.code === 'PERMISSION_DENIED' ? 'No problem. Connect whenever you like.' : error.message, 'plain');
  }
}

function compose() {
  mode = 'composing';
  el.compose.hidden = false;
  el.draft.focus();
  countDraft();
  renderAction();
}

function stopComposing(message = 'Rounds start at 100 NIM, which is about three cents.') {
  mode = 'idle';
  el.compose.hidden = true;
  say(message);
  renderAction();
}

function countDraft() {
  const left = MAX_MESSAGE - el.draft.value.length;
  el.count.textContent = `${left} left`;
  el.count.dataset.over = String(left < 0);
}

async function bump() {
  const message = el.draft.value.trim();
  if (!message) { say('Write something first.', 'error'); el.draft.focus(); return; }

  mode = 'paying';
  renderAction();
  say('Setting up your bump.', 'live');

  let claim;
  try {
    const response = await fetch('/api/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, address }),
    });
    claim = await response.json();
    if (!response.ok) {
      stopComposing();
      say(claim.message ?? 'That did not go through.', 'error');
      return;
    }
  } catch {
    stopComposing();
    say('Could not reach the server. Try again in a moment.', 'error');
    return;
  }

  say(`Confirm ${formatNim(claim.price)} NIM in your wallet. It goes straight to the holder.`, 'live');

  try {
    // The claim token rides along as the memo in plain UTF-8. Nimiq Pay hex
    // encodes it itself, so encoding it here would put hex of hex on chain and
    // the server would never match it.
    lastTxHash = await call(() => provider.sendBasicTransactionWithData({
      recipient: claim.recipient,
      value: claim.value,
      data: claim.token,
    }));
  } catch (error) {
    await release(claim.token);
    el.compose.hidden = false;
    mode = 'composing';
    renderAction();
    say(
      error.code === 'PERMISSION_DENIED'
        ? 'You backed out. The slot is open again.'
        : `That did not go through. ${error.message}`,
      error.code === 'PERMISSION_DENIED' ? 'plain' : 'error',
    );
    return;
  }

  // A returned hash means broadcast, not settled. The server is watching the
  // chain and the stream will say when it lands.
  mode = 'waiting';
  el.compose.hidden = true;
  el.draft.value = '';
  countDraft();
  renderAction();
  say('Sent. Waiting for the chain to confirm it.', 'live');

  setTimeout(() => {
    if (mode !== 'waiting') return;
    const mine = view?.holder && normaliseAddress(view.holder.address) === address;
    if (mine) stopComposing('It is yours. Now wait for someone to take it off you.');
  }, 2500);
}

async function release(token) {
  try {
    await fetch('/api/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch {
    // The claim expires on its own after a minute anyway.
  }
}

/* ---------- wiring ---------- */

el.action.addEventListener('click', () => {
  if (!address) return connect();
  if (mode === 'composing') return bump();
  return compose();
});
el.cancel.addEventListener('click', () => stopComposing());
el.draft.addEventListener('input', countDraft);

// Never on load. The provider's own checklist forbids prompting before a tap,
// and listAccounts() opens a native dialog.
listen();
setInterval(tickClock, 250);

// Once the holder settles, drop out of the waiting state.
setInterval(() => {
  if (mode !== 'waiting') return;
  const mine = view?.holder && normaliseAddress(view.holder.address) === address;
  if (mine) stopComposing('It is yours. Now wait for someone to take it off you.');
}, 1000);
