// Testes da etapa E da aceleracao (PLANO-T7.md, "T7b2b-resto e T7b3 no Desenho 1b"): o resto da T7b2b no porteiro e a
// T7b3 nas instrucoes. O OK de acao pelo Telegram e o toque no botao Sim ou Nao da mensagem do pedido, no PROPRIO chat
// Bot de Teste (F5 decidida, pedido do dono).
// - 87: "sim"/"s"/"nao"/"n" solto com pedido de OK aberto, o OK pelo botao ligado (config.json telegram.ok.ligado, lido
//   1 vez no criarPorteiro: o okLigado da etapa D) e a mensagem do pedido no chat = a linha nova em cima da mensagem dele;
//   desligado, ou o pedido sem mensagem no chat = a de hoje. 87d (revisao da etapa E): o mesmo EM CIMA da mensagem do
//   pedido (o gesto de citar do WhatsApp), que antes ia pra central. 87e (revisao da etapa D, item 15): qualquer texto em
//   cima da mensagem aberta do pedido = a linha dos botoes (nunca central nem aba).
// - 89: pendencias (Telegram e grupo): o pedido com o toque do dono anotado em e.okTg.mensagens[COD].toque (o formato da
//   etapa D) sai da lista (espera a aba, nao ele); sem o e.okTg = como hoje; o toque solto pelo lote cheio (soltoEm)
//   volta pra lista (89c).
// - 93: as instrucoes da central e da sessao escondida ensinam o OK pelo botao do pedido no Telegram.
// Isolamento: pastas temporarias via SESSOES_WPP_DIR, CLAUDE_SESSIONS_DIR, CLAUDE_PROJECTS_DIR e SESSOES_WPP_LOG (nunca o
// ~/.claude real). Nenhuma rede: o `tg` e um duble (harness copiado do tests/porteiro-telegram.test.mjs).
// Rodar: node --test --test-reporter=tap "tests/porteiro-ok-resto.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { criarPorteiro } from '../porteiro.mjs';
import { montarOkTg } from '../lib/ok-tg.mjs';
import { horaBRT } from '../lib/formato.mjs';
import { NUMERO_DONO } from './lib/dados-whatsapp.mjs';
import { CENTRAL_TESTE, RAIZES_TESTE } from './lib/dados-central.mjs';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MIN = 60 * 1000;
const T0 = Date.parse('2026-09-29T15:00:00Z'); // 12:00 em Brasilia
const iso = (ms) => new Date(ms).toISOString();
const DONO = 700100200;
const BOT = 700900800;
const CAB = '🎛️ *Controle de sessões*'; // cabecalho das frases do grupo (voz do controle: 🎛️, pedido do dono)
const CENTRAL = 'Central de sessões de teste';

// Textos por extenso de proposito (o teste prende o texto).
const TXT = {
  okBotoes: 'O pedido de OK se responde nos botões Sim e Não da mensagem dele.', // T7b2b (Desenho 1b)
  okWhatsapp: 'O pedido de OK se responde no WhatsApp por enquanto.', // a de hoje (T3a)
  // T7i: o pedido em que ele ja tocou nao tem mais botoes
  jaTocouSim: (hora) => `Você já tocou em Sim às ${hora}. Pra desistir, responde "não" em cima do pedido no grupo do WhatsApp.`,
  jaTocouNao: (hora) => `Você já tocou em Não às ${hora}.`,
};

// ---------- harness (copia do tests/porteiro-telegram.test.mjs) ----------

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

// Duble do criarTelegram (o mesmo do porteiro-telegram.test.mjs) + enviarTexto/editarTexto (os metodos do pedido de OK,
// T7b1a), que so gravam: nenhuma rede.
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
  tg.enviarTexto = async (pedido) => {
    gravar('enviarTexto', [pedido]);
    tg.enviadas += 1;
    return { ok: true, messageId: 900 + tg.enviadas };
  };
  tg.editar = async (messageId, pedido) => { gravar('editar', [messageId, pedido]); return { ok: true }; };
  tg.editarTexto = async (messageId, pedido) => { gravar('editarTexto', [messageId, pedido]); return { ok: true }; };
  tg.editarBotoes = async (messageId, botoes) => { gravar('editarBotoes', [messageId, botoes]); return { ok: true }; }; // T7i
  tg.apagar = async (messageId) => { gravar('apagar', [messageId]); return { ok: true }; };
  tg.responderToque = async (id, texto) => { gravar('responderToque', [id, texto]); return { ok: true }; };
  tg.quemSou = async () => { gravar('quemSou', []); return { ok: true, id: BOT, username: 'Teste_ControleBot' }; };
  tg.definirComandos = async (c) => { gravar('definirComandos', [c]); return { ok: true }; };
  tg.de = (metodo) => tg.chamadas.filter((c) => c.metodo === metodo);
  tg.zerar = () => { tg.chamadas.length = 0; };
  return tg;
}

// `cfg` = o config.json gravado ANTES do criarPorteiro (o okLigado da etapa D le 1 vez, na montagem).
function montar(cfg) {
  const raiz = pastaTemp('porteiro-ok-resto-');
  const env = {
    SESSOES_WPP_DIR: path.join(raiz, 'estado'),
    CLAUDE_SESSIONS_DIR: path.join(raiz, 'sessions'),
    CLAUDE_PROJECTS_DIR: path.join(raiz, 'projects'),
    SESSOES_WPP_LOG: path.join(raiz, 'porteiro.log'),
  };
  for (const d of [env.SESSOES_WPP_DIR, env.CLAUDE_SESSIONS_DIR, env.CLAUDE_PROJECTS_DIR]) fs.mkdirSync(d, { recursive: true });
  if (cfg !== undefined) fs.writeFileSync(path.join(env.SESSOES_WPP_DIR, 'config.json'), JSON.stringify(cfg));
  const h = { raiz, env, t: T0, idle: 0, grupo: [], enviados: [], reacoes: [], entregas: [], nReg: 0, nMsg: 0, nUpd: 100, nMid: 7000 };
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
      return { status: 'enviado', detalhe: '' };
    },
  };
  h.tg = dubleTg(h);
  h.cru = criarPorteiro({
    wpp: h.wpp, numeroDono: NUMERO_DONO, mensageiro: h.mensageiro, ocioso: async () => h.idle, agora: () => h.t, env,
    abrirCentral: () => {}, ensaio: false, rand: randFixo(), dormir: async (ms) => { h.t += ms; }, tg: h.tg,
    identTg: { chatId: DONO, botId: BOT }, // A1: o chat e o bot de antes
    central: CENTRAL_TESTE, raizesSessao: RAIZES_TESTE, // A3a: a central e as pastas como o dono configura
  });
  h.p = comBomba(h.cru);
  h.t += 1000; // mensagens dos testes nascem depois do cursor inicial
  return h;
}

function aba(h, sessionId, titulo, name = 'projetos-42') {
  h.nReg += 1;
  const reg = { pid: process.pid, sessionId, cwd: 'c:\\projetos', entrypoint: 'claude-vscode', name, nameSource: 'derived', status: 'idle', updatedAt: h.t };
  fs.writeFileSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${100000 + h.nReg}.json`), JSON.stringify(reg));
  const dir = path.join(h.env.CLAUDE_PROJECTS_DIR, 'c--projetos');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${sessionId}.jsonl`), `${JSON.stringify({ type: 'custom-title', customTitle: titulo, sessionId: 'x' })}\n`);
}
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
const ligarTg = (h) => mexer(h, (e) => { e.tg.offset = 0; }); // o historico ja foi pulado
const linhasSistema = (h) => estado(h).tg.sistema.linhas.map((l) => l.texto);
const apagadas = (h) => h.tg.de('apagar').map((c) => c.args[0]);
// `respondeA` = a mensagem do bot em cima da qual ele responde (reply_to_message)
function msgTg(h, texto, { respondeA = null } = {}) {
  h.nUpd += 1;
  h.nMid += 1;
  const m = {
    message_id: h.nMid, date: Math.floor(h.t / 1000), text: texto,
    chat: { id: DONO, type: 'private', first_name: 'Davi' }, from: { id: DONO, is_bot: false, first_name: 'Davi' },
  };
  if (respondeA != null) {
    m.reply_to_message = {
      message_id: respondeA, date: Math.floor(h.t / 1000) - 5, from: { id: BOT, is_bot: true, first_name: 'Bot de Teste' },
      chat: { id: DONO, type: 'private', first_name: 'Davi' }, text: '(a mensagem do bot)',
    };
  }
  return { update_id: h.nUpd, message: m };
}
// Toque no botao Sim ou Nao do pedido de OK, como o getUpdates devolve (a mensagem tocada e a do bot, com o texto e o
// teclado montados do pedido: o mesmo montarOkTg do porteiro). O formato e o do tests/porteiro-ok-tg.test.mjs (etapa D).
function toqueOk(h, p, acao, messageId) {
  h.nUpd += 1;
  const r = montarOkTg({ ...p, completo: false });
  return {
    update_id: h.nUpd,
    callback_query: {
      id: `q${h.nUpd}`, from: { id: DONO, is_bot: false, first_name: 'Davi' }, chat_instance: '-1',
      data: `k:${p.codigo}:${acao === 'sim' ? 's' : 'n'}`,
      message: {
        message_id: messageId, from: { id: BOT, is_bot: true, first_name: 'Bot de Teste' },
        chat: { id: DONO, type: 'private', first_name: 'Davi' }, date: Math.floor(Date.parse(p.criadoEm) / 1000) + 2,
        text: r.texto,
        reply_markup: {
          inline_keyboard: r.botoes.map((l) => l.map((b) => ({ text: b.texto, callback_data: b.dados, ...(b.estilo ? { style: b.estilo } : {}) }))),
        },
      },
    },
  };
}
const mid = (u) => u.message.message_id;
async function lerTg(h, updates) {
  h.tg.lotes.push(updates);
  await h.p.esperarTelegram(15000);
}
function pedidoOk(h, { codigo, sessionId, criado = h.t - MIN, status = 'pendente', extra = {} }) {
  const dir = path.join(h.env.SESSOES_WPP_DIR, 'oks');
  fs.mkdirSync(dir, { recursive: true });
  const p = {
    v: 1, codigo, sessionId, tipo: 'crm', acao: 'x', hashAcao: 'h', destinatarios: null,
    criadoEm: iso(criado), expiraEm: iso(criado + 30 * MIN), providerMsgId: `P-${codigo}`, messageId: `U-${codigo}`, status, ...extra,
  };
  fs.writeFileSync(path.join(dir, `${codigo}.json`), JSON.stringify(p));
  return p;
}
// config.json do estado: o OK pelo botao liga com telegram.ligado E telegram.ok.ligado (lerConfigOk, T7b1a). Vai pro
// montar(cfg): a etapa D le 1 vez, no criarPorteiro (okLigado).
const OK_LIGADO = { telegram: { ligado: true, ok: { ligado: true, naAba: false } } };

// ---------------------------------------------------------------------------------------------------------------
// T7b2b 87: passo 4 do tratarMensagemTg

// Aba S1 "Faro" com 1 pedido de OK aberto, a central SC e o Telegram com o historico pulado. O pedido nasce depois do
// iniciadoEm (`criado` = agora): com o OK ligado, a 1a leitura (sem update) ja manda a mensagem dele no chat (etapa D).
// `criado` antes do iniciadoEm = o pedido nunca sai no chat.
async function cena87(cfg, { criado } = {}) {
  const h = montar(cfg);
  aba(h, 'S1', 'Faro');
  aba(h, 'SC', CENTRAL, 'repos-99');
  const p = pedidoOk(h, { codigo: 'ABC234', sessionId: 'S1', criado: criado ?? h.t, extra: { titulo: 'Faro' } });
  ligarTg(h);
  await h.p.esperarTelegram(15000);
  h.t += 1000;
  h.tg.zerar();
  h.pedido = p;
  return h;
}
const msgDoOk = (h, cod = 'ABC234') => estado(h).okTg?.mensagens?.[cod]?.messageId ?? null;

test('T7b2b 87. OK pelo botao ligado, pedido de OK aberto e a mensagem dele no chat: "sim", "Sim", "S", "não", "n" soltos = a linha nova em cima da mensagem dele, notificando; nada repassado e a mensagem dele fica', async () => {
  for (const texto of ['sim', 'Sim', 'S', 'não', 'n']) {
    const h = await cena87(OK_LIGADO);
    assert.ok(Number.isSafeInteger(msgDoOk(h)), `${texto}: a mensagem do pedido ja esta no chat`);
    const u = msgTg(h, texto);
    await lerTg(h, [u]);
    assert.deepEqual(linhasSistema(h), [TXT.okBotoes], texto);
    assert.equal(h.entregas.length, 0, `${texto}: nada repassado`);
    const env = h.tg.de('enviar').map((x) => x.args[0]);
    assert.equal(env.length, 1, texto);
    assert.ok(env[0].html.includes('O pedido de OK se responde nos botões Sim e Não da mensagem dele.'), texto);
    assert.equal(env[0].responderA, mid(u), `${texto}: em cima da mensagem dele`);
    assert.equal(env[0].silencioso, false, `${texto}: notifica`);
    assert.deepEqual(apagadas(h), [], `${texto}: a mensagem dele fica`);
  }
});

test('T7b2b 87b. OK pelo botao desligado (sem config, sem telegram.ok, ok.ligado false, telegram.ligado false): "sim" e "n" soltos = a linha de hoje', async () => {
  const desligados = [
    undefined,
    { telegram: { ligado: true } },
    { telegram: { ligado: true, ok: { ligado: false } } },
    { telegram: { ligado: false, ok: { ligado: true } } },
    { telegram: { ligado: true, ok: { ligado: 'true' } } },
  ];
  for (const cfg of desligados) {
    for (const texto of ['sim', 'n']) {
      const h = await cena87(cfg);
      assert.equal(msgDoOk(h), null, `${JSON.stringify(cfg)}: desligado, o pedido nao sai no chat`);
      const u = msgTg(h, texto);
      await lerTg(h, [u]);
      assert.deepEqual(linhasSistema(h), [TXT.okWhatsapp], `${JSON.stringify(cfg)} ${texto}`);
      assert.equal(h.entregas.length, 0);
      assert.equal(h.tg.de('enviar')[0].args[0].responderA, mid(u));
    }
  }
});

test('T7b2b 87c. com o OK pelo botao ligado, so o "sim"/"s"/"nao"/"n" solto muda: "ok" e "manda" soltos vao pra central, e "sim" sem pedido aberto tambem; pedido aberto sem mensagem no chat (criado antes do iniciadoEm) = a linha de hoje', async () => {
  for (const texto of ['ok', 'manda']) {
    const h = await cena87(OK_LIGADO);
    await lerTg(h, [msgTg(h, texto)]);
    assert.deepEqual(h.entregas.map((p) => [p.sessionId, p.texto]), [['SC', texto]], `${texto}: vai pra central`);
    assert.ok(!linhasSistema(h).includes(TXT.okBotoes), `${texto}: sem a linha do OK`);
  }
  {
    const h = montar(OK_LIGADO);
    aba(h, 'S1', 'Faro');
    aba(h, 'SC', CENTRAL, 'repos-99');
    pedidoOk(h, { codigo: 'ABC234', sessionId: 'S1', status: 'usado' });
    ligarTg(h);
    await lerTg(h, [msgTg(h, 'sim')]);
    assert.deepEqual(h.entregas.map((p) => [p.sessionId, p.texto]), [['SC', 'sim']], 'sem pedido aberto: roteamento de hoje');
    assert.ok(!linhasSistema(h).includes(TXT.okBotoes));
  }
  // o OK ligado, mas o pedido nunca saiu no chat (nasceu antes do iniciadoEm): os botoes nao existem, vale a linha de hoje
  const h = await cena87(OK_LIGADO, { criado: T0 - MIN });
  assert.equal(msgDoOk(h), null, 'o pedido de antes do iniciadoEm nao sai no chat');
  const u = msgTg(h, 'sim');
  await lerTg(h, [u]);
  assert.deepEqual(linhasSistema(h), [TXT.okWhatsapp], 'sem a mensagem do pedido no chat: a linha de hoje');
  assert.equal(h.entregas.length, 0);
});

test('T7b2b 87d. EM CIMA da mensagem do pedido de OK (o gesto de citar do WhatsApp): "sim"/"não" = a linha dos botoes em cima da mensagem dele, sem repasse (antes ia pra central); com o Sim ja tocado, o "não" em cima nao vira fala, o toque fica Sim e a linha diz o toque (T7i: os botoes sairam); "sim" em cima de outra mensagem segue o roteamento de hoje (o "ok" em cima do pedido: 87e)', async () => {
  for (const texto of ['sim', 'não', 'N']) {
    const h = await cena87(OK_LIGADO);
    const u = msgTg(h, texto, { respondeA: msgDoOk(h) });
    await lerTg(h, [u]);
    assert.deepEqual(linhasSistema(h), [TXT.okBotoes], texto);
    assert.equal(h.entregas.length, 0, `${texto}: nada repassado (nem pra central)`);
    const env = h.tg.de('enviar').map((x) => x.args[0]);
    assert.equal(env.length, 1, texto);
    assert.equal(env[0].responderA, mid(u), `${texto}: em cima da mensagem dele`);
    assert.equal(env[0].silencioso, false, `${texto}: notifica`);
  }
  {
    // o Sim tocado e, depois, "não" em cima da mensagem do pedido: o unico recado e o do toque. T7i: os botoes sairam no
    // toque, entao a linha diz o toque e como desistir (antes: a linha dos botoes, que apontava o botao Não)
    const h = await cena87(OK_LIGADO);
    const id = msgDoOk(h);
    const tToque = h.t;
    await lerTg(h, [toqueOk(h, h.pedido, 'sim', id)]);
    const recados = () => h.entregas.map((p) => [p.sessionId, p.providerMsgId.replace(/\d+$/, ''), p.texto]);
    assert.deepEqual(recados(), [['S1', 'tgok-u', 'Sim']], 'o toque no Sim virou o recado pra aba');
    h.t += 1000;
    const u = msgTg(h, 'não', { respondeA: id });
    await lerTg(h, [u]);
    assert.deepEqual(recados(), [['S1', 'tgok-u', 'Sim']], 'o "não" digitado nao vira fala pra central nem pra aba');
    assert.deepEqual(linhasSistema(h), [TXT.jaTocouSim(horaBRT(iso(tToque)))]);
    assert.equal(estado(h).okTg.mensagens.ABC234.toque.acao, 'sim', 'o toque anotado segue Sim');
  }
  {
    // envio incerto: o Sim tocado numa 2a mensagem do pedido (entra em `outras`, etapa D); "não" em cima DELA = a linha
    // (T7i: a do toque)
    const h = await cena87(OK_LIGADO);
    const tToque = h.t;
    await lerTg(h, [toqueOk(h, h.pedido, 'sim', 5555)]);
    assert.deepEqual(estado(h).okTg.mensagens.ABC234.outras, [5555], 'a 2a mensagem entrou em outras');
    h.t += 1000;
    const antes = h.entregas.length;
    const u = msgTg(h, 'não', { respondeA: 5555 });
    await lerTg(h, [u]);
    assert.equal(h.entregas.length, antes, 'o "não" em cima da 2a mensagem nao vira fala');
    assert.deepEqual(linhasSistema(h), [TXT.jaTocouSim(horaBRT(iso(tToque)))]);
  }
  {
    // o pedido citado saiu de pendente DURANTE a leitura longa (a aba conferiu o Sim; a mensagem dele so fecha na volta
    // seguinte) e outro pedido segue aberto: o "sim" em cima do decidido nao vira a linha do outro (segue pra central)
    const h = await cena87(OK_LIGADO);
    aba(h, 'S2', 'Bravo');
    pedidoOk(h, { codigo: 'DEF567', sessionId: 'S2', criado: h.t, extra: { titulo: 'Bravo' } });
    await h.p.esperarTelegram(15000); // manda a mensagem do DEF567
    h.t += 1000;
    h.tg.zerar();
    assert.ok(Number.isSafeInteger(msgDoOk(h, 'DEF567')), 'o DEF567 no chat');
    const id = msgDoOk(h);
    h.tg.lotes.push(() => {
      const arq = path.join(h.env.SESSOES_WPP_DIR, 'oks', 'ABC234.json');
      fs.writeFileSync(arq, JSON.stringify({ ...JSON.parse(fs.readFileSync(arq, 'utf8')), status: 'usado', usadoEm: iso(h.t) }));
      return [msgTg(h, 'sim', { respondeA: id })];
    });
    await h.p.esperarTelegram(15000);
    assert.deepEqual(h.entregas.map((p) => [p.sessionId, p.texto]), [['SC', 'sim']], 'em cima do pedido ja decidido: roteamento de hoje');
    assert.ok(!linhasSistema(h).includes(TXT.okBotoes), 'sem a linha dos botoes do outro pedido');
  }
  // revisao da etapa D (item 15): o "ok" em cima da mensagem aberta do pedido saiu daqui (agora e a linha dos botoes, 87e)
  {
    const h = await cena87(OK_LIGADO);
    const u = msgTg(h, 'sim', { respondeA: 4242 });
    await lerTg(h, [u]);
    assert.deepEqual(h.entregas.map((p) => [p.sessionId, p.texto]), [['SC', 'sim']], 'sim em cima de outra mensagem: vai pra central');
    assert.ok(!linhasSistema(h).includes(TXT.okBotoes), 'sim em cima de outra mensagem: sem a linha do OK');
  }
});

// T30 (Eric 18/10/2026 19:43): o contrato do 87e mudou de sentido: o texto que nao e "sim"/"nao" em cima do pedido agora
// vai pra aba do pedido como comentario (com a nota), nunca pra central nem vira a linha dos botoes.
test('T7b2b 87e (revisao da etapa D, item 15; T30). texto que nao e "sim"/"nao" em cima da mensagem aberta de um pedido de OK aberto, com o OK pelo botao ligado = vai pra aba DO PEDIDO com a nota do comentario (nunca pra central, nem com o nome de outra aba), sem a linha dos botoes; OK desligado = o roteamento de hoje', async () => {
  for (const texto of ['beleza', 'o que vai sair?', 'ok', 'Faro: publica']) {
    const h = await cena87(OK_LIGADO);
    const u = msgTg(h, texto, { respondeA: msgDoOk(h) });
    await lerTg(h, [u]);
    assert.ok(!linhasSistema(h).includes(TXT.okBotoes), texto);
    assert.deepEqual(h.entregas.map((p) => [p.sessionId, p.texto, p.nota]), [['S1', texto, `Comentário em cima do pedido de OK ABC234: não é resposta ao OK; o OK só vale pelo botão e segue pendente.`]], `${texto}: pra aba do pedido`);
    assert.deepEqual(apagadas(h), [], `${texto}: a mensagem dele fica`);
  }
  // OK desligado com uma entrada aberta no estado (o OK foi desligado depois): o roteamento de hoje
  const h = await cena87({ telegram: { ligado: true } });
  mexer(h, (e) => {
    e.okTg.mensagens.ABC234 = { messageId: 4343, outras: [], sessionId: 'S1', completo: false, enviadoEm: iso(h.t), toque: null, fechadoEm: null, fim: null };
  });
  await lerTg(h, [msgTg(h, 'beleza', { respondeA: 4343 })]);
  assert.deepEqual(h.entregas.map((p) => [p.sessionId, p.texto]), [['SC', 'beleza']], 'OK desligado: vai pra central');
  assert.ok(!linhasSistema(h).includes(TXT.okBotoes));
});

test('T7i 117. passo 4 com o toque ja anotado (os botoes sairam no toque): "sim"/"não" solto ou qualquer texto em cima da mensagem do pedido = "Você já tocou em Sim às HH:MM. Pra desistir, ..." (Nao: "Você já tocou em Não às HH:MM."), em cima da mensagem dele, notificando, nada repassado e o toque fica; 2 pedidos: algum sem toque = a linha dos botoes; os 2 tocados = o toque mais recente', async () => {
  // T30: o "espera" em cima do pedido saiu daqui (texto que nao e "sim"/"nao" vira comentario pra aba: tests/porteiro-t30)
  for (const [acao, texto, citar] of [['sim', 'não', false], ['sim', 'n', true], ['nao', 'sim', false], ['nao', 'sim', true]]) {
    const nome = `${acao} / ${texto} / ${citar ? 'em cima' : 'solto'}`;
    const h = await cena87(OK_LIGADO);
    const id = msgDoOk(h);
    const tToque = h.t;
    await lerTg(h, [toqueOk(h, h.pedido, acao, id)]);
    h.t += 1000;
    h.tg.zerar();
    const antes = h.entregas.length;
    const u = msgTg(h, texto, citar ? { respondeA: id } : {});
    await lerTg(h, [u]);
    const linha = acao === 'sim' ? TXT.jaTocouSim(horaBRT(iso(tToque))) : TXT.jaTocouNao(horaBRT(iso(tToque)));
    assert.deepEqual(linhasSistema(h), [linha], nome);
    assert.equal(h.entregas.length, antes, `${nome}: nada repassado`);
    const env = h.tg.de('enviar').map((x) => x.args[0]);
    assert.equal(env.length, 1, nome);
    assert.equal(env[0].responderA, mid(u), `${nome}: em cima da mensagem dele`);
    assert.equal(env[0].silencioso, false, `${nome}: notifica`);
    assert.equal(estado(h).okTg.mensagens.ABC234.toque.acao, acao, `${nome}: o toque fica`);
  }
  // 2 pedidos abertos com mensagem no chat
  const h = await cena87(OK_LIGADO);
  aba(h, 'S2', 'Bravo');
  const p2 = pedidoOk(h, { codigo: 'DEF567', sessionId: 'S2', criado: h.t, extra: { titulo: 'Bravo' } });
  await h.p.esperarTelegram(15000); // a mensagem do DEF567 sai
  h.t += 1000;
  assert.ok(Number.isSafeInteger(msgDoOk(h, 'DEF567')), 'o DEF567 no chat');
  await lerTg(h, [toqueOk(h, h.pedido, 'sim', msgDoOk(h))]);
  h.t += 1000;
  h.tg.zerar();
  await lerTg(h, [msgTg(h, 'sim')]);
  assert.equal(linhasSistema(h).at(-1), TXT.okBotoes, 'o DEF567 ainda tem os botoes: a linha dos botoes');
  h.t += 2 * MIN;
  const tNao = h.t;
  await lerTg(h, [toqueOk(h, p2, 'nao', msgDoOk(h, 'DEF567'))]);
  h.t += 1000;
  h.tg.zerar();
  await lerTg(h, [msgTg(h, 'sim')]);
  assert.equal(linhasSistema(h).at(-1), TXT.jaTocouNao(horaBRT(iso(tNao))), 'os 2 tocados: o toque mais recente (o Não do DEF567)');
});

// ---------------------------------------------------------------------------------------------------------------
// T7b2b 89: pendencias sem o pedido em que o dono ja tocou

// "HH:MM" de Brasilia no dia do T0 (T0 = 12:00)
const aos = (hhmm) => { const [hh, mm] = hhmm.split(':').map(Number); return T0 + ((hh - 12) * 60 + mm) * MIN; };
// T9: o "pendencias" do Telegram e o painel; as linhas de antes refeitas dos itens dele (T14: o esperando, com a fechada marcada)
async function pendenciasTg(h) {
  h.tg.zerar();
  await lerTg(h, [msgTg(h, '/pendencias')]);
  const d = estado(h).tg.painel.dados;
  const itens = d.esperando.map((x) => ({ ...x, fechada: x.fechada === true }));
  if (!itens.length) return 'Nada esperando resposta sua.';
  const ms = (x) => { const v = Date.parse(x.hora); return Number.isFinite(v) ? v : Infinity; };
  itens.sort((a, b) => ms(a) - ms(b) || a.titulo.localeCompare(b.titulo, 'pt-BR'));
  return itens.map((x) => `- ${x.titulo} (${horaBRT(x.hora)}${x.fechada ? ', fechada' : ''}): ${x.texto}`).join('\n');
}
async function pendenciasGrupo(h) {
  h.enviados.length = 0;
  msg(h, { content: 'pendencias' });
  await h.p.passoGrupo();
  return h.enviados.map((x) => x.texto);
}

// O e.okTg nasce na etapa D (estadoNovo e completarEstado; PLANO-T7.md, "T7b2a no Desenho 1b"): aqui o porteiro so LE.
// O teste grava o e.okTg no estado.json, no formato da D, e o completarEstado da D o carrega do disco: o textoPendencias
// ve o toque anotado pelo caminho de verdade (o comando no Telegram e no grupo). Revisao da etapa E: sem acessor no
// Object.prototype (ele respondia em qualquer objeto, e ler o toque de e.tg.okTg passava verde).
async function comOkTg(h, okTg, fn) {
  mexer(h, (e) => { e.okTg = okTg; });
  return fn();
}
// 1 mensagem do pedido no formato da etapa D: {messageId, outras, sessionId, completo, enviadoEm, toque, fechadoEm, fim}
const mensagemOk = (messageId, sessionId, enviado, toque = null) => ({
  messageId, outras: [], sessionId, completo: false, enviadoEm: iso(enviado), toque, fechadoEm: null, fim: null,
});

async function cena89() {
  const h = montar();
  for (const [sid, titulo] of [['S1', 'Alfa'], ['S2', 'Bravo'], ['S3', 'Charlie'], ['S4', 'Delta']]) aba(h, sid, titulo);
  ligarTg(h);
  h.t = aos('12:20');
  pedidoOk(h, { codigo: 'KMN345', sessionId: 'S1', criado: aos('12:10'), extra: { tipo: 'outro', acao: 'arquivar o relatório de setembro.' } });
  pedidoOk(h, { codigo: 'ABC234', sessionId: 'S1', criado: aos('12:11'), extra: { tipo: 'outro', acao: 'apagar a planilha velha.' } });
  pedidoOk(h, {
    codigo: 'DEF567', sessionId: 'S2', criado: aos('12:12'),
    extra: { tipo: 'mensagem', destinatarios: ['Ana'], acao: 'mandar o resumo da reunião.' },
  });
  pedidoOk(h, { codigo: 'GHJ892', sessionId: 'S3', criado: aos('12:13'), extra: { tipo: 'publicacao', acao: 'subir o site novo.' } });
  pedidoOk(h, { codigo: 'PQR678', sessionId: 'S4', criado: aos('12:14'), extra: { tipo: 'crm', acao: 'marcar o negócio como ganho.' } });
  return h;
}
const L = {
  alfaNovo: '- Alfa (12:11): Pedido de OK (ação): apagar a planilha velha. Vale até 12:41.',
  alfaVelho: '- Alfa (12:10): Pedido de OK (ação): arquivar o relatório de setembro. Vale até 12:40.',
  bravo: '- Bravo (12:12): Pedido de OK (mensagem pra Ana): mandar o resumo da reunião. Vale até 12:42.',
  charlie: '- Charlie (12:13): Pedido de OK (publicação): subir o site novo. Vale até 12:43.',
  delta: '- Delta (12:14): Pedido de OK (CRM): marcar o negócio como ganho. Vale até 12:44.',
};
const TODOS = [L.alfaNovo, L.bravo, L.charlie, L.delta];
// Alfa tocou Sim no ABC234 (o mais novo dela) e Bravo tocou Nao no DEF567; Charlie tem a mensagem sem toque e Delta nem
// mensagem no chat.
const OK_TOCADO = () => ({
  iniciadoEm: iso(aos('12:00')),
  segurar: 4101,
  mensagens: {
    KMN345: mensagemOk(960, 'S1', aos('12:10')),
    ABC234: mensagemOk(961, 'S1', aos('12:11'), { acao: 'sim', em: iso(aos('12:16')), updateId: 4101 }),
    DEF567: mensagemOk(962, 'S2', aos('12:12'), { acao: 'nao', em: iso(aos('12:17')), updateId: 4102 }),
    GHJ892: mensagemOk(963, 'S3', aos('12:13')),
  },
});

test('T7b2b 89. pendencias: o pedido com o toque do dono anotado (Sim ou Nao) sai, no Telegram e no grupo; sem toque ou sem mensagem no chat fica; a aba com outro pedido aberto mostra esse', async () => {
  const h = await cena89();
  const depois = [L.alfaVelho, L.charlie, L.delta];
  await comOkTg(h, OK_TOCADO(), async () => {
    assert.equal(await pendenciasTg(h), depois.join('\n'));
    assert.equal(h.tg.de('enviar').length, 1);
    h.t += MIN;
    assert.deepEqual(await pendenciasGrupo(h), [[CAB, ...depois].join('\n')]);
  });
});

test('T7b2b 89b. sem o e.okTg (ou sem mensagens, ou com o toque null) = como hoje: todos os pedidos abertos na lista', async () => {
  const h = await cena89();
  assert.equal(await pendenciasTg(h), TODOS.join('\n'), 'sem o e.okTg');
  h.t += MIN;
  assert.deepEqual(await pendenciasGrupo(h), [[CAB, ...TODOS].join('\n')], 'sem o e.okTg, no grupo');
  const semToque = OK_TOCADO();
  semToque.mensagens.ABC234.toque = null;
  semToque.mensagens.DEF567.toque = null;
  for (const okTg of [null, { iniciadoEm: iso(aos('12:00')), segurar: null }, { iniciadoEm: iso(aos('12:00')), segurar: null, mensagens: null }, semToque]) {
    h.t += MIN;
    await comOkTg(h, okTg, async () => {
      assert.equal(await pendenciasTg(h), TODOS.join('\n'), JSON.stringify(okTg));
    });
  }
});

test('T7b2b 89c. a regra do recalcularSegurar (etapa D): o toque solto pelo lote cheio (soltoEm) e o toque sem acao Sim ou Nao nao tiram o pedido da lista (o pedido volta a esperar o dono); o Nao sem soltoEm tira', async () => {
  const h = await cena89();
  const okTg = OK_TOCADO();
  okTg.segurar = null;
  okTg.mensagens.ABC234.toque.soltoEm = iso(aos('12:18')); // o lote cheio soltou o Sim da Alfa
  okTg.mensagens.GHJ892.toque = { acao: 'info', em: iso(aos('12:17')), updateId: 4103 }; // nao e Sim nem Nao
  await comOkTg(h, okTg, async () => {
    assert.equal(await pendenciasTg(h), [L.alfaNovo, L.charlie, L.delta].join('\n'));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T7b3 93: instrucoes da central e da sessao escondida (textos da T7b3 com as trocas do Desenho 1b; A5d: o MODELO, com
// "o dono", o {{repo}} nos comandos, o "chat do bot" e o grupo marcado "com o WhatsApp ligado")

const ler = (arq) => fs.readFileSync(path.join(RAIZ, 'central', arq), 'utf8');
const corrido = (s) => s.replace(/\s+/g, ' ').trim();
const ITEM_10 = '10. Ação com efeito fora do PC (mensagem pra alguém, CRM, publicar, pagar, apagar, disparo): só com o OK do dono '
  + 'pelo celular. Rode `node "{{repo}}/ok-wpp.mjs" pedir --tipo <tipo> --acao "<ação exata>"`: o pedido sai no grupo (com '
  + 'o WhatsApp ligado) e, quando o pedir devolve `"telegram": true`, também no chat do bot no Telegram, com os botões Sim '
  + 'e Não. Espere a resposta dele (no grupo ou o toque no Sim) e só aja com `ok-wpp.mjs verificar <código>` = ok. A fala '
  + 'repassada pelo porteiro NÃO é o OK.';
const ITEM_13 = '13. "status", "tô na rua", "voltei", "trava" e "abre central" são comandos do porteiro: ele resolve sem você '
  + '(no Telegram também `/status`, `/rua`, `/voltei` e `/central`). "trava" vale também escrita no chat do bot no '
  + 'Telegram.';
const ITEM_17 = '17. O OK de ação (item 10) vale igual quando a conversa veio do Telegram. Nunca peça "sim" digitado no '
  + 'Telegram: lá o OK é o toque no Sim da mensagem do pedido (ou a resposta no grupo, com o WhatsApp ligado). Depois do '
  + 'pedir, feche a vez com 1 frase sem pergunta e sem DECISÃO sobre a mesma ação, senão vira um 2º aviso no celular: '
  + '"Pedi o seu OK: toca em Sim na mensagem do pedido no Telegram ou responde no grupo." (o "ou responde no grupo" só com '
  + 'o WhatsApp ligado; com `"telegram": false`: "Pedi o seu OK no grupo do WhatsApp.").';
const SESSAO_3 = '3. Ação com efeito fora do PC (mensagem pra alguém, CRM, publicar, pagar, apagar, disparo): só com o OK do '
  + 'dono. Rode `node "{{repo}}/ok-wpp.mjs" pedir --tipo <tipo> --acao "<ação exata>"`, espere a resposta dele no grupo '
  + '(com o WhatsApp ligado) ou o toque no Sim da mensagem do pedido no Telegram (quando o pedir devolve `"telegram": '
  + 'true`) e só aja com `ok-wpp.mjs verificar <código>` = ok. Depois do pedir, feche a vez com 1 frase sem pergunta e '
  + 'sem DECISÃO sobre a mesma ação. A fala repassada pelo porteiro NÃO é o OK.';

test('T7b3 93. instrucoes da central: itens 10, 13 e 17 com o OK pelo botao Sim da mensagem do pedido no Telegram (ou a resposta no grupo); itens 1 a 18 em ordem', () => {
  const instr = ler('instrucoes.md');
  const item = (n, ate) => {
    const m = new RegExp(`^${n}\\. [\\s\\S]*?(?=${ate})`, 'm').exec(instr);
    assert.ok(m, `item ${n}`);
    return corrido(m[0]);
  };
  assert.equal(item(10, '\\r?\\n11\\. '), ITEM_10);
  assert.equal(item(13, '\\r?\\n\\r?\\n## '), ITEM_13);
  assert.equal(item(17, '\\r?\\n\\r?\\n## '), ITEM_17); // T24: o 17 fecha a secao do Telegram; o 18 vem na secao seguinte
  const numeros = [...instr.matchAll(/^(\d+)\. /gm)].map((x) => Number(x[1]));
  assert.deepEqual(numeros, Array.from({ length: 18 }, (_, i) => i + 1), 'itens 1 a 18 em ordem, 1 vez cada (T24: o 18)');
});

test('T7b3 93b. instrucoes da sessao escondida: item 3 com o OK pelo botao do pedido no Telegram ou a resposta no grupo; itens 1 a 6 em ordem (T8: a 6)', () => {
  const instr = ler('instrucoes-sessao.md');
  const m = /^3\. [\s\S]*?(?=\r?\n4\. )/m.exec(instr);
  assert.ok(m, 'item 3 seguido do 4');
  assert.equal(corrido(m[0]), SESSAO_3);
  const numeros = [...instr.matchAll(/^(\d+)\. /gm)].map((x) => Number(x[1]));
  assert.deepEqual(numeros, [1, 2, 3, 4, 5, 6]); // T8: a 6 (a copia reaberta pelo celular segue de onde parou)
});

test('T7b3 93c. as 2 instrucoes citam o toque no Sim, o "telegram": true do pedir e o verificar; nenhuma diz que o OK e so no WhatsApp', () => {
  for (const arq of ['instrucoes.md', 'instrucoes-sessao.md']) {
    const instr = corrido(ler(arq));
    assert.ok(instr.includes('toque no Sim'), `${arq}: toque no Sim`);
    assert.ok(instr.includes('`"telegram": true`'), `${arq}: "telegram": true do pedir`);
    assert.ok(instr.includes('ok-wpp.mjs verificar <código>` = ok'), `${arq}: verificar`);
    assert.doesNotMatch(instr, /OK pelo WhatsApp|só no WhatsApp|pedido de OK no WhatsApp/, arq);
  }
});
