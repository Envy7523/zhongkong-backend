# 堂食菜品绑定 · 智能推荐验证（与「菜品销量」同一套识别规则）
# 执行方式（PS 5.1 必须显式按 UTF-8 读取）：
#   $VerifyDir = (Resolve-Path 'tools\poultry-verify').Path
#   $code = Get-Content -Raw -Encoding UTF8 (Join-Path $VerifyDir 'verify-dish-binding-recommend.ps1'); Invoke-Expression $code
#
# 安全约定（本项目发生过「验证脚本清空用户数据」事故）：
#   1) 只读校验推荐字段与统计；写操作**只用自己创建的临时本地菜品**（名称带「验证临时」前缀）
#   2) 批量智能绑定会写真实绑定表 —— 跑前快照全部绑定键，收尾**只删除本次新增的行**，恢复到基线
#   3) 收尾必须能自愈：若上次中断留下残留，下次启动先清掉自己建的东西
$ErrorActionPreference = 'Stop'
if (-not $PSScriptRoot) {
  if (-not $VerifyDir) { throw '请先设置 $VerifyDir = 本脚本所在目录' }
} else { $VerifyDir = $PSScriptRoot }
$base = 'http://127.0.0.1:3456'
$TMP_DISH_NAME = '验证临时绑定菜-智能推荐'
$TMP_DISH_SPEC = '标准'

$login = Invoke-RestMethod -Uri "$base/api/auth/login" -Method Post -ContentType 'application/json' `
  -Body (@{ username = 'admin'; password = 'admin123' } | ConvertTo-Json) -TimeoutSec 60
$headers = @{ Authorization = "Bearer $($login.token)" }

function Api($method, $path, $body) {
  $req = @{ Uri = "$base$path"; Method = $method; Headers = $headers; TimeoutSec = 300 }
  if ($body) {
    $req.Body = [System.Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 8))
    $req.ContentType = 'application/json; charset=utf-8'
  }
  return Invoke-RestMethod @req
}
function Check($label, $condition, $detail) {
  $mark = 'FAIL'; if ($condition) { $mark = 'PASS' }
  Write-Output ("[{0}] {1} :: {2}" -f $mark, $label, $detail)
}
# 规格归一化：必须与后端一致（'' 与 '--' 视为同一个键）。
# 之前拼接键时直接用了接口返回的原始 spec，而接口写入用的是归一化值，导致回滚匹配不上、漏删残留。
function NormSpec([string]$spec) {
  $t = [string]$spec
  if ($t -eq '--') { return '' }
  return $t.Trim()
}
function MappingKeys {
  # 绑定表全量键集合（快照/回滚用）
  $all = @()
  $page = 1
  while ($true) {
    $r = Api GET "/api/dish-sales/mappings?page=$page&page_size=100&mapped=bound"
    if (-not $r.items.Count) { break }
    foreach ($it in $r.items) { if ($it.mapping_id) { $all += ("{0}|{1}|{2}" -f $it.product_code, $it.product_name, (NormSpec $it.spec)) } }
    if ($r.items.Count -lt 100) { break }
    $page++
  }
  return $all
}

Write-Output '===== 0. 自愈：清掉自己上次遗留的临时菜品与指向它的绑定 ====='
$leftover = @((Api GET '/api/menu').items | Where-Object { $_.name -eq $TMP_DISH_NAME })
foreach ($d in $leftover) {
  foreach ($it in (Api GET "/api/dish-sales/mappings?keyword=$([uri]::EscapeDataString($TMP_DISH_NAME))&page_size=100").items) {
    if ($it.mapping_id) { Api DELETE "/api/dish-sales/mappings/$($it.mapping_id)" | Out-Null }
  }
  Api DELETE "/api/menu/$($d.id)" | Out-Null
}
Write-Output ("  已清理残留临时菜品 {0} 个" -f $leftover.Count)

Write-Output ''
Write-Output '===== 1. 推荐字段（只读） ====='
$page1 = Api GET '/api/dish-sales/mappings?mapped=unbound&page_size=100&sort=quantity'
Check '返回可推荐条数统计' ($null -ne $page1.recommend_summary) `
  "待绑定 $($page1.recommend_summary.pending) / 可智能推荐 $($page1.recommend_summary.recommendable) / 无推荐 $($page1.recommend_summary.unmatched)"
Check '统计自洽（可推荐 + 无推荐 = 待绑定）' `
  (($page1.recommend_summary.recommendable + $page1.recommend_summary.unmatched) -eq $page1.recommend_summary.pending) `
  "$($page1.recommend_summary.recommendable) + $($page1.recommend_summary.unmatched) = $($page1.recommend_summary.pending)"

$unboundWithRec = @($page1.items | Where-Object { $_.recommend_menu_item_id })
Check '未绑定行带出推荐 SKU' ($unboundWithRec.Count -gt 0) "本页 $($unboundWithRec.Count)/$($page1.items.Count) 行有推荐"
Check '推荐行都带依据标签' (@($unboundWithRec | Where-Object { -not $_.recommend_reason_label }).Count -eq 0) `
  "缺依据 $(@($unboundWithRec | Where-Object { -not $_.recommend_reason_label }).Count) 行"
Check '推荐依据取值合法' (@($unboundWithRec | Where-Object { $_.recommend_reason -notin @('skuid', 'name_spec', 'name') }).Count -eq 0) `
  "依据分布: $((@($unboundWithRec | Group-Object recommend_reason | ForEach-Object { "$($_.Name)=$($_.Count)" })) -join ' ')"

$boundPage = Api GET '/api/dish-sales/mappings?mapped=bound&page_size=50'
Check '已绑定行不返回推荐（避免误导）' (@($boundPage.items | Where-Object { $_.recommend_menu_item_id }).Count -eq 0) `
  "已绑定 $($boundPage.items.Count) 行中有推荐的 $(@($boundPage.items | Where-Object { $_.recommend_menu_item_id }).Count) 行"

Write-Output ''
Write-Output '===== 2. 识别规则正确性（只读断言） ====='
# 编码匹配的行：销售编码必须等于推荐菜品的 skuid，且名称（去括号后）一致 —— 名称互校防错绑
$menus = @((Api GET '/api/dish-sales/mappings?page_size=1').menu_items)
$skuById = @{}
foreach ($m in $menus) { $skuById[[string]$m.id] = [string]$m.skuid }
function Norm([string]$s) { return ($s -replace '[【】\[\]（）()\s]', '') }
$skuidRows = @($unboundWithRec | Where-Object { $_.recommend_reason -eq 'skuid' })
if ($skuidRows.Count) {
  $bad = @($skuidRows | Where-Object {
      $sku = $skuById[[string]$_.recommend_menu_item_id]
      (-not $sku) -or ($sku -ne [string]$_.product_code) -or ((Norm $_.product_name) -ne (Norm $_.recommend_sku_label))
    })
  Check '编码匹配要求编码+名称双一致' ($bad.Count -eq 0) "校验 $($skuidRows.Count) 行，不一致 $($bad.Count) 行"
} else {
  Check '编码匹配要求编码+名称双一致' $true '本页无 skuid 类推荐（跳过，非失败）'
}
# 名称类推荐：销售名与推荐菜品名（去括号空白后）必须一致
$nameRows = @($unboundWithRec | Where-Object { $_.recommend_reason -in @('name', 'name_spec') })
if ($nameRows.Count) {
  # 注意：recommend_sku_label 是「名称 · 规格 · 做法」拼出来的展示标签，比对名称要用 recommend_menu_name
  $badName = @($nameRows | Where-Object { (Norm $_.product_name) -ne (Norm $_.recommend_menu_name) })
  Check '名称类推荐与档案名归一化后一致' ($badName.Count -eq 0) "校验 $($nameRows.Count) 行，不一致 $($badName.Count) 行"
} else {
  Check '名称类推荐与档案名归一化后一致' $true '本页无名称类推荐（跳过）'
}

Write-Output ''
Write-Output '===== 2b. 疑似候选（精确规则未命中时的名称相似推荐） ====='
$withCand = @($page1.items | Where-Object { $_.recommend_candidates -and $_.recommend_candidates.Count -gt 0 })
Check '候选字段结构完整' (@($withCand | Where-Object { $_.recommend_candidates[0].menu_item_id -and $_.recommend_candidates[0].score -gt 0 -and $_.recommend_candidates[0].menu_name }).Count -eq $withCand.Count) `
  "本页 $($withCand.Count) 行有候选"
Check '候选不含员工餐菜品' (@($withCand | ForEach-Object { $_.recommend_candidates } | Where-Object { $_.menu_name -like '*员工*' }).Count -eq 0) `
  "员工餐候选数=$(@($withCand | ForEach-Object { $_.recommend_candidates } | Where-Object { $_.menu_name -like '*员工*' }).Count)"
Check '候选按相似度降序' (@($withCand | Where-Object { $_.recommend_candidates.Count -gt 1 -and $_.recommend_candidates[0].score -lt $_.recommend_candidates[1].score }).Count -eq 0) `
  "乱序行数=$(@($withCand | Where-Object { $_.recommend_candidates.Count -gt 1 -and $_.recommend_candidates[0].score -lt $_.recommend_candidates[1].score }).Count)"
Check '精确推荐与疑似候选互斥' (@($page1.items | Where-Object { $_.recommend_menu_item_id -and $_.recommend_candidates.Count -gt 0 }).Count -eq 0) `
  "同时给出两者的行数=$(@($page1.items | Where-Object { $_.recommend_menu_item_id -and $_.recommend_candidates.Count -gt 0 }).Count)"
Check '候选相似度均在阈值(0.6)之上' (@($withCand | ForEach-Object { $_.recommend_candidates } | Where-Object { $_.score -lt 0.6 }).Count -eq 0) `
  "低于阈值的候选数=$(@($withCand | ForEach-Object { $_.recommend_candidates } | Where-Object { $_.score -lt 0.6 }).Count)"

Write-Output ''
Write-Output '===== 3. 单行「采用推荐」（绑到自建临时菜品，随后解绑还原） ====='
$tmpDish = Api POST '/api/menu' @{ name = $TMP_DISH_NAME; category = '验证临时分类'; spec = $TMP_DISH_SPEC; cost = 1 }
$tmpId = $tmpDish.id
Check '临时本地菜品已建' ($tmpId -gt 0) "id=$tmpId name=$TMP_DISH_NAME"

$target = @($page1.items | Where-Object { $_.recommend_menu_item_id })[0]
if (-not $target) { throw '本页找不到带推荐的未绑定行，无法继续（可放宽 page_size）' }
Api POST '/api/dish-sales/mappings' @{
  product_code = $target.product_code; product_name = $target.product_name
  spec = $target.spec; menu_item_id = $tmpId
} | Out-Null
$after = Api GET ("/api/dish-sales/mappings?keyword=" + [uri]::EscapeDataString([string]$target.product_name) + "&mapped=bound&page_size=20")
$hit = @($after.items | Where-Object { $_.menu_item_id -eq $tmpId -and $_.product_name -eq $target.product_name })
Check '单行采用后变为已绑定' ($hit.Count -ge 1) "命中 $($hit.Count) 行（目标：$($target.product_name)）"
$hitMappingIds = @($hit | ForEach-Object { $_.mapping_id })
foreach ($mid in $hitMappingIds) { Api DELETE "/api/dish-sales/mappings/$mid" | Out-Null }
$restored = Api GET ("/api/dish-sales/mappings?keyword=" + [uri]::EscapeDataString([string]$target.product_name) + "&page_size=20")
$still = @($restored.items | Where-Object { $_.menu_item_id -eq $tmpId })
Check '解绑后回到未绑定（还原测试改动）' ($still.Count -eq 0) "仍指向临时菜品的行=$($still.Count)"

Write-Output ''
Write-Output '===== 4. 批量智能绑定（接口回报写入键 → 精确回滚，并发安全） ====='
$beforeKeys = MappingKeys
$beforeCount = $beforeKeys.Count
Write-Output "  基线：已绑定 $beforeCount 条"
$smart = Api POST '/api/dish-sales/mappings/auto-bind-smart'
$reasonText = (@('skuid', 'name_spec', 'name') | ForEach-Object { if ($smart.reasons.$_) { "$_=$($smart.reasons.$_)" } }) -join ' '
Check '批量智能绑定返回结果' ($smart.bound -ge 0) "成功 $($smart.bound) / 未识别 $($smart.skipped)（$reasonText）"
Check '绑定数与依据分布一致' (((@('skuid', 'name_spec', 'name') | ForEach-Object { [int]$smart.reasons.$_ }) | Measure-Object -Sum).Sum -eq $smart.bound) `
  "依据合计 = $($smart.bound)"
Check '回报了本次写入的绑定键' ($smart.written_keys.Count -eq $smart.bound) "written_keys=$($smart.written_keys.Count) / bound=$($smart.bound)"

# 回滚：只删接口回报的、本次由脚本写入的键（用户并发绑定的不受影响）
$written = @($smart.written_keys)
$afterKeys = MappingKeys
$effective = @($written | Where-Object { $afterKeys -contains $_ })
$allBound = @()
$page = 1
while ($true) {
  $r = Api GET "/api/dish-sales/mappings?page=$page&page_size=100&mapped=bound"
  if (-not $r.items.Count) { break }
  $allBound += @($r.items | Where-Object { $_.mapping_id })
  if ($r.items.Count -lt 100) { break }
  $page++
}
$toRemove = @($allBound | Where-Object { $written -contains ("{0}|{1}|{2}" -f $_.product_code, $_.product_name, (NormSpec $_.spec)) })
foreach ($row in $toRemove) { Api DELETE "/api/dish-sales/mappings/$($row.mapping_id)" | Out-Null }
$finalKeys = MappingKeys
$stillNew = @($written | Where-Object { $finalKeys -contains $_ })
$lostBase = @($beforeKeys | Where-Object { $finalKeys -notcontains $_ })
Check '本次写入的绑定已全部删除' ($stillNew.Count -eq 0) "残留 $($stillNew.Count) 条（写入 $($written.Count) 条，实际删 $($toRemove.Count) 条）"
Check '回滚精确（基线行一条没丢）' ($lostBase.Count -eq 0) "丢失 $($lostBase.Count) 条 / 基线 $beforeCount 条"
Write-Output ("  （当前总数 $($finalKeys.Count) 条；与基线 $beforeCount 的差额来自用户并发操作，属正常，脚本未触碰）")

Write-Output ''
Write-Output '===== 5. 收尾：删除自建临时菜品 ====='
Api DELETE "/api/menu/$tmpId" | Out-Null
$leftDish = @((Api GET '/api/menu').items | Where-Object { $_.name -eq $TMP_DISH_NAME }).Count
Check '临时菜品已回收' ($leftDish -eq 0) "残留=$leftDish"
$final = Api GET '/api/dish-sales/mappings?page_size=1'
Check '可推荐统计仍可返回' ($null -ne $final.recommend_summary) `
  "当前可智能推荐 $($final.recommend_summary.recommendable) 项 / 待绑定 $($final.recommend_summary.pending) 项"

Write-Output ''
Write-Output '===== 验证结束 ====='
