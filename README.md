# hate.this.meaningless.life

Experimental local-first developer tooling for human-directed, agent-assisted work.

This repository is a collection of working prototypes and integration pieces. It is not a single finished application, and the components are at different levels of maturity.

## What is here

- `legacy/commandhud/CommandHud-v21.ps1` — the original standalone Windows CommandHUD prototype.
- `legacy/commandhud/CommandHud-v21-corebridge.ps1` — the current Windows bridge prototype. It keeps a PowerShell runspace alive, preserves working-directory changes across commands, and can hand compatible repository commands to that repository's `tools/hud/cli.mjs` when present.
- `packages/vscode-extension/` — a separate DataFactory VS Code extension experiment with its own tests and lifecycle.
- `portable/` — Windows portable/bootstrap experiments.
- `docs/` — design, architecture, and integration notes. Some documents describe intended direction rather than completed behavior; verify claims against the current code before treating them as runtime contracts.
- `examples/digital-breakdown.project.json` — an example project description used by the tooling experiments.

## CommandHUD behavior

The Windows bridge can be launched from an ordinary directory, including outside a Git repository. In that case it behaves as a PowerShell command surface.

When a command is run from a repository containing a compatible `tools/hud/cli.mjs`, the bridge resolves that HUD core from the active repository and routes the command through it. The repository-specific core is responsible for project verification, semantic reduction, and any stronger authority rules it implements.

If no compatible HUD core is available, the bridge falls back to ordinary PowerShell execution rather than pretending the current directory is a verified project.

The bridge also supports workflow-prefixed requests of the form:

```text
@hud workflow-id "workflow name" stage 1 1 :: command
```

The child command process reports its final working directory back to the bridge so commands such as `Set-Location` persist across subsequent HUD commands.

## Authority model

A filesystem location and a verified project are not the same thing.

- The bridge may execute ordinary PowerShell outside a verified project.
- Repository-aware behavior should come from the active repository's compatible HUD core.
- A tool must not silently label Desktop, Downloads, the user profile, or an unrelated working directory as a verified project.
- Git, files, command output, and the actual runtime remain authoritative; UI state is a representation of them, not a substitute for them.

## Verification

Verification is component-specific. Do not infer that the whole repository is covered by one test command.

For the VS Code extension slice:

```powershell
Set-Location .\packages\vscode-extension
npm.cmd install
npm.cmd run verify
```

For a repository-specific CommandHUD core, use that repository's own documented verification commands.

Read `AGENTS.md` before changing source. `COPILOT-HANDOFF.md` contains integration context, but current code and runtime behavior take precedence over older planning text.

## Launching the CommandHUD bridge

Launch the active bridge from any directory:

```powershell
$HUD = Join-Path $env:USERPROFILE 'Projects\hate.this.meaningless.life\legacy\commandhud\CommandHud-v21-corebridge.ps1'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $HUD
```

Ownership boundary:

- this repository owns the Windows UI, runspace, command transport, cancellation, and cwd handoff;
- the active project HUD core owns immutable evidence, Git authority, output reduction, workflow derivation, and semantic presentation;
- raw command output remains available when semantic presentation is unavailable.

The child process must write its final directory back to the parent runspace. This is what makes `Set-Location` persist across commands; do not move cwd capture back into the parent wrapper.

Relevant bridge history:

```text
786827a Add workflow-aware CommandHUD bridge
f9efa72 Resolve CommandHUD core from active repository
a1ace70 Fall back when CommandHUD core is unavailable
22ace23 Persist CommandHUD working directory
ca77006 Persist child command working directory
```
