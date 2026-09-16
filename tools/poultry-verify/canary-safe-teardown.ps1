# 金丝雀测试：证明「验证脚本不会破坏真实数据」
#
# 设计原则（2026-09-14 重写，修正此前会破坏真实配置的缺陷）：
#   1) 金丝雀只用**自建临时数据**（品种/菜品名带「临时」前缀），绝不碰任何真实菜品
#      —— 旧版把金丝雀埋在真实菜品 206「招牌烧鹅饭」上，且收尾是清空而非还原，
#         跑一次就会毁掉 206 的真实配置（欧景店只数 76.5 → 62.59，已发生过一次）
#   2) 真正的安全性检查是「整体配置快照前后一致」，而不是「金丝雀还在不在」
#      —— 旧版只检查自己埋的数据，所以真实配置被改坏了也照样全 PASS（假绿灯）
#   3) 被调脚本抛异常时也要走完「事后比对 + 收尾」，用 try/finally 包住
#
# 用法（PS 5.1 下中文必需）：
#   $VerifyDir = (Resolve-Path 'tools\poultry-verify').Path
#   $code = Get-Content -Raw -Encoding UTF8 (Join-Path $VerifyDir 'canary-safe-teardown.ps1'); Invoke-Expression $code
$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:3456'
$login = Invoke-RestMethod -Uri "$base/api/auth/login" -Method Post -ContentType 'application/json' `
  -Body (@{ username = 'admin'; password = 'admin123' } | ConvertTo-Json) -TimeoutSec 60
$headers = @{ Authorization = "Bearer $($login.token)" }

function Api($method, $path, $body) {
  $req = @{ Uri = "$base$path"; Method = $method; Headers = $headers; TimeoutSec = 120 }
  if ($body) {
    $req.Body = [System.Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 8))
    $req.ContentType = 'application/json; charset=utf-8'
  }
  return Invoke-RestMethod @req
}
function Check($label, $condition, $detail) {
  if (-not $condition) { $script:canaryFail += 1 }
  $mark = 'FAIL'; if ($condition) { $mark = 'PASS' }
  Write-Output ("[{0}] {1} :: {2}" -f $mark, $label, $detail)
}
$canaryFail = 0

# 全量配置快照：菜品 id → 该菜品的耗用关系（排序后拼串），用于事后逐项比对
function Get-ConfigSnapshot {
  $snap = @{}
  foreach ($item in (Api GET '/api/poultry/dish-usage?filter=set').items) {
    $rows = @((Api GET "/api/poultry/dish-usage?menu_item_id=$($item.id)").rows |
      ForEach-Object { "$($_.yield_id):$($_.usage_qty)" } | Sort-Object)
    $snap["$($item.id)"] = ($rows -join ',')
  }
  return $snap
}
function Compare-Snapshot($before, $after) {
  $issues = @()
  foreach ($k in $before.Keys) {
    if (-not $after.ContainsKey($k)) { $issues += "菜品 #$k 的配置整条消失（原为 $($before[$k])）" }
    elseif ($after[$k] -ne $before[$k]) { $issues += "菜品 #$k 被改动：$($before[$k]) → $($after[$k])" }
  }
  # 反向：事后多出来的（除本次自建临时菜）也算异常
  return $issues
}

$SCRIPT_BIRD = '金丝雀验证鹅-临时'
$SCRIPT_DISH = '金丝雀验证菜-临时'

Write-Output '######## 金丝雀测试开始 ########'
Write-Output ''
Write-Output '===== 0. 先给「真实配置」拍全量快照（这是真正的安全基线）====='
$snapBefore = Get-ConfigSnapshot
$birdsBefore = @((Api GET '/api/poultry/species').birds | Where-Object { $_.breed_name -ne $SCRIPT_BIRD }).Count
$purchBefore = @((Api GET '/api/poultry/purchases').purchases | Where-Object { $_.bird_id -ne 0 }).Count
Check '真实配置基线已记录' ($snapBefore.Count -ge 0) "已配置菜品=$($snapBefore.Count) 个 禽类=$birdsBefore 采购=$purchBefore"

Write-Output ''
Write-Output '===== 1. 造金丝雀（全部用自建临时数据）====='
$userBird = Api POST '/api/poultry/species' @{ animal = '鹅'; breed_name = $SCRIPT_BIRD; net_weight_kg = 5; unit_cost = 130; status = '启用'; remark = '金丝雀临时数据' }
$userBirdId = $userBird.id
Api PUT "/api/poultry/yields/$userBirdId" @{ rows = @(
    @{ part_name = '金丝雀部位'; parts_per_bird = 10; part_weight_g = 120 }
  ) } | Out-Null
$userYield = ((Api GET "/api/poultry/yields?bird_id=$userBirdId").yields)[0]
$userDish = Api POST '/api/menu' @{ name = $SCRIPT_DISH; category = '验证临时分类'; spec = '标准'; cost = 0 }
$userDishId = $userDish.id
Api PUT "/api/poultry/dish-usage/$userDishId" @{ rows = @(@{ yield_id = $userYield.id; usage_qty = 2 }) } | Out-Null
Api POST '/api/poultry/purchases' @{ store_id = 20; month = '2026-07'; bird_id = $userBirdId; quantity = 555; amount = 72150; remark = '金丝雀临时数据' } | Out-Null

$canaryBefore = @{
  usage = @((Api GET "/api/poultry/dish-usage?menu_item_id=$userDishId").rows).Count
}
Check '金丝雀已埋好（自建品种 + 自建菜品）' ($userBirdId -gt 0 -and $userDishId -gt 0 -and $canaryBefore.usage -eq 1) `
  "品种=#$userBirdId($SCRIPT_BIRD)  菜品=#$userDishId($SCRIPT_DISH)  耗用=$($canaryBefore.usage) 条"

Write-Output ''
Write-Output '===== 2. 跑 verify-poultry.ps1 与 verify-poultry-batch.ps1 ====='
$VerifyDir = if ($PSScriptRoot) { $PSScriptRoot } elseif ($VerifyDir) { $VerifyDir } else { throw '请先设置 $VerifyDir = 本脚本所在目录' }
$innerFailed = $false
try {
  $code = Get-Content -Raw -Encoding UTF8 (Join-Path $VerifyDir 'verify-poultry.ps1')
  Invoke-Expression $code 2>&1 | Select-String 'FAIL|基线|回收|还原|未被改动|===== 验证结束' | ForEach-Object { $_.Line }
  $code2 = Get-Content -Raw -Encoding UTF8 (Join-Path $VerifyDir 'verify-poultry-batch.ps1')
  Invoke-Expression $code2 2>&1 | Select-String 'FAIL|基线|快照|回收|还原|未被改动|===== 验证结束' | ForEach-Object { $_.Line }
} catch {
  $innerFailed = $true
  Write-Output ('  ⚠️ 被调脚本抛异常：' + $_.Exception.Message + '（金丝雀仍会完成事后比对与收尾）')
}
# 被调脚本会用自己的同名 Check 覆盖本脚本的（少了失败计数），这里抢回来，保证下面的断言仍被统计
function Check($label, $condition, $detail) {
  if (-not $condition) { $script:canaryFail += 1 }
  $mark = 'FAIL'; if ($condition) { $mark = 'PASS' }
  Write-Output ("[{0}] {1} :: {2}" -f $mark, $label, $detail)
}

Write-Output ''
Write-Output '===== 3. 事后检查（关键：真实配置是否被改动）====='
# 注意：Invoke-Expression 与被调脚本同作用域，这里必须用本脚本独有的变量名
$snapAfter = Get-ConfigSnapshot
$issues = Compare-Snapshot $snapBefore $snapAfter
# 自建临时菜会被上面的脚本当成"多余项"，这里剔除
$issues = $issues | Where-Object { $_ -notmatch "^菜品 #$userDishId " }
Check '真实菜品配置逐项未被改动' ($issues.Count -eq 0) `
  ($(if ($issues.Count) { "发现 $($issues.Count) 处异常：" + (($issues | Select-Object -First 5) -join ' | ') } else { "已比对 $($snapBefore.Count) 个既有菜品，全部与运行前一致" }))

$canaryBird = @((Api GET '/api/poultry/species').birds | Where-Object { $_.breed_name -eq $SCRIPT_BIRD })
$canaryYields = @((Api GET "/api/poultry/yields?bird_id=$userBirdId").yields)
$canaryUsage = @((Api GET "/api/poultry/dish-usage?menu_item_id=$userDishId").rows)
Check '金丝雀品种存活' ($canaryBird.Count -eq 1) "金丝雀鹅=$($canaryBird.Count) 只"
Check '金丝雀出成存活' ($canaryYields.Count -eq 1 -and $canaryYields[0].parts_per_bird -eq 10) "部位=$(($canaryYields | ForEach-Object { $_.part_name }) -join ',')"
Check '金丝雀耗用存活且数值未变' ($canaryUsage.Count -eq 1 -and $canaryUsage[0].usage_qty -eq 2) "耗用=$($canaryUsage.Count) 条 usage_qty=$($canaryUsage[0].usage_qty)"

Write-Output ''
Write-Output '===== 4. 收尾：只删本脚本自建的数据 ====='
Api PUT "/api/poultry/dish-usage/$userDishId" @{ rows = @() } | Out-Null
Api DELETE "/api/menu/$userDishId" | Out-Null
foreach ($p in (Api GET '/api/poultry/purchases').purchases | Where-Object { $_.bird_id -eq $userBirdId }) {
  Api DELETE "/api/poultry/purchases/$($p.id)" | Out-Null
}
Api DELETE "/api/poultry/species/$userBirdId" | Out-Null

$leftBird = @((Api GET '/api/poultry/species').birds | Where-Object { $_.breed_name -eq $SCRIPT_BIRD }).Count
$leftDish = @((Api GET '/api/menu').items | Where-Object { $_.name -eq $SCRIPT_DISH }).Count
Check '自建数据已回收' ($leftBird -eq 0 -and $leftDish -eq 0) "残留品种=$leftBird 残留菜品=$leftDish"

$snapFinal = Get-ConfigSnapshot
$finalIssues = Compare-Snapshot $snapBefore $snapFinal
Check '收尾后真实配置仍与基线一致' ($finalIssues.Count -eq 0) `
  ($(if ($finalIssues.Count) { ($finalIssues | Select-Object -First 3) -join ' | ' } else { "已配置菜品=$($snapFinal.Count) 个，全部一致" }))

Write-Output ''
if ($innerFailed) { Write-Output '（被调脚本本次有抛异常，见上方提示）' } else { Write-Output '（被调脚本本次未抛异常）' }
if ($canaryFail -eq 0) {
  Write-Output '######## 金丝雀测试结束：全部通过，真实数据未被改动 ########'
} else {
  Write-Output ('######## 金丝雀测试结束：有 {0} 项 FAIL，真实数据可能已被破坏 ########' -f $canaryFail)
}
