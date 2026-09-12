import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LIMITS, type ApprovalSheet, type RefusalReason, type RestoreRequest, type RestoreResult } from '../../shared/types.js';
import type { Journal } from '../journal/journal.js';
import { systemMover, type Mover } from '../platform/move.js';

interface Approval { snapshotId: string; candidateId: string; expiresAt: number }
export interface Incident { at: number; candidateId: string; expected: string; found: string }
export interface ExecutorOptions { now?: () => number; mover?: Mover }

function lstatBig(p: string): fs.BigIntStats | null {
  try { return fs.lstatSync(p, { bigint: true }); } catch { return null; }
}

/** "name (recovered).ext", then "name (recovered 2).ext" and so on. Null if twenty are taken. */
export function recoveredPath(abs: string): string | null {
  const dir = path.dirname(abs);
  const ext = path.extname(abs);
  const stem = path.basename(abs, ext);
  for (let i = 1; i <= 20; i++) {
    const p = path.join(dir, `${stem} (recovered${i > 1 ? ` ${i}` : ''})${ext}`);
    if (!lstatBig(p)) return p;
  }
  return null;
}

/**
 * The only code that moves a user's file.
 *
 * Every restore needs a single-use, expiring token issued for one candidate. Restores run one at a
 * time. Identity is checked before the move and verified by inode after it. The move itself is one
 * operation that cannot overwrite; the checks before it exist for clear messages, not for safety.
 * A post-check mismatch is an incident: recorded, reported, never called a success, never rolled
 * back, and every later restore is refused until the app restarts.
 */
export class Executor {
  private readonly approvals = new Map<string, Approval>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly mover: Mover;
  readonly incidents: Incident[] = [];

  constructor(private readonly journal: Journal, opts: ExecutorOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.mover = opts.mover ?? systemMover;
  }

  /** Issue a single-use token for one candidate in one frozen snapshot. Null if either is unknown. */
  openApproval(snapshotId: string, candidateId: string): ApprovalSheet | null {
    const rec = this.journal.recordFor(snapshotId, candidateId);
    if (!rec) return null;
    const now = this.now();
    for (const [t, a] of this.approvals) if (a.expiresAt < now) this.approvals.delete(t);
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = now + LIMITS.approvalTokenMs;
    this.approvals.set(token, { snapshotId, candidateId, expiresAt });
    const occupied = lstatBig(rec.absTo) !== null;
    const recovered = occupied ? recoveredPath(rec.absTo) : null;
    return {
      candidateId, token, expiresAt, name: rec.name, nameFlags: [...rec.nameFlags], from: rec.from, to: rec.to,
      destinationOccupied: occupied, recoveredName: recovered ? path.basename(recovered) : null,
    };
  }

  /** Serialized: one restore at a time, in the order requested. */
  restore(req: RestoreRequest): Promise<RestoreResult> {
    const run = this.queue.then(() => this.restoreNow(req));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private restoreNow(req: RestoreRequest): RestoreResult {
    const candidateId = typeof req?.candidateId === 'string' ? req.candidateId : '';
    const refuse = (reason: RefusalReason, message: string): RestoreResult => ({ status: 'refused', candidateId, reason, message });

    if (this.incidents.length) return refuse('halted', 'Stopped after an earlier incident, so nothing more will be moved. Nothing was changed.');

    const approval = typeof req?.token === 'string' ? this.approvals.get(req.token) : undefined;
    if (!approval || approval.candidateId !== candidateId) return refuse('token_invalid', 'This approval is not valid. Open the file again and approve it there.');
    this.approvals.delete(req.token);   // single use, whatever happens next
    if (approval.expiresAt < this.now()) return refuse('token_expired', 'This approval expired. Open the file again to approve it.');
    if (req.mode !== 'original' && req.mode !== 'recovered') return refuse('token_invalid', 'This approval is not valid. Open the file again and approve it there.');

    const rec = this.journal.recordFor(approval.snapshotId, candidateId);
    if (!rec) return refuse('unknown_candidate', 'This change is no longer in memory. Nothing was changed.');
    if (!this.mover.supported()) return refuse('unsupported_filesystem', 'This Mac cannot do a move that is guaranteed not to overwrite. Nothing was changed.');

    const src = lstatBig(rec.absFrom);
    if (!src) return refuse('source_missing', `${rec.name} is no longer in ${rec.from}. Nothing was changed.`);
    if (src.isSymbolicLink()) return refuse('symlink', `${rec.name} is now a link, not the file that was recorded. Nothing was changed.`);
    if (!src.isFile() || src.ino !== rec.ino || src.dev !== rec.dev) return refuse('source_changed', `The ${rec.name} in ${rec.from} is not the file that was recorded. Nothing was changed.`);

    const dst = req.mode === 'recovered' ? recoveredPath(rec.absTo) : rec.absTo;
    if (!dst) return refuse('destination_occupied', `${rec.to} has no free name for a recovered copy. Nothing was changed.`);
    const dir = lstatBig(path.dirname(dst));
    if (!dir || !dir.isDirectory()) return refuse('destination_missing', `${rec.to} no longer exists. Nothing was changed.`);
    if (dir.dev !== rec.dev) return refuse('cross_volume', `${rec.to} is on a different drive. Nothing was changed.`);
    const base = path.basename(dst);
    if (lstatBig(dst)) return refuse('destination_occupied', `${rec.to} already has a file called ${base}. Nothing was changed.`);

    this.journal.expectOwnMove(rec.dev, rec.ino);
    const r = this.mover.move(rec.absFrom, dst);
    if (!r.ok) {
      this.journal.cancelOwnMove(rec.dev, rec.ino);
      switch (r.code) {
        case 'EEXIST': return refuse('destination_occupied', `${rec.to} already has a file called ${base}. Nothing was changed.`);
        case 'EXDEV': return refuse('cross_volume', `${rec.to} is on a different drive. Nothing was changed.`);
        case 'ENOENT': return refuse('source_missing', `${rec.name} is no longer in ${rec.from}. Nothing was changed.`);
        case 'ENOTSUP': case 'EOPNOTSUPP': case 'ENOSYS': return refuse('unsupported_filesystem', 'This drive cannot do a move that is guaranteed not to overwrite. Nothing was changed.');
        default: return refuse('io_error', `The move did not happen (${r.code}). Nothing was changed.`);
      }
    }

    const after = lstatBig(dst);
    if (!after || after.ino !== rec.ino || after.dev !== rec.dev) {
      this.incidents.push({ at: this.now(), candidateId, expected: `${rec.dev}:${rec.ino}`, found: after ? `${after.dev}:${after.ino}` : 'nothing' });
      return { status: 'incident', candidateId, message: 'The file that arrived is not the one that was recorded. Stopped and recorded - nothing else will be moved.' };
    }
    this.journal.retire(candidateId);
    return { status: 'restored', candidateId, name: base, to: rec.to };
  }
}
