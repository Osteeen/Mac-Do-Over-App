import path from 'node:path';

export type RenameResult = { ok: true } | { ok: false; code: string; errno: number; message: string };

/** The one way a file is moved. Injectable so tests can simulate what a real filesystem cannot be made to do on demand. */
export interface Mover { supported(): boolean; move(src: string, dst: string): RenameResult }

type SafeRename = { renameExcl(src: string, dst: string): RenameResult; supported(): boolean };
let addon: SafeRename | null | undefined;

function load(): SafeRename | null {
  if (addon !== undefined) return addon;
  if (process.platform !== 'darwin') return (addon = null);
  try {
    addon = require(path.join(__dirname, '..', '..', '..', 'lib', 'safe-rename.cjs')) as SafeRename;
  } catch { addon = null; }
  return addon;
}

/**
 * macOS: renameatx_np(..., RENAME_EXCL) through our addon, a single operation that cannot overwrite.
 * Anywhere else: unsupported, with deliberately no fallback. fs.rename overwrites on Windows, and
 * link + unlink has a race.
 */
export const systemMover: Mover = {
  supported: () => { const m = load(); return !!m && m.supported(); },
  move: (src, dst) => {
    const m = load();
    if (!m) return { ok: false, code: 'ENOTSUP', errno: 45, message: 'no move that cannot overwrite on this platform' };
    return m.renameExcl(src, dst);
  },
};
