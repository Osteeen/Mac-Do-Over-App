import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Pure logic plus an injected fetch: runs on any OS, never calls the network. `npm test` builds first.
const root = fileURLToPath(new URL('..', import.meta.url));
if (!fs.existsSync(path.join(root, 'dist/main/find/find.js'))) throw new Error('dist is missing - run `npm test`, which builds before testing');
const require = createRequire(import.meta.url);
const { buildPayload, buildPreview } = require(path.join(root, 'dist/main/find/payload.js'));
const { validateAnswer } = require(path.join(root, 'dist/main/find/validate.js'));
const { runFind } = require(path.join(root, 'dist/main/find/find.js'));
const examples = JSON.parse(fs.readFileSync(path.join(root, 'src/shared/examples.json'), 'utf8'));
const snap = () => structuredClone(examples.stripSnapshot);
const KEY = 'test-key-not-real';

const answer = (matches, caveats = []) => ({ matches, caveats });
const okFetch = (body, seen = {}) => async (url, init) => {
  seen.url = url; seen.init = init;
  return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(body) }) };
};

test('the payload carries only whitelisted fields and no disk paths', () => {
  const s = snap();
  s.candidates[0].ino = '123'; s.candidates[0].absFrom = '/Users/someone/Desktop/x';
  s.events[0].absPath = '/Users/someone/secret';
  const p = buildPayload(s, '  the   document I moved  ');
  const text = JSON.stringify(p);
  assert.ok(!text.includes('/Users/'), 'an absolute path reached the payload');
  assert.ok(!text.includes('ino'), 'an inode reached the payload');
  assert.deepEqual(Object.keys(p.candidates[0]).sort(), ['from', 'id', 'kind', 'name', 'observedAt', 'to']);
  assert.equal(p.reference, 'the document I moved');
  assert.equal(p.now, s.frozenAt);
});

test('the payload sent is exactly the payload previewed', () => {
  const s = snap();
  const preview = buildPreview(s, 'the document I moved before I opened the browser');
  assert.deepEqual(buildPayload(s, 'the document I moved before I opened the browser'), preview.payload);
  assert.equal(preview.bytes, Buffer.byteLength(JSON.stringify(preview.payload)));
  assert.ok(preview.notSent.some((x) => x.includes('picture of your screen')));
});

test('the reference is capped', () => {
  assert.equal(buildPayload(snap(), 'x'.repeat(5000)).reference.length, 200);
});

test('validation accepts one match and several', () => {
  const s = snap();
  assert.equal(validateAnswer(answer([{ action_id: 'c1', why: 'moved before Chrome', evidence_event_ids: ['e1', 'e4'] }]), s).status, 'matched');
  const two = validateAnswer(answer([
    { action_id: 'c1', why: 'a', evidence_event_ids: ['e1'] },
    { action_id: 'c2', why: 'b', evidence_event_ids: ['e3'] },
  ], ['both went into an Archive folder']), s);
  assert.equal(two.status, 'matched');
  assert.equal(two.matches.length, 2);
});

test('an invented candidate, an invented event, or a match without evidence makes the whole answer invalid', () => {
  const s = snap();
  assert.equal(validateAnswer(answer([{ action_id: 'c9', why: 'x', evidence_event_ids: ['e1'] }]), s).status, 'invalid');
  assert.equal(validateAnswer(answer([
    { action_id: 'c1', why: 'x', evidence_event_ids: ['e1'] },
    { action_id: 'c2', why: 'x', evidence_event_ids: ['e99'] },
  ]), s).status, 'invalid');
  assert.equal(validateAnswer(answer([{ action_id: 'c1', why: 'x', evidence_event_ids: [] }]), s).status, 'invalid');
  assert.equal(validateAnswer({ matches: 'nope' }, s).status, 'invalid');
});

test('zero matches is an honest no_match', () => {
  const r = validateAnswer(answer([], ['Nothing was recorded about what is inside a file.']), snap());
  assert.equal(r.status, 'no_match');
  assert.equal(r.caveats.length, 1);
});

test('runFind sends the strict schema and the previewed payload, and never echoes the key', async () => {
  const s = snap(); const seen = {};
  const ref = 'the document I moved before I opened the browser';
  const r = await runFind(s, ref, { apiKey: KEY, fetchImpl: okFetch(answer([{ action_id: 'c1', why: 'moved before Chrome', evidence_event_ids: ['e1', 'e4'] }]), seen) });
  assert.equal(r.status, 'matched');
  assert.equal(seen.url, 'https://api.openai.com/v1/responses');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.text.format.strict, true);
  assert.deepEqual(JSON.parse(body.input[1].content), buildPreview(s, ref).payload);
  assert.equal(seen.init.headers.authorization, `Bearer ${KEY}`);
  assert.ok(!JSON.stringify(r).includes(KEY));
});

test('no connection, a timeout and an HTTP error each come back as results, not exceptions', async () => {
  const s = snap(); const ref = 'the pdf';
  assert.equal((await runFind(s, ref, { apiKey: KEY, fetchImpl: async () => { throw new TypeError('fetch failed'); } })).status, 'offline');
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  assert.equal((await runFind(s, ref, { apiKey: KEY, fetchImpl: hang, timeoutMs: 30 })).status, 'timeout');
  assert.equal((await runFind(s, ref, { apiKey: KEY, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) })).status, 'error');
  assert.equal((await runFind(s, ref, { apiKey: KEY, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ output_text: 'not json' }) }) })).status, 'invalid');
});

test('nothing is sent without a key, a reference, or anything to put back', async () => {
  let calls = 0; const counting = async () => { calls++; throw new Error('must not be called'); };
  assert.equal((await runFind(snap(), 'the pdf', { apiKey: null, fetchImpl: counting })).status, 'error');
  assert.equal((await runFind(snap(), '   ', { apiKey: KEY, fetchImpl: counting })).status, 'error');
  const empty = snap(); empty.candidates = [];
  assert.equal((await runFind(empty, 'the pdf', { apiKey: KEY, fetchImpl: counting })).status, 'no_match');
  assert.equal(calls, 0);
});
