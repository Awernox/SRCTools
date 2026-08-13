/**
 * Lists catalogue keys present in `en.ts` but absent from ru/uk/es.
 *
 * A developer tool, not part of the app or the bundle. A missing key is not a
 * compile error — the translator falls back to English on purpose, so nothing
 * ever renders blank — which is exactly why it needs reporting.
 *
 * Run with: node scripts/missing-keys.mjs [ru|uk|es]
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const I18N = join(ROOT, 'src', 'i18n');

/** Top-level quoted keys of the catalogue object, in file order. */
function keysOf(file) {
  const source = readFileSync(join(I18N, `${file}.ts`), 'utf8');
  const keys = [];
  for (const match of source.matchAll(/^ {2}'([^']+)':/gm)) keys.push(match[1]);
  return keys;
}

const en = keysOf('en');
const wanted = process.argv[2];
const targets = wanted === undefined ? ['ru', 'uk', 'es'] : [wanted];

for (const lang of targets) {
  const have = new Set(keysOf(lang));
  const missing = en.filter((key) => !have.has(key));
  console.log(`\n${lang}: ${missing.length} missing of ${en.length}`);
  for (const key of missing) console.log(`  ${key}`);
}
