#!/usr/bin/env node
'use strict';
/*
 * pergunta-modo-rua — hook PreToolUse (matcher AskUserQuestion) do sessoes-wpp
 * (plano: PLANO.md, Desenho item 2).
 *
 * Por que existe: com o dono fora do PC, um AskUserQuestion aberto prende a aba (botoes na tela
 * que ninguem clica) e o recado que vem do WhatsApp fica na fila sem responder a pergunta. Com o
 * modo rua LIGADO e FRESCO (estado.json do porteiro atualizado ha no maximo 5 min), este hook
 * nega o AskUserQuestion mandando escrever a pergunta como bloco DECISAO em texto e encerrar a
 * vez (o Stop dessa vez vira evento "parou" com marca decisao), e grava o evento
 * "pergunta-barrada" com as perguntas e opcoes literais.
 *
 * Modo rua velho (porteiro morto), desligado ou ausente = trata como desligado: os botoes do
 * dono no PC nunca ficam presos por estado podre. So sessoes interativas (lib.ehInterativa: VS Code, terminal e, desde a
 * F4i, Claude Desktop com canal de recado); outra ferramenta, outra origem ou sessao sem registro = sai calado.
 *
 * F4f (sessoes-wpp, 30/09/2026): a sessao nova que o porteiro abre ESCONDIDA no PC (central/abrir-sessao.vbs) nasce com
 * SESSOES_WPP_ESCONDIDA=1 no ambiente. Ninguem ve os botoes dela, entao o AskUserQuestion e negado SEMPRE (com ou sem
 * modo rua), com motivo proprio, e o evento "pergunta-barrada" sai igual. Precisa do registro interativo do mesmo jeito.
 *
 * Contrato de saida: SEMPRE exit 0. Sem decisao = stdout vazio. Deny = JSON do PreToolUse
 * (hookSpecificOutput.permissionDecision 'deny'). Erro interno vai pro log, nunca pra sessao (falha = libera a ferramenta).
 * Evento que nao grava nao impede o deny: o bloco DECISAO em texto ainda chega pelo Stop.
 */
const lib = require('./lib/sessoes-wpp.js');

const NOME = 'pergunta-modo-rua';
const MOTIVO = 'A pessoa que usa este PC está fora dele (modo rua). Não use AskUserQuestion agora: escreva a pergunta em texto, no bloco 🔴 **DECISÃO:** com as opções A/B, e encerre a vez. Os botões voltam quando ela estiver no PC.';
const MOTIVO_ESCONDIDA = 'Esta sessão roda escondida no PC (aberta pelo celular): ninguém vê os botões. Escreva a pergunta em texto, no bloco 🔴 **DECISÃO:** com as opções A/B, e encerre a vez.';
const ESCONDIDA = process.env.SESSOES_WPP_ESCONDIDA === '1';

let cam = { logFile: null };
try { cam = lib.caminhos(process.env); } catch (_) { /* sem caminhos = sem log */ }

function registrarErro(msg) {
  if (cam.logFile) lib.log(cam.logFile, `${NOME}: ${msg}`);
}

let encerrado = false;
function sair() {
  if (encerrado) return;
  encerrado = true;
  process.exit(0);
}
function finish(o) { encerrado = true; process.stdout.write(JSON.stringify(o || {})); process.exit(0); }
function deny(motivo) {
  finish({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: motivo } });
}

process.on('uncaughtException', (e) => { registrarErro(`excecao: ${e && e.stack ? e.stack : e}`); sair(); });
process.on('unhandledRejection', (e) => { registrarErro(`rejeicao: ${e && e.stack ? e.stack : e}`); sair(); });

function perguntasDe(toolInput) {
  const qs = toolInput && Array.isArray(toolInput.questions) ? toolInput.questions : [];
  return qs.map((q) => ({
    pergunta: q && typeof q.question === 'string' ? q.question : '',
    opcoes: (q && Array.isArray(q.options) ? q.options : [])
      .map((o) => (o && typeof o.label === 'string' ? o.label : ''))
      .filter((l) => l !== ''),
  }));
}

// Devolve true quando e para negar.
function decidir(bruto) {
  let entrada;
  try { entrada = JSON.parse(bruto); } catch (e) { registrarErro(`stdin nao e JSON: ${e.message}`); return false; }
  if (!entrada || typeof entrada !== 'object') return false;
  if (entrada.tool_name !== 'AskUserQuestion') return false;

  if (!ESCONDIDA) { // F4f: a sessao escondida nega sempre; as outras so com o modo rua efetivo
    const modo = lib.lerModoRua(cam.estadoDir);
    if (!modo.efetivo) return false;
  }

  const sessionId = entrada.session_id;
  const registro = lib.acharRegistro(sessionId, cam.sessionsDir);
  if (!lib.ehInterativa(registro)) return false; // aba do VS Code ou terminal interativo (F3.9)

  try {
    const entradas = typeof entrada.transcript_path === 'string' ? lib.lerCauda(entrada.transcript_path) : [];
    const ev = {
      v: 1,
      tipo: 'pergunta-barrada',
      at: new Date().toISOString(),
      sessionId,
      pid: registro.pid == null ? null : registro.pid,
      nome: registro.name == null ? null : registro.name,
      titulo: lib.tituloDe(entradas, registro),
      cwd: registro.cwd == null ? (entrada.cwd == null ? null : entrada.cwd) : registro.cwd,
      perguntas: perguntasDe(entrada.tool_input),
    };
    lib.anexarEvento(cam.estadoDir, ev);
  } catch (e) {
    registrarErro(`evento nao gravado (deny segue): ${e && e.stack ? e.stack : e}`);
  }
  return true;
}

let bruto = '';
const guarda = setTimeout(() => { registrarErro('stdin nao fechou em 10 s'); sair(); }, 10000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { bruto += d; });
process.stdin.on('error', (e) => { registrarErro(`stdin: ${e.message}`); clearTimeout(guarda); sair(); });
process.stdin.on('end', () => {
  clearTimeout(guarda);
  let negar = false;
  try { negar = decidir(bruto); } catch (e) { registrarErro(`erro: ${e && e.stack ? e.stack : e}`); negar = false; }
  if (negar) deny(ESCONDIDA ? MOTIVO_ESCONDIDA : MOTIVO);
  sair();
});
