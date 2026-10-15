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
    throw '先に scripts/package-vps.ps1 で配布パッケージを作成してください。'
}
$expectedHash = ((Get-Content -LiteralPath $checksum -Raw).Trim() -split '\s+')[0]
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
    throw '配布パッケージのチェックサム検証に失敗しました。'
}
Write-Host '配布パッケージを転送します。SSH がサーバーのパスワードを求める場合があります。'
& scp @sshOptions $archive $checksum 'debian@133.167.82.242:/home/debian/anshin-anpi/releases/'
if ($LASTEXITCODE -ne 0) { throw '転送に失敗しました。サーバーは更新していません。' }
$remoteCommand = "set -eu; cd /home/debian/anshin-anpi/releases; sha256sum -c anshin-vps-$releaseTag.tar.gz.sha256; mkdir -p $releaseTag; tar -xzf anshin-vps-$releaseTag.tar.gz -C $releaseTag; bash $releaseTag/deploy/vps/update-consent.sh"
Write-Host 'API、管理画面、現在の同意文面を更新します。sudo がパスワードを求める場合があります。'
& ssh -t @sshOptions 'debian@133.167.82.242' $remoteCommand
if ($LASTEXITCODE -ne 0) { throw '更新処理が正常に完了しませんでした。サーバーの出力を確認してください。' }
Write-Host 'アプリと現在の同意文面を同期しました。'
