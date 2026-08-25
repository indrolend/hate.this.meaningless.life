# Material inventory

This inventory classifies what is authoritative now. File age and directory names are not authority; current entrypoints, tests, and runtime behavior are.

| Material | Classification | Current use |
| --- | --- | --- |
| `packages/commandhud/` | current product authority | generic CLI, execution core, immutable evidence, reduction, Search, History, Undo, terminal UI, server, and visual desktop renderer |
| root `package.json` | current install authority | exposes `hud` and `commandhud` from a clone or GitHub installation |
| root `hud.cmd` and `CommandHUD*.cmd` | current Windows front doors | invoke the product-owned CLI against the caller's verified Git repository |
| `.github/workflows/commandhud-checks.yml` | current verification authority | exercises the package on supported hosted platforms |
| `legacy/commandhud/CommandHud-v21*.ps1` | historical behavioral reference | preserves the original Windows Forms interaction and persistent-runspace lineage; not a current launcher |
| `packages/vscode-extension/` | retained independent prototype | records the earlier DataFactory project/order/agent-packet model; not part of current CommandHUD execution |
| `examples/` | example integration data | demonstrates project declaration shape; not runtime authority |

## Current contract

The tested current path is:

```text
verified Git repository
  -> hud shell / hud desktop / hud <operation>
  -> packages/commandhud
  -> real shell, Git, filesystem, and repository-owned commands
  -> immutable raw evidence plus deterministic compact context
```

The selected repository can declare project identity and typed commands. Generic CommandHUD does not need a copied runtime under that repository.

## Retained behavior to evaluate before deleting historical material

The Windows Forms prototype still documents interaction details such as a dedicated GUI input/output surface, click-to-copy, click-to-paste, mouse-wheel history, and activity-derived face/palette states. The current product covers execution, cancellation, evidence, compact copy, history, and terminal/visual clients, but exact UI parity is neither assumed nor required.

The DataFactory extension contains a deterministic order abstraction and provider-neutral agent packet. Current CommandHUD has objectives, frontier state, run packets, and handoff evidence, but the old order schema should be deleted only after its unique constraints are either deliberately adopted or rejected.

The portable VS Code bootstrap and bundled VSIX had no unique current CommandHUD behavior. They were removed after verification showed that they only downloaded VS Code, installed the retained DataFactory extension, created a shortcut, and launched it. Git history preserves that implementation evidence.

## Resolved former gaps

- Command execution, evidence, reduction, terminal UI, server, and visual renderer now share one core.
- Project selection is verified against a real Git root.
- Repository command discovery and typed declarations are implemented.
- DATA has been exercised as a separate integration fixture through thin launchers and project-owned declarations.
- The product installs from its repository root and runs across Node-supported shells; the current native-feeling desktop host is Windows-specific.

## Remaining product gaps

- No packaged signed native executable or installer exists.
- The visual desktop host is Windows-only; other platforms use the CLI, terminal UI, or local server.
- Session presence/navigation is process-local rather than synchronized through an account or relay.
- The retained Windows Forms and DataFactory prototypes still need a deliberate keep/archive/delete decision after their unique behavior is accounted for.
