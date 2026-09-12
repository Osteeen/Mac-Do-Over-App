import path from 'node:path';
import { TimeRing } from '../../shared/ring-buffer.js';
import { LIMITS, type Candidate, type CandidateRecord, type JournalEvent, type StripSnapshot } from '../../shared/types.js';
import { nameFlags } from '../../shared/names.js';
import { platform } from '../platform/index.js';

/** A file's identity: device plus inode. A string so bigint identities work as Map keys. */
export type FileKey = string;
export const fileKey = (dev: bigint, ino: bigint): FileKey => `${dev}:${ino}`;

type LiveRecord = CandidateRecord & { key: FileKey };
interface Frozen { at: number; records: Map<string, LiveRecord> }

/** Keep only the fields a screen or Find may see. A whitelist, so a new main-only field can never leak. */
function toView(c: CandidateRecord): Candidate {
  const { id, kind, name, from, to, observedAt, eventId, fromTrash } = c;
  return { id, kind, name, from, to, observedAt, eventId, fromTrash, nameFlags: [...c.nameFlags] };
}

/**
 * Observed events and the candidates they produce, in memory only and time-evicted.
 * Nothing here is written to disk.
 */
export class Journal {
  private readonly events = new TimeRing<JournalEvent>(LIMITS.journalMs);
  private readonly candidates = new Map<string, LiveRecord>();
  private readonly own = new Map<FileKey, number>();
  private readonly frozen = new Map<string, Frozen>();
  private seq = { e: 0, c: 0, s: 0 };

  recordFront(ts: number, appName: string, title: string): void {
    this.events.push({ id: `e${++this.seq.e}`, ts, kind: 'window.front', appName, title });
  }

  /** The executor calls this BEFORE it moves a file, so our own restore is not logged as a new incident. */
  expectOwnMove(dev: bigint, ino: bigint, ttlMs = 5_000): void {
    this.own.set(fileKey(dev, ino), Date.now() + ttlMs);
  }

  /** The file with identity `key` was at `oldPath` and is now at `newPath`. Called by the move detector. */
  recordRelocation(key: FileKey, dev: bigint, ino: bigint, oldPath: string, newPath: string, ts: number): void {
    const ownUntil = this.own.get(key);
    if (ownUntil !== undefined) {
      this.own.delete(key);
      if (ownUntil >= ts) { this.relocate(key, newPath); return; }
    }

    const name = path.basename(oldPath);
    if (path.dirname(oldPath) === path.dirname(newPath)) {
      // A rename in place: context for Find, never something to reverse.
      this.events.push({ id: `e${++this.seq.e}`, ts, kind: 'file.rename', name, newName: path.basename(newPath), dir: platform.displayPath(path.dirname(newPath)) });
      this.relocate(key, newPath, path.basename(newPath));
      return;
    }

    const eventId = `e${++this.seq.e}`;
    this.events.push({ id: eventId, ts, kind: 'file.move', name, from: platform.displayPath(path.dirname(oldPath)), to: platform.displayPath(path.dirname(newPath)) });
    // Earlier candidates for this same file now start from its new location (chain resolution).
    this.relocate(key, newPath);

    // A move out of the Trash is context only: "moving it back" would put it in the Trash.
    if (platform.isInTrash(oldPath)) return;

    const rec: LiveRecord = {
      id: `c${++this.seq.c}`, kind: 'move_back', name,
      from: platform.displayPath(path.dirname(newPath)),
      to: platform.displayPath(path.dirname(oldPath)),
      observedAt: ts, eventId, fromTrash: platform.isInTrash(newPath), nameFlags: nameFlags(name),
      // absTo is the original full path, so a Finder rename on the way into the Trash is undone too.
      ino, dev, absFrom: newPath, absTo: oldPath, key,
    };
    this.candidates.set(rec.id, rec);
  }

  /** Freeze what the user is about to read. The records behind it stay fixed until the snapshot expires. */
  freeze(now = Date.now()): StripSnapshot {
    this.prune(now);
    const live = [...this.candidates.values()].sort((a, b) => b.observedAt - a.observedAt);
    const snapshotId = `s${++this.seq.s}`;
    this.frozen.set(snapshotId, { at: now, records: new Map(live.map((c) => [c.id, { ...c }])) });
    for (const id of [...this.frozen.keys()].slice(0, -5)) this.frozen.delete(id);
    return { snapshotId, frozenAt: now, events: this.events.snapshot(now), candidates: live.map(toView) };
  }

  /** MAIN ONLY: the record behind a candidate in a frozen snapshot, or null if either is unknown. */
  recordFor(snapshotId: string, candidateId: string): CandidateRecord | null {
    return this.frozen.get(snapshotId)?.records.get(candidateId) ?? null;
  }

  /** Remove a candidate once it has been restored, or found to be stale. */
  retire(candidateId: string): void { this.candidates.delete(candidateId); }

  dispose(): void { this.events.dispose(); this.candidates.clear(); this.own.clear(); this.frozen.clear(); }

  private relocate(key: FileKey, newPath: string, renamedTo?: string): void {
    for (const [id, c] of this.candidates) {
      if (c.key !== key) continue;
      c.absFrom = newPath;
      c.from = platform.displayPath(path.dirname(newPath));
      c.fromTrash = platform.isInTrash(newPath);
      if (renamedTo) {
        // Keep the later rename: put it back under its current name, not the one it had before.
        c.name = renamedTo;
        c.nameFlags = nameFlags(renamedTo);
        c.absTo = path.join(path.dirname(c.absTo), renamedTo);
      }
      if (c.absFrom === c.absTo) this.candidates.delete(id);   // already back where it started
    }
  }

  private prune(now: number): void {
    const cutoff = now - LIMITS.journalMs;
    for (const [id, c] of this.candidates) if (c.observedAt < cutoff) this.candidates.delete(id);
    for (const [k, until] of this.own) if (until < now) this.own.delete(k);
    for (const [id, f] of this.frozen) if (f.at < cutoff) this.frozen.delete(id);
  }
}
