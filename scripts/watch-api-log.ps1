[CmdletBinding()]
param()
$logPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'backend\logs\api-requests.jsonl'
if (-not (Test-Path -LiteralPath $logPath)) {
    Write-Host '要求ログはまだありません。API_DEBUG_LOG_ENABLED=true を設定し、API 再起動後に操作してください。'
    return
}
Get-Content -LiteralPath $logPath -Encoding UTF8 -Tail 10 -Wait | ForEach-Object {
    try { $_ | ConvertFrom-Json | ConvertTo-Json -Depth 30 } catch { Write-Output $_ }
}
