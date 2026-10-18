> **Publicado pela Expert Integrado — versão 2026-10-18-475ec99.** Cópia pública de `tele-control`, gerada automaticamente a partir da fonte interna (sem histórico) pelo robô publicador. Issues e pull requests aqui não são acompanhados; contato em expertintegrado.com.br.

# Tele Control — as abas do Claude Code do seu PC, controladas pelo celular

Criado por **Eric Luciano** na **Mentoria Automações Inteligentes**.

## O que é

Você deixa várias conversas do Claude Code trabalhando no PC e sai. Quando uma delas para esperando você (uma pergunta,
uma decisão, algo que só você pode fazer), o aviso chega no seu Telegram. Você responde por texto ou por áudio e a
resposta entra na conversa certa, lá no PC. O que você manda sem citar um aviso vai para a "central", uma sessão
escondida do Claude Code que descobre de qual conversa é o assunto e entrega lá, ou responde ela mesma.

## Como funciona

- **O porteiro**: um processo sem IA que fica ligado no PC. Ele lê o seu bot do Telegram, manda os avisos e entrega
  cada resposta na conversa certa, uma por vez. Se ele cair, volta sozinho quando uma conversa do Claude Code abrir.
- **Modo rua**: com ele ligado, os avisos vão para o celular. Liga sozinho quando o PC fica parado por 30 minutos (dá
  pra mudar) ou quando você manda `/rua`; desliga quando você volta a mexer no PC ou manda `/voltei`. Se preferir, ele
  liga só pelo comando.
- **Menu e botões no Telegram**: `/painel` mostra as conversas abertas (trabalhando e paradas), `/pendencias` lista o
  que espera por você e `/central` reabre a central. Quando uma ação tem efeito fora do PC (mandar mensagem para
  alguém, publicar, pagar, apagar), a central pede o seu OK numa mensagem com os botões **Sim** e **Não** e só age
  depois do Sim.
- **A central**: recebe o que chega sem citar, acha a conversa dona do assunto e repassa. Também reabre uma conversa
  fechada (ou abre uma nova) numa das suas pastas de projeto, a pedido seu pelo celular.
- **Áudio** (opcional): com a transcrição ligada, o áudio que você manda vira texto no próprio PC (faster-whisper)
  antes de entrar na conversa. Sem ela, mande por escrito.
- **Resposta em voz** (opcional): quando você fala por áudio, a resposta também chega em áudio. Vem ligada; para
  desligar, ponha `"voz": false` dentro de `telegram` na configuração.
- **Conversa resolvida**: quando o assunto com uma conversa se resolve, o Tele Control apaga do Telegram a mensagem do
  robô e a sua (texto e áudio), ou mantém tudo e só tira os botões. Você escolhe na instalação.

## Requisitos

- Windows 10 ou 11. Mac e Linux: ainda não.
- Node.js 22.16 ou mais novo.
- Claude Code 2.1.295 ou mais novo.
- Windows Terminal e PowerShell.
- Um bot do Telegram, só seu (o `/instalar` ensina a criar no @BotFather). Na v1 o canal é a conversa privada com o seu
  bot; grupo do Telegram: ainda não.
- Python 3.10 ou mais novo, só se quiser transcrever áudio (o faster-whisper ocupa cerca de 1,5 GB).
- WhatsApp: opcional, só com um conector de WhatsApp já ligado no seu Claude Code. A instalação guiada liga só o
  Telegram, que é o recomendado.

Não tem `npm install`: o código é Node puro, sem dependências.

## Instalação

1. Baixe este repositório para uma pasta do PC (`git clone` ou o botão **Code > Download ZIP**).
2. Abra o Claude Code **nessa pasta**: no VS Code, no Claude Desktop, no Orca ou no terminal. Se ele perguntar se você
   confia na pasta, aceite.
3. Digite `/instalar`.

A instalação confere o PC (`node instalar.mjs checar`) e faz estas perguntas, com opções de clique:

1. **Onde você usa o Claude Code?** VS Code, Claude Desktop, Orca, terminal ou outro (pode marcar vários).
2. **Por onde quer controlar?** Telegram (recomendado). Em seguida vêm o passo a passo do @BotFather, a chave do bot
   numa janela à parte e um `/start` para o seu bot, que mostra ao Tele Control qual é a sua conversa.
3. **Como o Tele Control te chama nos recados?** E se fica "do", "da" ou "de" antes do nome.
4. **Em quais pastas você abre o Claude Code para os seus projetos?** É só nelas que o celular abre e reabre conversa.
5. **Modo rua:** sozinho, com o PC parado há 30 minutos (recomendado), ou só quando você mandar `/rua`.
6. **Ligar junto com o Windows?** Sim (recomendado) ou não.
7. **Áudio:** transcrever os áudios que você mandar (precisa do Python e do faster-whisper, cerca de 1,5 GB) ou sem
   áudio por enquanto.
8. **Posso pôr no seu `CLAUDE.md` a regra que faz as perguntas das sessões chegarem no celular?** Sim (recomendado) ou
   não, eu faço. A regra ensina o Claude a fechar a resposta com "DECISÃO:", com "Fica com você:" ou com a pergunta
   na última linha; sem isso, quase nada chega no celular.
9. **Central:** Cuidadosa (recomendado: faz o que o Claude Code libera sozinho e te conta o que ficou de fora) ou Livre
   (age sem pedir licença, como uma aba em modo bypass).
10. **Conversa resolvida no Telegram:** apagar (recomendado) ou manter.

A chave do bot nunca passa pelo chat: ela entra numa janela própria do PowerShell, com a digitação escondida, e fica
guardada na variável de usuário `SESSOES_WPP_TELEGRAM_TOKEN`. Se colar a chave no chat por engano, troque-a no
@BotFather (`/revoke`) e use a nova na janela.

No fim, o Tele Control liga e manda no seu bot: "Tele Control ligado neste PC. Responda aqui pra testar." Responda
qualquer coisa: quem atende é a central, que na primeira vez pode levar alguns minutos para abrir. Depois vem um cartão
com o que ficou ligado e como desligar. Rodar `/instalar` de novo é seguro: cada passo só acrescenta o que falta.

## Depois de instalar

- **Configuração**: `%USERPROFILE%\.claude\sessoes-wpp\config.json`. Todo campo é opcional; o que falta ou está fora
  do formato fica no padrão. Mudou o arquivo, religue com `node instalar.mjs ligar` (na pasta do repositório). Também
  dá para rodar `/instalar` de novo: quando uma resposta muda, ele mostra o antes e o depois e pergunta se troca.

  | campo | o que faz | valores |
  | --- | --- | --- |
  | `modoRua.automatico`, `modoRua.ociosoMin` | modo rua sozinho; depois de quantos minutos parado | `true` ou `false`; 5 a 240 (padrão 30) |
  | `sessoes.raizes` | pastas onde o celular abre e reabre conversa | lista de pastas |
  | `central.modoPermissao` | central Cuidadosa ou Livre | `pedir` ou `sozinha` |
  | `transcricao.ligada` | transcrição dos áudios | `true` ou `false` |
  | `telegram.voz` | resposta em voz | `false` desliga |
  | `telegram.resolvidas` | conversa resolvida | `apagar` ou `manter` |
  | `dono.nome` | como o Tele Control te chama | texto |

- **Desligar** (guarda a configuração): `node instalar.mjs desinstalar`. Para o Tele Control e tira o que ele pôs no
  Claude Code (os avisos, o início com o Windows e a regra do `CLAUDE.md`). Para voltar, rode `/instalar` de novo.
- **Desinstalar tudo**: `node instalar.mjs desinstalar --tudo`. Também tira o `config.json` (fica uma cópia) e a
  chave do bot guardada no Windows.
- **Orca**: nas configurações do Orca, desligue o acompanhamento de status dos agentes (ou só o do Claude). Senão o
  Orca grava hooks no Claude Code que rodam em toda conversa do PC e deixam tudo mais lento. O Tele Control não
  depende deles.

## Privacidade

Tudo roda no seu PC. O que sai dele: as mensagens trocadas com o seu bot do Telegram (e com o WhatsApp, se você ligar)
e, com a resposta em voz, o texto da resposta, que vai para o serviço de voz da Microsoft virar áudio. A transcrição
dos áudios é local. Não existe servidor do Tele Control no meio: nada passa por quem criou o sistema.

## Marca d'água

O Tele Control põe uma linha de procedência no fim das instruções da central (o prompt do Claude que ele monta). Para
tirar (white-label), defina `EXPERT_NO_PROVENANCE=1` nas variáveis de ambiente do usuário.

## Para quem programa

- `porteiro.mjs`: o processo sem IA (modo rua, avisos, leitura do Telegram, roteamento, fila de envio).
- `mensageiro.mjs`: entrega a sua fala na conversa certa, um recado por vez.
- `central/`: a sessão escondida que recebe o que chega sem citar.
- `telegram.mjs` e `canal-telegram.mjs`: o bot do Telegram. `wpp.mjs`: o WhatsApp (opcional). `ok-wpp.mjs`: o pedido
  de OK.
- `hooks/`: os gatilhos do Claude Code (conversa parou, pergunta com o modo rua ligado, religar o porteiro).
- `instalar.mjs` e `.claude/skills/instalar/`: o instalador. Sem IA; cada passo devolve um JSON e guarda uma cópia de
  todo arquivo antes de mudar.
- `lib/`: formato das mensagens, roteamento e a leitura da configuração.
- `tests/` e `hooks/tests/`: os testes automáticos (`node --test`).

## Licença

Licença de uso (texto completo no arquivo [`LICENSE`](LICENSE)): licenciado ao aluno matriculado na Mentoria Automações
Inteligentes e ao cliente da Empresa Inteligente, para uso próprio e da própria empresa, nos termos do contrato;
redistribuição, revenda, sublicenciamento e publicação pública não são autorizados.

---

Procedência: o Tele Control é um sistema criado por Eric Luciano, educador e mentor de IA aplicada a negócios, da Expert Integrado (expertintegrado.com.br).
