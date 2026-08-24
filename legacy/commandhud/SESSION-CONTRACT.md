# CommandHUD bridge session contract

This document describes what the current Windows bridge actually preserves between commands. It is intentionally narrower than "persistent PowerShell session".

## Current execution model

`CommandHud-v21-corebridge.ps1` keeps a parent PowerShell runspace alive for HUD state. Each user command is encoded and executed in a child `pwsh.exe` process. If the active repository has a compatible `tools/hud/cli.mjs`, the child command is routed through that core; otherwise it runs directly in PowerShell.

The bridge explicitly transports the child command's final working directory back into the parent runspace after the command finishes. That is why `Set-Location` survives into the next HUD command.

No other child PowerShell session state is currently transported back by the bridge.

## What is intentionally persistent

- current working directory, via explicit child-to-parent cwd handoff
- HUD-local command history and display state
- HUD-local last-result state
- repository-aware behavior supplied by an active compatible HUD core

## What is not currently claimed to persist

Do not assume these survive from one HUD command to the next:

- ordinary PowerShell variables
- functions defined by a command
- aliases defined by a command
- imported modules loaded only in the child process
- process-local environment changes made only in the child
- other child-process session state unless it is explicitly transported

The bridge should be described as a command surface with cwd continuity, not as a fully persistent PowerShell shell.

## Manual runtime probe

To measure the contract in a running HUD, enter each command separately.

### Working directory

```powershell
Set-Location $env:USERPROFILE
```

then:

```powershell
(Get-Location).Path
```

Expected current contract: the second command runs from the user profile.

### Variable

```powershell
$HudSessionProbe = 'ALIVE'
```

then:

```powershell
"VAR=$HudSessionProbe"
```

A value here should only be documented as persistent after it is observed in the actual bridge runtime.

### Function

```powershell
function Invoke-HudSessionProbe { 'ALIVE' }
```

then:

```powershell
Invoke-HudSessionProbe
```

Again, do not infer persistence from the existence of the parent runspace; the user command executes in a child process.

### Environment

```powershell
$env:HUD_SESSION_PROBE = 'ALIVE'
```

then:

```powershell
"ENV=$env:HUD_SESSION_PROBE"
```

Record the observed result rather than assuming environment mutations are handed back.

## Design rule

Persist only state that has a demonstrated user benefit and an explicit transport contract. Do not grow a generic session-synchronization layer merely to imitate a traditional shell. The exact child command, output, exit status, cwd handoff, and repository core remain the meaningful runtime facts.
