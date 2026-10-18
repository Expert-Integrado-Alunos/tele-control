# Tele Control: a janela da chave do bot do Telegram (o instalar.mjs abre no passo telegram-chave e espera fechar).
# A chave entra escondida (Read-Host -AsSecureString) e so vai pra variavel de usuario do Windows: nunca aparece na
# tela, no chat do Claude, no historico da conversa nem em arquivo.
# Saida: 0 = gravou; 1 = desistiu (Enter sem colar nada); 2 = o que veio nao parece uma chave de bot.
# Arquivo so com ASCII de proposito: o Windows PowerShell 5.1 le .ps1 sem BOM como ANSI.
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z_][A-Za-z0-9_]{0,99}$')]
  [string]$Variavel
)

$Host.UI.RawUI.WindowTitle = 'Tele Control - chave do bot'
Write-Host ''
Write-Host '  Tele Control: cole aqui a chave do seu bot (a mensagem do BotFather que tem numero:letras).'
Write-Host '  Ela nao aparece na tela enquanto voce cola. Cole com Ctrl+V ou com o botao direito e aperte Enter.'
Write-Host '  Pra desistir, aperte Enter sem colar nada.'
Write-Host ''
$seguro = Read-Host -AsSecureString '  Chave'
$ponteiro = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($seguro)
try {
  $chave = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ponteiro)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ponteiro)
}
$chave = "$chave".Trim()
if ($chave -eq '') { exit 1 }
if ($chave -notmatch '^\d{5,16}:[A-Za-z0-9_-]{20,}$') {
  Write-Host ''
  Write-Host '  Isso nao parece a chave de um bot (o formato e numero:letras). A janela fecha; tente de novo.'
  Start-Sleep -Seconds 5
  exit 2
}
[Environment]::SetEnvironmentVariable($Variavel, $chave, 'User')
$chave = $null
Write-Host ''
Write-Host '  Chave guardada no Windows. Esta janela fecha sozinha.'
Start-Sleep -Seconds 2
exit 0
