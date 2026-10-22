// Testes da T35 (PLANO-TELEGRAM.md, "T35 — escolher pela central quem fica no painel e listar quem está fora"; pedido
// do dono pelo Telegram, longe do PC: «E se eu quiser em outras situações escolher quais as sessões que eu coloco aqui
// [...] inclusive listar algumas que não estão, porque tipo algumas sumiram [...] Listar as sessões que não estão aí?»).
// - 1: o estado (escolhasPainel e painelLista no estado velho) e a poda.
// - 2: a escolha nos dados do painel: com o foco (posta entra, tirada sai, pedido de OK fica, a linha do fim com as
//   postas) e sem o foco (tirada sai, a linha so com o numero); a foto de dentro e de fora.
// - 3 e 4: o evento da central pelo Telegram (por, tirar, normal, limpar; a frase em cima da fala dele; nada vai pra
//   aba) e as guardas (outra sessao, travado, sem id, acao torta, sessao torta, repetido).
// - 5: o passo de minuto remonta a lista velha (sem painel na tela).
// - 6 e 7: o CLI `painel` (so le; os blocos, as palavras, o teto de 60, sem foto) e as acoes (1 evento; recusas).
// - 8: a linha do fim (linhaDoFoco) e o item 19 das instrucoes da central.
// Isolamento: pastas temporarias via SESSOES_WPP_DIR, CLAUDE_SESSIONS_DIR, CLAUDE_PROJECTS_DIR e SESSOES_WPP_LOG (nunca o
// ~/.claude real nem o banco do VS Code de verdade). Nenhuma rede: `tg`, `wpp`, o mensageiro e a lista do VS Code sao
// dubles. Harness copiado (enxuto) do tests/porteiro-t33.test.mjs.
// Rodar: node --test --test-reporter=tap "tests/porteiro-t35.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { criarPorteiro } from '../porteiro.mjs';
import { raizNormal } from '../lib/lista-vscode.mjs';
import * as formatoTg from '../lib/formato-tg.mjs';
import { horaBRT, diaBRT } from '../lib/formato.mjs';
import { NUMERO_DONO } from './lib/dados-whatsapp.mjs';
import { CENTRAL_TESTE } from './lib/dados-central.mjs';

const require = createRequire(import.meta.url);
const lib = require('../hooks/lib/sessoes-wpp.js');
const PORTEIRO = fileURLToPath(new URL('../porteiro.mjs', import.meta.url));
const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-21T18:30:00Z'); // 15:30 em Brasilia
const iso = (ms) => new Date(ms).toISOString();
const DONO = 700100200;
const BOT = 700900800;
const BOT_NOME = 'Teste_ControleBot';
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SC = U(99); // a central
const CAB = '🎛️ *Controle de sessões*';

// ---------- harness (copia enxuta do tests/porteiro-t33.test.mjs) ----------

const tique = () => new Promise((ok) => setImmediate(ok));
async function bombear(p) {
  for (let i = 0; i < 100; i++) {
    const r = await p.passoEntrega();
    if (!r.emVoo && !r.fila) return;
    await tique();
  }
  throw new Error('bombear: a fila de entrega nao esvaziou');
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
  tg.quemSou = async () => ({ ok: true, id: BOT, username: BOT_NOME });
  tg.definirComandos = async () => ({ ok: true });
  tg.de = (metodo) => tg.chamadas.filter((c) => c.metodo === metodo);
  tg.zerar = () => { tg.chamadas.length = 0; };
  return tg;
}

function montar({ foco = null } = {}) {
  const raiz = pastaTemp('porteiro-t35-');
  const env = {
    SESSOES_WPP_DIR: path.join(raiz, 'estado'),
    CLAUDE_SESSIONS_DIR: path.join(raiz, 'sessions'),
    CLAUDE_PROJECTS_DIR: path.join(raiz, 'projects'),
    SESSOES_WPP_LOG: path.join(raiz, 'porteiro.log'),
  };
  for (const d of [env.SESSOES_WPP_DIR, env.CLAUDE_SESSIONS_DIR, env.CLAUDE_PROJECTS_DIR]) fs.mkdirSync(d, { recursive: true });
  const repos = path.join(raiz, 'repos');
  fs.mkdirSync(path.join(repos, 'sessoes-wpp'), { recursive: true });
  const h = { raiz, env, t: T0, idle: 0, entregas: [], nReg: 0, nUpd: 100, nMid: 7000, repos, lista: { arquivadas: new Set(), grupos: new Map() } };
  const wpp = {
    async lerGrupo() { return []; },
    async enviarGrupo() { return { ok: true, providerMsgId: 'P1', messageId: 'U1' }; },
    async reagir() { return { ok: true }; },
    async editarGrupo() { return { ok: true }; },
  };
  const mensageiro = { async entregar(p) { h.entregas.push(p); return { status: 'enviado', detalhe: '' }; } };
  h.tg = dubleTg(h);
  const opcoes = {
    wpp, numeroDono: NUMERO_DONO, mensageiro, ocioso: async () => h.idle, agora: () => h.t, env, abrirCentral: () => {}, rand: randFixo(),
    dormir: async (ms) => { h.t += ms; }, raizesSessao: [repos],
    tg: h.tg, identTg: { chatId: DONO, botId: BOT }, central: CENTRAL_TESTE,
    abrirSessaoEscondida: async () => {},
    lerListaVsCode: () => h.lista,
  };
  if (foco) opcoes.focoPainel = foco;
  h.cru = criarPorteiro(opcoes);
  h.p = {
    ...h.cru,
    passoEventos: async () => { await h.cru.passoEventos(); await bombear(h.cru); },
  };
  h.t += 1000;
  h.tg.usuarioBot = BOT_NOME;
  mexer(h, (e) => { e.tg.offset = 0; });
  return h;
}

const projeto = (raiz) => raiz.replace(/[^A-Za-z0-9]/g, '-');
function conversa(h, raiz, sid, { titulo = null, entrypoint = 'claude-vscode', minAtras = 60, cwd = raiz } = {}) {
  const dir = path.join(h.env.CLAUDE_PROJECTS_DIR, projeto(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const linhas = [];
  if (titulo) linhas.push({ type: 'custom-title', customTitle: titulo, sessionId: sid });
  linhas.push({ type: 'user', sessionId: sid, entrypoint, cwd, timestamp: iso(h.t - minAtras * MIN), message: { role: 'user', content: 'oi' } });
  const arq = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(arq, linhas.map((x) => `${JSON.stringify(x)}\n`).join(''));
  const quando = new Date(h.t - minAtras * MIN);
  fs.utimesSync(arq, quando, quando);
}
function aberta(h, raiz, sid, { titulo, minAtras = 60, status = 'idle', cwd = raiz, entrypoint = 'claude-vscode' }) {
  conversa(h, raiz, sid, { titulo, minAtras, cwd, entrypoint });
  h.nReg += 1;
  const quando = h.t - minAtras * MIN;
  const reg = { pid: process.pid, sessionId: sid, cwd, entrypoint, name: titulo, nameSource: 'user', status, statusUpdatedAt: quando, updatedAt: quando, startedAt: quando };
  fs.writeFileSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${100000 + h.nReg}.json`), JSON.stringify(reg));
}
function pedidoOk(h, { codigo, sessionId, criado = h.t - MIN }) {
  const dir = path.join(h.env.SESSOES_WPP_DIR, 'oks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${codigo}.json`), JSON.stringify({
    v: 1, codigo, sessionId, tipo: 'crm', acao: 'x', hashAcao: 'h', destinatarios: null,
    criadoEm: iso(criado), expiraEm: iso(criado + 30 * MIN), providerMsgId: 'P1', messageId: 'uuid-a', status: 'pendente',
  }));
}
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
const painel = (h) => estado(h).tg.painel?.dados ?? null;
function msgTg(h, texto) {
  h.nUpd += 1;
  h.nMid += 1;
  return {
    update_id: h.nUpd,
    message: {
      message_id: h.nMid, date: Math.floor(h.t / 1000), text: texto,
      chat: { id: DONO, type: 'private', first_name: 'Davi' }, from: { id: DONO, is_bot: false, first_name: 'Davi' },
    },
  };
}
async function falarTg(h, texto) {
  const u = msgTg(h, texto);
  h.tg.lotes.push([u]);
  await h.p.esperarTelegram(15000);
  await bombear(h.cru);
  return u;
}
const enviados = (h) => h.tg.de('enviar').map((c) => c.args[0]);
// 1 volta do Telegram sem fala nova: sai o que ficou na fila (a frase do controle)
async function vez(h) {
  h.tg.lotes.push([]);
  await h.p.esperarTelegram(15000);
  await bombear(h.cru);
}
const sids = (v) => (v ?? []).map((x) => x.sid);
const evento = (h, ev) => lib.anexarEvento(h.env.SESSOES_WPP_DIR, ev);
const painelEv = (h, acao, sessoes, o = {}) => evento(h, {
  v: 1, tipo: 'painel', at: iso(h.t), acao, sessoes, providerMsgId: 'tg-u1', por: SC, ...o,
});

// A cena: a central; o grupo Prioridade (Mac dia 1 aberta, Imersão fechada), o Ativos (Douglas aberta, Site fechada,
// Pede OK fechada com pedido de OK) e uma fechada sem grupo de antes do desde (Velha). O desde = 30 min atras.
function cena(h) {
  const { repos } = h;
  aberta(h, repos, SC, { titulo: CENTRAL_TESTE.nome, minAtras: 1, cwd: CENTRAL_TESTE.pasta, entrypoint: 'cli' });
  aberta(h, repos, U(1), { titulo: 'Mac dia 1', minAtras: 120 });
  conversa(h, repos, U(2), { titulo: 'Imersão', minAtras: 90 });
  aberta(h, repos, U(3), { titulo: 'Douglas', minAtras: 60 });
  conversa(h, repos, U(4), { titulo: 'Site', minAtras: 3 * 24 * 60 });
  conversa(h, repos, U(5), { titulo: 'Pede OK', minAtras: 50 });
  conversa(h, repos, U(6), { titulo: 'Velha', minAtras: 45 });
  h.lista = {
    arquivadas: new Set(),
    grupos: new Map([[raizNormal(repos), [
      { nome: '❗Prioridade', ids: [U(1), U(2)] },
      { nome: '🟢 Ativos', ids: [U(3), U(4), U(5)] },
    ]]]),
  };
  pedidoOk(h, { codigo: 'ABC234', sessionId: U(5) });
}
const FOCO = () => ({ grupo: 'Prioridade', desdeMs: T0 - 30 * MIN });

// ---------- 1. estado e poda ----------

test('T35 1. estado: escolhasPainel = {} e painelLista vazia no estado velho; poda: chave que nao e UUID, lado torto, hora ilegivel e mais de 30 dias saem; teto de 200 (as mais novas); a lista torta volta vazia', async () => {
  const h = montar();
  mexer(h, (e) => { delete e.escolhasPainel; delete e.painelLista; });
  await h.p.passoEventos();
  assert.deepEqual(estado(h).escolhasPainel, {});
  assert.deepEqual(estado(h).painelLista, { em: null, dentro: [], fora: [] });

  mexer(h, (e) => {
    e.escolhasPainel = {
      [U(1)]: { lado: 'por', em: iso(h.t - MIN) },
      [U(2)]: { lado: 'tirar', em: iso(h.t - 29 * 24 * 60 * MIN) },
      [U(3)]: { lado: 'outro', em: iso(h.t - MIN) },
      [U(4)]: { lado: 'por', em: 'ontem' },
      [U(5)]: { lado: 'por', em: iso(h.t - 31 * 24 * 60 * MIN) },
      'nao-e-uuid': { lado: 'por', em: iso(h.t - MIN) },
    };
    e.painelLista = { em: 'torta', dentro: 'x', fora: [{ sid: U(1), titulo: 'A' }, 7, null] };
  });
  await h.p.passoEventos();
  assert.deepEqual(Object.keys(estado(h).escolhasPainel).sort(), [U(1), U(2)]);
  assert.deepEqual(estado(h).painelLista, { em: null, dentro: [], fora: [{ sid: U(1), titulo: 'A' }] });

  mexer(h, (e) => {
    e.escolhasPainel = {};
    for (let i = 0; i < 205; i += 1) e.escolhasPainel[U(1000 + i)] = { lado: 'por', em: iso(h.t - i * MIN) };
  });
  await h.p.passoEventos();
  const esc = estado(h).escolhasPainel;
  assert.equal(Object.keys(esc).length, 200);
  for (const i of [0, 199]) assert.ok(esc[U(1000 + i)], `U(${1000 + i}) fica`);
  for (const i of [200, 204]) assert.equal(esc[U(1000 + i)], undefined, `U(${1000 + i}) sai`);
});

// ---------- 2. a escolha nos dados do painel ----------

test('T35 2. com o foco: a posta entra no grupo em que a regra a poe, a tirada sai mesmo no grupo do foco, a tirada com pedido de OK fica; a linha do fim conta as postas; a foto de dentro e de fora', async () => {
  const h = montar({ foco: FOCO() });
  const tCena = h.t;
  cena(h);
  await falarTg(h, '/painel');
  let d = painel(h);
  assert.deepEqual(sids(d.paradas), [U(2), U(1)], 'antes: so o foco (sem a central viva)');
  assert.deepEqual(sids(d.esperando), [U(5)], 'o pedido de OK');
  assert.deepEqual(d.foco, { grupo: 'Prioridade', fora: 3 }, 'fora: Douglas, Site e Velha (a central nao conta)');
  assert.equal(d.abertas, 1, 'so o Mac dia 1 (sem a central e o Douglas)');

  mexer(h, (e) => {
    e.escolhasPainel = {
      [U(3)]: { lado: 'por', em: iso(h.t) }, // Douglas (aberta, outro grupo): entra
      [U(4)]: { lado: 'por', em: iso(h.t) }, // Site (fechada ha 3 dias): entra nas Fechadas
      [U(1)]: { lado: 'tirar', em: iso(h.t) }, // Mac dia 1 (do foco): sai
      [U(5)]: { lado: 'tirar', em: iso(h.t) }, // Pede OK: o pedido de OK fica
    };
  });
  await falarTg(h, '/painel');
  d = painel(h);
  assert.deepEqual(sids(d.esperando), [U(5)], 'o pedido de OK fica mesmo tirado');
  assert.deepEqual(sids(d.paradas), [U(3), U(2)], 'Douglas (posto) e Imersão (foco); sem o Mac dia 1');
  assert.deepEqual(d.fechadas.map((x) => [x.sid, x.grupo]), [[U(4), 'Ativos']], 'o Site posto, no grupo dele');
  assert.deepEqual(d.foco, { grupo: 'Prioridade', fora: 2, postas: 2 }, 'fora: Mac dia 1 e Velha');
  assert.equal(d.abertas, 1, 'so o Douglas');
  const html = enviados(h).at(-1).html;
  assert.ok(html.endsWith('<p>O grupo Prioridade do VS Code e mais 2 que você pôs (2 conversas fora do painel).</p>'), html.slice(-200));
  assert.ok(!html.includes('>Mac dia 1<'), html);

  const pl = estado(h).painelLista;
  assert.ok(Number.isFinite(Date.parse(pl.em)));
  assert.deepEqual(pl.dentro.map((x) => [x.sid, x.titulo, x.lugar]), [
    [U(5), 'Pede OK', 'Esperando você'], [U(3), 'Douglas', 'Paradas'], [U(2), 'Imersão', 'Paradas'], [U(4), 'Site', 'Fechadas'],
  ], 'o titulo do pedido de OK de aba fechada vem do transcript');
  assert.deepEqual(pl.fora, [
    { sid: U(1), titulo: 'Mac dia 1', aberta: true, ms: iso(tCena - 120 * MIN) },
    { sid: U(6), titulo: 'Velha', aberta: false, ms: iso(tCena - 45 * MIN) },
  ], 'a aberta primeiro, depois a fechada; sem a central');
  assert.equal(h.entregas.length, 0, 'nada vai pra aba nenhuma');
});

test('T35 2b. sem o foco: a tirada sai (o painel de antes com ela fora) e a linha do fim so com o numero; a posta nao muda nada; sem escolha, sem a linha', async () => {
  const h = montar();
  cena(h);
  await falarTg(h, '/painel');
  assert.equal(Object.hasOwn(painel(h), 'foco'), false);
  assert.deepEqual(estado(h).painelLista.fora, []);
  mexer(h, (e) => {
    e.escolhasPainel = { [U(3)]: { lado: 'tirar', em: iso(h.t) }, [U(6)]: { lado: 'por', em: iso(h.t) } };
  });
  await falarTg(h, '/painel');
  const d = painel(h);
  assert.ok(!sids(d.paradas).includes(U(3)), 'o Douglas saiu');
  assert.ok(sids(d.paradas).includes(U(6)), 'a Velha ja estava');
  assert.deepEqual(d.foco, { grupo: null, fora: 1 });
  assert.ok(enviados(h).at(-1).html.endsWith('<p>1 conversa fora do painel.</p>'), enviados(h).at(-1).html.slice(-120));
  assert.deepEqual(estado(h).painelLista.fora.map((x) => x.sid), [U(3)]);
});

// ---------- 3 e 4. o evento da central ----------

test('T35 3. pela central no Telegram: por, tirar, normal e limpar mudam o e.escolhasPainel; 1 frase em cima da fala dele; a lista remontada na hora; o painel vivo confere de novo', async () => {
  const h = montar({ foco: FOCO() });
  cena(h);
  await falarTg(h, '/painel');
  const u = await falarTg(h, 'põe o Douglas e o Site no painel e tira o Mac dia 1');
  assert.deepEqual(h.entregas.map((p) => p.sessionId), [SC], 'a fala solta vai pra central');
  const id = `tg-u${u.update_id}`;
  h.tg.zerar();
  painelEv(h, 'por', [U(3), U(4), U(77)], { providerMsgId: id });
  const agora = iso(h.t);
  mexer(h, (e) => { e.painelTg.conferidoEm = iso(h.t); }); // o painel vivo acabou de conferir: so confere de novo pela escolha
  await h.p.passoEventos();
  assert.ok(estado(h).painelLista.dentro.some((x) => x.sid === U(3)), 'a lista remontada na hora, antes de qualquer volta do Telegram');
  await vez(h);
  assert.deepEqual(estado(h).escolhasPainel, { [U(3)]: { lado: 'por', em: agora }, [U(4)]: { lado: 'por', em: agora } });
  const frase = enviados(h).find((x) => String(x.html).includes('Pus no painel'));
  assert.ok(frase, JSON.stringify(enviados(h)));
  assert.equal(frase.responderA, u.message.message_id, 'em cima da fala dele');
  assert.ok(frase.html.includes('Pus no painel: Douglas e Site.'), frase.html);
  assert.ok(frase.html.includes('Não achei a aba 00000000.'), frase.html);
  assert.ok(estado(h).painelLista.dentro.some((x) => x.sid === U(3)), 'a lista ja com o Douglas dentro');
  assert.ok(sids(painel(h).paradas).includes(U(3)), 'o painel na tela ja se remontou com o Douglas (o painel vivo conferiu na volta)');
  assert.ok(h.tg.de('editar').length >= 1, 'editou o painel na tela');
  assert.ok(logs(h).some((l) => l.endsWith('painel da central (por): 2 mudaram, 1 linha(s) a mais')), logs(h).join('\n'));

  h.tg.zerar();
  painelEv(h, 'tirar', [U(1), U(5)], { providerMsgId: id, at: iso(h.t + 1) });
  await h.p.passoEventos();
  await vez(h);
  assert.equal(estado(h).escolhasPainel[U(1)].lado, 'tirar');
  let html = enviados(h).map((x) => String(x.html)).find((x) => x.includes('Tirei do painel'));
  assert.ok(html.includes('Tirei do painel: Mac dia 1 e Pede OK.'), html);
  assert.ok(html.includes('Pede OK tem pedido de OK aberto: segue no painel até ele sair.'), html);

  h.tg.zerar();
  painelEv(h, 'normal', [U(3), U(2)], { providerMsgId: id, at: iso(h.t + 2) });
  await h.p.passoEventos();
  await vez(h);
  assert.equal(estado(h).escolhasPainel[U(3)], undefined);
  html = enviados(h).map((x) => String(x.html)).find((x) => x.includes('regra do grupo'));
  assert.ok(html.includes('Voltou pra regra do grupo: Douglas.'), html);
  assert.ok(html.includes('Imersão já seguia a regra do grupo.'), html);

  h.tg.zerar();
  painelEv(h, 'limpar', [], { providerMsgId: id, at: iso(h.t + 3) });
  await h.p.passoEventos();
  await vez(h);
  assert.deepEqual(estado(h).escolhasPainel, {});
  html = enviados(h).map((x) => String(x.html)).find((x) => x.includes('Voltei o painel'));
  assert.ok(html.includes('Voltei o painel pra regra do grupo Prioridade do VS Code: desfiz 3 escolhas.'), html);
  h.tg.zerar();
  painelEv(h, 'limpar', [], { providerMsgId: id, at: iso(h.t + 4) });
  await h.p.passoEventos();
  await vez(h);
  html = enviados(h).map((x) => String(x.html)).find((x) => x.includes('O painel já seguia'));
  assert.ok(html.includes('O painel já seguia só a regra do grupo Prioridade do VS Code.'), html);
  assert.equal(h.entregas.length, 1, 'nada vai pra aba nenhuma');
});

test('T35 4. guardas: so da central viva (outro `por` = so log), travado = so log, sem id, acao torta, sessao torta ou demais, limpar com sessao = so log; a mesma linha 1 vez so', async () => {
  const h = montar({ foco: FOCO() });
  cena(h);
  await falarTg(h, '/painel');
  painelEv(h, 'por', [U(3)], { por: U(50) });
  await h.p.passoEventos();
  assert.deepEqual(estado(h).escolhasPainel, {});
  assert.equal(comLog(h, 'painel ignorado: nao veio da central viva'), 1);
  [
    { providerMsgId: '' }, { acao: 'mudar' }, { sessoes: ['abc'] }, { sessoes: [] },
    { sessoes: Array.from({ length: 21 }, (_, i) => U(i + 1)) }, { acao: 'limpar', sessoes: [U(3)] },
  ].forEach((o, i) => painelEv(h, o.acao ?? 'por', o.sessoes ?? [U(3)], { ...o, at: iso(h.t + 10 + i) }));
  await h.p.passoEventos();
  assert.deepEqual(estado(h).escolhasPainel, {});
  assert.equal(comLog(h, 'painel ignorado: sem id da mensagem, com acao torta ou com sessao invalida'), 6);
  mexer(h, (e) => { e.trava = true; });
  painelEv(h, 'por', [U(3)], { at: iso(h.t + 7) });
  await h.p.passoEventos();
  assert.deepEqual(estado(h).escolhasPainel, {});
  assert.equal(comLog(h, 'painel ignorado: travado'), 1);
  mexer(h, (e) => { e.trava = false; });
  const ev = { v: 1, tipo: 'painel', at: iso(h.t + 8), acao: 'por', sessoes: [U(3)], providerMsgId: 'tg-u1', por: SC };
  evento(h, ev);
  evento(h, ev);
  await h.p.passoEventos();
  assert.equal(comLog(h, 'painel da central (por)'), 1, 'a mesma linha 1 vez so');
});

// ---------- 5. o passo de minuto ----------

test('T35 5. o passo de minuto monta a lista sem painel na tela e remonta so quando ela tem 5 min ou mais', async () => {
  const h = montar({ foco: FOCO() });
  cena(h);
  await h.p.passoMinuto();
  const em = estado(h).painelLista.em;
  assert.equal(em, iso(h.t));
  assert.deepEqual(estado(h).painelLista.dentro.map((x) => x.titulo).sort(), ['Imersão', 'Mac dia 1', 'Pede OK'], 'sem a central');
  h.t += 4 * MIN;
  await h.p.passoMinuto();
  assert.equal(estado(h).painelLista.em, em, 'com menos de 5 min fica');
  h.t += MIN;
  await h.p.passoMinuto();
  assert.equal(estado(h).painelLista.em, iso(h.t), 'com 5 min remonta');
  assert.equal(h.tg.de('enviar').length, 0, 'nada sai pro dono');
});

// ---------- 6 e 7. o CLI ----------

function cli(estadoJson) {
  const raiz = pastaTemp('porteiro-t35-cli-');
  const env = { ...process.env, SESSOES_WPP_DIR: path.join(raiz, 'estado'), SESSOES_WPP_LOG: path.join(raiz, 'p.log'), CLAUDE_CODE_SESSION_ID: SC };
  delete env.SESSOES_WPP_ENSAIO;
  fs.mkdirSync(env.SESSOES_WPP_DIR, { recursive: true });
  if (estadoJson !== undefined) fs.writeFileSync(path.join(env.SESSOES_WPP_DIR, 'estado.json'), estadoJson);
  const rodar = (args) => spawnSync(process.execPath, [PORTEIRO, ...args], { env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  const eventos = () => {
    try {
      return fs.readFileSync(path.join(env.SESSOES_WPP_DIR, 'eventos.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  };
  return { raiz, env, rodar, eventos };
}

test('T35 6. CLI painel: so le; os blocos No painel e Fora do painel (a aberta, a fechada, a hora, sem hora), as escolhas; as palavras filtram pelo titulo; o teto de 60; sem foto = "o painel ainda nao foi montado"', () => {
  const vazio = cli();
  let r = vazio.rodar(['painel']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'o painel ainda nao foi montado');
  assert.equal(fs.existsSync(path.join(vazio.env.SESSOES_WPP_DIR, 'estado.json')), false, 'nao cria estado');

  const agora = Date.now();
  const q = (min) => iso(agora - min * MIN);
  const hora = (v) => (diaBRT(v) === diaBRT(iso(agora)) ? horaBRT(v) : `${diaBRT(v)} ${horaBRT(v)}`);
  const est = {
    painelLista: {
      em: q(2),
      dentro: [{ sid: U(1), titulo: 'Mac dia 1', lugar: 'Paradas' }, { sid: U(2), titulo: 'Fred', lugar: 'Esperando você' }],
      fora: [
        { sid: U(3), titulo: 'Consultoria Douglas', aberta: true, ms: q(30) },
        { sid: U(4), titulo: 'Site\nnovo', aberta: false, ms: q(60 * 30) },
        { sid: U(5), titulo: 'Sem hora', aberta: false, ms: null },
        { sid: 'nao-e-uuid', titulo: 'Torta', aberta: false, ms: null },
      ],
    },
    escolhasPainel: { [U(2)]: { lado: 'por', em: q(5) }, [U(3)]: { lado: 'tirar', em: q(5) } },
  };
  const c = cli(JSON.stringify(est));
  r = c.rodar(['painel']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), [
    `Painel de ${hora(q(2))}.`,
    'No painel (2):',
    `- Mac dia 1 (sessionId ${U(1)}, Paradas)`,
    `- Fred (sessionId ${U(2)}, Esperando você)`,
    'Fora do painel (3):',
    `- Consultoria Douglas (sessionId ${U(3)}, aberta, mexeu às ${hora(q(30))})`,
    `- Site novo (sessionId ${U(4)}, fechada, mexeu às ${hora(q(60 * 30))})`,
    `- Sem hora (sessionId ${U(5)}, fechada, sem hora)`,
    `Postas pela central: Fred (sessionId ${U(2)})`,
    `Tiradas pela central: Consultoria Douglas (sessionId ${U(3)})`,
  ].join('\n'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(c.env.SESSOES_WPP_DIR, 'estado.json'), 'utf8')), est, 'so le');
  r = c.rodar(['painel', 'CONSULTÓRIA']);
  assert.ok(r.stdout.includes('(só os títulos com "consultoria")'), r.stdout);
  assert.ok(r.stdout.includes('No painel (0):') && r.stdout.includes('Fora do painel (1):'), r.stdout);
  assert.ok(r.stdout.includes('- Consultoria Douglas') && !r.stdout.includes('- Site'), r.stdout);

  const muitos = { painelLista: { em: q(1), dentro: [], fora: Array.from({ length: 65 }, (_, i) => ({ sid: U(100 + i), titulo: `Aba ${i}`, aberta: false, ms: q(i) })) } };
  r = cli(JSON.stringify(muitos)).rodar(['painel']);
  const linhas = r.stdout.trim().split('\n');
  assert.equal(linhas.filter((l) => l.startsWith('- Aba ')).length, 60);
  assert.equal(linhas.at(-1), '... e mais 5 (peça pelo nome)');
  r = cli('{ quebrado').rodar(['painel']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'o painel ainda nao foi montado');
});

test('T35 7. CLI painel --por|--tirar|--normal|--limpar: grava 1 evento {v, tipo, at, acao, sessoes, providerMsgId, por}; ids por virgula sem repetir; mais de 1 acao, sem id, id torto, mais de 20 ou sem --msg = exit 1 com {ok:false} e nada gravado; o uso lista os comandos', () => {
  const c = cli();
  let r = c.rodar(['painel', '--por', `${U(1)}, ${U(2)},${U(1)}`, '--msg', 'tg-u123']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { ok: true });
  for (const a of ['tirar', 'normal']) assert.equal(c.rodar(['painel', `--${a}`, U(3), '--msg', 'PROV9']).status, 0, a);
  assert.equal(c.rodar(['painel', '--limpar', '--msg', 'tg-u5']).status, 0);
  let evs = c.eventos();
  assert.deepEqual(evs.map((x) => [x.v, x.tipo, x.acao, x.sessoes, x.providerMsgId, x.por]), [
    [1, 'painel', 'por', [U(1), U(2)], 'tg-u123', SC],
    [1, 'painel', 'tirar', [U(3)], 'PROV9', SC],
    [1, 'painel', 'normal', [U(3)], 'PROV9', SC],
    [1, 'painel', 'limpar', [], 'tg-u5', SC],
  ]);
  for (const x of evs) assert.ok(Number.isFinite(Date.parse(x.at)));
  for (const args of [
    ['painel', '--por', U(1), '--tirar', U(2), '--msg', 'tg-u1'],
    ['painel', '--por', '--msg', 'tg-u1'],
    ['painel', '--por', 'abc', '--msg', 'tg-u1'],
    ['painel', '--tirar', `${U(1)},abc`, '--msg', 'tg-u1'],
    ['painel', '--por', Array.from({ length: 21 }, (_, i) => U(i + 1)).join(','), '--msg', 'tg-u1'],
    ['painel', '--por', U(1)],
    ['painel', '--limpar'],
  ]) {
    r = c.rodar(args);
    assert.equal(r.status, 1, JSON.stringify(args));
    assert.equal(JSON.parse(r.stdout).ok, false, JSON.stringify(args));
  }
  evs = c.eventos();
  assert.equal(evs.length, 4, 'nada gravado nas recusadas');
  r = c.rodar([]);
  assert.match(r.stdout, /node porteiro\.mjs painel \[palavras do titulo\]/);
  assert.match(r.stdout, /painel --por\|--tirar\|--normal "<sessionId>\[,<sessionId>\.\.\.\]" --msg <id da mensagem do dono>/);
  assert.match(r.stdout, /painel --limpar --msg <id da mensagem do dono>/);
});

// ---------- 8. a linha do fim e as instrucoes ----------

test('T35 8. a linha do fim com as postas e sem o foco; o item 19 das instrucoes da central (listar, por, tirar, normal, limpar; quem muda e o porteiro)', () => {
  const { linhaDoFoco } = formatoTg;
  assert.equal(linhaDoFoco({ grupo: 'Prioridade', fora: 12, postas: 2 }), 'O grupo Prioridade do VS Code e mais 2 que você pôs (12 conversas fora do painel).');
  assert.equal(linhaDoFoco({ grupo: 'Prioridade', fora: 0, postas: 1 }), 'O grupo Prioridade do VS Code e mais 1 que você pôs.');
  assert.equal(linhaDoFoco({ grupo: 'Prioridade', fora: 3, postas: 0 }), 'Só o grupo Prioridade do VS Code (3 conversas fora do painel).');
  assert.equal(linhaDoFoco({ grupo: null, fora: 2 }), '2 conversas fora do painel.');
  assert.equal(linhaDoFoco({ grupo: null, fora: 1 }), '1 conversa fora do painel.');
  assert.equal(linhaDoFoco({ grupo: null, fora: 0 }), null);

  const instr = fs.readFileSync(path.join(path.dirname(PORTEIRO), 'central', 'instrucoes.md'), 'utf8');
  const item = /^19\. [\s\S]*$/m.exec(instr);
  assert.ok(item, 'item 19 no fim');
  const corrido = item[0].replace(/\s+/g, ' ');
  for (const t of [
    '`node "{{repo}}/porteiro.mjs" painel [palavras do título]`',
    '`node "{{repo}}/porteiro.mjs" painel --por "<sessionId>[,<sessionId>...]" --msg <id da mensagem do dono>`',
    '`--tirar`', '`--normal`',
    '`node "{{repo}}/porteiro.mjs" painel --limpar --msg <id da mensagem do dono>`',
    'pergunte qual', '"pedi pro porteiro pôr X no painel"', 'Quem muda e confirma é o porteiro',
    'Pedido de OK aberto fica no painel sempre', 'a 1ª frase diz quantas estão fora',
  ]) assert.ok(corrido.includes(t), t);
  assert.ok(!/abas\.mjs|config\.json/.test(corrido), 'quem muda e o porteiro, pelo estado');
});
