# Current state

## Authority

- Repository: `indrolend/hate.this.meaningless.life`
- Product version: `0.6.0`
- Active implementation: `packages/vscode-extension/`
- Installable package: `portable/hate.this.meaningless.life-0.6.0.vsix`
- Legacy reference only: `legacy/commandhud/CommandHud-v21.ps1`

## Purpose

A local, project-scoped execution companion for the manual LLM coding loop:

```text
paste command → run → capture evidence → copy reduced or raw → return to LLM
```

## Current guarantees

- No verified Git repository, no command execution.
- Raw output is authoritative; reduced output is deterministic and derived.
- Runs are immutable and project-scoped.
- Repository fingerprints include content state, not only changed filenames.
- Active runs are journaled and recovered as interrupted after host failure.
- Output and history are bounded.
- Repeated commands can show outcome transitions.
- Ollama and containers are optional future leverage layers, never runtime dependencies.

## Verification

The packaged 0.6.0 source completed 33 checks: 29 passed and four Windows-only checks were skipped outside Windows. Run the authoritative Windows verification with:

```powershell
.\scripts\verify-windows.ps1
```

## Install

Normal VS Code:

```powershell
git clone https://github.com/indrolend/hate.this.meaningless.life.git
Set-Location .\hate.this.meaningless.life
.\install.ps1 -Project C:\path\to\repository
```

Self-contained portable host:

```powershell
.\install.ps1 -Portable -Project C:\path\to\repository
```

Update an existing clone and reinstall:

```powershell
.\update.ps1 -Project C:\path\to\repository
```
