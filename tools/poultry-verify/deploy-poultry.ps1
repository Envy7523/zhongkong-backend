# 菜品核算功能上线（云端 134.175.41.247）
# 只上传本功能相关文件 + 重建后的前端产物；不上传 config.json（云端凭据）与 database.sqlite（云端业务数据）
#
# ⚠️ 上云必须逐次获得用户明确同意，不要自行执行（项目已有过一次未授权部署的教训）
# ⚠️ 执行前先构建前端：cd frontend; npm run build
# ⚠️ server-access/（SSH 私钥）不在 git 里，换机器需从旧机器拷贝
$ErrorActionPreference = 'Continue'
# 项目根目录按脚本位置推导，换机器/换路径无需改脚本
$LOCAL = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$key = Join-Path $LOCAL 'server-access\zhongkong_company'
if (-not (Test-Path $key)) { throw "找不到 SSH 私钥：$key" }
$hostS = 'ubuntu@134.175.41.247'
$APP = '/home/ubuntu/app'
$ts = Get-Date -Format yyyyMMddHHmmss
$log = @()
function Say($m) { $script:log += $m; Write-Output $m }
function Run($cmd) { $r = & ssh -i $key -o StrictHostKeyChecking=no $hostS $cmd 2>&1; $r | ForEach-Object { Say ('   ' + $_) }; return $LASTEXITCODE }

Say ("===== 部署开始 $ts =====")

Say '== 1/7 云端备份（代码 + 数据库） =='
Run "cd $APP && cp server.js server.js.bak-$ts && cp lib/db.js lib/db.js.bak-$ts && cp lib/business-analytics.js lib/business-analytics.js.bak-$ts && cp PROJECT_CHANGES.md PROJECT_CHANGES.md.bak-$ts && cp data/database.sqlite data/database.sqlite.bak-cloud-$ts && ls -la *.bak-$ts lib/*.bak-$ts | head -10"

Say '== 2/7 停服 =='
Run "sudo systemctl stop zhongkong && echo STOPPED"

Say '== 3/7 上传后端 =='
scp -q -i $key "$LOCAL\server.js" "${hostS}:$APP/server.js"; Say ("   server.js exit=$LASTEXITCODE")
scp -q -i $key "$LOCAL\lib\db.js" "${hostS}:$APP/lib/db.js"; Say ("   lib/db.js exit=$LASTEXITCODE")
scp -q -i $key "$LOCAL\lib\poultry-accounting.js" "${hostS}:$APP/lib/poultry-accounting.js"; Say ("   lib/poultry-accounting.js (新增) exit=$LASTEXITCODE")
scp -q -i $key "$LOCAL\lib\business-analytics.js" "${hostS}:$APP/lib/business-analytics.js"; Say ("   lib/business-analytics.js exit=$LASTEXITCODE")
scp -q -i $key "$LOCAL\PROJECT_CHANGES.md" "${hostS}:$APP/PROJECT_CHANGES.md"; Say ("   PROJECT_CHANGES.md exit=$LASTEXITCODE")

Say '== 4/7 上传前端（先清旧 dist，避免残留旧哈希分包） =='
Run "cd $APP/frontend && rm -rf dist && echo DIST_CLEARED"
scp -q -r -i $key "$LOCAL\frontend\dist" "${hostS}:$APP/frontend/"; Say ("   dist exit=$LASTEXITCODE")
scp -q -r -i $key "$LOCAL\frontend\src" "${hostS}:$APP/frontend/"; Say ("   src exit=$LASTEXITCODE")

Say '== 5/7 启动服务 =='
Run "sudo systemctl start zhongkong && sleep 6 && systemctl is-active zhongkong"
Run "curl -s -o /dev/null -w 'api_http=%{http_code}\n' http://127.0.0.1:3456/api/config"
Run "curl -s -o /dev/null -w 'page_http=%{http_code}\n' http://127.0.0.1:3456/menu-management/accounting"

Say '== 6/7 校验产物与源码 =='
Run "cd $APP && ls -la lib/poultry-accounting.js && echo '--- dist 是否引用新分包 ---' && grep -o 'MenuAccounting-[A-Za-z0-9_-]*\.js' frontend/dist/index.html | head -3 && echo '--- src 是否到位 ---' && ls -la frontend/src/views/menu/MenuAccounting.vue && ls frontend/src | cat"

Say '== 7/7 校验数据库新表（只读） =='
$checkScript = Join-Path $PSScriptRoot 'check-cloud-tables.js'
if (Test-Path $checkScript) {
  scp -q -i $key $checkScript "${hostS}:$APP/_check_table.js"
  Run "cd $APP && node _check_table.js; rm -f _check_table.js"
} else {
  Say ('   跳过：缺少 ' + $checkScript)
}

Say '== 收尾：服务状态与服务端日志尾部 =='
Run "systemctl is-active zhongkong; sudo journalctl -u zhongkong -n 12 --no-pager | tail -12"

Say '===== 部署结束 ====='
$log -join "`n" | Out-File -FilePath (Join-Path $LOCAL '_deploy_poultry_log.txt') -Encoding utf8
