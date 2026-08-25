param(
    [string] $Destination = (Join-Path $env:USERPROFILE 'DataFactory'),
    [string] $Project = '',
    [string] $ProductRepository = 'https://github.com/indrolend/hate.this.meaningless.life.git',
    [string] $ProductClone = (Join-Path $env:USERPROFILE 'Projects\hate.this.meaningless.life')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Normalize-Origin([string] $Origin) {
    $value = [string]::IsNullOrWhiteSpace($Origin) ? '' : $Origin.Trim().Replace('\\', '/').TrimEnd('/')
    if (-not $value) { return '' }

    if ($value -match '^(?:ssh://)?(?:[^@/]+@)?([^:/]+)[:/]([^?#]+)$' -and $value -notmatch '://') {
        return ('{0}/{1}' -f $Matches[1].ToLowerInvariant(), $Matches[2]).Replace('.git', '').TrimEnd('/').ToLowerInvariant()
    }

    try {
        $uri = [System.Uri]$value
        return ('{0}{1}' -f $uri.Host.ToLowerInvariant(), $uri.AbsolutePath).Replace('.git', '').TrimEnd('/').ToLowerInvariant()
    } catch {
        return $value.Replace('.git', '').TrimEnd('/').ToLowerInvariant()
    }
}

function Same-Origin([string] $Expected, [string] $Actual) {
    if (-not $Expected) { return $true }
    return (Normalize-Origin $Expected) -eq (Normalize-Origin $Actual)
}

function Get-RepositoryName([string] $Repository) {
    $normalized = Normalize-Origin $Repository
    if (-not $normalized) { return 'repository' }
    $parts = $normalized.Split('/', [System.StringSplitOptions]::RemoveEmptyEntries)
    return $parts[$parts.Length - 1]
}

function Get-DefaultCloneDestination([string] $Repository, [string] $Home = $env:USERPROFILE) {
    if (Same-Origin $Repository $ProductRepository) { return $ProductClone }
    return Join-Path (Join-Path $Home 'Projects') (Get-RepositoryName $Repository)
}

function Test-ForbiddenImplicitProject([string] $Candidate) {
    $resolved = [System.IO.Path]::GetFullPath($Candidate)
    return $resolved -in @(
        [System.IO.Path]::GetFullPath($env:USERPROFILE),
        [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE 'Desktop')),
        [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE 'Downloads'))
    )
}

function Assert-GitAvailable {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw 'GIT_MISSING'
    }
}

function Resolve-VerifiedProject([string] $Candidate, [string] $ExpectedOrigin = '') {
    if (-not $Candidate) { return $null }
    Assert-GitAvailable
    $resolved = [System.IO.Path]::GetFullPath($Candidate)
    if (-not (Test-Path -LiteralPath $resolved) -or (Test-ForbiddenImplicitProject $resolved)) { return $null }

    $root = (& git -C $resolved rev-parse --show-toplevel 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $root) { return $null }
    $origin = (& git -C $resolved remote get-url origin 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $origin) { return $null }

    $root = [System.IO.Path]::GetFullPath($root.Trim())
    $origin = $origin.Trim()
    if ($ExpectedOrigin -and -not (Same-Origin $ExpectedOrigin $origin)) { return $null }

    return @{
        root = $root
        origin = $origin
    }
}

$BundleRoot = $PSScriptRoot
$Vsix = Get-ChildItem -LiteralPath $BundleRoot -Filter 'DataFactory-*.vsix' -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $Vsix) {
    throw "DATAFACTORY_VSIX_NOT_FOUND: $BundleRoot"
}

$Archive = Join-Path $env:TEMP 'DataFactory-VSCode.zip'
$HostRoot = Join-Path $Destination 'host'
$ConfigRoot = Join-Path $Destination 'config'
$LauncherRoot = Join-Path $Destination 'launcher'
$ProjectConfig = Join-Path $ConfigRoot 'project.json'
$Download = 'https://update.code.visualstudio.com/latest/win32-x64-archive/stable'

New-Item -ItemType Directory -Path $Destination -Force | Out-Null

if (-not (Test-Path -LiteralPath (Join-Path $HostRoot 'Code.exe'))) {
    Write-Host 'HOST' -ForegroundColor Cyan
    Invoke-WebRequest -Uri $Download -OutFile $Archive
    New-Item -ItemType Directory -Path $HostRoot -Force | Out-Null
    Expand-Archive -LiteralPath $Archive -DestinationPath $HostRoot -Force
}

New-Item -ItemType Directory -Path (Join-Path $HostRoot 'data') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $HostRoot 'data\tmp') -Force | Out-Null
New-Item -ItemType Directory -Path $ConfigRoot -Force | Out-Null
New-Item -ItemType Directory -Path $LauncherRoot -Force | Out-Null

$Code = Join-Path $HostRoot 'bin\code.cmd'
& $Code --install-extension $Vsix.FullName --force
if ($LASTEXITCODE -ne 0) {
    throw 'DATAFACTORY_EXTENSION_INSTALL_FAILED'
}

if ($Project) {
    $verifiedProject = Resolve-VerifiedProject $Project
    if (-not $verifiedProject) { throw 'PROJECT_NOT_VERIFIED' }
    $verifiedProject | ConvertTo-Json | Set-Content -LiteralPath $ProjectConfig -Encoding UTF8
} elseif (-not (Test-Path -LiteralPath $ProjectConfig)) {
    @{ root = ''; origin = '' } | ConvertTo-Json | Set-Content -LiteralPath $ProjectConfig -Encoding UTF8
}

$LauncherScript = Join-Path $LauncherRoot 'Start-DataFactory.ps1'
$LauncherText = @"
param()
`$ErrorActionPreference = 'Stop'
`$Root = Split-Path -Parent `$PSScriptRoot
`$HostRoot = Join-Path `$Root 'host'
`$ProjectConfig = Join-Path (Join-Path `$Root 'config') 'project.json'
`$DefaultClone = '$($ProductClone.Replace("'", "''"))'
`$DefaultRepo = '$($ProductRepository.Replace("'", "''"))'

function Normalize-Origin([string] `$Origin) {
    `$value = [string]::IsNullOrWhiteSpace(`$Origin) ? '' : `$Origin.Trim().Replace('\\', '/').TrimEnd('/')
    if (-not `$value) { return '' }
    if (`$value -match '^(?:ssh://)?(?:[^@/]+@)?([^:/]+)[:/]([^?#]+)$' -and `$value -notmatch '://') {
        return ('{0}/{1}' -f `$Matches[1].ToLowerInvariant(), `$Matches[2]).Replace('.git', '').TrimEnd('/').ToLowerInvariant()
    }
    try {
        `$uri = [System.Uri]`$value
        return ('{0}{1}' -f `$uri.Host.ToLowerInvariant(), `$uri.AbsolutePath).Replace('.git', '').TrimEnd('/').ToLowerInvariant()
    } catch {
        return `$value.Replace('.git', '').TrimEnd('/').ToLowerInvariant()
    }
}
function Same-Origin([string] `$Expected, [string] `$Actual) {
    if (-not `$Expected) { return `$true }
    return (Normalize-Origin `$Expected) -eq (Normalize-Origin `$Actual)
}
function Get-RepositoryName([string] `$Repository) {
    `$normalized = Normalize-Origin `$Repository
    if (-not `$normalized) { return 'repository' }
    `$parts = `$normalized.Split('/', [System.StringSplitOptions]::RemoveEmptyEntries)
    return `$parts[`$parts.Length - 1]
}
function Get-DefaultCloneDestination([string] `$Repository) {
    if (Same-Origin `$Repository `$DefaultRepo) { return `$DefaultClone }
    return Join-Path (Join-Path `$env:USERPROFILE 'Projects') (Get-RepositoryName `$Repository)
}
function Test-ForbiddenImplicitProject([string] `$Candidate) {
    `$resolved = [System.IO.Path]::GetFullPath(`$Candidate)
    return `$resolved -in @(
        [System.IO.Path]::GetFullPath(`$env:USERPROFILE),
        [System.IO.Path]::GetFullPath((Join-Path `$env:USERPROFILE 'Desktop')),
        [System.IO.Path]::GetFullPath((Join-Path `$env:USERPROFILE 'Downloads'))
    )
}
function Assert-GitAvailable {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw 'GIT_MISSING'
    }
}
function Get-ProjectConfig {
    if (-not (Test-Path -LiteralPath `$ProjectConfig)) { return @{ root = ''; origin = '' } }
    return (Get-Content -LiteralPath `$ProjectConfig -Raw | ConvertFrom-Json)
}
function Save-ProjectConfig([string]`$root, [string]`$origin) {
    @{ root = `$root; origin = `$origin } | ConvertTo-Json | Set-Content -LiteralPath `$ProjectConfig -Encoding UTF8
}
function Resolve-VerifiedProject([string]`$Candidate, [string]`$ExpectedOrigin = '') {
    if (-not `$Candidate) { return `$null }
    Assert-GitAvailable
    `$resolved = [System.IO.Path]::GetFullPath(`$Candidate)
    if (-not (Test-Path -LiteralPath `$resolved) -or (Test-ForbiddenImplicitProject `$resolved)) { return `$null }
    `$root = (& git -C `$resolved rev-parse --show-toplevel 2>`$null)
    if (`$LASTEXITCODE -ne 0 -or -not `$root) { return `$null }
    `$origin = (& git -C `$resolved remote get-url origin 2>`$null)
    if (`$LASTEXITCODE -ne 0 -or -not `$origin) { return `$null }
    `$root = [System.IO.Path]::GetFullPath(`$root.Trim())
    `$origin = `$origin.Trim()
    if (`$ExpectedOrigin -and -not (Same-Origin `$ExpectedOrigin `$origin)) { return `$null }
    return @{ root = `$root; origin = `$origin }
}

`$config = Get-ProjectConfig
`$verified = Resolve-VerifiedProject `$config.root `$config.origin
if (-not `$verified) {
    Write-Host 'NO PROJECT' -ForegroundColor Yellow
    `$choice = (Read-Host 'OPEN or CLONE').Trim().ToUpperInvariant()
    if (`$choice -eq 'CLONE') {
        `$repository = (Read-Host "Repository URL [`$DefaultRepo]").Trim()
        if (-not `$repository) { `$repository = `$DefaultRepo }
        `$destination = (Read-Host ("Clone destination [{0}]" -f (Get-DefaultCloneDestination `$repository))).Trim()
        if (-not `$destination) { `$destination = Get-DefaultCloneDestination `$repository }
        if (Test-ForbiddenImplicitProject `$destination) { throw 'NO_PROJECT_FALLBACK_PATH' }
        if (Test-Path -LiteralPath `$destination) {
            `$verified = Resolve-VerifiedProject `$destination `$repository
            if (-not `$verified) { throw 'DESTINATION_EXISTS' }
        } else {
            `$parent = Split-Path -Parent `$destination
            New-Item -ItemType Directory -Path `$parent -Force | Out-Null
            & git -C `$parent clone `$repository `$destination
            if (`$LASTEXITCODE -ne 0) { throw 'PROJECT_CLONE_FAILED' }
            `$verified = Resolve-VerifiedProject `$destination `$repository
        }
    } else {
        `$candidate = (Read-Host 'Repository path').Trim()
        `$verified = Resolve-VerifiedProject `$candidate ''
    }
    if (-not `$verified) { throw 'PROJECT_NOT_VERIFIED' }
    Save-ProjectConfig `$verified.root `$verified.origin
}
Save-ProjectConfig `$verified.root `$verified.origin
Start-Process -FilePath (Join-Path `$HostRoot 'Code.exe') -ArgumentList @(`$verified.root)
"@
Set-Content -LiteralPath $LauncherScript -Value $LauncherText -Encoding UTF8

$Launch = Join-Path $Destination 'DataFactory.cmd'
$LaunchText = @"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher\Start-DataFactory.ps1"
"@
Set-Content -LiteralPath $Launch -Value $LaunchText -Encoding Ascii

$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'DataFactory.lnk'))
$Shortcut.TargetPath = $Launch
$Shortcut.WorkingDirectory = $Destination
$Shortcut.IconLocation = (Join-Path $HostRoot 'Code.exe')
$Shortcut.Save()

Write-Host 'READY' -ForegroundColor Green
Write-Host $Launch
Start-Process -FilePath $Launch
