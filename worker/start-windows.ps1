param(
  [switch]$NoObserver
)

$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'Gantang Realtime Mail Carrier'
Add-Type -AssemblyName System.Security

$configRoot = Join-Path $env:LOCALAPPDATA 'AllAboutBookGantang'
$configPath = Join-Path $configRoot 'worker-config.json'
if (-not (Test-Path -LiteralPath $configPath)) {
  throw 'The mail carrier is not configured. Run configure-windows.ps1 first.'
}

$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$appServerUrl = if ($config.appServerUrl) { $config.appServerUrl } else { 'ws://127.0.0.1:8766' }
if ($appServerUrl -ne 'ws://127.0.0.1:8766') {
  throw 'Only the dedicated loopback app-server URL ws://127.0.0.1:8766 is allowed.'
}
if ($config.PSObject.Properties.Name -contains 'readyThreadId') {
  $config.readyThreadId = $null
} else {
  $config | Add-Member -NotePropertyName readyThreadId -NotePropertyValue $null
}
if ($config.PSObject.Properties.Name -contains 'observerReadyThreadId') {
  $config.observerReadyThreadId = $null
} else {
  $config | Add-Member -NotePropertyName observerReadyThreadId -NotePropertyValue $null
}
[IO.File]::WriteAllText(
  $configPath,
  ($config | ConvertTo-Json),
  [Text.UTF8Encoding]::new($false)
)

$desktopCodexRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
$desktopCodex = if (Test-Path -LiteralPath $desktopCodexRoot) {
  Get-ChildItem -LiteralPath $desktopCodexRoot -Filter 'codex.exe' -File -Recurse |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
}
$pathCodex = Get-Command codex.exe -ErrorAction SilentlyContinue
$codexExe = @(
  if ($desktopCodex) { $desktopCodex.FullName }
  if ($pathCodex) { $pathCodex.Source }
) | Where-Object { $_ } | Select-Object -First 1
if (-not $codexExe) {
  throw 'The native Codex executable was not found.'
}

$readyUrl = 'http://127.0.0.1:8766/readyz'
try {
  $existing = Invoke-WebRequest -UseBasicParsing -Uri $readyUrl -TimeoutSec 2
  if ($existing.StatusCode -eq 200) {
    throw 'The dedicated Codex app-server is already running. Close the older carrier before starting another one.'
  }
} catch {
  if ($_.Exception.Message -like 'The dedicated Codex app-server is already running*') { throw }
}

$protectedBytes = [IO.File]::ReadAllBytes($config.secretPath)
$plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
  $protectedBytes,
  $null,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
$appServer = $null
$previousCodexHome = $env:CODEX_HOME

try {
  $env:CODEX_HOME = Join-Path $env:USERPROFILE '.codex'
  $appServer = Start-Process -FilePath $codexExe -ArgumentList @(
    'app-server', '--listen', $appServerUrl
  ) -WindowStyle Hidden -PassThru

  $ready = $false
  for ($attempt = 0; $attempt -lt 80; $attempt++) {
    if ($appServer.HasExited) { throw 'The dedicated Codex app-server exited during startup.' }
    try {
      $probe = Invoke-WebRequest -UseBasicParsing -Uri $readyUrl -TimeoutSec 2
      if ($probe.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 250
  }
  if (-not $ready) { throw 'The dedicated Codex app-server did not become ready.' }

  $env:GANTANG_APP_SERVER_URL = $appServerUrl
  $env:GANTANG_CODEX_CWD = $config.codexCwd

  if (-not $NoObserver) {
    Start-Process -FilePath 'powershell.exe' -ArgumentList @(
      '-NoExit', '-ExecutionPolicy', 'Bypass', '-File',
      (Join-Path $PSScriptRoot 'observe-windows.ps1')
    ) -WindowStyle Normal | Out-Null
  }

  $plainKey = [Text.Encoding]::UTF8.GetString($plainBytes)
  $env:GANTANG_SUPABASE_URL = $config.projectUrl
  $env:GANTANG_SUPABASE_SERVICE_ROLE_KEY = $plainKey
  $env:GANTANG_CODEX_THREAD_ID = $config.threadId
  $env:GANTANG_CONFIG_PATH = $configPath
  node (Join-Path $PSScriptRoot 'gantang-worker.mjs')
  if ($LASTEXITCODE -ne 0) {
    throw "The event mail carrier stopped with exit code $LASTEXITCODE."
  }
} finally {
  if ($appServer -and -not $appServer.HasExited) {
    Stop-Process -Id $appServer.Id -ErrorAction SilentlyContinue
    Wait-Process -Id $appServer.Id -Timeout 10 -ErrorAction SilentlyContinue
  }
  [Array]::Clear($plainBytes, 0, $plainBytes.Length)
  [Array]::Clear($protectedBytes, 0, $protectedBytes.Length)
  Remove-Item Env:GANTANG_SUPABASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:GANTANG_SUPABASE_SERVICE_ROLE_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:GANTANG_CODEX_THREAD_ID -ErrorAction SilentlyContinue
  Remove-Item Env:GANTANG_CODEX_CWD -ErrorAction SilentlyContinue
  Remove-Item Env:GANTANG_APP_SERVER_URL -ErrorAction SilentlyContinue
  Remove-Item Env:GANTANG_CONFIG_PATH -ErrorAction SilentlyContinue
  if ($null -eq $previousCodexHome) {
    Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue
  } else {
    $env:CODEX_HOME = $previousCodexHome
  }
  $plainKey = $null
}
