#Requires -Version 5.1
<#
  Installs the Hashdesk browser miner on Windows without git.

  Downloads the repository as a zip, unpacks it to %USERPROFILE%\hashdesk-miner,
  then runs setup.ps1 and starts the miner.

  One-liner (no download needed):
    irm https://raw.githubusercontent.com/phantrongkien12/hashdesk-miner/main/install-windows.ps1 | iex

  Or save this file and run:
    powershell -ExecutionPolicy Bypass -File install-windows.ps1
    powershell -ExecutionPolicy Bypass -File install-windows.ps1 -NoRun
#>
[CmdletBinding()]
param(
  [switch]$NoRun,
  [string]$Destination = (Join-Path $env:USERPROFILE 'hashdesk-miner')
)

$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 still defaults to TLS 1.0 on older builds, which
# GitHub rejects outright.
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch {
  # Newer runtimes ignore this and negotiate on their own.
}

function Say { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Warn { param([string]$Message) Write-Host "[!] $Message" -ForegroundColor Yellow }

$repoZip = 'https://github.com/phantrongkien12/hashdesk-miner/archive/refs/heads/main.zip'
$work = Join-Path ([IO.Path]::GetTempPath()) ("hashdesk-" + [guid]::NewGuid().ToString('N'))
$zip = Join-Path $work 'repo.zip'

try {
  New-Item -ItemType Directory -Force -Path $work | Out-Null

  Say "downloading the repository"
  try {
    Invoke-WebRequest -Uri $repoZip -OutFile $zip -UseBasicParsing
  } catch {
    throw "could not download $repoZip - check the network or proxy. $($_.Exception.Message)"
  }

  Say "unpacking"
  Expand-Archive -LiteralPath $zip -DestinationPath $work -Force
  $source = Join-Path $work 'hashdesk-miner-main'
  if (-not (Test-Path -LiteralPath $source)) {
    throw "unexpected archive layout, no hashdesk-miner-main folder inside the zip"
  }

  if (Test-Path -LiteralPath $Destination) {
    # Copying over the top keeps node_modules and .next, so an update does not
    # force a full reinstall. robocopy is used because Copy-Item -Recurse
    # flattens nested folders in Windows PowerShell 5.1.
    Say "updating the existing copy at $Destination"
    & robocopy $source $Destination /E /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed with code $LASTEXITCODE" }
  } else {
    Say "installing to $Destination"
    Move-Item -LiteralPath $source -Destination $Destination
  }
} catch {
  Write-Host "[x] $($_.Exception.Message)" -ForegroundColor Red
  return
} finally {
  if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
}

Set-Location -LiteralPath $Destination

Say "running setup"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Destination 'setup.ps1')
if ($LASTEXITCODE -ne 0) {
  Write-Host "[x] setup failed, read the message above" -ForegroundColor Red
  return
}

if ($NoRun) {
  Write-Host ""
  Write-Host "  Start the miner:  $Destination\start-windows.bat" -ForegroundColor Green
  Write-Host ""
  return
}

# setup.ps1 installs Node into %LOCALAPPDATA%\node and pnpm into %APPDATA%\npm,
# but this session keeps the PATH it started with.
$env:Path = "$env:LOCALAPPDATA\node;$env:APPDATA\npm;$env:Path"

Say "starting the miner"
& node (Join-Path $Destination 'scripts\mine-tui.mjs') --serve
