[CmdletBinding()]
param([ValidateSet('setup','start','status','test')][string]$Action='start')
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
function Test-Exit { if ($LASTEXITCODE -ne 0) { throw "Command failed (exit $LASTEXITCODE)." } }
function Initialize-BackendEnvironment {
    $envPath=Join-Path $projectRoot '.env'
    if (-not (Test-Path -LiteralPath $envPath)) { Copy-Item -LiteralPath (Join-Path $projectRoot '.env.example') -Destination $envPath }
    $contents=Get-Content -LiteralPath $envPath -Raw -Encoding UTF8
    foreach ($key in @('REDIS_PASSWORD','DATA_ENCRYPTION_KEY','TEMPORARY_ENCRYPTION_KEY','LOOKUP_HMAC_KEY','AUDIT_HMAC_KEY')) {
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
    Write-Host 'Local backend secrets are configured in the ignored .env file.'
}
switch ($Action) {
    'setup' { Initialize-BackendEnvironment }
    'start' {
        Initialize-BackendEnvironment
        & docker compose --project-directory $projectRoot up -d --wait postgres redis; Test-Exit
        & (Join-Path $PSScriptRoot 'database.ps1') -Action migrate
        & docker compose --project-directory $projectRoot up -d --build --wait api; Test-Exit
    }
    'status' { & docker compose --project-directory $projectRoot ps; Test-Exit }
    'test' { Push-Location (Join-Path $projectRoot 'backend'); try { & npm test; Test-Exit } finally { Pop-Location } }
}
