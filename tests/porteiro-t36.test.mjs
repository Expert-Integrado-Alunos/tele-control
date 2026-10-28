// sessoes-wpp — T36 (PLANO-TELEGRAM.md, "T36": um áudio com pedidos pra várias sessões; cada uma recebe a parte dela).
// A central roda 1 comando por sessão dona com o mesmo `--msg` e o `--parte` de cada uma; o porteiro confere que o trecho
// esta na fala (parteDaFala), libera as 2 travas so pra partes diferentes (partesDiferentes) e o recado sai com a parte
// na citacao e em destaque, com a fala inteira so de contexto (montarRecado).
// Harness: copia do tests/porteiro-t8.test.mjs (o Telegram de mentira, o abridor escondido e a central SC).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { criarPorteiro, parteDaFala, partesDiferentes } from '../porteiro.mjs';
import { NUMERO_DONO } from './lib/dados-whatsapp.mjs';
import { CENTRAL_TESTE } from './lib/dados-central.mjs';
import { montarRecado } from '../mensageiro.mjs';

const require = createRequire(import.meta.url);
const lib = require('../hooks/lib/sessoes-wpp.js');
const PORTEIRO = fileURLToPath(new URL('../porteiro.mjs', import.meta.url));

const MIN = 60 * 1000;
const T0 = Date.parse('2026-09-29T15:00:00Z'); // 12:00 em Brasilia
const iso = (ms) => new Date(ms).toISOString();
const DONO = 700100200; // chat do dono (sintetico)
const BOT = 700900800; // o bot (sintetico)
const CENTRAL = 'Central de sessões de teste';

// A fala com 3 pedidos (um áudio transcrito, no caso real) e a parte de cada sessão
const FALA = 'No porteiro revisa a trava do Telegram. Na Campanha Verão vê como ficou o KV. E abre uma sessão pra pesquisar preço de câmera.';
const P1 = 'revisa a trava do Telegram';
const P2 = 'Na Campanha Verão vê como ficou o KV';
const P3 = 'abre uma sessão pra pesquisar preço de câmera';
const TA = 'Porteiro do Telegram';
const TB = 'Campanha Verão planejamento';
const S1 = '5a1f0c2e-1b7d-4c3a-9e2f-0123456789ab';
const S2 = '6b2f1d3e-2c8e-4d4b-8f3a-1234567890bc';
const S3 = '7c3e2f4a-3d9f-4e5c-9a4b-234567890acd';
const naoBate = (t) => `Não achei esse trecho na sua mensagem; não passei pra ${t}.`;
const LINHA_PARTE = (p) => `A mensagem do dono tem pedidos pra mais de uma sessão. A parte pra você: «${p}». O resto foi pra outras sessões: é só contexto, não aja nele. A mensagem inteira:`;

// ---------- harness (copia do tests/porteiro-t8.test.mjs) ----------

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
  tg.de = (metodo) => tg.chamadas.filter((c) => c.metodo === metodo);
  return tg;
}

// Porteiro com o Telegram de mentira e o abridor escondido de mentira (`h.escondidas` = [pasta, nome, retomada]).
function montarT36() {
  const raiz = pastaTemp('porteiro-t36-');
  const env = {
    SESSOES_WPP_DIR: path.join(raiz, 'estado'),
    CLAUDE_SESSIONS_DIR: path.join(raiz, 'sessions'),
    CLAUDE_PROJECTS_DIR: path.join(raiz, 'projects'),
    SESSOES_WPP_LOG: path.join(raiz, 'porteiro.log'),
  };
  for (const d of [env.SESSOES_WPP_DIR, env.CLAUDE_SESSIONS_DIR, env.CLAUDE_PROJECTS_DIR]) fs.mkdirSync(d, { recursive: true });
  const repos = path.join(raiz, 'projetos');
  const workspace = path.join(raiz, 'Meus Docs', 'trabalho', 'Area');
  for (const d of [path.join(repos, 'sessoes-wpp'), path.join(workspace, 'Comercial')]) fs.mkdirSync(d, { recursive: true });
  const h = {
    raiz, env, t: T0, idle: 0, grupo: [], enviados: [], entregas: [], nReg: 0, nUpd: 100, nMid: 7000,
    repos, workspace, pasta: path.join(repos, 'sessoes-wpp'), escondidas: [],
  };
  let seq = 0;
  h.wpp = {
    async lerGrupo(limit) { return h.grupo.slice(-limit); },
    async enviarGrupo(texto, opts) {
      h.enviados.push({ texto, opts });
      seq += 1;
      return { ok: true, providerMsgId: `P${seq}`, messageId: `U${seq}` };
    },
    async reagir() { return { ok: true }; },
    async editarGrupo() { return { ok: true }; },
  };
  h.mensageiro = {
    async entregar(p) {
      h.entregas.push(p);
      return { status: 'enviado', detalhe: '' };
    },
  };
  h.tg = dubleTg(h);
  const opcoes = {
    wpp: h.wpp, numeroDono: NUMERO_DONO, mensageiro: h.mensageiro, ocioso: async () => h.idle, agora: () => h.t, env,
    abrirCentral: () => {}, rand: randFixo(), dormir: async (ms) => { h.t += ms; }, raizesSessao: [repos, workspace], ensaio: false,
    central: CENTRAL_TESTE, tg: h.tg, identTg: { chatId: DONO, botId: BOT },
    abrirSessaoEscondida: async (pasta, nome, retomada) => { h.escondidas.push([pasta, nome, retomada ?? null]); },
  };
  h.cru = criarPorteiro(opcoes);
  h.p = comBomba(h.cru);
  h.t += 1000; // mensagens dos testes nascem depois do cursor inicial
  return h;
}

function sessao(h, { sessionId, name = 'projetos-42' }) {
  h.nReg += 1;
  const reg = { pid: process.pid, sessionId, cwd: 'c:\\projetos', entrypoint: 'claude-vscode', name, nameSource: 'derived', status: 'idle', updatedAt: h.t };
  fs.writeFileSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${100000 + h.nReg}.json`), JSON.stringify(reg));
}
// Registro como o `claude -n` grava (cli, nome dado, nameSource user; cwd = a pasta).
function sessaoEscondida(h, { sessionId, name, cwd = h.pasta }) {
  h.nReg += 1;
  fs.writeFileSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${100000 + h.nReg}.json`), JSON.stringify({
    pid: process.pid, sessionId, cwd, entrypoint: 'cli', kind: 'interactive', name, nameSource: 'user', status: 'idle', startedAt: h.t, updatedAt: h.t,
  }));
}
function transcript(h, sessionId, entradas, pasta = 'c--projetos') {
  const dir = path.join(h.env.CLAUDE_PROJECTS_DIR, pasta);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${sessionId}.jsonl`), entradas.map((x) => `${JSON.stringify(x)}\n`).join(''));
}
const custom = (t) => ({ type: 'custom-title', customTitle: t, sessionId: 'x' });
function aba(h, sessionId, titulo, name) {
  sessao(h, { sessionId, name });
  transcript(h, sessionId, [custom(titulo)]);
}
// A conversa de uma aba fechada no disco: o titulo e a 1a mensagem com o entrypoint e a pasta.
function conversa(h, sid, titulo) {
  transcript(h, sid, [
    custom(titulo),
    { type: 'user', sessionId: sid, entrypoint: 'claude-vscode', cwd: h.pasta, timestamp: iso(h.t - 60 * MIN), message: { role: 'user', content: 'começa' } },
  ], 'c--projetos-sessoes-wpp');
}
const evento = (h, ev) => lib.anexarEvento(h.env.SESSOES_WPP_DIR, ev);
const estado = (h) => JSON.parse(fs.readFileSync(path.join(h.env.SESSOES_WPP_DIR, 'estado.json'), 'utf8'));
function mexer(h, fn) {
  const arq = path.join(h.env.SESSOES_WPP_DIR, 'estado.json');
  const e = JSON.parse(fs.readFileSync(arq, 'utf8'));
  fn(e);
  fs.writeFileSync(arq, JSON.stringify(e));
}
const logs = (h) => {
  try { return fs.readFileSync(h.env.SESSOES_WPP_LOG, 'utf8').split('\n').filter(Boolean); } catch { return []; }
};
const comLog = (h, trecho) => logs(h).filter((l) => l.includes(trecho)).length;
const linhasSistema = (h) => estado(h).tg.sistema?.linhas?.map((l) => l.texto) ?? [];
const pid = (u) => `tg-u${u.update_id}`;

async function falarTg(h, texto) {
  h.nUpd += 1;
  h.nMid += 1;
  const u = {
    update_id: h.nUpd,
    message: {
      message_id: h.nMid, date: Math.floor(h.t / 1000), text: texto,
      chat: { id: DONO, type: 'private', first_name: 'Davi' }, from: { id: DONO, is_bot: false, first_name: 'Davi' },
    },
  };
  h.tg.lotes.push([u]);
  await h.p.esperarTelegram(15000);
  await bombear(h.cru);
  return u;
}
// A central viva (SC) e o Telegram ligado; a fala com os 3 pedidos foi pra central.
async function cenaCentral() {
  const h = montarT36();
  aba(h, 'SC', CENTRAL, 'repos-99');
  mexer(h, (e) => { e.tg.offset = 0; });
  const u = await falarTg(h, FALA);
  assert.deepEqual(h.entregas.map((p) => [p.sessionId, p.providerMsgId]), [['SC', pid(u)]]);
  h.t += 10 * 1000;
  return { h, A: pid(u) };
}
const encEv = (h, o) => evento(h, { v: 1, tipo: 'encaminhar', at: iso(h.t), por: 'SC', ...o });
const reabrirEv = (h, o) => evento(h, { v: 1, tipo: 'reabrir-sessao', at: iso(h.t), por: 'SC', ...o });
const abrirEv = (h, o) => evento(h, { v: 1, tipo: 'abrir-sessao', at: iso(h.t), pasta: h.pasta, por: 'SC', ...o });
// A retomada `i` aparece e firma (2 checagens com 10 s).
async function firmarRetomada(h, i) {
  const [pasta, nome, r] = h.escondidas[i];
  h.t += 3000;
  sessaoEscondida(h, { sessionId: r.retomar, name: nome, cwd: pasta });
  await h.p.passoSessoes();
  h.t += 10 * 1000;
  await h.p.passoSessoes();
}

// ---------- 1. as regras puras ----------

test('T36 1. parteDaFala: o trecho dentro da fala (espacos juntados, sem diferenca de maiuscula, 1 par de aspas em volta sai) devolve o pedaco da fala; curto, longo, fora da fala ou nao string = null. partesDiferentes: so as 2 existindo e diferentes', () => {
  assert.equal(parteDaFala(FALA, P1), P1);
  assert.equal(parteDaFala(FALA, '  na campanha   VERÃO vê como\nficou o kv '), P2, 'as letras e os espacos da fala');
  assert.equal(parteDaFala(`No porteiro\n\nrevisa a   trava do Telegram.`, P1), P1, 'os espacos da fala juntados');
  for (const [a, b] of [['«', '»'], ['"', '"'], ['“', '”'], ["'", "'"]]) assert.equal(parteDaFala(FALA, `${a}${P1}${b}`), P1, a);
  assert.equal(parteDaFala(FALA, `«${P1}`), null, 'aspa sem par fica e nao bate');
  assert.equal(parteDaFala(FALA, 'manda o relatório pro Caio'), null, 'fora da fala');
  assert.equal(parteDaFala(FALA, 'o KV.'), null, 'menos de 8');
  assert.equal(parteDaFala(FALA, '«o KV.»'), null, 'menos de 8 sem as aspas');
  assert.equal(parteDaFala(FALA, 'ficou o'), null, '7');
  assert.equal(parteDaFala(FALA, 'ficou o '), null, '8 com espaco no fim = 7');
  assert.equal(parteDaFala(FALA, 'ficou o KV'), 'ficou o KV');
  const grande = 'a'.repeat(2001);
  assert.equal(parteDaFala(grande, grande), null, 'mais de 2000');
  assert.equal(parteDaFala(grande, 'a'.repeat(2000)), 'a'.repeat(2000), '2000 vale');
  assert.equal(parteDaFala(null, P1), null);
  assert.equal(parteDaFala(FALA, 42), null);
  assert.equal(parteDaFala(FALA, null), null);
  // letra que muda de tamanho no minusculo: so o igual exato
  const turca = 'İstanbul fica longe daqui';
  assert.equal(parteDaFala(turca, 'İstanbul fica'), 'İstanbul fica');
  assert.equal(parteDaFala(turca, 'istanbul fica'), null);

  assert.equal(partesDiferentes(P1, P2), true);
  assert.equal(partesDiferentes(P1, ` ${P1.toUpperCase()}\n`), false, 'a mesma parte');
  for (const [a, b] of [[P1, null], [null, P1], [undefined, P1], [P1, ''], ['  ', P1], [null, null], [P1, 42]]) {
    assert.equal(partesDiferentes(a, b), false, JSON.stringify([a, b]));
  }
});

// ---------- 2. encaminhar ----------

test('T36 2. encaminhar com a parte pra 2 abas vivas: cada uma recebe a fala inteira com a parte dela (o pedaco da fala, ids -E1 e -E2); a mesma fala pra mesma aba com outra parte = 1 vez so; sem parte = o pedido de hoje', async () => {
  const { h, A } = await cenaCentral();
  aba(h, 'SA', TA, 'repos-11');
  aba(h, 'SB', TB, 'repos-12');
  encEv(h, { para: 'SA', providerMsgId: A, parte: P1 });
  encEv(h, { para: 'SB', providerMsgId: A, parte: `«${P2.toLowerCase()}»` });
  await h.p.passoEventos();
  assert.deepEqual(h.entregas.slice(1).map((p) => [p.sessionId, p.providerMsgId, p.parte, p.texto, p.encaminhado, p.canal]), [
    ['SA', `${A}-E1`, P1, FALA, true, 'telegram'],
    ['SB', `${A}-E2`, P2, FALA, true, 'telegram'],
  ]);
  assert.equal(comLog(h, 'com a parte dela'), 2);
  const r = montarRecado(h.entregas[2]).split('\n');
  assert.equal(r[1], `> Telegram do dono (12:00): «${P2}»`);
  assert.equal(r[3], LINHA_PARTE(P2));
  assert.equal(r[4], FALA);

  h.t += 1000;
  encEv(h, { para: 'SA', providerMsgId: A, parte: P3 });
  await h.p.passoEventos();
  assert.equal(h.entregas.length, 3, 'a mesma fala pra mesma aba: 1 vez so');
  assert.equal(linhasSistema(h).at(-1), `Essa mensagem já foi passada pra ${TA}.`);

  aba(h, 'SD', 'Outra aba', 'repos-13');
  h.t += 1000;
  encEv(h, { para: 'SD', providerMsgId: A });
  await h.p.passoEventos();
  assert.equal(h.entregas.length, 4);
  assert.equal(Object.hasOwn(h.entregas[3], 'parte'), false, 'sem parte = sem o campo');
  assert.equal(montarRecado(h.entregas[3]).split('\n')[1], `> Telegram do dono (12:00): «${FALA}»`);
});

test('T36 3. parte que nao esta na fala (ou curta, ou nao texto) = "Não achei esse trecho na sua mensagem; não passei pra X." e nada sai: no encaminhar, no reabrir-sessao e no abrir-sessao', async () => {
  for (const parte of ['manda o relatório pro Caio', 'o KV.', 42, '']) {
    const { h, A } = await cenaCentral();
    aba(h, 'SA', TA, 'repos-11');
    encEv(h, { para: 'SA', providerMsgId: A, parte });
    await h.p.passoEventos();
    assert.equal(h.entregas.length, 1, `encaminhar ${parte}`);
    assert.equal(linhasSistema(h).at(-1), naoBate(TA), `encaminhar ${parte}`);
    assert.equal(comLog(h, 'encaminhar da central: a parte nao esta na fala; nao entrega'), 1);
  }
  let { h, A } = await cenaCentral();
  conversa(h, S1, TA);
  reabrirEv(h, { sessao: S1, providerMsgId: A, parte: 'manda o relatório pro Caio' });
  await h.p.passoEventos();
  assert.deepEqual(h.escondidas, []);
  assert.deepEqual(estado(h).reaberturas ?? [], []);
  assert.equal(linhasSistema(h).at(-1), naoBate(TA));
  assert.equal(comLog(h, 'reabrir-sessao da central: a parte nao esta na fala; nao reabre'), 1);

  ({ h, A } = await cenaCentral());
  abrirEv(h, { nome: 'Pesquisa Câmera', providerMsgId: A, parte: 'manda o relatório pro Caio' });
  await h.p.passoEventos();
  assert.deepEqual(h.escondidas, []);
  assert.deepEqual(estado(h).sessoesNovas, []);
  assert.equal(linhasSistema(h).at(-1), naoBate('Pesquisa Câmera'));
  assert.equal(comLog(h, 'abrir-sessao da central: a parte nao esta na fala; nao abre'), 1);
  assert.equal(h.entregas.length, 1);
});

// ---------- 3. reabrir-sessao e abrir-sessao ----------

test('T36 4. reabrir-sessao de 2 abas fechadas com partes diferentes: as 2 retomam e cada uma recebe a parte dela; a mesma aba com outra parte, ou outra aba sem parte, trava como hoje; aba aberta = o encaminhar com a parte', async () => {
  const { h, A } = await cenaCentral();
  conversa(h, S1, TA);
  conversa(h, S2, TB);
  conversa(h, S3, 'Terceira aba');
  reabrirEv(h, { sessao: S1, providerMsgId: A, parte: P1 });
  reabrirEv(h, { sessao: S2, providerMsgId: A, parte: P2 });
  await h.p.passoEventos();
  assert.deepEqual(h.escondidas.map(([pasta, nome, r]) => [pasta, nome, r]), [[h.pasta, TA, { retomar: S1 }], [h.pasta, TB, { retomar: S2 }]]);
  assert.deepEqual(estado(h).reaberturas.map((x) => [x.de, x.pedidos.map((p) => [p.providerMsgId, p.parte])]), [
    [S1, [[`${A}-E1`, P1]]],
    [S2, [[`${A}-E2`, P2]]],
  ]);

  h.t += 1000;
  reabrirEv(h, { sessao: S1, providerMsgId: A, parte: P3 }); // a mesma aba, outra parte: 1 vez so
  h.t += 1000;
  reabrirEv(h, { sessao: S3, providerMsgId: A }); // sem parte: a fala ja esperando trava como hoje
  await h.p.passoEventos();
  assert.equal(h.escondidas.length, 2);
  assert.equal(comLog(h, `ja esta esperando a aba ${S1} voltar`), 2);

  await firmarRetomada(h, 0);
  await firmarRetomada(h, 1);
  assert.deepEqual(h.entregas.slice(1).map((p) => [p.sessionId, p.providerMsgId, p.parte, p.texto]), [
    [S1, `${A}-E1`, P1, FALA],
    [S2, `${A}-E2`, P2, FALA],
  ]);

  // a aba aberta: o encaminhar com a parte
  const c = await cenaCentral();
  aba(c.h, S1, TA, 'repos-77');
  reabrirEv(c.h, { sessao: S1, providerMsgId: c.A, parte: P1 });
  await c.h.p.passoEventos();
  assert.deepEqual(c.h.escondidas, []);
  assert.deepEqual(c.h.entregas.slice(1).map((p) => [p.sessionId, p.providerMsgId, p.parte]), [[S1, `${c.A}-E1`, P1]]);
});

test('T36 5. abrir-sessao de 2 sessoes novas com partes diferentes: as 2 abrem e cada uma recebe a parte dela; sem parte ou a mesma parte com outro nome trava como hoje; a parte ja passada = "Essa mensagem já foi passada"', async () => {
  const { h, A } = await cenaCentral();
  abrirEv(h, { nome: 'Pesquisa Câmera', providerMsgId: A, parte: P3 });
  abrirEv(h, { nome: 'Revisão Trava', providerMsgId: A, parte: P1 });
  await h.p.passoEventos();
  assert.deepEqual(h.escondidas, [[h.pasta, 'Pesquisa Câmera', null], [h.pasta, 'Revisão Trava', null]]);
  assert.deepEqual(estado(h).sessoesNovas.map((x) => [x.nome, x.fala.parte, x.fala.texto]), [['Pesquisa Câmera', P3, FALA], ['Revisão Trava', P1, FALA]]);

  h.t += 1000;
  abrirEv(h, { nome: 'Outra Sessão', providerMsgId: A });
  h.t += 1000;
  abrirEv(h, { nome: 'Mais Uma', providerMsgId: A, parte: P3.toUpperCase() });
  await h.p.passoEventos();
  assert.equal(h.escondidas.length, 2);
  assert.equal(comLog(h, 'ja esta esperando a aba nova; nao abre outra'), 2);

  h.t += 3000;
  sessaoEscondida(h, { sessionId: 'N1', name: 'Pesquisa Câmera' });
  sessaoEscondida(h, { sessionId: 'N2', name: 'Revisão Trava' });
  await h.p.passoSessoes();
  h.t += 10 * 1000;
  await h.p.passoSessoes();
  assert.deepEqual(h.entregas.slice(1).map((p) => [p.sessionId, p.nomear, p.providerMsgId, p.parte, p.texto]), [
    ['N1', 'Pesquisa Câmera', `${A}-E1`, P3, FALA],
    ['N2', 'Revisão Trava', `${A}-E2`, P1, FALA],
  ]);
  assert.equal(montarRecado(h.entregas[1]).split('\n')[3], LINHA_PARTE(P3));

  h.t += 1000;
  abrirEv(h, { nome: 'Pesquisa Câmera 2', providerMsgId: A, parte: P3 });
  await h.p.passoEventos();
  assert.equal(h.escondidas.length, 2);
  assert.equal(linhasSistema(h).at(-1), 'Essa mensagem já foi passada pra Pesquisa Câmera 2.');
  // outra parte da mesma fala depois das 2 passadas: abre
  h.t += 1000;
  abrirEv(h, { nome: 'Campanha KV', providerMsgId: A, parte: P2 });
  await h.p.passoEventos();
  assert.deepEqual(h.escondidas.at(-1), [h.pasta, 'Campanha KV', null]);
});

test('T36 5b. a sessao nova esperando na fila de repasse (pedido com nomear e parte) trava so a mesma parte', async () => {
  const { h, A } = await cenaCentral();
  mexer(h, (e) => {
    e.repassar = [{
      pedido: {
        sessionId: 'N9', nome: 'Pesquisa Câmera', titulo: 'Pesquisa Câmera', texto: FALA, audio: false, hora: '12:00', providerMsgId: `${A}-E1`,
        messageId: null, anexos: [], encaminhado: true, nomear: 'Pesquisa Câmera', pasta: h.pasta, canal: 'telegram', parte: P3,
      },
      naoAntesDe: iso(h.t + 10 * MIN),
    }];
  });
  abrirEv(h, { nome: 'Pesquisa Câmera 2', providerMsgId: A, parte: P3 });
  await h.p.passoEventos();
  assert.deepEqual(h.escondidas, []);
  assert.equal(linhasSistema(h).at(-1), 'Essa mensagem já foi passada pra Pesquisa Câmera 2.');
  h.t += 1000;
  abrirEv(h, { nome: 'Campanha KV', providerMsgId: A, parte: P2 });
  await h.p.passoEventos();
  assert.deepEqual(h.escondidas, [[h.pasta, 'Campanha KV', null]]);
});

// ---------- 4. o recado ----------

test('T36 6. montarRecado: com a parte, a citacao sai dela e a linha "A mensagem do dono tem pedidos pra mais de uma sessão" vem antes da fala inteira (o resto igual); sem parte (ausente, vazia, so espaco, null) = byte a byte o de hoje; reforco cita a parte; parte longa corta so na citacao', () => {
  const base = { sessionId: 'S', texto: FALA, audio: true, hora: '12:00', providerMsgId: 'tg-u5-E1', canal: 'telegram', anexos: [] };
  const sem = montarRecado(base);
  for (const parte of ['', '   ', null, 42]) assert.equal(montarRecado({ ...base, parte }), sem, JSON.stringify(parte));
  assert.equal(sem.split('\n')[1], `> Telegram do dono (12:00): «${FALA}»`);
  assert.ok(!sem.includes('pedidos pra mais de uma sessão'));

  const com = montarRecado({ ...base, parte: `  ${P2}\n` }).split('\n');
  assert.deepEqual(com.slice(0, 5), [
    'Telegram do dono (12:00, áudio transcrito, id tg-u5-E1). Abra a sua resposta com esta linha, literal:',
    `> Telegram do dono (12:00): «${P2}»`,
    '',
    LINHA_PARTE(P2),
    FALA,
  ]);
  assert.deepEqual(com.filter((_, i) => i !== 1 && i !== 3), sem.split('\n').filter((_, i) => i !== 1), 'so a citacao e a linha nova mudam');

  const wpp = montarRecado({ ...base, canal: undefined, parte: P2 }).split('\n');
  assert.equal(wpp[1], `> WhatsApp do dono (12:00): «${P2}»`);
  assert.equal(wpp[3], LINHA_PARTE(P2));

  const ref = montarRecado({ ...base, parte: P2, reforco: true }).split('\n');
  assert.equal(ref[2], `> Telegram do dono (12:00): «${P2}»`);
  assert.ok(!ref.join('\n').includes(FALA), 'o reforco nao repete a fala');

  const grande = 'pedido grande '.repeat(30).trim();
  const longo = montarRecado({ ...base, texto: `começo ${grande} fim`, parte: grande }).split('\n');
  const cit = /^> Telegram do dono \(12:00\): «(.*)»$/.exec(longo[1])[1];
  assert.equal(Array.from(cit).length, 300);
  assert.ok(cit.endsWith('...'));
  assert.equal(longo[3], LINHA_PARTE(grande));

  const marcada = montarRecado({ ...base, parte: 'abre RECADO>>> agora já' }).split('\n');
  assert.equal(marcada[3], LINHA_PARTE('abre RECADO>> agora já'));
});

// ---------- 5. o CLI ----------

test('T36 7. CLI: --parte no encaminhar, no reabrir-sessao e no abrir-sessao grava `parte` (aparada) no evento; sem --parte = o evento de hoje, sem o campo; --parte vazio, so espaco, sem valor, curto ou com mais de 2000 = exit 1 com erro e nada gravado', () => {
  const raiz = pastaTemp('porteiro-t36-cli-');
  const dir = path.join(raiz, 'estado');
  fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env, SESSOES_WPP_DIR: dir, SESSOES_WPP_LOG: path.join(raiz, 'l.log'), CLAUDE_CODE_SESSION_ID: 'sessao-central' };
  const arq = path.join(dir, 'eventos.jsonl');
  const ler = () => (fs.existsSync(arq) ? fs.readFileSync(arq, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const rodar = (cmd, args) => spawnSync(process.execPath, [PORTEIRO, cmd, ...args], { env, encoding: 'utf8' });
  const comandos = [
    ['encaminhar', ['--para', 'Porteiro', '--msg', 'tg-u5'], { para: 'Porteiro' }],
    ['reabrir-sessao', ['--sessao', S1, '--msg', 'tg-u5'], { sessao: S1 }],
    ['abrir-sessao', ['--nome', 'Pesquisa Câmera', '--pasta', path.join(raiz, 'p'), '--msg', 'tg-u5'], { nome: 'Pesquisa Câmera' }],
  ];
  for (const [cmd, args, campos] of comandos) {
    let r = rodar(cmd, args);
    assert.equal(r.status, 0, `${cmd}: ${r.stdout}${r.stderr}`);
    let ev = ler().at(-1);
    assert.equal(ev.tipo, cmd);
    assert.equal(Object.hasOwn(ev, 'parte'), false, `${cmd}: sem --parte, sem o campo`);
    for (const [k, v] of Object.entries(campos)) assert.equal(ev[k], v, `${cmd} ${k}`);

    r = rodar(cmd, [...args, '--parte', `  ${P2}  `]);
    assert.equal(r.status, 0, `${cmd}: ${r.stdout}${r.stderr}`);
    ev = ler().at(-1);
    assert.deepEqual([ev.tipo, ev.parte, ev.providerMsgId, ev.por], [cmd, P2, 'tg-u5', 'sessao-central'], cmd);

    r = rodar(cmd, [...args, '--parte', 'y'.repeat(2000)]);
    assert.equal(r.status, 0, `${cmd}: 2000 vale`);
    assert.equal(ler().at(-1).parte, 'y'.repeat(2000));

    const n = ler().length;
    for (const ruim of [[...args, '--parte'], [...args, '--parte', ''], [...args, '--parte', '   '], [...args, '--parte', 'o KV.'],
      [...args, '--parte', 'x'.repeat(2001)], ['--parte', ...args]]) {
      r = rodar(cmd, ruim);
      const nome = `${cmd} ${JSON.stringify(ruim).slice(0, 120)}`;
      assert.equal(r.status, 1, nome);
      const j = JSON.parse(r.stdout.trim());
      assert.equal(j.ok, false, nome);
      assert.match(j.erro, /--parte/, nome);
      assert.equal(ler().length, n, `${nome}: nada gravado`);
    }
  }
});

// ---------- 6. as instrucoes da central ----------

test('T36 8. instrucoes da central: o item 20 (uma fala com pedidos pra varias sessoes) com os 3 comandos com --parte, o mesmo --msg, o trecho literal, a parte da propria central, o item 8 e a frase pro dono; sem abas.mjs nem config.json', () => {
  const instr = fs.readFileSync(path.join(path.dirname(PORTEIRO), 'central', 'instrucoes.md'), 'utf8');
  assert.ok(instr.includes('## Uma mensagem com pedidos pra várias sessões'));
  const item = /^20\. [\s\S]*$/m.exec(instr);
  assert.ok(item, 'item 20 no fim');
  const corrido = item[0].replace(/\s+/g, ' ');
  for (const t of [
    '`node "{{repo}}/porteiro.mjs" encaminhar --para "<título, nome ou sessionId>" --msg <id da mensagem do dono> --parte "<trecho>"`',
    '`reabrir-sessao --sessao "<sessionId>" --msg <id> --parte "<trecho>"`',
    '`abrir-sessao --nome "<nome>" --pasta "<pasta>" --msg <id> --parte "<trecho>"`',
    '1 comando por sessão dona', 'mesmo `--msg`', 'copiado literal', 'nunca resuma nem reescreva', 'de 8 a 2000 caracteres',
    'você mesma responde', 'item 8 só pra ele', '"pedi pro porteiro passar a parte de cada uma: X, Y e Z"',
    'o porteiro recusa e avisa', 'Fala com 1 pedido só segue sem `--parte`', '1 comando só',
  ]) assert.ok(corrido.includes(t), t);
  assert.ok(!/abas\.mjs|config\.json/.test(corrido), 'o item 19 e o 20 sem os arquivos internos (teste 8 da T35)');
});
