// Testes da T41 (PLANO-TELEGRAM.md, "T41"; caso real: a sessao nova aberta pelo celular ficava viva escondida pra sempre
// e a conversa aberta depois no VS Code mostrava «This conversation is still open somewhere else»). A sessao nova
// ESCONDIDA que firma fica gravada em e.retomadas, como a escondida que o porteiro retomou (T18b), e o devolverRetomadas
// fecha ela pelas mesmas regras: parada e sem fala esperando, com o dono no PC, com a mesma conversa viva no VS Code ou
// depois de 30 min.
// - T41 1: a sessao nova escondida que firma fica gravada (o pid do registro `cli` dela, a hora em que firmou).
// - T41 2: nao fica gravada: a aba nova do VS Code (sem o abridor escondido) e o sessionId que nao e UUID (a faxina).
// - T41 3: a fala entregue segura; trabalhando nao fecha; parada ha 1 min com o dono no PC fecha (so o pid dela).
// - T41 4: os outros 2 motivos (a mesma conversa viva no VS Code; 30 min parada) valem pra ela.
// Isolamento: como o tests/porteiro-t18.test.mjs (pastas temporarias via SESSOES_WPP_DIR, CLAUDE_SESSIONS_DIR,
// CLAUDE_PROJECTS_DIR e SESSOES_WPP_LOG; dubles de tg, wpp, mensageiro e abridor; `processos` e `pidVivo` falsos: nenhum
// processo de verdade e consultado ou morto) + a central e o `abrir-sessao` do tests/porteiro-t6.test.mjs.
// Rodar: node --test --test-reporter=tap "tests/porteiro-t41.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { criarPorteiro } from '../porteiro.mjs';
import { NUMERO_DONO } from './lib/dados-whatsapp.mjs';
import { CENTRAL_TESTE } from './lib/dados-central.mjs';

const require = createRequire(import.meta.url);
const lib = require('../hooks/lib/sessoes-wpp.js');

const MIN = 60 * 1000;
const T0 = Date.parse('2026-09-29T15:00:00Z'); // 12:00 em Brasilia
const iso = (ms) => new Date(ms).toISOString();
const DONO = 700100200;
const BOT = 700900800;
const NOME = 'Revisão Porteiro';
const FALA = 'abre uma sessão pra revisar o porteiro';
const CENTRAL = 'Central de sessões de teste';
const N1 = '7c3f2e1d-3d9f-4e5c-8a4b-2345678901ef'; // a sessao nova
const NOVA = 43001; // pid da sessao nova escondida
const VSC = 41001; // pid da aba do VS Code
const PID_CENTRAL = 31001;

// ---------- harness (do tests/porteiro-t18.test.mjs + a central e o abrir-sessao do tests/porteiro-t6.test.mjs) ----------

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
    return lote;
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
  return tg;
}

// Porteiro com o Telegram, o abridor escondido de mentira (`h.escondidas`) e os processos falsos: `h.vivos` (pids vivos
// pro pidVivo), `h.procs` (pid -> o que o processos.info devolve) e `h.mortes` (cada matarArvore). `h.idle` = o que o
// ocioso devolve (padrao 5 min: o dono fora do PC). `vsCode: true` = sem o abridor escondido (a aba nova do VS Code):
// foto das janelas em `h.janelas` (abrir poe a janela nova).
function montar({ vsCode = false } = {}) {
  const raiz = pastaTemp('porteiro-t41-');
  const env = {
    SESSOES_WPP_DIR: path.join(raiz, 'estado'),
    CLAUDE_SESSIONS_DIR: path.join(raiz, 'sessions'),
    CLAUDE_PROJECTS_DIR: path.join(raiz, 'projects'),
    SESSOES_WPP_LOG: path.join(raiz, 'porteiro.log'),
  };
  for (const d of [env.SESSOES_WPP_DIR, env.CLAUDE_SESSIONS_DIR, env.CLAUDE_PROJECTS_DIR]) fs.mkdirSync(d, { recursive: true });
  const repos = path.join(raiz, 'repos');
  const workspace = path.join(raiz, 'Meus Docs', 'trabalho', 'Area');
  for (const d of [path.join(repos, 'sessoes-wpp'), workspace]) fs.mkdirSync(d, { recursive: true });
  const h = {
    raiz, env, t: T0, idle: 5 * MIN, entregas: [], escondidas: [], vsCodeAbertos: [], nUpd: 100, nMid: 7000,
    pasta: path.join(repos, 'sessoes-wpp'), vivos: new Set(), procs: new Map(), mortes: [],
    janelas: { sessao: '20260930T085209', ids: [1], comClaude: [1] },
    estadoArq: path.join(env.SESSOES_WPP_DIR, 'estado.json'),
  };
  const wpp = {
    async lerGrupo() { return []; },
    async enviarGrupo() { return { ok: true, providerMsgId: 'P1', messageId: 'U1' }; },
    async reagir() { return { ok: true }; },
    async editarGrupo() { return { ok: true }; },
  };
  const mensageiro = {
    async entregar(p) {
      h.entregas.push(p);
      return { status: 'enviado', detalhe: '' };
    },
  };
  h.tg = dubleTg(h);
  const processos = {
    info(pid) { return h.procs.get(pid) ?? null; },
    matarArvore(pid) {
      h.mortes.push(pid);
      h.vivos.delete(pid);
      return true;
    },
    filhos() { return []; },
  };
  const opcoes = {
    wpp, numeroDono: NUMERO_DONO, mensageiro, ocioso: async () => h.idle, agora: () => h.t, env, abrirCentral: () => {},
    rand: randFixo(), dormir: async (ms) => { h.t += ms; }, raizesSessao: [repos, workspace], ensaio: false, tg: h.tg,
    identTg: { chatId: DONO, botId: BOT }, processos, pidVivo: (pid) => h.vivos.has(Number(pid)), central: CENTRAL_TESTE,
    abrirSessaoEscondida: async (pasta, nome, retomada) => { h.escondidas.push([pasta, nome, retomada ?? null]); },
  };
  if (vsCode) {
    delete opcoes.abrirSessaoEscondida;
    opcoes.abrirSessaoVsCode = async (pasta) => {
      h.vsCodeAbertos.push(pasta);
      h.janelas.ids.push(Math.max(0, ...h.janelas.ids) + 1);
    };
    opcoes.janelasVsCode = () => structuredClone(h.janelas);
    opcoes.abrirLinkVsCode = async () => {};
  }
  h.cru = criarPorteiro(opcoes);
  h.p = comBomba(h.cru);
  h.t += 1000; // as mensagens dos testes nascem depois do cursor inicial
  return h;
}

// Registro como o Claude Code grava (`<pid>.json`); o pid entra nos vivos e no processos.info (claude.exe criado na hora
// do startedAt). O status vale desde agora (statusUpdatedAt).
function registro(h, { pid, sessionId, entrypoint, name, cwd, status = 'idle', startedAt = h.t }) {
  const reg = {
    pid, sessionId, cwd, entrypoint, kind: 'interactive', name, nameSource: entrypoint === 'cli' ? 'user' : 'derived',
    status, startedAt, updatedAt: h.t, statusUpdatedAt: h.t,
  };
  fs.writeFileSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${pid}.json`), JSON.stringify(reg));
  h.vivos.add(pid);
  h.procs.set(pid, { nome: 'claude.exe', paiPid: 1, criadoEm: startedAt });
  return reg;
}
// A sessao nova como o `claude -n` grava (cli, o nome pedido, na pasta) e o status dela mudando depois.
const nova = (h, o = {}) => registro(h, { pid: NOVA, sessionId: N1, entrypoint: 'cli', name: NOME, cwd: h.pasta, ...o });
function transcript(h, sessionId, entradas, pasta) {
  const dir = path.join(h.env.CLAUDE_PROJECTS_DIR, pasta);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${sessionId}.jsonl`), entradas.map((x) => `${JSON.stringify(x)}\n`).join(''));
}
const estado = (h) => JSON.parse(fs.readFileSync(h.estadoArq, 'utf8'));
function mexer(h, fn) {
  const e = estado(h);
  fn(e);
  fs.writeFileSync(h.estadoArq, JSON.stringify(e));
}
const logs = (h) => {
  try { return fs.readFileSync(h.env.SESSOES_WPP_LOG, 'utf8').split('\n').filter(Boolean); } catch { return []; }
};
const comLog = (h, trecho) => logs(h).filter((l) => l.includes(trecho)).length;

// A central viva (SC), o Telegram ligado, a fala do dono pelo Telegram entregue na central e o `abrir-sessao` que a
// central grava ja tratado: o item espera a sessao nova. -> {h, A (o id da fala)}
async function cenaPedida(o = {}) {
  const h = montar(o);
  registro(h, { pid: PID_CENTRAL, sessionId: 'SC', entrypoint: 'claude-vscode', name: 'repos-99', cwd: 'c:\\projetos' });
  transcript(h, 'SC', [{ type: 'custom-title', customTitle: CENTRAL, sessionId: 'x' }], 'c--projetos');
  mexer(h, (e) => { e.tg.offset = 0; });
  h.nUpd += 1;
  h.nMid += 1;
  h.tg.lotes.push([{
    update_id: h.nUpd,
    message: {
      message_id: h.nMid, date: Math.floor(h.t / 1000), text: FALA,
      chat: { id: DONO, type: 'private', first_name: 'Davi' }, from: { id: DONO, is_bot: false, first_name: 'Davi' },
    },
  }]);
  await h.p.esperarTelegram(15000);
  await bombear(h.cru);
  const A = `tg-u${h.nUpd}`;
  assert.deepEqual(h.entregas.map((p) => [p.sessionId, p.providerMsgId]), [['SC', A]], 'a fala foi pra central');
  h.t += 10 * 1000;
  lib.anexarEvento(h.env.SESSOES_WPP_DIR, { v: 1, tipo: 'abrir-sessao', at: iso(h.t), nome: NOME, pasta: h.pasta, providerMsgId: A, por: 'SC' });
  await h.p.passoEventos();
  assert.equal(estado(h).sessoesNovas.length, 1, 'o item espera a sessao nova');
  return { h, A };
}
// O registro da sessao nova aparece e firma (2 checagens com 10 s): a fala vai pra ela.
async function firmar(h, o = {}) {
  h.t += 3000;
  nova(h, o);
  await h.p.passoSessoes();
  h.t += 10 * 1000;
  await h.p.passoSessoes();
}
// A sessao nova escondida firme, com a fala entregue, o trabalho feito e parada ha `parada` ms.
async function cenaParada(parada) {
  const { h, A } = await cenaPedida();
  await firmar(h);
  const startedAt = h.t - 10 * 1000;
  h.t += 5 * 1000;
  nova(h, { status: 'busy', startedAt }); // pegou o recado e esta trabalhando
  h.t += 2 * MIN;
  nova(h, { status: 'idle', startedAt }); // terminou agora
  h.t += parada;
  return { h, A };
}

// Mac-testes (A): os testes marcados com SO_WINDOWS conferem a premissa do Windows (o processo `claude.exe`); fora do
// win32 eles pulam. O caminho do Mac tem os testes proprios em tests/mac-*.test.mjs.
const SO_WINDOWS = process.platform !== 'win32' && 'premissa do Windows (o Mac tem os tests/mac-*)';

// ---------- a sessao nova escondida fica gravada ----------

test('T41 1. a sessao nova escondida que firma fica gravada em e.retomadas (o pid do registro cli dela e a hora em que firmou) e a fala vai pra ela; antes de firmar, nada gravado', async () => {
  const { h, A } = await cenaPedida();
  assert.deepEqual(h.escondidas, [[h.pasta, NOME, null]], 'a sessao nova nasce escondida, sem retomada');
  h.t += 3000;
  nova(h);
  await h.p.passoSessoes();
  assert.deepEqual(estado(h).retomadas, {}, 'vista 1 vez: ainda nao firmou');
  h.t += 10 * 1000;
  await h.p.passoSessoes();
  assert.deepEqual(h.entregas.slice(1).map((p) => [p.sessionId, p.nome, p.providerMsgId]), [[N1, NOME, `${A}-E1`]]);
  assert.deepEqual(estado(h).sessoesNovas, [], 'o item saiu');
  assert.deepEqual(estado(h).retomadas, { [N1]: { pid: NOVA, desde: iso(h.t) } });
});

test('T41 2. nao grava: a aba nova do VS Code (sem o abridor escondido) e a sessao escondida com sessionId que nao e UUID; as duas firmam e recebem a fala como antes', async () => {
  // a aba nova do VS Code: e do dono, o porteiro nunca fecha
  let { h, A } = await cenaPedida({ vsCode: true });
  assert.deepEqual([h.vsCodeAbertos, h.escondidas], [[h.pasta], []]);
  h.t += 3000;
  registro(h, { pid: VSC, sessionId: N1, entrypoint: 'claude-vscode', name: 'projetos-77', cwd: h.pasta });
  await h.p.passoSessoes();
  h.t += 10 * 1000;
  await h.p.passoSessoes();
  assert.deepEqual(h.entregas.slice(1).map((p) => [p.sessionId, p.providerMsgId]), [[N1, `${A}-E1`]], 'a aba nova recebe');
  assert.deepEqual(estado(h).retomadas, {}, 'a aba do VS Code nunca e gravada');

  // sessionId que nao e UUID: firma e recebe, mas nao fica (a faxina do salvar tira; nada de entrada torta no log)
  ({ h, A } = await cenaPedida());
  await firmar(h, { sessionId: 'E1' });
  assert.deepEqual(h.entregas.slice(1).map((p) => [p.sessionId, p.providerMsgId]), [['E1', `${A}-E1`]]);
  assert.deepEqual(estado(h).retomadas, {});
  h.idle = 0;
  await h.p.passoMinuto();
  assert.equal(comLog(h, 'entrada torta'), 0);
  assert.deepEqual(h.mortes, []);
});

// ---------- a sessao nova volta pro VS Code como a retomada ----------

test('T41 3. a sessao nova gravada, com o dono no PC: a fala entregue que ainda nao virou trabalho segura; trabalhando nao fecha; parada ha 59 s nao; parada ha 1 min fecha (so o pid dela, pelo passo rapido) e esquece', { skip: SO_WINDOWS }, async () => {
  const { h } = await cenaPedida();
  await firmar(h);
  const startedAt = h.t - 10 * 1000;
  h.idle = 0; // o dono no PC
  // a fala entregue e ela ainda nao mexeu (o status de antes da entrega), ha mais de 1 min: espera
  h.t += 2 * MIN;
  await h.p.passoRetomadas();
  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, [], 'a fala entregue ainda nao virou trabalho');
  // trabalhando
  nova(h, { status: 'busy', startedAt });
  h.t += 5 * MIN;
  await h.p.passoRetomadas();
  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, [], 'ocupada nunca fecha');
  // terminou ha 59 s
  nova(h, { status: 'idle', startedAt });
  h.t += 59 * 1000;
  await h.p.passoRetomadas();
  assert.deepEqual(h.mortes, [], '59 s: ainda nao');
  assert.deepEqual(Object.keys(estado(h).retomadas), [N1]);
  h.t += 1000;
  await h.p.passoRetomadas();
  assert.deepEqual(h.mortes, [NOVA], 'so a sessao nova, nunca a central');
  assert.deepEqual(estado(h).retomadas, {});
  assert.equal(comLog(h, `retomada ${N1}: a escondida (pid ${NOVA}) fechada: o dono esta no PC`), 1);
  await h.p.passoRetomadas();
  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, [NOVA], 'esquecida: nao fecha de novo');
});

test('T41 4. os outros 2 motivos valem pra sessao nova: a mesma conversa viva no VS Code (parada ha 1 min, com o dono fora) e 30 min parada (29 min nao)', { skip: SO_WINDOWS }, async () => {
  // o dono abriu a conversa no VS Code («Open here anyway»): fecha a escondida, nunca a do VS Code
  let { h } = await cenaParada(MIN);
  registro(h, { pid: VSC, sessionId: N1, entrypoint: 'claude-vscode', name: 'projetos-77', cwd: 'c:\\projetos', startedAt: h.t - MIN });
  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, [NOVA]);
  assert.equal(comLog(h, `retomada ${N1}: a escondida (pid ${NOVA}) fechada: a mesma conversa esta no VS Code`), 1);
  assert.deepEqual(estado(h).retomadas, {});

  // o dono fora do PC e sem o VS Code: so nos 30 min
  ({ h } = await cenaParada(29 * MIN));
  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, [], '29 min: ainda nao');
  assert.deepEqual(Object.keys(estado(h).retomadas), [N1]);
  h.t += MIN;
  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, [NOVA]);
  assert.equal(comLog(h, `retomada ${N1}: a escondida (pid ${NOVA}) fechada: parada ha 30 min`), 1);
});
