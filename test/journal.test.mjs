import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Real files, a real watcher, a throwaway temp folder. Runs against dist: `npm test` builds once first,
// so parallel test files never race each other writing the build output.
const root = fileURLToPath(new URL('..', import.meta.url));
if (!fs.existsSync(path.join(root, 'dist/main/journal/journal.js'))) throw new Error('dist is missing - run `npm test`, which builds before testing');
const require = createRequire(import.meta.url);
const { Journal } = require(path.join(root, 'dist/main/journal/journal.js'));
const { startMoveDetector } = require(path.join(root, 'dist/main/journal/move-detector.js'));
const { nameFlags } = require(path.join(root, 'dist/shared/names.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await wait(50); }
  return fn();
}

async function sandbox(files) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdo-journal-')));
  for (const d of ['Desktop', 'Archive', 'Other']) fs.mkdirSync(path.join(dir, d));
  for (const f of files) fs.writeFileSync(path.join(dir, f), 'x');
  const journal = new Journal();
  const det = startMoveDetector({ roots: [dir], trash: null, source: 'environment', warnings: [] }, journal);
  await new Promise((r) => det.once('ready', r));
  const p = (...s) => path.join(dir, ...s);
  return { p, journal, async done() { await det.close(); journal.dispose(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const withCandidates = (j, n) => () => { const s = j.freeze(); return s.candidates.length >= n ? s : null; };

test('a move between folders becomes one file.move event and one candidate', async () => {
  const s = await sandbox(['Desktop/Q3-report.pdf']);
  try {
    fs.renameSync(s.p('Desktop/Q3-report.pdf'), s.p('Archive/Q3-report.pdf'));
    const snap = await until(withCandidates(s.journal, 1));
    assert.ok(snap, 'no candidate was produced');
    assert.equal(snap.events.filter((e) => e.kind === 'file.move').length, 1);
    const c = snap.candidates[0];
    assert.equal(c.name, 'Q3-report.pdf');
    assert.ok(c.from.endsWith('/Archive') && c.to.endsWith('/Desktop'), `${c.from} -> ${c.to}`);
    for (const k of ['ino', 'dev', 'absFrom', 'absTo', 'key']) assert.equal(k in c, false, `${k} leaked into the view`);
    assert.equal(s.journal.recordFor(snap.snapshotId, c.id).absTo, s.p('Desktop/Q3-report.pdf'));
  } finally { await s.done(); }
});

test('a rename in place is recorded for context and offers nothing to undo', async () => {
  const s = await sandbox(['Desktop/budget.xlsx']);
  try {
    fs.renameSync(s.p('Desktop/budget.xlsx'), s.p('Desktop/budget-2026.xlsx'));
    const snap = await until(() => { const x = s.journal.freeze(); return x.events.some((e) => e.kind === 'file.rename') ? x : null; });
    assert.ok(snap, 'rename was not recorded');
    assert.equal(snap.candidates.length, 0);
  } finally { await s.done(); }
});

test('our own restore is not logged as a new incident', async () => {
  const s = await sandbox(['Desktop/ours.txt', 'Desktop/theirs.txt']);
  try {
    const st = fs.lstatSync(s.p('Desktop/ours.txt'), { bigint: true });
    s.journal.expectOwnMove(st.dev, st.ino);
    fs.renameSync(s.p('Desktop/ours.txt'), s.p('Archive/ours.txt'));
    await wait(300);
    // A second, ordinary move proves the watcher was live, so the assertion below is not vacuous.
    fs.renameSync(s.p('Desktop/theirs.txt'), s.p('Archive/theirs.txt'));
    const snap = await until(withCandidates(s.journal, 1));
    assert.ok(snap, 'watcher never saw the ordinary move');
    await wait(300);
    const final = s.journal.freeze();
    assert.deepEqual(final.candidates.map((c) => c.name), ['theirs.txt']);
    assert.equal(final.events.filter((e) => e.kind === 'file.move').length, 1);
  } finally { await s.done(); }
});

test('a second move of the same file re-points the first candidate', async () => {
  const s = await sandbox(['Desktop/photos.zip']);
  try {
    fs.renameSync(s.p('Desktop/photos.zip'), s.p('Archive/photos.zip'));
    assert.ok(await until(withCandidates(s.journal, 1)));
    fs.renameSync(s.p('Archive/photos.zip'), s.p('Other/photos.zip'));
    const snap = await until(withCandidates(s.journal, 2));
    assert.ok(snap, 'second move not recorded');
    for (const c of snap.candidates) assert.ok(c.from.endsWith('/Other'), `candidate still points at ${c.from}`);
    assert.deepEqual(snap.candidates.map((c) => c.to.split('/').pop()).sort(), ['Archive', 'Desktop']);
  } finally { await s.done(); }
});

test('hostile names are flagged, ordinary ones are not', () => {
  const rlo = String.fromCharCode(0x202e);
  assert.deepEqual(nameFlags('invoice' + rlo + 'txt.exe'), ['bidi']);
  assert.deepEqual(nameFlags("Bob's notes & plans.txt"), []);
  assert.deepEqual(nameFlags('<script>.pdf'), ['markup']);
  assert.deepEqual(nameFlags('two' + String.fromCharCode(10) + 'lines.txt'), ['newline']);
});
