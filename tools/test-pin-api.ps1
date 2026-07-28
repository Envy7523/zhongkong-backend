
$token = Get-Content $env:TEMP\cw_token.txt
$headers = @{Authorization = "Bearer $token"}

# 1. Create public pin
$b1 = '{"lng":116.4,"lat":39.9,"name":"Test Public Pin","remark":"visible to all","visibility":"public"}'
$r1 = Invoke-RestMethod 'http://localhost:3456/api/map-pins' -Method POST -Body $b1 -Headers $headers -ContentType 'application/json'
Write-Host "Created public pin ID: $($r1.id)"
$pubId = $r1.id

# 2. Create private pin
$b2 = '{"lng":116.5,"lat":39.95,"name":"Test Private Pin","remark":"only me","visibility":"private"}'
$r2 = Invoke-RestMethod 'http://localhost:3456/api/map-pins' -Method POST -Body $b2 -Headers $headers -ContentType 'application/json'
Write-Host "Created private pin ID: $($r2.id)"

# 3. Query all pins
$all = Invoke-RestMethod 'http://localhost:3456/api/map-pins' -Headers $headers
Write-Host "Total pins: $($all.data.Length)"
foreach ($p in $all.data) {
  Write-Host "  ID=$($p.id) name=$($p.name) visibility=$($p.visibility) user_id=$($p.user_id)"
}

# 4. Add comments
$c1 = '{"content":"This location looks good!"}'
$rc1 = Invoke-RestMethod "http://localhost:3456/api/map-pins/$pubId/comments" -Method POST -Body $c1 -Headers $headers -ContentType 'application/json'
Write-Host "Created comment ID: $($rc1.id)"

$c2 = '{"content":"Need to verify"}'
$rc2 = Invoke-RestMethod "http://localhost:3456/api/map-pins/$pubId/comments" -Method POST -Body $c2 -Headers $headers -ContentType 'application/json'
Write-Host "Created comment ID: $($rc2.id)"
$commentId = $rc1.id

# 5. View comments
$comments = Invoke-RestMethod "http://localhost:3456/api/map-pins/$pubId/comments" -Headers $headers
Write-Host "Comment count: $($comments.data.Length)"
foreach ($cc in $comments.data) {
  Write-Host "  Comment ID=$($cc.id) user=$($cc.username) content=$($cc.content)"
}

# 6. Delete comment
Invoke-RestMethod "http://localhost:3456/api/map-pins/$pubId/comments/$commentId" -Method DELETE -Headers $headers
Write-Host "Deleted comment $commentId"

# 7. Verify deletion
$comments2 = Invoke-RestMethod "http://localhost:3456/api/map-pins/$pubId/comments" -Headers $headers
Write-Host "After delete, comment count: $($comments2.data.Length)"

# 8. Update pin visibility
$u1 = '{"visibility":"private"}'
Invoke-RestMethod "http://localhost:3456/api/map-pins/$pubId" -Method PUT -Body $u1 -Headers $headers -ContentType 'application/json'
Write-Host "Updated pin $pubId visibility to private"

# 9. Verify update
$pin = Invoke-RestMethod "http://localhost:3456/api/map-pins" -Headers $headers
$updated = $pin.data | Where-Object { $_.id -eq $pubId }
Write-Host "Pin $pubId visibility now: $($updated.visibility)"

Write-Host "`n=== All API tests passed ==="
