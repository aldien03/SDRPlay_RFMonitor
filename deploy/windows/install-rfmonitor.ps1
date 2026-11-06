<#
 RF Monitor - Windows 11 installer (evaluation / unqualified).
 Normal use: double-click Install-RFMonitor.bat. Safe to run again at any time.
 Options:  -CheckOnly   look at the PC and change nothing
           -Uninstall   remove the start-up tasks (your recordings are kept)
 ASCII only on purpose: Windows PowerShell 5.1 misreads other characters.
#>
[CmdletBinding()]
param(
  [switch]$CheckOnly,
  [switch]$Uninstall,
  [string]$AppDir = 'C:\RFMonitor\app',
  [string]$DataRoot = "$env:ProgramData\RFMonitor",
  [int]$Port = 8080,
  [int]$SdrConnectPort = 5454
)
$ErrorActionPreference = 'Stop'
$Source = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$TaskApp = 'RF Monitor'
$TaskSdr = 'RF Monitor - SDRconnect'
$Total = 8
$script:Problems = New-Object System.Collections.ArrayList

function Step($n, $text) { Write-Host ""; Write-Host "[$n/$Total] $text" -ForegroundColor Cyan }
function Ok($text)   { Write-Host "   OK    $text" -ForegroundColor Green }
function Info($text) { Write-Host "         $text" }
function Warn($text) { Write-Host "   NOTE  $text" -ForegroundColor Yellow }
function Fail($what, $fix) {
  [void]$script:Problems.Add($what)
  Write-Host "   STOP  $what" -ForegroundColor Red
  Write-Host "         To fix: $fix" -ForegroundColor Red
}
function Pause-ForUser($text) {
  if ($CheckOnly) { return }
  Write-Host ""; Read-Host "   >>> $text  Press Enter when done" | Out-Null
}
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
}
function Get-NodeInfo {
  Refresh-Path
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { return $null }
  $v = (& $cmd.Source -v).Trim()
  [pscustomobject]@{ Path = $cmd.Source; Version = $v; Major = [int]($v.TrimStart('v').Split('.')[0]) }
}
function Find-Exe($names) {
  $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ }
  foreach ($root in $roots) {
    $dir = Join-Path $root 'SDRplay'
    if (Test-Path $dir) {
      foreach ($n in $names) {
        $hit = Get-ChildItem -Path $dir -Recurse -Filter $n -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($hit) { return $hit.FullName }
      }
    }
  }
  return $null
}
function Write-NoBom($path, $text) { [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($false))) }

Write-Host ""
Write-Host "=== RF Monitor installer for Windows 11 ===" -ForegroundColor White
Write-Host "This PC will be an EVALUATION install. Production monitoring uses Ubuntu 24.04."
if ($CheckOnly) { Write-Host "Check-only mode: nothing will be changed." -ForegroundColor Yellow }

# ---------- Uninstall ----------
if ($Uninstall) {
  foreach ($t in @($TaskApp, $TaskSdr)) {
    if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $t -Confirm:$false
      Ok "Removed start-up task: $t"
    }
  }
  Info "Kept your recordings and settings in $DataRoot. Delete that folder yourself if you no longer need it."
  return
}

# ---------- 1. Windows ----------
Step 1 'Checking Windows'
$os = Get-CimInstance Win32_OperatingSystem
if ([int]$os.BuildNumber -ge 22000) { Ok "$($os.Caption) (build $($os.BuildNumber))" }
else { Fail "This is not Windows 11 ($($os.Caption))." 'Use a Windows 11 PC.' }
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrator')
if ($isAdmin) { Ok 'Running as administrator' }
elseif (-not $CheckOnly) { Fail 'Not running as administrator.' 'Close this window and double-click Install-RFMonitor.bat, then choose Yes when Windows asks.' }
$web = $false
try { $web = (Test-NetConnection -ComputerName 'registry.npmjs.org' -Port 443 -WarningAction SilentlyContinue).TcpTestSucceeded } catch { }
if ($web) { Ok 'Internet access works' } else { Warn 'No internet access detected. Node.js and the build step need it.' }
if ($script:Problems.Count -gt 0 -and -not $CheckOnly) { Write-Host ""; Write-Host "Stopped. Nothing was changed." -ForegroundColor Red; return }

# ---------- 2. Clock and power ----------
Step 2 'Clock and sleep settings'
$w32 = Get-Service w32time -ErrorAction SilentlyContinue
if ($w32 -and $w32.Status -eq 'Running') { Ok 'Windows clock service is running' }
elseif ($CheckOnly) { Warn 'Windows clock service is not running (the installer would start it).' }
else {
  Set-Service w32time -StartupType Automatic; Start-Service w32time; w32tm /resync 2>&1 | Out-Null
  Ok 'Started the Windows clock service (recordings need a correct clock)'
}
if (-not $CheckOnly) {
  powercfg /change standby-timeout-ac 0; powercfg /change hibernate-timeout-ac 0
  Ok 'Sleep turned off while plugged in, so monitoring is not interrupted'
}

# ---------- 3. Node.js ----------
Step 3 'Node.js (the program that runs RF Monitor)'
$node = Get-NodeInfo
if ($node -and $node.Major -ge 20) { Ok "Node.js $($node.Version) found" }
elseif ($CheckOnly) { Fail 'Node.js 20 or newer is missing.' 'Run this installer without -CheckOnly, or install the LTS version from https://nodejs.org' }
else {
  Info 'Node.js 20 or newer is missing. Installing the LTS version (about 30 MB)...'
  $installed = $false
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements
    $node = Get-NodeInfo
    $installed = ($node -and $node.Major -ge 20)
  }
  if (-not $installed) {
    Start-Process 'https://nodejs.org/en/download'
    Info 'Automatic install did not work. A web page has opened.'
    Info 'Download the Windows Installer (.msi) marked LTS, run it, and accept all defaults.'
    Pause-ForUser 'Finish installing Node.js.'
    $node = Get-NodeInfo
  }
  if ($node -and $node.Major -ge 20) { Ok "Node.js $($node.Version) installed" }
  else { Fail 'Node.js 20+ is still not available.' 'Install it from https://nodejs.org (LTS), restart the PC, and run this installer again.' }
}

# ---------- 4. SDRplay API ----------
Step 4 'SDRplay API (the driver for the RSPdx)'
function Test-SdrApi { $s = Get-Service -Name 'SDRplayAPIService' -ErrorAction SilentlyContinue; return ($s -and $s.Status -eq 'Running') }
if (Test-SdrApi) { Ok 'SDRplay API service is running' }
else {
  if ($CheckOnly) { Fail 'SDRplay API is not installed or not running.' 'Install the API for Windows from https://www.sdrplay.com/api/' }
  else {
    Start-Process 'https://www.sdrplay.com/api/'
    Info 'A web page has opened. Do this:'
    Info '  1. Under "Windows", download the SDRplay API installer.'
    Info '  2. Run it and accept the defaults. Click Yes if Windows asks about the driver.'
    Info '  3. Do NOT plug the RSPdx in yet if the installer says so; follow its prompts.'
    Pause-ForUser 'Finish installing the SDRplay API.'
    if (Test-SdrApi) { Ok 'SDRplay API service is running' }
    else { Fail 'SDRplay API service is not running.' 'Restart the PC, then run this installer again. If it persists, reinstall the API.' }
  }
}

# ---------- 5. SDRconnect and receiver ----------
Step 5 'SDRconnect and the RSPdx receiver'
$sdrGui = Find-Exe @('SDRconnect.exe')
$sdrHeadless = Find-Exe @('SDRconnect_headless.exe')
if ($sdrGui -or $sdrHeadless) { Ok "SDRconnect found: $(if ($sdrHeadless) { $sdrHeadless } else { $sdrGui })" }
elseif ($CheckOnly) { Fail 'SDRconnect is not installed.' 'Install it from https://www.sdrplay.com/sdrconnect/' }
else {
  Start-Process 'https://www.sdrplay.com/sdrconnect/'
  Info 'A web page has opened. Download SDRconnect for Windows x64, run it, accept the defaults.'
  Pause-ForUser 'Finish installing SDRconnect.'
  $sdrGui = Find-Exe @('SDRconnect.exe'); $sdrHeadless = Find-Exe @('SDRconnect_headless.exe')
  if ($sdrGui -or $sdrHeadless) { Ok 'SDRconnect found' }
  else { Fail 'SDRconnect was not found under Program Files\SDRplay.' 'Reinstall SDRconnect with default options, then run this installer again.' }
}
$rsp = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match 'RSP' -or $_.InstanceId -match 'VID_1DF7' }
if ($rsp) { Ok "Receiver connected: $($rsp[0].FriendlyName)" }
else {
  Warn 'No SDRplay receiver detected.'
  Info 'Plug the RSPdx straight into a blue USB 3 port on the PC (no USB hub) and keep the antenna connected.'
  Pause-ForUser 'Connect the RSPdx.'
  $rsp = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match 'RSP' -or $_.InstanceId -match 'VID_1DF7' }
  if ($rsp) { Ok 'Receiver connected' } else { Warn 'Still no receiver. The dashboard will show Offline until it is connected.' }
}

if ($CheckOnly) {
  Write-Host ""
  if ($script:Problems.Count) { Write-Host "Check finished: $($script:Problems.Count) item(s) need attention (see STOP above)." -ForegroundColor Yellow }
  else { Write-Host 'Check finished: this PC is ready. Run the installer without -CheckOnly.' -ForegroundColor Green }
  return
}
if ($script:Problems.Count -gt 0) {
  Write-Host ""; Write-Host 'Stopped before installing RF Monitor because of the STOP items above.' -ForegroundColor Red
  Write-Host 'Fix them, then double-click Install-RFMonitor.bat again. Nothing is broken by re-running.'
  return
}

# ---------- 6. Copy, build ----------
Step 6 'Installing and building RF Monitor (takes 2-5 minutes)'
New-Item -ItemType Directory -Force $AppDir | Out-Null
robocopy $Source $AppDir /MIR /XD node_modules .git dist tmp evidence artifacts /XF *.log /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copying files failed (robocopy code $LASTEXITCODE)." }
$nodeBin = $node.Path
$npm = Join-Path (Split-Path $nodeBin) 'npm.cmd'
Push-Location $AppDir
try {
  Info 'Downloading components (npm ci)...'
  & $npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed. Check the internet connection and run the installer again.' }
  Info 'Building (npm run build)...'
  & $npm run build
  if ($LASTEXITCODE -ne 0) { throw 'npm run build failed. Send the text above to the maintainer.' }
} finally { Pop-Location }
if (-not (Test-Path "$AppDir\dist\server-node\index.js")) { throw 'Build finished but the program file is missing.' }
Ok 'RF Monitor built'

# ---------- 7. Settings, password, start-up ----------
Step 7 'Settings and start-up'
$cfg = Join-Path $DataRoot 'config'; $evi = Join-Path $DataRoot 'evidence'; $run = Join-Path $DataRoot 'runtime'
New-Item -ItemType Directory -Force $cfg, $evi, $run | Out-Null
icacls $DataRoot /inheritance:r /grant:r 'Administrators:(OI)(CI)F' 'SYSTEM:(OI)(CI)F' | Out-Null
if (-not (Test-Path "$cfg\catalog.json"))     { Copy-Item "$AppDir\config\band-catalog.example.json" "$cfg\catalog.json" }
if (-not (Test-Path "$run\operational.json")) { Copy-Item "$AppDir\config\operational.example.json" "$run\operational.json" }

if (Test-Path "$cfg\admin.json") { Ok 'Settings password already set (kept)' }
else {
  Info 'Choose a Settings password. It is needed only to change settings. 12-128 characters.'
  for ($try = 1; $try -le 3; $try++) {
    $a = Read-Host '   Password' -AsSecureString
    $b = Read-Host '   Repeat it' -AsSecureString
    $p1 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($a))
    $p2 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($b))
    if ($p1 -ne $p2) { Warn 'The two entries differ. Try again.'; continue }
    if ($p1.Length -lt 12 -or $p1.Length -gt 128 -or $p1 -match '[\r\n]') { Warn 'Use 12 to 128 characters on one line. Try again.'; continue }
    $tmp = Join-Path $cfg 'pw.tmp'
    Write-NoBom $tmp $p1
    cmd /c "`"$nodeBin`" `"$AppDir\dist\server-node\admin-credential.js`" < `"$tmp`" > `"$cfg\admin.json`""
    $code = $LASTEXITCODE
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    $p1 = $p2 = $null
    if ($code -ne 0 -or -not (Test-Path "$cfg\admin.json") -or (Get-Item "$cfg\admin.json").Length -lt 10) {
      Remove-Item "$cfg\admin.json" -Force -ErrorAction SilentlyContinue
      throw 'Could not store the password. Run the installer again.'
    }
    Ok 'Settings password saved (only a hash is stored). Write it down somewhere safe.'
    break
  }
  if (-not (Test-Path "$cfg\admin.json")) { throw 'No valid password entered. Run the installer again.' }
}

$launcher = Join-Path $DataRoot 'start-rf-monitor.ps1'
$envLines = @(
  "RF_MONITOR_REQUIRE_EXPLICIT_CONFIG=true", "RF_MONITOR_HOST=127.0.0.1", "RF_MONITOR_PORT=$Port",
  "RF_MONITOR_STORAGE=$evi", "RF_MONITOR_CATALOG_FILE=$cfg\catalog.json", "RF_MONITOR_OPERATIONAL_FILE=$run\operational.json",
  "RF_MONITOR_ADMIN_FILE=$cfg\admin.json", "RF_MONITOR_ADMIN_SESSION_MINUTES=15", "RF_MONITOR_SIMULATION=off",
  "RF_MONITOR_IQ_CAPTURE_MS=0", "RF_MONITOR_IQ_MAX_BYTES=67108864",
  "SDRCONNECT_URL=ws://127.0.0.1:$SdrConnectPort/", "SDRCONNECT_TIMEOUT_MS=3000", "SDRCONNECT_SAMPLE_RATE_HZ=10000000",
  "SDRCONNECT_DEVICE_INDEX=0", "SDRCONNECT_TLS_REJECT_UNAUTHORIZED=true", "TZ=UTC"
)
$body = New-Object System.Text.StringBuilder
foreach ($l in $envLines) { $k, $v = $l.Split('=', 2); [void]$body.AppendLine("`$env:$k = '$($v.Replace("'", "''"))'") }
[void]$body.AppendLine("Set-Location '$AppDir'")
[void]$body.AppendLine("& '$nodeBin' --max-old-space-size=384 dist\server-node\index.js *>> '$run\rf-monitor.log'")
Write-NoBom $launcher $body.ToString()

$settings = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
$act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`""
Register-ScheduledTask -TaskName $TaskApp -Action $act -Trigger (New-ScheduledTaskTrigger -AtStartup) -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
Ok 'RF Monitor will start automatically when the PC starts'

if ($sdrHeadless) {
  $act2 = New-ScheduledTaskAction -Execute $sdrHeadless -Argument "--websocket_port=$SdrConnectPort"
  Register-ScheduledTask -TaskName $TaskSdr -Action $act2 -Trigger (New-ScheduledTaskTrigger -AtStartup) -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskSdr
  Ok 'SDRconnect background service registered and started'
} else {
  Warn 'This SDRconnect has no background (headless) mode. Start SDRconnect yourself and turn on its WebSocket server (see the guide, "Turn on the SDRconnect server").'
}

# ---------- 8. Start and verify ----------
Step 8 'Starting and checking'
Start-ScheduledTask -TaskName $TaskApp
$healthy = $false
for ($i = 0; $i -lt 30 -and -not $healthy; $i++) {
  Start-Sleep -Seconds 2
  try { $r = Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 3; $healthy = $true } catch { }
}
if ($healthy) { Ok "RF Monitor is running at http://127.0.0.1:$Port/" }
else { Fail 'RF Monitor did not answer within 60 seconds.' "Open $run\rf-monitor.log in Notepad and send the last lines to the maintainer." }
$sdrUp = $false
try { $sdrUp = (Test-NetConnection -ComputerName 127.0.0.1 -Port $SdrConnectPort -WarningAction SilentlyContinue).TcpTestSucceeded } catch { }
if ($sdrUp) { Ok "SDRconnect server answers on port $SdrConnectPort" }
else { Warn "SDRconnect server is not answering on port $SdrConnectPort yet. The dashboard will show Offline until it is." }

$desktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
$lnk = Join-Path $desktop 'RF Monitor.url'
Write-NoBom $lnk "[InternetShortcut]`r`nURL=http://127.0.0.1:$Port/`r`n"
Ok 'Desktop shortcut "RF Monitor" created'

Write-Host ""
if ($healthy) {
  Write-Host 'DONE. Double-click "RF Monitor" on the desktop to open the dashboard.' -ForegroundColor Green
  Start-Process "http://127.0.0.1:$Port/"
} else { Write-Host 'Installed, but the program did not start. See the STOP message above.' -ForegroundColor Red }
Write-Host 'This is an unqualified evaluation install; the dashboard will not show production-ready.'
