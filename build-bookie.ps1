$ErrorActionPreference = 'Stop'

$sourcePath = Join-Path $PSScriptRoot 'qwantum-bookie.source.js'
$targetPath = Join-Path $PSScriptRoot 'qwantum-bookie.user.js'
$lines = Get-Content -LiteralPath $sourcePath
$compactLines = $lines |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_.Length -gt 0 }

Set-Content -LiteralPath $targetPath -Value $compactLines -Encoding utf8NoBOM

$bytes = (Get-Item -LiteralPath $targetPath).Length
Write-Output "Built qwantum-bookie.user.js ($bytes bytes)."
