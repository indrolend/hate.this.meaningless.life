# DATA CommandHUD core

`hud` is the persistent local development front door for DATA. It verifies the project root, records Git authority around every command, preserves raw output, and emits a deterministic continuation packet.

## Install the local entrypoint

From the repository root:

```text
npm link
```

This exposes the repository's `hud` bin through npm's user-level binary directory. It does not install a service or start a UI. Remove it with `npm unlink --global digital-breakdown-apk`.

Without linking, use `npm run hud -- <command>`.

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

The adapter binds to loopback by default. It exposes read operations for state, tree, static assets, and projected media, plus narrow typed operation boundaries. `POST /operations/search` accepts only same-origin JSON containing `query` and repository-relative `scope`, then delegates to `searchRepository()`. `POST /operations/repository-command` accepts only a discovered command `name`; the runtime rediscovers that identity before execution. It has no arbitrary shell-execution endpoint. Use `hud serve --lan` only when explicitly testing from another device on the local network.

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

The visual command bar has two explicit modes. Terminal is the default and continues to stage ordinary commands; power users can also type `search "query" scope` there. Choosing Search from the toolkit enters a focused Search mode where the input is literal query text and scope is selected separately as Repository or Current Directory. This lets multiword queries remain unquoted while keeping the operation boundary visible.

The toolkit's Library directory is derived from `discoverCommands()` in the same live or snapshot state as the repository map. It lists the current repository's declared package scripts and factual command adapters instead of maintaining another curated command list. Selecting an entry stages its exact command in Terminal mode for inspection or editing; it does not grant the browser arbitrary execution.

In live mode, a Library entry can be run only after an explicit confirmation that shows the resolved command and warns that repository commands can execute arbitrary local code. The renderer submits the stable discovered identity, such as `npm:hud:test`, rather than executable text. The runtime rediscovers that identity, executes its runtime-owned argument vector without a shell, and records the resolved command, status, duration, reduction, Git state, stdout, and stderr through the existing immutable run system. The same operation is available directly as `node tools/hud/cli.mjs repository-command npm:hud:test`. Static mode remains staging-only.

## Immutable operation history

The live History control projects existing structured run records; it does not create a history database. `GET /history` returns bounded summaries with operation identity, factual result, duration, status, and `CURRENT`, `STALE`, or `UNKNOWN` evidence currency. `GET /history/:runId` returns the existing operation, presentation, Git snapshots, raw evidence paths, and compact handoff. Run IDs are validated before reading the project-specific immutable run directory.

Selecting a recorded Search reconstructs its saved matches and repository highlights without executing `rg` again. Source excerpts accept that validated Search run identity and retain the same projected-file, recorded-match, size, binary, and context limits as the latest-Search view. Selecting a recorded repository command shows its saved reduction and evidence reference; it does not infer test ownership or touched files.

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
