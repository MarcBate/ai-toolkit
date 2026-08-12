# Stop a running AI Toolkit UI stack (worker + fileServer + Next).
#
# The stack runs under `concurrently --restart-tries -1`, so killing the worker
# or the file server on its own just gets it respawned. The only thing that
# sticks is killing the top of the tree, which is what this walks up to find.
#
# Exits 0 when the stack is down and port 8675 is free, 1 otherwise.

[CmdletBinding()]
param(
    # Kill even if a trainer process is alive. Off by default: losing an
    # in-flight training run costs hours, and the UI stack is cheap to restart.
    [switch]$Force
)

$repo = Split-Path -Parent $PSScriptRoot

function Get-ToolkitProcesses {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -and
        $_.CommandLine -match [regex]::Escape($repo) -and
        $_.CommandLine -match 'dist[\\/]cron|concurrently|npm-cli\.js|npm\.cmd|next'
    }
}

# --- refuse to kill a live training run unless explicitly forced -------------
$trainers = Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'run_ui\.py|run\.py' }

if ($trainers -and -not $Force) {
    Write-Host ""
    Write-Host "  A trainer process is still running:" -ForegroundColor Yellow
    foreach ($t in $trainers) { Write-Host "    pid $($t.ProcessId)  $($t.CommandLine)" }
    Write-Host ""
    Write-Host "  Refusing to stop - killing this loses the in-flight training step." -ForegroundColor Yellow
    Write-Host "  Use Save and Pause in the UI first, or re-run with -Force." -ForegroundColor Yellow
    exit 1
}

$procs = Get-ToolkitProcesses
if (-not $procs) {
    Write-Host "  Nothing to stop - no AI Toolkit processes found."
    exit 0
}

# Walk each process up to the highest ancestor that is still part of the stack.
# Killing that root takes concurrently and its children down together, so the
# supervisor never gets the chance to restart anything.
$byId = @{}
foreach ($p in Get-CimInstance Win32_Process -ErrorAction SilentlyContinue) { $byId[[int]$p.ProcessId] = $p }
$toolkitIds = @{}
foreach ($p in $procs) { $toolkitIds[[int]$p.ProcessId] = $true }

$roots = @{}
foreach ($p in $procs) {
    $cur = $p
    while ($true) {
        $parent = $byId[[int]$cur.ParentProcessId]
        if (-not $parent) { break }
        # keep climbing while the parent still belongs to this repo's stack
        if ($parent.CommandLine -and $parent.CommandLine -match [regex]::Escape($repo)) {
            $cur = $parent
            continue
        }
        # also climb through the plain cmd.exe shims npm inserts between steps
        if ($parent.Name -eq 'cmd.exe' -and $parent.CommandLine -match 'npm|concurrently') {
            $cur = $parent
            continue
        }
        break
    }
    $roots[[int]$cur.ProcessId] = $true
}

foreach ($rootPid in $roots.Keys) {
    Write-Host "  Stopping process tree $rootPid ..."
    & taskkill.exe /PID $rootPid /T /F 2>&1 | Out-Null
}

# Mop up anything orphaned by the tree kill.
Start-Sleep -Milliseconds 500
foreach ($p in Get-ToolkitProcesses) {
    & taskkill.exe /PID $p.ProcessId /T /F 2>&1 | Out-Null
}

# --- wait for the port to actually come free --------------------------------
# Process death and socket release are not the same moment; returning before
# the port frees would let the caller start a new stack that fails to bind.
for ($i = 0; $i -lt 30; $i++) {
    $listening = Get-NetTCPConnection -LocalPort 8675 -State Listen -ErrorAction SilentlyContinue
    if (-not $listening) {
        Write-Host "  Stopped. Port 8675 is free."
        exit 0
    }
    Start-Sleep -Milliseconds 500
}

Write-Host "  Processes were killed but port 8675 is still held." -ForegroundColor Yellow
exit 1
