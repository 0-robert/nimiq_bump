import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  unwrap, toWalletError, isDeclined, call, init,
  looksLikeNimiqPay, shortAddress, formatClock, WalletError,
} from '../public/wallet.js';

test('a refusal that resolves is caught, not mistaken for a payment', async () => {
  const declined = { error: { type: 'PermissionDeniedError', message: 'User rejected' } };
  assert.throws(() => unwrap(declined), (e) => e.code === 'PERMISSION_DENIED');
  await assert.rejects(call(async () => declined), (e) => e.code === 'PERMISSION_DENIED');
});

test('a refusal that throws is caught the same way', async () => {
  await assert.rejects(
    call(async () => { throw Object.assign(new Error('User cancelled'), { name: 'PermissionDeniedError' }); }),
    (e) => e.code === 'PERMISSION_DENIED',
  );
});

test('a real failure is not reported as a refusal', async () => {
  await assert.rejects(
    call(async () => ({ error: { type: 'InvalidTransaction', message: 'insufficient funds' } })),
    (e) => e.code === 'INVALID_TX',
  );
});

test('a transaction hash passes straight through', async () => {
  const hash = 'a'.repeat(64);
  assert.equal(await call(async () => hash), hash);
});

test('refusal wording is matched loosely, since the type string is unspecified', () => {
  for (const word of ['rejected', 'declined', 'cancelled', 'denied', 'aborted', 'PermissionDenied']) {
    assert.ok(isDeclined(word), `${word} was not recognised as a refusal`);
  }
  assert.ok(!isDeclined('NetworkError', 'timed out'));
});

test('init resolves when the provider arrives late', async () => {
  const scope = {};
  setTimeout(() => { scope.nimiq = { ok: true }; }, 120);
  assert.deepEqual(await init({ timeout: 2000, scope }), { ok: true });
});

test('init gives up outside Nimiq Pay rather than hanging', async () => {
  await assert.rejects(init({ timeout: 60, scope: {} }), (e) => e.code === 'NO_PROVIDER');
});

test('the host is recognised by user agent before injection happens', () => {
  assert.ok(looksLikeNimiqPay({ navigator: { userAgent: 'Mozilla/5.0 NimiqPay/1.2' } }));
  assert.ok(looksLikeNimiqPay({ nimiqPay: {} }));
  assert.ok(!looksLikeNimiqPay({ navigator: { userAgent: 'Mozilla/5.0 Safari' } }));
});

test('display helpers', () => {
  assert.equal(shortAddress('NQ22 JV9P 548B JL00 TRKS GT1P X3QJ 52BV ENK3'), 'NQ22 JV9P ... ENK3');
  assert.equal(formatClock(300_000), '5:00');
  assert.equal(formatClock(61_000), '1:01');
  assert.equal(formatClock(-5), '0:00');
  // Hours show up only when there are any, so the close reads 4:07:22 then 7:22.
  assert.equal(formatClock(14_842_000), '4:07:22');
  assert.equal(formatClock(3_600_000), '1:00:00');
  assert.equal(formatClock(3_599_000), '59:59');
});
