#Requires -Version 5.1
<#
  Windows setup for the Hashdesk browser miner.

  Mirrors setup.sh: installs Node, pnpm and Chrome when they are missing, then
  installs dependencies and builds the app. Run start-windows.bat afterwards.

  Usage:
    powershell -ExecutionPolicy Bypass -File setup.ps1
    powershell -ExecutionPolicy Bypass -File setup.ps1 -Clean
#>
[CmdletBinding()]
param(
  [switch]$Clean,
  [switch]$SkipChrome
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Say { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Warn { param([string]$Message) Write-Host "[!] $Message" -ForegroundColor Yellow }
function Die {
  param([string]$Message)
  Write-Host "[x] $Message" -ForegroundColor Red
  exit 1
}

function Test-Command {
  param([string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# winget and the Node installer both edit PATH outside this process, so the
# session copy has to be rebuilt from the registry before anything is found.
function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Add-UserPath {
  param([string]$Directory)
  if (-not (Test-Path -LiteralPath $Directory)) { return }
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($user -notlike "*$Directory*") {
    [Environment]::SetEnvironmentVariable('Path', "$Directory;$user", 'User')
  }
  if ($env:Path -notlike "*$Directory*") { $env:Path = "$Directory;$env:Path" }
}

# --- node -------------------------------------------------------------------

function Get-NodeMajor {
  if (-not (Test-Command 'node')) { return 0 }
  try {
    $major = & node -p "process.versions.node.split('.')[0]" 2>$null
    return [int]$major
  } catch {
    return 0
  }
}

function Test-NodeReady {
  if ((Get-NodeMajor) -lt 20) { return $false }
  if (-not (Test-Command 'npm')) { return $false }
  & npm --version *> $null
  return ($LASTEXITCODE -eq 0)
}

function Install-Node {
  $version = if ($env:NODE_VERSION) { $env:NODE_VERSION } else { '22.11.0' }

  if (Test-Command 'winget') {
    Say "installing Node LTS with winget"
    & winget install --id OpenJS.NodeJS.LTS -e --silent `
      --accept-source-agreements --accept-package-agreements
    Update-SessionPath
    if (Test-NodeReady) { return }
    Warn "winget did not produce a usable node, falling back to the zip"
  }

  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $url = "https://nodejs.org/dist/v$version/node-v$version-win-$arch.zip"
  $dest = Join-Path $env:LOCALAPPDATA 'node'
  $temp = [IO.Path]::GetTempPath()
  $zip = Join-Path $temp "node-v$version-win-$arch.zip"
  $unpacked = Join-Path $temp "node-v$version-win-$arch"

  Say "downloading Node $version ($arch)"
  try {
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  } catch {
    Die "could not download $url. Set NODE_VERSION to a version that exists."
  }

  if (Test-Path -LiteralPath $unpacked) { Remove-Item -LiteralPath $unpacked -Recurse -Force }
  Expand-Archive -LiteralPath $zip -DestinationPath $temp -Force
  if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
  Move-Item -LiteralPath $unpacked -Destination $dest
  Remove-Item -LiteralPath $zip -Force

  Add-UserPath $dest
  Say "node $(& node --version), npm $(& npm --version)"
}

if (Test-NodeReady) {
  Say "node $(& node --version), npm $(& npm --version)"
} else {
  if (Test-Command 'node') {
    Warn "node $(& node --version) is incomplete or too old, installing a full copy"
  } else {
    Warn "node not found, installing it"
  }
  Install-Node
  if (-not (Test-NodeReady)) { Die "Node install did not produce a working npm." }
}

# --- pnpm -------------------------------------------------------------------

function Get-PnpmVersion {
  try {
    $pkg = Get-Content -Raw -LiteralPath 'package.json' | ConvertFrom-Json
    if ($pkg.packageManager -match '^pnpm@(.+)$') { return $Matches[1] }
  } catch {
    # Fall through to the pin below.
  }
  return '12.3.4'
}

$PnpmVersion = Get-PnpmVersion
$PnpmCommand = $null

if (Test-Command 'pnpm') {
  & pnpm --version *> $null
  if ($LASTEXITCODE -eq 0) { $PnpmCommand = 'pnpm' }
}

if (-not $PnpmCommand) {
  Say "installing pnpm@$PnpmVersion with npm"
  # --force: a corepack shim may already sit at the same path.
  & npm install -g --force "pnpm@$PnpmVersion" *> $null
  Add-UserPath (Join-Path $env:APPDATA 'npm')
  Update-SessionPath
  if (Test-Command 'pnpm') {
    & pnpm --version *> $null
    if ($LASTEXITCODE -eq 0) { $PnpmCommand = 'pnpm' }
  }
}

if (-not $PnpmCommand) {
  Warn "pnpm unavailable, running it through npx"
}

function Invoke-Pnpm {
  param([string[]]$Arguments)
  if ($PnpmCommand) {
    & $PnpmCommand @Arguments
  } else {
    & npx --yes "pnpm@$PnpmVersion" @Arguments
  }
}

# --- chrome -----------------------------------------------------------------

function Find-Chrome {
  $candidates = @($env:CHROME_BIN)
  foreach ($root in @($env:LOCALAPPDATA, $env:PROGRAMFILES, ${env:ProgramFiles(x86)})) {
    if (-not $root) { continue }
    $candidates += Join-Path $root 'Google\Chrome\Application\chrome.exe'
    $candidates += Join-Path $root 'Chromium\Application\chrome.exe'
    $candidates += Join-Path $root 'Microsoft\Edge\Application\msedge.exe'
  }
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  return $null
}

if ($SkipChrome) {
  Say "skipping the Chrome check"
} else {
  $chrome = Find-Chrome
  if ($chrome) {
    Say "chrome ok: $chrome"
  } elseif (Test-Command 'winget') {
    Say "chrome not found, installing it with winget"
    & winget install --id Google.Chrome -e --silent `
      --accept-source-agreements --accept-package-agreements
    Update-SessionPath
    $chrome = Find-Chrome
    if ($chrome) { Say "chrome ok: $chrome" } else { Warn "chrome still not found, install it by hand" }
  } else {
    Warn "chrome not found and winget is unavailable"
    Warn "install Chrome from https://www.google.com/chrome/ and rerun this script"
  }
}

# --- build ------------------------------------------------------------------

if ($Clean) {
  Say "clean: removing node_modules, .next and logs"
  foreach ($path in @('node_modules', '.next')) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
  }
  foreach ($log in @('server.log', 'mine-tui.log', 'mine-chrome.log', 'mine-schedule.log')) {
    if (Test-Path -LiteralPath $log) { Remove-Item -LiteralPath $log -Force }
  }
}

Say "installing dependencies"
Invoke-Pnpm @('install', '--frozen-lockfile')
if ($LASTEXITCODE -ne 0) {
  Warn "frozen install failed, retrying without the lockfile check"
  Invoke-Pnpm @('install')
  if ($LASTEXITCODE -ne 0) { Die "dependency install failed." }
}

Say "building"
Invoke-Pnpm @('run', 'build')
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath '.next\BUILD_ID')) {
  Warn "build incomplete, retrying once"
  Invoke-Pnpm @('run', 'build')
}
if (-not (Test-Path -LiteralPath '.next\BUILD_ID')) {
  Die "build failed, no .next\BUILD_ID. Run 'pnpm run build' to see the error."
}

Say "setup complete"
Write-Host ""
Write-Host "  Start the miner:  start-windows.bat" -ForegroundColor Green
Write-Host "  Or directly:      node scripts\mine-tui.mjs --serve" -ForegroundColor Gray
Write-Host ""
