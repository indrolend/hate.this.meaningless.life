# CommandHUD continuation handoff

## Authority

The current product runtime is `packages/commandhud/`. Do not recreate retired Windows Forms, DataFactory/VS Code, portable bootstrap, or selected-project copied HUD implementations.

The current product authority is the repository's `main` branch. Inspect Git status, branch, HEAD, and tests before changing it; source and runtime evidence override this handoff.

## Product contract

CommandHUD attaches to a verified Git repository, runs real repository or shell computation, retains complete immutable evidence, and produces deterministic compact context for the copy-command / paste-output LLM loop.

One generic core owns:

- repository identity and boundary enforcement;
- shell and typed repository-command execution;
- immutable stdout, stderr, Git, duration, and operation evidence;
- deterministic reduction and handoff export;
- Search, History, evidence-backed worktree Undo, and command discovery;
- CLI, fixed terminal UI, local server, and visual desktop clients.

Selected repositories own their scripts, package commands, identity, and optional `commandHud.commands` declarations. Frontends request typed intent or a runtime-discovered identity; they do not own a second execution or state model.

## Start here

```powershell
git status -sb
git log -5 --oneline --decorate
npm test
git diff --check
```

Manual entrypoints from another Git repository:

```powershell
hud shell
hud desktop
hud state --json
hud search currentState .
```

Install directly from the current published branch when testing a clean machine:

```powershell
npm install --global "git+https://github.com/indrolend/hate.this.meaningless.life.git#main"
```

## Current boundaries

- `hud desktop` is Windows-only; `hud shell`, CLI operations, and `hud serve` are the cross-platform paths.
- Ordinary `hud serve` does not expose arbitrary shell execution. The trusted desktop host enables the terminal endpoint locally.
- Search and repository commands use typed operation requests and immutable records.
- Undo reverses recorded worktree content when the inverse patch still applies. It does not rewrite commits, pushes, or external side effects.
- Visual state comes from the live runtime. No compatibility command writes snapshots or copied HUD code into the selected repository.
- Raw evidence remains authoritative even when a compact reducer is available.

## Historical material

See `docs/MATERIAL-INVENTORY.md` and `docs/PROTOTYPE-RETIREMENT-AUDIT.md`. Historical source remains in Git rather than as parallel runnable systems in the active tree.

## Highest-leverage next decision

Keep current implementation work in `packages/commandhud/` and project-specific integrations in the projects that own them. The next product frontier should be selected from observed user friction, not from unretired prototype sediment.
