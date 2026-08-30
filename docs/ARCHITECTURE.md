# CommandHUD architecture

## Authority flow

```text
Git repository + filesystem + shell + repository scripts
                         |
                         v
              packages/commandhud core
        execution / evidence / reduction / state
                         |
             +-----------+-----------+
             |           |           |
            CLI       terminal UI   desktop UI
```

There is one runtime state and evidence model. Frontends may request typed operations or present recorded evidence; they do not own independent execution histories.

## Repository boundary

CommandHUD verifies the selected directory through `git rev-parse --show-toplevel`. An optional project manifest supplies stable human identity and project-specific metadata. Without a manifest, the Git remote or root name supplies identity.

Repository scripts and files remain the source of discovered commands. Package scripts are discovered mechanically; additional typed commands are declared under `commandHud.commands` in the selected project manifest. Commands may select generic test/audit/smoke reduction and declare literal success markers. Generic CommandHUD code does not copy DATA-specific commands or output markers into another authority.

## State boundary

Machine-local evidence lives outside project Git:

```text
Windows: %LOCALAPPDATA%\CommandHud
macOS:   ~/Library/Application Support/CommandHud
Linux:   $XDG_STATE_HOME/commandhud
```

Each record carries project identity, root, branch, commit, command, exit status, time, raw output paths, and repository currency. Shareable project configuration may live in `commandhud.project.json` or `.commandhud/project.json`; credentials and transient evidence never do.

## Current and historical material

| Path | Classification |
| --- | --- |
| `packages/commandhud/` | current product authority |
| `packages/commandhud/repository-map-client/` | current browser renderer; client only, not semantic authority |
| root `hud.cmd` | argument-preserving CLI front door |
| `CommandHUD.cmd` | Windows compatibility launcher for the complete CLI |
| `CommandHUD-TUI.cmd` and `CommandHUD-Desktop.cmd` | unambiguous Windows client launchers |
| `CommandHUD Shell.cmd` | quoted compatibility alias for the plain shell |
| `docs/PROTOTYPE-RETIREMENT-AUDIT.md` | behavioral accounting for removed prototype lineages |

Retired source remains available through Git history. Do not restore it to the active tree unless a demonstrated current contract cannot be implemented through the canonical runtime.
