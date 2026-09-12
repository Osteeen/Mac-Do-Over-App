import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Real files and the real no-overwrite addon. Runs against dist: `npm test` builds once first.
const root = fileURLToPath(new URL('..', import.meta.url));
if (!fs.existsSync(path.join(root, 'dist/main/executor/executor.js'))) throw new Error('dist is missing - run `npm test`, which builds before testing');
const require = createRequire(import.meta.url);
const { Journal, fileKey } = require(path.join(root, 'dist/main/journal/journal.js'));
const { Executor } = require(path.join(root, 'dist/main/executor/executor.js'));
const { systemMover } = require(path.join(root, 'dist/main/platform/move.js'));
const { LIMITS } = require(path.join(root, 'dist/shared/types.js'));
const needsMac = process.platform !== 'darwin' && 'needs the macOS no-overwrite addon';

function setup(opts) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdo-exec-')));
  for (const d of ['Desktop', 'Archive']) fs.mkdirSync(path.join(dir, d));
  const journal = new Journal();
  const ex = new Executor(journal, opts);
  const p = (...s) => path.join(dir, ...s);
  /** Make a file on the Desktop, move it into Archive for real, and record that move. */
  function mistake(name) {
    const a = p('Desktop', name), b = p('Archive', name);
    fs.writeFileSync(a, 'original ' + name);
    fs.renameSync(a, b);
    const st = fs.lstatSync(b, { bigint: true });
    journal.recordRelocation(fileKey(st.dev, st.ino), st.dev, st.ino, a, b, Date.now());
    return { a, b, ino: st.ino };
  }
  function approve(name, mode = 'original') {
    const snap = journal.freeze();
    const c = snap.candidates.find((x) => x.name === name);
    const sheet = ex.openApproval(snap.snapshotId, c.id);
    return { c, sheet, request: { candidateId: c.id, token: sheet.token, mode } };
  }
  return { p, journal, ex, mistake, approve, done() { journal.dispose(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('puts the file back and verifies it by inode', { skip: needsMac }, async () => {
  const s = setup();
  try {
    const f = s.mistake('Q3-report.pdf');
    const r = await s.ex.restore(s.approve('Q3-report.pdf').request);
    assert.equal(r.status, 'restored', JSON.stringify(r));
    assert.equal(fs.lstatSync(f.a, { bigint: true }).ino, f.ino);
    assert.equal(fs.existsSync(f.b), false);
    assert.equal(s.journal.freeze().candidates.length, 0, 'a restored candidate is retired');
  } finally { s.done(); }
});

test('a token works once', { skip: needsMac }, async () => {
  const s = setup();
  try {
    s.mistake('once.txt');
    const { request } = s.approve('once.txt');
    assert.equal((await s.ex.restore(request)).status, 'restored');
    assert.equal((await s.ex.restore(request)).reason, 'token_invalid');
  } finally { s.done(); }
});

test('a token issued for one file cannot move another', async () => {
  const s = setup();
  try {
    s.mistake('a.txt'); const other = s.mistake('b.txt');
    const { request } = s.approve('a.txt');
    const bId = s.journal.freeze().candidates.find((c) => c.name === 'b.txt').id;
    const r = await s.ex.restore({ ...request, candidateId: bId });
    assert.equal(r.reason, 'token_invalid');
    assert.ok(fs.existsSync(other.b), 'b.txt must not have moved');
  } finally { s.done(); }
});

test('an expired token is refused and nothing moves', async () => {
  let t = Date.now();
  const s = setup({ now: () => t });
  try {
    const f = s.mistake('late.txt');
    const { request } = s.approve('late.txt');
    t += LIMITS.approvalTokenMs + 1;
    assert.equal((await s.ex.restore(request)).reason, 'token_expired');
    assert.ok(fs.existsSync(f.b));
  } finally { s.done(); }
});

test('an occupied destination is refused and both files stay intact', { skip: needsMac }, async () => {
  const s = setup();
  try {
    const f = s.mistake('contract.pdf');
    fs.writeFileSync(f.a, 'impostor');
    const { sheet, request } = s.approve('contract.pdf');
    assert.equal(sheet.destinationOccupied, true);
    assert.equal(sheet.recoveredName, 'contract (recovered).pdf');
    assert.equal((await s.ex.restore(request)).reason, 'destination_occupied');
    assert.equal(fs.readFileSync(f.a, 'utf8'), 'impostor');
    assert.equal(fs.readFileSync(f.b, 'utf8'), 'original contract.pdf');
  } finally { s.done(); }
});

test('the move itself refuses an impostor that appears after the checks', { skip: needsMac }, async () => {
  let dstSeen = null;
  const racing = { supported: systemMover.supported, move: (src, dst) => { dstSeen = dst; fs.writeFileSync(dst, 'late impostor'); return systemMover.move(src, dst); } };
  const s = setup({ mover: racing });
  try {
    const f = s.mistake('race.pdf');
    const r = await s.ex.restore(s.approve('race.pdf').request);
    assert.equal(r.reason, 'destination_occupied', JSON.stringify(r));
    assert.equal(fs.readFileSync(dstSeen, 'utf8'), 'late impostor');
    assert.equal(fs.readFileSync(f.b, 'utf8'), 'original race.pdf');
    assert.equal(s.ex.incidents.length, 0);
  } finally { s.done(); }
});

test('put back as (recovered) leaves the occupying file untouched', { skip: needsMac }, async () => {
  const s = setup();
  try {
    const f = s.mistake('contract.pdf');
    fs.writeFileSync(f.a, 'impostor');
    const r = await s.ex.restore(s.approve('contract.pdf', 'recovered').request);
    assert.equal(r.status, 'restored', JSON.stringify(r));
    assert.equal(r.name, 'contract (recovered).pdf');
    assert.equal(fs.readFileSync(f.a, 'utf8'), 'impostor');
    assert.equal(fs.readFileSync(s.p('Desktop', 'contract (recovered).pdf'), 'utf8'), 'original contract.pdf');
  } finally { s.done(); }
});

test('a different file at the source is refused', async () => {
  const s = setup();
  try {
    const f = s.mistake('swap.txt');
    const { request } = s.approve('swap.txt');
    fs.unlinkSync(f.b); fs.writeFileSync(f.b, 'someone else');
    assert.equal((await s.ex.restore(request)).reason, 'source_changed');
    assert.equal(fs.readFileSync(f.b, 'utf8'), 'someone else');
    assert.equal(fs.existsSync(f.a), false);
  } finally { s.done(); }
});

test('a symlink at the source is refused', async () => {
  const s = setup();
  try {
    const f = s.mistake('link.txt');
    const { request } = s.approve('link.txt');
    fs.writeFileSync(s.p('Desktop', 'target.txt'), 'target');
    fs.unlinkSync(f.b); fs.symlinkSync(s.p('Desktop', 'target.txt'), f.b);
    assert.equal((await s.ex.restore(request)).reason, 'symlink');
  } finally { s.done(); }
});

test('a post-check mismatch is an incident, never a success, and halts later restores', async () => {
  const swapping = { supported: () => true, move: (src, dst) => { fs.writeFileSync(dst, 'swapped'); fs.unlinkSync(src); return { ok: true }; } };
  const s = setup({ mover: swapping });
  try {
    s.mistake('one.txt'); s.mistake('two.txt');
    const first = s.approve('one.txt'); const second = s.approve('two.txt');
    const r = await s.ex.restore(first.request);
    assert.equal(r.status, 'incident');
    assert.equal(s.ex.incidents.length, 1);
    assert.equal((await s.ex.restore(second.request)).reason, 'halted');
  } finally { s.done(); }
});

test('no move primitive means refusal, not a fallback', async () => {
  const s = setup({ mover: { supported: () => false, move: () => { throw new Error('must not be called'); } } });
  try {
    const f = s.mistake('nope.txt');
    assert.equal((await s.ex.restore(s.approve('nope.txt').request)).reason, 'unsupported_filesystem');
    assert.ok(fs.existsSync(f.b));
  } finally { s.done(); }
});
