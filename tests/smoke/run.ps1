# Smoke test (Windows): open a document in a debug build, drive the UI, then check what was written to disk.
# Build first with: npx tauri build --debug --no-bundle
#
# 三段：
#   1. sample.md —— 编辑、公式、表格、代码块、保存
#   2. untidy.md —— 「一键整理」：悬浮按钮出现、点它、结果落盘且文字一个都没少
#   3. 从链接打开 —— 真的去 GitHub 下一本书回来（要联网，连不上就记 SKIP）
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '../..')
$bin = Join-Path $root 'src-tauri/target.noindex/debug/mdpad.exe'
$work = Join-Path ([IO.Path]::GetTempPath()) "mdpad-smoke-$PID"
Copy-Item -Recurse (Join-Path $root 'tests/smoke') $work

function Invoke-App { # Invoke-App <文档> <测试脚本> <日志名> [等待秒数]
  param($Doc, $Scenario, $Name, $Wait = 90000)
  $log = Join-Path $work "$Name.txt"
  $env:MDPAD_DATA_DIR = Join-Path $work ".data-$Name"
  # MDPAD_LIBRARY_DIR 指向临时目录，否则第 3 段会往用户真实的 ~/Documents/MDPad 里写书
  $env:MDPAD_LIBRARY_DIR = Join-Path $work "library-$Name"
  $env:MDPAD_TEST_JS = Get-Content -Raw -Encoding UTF8 (Join-Path $root "tests/smoke/$Scenario")
  $app = Start-Process -FilePath $bin -ArgumentList "`"$Doc`"" -RedirectStandardError $log -PassThru
  $exited = $app.WaitForExit($Wait)
  if (-not $exited) {
    $app.Kill()
    Write-Host 'Timed out'
  } else {
    # The no-argument overload flushes the redirected stderr stream before we read it.
    $app.WaitForExit()
    try { Write-Host "app exit code: $($app.ExitCode)" } catch { Write-Host 'app exit code: unavailable' }
  }
  # Get-Content used to emit into the function's output stream: Actions showed no app log at all,
  # and $output became a mix of lines and one whole string. Print it explicitly, return one string.
  $text = if (Test-Path $log) { Get-Content -Raw -Encoding UTF8 $log } else { '' }
  Write-Host "--- app stderr ($Name) ---"
  Write-Host $text
  Write-Host '--- end ---'
  return $text
}

Write-Host '=== 1. 打开、编辑、保存 ==='
$doc = Join-Path $work 'sample.md'
$output = Invoke-App $doc 'test.js' 'log'
$saved = Get-Content -Raw -Encoding UTF8 $doc
$checks = [ordered]@{
  'loaded=true'          = [bool]($output -match 'loaded=true')
  'katex:true'           = [bool]($output -match '"katex":true')
  'status:已保存'         = [bool]($output -match '"status":"已保存"')
  'headingMarkers:# '    = [bool]($output -match '"headingMarkers":\["# "\]')
  'saved:新增的文字'      = [bool]($saved -match '新增的文字')
}
$missing = @($checks.Keys | Where-Object { -not $checks[$_] })
if ($missing.Count -eq 0) {
  Write-Host 'PASS'
} else {
  foreach ($key in $checks.Keys) { Write-Host ("  check {0}: {1}" -f $key, $checks[$key]) }
  Write-Host ("  missing: {0}" -f ($missing -join ', '))
  Write-Host ("  work dir: {0}" -f $work)
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

Write-Host ''
Write-Host '=== 3. 从链接打开（要联网：下载一个真实的 GitHub 书仓） ==='
$sample = Join-Path $work 'sample.md'
$fetchOut = Invoke-App $sample 'fetch-test.js' 'fetch-log' 180000

if ($fetchOut -match 'verdict=pass') {
  Write-Host 'PASS fetch'
} elseif ($fetchOut -match 'verdict=skip') {
  # 这台机器到不了 GitHub。链接识别与解压的围栏已由 cargo test 的单测覆盖，
  # 所以这里只记 SKIP，不让网络问题挡住发版。
  Write-Host 'SKIP fetch（连不上 GitHub，未验证端到端）'
} else {
  Write-Host 'FAIL fetch'
  exit 1
}
