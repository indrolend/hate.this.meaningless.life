#requires -Version 5.1
# Command HUD v21

param(
    [string]$StartDirectory = (Get-Location).Path
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()

$appRoot = Join-Path $env:LOCALAPPDATA 'CommandHud'
$sessionId = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $PID
$sessionRoot = Join-Path (Join-Path $appRoot 'sessions') $sessionId
$logRoot = Join-Path $sessionRoot 'logs'
$historyPath = Join-Path $sessionRoot 'history.jsonl'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null

$script:Runspace = [runspacefactory]::CreateRunspace()
$script:Runspace.Open()
$script:Runspace.SessionStateProxy.Path.SetLocation($StartDirectory)
$script:ActivePowerShell = $null
$script:ActiveAsync = $null
$script:ActiveRecord = $null
$script:LastRecord = $null
$script:ActiveLivePath = $null
$script:LiveReadLength = 0
$script:LiveText = [System.Text.StringBuilder]::new()
$script:HudMode = 'ready'
$script:AnimationTick = 0
$script:ActivityColorIndex = 0
$script:LastAutoPasteText = if ([System.Windows.Forms.Clipboard]::ContainsText()) {
    [System.Windows.Forms.Clipboard]::GetText()
} else { $null }
$script:CommandHistory = [System.Collections.Generic.List[string]]::new()
$script:HistoryOffset = 0

$Palette = @{
    Background = [System.Drawing.Color]::FromArgb(13, 17, 19)
    Surface = [System.Drawing.Color]::FromArgb(22, 31, 34)
    SurfaceActive = [System.Drawing.Color]::FromArgb(31, 47, 51)
    Foreground = [System.Drawing.Color]::FromArgb(240, 247, 248)
    Muted = [System.Drawing.Color]::FromArgb(112, 139, 144)
    MetallicTeal = [System.Drawing.Color]::FromArgb(56, 122, 138)
    ElectricCyan = [System.Drawing.Color]::FromArgb(184, 255, 255)
    AcidChartreuse = [System.Drawing.Color]::FromArgb(186, 255, 74)
    Success = [System.Drawing.Color]::FromArgb(94, 232, 125)
    Failure = [System.Drawing.Color]::FromArgb(255, 95, 95)
    Warning = [System.Drawing.Color]::FromArgb(255, 195, 70)
}
$Rainbow = @(
    $Palette.ElectricCyan,
    $Palette.AcidChartreuse,
    [System.Drawing.Color]::FromArgb(255, 120, 210),
    $Palette.Warning,
    [System.Drawing.Color]::FromArgb(155, 125, 255)
)
$HudSettings = @{
    AutoRunPaste  = $true
    ClickCopy     = $true
    HistoryWheel  = $true
    MainLive      = $true
    AlwaysOnTop   = $false
}

function New-ControlFont([float]$size = 10.0, [System.Drawing.FontStyle]$style = [System.Drawing.FontStyle]::Regular) {
    return [System.Drawing.Font]::new('Cascadia Mono', $size, $style)
}

function Set-ButtonStyle($button, [System.Drawing.Color]$accent) {
    $button.FlatStyle = 'Flat'
    $button.FlatAppearance.BorderColor = $Palette.MetallicTeal
    $button.FlatAppearance.MouseOverBackColor = $Palette.SurfaceActive
    $button.BackColor = $Palette.Surface
    $button.ForeColor = $accent
    $button.Font = New-ControlFont 10 ([System.Drawing.FontStyle]::Bold)
    $button.Cursor = [System.Windows.Forms.Cursors]::Hand
}

function Convert-ObjectsToText($objects) {
    if ($null -eq $objects -or $objects.Count -eq 0) { return '' }
    return (($objects | Out-String -Width 240).TrimEnd())
}

function Copy-AllHistory {
    if (-not (Test-Path -LiteralPath $historyPath)) { return }

    $transcript = [System.Collections.Generic.List[string]]::new()
    Get-Content -LiteralPath $historyPath -Encoding UTF8 | ForEach-Object {
        try {
            $record = $_ | ConvertFrom-Json
            $output = ''
            if ($record.log_path -and (Test-Path -LiteralPath $record.log_path)) {
                $output = (Get-Content -LiteralPath $record.log_path -Raw).TrimEnd()
            }
            $transcript.Add(('PS {0}> {1}' -f $record.directory, $record.command))
            if ($output) { $transcript.Add($output) }
            $transcript.Add('')
        } catch {}
    }

    if ($transcript.Count -eq 0) { return }
    [System.Windows.Forms.Clipboard]::SetText(($transcript -join "`r`n").TrimEnd())
    $copyAllButton.Text = 'COPIED'
    $copyAllResetTimer.Stop()
    $copyAllResetTimer.Start()
}

function Copy-LatestOutput {
    if ($script:ActivePowerShell -and $script:LiveText.Length -gt 0) {
        [System.Windows.Forms.Clipboard]::SetText($script:LiveText.ToString().TrimEnd())
        $copyButton.Text = 'COPIED'
        $form.Opacity = 0.90
        $lastOutput.ForeColor = $Palette.Muted
        $copyResetTimer.Stop()
        $copyResetTimer.Start()
        return
    }
    if ($null -eq $script:LastRecord) { return }
    $output = [string]$script:LastRecord.output
    if ([string]::IsNullOrWhiteSpace($output)) { $output = '(no output)' }
    [System.Windows.Forms.Clipboard]::SetText($output)
    $copyButton.Text = 'COPIED'
    $form.Opacity = 0.90
    $lastOutput.ForeColor = $Palette.Muted
    $copyResetTimer.Stop()
    $copyResetTimer.Start()
}

function Append-LiveText([string]$text) {
    if ([string]::IsNullOrEmpty($text)) { return }
    [void]$script:LiveText.Append($text)
    if (-not $text.EndsWith("`n")) { [void]$script:LiveText.Append("`r`n") }
    $liveOutput.AppendText($text)
    if (-not $text.EndsWith("`n")) { $liveOutput.AppendText("`r`n") }
    $liveOutput.SelectionStart = $liveOutput.TextLength
    $liveOutput.ScrollToCaret()
    if ($HudSettings.MainLive -and $script:ActivePowerShell) {
        $lastOutput.AppendText($text)
        if (-not $text.EndsWith("`n")) { $lastOutput.AppendText("`r`n") }
        $lastOutput.SelectionStart = $lastOutput.TextLength
        $lastOutput.ScrollToCaret()
    }
}

function Update-LiveOutput {
    if (-not $script:ActiveLivePath -or -not (Test-Path -LiteralPath $script:ActiveLivePath)) { return }
    $stream = $null
    $reader = $null
    try {
        $stream = [System.IO.FileStream]::new(
            $script:ActiveLivePath,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::ReadWrite
        )
        $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8)
        $text = $reader.ReadToEnd()
        if ($text.Length -gt $script:LiveReadLength) {
            $newText = $text.Substring($script:LiveReadLength)
            $script:LiveReadLength = $text.Length
            $script:ActivityColorIndex = ($script:ActivityColorIndex + 1) % $Rainbow.Count
            Append-LiveText $newText
        }
    } catch {} finally {
        if ($reader) { $reader.Dispose() }
        elseif ($stream) { $stream.Dispose() }
    }
}

function Toggle-LiveWindow {
    if ($liveForm.Visible) {
        $liveForm.Hide()
    } else {
        $liveForm.Show($form)
        $liveForm.Activate()
    }
}

function Get-AnimatedFace {
    switch ($script:HudMode) {
        'run' {
            $frames = @('(o_o)', '(O_o)', '(O_O)', '(o_O)')
            return $frames[$script:AnimationTick % $frames.Count]
        }
        'pass' { return $(if ($script:AnimationTick -lt 8 -and $script:AnimationTick % 2) { '(^o^)' } else { '(^_^)' }) }
        'fail' { return $(if ($script:AnimationTick -lt 8 -and $script:AnimationTick % 2) { '(X_X)' } else { '(x_x)' }) }
        'stop' { return '(-_-)' }
        default { return $(if ($script:AnimationTick % 32 -eq 0) { '(-_-)' } else { '(._.)' }) }
    }
}

function Add-HistoryRecord($record, [bool]$persist) {
    if ($persist) {
        $record | ConvertTo-Json -Compress | Add-Content -LiteralPath $historyPath -Encoding UTF8
    }
}

function Show-Record($record) {
    if ($null -eq $record) { return }

    $statusLabel.Text = if ($record.status -eq 'passed') { 'PASS' } elseif ($record.status -eq 'failed') { 'FAIL' } else { 'STOP' }
    $script:HudMode = if ($record.status -eq 'passed') { 'pass' } elseif ($record.status -eq 'failed') { 'fail' } else { 'stop' }
    $script:AnimationTick = 0
    $script:ActivityColorIndex = 0
    $faceLabel.Text = Get-AnimatedFace
    $statusLabel.ForeColor = if ($record.status -eq 'passed') {
        $Palette.Success
    } elseif ($record.status -eq 'failed') {
        $Palette.Failure
    } else {
        $Palette.Warning
    }

    $output = $record.output
    if ([string]::IsNullOrWhiteSpace($output) -and $record.log_path -and (Test-Path -LiteralPath $record.log_path)) {
        $output = Get-Content -LiteralPath $record.log_path -Raw
    }
    if ([string]::IsNullOrWhiteSpace($output)) { $output = '(no output)' }

    $lastOutput.Text = $output
    $lastOutput.SelectionStart = 0
    $lastOutput.ScrollToCaret()
}

function Complete-Command([bool]$cancelled = $false) {
    $stopwatch = $script:ActiveRecord.stopwatch
    $stopwatch.Stop()
    $resultObjects = @()
    $errors = @()
    $warnings = @()

    try {
        if (-not $cancelled) {
            $resultObjects = @($script:ActivePowerShell.EndInvoke($script:ActiveAsync))
        }
    } catch {
        $errors += $_
    }
    Update-LiveOutput

    $errors += @($script:ActivePowerShell.Streams.Error)
    $warnings += @($script:ActivePowerShell.Streams.Warning)

    $parts = [System.Collections.Generic.List[string]]::new()
    $normalText = Convert-ObjectsToText $resultObjects
    if ($normalText) { $parts.Add($normalText) }
    foreach ($warning in $warnings) { $parts.Add('WARNING: ' + $warning.Message) }
    foreach ($errorItem in $errors) { $parts.Add('ERROR: ' + $errorItem.ToString()) }
    if ($cancelled) { $parts.Add('COMMAND CANCELLED') }
    $output = ($parts -join "`r`n")

    $recordedExit = $script:Runspace.SessionStateProxy.GetVariable('__CJ_EXIT')
    $exitCode = if ($cancelled) {
        130
    } elseif ($null -ne $recordedExit) {
        [int]$recordedExit
    } elseif ($errors.Count -gt 0) {
        1
    } else {
        0
    }
    $status = if ($cancelled) { 'stopped' } elseif ($exitCode -eq 0 -and $errors.Count -eq 0) { 'passed' } else { 'failed' }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $logPath = Join-Path $logRoot ($stamp + '.log')
    $output | Set-Content -LiteralPath $logPath -Encoding UTF8

    $record = [pscustomobject]@{
        id               = $stamp
        started          = $script:ActiveRecord.started.ToString('o')
        started_display  = $script:ActiveRecord.started.ToString('HH:mm:ss')
        command          = $script:ActiveRecord.command
        directory        = $script:ActiveRecord.directory
        duration_seconds = [math]::Round($stopwatch.Elapsed.TotalSeconds, 3)
        exit_code        = $exitCode
        status           = $status
        log_path         = $logPath
        output           = $output
    }

    Add-HistoryRecord $record $true
    $script:LastRecord = $record
    Show-Record $record

    if ($output) { Write-Host $output }
    Write-Host ''

    $script:ActivePowerShell.Dispose()
    $script:ActivePowerShell = $null
    $script:ActiveAsync = $null
    $script:ActiveLivePath = $null
    $script:ActiveRecord = $null
    $pollTimer.Stop()
    $runButton.Enabled = $true
    $cancelButton.Enabled = $false
    $inputBox.ReadOnly = $false
    $inputBox.Focus()
}

function Start-Command {
    if ($script:ActivePowerShell) { return }
    $command = $inputBox.Text.Trim()
    if ([string]::IsNullOrWhiteSpace($command)) { return }
    if ($script:CommandHistory.Count -eq 0 -or $script:CommandHistory[$script:CommandHistory.Count - 1] -ne $command) {
        $script:CommandHistory.Add($command)
    }
    $script:HistoryOffset = 0

    $directory = $script:Runspace.SessionStateProxy.Path.CurrentLocation.Path
    $started = Get-Date
    $script:ActiveRecord = [pscustomobject]@{
        command = $command
        directory = $directory
        started = $started
        stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    }

    $statusLabel.Text = 'RUN'
    $script:HudMode = 'run'
    $script:AnimationTick = 0
    $script:ActivityColorIndex = 0
    $faceLabel.Text = Get-AnimatedFace
    $statusLabel.ForeColor = $Palette.ElectricCyan
    $lastOutput.Clear()
    $runButton.Enabled = $false
    $cancelButton.Enabled = $true
    $inputBox.ReadOnly = $true
    $inputBox.Clear()
    $liveOutput.Clear()
    [void]$script:LiveText.Clear()
    $script:LiveReadLength = 0
    $script:ActiveLivePath = Join-Path $logRoot ('active-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.log')
    [System.IO.File]::WriteAllText($script:ActiveLivePath, '', [System.Text.UTF8Encoding]::new($false))
    Write-Host "`nPS $directory> $command" -ForegroundColor Cyan

    $script:ActivePowerShell = [powershell]::Create()
    $script:ActivePowerShell.Runspace = $script:Runspace
    $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($command))
    $encodedLivePath = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script:ActiveLivePath))
    $wrapper = @"
`$global:LASTEXITCODE = `$null
`$global:__CJ_EXIT = `$null
`$global:__CJ_SUCCESS = `$false
try {
    `$__cj_text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$encodedCommand'))
    `$__cj_live = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$encodedLivePath'))
    & {
        try {
            . ([scriptblock]::Create(`$__cj_text))
            `$global:__CJ_SUCCESS = `$?
        } catch {
            `$global:__CJ_SUCCESS = `$false
            Write-Error `$_
        }
    } *>&1 | ForEach-Object {
        `$__cj_line = (`$_ | Out-String -Width 240).TrimEnd()
        if (`$__cj_line) {
            try {
                [System.IO.File]::AppendAllText(`$__cj_live, `$__cj_line + [Environment]::NewLine, [System.Text.UTF8Encoding]::new(`$false))
            } catch {}
        }
        `$_
    }
} catch {
    `$global:__CJ_SUCCESS = `$false
    Write-Error `$_
}
`$global:__CJ_EXIT = if (`$null -ne `$global:LASTEXITCODE) {
    [int]`$global:LASTEXITCODE
} elseif (`$global:__CJ_SUCCESS) {
    0
} else {
    1
}
"@
    [void]$script:ActivePowerShell.AddScript($wrapper)
    $script:ActiveAsync = $script:ActivePowerShell.BeginInvoke()
    $pollTimer.Start()
}

$form = [System.Windows.Forms.Form]::new()
$form.Text = 'hate.this.meaningless.life'
$form.StartPosition = 'CenterScreen'
$form.Size = [System.Drawing.Size]::new(900, 540)
$form.MinimumSize = [System.Drawing.Size]::new(620, 360)
$form.TopMost = $HudSettings.AlwaysOnTop
$form.BackColor = $Palette.Background
$form.ForeColor = $Palette.Foreground
$form.KeyPreview = $true
$form.AutoScaleMode = 'Dpi'

$layout = [System.Windows.Forms.TableLayoutPanel]::new()
$layout.Dock = 'Fill'
$layout.Padding = [System.Windows.Forms.Padding]::new(8)
$layout.ColumnCount = 1
$layout.RowCount = 5
[void]$layout.RowStyles.Add([System.Windows.Forms.RowStyle]::new('Absolute', 24))
[void]$layout.RowStyles.Add([System.Windows.Forms.RowStyle]::new('Percent', 100))
[void]$layout.RowStyles.Add([System.Windows.Forms.RowStyle]::new('Absolute', 22))
[void]$layout.RowStyles.Add([System.Windows.Forms.RowStyle]::new('Absolute', 72))
[void]$layout.RowStyles.Add([System.Windows.Forms.RowStyle]::new('Absolute', 32))
$form.Controls.Add($layout)

$topBar = [System.Windows.Forms.Panel]::new()
$topBar.Dock = 'Fill'
$lastLabel = [System.Windows.Forms.Label]::new()
$lastLabel.Text = 'OUTPUT'
$lastLabel.Font = New-ControlFont 10 ([System.Drawing.FontStyle]::Bold)
$lastLabel.ForeColor = $Palette.ElectricCyan
$lastLabel.AutoSize = $true
$lastLabel.Location = [System.Drawing.Point]::new(0, 5)
$faceLabel = [System.Windows.Forms.Label]::new()
$faceLabel.Text = '(._.)'
$faceLabel.Font = New-ControlFont 11 ([System.Drawing.FontStyle]::Bold)
$faceLabel.ForeColor = $Palette.ElectricCyan
$faceLabel.AutoSize = $true
$faceLabel.Location = [System.Drawing.Point]::new(370, 4)
$statusLabel = [System.Windows.Forms.Label]::new()
$statusLabel.Text = 'READY'
$statusLabel.Font = New-ControlFont 10 ([System.Drawing.FontStyle]::Bold)
$statusLabel.ForeColor = $Palette.Muted
$statusLabel.AutoSize = $true
$statusLabel.Anchor = 'Top,Right'
$statusLabel.Location = [System.Drawing.Point]::new(870, 5)
$topBar.Controls.AddRange(@($lastLabel, $faceLabel, $statusLabel))
$topBar.Add_Resize({
    $faceLabel.Left = [math]::Max(0, [math]::Floor(($topBar.ClientSize.Width - $faceLabel.Width) / 2))
    $statusLabel.Left = [math]::Max(0, $topBar.ClientSize.Width - $statusLabel.Width)
})
$layout.Controls.Add($topBar, 0, 0)

$lastOutput = [System.Windows.Forms.RichTextBox]::new()
$lastOutput.Dock = 'Fill'
$lastOutput.ReadOnly = $true
$lastOutput.BackColor = $Palette.Background
$lastOutput.ForeColor = $Palette.Foreground
$lastOutput.Font = New-ControlFont 10
$lastOutput.BorderStyle = 'FixedSingle'
$lastOutput.WordWrap = $false
$lastOutput.Text = ''
$layout.Controls.Add($lastOutput, 0, 1)

$inputLabel = [System.Windows.Forms.Label]::new()
$inputLabel.Text = 'INPUT'
$inputLabel.Font = New-ControlFont 10 ([System.Drawing.FontStyle]::Bold)
$inputLabel.ForeColor = $Palette.AcidChartreuse
$inputLabel.Dock = 'Fill'
$inputLabel.TextAlign = 'MiddleLeft'
$layout.Controls.Add($inputLabel, 0, 2)

$inputPanel = [System.Windows.Forms.Panel]::new()
$inputPanel.Dock = 'Fill'
$inputBox = [System.Windows.Forms.RichTextBox]::new()
$inputBox.Dock = 'Fill'
$inputBox.AcceptsTab = $true
$inputBox.BackColor = $Palette.Background
$inputBox.ForeColor = $Palette.AcidChartreuse
$inputBox.Font = New-ControlFont 11
$inputBox.BorderStyle = 'FixedSingle'
$runButton = [System.Windows.Forms.Button]::new()
$runButton.Text = 'RUN'
Set-ButtonStyle $runButton $Palette.AcidChartreuse
$cancelButton = [System.Windows.Forms.Button]::new()
$cancelButton.Text = 'STOP'
$cancelButton.Enabled = $false
Set-ButtonStyle $cancelButton $Palette.Failure
$inputPanel.Controls.Add($inputBox)
$layout.Controls.Add($inputPanel, 0, 3)

$bottomBar = [System.Windows.Forms.TableLayoutPanel]::new()
$bottomBar.Dock = 'Fill'
$bottomBar.ColumnCount = 5
$bottomBar.RowCount = 1
[void]$bottomBar.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new('Percent', 20))
[void]$bottomBar.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new('Percent', 20))
[void]$bottomBar.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new('Percent', 20))
[void]$bottomBar.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new('Percent', 20))
[void]$bottomBar.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new('Percent', 20))
$runButton.Dock = 'Fill'
$cancelButton.Dock = 'Fill'
$liveButton = [System.Windows.Forms.Button]::new()
$liveButton.Text = 'LIVE'
$liveButton.Dock = 'Fill'
Set-ButtonStyle $liveButton $Palette.Warning
$copyButton = [System.Windows.Forms.Button]::new()
$copyButton.Text = 'COPY'
$copyButton.Dock = 'Fill'
Set-ButtonStyle $copyButton $Palette.ElectricCyan
$copyAllButton = [System.Windows.Forms.Button]::new()
$copyAllButton.Text = 'ALL'
$copyAllButton.Dock = 'Fill'
Set-ButtonStyle $copyAllButton $Palette.MetallicTeal
$bottomBar.Controls.Add($runButton, 0, 0)
$bottomBar.Controls.Add($cancelButton, 1, 0)
$bottomBar.Controls.Add($liveButton, 2, 0)
$bottomBar.Controls.Add($copyButton, 3, 0)
$bottomBar.Controls.Add($copyAllButton, 4, 0)
$layout.Controls.Add($bottomBar, 0, 4)

$liveForm = [System.Windows.Forms.Form]::new()
$liveForm.Text = 'live'
$liveForm.StartPosition = 'CenterParent'
$liveForm.Size = [System.Drawing.Size]::new(900, 560)
$liveForm.MinimumSize = [System.Drawing.Size]::new(520, 300)
$liveForm.BackColor = $Palette.Background
$liveForm.ForeColor = $Palette.Foreground
$liveForm.AutoScaleMode = 'Dpi'
$liveOutput = [System.Windows.Forms.RichTextBox]::new()
$liveOutput.Dock = 'Fill'
$liveOutput.ReadOnly = $true
$liveOutput.BackColor = $Palette.Background
$liveOutput.ForeColor = $Palette.Foreground
$liveOutput.Font = New-ControlFont 10
$liveOutput.BorderStyle = 'None'
$liveOutput.WordWrap = $false
$liveForm.Controls.Add($liveOutput)
$liveForm.Add_FormClosing({
    param($sender, $eventArgs)
    if ($form.Visible) {
        $eventArgs.Cancel = $true
        $liveForm.Hide()
    }
})

$pollTimer = [System.Windows.Forms.Timer]::new()
$pollTimer.Interval = 100
$pollTimer.Add_Tick({
    Update-LiveOutput
    if ($script:ActiveAsync -and $script:ActiveAsync.IsCompleted) {
        Update-LiveOutput
        Complete-Command
    }
})

$copyResetTimer = [System.Windows.Forms.Timer]::new()
$copyResetTimer.Interval = 220
$copyResetTimer.Add_Tick({
    $copyResetTimer.Stop()
    $copyButton.Text = 'COPY'
    $form.Opacity = 1.0
    $lastOutput.ForeColor = $Palette.Foreground
})

$copyAllResetTimer = [System.Windows.Forms.Timer]::new()
$copyAllResetTimer.Interval = 900
$copyAllResetTimer.Add_Tick({
    $copyAllResetTimer.Stop()
    $copyAllButton.Text = 'ALL'
})

$animationTimer = [System.Windows.Forms.Timer]::new()
$animationTimer.Interval = 140
$animationTimer.Add_Tick({
    $script:AnimationTick++
    $topBar.BackColor = $Palette.Background
    $faceLabel.Text = Get-AnimatedFace
    $faceLabel.ForeColor = switch ($script:HudMode) {
        'run' { $Rainbow[$script:ActivityColorIndex] }
        'pass' { $Palette.Success }
        'fail' { $Palette.Failure }
        'stop' { $Palette.Warning }
        default { $Palette.ElectricCyan }
    }
    if ($script:HudMode -eq 'run' -and $script:AnimationTick % 4 -eq 2) { $topBar.BackColor = $Palette.Surface }
})
$animationTimer.Start()

$runButton.Add_Click({ Start-Command })
$cancelButton.Add_Click({
    if ($script:ActivePowerShell) {
        try { $script:ActivePowerShell.Stop() } catch {}
        Complete-Command $true
    }
})
$liveButton.Add_Click({ Toggle-LiveWindow })
$copyButton.Add_Click({ Copy-LatestOutput })
$copyAllButton.Add_Click({ Copy-AllHistory })
$lastOutput.Add_Click({ if ($HudSettings.ClickCopy) { Copy-LatestOutput } })
$inputBox.Add_Click({
    if (-not $inputBox.ReadOnly -and $inputBox.TextLength -eq 0 -and [System.Windows.Forms.Clipboard]::ContainsText()) {
        $clipboardText = [System.Windows.Forms.Clipboard]::GetText()
        if ($clipboardText -ne $script:LastAutoPasteText) {
            $inputBox.Text = $clipboardText
            $inputBox.SelectionStart = $inputBox.TextLength
            $script:LastAutoPasteText = $clipboardText
            if ($HudSettings.AutoRunPaste) { Start-Command }
        }
    }
})
$inputBox.Add_MouseWheel({
    param($sender, $eventArgs)
    if (-not $HudSettings.HistoryWheel -or $script:ActivePowerShell -or $script:CommandHistory.Count -eq 0) { return }
    if ($eventArgs.Delta -gt 0) {
        $script:HistoryOffset = [math]::Min($script:CommandHistory.Count, $script:HistoryOffset + 1)
    } else {
        $script:HistoryOffset = [math]::Max(0, $script:HistoryOffset - 1)
    }
    if ($script:HistoryOffset -eq 0) {
        $inputBox.Clear()
    } else {
        $inputBox.Text = $script:CommandHistory[$script:CommandHistory.Count - $script:HistoryOffset]
        $inputBox.SelectionStart = $inputBox.TextLength
    }
})
$inputBox.Add_KeyDown({
    param($sender, $eventArgs)
    $atStart = $inputBox.SelectionStart -eq 0 -and $inputBox.SelectionLength -eq 0
    if ($atStart -and ($eventArgs.KeyCode -eq [System.Windows.Forms.Keys]::Back -or $eventArgs.KeyCode -eq [System.Windows.Forms.Keys]::Left)) {
        $eventArgs.SuppressKeyPress = $true
        $eventArgs.Handled = $true
        return
    }
    if ($eventArgs.KeyCode -eq [System.Windows.Forms.Keys]::Enter -and -not $eventArgs.Shift) {
        $eventArgs.SuppressKeyPress = $true
        Start-Command
    }
})

$form.Add_FormClosing({
    $animationTimer.Stop()
    $copyResetTimer.Stop()
    $copyAllResetTimer.Stop()
    $pollTimer.Stop()
    $liveForm.Hide()
    if ($script:ActivePowerShell) {
        try { $script:ActivePowerShell.Stop() } catch {}
        $script:ActivePowerShell.Dispose()
    }
    $script:Runspace.Close()
    $script:Runspace.Dispose()
})

$form.Add_Shown({
    $faceLabel.Left = [math]::Max(0, [math]::Floor(($topBar.ClientSize.Width - $faceLabel.Width) / 2))
    $statusLabel.Left = [math]::Max(0, $topBar.ClientSize.Width - $statusLabel.Width)
    $inputBox.Focus()
})

[void][System.Windows.Forms.Application]::Run($form)
