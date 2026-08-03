# Architecture

## Reuse rather than replace

| Concern | Authority |
| --- | --- |
| Editing and language services | portable VS Code host |
| History and branching | Git |
| Execution | shell and repository scripts |
| Build/test | repository-owned commands |
| Security and authentication | OS, Git, GitHub, SSH |
| Focus, work memory, handoff | hate.this.meaningless.life |

## Portable Windows layout

```text
hate.this.meaningless.life/
  host/
    Code.exe
    data/
      user-data/
      extensions/
      tmp/
  config/
    projects.json
  evidence/
  launcher/
  hate.this.meaningless.life.cmd
```

Project clones should default outside the application package:

```text
%USERPROFILE%\Projects\hate.this.meaningless.life
%USERPROFILE%\Projects\digital-breakdown-apk
```

The launcher derives its own installation path, then resolves a configured project. It never treats its caller's current directory as authority.

## State boundary

Shareable project state lives under `.datafactory/` or a future renamed equivalent. Machine-private state, credentials, caches, and transient logs stay outside Git. Every derived record carries the source commit that produced it.
