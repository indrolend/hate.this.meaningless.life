# hate.this.meaningless.life

A local-first development instrument for human-directed, agent-assisted work.

This seed repository contains working material, not just a product proposal:

- `legacy/commandhud/CommandHud-v21.ps1` — the complete Windows Command HUD prototype.
- `packages/vscode-extension/` — the tested DataFactory VS Code extension slice.
- `portable/` — the current Windows portable bootstrap and packaged VSIX.
- `docs/` — product contract, architecture, and integration plan.
- `examples/digital-breakdown.project.json` — the first real project adapter.

## Product invariant

No verified repository root, no command execution.

The application must never silently use Desktop, Downloads, the user profile, or an accidental shell working directory as the project.

## Current verification

The extension core has syntax checks and four Node tests covering intent normalization, bounded order generation, authority retention, and empty-goal rejection.

```powershell
Set-Location .\packages\vscode-extension
npm.cmd install
npm.cmd run verify
```

Read `AGENTS.md` before changing source. The first integration order is in `COPILOT-HANDOFF.md`.
