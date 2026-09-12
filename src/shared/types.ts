/**
 * THE CONTRACT. Every lane builds against these shapes: journal, candidates and executor (Austin),
 * Find (Faisal), screens (Lucy). Change a shape only through a PR all three can see.
 *
 * Rules that are part of the contract, not implementation details:
 * - Paths in shared shapes are DISPLAY paths ("~/Documents/Archive"). Absolute paths, inodes and
 *   device ids live only in CandidateRecord, which never crosses IPC or enters a Find payload.
 * - Filenames and window titles are untrusted (markup, bidi overrides, newlines). Screens render
 *   them as text, never as markup, and surface `nameFlags`.
 * - Approval binds to a candidate id and a single-use token, never to a displayed string.
 * - Times are epoch milliseconds.
 */

export type EventId = string;
export type CandidateId = string;

// ---- Journal ---------------------------------------------------------------------------------
// Same event shapes the agent gate was scored on (held-out 10/10). Keep them that way.

/** A file moved between folders, or into or out of the Trash. The only reversible event. */
export interface FileMoveEvent { id: EventId; ts: number; kind: 'file.move'; name: string; from: string; to: string }
/** A file renamed in place. Recorded for context; renames are not reversible. */
export interface FileRenameEvent { id: EventId; ts: number; kind: 'file.rename'; name: string; newName: string; dir: string }
/** An app came to the front. Switching TO an app only; quitting or hiding is never recorded. */
export interface WindowFrontEvent { id: EventId; ts: number; kind: 'window.front'; appName: string; title: string }

export type JournalEvent = FileMoveEvent | FileRenameEvent | WindowFrontEvent;

/** The Trash as it appears in `from` and `to`. */
export const TRASH = '~/.Trash';

// ---- Candidates ------------------------------------------------------------------------------

/** Why a name needs care on screen. Any flag gets a visible badge ("BIDI HELD" for bidi). */
export type NameFlag = 'bidi' | 'control' | 'newline' | 'markup';

/** One reversible incident, as screens and Find see it. */
export interface Candidate {
  id: CandidateId;
  kind: 'move_back';
  name: string;
  /** Where the file is now. */
  from: string;
  /** Where it goes back to. */
  to: string;
  /** When the original move was observed. */
  observedAt: number;
  /** The journal event this candidate reverses. */
  eventId: EventId;
  fromTrash: boolean;
  nameFlags: NameFlag[];
}

/** MAIN PROCESS ONLY. Never crosses IPC and never enters a Find payload. */
export interface CandidateRecord extends Candidate {
  /** Identity captured when the move was observed: checked before the restore, verified after. Use lstat({ bigint: true }). */
  ino: bigint;
  dev: bigint;
  absFrom: string;
  absTo: string;
}

/** Frozen when the handle is pulled, so what the user is reading cannot shift underneath them. */
export interface StripSnapshot { snapshotId: string; frozenAt: number; events: JournalEvent[]; candidates: Candidate[] }

// ---- Find ------------------------------------------------------------------------------------

/** Exactly what leaves the Mac on Send, and nothing is added downstream: no frames, no absolute paths. */
export interface FindPayload {
  now: number;
  timeline: JournalEvent[];
  candidates: Array<Pick<Candidate, 'id' | 'kind' | 'name' | 'from' | 'to' | 'observedAt'>>;
  reference: string;
}

/** Shown before Send. `notSent` says, in plain words, what stays on the Mac. */
export interface FindPreview {
  snapshotId: string;
  provider: 'OpenAI';
  model: string;
  bytes: number;
  eventCount: number;
  candidateCount: number;
  notSent: string[];
  payload: FindPayload;
}

export interface FindMatch { candidateId: CandidateId; why: string; evidenceEventIds: EventId[] }

/** `matched` only after validation: every candidate id and every cited event exists in the snapshot. */
export type FindResult =
  | { status: 'matched'; matches: FindMatch[]; caveats: string[] }
  | { status: 'no_match'; caveats: string[] }
  /** The model cited a candidate or event that does not exist. Never shown as a match. */
  | { status: 'invalid'; reason: string }
  | { status: 'offline' | 'timeout' | 'error'; reason: string };

// ---- Approval and restore --------------------------------------------------------------------

/** Opened for exactly one candidate. The token is single-use and expires. */
export interface ApprovalSheet {
  candidateId: CandidateId;
  token: string;
  expiresAt: number;
  name: string;
  nameFlags: NameFlag[];
  from: string;
  to: string;
  /** Checked when the sheet opens. The executor checks again at restore time; this is a hint, not a guarantee. */
  destinationOccupied: boolean;
  /** Offered when the destination is occupied: puts the file back under a new name, never over the existing file. */
  recoveredName: string | null;
}

export interface RestoreRequest { candidateId: CandidateId; token: string; mode: 'original' | 'recovered' }

export type RefusalReason =
  | 'destination_occupied' | 'source_missing' | 'source_changed' | 'symlink'
  | 'unsupported_filesystem' | 'cross_volume' | 'unknown_candidate' | 'token_invalid' | 'token_expired'
  | 'destination_missing' | 'io_error' | 'halted';

export type RestoreResult =
  | { status: 'restored'; candidateId: CandidateId; name: string; to: string }
  | { status: 'refused'; candidateId: CandidateId; reason: RefusalReason; message: string }
  /** The move ran but the post-check found a different file. Recorded and stopped: never a success, never rolled back. */
  | { status: 'incident'; candidateId: CandidateId; message: string };

// ---- Limits ----------------------------------------------------------------------------------

export const LIMITS = {
  /** Journal events are evicted after ten minutes. */
  journalMs: 10 * 60_000,
  /** An unlink and an add of the same inode within this window are one move. */
  movePairMs: 2_000,
  approvalTokenMs: 60_000,
  findTimeoutMs: 20_000,
  referenceMaxChars: 200,
} as const;
