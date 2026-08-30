# Material inventory

This inventory classifies what is authoritative now. File age and directory names are not authority; current entrypoints, tests, and runtime behavior are.

| Material | Classification | Current use |
| --- | --- | --- |
| `packages/commandhud/` | current product authority | generic CLI, execution core, immutable evidence, reduction, Search, History, Undo, terminal UI, server, and Repository Map client |
| `packages/commandhud/repository-map-client/` | current browser renderer | presentation shared by `hud desktop` and `hud serve`; consumes server/core state |
| root `package.json` | sole current install authority | exposes canonical `hud` and compatibility alias `commandhud` from a clone or GitHub installation |
| root `hud.cmd` | current Windows CLI front door | forwards the complete CLI argument vector |
| `CommandHUD.cmd` | Windows compatibility launcher | forwards the complete CLI and matches the installed `commandhud` alias |
| `CommandHUD-TUI.cmd` and `CommandHUD-Desktop.cmd` | current explicit client launchers | select one documented client and preserve caller arguments |
| `CommandHUD Shell.cmd` | compatibility alias | delegates to the plain shell; its spaced path must be quoted in PowerShell |
| `.github/workflows/commandhud-checks.yml` | current verification authority | exercises the package on supported hosted platforms |
| `docs/PROTOTYPE-RETIREMENT-AUDIT.md` | historical behavior inventory | records the adopted, superseded, and rejected contracts from removed Windows Forms, DataFactory, and portable prototypes |

## Current contract

The tested current path is:

```text
verified Git repository
  -> hud shell / hud tui / hud desktop / hud <operation>
  -> packages/commandhud
  -> real shell, Git, filesystem, and repository-owned commands
  -> immutable raw evidence plus deterministic compact context
```

The selected repository can declare project identity and typed commands. Generic CommandHUD does not need a copied runtime under that repository.

## Retired material

The Windows Forms command surfaces, DataFactory VS Code extension, portable VS Code bootstrap, bundled VSIX, and stale DATA fixture were removed after direct behavior comparison. The retirement audit preserves the decisions; Git history preserves the implementations.

## Resolved former gaps

- Command execution, evidence, reduction, terminal UI, server, and Repository Map client now share one core.
- Project selection is verified against a real Git root.
- Repository command discovery and typed declarations are implemented.
- DATA has been exercised as a separate integration fixture through thin launchers and project-owned declarations.
- The product installs from its repository root and runs across Node-supported shells; the current native-feeling desktop host is Windows-specific.

## Remaining product gaps

- No packaged signed native executable or installer exists.
- The visual desktop host is Windows-only; other platforms use the CLI, terminal UI, or local server.
- Session presence/navigation is process-local rather than synchronized through an account or relay.
- A packaged signed native application and cross-device session authority remain product work rather than prototype-retirement work.
