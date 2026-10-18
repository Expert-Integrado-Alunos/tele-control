// Testes da T21a (PLANO-TELEGRAM.md, "T21 — o controle completo numa conversa do Orca", contratos 1, 2 e 4; pedido do dono:
// "Mas não dá pra arrumar as coisas que não tem ainda?"). O Orca abre o terminal na pasta do projeto (uma SUBPASTA
// da raiz), e a conversa `cli` dali mora na pasta de projeto dela, nao na da raiz.
// - T21 1 (contrato 1): a fechada `cli` de subpasta entra no painel: mexida nas ultimas 48 h = Paradas marcada; mais
//   velha = Fechadas, "Sem grupo".
// - T21 2 (contrato 1): o que continua fora: `claude-vscode` de subpasta, `cli` com o cwd fora das raizes, a central e a
//   viva (aberta = Paradas sem a marca, nunca como fechada).
// - T21 3 (contrato 2): o `parou` com `app: 'orca'` grava e.origens; sem `app` ou outro valor = nada; poda de 30 dias, chave
//   que nao e UUID e teto de 200; estado velho sem a chave = {}.
// - T21 4 (contrato 4): modo rua ligado + parou de conversa `cli` com `app: 'orca'` que precisa do dono = o chamado sai
//   pelo Telegram como o de qualquer aba.
// Isolamento: pastas temporarias via SESSOES_WPP_DIR, CLAUDE_SESSIONS_DIR, CLAUDE_PROJECTS_DIR e SESSOES_WPP_LOG (nunca o
// ~/.claude real); raizes de mentira (repos e Workspace) dentro da pasta temporaria. Nenhuma rede: `tg`, `wpp`,
// mensageiro, abridor da sessao escondida e a lista do VS Code sao dubles. Harness copiado do tests/porteiro-t11.test.mjs.
// Rodar: node --test --test-reporter=tap "tests/porteiro-t21.test.mjs"
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
const DIA = 24 * 60 * MIN;
const T0 = Date.parse('2026-10-14T16:00:00Z'); // 13:00 em Brasilia
const iso = (ms) => new Date(ms).toISOString();
const DONO = 700100200;
const BOT = 700900800;
const BOT_NOME = 'Teste_ControleBot';
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FINAL = [
  'Terminei a revisão.',
  '',
  '---',
  '🔴 **DECISÃO:** Publico? A) Sim, tudo hoje (recomendado) / B) Só as correções',
].join('\n');
const DECISAO = { decisao: true, fica: false, pergunta: false };

// ---------- harness (copia enxuta do tests/porteiro-t11.test.mjs) ----------

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
  return tg;
}

// Porteiro com o Telegram, o abridor escondido de mentira e a lista do VS Code de mentira (`h.lista`).
function montarT21({ canalPrincipal } = {}) {
  const raiz = pastaTemp('porteiro-t21-');
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
    raiz, env, t: T0, idle: 0, entregas: [], enviados: [], nReg: 0, nUpd: 100, nMid: 7000, repos, workspace,
    escondidas: [], lista: { arquivadas: new Set(), grupos: new Map() },
  };
  const wpp = {
    async lerGrupo() { return []; },
    async enviarGrupo(texto) { h.enviados.push(texto); return { ok: true, providerMsgId: 'P1', messageId: 'U1' }; },
    async reagir() { return { ok: true }; },
    async editarGrupo() { return { ok: true }; },
  };
  const mensageiro = { async entregar(p) { h.entregas.push(p); return { status: 'enviado', detalhe: '' }; } };
  h.tg = dubleTg(h);
  const opcoes = {
    wpp, numeroDono: NUMERO_DONO, mensageiro, ocioso: async () => h.idle, agora: () => h.t, env, abrirCentral: () => {}, rand: randFixo(),
    dormir: async (ms) => { h.t += ms; }, raizesSessao: [repos, workspace], ensaio: false,
    tg: h.tg, identTg: { chatId: DONO, botId: BOT }, central: CENTRAL_TESTE, // A3a: a central como o dono configura
    abrirSessaoEscondida: async (pasta, nome, retomada) => { h.escondidas.push([pasta, nome, retomada ?? null]); },
    lerListaVsCode: () => h.lista,
  };
  if (canalPrincipal) opcoes.canalPrincipal = canalPrincipal;
  h.p = criarPorteiro(opcoes);
  h.t += 1000;
  mexer(h, (e) => { e.tg.offset = 0; });
  return h;
}

const projeto = (pasta) => pasta.replace(/[^A-Za-z0-9]/g, '-'); // a pasta de projeto do Claude Code (c:\projetos -> c--projetos)
// A conversa na pasta de projeto do cwd (o jeito do Orca: o terminal abre na pasta do projeto): o titulo e a 1a mensagem
// (entrypoint e cwd, como o Claude Code grava); a hora do arquivo = `minAtras` minutos antes de agora.
function conversa(h, cwd, sid, { titulo = null, entrypoint = 'cli', minAtras = 60, pasta = projeto(cwd) } = {}) {
  const dir = path.join(h.env.CLAUDE_PROJECTS_DIR, pasta);
  fs.mkdirSync(dir, { recursive: true });
  const linhas = [];
  if (titulo) linhas.push({ type: 'custom-title', customTitle: titulo, sessionId: sid });
  linhas.push({ type: 'user', sessionId: sid, entrypoint, cwd, timestamp: iso(h.t - minAtras * MIN), message: { role: 'user', content: 'oi' } });
  const arq = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(arq, linhas.map((x) => `${JSON.stringify(x)}\n`).join(''));
  const quando = new Date(h.t - minAtras * MIN);
  fs.utimesSync(arq, quando, quando);
  return arq;
}
function sessao(h, { sessionId, cwd, entrypoint = 'cli', status = 'idle' }) {
  h.nReg += 1;
  const reg = { pid: process.pid, sessionId, cwd, entrypoint, name: `orca-${h.nReg}`, nameSource: 'derived', status, updatedAt: h.t };
  fs.writeFileSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${100000 + h.nReg}.json`), JSON.stringify(reg));
}
const estado = (h) => JSON.parse(fs.readFileSync(path.join(h.env.SESSOES_WPP_DIR, 'estado.json'), 'utf8'));
function mexer(h, fn) {
  const arq = path.join(h.env.SESSOES_WPP_DIR, 'estado.json');
  const e = JSON.parse(fs.readFileSync(arq, 'utf8'));
  fn(e);
  fs.writeFileSync(arq, JSON.stringify(e));
}
const painel = (h) => estado(h).tg.painel?.dados ?? null;
async function falarTg(h, texto) {
  h.nUpd += 1;
  h.nMid += 1;
  h.tg.lotes.push([{
    update_id: h.nUpd,
    message: {
      message_id: h.nMid, date: Math.floor(h.t / 1000),
      chat: { id: DONO, type: 'private', first_name: 'Davi' }, from: { id: DONO, is_bot: false, first_name: 'Davi' }, text: texto,
    },
  }]);
  await h.p.esperarTelegram(15000);
  await bombear(h.p);
}
function parou(h, sessionId, o = {}) {
  const ev = {
    v: 1, tipo: 'parou', at: iso(h.t), sessionId, pid: process.pid, nome: o.nome ?? 'orca-1', titulo: o.titulo ?? null,
    cwd: o.cwd ?? path.join(h.repos, 'sessoes-wpp'), entrypoint: o.entrypoint ?? 'cli', final: o.final ?? 'Feito.',
    finalTs: o.finalTs ?? iso(h.t), marcas: o.marcas ?? { decisao: false, fica: false, pergunta: false },
  };
  if (o.app !== undefined) ev.app = o.app;
  return ev;
}
const evento = (h, ev) => lib.anexarEvento(h.env.SESSOES_WPP_DIR, ev);
const daParadas = (d) => (d.paradas ?? []).map((x) => [x.titulo, x.sid, x.fechada === true]);
const daFechadas = (d) => (d.fechadas ?? []).map((x) => [x.titulo, x.sid, x.grupo]);

// ---------- 1 e 2. Fechadas de subpasta (contrato 1) ----------

test('T21 1. fechada `cli` com o cwd numa SUBPASTA da raiz (pasta de projeto propria) entra: < 48 h = Paradas marcada; > 48 h = Fechadas sem grupo (as 2 raizes)', async () => {
  const h = montarT21();
  const sub = path.join(h.repos, 'sessoes-wpp');
  const subW = path.join(h.workspace, 'Aulas');
  conversa(h, sub, U(1), { titulo: 'Teste Orca', minAtras: 30 });
  conversa(h, sub, U(2), { titulo: 'Orca velha', minAtras: 49 * 60 });
  conversa(h, subW, U(3), { minAtras: 50 * 60 }); // sem titulo, outra raiz
  fs.mkdirSync(path.join(h.env.CLAUDE_PROJECTS_DIR, projeto(sub), U(60), 'subagents'), { recursive: true }); // pasta de subagente
  fs.writeFileSync(path.join(h.env.CLAUDE_PROJECTS_DIR, projeto(sub), 'agent-abc.jsonl'), '{"type":"user","entrypoint":"cli"}\n');
  await falarTg(h, '/painel');
  const d = painel(h);
  assert.ok(d, 'sem painel');
  assert.deepEqual(daParadas(d), [['Teste Orca', U(1), true]]);
  assert.deepEqual(daFechadas(d), [['Orca velha', U(2), null], ['sem nome', U(3), null]]);
  assert.equal(Object.hasOwn(d, 'listaErro'), false);
  assert.equal(h.entregas.length, 0, 'nada vai pra aba nenhuma');
});

test('T21 2. fora: `claude-vscode` de subpasta, `cli` com o cwd fora das raizes, `cli` de subpasta com o titulo da central, `cli` de subpasta viva (so como aberta), pasta de projeto que nao comeca pelo nome da raiz e a vizinha de nome parecido (repos-velho)', async () => {
  const h = montarT21();
  const sub = path.join(h.repos, 'sessoes-wpp');
  const fora = path.join(h.raiz, 'outro-lugar', 'projeto');
  fs.mkdirSync(fora, { recursive: true });
  conversa(h, sub, U(11), { titulo: 'Entra', minAtras: 10 }); // controle: a de subpasta que entra
  conversa(h, sub, U(51), { titulo: 'VS Code em subpasta', entrypoint: 'claude-vscode', minAtras: 11 });
  conversa(h, sub, U(56), { titulo: 'VS Code velha', entrypoint: 'claude-vscode', minAtras: 60 * 60 });
  conversa(h, fora, U(52), { titulo: 'Fora das raizes', minAtras: 12 });
  conversa(h, fora, U(57), { titulo: 'Fora velha', minAtras: 60 * 60 });
  conversa(h, sub, U(53), { titulo: 'Central de sessões de teste', minAtras: 13 });
  conversa(h, sub, U(54), { titulo: 'Viva no Orca', minAtras: 14 });
  sessao(h, { sessionId: U(54), cwd: sub });
  // custo: pasta de projeto cujo nome nao comeca pelo da raiz + "-" nem e lida (o Claude Code sempre nomeia pela pasta)
  conversa(h, sub, U(58), { titulo: 'Pasta com outro nome', minAtras: 15, pasta: 'outra-pasta' });
  // vizinha de nome parecido: a pasta de projeto comeca pelo nome da raiz + "-" (C:\projetos-velho -> c--projetos-velho) e
  // passa no filtro do nome, mas o cwd fica fora da raiz; quem segura e o raizDaPasta (sabotagem 6 da t21.mjs)
  const vizinha = path.join(h.raiz, 'repos-velho', 'projeto');
  fs.mkdirSync(vizinha, { recursive: true });
  conversa(h, vizinha, U(59), { titulo: 'Vizinha da raiz', minAtras: 16 });
  await falarTg(h, '/painel');
  const d = painel(h);
  assert.ok(d, 'sem painel');
  const fechadasNasParadas = daParadas(d).filter((x) => x[2]).map((x) => x[1]);
  assert.deepEqual(fechadasNasParadas, [U(11)], 'so a de controle entra como fechada');
  assert.deepEqual(daFechadas(d), [], 'nada velho entra nas Fechadas');
  const viva = (d.paradas ?? []).filter((x) => x.sid === U(54));
  assert.equal(viva.length, 1, 'a viva aparece 1 vez, como aberta');
  assert.equal(viva[0].fechada === true, false, 'a viva nunca e marcada fechada');
  const todos = JSON.stringify(d);
  for (const n of [51, 52, 53, 56, 57, 58, 59]) assert.equal(todos.includes(U(n)), false, `U(${n}) fora do painel`);
});

// ---------- 3. a origem (contrato 2) ----------

test('T21 3. parou com app "orca" grava e.origens {app, em}; sem app ou app "x" = nada; poda: 31 dias sai, chave que nao e UUID sai, teto 200 (as mais novas); estado velho sem a chave = {}', async () => {
  const h = montarT21();
  mexer(h, (e) => { delete e.origens; });
  await h.p.passoEventos();
  assert.deepEqual(estado(h).origens, {}, 'estado velho sem a chave = {}');

  mexer(h, (e) => {
    e.origens = {
      [U(80)]: { app: 'orca', em: iso(h.t - 31 * DIA) },
      'nao-e-uuid': { app: 'orca', em: iso(h.t) },
      [U(81)]: { app: 'orca', em: iso(h.t - 29 * DIA) },
      [U(82)]: { app: 'x', em: iso(h.t) },
      [U(83)]: { app: 'orca', em: 'ontem' },
    };
  });
  const agora = h.t;
  evento(h, parou(h, U(1), { app: 'orca' }));
  evento(h, parou(h, U(2)));
  evento(h, parou(h, U(3), { app: 'x' }));
  await h.p.passoEventos();
  await bombear(h.p);
  const o = estado(h).origens;
  assert.deepEqual(Object.keys(o).sort(), [U(1), U(81)]);
  assert.deepEqual(o[U(1)], { app: 'orca', em: iso(agora) });
  assert.deepEqual(o[U(81)], { app: 'orca', em: iso(agora - 29 * DIA) });
  // ultimosParou segue gravando os 3 (nada mudou ali)
  for (const n of [1, 2, 3]) assert.ok(estado(h).ultimosParou[U(n)], `ultimosParou U(${n})`);

  // teto de 200: as mais novas ficam
  mexer(h, (e) => {
    e.origens = {};
    for (let i = 0; i < 205; i += 1) e.origens[U(1000 + i)] = { app: 'orca', em: iso(h.t - i * MIN) };
  });
  evento(h, parou(h, U(4)));
  await h.p.passoEventos();
  const o2 = estado(h).origens;
  assert.equal(Object.keys(o2).length, 200);
  assert.ok(o2[U(1000)] && o2[U(1199)], 'as 200 mais novas');
  assert.equal(Object.hasOwn(o2, U(1200)), false, 'a mais velha sai');
});

// ---------- 4. o aviso na rua (contrato 4) ----------

test('T21 4. modo rua ligado + parou de conversa `cli` com app "orca" que precisa do dono = o chamado sai pelo Telegram como o de qualquer aba (nada no grupo)', async () => {
  const h = montarT21({ canalPrincipal: 'telegram' });
  const sub = path.join(h.repos, 'sessoes-wpp');
  sessao(h, { sessionId: U(7), cwd: sub });
  conversa(h, sub, U(7), { titulo: 'Teste Orca', minAtras: 1 });
  h.idle = 30 * MIN;
  await h.p.passoMinuto();
  assert.equal(estado(h).modoRua.ligado, true);
  evento(h, parou(h, U(7), { titulo: 'Teste Orca', final: FINAL, marcas: DECISAO, app: 'orca', nome: 'orca-1' }));
  await h.p.passoEventos();
  await bombear(h.p);
  assert.equal(estado(h).origens[U(7)].app, 'orca');
  assert.equal(estado(h).parouGuardado[U(7)].noTelegram, true);
  await h.p.esperarTelegram(15000);
  const envios = h.tg.de('enviar').map((c) => c.args[0]);
  const aviso = envios.find((x) => String(x.html).includes('Teste Orca'));
  assert.ok(aviso, `o chamado saiu: ${JSON.stringify(envios.map((x) => x.html))}`);
  assert.equal(aviso.html, '<h2>ℹ️ Teste Orca</h2><p>Terminei a revisão.</p><p><b>Publico?</b></p>');
  assert.equal(aviso.botoes.length, 3, 'A, B e Mais informações');
  assert.deepEqual(h.enviados, [], 'nada no grupo');
});
