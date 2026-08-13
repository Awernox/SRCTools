/**
 * Reports user-facing English text that never reaches the catalogues.
 *
 * A developer tool, not part of the app or the bundle. Two things are looked
 * for: string literals in props that render as text (label, title, hint,
 * placeholder, aria-label, detail, message) and bare JSX text nodes. Both are
 * reported with file and line so they can be replaced with a `t()` call.
 *
 * The whole file is scanned at once rather than line by line: JSX text is
 * routinely wrapped across lines by the formatter, and a per-line scan misses
 * every one of those.
 *
 * Run with: node scripts/find-untranslated.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SRC = join(ROOT, 'src');

/** Props and object fields whose string value is shown to the user. */
const TEXT_PROPS =
  /\b(label|title|hint|detail|description|placeholder|aria-label|message|heading|subtitle|caption|tooltip|summary|confirmLabel|text|reason|name)\s*[=:]\s*(["'])([^"'\n]{3,})\2/g;

/**
 * Bare text between tags, possibly wrapped across lines: `>Some words<`.
 *
 * Deliberately greedy with a single character class and no surrounding `\s*`:
 * the obvious `>\s*(...)\s*<` spelling is ambiguous and backtracks for seconds
 * on a 2000-line file. Trimming afterwards is both faster and clearer.
 */
const JSX_TEXT = /(?<![=!<>-])>([^<>{}]+)</g;

/** Quoted English-looking strings passed to functions (toasts, menu entries). */
const CALL_STRING = /(?:^|[({,[]\s*)(["'])([A-Z][a-z]+(?: [^"'\n]{2,})+?)\1/gm;

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walk(path);
    } else if (/\.tsx?$/.test(entry) && !path.includes(join('src', 'i18n'))) {
      files.push(path);
    }
  }
})(SRC);

/** Blanks comments, keeping byte offsets so line numbers stay right. */
function maskComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length));
}

const lineOf = (source, index) => source.slice(0, index).split('\n').length;

/**
 * True for a JSX-text match that is really code.
 *
 * The text pass cannot mask `{...}` first — in a `.tsx` file that would blank
 * every function body and with it all the JSX inside. Instead the character
 * class already excludes braces, which rules out `{t('key')}`, and this rules
 * out the remaining noise: generics, comparisons and type annotations.
 */
function looksLikeCode(value) {
  return /[=;()[\]]|&&|\|\||=>|\bextends\b|\bkeyof\b/.test(value);
}

let total = 0;
for (const file of files.sort()) {
  const source = readFileSync(file, 'utf8');
  const code = maskComments(source);
  const hits = new Map();

  const add = (index, what) => {
    const line = lineOf(source, index);
    if (!hits.has(line)) hits.set(line, new Set());
    hits.get(line).add(what);
  };

  for (const match of code.matchAll(TEXT_PROPS)) {
    const value = match[3];
    if (/^[a-z0-9-]+$/.test(value) || /^(var\(|calc\(|#|\d|https?:)/.test(value)) continue;
    add(match.index, `${match[1]}="${value}"`);
  }

  for (const match of code.matchAll(JSX_TEXT)) {
    const value = match[1].replace(/\s+/g, ' ').trim();
    if (value.length < 3 || !/^[A-Z]/.test(value) || !/[A-Za-z]{3}/.test(value)) continue;
    if (looksLikeCode(value)) continue;
    add(match.index, `text: ${value}`);
  }

  for (const match of code.matchAll(CALL_STRING)) {
    add(match.index, `string: ${match[2]}`);
  }

  if (hits.size > 0) {
    const count = [...hits.values()].reduce((sum, set) => sum + set.size, 0);
    total += count;
    console.log(`\n${relative(ROOT, file)}  (${count})`);
    for (const line of [...hits.keys()].sort((a, b) => a - b)) {
      for (const what of hits.get(line)) console.log(`  ${line}: ${what}`);
    }
  }
}

console.log(`\n${total} candidate(s) in ${files.length} file(s).`);
