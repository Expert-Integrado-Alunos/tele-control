#!/usr/bin/env node
'use strict';
/*
 * sessao-parou — hook Stop do sessoes-wpp (plano: PLANO.md, Desenho item 1).
 *
 * Por que existe: da rua, o dono so fica sabendo que uma aba do VS Code parou esperando por ele
 * se alguem registrar isso. Este hook grava 1 evento "parou" em eventos.jsonl a cada fim de vez
 * de uma aba do VS Code (entrypoint "claude-vscode"), com nome salvo, pasta, hora, a mensagem
 * final literal (no maximo os ultimos 6000 chars) e as marcas (DECISAO / "Fica com voce" /
 * pergunta). Quem decide avisar no WhatsApp e o porteiro, que deduplica por finalTs; por isso o
 * evento e gravado mesmo com stop_hook_active true.
 *
 * Headless (sdk-cli), Claude Desktop SEM canal de recado e sessao sem registro: sai calado (F4i, 05/10/2026: o Desktop com
 * messagingSocketPath entra, pela mesma regra do lib.ehInterativa).
 * Le so a cauda do transcript (2 MB): roda em todo Stop, com transcript de dezenas de MB.
 *
 * F4f b (medido 01/10/2026 00:45, CLI 2.1.286, 1a vez de uma sessao escondida aberta pelo porteiro): o transcript chega
 * no disco com atraso. No Stop, a resposta final ainda nao estava no arquivo; ~20 ms depois, estava. Sem esperar, a 1a
 * vez nao gerava evento nenhum (e a resposta da sessao nova nunca voltava pro grupo) e uma vez seguinte podia sair com a
 * resposta velha (5 em 1416 eventos de 27/09 a 01/10). Agora, resposta da vez ainda fora do arquivo (lib.respostaFresca)
 * = le de novo a cada ESPERA_PASSO_MS, ate ESPERA_MAX_MS; nao veio = segue com o que tem, como antes.
 *
 * F4f c (06/10/2026 06:06, CLI 2.1.290, central no terminal escondido com o PC carregado): a resposta chegou no arquivo
 * ~4 s depois do Stop, os 3 s passaram, o evento saiu com a resposta da vez anterior e o porteiro descartou como repetido
 * (a resposta nunca chegou no Telegram). A doc oficial manda usar o `last_assistant_message` do Stop: com ele, o final vem
 * dele, sem espera; o finalTs e o da ultima resposta do transcript quando e a mesma, senao a hora do evento
 * (`fonteFinal: 'stop'`). Sem o campo = a espera de antes (`fonteFinal: 'transcript'`).
 *
 * Contrato de saida: SEMPRE exit 0, NUNCA escreve em stdout (Stop nao decide nada), erro interno
 * vai pro log (~/.claude/logs/sessoes-wpp.log ou SESSOES_WPP_LOG), nunca pra sessao.
 */
const fs = require('fs');
const lib = require('./lib/sessoes-wpp.js');

const FINAL_MAX = 6000;
const NOME = 'sessao-parou';
const ESPERA_PASSO_MS = 100;
const ESPERA_MAX_MS = 3000;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

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

process.on('uncaughtException', (e) => { registrarErro(`excecao: ${e && e.stack ? e.stack : e}`); sair(); });
process.on('unhandledRejection', (e) => { registrarErro(`rejeicao: ${e && e.stack ? e.stack : e}`); sair(); });

// Ultimos FINAL_MAX chars sem deixar surrogate orfao no inicio (emoji cortado ao meio).
function cauda(texto) {
  if (texto.length <= FINAL_MAX) return texto;
  let s = texto.slice(-FINAL_MAX);
  const c = s.charCodeAt(0);
  if (c >= 0xdc00 && c <= 0xdfff) s = s.slice(1);
  return s;
}

// F4f c: o last_assistant_message do Stop (texto nao vazio) | null.
function textoDoStop(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

// F4f c: o texto do Stop e a ultima resposta do transcript sao a mesma (espacos nao contam; o do Stop pode trazer blocos
// a mais antes do ultimo).
function mesmoFinal(doStop, doArquivo) {
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
  const a = norm(doStop);
  const b = norm(doArquivo);
  return Boolean(b) && (a === b || a.endsWith(` ${b}`));
}

async function processar(bruto) {
  let entrada;
  try { entrada = JSON.parse(bruto); } catch (e) { registrarErro(`stdin nao e JSON: ${e.message}`); return; }
  if (!entrada || typeof entrada !== 'object') return;

  const sessionId = entrada.session_id;
  const registro = lib.acharRegistro(sessionId, cam.sessionsDir);
  if (!registro) return;
  if (!lib.ehInterativa(registro)) return; // aba do VS Code ou terminal interativo (F3.9)

  const tp = entrada.transcript_path;
  if (!tp || typeof tp !== 'string') { registrarErro(`sem transcript_path (sessao ${sessionId})`); return; }
  if (!fs.existsSync(tp)) { registrarErro(`transcript inexistente: ${tp}`); return; }

  let entradas = lib.lerCauda(tp);
  const doStop = textoDoStop(entrada.last_assistant_message);
  let final;
  let finalTs;
  let fonteFinal;
  if (doStop) {
    // F4f c: o texto final vem do proprio Stop (sem esperar o arquivo). finalTs = o da ultima resposta do transcript
    // quando ela e a mesma (o porteiro deduplica pelo finalTs, como antes); senao, a hora de agora.
    const noArquivo = lib.ultimaResposta(entradas);
    const mesma = noArquivo && lib.respostaFresca(entradas) && mesmoFinal(doStop, noArquivo.texto);
    if (!mesma) registrarErro(`transcript atrasado (sessao ${sessionId}): o texto final veio do Stop`);
    final = doStop;
    finalTs = mesma && noArquivo.ts ? noArquivo.ts : new Date().toISOString();
    fonteFinal = 'stop';
  } else {
    for (const fim = Date.now() + ESPERA_MAX_MS; !lib.respostaFresca(entradas) && Date.now() < fim;) {
      await dormir(ESPERA_PASSO_MS);
      entradas = lib.lerCauda(tp);
    }
    const resposta = lib.ultimaResposta(entradas);
    if (!resposta) return;
    final = resposta.texto;
    finalTs = resposta.ts;
    fonteFinal = 'transcript';
  }

  const ev = {
    v: 1,
    tipo: 'parou',
    at: new Date().toISOString(),
    sessionId,
    pid: registro.pid == null ? null : registro.pid,
    nome: registro.name == null ? null : registro.name,
    titulo: lib.tituloDe(entradas, registro),
    cwd: registro.cwd == null ? (entrada.cwd == null ? null : entrada.cwd) : registro.cwd,
    entrypoint: registro.entrypoint,
    final: cauda(final),
    finalTs,
    marcas: lib.marcas(final),
    fonteFinal,
  };
  // T21 (PLANO-TELEGRAM.md, "T21", contrato 2): a conversa roda num terminal do Orca = so a PRESENCA do
  // ORCA_TERMINAL_HANDLE (o Orca poe em todo terminal que abre). Nenhum valor de variavel do Orca vai pro evento
  // (ORCA_AGENT_HOOK_TOKEN e segredo). Sem a variavel, o evento sai como antes (sem a chave `app`).
  const orca = process.env.ORCA_TERMINAL_HANDLE;
  if (typeof orca === 'string' && orca !== '') ev.app = 'orca';
  // T27 (PLANO-TELEGRAM.md, "T27", contrato 1): a aba continuou por um hook de Stop (nao por ele) = a mesma vez da parada
  // anterior; o porteiro nao encerra o chamado por causa desta. Sem o campo true, o evento sai como antes.
  if (entrada.stop_hook_active === true) ev.continuacao = true;
  lib.anexarEvento(cam.estadoDir, ev);
}

let bruto = '';
const guarda = setTimeout(() => { registrarErro('stdin nao fechou em 10 s'); sair(); }, 10000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { bruto += d; });
process.stdin.on('error', (e) => { registrarErro(`stdin: ${e.message}`); clearTimeout(guarda); sair(); });
process.stdin.on('end', () => {
  clearTimeout(guarda);
  processar(bruto)
    .catch((e) => registrarErro(`erro: ${e && e.stack ? e.stack : e}`))
    .finally(sair);
});
