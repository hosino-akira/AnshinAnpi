[CmdletBinding()]
param()
$logPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'backend\logs\api-requests.jsonl'
if (-not (Test-Path -LiteralPath $logPath)) {
    Write-Host 'No request log yet. Enable API_DEBUG_LOG_ENABLED=true, restart the API and make a request.'
    return
}
Get-Content -LiteralPath $logPath -Encoding UTF8 -Tail 10 -Wait | ForEach-Object {
    try { $_ | ConvertFrom-Json | ConvertTo-Json -Depth 30 } catch { Write-Output $_ }
}
