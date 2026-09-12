import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { LIMITS } from '../../shared/types.js';
import type { WatchRoots } from '../config.js';
import { fileKey, type FileKey, type Journal } from './journal.js';

function lstatBig(p: string): fs.BigIntStats | null {
  try { return fs.lstatSync(p, { bigint: true }); } catch { return null; }
}

/** Hidden files, bundles and dependency trees are never candidates. Only files directly inside the Trash are watched. */
function ignored(p: string, trash: string | null): boolean {
  if (trash && p === trash) return false;
  if (trash && p.startsWith(trash + path.sep)) return path.relative(trash, p).includes(path.sep) || path.basename(p) === '.DS_Store';
  const base = path.basename(p);
  return base.startsWith('.') || base === 'node_modules' || base.endsWith('.app') || base.endsWith('.photoslibrary');
}

/**
 * Turns a disappearance and an appearance of the SAME file (device + inode) into one move.
 *
 * chokidar reports a move as unlink + add, in either order, and can coalesce events. Identity comes
 * from lstat, never from names. Symlinks and directories are skipped. Files seen during the initial
 * scan are indexed but never become events. When in doubt it records nothing: a missed move costs a
 * candidate, a false one could move the wrong file.
 */
export class MoveDetector extends EventEmitter {
  private readonly byPath = new Map<string, FileKey>();
  private readonly byKey = new Map<FileKey, string>();
  private readonly pending = new Map<FileKey, NodeJS.Timeout>();
  private watcher: FSWatcher | null = null;
  private ready = false;
  /** Set once the OS refuses more watchers, so the log gets one clear warning instead of a flood. */
  private overLimit = false;

  constructor(private readonly journal: Journal) { super(); }

  start(cfg: WatchRoots): void {
    const targets = [...cfg.roots, ...(cfg.trash ? [cfg.trash] : [])];
    if (targets.length === 0) return;
    this.watcher = watch(targets, {
      ignoreInitial: false,
      followSymlinks: false,
      depth: 6,
      atomic: true,
      ignored: (p: string) => ignored(p, cfg.trash),
    });
    this.watcher.on('add', (p) => this.onAdd(p));
    this.watcher.on('change', (p) => this.onChange(p));
    this.watcher.on('unlink', (p) => this.onUnlink(p));
    this.watcher.on('ready', () => { this.ready = true; this.emit('ready', this.byPath.size); });
    this.watcher.on('error', (e) => {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EMFILE' || code === 'ENOSPC') {
        // Folders already being watched keep working; the rest are not observed. Say so once.
        if (this.overLimit) return;
        this.overLimit = true;
        this.emit('error', new Error(`macOS refused to watch more folders (${code}). Folders already watched still work; the rest are not observed. Watch fewer folders.`));
        return;
      }
      this.emit('error', e);
    });
  }

  async close(): Promise<void> {
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    await this.watcher?.close();
    this.watcher = null;
  }

  private index(p: string, key: FileKey): void {
    const was = this.byPath.get(p);
    if (was && was !== key && this.byKey.get(was) === p) this.byKey.delete(was);   // stale: this path now holds another file
    this.byPath.set(p, key);
    this.byKey.set(key, p);
  }

  private onAdd(p: string): void {
    const st = lstatBig(p);
    if (!st || !st.isFile()) return;
    const key = fileKey(st.dev, st.ino);
    const prev = this.byKey.get(key);
    this.index(p, key);
    if (!this.ready || !prev || prev === p) return;
    // Anything still at the old path means this is not a move: a hard link, or an inode number reused.
    if (lstatBig(prev)) return;
    this.clearPending(key);
    this.byPath.delete(prev);
    this.journal.recordRelocation(key, st.dev, st.ino, prev, p, Date.now());
  }

  /** Reconcile identity: an atomic save replaces the inode at the same path. */
  private onChange(p: string): void {
    const st = lstatBig(p);
    if (!st || !st.isFile()) return;
    this.index(p, fileKey(st.dev, st.ino));
  }

  private onUnlink(p: string): void {
    const key = this.byPath.get(p);
    if (!key) return;
    this.byPath.delete(p);
    if (this.byKey.get(key) !== p) return;   // already paired with an earlier add
    this.clearPending(key);
    // Keep the identity for the pairing window, so an add that arrives after the unlink still pairs.
    const t = setTimeout(() => {
      this.pending.delete(key);
      if (this.byKey.get(key) === p) this.byKey.delete(key);
    }, LIMITS.movePairMs);
    t.unref?.();
    this.pending.set(key, t);
  }

  private clearPending(key: FileKey): void {
    const t = this.pending.get(key);
    if (t) { clearTimeout(t); this.pending.delete(key); }
  }
}

export function startMoveDetector(cfg: WatchRoots, journal: Journal): MoveDetector {
  const d = new MoveDetector(journal);
  d.start(cfg);
  return d;
}
