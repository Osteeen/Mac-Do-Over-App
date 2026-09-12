# Security notes

## What this starter does that needs care

It reads the screen, observes global input, watches folders, and moves files. Each is a real
capability, so the boundaries are stated here rather than left implicit.

**Screen capture.** Frames live in an in-memory ring, evicted by time, and are never written to
disk by this code. macOS shows its own recording indicator whenever any app reads the screen; that
indicator is not suppressed and should not be.

**Input.** Mac Do Over does not run the global keyboard and mouse sensor: it starts only when
`STARTER_DEBUG` is set, for debugging, and in the capture gate. When it does run, only mouse events
and Command shortcuts are passed on. Key events without Command are discarded before anything is
stored, so ordinary typing, capital letters included, is never captured.

**File moves.** The only operation that moves a file is `renameatx_np` with `RENAME_EXCL`: one
syscall that fails if the destination exists. It cannot overwrite. It does **not** verify that the
source is still the file you inspected, so callers must `stat` before and verify by inode after,
and treat a mismatch as an incident rather than a success.

## Renderer isolation

Every window runs with `contextIsolation: true`, `nodeIntegration: false` and `sandbox: true`.
Renderers reach main only through a named preload bridge; every handler validates that the sender
is a registered window and that the call came from the main frame rather than a subframe. Each
page carries a Content Security Policy with `default-src 'none'`.

Inline scripts are permitted (`script-src 'unsafe-inline'`) because the pages are self-contained
and load nothing external. A product built on this should tighten that.

## Findings from the audit of 2026-09-09 (first round)

**Fixed: NUL truncation in the rename addon.** A JavaScript string may contain NUL; a C string may
not. Passing one through `c_str()` truncated silently, so a caller asking to create `safe\0HIDDEN`
got a file called `safe` and a report of success. What the caller asked for and what happened could
diverge without any error. Paths containing NUL, and empty paths, are now refused with `EINVAL`.
Regression tests cover both.

**Reviewed, no change needed.** Overlong names, `..` segments and empty strings are all rejected by
the kernel with ordinary errors and nothing is created. The addon holds no raw pointer beyond the
lifetime of its owning `std::string`. `permissions:open` is allowlisted to three known panes and
cannot be induced to open an arbitrary URL.

**Resolved.** `npm audit` reports six advisories reached transitively through `get-windows`.
An earlier note claimed they were build-only; that was wrong. They are now genuinely off both the
runtime graph and the bundle, by importing the macOS leaf rather than the package index. See the
second-round findings below.

## Findings from the second audit of 2026-09-09

An independent review found fifteen issues. What changed:

**Input capture was recording text.** The filter required "any modifier", which meant Shift+A
(a capital letter) and Option+A (which composes `å` on a US layout) were both recorded as
shortcuts. That contradicted the guarantee outright. A command now requires **Command or
Control**; Shift and Option compose characters and are never sufficient on their own.

**IPC authorisation survived navigation.** A window registered at startup kept its privileges
after being navigated elsewhere, so a document that was never meant to have them could call main.
Registration is now pinned to the document URL: navigation away from it is blocked, window-open
requests are denied, and privileges are revoked if the document changes anyway.

**Shell injection during signing.** The app path was interpolated into a shell command, so an app
named `Demo$(touch PWNED).app` executed that command. Arguments now go to `codesign` directly with
no shell.

**The API key was passed as a command-line argument**, visible to anything that could read the
process table while it ran. It goes on stdin now.

**The window sensor had no bound.** Each poll launched a subprocess, and a stalled call let the
next interval start another, without limit. One outstanding call at a time, a three-second
timeout, and it halts after five consecutive failures.

**Retention was lazy, not guaranteed.** Frames were only evicted when something was pushed, so an
idle buffer held its last frame indefinitely. A timer now sweeps on the same schedule, and a grab
that resolves after capture stopped is discarded rather than retained.

**Permission prompting bypassed the capture timeout latch**, starting a fresh unresolvable request
on each attempt. One shared in-flight request and the same permanent latch.

### Not fixed, disclosed instead

**The exclusion policy does not run before frame retention.** Frames enter the buffer with no
exclusion decision. Nothing reads or transmits them in this starter, so nothing leaks here, but a
product built on it must implement that gate before claiming any app is excluded.

**Six npm advisories: fixed, not merely disclosed.** They were reached through `get-windows`,
whose `index.js` statically imports its macOS, Linux **and Windows** implementations. Only
`lib/windows.js` imports `@mapbox/node-pre-gyp`, which pulls in `node-gyp`, `cacache`,
`make-fetch-happen` and a vulnerable `tar`. A macOS-only app was loading a Windows build
toolchain for nothing, since `lib/macos.js` merely runs a prebuilt binary through `execFile`.

The sensor now resolves the package entry point and imports `lib/macos.js` beside it by file URL,
because the package's `exports` map has no subpath entries. Verified: the direct import loads none
of the five vulnerable packages, while importing the index loads them. The packager also excludes
`get-windows/node_modules`, `@mapbox`, and `lib/windows.js` from the bundle, so they are neither
loaded nor shipped.

**"Never written to disk" is an application-level claim only.** No code here writes a frame, and
no crash reporter is enabled. That says nothing about Chromium's own cache files or the operating
system's encrypted swap.

## Reporting

Mac Do Over is a hackathon build, not a hardened release. Open an issue on this repository.
