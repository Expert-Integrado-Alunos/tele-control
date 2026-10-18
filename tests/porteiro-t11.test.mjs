// Testes da T11 (PLANO-TELEGRAM.md, "T11 — as abas fechadas da lista do VS Code no painel"; pedido do dono:
// "tem que pegar todas as sessões que não estão arquivadas ou concluídas"). Antes: o painel do Telegram so mostrava as
// abas abertas e, das fechadas, so as que deixaram pergunta. Agora o "⚪ Fechadas" leva tambem as outras fechadas da lista
// do VS Code (as conversas das 2 janelas que nao estao arquivadas nem no grupo CONCLUÍDO), agrupadas pelo grupo dele; o
// toque no nome da a situacao e responder em cima reabre (T8).
// - T11 1: o que entra e o que nao entra, e a ordem (grupo do VS Code; dentro dele, a mais recente primeiro).
// - T11 2: sem o lerListaVsCode = o painel de antes; lista ilegivel = a linha e 1 log por hora.
// - T11 3: titulo pelo fim do transcript, atualizado quando a conversa muda.
// - T11 4: a situacao da fechada que o porteiro nao conhecia, a frase "Responda aqui pra reabrir." e a resposta que reabre.
// - T11 5 e 6: o leitor real (lerListaVsCodeReal) pelo SESSOES_WPP_VSCODE_DB, e o rodar que passa ele ao criarPorteiro.
// - A3b (PLANO-ABERTO.md, "A3b"): a lista vazia no painel (o que o rodar passa quando o `apps` nao tem o vscode).
// - T14 (PLANO-TELEGRAM.md, "T14"; pedido do dono): o grupo "Fechadas" saiu. A fechada com pergunta vai pro
//   Esperando (marcada) e as outras fechadas da lista entram nas Paradas (marcadas) quando mexeram nas ultimas 48 h, junto
//   das abertas, a que mexeu por ultimo primeiro. Os T11 1 a 4 e o T12 2 seguem esse painel; os T14 no fim.
// Isolamento: pastas temporarias via SESSOES_WPP_DIR, CLAUDE_SESSIONS_DIR, CLAUDE_PROJECTS_DIR e SESSOES_WPP_LOG (nunca o
// ~/.claude real nem o banco do VS Code de verdade); raizes de mentira (repos e Area) dentro da pasta temporaria.
// Nenhuma rede: `tg`, `wpp`, mensageiro, abridor da sessao escondida e a lista do VS Code sao dubles. Harness copiado do
// tests/porteiro-t8.test.mjs.
// Rodar: node --test --test-reporter=tap "tests/porteiro-t11.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { criarPorteiro, lerListaVsCodeReal } from '../porteiro.mjs';
import { raizNormal } from '../lib/lista-vscode.mjs';
import * as listaMod from '../lib/lista-vscode.mjs'; // A3b: a listaVsCodeVazia (por namespace: ausente deixa so o teste dela vermelho)
import { NUMERO_DONO } from './lib/dados-whatsapp.mjs';
import { CENTRAL_TESTE } from './lib/dados-central.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-06T23:00:00Z'); // 20:00 em Brasilia
const iso = (ms) => new Date(ms).toISOString();
const DONO = 700100200;
const BOT = 700900800;
const BOT_NOME = 'Teste_ControleBot';
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// ---------- harness (copia enxuta do tests/porteiro-t8.test.mjs) ----------

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

// Porteiro com o Telegram, o abridor escondido de mentira (`abridor: false` = sem ele) e a lista do VS Code de mentira:
// `h.lista` (null = ilegivel; funcao = o que ela fizer). `lista: false` = sem o lerListaVsCode (o painel de antes).
function montarT11({ abridor = true, lista = true } = {}) {
  const raiz = pastaTemp('porteiro-t11-');
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
    raiz, env, t: T0, idle: 0, entregas: [], nReg: 0, nUpd: 100, nMid: 7000, repos, workspace,
    escondidas: [], mortas: new Set(), lista: { arquivadas: new Set(), grupos: new Map() }, leituras: 0,
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
      return h.mortas.has(p.sessionId) ? { status: 'nao_achei', detalhe: '' } : { status: 'enviado', detalhe: '' };
    },
  };
  h.tg = dubleTg(h);
  const opcoes = {
    wpp, numeroDono: NUMERO_DONO, mensageiro, ocioso: async () => h.idle, agora: () => h.t, env, abrirCentral: () => {}, rand: randFixo(),
    dormir: async (ms) => { h.t += ms; }, raizesSessao: [repos, workspace], ensaio: false,
    tg: h.tg, identTg: { chatId: DONO, botId: BOT },
    central: CENTRAL_TESTE, // A3a: a central como o dono configura
  };
  if (abridor) opcoes.abrirSessaoEscondida = async (pasta, nome, retomada) => { h.escondidas.push([pasta, nome, retomada ?? null]); };
  if (lista) {
    opcoes.lerListaVsCode = () => {
      h.leituras += 1;
      return typeof h.lista === 'function' ? h.lista() : h.lista;
    };
  }
  h.cru = criarPorteiro(opcoes);
  h.p = h.cru;
  h.t += 1000;
  h.tg.usuarioBot = BOT_NOME;
  mexer(h, (e) => { e.tg.offset = 0; });
  return h;
}

const projeto = (raiz) => raiz.replace(/[^A-Za-z0-9]/g, '-'); // a pasta de projeto do Claude Code (c:\projetos -> c--projetos)
// A conversa de uma aba na pasta de projeto da raiz: o titulo, a 1a mensagem (entrypoint e pasta, como o Claude Code
// grava) e, se der, a ultima resposta; a hora do arquivo = `minAtras` minutos antes de agora.
function conversa(h, raiz, sid, { titulo = null, entrypoint = 'claude-vscode', minAtras = 60, final = null, pasta = projeto(raiz), cwd = raiz } = {}) {
  const dir = path.join(h.env.CLAUDE_PROJECTS_DIR, pasta);
  fs.mkdirSync(dir, { recursive: true });
  const linhas = [];
  if (titulo) linhas.push({ type: 'custom-title', customTitle: titulo, sessionId: sid });
  linhas.push({ type: 'user', sessionId: sid, entrypoint, cwd, timestamp: iso(h.t - minAtras * MIN), message: { role: 'user', content: 'oi' } });
  if (final) linhas.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: final }] } });
  const arq = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(arq, linhas.map((x) => `${JSON.stringify(x)}\n`).join(''));
  const quando = new Date(h.t - minAtras * MIN);
  fs.utimesSync(arq, quando, quando);
  return arq;
}
function sessao(h, { sessionId, cwd, entrypoint = 'claude-vscode', status = 'idle' }) {
  h.nReg += 1;
  const reg = { pid: process.pid, sessionId, cwd, entrypoint, name: `repos-${h.nReg}`, nameSource: 'derived', status, updatedAt: h.t };
  fs.writeFileSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${100000 + h.nReg}.json`), JSON.stringify(reg));
}
function sessaoEscondida(h, { sessionId, name, cwd }) {
  h.nReg += 1;
  fs.writeFileSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${100000 + h.nReg}.json`), JSON.stringify({
    pid: process.pid, sessionId, cwd, entrypoint: 'cli', kind: 'interactive', name, nameSource: 'user', status: 'idle', startedAt: h.t, updatedAt: h.t,
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
const linhasSistema = (h) => estado(h).tg.sistema.linhas.map((l) => l.texto);
const painel = (h) => estado(h).tg.painel?.dados ?? null;
function msgTg(h, texto, { respondeA = null } = {}) {
  h.nUpd += 1;
  h.nMid += 1;
  const m = {
    message_id: h.nMid, date: Math.floor(h.t / 1000),
    chat: { id: DONO, type: 'private', first_name: 'Davi' }, from: { id: DONO, is_bot: false, first_name: 'Davi' }, text: texto,
  };
  if (respondeA != null) m.reply_to_message = { message_id: respondeA };
  return { update_id: h.nUpd, message: m };
}
async function falarTg(h, texto, opts) {
  const u = msgTg(h, texto, opts);
  h.tg.lotes.push([u]);
  await h.p.esperarTelegram(15000);
  await bombear(h.cru);
  return u;
}
const enviado = (h) => h.tg.de('enviar').at(-1)?.args[0] ?? null;

// A cena da T11 1: conversas nas 2 raizes, abertas e fechadas, e a lista do VS Code delas.
function cenaT11(h) {
  const { repos, workspace } = h;
  conversa(h, repos, U(1), { titulo: 'Relatório Mensal', minAtras: 60 });
  conversa(h, repos, U(2), { titulo: 'Ajuste do Painel', minAtras: 30 });
  conversa(h, repos, U(3), { titulo: 'Loja Online', minAtras: 90 });
  conversa(h, repos, U(4), { titulo: 'Conteúdo', minAtras: 120 });
  conversa(h, repos, U(5), { titulo: 'Aniversário', minAtras: 10 });
  conversa(h, repos, U(6), { titulo: 'Aba no terminal', entrypoint: 'cli', minAtras: 20 });
  conversa(h, repos, U(32), { minAtras: 5 }); // sem titulo nenhum
  // a pasta de projeto do Workspace com outra caixa (caso real: d--Meus-Docs-... com a letra do disco minuscula)
  const pastaW = projeto(workspace).toLowerCase();
  conversa(h, workspace, U(11), { titulo: 'Site Novo', minAtras: 45, pasta: pastaW });
  conversa(h, workspace, U(12), { titulo: 'Pesquisa para aula', minAtras: 15, pasta: pastaW });
  // fora
  conversa(h, repos, U(21), { titulo: 'Aberta', minAtras: 1 });
  sessao(h, { sessionId: U(21), cwd: repos });
  conversa(h, repos, U(22), { titulo: 'Arquivada', minAtras: 2 });
  conversa(h, repos, U(23), { titulo: 'Concluída', minAtras: 3 });
  conversa(h, repos, U(24), { titulo: 'Central de sessoes de teste', entrypoint: 'cli', minAtras: 4 });
  conversa(h, repos, U(25), { titulo: 'Rotina', entrypoint: 'sdk-cli', minAtras: 6 });
  conversa(h, workspace, U(26), { titulo: 'Desktop', entrypoint: 'claude-desktop', minAtras: 7, pasta: pastaW });
  conversa(h, repos, U(27), { titulo: 'Subpasta', minAtras: 8, pasta: projeto(path.join(repos, 'sessoes-wpp')), cwd: path.join(repos, 'sessoes-wpp') });
  conversa(h, repos, U(28), { titulo: 'Reaberta', minAtras: 9 });
  conversa(h, repos, U(29), { titulo: 'Com pergunta', minAtras: 11 });
  fs.writeFileSync(path.join(h.env.CLAUDE_PROJECTS_DIR, projeto(repos), 'agent-abc.jsonl'), '{"type":"user","entrypoint":"cli"}\n');
  fs.mkdirSync(path.join(h.env.CLAUDE_PROJECTS_DIR, projeto(repos), U(40)), { recursive: true }); // pasta de subagente
  h.lista = {
    arquivadas: new Set([U(22)]),
    grupos: new Map([
      [raizNormal(repos), [
        { nome: '❗Prioridade', ids: [U(1), U(28)] },
        { nome: '🟢 Ativos', ids: [U(2), U(3), U(21), U(22), U(29)] },
        { nome: '🟡 Aguardando', ids: [U(4), U(32)] },
        { nome: '🟠 Backlogs', ids: [] },
        { nome: '✔️ CONCLUÍDO', ids: [U(23)] },
      ]],
      [raizNormal(workspace), [{ nome: '❗Prioridade', ids: [U(11)] }, { nome: 'ℹ️ Aulas', ids: [U(12)] }]],
    ]),
  };
  mexer(h, (e) => {
    e.reabertas = { [U(28)]: { para: U(99), nome: 'Reaberta', desde: iso(h.t - MIN) } };
    e.ultimosParou[U(29)] = { at: iso(h.t - 11 * MIN), finalTs: iso(h.t - 11 * MIN), precisa: true, pergunta: 'Publico?', titulo: 'Com pergunta', nome: 'repos-9' };
  });
}
// T14: as Paradas da cena (a aberta e as fechadas da lista), a que mexeu por ultimo primeiro: [titulo, sid, fechada]
const ESPERADO_PARADAS = [
  ['Aberta', U(21), false],
  ['sem nome', U(32), true],
  ['Aniversário', U(5), true],
  ['Pesquisa para aula', U(12), true],
  ['Aba no terminal', U(6), true],
  ['Ajuste do Painel', U(2), true],
  ['Site Novo', U(11), true],
  ['Relatório Mensal', U(1), true],
  ['Loja Online', U(3), true],
  ['Conteúdo', U(4), true],
];
const SO_ABERTA = [['Aberta', U(21), false]];
const daParadas = (d) => (d.paradas ?? []).map((x) => [x.titulo, x.sid, x.fechada === true]);
const fechadasDe = (d) => daParadas(d).filter((x) => x[2]);

// ---------- 1. o que entra e a ordem ----------

test('T11 1 (T14). painel: as fechadas da lista do VS Code nas Paradas com a marca, junto da aberta, a que mexeu por ultimo primeiro (as 2 janelas juntas); fora: arquivada, concluida, a central, automatica, Desktop, outra pasta, reaberta, a com pergunta (vai pro Esperando, marcada) e arquivo que nao e conversa', async () => {
  const h = montarT11();
  cenaT11(h);
  await falarTg(h, '/painel');
  const d = painel(h);
  assert.deepEqual(daParadas(d), ESPERADO_PARADAS);
  assert.deepEqual(d.esperando.map((x) => [x.titulo, x.sid, x.fechada]), [['Com pergunta', U(29), true]], 'a com pergunta fica so no Esperando, marcada');
  for (const k of ['fechadasLista', 'listaErro']) assert.equal(Object.hasOwn(d, k), false, k);
  assert.deepEqual(d.fechadas, [], 'T14b: tudo mexeu nas ultimas 48 h, nada nas Fechadas');
  const html = enviado(h).html;
  assert.ok(!html.includes('Fechadas') && !html.includes('<h4>'), html);
  assert.ok(html.includes('<summary>🟢 Paradas (10)</summary>'), html);
  assert.ok(html.includes(`<p><b><a href="https://t.me/${BOT_NOME}?start=a_${U(11)}">Site Novo</a></b> (fechada)</p>`), html);
  assert.ok(html.includes(`<p><b><a href="https://t.me/${BOT_NOME}?start=a_${U(21)}">Aberta</a></b></p>`), html);
  assert.ok(html.includes(`<b><a href="https://t.me/${BOT_NOME}?start=a_${U(29)}">Com pergunta</a></b> (fechada) · 19:49`), html);
  assert.equal(h.entregas.length, 0, 'nada vai pra aba nenhuma');
});

// ---------- 2. sem a lista, e lista ilegivel ----------

test('T11 2 (T14). sem o lerListaVsCode = so a aberta nas Paradas (sem listaErro); lista ilegivel (null ou erro) = nenhuma fechada nas Paradas, listaErro e a linha no painel, 1 log por hora; a fechada com pergunta nao depende da lista', async () => {
  const sem = montarT11({ lista: false });
  cenaT11(sem);
  await falarTg(sem, '/painel');
  const d0 = painel(sem);
  assert.deepEqual(daParadas(d0), SO_ABERTA);
  assert.equal(Object.hasOwn(d0, 'listaErro'), false);
  assert.deepEqual(d0.esperando.map((x) => x.sid), [U(29)]);

  const h = montarT11();
  cenaT11(h);
  h.lista = null;
  await falarTg(h, '/painel');
  let d = painel(h);
  assert.deepEqual(daParadas(d), SO_ABERTA);
  assert.deepEqual(d.esperando.map((x) => x.sid), [U(29)]);
  assert.equal(d.listaErro, true);
  assert.ok(enviado(h).html.endsWith('<p>Não consegui ler a lista do VS Code agora.</p>'), enviado(h).html.slice(-200));
  // formato torto (versao nova da extensao muda o valor) = ilegivel tambem, sem derrubar o painel
  const antes = h.tg.de('enviar').length;
  h.lista = { arquivadas: [], grupos: {} };
  await falarTg(h, '/painel');
  assert.equal(h.tg.de('enviar').length, antes + 1, 'saiu um painel novo');
  assert.ok(enviado(h).html.endsWith('<p>Não consegui ler a lista do VS Code agora.</p>'), enviado(h).html.slice(-200));
  d = painel(h);
  assert.deepEqual([daParadas(d), d.listaErro], [SO_ABERTA, true]);
  h.t += 30 * MIN;
  h.lista = () => { throw new Error('banco travado'); };
  await falarTg(h, '/painel');
  d = painel(h);
  assert.deepEqual([daParadas(d), d.listaErro], [SO_ABERTA, true]);
  assert.equal(comLog(h, 'lista do VS Code: nao consegui ler'), 1, 'no maximo 1 log por hora');
  h.t += 31 * MIN;
  await falarTg(h, '/painel');
  assert.equal(comLog(h, 'lista do VS Code: nao consegui ler'), 2);
  // voltou a ler: as fechadas voltam e a linha sai
  cenaT11(h);
  await falarTg(h, '/painel');
  d = painel(h);
  assert.deepEqual(fechadasDe(d), ESPERADO_PARADAS.filter((x) => x[2]));
  assert.equal(d.listaErro, undefined);
});

// ---------- 3. titulo ----------

test('T11 3. titulo = o do fim da conversa (ultimo custom-title, senao ultimo ai-title, no ultimo 1 MB); conversa que mudou = titulo novo e sobe nas Paradas (T14: a que mexeu por ultimo primeiro)', async () => {
  const h = montarT11();
  cenaT11(h);
  // titulo antigo no comeco e 1,2 MB depois: vale o ai-title do fim
  const arq = path.join(h.env.CLAUDE_PROJECTS_DIR, projeto(h.repos), `${U(3)}.jsonl`);
  const enche = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(1000) } })}\n`.repeat(1200);
  fs.appendFileSync(arq, `${enche}${JSON.stringify({ type: 'ai-title', aiTitle: 'Loja Online checkout' })}\n`);
  const velho = new Date(h.t - 90 * MIN);
  fs.utimesSync(arq, velho, velho);
  await falarTg(h, '/painel');
  assert.deepEqual(daParadas(painel(h)).find((x) => x[1] === U(3)), ['Loja Online checkout', U(3), true]);
  // a conversa mexeu (novo titulo, hora nova): titulo novo e sobe no grupo
  const a1 = path.join(h.env.CLAUDE_PROJECTS_DIR, projeto(h.repos), `${U(1)}.jsonl`);
  fs.appendFileSync(a1, `${JSON.stringify({ type: 'custom-title', customTitle: 'Relatório Mensal v2', sessionId: U(1) })}\n`);
  const agora = new Date(h.t - MIN);
  fs.utimesSync(a1, agora, agora);
  h.t += MIN;
  await falarTg(h, '/painel');
  assert.deepEqual(fechadasDe(painel(h)).slice(0, 2), [['Relatório Mensal v2', U(1), true], ['sem nome', U(32), true]]);
});

// ---------- 4. a situacao e a reabertura ----------

test('T11 4 (T18). toque numa fechada da lista que o porteiro nao conhecia: a situacao com o titulo e a ultima mensagem do transcript e "Fechada. Responda aqui pra reabrir."; responder em cima retoma a MESMA conversa (T18, nunca copia) e passa a fala', async () => {
  const h = montarT11();
  cenaT11(h);
  conversa(h, h.repos, U(1), { titulo: 'Relatório Mensal', minAtras: 60, final: 'Terminei a lista.\n\nMando o convite agora?' });
  h.mortas.add(U(1));
  const u = await falarTg(h, `/start a_${U(1)}`);
  const s = enviado(h);
  assert.equal(s.html, '<h2>ℹ️ Relatório Mensal</h2><p><i>Fechada. Responda aqui pra reabrir.</i></p><p>Terminei a lista.</p><p><b>Mando o convite agora?</b></p>');
  assert.equal(s.responderA, undefined, 'T12: sem citar o /start, que sai do chat');
  assert.ok(h.tg.de('apagar').some((c) => c.args[0] === u.message.message_id), 'T12: o /start apagado');
  assert.deepEqual(linhasSistema(h), [], 'nada de "Essa aba fechou."');
  const tela = estado(h).tg.situacao.mensagem.messageId;
  await falarTg(h, 'manda sim', { respondeA: tela });
  assert.deepEqual(h.entregas.map((p) => p.sessionId), [U(1)]);
  assert.equal(h.escondidas.length, 1);
  const [pasta, nome, r] = h.escondidas[0];
  assert.deepEqual([pasta, nome, r], [h.repos, 'Relatório Mensal', { retomar: U(1) }]);
  // a mesma conversa firma (o mensageiro acha de novo) e recebe a mesma fala
  h.t += 3000;
  sessaoEscondida(h, { sessionId: U(1), name: nome, cwd: pasta });
  h.mortas.delete(U(1));
  await h.p.passoSessoes();
  h.t += 10 * 1000;
  await h.p.passoSessoes();
  await bombear(h.cru);
  assert.deepEqual(h.entregas.map((p) => p.sessionId), [U(1), U(1)]);
  assert.ok(h.entregas[1].texto.includes('manda sim'), h.entregas[1].texto);
  // depois de retomada, ela segue nas Paradas como aberta (a mesma, sem a marca de fechada), 1 vez so
  await falarTg(h, '/painel');
  assert.deepEqual(daParadas(painel(h)).filter((x) => x[1] === U(1)), [['Relatório Mensal', U(1), false]]);
});

test('T11 4b. fechada que nao da pra reabrir (Desktop) ou sem o abridor = so "Fechada."; sem transcript = "Essa aba fechou."', async () => {
  const h = montarT11();
  cenaT11(h);
  await falarTg(h, `/start a_${U(26)}`);
  assert.equal(enviado(h).html, '<h2>ℹ️ Desktop</h2><p><i>Fechada.</i></p><p>Ainda sem mensagem dela.</p>');
  await falarTg(h, `/start a_${U(77)}`);
  assert.equal(linhasSistema(h).at(-1), 'Essa aba fechou.');
  const sem = montarT11({ abridor: false });
  cenaT11(sem);
  await falarTg(sem, `/start a_${U(1)}`);
  assert.equal(enviado(sem).html, '<h2>ℹ️ Relatório Mensal</h2><p><i>Fechada.</i></p><p>Ainda sem mensagem dela.</p>');
});

// ---------- 5. o leitor real ----------

test('T11 5 (A3b). lerListaVsCodeReal le o banco do SESSOES_WPP_VSCODE_DB (so a chave da extensao); banco que nao existe = a lista vazia (o VS Code nunca rodou ali)', () => {
  const pasta = pastaTemp('porteiro-t11-db-');
  const arq = path.join(pasta, 'state.vscdb');
  const db = new DatabaseSync(arq);
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('Anthropic.claude-code', JSON.stringify({
    hiddenSessionIds: [U(1)], 'sessionGroups:c:\\projetos': [{ id: 'g', name: '🟢 Ativos', sessionIds: [U(2)] }],
  }));
  db.close();
  const l = lerListaVsCodeReal({ env: { SESSOES_WPP_VSCODE_DB: arq } })();
  assert.deepEqual([...l.arquivadas], [U(1)]);
  assert.deepEqual(l.grupos.get('c:\\projetos'), [{ nome: '🟢 Ativos', ids: [U(2)] }]);
  const v = lerListaVsCodeReal({ env: { SESSOES_WPP_VSCODE_DB: path.join(pasta, 'nao.vscdb') } })();
  assert.deepEqual([v?.arquivadas?.size, v?.grupos?.size], [0, 0]);
});

test('T11 6 (A3b). o rodar passa o leitor real da lista ao criarPorteiro quando o apps tem o vscode, e a lista vazia quando nao tem (senao o painel de verdade fica sem as fechadas)', () => {
  const fonte = fs.readFileSync(new URL('../porteiro.mjs', import.meta.url), 'utf8');
  const rodar = fonte.slice(fonte.indexOf('async function rodar('));
  const chamada = rodar.slice(rodar.indexOf('criarPorteiro({'), rodar.indexOf('});', rodar.indexOf('criarPorteiro({')));
  assert.match(chamada, /\blerListaVsCode: apps\.includes\('vscode'\) \? lerListaVsCodeReal\(\{ env, banco: bancoVsCodeDoConfig\(cfg\) \}\) : listaVsCodeVazia,/);
});

test('A3b (T11). a lista vazia (listaVsCodeVazia, o que o rodar passa sem o vscode no apps): as fechadas das pastas de projeto entram nas Paradas sem grupo, tambem as que o VS Code arquivou ou concluiu (sem a lista nao da pra saber), e o painel sai sem a linha de erro', async () => {
  assert.equal(typeof listaMod.listaVsCodeVazia, 'function', 'listaVsCodeVazia exportada');
  const h = montarT11();
  cenaT11(h);
  h.lista = listaMod.listaVsCodeVazia;
  await falarTg(h, '/painel');
  const d = painel(h);
  assert.deepEqual(daParadas(d), [
    ['Aberta', U(21), false],
    ['Arquivada', U(22), true],
    ['Concluída', U(23), true],
    ['sem nome', U(32), true],
    ['Aniversário', U(5), true],
    ['Pesquisa para aula', U(12), true],
    ['Aba no terminal', U(6), true],
    ['Ajuste do Painel', U(2), true],
    ['Site Novo', U(11), true],
    ['Relatório Mensal', U(1), true],
    ['Loja Online', U(3), true],
    ['Conteúdo', U(4), true],
  ]);
  assert.ok((d.paradas ?? []).every((x) => (x.grupo ?? null) === null), 'sem grupo');
  assert.equal(Object.hasOwn(d, 'listaErro'), false);
  assert.ok(!enviado(h).html.includes('Não consegui ler a lista'), enviado(h).html.slice(-200));
  assert.deepEqual(d.esperando.map((x) => x.sid), [U(29)], 'a com pergunta segue no Esperando');
  assert.equal(comLog(h, 'lista do VS Code: nao consegui ler'), 0);
});

// ---------- T12: o toque no nome da aba no painel (PLANO-TELEGRAM.md, T12; pedido do dono) ----------
// "/start" do toque apagado, situacao sem citar, a aba tocada sai do painel (edicao) ate mudar de lugar, o painel vivo.

// O registro da aba `sid` com outro status (o mesmo arquivo: o sessoesVivas fica com o 1o de cada sessionId).
function statusDe(h, sid, status) {
  for (const nome of fs.readdirSync(h.env.CLAUDE_SESSIONS_DIR)) {
    const arq = path.join(h.env.CLAUDE_SESSIONS_DIR, nome);
    const reg = JSON.parse(fs.readFileSync(arq, 'utf8'));
    if (reg.sessionId !== sid) continue;
    fs.writeFileSync(arq, JSON.stringify({ ...reg, status, updatedAt: h.t }));
    return;
  }
  throw new Error(`statusDe: sem registro de ${sid}`);
}
const editadas = (h, id) => h.tg.de('editar').filter((c) => c.args[0] === id).map((c) => c.args[1]);
const comLink = (html, sid) => html.includes(`start=a_${sid}"`);
// uma volta do Telegram sem fala dele, `seg` segundos depois
async function volta(h, seg) {
  h.t += seg * 1000;
  await h.p.esperarTelegram(1000);
}

test('T12 1. toque no nome da aba: o "/start" sai do chat antes da situacao, que nao cita ele; a aba sai do painel na tela (edicao, sem mensagem nova)', async () => {
  const h = montarT11();
  cenaT11(h);
  sessao(h, { sessionId: U(29), cwd: h.repos }); // "Com pergunta" aberta = esperando
  await falarTg(h, '/painel');
  const idPainel = estado(h).tg.painel.mensagem.messageId;
  assert.deepEqual(painel(h).esperando.map((x) => x.sid), [U(29)]);
  h.tg.zerar();
  const u = await falarTg(h, `/start a_${U(29)}`);
  const mid = u.message.message_id;
  const ordem = h.tg.chamadas.filter((c) => c.metodo !== 'lerAtualizacoes').map((c) => [c.metodo, c.metodo === 'enviar' ? 'situacao' : c.args[0]]);
  assert.deepEqual(ordem.slice(0, 2), [['apagar', mid], ['enviar', 'situacao']], JSON.stringify(ordem));
  const sit = h.tg.de('enviar')[0].args[0];
  assert.ok(sit.html.startsWith('<h2>ℹ️ Com pergunta</h2>'), sit.html);
  assert.equal(sit.responderA, undefined, 'a situacao nao cita o /start (apagado)');
  assert.equal(h.tg.de('enviar').length, 1, 'o painel nao sai de novo');
  const ed = editadas(h, idPainel);
  assert.equal(ed.length, 1);
  assert.ok(!comLink(ed[0].html, U(29)), 'a aba tocada sai do painel');
  assert.ok(ed[0].html.includes('<p>Nada esperando resposta sua.</p>'), ed[0].html);
  assert.ok(comLink(ed[0].html, U(21)), 'o resto fica');
  assert.deepEqual(painel(h).esperando, []);
  assert.ok(Object.hasOwn(estado(h).painelTg.tocadas, U(29)));
  assert.equal(h.entregas.length, 0, 'nada vai pra aba');
});

test('T12 2. a aba tocada fica fora enquanto esta no mesmo lugar e volta quando muda (parada -> trabalhando); /painel novo traz todas de volta', async () => {
  const h = montarT11();
  cenaT11(h);
  await falarTg(h, '/painel');
  const idPainel = estado(h).tg.painel.mensagem.messageId;
  await falarTg(h, `/start a_${U(21)}`); // "Aberta", parada
  assert.equal(painel(h).paradas.some((x) => x.sid === U(21)), false);
  // nada mudou: o painel vivo nao edita (so a hora mudaria)
  h.tg.zerar();
  await volta(h, 31);
  assert.deepEqual(editadas(h, idPainel), []);
  // ela comeca a trabalhar: volta, em Trabalhando
  statusDe(h, U(21), 'busy');
  await volta(h, 31);
  const ed = editadas(h, idPainel);
  assert.equal(ed.length, 1);
  assert.ok(ed[0].html.includes('🟡 Trabalhando (1)') && comLink(ed[0].html, U(21)), ed[0].html);
  assert.deepEqual(painel(h).trabalhando.map((x) => x.sid), [U(21)]);
  assert.equal(Object.hasOwn(estado(h).painelTg.tocadas, U(21)), false, 'mudou de lugar: sai das tocadas');
  // tocou de novo (trabalhando) e pediu outro painel: o novo traz todas
  await falarTg(h, `/start a_${U(21)}`);
  assert.deepEqual(painel(h).trabalhando, []);
  await falarTg(h, '/painel');
  assert.deepEqual(painel(h).trabalhando.map((x) => x.sid), [U(21)]);
  assert.deepEqual(estado(h).painelTg.tocadas, {});
});

test('T12 3. o painel vivo: edita em silencio so quando muda algo fora a hora, no maximo a cada 30 s; sem painel = nada; edicao recusada = o painel sai e nao volta sozinho', async () => {
  const h = montarT11();
  cenaT11(h);
  await volta(h, 31);
  assert.deepEqual([h.tg.de('enviar').length, h.tg.de('editar').length], [0, 0], 'sem painel na tela = nada');
  await falarTg(h, '/painel');
  const idPainel = estado(h).tg.painel.mensagem.messageId;
  h.tg.zerar();
  await volta(h, 31);
  assert.deepEqual(editadas(h, idPainel), [], 'so a hora mudou');
  // aba nova abre: no maximo a cada 30 s
  conversa(h, h.repos, U(42), { titulo: 'Nova', minAtras: 0 });
  sessao(h, { sessionId: U(42), cwd: h.repos });
  await volta(h, 10);
  assert.deepEqual(editadas(h, idPainel), [], 'menos de 30 s da ultima conferencia');
  await volta(h, 25);
  const ed = editadas(h, idPainel);
  assert.equal(ed.length, 1);
  assert.ok(comLink(ed[0].html, U(42)), ed[0].html);
  assert.equal(h.tg.de('enviar').length, 0, 'edicao, sem mensagem nova (sem notificar)');
  assert.equal(painel(h).abertas, 2);
  // o dono apagou o painel: a edicao e recusada e o painel sai, sem mensagem nova
  h.tg.editar = async (messageId, pedido) => {
    h.tg.chamadas.push({ metodo: 'editar', args: [messageId, pedido] });
    return { ok: false, erro: 'editMessageText: Bad Request: message to edit not found', codigo: 400 };
  };
  statusDe(h, U(42), 'busy');
  await volta(h, 31);
  assert.equal(editadas(h, idPainel).length, 2);
  assert.equal(estado(h).tg.painel.mensagem, null);
  statusDe(h, U(42), 'idle');
  await volta(h, 31);
  assert.equal(editadas(h, idPainel).length, 2, 'nao tenta de novo');
  assert.equal(h.tg.de('enviar').length, 0, 'e nao manda outro painel sozinho');
});

test('T12 4. "Essa aba fechou." (aba sem transcript) continua em cima do "/start", que fica; "/start" sozinho = o painel, sem apagar nada', async () => {
  const h = montarT11();
  cenaT11(h);
  const u = await falarTg(h, `/start a_${U(77)}`);
  assert.equal(linhasSistema(h).at(-1), 'Essa aba fechou.');
  assert.equal(enviado(h).responderA, u.message.message_id);
  assert.deepEqual(h.tg.de('apagar'), []);
  h.tg.zerar();
  const s = await falarTg(h, '/start');
  assert.ok(enviado(h).html.startsWith('<h3>Abas abertas: 1</h3>'), enviado(h).html);
  assert.equal(enviado(h).responderA, s.message.message_id);
  assert.deepEqual(h.tg.de('apagar'), []);
});

test('T12 5. aba esperando tocada volta quando chega pergunta nova (a hora da pergunta muda o lugar); travado = o painel vivo nao mexe', async () => {
  const h = montarT11();
  cenaT11(h);
  sessao(h, { sessionId: U(29), cwd: h.repos });
  await falarTg(h, '/painel');
  const idPainel = estado(h).tg.painel.mensagem.messageId;
  await falarTg(h, `/start a_${U(29)}`);
  assert.deepEqual(painel(h).esperando, []);
  // a aba parou de novo com outra pergunta (hora nova): volta em "Esperando"
  mexer(h, (e) => {
    e.ultimosParou[U(29)] = { ...e.ultimosParou[U(29)], at: iso(h.t), finalTs: iso(h.t), pergunta: 'E agora, publico?' };
  });
  h.tg.zerar();
  await volta(h, 31);
  const ed = editadas(h, idPainel);
  assert.equal(ed.length, 1);
  assert.ok(comLink(ed[0].html, U(29)), ed[0].html);
  assert.deepEqual(painel(h).esperando.map((x) => x.sid), [U(29)]);
  // travado: nada mexe no painel, mesmo com mudanca
  mexer(h, (e) => { e.trava = true; });
  statusDe(h, U(21), 'busy');
  h.tg.zerar();
  await volta(h, 31);
  assert.deepEqual(editadas(h, idPainel), []);
});

// ---------- T14: o painel por pergunta e por movimento (PLANO-TELEGRAM.md, T14; pedido do dono) ----------
// Esperando = toda conversa com pergunta (a fechada marcada); Paradas = sem pergunta e mexeu nas ultimas 48 h; o resto e a
// concluida pelo botao "Concluir" da situacao saiam do painel (e do pendencias) ate algo mais novo que a conclusao. T14b: o
// resto vai pro "⚪ Fechadas". T14c: o "Concluir" saiu.

const HORA = 60 * MIN;
// Registro de aba aberta com os campos dados (sem os do sessao(): hora do status, sem hora nenhuma...).
function registro(h, campos) {
  h.nReg += 1;
  fs.writeFileSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${100000 + h.nReg}.json`), JSON.stringify({
    pid: process.pid, cwd: h.repos, entrypoint: 'claude-vscode', name: `repos-${h.nReg}`, nameSource: 'derived', ...campos,
  }));
}
function toqueTg(h, dados, messageId) {
  h.nUpd += 1;
  return {
    update_id: h.nUpd,
    callback_query: { id: `q${h.nUpd}`, from: { id: DONO, is_bot: false }, message: { message_id: messageId, chat: { id: DONO, type: 'private' } }, data: dados },
  };
}
async function tocarTg(h, dados, messageId) {
  h.tg.lotes.push([toqueTg(h, dados, messageId)]);
  await h.p.esperarTelegram(15000);
  await bombear(h.cru);
}
const parouCom = (h, sid, minAtras, pergunta, titulo) => ({
  at: iso(h.t - minAtras * MIN), finalTs: iso(h.t - minAtras * MIN), precisa: true, pergunta, titulo, nome: 'repos-x',
});

test('T14 1. Esperando = toda conversa com pergunta, aberta ou fechada (a fechada marcada; a pergunta nao vence em 24 h, so em 30 dias), na ordem da hora; quem tem pergunta nao repete nas Paradas', async () => {
  const h = montarT11();
  cenaT11(h);
  conversa(h, h.repos, U(30), { titulo: 'Viva com pergunta', minAtras: 50 });
  sessao(h, { sessionId: U(30), cwd: h.repos });
  conversa(h, h.repos, U(31), { titulo: 'Velha com pergunta', minAtras: 72 * 60 });
  mexer(h, (e) => {
    e.ultimosParou[U(30)] = parouCom(h, U(30), 50, 'Sigo?', 'Viva com pergunta');
    e.ultimosParou[U(31)] = parouCom(h, U(31), 72 * 60, 'Fecho o mês?', 'Velha com pergunta');
    e.ultimosParou[U(39)] = parouCom(h, U(39), 31 * 24 * 60, 'De 31 dias?', 'Muito velha');
    e.ultimosParou[U(41)] = { at: iso(h.t - 25 * HORA), finalTs: iso(h.t - 25 * HORA), precisa: false };
  });
  await falarTg(h, '/painel'); // a poda corre no salvar: o 2o painel ja sai sem o que venceu
  await falarTg(h, '/painel');
  const d = painel(h);
  assert.deepEqual(d.esperando.map((x) => [x.sid, x.fechada === true]), [[U(31), true], [U(30), false], [U(29), true]]);
  const up = estado(h).ultimosParou;
  assert.deepEqual([Object.hasOwn(up, U(31)), Object.hasOwn(up, U(39)), Object.hasOwn(up, U(41))], [true, false, false], 'poda: pergunta 30 dias, o resto 24 h');
  const html = enviado(h).html;
  assert.ok(html.includes('<summary>🔴 Esperando você (3)</summary>'), html);
  assert.ok(html.includes(`start=a_${U(31)}">Velha com pergunta</a></b> (fechada) · 03/10 20:00<br>Fecho o mês?`), html);
  assert.ok(html.includes(`start=a_${U(30)}">Viva com pergunta</a></b> · 19:10<br>Sigo?`), html);
  assert.equal(daParadas(d).some((x) => [U(29), U(30), U(31)].includes(x[1])), false);
});

test('T14 2. Paradas = sem pergunta e mexeu nas ultimas 48 h: fechada pela hora do transcript, aberta pela hora do status (senao updatedAt, senao startedAt; sem hora nenhuma fica); a janela anda; "Abas abertas" conta todas as vivas', async () => {
  const h = montarT11();
  cenaT11(h);
  conversa(h, h.repos, U(33), { titulo: 'Fechada 47 h', minAtras: 47 * 60 });
  conversa(h, h.repos, U(34), { titulo: 'Fechada 49 h', minAtras: 49 * 60 });
  registro(h, { sessionId: U(35), status: 'idle', statusUpdatedAt: h.t - 49 * HORA, updatedAt: h.t }); // o status vence
  registro(h, { sessionId: U(36), status: 'idle', statusUpdatedAt: h.t - 47 * HORA });
  registro(h, { sessionId: U(37), status: 'idle', startedAt: h.t - 49 * HORA });
  registro(h, { sessionId: U(38), status: 'idle' }); // sem hora nenhuma
  await falarTg(h, '/painel');
  let ids = daParadas(painel(h)).map((x) => x[1]);
  assert.ok(ids.includes(U(33)) && !ids.includes(U(34)), 'fechada: 47 h fica, 49 h sai');
  assert.ok(ids.includes(U(36)) && !ids.includes(U(35)) && !ids.includes(U(37)), 'aberta: pela hora do status, senao do comeco');
  assert.ok(ids.includes(U(38)), 'aberta sem hora nenhuma fica');
  const fe = () => painel(h).fechadas.map((x) => x.sid).sort();
  assert.deepEqual(fe(), [U(34), U(35), U(37)].sort(), 'T14b: o que passou de 48 h (aberta ou fechada) vai pras Fechadas');
  assert.ok(painel(h).fechadas.every((x) => x.grupo === null), 'fora dos grupos do VS Code = Sem grupo');
  assert.ok(enviado(h).html.includes('<summary>⚪ Fechadas (3)</summary><h4><b>Sem grupo</b></h4>'), enviado(h).html);
  assert.equal(painel(h).abertas, 5);
  assert.ok(enviado(h).html.startsWith('<h3>Abas abertas: 5</h3>'));
  // 2 h depois: as de 47 h saem
  h.t += 2 * HORA;
  await falarTg(h, '/painel');
  ids = daParadas(painel(h)).map((x) => x[1]);
  assert.ok(!ids.includes(U(33)) && !ids.includes(U(36)) && ids.includes(U(38)), ids.join(' '));
  assert.deepEqual(fe(), [U(33), U(34), U(35), U(36), U(37)].sort(), 'a janela anda: as de 47 h vao pras Fechadas');
});

const semConcluir = (env) => !(env.botoes ?? []).flat().some((b) => String(b.dados).startsWith('z:'));

test('T14 3 (T14c). o "Concluir" saiu: a situacao nao tem o botao em lugar nenhum (Esperando, Paradas aberta e fechada, Fechadas, Trabalhando); o z: de uma situacao de antes = "Essa pergunta já mudou." e nada muda', async () => {
  const h = montarT11();
  cenaT11(h);
  conversa(h, h.repos, U(34), { titulo: 'Fechada 49 h', minAtras: 49 * 60 });
  await falarTg(h, '/painel');
  assert.ok(painel(h).fechadas.some((x) => x.sid === U(34)));
  for (const sid of [U(29), U(21), U(5), U(34)]) { // Esperando, Paradas (aberta), Paradas (fechada), Fechadas
    await falarTg(h, `/start a_${sid}`);
    assert.ok(semConcluir(enviado(h)), `${sid} ${JSON.stringify(enviado(h).botoes)}`);
    assert.equal(Object.hasOwn(estado(h).tg.situacao.dados, 'concluir'), false, sid);
  }
  statusDe(h, U(21), 'busy');
  await falarTg(h, `/start a_${U(21)}`);
  assert.ok(semConcluir(enviado(h)), 'trabalhando');
  // o z: de uma situacao de antes (ainda no chat dele) = toque velho; nada muda
  const s = estado(h).tg.situacao;
  h.tg.zerar();
  await tocarTg(h, `z:${s.chamadoId}`, s.mensagem.messageId);
  assert.deepEqual(h.tg.de('responderToque').map((c) => c.args[1]), ['Essa pergunta já mudou.']);
  assert.equal(Object.hasOwn(estado(h).painelTg, 'concluidas'), false);
  assert.deepEqual([h.entregas.length, h.escondidas.length], [0, 0], 'nada vai pra aba nem reabre');
});

test('T14c 1. estado de antes com as conclusoes (painelTg.concluidas): ignorado (cada aba no lugar dela, a pergunta no Esperando) e o campo sai do disco; painelTg torto = vazio', async () => {
  const h = montarT11();
  cenaT11(h);
  mexer(h, (e) => { e.painelTg = { tocadas: {}, conferidoEm: null, concluidas: { [U(29)]: iso(h.t), [U(21)]: iso(h.t), [U(3)]: iso(h.t) } }; });
  await falarTg(h, '/painel');
  const d = painel(h);
  assert.deepEqual(d.esperando.map((x) => x.sid), [U(29)]);
  assert.deepEqual(daParadas(d), ESPERADO_PARADAS);
  assert.deepEqual(d.fechadas, []);
  assert.deepEqual(Object.keys(estado(h).painelTg).sort(), ['conferidoEm', 'tocadas']);
  mexer(h, (e) => { e.painelTg = 'lixo'; });
  await falarTg(h, '/painel');
  assert.deepEqual(Object.keys(estado(h).painelTg).sort(), ['conferidoEm', 'tocadas']);
  assert.deepEqual(estado(h).painelTg.tocadas, {});
});

// ---------- T14b: o grupo Fechadas volta (PLANO-TELEGRAM.md, T14b; pedido do dono) ----------
// "antes eu conseguia ver todas as fechadas, agora eu nao consigo mais" / "eu preciso conseguir ver as mensagens que eu
// fechei": o que sai do Esperando e das Paradas (parada ha mais de 48 h; T14c: a concluida pelo botao saiu junto com ele) vai pro "⚪ Fechadas",
// pelos grupos do VS Code, em vez de sumir.

test('T14b 1. Fechadas: as paradas ha mais de 48 h (fechadas da lista e abertas) pelos grupos do VS Code (as 2 janelas juntas pelo nome; a aberta pelo grupo dela), "Sem grupo" no fim, a que mexeu por ultimo primeiro; fora: arquivada, grupo de concluidas, central, automatica, Desktop, outra pasta, reaberta e a com pergunta (Esperando)', async () => {
  const h = montarT11();
  cenaT11(h);
  h.t += 49 * HORA;
  await falarTg(h, '/painel');
  const d = painel(h);
  assert.deepEqual(d.paradas, []);
  assert.deepEqual(d.esperando.map((x) => x.sid), [U(29)], 'a pergunta continua (30 dias)');
  assert.deepEqual(d.fechadas.map((x) => [x.titulo, x.sid, x.grupo]), [
    ['Site Novo', U(11), 'Prioridade'],
    ['Relatório Mensal', U(1), 'Prioridade'],
    ['Aberta', U(21), 'Ativos'],
    ['Ajuste do Painel', U(2), 'Ativos'],
    ['Loja Online', U(3), 'Ativos'],
    ['sem nome', U(32), 'Aguardando'],
    ['Conteúdo', U(4), 'Aguardando'],
    ['Pesquisa para aula', U(12), 'Aulas'],
    ['Aniversário', U(5), null],
    ['Aba no terminal', U(6), null],
  ]);
  for (const x of d.fechadas) assert.equal(Object.hasOwn(x, 'fechada'), false, 'sem a marca');
  const html = enviado(h).html;
  assert.ok(html.includes(`<details><summary>⚪ Fechadas (10)</summary><h4><b>Prioridade</b></h4><p><b><a href="https://t.me/${BOT_NOME}?start=a_${U(11)}">Site Novo</a></b></p>`), html);
  assert.ok(html.includes(`<h4><b>Sem grupo</b></h4><p><b><a href="https://t.me/${BOT_NOME}?start=a_${U(5)}">Aniversário</a></b></p>`), html);
  assert.ok(!html.includes('(fechada)</p>') && !html.includes('🟢 Paradas'), html);
  assert.equal(h.entregas.length, 0);
});

test('T14b 2. o toque no nome de uma Fechada: a situacao sem o Concluir; ela sai do painel na tela (T12, lugar "fechadas") e volta no painel novo; lista ilegivel = so as abertas nas Fechadas, Sem grupo', async () => {
  const h = montarT11();
  cenaT11(h);
  h.t += 49 * HORA;
  await falarTg(h, '/painel');
  const idPainel = estado(h).tg.painel.mensagem.messageId;
  h.tg.zerar();
  await falarTg(h, `/start a_${U(3)}`); // "Loja Online", fechada
  const sit = h.tg.de('enviar')[0].args[0];
  assert.ok(sit.html.startsWith('<h2>ℹ️ Loja Online</h2>'), sit.html);
  assert.ok(semConcluir(sit), JSON.stringify(sit.botoes));
  const ed = editadas(h, idPainel);
  assert.equal(ed.length, 1);
  assert.ok(!comLink(ed[0].html, U(3)) && ed[0].html.includes('⚪ Fechadas (9)'), ed[0].html);
  assert.equal(estado(h).painelTg.tocadas[U(3)], 'fechadas');
  // nada mudou: fica fora; o painel novo traz de volta
  h.tg.zerar();
  await volta(h, 31);
  assert.deepEqual(editadas(h, idPainel), []);
  await falarTg(h, '/painel');
  assert.ok(painel(h).fechadas.some((x) => x.sid === U(3)));
  // a lista do VS Code ilegivel: so a aberta (sem grupo) e a linha da lista
  h.lista = null;
  await falarTg(h, '/painel');
  assert.deepEqual(painel(h).fechadas, [{ titulo: 'Aberta', sid: U(21), grupo: null }]);
  assert.equal(painel(h).listaErro, true);
  assert.ok(enviado(h).html.endsWith('</details><p>Não consegui ler a lista do VS Code agora.</p>'), enviado(h).html.slice(-200));
});
