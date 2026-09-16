/**
 * The wallet bridge.
 *
 * Plain JavaScript with no build step, so the browser and the test runner load
 * the same file. The error handling below is the most dangerous code in the app
 * and duplicating it into an untested copy was not worth the convenience.
 */

/** 1 NIM = 100,000 Luna. */
export const LUNA_PER_NIM = 100_000;

export class WalletError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
  }
}

/**
 * The provider reports a declined payment two different ways: sometimes it
 * throws, sometimes it resolves with an { error } body. That is an open bug
 * (nimiq/developer-center#180). Handling only one of them means a refused
 * payment reads as a successful one, which is the worst outcome available here.
 */
export function isDeclined(type, message = '') {
  return /reject|declin|cancel|denied|abort|permission/i.test(`${type} ${message}`);
}

export function unwrap(result) {
  if (result && typeof result === 'object' && 'error' in result) {
    const { type = '', message = '' } = result.error ?? {};
    throw new WalletError(isDeclined(type, message) ? 'PERMISSION_DENIED' : 'INVALID_TX', message);
  }
  return result;
}

export function toWalletError(thrown) {
  if (thrown instanceof WalletError) return thrown;
  const type = thrown?.name ?? '';
  const message = thrown?.message ?? String(thrown);
  return new WalletError(isDeclined(type, message) ? 'PERMISSION_DENIED' : 'INVALID_TX', message);
}

/** Run a provider call so that both refusal paths land in the same place. */
export async function call(fn) {
  try {
    return unwrap(await fn());
  } catch (thrown) {
    throw toWalletError(thrown);
  }
}

/**
 * Wait for the provider to be injected.
 *
 * This is the SDK's init() reimplemented in six lines. The package ships ESM
 * only with no CDN build, and pulling in a bundler for a polling loop this size
 * would add a build step to an app that otherwise has none.
 */
export function init({ timeout = 10_000, scope = globalThis } = {}) {
  if (scope.nimiq) return Promise.resolve(scope.nimiq);
  return new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      if (!scope.nimiq) return;
      clearInterval(poll);
      clearTimeout(bail);
      resolve(scope.nimiq);
    }, 50);
    const bail = setTimeout(() => {
      clearInterval(poll);
      reject(new WalletError('NO_PROVIDER', 'Open this inside Nimiq Pay to take the slot.'));
    }, timeout);
  });
}

/**
 * True from the first paint, before the host has had a chance to inject
 * anything. The injected provider can arrive late, so the injection check alone
 * misses a host that is about to answer. Optimistic display only, never a gate.
 */
export function looksLikeNimiqPay(scope = globalThis) {
  return Boolean(scope.nimiqPay) || /NimiqPay/i.test(scope.navigator?.userAgent ?? '');
}

export function normaliseAddress(address) {
  return String(address ?? '').replace(/\s+/g, '').toUpperCase();
}

export function formatAddress(address) {
  return (normaliseAddress(address).match(/.{1,4}/g) ?? []).join(' ');
}

export function shortAddress(address) {
  const flat = normaliseAddress(address);
  if (flat.length <= 12) return formatAddress(flat);
  return `${flat.slice(0, 8).replace(/.{4}/g, '$& ').trim()} ... ${flat.slice(-4)}`;
}

export function formatNim(nim) {
  return Number(nim).toLocaleString('en-GB');
}

export function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
