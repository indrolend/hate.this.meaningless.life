param(
    [string] $Destination = (Join-Path $env:USERPROFILE 'DataFactory'),
    [string] $Project = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$BundleRoot = $PSScriptRoot
$Vsix = Get-ChildItem -LiteralPath $BundleRoot -Filter 'DataFactory-*.vsix' -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $Vsix) {
    throw "DATAFACTORY_VSIX_NOT_FOUND: $BundleRoot"
}

$Archive = Join-Path $env:TEMP 'DataFactory-VSCode.zip'
$HostRoot = Join-Path $Destination 'host'
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

$Code = Join-Path $HostRoot 'bin\code.cmd'
& $Code --install-extension $Vsix.FullName --force
if ($LASTEXITCODE -ne 0) {
    throw 'DATAFACTORY_EXTENSION_INSTALL_FAILED'
}

$Launch = Join-Path $Destination 'DataFactory.cmd'
$LaunchText = @"
@echo off
start "DataFactory" "%~dp0host\Code.exe" "%~1"
"@
Set-Content -LiteralPath $Launch -Value $LaunchText -Encoding Ascii

$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'DataFactory.lnk'))
$Shortcut.TargetPath = $Launch
$Shortcut.Arguments = '"' + $Project + '"'
$Shortcut.WorkingDirectory = $Project
$Shortcut.IconLocation = (Join-Path $HostRoot 'Code.exe')
$Shortcut.Save()

Write-Host 'READY' -ForegroundColor Green
Write-Host $Launch
Start-Process -FilePath (Join-Path $HostRoot 'Code.exe') -ArgumentList @($Project)
