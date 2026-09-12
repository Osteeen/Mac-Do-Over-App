import { LIMITS, type FindPayload, type FindPreview, type JournalEvent, type StripSnapshot } from '../../shared/types.js';

/** Shown in the preview, in plain words, next to what IS sent. */
export const NOT_SENT = [
  'Any picture of your screen',
  'What is inside your files',
  'Anything you typed except this sentence',
  'Full disk paths of the files on this list',
];

export const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';

/** Whitespace collapsed, trimmed, capped. */
export function normalizeReference(reference: unknown): string {
  if (typeof reference !== 'string') return '';
  return reference.replace(/\s+/g, ' ').trim().slice(0, LIMITS.referenceMaxChars);
}

/** Field whitelist per event kind, so anything added to the journal later cannot ride along to the network. */
function copyEvent(e: JournalEvent): JournalEvent | null {
  switch (e.kind) {
    case 'file.move': return { id: e.id, ts: e.ts, kind: e.kind, name: e.name, from: e.from, to: e.to };
    case 'file.rename': return { id: e.id, ts: e.ts, kind: e.kind, name: e.name, newName: e.newName, dir: e.dir };
    case 'window.front': return { id: e.id, ts: e.ts, kind: e.kind, appName: e.appName, title: e.title };
    default: return null;
  }
}

/**
 * Exactly what leaves the Mac. Deterministic for a given snapshot and reference (`now` is the
 * snapshot's freeze time), so the payload sent is byte-for-byte the payload previewed.
 */
export function buildPayload(snap: StripSnapshot, reference: unknown): FindPayload {
  return {
    now: snap.frozenAt,
    timeline: snap.events.map(copyEvent).filter((e): e is JournalEvent => e !== null),
    candidates: snap.candidates.map(({ id, kind, name, from, to, observedAt }) => ({ id, kind, name, from, to, observedAt })),
    reference: normalizeReference(reference),
  };
}

export function buildPreview(snap: StripSnapshot, reference: unknown, model = DEFAULT_MODEL): FindPreview {
  const payload = buildPayload(snap, reference);
  return {
    snapshotId: snap.snapshotId,
    provider: 'OpenAI',
    model,
    bytes: Buffer.byteLength(JSON.stringify(payload)),
    eventCount: payload.timeline.length,
    candidateCount: payload.candidates.length,
    notSent: [...NOT_SENT],
    payload,
  };
}
