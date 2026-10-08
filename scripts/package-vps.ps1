[CmdletBinding()]
param(
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$')]
    [string]$Tag = (Get-Date -Format 'yyyyMMdd-HHmmss')
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseDirectory = Join-Path $projectRoot "deploy/releases/$Tag"
if (Test-Path -LiteralPath $releaseDirectory) { throw "Release already exists: $releaseDirectory" }

function Test-CommandExit {
    if ($LASTEXITCODE -ne 0) { throw "Packaging command failed (exit $LASTEXITCODE)." }
}

Push-Location $projectRoot
try {
    $apiImage = "anshin-anpi-api:$Tag"
    $adminImage = "anshin-anpi-admin:$Tag"
    & docker build --platform linux/amd64 -f backend/Dockerfile -t $apiImage .
    Test-CommandExit
    & docker build --platform linux/amd64 -f anshin-anpi-admin-source/Dockerfile -t $adminImage .
    Test-CommandExit

    New-Item -ItemType Directory -Path "$releaseDirectory/deploy/vps", "$releaseDirectory/database" -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $projectRoot 'compose.production.yaml') -Destination $releaseDirectory
    Copy-Item -LiteralPath (Join-Path $projectRoot 'deploy/vps/env.example'), (Join-Path $projectRoot 'deploy/vps/anshin.info.conf') -Destination "$releaseDirectory/deploy/vps"
    Copy-Item -LiteralPath (Join-Path $projectRoot 'database/migrations') -Destination "$releaseDirectory/database" -Recurse
    & docker image save --output "$releaseDirectory/images.tar" $apiImage $adminImage
    Test-CommandExit
    Set-Content -LiteralPath "$releaseDirectory/release-tag.txt" -Value $Tag -Encoding ascii

    $archive = Join-Path $projectRoot "deploy/releases/anshin-vps-$Tag.tar.gz"
    & tar -czf $archive -C $releaseDirectory compose.production.yaml deploy database images.tar release-tag.txt
    Test-CommandExit
    $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath "$archive.sha256" -Value "$hash  $([System.IO.Path]::GetFileName($archive))" -Encoding ascii
    Write-Host "Release tag: $Tag"
    Write-Host "Deployment archive: $archive"
    Write-Host 'The archive contains images, migrations, and configuration templates; fill the private production environment separately.'
}
finally { Pop-Location }
