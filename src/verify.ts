/**
 * Chain verification. The server never trusts the client's word that a payment
 * happened: it goes and looks, then applies every check below before a bump counts.
 */

import { addressesMatch, hexToUtf8, normaliseAddress } from './nimiq.ts';

/** A macro block closes every batch of 60, so any 60 consecutive heights contain one. */
export const BLOCKS_PER_BATCH = 60;

/** Past this many blocks from its validity start, a transaction can never confirm. */
export const VALIDITY_WINDOW = 7200;

export interface ChainTx {
  hash: string;
  blockNumber: number;
  to: string;
  value: number;
  confirmations: number;
  recipientData: string;
  executionResult: boolean;
  networkId: number;
}

export interface Claim {
  token: string;
  recipient: string;
  valueLuna: number;
}

export type VerifyOutcome =
  | { status: 'confirmed'; tx: ChainTx }
  | { status: 'settling'; tx: ChainTx }
  | { status: 'pending' }
  | { status: 'rejected'; reason: string };

class RpcError extends Error {
  retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'RpcError';
    this.retryable = retryable;
  }
}

/**
 * The public node is POST only, with no WebSocket and so no subscriptions.
 * It allows 20 tokens per 10s per IP, and a list costs one token per started
 * 100 results, so every list call passes an explicit max. One Durable Object
 * polling on everyone's behalf stays far inside that; per-client polling would not.
 */
export async function rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

  if (response.status === 429) {
    const resetAt = response.headers.get('x-ratelimit-reset');
    throw new RpcError(`rate limited${resetAt ? `, resets at ${resetAt}` : ''}`, true);
  }
  if (!response.ok) throw new RpcError(`${method} returned HTTP ${response.status}`, response.status >= 500);

  const body = (await response.json()) as { result?: { data?: T } | T; error?: unknown };
  if (body.error) throw new RpcError(`${method}: ${JSON.stringify(body.error)}`, false);

  // The node wraps results in { data } on some methods and returns them bare on others.
  const result = body.result as { data?: T } | T;
  return (result && typeof result === 'object' && 'data' in result ? (result as { data: T }).data : result) as T;
}

/** Field names differ between node builds and between RPC and the REST explorer. */
function readTx(raw: Record<string, unknown>): ChainTx | null {
  const hash = raw.hash ?? raw.transactionHash;
  const to = raw.to ?? raw.toAddress ?? raw.recipient;
  if (typeof hash !== 'string' || typeof to !== 'string') return null;

  // executionResult may arrive flattened, wrapped, or (on the REST API) as `executed`.
  const executionRaw = raw.executionResult ?? raw.executed;
  const executionResult =
    typeof executionRaw === 'object' && executionRaw !== null
      ? Boolean((executionRaw as { executionResult?: unknown }).executionResult)
      : Boolean(executionRaw);

  return {
    hash,
    to,
    blockNumber: Number(raw.blockNumber ?? raw.block_height ?? 0),
    value: Number(raw.value ?? 0),
    confirmations: Number(raw.confirmations ?? 0),
    recipientData: String(raw.recipientData ?? raw.data ?? ''),
    executionResult,
    networkId: Number(raw.networkId ?? raw.network_id ?? 0),
  };
}

/**
 * Every condition a payment must satisfy. Order matters only for the error
 * message; all of them have to hold.
 *
 * The one that catches people: Albatross writes FAILED transactions to the
 * chain, fee charged and effect discarded. So a transaction existing is not
 * proof of payment, and executionResult has to be checked explicitly.
 */
export function checkTx(tx: ChainTx, claim: Claim, networkId: number): { ok: true } | { ok: false; reason: string } {
  if (!tx.executionResult) return { ok: false, reason: 'transaction failed on chain' };
  if (tx.networkId !== networkId) return { ok: false, reason: `wrong network: ${tx.networkId}` };
  if (!addressesMatch(tx.to, claim.recipient)) return { ok: false, reason: 'paid the wrong address' };
  if (tx.value < claim.valueLuna) return { ok: false, reason: `underpaid: ${tx.value} < ${claim.valueLuna}` };
  if (hexToUtf8(tx.recipientData) !== claim.token) return { ok: false, reason: 'memo does not match this claim' };
  return { ok: true };
}

/**
 * Nimiq's "one second" describes inclusion, not finality.
 *
 * A micro block comes from a single validator and is reversible up to 59 blocks
 * deep. The macro block closing each batch is produced by Tendermint BFT and
 * finalises everything before it irreversibly, which is 0 to 60 seconds out and
 * around 30 on average. Depth alone carries no finality meaning, so 60
 * confirmations is the shortcut that guarantees a macro block has passed.
 */
export function isFinal(tx: ChainTx, head: number): boolean {
  const depth = Math.max(tx.confirmations, head - tx.blockNumber + 1);
  return depth >= BLOCKS_PER_BATCH;
}

/**
 * Look for the payment that settles a claim.
 *
 * Searches by recipient and memo, never by sender: the provider exposes no
 * sender parameter, so the wallet picks its own signing account and it is not
 * necessarily the address the app displayed.
 */
export async function findPayment(
  rpcUrl: string,
  claim: Claim,
  networkId: number,
  lookback = 20,
): Promise<VerifyOutcome> {
  const address = normaliseAddress(claim.recipient);

  let head: number;
  let raw: Record<string, unknown>[];
  try {
    [head, raw] = await Promise.all([
      rpc<number>(rpcUrl, 'getBlockNumber'),
      rpc<Record<string, unknown>[]>(rpcUrl, 'getTransactionsByAddress', [address, lookback]),
    ]);
  } catch (error) {
    // A flaky node is not a failed payment. Stay pending and look again.
    if (error instanceof RpcError && error.retryable) return { status: 'pending' };
    throw error;
  }

  for (const entry of raw ?? []) {
    const tx = readTx(entry);
    if (!tx) continue;
    if (hexToUtf8(tx.recipientData) !== claim.token) continue;

    const check = checkTx(tx, claim, networkId);
    if (!check.ok) return { status: 'rejected', reason: check.reason };
    return isFinal(tx, head) ? { status: 'confirmed', tx } : { status: 'settling', tx };
  }

  return { status: 'pending' };
}
