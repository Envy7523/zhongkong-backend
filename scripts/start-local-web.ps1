$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimePath = Join-Path $projectRoot '.local-web'
foreach ($port in @(3456, 5173)) {
    if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
        throw "Port $port is occupied. Stop the existing local service first."
    }
}
New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null
# Never load the project's production credentials in this local web environment.
$env:ZHONGKONG_CONFIG_PATH = Join-Path $runtimePath 'config.json'
if (Test-Path -LiteralPath $env:ZHONGKONG_CONFIG_PATH) {
    throw 'Local configuration exists. Review/remove its credentials before starting this safe environment.'
}
$env:ZHONGKONG_DB_PATH = Join-Path $runtimePath 'database.sqlite'
$env:ZHONGKONG_HOST = '127.0.0.1'
$env:PORT = '3456'
$env:DISABLE_WECOM_BOT = '1'
$env:ATTENDANCE_AUTO_SYNC = '0'
$nodePath = (Get-Command node.exe).Source
$backend = Start-Process -FilePath $nodePath -ArgumentList 'server.js' -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimePath 'backend.log') -RedirectStandardError (Join-Path $runtimePath 'backend-error.log')
$frontend = Start-Process -FilePath $nodePath -ArgumentList 'node_modules/vite/bin/vite.js' -WorkingDirectory (Join-Path $projectRoot 'frontend') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimePath 'frontend.log') -RedirectStandardError (Join-Path $runtimePath 'frontend-error.log')
Write-Output "Backend PID: $($backend.Id); Frontend PID: $($frontend.Id)"
Write-Output 'Web: http://127.0.0.1:5173 ; API: http://127.0.0.1:3456'
