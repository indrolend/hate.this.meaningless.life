# Product authority

`hate.this.meaningless.life` is a simple local-first utility for repository work, command execution, copy/paste LLM workflows, and durable human-owned development history.

## Invariants

- No verified repository root, no command execution.
- Human intent selects work; agents propose or perform bounded operations.
- Git, repository scripts, tests, containers, and operating-system security remain authoritative.
- Preserve dirty work. Never reset, overwrite, merge, deploy, publish, or force-push without explicit approval.
- Histories and evidence belong to one project and retain repository, branch, commit, command, exit code, and time.
- High-variance exploration is disposable. Promotion to authority is explicit and sequential.
- No fake command delay, random distraction, duplicated output, or terminal bell at input boundaries.
- Labels and primary buttons use short words.
- Humor reflects observed runtime state; it does not hide or invent state.
- Do not fork VS Code unless a demonstrated extension API limitation blocks a required behavior.

## Implementation authority

- Treat `packages/commandhud/` as the current product runtime and test authority.
- Treat `legacy/commandhud/CommandHud-v21.ps1` as behavioral evidence for the original Windows command surface, not an active launcher.
- Treat `packages/vscode-extension/` as a retained project/order prototype, not current execution authority.
- Treat `portable/Install-DataFactory-Portable.ps1` as historical bootstrap evidence, not a distribution path.
- Keep repository-specific scripts and typed command declarations in their repository; do not copy the generic HUD runtime into projects it operates on.

## Required change workflow

1. Resolve exact branch, commit, origin, and dirty state.
2. Inspect existing implementations before editing.
3. Make the smallest coherent change.
4. Run focused syntax/tests first.
5. Run the complete local suite.
6. Package when packaging code changed.
7. Return commands, exit codes, artifact hashes, unknowns, and the next bounded order.

## Current scope

Maintain one generic CommandHUD authority and thin project integrations. DATA is an integration fixture whose game code, scripts, adapters, and build policy remain DATA-owned. New frontends must consume the existing runtime state and immutable evidence rather than create parallel execution or history models.
