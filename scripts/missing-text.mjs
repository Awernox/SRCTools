/**
 * Dumps the English source text of every key a language is missing.
 *
 * A developer tool, like its neighbours: it exists so the strings that still need
 * translating can be read in one place, in catalogue order, with their section
 * comments for context. Nothing here ships.
 *
 * Run with: node scripts/missing-text.mjs [ru|uk|es]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const I18N = join(ROOT, 'src', 'i18n');

/** Splits a catalogue body into comment blocks and `key: value` entries. */
export function parse(file) {
  const source = readFileSync(join(I18N, `${file}.ts`), 'utf8');
  const body = source.slice(source.indexOf('= {') + 3, source.lastIndexOf('};'));
  const items = [];
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*\/\//.test(line)) {
      items.push({ kind: 'comment', text: line.trimEnd() });
      continue;
    }
    const start = line.match(/^ {2}'([^']+)':(.*)$/);
    if (!start) continue;
    const key = start[1];
    let raw = start[2].trim();
    // A long value sits on the following line, and may wrap again.
    while (!raw.endsWith(',') || raw === ',') {
      i += 1;
      raw = `${raw} ${lines[i].trim()}`.trim();
    }
    items.push({ kind: 'entry', key, raw: raw.replace(/,$/, '') });
  }
  return items;
}

/** `'a' + "b"` → the string it denotes. Only the two quote styles are used. */
export function unquote(raw) {
  return raw
    .split(/\s*\+\s*/)
    .map((part) => part.trim().replace(/^['"]/, '').replace(/['"]$/, ''))
    .join('');
}

// Only when run directly: `placeholders.mjs` imports the parser above and has no
// business writing dump files as a side effect of that.
const invoked = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

const en = invoked ? parse('en') : [];
const targets = process.argv[2] ? [process.argv[2]] : ['ru', 'uk', 'es'];

for (const lang of invoked ? targets : []) {
  const have = new Set(parse(lang).filter((i) => i.kind === 'entry').map((i) => i.key));
  const out = [];
  let heading = '';
  for (const item of en) {
    if (item.kind === 'comment') {
      heading = item.text;
      continue;
    }
    if (have.has(item.key)) continue;
    if (heading) {
      out.push('');
      out.push(heading);
      heading = '';
    }
    out.push(`${item.key} = ${unquote(item.raw)}`);
  }
  const path = join(ROOT, 'scripts', `.tmp-missing-${lang}.txt`);
  writeFileSync(path, `${out.join('\n')}\n`, 'utf8');
  console.log(`${lang}: ${out.filter((l) => l.includes(' = ')).length} → ${path}`);
}
