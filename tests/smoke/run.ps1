# Smoke test (Windows): open sample.md in a debug build, edit and save it, then check the result.
# Build first with: npx tauri build --debug --no-bundle
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '../..')
$bin = Join-Path $root 'src-tauri/target.noindex/debug/mdpad.exe'
$work = Join-Path ([IO.Path]::GetTempPath()) "mdpad-smoke-$PID"
Copy-Item -Recurse (Join-Path $root 'tests/smoke') $work
$doc = Join-Path $work 'sample.md'
$log = Join-Path $work 'log.txt'

$env:MDPAD_DATA_DIR = Join-Path $work '.data'
$env:MDPAD_TEST_JS = Get-Content -Raw -Encoding UTF8 (Join-Path $root 'tests/smoke/test.js')
$app = Start-Process -FilePath $bin -ArgumentList "`"$doc`"" -RedirectStandardError $log -PassThru
if (-not $app.WaitForExit(90000)) { $app.Kill(); Write-Host 'Timed out' }
Get-Content -Encoding UTF8 $log

$output = Get-Content -Raw -Encoding UTF8 $log
$saved = Get-Content -Raw -Encoding UTF8 $doc
if ($output -match 'loaded=true' -and $output -match '"katex":true' -and
    $output -match '"status":"已保存"' -and $output -match '"headingMarkers":\["# "\]' -and $saved -match '新增的文字') {
  Write-Host 'PASS'
} else {
  Write-Host 'FAIL'
  exit 1
}
