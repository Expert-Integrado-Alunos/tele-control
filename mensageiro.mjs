// sessoes-wpp — mensageiro: entrega 1 recado do dono (vindo do grupo do WhatsApp ou, desde a fase 5a, do chat dele com o
// bot no Telegram: `pedido.canal === 'telegram'`) numa aba do VS Code.
// Por que assim: so uma sessao do Claude consegue usar SendMessage; o porteiro (sem IA) chama um `claude -p` curto que faz
// so isso (medido 27/09/2026 16:27: 11 s, 3 turnos, chegou na aba). Um por vez, com trava de arquivo: `claude -p` em
// paralelo corrompe o ~/.claude.json (incidente real). O recado abre com a ordem de citar a fala na 1a linha, porque na
// visao Focus o recado em si fica dobrado e invisivel. Contrato: PLANO.md ("Desenho" item 5).
import { spawn as spawnReal } from 'node:child_process';
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { claudeDoConfig, frasesDoDono, PADRAO_DONO, mensageiroDoConfig } from './lib/config.mjs';

const FALA1_MAX = 300;
const CITADA_MAX = 1500; // F4h: a mensagem citada de uma aba que fechou

// D6 (2a rodada do GPT-6, achado 8): registro do `claude -p` rodando, em <estadoDir>/mensageiro-filho.json =
// {pid do filho, porteiroPid (quem chamou), at (hora do spawn)}. Porteiro que morre com o filho vivo deixa o registro; o
// porteiro novo confere que o pid ainda e aquele claude (nome, pai e hora de criacao) e encerra a arvore antes de
// recuperar a entrega em voo. Apagado quando o filho fecha (so se for o registro dele).
export const ARQ_FILHO = 'mensageiro-filho.json';

// Identidade da sessao que ABRIU o porteiro (medido 27/09/2026 21:27: porteiro religado de dentro de uma aba herdava id,
// pid, socket e entrypoint claude-vscode dela, e o CLAUDE_CODE_CHILD_SESSION desliga o transcript). O `claude -p` do
// mensageiro nasce sem nada disso: ele e uma sessao propria (sdk-cli), nunca a aba que abriu o porteiro.
const HERDADAS = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_AGENT_SDK_VERSION',
  'CODEX_COMPANION_SESSION_ID', 'CODEX_COMPANION_TRANSCRIPT_PATH'];
export function ambienteDoMensageiro(base = process.env) {
  const env = { ...base, SESSOES_WPP_MENSAGEIRO: '1' };
  for (const k of HERDADAS) delete env[k];
  return env;
}

// A5a: o `--model <modelo>` vai antes destes (o modelo do config.json; padrao sonnet)
const ARGS_FIXOS = ['--allowedTools', 'SendMessage,ListAgents,ToolSearch', '--strict-mcp-config',
  '--mcp-config', '{"mcpServers":{}}', '--output-format', 'json'];

// O id vai tambem na ultima linha (28/09/2026 06:57 e 07:06, 2 abas): o `claude -p` juntou as 2 primeiras linhas do recado
// longo e o "id" sumiu; o porteiro nao achou o recado no transcript (alarme falso "ainda não pegou" e a resposta da aba nao
// voltou pro grupo). Nos 2 casos a ultima linha chegou intacta.
// A4b (PLANO-ABERTO.md, "A4b — os textos"): `D` = as frasesDoDono do dono do config.json ("do Davi", "da Ana", "de Sam";
// sem nome = "do dono"); o fim nao leva o nome do grupo nem o do bot.
const fimRecado = (id, D) => `Veio do número ${D.de} no grupo do WhatsApp, conferido pelo porteiro (id ${id}). A sua próxima resposta volta pro grupo sozinha, mas lá só chegam a 1ª frase depois da linha de citação e a pergunta (o resto, só se ${D.ele} pedir detalhe). Então: 1 frase do que aconteceu e, se precisar ${D.dele}, o bloco 🔴 **DECISÃO:** com as opções A) / B).`;
// Fase 5a (T3a, PLANO-TELEGRAM.md "Textos"): pedido vindo do chat do dono com o bot (id `tg-u<update_id>`).
// T7c1 (PLANO-T7.md, F3/F4): o chamado mostra so as 2 linhas da F4g; o texto inteiro sai no "Mais informações".
const fimRecadoTg = (id, D) => `Veio do Telegram ${D.de}, conferido pelo porteiro (id ${id}). A sua próxima resposta volta pro Telegram sozinha, mas lá só aparecem a 1ª frase depois da linha de citação e a pergunta (o texto inteiro, só quando ${D.ele} toca em Mais informações ou pede detalhe). Então: 1 frase do que aconteceu e, se precisar de uma escolha ${D.dele}, o bloco 🔴 **DECISÃO:** com as opções A) / B): elas viram botões.`;
// T7b2b (PLANO-T7.md, "F5 decidida", Desenho 1b): o toque do dono no botao Sim ou Nao do pedido de OK, no chat do bot
// (id `tgok-u<update_id>`). O recado nao leva a acao; a nota manda rodar o verificar antes de agir. O reforco (sem a nota,
// e a aba ja agiu) fecha sem a frase do verificar: com ela, a aba rodaria o verificar de novo e diria que o OK falhou.
const fimRecadoOkTg = (id, D, reforco = false) => `Veio do toque ${D.de} no botão Sim ou Não do pedido de OK (Telegram), conferido pelo porteiro (id ${id}).${reforco ? '' : ' Rode o verificar da nota antes de agir.'} A sua próxima resposta volta pro Telegram sozinha: 1 frase do que aconteceu e, se precisar de uma escolha ${D.dele}, o bloco 🔴 **DECISÃO:** com as opções A) / B).`;

/**
 * Texto que vai pra aba (literal; a aba ve isto como recado de outra sessao).
 * `p.reforco === true` (F3.6, reentrega porque a 1a resposta saiu sem a linha): recado curto SEM o texto do dono fora da
 * linha de citacao, sem nota e sem anexos, pra aba nao executar a acao 2 vezes. Mantem `id <providerMsgId>` na 1a linha:
 * e por ele que o porteiro acha o recado no transcript.
 * `p.canal === 'telegram'` (T3a): "Telegram <do dono>" na 1a linha e na citacao e o fim do Telegram. T4a: os anexos do
 * Telegram sao arquivos ja baixados no PC (`{tipo, caminho, nome}`): o bloco leva o caminho pra aba abrir com o Read;
 * anexo sem caminho fica fora. Sem `canal` (ou qualquer outro valor) = WhatsApp, byte a byte como antes (o bloco do
 * message_id continua so no WhatsApp).
 * T7b2b: `providerMsgId` com o prefixo `tgok-u` (o toque no botao Sim ou Nao do pedido de OK) fecha com o
 * fimRecadoOkTg, tambem no reforco (sem a frase do verificar); o `tg-u` e o WhatsApp ficam byte a byte.
 * A4b: `dono` = o {nome, artigo} do config.json (o donoDoConfig, que o porteiro passa pro criarMensageiro): o rotulo
 * ("Telegram da Ana"), a citada ("Ela respondeu") e o fim saem com as frasesDoDono dele; sem dono = o PADRAO_DONO
 * ("do dono").
 * T36 (PLANO-TELEGRAM.md "T36"): `p.parte` (string nao vazia) = o trecho da fala que e desta aba. A citacao (tambem a do
 * reforco) sai da parte e, antes da fala inteira, 1 linha diz que o resto foi pra outras sessoes e e so contexto.
 */
export function montarRecado(p, dono = PADRAO_DONO) {
  const D = frasesDoDono(dono);
  const texto = String(p?.texto ?? '').replaceAll('RECADO>>>', 'RECADO>>');
  // T36: a parte da fala que e desta aba (a mensagem dele tinha pedidos pra mais de uma sessao; o porteiro ja conferiu
  // que o trecho esta na fala). A citacao sai da parte; sem parte, tudo igual.
  const parte = typeof p?.parte === 'string' ? p.parte.replaceAll('RECADO>>>', 'RECADO>>').replace(/\s+/g, ' ').trim() : '';
  const umaLinha = parte || texto.replace(/\s+/g, ' ').trim();
  const cps = Array.from(umaLinha);
  const fala1 = cps.length > FALA1_MAX ? `${cps.slice(0, FALA1_MAX - 3).join('')}...` : umaLinha;
  const origem = p?.audio ? `${p.hora}, áudio transcrito, id ${p.providerMsgId}` : `${p.hora}, id ${p.providerMsgId}`;
  const doTelegram = p?.canal === 'telegram';
  const de = doTelegram ? `Telegram ${D.de}` : `WhatsApp ${D.de}`;
  const doToqueOk = String(p?.providerMsgId ?? '').startsWith('tgok-u'); // T7b2b
  const fim = doToqueOk ? fimRecadoOkTg : doTelegram ? fimRecadoTg : fimRecado;
  if (p?.reforco === true) {
    return [
      `${de} (${origem}). A sua resposta a esta mensagem saiu sem a linha de citação.`,
      'Não repita nenhuma ação que você já fez por causa dela. Só reescreva a resposta, abrindo com esta linha, literal:',
      `> ${de} (${p.hora}): «${fala1}»`,
      '',
      fim(p.providerMsgId, D, true), // so o fimRecadoOkTg usa o 3o argumento (sem a frase do verificar)
    ].join('\n');
  }
  const partes = [
    `${de} (${origem}). Abra a sua resposta com esta linha, literal:`,
    `> ${de} (${p.hora}): «${fala1}»`,
    '',
    ...(parte ? [`A mensagem ${D.de} tem pedidos pra mais de uma sessão. A parte pra você: «${parte}». O resto foi pra outras sessões: é só contexto, não aja nele. A mensagem inteira:`] : []),
    texto,
  ];
  // F4h: ele citou a mensagem de uma aba com o mesmo nome que fechou (a central reaberta): a pergunta dela, numa linha.
  // T5b: no Telegram ele responde em cima do chamado (ou toca num botao dele).
  const citada = typeof p?.citada === 'string' ? p.citada.replaceAll('RECADO>>>', 'RECADO>>').replace(/\s+/g, ' ').trim() : '';
  if (citada) {
    const cps = Array.from(citada);
    const curta = cps.length > CITADA_MAX ? `${cps.slice(0, CITADA_MAX - 3).join('')}...` : citada;
    const como = doTelegram ? 'respondeu em cima desta mensagem do Telegram' : 'respondeu citando esta mensagem do grupo';
    partes.push('', `${D.Ele} ${como}, de uma aba com o seu nome que fechou antes de você abrir (você não viu a conversa dela): «${curta}»`);
  }
  if (p?.nota) partes.push('', String(p.nota)); // instrucao do porteiro (ex.: pedido de OK), fora da linha de citacao
  const anexos = !doTelegram && Array.isArray(p?.anexos) ? p.anexos.filter((a) => a && a.messageId) : [];
  if (anexos.length) {
    partes.push('', 'Anexos no grupo do WhatsApp (baixe com download_attachment do whatsapp-agent):');
    for (const a of anexos) partes.push(`- ${a.tipo || 'arquivo'}, message_id ${a.messageId}`);
  }
  // T4a: anexo do Telegram = arquivo no PC (so o que tem caminho); nome e caminho numa linha so
  const anexosTg = doTelegram && Array.isArray(p?.anexos)
    ? p.anexos.filter((a) => a && typeof a.caminho === 'string' && a.caminho.trim())
    : [];
  if (anexosTg.length) {
    const linha = (s) => String(s).replace(/[\r\n]+/g, ' ').trim();
    partes.push('', 'Anexos (arquivos no PC; abra com a ferramenta Read):');
    for (const a of anexosTg) {
      const nome = typeof a.nome === 'string' && linha(a.nome) ? ` "${linha(a.nome)}"` : '';
      partes.push(`- ${linha(a.tipo || 'arquivo') || 'arquivo'}${nome}: ${linha(a.caminho)}`);
    }
  }
  partes.push('', fim(p?.providerMsgId, D));
  return partes.join('\n');
}

/** Ordem pro `claude -p`: achar a aba pelo nome e mandar o recado sem mudar nada. */
export function montarPrompt(nome, recado) {
  return [
    'Você é o mensageiro do porteiro do Tele Control (WhatsApp e Telegram). Faça só isto, nada mais:',
    '1. Se SendMessage ou ListAgents não estiverem carregadas, carregue com ToolSearch "select:SendMessage,ListAgents".',
    `2. Chame ListAgents e conte as sessões cujo nome é exatamente "${nome}".`,
    '   0 = responda só NAO_ACHEI. 2 ou mais = responda só DUPLICADO.',
    `   1 = chame SendMessage com to "${nome}" e message igual ao texto entre <<<RECADO e RECADO>>>, sem mudar nada; depois responda só ENVIADO.`,
    '   Copie todas as linhas, da primeira à última, na mesma ordem: sem juntar, resumir, reformatar nem apagar nenhuma (a 1ª linha e a última levam o id que confere a entrega).',
    'Não leia arquivos, não rode comandos e não espere resposta da outra sessão.',
    '<<<RECADO',
    recado,
    'RECADO>>>',
  ].join('\n');
}

/** stdout do `claude -p --output-format json` -> {status, detalhe}. Exatamente 1 token reconhecido, senao erro. */
export function lerSaida(stdout, code) {
  const curto = (s) => String(s).replace(/\s+/g, ' ').slice(0, 200);
  if (code !== 0) return { status: 'erro', detalhe: `exit ${code}` };
  let j = null;
  const linhas = String(stdout || '').trim().split('\n').reverse();
  for (const l of linhas) { try { j = JSON.parse(l); break; } catch { /* proxima */ } }
  if (!j) return { status: 'erro', detalhe: `saida ilegivel (${String(stdout || '').length} bytes)` };
  if (j.is_error) return { status: 'erro', detalhe: `is_error: ${curto(j.result ?? j.subtype ?? '')}` };
  const achados = new Set(String(j.result ?? '').toUpperCase().match(/\b(ENVIADO|NAO_ACHEI|DUPLICADO)\b/g) || []);
  if (achados.size !== 1) return { status: 'erro', detalhe: `resultado inesperado: ${curto(j.result ?? '')}` };
  return { status: [...achados][0].toLowerCase(), detalhe: '' };
}

function pidVivo(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

// A3a: `claudeBin` (CLI: o claudeDoConfig do config.json, o mesmo da central e da escondida); sem ele = o claudeDoConfig({})
// deste processo (CLAUDE_BIN, o do instalador oficial ou o do PATH). A4b: `dono` (o donoDoConfig do config.json) vai pro
// montarRecado; sem ele = o PADRAO_DONO ("do dono"). A5a: `modelo` (CLI: o mensageiroDoConfig do config.json) vai no
// `--model` do `claude -p`, normalizado aqui pelo mensageiroDoConfig (ausente ou fora do formato = sonnet).
export function criarMensageiro({
  claudeBin = claudeDoConfig({}, { env: process.env }),
  spawn = spawnReal,
  estadoDir,
  dono = PADRAO_DONO,
  modelo,
  dormir = (ms) => new Promise((r) => setTimeout(r, ms)),
  timeoutMs = 120000,
  esperaTravaMs = 180000,
  travaVelhaMs = 180000,
} = {}) {
  const travaArq = join(estadoDir, 'mensageiro.lock');
  const filhoArq = join(estadoDir, ARQ_FILHO);
  const argsModelo = ['--model', mensageiroDoConfig({ mensageiro: { modelo } }).modelo]; // A5a

  // Sem pid (spawn falso) ou erro ao gravar = sem registro: o porteiro novo so espera e confere a aba (nao mata nada).
  function registrarFilho(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return;
    try {
      writeFileSync(filhoArq, JSON.stringify({ pid, porteiroPid: process.pid, at: new Date().toISOString() }));
    } catch { /* sem registro */ }
  }

  function apagarFilho(pid) {
    try {
      if (JSON.parse(readFileSync(filhoArq, 'utf8'))?.pid === pid) unlinkSync(filhoArq);
    } catch { /* ja saiu, ou de outro */ }
  }

  async function pegarTrava() {
    const token = randomUUID();
    const inicio = Date.now();
    for (;;) {
      try {
        const fd = openSync(travaArq, 'wx');
        try { writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token })); } finally { closeSync(fd); }
        return token;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      let dono = null;
      try { dono = JSON.parse(readFileSync(travaArq, 'utf8')); } catch { /* ilegivel = trata como velha */ }
      const idade = dono?.at ? Date.now() - Date.parse(dono.at) : Infinity;
      if (!dono || !(idade <= travaVelhaMs) || !pidVivo(dono.pid)) {
        try { unlinkSync(travaArq); } catch { /* outro removeu */ }
        continue;
      }
      if (Date.now() - inicio >= esperaTravaMs) return null;
      await dormir(250);
    }
  }

  function soltarTrava(token) {
    try {
      const dono = JSON.parse(readFileSync(travaArq, 'utf8'));
      if (dono.token === token) unlinkSync(travaArq);
    } catch { /* ja saiu */ }
  }

  function rodar(prompt) {
    return new Promise((resolve) => {
      let stdout = '';
      let acabou = false;
      let estourou = false;
      let pidFilho = null;
      const fim = (r) => {
        if (acabou) return;
        acabou = true;
        clearTimeout(relogio);
        if (pidFilho !== null) apagarFilho(pidFilho);
        resolve(r);
      };
      let filho;
      try {
        filho = spawn(claudeBin, ['-p', prompt, ...argsModelo, ...ARGS_FIXOS], {
          cwd: estadoDir, env: ambienteDoMensageiro(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        resolve({ erro: `spawn: ${String(e?.message || e).slice(0, 150)}` });
        return;
      }
      if (Number.isInteger(filho?.pid) && filho.pid > 0) {
        pidFilho = filho.pid;
        registrarFilho(pidFilho);
      }
      const relogio = setTimeout(() => { estourou = true; try { filho.kill(); } catch { /* ja morreu */ } }, timeoutMs);
      filho.stdout?.on('data', (b) => { if (stdout.length < 1 << 20) stdout += b; });
      filho.stderr?.on('data', () => { /* descartado: nao vai pro log */ });
      filho.on('error', (e) => fim({ erro: `spawn: ${String(e?.message || e).slice(0, 150)}` }));
      filho.on('close', (code) => fim(estourou ? { erro: `timeout ${Math.round(timeoutMs / 1000)} s` } : { stdout, code }));
    });
  }

  /** Entrega 1 recado. Nunca lanca: {status:'enviado'|'nao_achei'|'duplicado'|'erro', detalhe}. */
  async function entregar(pedido) {
    let token;
    try { token = await pegarTrava(); } catch (e) { return { status: 'erro', detalhe: `trava: ${String(e?.message || e).slice(0, 150)}` }; }
    if (!token) return { status: 'erro', detalhe: 'trava do mensageiro ocupada ha mais de 3 min' };
    try {
      const r = await rodar(montarPrompt(pedido.nome, montarRecado(pedido, dono)));
      if (r.erro) return { status: 'erro', detalhe: r.erro };
      return lerSaida(r.stdout, r.code);
    } finally {
      soltarTrava(token);
    }
  }

  return { entregar };
}
