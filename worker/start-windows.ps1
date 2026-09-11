$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'Gantang Mail Carrier'
Add-Type -AssemblyName System.Security
$configRoot = Join-Path $env:LOCALAPPDATA 'AllAboutBookGantang'
$configPath = Join-Path $configRoot 'worker-config.json'
if (-not (Test-Path -LiteralPath $configPath)) {
  throw 'The mail carrier is not configured. Run configure-windows.ps1 first.'
}

$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$desktopCodexRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
$desktopCodex = if (Test-Path -LiteralPath $desktopCodexRoot) {
  Get-ChildItem -LiteralPath $desktopCodexRoot -Filter 'codex.exe' -File -Recurse |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
}
$configuredCodex = if ($config.codexExe -and (Test-Path -LiteralPath $config.codexExe)) {
  Get-Item -LiteralPath $config.codexExe
}
$pathCodex = Get-Command codex.exe -ErrorAction SilentlyContinue
$codexExe = @(
  if ($desktopCodex) { $desktopCodex.FullName }
  if ($configuredCodex) { $configuredCodex.FullName }
  if ($pathCodex) { $pathCodex.Source }
) |
  Where-Object { $_ } |
  Select-Object -First 1
if (-not $codexExe) {
  throw 'The native Codex executable was not found.'
}
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
  $env:CODEX_EXE = $codexExe
  node (Join-Path $PSScriptRoot 'gantang-worker.mjs')
} finally {
  [Array]::Clear($plainBytes, 0, $plainBytes.Length)
  [Array]::Clear($protectedBytes, 0, $protectedBytes.Length)
  Remove-Item Env:GANTANG_SUPABASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:GANTANG_SUPABASE_SERVICE_ROLE_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:GANTANG_CODEX_THREAD_ID -ErrorAction SilentlyContinue
  Remove-Item Env:GANTANG_CODEX_CWD -ErrorAction SilentlyContinue
  Remove-Item Env:GANTANG_BRIDGE_ENTRY -ErrorAction SilentlyContinue
  Remove-Item Env:CODEX_EXE -ErrorAction SilentlyContinue
  $plainKey = $null
}
