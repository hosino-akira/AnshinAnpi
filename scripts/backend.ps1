[CmdletBinding()]
param([ValidateSet('setup','start','status')][string]$Action='start')
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
function Test-Exit { if ($LASTEXITCODE -ne 0) { throw "コマンドが失敗しました（終了コード $LASTEXITCODE）。" } }
function Initialize-BackendEnvironment {
    $envPath=Join-Path $projectRoot '.env'
    if (-not (Test-Path -LiteralPath $envPath)) { Copy-Item -LiteralPath (Join-Path $projectRoot '.env.example') -Destination $envPath }
    $contents=Get-Content -LiteralPath $envPath -Raw -Encoding UTF8
    foreach ($key in @('DATA_ENCRYPTION_KEY','TEMPORARY_ENCRYPTION_KEY','AUDIT_HMAC_KEY')) {
        $match=[regex]::Match($contents, "(?m)^$key=(.*)$")
        if ($match.Success -and $match.Groups[1].Value.Trim().Length -gt 0) { continue }
        $bytes=New-Object byte[] 32
        $rng=[System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        $line="$key=$([Convert]::ToBase64String($bytes))"
        if ($match.Success) { $contents=[regex]::Replace($contents, "(?m)^$key=.*$", $line) }
        else { $contents=$contents.TrimEnd()+"`n$line`n" }
    }
    [System.IO.File]::WriteAllText($envPath, $contents, [System.Text.UTF8Encoding]::new($false))
    Write-Host 'ローカル API の秘密キーを Git 管理外の .env に設定しました。'
}
function Get-LocalComposeArguments {
    $arguments=@('--project-directory', $projectRoot, '-f', (Join-Path $projectRoot 'compose.yaml'))
    $contents=Get-Content -LiteralPath (Join-Path $projectRoot '.env') -Raw -Encoding UTF8
    $profile=[regex]::Match($contents, '(?m)^AWS_PROFILE[ \t]*=([^\r\n]*)').Groups[1].Value.Trim().Trim([char[]]@('"', "'"))
    if ($profile -and -not $profile.StartsWith('#')) {
        foreach ($relativePath in @('.aws/config', '.aws/login/cache')) {
            if (-not (Test-Path -LiteralPath (Join-Path $env:USERPROFILE $relativePath))) {
                throw 'AWS_PROFILE が設定されていますが、ローカルの AWS ログイン設定またはキャッシュがありません。API 起動前に AWS CLI で認証してください。'
            }
        }
        $arguments+=@('-f', (Join-Path $projectRoot 'compose.aws-local.yaml'))
        Write-Host 'ローカルの AWS ログイン設定と更新可能な認証キャッシュを使用します。'
    }
    return $arguments
}
switch ($Action) {
    'setup' { Initialize-BackendEnvironment }
    'start' {
        Initialize-BackendEnvironment
        $composeArguments=Get-LocalComposeArguments
        & docker compose @composeArguments up -d --wait postgres; Test-Exit
        & (Join-Path $PSScriptRoot 'database.ps1') -Action migrate
        & docker compose @composeArguments up -d --build --wait api; Test-Exit
    }
    'status' { & docker compose --project-directory $projectRoot ps; Test-Exit }
}
