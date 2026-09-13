# 禽类菜范围（覆盖率分母口径）验证：关键词表 / 显式名单 / 双覆盖率口径 / 自清理与还原
# 说明：本机为 Windows PowerShell 5.1，脚本须以 UTF-8 显式读取后执行：
#   $VerifyDir = (Resolve-Path 'tools\poultry-verify').Path
#   $code = Get-Content -Raw -Encoding UTF8 (Join-Path $VerifyDir 'verify-poultry-scope.ps1'); Invoke-Expression $code
#
# 安全约定（本项目曾发生「验证脚本整表清空用户数据」事故，务必遵守）：
#   1) 关键词表是全局配置 —— 脚本先快照到 _tmp/scope-keywords-backup.json，收尾原样还原；
#      若上次异常中断留下备份，本次启动会先自动还原（自愈），测试词不会残留在生产配置里。
#   2) 只用自己的临时菜品验证「手动标记」，绝不改动任何真实菜品的判定配置。
#   3) 删除范围只限自己创建的行（名称前缀）。
$ErrorActionPreference = 'Stop'
if (-not $PSScriptRoot) {
  if (-not $VerifyDir) { throw '请先设置 $VerifyDir = 本脚本所在目录（如 (Resolve-Path tools\poultry-verify).Path）' }
} else { $VerifyDir = $PSScriptRoot }
$base = 'http://127.0.0.1:3456'
$tmpDir = Join-Path $VerifyDir '_tmp'
if (-not (Test-Path $tmpDir)) { New-Item -ItemType Directory -Path $tmpDir | Out-Null }
$backupFile = Join-Path $tmpDir 'scope-keywords-backup.json'

$SCRIPT_DISH_NAMES = @('验证临时菜-范围', '验证临时菜-范围鹅')
$SCRIPT_BIRD_NAMES = @('验证用鹅-范围临时')
$MARK = '自动化验证临时数据'

$login = Invoke-RestMethod -Uri "$base/api/auth/login" -Method Post -ContentType 'application/json' `
  -Body (@{ username = 'admin'; password = 'admin123' } | ConvertTo-Json) -TimeoutSec 60
$headers = @{ Authorization = "Bearer $($login.token)" }

function Api($method, $path, $body) {
  $req = @{ Uri = "$base$path"; Method = $method; Headers = $headers; TimeoutSec = 120 }
  if ($body) {
    # PS 5.1 的 Invoke-RestMethod 默认不按 UTF-8 编码请求体，中文会被写成 ?，必须显式给字节
    $json = $body | ConvertTo-Json -Depth 8
    $req.Body = [System.Text.Encoding]::UTF8.GetBytes($json)
    $req.ContentType = 'application/json; charset=utf-8'
  }
  return Invoke-RestMethod @req
}
function Check($label, $condition, $detail) {
  $mark = 'FAIL'
  if ($condition) { $mark = 'PASS' }
  Write-Output ("[{0}] {1} :: {2}" -f $mark, $label, $detail)
}
function Expect-400($label, $scriptBlock) {
  try { & $scriptBlock | Out-Null; Check $label $false '未被拦截' }
  catch { Check $label ($_.Exception.Response.StatusCode.value__ -eq 400) '已按 400 拒绝' }
}
# 关键词表的可比对指纹。
# 注意：不能用 Sort-Object kind, keyword 直接排 —— hashtable 的键不会被 Sort-Object 解析成属性，
# 会导致顺序随机（实测 hashtable 数组排不出序），所以要显式取值成字符串数组再排。
function KwKey($rows) {
  $pairs = foreach ($row in $rows) {
    $enabled = '1'
    if ($row.enabled -eq $false -or $row.enabled -eq 0 -or "$($row.enabled)" -eq '0') { $enabled = '0' }
    "$($row.kind):$($row.keyword):$enabled"
  }
  return (@($pairs) | Sort-Object) -join '|'
}

Write-Output '===== 0. 自愈还原 + 快照关键词表 + 记录基线（全程不碰真实菜品配置） ====='
# 自愈：上一次若中断在收尾之前，备份还在 —— 先把生产配置还原回去，再开始本次测试
if (Test-Path $backupFile) {
  $stale = Get-Content -Raw -Encoding UTF8 $backupFile | ConvertFrom-Json
  Api PUT '/api/poultry/scope/keywords' @{ keywords = [object[]]$stale.keywords } | Out-Null
  Remove-Item -Force $backupFile
  Write-Output '  （检测到上次中断留下的备份，已自动还原关键词表）'
}

# 回收自己上次的残留：先解除自建临时菜品上指向自建禽类的耗用，否则删品种会被拦下
$myBirds = @((Api GET '/api/poultry/species').birds | Where-Object { $SCRIPT_BIRD_NAMES -contains $_.breed_name })
$myYieldIds = @()
foreach ($b in $myBirds) { $myYieldIds += @((Api GET "/api/poultry/yields?bird_id=$($b.id)").yields | ForEach-Object { $_.id }) }
foreach ($d in (Api GET '/api/menu').items | Where-Object { $SCRIPT_DISH_NAMES -contains $_.name }) {
  if ($myYieldIds.Count) { Api PUT "/api/poultry/dish-usage/$($d.id)" @{ rows = @() } | Out-Null }
  Api DELETE "/api/menu/$($d.id)" | Out-Null
}
foreach ($b in $myBirds) { Api DELETE "/api/poultry/species/$($b.id)" | Out-Null }

$scope0 = Api GET '/api/poultry/scope'
$baselineKeywords = @($scope0.keywords | ForEach-Object { @{ keyword = $_.keyword; kind = $_.kind; enabled = $_.enabled; note = $_.note } })
$baselineKey = KwKey $baselineKeywords
@{ keywords = [object[]]$baselineKeywords; saved_at = (Get-Date).ToString('s') } | ConvertTo-Json -Depth 6 |
  Set-Content -Path $backupFile -Encoding UTF8
$baselineBirdCount = @((Api GET '/api/poultry/species').birds).Count
$baselineConfigured = (Api GET '/api/poultry/dish-usage?filter=set').configured
$baselineAccounting = Api GET '/api/poultry/accounting?store_id=12&date_from=2026-09-01&date_to=2026-09-10'
Check '快照已保存且基线已记录' ((Test-Path $backupFile) -and $baselineKeywords.Count -gt 0) `
  "关键词 $($baselineKeywords.Count) 条 禽类档案 $baselineBirdCount 已配置菜品 $baselineConfigured 基准只数 $($baselineAccounting.summary.total_birds)"

Write-Output ''
Write-Output '===== 1. 规则读取与预览 ====='
$scope = Api GET '/api/poultry/scope'
$includeNow = @($scope.rules.include)
Check '关键词表可读' ($scope.keywords.Count -gt 0 -and $includeNow.Count -gt 0) "关键词 $($scope.keywords.Count) 条 include=$($includeNow -join ',') exclude=$(@($scope.rules.exclude) -join ',')"

$preview = Api GET '/api/poultry/scope/preview'
Check '规则预览可返回菜品判定' ($preview.dishes.Count -gt 0) "菜品 $($preview.dishes.Count) 个 判定为禽类菜 $($preview.summary.scope_dish_count) 个"
$inScopeRows = @($preview.dishes | Where-Object { $_.in_scope })
Check '预览统计与明细一致' ($inScopeRows.Count -eq $preview.summary.scope_dish_count) "明细 $($inScopeRows.Count) = 统计 $($preview.summary.scope_dish_count)"
Check '每条判定都带依据' (@($preview.dishes | Where-Object { -not $_.reason }).Count -eq 0) "缺依据行数=$(@($preview.dishes | Where-Object { -not $_.reason }).Count)"
Check '排除词生效（含蛋的菜被判不算）' (@($preview.dishes | Where-Object { $_.menu_name -like '*蛋*' -and $_.in_scope }).Count -eq 0) `
  "含「蛋」且被算作禽类菜的菜品数=$(@($preview.dishes | Where-Object { $_.menu_name -like '*蛋*' -and $_.in_scope }).Count)"

Write-Output ''
Write-Output '===== 2. 关键词维护（临时改动，收尾还原） ====='
$testKeywords = @($baselineKeywords | ForEach-Object { $_ }) + @{ keyword = '验证词-临时禽'; kind = 'include'; enabled = $true; note = $MARK }
$saveRes = Api PUT '/api/poultry/scope/keywords' @{ keywords = [object[]]$testKeywords }
Check '新增关键词成功' ($saveRes.count -eq $testKeywords.Count) "保存 $($saveRes.count) 条"
$afterAdd = Api GET '/api/poultry/scope'
Check '新增关键词已回读' (@($afterAdd.keywords | Where-Object { $_.keyword -eq '验证词-临时禽' }).Count -eq 1) "回读 $($afterAdd.keywords.Count) 条"
Check '新增词进入生效规则' (@($afterAdd.rules.include) -contains '验证词-临时禽') "include=$(@($afterAdd.rules.include) -join ',')"

# 停用测试：把「鸡」停用后，生效 include 里不应再有它
$disableChicken = @($afterAdd.keywords | ForEach-Object {
  if ($_.keyword -eq '鸡') { @{ keyword = $_.keyword; kind = $_.kind; enabled = $false; note = $_.note } }
  else { @{ keyword = $_.keyword; kind = $_.kind; enabled = $_.enabled; note = $_.note } }
})
Api PUT '/api/poultry/scope/keywords' @{ keywords = [object[]]$disableChicken } | Out-Null
$afterDisable = Api GET '/api/poultry/scope'
Check '停用关键词后不再生效' ((@($afterDisable.rules.include) -notcontains '鸡') -and (@($afterDisable.keywords | Where-Object { $_.keyword -eq '鸡' })[0].enabled -eq $false)) `
  "include=$(@($afterDisable.rules.include) -join ',')"

Expect-400 '空关键词被拒绝' { Api PUT '/api/poultry/scope/keywords' @{ keywords = @() } }
Expect-400 '全部 include 停用被拒绝' { Api PUT '/api/poultry/scope/keywords' @{ keywords = @(@{ keyword = '鹅'; kind = 'include'; enabled = $false }) } }
Expect-400 '重复关键词被拒绝' { Api PUT '/api/poultry/scope/keywords' @{ keywords = @(@{ keyword = '鹅'; kind = 'include' }, @{ keyword = '鹅'; kind = 'include' }) } }
Expect-400 '空字符串关键词被拒绝' { Api PUT '/api/poultry/scope/keywords' @{ keywords = @(@{ keyword = '   '; kind = 'include' }) } }

Write-Output ''
Write-Output '===== 3. 显式名单（手动标记，用自建临时菜品） ====='
$tmpDish = Api POST '/api/menu' @{ name = '验证临时菜-范围'; category = '验证临时分类'; spec = '标准'; cost = 0 }
$tmpDishId = $tmpDish.id
Check '临时菜品已建' ($tmpDishId -gt 0) "dish=$tmpDishId"

$pv1 = Api GET '/api/poultry/scope/preview'
$row1 = @($pv1.dishes | Where-Object { $_.menu_item_id -eq $tmpDishId })[0]
Check '名称不含禽类词的临时菜默认不算' ($row1 -and -not $row1.in_scope -and $row1.reason -eq 'not_matched') "in_scope=$($row1.in_scope) reason=$($row1.reason)"

$markRes = Api POST '/api/poultry/scope/dishes' @{ menu_item_ids = @($tmpDishId); in_scope = $true; note = $MARK }
Check '手动标记为禽类菜成功' ($markRes.mode -eq 'include' -and $markRes.count -eq 1) "mode=$($markRes.mode) count=$($markRes.count)"
$pv2 = Api GET '/api/poultry/scope/preview'
$row2 = @($pv2.dishes | Where-Object { $_.menu_item_id -eq $tmpDishId })[0]
Check '手动标记优先于名称判定' ($row2.in_scope -and $row2.reason -eq 'manual') "in_scope=$($row2.in_scope) reason=$($row2.reason)"

Api POST '/api/poultry/scope/dishes' @{ menu_item_ids = @($tmpDishId); in_scope = $false; note = $MARK } | Out-Null
$pv3 = Api GET '/api/poultry/scope/preview'
$row3 = @($pv3.dishes | Where-Object { $_.menu_item_id -eq $tmpDishId })[0]
Check '手动标记为不算生效' ((-not $row3.in_scope) -and $row3.reason -eq 'manual_exclude') "in_scope=$($row3.in_scope) reason=$($row3.reason)"

# 名称含禽类词的临时菜被手动标为不算 —— 验证「排除优先级最高」
$tmpDish2 = Api POST '/api/menu' @{ name = '验证临时菜-范围鹅'; category = '验证临时分类'; spec = '标准'; cost = 0 }
$tmpDish2Id = $tmpDish2.id
Api POST '/api/poultry/scope/dishes' @{ menu_item_ids = @($tmpDish2Id); in_scope = $false; note = $MARK } | Out-Null
$pv4 = Api GET '/api/poultry/scope/preview'
$row4 = @($pv4.dishes | Where-Object { $_.menu_item_id -eq $tmpDish2Id })[0]
Check '名含禽类词也可被手动排除' ((-not $row4.in_scope) -and $row4.reason -eq 'manual_exclude') "in_scope=$($row4.in_scope) reason=$($row4.reason)"

Api POST '/api/poultry/scope/dishes' @{ menu_item_ids = @($tmpDishId, $tmpDish2Id); in_scope = $null } | Out-Null
$pv5 = Api GET '/api/poultry/scope/preview'
$row5 = @($pv5.dishes | Where-Object { $_.menu_item_id -eq $tmpDish2Id })[0]
Check '清除标记后回退到关键词判定' ($row5.in_scope -and $row5.reason -eq 'keyword') "in_scope=$($row5.in_scope) reason=$($row5.reason)"
Check '显式名单已清空' (@((Api GET '/api/poultry/scope').dishes).Count -eq 0) "剩余名单=$(@((Api GET '/api/poultry/scope').dishes).Count) 条"

Expect-400 '空菜品列表被拒绝' { Api POST '/api/poultry/scope/dishes' @{ menu_item_ids = @(); in_scope = $true } }
Expect-400 '不存在的菜品被拒绝' { Api POST '/api/poultry/scope/dishes' @{ menu_item_ids = @(99999999); in_scope = $true } }

Write-Output ''
Write-Output '===== 4. 已配禽类耗用的菜品强制计入 ====='
$bird = Api POST '/api/poultry/species' @{ animal = '鹅'; breed_name = '验证用鹅-范围临时'; net_weight_kg = 4.5; unit_cost = 120; status = '启用'; remark = $MARK }
$birdId = $bird.id
Api PUT "/api/poultry/yields/$birdId" @{ rows = @(@{ part_name = '验证部位-临时'; parts_per_bird = 4; part_kind = '身体' }) } | Out-Null
$yieldRow = @((Api GET "/api/poultry/yields?bird_id=$birdId").yields)[0]
Api PUT "/api/poultry/dish-usage/$($tmpDishId)" @{ rows = @(@{ yield_id = $yieldRow.id; usage_qty = 1 }) } | Out-Null
$pv6 = Api GET '/api/poultry/scope/preview'
$row6 = @($pv6.dishes | Where-Object { $_.menu_item_id -eq $tmpDishId })[0]
Check '已配耗用的菜自动算作禽类菜' ($row6.in_scope -and $row6.reason -eq 'configured') "in_scope=$($row6.in_scope) reason=$($row6.reason) configured=$($row6.configured)"

Write-Output ''
Write-Output '===== 5. 双覆盖率口径（只读核算） ====='
$acc = Api GET '/api/poultry/accounting?store_id=12&date_from=2026-09-01&date_to=2026-09-10'
$s = $acc.summary
$ps = $acc.coverage.poultry_scope
Check '返回禽类菜口径字段' ($null -ne $s.poultry_covered_rate -and $null -ne $ps) "禽类覆盖=$($s.poultry_covered_rate) 全量覆盖=$($s.covered_rate)"
Check '禽类覆盖率 = 分子 / 分母' ([math]::Abs([double]$s.poultry_covered_rate - ([double]$ps.covered_quantity / [double]$ps.scope_quantity)) -lt 0.001) `
  "$($ps.covered_quantity) / $($ps.scope_quantity) = $($s.poultry_covered_rate)"
Check '禽类覆盖率不超过 100%' ([double]$s.poultry_covered_rate -le 1.0001) "rate=$($s.poultry_covered_rate)"
Check '禽类菜分母 ≤ 全量分母' ([double]$s.poultry_scope_quantity -le [double]$s.total_quantity + 0.01) "禽类菜 $($s.poultry_scope_quantity) ≤ 全量 $($s.total_quantity)"
Check '禽类覆盖率 ≥ 全量覆盖率' ([double]$s.poultry_covered_rate -ge [double]$s.covered_rate) "禽类 $($s.poultry_covered_rate) ≥ 全量 $($s.covered_rate)"
Check '禽类未覆盖 = 分母 − 分子' ([math]::Abs([double]$s.poultry_uncovered_quantity - ([double]$s.poultry_scope_quantity - [double]$s.poultry_covered_quantity)) -lt 0.01) `
  "$($s.poultry_uncovered_quantity) = $($s.poultry_scope_quantity) − $($s.poultry_covered_quantity)"
Check '禽类缺口清单是全量缺口的子集' (@($ps.unbound | Where-Object { $n = $_.product_name; -not (@($acc.coverage.unbound | Where-Object { $_.product_name -eq $n }).Count) }).Count -eq 0) `
  "禽类未绑定 $($ps.unbound.Count) 项 / 全量未绑定 $($acc.coverage.unbound.Count) 项"
Check '菜品级判定明细已返回' ($ps.dishes.Count -gt 0) "明细 $($ps.dishes.Count) 行"
Check '只数与改造前一致（算法未被扰动）' ([double]$acc.summary.total_birds -eq [double]$baselineAccounting.summary.total_birds) `
  "现在 $($acc.summary.total_birds) / 基准 $($baselineAccounting.summary.total_birds)"

Write-Output ''
Write-Output '===== 6. 收尾：还原关键词表 + 回收自建数据 ====='
Api PUT '/api/poultry/scope/keywords' @{ keywords = [object[]]$baselineKeywords } | Out-Null
$restored = Api GET '/api/poultry/scope'
Check '关键词表已原样还原' ((KwKey $restored.keywords) -eq $baselineKey) "还原后 $((KwKey $restored.keywords))"

# 回收：先解除自建菜品耗用，再删菜品与品种
Api PUT "/api/poultry/dish-usage/$($tmpDishId)" @{ rows = @() } | Out-Null
foreach ($name in $SCRIPT_DISH_NAMES) {
  foreach ($d in (Api GET '/api/menu').items | Where-Object { $_.name -eq $name }) { Api DELETE "/api/menu/$($d.id)" | Out-Null }
}
foreach ($b in (Api GET '/api/poultry/species').birds | Where-Object { $SCRIPT_BIRD_NAMES -contains $_.breed_name }) {
  Api DELETE "/api/poultry/species/$($b.id)" | Out-Null
}
$leftDishes = @((Api GET '/api/menu').items | Where-Object { $SCRIPT_DISH_NAMES -contains $_.name }).Count
$leftBirds = @((Api GET '/api/poultry/species').birds | Where-Object { $SCRIPT_BIRD_NAMES -contains $_.breed_name }).Count
Check '自建临时菜品已回收' ($leftDishes -eq 0) "残留=$leftDishes"
Check '自建临时禽类已回收' ($leftBirds -eq 0) "残留=$leftBirds"
Check '显式名单无残留' (@((Api GET '/api/poultry/scope').dishes).Count -eq 0) "剩余名单=$(@((Api GET '/api/poultry/scope').dishes).Count) 条"

$endBirdCount = @((Api GET '/api/poultry/species').birds).Count
$endConfigured = (Api GET '/api/poultry/dish-usage?filter=set').configured
Check '用户真实数据未被改动' (($endBirdCount -eq $baselineBirdCount) -and ($endConfigured -eq $baselineConfigured)) `
  "禽类档案 $baselineBirdCount->$endBirdCount 已配置菜品 $baselineConfigured->$endConfigured"

$accEnd = Api GET '/api/poultry/accounting?store_id=12&date_from=2026-09-01&date_to=2026-09-10'
Check '核算结果恢复到基准' ([double]$accEnd.summary.total_birds -eq [double]$baselineAccounting.summary.total_birds) `
  "结束 $($accEnd.summary.total_birds) / 基准 $($baselineAccounting.summary.total_birds)"

Remove-Item -Force $backupFile -ErrorAction SilentlyContinue
Check '快照文件已清理' (-not (Test-Path $backupFile)) "backup=$backupFile"

Write-Output ''
Write-Output '===== 验证结束 ====='
