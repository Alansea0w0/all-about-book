param(
  [string]$ProjectUrl = 'https://acigficxrwlsgofrhqmk.supabase.co',
  [string]$CodexCwd = 'D:\Alansea\kindle',
  [string]$AppServerUrl = 'ws://127.0.0.1:8766'
)

$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'Gantang Mail Carrier Setup'
Add-Type -AssemblyName System.Security
if ($AppServerUrl -ne 'ws://127.0.0.1:8766') {
  throw 'Only the dedicated loopback app-server URL ws://127.0.0.1:8766 is allowed.'
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
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
$plainBytes = $null
$protectedBytes = $null
try {
  $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  $plainBytes = [Text.Encoding]::UTF8.GetBytes($plainKey)
  $protectedBytes = [Security.Cryptography.ProtectedData]::Protect(
    $plainBytes,
    $null,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  [IO.File]::WriteAllBytes($secretPath, $protectedBytes)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  if ($plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
  if ($protectedBytes) { [Array]::Clear($protectedBytes, 0, $protectedBytes.Length) }
  $plainKey = $null
  $secureKey = $null
}

$config = [ordered]@{
  version = 2
  projectUrl = $ProjectUrl
  threadId = $null
  readyThreadId = $null
  observerReadyThreadId = $null
  codexCwd = $CodexCwd
  appServerUrl = $AppServerUrl
  secretPath = $secretPath
}
[IO.File]::WriteAllText(
  $configPath,
  ($config | ConvertTo-Json),
  [Text.UTF8Encoding]::new($false)
)
Write-Host ''
Write-Host 'Setup complete. The key is encrypted for this Windows account.'
Write-Host 'The dedicated co-reading task will be created on the first start.'
Write-Host "Configuration: $configPath"
