import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Which folders the app observes.
 *
 * Defaults to the real home folders. Override with DESKTOP_AGENT_ROOTS, a colon-separated
 * list, so a sandbox can be watched during rehearsal without touching anything real:
 *
 *   DESKTOP_AGENT_ROOTS="$HOME/dev/DoOverDemo/Desktop:$HOME/dev/DoOverDemo/Documents" npm start
 *
 * Every root is resolved to a real filesystem location before use, so a symlinked parent or a
 * `..` segment cannot quietly point observation somewhere unintended.
 */
export interface WatchRoots {
  roots: string[];
  trash: string | null;
  source: 'default' | 'environment';
  warnings: string[];
}

const ENV = 'DESKTOP_AGENT_ROOTS';
const DEPTH_ENV = 'DESKTOP_AGENT_DEPTH';

/**
 * How many folder levels below each root are watched. Every watched folder costs one watcher, and on
 * macOS thousands of them stall: a Desktop full of code projects reached 4,190 folders at 6 levels,
 * but 873 at 3, which open in milliseconds. Override with DESKTOP_AGENT_DEPTH, 1 to 6.
 */
export function watchDepth(): number {
  const n = Number(process.env[DEPTH_ENV]);
  return Number.isInteger(n) && n >= 1 && n <= 6 ? n : 3;
}

/** Resolve a path to its real location even when the leaf does not exist yet. */
function resolveReal(p: string): string | null {
  const expanded = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
  const abs = path.resolve(expanded);
  try {
    return fs.realpathSync(abs);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
    } catch { return null; }
  }
}

export function watchRoots(): WatchRoots {
  const home = fs.realpathSync(os.homedir());
  const warnings: string[] = [];
  const raw = process.env[ENV];

  // An explicitly empty or whitespace-only override is a mistake, not a request for defaults.
  // Silently falling back would watch the real home folders when someone meant to watch a sandbox.
  const explicit = raw !== undefined;
  if (explicit && raw!.trim() === '') {
    return { roots: [], trash: null, source: 'environment',
      warnings: [`${ENV} is set but empty. That is almost certainly a mistake, so nothing is watched. Unset it to use the defaults.`] };
  }
  const requested = explicit
    ? raw!.split(':').map(s => s.trim()).filter(Boolean)
    : ['Desktop', 'Documents', 'Downloads'].map(d => path.join(home, d));

  const roots: string[] = [];
  for (const r of requested) {
    let real: string | null;
    let isDir: boolean;
    try {
      // One try/catch around the whole sequence: a root removed between the existence check
      // and the stat would otherwise throw ENOENT and take the app down at startup.
      real = resolveReal(r);
      if (!real) { warnings.push(`${r}: cannot be resolved, skipped`); continue; }
      isDir = fs.statSync(real).isDirectory();
    } catch { warnings.push(`${r}: disappeared or is unreadable, skipped`); continue; }
    if (!isDir) { warnings.push(`${real}: not a directory, skipped`); continue; }
    // iCloud Desktop and Documents produce hydration and eviction events that look like
    // moves to a naive watcher. Warn rather than pretend it works.
    if (real.includes('/Mobile Documents/')) warnings.push(`${real}: iCloud-managed, move detection is unreliable here`);
    if (roots.includes(real)) { warnings.push(`${real}: listed more than once (after resolving aliases), ignored`); continue; }
    const parent = roots.find(existing => real!.startsWith(existing + path.sep));
    if (parent) warnings.push(`${real}: is inside ${parent}, so its events will be seen twice`);
    if (!real.startsWith(home + path.sep) && real !== home) warnings.push(`${real}: is outside the home folder`);
    roots.push(real);
  }

  // The Trash is ALWAYS the real one, whatever the roots are. A file trashed from a sandbox
  // lands in ~/.Trash, so watching it means both ends of that move are observed and the Trash
  // case works during rehearsal too. Pre-existing Trash contents are never candidates, because
  // a candidate requires having observed the file arrive.
  const usingEnv = Boolean(raw);
  const trashPath = path.join(home, '.Trash');
  let trash: string | null = null;
  try {
    trash = fs.statSync(trashPath).isDirectory() ? trashPath : null;
    if (!trash) warnings.push(`${trashPath} exists but is not a directory, so trashed files cannot be recovered`);
  } catch { warnings.push(`${trashPath} is unreadable, so trashed files cannot be recovered`); }
  if (explicit && trash) warnings.push('The Trash is real even when roots are overridden, so a file trashed during rehearsal is observed in your actual Trash.');

  if (roots.length === 0) warnings.push('No usable roots. Nothing will be observed.');
  return { roots, trash, source: usingEnv ? 'environment' : 'default', warnings };
}

/** One line for the log and for the onboarding screen, so what is observed is never a guess. */
export function describeRoots(w: WatchRoots): string {
  const home = os.homedir();
  const short = (p: string) => (p.startsWith(home) ? '~' + p.slice(home.length) : p);
  const list = w.roots.map(short).join(', ') || 'nothing';
  return `watching ${list}${w.trash ? ' and the Trash' : ''}, ${watchDepth()} levels deep (${w.source})`;
}
