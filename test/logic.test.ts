import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  nextPrice, payout, nimToLuna, normaliseAddress, addressesMatch,
  shortAddress, unwrap, toWalletError, hexToUtf8, WalletError, sanitiseName,
} from '../src/nimiq.ts';
import { checkTx, isFinal } from '../src/verify.ts';

const HOLDER = 'NQ22 JV9P 548B JL00 TRKS GT1P X3QJ 52BV ENK3';

test('price ladder rises by a quarter each time', () => {
  assert.deepEqual(
    [100, 125, 157, 197, 247, 309, 387, 484, 605, 757].slice(1),
    [100, 125, 157, 197, 247, 309, 387, 484, 605].map(nextPrice),
  );
});

test('price always strictly increases, even at the smallest amounts', () => {
  for (let price = 1; price < 500; price++) {
    assert.ok(nextPrice(price) > price, `${price} did not increase`);
  }
});

test('being replaced pays back more than you put in', () => {
  for (const paid of [100, 125, 157, 197, 605]) {
    const { receives, profit } = payout(paid);
    assert.ok(profit > 0, `no profit at ${paid}`);
    assert.equal(receives, paid + profit);
    assert.ok(profit / paid >= 0.24, `profit was only ${((profit / paid) * 100).toFixed(1)}% at ${paid}`);
  }
});

test('fractional and negative prices are refused rather than rounded', () => {
  assert.throws(() => nextPrice(10.5), RangeError);
  assert.throws(() => nextPrice(0), RangeError);
  assert.throws(() => nimToLuna(-1), RangeError);
});

test('Luna conversion stays an exact integer', () => {
  assert.equal(nimToLuna(100), 10_000_000);
  assert.equal(nimToLuna(2570), 257_000_000);
  assert.ok(Number.isSafeInteger(nimToLuna(1_000_000)));
});

test('addresses compare regardless of spacing or case', () => {
  assert.equal(normaliseAddress(HOLDER), 'NQ22JV9P548BJL00TRKSGT1PX3QJ52BVENK3');
  assert.ok(addressesMatch(HOLDER, 'nq22jv9p548bjl00trksgt1px3qj52bvenk3'));
  assert.ok(!addressesMatch(HOLDER, 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000'));
  assert.match(shortAddress(HOLDER), /^NQ22 JV9P \.\.\. ENK3$/);
});

test('a declined payment is caught whether it throws or resolves', () => {
  // The provider does both. Missing either one reads a refusal as a payment.
  assert.throws(
    () => unwrap({ error: { type: 'PermissionDeniedError', message: 'User rejected' } }),
    (error: WalletError) => error.code === 'PERMISSION_DENIED',
  );
  const thrown = toWalletError(Object.assign(new Error('User cancelled'), { name: 'PermissionDeniedError' }));
  assert.equal(thrown.code, 'PERMISSION_DENIED');
});

test('a genuine failure is not mistaken for a refusal', () => {
  assert.throws(
    () => unwrap({ error: { type: 'InvalidTransaction', message: 'insufficient funds' } }),
    (error: WalletError) => error.code === 'INVALID_TX',
  );
});

test('a successful result passes straight through', () => {
  assert.equal(unwrap('a'.repeat(64)), 'a'.repeat(64));
  assert.deepEqual(unwrap([HOLDER]), [HOLDER]);
});

test('hex memos decode, and malformed ones do not throw', () => {
  assert.equal(hexToUtf8('6131623263336434'), 'a1b2c3d4');
  assert.equal(hexToUtf8('0x6131623263336434'), 'a1b2c3d4');
  assert.equal(hexToUtf8('nonsense'), '');
  assert.equal(hexToUtf8('abc'), '');
});

const claim = { token: 'a1b2c3d4', recipient: HOLDER, valueLuna: 15_000_000 };
const good = {
  hash: 'f'.repeat(64),
  blockNumber: 100,
  to: normaliseAddress(HOLDER),
  value: 15_000_000,
  confirmations: 60,
  recipientData: '6131623263336434',
  executionResult: true,
  networkId: 24,
};

test('a correct payment passes the gate', () => {
  assert.deepEqual(checkTx(good, claim, 24), { ok: true });
});

test('a failed transaction is rejected even though it is on chain', () => {
  // Albatross records failed transactions: fee charged, effect discarded.
  const result = checkTx({ ...good, executionResult: false }, claim, 24);
  assert.equal(result.ok, false);
});

test('the gate rejects wrong network, wrong recipient, underpayment and wrong memo', () => {
  const bad = [
    { ...good, networkId: 5 },
    { ...good, to: 'NQ07000000000000000000000000000000000' },
    { ...good, value: 14_999_999 },
    { ...good, recipientData: '6465616462656566' },
  ];
  for (const tx of bad) assert.equal(checkTx(tx, claim, 24).ok, false);
});

test('overpaying is accepted', () => {
  assert.deepEqual(checkTx({ ...good, value: 15_000_001 }, claim, 24), { ok: true });
});

test('finality needs a full batch, not just depth', () => {
  assert.ok(isFinal(good, 160));
  assert.ok(!isFinal({ ...good, confirmations: 59 }, 158));
  // Depth is taken from whichever source is further along.
  assert.ok(isFinal({ ...good, confirmations: 0 }, 200));
});


test('names are trimmed, collapsed and capped', () => {
  assert.equal(sanitiseName('  rob   vassallo  '), 'rob vassallo');
  assert.equal(sanitiseName('a'.repeat(40)), 'a'.repeat(16));
});

test('names cannot carry invisible or direction-flipping characters', () => {
  assert.equal(sanitiseName('ro\u200bb'), 'rob');
  assert.equal(sanitiseName('\u202ereversed'), 'reversed');
  assert.equal(sanitiseName('\u0000\u0007'), '');
  assert.equal(sanitiseName('   '), '');
});

test('a name cannot impersonate a wallet address', () => {
  assert.equal(sanitiseName('NQ22 JV9P 548B JL00 TRKS'), '');
  assert.equal(sanitiseName('nq22jv9p548bjl00trks'), '');
  // An ordinary word that merely starts with those letters is fine.
  assert.equal(sanitiseName('NQuick'), 'NQuick');
});

test('a capped name never splits a multi-byte character', () => {
  const name = sanitiseName('\u{1f525}'.repeat(20));
  assert.equal([...name].length, 16);
  assert.ok(!name.includes('\ufffd'));
});


test('the gate accepts a real mainnet transaction shape', () => {
  // Captured live from rpc.nimiqwatch.com. Note `to` arrives WITH spaces and
  // executionResult is a flat boolean, not the wrapped object the types imply.
  const live = {
    hash: 'd3b07384d113edec49eaa6238ad5ff00',
    blockNumber: 61_734_420,
    confirmations: 35_102,
    to: 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000',
    value: 295_886,
    fee: 0,
    recipientData: '',
    executionResult: true,
    networkId: 24,
  };
  // Derived, not hand-typed: the claim stores the flat form while the node
  // returns the spaced one, and counting 32 zeros by eye is how that test got
  // written wrong the first time.
  const forClaim = { token: '', recipient: normaliseAddress(live.to), valueLuna: 295_886 };
  assert.deepEqual(checkTx(live, forClaim, 24), { ok: true });
});

import { readTx, isRest } from '../src/verify.ts';

test('the REST explorer shape is read correctly, strings and all', () => {
  // Captured live from test-api.nimiq.watch. Every value is a string.
  const rest = {
    block_height: '11640375', hash: '5582ae19a470c39cfe05a8ae3d98f110d04519c1c553',
    sender_address: 'NQ04 4GVG UJ2G EC2K NYCL XBND F8PB QD4U AB6A', value: '360000', fee: '0',
    executed: 'True', timestamp: '1789603407',
    receiver_address: 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000',
    data: btoa('a1b2c3d4'), confirmations: '44595',
  };
  const tx = readTx(rest, 'rest', 5)!;
  assert.equal(tx.to, 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000');
  assert.equal(tx.value, 360_000);
  assert.equal(tx.blockNumber, 11_640_375);
  assert.equal(tx.confirmations, 44_595);
  assert.equal(tx.executionResult, true);
  assert.equal(tx.networkId, 5);
  assert.equal(hexToUtf8(tx.recipientData), 'a1b2c3d4');
});

test('a failed REST transaction is not mistaken for a success', () => {
  // Boolean("False") is true. This is the one that would have paid out on failures.
  const tx = readTx({ hash: 'x', receiver_address: 'NQ07', executed: 'False', value: '1' }, 'rest', 5)!;
  assert.equal(tx.executionResult, false);
  const rpcTx = readTx({ hash: 'x', to: 'NQ07', executionResult: false, value: 1, networkId: 24 }, 'rpc', 24)!;
  assert.equal(rpcTx.executionResult, false);
});

test('backend is picked from the URL', () => {
  assert.ok(isRest('https://test-api.nimiq.watch/api/v1'));
  assert.ok(isRest('https://api.nimiq.watch/api/v1/'));
  assert.ok(!isRest('https://rpc.nimiqwatch.com'));
});


test('a REST memo arrives as hex, not base64, and still matches the claim', () => {
  // The exact data field from the first real payment ever made to the app,
  // testnet, 17 Sep 2026. Decoding it as base64 turned the token into noise.
  const live = {
    hash: 'x', receiver_address: 'NQ05 L4NV YHX4 S8QV 4HT3 TVUU JE8D 2SHD BH2Y',
    value: '10000000', executed: 'True', confirmations: '87', block_height: '11685900',
    data: '65356564366633626266396631613763',
  };
  const tx = readTx(live, 'rest', 5)!;
  assert.equal(hexToUtf8(tx.recipientData), 'e5ed6f3bbf9f1a7c');
  const claim = { token: 'e5ed6f3bbf9f1a7c', recipient: live.receiver_address, valueLuna: 10_000_000 };
  assert.deepEqual(checkTx(tx, claim, 5), { ok: true });
});

import { hasProfanity } from '../src/moderate.ts';

test('the two messages that reached the board on device are now refused', () => {
  assert.ok(hasProfanity('shit'));
  assert.ok(hasProfanity('Fuck everyone'));
});

test('evasions are folded flat before matching', () => {
  for (const s of ['oh SHIT', 'sh1t happens', 's.h.i.t', 'shiiiit', 'f u c k this', 'what the f*ck']) {
    assert.ok(hasProfanity(s), `missed: ${s}`);
  }
});

test('ordinary words that merely contain a swear word pass', () => {
  for (const s of ['class dismissed', 'the assassin', 'shitake mushrooms', 'scunthorpe united', 'hell yeah', 'damn good', 'anyone up for lunch at 1?', 'Hello!!']) {
    assert.ok(!hasProfanity(s), `false positive: ${s}`);
  }
});


test('a poster called x is not profanity, and neither is the letter on its own', () => {
  // The list holds "xxx"; folding the list made that "x" and refused every
  // message whose author was called x, which is exactly how the probes were named.
  for (const s of ['x: anyone up for lunch at 1?', 'x marks the spot', 'Max: hello', 'x'])
    assert.ok(!hasProfanity(s), `false positive: ${s}`);
  assert.ok(hasProfanity('xxx'));
  assert.ok(hasProfanity('shiiiit'));
});
