<div align="center">
  <img src="src/assets/brand-mark.png" alt="SRCTools" width="96" height="96">

  # SRCTools

  **An advanced Speedrun.com moderator toolkit for Windows.**

  Queue triage, video validation, run analysis, bulk moderation and local
  statistics — in one desktop application that never decides anything on your
  behalf.
</div>

---

## What it is

SRCTools is a desktop application for people who moderate games on
[Speedrun.com](https://www.speedrun.com). It talks to the public Speedrun.com
API with your own API key, presents the pending-runs queue in a way a browser
tab cannot, and keeps a local record of what you did.

It is a **tool for a moderator, not a replacement for one.** Every automated
check in this application produces information; none of them produce a verdict.
There is no code path anywhere in SRCTools that approves or rejects a run
without a human pressing a button.

## Features

### Moderation queue

- Every pending run across every game you moderate, in one virtualized table
  that stays smooth at thousands of rows.
- Sort by any column; filter by game, category, player, video status, date
  range and free text.
- Column visibility is configurable and remembered.
- Row selection with `Ctrl`/`Shift` ranges, select-all and select-none.
- Skeleton loading states — the window never blanks and never freezes.

### Video validation

Each submitted link is checked against its provider and classified into one of
nine distinct states. The distinction that matters most:

| Status | Shown as | Meaning |
| --- | --- | --- |
| `AVAILABLE` | Available | The provider confirmed the video exists and is publicly viewable. |
| `PRIVATE` | Private | It exists, but the uploader restricted who can watch it. |
| `DELETED` | Deleted | The provider positively reported it as gone. |
| `UNAVAILABLE` | Unavailable | It exists but cannot be watched — removed, blocked or withdrawn. |
| `REGION_RESTRICTED` | Region locked | Blocked in some regions; may be viewable elsewhere. |
| `PROCESSING` | Processing | Uploaded but still transcoding. |
| `INVALID_URL` | Not a video link | The submitted text is not a usable video address. |
| `NETWORK_ERROR` | Check failed | **The check failed.** Nothing is known about the video. |
| `UNKNOWN` | Not checked | Not checked, or the provider gave no usable answer. |

`NETWORK_ERROR` and `UNKNOWN` are rendered in a neutral colour, never red, and
are never cached — the next check really does re-check. A timeout, a rate limit
or a provider outage is a failure of *the check*; SRCTools will not let it look
like a failure of the run. YouTube and Vimeo are checked through their public
oEmbed endpoints; Twitch requires your own application credentials, and without
them Twitch links are reported as “could not check”.

### Run inspection and analysis

- A detail panel with the full run record: times, platform, region, emulator,
  variables, splits and comment.
- The category's rules text, so you are not switching to a browser to read it.
- The runner's history in that category, with improvements highlighted.
- Leaderboard context: where this time would place.
- Duplicate detection across the queue.
- Automated checks that flag things worth a human look — a time far below the
  current world record, a suspiciously old submission date, a mismatched
  platform, a missing video. Each finding carries a severity and a confidence,
  and the overall recommendation is one of **nothing flagged**, **needs review**
  or **cannot verify**. There is deliberately no “approve” or “reject” outcome.

### Acting on runs

- Verify, reject and delete, individually or in bulk.
- Rejection requires a reason. Quick-rejection templates fill the box; they
  never send anything on their own.
- Bulk operations show live progress, can be cancelled mid-run, and report
  exact success and failure counts. Failures can be retried without repeating
  the successes.
- Deletion always confirms, whatever your settings say.

### Fast Review

One run at a time, keyboard first, with an optional pause after each decision so
a mistyped key is visible while it still means something.

### Everything else

- **Keyboard shortcuts** for every action, all rebindable except `Esc` and
  `Ctrl+K`. Press `?` for the reference sheet.
- **Command palette** on `Ctrl+K` — jump to a page, a game or an action.
- **Local history** of every action SRCTools performed from this machine, with
  CSV and JSON export.
- **Statistics** built from that history: totals, a daily activity chart, a
  breakdown by game and your most-used rejection reasons.
- **Favourite games** pinned to the sidebar.
- **Global search** across games and runs.
- **Resizable panels** whose layout is remembered.
- **Dark and light themes**, comfortable and compact density.
- **Desktop notifications** when a long bulk operation finishes.

## Security

- **Your API key is stored in the Windows Credential Manager**, encrypted by
  Windows against your user account. It is never written to the database, never
  included in an export, never printed to a log and never rendered in the UI.
  The Settings page can show you a masked preview such as `a1b2••••9f8e` — that
  preview is produced by the backend and is the only form of the key the
  interface ever sees.
- **Crash and error reports are scrubbed.** Error messages returned across the
  IPC bridge are constructed by SRCTools, not passed through from the HTTP
  layer, so a URL containing a key cannot leak into a toast.
- **No credentials in source.** There is nothing to configure at build time; you
  supply your key at first launch.
- **External links are validated.** Video URLs come from run submissions and are
  therefore attacker-controlled text. Only `http:` and `https:` addresses are
  ever handed to Windows; a `file:` or custom-scheme URL is refused and shown to
  you instead.
- **No HTML from the API is ever rendered.** Rules text, run comments and
  usernames are inserted as text nodes. There is no `dangerouslySetInnerHTML`
  anywhere in the codebase.
- **A strict Content Security Policy** with the local asset protocol disabled.
  Embedded players are restricted to the three video hosts SRCTools supports.
- **The webview holds no filesystem capability.** Exports are written by the
  Rust backend to a path you chose in a native save dialog.

## Requirements

| | |
| --- | --- |
| **OS** | Windows 10 (1809+) or Windows 11, 64-bit |
| **WebView2** | Preinstalled on Windows 11 and current Windows 10. The NSIS installer fetches it if missing. |
| **Speedrun.com API key** | Required. Free, from your account settings. |
| **Twitch application** | Optional; only needed to check Twitch links. |

To build from source you also need:

| | |
| --- | --- |
| **Node.js** | 18 or newer (20 LTS recommended) |
| **Rust** | 1.82 or newer, `x86_64-pc-windows-msvc` toolchain |
| **Visual Studio Build Tools** | 2019 or 2022, with the *Desktop development with C++* workload |

## Getting started

### 1. Install the dependencies

```bash
npm install
```

Rust crates are fetched automatically on the first build. SQLite is compiled in
via `rusqlite`'s bundled feature — you do not need to install it separately.

### 2. Run in development

```bash
npm run dev
```

This starts the Vite dev server on port 5173 and launches the Tauri window
against it, with hot reload for the frontend. The Rust side rebuilds when you
change it.

### 3. Build the Windows executable

```bash
npm run build:windows
```

Output lands in `src-tauri/target/release/`:

| Path | What it is |
| --- | --- |
| `srctools.exe` | The standalone executable |
| `bundle/nsis/SRCTools_1.0.0_x64-setup.exe` | NSIS installer (per-user, no admin rights) |
| `bundle/msi/SRCTools_1.0.0_x64_en-US.msi` | MSI package, for deployment |

`npm run build` does the same thing using whatever bundle targets
`tauri.conf.json` lists.

### All available commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server + Tauri window, hot reload |
| `npm run build` | Production build with the configured bundles |
| `npm run build:windows` | Production build, NSIS + MSI explicitly |
| `npm run typecheck` | `tsc --noEmit` over the whole frontend |
| `npm run vite:build` | Typecheck, then build the frontend only |
| `npm run icons` | Regenerate every icon size from `src-tauri/icons/icon.png` |

Rust checks, from `src-tauri/`:

```bash
cargo check
cargo clippy --all-targets
```

## First launch

SRCTools opens on a setup screen.

### Speedrun.com API key

1. Sign in at Speedrun.com.
2. Open <https://www.speedrun.com/settings/api> — there is a button on the setup
   screen that takes you there.
3. Copy your key and paste it into SRCTools.

The key is validated against `GET /profile` before anything is stored. If it is
rejected, nothing is saved. Once accepted it goes straight into the Windows
Credential Manager and the input field is cleared.

You can replace or remove it later under **Settings → Account**. Removing it
deletes it from the credential vault; your local history, statistics and
settings are kept.

### Twitch credentials (optional)

Twitch will not answer questions about a video without an application of its own.
Without credentials, Twitch links still open and play normally — SRCTools simply
reports them as “could not check” rather than guessing.

1. Go to <https://dev.twitch.tv/console/apps> and register an application.
   Any category is fine; the OAuth redirect URL is unused, so
   `http://localhost` is acceptable.
2. Copy the Client ID, generate a Client Secret.
3. Paste both under **Settings → Account → Twitch video checks**.

Both are stored in the credential vault alongside the API key. They must be set
together or cleared together.

## Keyboard shortcuts

Press `?` at any time for the live list, which reflects your own bindings.

| Key | Action |
| --- | --- |
| `A` | Verify the focused run |
| `R` | Reject (opens the reason dialog) |
| `V` | Open the video |
| `O` | Open the run on Speedrun.com |
| `Enter` | Open the detail panel |
| `Space` | Toggle selection |
| `N` / `P` | Next / previous run |
| `F` | Enter Fast Review |
| `Esc` | Close, cancel, or leave Fast Review |
| `Ctrl+A` | Select all |
| `Ctrl+Shift+A` | Clear selection |
| `Ctrl+R` | Refresh the queue |
| `Ctrl+F` | Focus the search box |
| `Ctrl+K` | Command palette |
| `?` | This list |
| `G` then `D` / `Q` / `H` / `S` / `,` | Go to Dashboard / Queue / History / Stats / Settings |

Everything except `Esc` and `Ctrl+K` can be rebound under **Settings →
Keyboard**.

## Where your data lives

| What | Where |
| --- | --- |
| API key, Twitch credentials | Windows Credential Manager |
| Cache, history, settings | `%APPDATA%\com.srctools.app\srctools.db` |
| Logs | `%APPDATA%\com.srctools.app\srctools.log.<date>` (rotated daily) |

The exact database path is shown, and can be copied, under **Settings → Data**.
Set `SRCTOOLS_LOG` to change the log level (for example `SRCTOOLS_LOG=debug`).

Cached API responses expire on their own and can be pruned or cleared at any
time — everything in the cache came from Speedrun.com and can be fetched again,
so clearing it costs API requests and time, never records. Your local moderation
history is kept separate precisely because it is the one thing here that
*cannot* be re-fetched; clear it deliberately with the **Clear** button on the
History page.

## Troubleshooting

**“Speedrun.com rejected the key.”**
The key is wrong, or it was regenerated on the website. Copy it again from
<https://www.speedrun.com/settings/api>.

**A run I can see in the queue fails to verify.**
Speedrun.com checks moderator rights per game at the moment of the action. If
you are not a moderator of that game, the API refuses it. Turn on
**Settings → Moderation → Only show games I moderate** to keep those runs out of
the queue.

**Everything is slow, or requests are being refused.**
SRCTools keeps its own request budget below Speedrun.com's published limit and
waits rather than letting the API refuse a call. If you have several tools
running against the same key, lower **Settings → Moderation → Requests per
minute**. The live usage is shown directly beneath it.

**Twitch videos always say “could not check”.**
That is what SRCTools reports when it has no Twitch credentials, or when
Twitch's API is unreachable. It is not a statement about the video. Add
credentials under **Settings → Account**.

**A video I know is fine shows as “could not check”.**
The provider did not answer. Re-check it from the detail panel, or drop the
remembered verdict under **Settings → Data**.

**A game's rules look out of date.**
Rules are cached. **Settings → Data → Refresh game data → Categories** drops the
cached copy and the next view re-fetches it.

**The window opens blank.**
WebView2 is missing or broken. Install the Evergreen Runtime from
<https://developer.microsoft.com/microsoft-edge/webview2/>.

**The build fails with a linker error.**
The MSVC C++ build tools are not installed. Install *Desktop development with
C++* from the Visual Studio Installer and confirm with
`rustup target list --installed` that `x86_64-pc-windows-msvc` is present.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module layout, the IPC contract,
the database schema, the caching and rate-limiting strategy, and the reasoning
behind the video-status taxonomy.

## Licence

MIT.

SRCTools is an independent project. It is not affiliated with, endorsed by, or
operated by Speedrun.com.
