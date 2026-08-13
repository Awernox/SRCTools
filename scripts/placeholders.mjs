/**
 * Checks that every translated string uses exactly the placeholders English does.
 *
 * A developer tool, like its neighbours. Nothing here ships.
 *
 * This is not cosmetic. `interpolate` leaves a `{placeholder}` it was given no
 * value for exactly where it stands, so a key that says `{count}` where English
 * says `{runs}` renders the literal braces on screen — in one language only,
 * which is precisely the kind of thing nobody notices for months. TypeScript
 * cannot catch it: the catalogues are strings, and the key is spelled right.
 *
 * Run with: node scripts/placeholders.mjs
 * Exits non-zero if anything disagrees.
 */

import { parse, unquote } from './missing-text.mjs';

/** Every `{name}` in a string, as a sorted, de-duplicated list. */
function marks(text) {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
}

const en = new Map(
  parse('en')
    .filter((item) => item.kind === 'entry')
    .map((item) => [item.key, marks(unquote(item.raw))]),
);

let bad = 0;
for (const lang of ['ru', 'uk', 'es']) {
  for (const item of parse(lang)) {
    if (item.kind !== 'entry') continue;
    const want = en.get(item.key);
    // A key English does not define is a language-only plural form, which is
    // allowed: `unit.run.few` exists because Russian needs it.
    if (!want) continue;
    const have = marks(unquote(item.raw));
    if (have.join() === want.join()) continue;
    bad += 1;
    console.log(`${lang} ${item.key}`);
    console.log(`   en: {${want.join('} {')}}`);
    console.log(`   ${lang}: ${have.length ? `{${have.join('} {')}}` : '(none)'}`);
  }
}

console.log(bad === 0 ? 'placeholders: all agree' : `placeholders: ${bad} disagree`);
process.exit(bad === 0 ? 0 : 1);
