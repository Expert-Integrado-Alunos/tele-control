// Testes da T38 no porteiro (PLANO-TELEGRAM.md, "T38"; pedido do dono, 07/11/2026: no painel do Telegram um botao que
// troca entre o "modo VS Code" (espelho dos grupos da lista de sessoes do VS Code) e o "modo padrao", e "fechado nao bate
// com fechado de verdade"). Este arquivo cobre os dados que o porteiro monta (D2a); os botoes e o Sincronizar sao do D2b.
// - T38 1: o espelho por janela (ordem, nome com icone, total, grupo vazio, id sem transcript, arquivadas, Concluido no
//   lugar dele, Sem grupo com `cli` e Desktop, id em 2 grupos, a mais recente primeiro).
// - T38 2: a central fora (viva e fechada `cli`) e o "Fora da lista do VS Code" (pedido de OK e viva de outra pasta).
// - T38 3: as marcas (esperando, trabalhando, fechada; aba aberta; abas ilegiveis; Aguardando).
// - T38 4: o modo padrao com a marca "fechada" nova (Esperando e Paradas) e o pendencias do grupo como antes.
// - T38 5: o espelho ignora foco, escolhas e tocadas, nao grava o painelLista; lista ilegivel = o padrao com o erro.
// - T38 6: o teto por grupo (40 mais recentes + as com marca que nao e so "fechada").
// D2b (os botoes, a situacao e o rodar):
// - T38 7: [Modo VS Code] grava painel.modo (foco e desde ficam) e edita o painel pro espelho; [Modo padrão] volta.
// - T38 8: config que nao grava = o balao do ajusteNaoGravou e nada muda; o modo atual = "ja esta" e remonta.
// - T38 9: [Sincronizar] (sem painel = novo; dentro dos 30 s edita com a lista e as abas relidas; lista ilegivel = erro).
// - T38 10: o painel vivo e a busca no espelho.
// - T38 13 (principal): o cache de 60 s das abas, o toque no nome e a busca sem painel no espelho.
// - T38 11: a situacao "Parada, com a aba aberta no VS Code." (com e sem reabrir) e a reabertura escondida.
// - T38 12: o lerAbasVsCodeReal e o que o rodar passa (modoPainel, lerAbasVsCode) e loga.
// Isolamento: pastas temporarias via SESSOES_WPP_DIR, CLAUDE_SESSIONS_DIR, CLAUDE_PROJECTS_DIR e SESSOES_WPP_LOG (nunca o
// ~/.claude real nem o banco do VS Code de verdade); raizes de mentira dentro da pasta temporaria. Nenhuma rede nem
// processo: `tg`, `wpp`, mensageiro, a lista do VS Code e as abas abertas sao dubles. Harness copiado (enxuto) do
// tests/porteiro-t33.test.mjs.
// Rodar: node --test --test-reporter=tap "tests/porteiro-t38.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pastaTemp } from './lib/pasta-temp.cjs';
import * as porteiroMod from '../porteiro.mjs';
import { raizNormal } from '../lib/lista-vscode.mjs';
import { NUMERO_DONO } from './lib/dados-whatsapp.mjs';
import { CENTRAL_TESTE } from './lib/dados-central.mjs';

const { criarPorteiro } = porteiroMod;
const MIN = 60 * 1000;
const T0 = Date.parse('2026-11-07T18:00:00Z'); // 15:00 em Brasilia
const iso = (ms) => new Date(ms).toISOString();
const DONO = 700100200;
const BOT = 700900800;
const BOT_NOME = 'Teste_ControleBot';
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

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

// Porteiro com o Telegram, o grupo do WhatsApp, a lista do VS Code (`h.lista`; null = ilegivel) e as abas abertas
// (`h.abas`: Map raizNormal -> Set | null = ilegiveis) de mentira. `modoPainel` = o do criarPorteiro; `foco` = o focoPainel.
function montar({ modoPainel = 'vscode', foco = null, workspaceAntes = false } = {}) {
  const raiz = pastaTemp('porteiro-t38-');
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
    raiz, env, t: T0, idle: 0, entregas: [], grupo: [], enviados: [], nReg: 0, nUpd: 100, nMid: 7000, nMsg: 0, repos, workspace,
    lista: { arquivadas: new Set(), grupos: new Map() }, abas: null, escondidas: [], mortas: new Set(),
  };
  let seq = 0;
  const wpp = {
    async lerGrupo(limit) { return h.grupo.slice(-limit); },
    async enviarGrupo(texto, opts) {
      h.enviados.push({ texto, opts });
      seq += 1;
      return { ok: true, providerMsgId: `P${seq}`, messageId: `U${seq}` };
    },
    async reagir() { return { ok: true }; },
    async editarGrupo() { return { ok: true }; },
  };
  // D2b: a aba em h.mortas = o mensageiro nao acha (a T8 reabre escondida, como no tests/porteiro-t11.test.mjs)
  const mensageiro = {
    async entregar(p) {
      h.entregas.push(p);
      return h.mortas.has(p.sessionId) ? { status: 'nao_achei', detalhe: '' } : { status: 'enviado', detalhe: '' };
    },
  };
  h.tg = dubleTg(h);
  const opcoes = {
    wpp, numeroDono: NUMERO_DONO, mensageiro, ocioso: async () => h.idle, agora: () => h.t, env, abrirCentral: () => {}, rand: randFixo(),
    dormir: async (ms) => { h.t += ms; }, raizesSessao: workspaceAntes ? [workspace, repos] : [repos, workspace], // T40: a ordem das pastas do config
    tg: h.tg, identTg: { chatId: DONO, botId: BOT }, central: CENTRAL_TESTE,
    abrirSessaoEscondida: async (pasta, nome, retomada) => { h.escondidas.push([pasta, nome, retomada ?? null]); },
    lerListaVsCode: () => h.lista,
    lerAbasVsCode: () => h.abas,
    modoPainel,
  };
  if (foco) opcoes.focoPainel = foco;
  h.p = criarPorteiro(opcoes);
  h.t += 1000;
  h.tg.usuarioBot = BOT_NOME;
  mexer(h, (e) => { e.tg.offset = 0; });
  return h;
}

const projeto = (raiz) => raiz.replace(/[^A-Za-z0-9]/g, '-');
// A conversa na pasta de projeto da raiz (hora do arquivo = `minAtras` minutos antes de agora)
function conversa(h, raiz, sid, { titulo = null, entrypoint = 'claude-vscode', minAtras = 60, pasta = projeto(raiz) } = {}) {
  const dir = path.join(h.env.CLAUDE_PROJECTS_DIR, pasta);
  fs.mkdirSync(dir, { recursive: true });
  const linhas = [];
  if (titulo) linhas.push({ type: 'custom-title', customTitle: titulo, sessionId: sid });
  linhas.push({ type: 'user', sessionId: sid, entrypoint, cwd: raiz, timestamp: iso(h.t - minAtras * MIN), message: { role: 'user', content: 'oi' } });
  const arq = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(arq, linhas.map((x) => `${JSON.stringify(x)}\n`).join(''));
  const quando = new Date(h.t - minAtras * MIN);
  fs.utimesSync(arq, quando, quando);
}
// A aba aberta (registro vivo): `minAtras` = a hora do status (statusUpdatedAt) e do arquivo
function aberta(h, raiz, sid, { titulo, minAtras = 60, status = 'idle' }) {
  conversa(h, raiz, sid, { titulo, minAtras });
  h.nReg += 1;
  const quando = h.t - minAtras * MIN;
  const reg = { pid: process.pid, sessionId: sid, cwd: raiz, entrypoint: 'claude-vscode', name: titulo, nameSource: 'user', status, statusUpdatedAt: quando, updatedAt: quando, startedAt: quando };
  fs.writeFileSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${100000 + h.nReg}.json`), JSON.stringify(reg));
}
function pedidoOk(h, { codigo, sessionId, criado = h.t - MIN, titulo = undefined }) {
  const dir = path.join(h.env.SESSOES_WPP_DIR, 'oks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${codigo}.json`), JSON.stringify({
    v: 1, codigo, sessionId, tipo: 'crm', acao: 'x', hashAcao: 'h', destinatarios: null, titulo,
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
// A pergunta pra ele (o parou que precisa dele) de cada aba: [sid, titulo, minAtras]
function perguntas(h, lista) {
  mexer(h, (e) => {
    for (const [sid, titulo, min] of lista) {
      e.ultimosParou[sid] = { at: iso(h.t - min * MIN), finalTs: iso(h.t - min * MIN), precisa: true, pergunta: `${titulo}?`, titulo, nome: titulo };
    }
  });
}
const painel = (h) => estado(h).tg.painel?.dados ?? null;
async function falarTg(h, texto, { respondeA = null } = {}) {
  h.nUpd += 1;
  h.nMid += 1;
  const m = {
    message_id: h.nMid, date: Math.floor(h.t / 1000), text: texto,
    chat: { id: DONO, type: 'private', first_name: 'Davi' }, from: { id: DONO, is_bot: false, first_name: 'Davi' },
  };
  if (respondeA != null) m.reply_to_message = { message_id: respondeA }; // D2b: a resposta em cima de uma mensagem
  h.tg.lotes.push([{ update_id: h.nUpd, message: m }]);
  await h.p.esperarTelegram(15000);
  await bombear(h.p);
}
// A mensagem do dono no grupo do WhatsApp
function msg(h, content) {
  h.nMsg += 1;
  h.grupo.push({
    id: `uuid-${h.nMsg}`, provider_msg_id: `PROV${h.nMsg}`, quoted_msg_id: null, sent_by_agent: false, message_type: 'text',
    content, transcription: null, direction: 'received', from_me: false, sender_phone: NUMERO_DONO, message_ts: iso(h.t),
  });
}
const enviado = (h) => h.tg.de('enviar').at(-1)?.args[0] ?? null;
const sids = (v) => (v ?? []).map((x) => x.sid);
// As abas abertas (Set por janela) e o prazo do cache vencido; `null` = ilegiveis
function abas(h, lista) {
  h.abas = lista === null ? null : new Map([[raizNormal(h.repos), new Set(lista)], [raizNormal(h.workspace), new Set()]]);
  h.t += 61 * 1000;
}
const grupos = (j) => j.grupos.map((g) => [g.nome, g.total, sids(g.itens)]);
const marcas = (g) => g.itens.map((x) => [x.sid, x.marcas]);
const todos = (d) => d.janelas.flatMap((j) => j.grupos.flatMap((g) => sids(g.itens)));

// ---------- T38 1. o espelho por janela ----------

test('T38 1. espelho por janela: grupos na ordem com o nome como veio e o total, grupo vazio, id sem transcript some, arquivada fora e contada, Concluido no lugar dele, Sem grupo (cli e Desktop) no fim, id em 2 grupos no 1o, a mais recente primeiro', async () => {
  const h = montar();
  const { repos, workspace } = h;
  conversa(h, repos, U(1), { titulo: 'Um', minAtras: 90 });
  conversa(h, repos, U(2), { titulo: 'Dois', minAtras: 30 });
  conversa(h, repos, U(3), { titulo: 'Três', minAtras: 60 });
  conversa(h, repos, U(4), { titulo: 'Arquivada no grupo', minAtras: 20 });
  conversa(h, repos, U(5), { titulo: 'Feita', minAtras: 10 });
  conversa(h, repos, U(6), { titulo: 'Do terminal', entrypoint: 'cli', minAtras: 50 });
  conversa(h, repos, U(7), { titulo: 'Do Desktop', entrypoint: 'claude-desktop', minAtras: 40 });
  conversa(h, repos, U(8), { titulo: 'Arquivada solta', minAtras: 5 });
  const pastaW = projeto(workspace).toLowerCase();
  conversa(h, workspace, U(11), { titulo: 'Fred', minAtras: 3 * 24 * 60, pasta: pastaW });
  conversa(h, workspace, U(12), { minAtras: 70, pasta: pastaW }); // sem titulo
  h.lista = {
    arquivadas: new Set([U(4), U(8)]),
    grupos: new Map([
      [raizNormal(repos), [
        { nome: '❗Prioridade', ids: [U(1), U(2), U(40)] }, // U(40): id sem transcript
        { nome: '🟢 Ativos', ids: [U(3), U(2), U(4)] }, // U(2) ja no Prioridade; U(4) arquivada
        { nome: '🟠 Backlogs', ids: [] },
        { nome: '✔️ Concluído', ids: [U(5)] },
      ]],
      [raizNormal(workspace), [{ nome: '❗ Prioridade', ids: [U(11)] }]],
    ]),
  };
  await falarTg(h, '/painel');
  const d = painel(h);
  assert.equal(d.modo, 'vscode');
  assert.deepEqual(d.janelas.map((j) => [j.nome, j.arquivadas, j.centralFora]), [['repos', 2, 0], ['Area', 0, 0]]);
  assert.deepEqual(grupos(d.janelas[0]), [
    ['❗Prioridade', 2, [U(2), U(1)]],
    ['🟢 Ativos', 1, [U(3)]],
    ['🟠 Backlogs', 0, []],
    ['✔️ Concluído', 1, [U(5)]],
    ['Sem grupo', 2, [U(7), U(6)]],
  ]);
  assert.equal(d.janelas[0].grupos.at(-1).semGrupo, true);
  assert.equal(Object.hasOwn(d.janelas[0].grupos[0], 'semGrupo'), false);
  assert.deepEqual(grupos(d.janelas[1]), [['❗ Prioridade', 1, [U(11)]], ['Sem grupo', 1, [U(12)]]]);
  assert.deepEqual(d.janelas[0].grupos[0].itens[0], { titulo: 'Dois', sid: U(2), marcas: ['fechada'] });
  assert.equal(d.janelas[1].grupos[1].itens[0].titulo, 'sem nome');
  assert.deepEqual([d.esperandoN, d.trabalhandoN, d.bot, d.modoRua], [0, 0, BOT_NOME, false]);
  assert.equal(Object.hasOwn(d, 'fora'), false);
  for (const k of ['esperando', 'paradas', 'fechadas', 'abertas', 'foco']) assert.equal(Object.hasOwn(d, k), false, k);
  const html = enviado(h).html;
  assert.ok(html.startsWith('<h3>Igual ao VS Code</h3>'), html.slice(0, 80));
  assert.ok(html.includes('<h1>Janela repos</h1>') && html.includes('<p>Arquivadas: 2</p>'), html);
});

test('T40. as janelas do espelho na ordem das pastas do config: Workspace antes de repos quando o config pede (pedido do dono, 08/11/2026 13:13); no html cada uma com a linha divisoria e o <h1>', async () => {
  const h = montar({ workspaceAntes: true });
  const { repos, workspace } = h;
  conversa(h, repos, U(1), { titulo: 'Um', minAtras: 90 });
  const pastaW = projeto(workspace).toLowerCase();
  conversa(h, workspace, U(11), { titulo: 'Fred', minAtras: 30, pasta: pastaW });
  h.lista = {
    arquivadas: new Set(),
    grupos: new Map([
      [raizNormal(repos), [{ nome: '❗Prioridade', ids: [U(1)] }]],
      [raizNormal(workspace), [{ nome: '❗ Prioridade', ids: [U(11)] }]],
    ]),
  };
  await falarTg(h, '/painel');
  const d = painel(h);
  assert.deepEqual(d.janelas.map((j) => j.nome), ['Area', 'repos']);
  const html = enviado(h).html;
  const iW = html.indexOf('<hr/><h1>Janela Area</h1>');
  const iR = html.indexOf('<hr/><h1>Janela repos</h1>');
  assert.ok(iW > 0 && iR > iW, html);
});

// ---------- T38 2. a central fora e o Fora da lista ----------

test('T38 2. central fora (a viva e a fechada cli com o titulo da central; a do VS Code com o titulo fica) contada em centralFora; pedido de OK e viva de outra pasta no fora', async () => {
  const h = montar();
  const { repos } = h;
  const outra = path.join(h.raiz, 'outra');
  aberta(h, repos, U(20), { titulo: CENTRAL_TESTE.nome, minAtras: 1, status: 'busy' });
  conversa(h, repos, U(21), { titulo: CENTRAL_TESTE.nome, entrypoint: 'cli', minAtras: 100 });
  conversa(h, repos, U(22), { titulo: CENTRAL_TESTE.nome, minAtras: 110 }); // claude-vscode: o titulo nao faz central
  conversa(h, repos, U(25), { titulo: 'Normal', minAtras: 10 });
  conversa(h, outra, U(23), { titulo: 'Pede OK de fora', minAtras: 15 });
  pedidoOk(h, { codigo: 'ABC234', sessionId: U(23), titulo: 'Pede OK de fora' });
  aberta(h, outra, U(24), { titulo: 'Viva de fora', minAtras: 2, status: 'busy' });
  await falarTg(h, '/painel');
  const d = painel(h);
  assert.equal(d.janelas[0].centralFora, 2);
  assert.deepEqual(grupos(d.janelas[0]), [['Sem grupo', 2, [U(25), U(22)]]]);
  assert.deepEqual(d.fora, {
    total: 2,
    itens: [
      { titulo: 'Pede OK de fora', sid: U(23), marcas: ['fechada', 'esperando'] },
      { titulo: 'Viva de fora', sid: U(24), marcas: ['trabalhando'] },
    ],
  });
  assert.deepEqual([d.esperandoN, d.trabalhandoN], [1, 1], 'a central trabalhando nao conta');
  const html = enviado(h).html;
  assert.ok(html.includes('Arquivadas: 0 · central fora: 2') && html.includes('Fora da lista do VS Code (2)'), html);
});

// ---------- T38 3. as marcas ----------

test('T38 3. marcas: trabalhando, esperando, fechada; sem processo com aba aberta = sem fechada; abas ilegiveis = sem processo vale fechada; pergunta no Aguardando = sem esperando', async () => {
  const h = montar();
  const { repos } = h;
  aberta(h, repos, U(30), { titulo: 'Trabalha', minAtras: 1, status: 'busy' });
  aberta(h, repos, U(31), { titulo: 'Pergunta aberta', minAtras: 2 });
  conversa(h, repos, U(32), { titulo: 'Fechada', minAtras: 3 });
  conversa(h, repos, U(33), { titulo: 'Aba aberta', minAtras: 4 });
  conversa(h, repos, U(34), { titulo: 'Aguardando', minAtras: 5 });
  conversa(h, repos, U(35), { titulo: 'Pergunta fechada', minAtras: 6 });
  h.lista = { arquivadas: new Set(), grupos: new Map([[raizNormal(repos), [{ nome: 'G', ids: [30, 31, 32, 33, 34, 35].map(U) }]]]) };
  perguntas(h, [[U(31), 'Pergunta aberta', 2], [U(34), 'Aguardando', 5], [U(35), 'Pergunta fechada', 6]]);
  mexer(h, (e) => { e.aguardando = { [U(34)]: { finalTs: e.ultimosParou[U(34)].finalTs, em: iso(h.t) } }; });
  abas(h, [U(33)]);
  await falarTg(h, '/painel');
  let d = painel(h);
  assert.deepEqual(marcas(d.janelas[0].grupos[0]), [
    [U(30), ['trabalhando']],
    [U(31), ['esperando']],
    [U(32), ['fechada']],
    [U(33), []],
    [U(34), ['fechada']],
    [U(35), ['fechada', 'esperando']],
  ]);
  assert.deepEqual([d.esperandoN, d.trabalhandoN], [2, 1]);
  abas(h, null);
  await falarTg(h, '/painel');
  d = painel(h);
  assert.deepEqual(marcas(d.janelas[0].grupos[0]).find(([sid]) => sid === U(33)), [U(33), ['fechada']]);
});

// ---------- T38 4. o modo padrao ----------

test('T38 4. padrao: no Esperando e nas Paradas a fechada com aba aberta sai sem "fechada" e a sem aba com ela; abas ilegiveis = como antes; o pendencias do grupo segue com ", fechada"', async () => {
  const h = montar({ modoPainel: 'padrao' });
  const { repos } = h;
  conversa(h, repos, U(40), { titulo: 'Sem aba', minAtras: 30 });
  conversa(h, repos, U(41), { titulo: 'Com aba', minAtras: 20 });
  conversa(h, repos, U(42), { titulo: 'Parada com aba', minAtras: 60 });
  conversa(h, repos, U(43), { titulo: 'Parada sem aba', minAtras: 50 });
  perguntas(h, [[U(40), 'Sem aba', 30], [U(41), 'Com aba', 20]]);
  abas(h, [U(41), U(42)]);
  await falarTg(h, '/painel');
  let d = painel(h);
  const fechadas = (v) => v.map((x) => [x.sid, Object.hasOwn(x, 'fechada') ? x.fechada : 'sem']);
  assert.equal(d.modo, 'padrao');
  assert.equal(Object.hasOwn(d, 'modoBotao'), false);
  assert.deepEqual(fechadas(d.esperando), [[U(40), true], [U(41), 'sem']]);
  assert.deepEqual(fechadas(d.paradas), [[U(43), true], [U(42), 'sem']]);
  msg(h, 'pendencias');
  await h.p.passoGrupo();
  await bombear(h.p);
  const texto = h.enviados.at(-1)?.texto ?? '';
  assert.match(texto, /- Com aba \(\d\d:\d\d, fechada\): Com aba\?/);
  assert.match(texto, /- Sem aba \(\d\d:\d\d, fechada\): Sem aba\?/);
  abas(h, null);
  await falarTg(h, '/painel');
  d = painel(h);
  assert.deepEqual(fechadas(d.esperando), [[U(40), true], [U(41), true]]);
  assert.deepEqual(fechadas(d.paradas), [[U(43), true], [U(42), true]]);
});

// ---------- T38 5. o espelho ignora foco, escolhas e tocadas ----------

test('T38 5. espelho: sem foco, escolhas da central e tocadas; nao grava o painelLista; lista ilegivel = o painel padrao com a linha do erro e o modoBotao', async () => {
  const h = montar({ foco: { grupo: 'Prioridade', desdeMs: T0 - 30 * MIN } });
  const { repos } = h;
  conversa(h, repos, U(50), { titulo: 'Tirada', minAtras: 100 }); // fora do foco e tirada pela central
  conversa(h, repos, U(51), { titulo: 'Tocada', minAtras: 10 });
  h.lista = {
    arquivadas: new Set(),
    grupos: new Map([[raizNormal(repos), [{ nome: '❗Prioridade', ids: [U(51)] }, { nome: '🟢 Ativos', ids: [U(50)] }]]]),
  };
  const lista0 = { em: iso(h.t), dentro: [], fora: [] };
  mexer(h, (e) => {
    e.escolhasPainel = { [U(50)]: { lado: 'tirar', em: iso(h.t) } };
    e.painelLista = lista0;
  });
  await falarTg(h, '/painel');
  let d = painel(h);
  assert.deepEqual(todos(d), [U(51), U(50)]);
  assert.equal(Object.hasOwn(d, 'foco'), false);
  assert.deepEqual(estado(h).painelLista, lista0);
  // a tocada continua no painel vivo (o espelho nao tira)
  mexer(h, (e) => { e.painelTg.tocadas = { [U(51)]: 'paradas' }; e.painelTg.conferidoEm = iso(h.t - MIN); });
  conversa(h, repos, U(52), { titulo: 'Nova', minAtras: 0 });
  h.t += 31 * 1000;
  await h.p.esperarTelegram(1000);
  d = painel(h);
  assert.deepEqual(todos(d), [U(51), U(50), U(52)]);
  assert.deepEqual(estado(h).painelLista, lista0);
  // lista ilegivel: o padrao com o erro, e o botao segue dizendo VS Code
  h.lista = null;
  await falarTg(h, '/painel');
  d = painel(h);
  assert.deepEqual([d.modo, d.modoBotao, d.listaErro], ['padrao', 'vscode', true]);
  assert.ok(Array.isArray(d.esperando) && Array.isArray(d.paradas));
});

// ---------- T38 6. o teto por grupo ----------

test('T38 6. teto: grupo com 45 conversas e 2 velhas com marca = total 45 e itens = as 40 mais recentes + as 2 marcadas; D2b: so "fechada" nao fura (45 fechadas sem aba = 40)', async () => {
  const h = montar();
  const { repos } = h;
  const ids = Array.from({ length: 45 }, (_, i) => U(100 + i));
  ids.forEach((sid, i) => conversa(h, repos, sid, { titulo: `C${i}`, minAtras: i + 1 }));
  h.lista = { arquivadas: new Set(), grupos: new Map([[raizNormal(repos), [{ nome: 'G', ids }]]]) };
  perguntas(h, [[U(143), 'C43', 44], [U(144), 'C44', 45]]);
  abas(h, ids);
  await falarTg(h, '/painel');
  const g = painel(h).janelas[0].grupos[0];
  assert.equal(g.total, 45);
  assert.deepEqual(sids(g.itens), [...ids.slice(0, 40), U(143), U(144)]);
  assert.deepEqual(g.itens.slice(-2).map((x) => x.marcas), [['esperando'], ['esperando']]);
  assert.ok(g.itens.slice(0, 40).every((x) => x.marcas.length === 0));
  // D2b: as 45 fechadas, sem aba e sem pergunta: a marca "fechada" sozinha nao fura o teto
  mexer(h, (e) => { e.ultimosParou = {}; });
  abas(h, []);
  await falarTg(h, '/painel');
  const g2 = painel(h).janelas[0].grupos[0];
  assert.equal(g2.total, 45);
  assert.deepEqual(sids(g2.itens), ids.slice(0, 40));
  assert.ok(g2.itens.every((x) => x.marcas.length === 1 && x.marcas[0] === 'fechada'), JSON.stringify(g2.itens.slice(0, 2)));
});

// ---------- D2b: os botoes do painel (modo e Sincronizar), a situacao e o rodar ----------

const SO_WINDOWS = process.platform !== 'win32' && 'premissa do Windows (o Mac tem os tests/mac-*)';
const require = createRequire(import.meta.url);
const L1_BUSCAR = [{ texto: 'Buscar', dados: 'p:b' }];
const L2_PADRAO = [{ texto: 'Modo VS Code', dados: 'p:mv' }, { texto: 'Sincronizar', dados: 'p:s' }];
const L2_VSCODE = [{ texto: 'Modo padrão', dados: 'p:mp' }, { texto: 'Sincronizar', dados: 'p:s' }];
const NAO_GRAVOU = 'Não consegui gravar o ajuste; nada mudou.';
const SINCRONIZADO = /^Sincronizado com o VS Code às \d\d:\d\d\.$/;
// O toque num botao em cima da mensagem `messageId` (o callback_query do toqueTg do tests/porteiro-t29d.test.mjs)
async function tocar(h, dados, messageId) {
  h.nUpd += 1;
  h.tg.lotes.push([{
    update_id: h.nUpd,
    callback_query: { id: `q${h.nUpd}`, from: { id: DONO, is_bot: false }, message: { message_id: messageId, chat: { id: DONO, type: 'private' } }, data: dados },
  }]);
  await h.p.esperarTelegram(15000);
  await bombear(h.p);
}
const naTela = (h) => estado(h).tg.painel?.mensagem?.messageId ?? null;
const baloes = (h) => h.tg.de('responderToque').map((c) => c.args[1]);
const edicoes = (h, id) => h.tg.de('editar').filter((c) => c.args[0] === id).map((c) => c.args[1]);
const arqCfg = (h) => path.join(h.env.SESSOES_WPP_DIR, 'config.json');
const lerCfg = (h) => JSON.parse(fs.readFileSync(arqCfg(h), 'utf8'));
const logs = (h) => (fs.existsSync(h.env.SESSOES_WPP_LOG) ? fs.readFileSync(h.env.SESSOES_WPP_LOG, 'utf8').split(/\r?\n/) : []);
const grupoG = (h, ids) => ({ arquivadas: new Set(), grupos: new Map([[raizNormal(h.repos), [{ nome: 'G', ids }]]]) });

test('T38 7 (D2b). [Modo VS Code]: grava painel.modo sem perder o foco, o desde e os outros blocos; edita o painel na tela pro espelho com [Modo padrão][Sincronizar]; balao e 1 linha de log; [Modo padrão] volta', async () => {
  const h = montar({ modoPainel: 'padrao' });
  conversa(h, h.repos, U(60), { titulo: 'Alfa', minAtras: 10 });
  h.lista = grupoG(h, [U(60)]);
  const cfg0 = { voz: { ligada: false }, painel: { foco: 'G', desde: '2026-11-07T12:00:00.000Z' } };
  fs.writeFileSync(arqCfg(h), JSON.stringify(cfg0));
  await falarTg(h, '/painel');
  const id = naTela(h);
  assert.deepEqual(enviado(h).botoes, [L1_BUSCAR, L2_PADRAO]);
  h.tg.zerar();
  await tocar(h, 'p:mv', id);
  assert.deepEqual(lerCfg(h), { voz: { ligada: false }, painel: { foco: 'G', desde: '2026-11-07T12:00:00.000Z', modo: 'vscode' } });
  assert.deepEqual(baloes(h), ['Painel no modo VS Code.']);
  assert.equal(h.tg.de('enviar').length, 0, 'edicao do painel na tela, nunca mensagem nova');
  const ed = edicoes(h, id).at(-1);
  assert.ok(ed && ed.html.startsWith('<h3>Igual ao VS Code</h3>'), JSON.stringify(h.tg.chamadas.map((c) => c.metodo)));
  assert.deepEqual(ed.botoes, [L1_BUSCAR, L2_VSCODE]);
  assert.equal(painel(h).modo, 'vscode');
  assert.ok(logs(h).some((l) => l.endsWith('Telegram: painel no modo VS Code (config.json gravado)')));
  h.tg.zerar();
  await tocar(h, 'p:mp', id);
  assert.deepEqual(lerCfg(h).painel, { foco: 'G', desde: '2026-11-07T12:00:00.000Z', modo: 'padrao' });
  assert.deepEqual(baloes(h), ['Painel no modo padrão.']);
  const volta = edicoes(h, id).at(-1);
  assert.ok(volta && !volta.html.includes('Igual ao VS Code'), volta?.html);
  assert.deepEqual(volta.botoes, [L1_BUSCAR, L2_PADRAO]);
  assert.equal(painel(h).modo, 'padrao');
  assert.ok(logs(h).some((l) => l.endsWith('Telegram: painel no modo padrao (config.json gravado)')));
});

test('T38 8 (D2b). config que nao grava (JSON torto, bloco painel que nao e objeto) = o balao do ajusteNaoGravou e nada muda (config, modo e painel); o modo atual = o balao "ja esta" e remonta (as tocadas voltam)', async () => {
  const h = montar({ modoPainel: 'padrao' });
  conversa(h, h.repos, U(61), { titulo: 'Beta', minAtras: 10 });
  await falarTg(h, '/painel');
  const id = naTela(h);
  const dados0 = painel(h);
  for (const torto of ['{ "painel": ', JSON.stringify({ painel: 'vscode' })]) {
    fs.writeFileSync(arqCfg(h), torto);
    h.tg.zerar();
    await tocar(h, 'p:mv', id);
    assert.deepEqual(baloes(h), [NAO_GRAVOU], torto);
    assert.equal(fs.readFileSync(arqCfg(h), 'utf8'), torto, 'o config fica como estava');
    assert.deepEqual([h.tg.de('editar').length, h.tg.de('enviar').length], [0, 0], 'o painel nao muda');
    assert.deepEqual(painel(h), dados0);
  }
  await falarTg(h, '/painel');
  assert.equal(painel(h).modo, 'padrao', 'o modo em memoria nao mudou');
  const id2 = naTela(h);
  mexer(h, (e) => { e.painelTg.tocadas = { [U(61)]: 'paradas' }; });
  h.t += 2000;
  const antes = h.t;
  h.tg.zerar();
  await tocar(h, 'p:mp', id2);
  assert.deepEqual(baloes(h), ['O painel já está no modo padrão.']);
  assert.deepEqual(estado(h).painelTg.tocadas, {}, 'remontou: as tocadas voltam');
  assert.ok(Date.parse(estado(h).painelTg.conferidoEm) >= antes, 'remontou: conferido agora');
  assert.deepEqual(edicoes(h, id2).at(-1)?.botoes, [L1_BUSCAR, L2_PADRAO]);
});

test('T38 9 (D2b). [Sincronizar]: sem painel na tela manda um novo; com painel, dentro dos 30 s do vivo, edita na hora com a lista nova, as abas relidas (cache limpo) e as tocadas limpas; lista ilegivel = o balao do erro', async () => {
  const h = montar();
  const { repos } = h;
  conversa(h, repos, U(70), { titulo: 'Alfa', minAtras: 10 });
  conversa(h, repos, U(71), { titulo: 'Beta', minAtras: 5 });
  h.lista = grupoG(h, [U(70)]);
  abas(h, []);
  await tocar(h, 'p:s', 4242);
  assert.equal(baloes(h).length, 1);
  assert.match(baloes(h)[0], SINCRONIZADO);
  const novo = h.tg.de('enviar').at(-1)?.args[0];
  assert.ok(novo && novo.html.startsWith('<h3>Igual ao VS Code</h3>'), JSON.stringify(h.tg.chamadas.map((c) => c.metodo)));
  assert.deepEqual(novo.botoes, [L1_BUSCAR, L2_VSCODE]);
  const id = naTela(h);
  assert.deepEqual(marcas(painel(h).janelas[0].grupos[0]), [[U(70), ['fechada']]]);
  // dentro dos 30 s do painel vivo e do prazo do cache das abas: a lista e as abas mudam
  h.lista = grupoG(h, [U(70), U(71)]);
  h.abas = new Map([[raizNormal(repos), new Set([U(70)])]]);
  h.t += 5000;
  mexer(h, (e) => { e.painelTg.tocadas = { [U(70)]: 'paradas' }; e.painelTg.conferidoEm = iso(h.t); });
  h.tg.zerar();
  await tocar(h, 'p:s', id);
  assert.equal(baloes(h).length, 1);
  assert.match(baloes(h)[0], SINCRONIZADO);
  assert.equal(h.tg.de('enviar').length, 0);
  const ed = edicoes(h, id).at(-1);
  assert.ok(ed && ed.html.includes('Beta'), ed?.html);
  assert.deepEqual(marcas(painel(h).janelas[0].grupos[0]), [[U(71), ['fechada']], [U(70), []]]);
  assert.deepEqual(estado(h).painelTg.tocadas, {});
  // a lista ilegivel: o balao do erro e o padrao com a linha do erro (o botao segue no VS Code)
  h.lista = null;
  h.tg.zerar();
  await tocar(h, 'p:s', id);
  assert.deepEqual(baloes(h), ['Não consegui ler a lista do VS Code agora.']);
  assert.deepEqual([painel(h).modo, painel(h).modoBotao, painel(h).listaErro], ['padrao', 'vscode', true]);
  assert.deepEqual(edicoes(h, id).at(-1)?.botoes, [L1_BUSCAR, L2_VSCODE]);
});

test('T38 10 (D2b). espelho: o painel vivo reedita quando a lista muda depois de 30 s; a busca com o painel na tela filtra pelo espelho', async () => {
  const h = montar();
  const { repos } = h;
  conversa(h, repos, U(80), { titulo: 'Zimbabue projeto', minAtras: 10 });
  conversa(h, repos, U(81), { titulo: 'Planilha', minAtras: 20 });
  h.lista = grupoG(h, [U(80), U(81)]);
  await falarTg(h, '/painel');
  const id = naTela(h);
  conversa(h, repos, U(82), { titulo: 'Novidade', minAtras: 0 });
  h.lista = grupoG(h, [U(80), U(81), U(82)]);
  h.tg.zerar();
  h.t += 31 * 1000;
  await h.p.esperarTelegram(1000);
  await bombear(h.p);
  const ed = edicoes(h, id).at(-1);
  assert.ok(ed && ed.html.startsWith('<h3>Igual ao VS Code</h3>') && ed.html.includes('Novidade'), ed?.html);
  assert.deepEqual(ed.botoes, [L1_BUSCAR, L2_VSCODE]);
  h.tg.zerar();
  await falarTg(h, '/buscar zimbabue');
  const b = edicoes(h, id).at(-1);
  assert.ok(b && b.html.includes('Zimbabue projeto') && !b.html.includes('Planilha') && !b.html.includes('Novidade'), b?.html);
  assert.deepEqual(b.botoes, [[{ texto: 'Limpar busca', dados: 'p:l' }], L2_VSCODE]);
});

test('T38 11 (D2b). situacao: sem processo e com a aba aberta = "Parada, com a aba aberta no VS Code. Responda aqui pra retomar." e a resposta reabre escondida (T8); sem reabrir = so "Parada, com a aba aberta no VS Code."; sem aba = o fechadaReabre de antes', async () => {
  const h = montar({ modoPainel: 'padrao' });
  const { repos } = h;
  conversa(h, repos, U(90), { titulo: 'Relatório', minAtras: 60 });
  conversa(h, repos, U(91), { titulo: 'Sem aba', minAtras: 50 });
  conversa(h, repos, U(92), { titulo: 'Do Desktop', entrypoint: 'claude-desktop', minAtras: 40 });
  abas(h, [U(90), U(92)]);
  await falarTg(h, `/start a_${U(90)}`);
  assert.ok(enviado(h).html.includes('<i>Parada, com a aba aberta no VS Code. Responda aqui pra retomar.</i>'), enviado(h).html);
  const tela = estado(h).tg.situacao.mensagem.messageId;
  h.mortas.add(U(90));
  await falarTg(h, 'manda sim', { respondeA: tela });
  assert.deepEqual(h.entregas.map((p) => p.sessionId), [U(90)]);
  assert.deepEqual(h.escondidas, [[repos, 'Relatório', { retomar: U(90) }]]);
  await falarTg(h, `/start a_${U(91)}`);
  assert.ok(enviado(h).html.includes('<i>Fechada. Responda aqui pra reabrir.</i>'), enviado(h).html);
  await falarTg(h, `/start a_${U(92)}`);
  assert.ok(enviado(h).html.includes('<i>Parada, com a aba aberta no VS Code.</i>'), enviado(h).html);
});

// ---------- T38 13 (principal, na validacao). o cache das abas, o toque no nome e a busca sem painel no espelho ----------

test('T38 13. espelho: as abas se releem no maximo a cada 60 s (2 paineis seguidos = 1 leitura); o toque no nome (a situacao) nao troca o painel na tela pelo padrao; a busca sem painel na tela manda o espelho filtrado', async () => {
  const h = montar();
  const { repos } = h;
  conversa(h, repos, U(95), { titulo: 'Zimbabue projeto', minAtras: 10 });
  conversa(h, repos, U(96), { titulo: 'Planilha', minAtras: 20 });
  h.lista = grupoG(h, [U(95), U(96)]);
  let leituras = 0;
  let abasAgora = new Map([[raizNormal(repos), new Set()]]);
  Object.defineProperty(h, 'abas', { get: () => { leituras += 1; return abasAgora; }, set: (v) => { abasAgora = v; } });
  // a busca sem painel na tela: o painel novo e o espelho filtrado (nao o padrao)
  await falarTg(h, '/buscar zimbabue');
  const b = h.tg.de('enviar').map((c) => c.args[0]).find((x) => typeof x?.html === 'string' && x.html.includes('Zimbabue projeto'));
  assert.ok(b && b.html.includes('<h1>Janela ') && !b.html.includes('Planilha'), JSON.stringify(h.tg.de('enviar').map((c) => c.args[0]?.html)));
  assert.equal(painel(h).modo, 'vscode');
  // 2 paineis dentro de 60 s = 1 leitura das abas; depois de 60 s, outra
  const antes = leituras;
  await falarTg(h, '/painel');
  h.t += 20 * 1000;
  await falarTg(h, '/painel');
  assert.equal(leituras - antes, 0, 'o cache de 60 s vale nos 2 paineis');
  h.t += 61 * 1000;
  await falarTg(h, '/painel');
  assert.equal(leituras - antes, 1, 'vencido o prazo, as abas se releem 1 vez');
  // o toque no nome no espelho: a situacao sai e o painel na tela continua o espelho (nada de editar pro padrao)
  const id = naTela(h);
  h.tg.zerar();
  await falarTg(h, `/start a_${U(96)}`);
  assert.ok(enviado(h)?.html.includes('Planilha'), JSON.stringify(enviado(h)));
  for (const ed of edicoes(h, id)) assert.ok(ed.html.startsWith('<h3>Igual ao VS Code</h3>'), ed.html);
  assert.equal(painel(h).modo, 'vscode');
  assert.ok(sids(painel(h).janelas[0].grupos[0].itens).includes(U(96)), 'a tocada continua no espelho');
});

// Uma janela do VS Code de teste: `workspaceStorage/<hash>` com o workspace.json da pasta e o state.vscdb com as abas
function janelaTeste(ws, hash, pasta, ids) {
  const { DatabaseSync } = require('node:sqlite');
  const sub = path.join(ws, hash);
  fs.mkdirSync(sub, { recursive: true });
  const folder = `file:///${pasta.split(/[\\/]/).map((s, i) => (i === 0 ? s.toLowerCase().replace(':', '%3A') : encodeURIComponent(s))).join('/')}`;
  fs.writeFileSync(path.join(sub, 'workspace.json'), JSON.stringify({ folder }));
  const db = new DatabaseSync(path.join(sub, 'state.vscdb'));
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('Anthropic.claude-code', JSON.stringify({
    panelTabSessions: ids.map((sessionId) => ({ sessionId, title: `t-${sessionId}`, fullEditor: false })),
  }));
  db.close();
}

test('T38 12 (D2b). lerAbasVsCodeReal: as janelas no workspaceStorage irmao do banco global (o do config, senao o do ambiente), so as raizes pedidas; sem banco = null. O rodar passa o modoPainel e o lerAbasVsCode (sem o app vscode = null) e loga o modo', { skip: SO_WINDOWS }, () => {
  const base = pastaTemp('t38d2b-ws-');
  const global = path.join(base, 'Code', 'User', 'globalStorage', 'state.vscdb');
  const ws = path.join(base, 'Code', 'User', 'workspaceStorage');
  const raiz = path.join(base, 'projetos');
  janelaTeste(ws, 'h1', raiz, [U(1), U(2)]);
  janelaTeste(ws, 'h2', path.join(base, 'outra'), [U(3)]);
  const comoObjeto = (m) => (m instanceof Map ? Object.fromEntries([...m].map(([k, s]) => [k, [...s].sort()])) : m);
  const esperado = { [raizNormal(raiz)]: [U(1), U(2)] };
  assert.deepEqual(comoObjeto(porteiroMod.lerAbasVsCodeReal({ env: {}, banco: global, raizes: [raiz] })()), esperado);
  assert.deepEqual(comoObjeto(porteiroMod.lerAbasVsCodeReal({ env: { SESSOES_WPP_VSCODE_DB: global }, raizes: [raiz] })()), esperado);
  assert.equal(porteiroMod.lerAbasVsCodeReal({ env: {}, raizes: [raiz] })(), null, 'sem banco = null');
  const fonte = fs.readFileSync(new URL('../porteiro.mjs', import.meta.url), 'utf8');
  const rodar = fonte.slice(fonte.indexOf('async function rodar('));
  const chamada = rodar.slice(rodar.indexOf('criarPorteiro({'), rodar.indexOf('});', rodar.indexOf('criarPorteiro({')));
  assert.match(chamada, /\bmodoPainel: modoPainelDoConfig\(cfg\)\.modo,/);
  assert.ok(chamada.includes("lerAbasVsCode: apps.includes('vscode') ? lerAbasVsCodeReal({ env, banco: bancoVsCodeDoConfig(cfg), raizes: sessoes.raizes }) : null,"));
  assert.ok(rodar.includes("log(`painel: modo ${modoPainelDoConfig(cfg).modo === 'vscode' ? 'VS Code' : 'padrao'}`);"));
});
