/**
 * Screen every user-facing string for AI writing patterns.
 *
 * Covers the markup, the runtime strings buried in JS and TS, and the
 * submission copy. The runtime strings are the ones that drift: they get added
 * one at a time while fixing something else, and never make it into a document
 * anyone thinks to re-read.
 *
 * Exits non-zero if anything is flagged, so it can gate a commit.
 */

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DETECTOR = '../.claude/skills/avoid-ai-writing/bin/avoid-ai-writing.js';

const strip = (html) =>
  html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&mdash;|&amp;|&middot;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Pull the strings a person actually reads out of source files. */
function runtimeStrings(files) {
  const found = [];
  const patterns = [
    /say\(\s*[`'"](.+?)[`'"]/gs,
    /textContent\s*=\s*[`'"]([^`'"]{4,})[`'"]/g,
    /fail\([^,]+,\s*'[^']+',\s*[`'"](.+?)[`'"]/g,
    /reason:\s*'([^']{10,})'/g,
    /placeholder="([^"]+)"/g,
  ];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      for (const match of src.matchAll(pattern)) found.push(match[1]);
    }
  }
  const seen = new Set();
  return found
    .map((s) => s.replace(/\$\{[^}]+\}/g, 'X').trim())
    .filter((s) => s.length > 3 && !seen.has(s) && seen.add(s));
}

const dir = mkdtempSync(join(tmpdir(), 'bump-copy-'));
const targets = [
  ['markup', strip(readFileSync('public/index.html', 'utf8'))],
  ['runtime strings', runtimeStrings(['public/app.js', 'public/preview.js', 'src/slot.ts', 'src/moderate.ts']).join('\n')],
  ['description', readFileSync('copy/description.txt', 'utf8')],
  ['builder story', readFileSync('copy/builder-story.txt', 'utf8')],
  ['readme', readFileSync('README.md', 'utf8')],
];

let failed = 0;
for (const [label, text] of targets) {
  const path = join(dir, `${label.replace(/\s+/g, '-')}.txt`);
  writeFileSync(path, text);
  const result = JSON.parse(execFileSync('node', [DETECTOR, path], { encoding: 'utf8' }));

  // Em dashes inside fenced code and markdown table rules are typography, not
  // prose, and the detector counts them without that context.
  const issues = result.issues.filter((i) => i.type !== 'em-dash');
  const words = String(result.stats.wordCount).padStart(4);

  console.log(
    `${label.padEnd(17)} ${words}w  score ${String(result.score).padEnd(3)} ` +
    `${result.label.padEnd(10)} ${issues.length ? `FLAGGED: ${issues.map((i) => i.type).join(', ')}` : 'clean'}`,
  );
  for (const issue of issues) console.log(`    ${issue.type}: ${JSON.stringify(issue.text ?? '').slice(0, 70)}`);
  if (issues.length) failed++;
}

// The submission form caps the description at 250 words.
const descriptionWords = readFileSync('copy/description.txt', 'utf8').trim().split(/\s+/).length;
console.log(`\ndescription is ${descriptionWords} words (limit 250)${descriptionWords > 250 ? '  OVER' : ''}`);
if (descriptionWords > 250) failed++;

process.exit(failed ? 1 : 0);
