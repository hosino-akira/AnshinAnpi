$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$testDatabase='anshin_api_test_'+[Guid]::NewGuid().ToString('N')
$previousTestDatabase=$env:TEST_DATABASE_NAME
function Test-Exit { if ($LASTEXITCODE -ne 0) { throw "Command failed (exit $LASTEXITCODE)." } }
try {
    & (Join-Path $PSScriptRoot 'backend.ps1') -Action setup
    & docker compose --project-directory $projectRoot up -d --wait postgres; Test-Exit
    & docker compose --project-directory $projectRoot exec -T -e "TEST_DATABASE_NAME=$testDatabase" postgres sh -c 'createdb -U "$POSTGRES_USER" "$TEST_DATABASE_NAME"'; Test-Exit
    & (Join-Path $PSScriptRoot 'database.ps1') -Action migrate -Database $testDatabase
    $env:TEST_DATABASE_NAME=$testDatabase
    Push-Location (Join-Path $projectRoot 'backend')
    try { & npm run test:integration; Test-Exit } finally { Pop-Location }
}
finally {
    $env:TEST_DATABASE_NAME=$previousTestDatabase
    & docker compose --project-directory $projectRoot exec -T -e "TEST_DATABASE_NAME=$testDatabase" postgres sh -c 'dropdb --if-exists -U "$POSTGRES_USER" "$TEST_DATABASE_NAME"'
}
