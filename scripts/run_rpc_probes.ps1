$ranges = @(1,5,10,50,100,500)
foreach ($r in $ranges) {
  Write-Output "`n=== RANGE=$r ==="
  $env:RANGE = $r
  node .\scripts\rpc_probe.js
  Start-Sleep -s 1
}
