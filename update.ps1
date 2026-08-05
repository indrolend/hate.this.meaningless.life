[CmdletBinding()]
param(
    [string] $Project = '',
    [switch] $Portable,
    [string] $PortableDestination = (Join-Path $env:USERPROFILE 'hate.this.meaningless.life')
)

$ErrorActionPreference = 'Stop'
$Repository = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path -LiteralPath (Join-Path $Repository '.git'))) {
    throw 'UPDATE_REQUIRES_GIT_CLONE'
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'GIT_MISSING' }

$dirty = (& git -C $Repository status --porcelain)
if ($LASTEXITCODE -ne 0) { throw 'GIT_STATUS_FAILED' }
if ($dirty) { throw 'LOCAL_CHANGES_PRESENT: commit or stash them before updating' }

& git -C $Repository pull --ff-only
if ($LASTEXITCODE -ne 0) { throw 'GIT_PULL_FAILED' }

& (Join-Path $Repository 'install.ps1') -Project $Project -Portable:$Portable -PortableDestination $PortableDestination
