# Mac Do Over

A generic **macOS** starter for desktop agents built on Electron and TypeScript.

It is deliberately empty of product. There is no domain logic, no feature UI, and nothing that
decides anything. What it gives you is the plumbing that every app of this shape needs and that
takes an unreasonable amount of a first day to get right.

## What's here

**App shell.** A menu-bar app with no dock icon. A transparent, always-on-top overlay window
sized to the primary display, with a click-through toggle. A small window docked to the screen
edge. All three render placeholder content.

**Permissions onboarding.** Screen Recording, Accessibility, and Input Monitoring, with live
status and deep links into System Settings. Input Monitoring has no status API, so it is
inferred from whether events actually arrive.

**Hardened IPC.** Context isolation, sandboxed renderers, per-sender validation, main-frame-only
checks, and a Content Security Policy on every page. Renderers can only call named channels.

**Screen capture into a memory buffer.** `desktopCapturer` thumbnails at 3 fps, JPEG encoded,
into a 60-second time-evicted ring, all in the main process. `freeze()` returns a copy.

> Deliberately **not** `getDisplayMedia`. A MediaStream makes Chromium treat the app as
> screen-sharing and puts a "Currently Sharing" window on screen. Thumbnails avoid that.
> macOS still shows its own recording indicator, which you should want: an app that reads the
> screen ought to be visibly unable to do it secretly.

**Sensors.** Global clicks and modifier shortcuts via `uiohook-napi`, with plain characters
discarded before anything is stored. Foreground window and app via `get-windows`.

**`safe-rename`.** A small N-API addon wrapping `renameatx_np` with `RENAME_EXCL`: a single
syscall that moves a file and fails if the destination exists. It can never overwrite.

> It does **not** verify that the source is still the file you inspected. Callers must `stat`
> before and verify by inode after. A mismatch is an incident, not a success. There is no
> `link` + `unlink` fallback, because that pair has a window in which a replacement at the
> source path gets deleted. On a filesystem without the flag, refuse.

**A recovery gate.** `--gate=recovery` exercises the rename primitive from inside the packaged
app and reports each case: destination collision refused with nothing changed, source-identity
change detected by the post-check, symlink behaviour made explicit. The cross-volume case is
reported as SKIP unless a second writable volume is mounted, because an unverified pass is worse
than an honest skip.

**A prompt evaluation runner.** Scores a prompt against fixtures and against a trivial baseline,
so "the model picks the right one" becomes a number instead of a feeling. Ships with a generic
example; write your own fixtures.

**Pre-flight.** `npm run preflight` checks the toolchain, the path characters the packager
rejects, that the addon really refuses a collision, permission grants, and machine headroom.

## Two things it will save you

**Permissions are keyed to your code signature.** Ad-hoc signing changes it on every build, which
silently revokes Screen Recording and raises a fresh dialog. Grant permissions to the dev binary
at `node_modules/electron/dist/Electron.app` instead, whose signature is stable, and package only
at the end.

**Never run the capture loop while a permission dialog is open.** Every grab blocks on a
permission check that is itself waiting on the user, the calls queue against WindowServer, and
the machine locks up. `startCapture()` refuses to start unless permission is already granted and
halts after five consecutive failures. Keep those guards.

## `npm audit` reports six advisories, and that is expected

They come in through `get-windows`, which ships a build toolchain for compiling its Windows
addon: `node-gyp`, `cacache`, `make-fetch-happen` and a vulnerable `tar`. This starter is macOS
only and uses the prebuilt binary, so none of it is reachable.

Two things keep it that way, and both are verified rather than assumed. The window sensor imports
`get-windows/lib/macos.js` directly instead of the package index, because the index statically
imports `lib/windows.js` which pulls in `@mapbox/node-pre-gyp`. And the packager excludes the
whole chain, so a packaged build contains none of it. See [SECURITY.md](SECURITY.md).

If you extend this to Windows, that changes: you would be executing the code those advisories
describe, and you should update or replace the dependency first.

## Use it

```
npm install
npm run build          # native addon, then TypeScript
npm test               # addon tests
npm run preflight
npm start              # dev run
npm run gate:recovery
npm run package        # $HOME/desktop-agent-starter-release, ad-hoc signed
```

electron-builder rejects paths containing characters like `&`, so keep the checkout somewhere
plain. Set an API key for the eval runner with `bash scripts/set-api-key.sh`, which stores it in
the Keychain rather than on disk.

## Not here

Windows and Linux. The sensors, the overlay, and the rename primitive are all macOS. Porting
means a `MoveFileEx` rename without `MOVEFILE_REPLACE_EXISTING`, a Recycle Bin adapter, and a
different permission flow.

MIT. See [LICENSE](LICENSE).
