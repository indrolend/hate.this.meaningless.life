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

Repository scripts and files remain the source of discovered commands. Package scripts are discovered mechanically; additional typed commands are declared under `commandHud.commands` in the selected project manifest. Generic CommandHUD code does not copy DATA-specific command catalogs into another authority.

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
| root `hud.cmd` and `CommandHUD*.cmd` | current Windows front doors |
| `legacy/commandhud/` | original Windows GUI behavioral reference |
| `packages/vscode-extension/` | separate project/order prototype |
| `portable/` | historical portable-host experiment |

Legacy material may be removed only after a tested current equivalent exists or its unique behavior is explicitly rejected.
