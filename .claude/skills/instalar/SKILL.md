---
name: instalar
description: Instala o Tele Control neste PC numa conversa guiada, com perguntas de clique, e liga o controle das sessões do Claude Code pelo Telegram. Rode com /instalar numa conversa aberta na pasta do repositório.
disable-model-invocation: true
allowed-tools: Bash(node instalar.mjs:*), AskUserQuestion
---

# /instalar: o Tele Control neste PC

Você vai guiar a pessoa na instalação do Tele Control, o controle das sessões do Claude Code pelo celular (Telegram).
Quem faz o trabalho é o `instalar.mjs` (sem IA, testado). Você faz as perguntas de clique (AskUserQuestion), roda um
passo por vez e traduz o resultado. Fale em português simples, sem jargão: a pessoa pode não ser programadora.

## Regras (valem do começo ao fim)

- A chave do bot NUNCA passa pelo chat: ela entra só na janela que o passo `telegram-chave` abre. Se a pessoa colar a
  chave aqui mesmo assim, não repita nem use; explique que ela ficou no histórico desta conversa e oriente a trocar
  (no @BotFather: `/revoke`, escolher o bot e usar a chave nova na janela).
- Nunca leia nem mostre arquivo `.env`, variável de ambiente, o registro do Windows ou conversa antiga do Claude Code.
- Rode tudo na pasta do repositório (a que tem o `instalar.mjs`), sempre no formato `node instalar.mjs <passo>
  [opções]`. Sem o `instalar.mjs` na pasta atual: pare e explique que a conversa precisa ser aberta na pasta do
  repositório.
- Cada passo devolve um JSON. `"ok": true` = siga. `"ok": false` = mostre o `erro` (já vem em português) e ofereça
  tentar de novo ou parar. Nunca contorne um passo que falhou mexendo em arquivo por fora: o `instalar.mjs` guarda uma
  cópia antes de mudar qualquer arquivo e anota o que fez, e é isso que permite desfazer.
- Uma pergunta por vez quando a resposta muda o passo seguinte; até 4 juntas quando são independentes.

## Roteiro

### 1. Conferir o PC

`node instalar.mjs checar`

- Faltou algo: mostre cada `falta` (já diz o que fazer) e pare até a pessoa resolver; depois rode de novo.
- Guarde o `nomeDoWindows` (sugestão da pergunta 3).

### 2. Perguntas 1 e 2 (juntas)

1. "Onde você usa o Claude Code?" (várias): VS Code / Claude Desktop / Orca / Terminal ou outro.
   Vira `apps`: `vscode`, `desktop`, `orca`, `terminal`.
2. "Por onde você quer controlar?": Telegram (recomendado) / WhatsApp.
   WhatsApp ainda não entra nesta instalação: explique e ofereça seguir com o Telegram ou parar.

### 3. O bot do Telegram

1. Passo a passo (o único trecho no celular):
   - no Telegram, procure **@BotFather** (o oficial, com o selo azul) e abra a conversa;
   - mande `/newbot`, escolha um nome (ex.: "Meu Claude") e um usuário que termine em "bot" (ex.: `meu_claude_bot`);
   - o BotFather responde com a chave do bot (um número, dois pontos e letras). **Não cole a chave aqui.**
2. Pergunte: "Já está com a chave do bot?" Sim, abrir a janela / Ainda não (espere e pergunte de novo).
3. `node instalar.mjs telegram-chave` (prazo do comando: 10 minutos, o máximo): abre uma janela do PowerShell; a
   pessoa cola a chave lá e aperta Enter (a chave não aparece na tela). Voltou `bot` = diga "Bot @usuario conferido".
   `"erro": "cancelado"` = a janela fechou sem chave ou o prazo acabou. Se a pessoa disser que colou depois, rode
   `node instalar.mjs telegram-chave --so-conferir` (confere sem abrir a janela); senão, ofereça abrir de novo.
4. "Agora abra o seu bot (@usuario) no Telegram e mande `/start`." Pergunte: Mandei / Não achei o bot.
5. `node instalar.mjs telegram-chat`: lista quem falou com o bot (`chats`).
   - Lista vazia: peça pra mandar `/start` de novo e rode outra vez.
   - Pergunte "Qual dessas conversas é a sua?", uma opção por conversa (nome e @usuario).
   - `node instalar.mjs telegram-chat --confirmar <id>`

### 4. Perguntas 3 a 6 (juntas; antes, rode `node instalar.mjs pastas`)

3. "Como o Tele Control te chama nos recados?": o nome da conversa confirmada no Telegram / o `nomeDoWindows`.
   Vira `dono.nome`.
4. "Em quais pastas você abre o Claude Code pros seus projetos?" (várias): as `pastas` sugeridas, com o número de
   conversas de cada uma. Sem sugestão, peça o caminho completo (opção "Outro"). Vira `sessoes.raizes`.
5. "Modo rua (os avisos vão pro celular quando você sai do PC)": Sozinho, com o PC parado há 30 min (recomendado) / Só
   quando eu mandar `/rua`. Vira `modoRua`: `{"automatico": true|false, "ociosoMin": 30}`.
6. "Ligar junto com o Windows?": Sim (recomendado) / Não.

3b. Sozinha, depois das 3 a 6 (aí já se sabe o nome): "Nos recados, como fica?": "do <nome>" / "da <nome>" / "de <nome>",
    com o nome escolhido no lugar de `<nome>`. Vira `dono.artigo`: `o`, `a` ou `""`. O fuso não se pergunta: fica o do
    Windows.

### 5. Perguntas 7 a 10 (juntas)

7. "Áudio": Transcrever os áudios que eu mandar (instala Python e o faster-whisper, cerca de 1,5 GB) / Sem áudio por
   enquanto. Vira `transcricao.ligada`. Escolheu transcrever: `node instalar.mjs checar --audio`; faltou o Python =
   mostre a `falta` e ofereça seguir sem áudio.
8. "Posso pôr no seu CLAUDE.md a regra que faz as perguntas das sessões chegarem no celular?": Sim (recomendado) /
   Não, eu faço.
9. "Central (a sessão que recebe o que você manda pelo celular)": Cuidadosa (recomendado): faz o que o Claude Code
   libera sozinho e te conta o que ficou de fora / Livre: age sem pedir licença, como uma aba em modo bypass. Vira
   `central.modoPermissao`: `pedir` ou `sozinha`.
10. "Conversa resolvida no Telegram": Apagar (recomendado: quando a conversa com uma sessão se resolve, some a mensagem
    do robô e a sua, áudio e texto) / Manter (nada é apagado; a mensagem resolvida só perde os botões). Vira
    `telegram.resolvidas`: `apagar` ou `manter`. Dá pra trocar depois: o mesmo `config` só com esse campo e `--trocar`,
    e `node instalar.mjs ligar`.

### 6. Gravar e ligar

1. `node instalar.mjs config --dados '<json>'`, com o JSON numa linha só, entre aspas simples:
   `{"apps":["vscode"],"canalPrincipal":"telegram","telegram":{"ligado":true,"resolvidas":"apagar","ok":{"ligado":true}},"whatsapp":{"ligado":false},"dono":{"nome":"Fulano","artigo":"o"},"sessoes":{"raizes":["C:/projetos"]},"modoRua":{"automatico":true,"ociosoMin":30},"transcricao":{"ligada":false},"central":{"modoPermissao":"pedir"}}`
   - Aspas simples dentro de um valor: troque por ’.
   - Pasta sempre com barra normal (`C:/projetos`), mesmo quando o `pastas` mostrou com barra invertida: no terminal a
     barra invertida some e a pasta é recusada.
   - Voltou `conflitos` (uma instalação anterior tinha outro valor): mostre o antes e o depois e pergunte se troca;
     sim = o mesmo comando com `--trocar`.
2. `node instalar.mjs hooks` (os avisos do Claude Code; `jaTinha` = já estavam ligados, nada a fazer).
3. Sim na pergunta 6: `node instalar.mjs inicializar`.
4. Sim na pergunta 8: `node instalar.mjs claude-md`.
5. `node instalar.mjs ligar` (prazo do comando: 3 minutos): liga o Tele Control e manda pelo bot "Tele Control ligado neste
   PC. Responda aqui pra testar." Pergunte: Chegou / Não chegou.
   - Não chegou: confira se o `/start` foi pro bot certo e rode `telegram-chat` de novo.
   - Chegou: peça pra responder qualquer coisa no Telegram. Quem responde é a central, que abre sozinha na primeira
     vez (pode levar uns minutos).

### 7. Cartão final

`node instalar.mjs cartao` e mostre, nesta ordem: o que ficou ligado (`ligado`), a dica de cada app (`dicas`; no Orca
ela é importante), como desligar (`comoDesligar`) e, por último, sempre, o crédito (`credito`).

## Desfazer

- Desligar e tirar o que foi posto no Claude Code (avisos, início com o Windows, regra do CLAUDE.md), guardando a
  configuração: `node instalar.mjs desinstalar`.
- Tirar tudo, inclusive a configuração e a chave guardada: `node instalar.mjs desinstalar --tudo`.
- Rodar `/instalar` de novo é seguro: cada passo só acrescenta o que falta.
