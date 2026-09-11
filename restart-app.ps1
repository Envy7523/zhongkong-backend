# 安全重启 NewDeom 前后端：只按端口(3456/5173)定位 PID，绝不触碰其它 node 进程（含 DSH web）
$ErrorActionPreference = 'Continue'

function Restart-PortService {
  param([int]$Port, [string]$File, [string[]]$ArgList, [string]$WorkDir, [string]$LogBase)
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) {
    Write-Output ("stop port {0} (pid {1})" -f $Port, $conn.OwningProcess)
    taskkill /PID $conn.OwningProcess /F /T 2>&1 | Out-Null
    Start-Sleep -Milliseconds 800
  } else {
    Write-Output ("port {0} was not listening" -f $Port)
  }
  Start-Process -FilePath $File -ArgumentList $ArgList -WorkingDirectory $WorkDir -WindowStyle Hidden -RedirectStandardOutput ($LogBase + '.log') -RedirectStandardError ($LogBase + '.err.log')
  Write-Output ("started port {0}" -f $Port)
}

Restart-PortService -Port 3456 -File 'node' -ArgList @('server.js') -WorkDir 'F:\NewDeom' -LogBase 'F:\NewDeom\server-3456'
Restart-PortService -Port 5173 -File 'cmd.exe' -ArgList @('/c','npm run dev') -WorkDir 'F:\NewDeom\frontend' -LogBase 'F:\NewDeom\vite-5173'

foreach ($p in 3456, 5173) {
  $n = 0
  do { Start-Sleep -Milliseconds 800; $n++ } until ((Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) -or $n -gt 45)
  Write-Output ("port {0} up = {1}" -f $p, [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue))
}