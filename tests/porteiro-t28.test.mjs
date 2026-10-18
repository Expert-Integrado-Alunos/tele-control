// Testes da T28 no porteiro (PLANO-TELEGRAM.md, "T28"; pedido do dono 16/10/2026 08:29 e 18/10 15:36; troca do 18/10
// 15:49: «Deixa sem os X vermelhos, só em negrito ... Tem um emoji que é tipo um sinal de replay. Pode ser ele.»): o OK
// que expirou (sem resposta, ou Sim nao conferido) fica na mensagem com a linha do fecho em negrito e o botao
// "🔄 Tentar novamente" (dados r:<COD>); o toque nele (do dono, no chat dele, ate 24 h depois do vencimento, 1 vez) manda
// 1 recado "Tentar novamente" pra aba EXATA do pedido, com a nota de pedir o OK de novo, e a tela troca o botao pela 2a
// linha. Por que existe: o OK vencido sumia sem rastro e o dono tinha de ir ao PC pedir de novo; o toque nunca pode virar
// Sim nem mandar recado a partir de toque forjado, velho ou repetido.
// Isolamento: pastas temporarias (prefixo "t28-") via SESSOES_WPP_DIR, CLAUDE_SESSIONS_DIR, CLAUDE_PROJECTS_DIR e
// SESSOES_WPP_LOG; nunca o ~/.claude real. Nenhuma rede: o `tg` e um duble (lotes roteirizados; o resto grava as chamadas).
// Relogio e `dormir` falsos. Harness copiado do tests/porteiro-t26.test.mjs (sem importar de outro teste).
// Rodar: node --test --test-reporter=tap "tests/porteiro-t28.test.mjs"
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { criarPorteiro, destravar } from '../porteiro.mjs';
import { montarBlocoOk, montarBlocoOkFechado, montarOkTg, montarOkTgFechado } from '../lib/ok-tg.mjs';
import { horaBRT } from '../lib/formato.mjs';
import { montarRecado } from '../mensageiro.mjs';
import { NUMERO_DONO } from './lib/dados-whatsapp.mjs';
import { CENTRAL_TESTE, RAIZES_TESTE } from './lib/dados-central.mjs';

const require = createRequire(import.meta.url);
const lib = require('../hooks/lib/sessoes-wpp.js');

const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-18T15:00:00Z'); // 12:00 em Brasilia
const iso = (ms) => new Date(ms).toISOString();
const DONO = 700100200;
const BOT = 700900800;
const ACAO = 'subir o site X em produção';
const ANOTEI_SIM = 'Anotei: Sim. Passando pra aba.';
const OK_NOS_BOTOES = 'O pedido de OK se responde nos botões Sim e Não da mensagem dele.';
const FINAL = 'Terminei a revisão do site.\n\n---\n🔴 **DECISÃO:** Publico agora? A) Sim (recomendado) / B) Não';
const DECISAO = { decisao: true, fica: false, pergunta: false };

// ---------- harness ----------

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

// Duble do criarTelegram: os message_id saem de UM contador (h.nMid), o do dono e o do bot intercalados. Cada chamada que
// cria mensagem guarda o id devolvido (`id`). Fila de lotes vazia = long poll sem nada: o relogio anda esperaS.
function dubleTg(h) {
  const tg = { chamadas: [], lotes: [] };
  const gravar = (metodo, args, id) => { tg.chamadas.push({ metodo, args, id }); };
  const novoId = () => { h.nMid += 1; return h.nMid; };
  tg.lerAtualizacoes = async (args) => {
    gravar('lerAtualizacoes', [{ ...args }]);
    if (tg.chamadas.length > 20000) throw new Error('duble: leitura demais (laco sem fim?)');
    const lote = tg.lotes.shift();
    if (lote === undefined) {
      h.t += (Number(args?.esperaS) || 0) * 1000;
      return [];
    }
    return lote;
  };
  const criar = (metodo, extra = () => ({})) => async (pedido) => {
    const id = novoId();
    gravar(metodo, [pedido], id);
    return { ok: true, messageId: id, ...extra(pedido) };
  };
  // como o telegram.mjs: com html = sendRichMessage ('rich'); sem html = sendMessage com o classico ('classico')
  tg.enviar = criar('enviar', (pedido) => ({ formato: typeof pedido?.html === 'string' && pedido.html !== '' ? 'rich' : 'classico' }));
  tg.enviarVoz = criar('enviarVoz');
  tg.enviarTexto = criar('enviarTexto'); // o pedido de OK do caminho de hoje
  tg.editar = async (messageId, pedido) => { gravar('editar', [messageId, pedido]); return { ok: true }; };
  tg.editarTexto = async (messageId, pedido) => { gravar('editarTexto', [messageId, pedido]); return { ok: true }; };
  tg.editarBotoes = async (messageId, botoes) => { gravar('editarBotoes', [messageId, botoes]); return { ok: true }; };
  tg.apagar = async (messageId) => { gravar('apagar', [messageId]); return { ok: true }; };
  tg.responderToque = async (id, texto) => { gravar('responderToque', [id, texto]); return { ok: true }; };
  tg.baixar = async () => ({ ok: false, erro: 'duble sem download' });
  tg.quemSou = async () => { gravar('quemSou', []); return { ok: true, id: BOT, username: 'Teste_ControleBot' }; };
  tg.definirComandos = async (c) => { gravar('definirComandos', [c]); return { ok: true }; };
  tg.de = (metodo) => tg.chamadas.filter((c) => c.metodo === metodo);
  return tg;
}

// config.json com o OK pelo botao ligado; `naAba` so entra se vier (ausente = ligada). O aviso sai pelo Telegram
// (canalPrincipal 'telegram' + modo rua).
// T26c2: `prefixo` da pasta, `respostasEntrega` (o mensageiro devolve na ordem; vazio = enviado) e `resolvidasTg`.
// T28t: `canalPrincipal` null = sem a opcao (o aviso da aba sai no grupo, como no tests/porteiro-ok-tg.test.mjs); o
// duble do WhatsApp grava as reacoes e as edicoes do grupo.
function montar({ naAba, prefixo = 't28-', respostasEntrega = [], resolvidasTg, canalPrincipal = 'telegram' } = {}) {
  const raiz = pastaTemp(prefixo);
  const env = {
    SESSOES_WPP_DIR: path.join(raiz, 'estado'),
    CLAUDE_SESSIONS_DIR: path.join(raiz, 'sessions'),
    CLAUDE_PROJECTS_DIR: path.join(raiz, 'projects'),
    SESSOES_WPP_LOG: path.join(raiz, 'porteiro.log'),
  };
  for (const d of [env.SESSOES_WPP_DIR, env.CLAUDE_SESSIONS_DIR, env.CLAUDE_PROJECTS_DIR]) fs.mkdirSync(d, { recursive: true });
  const ok = naAba === undefined ? { ligado: true } : { ligado: true, naAba };
  fs.writeFileSync(path.join(env.SESSOES_WPP_DIR, 'config.json'), JSON.stringify({ telegram: { ligado: true, ok } }));
  const h = { raiz, env, t: T0, idle: 0, grupo: [], enviados: [], reacoes: [], edicoesGrupo: [], entregas: [], nReg: 0, nUpd: 100, nMid: 7000 };
  let seq = 0;
  h.wpp = {
    async lerGrupo(limit) { return h.grupo.slice(-limit); },
    async enviarGrupo(texto, opts) {
      h.enviados.push({ texto, opts });
      seq += 1;
      return { ok: true, providerMsgId: `P${seq}`, messageId: `U${seq}` };
    },
    async reagir(messageId, emoji) { h.reacoes.push({ messageId, emoji }); return { ok: true }; },
    async editarGrupo(messageId, texto) { h.edicoesGrupo.push({ messageId, texto }); return { ok: true }; },
  };
  const fila = [...respostasEntrega];
  h.mensageiro = {
    async entregar(p) {
      h.entregas.push(p);
      return fila.length ? fila.shift() : { status: 'enviado', detalhe: '' };
    },
  };
  h.tg = dubleTg(h);
  h.opcoes = {
    wpp: h.wpp, numeroDono: NUMERO_DONO, mensageiro: h.mensageiro, ocioso: async () => h.idle, agora: () => h.t, env, ensaio: false,
    abrirCentral: () => {}, rand: randFixo(), dormir: async (ms) => { h.t += ms; },
    tg: h.tg, identTg: { chatId: DONO, botId: BOT }, central: CENTRAL_TESTE, raizesSessao: RAIZES_TESTE,
  };
  if (canalPrincipal !== null) h.opcoes.canalPrincipal = canalPrincipal;
  if (resolvidasTg !== undefined) h.opcoes.resolvidasTg = resolvidasTg;
  h.cru = criarPorteiro(h.opcoes);
  h.p = comBomba(h.cru);
  h.t += 1000; // o que o teste cria nasce depois do estado novo (e do iniciadoEm)
  return h;
}

function sessao(h, { sessionId, name = 'projetos-42', status = 'idle', pid = process.pid, entrypoint = 'claude-vscode' }) {
  h.nReg += 1;
  const reg = { pid, sessionId, cwd: 'c:\\projetos', entrypoint, name, nameSource: 'derived', status, updatedAt: h.t };
  fs.writeFileSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${100000 + h.nReg}.json`), JSON.stringify(reg));
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
function parou(h, sessionId, o = {}) {
  return {
    v: 1, tipo: 'parou', at: iso(h.t), sessionId, pid: process.pid, nome: o.nome ?? 'projetos-42', titulo: o.titulo ?? null,
    cwd: 'C:\\projetos', entrypoint: 'claude-vscode', final: o.final ?? 'Feito.', finalTs: o.finalTs ?? iso(h.t),
    marcas: o.marcas ?? { decisao: false, fica: false, pergunta: false },
  };
}
const evento = (h, ev) => lib.anexarEvento(h.env.SESSOES_WPP_DIR, ev);
const estado = (h) => JSON.parse(fs.readFileSync(path.join(h.env.SESSOES_WPP_DIR, 'estado.json'), 'utf8'));
function mexer(h, fn) {
  const arq = path.join(h.env.SESSOES_WPP_DIR, 'estado.json');
  const e = JSON.parse(fs.readFileSync(arq, 'utf8'));
  fn(e);
  fs.writeFileSync(arq, JSON.stringify(e));
}
const ligarTg = (h) => mexer(h, (e) => { e.tg.offset = 0; }); // historico ja pulado
async function ligarRua(h) {
  h.idle = 30 * MIN;
  await h.p.passoMinuto();
  assert.equal(estado(h).modoRua.ligado, true);
}
const chamado = (h, sid) => estado(h).tg.chamados[sid];
const okDe = (h, cod) => estado(h).okTg?.mensagens?.[cod];
const desde = (h, marca) => h.tg.chamadas.slice(marca);
const respostas = (chs) => chs.filter((c) => c.metodo === 'responderToque').map((c) => (c.args[1] === undefined ? null : c.args[1]));
const recadosOk = (h) => h.entregas.filter((x) => typeof x.providerMsgId === 'string' && x.providerMsgId.startsWith('tgok-u'));
const comBotaoDoOk = (pedido, cod) => Array.isArray(pedido?.botoes) && pedido.botoes.flat().some((b) => b?.dados === `k:${cod}:s`);

// O texto que o Telegram mostra (e devolve no toque) de uma mensagem clássica: a conta do semTags do telegram.mjs.
function semTags(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}
// A ultima versao (enviar ou editar) da mensagem `id`: {classico, html, botoes}.
function ultimaVersao(h, id) {
  let v = null;
  for (const c of h.tg.chamadas) {
    if (c.metodo === 'enviar' && c.id === id) v = c.args[0];
    if (c.metodo === 'editar' && c.args[0] === id) v = c.args[1];
  }
  return v;
}

// Mensagem do dono no chat do bot (como o getUpdates devolve).
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
const apiTeclado = (botoes) => ({
  inline_keyboard: botoes.map((l) => l.map((b) => ({ text: b.texto, callback_data: b.dados, ...(b.estilo ? { style: b.estilo } : {}) }))),
});
// Toque num botao do OK na tela `messageId`, como o getUpdates devolve: o texto e o teclado que a tela mostra.
function toqueNaTela(h, p, acao, { messageId, texto, botoes }) {
  h.nUpd += 1;
  return {
    update_id: h.nUpd,
    callback_query: {
      id: `q${h.nUpd}`, from: { id: DONO, is_bot: false, first_name: 'Davi' }, chat_instance: '-1',
      data: `k:${p.codigo}:${{ sim: 's', nao: 'n', info: 'i' }[acao]}`,
      message: {
        message_id: messageId, from: { id: BOT, is_bot: true, first_name: 'Bot de Teste' }, chat: { id: DONO, type: 'private', first_name: 'Davi' },
        date: Math.floor(h.t / 1000), text: texto, reply_markup: apiTeclado(botoes),
      },
    },
  };
}
// Toque com o texto e o teclado que a tela mostra agora.
function toqueNaTelaDeAgora(h, p, acao, tela) {
  const v = ultimaVersao(h, tela);
  return toqueNaTela(h, p, acao, { messageId: tela, texto: semTags(v.classico), botoes: v.botoes });
}

// Pedido de OK como o ok-wpp grava (oks/<COD>.json).
const arqOk = (h, cod) => path.join(h.env.SESSOES_WPP_DIR, 'oks', `${cod}.json`);
function pedidoOk(h, { codigo = 'ABC234', sessionId = 'S1', criado = h.t } = {}) {
  fs.mkdirSync(path.dirname(arqOk(h, codigo)), { recursive: true });
  const p = {
    v: 1, codigo, sessionId, titulo: 'Faro', tipo: 'publicacao', acao: ACAO, hashAcao: 'h', destinatarios: null,
    criadoEm: iso(criado), expiraEm: iso(criado + 30 * MIN), providerMsgId: `PED-${codigo}`, messageId: `UPED-${codigo}`, status: 'pendente',
  };
  fs.writeFileSync(arqOk(h, codigo), JSON.stringify(p, null, 2));
  return p;
}

// Aba S1 "Faro", Telegram com o historico pulado, modo rua; o que a subida pos na fila ja saiu.
async function preparar(h) {
  aba(h, 'S1', 'Faro');
  ligarTg(h);
  await ligarRua(h);
  await h.p.esperarTelegram(2000);
}
// + 1 pedido de OK novo, ja na tela da aba. Devolve {p, marca (antes do pedido), tela}.
async function comOkNaAba(h, o = {}) {
  await preparar(h);
  const marca = h.tg.chamadas.length;
  const p = pedidoOk(h, o);
  await h.p.esperarTelegram(2000);
  const c = chamado(h, 'S1');
  assert.ok(c && c.mensagem && Number.isSafeInteger(c.mensagem.messageId), 'a mensagem da aba saiu');
  return { p, marca, tela: c.mensagem.messageId };
}
// + a resposta da aba 1 s depois (o aviso com DECISAO pelo Telegram).
async function abaResponde(h) {
  h.t += 1000;
  evento(h, parou(h, 'S1', { final: FINAL, marcas: DECISAO }));
  await h.p.passoEventos();
  await h.p.esperarTelegram(2000);
}
const logs = (h) => {
  try { return fs.readFileSync(h.env.SESSOES_WPP_LOG, 'utf8').split('\n').filter(Boolean); } catch { return []; }
};
function mudarPedido(h, cod, campos) {
  const p = JSON.parse(fs.readFileSync(arqOk(h, cod), 'utf8'));
  fs.writeFileSync(arqOk(h, cod), JSON.stringify({ ...p, ...campos }, null, 2));
}
const usadoPeloTg = (u, id, t) => ({
  status: 'usado', usadoEm: iso(t), verificadoPor: { canal: 'telegram', updateId: u.update_id, messageId: id, texto: 'Sim', conferidoEm: iso(t) },
});
// o pedido do enviar (args[0]) ou do editar (args[1])
const conteudo = (c) => (c.metodo === 'editar' ? c.args[1] : c.args[0]);
const semBotoes = (pedido) => !Array.isArray(pedido?.botoes) || pedido.botoes.flat().length === 0;
const temBotaoK = (pedido) => Array.isArray(pedido?.botoes) && pedido.botoes.flat().some((b) => String(b?.dados ?? '').startsWith('k:'));
// Toque na tela da aba com o que ela mostra agora; o recado vai pra aba (bombear).
async function tocarNaAba(h, p, acao, tela) {
  const u = toqueNaTelaDeAgora(h, p, acao, tela);
  h.tg.lotes.push([u]);
  await h.p.esperarTelegram(5000);
  await bombear(h.cru);
  return u;
}
const apagadasDesde = (h, marca) => desde(h, marca).filter((c) => c.metodo === 'apagar').map((c) => c.args[0]);
// O recado entregue, como o transcript da aba mostra (copiado do tests/porteiro-t23.test.mjs).
function peer(pedido, ts) {
  const texto = `Another Claude session sent a message (from repos-99):\n<cross-session-message from="repos-99">\n${montarRecado(pedido)}\n</cross-session-message>`;
  return { type: 'user', isMeta: true, origin: { kind: 'peer', from: 'repos-99' }, timestamp: ts, message: { role: 'user', content: texto } };
}
// a linha de log do porteiro (nao a do canal) da recusa do pedido `cod`
const recusasDoPorteiro = (h, cod) => logs(h).filter((l) => l.includes(`Telegram: pedido de OK ${cod} recusado`));

// ---------------------------------------------------------------------------------------------------------------
// T28

const BOTAO = (cod) => [[{ texto: '🔄 Tentar novamente', dados: `r:${cod}` }]];
const recadosDeNovo = (h) => h.entregas.filter((x) => String(x.providerMsgId ?? '').startsWith('tgdn-u'));
const temR = (chs) => chs.some((c) => JSON.stringify(c.args).includes('"r:'));
// Toque no "Tentar novamente" (dados r:<COD>) na mensagem `messageId`; cada campo trocavel pra forjar 1 coisa por vez.
function toqueR(h, cod, { messageId, from, chat, msgFrom } = {}) {
  h.nUpd += 1;
  return {
    update_id: h.nUpd,
    callback_query: {
      id: `q${h.nUpd}`, from: from ?? { id: DONO, is_bot: false, first_name: 'Davi' }, chat_instance: '-1', data: `r:${cod}`,
      message: {
        message_id: messageId, from: msgFrom ?? { id: BOT, is_bot: true, first_name: 'Bot de Teste' },
        chat: chat ?? { id: DONO, type: 'private', first_name: 'Davi' }, date: Math.floor(h.t / 1000), text: 'o que a tela mostra',
      },
    },
  };
}
async function tocarR(h, u) {
  h.tg.lotes.push([u]);
  await h.p.esperarTelegram(5000);
  await bombear(h.cru);
}
// O OK na tela da aba vence sem toque: devolve {p, tela, ed (o editar do fecho)}
async function vencidoNaAba(h, o = {}) {
  const { p, tela } = await comOkNaAba(h, o);
  h.t = Date.parse(p.expiraEm) + 1000;
  const marca = h.tg.chamadas.length;
  await h.p.esperarTelegram(2000);
  const eds = desde(h, marca).filter((c) => c.metodo === 'editar' && c.args[0] === tela);
  return { p, tela, ed: eds.at(-1), novas: desde(h, marca) };
}
const fimForte = (p, linha) => {
  const fechado = montarBlocoOkFechado({ ...p, linha });
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `${esc(fechado.slice(0, -linha.length))}<b>${esc(linha)}</b>`;
};

describe('T28', () => {
  test('a. vencido sem toque -> 1 edicao da MESMA mensagem: a linha em negrito (sem ❌) e o botao 🔄 Tentar novamente; nenhuma mensagem nova', async () => {
    const h = montar({ prefixo: 't28-' });
    const { p, tela, ed, novas } = await vencidoNaAba(h);
    assert.equal(novas.filter((c) => c.metodo === 'editar').length, 1, JSON.stringify(novas.map((c) => c.metodo)));
    const linha = `Expirou às ${horaBRT(p.expiraEm)} sem resposta.`;
    assert.ok(ed.args[1].classico.endsWith(`\n\n${fimForte(p, linha)}`), ed.args[1].classico);
    assert.ok(!ed.args[1].classico.includes('❌'));
    assert.deepEqual(ed.args[1].botoes, BOTAO(p.codigo));
    assert.equal(novas.filter((c) => ['enviar', 'enviarTexto', 'editarTexto', 'apagar'].includes(c.metodo)).length, 0, 'nada novo');
    assert.equal(okDe(h, p.codigo).fim, 'expirou');
    assert.equal(tela, chamado(h, 'S1').mensagem.messageId);
  });

  test('b. Sim nao conferido (vence com o Sim tocado) -> o mesmo: a linha "... não conferiu até ...: expirou." em negrito e o botao', async () => {
    const h = montar({ prefixo: 't28-' });
    const { p, tela } = await comOkNaAba(h);
    const tToque = h.t;
    await tocarNaAba(h, p, 'sim', tela);
    h.t = Date.parse(p.expiraEm) + 1000;
    const marca = h.tg.chamadas.length;
    await h.p.esperarTelegram(2000);
    const eds = desde(h, marca).filter((c) => c.metodo === 'editar' && c.args[0] === tela);
    assert.equal(eds.length, 1, JSON.stringify(desde(h, marca).map((c) => c.metodo)));
    const linha = `Você tocou em Sim às ${horaBRT(iso(tToque))}, mas a aba não conferiu até ${horaBRT(p.expiraEm)}: expirou.`;
    assert.ok(eds[0].args[1].classico.endsWith(`\n\n${fimForte(p, linha)}`), eds[0].args[1].classico);
    assert.deepEqual(eds[0].args[1].botoes, BOTAO(p.codigo));
    assert.equal(desde(h, marca).filter((c) => ['enviar', 'enviarTexto', 'editarTexto'].includes(c.metodo)).length, 0);
  });

  test('c. conferido, cancelado (Nao) e problema -> nenhum botao r: em nenhuma chamada (como hoje)', async () => {
    { // conferido com a resposta na tela
      const h = montar({ prefixo: 't28-' });
      const { p, tela } = await comOkNaAba(h);
      await abaResponde(h);
      const u = await tocarNaAba(h, p, 'sim', tela);
      h.t += 1000;
      mudarPedido(h, p.codigo, usadoPeloTg(u, tela, h.t));
      await h.p.esperarTelegram(2000);
      assert.equal(temR(h.tg.chamadas), false, 'conferido');
      assert.equal(okDe(h, p.codigo).fim, 'conferido');
    }
    { // Nao tocado e recusado pelo Telegram
      const h = montar({ prefixo: 't28-' });
      const { p, tela } = await comOkNaAba(h);
      const u = await tocarNaAba(h, p, 'nao', tela);
      h.t += 1000;
      mudarPedido(h, p.codigo, { status: 'recusado', decididoEm: iso(h.t), verificadoPor: { canal: 'telegram', updateId: u.update_id, messageId: tela, texto: 'Não', conferidoEm: iso(h.t) } });
      await h.p.esperarTelegram(2000);
      assert.equal(temR(h.tg.chamadas), false, 'cancelado');
      assert.equal(okDe(h, p.codigo).fim, 'cancelado');
    }
    { // problema na entrega do Sim
      const h = montar({ prefixo: 't28-', respostasEntrega: [{ status: 'nao_achei', detalhe: '' }] });
      const { p, tela } = await comOkNaAba(h);
      await tocarNaAba(h, p, 'sim', tela);
      assert.equal(okDe(h, p.codigo).fim, 'problema');
      assert.equal(temR(h.tg.chamadas), false, 'problema');
    }
  });

  test('d. OK aberto + a aba encerra (guardado) + vence -> a tela do encerrado com a linha dele e o bloco com o botao', async () => {
    const h = montar({ prefixo: 't28-' });
    const { p, tela } = await comOkNaAba(h);
    await abaResponde(h);
    h.t += MIN;
    evento(h, parou(h, 'S1', { final: 'Segui com outra coisa.' }));
    await h.p.passoEventos();
    await h.p.esperarTelegram(2000);
    assert.ok(chamado(h, 'S1').encerrarDepois, `o encerrar ficou guardado: ${JSON.stringify(chamado(h, 'S1').versao.estado)}`);
    h.t = Date.parse(p.expiraEm) + 1000;
    const marca = h.tg.chamadas.length;
    await h.p.esperarTelegram(2000);
    const eds = desde(h, marca).filter((c) => c.metodo === 'editar' && c.args[0] === tela);
    assert.ok(eds.length >= 1, JSON.stringify(desde(h, marca).map((c) => c.metodo)));
    const ult = eds.at(-1).args[1];
    assert.ok(/^<b>[^\n]*Faro<\/b>\n<i>Encerrada às \d\d:\d\d: a aba seguiu no PC\.<\/i>\n\n/.test(ult.classico), ult.classico);
    assert.ok(ult.classico.endsWith(fimForte(p, `Expirou às ${horaBRT(p.expiraEm)} sem resposta.`)), ult.classico);
    assert.deepEqual(ult.botoes, BOTAO(p.codigo));
    assert.equal(chamado(h, 'S1').versao.estado, 'encerrado');
  });

  test('e. toque valido -> "Pedindo de novo à aba." no topo, 1 recado Tentar novamente pra S1 (tgdn-u, nota do pedir, sem ok), o botao sai e a 2a linha entra; 2o toque = "Já pedi de novo"; nada no grupo nem no chamado', async () => {
    const h = montar({ prefixo: 't28-' });
    const { p, tela } = await vencidoNaAba(h);
    h.t += 5 * MIN;
    const tToque = h.t;
    const estadoAntes = chamado(h, 'S1').versao.estado;
    const marca = h.tg.chamadas.length;
    const u = toqueR(h, p.codigo, { messageId: tela });
    await tocarR(h, u);
    assert.deepEqual(respostas(desde(h, marca)), ['Pedindo de novo à aba.']);
    const rec = recadosDeNovo(h);
    assert.equal(rec.length, 1);
    assert.equal(rec[0].sessionId, 'S1');
    assert.equal(rec[0].texto, 'Tentar novamente');
    assert.equal(rec[0].providerMsgId, `tgdn-u${u.update_id}`);
    assert.equal(rec[0].canal, 'telegram');
    assert.equal(rec[0].ok, undefined, 'sem o campo ok');
    assert.ok(rec[0].nota.includes(`O pedido de OK ${p.codigo} expirou às ${horaBRT(p.expiraEm)} sem a aba conferir`), rec[0].nota);
    assert.ok(/node \S*ok-wpp\.mjs pedir/.test(rec[0].nota), rec[0].nota);
    assert.ok(!rec[0].nota.includes(ACAO) && !rec[0].texto.includes(ACAO), 'sem a acao');
    const eds = desde(h, marca).filter((c) => c.metodo === 'editar' && c.args[0] === tela);
    assert.equal(eds.length, 1, JSON.stringify(desde(h, marca).map((c) => c.metodo)));
    assert.ok(eds[0].args[1].classico.endsWith(`<b>Expirou às ${horaBRT(p.expiraEm)} sem resposta.</b>\nPedi de novo à aba às ${horaBRT(iso(tToque))}.`), eds[0].args[1].classico);
    assert.equal(eds[0].args[1].botoes, null);
    assert.equal(okDe(h, p.codigo).deNovoEm, iso(tToque));
    assert.deepEqual(h.enviados, [], 'nada no grupo');
    assert.equal(chamado(h, 'S1').versao.estado, estadoAntes, 'o chamado da aba nao vira entregue');
    const linhas = logs(h).filter((l) => l.includes('tentar novamente'));
    assert.ok(linhas.length >= 1);
    assert.ok(linhas.every((l) => !l.includes(ACAO)), 'log sem a acao');

    const marca2 = h.tg.chamadas.length;
    await tocarR(h, toqueR(h, p.codigo, { messageId: tela }));
    assert.deepEqual(respostas(desde(h, marca2)), [`Já pedi de novo às ${horaBRT(iso(tToque))}.`]);
    assert.equal(recadosDeNovo(h).length, 1, '2o toque: nada vai pra aba');
  });

  test('f. nao confere: 24 h + 1 min = "antigo"; outro chat, nao-dono, mensagem de outro bot, pedido no prazo e pedido usado = "Essa pergunta já mudou."; travado = a frase da trava; nada vai pra aba', async () => {
    { // 24 h + 1 min; e 24 h em ponto ainda vale
      const h = montar({ prefixo: 't28-' });
      const { p, tela } = await vencidoNaAba(h);
      h.t = Date.parse(p.expiraEm) + 24 * 60 * MIN;
      const marca = h.tg.chamadas.length;
      await tocarR(h, toqueR(h, p.codigo, { messageId: tela }));
      assert.deepEqual(respostas(desde(h, marca)), ['Pedindo de novo à aba.'], '24 h em ponto vale');
      const h2 = montar({ prefixo: 't28-' });
      const v2 = await vencidoNaAba(h2);
      h2.t = Date.parse(v2.p.expiraEm) + 24 * 60 * MIN + MIN;
      const marca2 = h2.tg.chamadas.length;
      await tocarR(h2, toqueR(h2, v2.p.codigo, { messageId: v2.tela }));
      assert.deepEqual(respostas(desde(h2, marca2)), ['Esse pedido é antigo. Peça de novo na aba.']);
      assert.equal(recadosDeNovo(h2).length, 0);
    }
    { // forjados
      const h = montar({ prefixo: 't28-' });
      const { p, tela } = await vencidoNaAba(h);
      const forjados = [
        ['outro chat', { chat: { id: -100123, type: 'supergroup', title: 'G' } }],
        ['nao-dono', { from: { id: 555, is_bot: false, first_name: 'X' } }],
        ['mensagem de outro bot', { msgFrom: { id: 1234, is_bot: true, first_name: 'Outro' } }],
      ];
      for (const [nome, o] of forjados) {
        const marca = h.tg.chamadas.length;
        await tocarR(h, toqueR(h, p.codigo, { messageId: tela, ...o }));
        // o canal ja descarta toque de fora do chat do dono (nenhuma resposta); o que passa = "Essa pergunta já mudou."
        const r = respostas(desde(h, marca));
        assert.ok(r.length === 0 || (r.length === 1 && r[0] === 'Essa pergunta já mudou.'), `${nome}: ${JSON.stringify(r)}`);
        assert.equal(recadosDeNovo(h).length, 0, nome);
      }
      mudarPedido(h, p.codigo, { status: 'usado', usadoEm: iso(h.t) });
      const marca = h.tg.chamadas.length;
      await tocarR(h, toqueR(h, p.codigo, { messageId: tela }));
      assert.deepEqual(respostas(desde(h, marca)), ['Essa pergunta já mudou.'], 'pedido usado');
      assert.equal(recadosDeNovo(h).length, 0);
    }
    { // pedido ainda no prazo (aberto)
      const h = montar({ prefixo: 't28-' });
      const { p, tela } = await comOkNaAba(h);
      const marca = h.tg.chamadas.length;
      await tocarR(h, toqueR(h, p.codigo, { messageId: tela }));
      assert.deepEqual(respostas(desde(h, marca)), ['Essa pergunta já mudou.'], 'no prazo');
      assert.equal(recadosDeNovo(h).length, 0);
    }
    { // travado
      const h = montar({ prefixo: 't28-' });
      const { p, tela } = await vencidoNaAba(h);
      mexer(h, (e) => { e.trava = true; });
      const marca = h.tg.chamadas.length;
      await tocarR(h, toqueR(h, p.codigo, { messageId: tela }));
      assert.deepEqual(respostas(desde(h, marca)), ['Travado. Destrava no PC.']);
      assert.equal(recadosDeNovo(h).length, 0);
    }
  });

  test('g. problema na entrega do recado (nao_achei) -> a 2a linha vira "Não consegui pedir de novo à aba: ..."; o botao nao volta; nada no grupo; a aba nao e reaberta', async () => {
    const h = montar({ prefixo: 't28-', respostasEntrega: [{ status: 'nao_achei', detalhe: '' }] });
    const { p, tela } = await vencidoNaAba(h);
    const marca = h.tg.chamadas.length;
    await tocarR(h, toqueR(h, p.codigo, { messageId: tela }));
    assert.equal(recadosDeNovo(h).length, 1, 'o recado foi tentado');
    const ult = desde(h, marca).filter((c) => c.metodo === 'editar' && c.args[0] === tela).at(-1).args[1];
    assert.ok(/<\/b>\nNão consegui pedir de novo à aba: Não achei a sessão Faro aberta no PC\. [^\n]*$/.test(ult.classico), ult.classico);
    assert.equal(ult.botoes, null);
    assert.deepEqual(h.enviados, []);
    assert.equal(h.entregas.length, 1, 'nenhuma outra entrega (nada de reabrir)');
  });

  test('h. naAba false (mensagem separada) -> o fecho vencido = editarTexto com o texto de hoje (sem negrito nem simbolo) e o botao; o toque = editarTexto com a 2a linha e sem botao, e o recado', async () => {
    const h = montar({ prefixo: 't28-', naAba: false });
    await preparar(h);
    const p = pedidoOk(h);
    await h.p.esperarTelegram(2000);
    const id = h.tg.de('enviarTexto')[0].id;
    h.t = Date.parse(p.expiraEm) + 1000;
    const marca = h.tg.chamadas.length;
    await h.p.esperarTelegram(2000);
    const eds = desde(h, marca).filter((c) => c.metodo === 'editarTexto');
    assert.equal(eds.length, 1);
    const linha = `Expirou às ${horaBRT(p.expiraEm)} sem resposta.`;
    assert.deepEqual(eds[0].args, [id, { texto: montarOkTgFechado({ ...p, linha }).texto, botoes: BOTAO(p.codigo) }]);
    h.t += MIN;
    const tToque = h.t;
    const marca2 = h.tg.chamadas.length;
    await tocarR(h, toqueR(h, p.codigo, { messageId: id }));
    assert.deepEqual(respostas(desde(h, marca2)), ['Pedindo de novo à aba.']);
    const eds2 = desde(h, marca2).filter((c) => c.metodo === 'editarTexto');
    assert.deepEqual(eds2.map((c) => c.args), [[id, { texto: `${montarOkTgFechado({ ...p, linha }).texto}\nPedi de novo à aba às ${horaBRT(iso(tToque))}.` }]]);
    assert.equal(recadosDeNovo(h).length, 1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T28t: 1 teste por mutante da tools/integrar/sabotagens/t28.mjs que passava na 1a rodada (#35, #44, #45, #48, #49, #60,
// #64-#69 e #77). Os desvios do recado (#64-#69) seguem os testes 85b, 85c, 90, 90b, 90c e 92b do
// tests/porteiro-ok-tg.test.mjs (os mesmos desvios do recado do Sim/Nao), com o toque em "Tentar novamente".

const MUDOU = 'Essa pergunta já mudou.';
const ehTgdn = (x) => String(x?.providerMsgId ?? '').startsWith('tgdn-u');
// Canal principal WhatsApp (o aviso da aba sai no grupo), mensagem separada: a aba para com DECISAO (o aviso no grupo) e
// o OK de S1, criado 25 min antes, vence 5 min depois (o toque cabe nos 14 min do aviso: um recado comum o viraria
// "Concluído"). -> {p, id}
async function vencidoComAvisoNoGrupo(h) {
  aba(h, 'S1', 'Faro');
  ligarTg(h);
  await ligarRua(h);
  const tRua = h.t;
  const p = pedidoOk(h);
  await h.p.esperarTelegram(15000);
  const id = okDe(h, p.codigo).messageId;
  h.t = Date.parse(p.expiraEm) - 5 * MIN;
  h.idle = 30 * MIN + (h.t - tRua); // o PC segue ocioso desde o modo rua; o passoMinuto o mantem fresco
  await h.p.passoMinuto();
  evento(h, parou(h, 'S1', { final: FINAL, marcas: DECISAO }));
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 1, 'o aviso da aba saiu no grupo');
  assert.ok(Object.values(estado(h).avisos).some((a) => a.sessionId === 'S1'));
  h.enviados.length = 0;
  h.t = Date.parse(p.expiraEm) + 1000;
  await h.p.esperarTelegram(2000);
  assert.equal(okDe(h, p.codigo).fim, 'expirou');
  return { p, id };
}
const nadaNoGrupo = (h, caso) => {
  assert.deepEqual(h.edicoesGrupo, [], `${caso}: o aviso da aba no grupo nao vira "Concluído"`);
  assert.deepEqual(h.enviados, [], `${caso}: nenhum envio no grupo`);
  assert.deepEqual(h.reacoes, [], `${caso}: nenhuma reacao`);
  assert.deepEqual(estado(h).saida, [], `${caso}: nada na fila do grupo`);
};
// A central C1 (mensagem separada, sem modo rua) com o OK dela vencido. -> {p, id}
async function vencidoNaCentral(h) {
  aba(h, 'C1', 'Central de sessões de teste', CENTRAL_TESTE.nome);
  ligarTg(h);
  const p = pedidoOk(h, { sessionId: 'C1' });
  await h.p.esperarTelegram(15000);
  const id = okDe(h, p.codigo).messageId;
  h.t = Date.parse(p.expiraEm) + 1000;
  await h.p.esperarTelegram(2000);
  assert.equal(okDe(h, p.codigo).fim, 'expirou');
  return { p, id };
}

describe('T28t', () => {
  test('#35. fecho "não vale" (status desconhecido) e "sumiu" (arquivo apagado) nunca ganham o botao r: (na aba e na mensagem separada)', async () => {
    const casos = [
      ['nao vale (aba)', undefined, (h, p) => mudarPedido(h, p.codigo, { status: 'cancelado' }), 'nao-vale'],
      ['nao vale (separada)', false, (h, p) => mudarPedido(h, p.codigo, { status: 'cancelado' }), 'nao-vale'],
      ['sumiu (aba)', undefined, (h, p) => fs.rmSync(arqOk(h, p.codigo)), 'sumiu'],
    ];
    for (const [caso, naAba, mudar, fim] of casos) {
      const h = montar({ naAba });
      await preparar(h);
      const p = pedidoOk(h);
      await h.p.esperarTelegram(2000);
      const marca = h.tg.chamadas.length;
      mudar(h, p);
      h.t += 1000;
      await h.p.esperarTelegram(2000);
      assert.equal(okDe(h, p.codigo).fim, fim, caso);
      assert.ok(desde(h, marca).some((c) => ['editar', 'editarTexto'].includes(c.metodo)), `${caso}: o fecho saiu`);
      assert.equal(temR(h.tg.chamadas), false, `${caso}: nenhum botao r:`);
    }
  });

  test('#44. pedido de volta ao prazo (estado fabricado: a entrada fechou como expirou e o expiraEm foi pra frente) -> "Essa pergunta já mudou.", nada vai pra aba', async () => {
    const h = montar();
    const { p, tela } = await vencidoNaAba(h);
    mudarPedido(h, p.codigo, { expiraEm: iso(h.t + 10 * MIN) });
    const marca = h.tg.chamadas.length;
    await tocarR(h, toqueR(h, p.codigo, { messageId: tela }));
    assert.deepEqual(respostas(desde(h, marca)), [MUDOU]);
    assert.equal(recadosDeNovo(h).length, 0);
    assert.equal(okDe(h, p.codigo).deNovoEm ?? null, null);
  });

  test('#45. pedido vencido sem sessionId (null ou vazio) -> "Essa pergunta já mudou.", nada vai pra aba', async () => {
    const h = montar();
    const { p, tela } = await vencidoNaAba(h);
    for (const sid of [null, '']) {
      mudarPedido(h, p.codigo, { sessionId: sid });
      const marca = h.tg.chamadas.length;
      await tocarR(h, toqueR(h, p.codigo, { messageId: tela }));
      assert.deepEqual(respostas(desde(h, marca)), [MUDOU], `sessionId ${JSON.stringify(sid)}`);
    }
    assert.deepEqual(h.entregas, []);
    assert.equal(okDe(h, p.codigo).deNovoEm ?? null, null);
  });

  test('#48. entrada com fim "expirou" e sem fechadoEm (estado fabricado: o fecho falhou e so volta em 30 s) -> "Essa pergunta já mudou.", nada vai pra aba', async () => {
    const h = montar({ naAba: false });
    await preparar(h);
    const p = pedidoOk(h);
    await h.p.esperarTelegram(2000);
    const id = h.tg.de('enviarTexto')[0].id;
    const editarTexto = h.tg.editarTexto;
    let falhas = 1;
    h.tg.editarTexto = async (mid, pedido) => {
      if (falhas > 0) {
        falhas -= 1;
        h.tg.chamadas.push({ metodo: 'editarTexto', args: [mid, pedido] });
        return { ok: false, erro: 'duble: transporte' };
      }
      return editarTexto(mid, pedido);
    };
    h.t = Date.parse(p.expiraEm) + 1000;
    await h.p.esperarTelegram(2000);
    assert.equal(falhas, 0, 'o fecho foi tentado');
    assert.ok(!okDe(h, p.codigo).fechadoEm, 'o fecho falhou: a entrada segue aberta');
    mexer(h, (e) => { e.okTg.mensagens[p.codigo].fim = 'expirou'; });
    const marca = h.tg.chamadas.length;
    await tocarR(h, toqueR(h, p.codigo, { messageId: id }));
    assert.deepEqual(respostas(desde(h, marca)), [MUDOU]);
    assert.equal(recadosDeNovo(h).length, 0);
  });

  test('#49. entrada fechada com outro fim (estado fabricado: "problema") -> "Essa pergunta já mudou.", nada vai pra aba', async () => {
    const h = montar();
    const { p, tela } = await vencidoNaAba(h);
    mexer(h, (e) => { e.okTg.mensagens[p.codigo].fim = 'problema'; });
    assert.ok(okDe(h, p.codigo).fechadoEm);
    const marca = h.tg.chamadas.length;
    await tocarR(h, toqueR(h, p.codigo, { messageId: tela }));
    assert.deepEqual(respostas(desde(h, marca)), [MUDOU]);
    assert.equal(recadosDeNovo(h).length, 0);
  });

  test('#60. a nota do recado manda PEDIR o OK de novo (ok-wpp pedir, codigo novo), nunca verificar', async () => {
    const h = montar();
    const { p, tela } = await vencidoNaAba(h);
    await tocarR(h, toqueR(h, p.codigo, { messageId: tela }));
    const { nota } = recadosDeNovo(h)[0];
    assert.ok(nota.includes('peça o OK de novo agora (ok-wpp pedir, código novo: node '), nota);
    assert.ok(!nota.includes('verificar'), nota);
  });

  test('#64 e #65. aviso da aba no grupo: o recado entregue (aplicarResultado) e o recado que ja estava na aba (registrarJaNaAba) nao mexem no grupo', async () => {
    { // enviado
      const h = montar({ naAba: false, canalPrincipal: null });
      const { p, id } = await vencidoComAvisoNoGrupo(h);
      await tocarR(h, toqueR(h, p.codigo, { messageId: id }));
      const rec = recadosDeNovo(h);
      assert.equal(rec.length, 1);
      assert.ok(estado(h).entregas[rec[0].providerMsgId], 'a entrega e registrada');
      nadaNoGrupo(h, 'enviado');
    }
    { // erro na 1a, mas ja no transcript da aba: a nova tentativa passa pelo registrarJaNaAba
      const h = montar({ naAba: false, canalPrincipal: null, respostasEntrega: [{ status: 'erro', detalhe: 'claude -p estourou o tempo' }] });
      const { p, id } = await vencidoComAvisoNoGrupo(h);
      await tocarR(h, toqueR(h, p.codigo, { messageId: id }));
      assert.equal(estado(h).repassar.length, 1, '1a tentativa: erro -> nova tentativa');
      const rec = recadosDeNovo(h)[0];
      h.t += 2000;
      transcript(h, 'S1', [peer(rec, iso(h.t))]);
      h.t += 31 * 1000;
      await h.p.passoGrupo();
      assert.ok(logs(h).some((l) => /entrega S1: recado ja estava na aba/.test(l)), 'o caminho do registrarJaNaAba');
      assert.equal(h.entregas.length, 1, 'nao reenvia');
      assert.ok(estado(h).entregas[rec.providerMsgId], 'a entrega e registrada');
      nadaNoGrupo(h, 'ja na aba');
    }
  });

  test('#66. o recado entregue nao mexe no chamado da aba: a fala do dono em cima da tela esta em nova tentativa e o chamado segue "enviando"', async () => {
    const h = montar();
    h.mensageiro.entregar = async (x) => {
      h.entregas.push(x);
      return ehTgdn(x) ? { status: 'enviado', detalhe: '' } : { status: 'erro', detalhe: 'estourou o tempo' };
    };
    const { p, tela } = await vencidoNaAba(h);
    const fala = msgTg(h, 'manda o resumo antes', { respondeA: tela });
    const u = toqueR(h, p.codigo, { messageId: tela });
    h.tg.lotes.push([fala, u]);
    await h.p.esperarTelegram(15000);
    await bombear(h.cru);
    await h.p.esperarTelegram(5000);
    const e = estado(h);
    assert.deepEqual(h.entregas.map((x) => x.texto), ['manda o resumo antes', 'Tentar novamente']);
    assert.ok(e.repassar.some((i) => i?.pedido?.texto === 'manda o resumo antes'), 'a fala do dono espera a nova tentativa');
    assert.ok(e.entregas[`tgdn-u${u.update_id}`], 'o recado saiu');
    assert.equal(e.tg.chamados.S1.versao.estado, 'enviando', 'o chamado da aba segue "enviando"');
  });

  test('#67. recado pra CENTRAL com nao_achei: a 2a linha diz que nao consegui; nunca estaciona nem passa pra outra central', async () => {
    const h = montar({ naAba: false, respostasEntrega: [{ status: 'nao_achei', detalhe: '' }] });
    const { p, id } = await vencidoNaCentral(h);
    const marca = h.tg.chamadas.length;
    const u = toqueR(h, p.codigo, { messageId: id });
    await tocarR(h, u);
    assert.deepEqual(h.entregas.map((x) => [x.sessionId, x.providerMsgId]), [['C1', `tgdn-u${u.update_id}`]]);
    const e = estado(h);
    assert.deepEqual(e.centralPendentes, [], 'o recado nunca estaciona');
    assert.equal(e.centralSemRecado, null, 'nem marca a central sem recado');
    const ed = desde(h, marca).filter((c) => c.metodo === 'editarTexto' && c.args[0] === id).at(-1);
    assert.ok(ed && /\nNão consegui pedir de novo à aba: Não achei a sessão [^\n]*$/.test(ed.args[1].texto), JSON.stringify(ed?.args));
    aba(h, 'C2', 'Central de sessões de teste', CENTRAL_TESTE.nome);
    h.t += 30 * 1000;
    assert.deepEqual(await h.cru.passoCentral(), { pendentes: 0, soltas: 0, expiradas: 0 });
    await bombear(h.cru);
    assert.equal(h.entregas.length, 1, 'nenhuma entrega pra outra sessao');
  });

  test('#68. a fala da central sem recado estaciona; o recado do Tentar novamente na fila da mesma aba nao vai junto', async () => {
    const h = montar({ naAba: false, respostasEntrega: [{ status: 'nao_achei', detalhe: '' }] });
    const { p, id } = await vencidoNaCentral(h);
    const fala = msgTg(h, 'como ficou o deploy?');
    h.tg.lotes.push([fala, toqueR(h, p.codigo, { messageId: id })]);
    await h.p.esperarTelegram(5000);
    await bombear(h.cru);
    const e = estado(h);
    assert.ok(e.centralPendentes.some((x) => x.pedido.texto === 'como ficou o deploy?'), 'a fala da central estacionou');
    assert.ok(!e.centralPendentes.some((x) => ehTgdn(x.pedido)), 'o recado nunca estaciona');
    assert.deepEqual(h.entregas.map((x) => x.sessionId), ['C1', 'C1'], 'o recado foi pra central do pedido');
  });

  test('#69. "ainda não pegou" (naFila) e "não mostrou" (reforco que falhou) do recado nao mexem na tela: so 1 linha de log', async () => {
    { // naFila
      const h = montar();
      const { p, tela } = await vencidoNaAba(h);
      await tocarR(h, toqueR(h, p.codigo, { messageId: tela }));
      assert.ok(estado(h).entregas[recadosDeNovo(h)[0].providerMsgId], 'entrega registrada');
      const versao = ultimaVersao(h, tela);
      h.t += 10 * MIN + 1000;
      const marca = h.tg.chamadas.length;
      await h.p.passoEventos(); // 10 min sem o recado no transcript da aba
      await h.p.esperarTelegram(5000);
      assert.ok(logs(h).some((l) => l.includes('o recado do pedido de OK') && /ainda nao apareceu/.test(l)), 'a linha de log');
      assert.deepEqual(desde(h, marca).filter((c) => c.args[0] === tela && ['editar', 'editarTexto'].includes(c.metodo)), [], 'naFila nao mexe na tela');
      assert.deepEqual(ultimaVersao(h, tela), versao);
      assert.deepEqual(h.enviados, []);
    }
    { // reforco que o mensageiro nao entregou
      const h = montar({ respostasEntrega: [{ status: 'enviado', detalhe: '' }, { status: 'erro', detalhe: 'estourou o tempo' }] });
      const { p, tela } = await vencidoNaAba(h);
      await tocarR(h, toqueR(h, p.codigo, { messageId: tela }));
      const rec = recadosDeNovo(h)[0];
      h.t += 2000;
      transcript(h, 'S1', [peer(rec, iso(h.t))]);
      h.t += 1000;
      evento(h, parou(h, 'S1', { final: 'Vou conferir o pedido.' }));
      const marca = h.tg.chamadas.length;
      await h.p.passoEventos();
      await h.p.esperarTelegram(5000);
      assert.equal(h.entregas.filter((x) => x.reforco === true).length, 1, 'o reforco foi tentado');
      assert.ok(logs(h).some((l) => l.includes('o recado do pedido de OK') && /nao mostrou/.test(l)), 'a linha de log');
      assert.ok(!desde(h, marca).some((c) => c.args[0] === tela && c.metodo === 'editar' && /Não consegui/.test(c.args[1]?.classico ?? '')), 'nao mostrou nao mexe na 2a linha');
      assert.ok(!/Não consegui/.test(ultimaVersao(h, tela).classico));
    }
  });

  test('#77. o toque edita a tela no MESMO passo: o editar sai antes do 2o toque do mesmo lote', async () => {
    const h = montar();
    const { p, tela } = await vencidoNaAba(h);
    const tToque = h.t;
    const marca = h.tg.chamadas.length;
    h.tg.lotes.push([toqueR(h, p.codigo, { messageId: tela }), toqueR(h, p.codigo, { messageId: tela })]);
    await h.p.esperarTelegram(5000);
    await bombear(h.cru);
    const seq = desde(h, marca)
      .filter((c) => c.metodo === 'responderToque' || (c.metodo === 'editar' && c.args[0] === tela))
      .map((c) => (c.metodo === 'editar' ? 'editar' : c.args[1]));
    assert.deepEqual(seq, ['Pedindo de novo à aba.', 'editar', `Já pedi de novo às ${horaBRT(iso(tToque))}.`]);
  });
});
