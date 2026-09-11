$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'Gantang Mail Carrier'
Add-Type -AssemblyName System.Security
$configRoot = Join-Path $env:LOCALAPPDATA 'AllAboutBookGantang'
$configPath = Join-Path $configRoot 'worker-config.json'
if (-not (Test-Path -LiteralPath $configPath)) {
  throw 'The mail carrier is not configured. Run configure-windows.ps1 first.'
}

$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$protectedBytes = [IO.File]::ReadAllBytes($config.secretPath)
$plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
  $protectedBytes,
  $null,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)

try {
  $plainKey = [Text.Encoding]::UTF8.GetString($plainBytes)
  $env:GANTANG_SUPABASE_URL = $config.projectUrl
  $env:GANTANG_SUPABASE_SERVICE_ROLE_KEY = $plainKey
  $env:GANTANG_CODEX_THREAD_ID = $config.threadId
  $env:GANTANG_CODEX_CWD = $config.codexCwd
  $env:GANTANG_BRIDGE_ENTRY = $config.bridgeEntry
  node (Join-Path $PSScriptRoot 'gantang-worker.mjs')
} finally {
  [Array]::Clear($plainBytes, 0, $plainBytes.Length)
  [Array]::Clear($protectedBytes, 0, $protectedBytes.Length)
  Remove-Item Env:GANTANG_SUPABASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:GANTANG_SUPABASE_SERVICE_ROLE_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:GANTANG_CODEX_THREAD_ID -ErrorAction SilentlyContinue
  Remove-Item Env:GANTANG_CODEX_CWD -ErrorAction SilentlyContinue
  Remove-Item Env:GANTANG_BRIDGE_ENTRY -ErrorAction SilentlyContinue
  $plainKey = $null
}
