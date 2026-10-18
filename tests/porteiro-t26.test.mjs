// Testes da T26c1 (PLANO-TELEGRAM.md, "T26c1"; pedido do dono 18/10/2026 11:09: "o ok fica lá dentro. E não mensagem
// separada"): com o OK pelo botao ligado e a chave telegram.ok.naAba ausente (= ligada), o pedido de OK NOVO sai dentro
// da mensagem da aba (canal.okAbriu: o bloco no fim, os botoes do bloco), sem o enviarTexto proprio do porteiro; o toque
// na tela da aba e tratado pela tela (okNaMensagem, okInfo, okToque) e o texto em cima dela com o OK aberto = a linha dos
// botoes. `telegram.ok.naAba: false` = o caminho de hoje (1 enviarTexto separado).
// Por que existe: o Sim tocado vira autorizacao de acao irreversivel. A mensagem da aba agora leva o OK: o toque nela tem
// de conferir com o texto VISIVEL dela (parte da aba + bloco), o porteiro nunca pode mandar o pedido 2 vezes e a fala em
// cima dela nunca pode virar fala pra aba.
// Isolamento: pastas temporarias (prefixo "t26c1-") via SESSOES_WPP_DIR, CLAUDE_SESSIONS_DIR, CLAUDE_PROJECTS_DIR e
// SESSOES_WPP_LOG; nunca o ~/.claude real. Nenhuma rede: o `tg` e um duble (lotes roteirizados; o resto grava as chamadas,
// com o id que devolveu). Relogio e `dormir` falsos. Harness copiado do tests/porteiro-ok-tg.test.mjs e do
// tests/porteiro-t23.test.mjs (sem importar de outro teste).
// Rodar: node --test --test-reporter=tap "tests/porteiro-t26.test.mjs"
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
function montar({ naAba, prefixo = 't26c1-', respostasEntrega = [], resolvidasTg } = {}) {
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
  const h = { raiz, env, t: T0, idle: 0, grupo: [], enviados: [], entregas: [], nReg: 0, nUpd: 100, nMid: 7000 };
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
    canalPrincipal: 'telegram',
  };
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

// ---------------------------------------------------------------------------------------------------------------

test('T26c1 a. pedido novo com o OK na aba -> 1 mensagem classica da aba (o enviar do canal, sem html) com o bloco compacto no fim e os botoes do bloco, notificando; nenhum enviarTexto; entrada naAba com messageId null; 2a volta nao manda de novo', async () => {
  const h = montar();
  const { p, marca, tela } = await comOkNaAba(h);
  const novas = desde(h, marca);
  assert.equal(novas.filter((c) => c.metodo === 'enviarTexto').length, 0, 'nenhum enviarTexto');
  const envs = novas.filter((c) => c.metodo === 'enviar' && comBotaoDoOk(c.args[0], p.codigo));
  assert.equal(envs.length, 1, '1 mensagem com o OK');
  const arg = envs[0].args[0];
  assert.equal(envs[0].id, tela, 'e a tela da aba');
  assert.equal(arg.html ?? null, null, 'sem html: sai no classico');
  const bloco = montarBlocoOk({ ...p, completo: false });
  const visivel = semTags(arg.classico);
  assert.ok(visivel.endsWith(`\n${bloco.texto}`), `o bloco no fim: ${JSON.stringify(visivel)}`);
  assert.ok(visivel.includes('Faro'), 'com o titulo da aba');
  assert.deepEqual(arg.botoes, bloco.botoes, 'os botoes do bloco');
  assert.notEqual(arg.silencioso, true, 'notificando');
  const m = okDe(h, p.codigo);
  assert.ok(Number.isFinite(Date.parse(m.enviadoEm)));
  assert.deepEqual({ ...m, enviadoEm: null }, {
    messageId: null, outras: [], sessionId: 'S1', completo: false, enviadoEm: null, toque: null, fechadoEm: null, fim: null,
    semBotoes: false, naAba: true,
  });
  assert.equal(chamado(h, 'S1').ok.cod, p.codigo, 'o OK no chamado da aba');
  assert.deepEqual(h.enviados, [], 'nada no grupo');

  const marca2 = h.tg.chamadas.length;
  await h.p.esperarTelegram(15000);
  const depois = desde(h, marca2).filter((c) => ['enviar', 'enviarTexto', 'editar', 'editarTexto'].includes(c.metodo));
  assert.deepEqual(depois, [], '2a volta nao manda nem edita');
});

test('T26c1 b. a resposta da aba 1 s depois do OK na tela entra por edicao da mesma mensagem (1 editar, nenhum enviar), com o bloco ainda no fim', async () => {
  const h = montar();
  const { p, tela } = await comOkNaAba(h);
  const marca = h.tg.chamadas.length;
  await abaResponde(h);
  const novas = desde(h, marca);
  const eds = novas.filter((c) => c.metodo === 'editar');
  assert.equal(eds.length, 1, `1 edicao: ${JSON.stringify(novas.map((c) => c.metodo))}`);
  assert.equal(eds[0].args[0], tela, 'na mesma mensagem');
  assert.equal(novas.filter((c) => c.metodo === 'enviar').length, 0, 'nenhuma mensagem nova');
  assert.equal(novas.filter((c) => c.metodo === 'enviarTexto').length, 0);
  const bloco = montarBlocoOk({ ...p, completo: false });
  const visivel = semTags(eds[0].args[1].classico);
  assert.ok(visivel.includes('Terminei a revisão do site.'), `a parte da aba: ${JSON.stringify(visivel)}`);
  assert.ok(visivel.endsWith(`\n${bloco.texto}`), 'o bloco no fim');
  assert.deepEqual(eds[0].args[1].botoes, bloco.botoes, 'os botoes do bloco');
  assert.equal(okDe(h, p.codigo).naAba, true);
});

test('T26c1 c. Sim tocado na tela da aba com o texto visivel dela (parte da aba + bloco) confere: "Anotei", toque anotado, segurado, recado pra aba e so o teclado sai (editarBotoes(tela, null)), sem editar texto nem ir pra outras', async () => {
  const h = montar();
  const { p, tela } = await comOkNaAba(h);
  await abaResponde(h);
  const v = ultimaVersao(h, tela);
  assert.ok(semTags(v.classico).includes('Terminei a revisão do site.'), 'a tela mostra a parte da aba');
  const marca = h.tg.chamadas.length;
  const u = toqueNaTelaDeAgora(h, p, 'sim', tela);
  h.tg.lotes.push([u]);
  await h.p.esperarTelegram(5000);
  await bombear(h.cru);
  const novas = desde(h, marca);
  assert.deepEqual(respostas(novas), [ANOTEI_SIM]);
  const m = okDe(h, p.codigo);
  assert.equal(m.toque?.acao, 'sim');
  assert.equal(m.toque.updateId, u.update_id);
  assert.equal(m.messageId, null);
  assert.deepEqual(m.outras, [], 'a tela da aba nao entra em outras');
  assert.equal(estado(h).okTg.segurar, u.update_id, 'o toque fica segurado');
  const rec = recadosOk(h);
  assert.equal(rec.length, 1, '1 recado');
  assert.equal(rec[0].sessionId, 'S1');
  assert.equal(rec[0].texto, 'Sim');
  assert.equal(rec[0].ok, p.codigo);
  assert.ok(!JSON.stringify(rec[0]).includes(ACAO), 'o recado sem a acao');
  assert.deepEqual(novas.filter((c) => c.metodo === 'editarBotoes').map((c) => c.args), [[tela, null]], 'so o teclado sai');
  assert.equal(novas.filter((c) => ['editar', 'editarTexto'].includes(c.metodo)).length, 0, 'o texto nao e editado');
  assert.equal(novas.filter((c) => c.metodo === 'apagar' && c.args[0] === tela).length, 0, 'a tela fica');
  assert.equal(chamado(h, 'S1').ok.toque?.acao, 'sim', 'o canal anotou o toque');
});

test('T26c1 d. "Mais informações" na tela da aba edita pro bloco completo (o okInfo do canal, nenhum editarTexto); o Sim depois disso, no texto completo, confere', async () => {
  const h = montar();
  const { p, tela } = await comOkNaAba(h);
  const marca = h.tg.chamadas.length;
  h.tg.lotes.push([toqueNaTelaDeAgora(h, p, 'info', tela)]);
  await h.p.esperarTelegram(5000);
  const novas = desde(h, marca);
  assert.deepEqual(respostas(novas), [null], 'so tira o relogio do botao');
  assert.equal(novas.filter((c) => c.metodo === 'editarTexto').length, 0, 'nenhum editarTexto');
  const eds = novas.filter((c) => c.metodo === 'editar');
  assert.equal(eds.length, 1);
  assert.equal(eds[0].args[0], tela);
  const completo = montarBlocoOk({ ...p, completo: true });
  assert.ok(semTags(eds[0].args[1].classico).endsWith(`\n${completo.texto}`), 'o bloco completo no fim');
  assert.deepEqual(eds[0].args[1].botoes, completo.botoes, 'os botoes do completo');
  assert.equal(chamado(h, 'S1').ok.completo, true);
  assert.equal(okDe(h, p.codigo).toque, null, 'Mais informações nao anota');

  const marca2 = h.tg.chamadas.length;
  h.tg.lotes.push([toqueNaTelaDeAgora(h, p, 'sim', tela)]);
  await h.p.esperarTelegram(5000);
  await bombear(h.cru);
  assert.deepEqual(respostas(desde(h, marca2)), [ANOTEI_SIM], 'o Sim no completo confere');
  assert.equal(okDe(h, p.codigo).toque?.acao, 'sim');
  assert.equal(recadosOk(h).length, 1);
  assert.deepEqual(desde(h, marca2).filter((c) => c.metodo === 'editarBotoes').map((c) => c.args), [[tela, null]]);
});

test('T26c1 e. texto citando a mensagem da aba com o OK aberto = a linha dos botoes (canal.sistema em cima dele); nada vai pra aba', async () => {
  const h = montar();
  const { p, tela } = await comOkNaAba(h);
  await abaResponde(h);
  const marca = h.tg.chamadas.length;
  const x = msgTg(h, 'pode subir sim', { respondeA: tela });
  h.tg.lotes.push([x]);
  await h.p.esperarTelegram(5000);
  await bombear(h.cru);
  const novas = desde(h, marca);
  const linhas = novas.filter((c) => c.metodo === 'enviar' && semTags(c.args[0].html ?? c.args[0].classico).includes(OK_NOS_BOTOES));
  assert.equal(linhas.length, 1, `a linha dos botoes: ${JSON.stringify(novas.map((c) => c.metodo))}`);
  assert.equal(linhas[0].args[0].responderA, x.message.message_id, 'em cima da mensagem dele');
  assert.deepEqual(h.entregas, [], 'nada vai pra aba');
  assert.equal(chamado(h, 'S1').ok.cod, p.codigo, 'o OK segue aberto na aba');
  assert.equal(okDe(h, p.codigo).toque, null);
});

test('T26c1 f. 2 pedidos da mesma aba, pela ordem do criadoEm (nao do nome): o 2o substitui o 1o (entrada do 1o fecha com fim "substituido"); 1 mensagem da aba no chat, com o bloco do 2o', async () => {
  const h = montar();
  await preparar(h);
  const marca = h.tg.chamadas.length;
  const z = pedidoOk(h, { codigo: 'ZZZ234', criado: h.t }); // o 1o pelo criadoEm (ultimo pelo nome)
  const a = pedidoOk(h, { codigo: 'AAA234', criado: h.t + 1000 }); // o 2o pelo criadoEm (1o pelo nome)
  h.t += 1000;
  await h.p.esperarTelegram(2000);
  await h.p.esperarTelegram(2000);
  const mz = okDe(h, z.codigo);
  const ma = okDe(h, a.codigo);
  assert.equal(mz.fim, 'substituido', 'o 1o pelo criadoEm foi substituido');
  assert.ok(Number.isFinite(Date.parse(mz.fechadoEm)));
  assert.equal(mz.naAba, true);
  assert.equal(ma.fim, null, 'o 2o fica aberto');
  assert.equal(ma.fechadoEm, null);
  assert.equal(ma.naAba, true);
  const c = chamado(h, 'S1');
  assert.equal(c.ok.cod, a.codigo, 'o chamado mostra o 2o');
  const novas = desde(h, marca);
  assert.equal(novas.filter((x) => x.metodo === 'enviarTexto').length, 0);
  const apagadas = new Set(novas.filter((x) => x.metodo === 'apagar').map((x) => x.args[0]));
  const vivas = novas.filter((x) => x.metodo === 'enviar' && (comBotaoDoOk(x.args[0], z.codigo) || comBotaoDoOk(x.args[0], a.codigo)))
    .map((x) => x.id).filter((id) => !apagadas.has(id));
  assert.deepEqual(vivas, [c.mensagem.messageId], '1 mensagem da aba no chat');
  const v = ultimaVersao(h, c.mensagem.messageId);
  assert.ok(semTags(v.classico).endsWith(`\n${montarBlocoOk({ ...a, completo: false }).texto}`), 'com o bloco do 2o');
  assert.deepEqual(v.botoes, montarBlocoOk({ ...a, completo: false }).botoes);
});

test('T26c1 g. telegram.ok.naAba false = o caminho de hoje: 1 enviarTexto separado (cabecalho + bloco), entrada com o messageId dele e sem naAba; nada no chamado da aba', async () => {
  const h = montar({ naAba: false });
  await preparar(h);
  const marca = h.tg.chamadas.length;
  const p = pedidoOk(h);
  await h.p.esperarTelegram(2000);
  const novas = desde(h, marca);
  const envT = novas.filter((c) => c.metodo === 'enviarTexto');
  assert.equal(envT.length, 1, '1 enviarTexto');
  const esperado = montarOkTg({ ...p, completo: false });
  assert.equal(envT[0].args[0].texto, esperado.texto);
  assert.deepEqual(envT[0].args[0].botoes, esperado.botoes);
  assert.equal(novas.filter((c) => c.metodo === 'enviar' && comBotaoDoOk(c.args[0], p.codigo)).length, 0, 'nada pela mensagem da aba');
  const m = okDe(h, p.codigo);
  assert.equal(m.messageId, envT[0].id);
  assert.equal(m.naAba, undefined);
  assert.equal(chamado(h, 'S1')?.ok, undefined, 'o chamado da aba nao tem OK');
});

// ---------------------------------------------------------------------------------------------------------------
// T26c2 (PLANO-TELEGRAM.md, "T26c2"): o fecho do pedido na entrada naAba passa pelo canal (okFechou: some ou o bloco
// fechado na MESMA mensagem), os botoes voltam pelo canal depois da trava (okToque null), o problema na entrega fecha o
// bloco com a linha do problema, o pedido recusado com a tela trancada loga 1 vez. Por que existe: sem isto a tela da aba
// ficava com o bloco aberto e, com toque, trancada pra sempre (as mensagens novas da aba esperavam sem fim).

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

describe('T26c2', () => {
  test('a1. Sim conferido pelo Telegram com so o OK na tela (sem resposta da aba) -> a mensagem da aba e apagada (1 apagar, nada novo, nenhuma edicao); a entrada fecha (fechadoEm, fim conferido, sem apagada); o chamado fica sem o OK; 2a volta nada', async () => {
    const h = montar({ prefixo: 't26c2-' });
    const { p, tela } = await comOkNaAba(h);
    const u = await tocarNaAba(h, p, 'sim', tela);
    assert.equal(chamado(h, 'S1').ok.toque?.acao, 'sim', 'a tela trancada');
    h.t += 1000;
    mudarPedido(h, p.codigo, usadoPeloTg(u, tela, h.t));
    const marca = h.tg.chamadas.length;
    await h.p.esperarTelegram(2000);
    const novas = desde(h, marca);
    assert.deepEqual(apagadasDesde(h, marca), [tela], `a mensagem da aba sai: ${JSON.stringify(novas.map((c) => c.metodo))}`);
    assert.equal(novas.filter((c) => ['enviar', 'enviarTexto', 'editar', 'editarTexto'].includes(c.metodo)).length, 0, 'nada novo nem editado');
    const m = okDe(h, p.codigo);
    assert.equal(m.fim, 'conferido');
    assert.ok(Number.isFinite(Date.parse(m.fechadoEm)));
    assert.equal(m.apagada, undefined, 'sem outras: o apagada nao entra');
    assert.equal(chamado(h, 'S1')?.ok, undefined, 'o OK saiu do chamado');
    const marca2 = h.tg.chamadas.length;
    await h.p.esperarTelegram(15000);
    assert.deepEqual(desde(h, marca2).filter((c) => c.metodo !== 'lerAtualizacoes'), [], '2a volta nada');
  });

  test('a2. Sim conferido com a resposta da aba na tela -> a MESMA mensagem editada sem o bloco, com os botoes da resposta de volta (nenhum do OK); nenhuma mensagem nova, nada apagado', async () => {
    const h = montar({ prefixo: 't26c2-' });
    const { p, tela } = await comOkNaAba(h);
    await abaResponde(h);
    const u = await tocarNaAba(h, p, 'sim', tela);
    h.t += 1000;
    mudarPedido(h, p.codigo, usadoPeloTg(u, tela, h.t));
    const marca = h.tg.chamadas.length;
    await h.p.esperarTelegram(2000);
    const novas = desde(h, marca);
    const eds = novas.filter((c) => c.metodo === 'editar');
    assert.equal(eds.length, 1, `1 edicao: ${JSON.stringify(novas.map((c) => c.metodo))}`);
    assert.equal(eds[0].args[0], tela, 'na mesma mensagem');
    const visivel = semTags(eds[0].args[1].classico ?? eds[0].args[1].html);
    assert.ok(visivel.includes('Terminei a revisão do site.'), 'a parte da aba fica');
    assert.ok(!visivel.includes('Pedido de OK'), `sem o bloco: ${JSON.stringify(visivel)}`);
    assert.ok(!semBotoes(eds[0].args[1]), 'os botoes da resposta voltam');
    assert.ok(!temBotaoK(eds[0].args[1]), 'nenhum botao do OK');
    assert.equal(novas.filter((c) => ['enviar', 'enviarTexto', 'editarTexto'].includes(c.metodo)).length, 0, 'nenhuma mensagem nova');
    assert.deepEqual(apagadasDesde(h, marca), [], 'nada apagado');
    assert.equal(okDe(h, p.codigo).fim, 'conferido');
  });

  test('b. vencido sem toque -> o bloco fechado ("Expirou ... sem resposta.") na MESMA mensagem (1 editar, sem botoes); nenhuma mensagem nova; entrada fim expirou', async () => {
    const h = montar({ prefixo: 't26c2-' });
    const { p, tela } = await comOkNaAba(h);
    h.t = Date.parse(p.expiraEm) + 1000;
    const marca = h.tg.chamadas.length;
    await h.p.esperarTelegram(2000);
    const novas = desde(h, marca);
    const eds = novas.filter((c) => c.metodo === 'editar');
    assert.equal(eds.length, 1, `1 edicao: ${JSON.stringify(novas.map((c) => c.metodo))}`);
    assert.equal(eds[0].args[0], tela);
    const fechado = montarBlocoOkFechado({ ...p, linha: `Expirou às ${horaBRT(p.expiraEm)} sem resposta.` });
    assert.ok(semTags(eds[0].args[1].classico).endsWith(`\n${fechado}`), `o bloco fechado no fim: ${JSON.stringify(eds[0].args[1].classico)}`);
    // T28: o vencido ganha so o botao "🔄 Tentar novamente" (a linha em negrito: tests/porteiro-t28.test.mjs)
    assert.deepEqual(eds[0].args[1].botoes, [[{ texto: '🔄 Tentar novamente', dados: `r:${p.codigo}` }]]);
    assert.equal(novas.filter((c) => ['enviar', 'enviarTexto', 'editarTexto', 'apagar'].includes(c.metodo)).length, 0, 'nada novo, nada apagado');
    const m = okDe(h, p.codigo);
    assert.equal(m.fim, 'expirou');
    assert.ok(Number.isFinite(Date.parse(m.fechadoEm)));
  });

  test('c. problema na entrega do recado do Sim (nao_achei) -> o bloco fechado com a linha do problema na mesma mensagem, sem botoes; entrada fim problema; a tela destranca', async () => {
    const h = montar({ prefixo: 't26c2-', respostasEntrega: [{ status: 'nao_achei', detalhe: '' }] });
    const { p, tela } = await comOkNaAba(h);
    const marca = h.tg.chamadas.length;
    const tToque = h.t;
    await tocarNaAba(h, p, 'sim', tela);
    assert.equal(recadosOk(h).length, 1, 'o recado foi tentado');
    const eds = desde(h, marca).filter((c) => c.metodo === 'editar' && c.args[0] === tela);
    assert.ok(eds.length >= 1, `editou a tela: ${JSON.stringify(desde(h, marca).map((c) => c.metodo))}`);
    const ult = eds.at(-1).args[1];
    const visivel = semTags(ult.classico);
    const inicio = `Pedido de OK (publicação): ${ACAO}\n\nVocê tocou em Sim às ${horaBRT(iso(tToque))}, mas não consegui entregar na aba: `;
    assert.ok(visivel.includes(inicio), `a linha do problema no bloco: ${JSON.stringify(visivel)}`);
    assert.ok(semBotoes(ult), 'sem botoes');
    assert.equal(desde(h, marca).filter((c) => ['enviar', 'enviarTexto', 'editarTexto'].includes(c.metodo)).length, 0, 'nada novo');
    const m = okDe(h, p.codigo);
    assert.equal(m.fim, 'problema');
    assert.ok(Number.isFinite(Date.parse(m.fechadoEm)));
    assert.ok(chamado(h, 'S1').ok?.fechado, 'o canal fechou o OK');
    assert.deepEqual(h.enviados, [], 'nada no grupo');
  });

  test('d. a trava zera o toque: travado, os botoes da tela nao voltam e o OK novo (outra aba) nao sai; destravado, os botoes do bloco voltam por edicao da mesma tela e o OK novo sai', async () => {
    const h = montar({ prefixo: 't26c2-' });
    const { p, tela } = await comOkNaAba(h);
    aba(h, 'S2', 'Outra');
    h.tg.lotes.push([toqueNaTelaDeAgora(h, p, 'sim', tela), msgTg(h, 'trava')]);
    await h.p.esperarTelegram(5000);
    await bombear(h.cru);
    assert.equal(estado(h).trava, true);
    assert.equal(okDe(h, p.codigo).toque, null, 'a trava zerou o toque');
    const b = pedidoOk(h, { codigo: 'BCD234', sessionId: 'S2' });
    const marca = h.tg.chamadas.length;
    await h.p.esperarTelegram(15000);
    await h.p.esperarTelegram(15000);
    const travado = desde(h, marca);
    assert.equal(travado.filter((c) => c.metodo === 'editar' && c.args[0] === tela && !semBotoes(c.args[1])).length, 0, 'travado: os botoes nao voltam');
    assert.equal(travado.filter((c) => ['enviar', 'editar'].includes(c.metodo) && comBotaoDoOk(conteudo(c), b.codigo)).length, 0, 'travado: o OK novo nao sai');
    assert.equal(okDe(h, b.codigo), undefined);

    destravar({ env: h.env, agora: () => h.t });
    const marca2 = h.tg.chamadas.length;
    await h.p.esperarTelegram(5000);
    const depois = desde(h, marca2);
    const volta = depois.filter((c) => c.metodo === 'editar' && c.args[0] === tela);
    assert.equal(volta.length, 1, `1 edicao da tela: ${JSON.stringify(depois.map((c) => c.metodo))}`);
    const compacto = montarBlocoOk({ ...p, completo: false });
    assert.deepEqual(volta[0].args[1].botoes, compacto.botoes, 'os botoes do bloco voltam');
    assert.ok(semTags(volta[0].args[1].classico).endsWith(`\n${compacto.texto}`), 'o bloco aberto');
    assert.equal(depois.filter((c) => c.metodo === 'enviar' && comBotaoDoOk(c.args[0], b.codigo)).length, 1, 'o OK novo sai');
    const m = okDe(h, p.codigo);
    assert.equal(m.semBotoes, false);
    assert.equal(m.fechadoEm, null);
    assert.equal(chamado(h, 'S1').ok.toque, null, 'o canal desanotou');
    assert.equal(okDe(h, b.codigo).naAba, true);
    const marca3 = h.tg.chamadas.length;
    await h.p.esperarTelegram(15000);
    assert.equal(desde(h, marca3).filter((c) => c.metodo === 'editar' && c.args[0] === tela).length, 0, 'so 1 vez');
  });

  test('e. a T23 com o OK: a fala dele em voo (em cima da resposta) e o OK que some (conferido) = a mensagem do OK sai e a fala dele FICA no chat; sai quando a resposta da aba e trocada, como hoje', async () => {
    const h = montar({ prefixo: 't26c2-' });
    await preparar(h);
    await abaResponde(h);
    const r0 = chamado(h, 'S1').mensagem.messageId;
    const x = msgTg(h, 'pode fazer', { respondeA: r0 });
    const xId = x.message.message_id;
    h.tg.lotes.push([x]);
    await h.p.esperarTelegram(5000);
    const p = pedidoOk(h);
    await h.p.esperarTelegram(2000);
    const c = chamado(h, 'S1');
    assert.equal(c.ok?.cod, p.codigo, 'o OK no chamado');
    assert.ok(['enviando', 'entregue'].includes(c.versao.estado), `a fala dele em voo: ${c.versao.estado}`);
    const tela = c.mensagem.messageId;
    assert.equal(estado(h).tg.mensagens[tela]?.citar, xId, 'a tela do OK em cima da fala dele');
    const u = await tocarNaAba(h, p, 'sim', tela);
    h.t += 1000;
    mudarPedido(h, p.codigo, usadoPeloTg(u, tela, h.t));
    const marca = h.tg.chamadas.length;
    await h.p.esperarTelegram(5000);
    assert.deepEqual(apagadasDesde(h, marca), [tela], 'so a tela do OK sai; a fala dele fica');
    assert.equal(okDe(h, p.codigo).fim, 'conferido');

    const marca2 = h.tg.chamadas.length;
    // a aba recebeu a fala dele (o recado no transcript) e responde: a resposta sai em cima da fala dele
    const falas = h.entregas.filter((x) => String(x.providerMsgId ?? '').startsWith('tg-u'));
    assert.equal(falas.length, 1, 'a fala dele foi entregue');
    transcript(h, 'S1', falas.map((x, i) => peer(x, iso(h.t + 1000 * (i + 1)))));
    h.t += MIN;
    evento(h, parou(h, 'S1', { final: FINAL, marcas: DECISAO }));
    await h.p.passoEventos();
    await h.p.esperarTelegram(15000);
    assert.equal(chamado(h, 'S1').versao.estado, 'resposta');
    const r1 = chamado(h, 'S1').mensagem.messageId;
    assert.equal(estado(h).tg.mensagens[r1]?.citar, xId, 'a resposta em cima da fala dele');
    assert.ok(!apagadasDesde(h, marca2).includes(xId), 'a fala dele segue no chat');
    // a resposta e trocada (o toque numa opcao dela, como a T23c 1): a tela da resposta sai e leva a fala dele
    h.t += 1000;
    h.nUpd += 1;
    const opcao = {
      update_id: h.nUpd,
      callback_query: { id: `q${h.nUpd}`, from: { id: DONO, is_bot: false }, message: { message_id: r1, chat: { id: DONO, type: 'private' } }, data: `o:${chamado(h, 'S1').versao.chamadoId}:0` },
    };
    h.tg.lotes.push([opcao]);
    await h.p.esperarTelegram(15000);
    await bombear(h.cru);
    for (let i = 0; i < 3; i++) await h.p.esperarTelegram(15000);
    const ap = apagadasDesde(h, marca2);
    assert.deepEqual(ap, [r1, xId], 'a resposta trocada sai e leva a fala dele, nessa ordem e 1 vez cada');
  });

  test('f. modo manter (telegram.resolvidas manter): o Sim conferido fica no chat com o bloco fechado na mesma mensagem (1 editar, sem botoes), nada apagado', async () => {
    const h = montar({ prefixo: 't26c2-', resolvidasTg: 'manter' });
    const { p, tela } = await comOkNaAba(h);
    const u = await tocarNaAba(h, p, 'sim', tela);
    const tToque = okDe(h, p.codigo).toque.em;
    h.t += 1000;
    mudarPedido(h, p.codigo, usadoPeloTg(u, tela, h.t));
    const marca = h.tg.chamadas.length;
    await h.p.esperarTelegram(2000);
    const novas = desde(h, marca);
    const eds = novas.filter((c) => c.metodo === 'editar');
    assert.equal(eds.length, 1, `1 edicao: ${JSON.stringify(novas.map((c) => c.metodo))}`);
    assert.equal(eds[0].args[0], tela);
    const fechado = montarBlocoOkFechado({ ...p, linha: `Você tocou em Sim às ${horaBRT(tToque)}. A aba conferiu às ${horaBRT(iso(h.t))}.` });
    assert.ok(semTags(eds[0].args[1].classico).endsWith(`\n${fechado}`), `o bloco fechado: ${JSON.stringify(eds[0].args[1].classico)}`);
    assert.ok(semBotoes(eds[0].args[1]), 'sem botoes');
    assert.deepEqual(apagadasDesde(h, marca), [], 'nada apagado');
    assert.equal(novas.filter((c) => ['enviar', 'enviarTexto', 'editarTexto'].includes(c.metodo)).length, 0);
    assert.equal(okDe(h, p.codigo).fim, 'conferido');
  });

  test('g. naAba false = o fecho de hoje: o Sim conferido apaga a mensagem separada (apagar do id dela) e o vencido sem toque edita ela (editarTexto com o fechado); nada no chamado da aba', async () => {
    const h = montar({ prefixo: 't26c2-', naAba: false });
    await preparar(h);
    const p = pedidoOk(h);
    await h.p.esperarTelegram(2000);
    const id = okDe(h, p.codigo).messageId;
    assert.ok(Number.isSafeInteger(id));
    const compacto = montarOkTg({ ...p, completo: false });
    const u = toqueNaTela(h, p, 'sim', { messageId: id, texto: compacto.texto, botoes: compacto.botoes });
    h.tg.lotes.push([u]);
    await h.p.esperarTelegram(5000);
    await bombear(h.cru);
    h.t += 1000;
    mudarPedido(h, p.codigo, usadoPeloTg(u, id, h.t));
    let marca = h.tg.chamadas.length;
    await h.p.esperarTelegram(2000);
    assert.deepEqual(apagadasDesde(h, marca), [id], 'a mensagem separada sai');
    assert.equal(desde(h, marca).filter((c) => c.metodo === 'editar').length, 0, 'nada no chamado da aba');
    assert.equal(okDe(h, p.codigo).fim, 'conferido');
    assert.equal(okDe(h, p.codigo).apagada, true);

    const b = pedidoOk(h, { codigo: 'BCD234' });
    await h.p.esperarTelegram(2000);
    const idB = okDe(h, b.codigo).messageId;
    h.t = Date.parse(b.expiraEm) + 1000;
    marca = h.tg.chamadas.length;
    await h.p.esperarTelegram(2000);
    const linha = `Expirou às ${horaBRT(b.expiraEm)} sem resposta.`;
    assert.deepEqual(desde(h, marca).filter((c) => c.metodo === 'editarTexto').map((c) => c.args), [[idB, { texto: montarOkTgFechado({ ...b, linha }).texto, botoes: [[{ texto: '🔄 Tentar novamente', dados: `r:${b.codigo}` }]] }]]); // T28: o botao
    assert.equal(desde(h, marca).filter((c) => c.metodo === 'editar').length, 0);
    assert.equal(chamado(h, 'S1')?.ok, undefined);
  });

  test('h. pedido recusado com a tela trancada (outro OK da aba tocado): 1 linha de log so, mesmo com varias voltas de 30 s; a tela destrancada (o 1o fecha) = o pedido entra', async () => {
    const h = montar({ prefixo: 't26c2-' });
    const { p, tela } = await comOkNaAba(h);
    const u = await tocarNaAba(h, p, 'sim', tela);
    const b = pedidoOk(h, { codigo: 'BCD234' });
    for (let i = 0; i < 6; i++) await h.p.esperarTelegram(15000);
    const recusas = recusasDoPorteiro(h, 'BCD234');
    assert.equal(recusas.length, 1, recusas.join('\n'));
    assert.equal(okDe(h, b.codigo), undefined, 'nao entrou');
    mudarPedido(h, p.codigo, usadoPeloTg(u, tela, h.t));
    for (let i = 0; i < 4; i++) await h.p.esperarTelegram(15000);
    assert.equal(okDe(h, p.codigo).fim, 'conferido');
    assert.equal(okDe(h, b.codigo)?.naAba, true, 'o pedido entrou');
    assert.equal(chamado(h, 'S1').ok.cod, b.codigo);
    assert.equal(recusasDoPorteiro(h, 'BCD234').length, 1, 'sem log novo');
  });

  test('i. o canal nao tem mais o pedido (okFechou false: herdado ou substituido) = a entrada fecha do mesmo jeito, 1 linha de log, nada no chat', async () => {
    const h = montar({ prefixo: 't26c2-' });
    const { p } = await comOkNaAba(h);
    mexer(h, (e) => { delete e.tg.chamados.S1.ok; });
    h.t = Date.parse(p.expiraEm) + 1000;
    const marca = h.tg.chamadas.length;
    await h.p.esperarTelegram(2000);
    await h.p.esperarTelegram(15000);
    const m = okDe(h, p.codigo);
    assert.equal(m.fim, 'expirou');
    assert.ok(Number.isFinite(Date.parse(m.fechadoEm)));
    assert.equal(logs(h).filter((l) => l.includes(p.codigo) && /canal/.test(l) && /nao tem/.test(l)).length, 1, logs(h).filter((l) => l.includes(p.codigo)).join('\n'));
    assert.equal(desde(h, marca).filter((c) => ['enviar', 'editar', 'editarTexto', 'enviarTexto'].includes(c.metodo)).length, 0);
  });

  // T26s (as sabotagens da T26c que passavam): o canal que muda no passo drena no MESMO passo; o okSemTela no passo; o
  // recusado so volta em 30 s
  test('T26s a. o fecho pelo canal drena no mesmo passo: a mensagem da aba sai antes da proxima leitura', async () => {
    const h = montar({ prefixo: 't26c2-' });
    const { p, tela } = await comOkNaAba(h);
    const u = await tocarNaAba(h, p, 'sim', tela);
    h.t += 1000;
    mudarPedido(h, p.codigo, usadoPeloTg(u, tela, h.t));
    const marca = h.tg.chamadas.length;
    await h.p.esperarTelegram(2000);
    const ms = desde(h, marca).map((c) => (c.metodo === 'apagar' && c.args[0] === tela ? 'tela' : c.metodo));
    const iTela = ms.indexOf('tela');
    const iLer = ms.indexOf('lerAtualizacoes');
    assert.ok(iTela >= 0 && (iLer < 0 || iTela < iLer), JSON.stringify(ms));
  });

  test('T26s b. os botoes que voltam depois da trava saem no mesmo passo (antes da proxima leitura)', async () => {
    const h = montar({ prefixo: 't26c2-' });
    const { p, tela } = await comOkNaAba(h);
    h.tg.lotes.push([toqueNaTelaDeAgora(h, p, 'sim', tela), msgTg(h, 'trava')]);
    await h.p.esperarTelegram(5000);
    await bombear(h.cru);
    assert.equal(okDe(h, p.codigo).toque, null, 'a trava zerou o toque');
    destravar({ env: h.env, agora: () => h.t });
    const marca = h.tg.chamadas.length;
    await h.p.esperarTelegram(5000);
    const ms = desde(h, marca).map((c) => (c.metodo === 'editar' && c.args[0] === tela ? 'tela' : c.metodo));
    const iTela = ms.indexOf('tela');
    const iLer = ms.indexOf('lerAtualizacoes');
    assert.ok(iTela >= 0 && (iLer < 0 || iTela < iLer), JSON.stringify(ms));
  });

  test('T26s c. o OK aberto fora da tela e fora da fila volta pelo passo (okSemTela) e sai em mensagem nova', async () => {
    const h = montar({ prefixo: 't26c2-' });
    const { p } = await comOkNaAba(h);
    mexer(h, (e) => { e.tg.chamados.S1.descer = true; e.tg.saida = []; });
    const marca = h.tg.chamadas.length;
    await h.p.esperarTelegram(2000);
    const env = desde(h, marca).filter((c) => c.metodo === 'enviar');
    assert.equal(env.length, 1, JSON.stringify(desde(h, marca).map((c) => c.metodo)));
    assert.ok(comBotaoDoOk(conteudo(env[0]), p.codigo), 'a mensagem nova leva o OK');
  });

  test('T26s d. o pedido recusado pela tela trancada so volta ao canal a cada 30 s (nao a cada volta)', async () => {
    const h = montar({ prefixo: 't26c2-' });
    const { p, tela } = await comOkNaAba(h);
    await tocarNaAba(h, p, 'sim', tela);
    pedidoOk(h, { codigo: 'BCD234' });
    const t0 = h.t;
    for (let i = 0; i < 6; i++) await h.p.esperarTelegram(15000);
    const tentativas = logs(h).filter((l) => l.includes('OK BCD234 recusado (o OK'));
    const max = Math.floor((h.t - t0) / 30000) + 1;
    assert.ok(tentativas.length >= 1 && tentativas.length <= max, `${tentativas.length} tentativas em ${(h.t - t0) / 1000} s`);
  });
});
