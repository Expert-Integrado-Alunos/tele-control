// Testes da T8 (PLANO-TELEGRAM.md, "T8 — reabrir a aba fechada pelo celular"; pedido do dono, opção A: "Faço a
// reabertura da aba fechada pelo celular, com a conversa antiga inteira?"). Antes: a fala pra uma aba fechada dava "Não
// achei a sessão X aberta no PC." e a central mandava reabrir no PC (caso real).
// T18 (PLANO-TELEGRAM.md, "T18"; caso real: "toda interação que eu fizer eu use a mesma aba que já existia"; OK do
// dono ao desenho): a T8 abria uma CÓPIA escondida (`--fork-session --session-id <uuid>`), que virava outra
// conversa na lista do VS Code com o histórico partido (9 cópias de 07 a 11/10). Agora o porteiro retoma a MESMA conversa
// escondida (`claude --resume <sid>`, medido 11/10 23h: mesmo sessionId, nenhum arquivo novo) e passa a mesma fala pra
// ela; `-n` só com o título dado exato e livre (o `-n` reescreve o título; medido 12/10 00h3x).
// - T8 1 a 4: o "não achei" que retoma (Telegram), a 2a fala que espera junto, a fala depois direto pra ela, a cadeia das
//   cópias antigas (a mais nova volta como ela mesma) e a retomada que fecha e volta de novo.
// - T8 5 e 6: o que não reabre (cada motivo, fala que já ia pra retomada, sem o abridor) e as falhas (abridor, prazo,
//   trava).
// - T8 7 a 9: o reabrir-sessao da central (feliz e calada, aba viva, cadeia, não reabrível, fala que não existe, guardas).
// - T8 10 a 12: painel, estado do disco (religar no meio, item torto) e WhatsApp.
// - T8 13 a 16: o abridor real com 3 argumentos, o .vbs de verdade com claude falso, o CLI e as instruções.
// - T18 1 a 3: o nome da retomada (o -n só com o título dado exato e livre), a aba viva com o mesmo sessionId (nunca
//   retoma por cima de um processo vivo) e a retomada sem -n e sem título (nome derivado, "essa aba" nas frases).
// Isolamento: pastas temporarias via SESSOES_WPP_DIR, CLAUDE_SESSIONS_DIR, CLAUDE_PROJECTS_DIR e SESSOES_WPP_LOG (nunca o
// ~/.claude real); raizes de mentira (projetos e Area) dentro da pasta temporaria. Nenhuma rede: `tg`, `wpp`,
// mensageiro e o abridor da sessao escondida sao dubles. Relogio e `dormir` falsos. Harness copiado do
// tests/porteiro-t6.test.mjs + o chamadoNaTela do tests/porteiro-telegram.test.mjs.
// Rodar: node --test --test-reporter=tap "tests/porteiro-t8.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { criarPorteiro, abrirSessaoEscondidaReal } from '../porteiro.mjs';
import { NUMERO_DONO } from './lib/dados-whatsapp.mjs';
import { CENTRAL_TESTE } from './lib/dados-central.mjs';
import { montarRecado } from '../mensageiro.mjs';
import { criarCanalTelegram } from '../canal-telegram.mjs';

const require = createRequire(import.meta.url);
const lib = require('../hooks/lib/sessoes-wpp.js');
const PORTEIRO = fileURLToPath(new URL('../porteiro.mjs', import.meta.url));
const CENTRAL_DIR = path.join(path.dirname(PORTEIRO), 'central');

const MIN = 60 * 1000;
const T0 = Date.parse('2026-09-29T15:00:00Z'); // 12:00 em Brasilia
const iso = (ms) => new Date(ms).toISOString();
const DONO = 700100200; // chat do dono (sintetico)
const BOT = 700900800; // o bot (sintetico)

const S1 = '5a1f0c2e-1b7d-4c3a-9e2f-0123456789ab'; // a aba que fechou
const TIT = 'Campanha Verão planejamento';
const FINAL_FIN = '🟢 O material está pronto.\n\n🔴 **DECISÃO:** Mando pro Caio?\nA) Sim / B) Não';
const CENTRAL = 'Central de sessões de teste';
const DECISAO = { decisao: true, fica: false, pergunta: false };
// Frases por extenso de proposito (o teste prende o texto). Sem o cabecalho = como saem no Telegram.
const TXT8 = {
  naoAchei: `Não achei a sessão ${TIT} aberta no PC. "status" lista as que estão abertas.`,
  falhou: `Não consegui reabrir a aba ${TIT} no PC.`,
  naoApareceu: `Não consegui reabrir a aba ${TIT} no PC: ela não apareceu em 3 min.`,
  naoDa: (t, motivo) => (t ? `Não dá pra reabrir a aba ${t} pelo celular: ${motivo}.` : `Não dá pra reabrir essa aba pelo celular: ${motivo}.`),
  naoAcheiMsg: `Não achei a mensagem pra passar pra ${TIT}.`,
};

// ---------- harness (copia do tests/porteiro-t6.test.mjs) ----------

const tique = () => new Promise((ok) => setImmediate(ok));
async function bombear(p) {
  for (let i = 0; i < 100; i++) {
    const r = await p.passoEntrega();
    if (!r.emVoo && !r.fila) return;
    await tique();
  }
  throw new Error('bombear: a fila de entrega nao esvaziou');
}
function comBomba(cru) {
  return {
    ...cru,
    passoGrupo: async () => { await cru.passoGrupo(); await bombear(cru); },
    passoEventos: async () => { await cru.passoEventos(); await bombear(cru); },
    passoSessoes: async () => { await cru.passoSessoes(); await bombear(cru); },
  };
}
function randFixo() {
  let n = 0;
  return {
    getRandomValues(b) {
      for (let i = 0; i < b.length; i += 1) b[i] = (n * b.length + i) % 256;
      n += 1;
      return b;
    },
  };
}
function dubleTg(h) {
  const tg = { chamadas: [], lotes: [], enviadas: 0 };
  const gravar = (metodo, args) => { tg.chamadas.push({ metodo, args }); };
  tg.lerAtualizacoes = async (args) => {
    gravar('lerAtualizacoes', { ...args });
    if (tg.chamadas.length > 5000) throw new Error('duble: leitura demais (laco sem fim?)');
    const lote = tg.lotes.shift();
    if (lote === undefined) {
      h.t += (Number(args?.esperaS) || 0) * 1000;
      return [];
    }
    if (lote instanceof Error) throw lote;
    return typeof lote === 'function' ? lote(args) : lote;
  };
  tg.enviar = async (pedido) => {
    gravar('enviar', [pedido]);
    tg.enviadas += 1;
    return { ok: true, messageId: 900 + tg.enviadas, formato: 'rich' };
  };
  tg.editar = async (messageId, pedido) => { gravar('editar', [messageId, pedido]); return { ok: true }; };
  tg.editarBotoes = async (messageId, botoes) => { gravar('editarBotoes', [messageId, botoes]); return { ok: true }; };
  tg.apagar = async (messageId) => { gravar('apagar', [messageId]); return { ok: true }; };
  tg.responderToque = async (id, texto) => { gravar('responderToque', [id, texto]); return { ok: true }; };
  tg.baixar = async () => ({ ok: false, erro: 'sem rede no teste' });
  tg.quemSou = async () => { gravar('quemSou', []); return { ok: true, id: BOT, username: 'Teste_ControleBot' }; };
  tg.definirComandos = async (c) => { gravar('definirComandos', [c]); return { ok: true }; };
  tg.de = (metodo) => tg.chamadas.filter((c) => c.metodo === metodo);
  tg.zerar = () => { tg.chamadas.length = 0; };
  return tg;
}

// Porteiro com o Telegram (ou sem: `tg: false`), o abridor escondido de mentira (`h.escondidas` = [pasta, nome, retomada];
// `h.escFalha` = rejeita; `abridor: false` = sem ele) e o mensageiro que devolve "nao_achei" pras sessoes de `h.mortas`
// (e fecha o registro das de `h.fechar`: a aba fechou bem na hora da fala).
// A3a: `semRaiz` = porteiro sem pasta de projeto (o config sem o bloco `sessoes`); a central = a do teste.
function montarT8({ tg: comTg = true, abridor = true, semRaiz = false } = {}) {
  const raiz = pastaTemp('porteiro-t8-');
  const env = {
    SESSOES_WPP_DIR: path.join(raiz, 'estado'),
    CLAUDE_SESSIONS_DIR: path.join(raiz, 'sessions'),
    CLAUDE_PROJECTS_DIR: path.join(raiz, 'projects'),
    SESSOES_WPP_LOG: path.join(raiz, 'porteiro.log'),
  };
  for (const d of [env.SESSOES_WPP_DIR, env.CLAUDE_SESSIONS_DIR, env.CLAUDE_PROJECTS_DIR]) fs.mkdirSync(d, { recursive: true });
  const repos = path.join(raiz, 'projetos');
  const workspace = path.join(raiz, 'Meus Docs', 'trabalho', 'Area');
  for (const d of [path.join(repos, 'sessoes-wpp'), path.join(workspace, 'Comercial'), path.join(raiz, 'fora')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const h = {
    raiz, env, t: T0, idle: 0, grupo: [], enviados: [], reacoes: [], entregas: [], nReg: 0, nMsg: 0, nUpd: 100, nMid: 7000,
    nAux: 0, randAux: randFixo(), aberturas: 0, dormidas: [], repos, workspace, pasta: path.join(repos, 'sessoes-wpp'),
    escondidas: [], escFalha: null, mortas: new Set(), fechar: new Set(),
  };
  h.abrirCentral = () => { h.aberturas += 1; };
  let seq = 0;
  h.wpp = {
    async lerGrupo(limit) { return h.grupo.slice(-limit); },
    async enviarGrupo(texto, opts) {
      h.enviados.push({ texto, opts });
      seq += 1;
      return { ok: true, providerMsgId: `P${seq}`, messageId: `U${seq}` };
    },
    async reagir(messageId, emoji) {
      h.reacoes.push({ messageId, emoji });
      return { ok: true };
    },
    async editarGrupo() { return { ok: true }; },
  };
  h.mensageiro = {
    async entregar(p) {
      h.entregas.push(p);
      if (!h.mortas.has(p.sessionId)) return { status: 'enviado', detalhe: '' };
      if (h.fechar.has(p.sessionId)) fecharSessao(h, p.sessionId); // a aba fechou bem na hora da fala (o PC reiniciou)
      return { status: 'nao_achei', detalhe: '' };
    },
  };
  h.tg = comTg ? dubleTg(h) : null;
  const opcoes = {
    wpp: h.wpp, numeroDono: NUMERO_DONO, mensageiro: h.mensageiro, ocioso: async () => h.idle, agora: () => h.t, env, abrirCentral: h.abrirCentral,
    rand: randFixo(), dormir: async (ms) => { h.dormidas.push(ms); h.t += ms; }, raizesSessao: semRaiz ? [] : [repos, workspace], ensaio: false,
    central: CENTRAL_TESTE,
  };
  if (abridor) {
    opcoes.abrirSessaoEscondida = async (pasta, nome, retomada) => {
      h.escondidas.push([pasta, nome, retomada ?? null]);
      if (h.escFalha) throw new Error(h.escFalha);
    };
  }
  if (comTg) Object.assign(opcoes, { tg: h.tg, identTg: { chatId: DONO, botId: BOT } });
  h.opcoes = opcoes;
  religar(h);
  h.t += 1000; // mensagens dos testes nascem depois do cursor inicial
  return h;
}
function religar(h) {
  h.cru = criarPorteiro(h.opcoes);
  h.p = comBomba(h.cru);
}

function sessao(h, { sessionId, name = 'projetos-42', status = 'idle', pid = process.pid, entrypoint = 'claude-vscode', cwd = 'c:\\projetos' }) {
  h.nReg += 1;
  const reg = { pid, sessionId, cwd, entrypoint, name, nameSource: 'derived', status, updatedAt: h.t };
  fs.writeFileSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${100000 + h.nReg}.json`), JSON.stringify(reg));
}
// Registro como o `claude -n` grava (cli, nome dado, nameSource user; cwd = a pasta). Sem nome (a retomada sem -n, T18) =
// o nome derivado que o Claude Code sorteia (medido 12/10: `repos-40`, nameSource derived).
function sessaoEscondida(h, { sessionId, name, cwd = h.pasta }) {
  h.nReg += 1;
  const nome = typeof name === 'string' && name ? { name, nameSource: 'user' } : { name: 'repos-40', nameSource: 'derived' };
  fs.writeFileSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${100000 + h.nReg}.json`), JSON.stringify({
    pid: process.pid, sessionId, cwd, entrypoint: 'cli', kind: 'interactive', ...nome, status: 'idle', startedAt: h.t, updatedAt: h.t,
  }));
}
function fecharSessao(h, sessionId) {
  for (const nome of fs.readdirSync(h.env.CLAUDE_SESSIONS_DIR)) {
    if (!/^\d+\.json$/.test(nome)) continue;
    const arq = path.join(h.env.CLAUDE_SESSIONS_DIR, nome);
    if (JSON.parse(fs.readFileSync(arq, 'utf8')).sessionId === sessionId) fs.unlinkSync(arq);
  }
}
function transcript(h, sessionId, entradas, pasta = 'c--projetos') {
  const dir = path.join(h.env.CLAUDE_PROJECTS_DIR, pasta);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${sessionId}.jsonl`), entradas.map((x) => `${JSON.stringify(x)}\n`).join(''));
}
const custom = (t) => ({ type: 'custom-title', customTitle: t, sessionId: 'x' });
function aba(h, sessionId, titulo, name = 'projetos-42') {
  sessao(h, { sessionId, name });
  transcript(h, sessionId, [custom(titulo)]);
}
// A conversa de uma aba no disco: o titulo e a 1a mensagem com o entrypoint e a pasta (como o Claude Code grava).
function conversa(h, sid, { titulo = TIT, cwd = h.pasta, entrypoint = 'claude-vscode', projeto = 'c--projetos-sessoes-wpp' } = {}) {
  const linhas = [];
  if (titulo) linhas.push(custom(titulo));
  linhas.push({ type: 'user', sessionId: sid, entrypoint, cwd, timestamp: iso(h.t - 60 * MIN), message: { role: 'user', content: 'começa a aula' } });
  transcript(h, sid, linhas, projeto);
}
function parou(h, sessionId, o = {}) {
  return {
    v: 1, tipo: 'parou', at: iso(h.t), sessionId, pid: process.pid, nome: o.nome ?? 'projetos-42', titulo: o.titulo ?? null,
    cwd: 'C:\\projetos', entrypoint: 'claude-vscode', final: o.final ?? 'Feito.', finalTs: o.finalTs ?? iso(h.t),
    marcas: o.marcas ?? { decisao: false, fica: false, pergunta: false },
  };
}
const evento = (h, ev) => lib.anexarEvento(h.env.SESSOES_WPP_DIR, ev);
function msg(h, o = {}) {
  h.nMsg += 1;
  const m = {
    id: `uuid-${h.nMsg}`, provider_msg_id: `PROV${h.nMsg}`, quoted_msg_id: null, sent_by_agent: false, message_type: 'text',
    content: null, transcription: null, direction: 'received', from_me: false, sender_phone: NUMERO_DONO, message_ts: iso(h.t), ...o,
  };
  h.grupo.push(m);
  return m;
}
const estado = (h) => JSON.parse(fs.readFileSync(path.join(h.env.SESSOES_WPP_DIR, 'estado.json'), 'utf8'));
function mexer(h, fn) {
  const arq = path.join(h.env.SESSOES_WPP_DIR, 'estado.json');
  const e = JSON.parse(fs.readFileSync(arq, 'utf8'));
  fn(e);
  fs.writeFileSync(arq, JSON.stringify(e));
}
const ligarTg = (h) => mexer(h, (e) => { e.tg.offset = 0; });
async function ligarRua(h) {
  h.idle = 30 * MIN;
  await h.p.passoMinuto();
  assert.equal(estado(h).modoRua.ligado, true);
}
const logs = (h) => {
  try { return fs.readFileSync(h.env.SESSOES_WPP_LOG, 'utf8').split('\n').filter(Boolean); } catch { return []; }
};
const comLog = (h, trecho) => logs(h).filter((l) => l.includes(trecho)).length;
const linhasSistema = (h) => estado(h).tg.sistema.linhas.map((l) => l.texto);
const chamado = (h, sid) => estado(h).tg.chamados[sid];
const painel = (h) => estado(h).tg.painel?.dados ?? null;

function msgTg(h, texto, { respondeA = null } = {}) {
  h.nUpd += 1;
  h.nMid += 1;
  const m = {
    message_id: h.nMid, date: Math.floor(h.t / 1000),
    chat: { id: DONO, type: 'private', first_name: 'Davi' }, from: { id: DONO, is_bot: false, first_name: 'Davi' },
  };
  if (texto !== undefined) m.text = texto;
  if (respondeA != null) m.reply_to_message = { message_id: respondeA };
  return { update_id: h.nUpd, message: m };
}
function toqueTg(h, dados, messageId) {
  h.nUpd += 1;
  return {
    update_id: h.nUpd,
    callback_query: {
      id: `q${h.nUpd}`, from: { id: DONO, is_bot: false }, message: { message_id: messageId, chat: { id: DONO, type: 'private' } }, data: dados,
    },
  };
}
const pid = (u) => `tg-u${u.update_id}`;
const mid = (u) => u.message.message_id;
// Fala do dono pelo Telegram ate o resultado do mensageiro aplicado.
async function falarTg(h, texto, opts) {
  const u = msgTg(h, texto, opts);
  h.tg.lotes.push([u]);
  await h.p.esperarTelegram(15000);
  await bombear(h.cru);
  return u;
}
// Chamado de uma aba ja na tela (o aviso de quando ela estava aberta), montado com um canal auxiliar sobre o disco.
async function chamadoNaTela(h, sessionId, titulo, final = FINAL_FIN, nome = 'projetos-42') {
  const arq = path.join(h.env.SESSOES_WPP_DIR, 'estado.json');
  const e = JSON.parse(fs.readFileSync(arq, 'utf8'));
  const aux = {
    async enviar() { h.nAux += 1; return { ok: true, messageId: 500 + h.nAux, formato: 'rich' }; },
    async editar() { return { ok: true }; },
    async apagar() { return { ok: true }; },
  };
  const canal = criarCanalTelegram({ tg: aux, agora: () => h.t, rand: h.randAux });
  canal.aviso(e, { sessionId, at: iso(h.t), finalTs: iso(h.t), final, nome }, titulo);
  await canal.drenar(e);
  fs.writeFileSync(arq, JSON.stringify(e));
  const c = e.tg.chamados[sessionId];
  return { messageId: c.mensagem.messageId, chamadoId: c.versao.chamadoId };
}
// Recado como chega no transcript da aba (formato medido 27/09).
function peer(pedido, ts) {
  const texto = `Another Claude session sent a message (from repos-99):\n<cross-session-message from="repos-99">\n${montarRecado(pedido)}\n</cross-session-message>`;
  return { type: 'user', isMeta: true, origin: { kind: 'peer', from: 'repos-99' }, timestamp: ts, message: { role: 'user', content: texto } };
}
// Recado de cada pedido no transcript da aba + o parou dela 1 min depois. `o.projeto` = a pasta de projeto do transcript
// (a conversa retomada escreve no MESMO arquivo dela: o da `conversa()`).
function abaResponde(h, sid, pedidos, o = {}) {
  transcript(h, sid, pedidos.map((p, i) => peer(p, iso(h.t + 1000 * (i + 1)))), o.projeto);
  h.t += MIN;
  const ev = parou(h, sid, o);
  evento(h, ev);
  return ev;
}
// A aba S1 fechou com o chamado na tela; o mensageiro nao acha mais ela.
async function cenaFechada(h, o = {}) {
  conversa(h, S1, o);
  const tela = await chamadoNaTela(h, S1, TIT);
  ligarTg(h);
  h.mortas.add(S1);
  return tela;
}
// A retomada `i` (T18: a MESMA conversa) aparece e firma (2 checagens com 10 s); devolve o sessionId dela (o da conversa).
// Viva de novo = o mensageiro acha (sai de h.mortas), menos com `morta` (a retomada fecha bem na hora da fala).
async function firmarRetomada(h, i = 0, { morta = false } = {}) {
  const [pasta, nome, r] = h.escondidas[i];
  h.t += 3000;
  sessaoEscondida(h, { sessionId: r.retomar, name: nome, cwd: pasta });
  if (!morta) h.mortas.delete(r.retomar);
  await h.p.passoSessoes();
  h.t += 10 * 1000;
  await h.p.passoSessoes();
  return r.retomar;
}
const PROJ = 'c--projetos-sessoes-wpp'; // a pasta de projeto da conversa() (o transcript que a retomada continua)

// ---------- 1. o "nao achei" que reabre ----------

test('T8 1 (T18). resposta em cima do chamado de uma aba fechada: o "não achei" retoma a MESMA conversa escondida (pasta da conversa, -n com o titulo dado, so o sessionId dela: nenhum id novo), sem frase; ela firma e recebe a MESMA fala; o chamado e as mensagens ficam nela (sem trocarAba, sem entrada nova na cadeia); a resposta volta pelo Telegram em cima da fala', async () => {
  const h = montarT8();
  const { messageId: tela } = await cenaFechada(h);
  const u = await falarTg(h, 'sim, manda', { respondeA: tela });
  assert.deepEqual(h.entregas.map((p) => [p.sessionId, p.providerMsgId]), [[S1, pid(u)]]);
  assert.equal(h.escondidas.length, 1);
  const [pasta, nome, r] = h.escondidas[0];
  assert.equal(pasta, h.pasta, 'a pasta da conversa, sem trocar pela raiz');
  assert.equal(nome, TIT, 'o titulo dado exato (o -n reescreve o mesmo titulo)');
  assert.deepEqual(r, { retomar: S1 }, 'so o sessionId da conversa: nunca um id novo (a copia)');
  let e = estado(h);
  assert.deepEqual(e.reaberturas.map((x) => [x.de, x.para, x.nome, x.pasta, x.pedidos.length]), [[S1, S1, TIT, h.pasta, 1]]);
  assert.equal(chamado(h, S1).versao.estado, 'enviando', 'sem o "Não achei": o chamado segue esperando');
  assert.deepEqual(linhasSistema(h), [], 'nenhuma frase (so o resultado)');
  assert.equal(comLog(h, `reabrir: a aba ${S1} fechou; retomando a mesma conversa em `), 1);
  assert.equal(comLog(h, 'abrindo a copia'), 0);

  // ainda sem o registro, ou com 1 checagem so: nada sai
  await h.p.passoSessoes();
  h.t += 3000;
  sessaoEscondida(h, { sessionId: S1, name: TIT });
  h.mortas.delete(S1);
  await h.p.passoSessoes();
  assert.equal(h.entregas.length, 1);
  h.t += 10 * 1000;
  await h.p.passoSessoes();
  assert.equal(h.entregas.length, 2);
  assert.deepEqual(h.entregas[1], {
    sessionId: S1, nome: TIT, titulo: TIT, texto: 'sim, manda', audio: false, hora: '12:00', providerMsgId: pid(u),
    messageId: mid(u), anexos: [], canal: 'telegram', reaberta: S1,
  });
  e = estado(h);
  assert.deepEqual(e.reaberturas, []);
  assert.deepEqual(e.reabertas, {}, 'nenhuma entrada nova na cadeia (a conversa e a mesma)');
  assert.equal(chamado(h, S1).versao.estado, 'entregue', 'o chamado segue na mesma aba');
  assert.equal(e.tg.mensagens[tela].sessionId, S1);
  assert.equal(comLog(h, 'a aba voltou como'), 0, 'sem trocarAba');
  assert.equal(comLog(h, `reabrir: a aba ${S1} voltou (a mesma conversa); passando 1 fala(s)`), 1);

  // ela responde: o resultado sai no Telegram em cima da fala dele; nada no grupo
  abaResponde(h, S1, [h.entregas[1]], { nome: TIT, projeto: PROJ, final: '> Telegram do Davi (12:00): «sim, manda»\n\nMandei pro Caio.' });
  await h.p.passoEventos();
  assert.equal(estado(h).entregas[pid(u)].respondida, true);
  h.tg.zerar();
  await h.p.esperarTelegram(15000);
  const enviadas = h.tg.de('enviar').map((c) => c.args[0]);
  assert.equal(enviadas.length, 1);
  assert.ok(enviadas[0].html.includes('Mandei pro Caio.'));
  assert.equal(enviadas[0].responderA, mid(u));
  assert.deepEqual(h.enviados, []);
});

test('T8 2 (T18). toque no botao do chamado de uma aba fechada: "Anotei", o "não achei" retoma a mesma conversa e a opcao vai pra ela', async () => {
  const h = montarT8();
  const c = await cenaFechada(h);
  const q = toqueTg(h, `o:${c.chamadoId}:0`, c.messageId);
  h.tg.lotes.push([q]);
  await h.p.esperarTelegram(15000);
  await bombear(h.cru);
  assert.deepEqual(h.tg.de('responderToque').map((x) => x.args[1]), ['Anotei: A. Passando pra aba.']);
  assert.equal(h.escondidas.length, 1);
  const sid = await firmarRetomada(h);
  assert.equal(sid, S1);
  assert.deepEqual([h.entregas.at(-1).sessionId, h.entregas.at(-1).texto, h.entregas.at(-1).reaberta], [S1, 'A) Sim', S1]);
});

test('T8 3 (T18). 2a fala pra mesma aba durante a retomada espera junto (1 retomada so); as duas vao pra ela na ordem; a fala depois vai direto pra ela', async () => {
  const h = montarT8();
  const { messageId: tela } = await cenaFechada(h);
  const u1 = await falarTg(h, 'sim', { respondeA: tela });
  h.t += 5000;
  const u2 = await falarTg(h, 'e manda o PDF também', { respondeA: tela });
  assert.equal(h.escondidas.length, 1, '1 retomada so');
  assert.deepEqual(estado(h).reaberturas[0].pedidos.map((p) => p.providerMsgId), [pid(u1), pid(u2)]);
  assert.equal(comLog(h, `reabrir: a fala espera a aba ${S1} voltar`), 1);
  await firmarRetomada(h);
  assert.deepEqual(h.entregas.slice(2).map((p) => [p.sessionId, p.providerMsgId]), [[S1, pid(u1)], [S1, pid(u2)]]);
  h.t += 5000;
  const u3 = await falarTg(h, 'valeu', { respondeA: tela });
  assert.deepEqual(h.entregas.slice(4).map((p) => [p.sessionId, p.providerMsgId]), [[S1, pid(u3)]]);
  assert.equal(h.escondidas.length, 1);
});

test('T8 4 (T18). cadeia das copias antigas (T8): a copia fechou e ele responde em cima da antiga: retoma a ULTIMA (a conversa mais nova) como ela mesma, sem entrada nova; a fala pra antiga com a copia viva vai pra copia; a retomada que fecha volta de novo como ela mesma', async () => {
  const C = '7c3e1d2f-2a8b-4d4c-8f3a-123456789abc'; // a copia da T8 (antes da T18), fechada
  const h = montarT8();
  const { messageId: tela } = await cenaFechada(h);
  conversa(h, C, { entrypoint: 'cli' }); // a conversa da copia fica no PC (com o titulo do -n dela)
  h.mortas.add(C);
  const desde = iso(h.t);
  mexer(h, (e) => { e.reabertas = { [S1]: { para: C, nome: TIT, desde } }; });
  const u = await falarTg(h, 'e agora?', { respondeA: tela });
  assert.equal(h.escondidas.length, 1);
  assert.deepEqual(h.escondidas[0][2], { retomar: C }, 'a ultima da cadeia, como ela mesma');
  assert.equal(await firmarRetomada(h), C);
  let e = estado(h);
  assert.deepEqual(e.reabertas, { [S1]: { para: C, nome: TIT, desde } }, 'a cadeia antiga fica; nenhuma entrada nova');
  assert.deepEqual([h.entregas.at(-1).sessionId, h.entregas.at(-1).providerMsgId, h.entregas.at(-1).reaberta], [C, pid(u), C]);
  assert.equal(chamado(h, C).versao.estado, 'entregue', 'o chamado da antiga passou pra copia (trocarAba, como na T8)');

  // a fala que ainda ia pra aba antiga (o mensageiro nao acha) segue a cadeia ate a copia viva: sem retomar nada
  const v = montarT8();
  const c = await cenaFechada(v);
  sessaoEscondida(v, { sessionId: C, name: TIT });
  mexer(v, (x) => { x.reabertas = { [S1]: { para: C, nome: TIT, desde: iso(v.t) } }; });
  const w = await falarTg(v, 'mais uma', { respondeA: c.messageId });
  assert.deepEqual(v.escondidas, []);
  assert.deepEqual(v.entregas.map((p) => [p.sessionId, p.providerMsgId]), [[S1, pid(w)], [C, pid(w)]]);
  assert.equal(comLog(v, `reabrir: a fala vai pra copia ${C} da aba ${S1}, que ja esta aberta`), 1);

  // a retomada fechou (o PC reiniciou) e ele responde de novo: volta a MESMA conversa de novo, sem cadeia
  const z = montarT8();
  const t = await cenaFechada(z);
  await falarTg(z, 'sim', { respondeA: t.messageId });
  await firmarRetomada(z);
  fecharSessao(z, S1);
  z.mortas.add(S1);
  z.t += 5000;
  const y = await falarTg(z, 'e agora?', { respondeA: t.messageId });
  assert.equal(z.escondidas.length, 2);
  assert.deepEqual(z.escondidas[1][2], { retomar: S1 });
  await firmarRetomada(z, 1);
  e = estado(z);
  assert.deepEqual(e.reabertas, {});
  assert.deepEqual([z.entregas.at(-1).sessionId, z.entregas.at(-1).providerMsgId], [S1, pid(y)]);
});

// ---------- 2. o que nao reabre, e as falhas ----------

test('T8 5. aba que nao da pra reabrir = o "Não achei" de hoje, sem abridor: Claude Desktop, automatica, conversa que sumiu, pasta fora, pasta que nao existe, node_modules, sem o abridor escondido; e a fala que ja ia pra uma copia (sem laco)', async () => {
  const cenas = [
    ['desktop', (x) => conversa(x, S1, { entrypoint: 'claude-desktop' })],
    ['automatica', (x) => conversa(x, S1, { entrypoint: 'sdk-cli' })],
    ['sumiu', () => {}],
    ['pasta fora', (x) => conversa(x, S1, { cwd: path.join(x.raiz, 'fora') })],
    ['pasta que nao existe', (x) => conversa(x, S1, { cwd: path.join(x.repos, 'apagada') })],
    ['node_modules', (x) => { fs.mkdirSync(path.join(x.repos, 'app', 'node_modules'), { recursive: true }); conversa(x, S1, { cwd: path.join(x.repos, 'app', 'node_modules') }); }],
    ['sem abridor', (x) => conversa(x, S1), { abridor: false }],
  ];
  for (const [quem, prep, o = {}] of cenas) {
    const h = montarT8(o);
    prep(h);
    const { messageId: tela } = await chamadoNaTela(h, S1, TIT);
    ligarTg(h);
    h.mortas.add(S1);
    await falarTg(h, 'sim', { respondeA: tela });
    assert.deepEqual(h.escondidas, [], quem);
    assert.deepEqual([chamado(h, S1).versao.estado, chamado(h, S1).versao.frase], ['problema', TXT8.naoAchei], quem);
    assert.deepEqual(estado(h).reaberturas, [], quem);
  }
  // a fala que ja ia pra retomada e voltou "nao achei" (ela fechou bem na hora): o "Não achei" no chamado, sem 2a
  // retomada (a conversa segue no PC e daria pra retomar: sem a marca, o laco retomaria sem fim)
  const h = montarT8();
  const { messageId: tela } = await cenaFechada(h);
  await falarTg(h, 'sim', { respondeA: tela });
  h.fechar.add(S1);
  await firmarRetomada(h, 0, { morta: true });
  assert.equal(h.escondidas.length, 1);
  assert.equal(h.entregas.length, 2);
  assert.deepEqual([chamado(h, S1).versao.estado, chamado(h, S1).versao.frase], ['problema', TXT8.naoAchei]);
});

test('T8 6 (T18). abridor que falha = "Não consegui reabrir a aba X no PC." no chamado; a retomada que nao aparece em 3 min (nenhum registro, ou o registro em outra pasta) = a frase com o prazo, sem 2a tentativa nem copia; travado = a fala espera e, no prazo, desiste calado', async () => {
  let h = montarT8();
  h.escFalha = 'wscript nao saiu em 30 s';
  let c = await cenaFechada(h);
  await falarTg(h, 'sim', { respondeA: c.messageId });
  assert.equal(h.escondidas.length, 1);
  assert.deepEqual([chamado(h, S1).versao.estado, chamado(h, S1).versao.frase], ['problema', TXT8.falhou]);
  assert.deepEqual(estado(h).reaberturas, []);
  assert.equal(comLog(h, `reabrir: a retomada da aba ${S1} falhou`), 1);

  // nenhum registro em 3 min
  h = montarT8();
  c = await cenaFechada(h);
  await falarTg(h, 'sim', { respondeA: c.messageId });
  h.t += 170 * 1000;
  await h.p.passoSessoes();
  assert.equal(estado(h).reaberturas.length, 1, 'ainda no prazo');
  h.t += 11 * 1000;
  await h.p.passoSessoes();
  assert.deepEqual(estado(h).reaberturas, []);
  assert.deepEqual([chamado(h, S1).versao.estado, chamado(h, S1).versao.frase], ['problema', TXT8.naoApareceu]);
  assert.deepEqual([h.entregas.length, h.escondidas.length], [1, 1], 'sem 2a tentativa e sem copia');
  assert.equal(comLog(h, `reabrir: a aba ${S1} nao voltou em `), 1);

  h = montarT8();
  c = await cenaFechada(h);
  await falarTg(h, 'sim', { respondeA: c.messageId });
  // o registro com o sessionId dela, mas em outra pasta, nao vale (2 checagens com 3 min no meio)
  sessaoEscondida(h, { sessionId: S1, name: TIT, cwd: h.workspace });
  await h.p.passoSessoes();
  h.t += 170 * 1000;
  await h.p.passoSessoes();
  assert.equal(estado(h).reaberturas.length, 1, 'ainda no prazo');
  h.t += 11 * 1000;
  await h.p.passoSessoes();
  assert.deepEqual(estado(h).reaberturas, []);
  assert.deepEqual([chamado(h, S1).versao.estado, chamado(h, S1).versao.frase], ['problema', TXT8.naoApareceu]);
  assert.equal(h.entregas.length, 1);

  // travado: a retomada firma mas a fala nao sai; no prazo, desiste calado
  h = montarT8();
  c = await cenaFechada(h);
  await falarTg(h, 'sim', { respondeA: c.messageId });
  mexer(h, (e) => { e.trava = true; });
  await firmarRetomada(h);
  assert.equal(h.entregas.length, 1, 'travado: nada sai');
  assert.equal(estado(h).reaberturas.length, 1);
  h.t += 181 * 1000;
  await h.p.passoSessoes();
  assert.deepEqual(estado(h).reaberturas, []);
  assert.equal(chamado(h, S1).versao.estado, 'enviando', 'calado');
  assert.equal(comLog(h, `reabrir: travado ate o fim da espera da aba ${S1}`), 1);
});

// ---------- 3. o reabrir-sessao da central ----------

// A central viva (SC) e o Telegram ligado; a fala do dono pelo Telegram foi pra central.
async function cenaCentral(o = {}) {
  const h = montarT8(o);
  aba(h, 'SC', CENTRAL, 'repos-99');
  ligarTg(h);
  const u = await falarTg(h, 'abre a aba da Campanha Verão e vê como ficou o KV');
  assert.deepEqual(h.entregas.map((p) => [p.sessionId, p.providerMsgId]), [['SC', pid(u)]]);
  h.t += 10 * 1000;
  return { h, A: pid(u), u };
}
const reabrirEv = (h, o = {}) => evento(h, { v: 1, tipo: 'reabrir-sessao', at: iso(h.t), sessao: S1, providerMsgId: null, por: 'SC', ...o });

test('T8 7 (T18). reabrir-sessao da central: retoma a mesma conversa da aba fechada e passa a fala como encaminhada; a central que so pediu fica calada; a resposta dela volta em cima da fala', async () => {
  const { h, A, u } = await cenaCentral();
  conversa(h, S1);
  reabrirEv(h, { providerMsgId: A });
  await h.p.passoEventos();
  assert.equal(h.escondidas.length, 1);
  const [pasta, nome, r] = h.escondidas[0];
  assert.deepEqual([pasta, nome, r], [h.pasta, TIT, { retomar: S1 }]);
  assert.deepEqual(estado(h).reaberturas[0].pedidos.map((p) => [p.providerMsgId, p.encaminhado, p.canal]), [[`${A}-E1`, true, 'telegram']]);
  // a central responde "pedi pro porteiro reabrir": calada no Telegram (so o resultado)
  abaResponde(h, 'SC', [h.entregas[0]], { final: `> Telegram do Davi (12:00): «abre a aba»\n\nPedi pro porteiro reabrir a aba ${TIT}.` });
  await h.p.passoEventos();
  h.tg.zerar();
  await h.p.esperarTelegram(15000);
  assert.equal(h.tg.de('enviar').length, 0, 'a central que so pediu a reabertura fica calada');
  await firmarRetomada(h);
  const p = h.entregas.at(-1);
  assert.deepEqual(
    [p.sessionId, p.providerMsgId, p.encaminhado, p.canal, p.texto, p.reaberta],
    [S1, `${A}-E1`, true, 'telegram', 'abre a aba da Campanha Verão e vê como ficou o KV', S1],
  );
  abaResponde(h, S1, [p], { nome: TIT, projeto: PROJ, final: '> Telegram do Davi (12:00): «abre a aba»\n\nO KV entrou na página.' });
  await h.p.passoEventos();
  h.tg.zerar();
  await h.p.esperarTelegram(15000);
  const enviadas = h.tg.de('enviar').map((c) => c.args[0]);
  assert.equal(enviadas.length, 1);
  assert.ok(enviadas[0].html.includes('O KV entrou na página.'));
  assert.equal(enviadas[0].responderA, mid(u));
});

test('T8 8. reabrir-sessao: aba aberta = o encaminhar de sempre; aba ja reaberta com a copia viva = vai pra copia; nao reabrivel = "Não dá pra reabrir a aba X pelo celular: <motivo>."; fala que nao existe = "Não achei a mensagem pra passar pra X."', async () => {
  let { h, A } = await cenaCentral();
  aba(h, S1, TIT, 'repos-77');
  reabrirEv(h, { providerMsgId: A });
  await h.p.passoEventos();
  assert.deepEqual(h.escondidas, []);
  assert.deepEqual(h.entregas.slice(1).map((p) => [p.sessionId, p.providerMsgId, p.encaminhado]), [[S1, `${A}-E1`, true]]);

  ({ h, A } = await cenaCentral());
  conversa(h, S1);
  const C = '7c3e1d2f-2a8b-4d4c-8f3a-123456789abc';
  sessaoEscondida(h, { sessionId: C, name: TIT });
  mexer(h, (e) => { e.reabertas = { [S1]: { para: C, nome: TIT, desde: iso(h.t) } }; });
  reabrirEv(h, { providerMsgId: A });
  await h.p.passoEventos();
  assert.deepEqual(h.escondidas, []);
  assert.deepEqual(h.entregas.slice(1).map((p) => [p.sessionId, p.providerMsgId]), [[C, `${A}-E1`]]);

  // a original aberta de novo no PC (o dono reabriu ela) vale mais que a copia viva da cadeia
  ({ h, A } = await cenaCentral());
  aba(h, S1, TIT, 'repos-77');
  sessaoEscondida(h, { sessionId: C, name: TIT });
  mexer(h, (e) => { e.reabertas = { [S1]: { para: C, nome: TIT, desde: iso(h.t) } }; });
  reabrirEv(h, { providerMsgId: A });
  await h.p.passoEventos();
  assert.deepEqual(h.escondidas, []);
  assert.deepEqual(h.entregas.slice(1).map((p) => [p.sessionId, p.providerMsgId]), [[S1, `${A}-E1`]]);

  for (const [quem, prep, t, motivo] of [
    ['desktop', (x) => conversa(x, S1, { entrypoint: 'claude-desktop' }), TIT, 'ela é do Claude Desktop'],
    ['automatica', (x) => conversa(x, S1, { entrypoint: 'sdk-cli' }), TIT, 'ela não é uma aba do VS Code nem do terminal'],
    ['sumiu', () => {}, null, 'a conversa dela não está mais no PC'],
    ['pasta', (x) => conversa(x, S1, { cwd: path.join(x.raiz, 'fora') }), TIT, 'a pasta dela fica fora de projetos e Area'],
    ['central', (x) => conversa(x, S1, { titulo: CENTRAL, entrypoint: 'cli' }), CENTRAL, 'é a própria central (use "abre central")'],
  ]) {
    ({ h, A } = await cenaCentral());
    prep(h);
    reabrirEv(h, { providerMsgId: A });
    await h.p.passoEventos();
    assert.deepEqual(h.escondidas, [], quem);
    assert.deepEqual(linhasSistema(h), [TXT8.naoDa(t, motivo)], quem);
    assert.equal(h.entregas.length, 1, quem);
  }

  ({ h } = await cenaCentral());
  conversa(h, S1);
  reabrirEv(h, { providerMsgId: 'tg-u999999' });
  await h.p.passoEventos();
  assert.deepEqual(h.escondidas, []);
  assert.deepEqual(linhasSistema(h), [TXT8.naoAcheiMsg]);
});

// A3a (PLANO-ABERTO.md, "A3a"): as pastas de projeto vem do config; sem nenhuma, nenhuma aba fechada reabre.
test('A3a T8. reabrir-sessao sem pasta de projeto no config: "Não dá pra reabrir a aba X pelo celular: nenhuma pasta de projeto configurada."; nada abre e a fala nao vai pra ninguem', async () => {
  const { h, A } = await cenaCentral({ semRaiz: true });
  conversa(h, S1);
  reabrirEv(h, { providerMsgId: A });
  await h.p.passoEventos();
  assert.deepEqual(h.escondidas, []);
  assert.deepEqual(linhasSistema(h), [TXT8.naoDa(TIT, 'nenhuma pasta de projeto configurada')]);
  assert.equal(h.entregas.length, 1, 'so a fala pra central');
});

test('T8 9. reabrir-sessao: so da central viva, travado = nada, a mesma linha 1 vez, a mesma fala nao retoma 2 vezes, sem sessao ou sem id = nada', async () => {
  const { h, A } = await cenaCentral();
  conversa(h, S1);
  reabrirEv(h, { providerMsgId: A, por: 'OUTRA' });
  await h.p.passoEventos();
  assert.deepEqual(h.escondidas, []);
  assert.equal(comLog(h, 'reabrir-sessao ignorado: nao veio da central viva'), 1);
  mexer(h, (e) => { e.trava = true; });
  h.t += 1000;
  reabrirEv(h, { providerMsgId: A });
  await h.p.passoEventos();
  assert.deepEqual(h.escondidas, []);
  assert.equal(comLog(h, 'reabrir-sessao ignorado: travado'), 1);
  mexer(h, (e) => { e.trava = false; });
  h.t += 1000;
  reabrirEv(h, { providerMsgId: A });
  h.t += 1000;
  reabrirEv(h, { providerMsgId: A }); // o retry da central (outra linha, a mesma fala)
  await h.p.passoEventos();
  assert.equal(h.escondidas.length, 1);
  assert.equal(estado(h).reaberturas[0].pedidos.length, 1);
  assert.equal(comLog(h, `ja esta esperando a aba ${S1} voltar`), 1);
  // a mesma linha lida de novo (eventos.jsonl recomecado) = 1 vez so
  mexer(h, (e) => { e.offsetEventos = 0; });
  await h.p.passoEventos();
  assert.equal(h.escondidas.length, 1);
  assert.equal(comLog(h, 'reabrir-sessao ignorado: nao veio da central viva'), 1);
  assert.equal(comLog(h, `ja esta esperando a aba ${S1} voltar`), 1);
  h.t += 1000;
  reabrirEv(h, { providerMsgId: A, sessao: '' });
  reabrirEv(h, { providerMsgId: '' });
  await h.p.passoEventos();
  assert.equal(h.escondidas.length, 1);
  assert.equal(comLog(h, 'reabrir-sessao ignorado: sem sessao ou sem id da mensagem'), 2);
  // a mesma fala encaminhada pra outra aba aberta com a retomada ainda esperando: o id seguinte (-E2), nunca o -E1 de novo
  aba(h, 'SX', 'Outra aba', 'repos-55');
  h.t += 1000;
  evento(h, { v: 1, tipo: 'encaminhar', at: iso(h.t), para: 'SX', providerMsgId: A, por: 'SC' });
  await h.p.passoEventos();
  assert.deepEqual([h.entregas.at(-1).sessionId, h.entregas.at(-1).providerMsgId], ['SX', `${A}-E2`]);
});

// ---------- 4. painel, estado do disco e WhatsApp ----------

test('T8 10 (T18). painel: a aba fechada com pergunta (T14: no Esperando, marcada) volta aberta depois da retomada (a mesma aba, pelo titulo, sem a marca de fechada), 1 vez so', async () => {
  const h = montarT8();
  const { messageId: tela } = await cenaFechada(h);
  mexer(h, (e) => {
    e.ultimosParou[S1] = { at: iso(h.t), finalTs: iso(h.t), precisa: true, pergunta: 'Mando pro Caio?', titulo: TIT, nome: 'projetos-42' };
  });
  await falarTg(h, '/painel');
  assert.deepEqual(painel(h).esperando.map((x) => [x.sid, x.fechada]), [[S1, true]]);
  h.t += 5000;
  await falarTg(h, 'sim', { respondeA: tela });
  await firmarRetomada(h);
  h.t += 5000;
  await falarTg(h, '/painel');
  const d = painel(h);
  assert.deepEqual([...d.esperando, ...d.trabalhando, ...d.paradas].map((x) => [x.titulo, x.sid, Boolean(x.fechada)]), [[TIT, S1, false]]);
});

test('T8 11 (T18). estado do disco: o porteiro religado no meio da retomada acha ela e passa a fala; item torto sai com log; reabertas torta nao quebra a cadeia; a copia da T8 que ainda esperava (sessionId novo) segue valendo depois da troca', async () => {
  const h = montarT8();
  const { messageId: tela } = await cenaFechada(h);
  const u = await falarTg(h, 'sim', { respondeA: tela });
  religar(h);
  await firmarRetomada(h);
  assert.deepEqual([h.entregas.at(-1).sessionId, h.entregas.at(-1).providerMsgId], [S1, pid(u)]);
  mexer(h, (e) => {
    e.reaberturas = [null, { de: 1 }, { de: S1, para: 'x', nome: '', pasta: null, pedidos: 'x' }];
    e.reabertas = { [S1]: null, a: { para: 3 }, b: 'x' };
  });
  await h.p.passoSessoes();
  assert.deepEqual(estado(h).reaberturas, []);
  assert.equal(comLog(h, 'reabrir: item ruim na espera da retomada; descartado'), 3);
  // a reabertas torta da S1 nao vale: a fala pra ela, fechada de novo, retoma ela de novo (a conversa segue no PC)
  fecharSessao(h, S1);
  h.mortas.add(S1);
  h.t += 5000;
  await falarTg(h, 'de novo', { respondeA: tela });
  assert.equal(h.escondidas.length, 2);
  assert.deepEqual(h.escondidas[1][2], { retomar: S1 });

  // a copia da T8 gravada antes da troca (para = uuid novo) firma e recebe como antes: a cadeia grava a entrada dela
  const v = montarT8();
  const c = await cenaFechada(v);
  const w = await falarTg(v, 'sim', { respondeA: c.messageId });
  const C = '7c3e1d2f-2a8b-4d4c-8f3a-123456789abc';
  mexer(v, (e) => { e.reaberturas[0].para = C; });
  v.t += 3000;
  sessaoEscondida(v, { sessionId: C, name: TIT });
  await v.p.passoSessoes();
  v.t += 10 * 1000;
  await v.p.passoSessoes();
  assert.deepEqual([v.entregas.at(-1).sessionId, v.entregas.at(-1).providerMsgId, v.entregas.at(-1).reaberta], [C, pid(w), S1]);
  assert.equal(estado(v).reabertas[S1].para, C);
  assert.equal(chamado(v, C).versao.estado, 'entregue');
});

test('T8 12 (T18). WhatsApp: citou o aviso de uma aba que fechou: o "não achei" retoma a mesma conversa e a fala vai pra ela, sem frase no grupo', async () => {
  const h = montarT8({ tg: false });
  conversa(h, S1);
  sessao(h, { sessionId: S1, cwd: h.pasta });
  await ligarRua(h);
  evento(h, parou(h, S1, { titulo: TIT, final: FINAL_FIN, marcas: DECISAO }));
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 1);
  fecharSessao(h, S1);
  h.mortas.add(S1);
  h.t += 2 * MIN;
  const m = msg(h, { content: 'A', quoted_msg_id: 'P1' });
  await h.p.passoGrupo();
  assert.equal(h.entregas[0].sessionId, S1);
  assert.equal(h.escondidas.length, 1);
  assert.deepEqual(h.escondidas[0][2], { retomar: S1 });
  assert.equal(h.enviados.length, 1, 'nenhuma frase no grupo');
  await firmarRetomada(h);
  const p = h.entregas.at(-1);
  assert.deepEqual([p.sessionId, p.providerMsgId, p.texto, p.reaberta, 'canal' in p], [S1, m.provider_msg_id, 'A', S1, false]);
  assert.equal(h.enviados.length, 1);
});

// ---------- T18: o nome da retomada e a aba viva ----------

test('T18 1. o nome da retomada: -n so com o titulo DADO exato (o ultimo custom-title) e livre entre as vivas; senao sem -n (null): titulo automatico, com % ou aspas, mais de 60 caracteres, espaco na ponta, quebra de linha, ou o nome de uma sessao viva (NFC)', async () => {
  const OUTRA = '3b9d8c7e-6f5a-4b4c-9d3e-2f1a0b9c8d7e';
  const cenas = [
    ['titulo dado', (x) => conversa(x, S1), TIT],
    ['60 caracteres', (x) => conversa(x, S1, { titulo: 'b'.repeat(60) }), 'b'.repeat(60)],
    ['o titulo mudou: vale o ultimo', (x) => { conversa(x, S1, { titulo: 'Antigo' }); transcript(x, S1, [custom(TIT)], PROJ); }, TIT],
    ['so o titulo automatico', (x) => { conversa(x, S1, { titulo: null }); transcript(x, S1, [{ type: 'ai-title', aiTitle: 'Aula automatica', sessionId: 'x' }], PROJ); }, null],
    ['com %', (x) => conversa(x, S1, { titulo: 'Aula 100% pronta' }), null],
    ['com aspas', (x) => conversa(x, S1, { titulo: 'Campanha "Verão"' }), null],
    ['61 caracteres', (x) => conversa(x, S1, { titulo: 'a'.repeat(61) }), null],
    ['espaco na ponta', (x) => conversa(x, S1, { titulo: ' Campanha Verão' }), null],
    ['quebra de linha', (x) => conversa(x, S1, { titulo: 'Campanha\nVerão' }), null],
    ['nome de uma viva', (x) => { conversa(x, S1); sessaoEscondida(x, { sessionId: OUTRA, name: TIT }); }, null],
    ['nome de uma viva (NFD)', (x) => { conversa(x, S1, { titulo: 'Sessão' }); sessaoEscondida(x, { sessionId: OUTRA, name: 'Sessão'.normalize('NFD') }); }, null],
  ];
  for (const [quem, prep, nome] of cenas) {
    const h = montarT8();
    prep(h);
    const { messageId: tela } = await chamadoNaTela(h, S1, 'Aula');
    ligarTg(h);
    h.mortas.add(S1);
    await falarTg(h, 'sim', { respondeA: tela });
    assert.equal(h.escondidas.length, 1, quem);
    assert.deepEqual([h.escondidas[0][1], h.escondidas[0][2]], [nome, { retomar: S1 }], quem);
    assert.equal(estado(h).reaberturas[0].nome, nome, quem);
  }
});

test('T18 3. sem -n: a retomada firma com o nome derivado e a fala vai pra ela por esse nome; conversa sem titulo nenhum = "essa aba" nas frases (abridor que falha, 3 min) e a fala leva o titulo que o pedido tinha', async () => {
  let h = montarT8();
  conversa(h, S1, { titulo: 'Aula 100% pronta' });
  let tela = (await chamadoNaTela(h, S1, 'Aula')).messageId;
  ligarTg(h);
  h.mortas.add(S1);
  const u = await falarTg(h, 'sim', { respondeA: tela });
  assert.equal(comLog(h, `reabrir: a aba ${S1} fechou; retomando a mesma conversa em `), 1);
  assert.equal(comLog(h, '(sem -n: nome derivado)'), 1);
  await firmarRetomada(h);
  const p = h.entregas.at(-1);
  assert.deepEqual([p.sessionId, p.nome, p.titulo, p.providerMsgId], [S1, 'repos-40', 'Aula 100% pronta', pid(u)]);

  // sem titulo nenhum (nem custom-title nem ai-title)
  h = montarT8();
  conversa(h, S1, { titulo: null });
  tela = (await chamadoNaTela(h, S1, TIT)).messageId;
  ligarTg(h);
  h.mortas.add(S1);
  await falarTg(h, 'sim', { respondeA: tela });
  assert.equal(h.entregas[0].titulo, TIT, 'o pedido leva o titulo do chamado');
  assert.deepEqual([estado(h).reaberturas[0].nome, estado(h).reaberturas[0].titulo], [null, null]);
  await firmarRetomada(h);
  assert.equal(h.entregas.length, 2);
  assert.deepEqual([h.entregas[1].sessionId, h.entregas[1].nome, h.entregas[1].titulo], [S1, 'repos-40', TIT], 'sem titulo na conversa = o do pedido');

  h = montarT8();
  h.escFalha = 'wscript saiu com 3';
  conversa(h, S1, { titulo: null });
  tela = (await chamadoNaTela(h, S1, TIT)).messageId;
  ligarTg(h);
  h.mortas.add(S1);
  await falarTg(h, 'sim', { respondeA: tela });
  assert.equal(chamado(h, S1).versao.frase, 'Não consegui reabrir essa aba no PC.');

  h = montarT8();
  conversa(h, S1, { titulo: null });
  tela = (await chamadoNaTela(h, S1, TIT)).messageId;
  ligarTg(h);
  h.mortas.add(S1);
  await falarTg(h, 'sim', { respondeA: tela });
  h.t += 181 * 1000;
  await h.p.passoSessoes();
  assert.equal(chamado(h, S1).versao.frase, 'Não consegui reabrir essa aba no PC: ela não apareceu em 3 min.');
});

test('T18 2. aba viva com o mesmo sessionId que o mensageiro nao achou (nome repetido, aba esperando na tela): nunca retoma por cima dela (o "Não achei" de antes), nem pelo VS Code nem escondida', async () => {
  for (const [quem, viva] of [
    ['viva no VS Code', (x) => sessao(x, { sessionId: S1, name: 'repos-77', cwd: x.pasta })],
    ['viva escondida', (x) => sessaoEscondida(x, { sessionId: S1, name: TIT })],
  ]) {
    const h = montarT8();
    const { messageId: tela } = await cenaFechada(h);
    viva(h);
    await falarTg(h, 'sim', { respondeA: tela });
    assert.deepEqual(h.escondidas, [], quem);
    assert.deepEqual(estado(h).reaberturas, [], quem);
    assert.deepEqual([chamado(h, S1).versao.estado, chamado(h, S1).versao.frase], ['problema', TXT8.naoAchei], quem);
  }
});

// ---------- 5. o abridor real, o .vbs, o CLI e as instrucoes ----------

function spawnFalso(modos = []) {
  const chamadas = [];
  const fn = (cmd, args, opts) => {
    const filho = new EventEmitter();
    filho.kill = () => { filho.morto = true; };
    const modo = modos[chamadas.length] ?? 'ok';
    chamadas.push({ cmd, args, opts, filho });
    setImmediate(() => {
      if (modo === 'ok') filho.emit('exit', 0, null);
      else if (typeof modo === 'number') filho.emit('exit', modo, null);
    });
    return filho;
  };
  fn.chamadas = chamadas;
  return fn;
}

// A5d2: o gravarCentral dublado no abridor (a pasta montada e o modo; o de verdade esta no tests/a5d.test.mjs)
const MONTAR = (o) => ({ pasta: 'D:\\estado\\central', modo: o.modo });

test('T8 13 (T18). abrirSessaoEscondidaReal com a retomada: o wscript recebe a pasta, o nome (vazio = sem -n) e o sessionId da conversa (1 argumento cada); id que nao e uuid, id novo (a copia), nome ruim, nome que mudaria (aparado, cortado) e sessao nova sem nome rejeitam sem rodar; sem retomada = os 2 argumentos de antes', async () => {
  const vbs = path.join(CENTRAL_DIR, 'abrir-sessao.vbs');
  const pasta = 'D:\\Meus Docs\\trabalho\\Area';
  const NOVO = '0f1e2d3c-4b5a-4968-8776-655443322110';
  const abrir = (sp) => abrirSessaoEscondidaReal({ spawn: sp, gravarCentral: MONTAR, env: { PATH: 'x' } });
  let sp = spawnFalso();
  await abrir(sp)(pasta, TIT, { retomar: S1 });
  assert.deepEqual(sp.chamadas[0].args, ['//nologo', vbs, pasta, TIT, S1]);
  for (const semNome of [null, undefined, '']) {
    sp = spawnFalso();
    await abrir(sp)(pasta, semNome, { retomar: S1 });
    assert.deepEqual(sp.chamadas[0].args, ['//nologo', vbs, pasta, '', S1], String(semNome));
  }
  sp = spawnFalso();
  await abrir(sp)(pasta, TIT);
  assert.deepEqual(sp.chamadas[0].args, ['//nologo', vbs, pasta, TIT]);
  const ruins = [
    [TIT, { retomar: 'S1' }], [TIT, { retomar: S1, novo: NOVO }], [TIT, { retomar: `${S1} --x` }], [TIT, { retomar: '%PATH%' }],
    [TIT, {}], [TIT, [S1]], [TIT, 'x'], ['a"b', { retomar: S1 }], ['a%b', { retomar: S1 }], ['a\nb', { retomar: S1 }], [null, undefined],
    ['', null], [` ${TIT}`, { retomar: S1 }], ['a'.repeat(61), { retomar: S1 }],
  ];
  for (const [nome, r] of ruins) {
    sp = spawnFalso();
    await assert.rejects(abrir(sp)(pasta, nome, r), JSON.stringify([nome, r]));
    assert.equal(sp.chamadas.length, 0, JSON.stringify([nome, r]));
  }
});

test('T13 1. abrirSessaoEscondidaReal passa a pasta com a letra do disco MAIUSCULA (o VS Code grava `d:\\...` no transcript; o claude escondido em `d:` minusculo para na pergunta de confianca da pasta e nunca sobe); o resto da pasta fica igual', async () => {
  const vbs = path.join(CENTRAL_DIR, 'abrir-sessao.vbs');
  const casos = [
    ['d:\\Meus Docs\\trabalho\\Area', 'D:\\Meus Docs\\trabalho\\Area'],
    ['c:\\projetos\\sessoes-wpp', 'C:\\projetos\\sessoes-wpp'],
    ['c:/projetos/x', 'C:/projetos/x'],
    ['  d:\\Meus Docs\\trabalho\\Area\\Educacional  ', 'D:\\Meus Docs\\trabalho\\Area\\Educacional'],
    ['D:\\Meus Docs\\trabalho\\Area', 'D:\\Meus Docs\\trabalho\\Area'],
    ['\\\\servidor\\c:\\x', '\\\\servidor\\c:\\x'],
  ];
  for (const [de, para] of casos) {
    let sp = spawnFalso();
    await abrirSessaoEscondidaReal({ spawn: sp, gravarCentral: MONTAR, env: { PATH: 'x' } })(de, TIT, { retomar: S1 });
    assert.deepEqual(sp.chamadas[0].args, ['//nologo', vbs, para, TIT, S1], de);
    sp = spawnFalso();
    await abrirSessaoEscondidaReal({ spawn: sp, gravarCentral: MONTAR, env: { PATH: 'x' } })(de, TIT);
    assert.deepEqual(sp.chamadas[0].args, ['//nologo', vbs, para, TIT], de);
  }
});

// Prova do abrir-sessao.vbs de VERDADE (so Windows) com a retomada: wscript real com um claude FALSO (um .cmd que chama o
// node e grava a pasta atual e os argumentos). Nunca abre o claude de verdade.
test('T8 14 (T18). abrir-sessao.vbs de verdade com claude falso e 3 argumentos: -n (so com nome), --resume <sid> da MESMA conversa, sem --fork-session e sem --session-id, o modo e os arquivos da pasta montada (A5d2); id ruim, nome ruim, 2 argumentos sem nome e os 4 argumentos da copia = sai com 2 sem rodar', { skip: process.platform !== 'win32' }, async () => {
  const raiz = pastaTemp('porteiro vbs t8 ');
  const pasta = path.join(raiz, 'Área de trabalho');
  fs.mkdirSync(pasta, { recursive: true });
  const saida = path.join(raiz, 'saida.json');
  const falsoJs = path.join(raiz, 'claude-falso.cjs');
  fs.writeFileSync(falsoJs, `require('fs').writeFileSync(process.env.SAIDA_FALSO, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }));\n`);
  const falsoCmd = path.join(raiz, 'bin com espaco', 'claude.cmd');
  fs.mkdirSync(path.dirname(falsoCmd), { recursive: true });
  fs.writeFileSync(falsoCmd, `@echo off\r\n"${process.execPath}" "${falsoJs}" %*\r\n`);
  const vbs = path.join(CENTRAL_DIR, 'abrir-sessao.vbs');
  const NOVO = '0f1e2d3c-4b5a-4968-8776-655443322110';
  // A5d2: a pasta montada (o que o gravarCentral grava) e o modo vem do ambiente
  const montada = path.join(raiz, 'estado', 'central');
  fs.mkdirSync(montada, { recursive: true });
  for (const a of ['instrucoes-sessao.md', 'ajustes.json']) fs.writeFileSync(path.join(montada, a), '');
  const env = { ...process.env, SESSOES_WPP_CLAUDE: falsoCmd, SAIDA_FALSO: saida, SESSOES_WPP_MONTADA: montada, SESSOES_WPP_MODO: 'bypassPermissions' };
  const central = [
    '--permission-mode', 'bypassPermissions', '--settings', path.join(montada, 'ajustes.json'),
    '--append-system-prompt-file', path.join(montada, 'instrucoes-sessao.md'),
  ];
  for (const [nome, esperado] of [[TIT, ['-n', TIT, '--resume', S1, ...central]], ['', ['--resume', S1, ...central]]]) {
    fs.rmSync(saida, { force: true });
    const r = spawnSync('wscript.exe', ['//nologo', vbs, pasta, nome, S1], { env, windowsHide: true, timeout: 20000 });
    assert.equal(r.status, 0, String(r.stderr));
    let lido = null;
    for (let i = 0; i < 100 && lido === null; i++) {
      try { lido = JSON.parse(fs.readFileSync(saida, 'utf8')); } catch { await new Promise((ok) => setTimeout(ok, 100)); }
    }
    assert.ok(lido, `o claude falso rodou (${nome || 'sem nome'})`);
    assert.equal(fs.realpathSync.native(lido.cwd).toLowerCase(), fs.realpathSync.native(pasta).toLowerCase());
    assert.deepEqual(lido.argv, esperado, nome || 'sem nome');
  }
  for (const args of [[pasta, TIT, 'x y'], [pasta, TIT, '%PATH%'], [pasta, 'a%b', S1], [pasta, TIT, S1, NOVO], [pasta, ''], ['', TIT, S1]]) {
    fs.rmSync(saida, { force: true });
    const r2 = spawnSync('wscript.exe', ['//nologo', vbs, ...args], { env, windowsHide: true, timeout: 20000 });
    assert.equal(r2.status, 2, JSON.stringify(args));
    await new Promise((ok) => setTimeout(ok, 300));
    assert.equal(fs.existsSync(saida), false, `o claude falso nao rodou: ${JSON.stringify(args)}`);
  }
  fs.rmSync(raiz, { recursive: true, force: true });
});

test('T8 15. CLI reabrir-sessao: grava 1 evento {tipo, at, sessao, providerMsgId, por}; faltou --sessao ou --msg = exit 1 com {ok:false}; o uso lista o comando', () => {
  const raiz = pastaTemp('porteiro-t8-cli-');
  const env = { ...process.env, SESSOES_WPP_DIR: path.join(raiz, 'estado'), SESSOES_WPP_LOG: path.join(raiz, 'p.log'), CLAUDE_CODE_SESSION_ID: 'SC' };
  fs.mkdirSync(env.SESSOES_WPP_DIR, { recursive: true });
  const rodar = (args) => spawnSync(process.execPath, [PORTEIRO, ...args], { env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  let r = rodar(['reabrir-sessao', '--sessao', S1, '--msg', 'tg-u123']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { ok: true });
  const evs = fs.readFileSync(path.join(env.SESSOES_WPP_DIR, 'eventos.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(evs.length, 1);
  assert.deepEqual([evs[0].tipo, evs[0].sessao, evs[0].providerMsgId, evs[0].por], ['reabrir-sessao', S1, 'tg-u123', 'SC']);
  assert.ok(Number.isFinite(Date.parse(evs[0].at)));
  for (const args of [['reabrir-sessao', '--msg', 'tg-u1'], ['reabrir-sessao', '--sessao', S1]]) {
    r = rodar(args);
    assert.equal(r.status, 1, JSON.stringify(args));
    assert.equal(JSON.parse(r.stdout).ok, false);
  }
  r = rodar([]);
  assert.match(r.stdout, /reabrir-sessao --sessao "<sessionId>" --msg <id da mensagem do dono>/);
  fs.rmSync(raiz, { recursive: true, force: true });
});

test('T8 16. instrucoes: a central reabre a dona fechada (abas.mjs --fechadas + reabrir-sessao) e nao fala "pelo WhatsApp" no lugar do celular; a sessao reaberta segue de onde parou', () => {
  const central = fs.readFileSync(path.join(CENTRAL_DIR, 'instrucoes.md'), 'utf8');
  // A5d: o modelo (o caminho do repositorio entre aspas: `node "{{repo}}/abas.mjs" --fechadas`)
  assert.match(central, /node "\{\{repo\}\}\/abas\.mjs" --fechadas/);
  assert.match(central, /node "\{\{repo\}\}\/porteiro\.mjs" reabrir-sessao --sessao "<sessionId>" --msg <id/);
  assert.match(central, /pedi pro porteiro reabrir a aba X/);
  assert.doesNotMatch(central, /ele reabre no PC/);
  assert.doesNotMatch(central, /pelo WhatsApp não chega lá/);
  assert.match(central, /pelo celular não chega lá/);
  // T18: o porteiro retoma a MESMA conversa (nunca uma cópia)
  assert.doesNotMatch(central, /cópia/);
  assert.match(central, /retoma a mesma conversa escondida/);
  const sessao = fs.readFileSync(path.join(CENTRAL_DIR, 'instrucoes-sessao.md'), 'utf8');
  assert.match(sessao, /reaberta pelo celular/);
  assert.match(sessao, /siga de onde parou/);
});
