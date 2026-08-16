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

Each `run.json` is created immutably. `state.json` is only the pointer to the most recent run. History is derived from run records; there is no parallel history database.

Set `HUD_STATE_ROOT` to isolate state in tests or automation.

## Authority and safety

- A Git repository without `distribution/project.json` identifying `indrolend/data` is rejected.
- When invoked outside any repository, HUD may use the last verified DATA registration.
- When invoked inside a different repository, HUD fails instead of silently switching roots.
- HUD never commits, pushes, publishes, deploys, resets, or cleans by default.
- Repository scripts remain the verification adapters; GitHub Actions remains release authority.
