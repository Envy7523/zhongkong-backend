# 金丝雀测试：先造一份「用户数据」，再跑两个验证脚本，证明它们不再误删
# 用法：pwsh 里 Invoke-Expression 读取本文件执行
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
  $mark = 'FAIL'; if ($condition) { $mark = 'PASS' }
  Write-Output ("[{0}] {1} :: {2}" -f $mark, $label, $detail)
}

Write-Output '######## 金丝雀测试开始 ########'
Write-Output ''
Write-Output '===== 造「用户数据」：1 只鹅 + 出成 + 挂在 206 上的耗用 + 1 条采购 ====='
$userBird = Api POST '/api/poultry/species' @{ animal = '鹅'; breed_name = '用户金丝雀鹅'; net_weight_kg = 5; unit_cost = 130; status = '启用'; remark = '由用户手工录入' }
$userBirdId = $userBird.id
Api PUT "/api/poultry/yields/$userBirdId" @{ rows = @(
    @{ part_name = '金丝雀部位'; parts_per_bird = 10; part_weight_g = 120 }
  ) } | Out-Null
$userYield = ((Api GET "/api/poultry/yields?bird_id=$userBirdId").yields)[0]
Api PUT '/api/poultry/dish-usage/206' @{ rows = @(@{ yield_id = $userYield.id; usage_qty = 2 }) } | Out-Null
$userPurchase = @{ store_id = 20; month = '2026-07'; bird_id = $userBirdId; quantity = 555; amount = 72150; remark = '用户手工录入' }
Api POST '/api/poultry/purchases' $userPurchase | Out-Null

$canaryBefore = @{
  birds = @((Api GET '/api/poultry/species').birds).Count
  configured = (Api GET '/api/poultry/dish-usage?filter=set').configured
  purchases = @((Api GET '/api/poultry/purchases').purchases).Count
  usage206 = @((Api GET '/api/poultry/dish-usage?menu_item_id=206').rows).Count
}
Check '金丝雀已埋好' ($canaryBefore.birds -ge 1 -and $canaryBefore.usage206 -eq 1 -and $canaryBefore.purchases -ge 1) `
  "禽类=$($canaryBefore.birds) 已配置菜品=$($canaryBefore.configured) 采购=$($canaryBefore.purchases) 206耗用=$($canaryBefore.usage206) 条"

Write-Output ''
Write-Output '===== 跑 verify-poultry.ps1 ====='
$code = Get-Content -Raw -Encoding UTF8 'F:\NewDeom\_tmp\verify-poultry.ps1'
Invoke-Expression $code 2>&1 | Select-String 'FAIL|基线|回收|还原|未被改动|===== 验证结束' | ForEach-Object { $_.Line }

Write-Output ''
Write-Output '===== 跑 verify-poultry-batch.ps1 ====='
$code2 = Get-Content -Raw -Encoding UTF8 'F:\NewDeom\_tmp\verify-poultry-batch.ps1'
Invoke-Expression $code2 2>&1 | Select-String 'FAIL|基线|快照|回收|还原|未被改动|===== 验证结束' | ForEach-Object { $_.Line }

Write-Output ''
Write-Output '===== 金丝雀存活检查 ====='
# 注意：Invoke-Expression 与被调脚本同作用域，这里必须用本脚本独有的变量名，
# 否则会被验证脚本里的同名变量覆盖。
$canaryAfter = @{
  birds = @((Api GET '/api/poultry/species').birds).Count
  configured = (Api GET '/api/poultry/dish-usage?filter=set').configured
  purchases = @((Api GET '/api/poultry/purchases').purchases).Count
  usage206 = @((Api GET '/api/poultry/dish-usage?menu_item_id=206').rows).Count
}
$canaryBird = @((Api GET '/api/poultry/species').birds | Where-Object { $_.breed_name -eq '用户金丝雀鹅' })
$canaryYields = @((Api GET "/api/poultry/yields?bird_id=$userBirdId").yields)
$canaryPurchase = @((Api GET '/api/poultry/purchases').purchases | Where-Object { $_.bird_id -eq $userBirdId })
$canaryUsage = @((Api GET '/api/poultry/dish-usage?menu_item_id=206').rows)

Check '禽类档案存活' ($canaryBird.Count -eq 1) "金丝雀鹅=$($canaryBird.Count) 只（remark=$($canaryBird[0].remark)）"
Check '出成拆解存活' ($canaryYields.Count -eq 1 -and $canaryYields[0].parts_per_bird -eq 10) "部位=$(($canaryYields | ForEach-Object { $_.part_name }) -join ',') 出成=$(($canaryYields | ForEach-Object { $_.parts_per_bird }) -join ',')"
Check '菜品耗用存活且数值未变' ($canaryUsage.Count -eq 1 -and $canaryUsage[0].yield_id -eq $userYield.id -and $canaryUsage[0].usage_qty -eq 2) "206 耗用=$($canaryUsage.Count) 条 usage_qty=$($canaryUsage[0].usage_qty)（原为 2）"
Check '采购记录存活' ($canaryPurchase.Count -eq 1 -and $canaryPurchase[0].quantity -eq 555) "qty=$($canaryPurchase[0].quantity)（原为 555）"
Check '用户数据总量未变' ($canaryBefore.birds -eq $canaryAfter.birds -and $canaryBefore.purchases -eq $canaryAfter.purchases -and $canaryBefore.usage206 -eq $canaryAfter.usage206) `
  "禽类 $($canaryBefore.birds)->$($canaryAfter.birds) 采购 $($canaryBefore.purchases)->$($canaryAfter.purchases) 206耗用 $($canaryBefore.usage206)->$($canaryAfter.usage206)"

Write-Output ''
Write-Output '===== 收尾：只删金丝雀 ====='
Api PUT '/api/poultry/dish-usage/206' @{ rows = @() } | Out-Null
foreach ($p in $canaryPurchase) { Api DELETE "/api/poultry/purchases/$($p.id)" | Out-Null }
Api DELETE "/api/poultry/species/$userBirdId" | Out-Null
Check '金丝雀已清干净' (((Api GET '/api/poultry/species').birds.Count) -eq 0 -and ((Api GET '/api/poultry/dish-usage?filter=set').configured) -eq 0 -and ((Api GET '/api/poultry/purchases').purchases.Count) -eq 0) `
  "禽类=$((Api GET '/api/poultry/species').birds.Count) 已配置=$((Api GET '/api/poultry/dish-usage?filter=set').configured) 采购=$((Api GET '/api/poultry/purchases').purchases.Count)"
Write-Output '######## 金丝雀测试结束 ########'
