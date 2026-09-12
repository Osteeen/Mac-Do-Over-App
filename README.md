# Mac Do Over

**Mac Do Over finds the mistake you mean and puts that file back, while preserving your other work.**

A macOS menu-bar app. It watches a few folders for file moves, keeps a short memory of what it
observed, and when you ask, puts one file back where it was. Nothing else you did is touched.

Built for AI Tinkerers Abuja, "Agents, Everywhere", 12 September 2026.

## What it does

Files only. Two kinds of mistake:

- **A file moved to the wrong folder** is moved back to the folder it came from.
- **A file sent to the Trash (the Bin)** is moved back to where it was. Only files Mac Do Over
  observed entering the Trash are offered. Whatever was already in the Trash is never a candidate.

Press **Option+Command+Z** to open the list of recent changes it can put back.

**Find the one you mean.** Optionally type a half-description, such as "the document I moved
before I opened the browser". Mac Do Over sends the recorded timeline and your sentence to a
model, which picks from the recorded changes and cites the events it relied on. It can return
no match, one, or several. Every proposal is a recorded change, shown with its evidence, and
nothing moves until you approve it.

**Only that change is reversed.** Later moves, renames and other work are left as they are. If
you renamed the file after moving it, it goes back under its current name.

**It refuses rather than overwrite.** If a file with the same name is already at the destination,
the put-back is refused and both files stay intact. You can instead choose to put it back as
"name (recovered)", which never replaces anything.

**Putting back works offline.** Only Find uses the network. The list, the approval and the move
itself do not.

## How it works

```
folders + Trash --> move detector --> journal (in memory) --> snapshot
                                                                 |
             front app + window title ------------------------->|
                                                                 v
                                            list of changes  +  optional Find (OpenAI)
                                                                 |
                                                        approval (single-use token)
                                                                 |
                                                   executor --> safe-rename addon
```

**Journal.** A folder watcher reports a move as a disappearance and an appearance. The move
detector pairs the two only when they are the same file, identified by device and inode from
`lstat`, never by name, within a 2 second window. Symlinks and folders are skipped. Files
present at startup are indexed but never become events. When in doubt it records nothing: a
missed move costs a candidate, a false one could move the wrong file.

Each observed move becomes one event and one candidate. A second move of the same file updates
where the first candidate starts from. A rename in place is recorded as context only. The app
also records which application came to the front, with its window title.

**Snapshot.** Opening the list freezes a snapshot, so what you are reading cannot change
underneath you. Approval and Find act on that exact snapshot.

**Executor.** The only code that moves a file.

- Each put-back needs a single-use token, issued for one candidate in one snapshot, that expires
  after 60 seconds. Approval binds to the candidate id and token, never to a displayed name.
- Put-backs run one at a time.
- Before the move it checks that the file at the recorded location is still the same file (same
  device and inode, not a symlink), that the destination folder exists, is on the same drive,
  and is free. Any failure is a refusal with a plain message, and nothing is changed.
- After the move it checks the inode at the destination. A mismatch is recorded as an incident
  and reported, never as a success. It is not rolled back, and every later put-back is refused
  until the app restarts.
- Its own moves are registered with the journal first, so a put-back is not logged as a new
  mistake.

**The move itself.** A small native N-API addon calls `renameatx_np` with `RENAME_EXCL`: a single
operation that cannot overwrite. If the destination exists, the kernel refuses with `EEXIST`.
There is no copy-and-delete or link-and-unlink fallback. Where the primitive is unavailable, the
put-back is refused. The addon does not check source identity, which is why the executor checks
before and verifies after.

**Find.** Optional. Before anything is sent, a preview shows the provider, the model, the size
and the exact payload, along with a plain list of what is not sent. The payload is built from a
field whitelist and contains only:

- the recorded timeline: file moves and renames (file name, folders, time) and front-app changes
  (app name, window title, time)
- the candidates (id, file name, folders, time)
- your sentence, capped at 200 characters

Folders under your home folder are written as `~/Documents/...`, so your user name is not
in them (window titles are sent as they appear and can contain it). No picture of your screen, no file contents, nothing else you typed, no inodes and no
absolute paths for home folders leave the Mac. The payload sent is the payload previewed.

It is sent to OpenAI under their API policy (default model `gpt-5-mini`) with a strict JSON
output schema. The reply is validated before anything is shown: if it names a candidate or cites
an event that is not in the snapshot, or picks a file without citing any event, the whole answer
is rejected as invalid. No connection, a timeout (20 seconds) or an HTTP error each come back as
a message, and the list still works.

**API key.** Read from the macOS Keychain, or from `OPENAI_API_KEY` if set. It is not stored in
this repository or in a project file.

**Interface.** Filenames and window titles are treated as untrusted text: they are rendered as
text, never as markup, and names containing bidirectional overrides, control characters,
newlines or markup are flagged with a visible badge. The renderer never receives inodes or
absolute paths, and every argument it sends is checked for type and length in the main process.

## Privacy and retention

All of this is in memory. Mac Do Over has no intentional local persistence of what it records.

| What | Kept | Notes |
|---|---|---|
| File move and rename events, front-app changes | 10 minutes | Swept once a minute. Candidates older than 10 minutes are no longer offered. |
| Screen thumbnails | about 60 seconds | 2 per second at most, JPEG, capped at 240 frames. Captured only if Screen Recording is granted. Never sent anywhere. |
| Typing, clicks, shortcuts | never captured | The global keyboard and mouse sensor does not run in Mac Do Over. It starts only for debugging (`STARTER_DEBUG`). |
| Audio | never captured | There is no audio code. |

macOS shows its own screen-recording indicator while the app runs. It is not suppressed.

"No intentional local persistence" is an application-level statement. It says nothing about
Chromium's own cache files or the operating system's swap. See [SECURITY.md](SECURITY.md).

## Run it

macOS only. Tested on Apple Silicon. You need Node.js and the Xcode Command Line Tools (for the
native addon and the Keychain helper).

```
npm install
npm run build                  # native addon, then TypeScript
bash scripts/set-api-key.sh    # optional, only needed for Find; stores the key in the Keychain
```

Start it, watching folders of your choice (colon-separated):

```
DESKTOP_AGENT_ROOTS="$HOME/path/to/FolderA:$HOME/path/to/FolderB" npm start
```

Without `DESKTOP_AGENT_ROOTS` it watches `~/Desktop`, `~/Documents` and `~/Downloads`. The real
`~/.Trash` is always watched, even when you override the folders, so a file you trash while
trying it out is observed in your actual Trash. The tray item "Watched folders" shows exactly
what is being observed.

Then:

1. Start it from Terminal. macOS applies permissions to the app you launch it from, so grant
   **Screen Recording** and **Accessibility** to Terminal when asked, then quit Terminal and reopen it.
2. Watching the Trash needs **Full Disk Access** for Terminal too. Without it the log shows
   `EPERM ... .Trash` and trashed files cannot be put back; everything else still works.
3. Move a file to another watched folder, or to the Trash, then press **Option+Command+Z**.

Other scripts: `npm test` (addon, Keychain, security regression, journal, executor and Find tests), `npm run gate:recovery`
(exercises the rename primitive and prints each case), `npm run preflight`, `npm run package`
(ad-hoc signed, arm64).

## Built today vs pre-built

Core functionality was built during the event. What existed before is a generic, product-free
Electron starter, published publicly three days earlier:
**https://github.com/Osteeen/desktop-agent-starter**. This repository continues its history, and
the last pre-event commit is `c3d8ef4` (9 September 2026).

**Pre-built (the starter, up to `c3d8ef4`):**

- Menu-bar app with overlay, edge and onboarding window shells rendering placeholder content
- Permissions onboarding
- Hardened IPC (context isolation, sandboxed renderers, sender checks, Content Security Policy)
- Screen capture loop into a time-evicted in-memory ring buffer
- Input and front-window sensors
- Watched-folder configuration
- The `safe-rename` N-API addon and its tests, and the recovery gate
- A generic prompt evaluation runner with example fixtures
- Pre-flight checks, packaging, ad-hoc signing, and the Keychain key script

**Built today (every commit after `c3d8ef4`):**

- The contract: shared types, IPC channels, example data, hostile-name flags
- The journal and move detector, behind a platform adapter
- The executor: single-use approvals, identity checks before and after, refusal instead of
  overwrite, incidents, "(recovered)" names
- Find: previewed payload, the production prompt, the strict-schema call, answer validation
- Wiring the journal, executor and Find to the interface over IPC
- The recovery interface: the list of recent changes, the review view and the approval sheet
- Tests for the journal, executor and Find

`git log --oneline c3d8ef4..HEAD` lists exactly what was added today.

## Limits

- **macOS only.** There is no Windows or Linux implementation; on any other platform a put-back
  is refused.
- **Files only, and locations only.** It puts a file back where it was. It does not recover file
  contents, edits or overwritten files, and it does not reverse renames or folder moves.
- **It only knows what it observed.** A move that happened before it started, outside the watched
  folders, or more than 10 minutes ago is invisible to it. Hidden files, app bundles and
  `node_modules` are ignored. Folders synced by iCloud can produce events that look like moves,
  and it warns rather than claiming they work.
- **Other drives.** A file moved to a different drive gets a new identity, so it is not recorded as
  a move. A put-back whose destination is on a different drive is refused before the move is
  attempted. The addon's own cross-drive refusal (`EXDEV`) has not been tested: its test and the
  recovery gate case skip unless a second writable volume is mounted.
- **Interruption.** Behaviour if the process is killed mid-move is expected to be safe, because
  the move is a single operation, but it has not been tested experimentally.
- **Find accuracy is measured on synthetic data only.** Before the event, incident selection was
  scored on synthetic journals with `gpt-5-mini`: 12/12 on a development set against a 25%
  baseline ("pick the newest change"), and 10/10 on a held-out set against a 20% baseline, run
  once. That used an experiment prompt. The production prompt written today has not been scored
  on those sets, and neither has been tested against events from real use. The train/test split
  was self-enforced, which is weaker than a blind one.
- **No exclusion list yet.** The title of every window that comes to the front is kept for 10
  minutes and included in a Find payload. The preview shows it before anything is sent.
- **Unsigned.** Builds are ad-hoc signed and not notarized.

## `npm audit` reports six advisories

They come in through `get-windows`, which ships a toolchain for compiling its Windows addon
(`node-gyp`, `cacache`, `make-fetch-happen` and a vulnerable `tar`). This app is macOS only and
uses the prebuilt binary. The window sensor imports `get-windows/lib/macos.js` directly rather
than the package index, so none of that chain is loaded at runtime, and the packager excludes it
from the bundle. See [SECURITY.md](SECURITY.md).

## Credits

Built in Abuja at AI Tinkerers by Austin John, Lucy and Faisal.

## License

MIT. See [LICENSE](LICENSE).
