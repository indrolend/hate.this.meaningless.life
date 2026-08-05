[CmdletBinding()]
param(
    [string] $Project = '',
    [switch] $Portable,
    [string] $PortableDestination = (Join-Path $env:USERPROFILE 'hate.this.meaningless.life')
)

$ErrorActionPreference = 'Stop'
$Repository = Split-Path -Parent $MyInvocation.MyCommand.Path
$Vsix = Get-ChildItem -LiteralPath (Join-Path $Repository 'portable') -Filter 'hate.this.meaningless.life-*.vsix' -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $Vsix) {
    throw "VSIX_NOT_FOUND: $(Join-Path $Repository 'portable')"
}

function Resolve-Project([string] $Candidate) {
    if ([string]::IsNullOrWhiteSpace($Candidate)) { return '' }
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'GIT_MISSING' }
    $root = (& git -C $Candidate rev-parse --show-toplevel 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $root) { throw "PROJECT_NOT_GIT_REPOSITORY: $Candidate" }
    return [System.IO.Path]::GetFullPath($root.Trim())
}

$VerifiedProject = Resolve-Project $Project

if ($Portable) {
    $PortableInstaller = Join-Path $Repository 'portable\Install-DataFactory-Portable.ps1'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PortableInstaller `
        -Destination $PortableDestination `
        -Project $VerifiedProject
    if ($LASTEXITCODE -ne 0) { throw 'PORTABLE_INSTALL_FAILED' }
    exit 0
}

$Code = Get-Command code -ErrorAction SilentlyContinue
if (-not $Code) {
    throw @'
VS_CODE_CLI_NOT_FOUND
Open VS Code, run "Shell Command: Install 'code' command in PATH", then rerun this installer.
Alternatively rerun with -Portable to install a self-contained VS Code host.
'@
}

& $Code.Source --install-extension $Vsix.FullName --force
if ($LASTEXITCODE -ne 0) { throw 'EXTENSION_INSTALL_FAILED' }

Write-Host "INSTALLED $($Vsix.Name)" -ForegroundColor Green
if ($VerifiedProject) {
    Write-Host "OPENING $VerifiedProject" -ForegroundColor Cyan
    & $Code.Source $VerifiedProject
}
