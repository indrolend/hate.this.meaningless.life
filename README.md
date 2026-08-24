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
project  cwd  git  workflow  last  next  status
```

This is the boundary for quick-context text and future visual renderers. Add facts here only when an existing authoritative source can derive them and a real renderer needs them.

## Visual language prototype

Open `visual-prototype/index.html` directly in a browser. It is a standalone Canvas prototype with no dependencies or build step.

Demo commands:

```text
test  change  commit  push  fail  workflow  reset
```

The prototype proves presentation and motion only. It does not execute real commands, watch the filesystem, or replace the core. Its next integration step is a thin adapter from `hud state --json` and semantic command events into the existing fake state/event model.

The central repository is the interactive hero surface. Its particle transition adapts the proven `basicbrowserslim/js/spa` contract: rasterize current and target surfaces, sample visible pixels, explode through shallow projected depth, and reform with a spring overshoot. Pointer drag gives the hero a resisted pull and spring return; click, Enter, or Space reveals its evidence.

An optional local `hud-state.js` can assign a `hud state --json` snapshot to `window.commandHudRealState`. The file is ignored because it contains machine-specific paths and transient Git state. The `real` command, or initial page load when that global exists, hydrates the same visual model without introducing another backend.

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
