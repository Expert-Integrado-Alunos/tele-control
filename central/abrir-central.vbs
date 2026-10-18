' Abre a central: sessao interativa do Claude no Windows Terminal, escondida (sessoes-wpp fase 3, F3.9/F3.10).
' A3a: a pasta, o nome e o claude.exe chegam por argumento (o porteiro tira do config.json; nada fixo aqui). A5d2: mais a
' pasta montada e o modo de permissao:
'   wscript //nologo abrir-central.vbs <pasta> <nome> <claude.exe> <montada> <modo>
' Saida 0 = mandou abrir. 2 = argumento faltando, a mais ou vazio; caractere que a linha do wt.exe nao passa inteiro
' (aspas, %, ; e quebra de linha; no nome tambem | e a barra invertida, que quebrariam o -Titulos e o perfil); pasta ou
' montada que nao e absoluta ou e a raiz do disco; modo que nao e bypassPermissions nem auto. 3 = a pasta, o claude.exe,
' a montada ou um dos 2 arquivos dela nao existe.
' Ensaio (SESSOES_WPP_VBS_ENSAIO=1 no ambiente): escreve o perfil e as 2 linhas de comando, 1 por linha, e sai sem
' gravar nem abrir nada (o teste roda assim, pelo cscript).
' A5d2: a montada e a pasta que o porteiro grava a cada abertura (gravarCentral, lib/central.mjs): o instrucoes.md (entra
' no system prompt e vale de novo depois de compactar) e o ajustes.json (o --settings). O nome e so ASCII (o .vbs e lido
' como ANSI); o porteiro acha a central pelo nome normalizado, o mesmo do config.json.
' O modo vem da escolha do dono na instalacao (central.modoPermissao): sozinha = bypassPermissions (como uma aba em
' modo bypass); pedir = auto (o ajustes.json libera o roteamento e um hook nega o resto, porque ninguem olha a tela).
Set sh = CreateObject("Wscript.Shell")
Set amb = sh.Environment("PROCESS")
Set fso = CreateObject("Scripting.FileSystemObject")
Set args = WScript.Arguments
If args.Count <> 5 Then WScript.Quit 2
pasta = args(0)
nome = args(1)
claude = args(2)
montada = args(3)
modo = args(4)
If pasta = "" Or nome = "" Or claude = "" Or montada = "" Then WScript.Quit 2
If TemAlgum(nome, Array("""", "%", ";", "|", "\", vbCr, vbLf)) Then WScript.Quit 2
If TemAlgum(pasta, Array("""", "%", ";", vbCr, vbLf)) Or TemAlgum(claude, Array("""", "%", ";", vbCr, vbLf)) Then WScript.Quit 2
If TemAlgum(montada, Array("""", "%", ";", vbCr, vbLf)) Then WScript.Quit 2
If modo <> "bypassPermissions" And modo <> "auto" Then WScript.Quit 2
' A barra do fim sai: o \" fecharia as aspas na linha do wt.exe (e o WSH entrega o \\" do Node com as 2 barras)
Do While Len(pasta) > 0 And (Right(pasta, 1) = "\" Or Right(pasta, 1) = "/")
  pasta = Left(pasta, Len(pasta) - 1)
Loop
Set absoluta = New RegExp
absoluta.Pattern = "^[A-Za-z]:[\\/]."
If Not absoluta.Test(pasta) Then WScript.Quit 2
If Not absoluta.Test(montada) Then WScript.Quit 2
If Not fso.FolderExists(pasta) Or Not fso.FileExists(claude) Then WScript.Quit 3
instrucoes = montada & "\instrucoes.md"
' Recado de outra sessao (o mensageiro e um claude -p fora do modo bypass): a central em bypass SEGURA o recado
' ("Held peer message ... permission mode class doesn't match") e ele expira em 5 min com a janela escondida. Medido em
' 30/09/2026 com crossSessionInbound=accept no settings do usuario (nao valeu na central). Remedio da doc oficial pra
' sessao sem gente: --settings com crossSessionInbound=accept (o ajustes.json montado tem, nos 2 modos).
ajustes = montada & "\ajustes.json"
If Not fso.FolderExists(montada) Or Not fso.FileExists(instrucoes) Or Not fso.FileExists(ajustes) Then WScript.Quit 3

central = fso.GetParentFolderName(WScript.ScriptFullName)
' Escondida (28/09/2026: "quero que fique escondido"): (1) perfil do Windows Terminal com o nome da central, por
' fragmento (gravado na pasta Fragments do usuario) com closeOnExit "always": central morta nao deixa janela parada com
' "processo encerrado"; perfil ainda nao carregado = o terminal usa o padrao, sem erro. (2) O wt.exe nao abre minimizado
' (sem opcao na doc; ignora o estilo 7 do Run, testado): esconder-central.ps1 esconde a janela (nem na barra de tarefas)
' assim que ela aparece, pelo titulo = o nome da central.
perfil = "{""profiles"":[{""name"":""" & nome & """,""hidden"":true,""closeOnExit"":""always""}]}"
cmd = "wt.exe -w new -p """ & nome & """ --title """ & nome & """ -d """ & pasta & """ """ & claude & """ -n """ & nome & """ --permission-mode " & modo & " --settings """ & ajustes & """ --append-system-prompt-file """ & instrucoes & """"
esconder = "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & central & "\esconder-central.ps1"" -Titulos """ & nome & """"
If amb("SESSOES_WPP_VBS_ENSAIO") = "1" Then
  WScript.Echo perfil
  WScript.Echo cmd
  WScript.Echo esconder
  WScript.Quit 0
End If

' Ambiente limpo (medido 27/09/2026 21:27): aberta de dentro de uma sessao do Claude, a central herdava
' CLAUDE_CODE_CHILD_SESSION (= "Transcript saving is off"), o id, o pid e o socket da sessao que abriu e o
' entrypoint claude-vscode. No login nada disso existe; aqui tira sempre.
On Error Resume Next
For Each v In Array("CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", _
    "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_EXECPATH", _
    "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING", "CLAUDE_EFFORT", "CLAUDE_PLUGIN_DATA", _
    "CODEX_COMPANION_SESSION_ID", "CODEX_COMPANION_TRANSCRIPT_PATH", "SESSOES_WPP_MENSAGEIRO")
  amb.Remove v
Next
On Error GoTo 0
LimparSessaoClaude sh, amb

' O perfil (fragmento do Windows Terminal); sem a pasta local do usuario, segue sem ele
pastaLocal = amb("LOCALAPPDATA")
If pastaLocal <> "" Then
  On Error Resume Next
  frag = pastaLocal & "\Microsoft\Windows Terminal\Fragments"
  If Not fso.FolderExists(frag) Then fso.CreateFolder frag
  If Not fso.FolderExists(frag & "\sessoes-wpp") Then fso.CreateFolder frag & "\sessoes-wpp"
  Set arq = fso.CreateTextFile(frag & "\sessoes-wpp\central.json", True)
  arq.WriteLine perfil
  arq.Close
  On Error GoTo 0
End If
sh.Run cmd, 1, False
sh.Run esconder, 0, False

' Algum dos `proibidos` dentro do `texto`.
Function TemAlgum(texto, proibidos)
  Dim c
  TemAlgum = False
  For Each c In proibidos
    If InStr(texto, c) > 0 Then TemAlgum = True
  Next
End Function

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
