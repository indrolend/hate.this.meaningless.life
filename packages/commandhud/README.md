# DATA CommandHUD core

`hud` is the persistent local development front door for DATA. It verifies the project root, records Git authority around every command, preserves raw output, and emits a deterministic continuation packet.

## Primary product surface

The terminal context-condensing shell launched by `CommandHUD Shell.cmd` or `hud shell` is the primary CommandHUD interface. It owns the shortest supported development loop: paste an ordinary command, execute it against the real local repository, retain immutable evidence, display a condensed result, and copy that result back to an LLM. Robustness, accessibility, and usability work should target this functional surface first; visual layers must remain replaceable clients.

The CLI remains first-class automation over the same core. The local server and browser renderer are secondary clients and must continue to consume the same semantic state; they must not become a separate authority or dictate the core architecture.

## Install the local entrypoint

From the repository root:

```text
npm link
```

This exposes the repository's `hud` bin through npm's user-level binary directory. It does not install a service or start a UI. Remove it with `npm unlink --global digital-breakdown-apk`.

Without linking, use `npm run hud -- <command>`.

## Windows desktop launcher

Double-click `CommandHUD.cmd` at the repository root, or run:

```powershell
node tools/hud/cli.mjs desktop
```

The launcher verifies the repository, acquires one desktop-instance lock for it, starts the same loopback-only authoritative HUD server on an available port, and opens the renderer in a dedicated Microsoft Edge or Google Chrome app-mode window. Closing that window stops the owned server and releases the lock. A stale lock from a dead launcher is replaced; a live owner blocks a second desktop instance.

The browser receives only the local URL and uses a CommandHUD-owned profile under `%LOCALAPPDATA%\CommandHud\desktop\profiles`. This owned desktop session enables the terminal capability described below; ordinary `hud serve`, LAN, and static views do not. All terminal work still uses the existing immutable evidence and state model. Startup recovery runs before the application window opens, so corrupt or still-active detached evidence fails closed with a terminal-visible explanation.

This is the first thin Windows host, not the final packaged `CommandHUD.exe`. It deliberately reuses an installed Chromium app-mode host to prove repository selection, single-instance ownership, runtime lifetime, and standalone-window behavior without adding Electron. A later WebView2 executable can replace this host while retaining the same server/core contract.

### Historical prototype relationship

The earlier Windows Forms prototype remains in the separate `hate.this.meaningless.life` repository at `legacy/commandhud/CommandHud-v21-corebridge.ps1`. It established useful interaction behavior: persistent cwd, focused command input, Enter-to-run, streaming output, Stop, copy, and local command recall. Those are product references, not a second authority.

The DATA core supersedes the prototype's session JSONL/log ownership and PowerShell-runspace execution with verified repository identity, immutable runs, typed browser operations, evidence currency, cancellation, recovery, and Undo. The desktop launcher does not invoke or copy the legacy execution layer. Features should migrate by expressing their intent through the DATA runtime rather than maintaining two histories or state models.

## Workflow

```text
hud context
hud state
hud state --json
hud objective "Investigate Windows renderer regression"
hud frontier "Rebuild and visually verify shadows"
hud continue
hud run --objective "Verify native gameplay" npm test
hud packet --copy
hud history
hud last --json
hud tools
hud update
```

## Terminal-only HUD

Run `hud shell` for a persistent terminal interface over the same immutable evidence and reduction system as the desktop command bar. Paste ordinary commands directly; CommandHUD executes them in the selected shell, displays the shortened result, and automatically copies that identical ChatGPT-ready context to the clipboard while retaining complete stdout and stderr.

On Windows, `CommandHUD Shell.cmd` at the repository root provides the same terminal-only interface as a double-clickable launcher. It finds the HUD relative to the clone instead of relying on a fixed checkout path, reports a clear prerequisite error when Node.js is unavailable, and remains valid across branches. Desktop `.lnk` files are intentionally machine-specific; point one at the repository-owned `.cmd` in each clone.

```text
hud shell
hud shell --shell bash
hud shell --no-animation
"CommandHUD Shell.cmd" --no-animation
hud shell --plain
"CommandHUD Shell.cmd" --plain
hud shell --tui
"CommandHUD Shell.cmd" --tui
```

The terminal keeps repository-contained cwd changes between commands. `/copy`, `/context`, `/raw`, `/history`, `/undo`, `/shell`, `/cwd`, and `/exit` expose the recorded context and controls without requiring repeated `hud run` wrappers. Undo remains preview-first. Automatic clipboard failure is reported without changing the real command result, and `/copy` retries the last context explicitly.

Interactive sessions reuse the face-state grammar from the original CommandHUD prototype: `(._.)` idle, an eye cycle while running, `(^_^)` pass, `(x_x)` fail, and `(-_-)` stopped. Only the factual status row is replaced in place; the command and evidence remain ordinary terminal text. `--no-animation`, `COMMANDHUD_REDUCED_MOTION=1`, `REDUCE_MOTION=1`, `TERM=dumb`, and noninteractive output disable motion. `NO_COLOR` remains compatible because this first visual slice does not depend on color.

The default interface is deliberately line-oriented: a simple `> ` prompt, real command execution, condensed output, automatic copy, and slash-command access to evidence and Undo. It does not use the alternate screen, terminal mouse reporting, or cursor-positioned panels.

`--tui` opts into the experimental fixed visual client. That client keeps the face/status header, `> ` input field, bounded output panel, and mouse controls in stable regions. Its footer maps clicks to the same slash commands available from the keyboard. Mouse reporting is disabled before leaving the alternate screen. The TUI must never become runtime authority or weaken the plain shell path.

`hud run` streams the command while writing separate raw stdout and stderr logs. Use `--quiet` when only the final reduced packet is wanted. A nonzero underlying command remains nonzero: `PASS` exits 0, `FAIL` exits 1, `BLOCKED` exits 2, and HUD transport/tooling `ERROR` exits 3.

## State

Transient state does not enter the repository. The default Windows location is:

```text
%LOCALAPPDATA%\CommandHud\
```

Layout:

```text
CommandHud/
  projects/
    indrolend_data.json
    indrolend_data/state.json
  runs/
    indrolend_data/<run-id>/
      run.json
      stdout.log
      stderr.log
```

Each `run.json` is created immutably and records repository currency before and after execution. `state.json` contains only the most recent run pointer plus the current objective and frontier. History is derived from run records; there is no parallel history database.

`hud continue` compares durable evidence with the current HEAD and a content fingerprint of tracked and non-ignored untracked files. Evidence is `CURRENT`, `STALE`, or `UNKNOWN`; legacy records without currency remain readable and are classified `UNKNOWN`.

## Current architecture

The core follows one directional data flow:

```text
real command output
  -> immutable stdout.log / stderr.log
  -> deterministic reduction
  -> run.json semantic record
  -> derived presentation, workflow, and current-state views
  -> text, JSON, or visual renderer
```

`core.mjs` owns project resolution, Git authority, command execution, raw evidence, reduction, immutable run records, workflow derivation, and the renderer-neutral current state. `cli.mjs` parses commands and renders those core objects. Renderers should consume core objects instead of reparsing terminal output.

There is deliberately no mutable workflow database. Workflow state is derived from immutable run records. `state.json` remains small and contains only the latest run pointer plus objective/frontier working state.

## Workflow runs

A run joins a workflow when the CLI receives workflow metadata:

```text
hud run --workflow-id verify-1 --workflow-name "verify change" --stage test --stage-index 1 --stage-count 2 npm test
hud workflow verify-1
hud workflow verify-1 --json
```

Stage retries create new immutable run records. The workflow view selects the latest attempt for each stage and reports pending, failed, blocked, or completed state.

The Windows bridge also accepts this compact input form:

```text
@hud verify-1 "verify change" test 1 2 :: npm test
```

## Canonical semantic state

`hud state` and `hud state --json` render the same `currentState()` object. It is a derived snapshot, not another persisted authority. Current fields are:

```text
project  cwd  git  repository  workflow  last  next  status
```

This is the boundary for quick-context text and future visual renderers. Add facts here only when an existing authoritative source can derive them and a real renderer needs them.

## Repository map prototype

The renderer consumes the same repository projection exposed by `hud state --json`. The projection is built from Git tracked files plus nonignored untracked files, with deterministic hierarchy, mechanical file metadata, and porcelain Git status where known.

Inspect the projection without dumping every path:

```text
node tools/hud/cli.mjs tree
```

Start the local adapter and open the local page:

```powershell
node tools/hud/cli.mjs serve
```

Open `http://127.0.0.1:8765/`. The tree and map consume one projection. The map progressively displays the repository root, a selected directory, and that directory's immediate children. File focus displays only mechanically derived type, size, path, and Git state.

The adapter binds to loopback by default. It exposes read operations for state, tree, static assets, and projected media, plus narrow typed operation boundaries. `POST /operations/search` accepts only same-origin JSON containing `query` and repository-relative `scope`, then delegates to `searchRepository()`. `POST /operations/repository-command` accepts only a discovered command `name`; the runtime rediscovers that identity before execution. Ordinary `hud serve` has no arbitrary shell-execution capability. Use `hud serve --lan` only when explicitly testing from another device on the local network.

## Desktop terminal and shells

The trusted desktop launcher enables one additional local-only capability: ordinary terminal commands through the persistent command bar. The runtime detects and explicitly labels PowerShell, Bash, and Windows Command Prompt when installed; unavailable shells are not offered. Shell choice is never inferred from command text. PowerShell commands use an encoded noninteractive wrapper, Bash uses the installed native Bash or WSL, and Command Prompt uses a private temporary batch wrapper. The exact user-entered command is stored separately from that transport.

Each command records stdout, stderr, exit status, duration, Git state, and content delta through the same immutable run path used by repository commands. The command's final working directory becomes the next command's starting directory only when it resolves to an existing directory inside the verified repository. An attempted directory escape is recorded as `outside-repository` and is not adopted. Commands can be cancelled through the existing active-run identity, and partial content changes remain eligible for evidence-backed Undo.

After any desktop terminal command, **Copy handoff** produces a bounded context packet intended for the ordinary chat-to-terminal loop. It includes repository/branch/cwd, explicit shell, exact user command, truthful status and exit code, changed paths, up to 40 cleaned tail lines from stdout and stderr, and the immutable raw run reference. Full evidence is never replaced or rewritten. Large excerpts are visibly marked `tail, bounded`.

The handoff API and `hud handoff --json` report observed `rawBytes`, `contextBytes`, `savedBytes`, and `reductionPercent`. The desktop displays the same raw-to-context comparison after copying. These are byte-density measurements for that recorded operation, not estimates of developer productivity or token cost. Small outputs can legitimately have zero reduction because provenance fields cost more than the raw text.

The terminal endpoint accepts only `{ command, shell }`, only while the server was created by the desktop host. The browser cannot supply a working directory, executable transport, evidence path, or process identity. This is a desktop authorization boundary rather than a claim that arbitrary project commands are safe.

## Live local session

Every view attached to one running HUD server now observes the same live repository session through `GET /events`. The server emits small server-sent events for operation lifecycle changes, completed semantic-state changes, and shared navigation. Clients fetch authoritative `currentState()` after a state event; the event itself does not become another repository state model.

Directory and file focus can be shared through `POST /session/navigation`. The server accepts only a generated client identity and paths that exist in the current Git-backed repository projection. It rejects invented or out-of-repository paths, assigns a monotonic session revision, and broadcasts the accepted selection to the other connected views. A client ignores its own echoed selection. Camera position and transient open panels remain client-local so another screen does not make the current screen physically difficult to use.

`GET /runtime` reports the repository session identity, connected event-stream clients, event sequence, and latest shared navigation alongside the existing operation and terminal facts. This session is currently process-local: restarting the runtime preserves immutable operation evidence but resets connected-client and navigation presence. There is no account, cloud relay, remote authentication, or background filesystem watcher in this checkpoint.

File focus uses native browser controls to preview projected MP4, MOV, WebM, MP3, WAV, M4A, AAC, OGG, and FLAC files. Image formats are displayed directly. Media delivery supports byte ranges for seeking. Actual playback still depends on the codecs supported by the active browser; a `.mov` container is not proof that its internal codec can be decoded.

## Search and compact handoff

Search is a recorded development operation backed by the installed `rg` executable. It uses literal matching, preserves exact stdout and stderr in the immutable run directory, and derives both human and JSON views from the same structured operation record:

```powershell
node tools/hud/cli.mjs search currentState tools/hud
node tools/hud/cli.mjs search --json currentState tools/hud
node tools/hud/cli.mjs handoff --copy
```

`rg` exit code 1 is represented truthfully as a successful zero-match search. Missing tools are blocked and other search-tool failures remain failed. The compact handoff lists the repository, branch, scope, exact command, factual file/line counts, and the immutable run ID and raw evidence paths. The live map reads `lastOperation` from `currentState()` and highlights those same paths; it does not infer dependencies or file meaning.

Selecting a matching file in the live map requests a bounded read-only excerpt from `/source`. The server accepts only a file in the current repository projection that also appears in the latest Search record, derives the line numbers from that record, limits context and file size, rejects binary content, and reports whether the Search evidence is `CURRENT` or `STALE`. Snapshot mode does not claim source access.

The source header follows the deterministic file order already stored on the Search operation. Previous and next controls move directly between matching files through the existing `openFile()` navigation path; they do not create another result index.

Repository-root searches normalize ripgrep's leading `./` so result paths retain the same identity as repository projection paths. The result panel exposes those factual paths as direct file-focus actions. In live mode, the Search toolkit also fetches and copies the actual compact packet from `/handoff`; snapshot mode retains the CLI-copy fallback.

The visual command bar has two explicit modes. Terminal is the default: in the trusted desktop application it runs commands through the explicitly selected installed shell; in ordinary live-browser or static mode it only stages and copies them. Power users can also type `search "query" scope` there. Choosing Search from the toolkit enters a focused Search mode where the input is literal query text and scope is selected separately as Repository or Current Directory. This lets multiword queries remain unquoted while keeping the operation boundary visible.

The single main HUD menu combines workspace actions, Search, Git helpers, selection tools, and the Library derived from `discoverCommands()` in the same live or snapshot state as the repository map. It lists the current repository's declared package scripts and factual command adapters instead of maintaining another curated command list. Section headings organize one searchable directory; they are not separate menus. Selecting a command stages its exact text in Terminal mode for inspection or editing and does not grant the browser arbitrary execution.

In live mode, a Library entry can be run only after an explicit confirmation that shows the resolved command and warns that repository commands can execute arbitrary local code. The renderer submits the stable discovered identity, such as `npm:hud:test`, rather than executable text. The runtime rediscovers that identity, executes its runtime-owned argument vector without a shell, and records the resolved command, status, duration, reduction, Git state, stdout, and stderr through the existing immutable run system. The same operation is available directly as `node tools/hud/cli.mjs repository-command npm:hud:test`. Static mode remains staging-only.

## Immutable operation history

The live History control projects existing structured run records; it does not create a history database. `GET /history` returns bounded summaries with operation identity, factual result, duration, status, and `CURRENT`, `STALE`, or `UNKNOWN` evidence currency. `GET /history/:runId` returns the existing operation, presentation, Git snapshots, raw evidence paths, and compact handoff. Run IDs are validated before reading the project-specific immutable run directory.

Selecting a recorded Search reconstructs its saved matches and repository highlights without executing `rg` again. Source excerpts accept that validated Search run identity and retain the same projected-file, recorded-match, size, binary, and context limits as the latest-Search view. Selecting a recorded repository command shows its saved reduction and evidence reference; it does not infer test ownership or touched files.

## Evidence-backed Undo

Repository-command runs capture their own content-level worktree delta as a full-index Git binary patch in the immutable run directory. The prominent Undo control selects the latest recorded reversible operation, asks the runtime to check the inverse patch against the current worktree, and always presents the affected paths before enabling Apply Undo. The renderer submits only the target run ID.

Undo is a new forward operation: it runs the recorded inverse, captures its own inverse delta, and writes another immutable evidence record. Undoing that Undo provides a factual Redo. If later content overlaps the recorded patch, `git apply --reverse --check` classifies the plan as `CONFLICT` and no mutation is attempted. Read-only and no-change operations report `NO_CHANGE`. This initial boundary restores worktree content only; it does not rewrite commits, reverse pushes, or claim to compensate for external effects.

CLI parity is available through `node tools/hud/cli.mjs undo-plan <runId>` and `node tools/hud/cli.mjs undo <runId>`. Both derive the action from the runtime-owned immutable record; neither accepts a patch from the caller.

## Runtime serialization and bounded evidence

The local server permits only one typed operation at a time for its repository. Search, repository commands, and Undo share that boundary because each writes immutable run state even when the repository content is read-only. A concurrent request receives HTTP `409` with the active operation type, label, and start time; `GET /runtime` exposes the same factual BUSY or ready state. Undo performs both its final inverse-patch check and application inside this boundary, so another HUD operation cannot race between them.

History can display raw stdout and stderr through `GET /history/:runId/evidence/stdout` and `/stderr`. The caller supplies a validated run identity and stream name, never a filesystem path. Responses are limited to 1–500 requested lines and at most the final 64 KiB, report the complete evidence size, and state whether the returned text is complete or a bounded tail. The original evidence file remains unchanged in the immutable run directory.

The main HUD menu mechanically groups package scripts by their colon-separated namespace, including HUD, Android, Native, LG, and maintenance-related groups. Unnamespaced scripts and factual repository adapters remain in General and Tools. Typing searches across every section. Undo, immutable History, Refresh, and compact handoff also live in this same menu instead of occupying separate header menus or buttons. These groups are derived from `currentState().commands`; they do not introduce a second command catalog.

## Live command lifecycle and cancellation

While a repository command is active, `GET /runtime` reports its runtime-owned run identity, exact resolved command, elapsed lifecycle, and whether it can be cancelled. The visual command result follows `starting`, `running`, and `cancelling` states, and reads a bounded tail of the active stdout evidence from `GET /runtime/evidence/stdout`. The renderer never supplies an evidence path or process ID.

`POST /operations/cancel` accepts only the currently active run identity. It signals the existing command execution owned by the server; it cannot select or terminate an arbitrary process. On Windows, CommandHUD asks the spawned process tree to terminate and escalates to a forced tree termination after a short grace period. Other platforms use `SIGTERM` followed by `SIGKILL` after the same grace period.

Cancellation still completes an immutable `CANCELLED` run record with the output produced before termination, Git before/after state, and the captured content delta. Output may therefore contain complete-looking lines emitted before the cancellation took effect; the authoritative operation status remains `CANCELLED`. Partial repository changes remain in the worktree rather than being silently discarded, and the existing evidence-backed Undo flow is offered when that captured delta is safe to reverse.

Cancellation currently applies only to repository commands started by the running server. Search and Undo remain short serialized operations.

## Interrupted-run recovery

Each spawned command now writes a small `inflight.json` journal beside its stdout and stderr before the visual runtime reports that the run has started. The journal preserves the exact command identity, process ID, starting Git/currency evidence, and pre-operation worktree tree. Normal completion writes the immutable `run.json` and removes the journal.

When `hud serve` starts, it examines unfinished journals before accepting operations. If the recorded process no longer exists, CommandHUD captures the current Git state and worktree delta, retains the existing output, and finalizes the run as `INTERRUPTED` with a null exit code. It never treats recognizable partial output as proof of success. Recovered content changes use the same evidence-backed Undo check as completed and cancelled commands.

If a journal's process ID still appears active, startup fails closed instead of starting a competing operation runtime or killing a process whose identity cannot be proven safely. The user can wait for or inspect that detached process before restarting CommandHUD. This recovery is local evidence repair, not resumable execution: CommandHUD does not reconnect to the old process stream or continue the command.

Mutable project registration/state, in-flight journals, and final run records are published with same-directory atomic JSON writes: CommandHUD writes and flushes a uniquely named temporary file before renaming it into place. Immutable journals and run records additionally refuse to replace an existing destination. Temporary files are removed if publication fails.

Recovery validates the journal schema, project/run identity, process and command metadata, starting Git evidence, worktree tree, and exact stdout/stderr locations before reading anything. A malformed or truncated journal remains untouched and is reported as corrupt; `hud serve` refuses to start the operation runtime until that evidence is inspected. CommandHUD does not silently discard, reinterpret, or follow paths from damaged journal content.

In the live renderer, submitting Search sends structured `query` and `scope` JSON rather than a command string. The runtime validates it, runs `rg` directly without a shell, records the evidence, and returns refreshed semantic state. Snapshot mode keeps the same Search controls but only copies the equivalent CLI command without claiming execution.

`hud visual-state` remains a compatibility path for static hosting. It writes ignored `hud-state.js`, which contains machine-specific paths and transient Git state. Static mode can navigate that snapshot but cannot stream repository media. The browser command bar stages and copies exact commands; actual command execution remains owned by the CLI and Windows bridge.

## Windows CommandHUD bridge

The active bridge lives in the separate `hate.this.meaningless.life` repository at `legacy/commandhud/CommandHud-v21-corebridge.ps1`.

The bridge owns UI/runspace concerns: input, animation, cancellation, current PowerShell directory, and local UI history. DATA owns run evidence, reduction, Git/workflow semantics, and presentation. The bridge resolves `tools/hud/cli.mjs` from the active repository and falls back to ordinary PowerShell when no compatible core exists.

Important cwd contract: commands execute in a child PowerShell process, which records its final working directory for the parent runspace. Preserve that handoff when changing command transport.

## Continue from here

Before changing the HUD:

```text
git status --short --branch
npm run hud:test
node tools/hud/cli.mjs state
```

Preserve these contracts:

- raw stdout/stderr remains available and immutable;
- semantic views are derived from authoritative state;
- a nonzero underlying command remains nonzero;
- workflow retries resolve from the latest immutable stage attempt;
- wrong repositories are rejected rather than silently substituted;
- the visual prototype remains a renderer, not a second backend.

Current local continuation sequence is represented by these commits:

```text
1435baf Add workflow-aware CommandHUD run records
1fcf19a Expose canonical HUD semantic state
e3169ed Prototype visual CommandHUD language
```

Set `HUD_STATE_ROOT` to isolate state in tests or automation.

## Authority and safety

- A Git repository without `distribution/project.json` identifying `indrolend/data` is rejected.
- When invoked outside any repository, HUD may use the last verified DATA registration.
- When invoked inside a different repository, HUD fails instead of silently switching roots.
- HUD never commits, pushes, publishes, deploys, resets, or cleans by default.
- Repository scripts remain the verification adapters; GitHub Actions remains release authority.
