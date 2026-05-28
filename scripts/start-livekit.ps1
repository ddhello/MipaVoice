param(
    [string] $HostAddress = "0.0.0.0"
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$exePath = Join-Path $root ".bin\livekit\livekit-server.exe"

if (-not (Test-Path $exePath)) {
    Write-Host "LiveKit Server is not installed yet."
    Write-Host "Run: pnpm livekit:download"
    exit 1
}

Write-Host "Starting LiveKit Server in development mode..."
Write-Host "URL: ws://127.0.0.1:7880"
Write-Host "API key: devkey"
Write-Host "API secret: secret"

& $exePath --dev --bind $HostAddress

