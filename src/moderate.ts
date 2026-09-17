/**
 * Message screening.
 *
 * Runs before the wallet is ever opened, so a blocked message costs nobody
 * anything. The competition rules disqualify apps carrying hate speech, sexual
 * content or scams, and this slot is the first thing anyone sees.
 */

import { PROFANITY } from './profanity.ts';

const SAFE_MODEL = '@cf/meta/llama-guard-3-8b';

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i' };

/**
 * Fold the usual evasions flat: sh1t, s.h.i.t, shiiit, S H I T. The list is
 * folded the same way when the pattern is built, so both sides agree.
 */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[0134578@$!]/g, (c) => LEET[c] ?? c)
    // A single separator between letters that are being spelled out one at a time.
    .replace(/(?<=[a-z])[\s.\-_*](?=[a-z](?:[\s.\-_*][a-z])+)/g, '')
    .replace(/(.)\1{2,}/g, '$1');
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One pattern for the whole list. Whole words and phrases only, bounded by
 * anything that is not a letter or digit, so "class", "assassin" and
 * "shitake" pass while "shit" does not.
 */
const PROFANE = new RegExp(
  `(?<![a-z0-9])(?:${[...new Set(PROFANITY.map(normalise))].map(escape).join('|')})(?![a-z0-9])`,
);

/**
 * Llama Guard classifies harm, not language: a threat is unsafe to it, "shit"
 * is not, and both "shit" and "Fuck everyone" reached the board on device.
 * Plain swearing is refused here, cheaply, before the model is asked.
 */
export function hasProfanity(text: string): boolean {
  return PROFANE.test(normalise(text));
}

/** Caught before the model runs, because these are not worth a round trip. */
const OBVIOUS = [
  /\b(?:seed\s*phrase|private\s*key|recovery\s*phrase)\b/i,
  /\b(?:airdrop|giveaway)\b.{0,40}\b(?:claim|connect|verify)\b/i,
  /\bconnect\s+(?:your\s+)?wallet\b/i,
  /\bhttps?:\/\/(?!nimiq\.com|miniappscompetition\.com)/i,
];

export interface Verdict {
  ok: boolean;
  reason: string;
}

export async function screen(env: Env, message: string): Promise<Verdict> {
  if (OBVIOUS.some((pattern) => pattern.test(message))) {
    return { ok: false, reason: 'Links and wallet requests are not allowed.' };
  }
  if (hasProfanity(message)) {
    return { ok: false, reason: 'Keep it clean. Nothing was paid.' };
  }

  if (!env.AI) return { ok: true, reason: '' };

  try {
    const result = await env.AI.run(SAFE_MODEL, {
      messages: [{ role: 'user', content: message }],
    });

    const verdict = String((result as { response?: string })?.response ?? '').toLowerCase();
    if (verdict.includes('unsafe')) {
      return { ok: false, reason: 'That message was rejected. Try different wording.' };
    }
    return { ok: true, reason: '' };
  } catch {
    // If the classifier is unavailable, the obvious patterns above still applied.
    // Blocking every message during an outage would take the app down with it.
    return { ok: true, reason: '' };
  }
}
