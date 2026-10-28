// Runs the private Pivot STK library test set (stk/library, git-ignored) through the importer,
// renderer and project loader, and compares the results with a saved baseline.
//
//   node tests/stk-corpus.mjs                    coverage report, plus changes since the baseline
//   node tests/stk-corpus.mjs --save-baseline    record the current results as the baseline
//   node tests/stk-corpus.mjs --list=changed     also list every changed figure (or newly|regressed|rejected)
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createFigureFromStk, decodeStk } from '../src/stk-import.js';
import { drawStkFigure, getStkArtworkBounds } from '../src/stk-renderer.js';
import { normaliseProject } from '../src/project.js';

const folder = new URL('../stk/library/', import.meta.url);
if (!fs.existsSync(new URL('catalogue.json', folder))) {
  console.log('No STK test set found at stk/library; nothing to do.');
  process.exit(0);
}
const args = new Set(process.argv.slice(2));
const listArg = [...args].find(arg => arg.startsWith('--list='))?.split('=')[1];
const catalogue = JSON.parse(fs.readFileSync(new URL('catalogue.json', folder), 'utf8'));
const baselineUrl = new URL('baseline.json', folder);
const hash = value => createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 16);

function recordingContext() {
  const calls = [];
  const state = { fillStyle: '#000000', strokeStyle: '#000000', lineCap: 'round', lineJoin: 'round', lineWidth: 1, globalAlpha: 1 };
  const context = new Proxy(state, {
    get(target, key) { return key in target ? target[key] : (...callArgs) => { calls.push([String(key), ...callArgs, target.fillStyle, target.strokeStyle, target.lineWidth, target.globalAlpha]); }; },
    set(target, key, value) { target[key] = value; return true; }
  });
  return { context, calls };
}

function formatOf(bytes) {
  const hex = value => value.toString(16).padStart(2, '0');
  try {
    const payload = zlib.inflateSync(bytes[0] === 0x78 ? bytes : bytes.subarray(1));
    return `0x${hex(bytes[0])}/${hex(payload[0])}`;
  } catch { return `0x${hex(bytes[0])}/raw`; }
}

const results = {};
for (const entry of catalogue) {
  const bytes = fs.readFileSync(new URL(`${entry.id}.stk`, folder));
  const result = { name: entry.name, version: entry.version, format: formatOf(bytes) };
  try {
    const decoded = await decodeStk(new Uint8Array(bytes));
    const figure = createFigureFromStk(decoded, { x: 400, y: 300, id: 'corpus' });
    const { context, calls } = recordingContext();
    drawStkFigure({ context, figure });
    const bounds = getStkArtworkBounds(figure);
    normaliseProject(JSON.parse(JSON.stringify({ version: 5, name: 'Corpus', width: 800, height: 500, fps: 12, frames: [[figure]], delays: [1], currentFrameIndex: 0, groups: [], settings: {} })));
    const painted = calls.some(call => call[0] === 'stroke' || call[0] === 'fill');
    const invalid = calls.some(call => call.some(value => typeof value === 'number' && !Number.isFinite(value)));
    result.outcome = !painted ? 'suspicious: paints nothing' : invalid ? 'suspicious: invalid coordinates' : !bounds ? 'suspicious: no bounds' : 'imports';
    result.decoded = hash(decoded);
    result.drawing = hash(calls);
  } catch (error) {
    const message = String(error?.message || error);
    result.outcome = message.startsWith('STK import rejected:') ? 'rejected' : 'CRASH';
    result.error = message;
  }
  results[entry.id] = result;
}

const all = Object.entries(results);
const tally = list => list.reduce((counts, [, r]) => (counts[r.outcome] = (counts[r.outcome] || 0) + 1, counts), {});
const importing = all.filter(([, r]) => r.outcome === 'imports').length;
console.log(`STK library: ${importing} of ${all.length} figures import (${Math.round(importing / all.length * 100)}%)`);
for (const version of ['2', '3', '4', '5']) {
  const subset = all.filter(([, r]) => r.version === version);
  if (subset.length) console.log(`  Pivot ${version}: ${subset.filter(([, r]) => r.outcome === 'imports').length} of ${subset.length}`, JSON.stringify(tally(subset)));
}
const reasons = {};
for (const [, r] of all.filter(([, r]) => r.outcome !== 'imports')) {
  const reason = `${r.format}  ${(r.error || r.outcome).replace('STK import rejected: ', '').replace(/\d+(\.\d+)?/g, 'N')}`;
  reasons[reason] = (reasons[reason] || 0) + 1;
}
console.log('Not importing (top reasons):');
Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([reason, count]) => console.log(`  ${String(count).padStart(4)}  ${reason}`));
const crashes = all.filter(([, r]) => r.outcome === 'CRASH' || r.outcome.startsWith('suspicious'));
if (crashes.length) console.log('CRASHES OR SUSPICIOUS IMPORTS:', crashes.map(([id, r]) => `${id} ${r.name}: ${r.error || r.outcome}`).join('\n  '));

if (args.has('--save-baseline')) {
  fs.writeFileSync(baselineUrl, JSON.stringify(results));
  console.log('Baseline saved to stk/library/baseline.json');
} else if (fs.existsSync(baselineUrl)) {
  const baseline = JSON.parse(fs.readFileSync(baselineUrl, 'utf8'));
  const groups = { newly: [], regressed: [], changed: [], rejected: [] };
  for (const [id, now] of all) {
    const before = baseline[id];
    if (!before) continue;
    const wasOk = before.outcome === 'imports', isOk = now.outcome === 'imports';
    if (!wasOk && isOk) groups.newly.push(id);
    else if (wasOk && !isOk) groups.regressed.push(id);
    else if (wasOk && isOk && (before.decoded !== now.decoded || before.drawing !== now.drawing)) groups.changed.push(id);
    else if (!isOk && before.error !== now.error) groups.rejected.push(id);
  }
  console.log(`Since baseline: ${groups.newly.length} newly importing, ${groups.regressed.length} REGRESSED, ${groups.changed.length} imported figures changed output, ${groups.rejected.length} rejections changed reason`);
  if (groups.regressed.length) console.log('  REGRESSED:', groups.regressed.map(id => `${id} ${results[id].name}: ${results[id].error || results[id].outcome}`).join('\n    '));
  if (listArg && groups[listArg]) console.log(`  ${listArg}:`, groups[listArg].map(id => `${id} ${results[id].name} [${results[id].format}]`).join(', '));
  if (groups.regressed.length || crashes.length) process.exitCode = 1;
}
