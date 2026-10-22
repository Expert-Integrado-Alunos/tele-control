// Testes da T33 (PLANO-TELEGRAM.md, "T33 — o painel só com o grupo Prioridade"; pedido do dono, saindo do PC por 7 dias:
// «Essas são as principais tarefas que eu vou continuar trabalhando, o resto [...] Eu não vou usar. Dá pra deixar essas
// daí dentro da tela de ativos? Ou trabalhando e as outras fora?») e da T34 ("T34 — o porteiro religa o guardião";
// «garanta que o processo aqui reinicie sempre sozinho e não pare nunca»).
// - T33 1: com o foco, o painel so com o grupo dele (nas 2 janelas), o pedido de OK aberto, a sem grupo e a aberta que
//   mexeram depois do `desde`; o resto sai de todos os grupos; o topo e a linha do fim.
// - T33 2: o painel de antes sem foco, com a lista ilegivel, com o grupo sem ninguem (1 log por hora) e com o nome so de
//   icone.
// - T33 3: sem o `desde`, a hora em que o porteiro subiu.
// - T33 4 e 5: o focoDoConfig e a linha do fim (linhaDoFoco, montarPainel rico e classico).
// - T34 1 a 3: o passo de minuto religa o guardiao morto (prazo de 10 min, vivo, sem saber, desligado, ensaio); o
//   guardiaoReal (o lock e o wscript); o rodar passa os 2 ao criarPorteiro.
// Isolamento: pastas temporarias via SESSOES_WPP_DIR, CLAUDE_SESSIONS_DIR, CLAUDE_PROJECTS_DIR e SESSOES_WPP_LOG (nunca o
// ~/.claude real nem o banco do VS Code de verdade); raizes de mentira dentro da pasta temporaria. Nenhuma rede nem
// processo: `tg`, `wpp`, mensageiro, a lista do VS Code, o guardiao e o spawn sao dubles. Harness copiado (enxuto) do
// tests/porteiro-t11.test.mjs.
// Rodar: node --test --test-reporter=tap "tests/porteiro-t33.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pastaTemp } from './lib/pasta-temp.cjs';
import * as porteiroMod from '../porteiro.mjs';
import { raizNormal } from '../lib/lista-vscode.mjs';
import * as configMod from '../lib/config.mjs';
import * as formatoTg from '../lib/formato-tg.mjs';
import { NUMERO_DONO } from './lib/dados-whatsapp.mjs';
import { CENTRAL_TESTE } from './lib/dados-central.mjs';

const { criarPorteiro } = porteiroMod;
const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-21T18:00:00Z'); // 15:00 em Brasilia
const iso = (ms) => new Date(ms).toISOString();
const DONO = 700100200;
const BOT = 700900800;
const BOT_NOME = 'Teste_ControleBot';
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

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
  tg.zerar = () => { tg.chamadas.length = 0; };
  return tg;
}

// Porteiro com o Telegram e a lista do VS Code de mentira (`h.lista`; null = ilegivel). `foco` = o focoPainel;
// `guardiao` = o duble do guardiao (T34); `ensaio` = o modo ensaio.
function montar({ foco = null, guardiao = null, ensaio = false } = {}) {
  const raiz = pastaTemp('porteiro-t33-');
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
  const h = { raiz, env, t: T0, idle: 0, entregas: [], nReg: 0, nUpd: 100, nMid: 7000, repos, workspace, lista: { arquivadas: new Set(), grupos: new Map() } };
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
    dormir: async (ms) => { h.t += ms; }, raizesSessao: [repos, workspace], ensaio,
    tg: h.tg, identTg: { chatId: DONO, botId: BOT }, central: CENTRAL_TESTE,
    abrirSessaoEscondida: async () => {},
    lerListaVsCode: () => (typeof h.lista === 'function' ? h.lista() : h.lista),
  };
  if (foco) opcoes.focoPainel = foco;
  if (guardiao) opcoes.guardiao = guardiao;
  h.p = criarPorteiro(opcoes);
  h.t += 1000;
  h.tg.usuarioBot = BOT_NOME;
  if (!ensaio) mexer(h, (e) => { e.tg.offset = 0; });
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
// A aba aberta (registro vivo): `minAtras` = a hora do status (statusUpdatedAt)
function aberta(h, raiz, sid, { titulo, minAtras = 60, status = 'idle' }) {
  conversa(h, raiz, sid, { titulo, minAtras });
  h.nReg += 1;
  const quando = h.t - minAtras * MIN;
  const reg = { pid: process.pid, sessionId: sid, cwd: raiz, entrypoint: 'claude-vscode', name: titulo, nameSource: 'user', status, statusUpdatedAt: quando, updatedAt: quando, startedAt: quando };
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
async function falarTg(h, texto) {
  h.nUpd += 1;
  h.nMid += 1;
  h.tg.lotes.push([{
    update_id: h.nUpd,
    message: {
      message_id: h.nMid, date: Math.floor(h.t / 1000), text: texto,
      chat: { id: DONO, type: 'private', first_name: 'Davi' }, from: { id: DONO, is_bot: false, first_name: 'Davi' },
    },
  }]);
  await h.p.esperarTelegram(15000);
  await bombear(h.p);
}
const enviado = (h) => h.tg.de('enviar').at(-1)?.args[0] ?? null;
const sids = (v) => (v ?? []).map((x) => x.sid);

// A cena: o grupo do foco nas 2 janelas, os outros grupos, conversas sem grupo, abertas e fechadas, perguntas e um
// pedido de OK. O `desde` do foco = 30 min atras.
function cena(h) {
  const { repos, workspace } = h;
  conversa(h, repos, U(1), { titulo: 'Imersão', minAtras: 60 }); // foco, fechada, antes do desde
  aberta(h, repos, U(2), { titulo: 'Mac dia 1', minAtras: 120 }); // foco, aberta, antes do desde
  conversa(h, repos, U(3), { titulo: 'Site', minAtras: 10 }); // Ativos, fechada, depois do desde: fora
  aberta(h, repos, U(4), { titulo: 'Douglas', minAtras: 60 }); // Ativos, aberta, antes do desde: fora
  conversa(h, repos, U(5), { titulo: 'Pergunta velha', minAtras: 40 }); // Ativos, fechada, pergunta antes do desde: fora
  conversa(h, repos, U(6), { titulo: 'Concluída', minAtras: 5 }); // concluida: fora desde a T11 (nao conta)
  conversa(h, repos, U(7), { titulo: 'Velha sem grupo', minAtras: 90 }); // sem grupo, antes do desde: fora
  conversa(h, repos, U(8), { titulo: 'Nova pelo celular', entrypoint: 'cli', minAtras: 10 }); // sem grupo, depois: fica
  aberta(h, repos, U(9), { titulo: 'Aberta nova', minAtras: 5 }); // sem grupo, aberta, depois: fica
  conversa(h, repos, U(10), { titulo: 'Pede OK', minAtras: 50 }); // Ativos, fechada, com pedido de OK: fica
  aberta(h, repos, U(13), { titulo: 'Ativa de novo', minAtras: 2 }); // Ativos, aberta, depois: fica
  aberta(h, repos, U(14), { titulo: 'Pergunta nova', minAtras: 5 }); // Ativos, aberta, pergunta depois: fica
  conversa(h, repos, U(15), { titulo: 'Pergunta do foco', minAtras: 120 }); // foco, fechada, pergunta antiga: fica
  const pastaW = projeto(workspace).toLowerCase();
  conversa(h, workspace, U(11), { titulo: 'Fred', minAtras: 3 * 24 * 60, pasta: pastaW }); // foco (2a janela), > 48 h
  conversa(h, workspace, U(12), { titulo: 'Aula', minAtras: 3 * 24 * 60, pasta: pastaW }); // Aulas, > 48 h: fora
  h.lista = {
    arquivadas: new Set(),
    grupos: new Map([
      [raizNormal(repos), [
        { nome: '❗Prioridade', ids: [U(1), U(2), U(15), U(40)] }, // U(40): id sem transcript (caso real)
        { nome: '🟢 Ativos', ids: [U(3), U(4), U(5), U(10), U(13), U(14)] },
        { nome: '✔️ CONCLUÍDO', ids: [U(6)] },
      ]],
      [raizNormal(workspace), [{ nome: '❗ Prioridade', ids: [U(11)] }, { nome: 'ℹ️ Aulas', ids: [U(12)] }]],
    ]),
  };
  pedidoOk(h, { codigo: 'ABC234', sessionId: U(10) });
  mexer(h, (e) => {
    const pergunta = (sid, titulo, min) => {
      e.ultimosParou[sid] = { at: iso(h.t - min * MIN), finalTs: iso(h.t - min * MIN), precisa: true, pergunta: `${titulo}?`, titulo, nome: titulo };
    };
    pergunta(U(5), 'Pergunta velha', 40);
    pergunta(U(14), 'Pergunta nova', 5);
    pergunta(U(15), 'Pergunta do foco', 120);
  });
}
const FOCO = () => ({ grupo: 'Prioridade', desdeMs: T0 - 30 * MIN });
const LINHA_5 = '<p>Só o grupo Prioridade do VS Code (5 conversas fora do painel).</p>';

// ---------- T33 1. com o foco ----------

test('T33 1. com o foco: so o grupo dele (2 janelas), o pedido de OK, a sem grupo e a aberta que mexeram depois do desde; o resto sai de todos os grupos; o topo conta as abertas que ficaram e o fim tem a linha', async () => {
  const h = montar({ foco: FOCO() });
  cena(h);
  await falarTg(h, '/painel');
  const d = painel(h);
  assert.deepEqual(sids(d.esperando), [U(15), U(14), U(10)], 'a pergunta do foco, a da aberta que perguntou depois e o pedido de OK');
  assert.deepEqual(sids(d.paradas), [U(13), U(9), U(8), U(1), U(2)], 'a aberta de outro grupo que mexeu depois, a sem grupo nova (aberta e fechada) e as do foco');
  assert.deepEqual(d.trabalhando, []);
  assert.deepEqual(d.fechadas.map((x) => [x.sid, x.grupo]), [[U(11), 'Prioridade']], 'a do foco da 2a janela, parada ha mais de 48 h');
  assert.deepEqual(d.foco, { grupo: 'Prioridade', fora: 5 }, 'fora: Site, Douglas, Pergunta velha, Velha sem grupo e Aula');
  assert.equal(d.abertas, 4, 'Mac dia 1, Aberta nova, Ativa de novo e Pergunta nova (sem o Douglas)');
  const html = enviado(h).html;
  assert.ok(html.startsWith('<h3>Abas abertas: 4</h3>'), html.slice(0, 80));
  assert.ok(html.endsWith(LINHA_5), html.slice(-160));
  for (const t of ['Douglas', 'Site', 'Pergunta velha', 'Velha sem grupo', 'Aula']) assert.ok(!html.includes(`>${t}<`), t);
  // a aba de outro grupo que volta a mexer (trabalhando agora) entra; nada vai pra aba nenhuma
  fs.rmSync(path.join(h.env.CLAUDE_SESSIONS_DIR, '100002.json')); // o Douglas era o 2o registro
  aberta(h, h.repos, U(4), { titulo: 'Douglas', minAtras: 0, status: 'busy' });
  await falarTg(h, '/painel');
  assert.deepEqual(painel(h).trabalhando.map((x) => x.sid), [U(4)]);
  assert.deepEqual(painel(h).foco, { grupo: 'Prioridade', fora: 4 });
  assert.equal(h.entregas.length, 0);
});

// ---------- T33 2. o painel de antes ----------

test('T33 2. painel de antes: sem foco; com a lista ilegivel (listaErro, 1 log por hora); com o grupo sem ninguem (1 log por hora); com o nome so de icone (sem log)', async () => {
  const sem = montar();
  cena(sem);
  await falarTg(sem, '/painel');
  let d = painel(sem);
  assert.equal(Object.hasOwn(d, 'foco'), false);
  assert.ok(sids(d.paradas).includes(U(4)) && sids(d.esperando).includes(U(5)), 'o Douglas e a pergunta velha aparecem');
  assert.equal(d.abertas, 5);
  const todas = { esperando: sids(d.esperando), paradas: sids(d.paradas), fechadas: sids(d.fechadas) };

  const h = montar({ foco: FOCO() });
  cena(h);
  h.lista = null;
  await falarTg(h, '/painel');
  d = painel(h);
  assert.equal(Object.hasOwn(d, 'foco'), false);
  assert.equal(d.listaErro, true);
  assert.equal(d.abertas, 5);
  assert.ok(sids(d.paradas).includes(U(4)));
  assert.ok(!enviado(h).html.includes('Só o grupo'));
  h.t += 30 * MIN;
  await falarTg(h, '/painel');
  assert.equal(comLog(h, 'painel: lista do VS Code ilegivel; o painel sai sem o foco'), 1, '1 log por hora');
  h.t += 31 * MIN;
  await falarTg(h, '/painel');
  assert.equal(comLog(h, 'painel: lista do VS Code ilegivel; o painel sai sem o foco'), 2);

  const g = montar({ foco: { grupo: 'Urgente', desdeMs: T0 - 30 * MIN } });
  cena(g);
  await falarTg(g, '/painel');
  d = painel(g);
  assert.equal(Object.hasOwn(d, 'foco'), false);
  assert.deepEqual({ esperando: sids(d.esperando), paradas: sids(d.paradas), fechadas: sids(d.fechadas) }, todas, 'igual ao sem foco');
  await falarTg(g, '/painel');
  assert.equal(comLog(g, 'painel: nenhuma conversa no grupo "Urgente"; o painel sai sem o foco'), 1);

  const icone = montar({ foco: { grupo: '❗', desdeMs: T0 - 30 * MIN } });
  cena(icone);
  await falarTg(icone, '/painel');
  assert.equal(Object.hasOwn(painel(icone), 'foco'), false);
  assert.equal(comLog(icone, 'o painel sai sem o foco'), 0);
});

// ---------- T33 3. sem o desde ----------

test('T33 3. sem o desde: vale a hora em que o porteiro subiu (a sem grupo de antes sai; a que nasce depois entra); o nome com icone, acento e caixa diferentes casa', async () => {
  const h = montar({ foco: { grupo: '❗ PRIORIDÁDE', desdeMs: null } });
  conversa(h, h.repos, U(1), { titulo: 'Do foco', minAtras: 600 });
  conversa(h, h.repos, U(7), { titulo: 'Antes de subir', minAtras: 1 });
  h.t += 5 * MIN;
  conversa(h, h.repos, U(8), { titulo: 'Depois de subir', entrypoint: 'cli', minAtras: 1 });
  h.lista = { arquivadas: new Set(), grupos: new Map([[raizNormal(h.repos), [{ nome: '❗Prioridade', ids: [U(1)] }]]]) };
  await falarTg(h, '/painel');
  const d = painel(h);
  assert.deepEqual(sids(d.paradas), [U(8), U(1)]);
  assert.deepEqual(d.foco, { grupo: 'PRIORIDÁDE', fora: 1 });
});

// ---------- T33 4 e 5. o config e a linha ----------

test('T33 4. focoDoConfig: o painel.foco aparado (1 a 60, 1 linha) e o desde legivel; o resto = sem foco ou sem a hora', () => {
  const { focoDoConfig } = configMod;
  assert.equal(typeof focoDoConfig, 'function');
  const d = '2026-10-21T15:00:00-03:00';
  assert.deepEqual(focoDoConfig({ painel: { foco: ' Prioridade ', desde: d } }), { grupo: 'Prioridade', desdeMs: Date.parse(d) });
  assert.deepEqual(focoDoConfig({ painel: { foco: '❗Prioridade' } }), { grupo: '❗Prioridade', desdeMs: null });
  assert.deepEqual(focoDoConfig({ painel: { foco: 'Prioridade', desde: 'ontem' } }), { grupo: 'Prioridade', desdeMs: null });
  for (const cfg of [null, {}, { painel: null }, { painel: [] }, { painel: { foco: '' } }, { painel: { foco: '   ' } },
    { painel: { foco: 'a\nb' } }, { painel: { foco: 'x'.repeat(61) } }, { painel: { foco: 7 } }, { painel: { desde: d } }]) {
    assert.deepEqual(focoDoConfig(cfg), { grupo: null, desdeMs: null }, JSON.stringify(cfg));
  }
});

test('T33 5. a linha do fim: plural, singular e sem os parenteses; escapada; no painel rico e no classico, por ultimo', () => {
  const { linhaDoFoco, montarPainel } = formatoTg;
  assert.equal(typeof linhaDoFoco, 'function');
  assert.equal(linhaDoFoco({ grupo: 'Prioridade', fora: 12 }), 'Só o grupo Prioridade do VS Code (12 conversas fora do painel).');
  assert.equal(linhaDoFoco({ grupo: 'Prioridade', fora: 1 }), 'Só o grupo Prioridade do VS Code (1 conversa fora do painel).');
  assert.equal(linhaDoFoco({ grupo: 'Prioridade', fora: 0 }), 'Só o grupo Prioridade do VS Code.');
  assert.equal(linhaDoFoco({ grupo: 'A<b>&c', fora: 2 }), 'Só o grupo A&lt;b&gt;&amp;c do VS Code (2 conversas fora do painel).');
  for (const f of [undefined, null, {}, { grupo: '  ' }, { grupo: 3 }, []]) assert.equal(linhaDoFoco(f), null, JSON.stringify(f));
  const d = {
    hora: iso(T0), modoRua: false, abertas: 1, esperando: [], trabalhando: [], paradas: [{ titulo: 'Mac dia 1', sid: U(1) }],
    fechadas: [], foco: { grupo: 'Prioridade', fora: 3 },
  };
  const { html, classico } = montarPainel(d);
  assert.ok(html.endsWith('<p>Só o grupo Prioridade do VS Code (3 conversas fora do painel).</p>'), html);
  assert.ok(classico.endsWith('\nSó o grupo Prioridade do VS Code (3 conversas fora do painel).'), classico);
  const { html: semFoco } = montarPainel({ ...d, foco: undefined });
  assert.ok(!semFoco.includes('Só o grupo'), semFoco);
});

// ---------- T34. o guardiao ----------

function dubleGuardiao() {
  const g = { estado: false, religadas: 0, erroReligar: null };
  g.vivo = () => {
    if (g.estado === 'lanca') throw new Error('wmi');
    return g.estado;
  };
  g.religar = () => {
    g.religadas += 1;
    if (g.erroReligar) throw g.erroReligar;
  };
  return g;
}

test('T34 1. o passo de minuto religa o guardiao morto, no maximo 1 vez a cada 10 min, com 1 linha no log; vivo, sem saber (null ou erro), o arquivo desligado e o ensaio = nada; o .vbs que falha vira log', async () => {
  const g = dubleGuardiao();
  const h = montar({ guardiao: g });
  await h.p.passoMinuto();
  assert.equal(g.religadas, 1);
  assert.equal(comLog(h, 'guardiao: estava morto; rodei o .vbs pra ele renascer'), 1);
  h.t += 9 * MIN;
  await h.p.passoMinuto();
  assert.equal(g.religadas, 1, 'dentro dos 10 min nao repete');
  h.t += 1 * MIN;
  await h.p.passoMinuto();
  assert.equal(g.religadas, 2, 'passou dos 10 min: religa de novo');
  for (const est of [true, null, 'lanca']) {
    g.estado = est;
    h.t += 11 * MIN;
    await h.p.passoMinuto();
    assert.equal(g.religadas, 2, String(est));
  }
  g.estado = false;
  const desligado = path.join(h.env.SESSOES_WPP_DIR, 'desligado');
  fs.writeFileSync(desligado, '');
  h.t += 11 * MIN;
  await h.p.passoMinuto();
  assert.equal(g.religadas, 2, 'parado de proposito');
  fs.rmSync(desligado);
  g.erroReligar = Object.assign(new Error('x'), { code: 'ENOENT' });
  await h.p.passoMinuto();
  assert.equal(g.religadas, 3);
  assert.equal(comLog(h, 'guardiao: estava morto e o .vbs falhou (ENOENT)'), 1);
  h.t += 1 * MIN;
  await h.p.passoMinuto();
  assert.equal(g.religadas, 3, 'a falha tambem respeita os 10 min');

  const ge = dubleGuardiao();
  const ens = montar({ guardiao: ge, ensaio: true });
  await ens.p.passoMinuto();
  assert.equal(ge.religadas, 0, 'o ensaio nunca roda o .vbs');
});

test('T34 2. guardiaoReal: lock aberto pelo guardiao (EBUSY, EPERM, EACCES) = vivo; abriu (sem truncar) ou nao existe = morto; outro erro = sem saber; religar = wscript //nologo no .vbs, escondido e solto', () => {
  const { guardiaoReal } = porteiroMod;
  assert.equal(typeof guardiaoReal, 'function');
  const dir = pastaTemp('porteiro-t34-');
  const lock = path.join(dir, 'guardiao.lock');
  const g = guardiaoReal({ estadoDir: dir, env: { SystemRoot: 'C:\\Win' } });
  assert.equal(g.vivo(), false, 'sem o lock');
  assert.equal(fs.existsSync(lock), false, 'nao cria o lock');
  fs.writeFileSync(lock, 'guardiao desde ontem\r\n');
  assert.equal(g.vivo(), false, 'lock solto');
  assert.equal(fs.readFileSync(lock, 'utf8'), 'guardiao desde ontem\r\n', 'nao trunca');
  const comErro = (code) => guardiaoReal({
    estadoDir: dir, io: { openSync: () => { throw Object.assign(new Error(code), { code }); }, closeSync: () => {} },
  }).vivo();
  for (const c of ['EBUSY', 'EPERM', 'EACCES']) assert.equal(comErro(c), true, c);
  assert.equal(comErro('EIO'), null);
  const modos = [];
  guardiaoReal({ estadoDir: dir, io: { openSync: (a, m) => { modos.push([a, m]); return 7; }, closeSync: () => {} } }).vivo();
  assert.deepEqual(modos, [[lock, 'r+']]);

  const chamadas = [];
  let soltou = 0;
  const spawn = (cmd, args, opts) => {
    chamadas.push([cmd, args, opts]);
    return { on() {}, unref() { soltou += 1; } };
  };
  const vbs = path.join(dir, 'tele', 'sessoes-wpp-porteiro.vbs'); // a guarda da copia aberta barra caminho de maquina
  guardiaoReal({ estadoDir: dir, vbs, env: { SystemRoot: 'C:\\Win' }, spawn }).religar();
  assert.deepEqual(chamadas, [[
    path.join('C:\\Win', 'System32', 'wscript.exe'), ['//nologo', vbs],
    { detached: true, stdio: 'ignore', windowsHide: true },
  ]]);
  assert.equal(soltou, 1);
  // padrao: o .vbs da pasta do porteiro
  chamadas.length = 0;
  guardiaoReal({ estadoDir: dir, env: {}, spawn }).religar();
  assert.equal(chamadas[0][1][1], path.join(path.dirname(new URL('../porteiro.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'sessoes-wpp-porteiro.vbs'));
});

test('T34 3 (T33). o rodar passa o foco do config e o guardiao real (so no Windows, fora do ensaio) ao criarPorteiro', () => {
  const fonte = fs.readFileSync(new URL('../porteiro.mjs', import.meta.url), 'utf8');
  const rodar = fonte.slice(fonte.indexOf('async function rodar('));
  const chamada = rodar.slice(rodar.indexOf('criarPorteiro({'), rodar.indexOf('});', rodar.indexOf('criarPorteiro({')));
  assert.match(chamada, /\bfocoPainel: focoDoConfig\(cfg\),/);
  assert.match(chamada, /\bguardiao: !ehMac\(\) && process\.platform === 'win32' && !ensaio \? guardiaoReal\(\{ estadoDir: C\.estadoDir, env \}\) : null,/);
});
