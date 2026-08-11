# SRCTools — Architecture

This document describes how SRCTools is built and, more usefully, *why* it is
built that way. The design is dominated by one constraint: **the application
must never state something about a run that it does not actually know.** Most of
what follows is a consequence of taking that seriously.

---

## Contents

1. [Shape of the application](#1-shape-of-the-application)
2. [Backend (Rust)](#2-backend-rust)
3. [Frontend (React + TypeScript)](#3-frontend-react--typescript)
4. [The IPC contract](#4-the-ipc-contract)
5. [Database](#5-database)
6. [Caching](#6-caching)
7. [Rate limiting](#7-rate-limiting)
8. [Video verification](#8-video-verification)
9. [Run analysis](#9-run-analysis)
10. [Security model](#10-security-model)
11. [Error handling](#11-error-handling)
12. [Build pipeline](#12-build-pipeline)

---

## 1. Shape of the application

```
┌──────────────────────────────────────────────────────────────┐
│  WebView2 — React 18 + TypeScript                            │
│                                                              │
│  pages/      Dashboard Queue RunDetail FastReview Games       │
│              History Stats Settings Setup                     │
│  components/ Chrome Sidebar CommandPalette RejectDialog       │
│              ShortcutHelp Toasts ui.tsx                       │
│  store/      app session queue detail moderation              │
│              dashboard history ui        (Zustand)            │
│  ipc.ts      the only module that calls invoke()             │
└───────────────────────────┬──────────────────────────────────┘
                            │ Tauri IPC — 69 typed commands
┌───────────────────────────┴──────────────────────────────────┐
│  Rust                                                        │
│                                                              │
│  commands/   auth library moderation prefs queue records      │
│  src_api/    client endpoints models rate_limit              │
│  video/      detect providers types                          │
│  analysis/   checks types                                     │
│  db/         schema cache history prefs models                │
│  secrets.rs  Windows Credential Manager                       │
│  state.rs    shared AppState                                  │
└──────┬──────────────────────┬─────────────────┬──────────────┘
       │                      │                 │
  Speedrun.com API   YouTube/Twitch/Vimeo   SQLite + Credential
                                              Manager
```

The frontend owns presentation and interaction. The backend owns *everything
that touches the network, the disk or a credential*. That split is not
stylistic: it is what allows the webview to hold no filesystem capability and
never to see an API key.

### Why Tauri

The application needs OS-native credential storage, an embedded SQLite database
and outbound HTTP that is not subject to browser CORS. Tauri provides a native
backend for all three while keeping the UI in a webview, and produces a ~8 MB
executable rather than a bundled browser runtime.

---

## 2. Backend (Rust)

| Module | Responsibility |
| --- | --- |
| `lib.rs` | App setup: data directory, logging, state construction, command registration, startup report. |
| `main.rs` | Thin entry point; `windows_subsystem = "windows"` so no console appears. |
| `state.rs` | `AppState`: the HTTP client, rate limiter, database handle and cached credentials, shared across commands. |
| `error.rs` | `AppError` and `AppResult`. Every command returns this. |
| `dto.rs` | The types crossing the IPC boundary, `#[serde(rename_all = "camelCase")]`. |
| `secrets.rs` | Credential Manager access. The only module that can read a key. |
| `src_api/` | Speedrun.com HTTP client, endpoint builders, response models, rate limiter. |
| `video/` | URL detection, provider probes, the status taxonomy. |
| `analysis/` | Heuristic checks over a run and its context. |
| `db/` | Schema and migrations, cache, history, preferences. |
| `commands/` | The 69 `#[tauri::command]` functions, grouped by area. |
| `util.rs` | Small shared helpers. |

### Command modules

| Module | Commands | Area |
| --- | --- | --- |
| `auth.rs` | 10 | Key storage, profile, connection test, Twitch credentials, rate-limit status |
| `library.rs` | 9 | Games, categories, variables, levels, leaderboards, platforms, regions |
| `moderation.rs` | 7 | Verify, reject, delete, bulk, cancel, retry |
| `prefs.rs` | 26 | Settings, templates, favourites, layouts, shortcuts, cache management |
| `queue.rs` | 7 | Queue, run detail, video checks, dashboard |
| `records.rs` | 10 | History, audit log, statistics, exports |

### Concurrency

Tauri commands are `async` and run on a Tokio multi-threaded runtime. SQLite is
accessed through a `parking_lot::Mutex<Connection>` held only for the duration of
a statement — the database is fast and local, and a connection pool would add
complexity for no measurable gain at this scale.

Long operations run entirely in the backend. Bulk moderation emits a Tauri event
per completed item, so the progress bar and its success/failure counts come from
the backend's own view of the batch rather than the frontend guessing. Batch
video checks return in one call. Either way the webview is never blocked; it is
only ever notified.

---

## 3. Frontend (React + TypeScript)

### State

Zustand, one store per domain:

| Store | Holds |
| --- | --- |
| `app` | Current page, panel layout, Fast Review flag, command palette |
| `session` | Profile, connection, settings, shortcuts, templates, favourites, moderated games |
| `queue` | Runs, filters, sort, selection, focus index, column definitions |
| `detail` | The open run's detail, its video checks and analysis |
| `moderation` | In-flight actions, per-run busy set, bulk progress |
| `dashboard` | Summary figures |
| `history` | Local log with its own filters |
| `ui` | Toasts and confirmation dialogs |

Two access patterns, and mixing them up is the most common bug in a Zustand
codebase:

- **Selectors** (`useQueue((s) => s.focusIndex)`) for anything read during
  render, so the component re-renders when it changes.
- **`.getState()`** for event handlers and effects, where subscribing would only
  cause needless renders.

`ui` is deliberately a store rather than React context, so non-component
modules — including the IPC error path — can raise a toast.

### Performance

- The queue table is virtualized with `@tanstack/react-virtual`; only visible
  rows exist in the DOM, so thousands of runs scroll at full frame rate.
- Filtering and sorting are memoized derivations over the run array.
- Video checks are batched into one backend call, not one per row.
- Every network-backed view has a skeleton state. Nothing blocks the main
  thread; the window cannot freeze on a slow API.

### Styling

Plain CSS with custom properties, in four files:

| File | Contents |
| --- | --- |
| `tokens.css` | Colour, spacing, radius, typography and shadow variables, per theme |
| `layout.css` | Page shell, toolbars, grids, panels |
| `components.css` | Buttons, inputs, badges, cards, tables, modals, menus, toasts |
| `pages.css` | Page-specific composition |

Theme and density are `data-` attributes on `<html>`, so switching either is one
attribute write and no re-render.

---

## 4. The IPC contract

`src/ipc.ts` is the only module in the frontend that calls `invoke`. Everything
else imports a typed wrapper. Two properties follow:

1. **Argument names are checked once.** Tauri converts a command's snake_case
   Rust parameters to camelCase on the JS side. The wrappers are the single
   written record of what each command expects, so a rename breaks compilation
   in one file rather than silently failing at runtime.
2. **Errors arrive typed.** Rust serialises every failure as
   `{kind, message, retryable, hint}`. `toAppError` normalises anything else
   into the same shape, so a `catch` block never has to guess.

Types are declared twice — as Rust structs in `dto.rs` and TypeScript interfaces
in `types.ts` — rather than generated. At this size the generator's dependency
cost exceeded its benefit, and the serde rename attributes make the mapping
mechanical. `npm run typecheck` catches drift on the frontend side.

---

## 5. Database

One SQLite file, created on first launch, versioned with `PRAGMA user_version`.

| Table | Purpose |
| --- | --- |
| `cache_entries` | Keyed API payloads. `(kind, key)` primary key so one namespace can be invalidated alone. |
| `video_checks` | Verdicts keyed by normalised URL, so every submission form of the same video shares a row. |
| `moderation_history` | Every action, successful or failed, with the run's context denormalised so history survives a cache clear. |
| `audit_log` | Bulk and destructive operations summarised per batch, with success and failure counts. |
| `settings` | One JSON value per key. |
| `rejection_templates` | Reusable reasons; `builtin` marks the seeded ones so they can be restored. |
| `favorite_games` | Pinned games with sort order. |
| `layouts` | Panel sizes and column visibility, one JSON blob per view. |
| `shortcuts` | Bindings that override the frontend defaults. |

Two decisions worth stating:

- **History is denormalised on purpose.** Game name, category, players and time
  are copied into each row rather than joined from the cache. Clearing the cache
  must not turn your own history into a list of opaque IDs.
- **Failed attempts are recorded.** A bulk action that half succeeded is only
  auditable if the failures were written down too.

Migrations run inside a transaction on startup; a failure leaves the previous
schema intact rather than a half-migrated database.

---

## 6. Caching

Every cached namespace has its own TTL, chosen by how fast the underlying data
actually changes:

| Namespace | TTL | Why |
| --- | --- | --- |
| `platforms`, `regions` | 7 days | Effectively static. |
| `game`, `categories`, `levels`, `variables` | 12 hours | Rules change occasionally. |
| `moderated_games`, `user`, `profile` | 6 hours | Changes with moderator assignments. |
| `leaderboard` | 30 minutes | Moves whenever a run is verified. |
| `run` | 5 minutes | The thing being actively worked on. |

Expired rows are kept until pruned rather than deleted on read, so
`cache_prune` can reclaim space in one pass and a read never pays for a write.

`cache_invalidate` accepts exactly eleven namespace strings and rejects anything
else with an `InvalidInput` error — an unrecognised namespace is a bug, not a
no-op to swallow.

Clearing the cache is safe by construction: everything in it came from
Speedrun.com and can be fetched again. It costs API requests and time, never
records. The Settings page says so, because a "clear data" button that might
destroy your own history should not look like one that cannot.

---

## 7. Rate limiting

Speedrun.com asks for roughly 100 requests per minute and answers a 420 when you
exceed it. SRCTools paces itself rather than reacting to rejections.

`RateLimiter` is a sliding-window token bucket shared by every outbound request.
`acquire()` blocks until a slot is free, so a burst — checking 200 videos, say —
degrades into a steady stream instead of a wall of errors. A server-imposed
back-off outranks the local window entirely: if Speedrun.com says wait, all
traffic stops until it elapses, whatever the local budget thinks.

The budget is configurable between 10 and 100 requests per minute. The backend
clamps the value and returns what it actually applied, so a UI that tries to set
500 is corrected rather than silently ignored — the Settings field syncs back
from the stored value for exactly this reason.

---

## 8. Video verification

This is the feature with the strictest invariant in the codebase, and it is
enforced structurally rather than by convention.

Three layers:

1. **`detect`** turns submitted text into a `VideoRef` — platform, native ID,
   canonical key — with no network access. Text that is not a usable video
   address becomes `INVALID_URL` here, before anything is requested.
2. **`providers`** asks the platform itself. YouTube and Vimeo answer through
   their public oEmbed endpoints; Twitch through the Helix API, which requires
   your own application credentials.
3. **`video/mod.rs`** joins the two and guarantees the invariant: **only a
   provider can produce `DELETED`.** A transport failure produces
   `NETWORK_ERROR`. An unsupported host produces `UNKNOWN`. There is no code
   path from a timeout to a verdict.

`check_url` never returns `Err`. An unreachable provider is a *result the
moderator needs to see*, not an error that aborts a batch of two hundred.

Cache policy follows the same logic, which is why caching lives in `db::cache`
and not in the video module — the TTL depends on the verdict:

| Verdict | Cached for |
| --- | --- |
| `DELETED`, `INVALID_URL` | 30 days — a deleted video does not come back. |
| `AVAILABLE`, `PRIVATE`, `UNAVAILABLE`, `REGION_RESTRICTED` | 6 hours — the uploader can change these. |
| `PROCESSING` | 15 minutes — expected to change shortly. |
| `UNKNOWN`, `NETWORK_ERROR` | **Never.** Caching a non-answer would make a transient failure permanent. |

The presentation layer completes the guarantee: `UNKNOWN` and `NETWORK_ERROR`
render in a neutral tone, never red, so SRCTools' own network trouble cannot
push a moderator toward rejecting a run.

---

## 9. Run analysis

Nine check groups run over a run and its context — its videos, times,
leaderboard position, platform and system, dates, variables, submission text and
any prior local record. Each produces zero or more `Finding`s.

A finding carries:

- **Severity** — `note`, `warning` or `critical`.
- **Confidence** — `confirmed` (from the run data or a provider's own answer),
  `likely`, `heuristic` (a pattern worth a look, not evidence), or
  `unverifiable` (could not be checked; unknown, not a problem).
- A **detail** explaining what was observed, and often a **suggestion** for what
  to check.

The findings collapse into exactly one of three recommendations:

| Recommendation | Meaning |
| --- | --- |
| `nothing_flagged` | No automated check raised a flag. The decision is still yours. |
| `needs_review` | Checks raised flags for a human to review. |
| `cannot_verify` | Something could not be checked at all. |

**There is deliberately no `approve` or `reject` member.** The enum has no such
variant, so no future code path can produce one by accident. Heuristics inform;
they do not decide. The UI reinforces this by labelling every finding with its
confidence, so a "heuristic" flag can never be mistaken for a confirmed fact.

---

## 10. Security model

### Credentials

The Speedrun.com API key and Twitch credentials live in the Windows Credential
Manager via the `keyring` crate, encrypted by Windows against the user account.

- `secrets.rs` is the only module that can read them.
- They are never written to SQLite, never included in an export, never passed to
  a formatter, and never returned across the IPC bridge.
- The frontend can obtain a **masked preview** (`a1b2••••9f8e`), produced by the
  backend. That is the only form of the key the UI ever holds.
- A key is validated against `GET /profile` before it is stored. A rejected key
  is not written anywhere.

### Logging

`reqwest`'s header logging is off and no code path passes a key to a formatter,
so no log line can contain one. Errors crossing the IPC boundary are constructed
by SRCTools rather than passed through from the HTTP layer, which means a URL
containing a key cannot leak into a toast or a crash report.

### Untrusted input

Video URLs, run comments, rules text and usernames all come from user
submissions on Speedrun.com and are treated as attacker-controlled:

- **URLs** pass `isSafeExternalUrl` before reaching the OS handler. Only `http:`
  and `https:` are allowed; a `file:` or custom-scheme URL is refused and shown
  to the moderator instead of being opened.
- **Text** is inserted as text nodes. There is no `dangerouslySetInnerHTML`
  anywhere in the codebase.
- **Embeds** are restricted by CSP to `youtube-nocookie.com`, `player.twitch.tv`
  and `player.vimeo.com`.

### Capabilities

The Tauri capability set grants the main window only what it uses: window
controls, `opener` for URLs, clipboard read/write, dialog open/save, and
notifications. The local asset protocol is **disabled** — every image SRCTools
displays is a remote `https` URL, so there is no reason to expose local files to
the webview.

Exports are written by the Rust backend to a path chosen in a native save
dialog. The `fs` plugin is not installed at all, so the webview has no
filesystem capability to misuse.

### Destructive actions

Deletion always confirms, regardless of settings. Bulk operations require an
explicit `confirm: true` across the bridge — there is no default on either side.
Every batch is written to `audit_log` with its success and failure counts before
it is reported as finished.

---

## 11. Error handling

`AppError` carries four fields, and each exists to answer a question the UI
needs to answer:

| Field | Question |
| --- | --- |
| `kind` | What class of failure was this? |
| `message` | What do I tell the moderator? |
| `retryable` | Should I offer a "Try again" button? |
| `hint` | What can they actually do about it? |

Kinds cover the failures that need different handling: no key configured, a
rejected key, insufficient permission, not found, rate limited, service
unavailable, an unexpected HTTP status, a network failure, a timeout, an
unparseable response, invalid input, a database error, unavailable credential
storage, file I/O and internal faults. The frontend renders `message + hint`
through `errorText`.

The principle throughout: **a failed check is reported as a failed check.** A
network error while loading a run's analysis produces "the checks could not be
loaded — that says nothing about this run", not an empty analysis panel that
reads as a clean bill of health.

Errors are shown where they happened. A page that cannot load shows an
`ErrorState` with a retry; a background failure raises a toast that stays until
dismissed, because a failure that vanishes after four seconds is a failure the
moderator may never have read.

---

## 12. Build pipeline

```
npm run build:windows
    │
    ├─ npm run vite:build
    │     ├─ tsc --noEmit          type checking, no output
    │     └─ vite build            bundle → dist/
    │
    └─ tauri build --bundles nsis,msi
          ├─ cargo build --release
          └─ bundle dist/ + srctools.exe → installers
```

TypeScript is configured strictly: `strict`, `noUnusedLocals`,
`noUnusedParameters`, `noUncheckedIndexedAccess`,
`noFallthroughCasesInSwitch`. The first two mean an unused import is a build
failure, not a lint warning — which is the intent.

The release profile optimises for size (`opt-level = "s"`, LTO, one codegen
unit, symbols stripped, `panic = "abort"`), producing an ~8 MB executable and a
~3 MB NSIS installer.

### Verifying a change

```bash
npm run typecheck                       # frontend
cd src-tauri && cargo clippy --all-targets   # backend lints
cd src-tauri && cargo test              # backend unit tests
npm run build:windows                   # full release build
```

---

## Appendix: extending SRCTools

**Adding a command.** Write the `#[tauri::command]` in the right
`commands/` module, register it in the `generate_handler!` list in `lib.rs`, add
its DTO to `dto.rs` if it returns something new, mirror the type in
`src/types.ts`, and add the wrapper to `src/ipc.ts`. The wrapper is what makes
the argument names compile-checked; skipping it defeats the point.

**Adding a video provider.** Extend `VideoPlatform`, add detection in
`video/detect.rs`, add the probe in `video/providers.rs`, and — if it needs an
embed — add its player origin to the CSP `frame-src` list. The probe must map
transport failures to `NETWORK_ERROR` and unrecognised responses to `UNKNOWN`.
Returning `DELETED` because a request failed would break the invariant the
feature exists to uphold.

**Adding an analysis check.** Add the function in `analysis/checks.rs` and call
it from `run_all`. Choose the confidence honestly: `heuristic` for a pattern,
`confirmed` only for something read directly from the run data or a provider's
own answer. A check may never conclude that a run is invalid — it describes what
it saw and leaves the decision to the person reading it.
