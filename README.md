# hate.this.meaningless.life

`funny.html` is a small command HUD for the modern copy-and-paste development loop:

1. Copy a command from an LLM.
2. Paste it into **INPUT**.
3. Press Enter.
4. Read the exact result in **OUTPUT**.
5. Click **COPY** and return it to the conversation. History entries can also be loaded back into INPUT or rerun directly.

The HUD executes only inside a verified Git repository. On Windows it uses Windows PowerShell explicitly, so PowerShell commands such as `Get-Location` are not accidentally sent to `cmd.exe`. Shift+Enter inserts a newline. Command output and metadata are stored outside the repository under `%LOCALAPPDATA%\hate.this.meaningless.life`, or beside a removable installation when launched through its shortcut.


## 0.6 workflow

- Paste a command, press Enter, and watch exact raw output.
- `COPY: REDUCED` is the default and deterministically selects causal errors, summaries, and useful context.
- Scroll over any copy button to switch between `REDUCED` and `RAW`.
- History is stored as immutable expandable run cards with `LOAD`, `RERUN`, and `COPY`.
- Cards show `CURRENT` only when both the Git commit and working-tree fingerprint still match.

## Install on Windows

### Normal VS Code

```powershell
git clone https://github.com/indrolend/hate.this.meaningless.life.git
Set-Location .\hate.this.meaningless.life
.\install.ps1 -Project C:\path\to\your\repository
```

This installs the bundled VSIX through the existing `code` CLI and opens the verified project. It does not download another editor.

### Self-contained portable host

```powershell
.\install.ps1 -Portable -Project C:\path\to\your\repository
```

Portable mode downloads the VS Code archive on first setup, installs the bundled extension, creates a Desktop shortcut, and opens the selected repository.

### Update

From an existing clean Git clone:

```powershell
.\update.ps1 -Project C:\path\to\your\repository
```

The updater performs a fast-forward-only pull and reinstalls the bundled extension. It refuses to overwrite local changes.

See [`docs/CURRENT-STATE.md`](docs/CURRENT-STATE.md) for a compact authoritative handoff suitable for humans and LLMs.

## Develop

```powershell
Set-Location .\packages\vscode-extension
npm.cmd install
npm.cmd run verify
Set-Location ..\..
.\scripts\verify-windows.ps1
```

The active HUD files are `media/funny.html`, `media/funny.css`, and `media/funny.js`. `src/extension.js` is the VS Code bridge; `src/core.js` owns Git inspection, execution, cancellation, and external project-keyed history. `legacy/commandhud/` is reference material, not active runtime code. The internal `dataFactory.*` command IDs remain temporarily for upgrade compatibility; they are not a second runtime.
