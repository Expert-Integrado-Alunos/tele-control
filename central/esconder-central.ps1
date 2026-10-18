# Esconde a janela da central (sessoes-wpp) no Windows Terminal assim que ela aparece (some da tela e da barra de
# tarefas; a sessao segue rodando). Minimizada ainda aparecia na barra (caso real).
# Por que existe (pedido do dono: "quero que fique escondido"): o wt.exe nao tem opcao de abrir minimizado (doc oficial
# de argumentos, conferida em 28/09) e ignora o estilo de janela do VBS (testado: estilo 7 abriu a janela normal).
# Chamado pelo abrir-central.vbs logo depois de abrir o terminal, com -Titulos = o nome da central (A3a: vem do
# config.json; sem titulo padrao). Procura por ate -Segundos janelas do WindowsTerminal cujo titulo E um dos -Titulos ou
# termina com espaco + ele (o --title do wt.exe e o nome; depois o Claude Code poe um sinal antes do nome da sessao,
# medido 14/10/2026 na central viva: "<sinal> <nome>") e esconde. Nunca "contem": um nome curto casaria outras janelas
# do terminal e as esconderia. So le titulo e esconde: nao fecha, nao digita, nao muda foco de proposito.
# -Titulos vazio (ou so com separadores) = nao esconde nada: sai antes de olhar qualquer janela.
param(
  [string]$Titulos = "",
  [int]$Segundos = 30
)
$lista = @($Titulos -split "\|" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($lista.Count -eq 0) { "escondidas=0"; exit 0 }
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class JanelaCentral {
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr p);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  public static List<IntPtr> Achar(string[] titulos) {
    var achadas = new List<IntPtr>();
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      if (c.ToString() != "CASCADIA_HOSTING_WINDOW_CLASS") return true;
      var t = new StringBuilder(512); GetWindowText(h, t, 512);
      var titulo = t.ToString();
      foreach (var x in titulos) {
        if (titulo == x || titulo.EndsWith(" " + x, StringComparison.Ordinal)) { achadas.Add(h); break; }
      }
      return true;
    }, IntPtr.Zero);
    return achadas;
  }
}
"@
# Achou = segue vigiando mais 8 s e esconde de novo se a janela voltar (o terminal pode se restaurar ao terminar de
# abrir); depois disso sai, e o dono pode abrir a janela a vontade.
$feitas = @{}
$fim = (Get-Date).AddSeconds($Segundos)
$achouEm = $null
while ((Get-Date) -lt $fim) {
  foreach ($h in [JanelaCentral]::Achar([string[]]$lista)) {
    [void][JanelaCentral]::ShowWindow($h, 0)  # 0 = SW_HIDE: some da tela e da barra de tarefas; o processo segue
    $feitas[[string]$h] = $true
  }
  if ($feitas.Count -gt 0 -and -not $achouEm) { $achouEm = Get-Date }
  if ($achouEm -and ((Get-Date) - $achouEm).TotalSeconds -ge 8) { break }
  Start-Sleep -Milliseconds 250
}
"escondidas=$($feitas.Count)"
