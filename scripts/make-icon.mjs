/**
 * Builds the SRCTools brand assets from the source logo artwork.
 *
 *   node scripts/make-icon.mjs <source.png> <out.png> [size] [--plate=#0A0A0B]
 *
 * Without `--plate` the output is a white mark on transparency, used inside the
 * app where it sits on themed surfaces. With `--plate` the mark is composited
 * onto a rounded dark square — the form the Windows executable, taskbar and
 * installer icons need, since a bare white mark disappears on light chrome.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { decodePng, encodePng, extractMark, centreOnSquare, roundedPlate } from './png.mjs';

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const [srcPath, outPath, sizeArg] = args.filter((a) => !a.startsWith('--'));

if (!srcPath || !outPath) {
  console.error('usage: node make-icon.mjs <source.png> <out.png> [size] [--plate=#0A0A0B]');
  process.exit(1);
}

const size = Number(sizeArg || 1024);
const plateFlag = flags.find((f) => f.startsWith('--plate'));
const plateColour = plateFlag ? plateFlag.split('=')[1] || '#0A0A0B' : null;

const mark = extractMark(decodePng(readFileSync(srcPath)));
// A plated icon needs more breathing room inside the rounded square than a
// bare mark does, hence the lower coverage.
const coverage = plateColour ? 0.6 : 0.78;
const result = centreOnSquare(mark, size, coverage, plateColour ? roundedPlate(plateColour) : null);

writeFileSync(outPath, encodePng(size, size, result.rgba));
console.log(
  `wrote ${outPath} — ${size}x${size}, mark ${result.markWidth}x${result.markHeight}` +
    (plateColour ? `, plate ${plateColour}` : ', transparent'),
);
