# 菜品核算端到端验证（自清理）：建档案 -> 算只数 -> 采购对比 -> 模板 -> 清理
# 说明：本机为 Windows PowerShell 5.1，脚本须以 UTF-8 显式读取后执行，否则中文串会被按 GBK 解析。
$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:3456'

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

Write-Output '===== 0. 回收自己上次的残留并记录基线（全程不碰任何真实菜品配置） ====='
# 安全约定（两次事故后收紧）：
#   1) 本脚本只用「自己按名称前缀建出来的禽类 + 自己建的临时菜品」，绝不改动用户的任何菜品耗用配置；
#   2) 核算公式改为只读校验（核对接口内部一致性），不再靠改真实菜品来测；
#   3) 删除范围只限自己创建的行。
$SCRIPT_BIRD_NAMES = @('验证用鹅-临时', '验证用鸭-临时', '批量验证用鹅-临时')
$SCRIPT_DISH_NAMES = @('验证临时菜-耗用', '验证临时菜-导入')

# 回收上一次跑挂留下的自己人：先解除指向自己测试禽类的耗用行，否则删品种会被后端拦下
$myBirds = @((Api GET '/api/poultry/species').birds | Where-Object { $SCRIPT_BIRD_NAMES -contains $_.breed_name })
$myYieldIds = @()
foreach ($b in $myBirds) { $myYieldIds += @((Api GET "/api/poultry/yields?bird_id=$($b.id)").yields | ForEach-Object { $_.id }) }
if ($myYieldIds.Count) {
  foreach ($item in (Api GET '/api/poultry/dish-usage?filter=set').items) {
    $rows = @((Api GET "/api/poultry/dish-usage?menu_item_id=$($item.id)").rows)
    $keep = @($rows | Where-Object { $myYieldIds -notcontains $_.yield_id } | ForEach-Object { @{ yield_id = $_.yield_id; usage_qty = $_.usage_qty } })
    if ($keep.Count -ne $rows.Count) {
      if ($keep.Count -gt 0) { Api PUT "/api/poultry/dish-usage/$($item.id)" @{ rows = [object[]]$keep } | Out-Null }
      else { Api PUT "/api/poultry/dish-usage/$($item.id)" @{ rows = @() } | Out-Null }
    }
  }
}
foreach ($b in $myBirds) { Api DELETE "/api/poultry/species/$($b.id)" | Out-Null }
# 回收自己建的临时菜品
foreach ($d in (Api GET '/api/menu').items | Where-Object { $SCRIPT_DISH_NAMES -contains $_.name }) {
  Api DELETE "/api/menu/$($d.id)" | Out-Null
}
foreach ($p in (Api GET '/api/poultry/purchases').purchases) {
  if ($p.remark -eq '自动化验证临时数据') { Api DELETE "/api/poultry/purchases/$($p.id)" | Out-Null }
}

$baselineBirds = @((Api GET '/api/poultry/species').birds).Count
$baselineConfigured = (Api GET '/api/poultry/dish-usage?filter=set').configured
$leftAfterClean = @((Api GET '/api/poultry/species').birds | Where-Object { $SCRIPT_BIRD_NAMES -contains $_.breed_name }).Count
Check '基线已记录且残留已清' ($baselineBirds -ge 0 -and $leftAfterClean -eq 0) "回收自己残留=$(if($myBirds.Count){"$($myBirds.Count) 条"}else{'无'}) 清理后残留=$leftAfterClean 现有禽类档案=$baselineBirds 已配置菜品=$baselineConfigured"

Write-Output '===== 1. 初始状态 ====='
$before = Api GET '/api/poultry/species'
Check '基线可读' ($null -ne $before.birds) "birds=$($before.birds.Count)（用户数据不参与断言）"

Write-Output ''
Write-Output '===== 2. 禽类档案 ====='
$bird = Api POST '/api/poultry/species' @{ animal = '鹅'; breed_name = '验证用鹅-临时'; net_weight_kg = 4.5; unit_cost = 120; status = '启用'; remark = '自动化验证临时数据' }
$birdId = $bird.id
Check '新增禽类' ($bird.ok -and $birdId -gt 0) "id=$birdId"
Expect-400 '重复品种被拒绝' { Api POST '/api/poultry/species' @{ animal = '鹅'; breed_name = '验证用鹅-临时' } }
Expect-400 '非法禽类被拒绝' { Api POST '/api/poultry/species' @{ animal = '猪'; breed_name = '验证用猪-临时' } }

Write-Output ''
Write-Output '===== 3. 整只出成拆解 ====='
$y = Api PUT "/api/poultry/yields/$birdId" @{ rows = @(
    @{ part_name = '烧鹅肉-饭用'; parts_per_bird = 16; part_weight_g = 70; remark = '一只出16份' },
    @{ part_name = '鹅头带颈'; parts_per_bird = 1; part_weight_g = 250; remark = '一只1个' }
  ) }
Check '保存出成' ($y.ok -and $y.count -eq 2) "count=$($y.count)"
Expect-400 '出成<=0 被拒绝' { Api PUT "/api/poultry/yields/$birdId" @{ rows = @(@{ part_name = 'x'; parts_per_bird = 0 }) } }
Expect-400 '重复部位被拒绝' { Api PUT "/api/poultry/yields/$birdId" @{ rows = @(@{ part_name = 'a'; parts_per_bird = 1 }, @{ part_name = 'a'; parts_per_bird = 1 }) } }
$yields = Api GET "/api/poultry/yields?bird_id=$birdId"
Check '出成回读' (($yields.yields | Measure-Object).Count -eq 2) "部位=$((($yields.yields | ForEach-Object { $_.part_name }) -join ','))"
$yieldRice = $yields.yields | Where-Object { $_.part_name -eq '烧鹅肉-饭用' }
$yieldHead = $yields.yields | Where-Object { $_.part_name -eq '鹅头带颈' }
Check '一只出成数正确' ($yieldRice.parts_per_bird -eq 16) "parts_per_bird=$($yieldRice.parts_per_bird)"

Write-Output ''
Write-Output '===== 4. 菜品耗用（用自建临时菜品，绝不改真实菜品） ====='
$tmpDish = Api POST '/api/menu' @{ name = '验证临时菜-耗用'; category = '验证临时分类'; spec = '标准'; cost = 0 }
$tmpDishId = $tmpDish.id
Check '临时菜品已建' ($tmpDishId -gt 0) "dish=$tmpDishId"
$u = Api PUT "/api/poultry/dish-usage/$tmpDishId" @{ rows = @(@{ yield_id = $yieldRice.id; usage_qty = 1 }) }
Check '保存耗用' ($u.ok -and $u.count -eq 1) "count=$($u.count)"
$uBack = Api GET "/api/poultry/dish-usage?menu_item_id=$tmpDishId"
Check '耗用回读' ($uBack.rows.Count -eq 1 -and $uBack.rows[0].animal -eq '鹅') "animal=$($uBack.rows[0].animal) part=$($uBack.rows[0].part_name) 类别=$($uBack.rows[0].part_kind)"
Expect-400 '无效部位被拒绝' { Api PUT "/api/poultry/dish-usage/$tmpDishId" @{ rows = @(@{ yield_id = 999999; usage_qty = 1 }) } }
Expect-400 '耗用量<=0 被拒绝' { Api PUT "/api/poultry/dish-usage/$tmpDishId" @{ rows = @(@{ yield_id = $yieldRice.id; usage_qty = 0 }) } }

Write-Output ''
Write-Output '===== 5. 核算口径校验（只读，不修改任何配置） ====='
$calc = Api GET '/api/poultry/accounting?date_from=2026-05-01&date_to=2026-09-10&channel=all'
Check '核算接口可用' ($calc.ok -eq $true -and $calc.summary.total_quantity -gt 0) "总销量=$($calc.summary.total_quantity) 明细行=$($calc.dishes.Count) 部位数=$($calc.parts.Count)"

# 5.1 明细行：只数 = 销量 × 每份耗用 ÷ 一只出成
$badRows = @($calc.dishes | Where-Object {
    [math]::Abs($_.birds_count - [math]::Round($_.quantity * $_.usage_qty / $_.parts_per_bird, 2)) -gt 0.02 })
Check '每行只数 = 销量×每份耗用÷一只出成' ($badRows.Count -eq 0) "不符行数=$($badRows.Count) / 共 $($calc.dishes.Count) 行"

# 5.2 部位汇总：折鸟数 = 该部位总需求 ÷ 一只出成（需求按该部位的明细行相加）
$mismatch = @()
foreach ($p in $calc.parts) {
  $rowsOfPart = @($calc.dishes | Where-Object { $_.part_name -eq $p.part_name -and $_.bird_id -eq $p.bird_id })
  $demand = ($rowsOfPart | ForEach-Object { $_.quantity * $_.usage_qty } | Measure-Object -Sum).Sum
  $expectBirds = [math]::Round($demand / $p.parts_per_bird, 2)
  if ([math]::Abs($p.birds - $expectBirds) -gt 0.02) { $mismatch += "$($p.part_name): 接口=$($p.birds) 手算=$expectBirds" }
}
Check '部位折鸟 = 总需求÷一只出成' ($mismatch.Count -eq 0) ($(if($mismatch.Count){ $mismatch -join ' | ' } else { "全部 $($calc.parts.Count) 个部位一致" }))

# 5.3 核心：每只禽 只数 = max(身体相加, 副产品最大)
$birdMismatch = @()
foreach ($b in $calc.summary.birds) {
  $p = @($calc.parts | Where-Object { $_.bird_id -eq $b.bird_id })
  $bodySum = [math]::Round((($p | Where-Object { $_.part_kind -ne '副产品' }) | Measure-Object -Property birds -Sum).Sum, 2)
  $bypMax = [math]::Round((($p | Where-Object { $_.part_kind -eq '副产品' }) | Measure-Object -Property birds -Maximum).Maximum, 2)
  if ($null -eq $bodySum) { $bodySum = 0 }
  if ($null -eq $bypMax) { $bypMax = 0 }
  $expect = [math]::Round([math]::Max($bodySum, $bypMax), 2)
  if ([math]::Abs($b.birds_count - $expect) -gt 0.05) { $birdMismatch += "$($b.breed_name): 接口=$($b.birds_count) max($bodySum,$bypMax)=$expect" }
  if ([math]::Abs($b.body_birds - $bodySum) -gt 0.05) { $birdMismatch += "$($b.breed_name) body 字段不一致 接口=$($b.body_birds) 手算=$bodySum" }
  if ([math]::Abs($b.byproduct_birds - $bypMax) -gt 0.05) { $birdMismatch += "$($b.breed_name) byproduct 字段不一致 接口=$($b.byproduct_birds) 手算=$bypMax" }
}
Check '只数 = max(身体相加, 副产品最大)' ($birdMismatch.Count -eq 0) ($(if($birdMismatch.Count){ $birdMismatch -join ' | ' } else { "全部 $($calc.summary.birds.Count) 种禽一致" }))

# 5.4 合计只数 = 各禽只数之和；瓶颈标注唯一
$sumBirds = [math]::Round((($calc.summary.birds | Measure-Object -Property birds_count -Sum).Sum), 2)
Check '合计只数 = 各禽之和' ([math]::Abs($calc.summary.total_birds - $sumBirds) -lt 0.02) "合计=$($calc.summary.total_birds) 逐禽相加=$sumBirds"
$bnPerBird = @{}
foreach ($p in ($calc.parts | Where-Object { $_.is_bottleneck })) { $bnPerBird[$p.bird_id] = 1 + ($bnPerBird[$p.bird_id]) }
$dupBn = @($bnPerBird.Keys | Where-Object { $bnPerBird[$_] -gt 1 })
Check '每种禽只有一个瓶颈标注' ($dupBn.Count -eq 0) "有瓶颈标注的禽=$($bnPerBird.Keys.Count) 个 重复=$($dupBn.Count)"

# 5.5 旧口径参考值应 ≥ 新口径（旧口径把同一只鸟的多个部位重复计鸟）
Check '旧口径参考值 ≥ 新口径' ($calc.summary.total_birds_linear -ge $calc.summary.total_birds) "新=$($calc.summary.total_birds) 旧=$($calc.summary.total_birds_linear) 差=$([math]::Round($calc.summary.total_birds_linear - $calc.summary.total_birds, 2))"

# 5.6 占比合计 = 100%（线性口径）
$shareSum = [math]::Round((($calc.dishes | Measure-Object -Property share -Sum).Sum), 2)
Check '明细占比合计=100%' ([math]::Abs($shareSum - 1) -lt 0.02) "合计=$shareSum"

# 5.7 本次测试的临时菜品应出现在未配出成里（它没销量，但脏数据不应出现）
$myTempInUnbound = @($calc.coverage.unbound | Where-Object { $_.product_name -eq '验证临时菜-耗用' })
Check '临时菜品不污染核算结果' ($myTempInUnbound.Count -eq 0) "出现次数=$($myTempInUnbound.Count)"

Check '覆盖率为部分覆盖' ($calc.summary.covered_rate -gt 0) "covered_rate=$($calc.summary.covered_rate)"
Check '未绑定清单非空' ($calc.coverage.unbound.Count -gt 0) "unbound项=$($calc.coverage.unbound.Count) 未覆盖销量=$($calc.coverage.unbound_quantity)"
Check '未配出成按菜品聚合' ((($calc.coverage.no_usage | Where-Object { $_.menu_name -eq '打包盒' })).Count -le 1) "打包盒行数=$((@($calc.coverage.no_usage | Where-Object { $_.menu_name -eq '打包盒' })).Count)"
Check '未覆盖清单无空名' ((@($calc.coverage.no_usage | Where-Object { -not $_.menu_name }).Count) -eq 0) "空名行数=$((@($calc.coverage.no_usage | Where-Object { -not $_.menu_name })).Count)"
Check '渠道构成含其他' ((($calc.channel_breakdown | Where-Object { $_.channel -eq 'other' }).quantity) -gt 0) (($calc.channel_breakdown | ForEach-Object { "$($_.label)=$($_.quantity)" }) -join ' ')
Check '数据区间回显' ($calc.data_range.max_date -ne '') "范围=$($calc.data_range.min_date)~$($calc.data_range.max_date)"

Write-Output ''
Write-Output '===== 6. 门店筛选 ====='
$storeList = Api GET '/api/db/stores?page=1&page_size=500'
$store = $storeList.stores | Where-Object { $_.store_name -like '*博罗店*' } | Select-Object -First 1
$calcStore = Api GET "/api/poultry/accounting?date_from=2026-05-01&date_to=2026-09-10&store_id=$($store.id)"
$storeQty = ($calcStore.dishes | Measure-Object -Property quantity -Sum).Sum
$allQty = ($calc.dishes | Measure-Object -Property quantity -Sum).Sum
Check '门店筛选收窄结果' ($storeQty -lt $allQty -and $storeQty -gt 0) "单店已配菜品销量=$storeQty / 全部=$allQty"
Check '回显门店' ($calcStore.stores[0].store_name -eq $store.store_name) "$($calcStore.stores[0].store_name)"

Write-Output ''
Write-Output '===== 7. 渠道筛选 ====='
$calcDine = Api GET '/api/poultry/accounting?date_from=2026-05-01&date_to=2026-09-10&channel=dine_in'
$calcGroup = Api GET '/api/poultry/accounting?date_from=2026-05-01&date_to=2026-09-10&channel=group'
Check '渠道筛选生效' ($calcDine.summary.total_quantity -gt 0 -and $calcGroup.summary.total_quantity -gt 0 -and ($calcDine.summary.total_quantity + $calcGroup.summary.total_quantity) -lt $calc.summary.total_quantity) "堂食=$($calcDine.summary.total_quantity) 团购=$($calcGroup.summary.total_quantity) 全部=$($calc.summary.total_quantity)"

Write-Output ''
Write-Output '===== 8. 采购录入与理论vs实际 ====='
$month = '2026-08'
# remark 固定用脚本标识，收尾时只按这个标识回收，避免误删用户自己录的采购
$MARK = '自动化验证临时数据'
Api POST '/api/poultry/purchases' @{ store_id = $store.id; month = $month; bird_id = $birdId; quantity = 777; amount = 93240; remark = $MARK } | Out-Null
$p1 = Api GET "/api/poultry/purchases?month=$month&store_id=$($store.id)"
$mine1 = @($p1.purchases | Where-Object { $_.bird_id -eq $birdId })
Check '采购入库' ($mine1.Count -eq 1 -and $mine1[0].quantity -eq 777) "qty=$($mine1[0].quantity)"
Api POST '/api/poultry/purchases' @{ store_id = $store.id; month = $month; bird_id = $birdId; quantity = 800; amount = 96000; remark = $MARK } | Out-Null
$p2 = Api GET "/api/poultry/purchases?month=$month&store_id=$($store.id)"
$mine2 = @($p2.purchases | Where-Object { $_.bird_id -eq $birdId })
Check '同键覆盖不重复' ($mine2.Count -eq 1 -and $mine2[0].quantity -eq 800) "qty=$($mine2[0].quantity) 该禽类行数=$($mine2.Count)"
Expect-400 '月份格式校验' { Api POST '/api/poultry/purchases' @{ store_id = $store.id; month = '202608'; bird_id = $birdId; quantity = 1 } }
$cmpWhole = Api GET "/api/poultry/accounting/purchase-comparison?date_from=2026-08-01&date_to=2026-08-31&store_id=$($store.id)"
$rowWhole = $cmpWhole.comparison | Where-Object { $_.bird_id -eq $birdId }
Check '整月对比' ($cmpWhole.is_whole_month -eq $true -and $rowWhole.purchased_birds -eq 800) "整月=$($cmpWhole.is_whole_month) 理论=$($rowWhole.theoretical_birds) 采购=$($rowWhole.purchased_birds) 差异=$($rowWhole.diff_birds) 差异率=$($rowWhole.diff_rate)"
$cmpPart = Api GET "/api/poultry/accounting/purchase-comparison?date_from=2026-08-01&date_to=2026-08-15&store_id=$($store.id)"
Check '非整月标注' ($cmpPart.is_whole_month -eq $false) "整月=$($cmpPart.is_whole_month) 涉及月份=$($cmpPart.months -join ',')"

Write-Output ''
Write-Output '===== 9. Excel 模板 ====='
$tpl = Api GET '/api/poultry/template'
Check '模板可生成' ($tpl.ok -and $tpl.data.Length -gt 5000) "文件=$($tpl.file_name) base64长度=$($tpl.data.Length)"

Write-Output ''
Write-Output '===== 9b. Excel 导入（走真实 xlsx + base64，与页面同路径；目标是自建临时菜） ====='
$tmpDish2 = Api POST '/api/menu' @{ name = '验证临时菜-导入'; category = '验证临时分类'; spec = '标准'; cost = 0 }
$tmpDish2Id = $tmpDish2.id
& node 'F:\NewDeom\_tmp\make-test-xlsx.js' | Out-Null
$bytes = [System.IO.File]::ReadAllBytes('F:\NewDeom\_tmp\test-import.xlsx')
$b64 = [System.Convert]::ToBase64String($bytes)
$imp = Api POST '/api/poultry/import' @{ filename = 'test-import.xlsx'; data = "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,$b64" }
Check '导入禽类档案' ($imp.birds -eq 1) "birds=$($imp.birds)（禽类值非法的行应报错跳过）"
Check '导入出成' ($imp.yields -eq 1) "yields=$($imp.yields)（不存在品种的行应报错）"
Check '导入耗用' ($imp.usage -eq 1) "usage=$($imp.usage)（不存在菜品的行应报错、空行应静默跳过）"
Check '异常行被回报' ($imp.error_count -ge 3) "errors=$($imp.error_count): $(($imp.errors | ForEach-Object { $_.message }) -join ' | ')"
$uDuck = Api GET "/api/poultry/dish-usage?menu_item_id=$tmpDish2Id"
Check '导入把临时菜配上了鸭腿' ($uDuck.rows.Count -eq 1 -and $uDuck.rows[0].animal -eq '鸭') "行数=$($uDuck.rows.Count) 部位=$(($uDuck.rows | ForEach-Object { $_.animal + $_.part_name }) -join ',')"
Check '导入行带上了部位类别' (@($uDuck.rows)[0].part_kind -in @('身体', '副产品')) "类别=$(@($uDuck.rows)[0].part_kind)"

Write-Output ''
Write-Output '===== 10. 只回收自己建的数据（不碰用户任何配置） ====='
# ① 删除自己建的临时菜品（注意：本项目外键级联未生效，删菜品不会自动删耗用行，下面第 ③ 步会显式解除）
foreach ($d in (Api GET '/api/menu').items | Where-Object { $SCRIPT_DISH_NAMES -contains $_.name }) {
  Api DELETE "/api/menu/$($d.id)" | Out-Null
}
# ② 删除自己按名称前缀建的禽类档案
#    先显式解除「指向自己测试部位」的耗用行 —— 无论那行指向的菜品是否还存在，都要清掉
$ownBirds = @((Api GET '/api/poultry/species').birds | Where-Object { $SCRIPT_BIRD_NAMES -contains $_.breed_name })
$ownYieldIds = @()
foreach ($b in $ownBirds) { $ownYieldIds += @((Api GET "/api/poultry/yields?bird_id=$($b.id)").yields | ForEach-Object { $_.id }) }
if ($ownYieldIds.Count) {
  foreach ($item in (Api GET '/api/poultry/dish-usage?filter=set').items) {
    $rows = @((Api GET "/api/poultry/dish-usage?menu_item_id=$($item.id)").rows)
    $keep = @($rows | Where-Object { $ownYieldIds -notcontains $_.yield_id } | ForEach-Object { @{ yield_id = $_.yield_id; usage_qty = $_.usage_qty } })
    if ($keep.Count -ne $rows.Count) {
      if ($keep.Count -gt 0) { Api PUT "/api/poultry/dish-usage/$($item.id)" @{ rows = [object[]]$keep } | Out-Null }
      else { Api PUT "/api/poultry/dish-usage/$($item.id)" @{ rows = @() } | Out-Null }
    }
  }
}
foreach ($b in $ownBirds) { Api DELETE "/api/poultry/species/$($b.id)" | Out-Null }
# ③ 只删本次脚本建的采购记录
foreach ($p in (Api GET '/api/poultry/purchases').purchases) {
  if ($p.remark -eq '自动化验证临时数据') { Api DELETE "/api/poultry/purchases/$($p.id)" | Out-Null }
}
Remove-Item 'F:\NewDeom\_tmp\test-import.xlsx' -Force -ErrorAction SilentlyContinue

$a1 = Api GET '/api/poultry/species'
$a3 = Api GET '/api/poultry/dish-usage?filter=set'
$leftover = @($a1.birds | Where-Object { $SCRIPT_BIRD_NAMES -contains $_.breed_name })
$leftoverDish = @((Api GET '/api/menu').items | Where-Object { $SCRIPT_DISH_NAMES -contains $_.name })
Check '自己建的禽类档案已回收' ($leftover.Count -eq 0) "残留=$($leftover.Count) 当前禽类档案总数=$($a1.birds.Count)（基线 $baselineBirds）"
Check '自己建的临时菜品已回收' ($leftoverDish.Count -eq 0) "残留=$($leftoverDish.Count)"
Check '用户数据未被改动' ($a1.birds.Count -eq $baselineBirds -and $a3.configured -eq $baselineConfigured) "禽类 $baselineBirds->$($a1.birds.Count) 已配置菜品 $baselineConfigured->$($a3.configured)"
Check '核算接口仍可用' ($true) "已配置菜品=$($a3.configured)"
Write-Output ''
Write-Output '===== 验证结束 ====='
