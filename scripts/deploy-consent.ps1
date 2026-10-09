[CmdletBinding()]
param([string]$IdentityFile)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseTag = '20261008-consent-v3'
$releaseDirectory = Join-Path $projectRoot "deploy/releases/$releaseTag"
$archive = Join-Path $projectRoot "deploy/releases/anshin-vps-$releaseTag.tar.gz"
$checksum = "$archive.sha256"
$sshOptions = @()
if ($IdentityFile) {
    $resolvedKey = (Resolve-Path -LiteralPath $IdentityFile).Path
    $sshOptions = @('-i', $resolvedKey)
}
if (!(Test-Path -LiteralPath $archive) -or !(Test-Path -LiteralPath $checksum)) {
    throw 'Build the release with scripts/package-vps.ps1 first.'
}
$expectedHash = ((Get-Content -LiteralPath $checksum -Raw).Trim() -split '\s+')[0]
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
    throw 'Release checksum verification failed.'
}
Write-Host 'Upload the release; SSH may request your server password.'
& scp @sshOptions $archive $checksum 'debian@133.167.82.242:/home/debian/anshin-anpi/releases/'
if ($LASTEXITCODE -ne 0) { throw 'Upload failed; the server was not updated.' }
$remoteCommand = "set -eu; cd /home/debian/anshin-anpi/releases; sha256sum -c anshin-vps-$releaseTag.tar.gz.sha256; mkdir -p $releaseTag; tar -xzf anshin-vps-$releaseTag.tar.gz -C $releaseTag; bash $releaseTag/deploy/vps/update-consent.sh"
Write-Host 'Deploy API, admin UI, and current policies; sudo may request your server password.'
& ssh -t @sshOptions 'debian@133.167.82.242' $remoteCommand
if ($LASTEXITCODE -ne 0) { throw 'Deployment did not finish successfully; inspect the server output.' }
Write-Host 'Code and current consent policies synchronized.'
