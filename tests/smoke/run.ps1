# Smoke test (Windows): open a document in a debug build, drive the UI, then check what was written to disk.
# Build first with: npx tauri build --debug --no-bundle
#
# 两段：
#   1. sample.md —— 编辑、公式、表格、代码块、保存
#   2. untidy.md —— 「一键整理」：悬浮按钮出现、点它、结果落盘且文字一个都没少
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '../..')
$bin = Join-Path $root 'src-tauri/target.noindex/debug/mdpad.exe'
$work = Join-Path ([IO.Path]::GetTempPath()) "mdpad-smoke-$PID"
Copy-Item -Recurse (Join-Path $root 'tests/smoke') $work

function Invoke-App { # Invoke-App <文档> <测试脚本> <日志名>
  param($Doc, $Scenario, $Name)
  $log = Join-Path $work "$Name.txt"
  $env:MDPAD_DATA_DIR = Join-Path $work ".data-$Name"
  $env:MDPAD_TEST_JS = Get-Content -Raw -Encoding UTF8 (Join-Path $root "tests/smoke/$Scenario")
  $app = Start-Process -FilePath $bin -ArgumentList "`"$Doc`"" -RedirectStandardError $log -PassThru
  if (-not $app.WaitForExit(90000)) { $app.Kill(); Write-Host 'Timed out' }
  Get-Content -Encoding UTF8 $log
  return (Get-Content -Raw -Encoding UTF8 $log)
}

Write-Host '=== 1. 打开、编辑、保存 ==='
$doc = Join-Path $work 'sample.md'
$output = Invoke-App $doc 'test.js' 'log'
$saved = Get-Content -Raw -Encoding UTF8 $doc
if ($output -match 'loaded=true' -and $output -match '"katex":true' -and
    $output -match '"status":"已保存"' -and $output -match '"headingMarkers":\["# "\]' -and $saved -match '新增的文字') {
  Write-Host 'PASS'
} else {
  Write-Host 'FAIL'
  exit 1
}

Write-Host ''
Write-Host '=== 2. 一键整理 ==='
$untidy = Join-Path $work 'untidy.md'
$tidyOut = Invoke-App $untidy 'tidy-test.js' 'tidy-log'
$tidySaved = Get-Content -Raw -Encoding UTF8 $untidy
if ($tidyOut -match '"appeared":true' -and $tidyOut -match '"busySeen":true' -and
    $tidySaved -match '(?m)^# 项目周报\r?$' -and $tidySaved -match '(?m)^## 一、本周进展\r?$' -and
    $tidySaved -match '(?m)^## 二、下周计划\r?$' -and $tidySaved -match '完成了登录页面' -and
    $tidySaved -match '接入新的导出流程') {
  Write-Host 'PASS tidy'
} else {
  Write-Host 'FAIL tidy'
  exit 1
}
