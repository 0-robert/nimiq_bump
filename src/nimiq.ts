/**
 * Nimiq primitives: money, addresses, and the provider's two-faced error model.
 * Pure functions only, so the whole file is testable without a network or a wallet.
 */

/** 1 NIM = 100,000 Luna. Luna is the integer base unit; never do money maths in NIM. */
export const LUNA_PER_NIM = 100_000;

/** Total supply is 2.1e15 Luna, comfortably inside Number.MAX_SAFE_INTEGER (9.007e15). */
export const MAX_SUPPLY_LUNA = 2_100_000_000_000_000;

export function nimToLuna(nim: number): number {
  if (!Number.isInteger(nim) || nim < 0) throw new RangeError(`price must be a whole NIM amount, got ${nim}`);
  const luna = nim * LUNA_PER_NIM;
  if (luna > MAX_SUPPLY_LUNA) throw new RangeError(`${nim} NIM exceeds total supply`);
  return luna;
}

/**
 * The price ladder. Each bump costs ceil(1.25x) the last price, in whole NIM.
 *
 * 1.25 rather than 1.5: twenty replacements reach the price twelve did before,
 * so a day holds more of them and more wallets get paid. Each displacement
 * pays +25% instead of +50%.
 *
 * Ceil rather than round so the price strictly increases at every step: at a
 * floor of 1 NIM, rounding would stall at 2 forever. Whole NIM keeps the
 * display clean and sidesteps float entirely.
 *
 * 100 -> 125 -> 157 -> 197 -> 247 -> 309 -> 387 -> 484 -> 605 -> 757
 */
export function nextPrice(currentNim: number): number {
  if (!Number.isInteger(currentNim) || currentNim < 1) {
    throw new RangeError(`current price must be a positive whole NIM amount, got ${currentNim}`);
  }
  return Math.ceil((currentNim * 5) / 4);
}

/** What the holder clears by being bumped: the new price minus what they paid. */
export function payout(paidNim: number): { receives: number; profit: number } {
  const receives = nextPrice(paidNim);
  return { receives, profit: receives - paidNim };
}

/**
 * Nimiq addresses arrive as 36 characters in groups of four ("NQ07 1A2B ...").
 * Spacing is presentational and not guaranteed, so compare normalised forms only.
 */
export function normaliseAddress(address: string): string {
  return address.replace(/\s+/g, '').toUpperCase();
}

export function addressesMatch(a: string, b: string): boolean {
  return normaliseAddress(a) === normaliseAddress(b);
}

/** Regroup into fours for display. */
export function formatAddress(address: string): string {
  return (normaliseAddress(address).match(/.{1,4}/g) ?? []).join(' ');
}

/** Shorten for a crowded row: "NQ07 1A2B ... X9F2". */
export function shortAddress(address: string): string {
  const flat = normaliseAddress(address);
  if (flat.length <= 12) return formatAddress(flat);
  return `${flat.slice(0, 8).replace(/.{4}/g, '$& ').trim()} ... ${flat.slice(-4)}`;
}

export interface ErrorResponse {
  error: { type: string; message: string };
}

export type WalletErrorCode = 'PERMISSION_DENIED' | 'INVALID_TX' | 'NO_PROVIDER';

export class WalletError extends Error {
  code: WalletErrorCode;
  constructor(code: WalletErrorCode, message: string) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
  }
}

function isErrorResponse(value: unknown): value is ErrorResponse {
  return typeof value === 'object' && value !== null && 'error' in value;
}

/**
 * The provider reports a declined payment two different ways: sometimes it
 * throws, sometimes it resolves with an ErrorResponse body. That is an open bug
 * (nimiq/developer-center#180), deferred to 1.0. A plain try/catch reads the
 * resolved variant as a successful payment, which is the worst possible failure
 * here, so every provider call goes through this.
 */
export function unwrap<T>(result: T | ErrorResponse): T {
  if (isErrorResponse(result)) {
    const { type, message } = result.error;
    throw new WalletError(isDeclined(type, message) ? 'PERMISSION_DENIED' : 'INVALID_TX', message);
  }
  return result;
}

/**
 * The error type string is not formally specified anywhere, so match loosely on
 * both the type and the message rather than testing for one exact literal.
 */
export function isDeclined(type: string, message = ''): boolean {
  return /reject|declin|cancel|denied|abort|permission/i.test(`${type} ${message}`);
}

/** Turn anything the provider throws or returns into one WalletError. */
export function toWalletError(thrown: unknown): WalletError {
  if (thrown instanceof WalletError) return thrown;
  const type = (thrown as { name?: string })?.name ?? '';
  const message = (thrown as { message?: string })?.message ?? String(thrown);
  return new WalletError(isDeclined(type, message) ? 'PERMISSION_DENIED' : 'INVALID_TX', message);
}

/** The memo is hex on the wire. Decode before comparing it to a claim token. */
export function hexToUtf8(hex: string): string {
  const clean = hex.replace(/^0x/, '');
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) return '';
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return '';
  }
}

/**
 * Claim tokens ride in the transaction's data field. Its exact ceiling is
 * undocumented; the official demo says 64 bytes. 16 hex characters leaves a wide
 * margin and still gives 64 bits of entropy.
 */
export const CLAIM_TOKEN_BYTES = 8;

export function formatNim(nim: number): string {
  return nim.toLocaleString('en-GB');
}


export const MAX_NAME_LENGTH = 16;

/**
 * Clean up a display name.
 *
 * Names sit next to money in a public feed, so the rules are deliberately mean:
 * no invisible characters, no direction overrides, no impersonating a wallet
 * address, and a hard length cap so nobody can push the tape around.
 *
 * Returns an empty string when nothing usable survives, and the caller falls
 * back to a shortened address.
 */
export function sanitiseName(input: string): string {
  const stripped = String(input ?? '')
    // Control characters, zero width joiners and spaces, and the bidi overrides
    // that let a name render as something other than what it contains.
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!stripped) return '';
  // An address-shaped name would let someone pose as another wallet in the tape.
  if (/^NQ[0-9A-Z\s]{10,}$/i.test(stripped)) return '';

  // Spread first: slicing a string by code unit would cut an emoji in half.
  return [...stripped].slice(0, MAX_NAME_LENGTH).join('').trim();
}
