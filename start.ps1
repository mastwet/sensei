<#
.SYNOPSIS
    Bootstrap and launch sensei on Windows (Windows equivalent of install.sh).

.DESCRIPTION
    1. Verifies Node >= 22.19 (the host contract in package.json engines).
    2. Installs the pinned pi host with --ignore-scripts, but only when the
       dependency tree is missing or stale relative to package.json.
    3. Links the `sensei` command globally (idempotent, ~1s).
    4. Smoke-checks the host, then hands the console to the TUI.

    Everything happens under the sensei agent dir (~/.sensei by default);
    ~/.pi and ~/.senpi are never touched.

.PARAMETER SkipInstall
    Never run npm install. Fails fast if the host is not present.

.PARAMETER SkipLink
    Skip the global `npm link` step.

.PARAMETER NewWindow
    Launch the TUI in a separate PowerShell window instead of the current
    console. Use this when this script is invoked without a real terminal
    (task scheduler, double-click, another agent's shell).

.PARAMETER SenseiArgs
    Remaining arguments are passed straight through to sensei, e.g.
        .\start.ps1 -p "explain this repo"
        .\start.ps1 --version

.EXAMPLE
    .\start.ps1
    .\start.ps1 -SkipInstall -SkipLink
    .\start.ps1 -NewWindow
#>
[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [switch]$SkipLink,
    [switch]$NewWindow,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$SenseiArgs
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }

function Write-Step { param([string]$Message) Write-Host "==> $Message" }
function Write-Ok   { param([string]$Message) Write-Host "    ok  $Message" }
function Write-Note { param([string]$Message) Write-Host "    ..  $Message" }
function Write-Warn { param([string]$Message) Write-Host "    !!  $Message" -ForegroundColor Yellow }

# Runs a native executable with stderr noise tolerated, and fails on a
# non-zero exit code. npm prints deprecation warnings on stderr; under
# ErrorActionPreference='Stop' those can surface as terminating error
# records on Windows PowerShell 5.1, so we neutralize it around the call
# and check the exit code ourselves instead.
function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [Parameter(Mandatory = $true)][string]$What
    )
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $FilePath @Arguments
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0) { throw "$What failed (exit code $code)" }
}

# --- 1. toolchain ------------------------------------------------------------

Write-Step 'Checking the toolchain'

$node = Get-Command node -ErrorAction SilentlyContinue
$npm  = Get-Command npm  -ErrorAction SilentlyContinue

if (-not $node) { throw 'node not found on PATH. Install Node.js >= 22.19 and reopen the shell.' }
if (-not $npm)  { throw 'npm not found on PATH. It ships with Node.js; reinstall Node.js.' }

$nodeVersion = [version]((& $node.Source --version).Trim().TrimStart('v'))
if ($nodeVersion -lt [version]'22.19.0') {
    throw "Node $nodeVersion is too old. sensei requires >= 22.19 (see package.json engines)."
}
Write-Ok "node $nodeVersion  (npm $(& $npm.Source --version))"

# --- 2. dependencies ---------------------------------------------------------

$hostCli = Join-Path $root 'node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js'
$pkgFile = Join-Path $root 'package.json'
$modules = Join-Path $root 'node_modules'

$needsInstall = $false
$reason = ''

if (-not (Test-Path $hostCli)) {
    $needsInstall = $true
    $reason = 'pinned pi host is not installed'
}
elseif ((Get-Item $modules).LastWriteTimeUtc -lt (Get-Item $pkgFile).LastWriteTimeUtc) {
    $needsInstall = $true
    $reason = 'package.json is newer than node_modules'
}

if ($SkipInstall) {
    if (-not (Test-Path $hostCli)) {
        throw '-SkipInstall was passed but the pi host is missing. Run without -SkipInstall first.'
    }
    Write-Ok 'install skipped (-SkipInstall)'
}
elseif ($needsInstall) {
    Write-Step "Installing dependencies ($reason)"
    Invoke-Native -FilePath $npm.Source -Arguments @('install', '--ignore-scripts') -What 'npm install'
    Write-Ok 'dependencies installed'
}
else {
    Write-Ok 'dependencies up to date'
}

if (-not (Test-Path $hostCli)) {
    throw "pi host still missing at $hostCli. Reinstall with: npm install --ignore-scripts"
}

# --- 3. global link ----------------------------------------------------------

$sensei = Get-Command sensei -ErrorAction SilentlyContinue

if ($SkipLink) {
    Write-Ok 'global link skipped (-SkipLink)'
}
else {
    Write-Step 'Linking the global sensei command'
    Invoke-Native -FilePath $npm.Source -Arguments @('link') -What 'npm link'
    $sensei = Get-Command sensei -ErrorAction SilentlyContinue
    if (-not $sensei) {
        Write-Warn 'sensei is not resolvable on PATH yet; falling back to the local launcher'
    }
    else {
        Write-Ok "sensei -> $($sensei.Source)"
    }
}

# --- 4. smoke check ----------------------------------------------------------

Write-Step 'Smoke-checking the host'

$expected = ([regex]::Match((Get-Content $pkgFile -Raw), '"@earendil-works/pi-coding-agent"\s*:\s*"([^"]+)"')).Groups[1].Value
$launcher = Join-Path $root 'bin\sensei.mjs'

$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$actual = (& $node.Source $launcher --version 2>&1 | Select-Object -Last 1)
$ErrorActionPreference = $previous

Write-Ok "pi host $actual (pinned $expected)"
if ($expected -and $actual -ne $expected) {
    Write-Warn "host reports $actual but package.json pins $expected"
}

# --- 5. next-step hints ------------------------------------------------------

$agentDir = if ($env:SENSEI_AGENT_DIR) { $env:SENSEI_AGENT_DIR }
            else { Join-Path $HOME '.sensei' }

$hints = @()
if (-not (Test-Path (Join-Path $agentDir 'auth.json'))) { $hints += 'no auth.json yet - log in on first launch, or set a provider env var' }
if ((Test-Path (Join-Path $agentDir 'models.json')) -and
    (Get-Item (Join-Path $agentDir 'models.json')).Length -le 32) { $hints += 'models.json is empty - add your OpenAI-compatible endpoint' }
if ($hints.Count -gt 0) {
    Write-Step "Agent dir $agentDir"
    $hints | ForEach-Object { Write-Note $_ }
}

# --- 6. launch ---------------------------------------------------------------

Write-Step 'Starting sensei'

if ($NewWindow) {
    $cmd = 'Set-Location -LiteralPath ''{0}''; & sensei {1}' -f $root, ($SenseiArgs -join ' ')
    $proc = Start-Process -FilePath 'powershell.exe' -WorkingDirectory $root `
        -ArgumentList '-NoExit', '-Command', $cmd -PassThru
    Start-Sleep -Seconds 3
    if ($proc.HasExited) {
        throw "sensei exited immediately (code $($proc.ExitCode)). Run .\start.ps1 without -NewWindow to see the error."
    }
    Write-Ok "TUI running in a new window (pid $($proc.Id))"
    return
}

# Hand this console to the TUI so it gets a real terminal; stdio is inherited.
if ($sensei) { & $sensei.Source @SenseiArgs } else { & $node.Source $launcher @SenseiArgs }
exit $LASTEXITCODE
