$BASE = 'http://localhost:3001'
$tok_d = (curl.exe --% -s -X POST "$BASE/api/auth/login-password" -H "Content-Type: application/json" -d "{\"phone\":\"13700003001\",\"password\":\"123456\"}" | ConvertFrom-Json).data.token
$tok_i = (curl.exe --% -s -X POST "$BASE/api/auth/login-password" -H "Content-Type: application/json" -d "{\"phone\":\"13600004001\",\"password\":\"123456\"}" | ConvertFrom-Json).data.token

function Check($label, $tok, $path) {
  try {
    $json = curl.exe -s "$BASE$path" -H "Authorization: Bearer $tok" | ConvertFrom-Json
    $data = $json.data
    $shape = if ($null -eq $data) { 'null' }
             elseif ($data -is [array]) { "array(count=$($data.Count))" }
             elseif ($data.PSObject.Properties.Name -contains 'list') { "pagelist(total=$($data.total))" }
             else { "obj(keys=$($data.PSObject.Properties.Name -join ','))" }
    Write-Output "$label  code=$($json.code)  shape=$shape"
  } catch { Write-Output "$label  HTTP_ERR" }
}

Write-Output "=== Designer (tok=$($tok_d.Substring(0,20))...) ==="
Check "orders"      $tok_d "/api/designer/orders"
Check "finance"     $tok_d "/api/designer/earnings"
Check "withdraw"    $tok_d "/api/designer/withdraw-info"
Check "portfolio"   $tok_d "/api/designer/portfolio"
Check "hall"        $tok_d "/api/designer/hall"
Check "disputes"    $tok_d "/api/designer/disputes"

Write-Output ""
Write-Output "=== Installer (tok=$($tok_i.Substring(0,20))...) ==="
Check "orders"          $tok_i "/api/installer/orders"
Check "hall"            $tok_i "/api/installer/hall"
Check "warranty"        $tok_i "/api/installer/warranty-claims"
Check "earnings"        $tok_i "/api/installer/earnings"
Check "profile"         $tok_i "/api/installer/profile"
Check "disputes"        $tok_i "/api/installer/disputes"
