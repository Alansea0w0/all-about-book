$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'Co-reading Gantang (Codex observer)'
$configPath = Join-Path $env:LOCALAPPDATA 'AllAboutBookGantang\worker-config.json'
if (-not (Test-Path -LiteralPath $configPath)) {
  throw 'The mail carrier is not configured.'
}
$config = $null
for ($attempt = 0; $attempt -lt 240; $attempt++) {
  $candidate = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (
    $candidate.version -eq 2 -and
    $candidate.threadId -and
    $candidate.readyThreadId -eq $candidate.threadId -and
    $candidate.observerReadyThreadId -eq $candidate.threadId
  ) {
    $config = $candidate
    break
  }
  if ($attempt -eq 0) {
    Write-Host 'Waiting for the first co-reading letter before opening the Codex observer...'
  }
  Start-Sleep -Milliseconds 500
}
if (-not $config) { throw 'The dedicated co-reading task was not ready within two minutes.' }

$desktopCodexRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
$codexExe = Get-ChildItem -LiteralPath $desktopCodexRoot -Filter 'codex.exe' -File -Recurse |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if (-not $codexExe) { throw 'The native Codex executable was not found.' }

$env:CODEX_HOME = Join-Path $env:USERPROFILE '.codex'
$env:TERM = 'xterm-256color'
& $codexExe.FullName resume $config.threadId `
  --remote $config.appServerUrl `
  --no-alt-screen
