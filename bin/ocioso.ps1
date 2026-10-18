# Le ha quanto tempo o PC esta sem teclado/mouse (GetLastInputInfo do user32). O porteiro chama com -MinMs 0 a cada minuto.
# ocioso.ps1 — espera o dono parar de usar teclado/mouse antes de uma acao que rouba foco (clique, digitacao, abrir janela).
# Sai 0 quando o PC ficou ocioso por >= MinMs; sai 4 quando estourou TimeoutMs com o dono ainda ativo.
# Saida (1 linha): status=ok|timeout idle_ms=<n> esperou_ms=<n>
# T7e1 (02/10/2026): o C# compila 1 vez numa DLL em %LOCALAPPDATA%\sessoes-wpp\WinUiIdle-<12 hex do sha256 da fonte>.dll
# (num .tmp + Move-Item); depois so carrega (Add-Type -Path), sem o csc a cada minuto. DLL que nao carrega (ou pasta,
# hash ou compilacao que falha) = compila em memoria, como antes. Fonte mudou = nome novo (a DLL velha fica). O hash e da
# fonte com fim de linha LF (checkout em CRLF ou LF = mesma DLL).
param([int]$MinMs = 4000, [int]$TimeoutMs = 120000, [int]$PollMs = 500)
$fonte = @"
using System; using System.Runtime.InteropServices;
public static class WinUiIdle {
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  public static uint Ms() { var i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO)); GetLastInputInfo(ref i); return (uint)Environment.TickCount - i.dwTime; }
}
"@
$fonte = $fonte -replace "`r`n", "`n"
$carregou = $false
$eap = $ErrorActionPreference
try {
  $ErrorActionPreference = 'Stop'
  $sha = [Security.Cryptography.SHA256]::Create()
  $hex = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($fonte)) | ForEach-Object { $_.ToString('x2') })
  $nome = 'WinUiIdle-' + $hex.Substring(0, 12)
  $pasta = Join-Path $env:LOCALAPPDATA 'sessoes-wpp'
  $dll = Join-Path $pasta ($nome + '.dll')
  if (-not (Test-Path -LiteralPath $dll)) {
    if (-not (Test-Path -LiteralPath $pasta)) { $null = New-Item -ItemType Directory -Path $pasta -Force }
    $tmp = Join-Path $pasta ($nome + '.' + $PID + '.tmp')
    $par = New-Object System.CodeDom.Compiler.CompilerParameters
    $par.GenerateExecutable = $false
    $par.GenerateInMemory = $false
    $par.OutputAssembly = $tmp
    $null = $par.ReferencedAssemblies.Add('System.dll')
    $res = (New-Object Microsoft.CSharp.CSharpCodeProvider).CompileAssemblyFromSource($par, $fonte)
    if ($res.Errors.HasErrors) { throw 'compilacao da DLL falhou' }
    # outro powershell criou a DLL no meio (Move-Item falha): fica a dele, o .tmp sai
    try { Move-Item -LiteralPath $tmp -Destination $dll } catch { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
  }
  Add-Type -Path $dll
  $carregou = $true
} catch {
  $carregou = $false
} finally {
  $ErrorActionPreference = $eap
}
if (-not $carregou) { Add-Type -TypeDefinition $fonte }
$sw = [Diagnostics.Stopwatch]::StartNew()
while ($true) {
  $idle = [WinUiIdle]::Ms()
  if ($idle -ge $MinMs) { Write-Output "status=ok idle_ms=$idle esperou_ms=$($sw.ElapsedMilliseconds)"; exit 0 }
  if ($sw.ElapsedMilliseconds -ge $TimeoutMs) { Write-Output "status=timeout idle_ms=$idle esperou_ms=$($sw.ElapsedMilliseconds)"; exit 4 }
  Start-Sleep -Milliseconds $PollMs
}
