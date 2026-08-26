# hate.this.meaningless.life

A local-first command HUD and context condenser for human-directed, LLM-assisted repository work.

CommandHUD runs real commands inside a verified Git repository, preserves complete evidence, and produces a compact result suitable for pasting back into ChatGPT. Git, the filesystem, the selected shell, and repository-owned scripts remain authoritative.

## Current authority

`packages/commandhud/` is the product runtime. It owns:

- PowerShell, Bash, Zsh, and Cmd command execution;
- persistent repository-contained working directories;
- immutable stdout/stderr and Git before/after evidence;
- deterministic context reduction and automatic clipboard export;
- Search, operation history, safe worktree Undo, and command discovery;
- the terminal UI, local desktop host, and visual repository client.

Earlier Windows Forms, DataFactory/VS Code, and portable distribution prototypes were removed after their behavior was accounted for. Git history retains their exact source; [the retirement audit](docs/PROTOTYPE-RETIREMENT-AUDIT.md) records what was adopted, superseded, or deliberately rejected.

## Requirements

- Node.js 20 or newer
- Git
- at least one supported shell
- optional: `rg` for repository Search

## Use it now

From the Git repository you want to operate on:

```powershell
& 'C:\path\to\hate.this.meaningless.life\CommandHUD Shell.cmd'
```

The launcher attaches to the current Git repository. Paste an ordinary command at the prompt; the full output is retained and the condensed result is shown and copied automatically.

Open the visual desktop client from the current repository:

```powershell
C:\path\to\hate.this.meaningless.life\CommandHUD.cmd
```

Use the product CLI directly:

```powershell
node C:\path\to\hate.this.meaningless.life\packages\commandhud\cli.mjs state --json
node C:\path\to\hate.this.meaningless.life\packages\commandhud\cli.mjs search currentState tools
```

To make `hud` available globally, run this once from the product clone:

```powershell
npm install --global C:\path\to\hate.this.meaningless.life
```

Then every Git checkout has the same access point:

```powershell
hud shell
hud desktop
hud state --json
hud search currentState tools
```

## Project identity

A Git root is the minimum verified boundary. CommandHUD derives identity from, in order:

1. `commandhud.project.json`
2. `.commandhud/project.json`
3. the legacy-compatible `distribution/project.json`
4. the Git `origin` URL
5. the local repository directory name

An explicit configuration only needs an ID:

```json
{
  "id": "owner/project",
  "name": "Project name"
}
```

Projects may expose additional typed commands without changing CommandHUD:

```json
{
  "id": "owner/project",
  "commandHud": {
    "commands": [
      {
        "name": "verify-assets",
        "command": "python tools/verify_assets.py",
        "argv": ["python", "tools/verify_assets.py"],
        "owner": "tools/verify_assets.py",
        "resultMarkers": true,
        "successMarkers": [
          {"contains": "ASSETS=PASS", "summary": "assets verified"}
        ]
      }
    ]
  }
}
```

The browser requests the stable `name`; the runtime rereads the repository declaration, validates its owner path, and executes the recorded `argv`. It does not accept browser-supplied shell text. Optional `kind` values (`test`, `audit`, or `smoke`) select a generic reducer. Literal success markers add project-owned factual summaries only after exit 0. `resultMarkers: true` records strict `NAME=PASS|FAIL key=value` lines with their stream and line number; these facts never override the real process exit status.

CommandHUD refuses execution outside a Git repository unless an explicit `--root` selects one.

## Verification

```powershell
npm test
git diff --check
```

The DATA game was the integration fixture where the current runtime matured. DATA-specific build and device commands remain owned by DATA and are discovered from its files and package scripts; the general CommandHUD runtime now lives here.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for boundaries and `packages/commandhud/README.md` for the complete command reference.
