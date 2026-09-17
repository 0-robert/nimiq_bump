/**
 * The screen.
 *
 * Holds no truth of its own: every number comes from the server. The only
 * things computed here are the countdown, which ticks between updates so the
 * clock stays smooth, and the heat of the flame, which is derived from them.
 */

// Preview mode lets the screen be explored in a normal browser, where there is
// no wallet to connect to. Loaded only when asked for, so it costs nothing here.
if (new URLSearchParams(location.search).has('preview')) {
  await (await import('./preview.js')).install();
}

import { init, call, looksLikeNimiqPay, normaliseAddress, shortAddress, formatNim, formatClock } from './wallet.js';
import { createFire, heatFrom } from './fire.js';

const $ = (id) => document.getElementById(id);
const el = {
  slot: $('slot'), fire: $('fire'), day: $('day'), stamp: $('stamp'), state: $('state'), watching: $('watching'),
  message: $('message'), holder: $('holder'),
  price: $('price'), payout: $('payout'),
  clock: $('clock'),
  action: $('action'), actionLabel: $('action-label'),
  compose: $('compose'), draft: $('draft'), name: $('name'), count: $('count'), cancel: $('cancel'),
  status: $('status'), tape: $('tape'), events: $('events'),
  past: $('past'), winners: $('winners'), totals: $('totals'),
};

const MAX_MESSAGE = 140;
const DAY_MS = 86_400_000;
/** The flame never goes out entirely. An unlit slot reads as a broken app. */
const EMBERS = 0.3;

const fire = createFire(el.fire);

let provider = null;
let address = null;
let view = null;
let endsAt = null;
let mode = 'idle';

/* ---------- small animations ---------- */

/** Numbers count up rather than snapping, so a rising price reads as rising. */
function countTo(node, to) {
  // `data-changed` lives on the <b>, which is what the animation targets.
  const from = Number(String(node.textContent).replace(/[^\d]/g, '')) || 0;
  if (from === to) return;
  node.dataset.changed = 'true';
  setTimeout(() => delete node.dataset.changed, 440);

  if (fire.reduced || Math.abs(to - from) < 2) { node.textContent = formatNim(to); return; }

  const started = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - started) / 520);
    const eased = 1 - Math.pow(1 - t, 3);
    node.textContent = formatNim(Math.round(from + (to - from) * eased));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Plain text, set only when it changes so a re-render never disturbs it. */
function setMessage(text) {
  if (el.message.textContent !== text) el.message.textContent = text;
  delete el.message.dataset.animate;
}

/** True when this render is the one where the holder changed hands. */
function landedNow(holder, previous) {
  return Boolean(holder?.txHash && holder.txHash !== previous?.holder?.txHash);
}

/**
 * "Posted by" as quiet text, the name as a stamped orange tag. Built from nodes
 * rather than markup: the name is user supplied, sanitised or not.
 */
function byline(name, stamp) {
  const who = document.createElement('b');
  who.className = 'who';
  who.textContent = name;
  if (stamp) who.dataset.flare = 'true';
  el.holder.replaceChildren('Posted by ', who);
}

function payday(amount) {
  const toast = document.createElement('div');
  toast.className = 'payday';
  toast.textContent = `+${formatNim(amount)} NIM`;
  document.body.append(toast);
  setTimeout(() => toast.remove(), 3300);
}

/* ---------- rendering ---------- */

function say(text, tone = 'plain') {
  // Shown only when it has something to say. A permanent line here just
  // repeated what the slot was already displaying.
  el.status.hidden = !text;
  el.status.textContent = text ?? '';
  el.status.dataset.tone = tone;
}

function render(next) {
  const previous = view;
  view = next;
  endsAt = next.endsIn === null ? null : Date.now() + next.endsIn;

  const holder = next.holder;
  const mine = holder && address && normaliseAddress(holder.address) === address;

  el.day.textContent = `Day ${next.round}`;
  // Other people, here now. Shown from two upward: a count of one is just you.
  el.watching.hidden = !(next.watching >= 2);
  el.watching.textContent = `${formatNim(next.watching ?? 0)} watching`;

  if (holder) {
    setMessage(holder.message);
    byline(mine ? 'you' : (holder.name || shortAddress(holder.address)), landedNow(holder, previous));
    el.state.hidden = false;
    el.state.className = holder.settled ? 'tag tag-live' : 'tag tag-ghost';
    el.state.textContent = holder.settled ? 'Confirmed' : 'Confirming';
    el.state.title = holder.settled
      ? 'Confirmed on chain.'
      : 'Waiting for final confirmation on chain.';
  } else {
    // An empty slot used to announce that nothing was happening, which is the
    // worst thing to show someone opening the app for the first time. It names
    // the price and what it buys instead.
    setMessage(`Post your message for ${formatNim(next.price)} NIM`);
    el.holder.textContent = 'Nothing posted yet today';
    el.state.hidden = true;
  }
  // A long message is set smaller so it still reads as one title, not a paragraph.
  const length = el.message.textContent.length;
  el.message.dataset.long = String(length > 44);
  el.message.dataset.short = String(length <= 22);

  // Replay the landing only when the holder actually changed hands.
  const landed = holder?.txHash && holder.txHash !== previous?.holder?.txHash;
  if (landed) {
    el.slot.dataset.landed = 'true';
    setTimeout(() => delete el.slot.dataset.landed, 600);
    fire.flare();

    const wasMine = previous?.holder && address && normaliseAddress(previous.holder.address) === address;
    if (wasMine) {
      payday(holder.paid);
      say(`Someone replaced your message. You received ${formatNim(holder.paid)} NIM. Post again for ${formatNim(next.price)} NIM.`, 'paid');
    }
  }

  countTo(el.price, next.price);
  countTo(el.payout, next.payout);

  renderTape(next.events, previous?.events);
  renderWinners(next.winners?.slice(0, 6));
  renderTotals(next.totals);
  tick();
  renderAction();
}

function renderWinners(winners) {
  el.past.hidden = !winners?.length;
  if (!winners?.length) return;
  el.winners.replaceChildren(...winners.map((win) => {
    const li = document.createElement('li');
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = String(win.round);
    const message = document.createElement('span');
    message.className = 'm';
    message.textContent = win.message;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${win.name || shortAddress(win.address)} paid ${formatNim(win.paidNim)} NIM`;
    li.append(n, message, meta);
    return li;
  }));
}

const plural = (n, one) => `${formatNim(n)} ${n === 1 ? one : `${one}s`}`;

function renderTotals(totals) {
  // Shares the footer line, so it always says something rather than vanishing.
  el.totals.textContent = totals?.bumps
    ? `${plural(totals.bumps, 'post')}, ${formatNim(totals.nimMoved)} NIM paid, ${plural(totals.wallets, 'wallet')}`
    : 'Nimiq Mini Apps Competition';
}

function tick() {
  if (!endsAt) {
    el.clock.textContent = '\u2014';
    el.stamp.dataset.urgent = 'false';
    fire.setHeat(EMBERS);
    return;
  }

  const left = Math.max(0, endsAt - Date.now());
  el.clock.textContent = formatClock(left);

  // The last ten minutes of the day are where it gets decided.
  el.stamp.dataset.urgent = String(left <= 600_000);

  fire.setHeat(Math.max(EMBERS, heatFrom({
    price: view?.price ?? 100,
    floor: view?.floor ?? 100,
    endsIn: left,
    roundMs: DAY_MS,
    holder: view?.holder,
  })));
}

/** The tape: who took it from whom, and what it paid. */
function renderTape(events, previous) {
  // Hiding an empty tape left a hole where the page should have had a pulse.
  el.tape.hidden = false;
  if (!events?.length) {
    el.events.replaceChildren(emptyRow('No activity yet today.'));
    return;
  }

  const seen = new Set((previous ?? []).map((e) => `${e.at}:${e.actor}`));
  el.events.replaceChildren(...events.map((event) => {
    const li = document.createElement('li');
    li.dataset.kind = event.kind;
    if (previous && !seen.has(`${event.at}:${event.actor}`)) li.dataset.fresh = 'true';

    const time = document.createElement('span');
    time.className = 't';
    time.textContent = new Date(event.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

    const what = document.createElement('span');
    what.className = 'what';
    const actor = who(event.actorName, event.actor);
    what.textContent =
      event.kind === 'won' ? `${actor} held the last message of day ${event.day}`
      : event.kind === 'open' ? `${actor} posted the first message`
      : `${actor} replaced ${who(event.fromName, event.from)}`;

    const amount = document.createElement('span');
    amount.className = 'amt';
    amount.textContent = event.kind === 'take' ? `+${formatNim(event.amount)}` : formatNim(event.amount);

    li.append(time, what, amount);
    return li;
  }));
}

function emptyRow(text) {
  const li = document.createElement('li');
  li.dataset.kind = 'idle';
  const span = document.createElement('span');
  span.className = 'what';
  span.textContent = text;
  li.append(span);
  return li;
}

/** A chosen name if there is one, otherwise enough of the address to follow along. */
function who(name, address) {
  if (name) return name;
  return address ? normaliseAddress(address).slice(0, 6) : 'someone';
}

function renderAction() {
  const button = el.action;
  const label = el.actionLabel;
  button.disabled = false;
  button.dataset.sheen = 'false';

  if (!looksLikeNimiqPay()) {
    // Outside Nimiq Pay there is no wallet to connect to. A dead button was the
    // wrong answer: Pay accepts a URL through this deep link, so the button
    // hands the page over to the app instead of refusing.
    label.textContent = 'Open in Nimiq Pay';
    button.disabled = false;
    button.dataset.handoff = 'true';
    return;
  }
  delete button.dataset.handoff;
  if (!address) { label.textContent = 'Connect wallet'; return; }
  if (mode === 'paying') { label.textContent = 'Confirm in your wallet'; button.disabled = true; return; }
  if (mode === 'waiting') { label.textContent = 'Waiting for confirmation'; button.disabled = true; return; }

  const mine = view?.holder && normaliseAddress(view.holder.address) === address;
  if (mine) { label.textContent = 'Your message is up'; button.disabled = true; return; }

  if (view?.locked && mode !== 'composing') { label.textContent = 'Someone else is paying right now'; button.disabled = true; return; }

  label.textContent = view?.holder ? `Replace it for ${formatNim(view.price)} NIM` : `Post for ${formatNim(view?.price ?? 0)} NIM`;
  button.dataset.sheen = 'true';
}

/* ---------- live updates ---------- */

/*
  Server Sent Events rather than WebSocket: WebSocket is not confirmed to work
  inside the Nimiq Pay WebView, and SSE is already running in production in
  another Mini App there. Mobile WebViews suspend when backgrounded, so the
  client refetches on return instead of trusting the stream survived.
*/
function listen() {
  let stream;
  let backoff = 1000;

  const open = () => {
    stream = new EventSource('/api/stream');
    stream.onmessage = (event) => { backoff = 1000; render(JSON.parse(event.data)); };
    stream.onerror = () => {
      stream.close();
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 15_000);
    };
  };

  open();

  const wake = () => {
    resync();
    if (stream?.readyState === 2) open();
  };
  // A WebView host does not reliably raise visibilitychange when the wallet
  // app comes back to the front, so every way back is treated as a return.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
  addEventListener('focus', wake);
  addEventListener('pageshow', wake);

  /*
   * Belt and braces. The stream is the fast path, but a deploy drops it, a
   * suspended WebView silently loses it, and the reconnect can sit in backoff.
   * Polling state on a timer means the screen is never more than a few
   * seconds behind whatever happens, and it is one small read per tick.
   */
  setInterval(() => resync(), 8_000);
}

async function resync() {
  try { render(await (await fetch('/api/state', { cache: 'no-store' })).json()); } catch { /* the stream will catch up */ }
}

/* ---------- the bump ---------- */

async function connect() {
  try {
    provider ??= await init({ timeout: 10_000 });
    address = normaliseAddress((await call(() => provider.listAccounts()))[0]);
    say('Wallet connected.');
    renderAction();
  } catch (error) {
    say(error.code === 'PERMISSION_DENIED' ? 'Wallet not connected.' : error.message);
  }
}

function compose() {
  mode = 'composing';
  el.compose.hidden = false;
  // Remembered per device so nobody retypes it every day. Local only.
  try { el.name.value ||= localStorage.getItem('bump.name') ?? ''; } catch { /* private mode */ }
  el.draft.focus();
  countDraft();
  renderAction();
}

function stopComposing(message = '') {
  mode = 'idle';
  el.compose.hidden = true;
  say(message);
  renderAction();
}

function countDraft() {
  const left = MAX_MESSAGE - el.draft.value.length;
  el.count.textContent = `${left} characters left`;
  el.count.dataset.over = String(left < 0);
}

async function bump() {
  const message = el.draft.value.trim();
  if (!message) { say('Enter a message first.', 'error'); el.draft.focus(); return; }

  mode = 'paying';
  renderAction();
  say('Preparing your payment.', 'live');

  let claim;
  try {
    const response = await fetch('/api/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, address, name: el.name.value.trim() }),
    });
    claim = await response.json();
    if (!response.ok) { stopComposing(); say(claim.message ?? 'Something went wrong. Try again.', 'error'); return; }
  } catch {
    stopComposing();
    say('Could not reach the server. Try again in a moment.', 'error');
    return;
  }

  try { localStorage.setItem('bump.name', el.name.value.trim()); } catch { /* private mode */ }

  say(`Confirm ${formatNim(claim.price)} NIM in your wallet. It goes directly to the current poster.`, 'live');

  try {
    // The claim token rides along as the memo in plain UTF-8. Nimiq Pay hex
    // encodes it itself, so encoding it here would put hex of hex on chain and
    // the server would never match it.
    await call(() => provider.sendBasicTransactionWithData({
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
      error.code === 'PERMISSION_DENIED' ? 'Payment cancelled.' : `Payment failed. ${error.message}`,
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
  say('Payment sent. Waiting for confirmation.', 'live');
}

async function release(token) {
  try {
    await fetch('/api/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch { /* the claim expires on its own after a minute */ }
}

/* ---------- wiring ---------- */

el.action.addEventListener('click', () => {
  if (el.action.dataset.handoff === 'true') {
    /*
     * The custom scheme, not the nimpay.app link: that one looks the host up
     * in Nimiq's directory and refuses anything unlisted. The scheme opens
     * the installed app directly. Where nothing handles it, a desktop
     * browser for instance, the page is still here a moment later, so say
     * how to open it by hand instead of leaving a click that did nothing.
     */
    location.href = `nimiqpay://miniapp?url=${encodeURIComponent(location.origin)}`;
    setTimeout(() => {
      if (document.visibilityState === 'visible') {
        say(`Nothing opened. In Nimiq Pay go to Mini Apps, then Custom URL, and paste ${location.host}`);
      }
    }, 1800);
    return;
  }
  if (!address) return connect();
  if (mode === 'composing') return bump();
  return compose();
});
el.cancel.addEventListener('click', () => stopComposing());
el.draft.addEventListener('input', countDraft);

// Never on load. listAccounts() opens a native dialog and the provider's own
// checklist forbids prompting before a deliberate tap.
listen();
setInterval(tick, 250);
setInterval(() => {
  if (mode !== 'waiting') return;
  const mine = view?.holder && normaliseAddress(view.holder.address) === address;
  if (mine) stopComposing('It is yours. Now wait for someone to take it off you.');
}, 1000);
