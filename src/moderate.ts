/**
 * Message screening.
 *
 * Runs before the wallet is ever opened, so a blocked message costs nobody
 * anything. The competition rules disqualify apps carrying hate speech, sexual
 * content or scams, and this slot is the first thing anyone sees.
 */

const SAFE_MODEL = '@cf/meta/llama-guard-3-8b';

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
