param(
  [string]$ThreadId = '01a08fd9-145a-7882-8ce4-64280bd67c67',
  [string]$ProjectUrl = 'https://acigficxrwlsgofrhqmk.supabase.co',
  [string]$CodexCwd = 'D:\Alansea\kindle'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$downloadsRoot = Split-Path -Parent $repoRoot
$bridgeEntry = Join-Path $downloadsRoot 'Local-Codex-Bridge\dist\src\index.js'
if (-not (Test-Path -LiteralPath $bridgeEntry)) {
  throw "Local Codex Bridge was not found: $bridgeEntry"
}

$configRoot = Join-Path $env:LOCALAPPDATA 'AllAboutBookGantang'
New-Item -ItemType Directory -Path $configRoot -Force | Out-Null
$secretPath = Join-Path $configRoot 'service-role.dpapi'
$configPath = Join-Path $configRoot 'worker-config.json'

Write-Host 'Paste the Supabase service_role key. It will not be displayed or written to the project or logs.'
$secureKey = Read-Host -AsSecureString
if ($secureKey.Length -lt 20) {
  throw 'No valid key was entered.'
}
$secureKey | ConvertFrom-SecureString | Set-Content -LiteralPath $secretPath -Encoding utf8

$config = [ordered]@{
  projectUrl = $ProjectUrl
  threadId = $ThreadId
  codexCwd = $CodexCwd
  bridgeEntry = $bridgeEntry
  secretPath = $secretPath
}
$config | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding utf8
Write-Host ''
Write-Host 'Setup complete. The key is encrypted for this Windows account.'
Write-Host "Configuration: $configPath"
