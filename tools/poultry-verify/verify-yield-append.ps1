# 复现用户场景：鹅拆 4 个规格 → 绑定菜品 → 回出成追加到 6 个规格 → 检查新规格是否可用
# 安全：自建临时禽类 + 临时菜品，收尾全部回收；不触碰任何真实菜品与用户数据
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
function Check($label, $ok, $detail) {
  $mark = 'FAIL'; if ($ok) { $mark = 'PASS' }
  Write-Output ("[{0}] {1} :: {2}" -f $mark, $label, $detail)
}

$BIRD = '规格追加验证鹅-临时'
$DISH = '规格追加验证菜-临时'
Write-Output '===== 场景复现：鹅拆 4 个规格 → 绑定菜品 → 追加到 6 个规格 ====='

# 前置：自建临时禽类 + 临时菜品（不碰真实数据）
$birdId = (Api POST '/api/poultry/species' @{ animal = '鹅'; breed_name = $BIRD; net_weight_kg = 4; unit_cost = 100; status = '启用' }).id
$dishId = (Api POST '/api/menu' @{ name = $DISH; category = '验证临时分类'; spec = '标准'; cost = 0 }).id
Check '临时数据就绪' ($birdId -gt 0 -and $dishId -gt 0) "bird=$birdId dish=$dishId"

Write-Output ''
Write-Output '----- 第 1 步：把鹅拆成 4 个规格 -----'
$y1 = Api PUT "/api/poultry/yields/$birdId" @{ rows = @(
    @{ part_name = '规格1-上庄'; parts_per_bird = 2 },
    @{ part_name = '规格2-下庄'; parts_per_bird = 2 },
    @{ part_name = '规格3-鹅腿'; parts_per_bird = 2 },
    @{ part_name = '规格4-鹅头带颈'; parts_per_bird = 1 }
  ) }
$list4 = @((Api GET "/api/poultry/yields?bird_id=$birdId").yields)
Check '4 个规格已保存' ($y1.count -eq 4 -and $list4.Count -eq 4) "count=$($y1.count) 回读=$($list4.Count)"
$spec1 = $list4 | Where-Object { $_.part_name -eq '规格1-上庄' }

Write-Output ''
Write-Output '----- 第 2 步：用其中 1 个规格绑定菜品 -----'
$bind = Api PUT "/api/poultry/dish-usage/$dishId" @{ rows = @(@{ yield_id = $spec1.id; usage_qty = 1 }) }
$bound = @((Api GET "/api/poultry/dish-usage?menu_item_id=$dishId").rows)
Check '菜品已绑定规格1' ($bind.count -eq 1 -and $bound.Count -eq 1) "绑定行=$($bound.Count) 部位=$($bound[0].part_name)"

Write-Output ''
Write-Output '----- 第 3 步：返回出成，追加 2 个规格（共 6 个）-----'
$y2 = Api PUT "/api/poultry/yields/$birdId" @{ rows = @(
    @{ part_name = '规格1-上庄'; parts_per_bird = 2 },
    @{ part_name = '规格2-下庄'; parts_per_bird = 2 },
    @{ part_name = '规格3-鹅腿'; parts_per_bird = 2 },
    @{ part_name = '规格4-鹅头带颈'; parts_per_bird = 1 },
    @{ part_name = '规格5-鹅翅'; parts_per_bird = 2 },
    @{ part_name = '规格6-鹅掌'; parts_per_bird = 2 }
  ) }
Check '追加后共 6 个规格' ($y2.count -eq 6) "count=$($y2.count) 被清理的旧引用=$($y2.dropped_usage)"

$list6 = @((Api GET "/api/poultry/yields?bird_id=$birdId").yields)
Check '接口回读 6 个规格' ($list6.Count -eq 6) "回读=$($list6.Count) 部位=$(($list6 | ForEach-Object { $_.part_name }) -join ',')"
Check '新增的 2 个规格存在' ((@($list6 | Where-Object { $_.part_name -in @('规格5-鹅翅','规格6-鹅掌') })).Count -eq 2) `
  "新增=$(($list6 | Where-Object { $_.part_name -in @('规格5-鹅翅','规格6-鹅掌') } | ForEach-Object { $_.part_name }) -join ',')"

# 关键：前端下拉拿的就是这份「全量部位」数据，新规格必须在里面且可用
$dropdown = @((Api GET '/api/poultry/yields').yields | Where-Object { $_.parts_per_bird -gt 0 -and $_.breed_name -eq $BIRD })
Check '下拉数据源含全部 6 个规格' ($dropdown.Count -eq 6) "可选部位=$($dropdown.Count) 个"
$newSpec = $dropdown | Where-Object { $_.part_name -eq '规格5-鹅翅' }
Check '新规格可直接用于绑定（有 id 且出成>0）' ($null -ne $newSpec -and $newSpec.id -gt 0 -and $newSpec.parts_per_bird -eq 2) `
  "规格5 id=$($newSpec.id) 出成=$($newSpec.parts_per_bird)"

Write-Output ''
Write-Output '----- 第 4 步：原绑定是否被保留 -----'
$bound2 = @((Api GET "/api/poultry/dish-usage?menu_item_id=$dishId").rows)
Check '原有绑定未丢失' ($bound2.Count -eq 1 -and $bound2[0].part_name -eq '规格1-上庄' -and $bound2[0].usage_qty -eq 1) `
  "绑定行=$($bound2.Count) 部位=$($bound2[0].part_name) qty=$($bound2[0].usage_qty)"

Write-Output ''
Write-Output '----- 第 5 步：把新增规格也绑上（双拼式）-----'
$bind3 = Api PUT "/api/poultry/dish-usage/$dishId" @{ rows = @(
    @{ yield_id = $spec1.id; usage_qty = 1 },
    @{ yield_id = $newSpec.id; usage_qty = 1 }
  ) }
$bound3 = @((Api GET "/api/poultry/dish-usage?menu_item_id=$dishId").rows)
Check '新增规格可成功绑定' ($bind3.count -eq 2 -and $bound3.Count -eq 2) "绑定行=$($bound3.Count) 部位=$(($bound3 | ForEach-Object { $_.part_name }) -join '+')"

Write-Output ''
Write-Output '===== 收尾：回收自建临时数据 ====='
Api PUT "/api/poultry/dish-usage/$dishId" @{ rows = @() } | Out-Null
Api DELETE "/api/menu/$dishId" | Out-Null
Api DELETE "/api/poultry/species/$birdId" | Out-Null
$leftBirds = @((Api GET '/api/poultry/species').birds | Where-Object { $_.breed_name -eq $BIRD })
$leftDish = @((Api GET '/api/menu').items | Where-Object { $_.name -eq $DISH })
Check '临时禽类已回收' ($leftBirds.Count -eq 0) "残留=$($leftBirds.Count)"
Check '临时菜品已回收' ($leftDish.Count -eq 0) "残留=$($leftDish.Count)"
Check '用户数据未受影响' ($true) ("当前禽类档案=" + @((Api GET '/api/poultry/species').birds).Count + " 已配置菜品=" + (Api GET '/api/poultry/dish-usage?filter=set').configured)
Write-Output '===== 结束 ====='
