import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Everything that differs between operating systems sits behind this interface, so the journal,
 * candidates, Find and the screens stay platform-independent.
 *
 * Only macOS is implemented. Windows needs three things before it can be claimed: a move that
 * cannot overwrite (MoveFileExW without MOVEFILE_REPLACE_EXISTING, as a native addon), a Recycle
 * Bin reader (files are renamed to $R... with metadata in $I...), and a keyboard rule that still
 * never captures characters on layouts where Ctrl+Alt types them.
 */
export interface Platform {
  id: 'darwin' | 'unsupported';
  /** "~/Documents/Archive" for anything under the home folder, so the user's name never appears. */
  displayPath(abs: string): string;
  trashRoot(): string | null;
  isInTrash(abs: string): boolean;
}

const home = (() => { try { return fs.realpathSync(os.homedir()); } catch { return os.homedir(); } })();

function displayUnderHome(abs: string): string {
  if (abs === home) return '~';
  if (abs.startsWith(home + path.sep)) return '~/' + path.relative(home, abs).split(path.sep).join('/');
  return abs;
}

const darwinTrash = path.join(home, '.Trash');

const darwin: Platform = {
  id: 'darwin',
  displayPath: displayUnderHome,
  trashRoot: () => darwinTrash,
  isInTrash: (abs) => abs === darwinTrash || abs.startsWith(darwinTrash + path.sep),
};

// Importing this module never throws on another OS, so platform-independent code and its tests
// run anywhere. Anything that would move a file refuses on an unsupported platform instead.
const unsupported: Platform = {
  id: 'unsupported',
  displayPath: displayUnderHome,
  trashRoot: () => null,
  isInTrash: () => false,
};

export const platform: Platform = process.platform === 'darwin' ? darwin : unsupported;
