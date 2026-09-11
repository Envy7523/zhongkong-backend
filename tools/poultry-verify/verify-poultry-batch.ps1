# 菜品耗用「分组选菜 + 批量关联」端到端验证（自清理）
$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:3456'
$login = Invoke-RestMethod -Uri "$base/api/auth/login" -Method Post -ContentType 'application/json' `
  -Body (@{ username = 'admin'; password = 'admin123' } | ConvertTo-Json) -TimeoutSec 60
$headers = @{ Authorization = "Bearer $($login.token)" }

function Api($method, $path, $body) {
  $req = @{ Uri = "$base$path"; Method = $method; Headers = $headers; TimeoutSec = 120 }
  if ($body) {
    $json = $body | ConvertTo-Json -Depth 8
    $req.Body = [System.Text.Encoding]::UTF8.GetBytes($json)
    $req.ContentType = 'application/json; charset=utf-8'
  }
  return Invoke-RestMethod @req
}
function Check($label, $condition, $detail) {
  $mark = 'FAIL'; if ($condition) { $mark = 'PASS' }
  Write-Output ("[{0}] {1} :: {2}" -f $mark, $label, $detail)
}
function Expect-400($label, $scriptBlock) {
  try { & $scriptBlock | Out-Null; Check $label $false '未被拦截' }
  catch { Check $label ($_.Exception.Response.StatusCode.value__ -eq 400) '已按 400 拒绝' }
}

Write-Output '===== 0. 记录基线；只回收脚本自己的残留（绝不整表清空） ====='
$SCRIPT_BIRD_NAMES = @('批量验证用鹅-临时', '验证用鹅-临时', '验证用鸭-临时')
$baselineBirds = (Api GET '/api/poultry/species').birds.Count
$baselineConfigured = (Api GET '/api/poultry/dish-usage?filter=set').configured
foreach ($b in (Api GET '/api/poultry/species').birds) {
  if ($SCRIPT_BIRD_NAMES -contains $b.breed_name) { Api DELETE "/api/poultry/species/$($b.id)" | Out-Null }
}
foreach ($p in (Api GET '/api/poultry/purchases').purchases) {
  if ($p.remark -eq '自动化验证临时数据') { Api DELETE "/api/poultry/purchases/$($p.id)" | Out-Null }
}
Write-Output ("  基线：禽类档案={0} 已配置菜品={1}（脚本不修改也不删除用户数据）" -f $baselineBirds, $baselineConfigured)

Write-Output ''
Write-Output '===== 1. 前提数据：1 只禽 + 2 个部位 ====='
$birdId = (Api POST '/api/poultry/species' @{ animal = '鹅'; breed_name = '批量验证用鹅-临时'; net_weight_kg = 4; unit_cost = 100; status = '启用' }).id
$y = Api PUT "/api/poultry/yields/$birdId" @{ rows = @(
    @{ part_name = '批量部位A'; parts_per_bird = 8; part_weight_g = 100 },
    @{ part_name = '批量部位B'; parts_per_bird = 4; part_weight_g = 200 }
  ) }
$yields = (Api GET "/api/poultry/yields?bird_id=$birdId").yields
$yieldA = $yields | Where-Object { $_.part_name -eq '批量部位A' }
$yieldB = $yields | Where-Object { $_.part_name -eq '批量部位B' }
Check '部位就绪' ($yieldA.parts_per_bird -eq 8 -and $yieldB.parts_per_bird -eq 4) "A=8 B=4"

Write-Output ''
Write-Output '===== 2. 分组统计 ====='
$ov = Api GET '/api/poultry/dish-usage'
$cats = @($ov.categories)
$sumTotal = ($cats | Measure-Object -Property total -Sum).Sum
Check '返回分组列表' ($cats.Count -gt 0) "分组数=$($cats.Count) 首个=$($cats[0].name)($($cats[0].configured)/$($cats[0].total))"
Check '分组进度字段齐全' (($cats | Where-Object { $_.PSObject.Properties.Name -notcontains 'configured' }).Count -eq 0) "样例=" + (($cats | Select-Object -First 3 | ForEach-Object { "$($_.name):$($_.configured)/$($_.total)" }) -join ' ')
Check '分组总数=全部菜品数' ($sumTotal -eq $ov.all_total) "分组合计=$sumTotal all_total=$($ov.all_total)"
$target = $cats | Where-Object { $_.name -and $_.total -ge 2 } | Sort-Object total | Select-Object -First 1
Check '选出测试分组' ($null -ne $target) "分组「$($target.name)」共 $($target.total) 个菜品"

Write-Output ''
Write-Output '===== 3. 按分组筛选 ====='
$filtered = Api GET "/api/poultry/dish-usage?category=$([uri]::EscapeDataString($target.name))"
$wrongCat = @($filtered.items | Where-Object { $_.category -ne $target.name })
Check '分组筛选只返回该组' ($wrongCat.Count -eq 0 -and $filtered.items.Count -eq $target.total) "返回=$($filtered.items.Count) 期望=$($target.total) 越界=$($wrongCat.Count)"
Check '筛选后仍返回完整分组条' (@($filtered.categories).Count -eq $cats.Count) "分组数=$(@($filtered.categories).Count)"
$groupIds = @($filtered.items | ForEach-Object { $_.id })

# 安全：这批真实菜品的耗用配置稍后会被本脚本反复改写，先快照，收尾原样还原
$usageSnapshot = @{}
foreach ($menuId in $groupIds) {
  $rows = @((Api GET "/api/poultry/dish-usage?menu_item_id=$menuId").rows | ForEach-Object { @{ yield_id = $_.yield_id; usage_qty = $_.usage_qty } })
  $usageSnapshot["$menuId"] = $rows
}
$snapRowTotal = ($usageSnapshot.Values | ForEach-Object { $_.Count } | Measure-Object -Sum).Sum
$snapDishCount = @($usageSnapshot.Values | Where-Object { $_.Count -gt 0 }).Count
function Restore-UsageSnapshot {
  foreach ($menuId in $usageSnapshot.Keys) {
    $rows = @($usageSnapshot[$menuId])
    if ($rows.Count -gt 0) { Api PUT "/api/poultry/dish-usage/$menuId" @{ rows = [object[]]$rows } | Out-Null }
    else { Api PUT "/api/poultry/dish-usage/$menuId" @{ rows = @() } | Out-Null }
  }
}
Write-Output ("  已快照该组 {0} 个菜品原有配置：{1} 条关系 / 涉及 {2} 个菜品（收尾会原样还原）" -f $groupIds.Count, $snapRowTotal, $snapDishCount)

Write-Output ''
Write-Output '===== 4. 批量关联（覆盖模式） ====='
$r1 = Api POST '/api/poultry/dish-usage/batch' @{ menu_item_ids = $groupIds; mode = 'replace'; rows = @(@{ yield_id = $yieldA.id; usage_qty = 1 }) }
Check '批量覆盖成功' ($r1.ok -and $r1.dishes -eq $target.total -and $r1.rows -eq 1) "菜品=$($r1.dishes) 关系=$($r1.rows) 模式=$($r1.mode)"
Check '覆盖时如实回报被清掉的旧配置' ($r1.removed -eq $snapRowTotal -and $r1.replaced_dishes -eq $snapDishCount) "removed=$($r1.removed)/期望$snapRowTotal replaced=$($r1.replaced_dishes)/期望$snapDishCount"
$after = Api GET "/api/poultry/dish-usage?category=$([uri]::EscapeDataString($target.name))"
$bad = @($after.items | Where-Object { $_.usage_count -ne 1 -or $_.usage[0].part_name -ne '批量部位A' })
Check '组内每个菜品各挂 1 条且部位正确' ($bad.Count -eq 0) "异常行=$($bad.Count) 例=$($after.items[0].name) -> $($after.items[0].usage[0].part_name)"
Check '分组进度更新为已配满' (($after.categories | Where-Object { $_.name -eq $target.name }).configured -eq $target.total) "进度=$(($after.categories | Where-Object { $_.name -eq $target.name }).configured)/$($target.total)"
$expectedConfigured = $baselineConfigured - $snapDishCount + $target.total
Check '全局已配置数=基线 - 组内原有 + 组内菜品数' ($after.configured -eq $expectedConfigured) "configured=$($after.configured) 期望=$expectedConfigured（基线$baselineConfigured）"

Write-Output ''
Write-Output '===== 5. 批量关联（追加模式） ====='
$r2 = Api POST '/api/poultry/dish-usage/batch' @{ menu_item_ids = $groupIds; mode = 'append'; rows = @(@{ yield_id = $yieldB.id; usage_qty = 2 }) }
Check '批量追加成功' ($r2.ok -and $r2.mode -eq 'append' -and $r2.removed -eq 0) "菜品=$($r2.dishes) removed=$($r2.removed)"
$after2 = Api GET "/api/poultry/dish-usage?category=$([uri]::EscapeDataString($target.name))"
$bad2 = @($after2.items | Where-Object { $_.usage_count -ne 2 })
Check '追加后每菜 2 条关系' ($bad2.Count -eq 0) "异常行=$($bad2.Count) 首行=$($after2.items[0].usage_count) 条"
Check '追加保留原部位' ([bool](@($after2.items[0].usage | Where-Object { $_.part_name -eq '批量部位A' }).Count)) (($after2.items[0].usage | ForEach-Object { $_.part_name }) -join '+')

Write-Output ''
Write-Output '===== 6. 再覆盖：旧配置被清除并回报 ====='
$r3 = Api POST '/api/poultry/dish-usage/batch' @{ menu_item_ids = $groupIds; mode = 'replace'; rows = @(@{ yield_id = $yieldB.id; usage_qty = 1 }) }
Check '覆盖清除旧配置并回报条数' ($r3.removed -eq $target.total -and $r3.replaced_dishes -eq $target.total) "removed=$($r3.removed) replaced_dishes=$($r3.replaced_dishes) 期望=$($target.total)"
$after3 = Api GET "/api/poultry/dish-usage?category=$([uri]::EscapeDataString($target.name))"
$bad3 = @($after3.items | Where-Object { $_.usage_count -ne 1 -or $_.usage[0].part_name -ne '批量部位B' })
Check '覆盖后只剩新部位' ($bad3.Count -eq 0) "异常行=$($bad3.Count) 例=$($after3.items[0].usage[0].part_name)"

Write-Output ''
Write-Output '===== 7. 参数校验 ====='
Expect-400 '空菜品列表被拒绝' { Api POST '/api/poultry/dish-usage/batch' @{ menu_item_ids = @(); mode = 'replace'; rows = @(@{ yield_id = $yieldA.id; usage_qty = 1 }) } }
Expect-400 '空耗用行被拒绝' { Api POST '/api/poultry/dish-usage/batch' @{ menu_item_ids = $groupIds; mode = 'replace'; rows = @() } }
Expect-400 '无效部位被拒绝' { Api POST '/api/poultry/dish-usage/batch' @{ menu_item_ids = $groupIds; mode = 'replace'; rows = @(@{ yield_id = 999999; usage_qty = 1 }) } }
Expect-400 '耗用量<=0 被拒绝' { Api POST '/api/poultry/dish-usage/batch' @{ menu_item_ids = $groupIds; mode = 'replace'; rows = @(@{ yield_id = $yieldA.id; usage_qty = 0 }) } }
Expect-400 '重复部位被拒绝' { Api POST '/api/poultry/dish-usage/batch' @{ menu_item_ids = $groupIds; mode = 'replace'; rows = @(@{ yield_id = $yieldA.id; usage_qty = 1 }, @{ yield_id = $yieldA.id; usage_qty = 2 }) } }
Expect-400 '不存在的菜品被拒绝' { Api POST '/api/poultry/dish-usage/batch' @{ menu_item_ids = @(999901, 999902); mode = 'replace'; rows = @(@{ yield_id = $yieldA.id; usage_qty = 1 }) } }

Write-Output ''
Write-Output '===== 8. 批量结果参与核算（与手算对照） ====='
$calc = Api GET '/api/poultry/accounting?date_from=2026-05-01&date_to=2026-09-10&channel=all'
$groupRows = @($calc.dishes | Where-Object { $groupIds -contains $_.menu_item_id })
$qty = ($groupRows | Measure-Object -Property quantity -Sum).Sum
$birds = ($groupRows | Measure-Object -Property birds_count -Sum).Sum
$expected = [math]::Round($qty / 4, 2)
Check '分组菜品都进入核算' ($groupRows.Count -gt 0) "明细行=$($groupRows.Count) 涉及菜品=$(($groupRows | ForEach-Object { $_.menu_item_id } | Sort-Object -Unique).Count)"
Check '只数=销量/出成量(4)' ([math]::Abs($birds - $expected) -lt 0.05) "合计销量=$qty / 4 = $birds（手算 $expected）"
$myBird = $calc.summary.birds | Where-Object { $_.bird_id -eq $birdId }
# 只比对自己这只验证禽，用户自己配的禽类不参与断言；汇总按未舍入总量定稿，逐行明细各留 2 位小数会有 0.01 级漂移
Check '汇总只数与明细合计一致' ([math]::Abs($myBird.birds_count - $birds) -lt 0.05) "该禽汇总=$($myBird.birds_count) 明细合计=$birds"

Write-Output ''
Write-Output '===== 9. 只回收自己建的数据，并把菜品耗用还原成快照 ====='
Restore-UsageSnapshot
foreach ($b in (Api GET '/api/poultry/species').birds) {
  if ($SCRIPT_BIRD_NAMES -contains $b.breed_name) { Api DELETE "/api/poultry/species/$($b.id)" | Out-Null }
}
$a1 = Api GET '/api/poultry/species'
$leftover = @($a1.birds | Where-Object { $SCRIPT_BIRD_NAMES -contains $_.breed_name })
$restoredCount = 0
foreach ($menuId in $groupIds) {
  $rows = @((Api GET "/api/poultry/dish-usage?menu_item_id=$menuId").rows)
  $restoredCount += $rows.Count
}
Check '自己建的禽类档案已回收' ($leftover.Count -eq 0) "残留=$($leftover.Count) 当前禽类档案总数=$($a1.birds.Count)（基线 $baselineBirds）"
Check '用户数据未被改动' ($a1.birds.Count -eq $baselineBirds) "禽类档案 $baselineBirds -> $($a1.birds.Count)"
Check '组内菜品耗用已还原为快照' ($restoredCount -eq $snapRowTotal) "快照=$snapRowTotal 条 现状=$restoredCount 条"
Write-Output ''
Write-Output '===== 验证结束 ====='
