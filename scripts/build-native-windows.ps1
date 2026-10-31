$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'native/windows/DeskreenVirtualDisplay.cs'
$outDir = Join-Path $root 'out/native'
$out = Join-Path $outDir 'DeskreenVirtualDisplay.exe'

# Keep the resources directory present on every platform so electron-builder
# can always copy it.
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

if ($env:OS -ne 'Windows_NT') {
	Write-Host 'Skipping Windows virtual display helper (not running on Windows)'
	exit 0
}

if (-not (Test-Path $src)) {
	throw "Native helper source not found: $src"
}

$cscCandidates = @(
	(Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
	(Join-Path $env:WINDIR 'Microsoft.NET/Framework/v4.0.30319/csc.exe')
)

$csc = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $csc) {
	$cscCommand = Get-Command csc.exe -ErrorAction SilentlyContinue
	if ($cscCommand) {
		$csc = $cscCommand.Source
	}
}

if (-not $csc) {
	throw 'csc.exe was not found. Install the .NET Framework 4.x compiler to build the Windows virtual display helper.'
}

& $csc /nologo /target:exe /platform:anycpu /optimize+ /reference:System.dll /out:"$out" "$src"

if ($LASTEXITCODE -ne 0) {
	throw "The Windows virtual display helper failed to compile (exit code $LASTEXITCODE)."
}

Write-Host "Built $out"
