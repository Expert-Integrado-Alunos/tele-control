' Launcher oculto do porteiro do sessoes-wpp (Tele Control) — copiado pra pasta Startup do usuario (fase 3, F3.10; o PC
' reiniciou (caso real) e o porteiro ficou fora ate ser religado a mao). Tambem e o que o supervisor
' (hooks/porteiro-supervisor.js, SessionStart de qualquer aba) roda quando o porteiro morreu.
' Janela 0 = invisivel; nao usa schtasks nem servico do Windows.
'
' Sem argumento: RENASCE PELO WMI (Win32_Process.Create) com "/guardiao" e sai. O processo criado pelo WMI recebe o
' ambiente do LOGIN do usuario (montado do registro) e nasce fora da arvore e do job de quem chamou. Motivo (caso
' real): religado pelo SessionStart de uma sessao do Claude Desktop, o porteiro herdou
' CLAUDE_CODE_HARBOR_KITE=0 (desliga o recado entre sessoes) e a identidade de outra conta; a central e o mensageiro
' ficaram sem canal e o Telegram parou. A lista fixa de nomes (Remove) nao pegou: o Desktop inventa nomes novos.
' WMI falhou = caminho antigo (limpa o que for de sessao do Claude e sobe o porteiro 1 vez); o porteiro limpa de novo ao
' subir (lib/ambiente.mjs).
'
' "/guardiao": vigia leve, 1 por PC (guardiao.lock aberto pra escrita enquanto vive; o 2o nao abre e sai). A cada 60 s,
' porteiro morto e sem o arquivo "desligado" na pasta de estado = `porteiro.mjs garantir`. Motivo (caso real): o
' porteiro morreu por falta de memoria e so voltou 24 min depois, quando alguem abriu uma sessao (supervisor).
'
' Caminhos: o porteiro.mjs e o da MESMA pasta deste .vbs (o repositorio clonado em qualquer lugar); o node.exe e o
' primeiro do PATH (o do login, quando nasce pelo WMI ou pela pasta Inicializar), senao o da pasta padrao do instalador
' do Node (%ProgramFiles%\nodejs). Ensaio (SESSOES_WPP_VBS_ENSAIO=1 no ambiente): escreve o node e o porteiro, 1 por
' linha, e sai sem rodar nada (teste).
Option Explicit
Dim sh, fso, node, porteiro, estado, modo
Set sh = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
porteiro = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "porteiro.mjs")
node = AcharNode()
If sh.Environment("PROCESS")("SESSOES_WPP_VBS_ENSAIO") = "1" Then
  WScript.Echo node
  WScript.Echo porteiro
  WScript.Quit 0
End If
estado = sh.ExpandEnvironmentStrings("%SESSOES_WPP_DIR%")
If estado = "%SESSOES_WPP_DIR%" Or estado = "" Then estado = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.claude\sessoes-wpp"
modo = ""
If WScript.Arguments.Count > 0 Then modo = LCase(WScript.Arguments(0))

If modo <> "/guardiao" Then
  If RenascerPeloWmi() Then WScript.Quit 0
  LimparSessaoClaude
  sh.Run """" & node & """ """ & porteiro & """ garantir", 0, False
  WScript.Quit 0
End If

' ---- guardiao ----
Dim trava
On Error Resume Next
Set trava = fso.OpenTextFile(estado & "\guardiao.lock", 2, True)
If Err.Number <> 0 Then WScript.Quit 0 ' outro guardiao vivo
On Error GoTo 0
trava.WriteLine "guardiao desde " & Now
Do
  If Not fso.FileExists(estado & "\desligado") Then
    If Not PorteiroVivo() Then sh.Run """" & node & """ """ & porteiro & """ garantir --guardiao", 0, True
  End If
  WScript.Sleep 60000
Loop

' O primeiro node.exe do PATH (entrada com aspas ou com %VARIAVEL% vale); nenhum = o da pasta padrao do instalador.
Function AcharNode()
  Dim p, dir
  For Each p In Split(sh.Environment("PROCESS")("PATH"), ";")
    dir = Trim(Replace(sh.ExpandEnvironmentStrings(p), """", ""))
    If dir <> "" Then
      If fso.FileExists(fso.BuildPath(dir, "node.exe")) Then
        AcharNode = fso.BuildPath(dir, "node.exe")
        Exit Function
      End If
    End If
  Next
  AcharNode = fso.BuildPath(sh.ExpandEnvironmentStrings("%ProgramFiles%"), "nodejs\node.exe")
End Function

Function RenascerPeloWmi()
  Dim wmi, cfg, rc, novoPid
  RenascerPeloWmi = False
  On Error Resume Next
  Set wmi = GetObject("winmgmts:{impersonationLevel=impersonate}!\\.\root\cimv2")
  Set cfg = wmi.Get("Win32_ProcessStartup").SpawnInstance_
  cfg.ShowWindow = 0
  rc = wmi.Get("Win32_Process").Create("wscript.exe //nologo """ & WScript.ScriptFullName & """ /guardiao", _
    fso.GetParentFolderName(porteiro), cfg, novoPid)
  If Err.Number = 0 And rc = 0 Then RenascerPeloWmi = True
  On Error GoTo 0
End Function

' Pid da trava do porteiro (porteiro.lock) vivo e node.exe. Trava sem pid ou erro do WMI = morto (garantir confere de novo).
Function PorteiroVivo()
  Dim arq, pid, wmi, lista
  PorteiroVivo = False
  On Error Resume Next
  If Not fso.FileExists(estado & "\porteiro.lock") Then Exit Function
  Set arq = fso.OpenTextFile(estado & "\porteiro.lock", 1)
  pid = Trim(arq.ReadAll)
  arq.Close
  If Err.Number <> 0 Or Not IsNumeric(pid) Or pid = "" Then Exit Function
  Set wmi = GetObject("winmgmts:{impersonationLevel=impersonate}!\\.\root\cimv2")
  Set lista = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId = " & CLng(pid) & " AND Name = 'node.exe'")
  If Err.Number = 0 Then PorteiroVivo = (lista.Count > 0)
  On Error GoTo 0
End Function

' Tira do ambiente deste processo toda variavel de sessao do Claude (mesma regra do lib/ambiente.mjs: prefixo, menos os
' dubles do sessoes-wpp e o que o usuario definiu no registro User/Machine).
Sub LimparSessaoClaude()
  Dim amb, usr, sist, item, i, nome, nomes, n
  Set amb = sh.Environment("PROCESS")
  Set usr = sh.Environment("USER")
  Set sist = sh.Environment("SYSTEM")
  nomes = Array()
  For Each item In amb
    i = InStr(item, "=")
    If i > 1 Then
      nome = UCase(Left(item, i - 1))
      If DeSessaoClaude(nome) And usr(nome) = "" And sist(nome) = "" Then
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

Function DeSessaoClaude(n)
  Dim p
  DeSessaoClaude = False
  If n = "CLAUDE_BIN" Or n = "CLAUDE_SESSIONS_DIR" Or n = "CLAUDE_PROJECTS_DIR" Then Exit Function
  For Each p In Array("CLAUDE", "ANTHROPIC_", "CODEX_COMPANION_", "MCP_CONNECTION_", "MCP_SERVER_CONNECTION_")
    If Left(n, Len(p)) = p Then
      DeSessaoClaude = True
      Exit Function
    End If
  Next
End Function
