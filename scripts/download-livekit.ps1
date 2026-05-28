param(
    [switch] $Force
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$installDir = Join-Path $root ".bin\livekit"
$exePath = Join-Path $installDir "livekit-server.exe"

if ((Test-Path $exePath) -and -not $Force) {
    Write-Host "LiveKit Server is already installed at $exePath"
    Write-Host "Use -Force to download it again."
    exit 0
}

New-Item -ItemType Directory -Force -Path $installDir | Out-Null

$releaseUrl = "https://api.github.com/repos/livekit/livekit/releases/latest"
Write-Host "Fetching latest LiveKit release..."
$release = Invoke-RestMethod -Uri $releaseUrl -Headers @{ "User-Agent" = "MipaVoice" }
$asset = $release.assets |
    Where-Object { $_.name -match "windows_amd64\.zip$" } |
    Select-Object -First 1

if (-not $asset) {
    throw "Could not find a Windows amd64 LiveKit Server release asset."
}

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("mipavoice-livekit-" + [System.Guid]::NewGuid())
$zipPath = Join-Path $tempDir $asset.name
$extractDir = Join-Path $tempDir "extract"

New-Item -ItemType Directory -Force -Path $tempDir, $extractDir | Out-Null

try {
    Write-Host "Downloading $($asset.name)..."
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath

    Write-Host "Extracting LiveKit Server..."
    Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

    $downloadedExe = Get-ChildItem -Path $extractDir -Recurse -Filter "livekit-server.exe" |
        Select-Object -First 1

    if (-not $downloadedExe) {
        throw "Downloaded archive did not contain livekit-server.exe."
    }

    Copy-Item -Path $downloadedExe.FullName -Destination $exePath -Force
    Write-Host "LiveKit Server installed at $exePath"
}
finally {
    if (Test-Path $tempDir) {
        Remove-Item -LiteralPath $tempDir -Recurse -Force
    }
}

