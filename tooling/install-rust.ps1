$ErrorActionPreference = 'Stop'
$rustRepository = Split-Path -Parent $PSScriptRoot
$rustCache = Join-Path $rustRepository '.tools/rust'
$env:CARGO_HOME = Join-Path $rustCache 'cargo'
$env:RUSTUP_HOME = Join-Path $rustCache 'rustup'
$rustInstaller = Join-Path $rustCache 'rustup-init-1.28.2.exe'
$rustupExe = Join-Path $env:CARGO_HOME 'bin/rustup.exe'
$rustInstallerUrl = 'https://static.rust-lang.org/rustup/archive/1.28.2/x86_64-pc-windows-msvc/rustup-init.exe'
$rustInstallerSha = '88d8258dcf6ae4f7a80c7d1088e1f36fa7025a1cfd1343731b4ee6f385121fc0'

if (-not $IsWindows) { throw 'This bootstrap is for the approved Windows reference toolchain.' }
New-Item -ItemType Directory -Path $rustCache -Force | Out-Null
if (-not (Test-Path -LiteralPath $rustupExe)) {
    if (-not (Test-Path -LiteralPath $rustInstaller)) {
        Invoke-WebRequest -Uri $rustInstallerUrl -OutFile $rustInstaller
    }
    $rustObservedSha = (Get-FileHash -LiteralPath $rustInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($rustObservedSha -ne $rustInstallerSha) { throw 'Pinned rustup installer SHA-256 mismatch; refusing execution.' }
    & $rustInstaller -y --no-modify-path --default-toolchain none --profile minimal
    if ($LASTEXITCODE -ne 0) { throw "rustup bootstrap failed: $LASTEXITCODE" }
}
$rustupVersion = & $rustupExe --version
if ($LASTEXITCODE -ne 0 -or $rustupVersion -notmatch '^rustup 1\.28\.2 ') {
    throw 'The project cache does not contain the approved rustup 1.28.2; refusing an implicit upgrade.'
}
& $rustupExe set auto-self-update disable
if ($LASTEXITCODE -ne 0) { throw "rustup configuration failed: $LASTEXITCODE" }
& $rustupExe toolchain install 1.94.1 --profile minimal --component rustfmt --component clippy --target wasm32-unknown-unknown --no-self-update
if ($LASTEXITCODE -ne 0) { throw "Rust toolchain installation failed: $LASTEXITCODE" }
& $rustupExe run 1.94.1 rustc --version --verbose
if ($LASTEXITCODE -ne 0) { throw "Rust verification failed: $LASTEXITCODE" }
& $rustupExe target list --installed --toolchain 1.94.1
if ($LASTEXITCODE -ne 0) { throw "Rust target verification failed: $LASTEXITCODE" }
