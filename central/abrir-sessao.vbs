' Abre a SESSAO NOVA pedida pelo WhatsApp ESCONDIDA no PC (sessoes-wpp fase 4f): claude interativo num console
' escondido, sem VS Code, sem Windows Terminal, sem teclado e sem mouse. Pedido de 30/09/2026 21:4x: "eu quero por api, e
' nao pelo teclado. Pq eventualmente o pc esta bloqueado. Tem que ser sem interacao no mouse".
' Uso (o porteiro chama): wscript //nologo abrir-sessao.vbs "<pasta>" "<nome>"
' T18 (12/10/2026): com 3 argumentos = a MESMA conversa fechada, retomada escondida (a aba reaberta pelo celular):
'   wscript //nologo abrir-sessao.vbs "<pasta>" "<nome ou vazio>" <sessionId>
' = claude [-n <nome>] --resume <sessionId> (medido 11/10 23h: o mesmo sessionId sobe com a conversa inteira, com
' recado, sem arquivo novo). Nome vazio = sem -n (nome derivado; o -n reescreve o titulo da conversa, medido 12/10). O id
' so com letra, numero e hifen. Nunca --fork-session nem --session-id: o modo de 4 argumentos da T8 (a COPIA, que virava
' outra conversa na lista do VS Code) saiu; outro numero de argumentos = sai.
' Medido 30/09/2026 21:47: Shell.Run com estilo 0 DIRETO no claude.exe = console escondido (o Windows nao entrega pro
' Windows Terminal) e o claude interativo sobe (registro entrypoint cli). O wt.exe ignora o estilo (a central pisca).
' Sem acento no texto deste arquivo de proposito (o .vbs e lido como ANSI); o nome com acento chega pelos argumentos.
' Ambiente limpo como o abrir-central.vbs (aberto de dentro do porteiro, o claude herdaria a identidade de outra sessao),
' mais SESSOES_WPP_ESCONDIDA=1: a trava de pergunta (hooks/pergunta-modo-rua.js) nega o AskUserQuestion dela sempre,
' porque ninguem ve os botoes.
' A5d2: o modo e os arquivos vem da pasta montada que o porteiro grava a cada abertura (gravarCentral, lib/central.mjs),
' pelo ambiente, como o SESSOES_WPP_CLAUDE: SESSOES_WPP_MONTADA (pasta absoluta com o instrucoes-sessao.md e o
' ajustes.json) e SESSOES_WPP_MODO (bypassPermissions = o dono escolheu "sozinha"; auto = "pedir"). Ausente ou ruim = sai
' com 2 (nunca o bypass por falta); a montada ou um dos 2 arquivos que nao existe = sai com 3. O ajustes.json tem o
' crossSessionInbound=accept nos 2 modos: sem ele, a sessao segura o recado do mensageiro ("Held peer message").
If WScript.Arguments.Count <> 2 And WScript.Arguments.Count <> 3 Then WScript.Quit 2
pasta = WScript.Arguments(0)
nome = WScript.Arguments(1)
If pasta = "" Then WScript.Quit 2
If nome = "" And WScript.Arguments.Count = 2 Then WScript.Quit 2
If InStr(nome, """") > 0 Or InStr(nome, "%") > 0 Then WScript.Quit 2
retomada = ""
If WScript.Arguments.Count = 3 Then
  Set ids = New RegExp
  ids.Pattern = "^[0-9A-Za-z-]+$"
  If Not ids.Test(WScript.Arguments(2)) Then WScript.Quit 2
  retomada = " --resume " & WScript.Arguments(2)
End If
nomeArg = ""
If nome <> "" Then nomeArg = " -n """ & nome & """"
Set sh = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Set amb = sh.Environment("PROCESS")
On Error Resume Next
For Each v In Array("CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", _
    "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_EXECPATH", _
    "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING", "CLAUDE_EFFORT", "CLAUDE_PLUGIN_DATA", _
    "CODEX_COMPANION_SESSION_ID", "CODEX_COMPANION_TRANSCRIPT_PATH", "SESSOES_WPP_MENSAGEIRO")
  amb.Remove v
Next
On Error GoTo 0
LimparSessaoClaude sh, amb
amb("SESSOES_WPP_ESCONDIDA") = "1"
montada = amb("SESSOES_WPP_MONTADA")
modo = amb("SESSOES_WPP_MODO")
Set ruim = New RegExp
ruim.Pattern = "[""%;\r\n]"
Set absoluta = New RegExp
absoluta.Pattern = "^[A-Za-z]:[\\/]."
If montada = "" Or ruim.Test(montada) Or Not absoluta.Test(montada) Then WScript.Quit 2
If modo <> "bypassPermissions" And modo <> "auto" Then WScript.Quit 2
If Not fso.FolderExists(pasta) Then WScript.Quit 3
instrucoes = montada & "\instrucoes-sessao.md"
ajustes = montada & "\ajustes.json"
If Not fso.FolderExists(montada) Or Not fso.FileExists(instrucoes) Or Not fso.FileExists(ajustes) Then WScript.Quit 3
sh.CurrentDirectory = pasta
claude = amb("SESSOES_WPP_CLAUDE")
If claude = "" Then claude = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.local\bin\claude.exe"
cmd = """" & claude & """" & nomeArg & retomada & " --permission-mode " & modo & " --settings """ & ajustes & _
  """ --append-system-prompt-file """ & instrucoes & """"
sh.Run cmd, 0, False

' Defesa (incidente 11/10/2026, lib/ambiente.mjs): tira tambem toda variavel de sessao do Claude que a lista acima nao
' conhece (a sessao do Claude Desktop poe CLAUDE_CODE_HARBOR_KITE=0, que desliga o recado entre sessoes, e a identidade
' de outra conta). Regra por prefixo; ficam os dubles do sessoes-wpp e o que o usuario definiu no registro User/Machine.
Sub LimparSessaoClaude(sh, amb)
  Dim usr, sist, item, i, nome, nomes, n, p, deSessao
  Set usr = sh.Environment("USER")
  Set sist = sh.Environment("SYSTEM")
  nomes = Array()
  For Each item In amb
    i = InStr(item, "=")
    If i > 1 Then
      nome = UCase(Left(item, i - 1))
      deSessao = False
      If nome <> "CLAUDE_BIN" And nome <> "CLAUDE_SESSIONS_DIR" And nome <> "CLAUDE_PROJECTS_DIR" Then
        For Each p In Array("CLAUDE", "ANTHROPIC_", "CODEX_COMPANION_", "MCP_CONNECTION_", "MCP_SERVER_CONNECTION_")
          If Left(nome, Len(p)) = p Then deSessao = True
        Next
      End If
      If deSessao And usr(nome) = "" And sist(nome) = "" Then
        ReDim Preserve nomes(UBound(nomes) + 1)
        nomes(UBound(nomes)) = nome
      End If
    End If
  Next
  On Error Resume Next
  For Each n In nomes
    amb.Remove n
  Next
  On Error GoTo 0
End Sub
