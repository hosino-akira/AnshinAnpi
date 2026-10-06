[CmdletBinding()]
param(
    [ValidateSet('migrate', 'status')]
    [string]$Action = 'migrate',
    [ValidatePattern('^[a-zA-Z_][a-zA-Z0-9_]*$')]
    [string]$Database
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
# psql input must remain UTF-8 in Windows PowerShell 5 as well as PowerShell 7.
$previousOutputEncoding = $OutputEncoding
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Invoke-DatabaseSql([string]$Sql) {
    $Sql | & docker compose --project-directory $projectRoot exec -T -e "TARGET_DATABASE=$Database" postgres sh -c 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "${TARGET_DATABASE:-$POSTGRES_DB}"'
    if ($LASTEXITCODE -ne 0) { throw "Database command failed (exit $LASTEXITCODE)." }
}

try {
    switch ($Action) {
        'migrate' {
            $migrationFiles = Get-ChildItem -LiteralPath (Join-Path $projectRoot 'database\migrations') -Filter '*.sql' | Sort-Object Name
            foreach ($migration in $migrationFiles) {
                Write-Host "Applying $($migration.Name)"
                Invoke-DatabaseSql (Get-Content -LiteralPath $migration.FullName -Raw -Encoding UTF8)
            }
        }
        'status' {
            Invoke-DatabaseSql @'
SELECT current_database() AS database, current_setting('TimeZone') AS timezone;
SELECT version, applied_at FROM app_meta.schema_migrations ORDER BY version;
SELECT relname AS table_name, n_live_tup AS estimated_rows
FROM pg_stat_user_tables WHERE schemaname = 'public' ORDER BY relname;
'@
        }
    }
}
finally {
    $OutputEncoding = $previousOutputEncoding
}
