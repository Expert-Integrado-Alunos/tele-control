// Testes da T7b2a no Desenho 1b (etapa D da Aceleracao; PLANO-T7.md, "T7b2a no Desenho 1b (contrato fechado)", com os
// textos da secao "T7b2a" e da "F5 decidida"): o pedido de OK sai com os botoes Sim e Nao no PROPRIO chat do bot,
// pelo porteiro; o toque vira recado pra aba (sem a acao) e o porteiro SEGURA o update do toque (offset preso) ate a aba
// conferir, porque o verificar espia o bot a partir do e.tg.offset que o porteiro grava.
// Por que existe: o toque no Sim vira autorizacao de acao irreversivel. O porteiro so aponta (nunca grava o arquivo do
// pedido, nunca mexe no grupo, nunca poe a acao no recado) e nao pode perder o toque antes de a aba conferir.
// Isolamento: pastas temporarias (prefixo "t7b2a-") via SESSOES_WPP_DIR, CLAUDE_SESSIONS_DIR, CLAUDE_PROJECTS_DIR e
// SESSOES_WPP_LOG; nunca o ~/.claude real. Nenhuma rede: o `tg` e um duble (lerAtualizacoes com lotes roteirizados; o
// resto grava as chamadas). Relogio e `dormir` falsos. Harness copiado do tests/porteiro-telegram.test.mjs.
// Revisao adversarial (03/10/2026, 2 revisores, veredito "corrigir"): os testes 80c em diante levam "(revisao, item N)"
// no nome. Os de defeito ficam vermelhos no codigo de antes da correcao; os de "teste que nao prende" prendem a sabotagem
// que passava. O duble falha rapido quando a leitura nao anda o relogio (laco sem fim no porteiro, item 13).
// Rodar: node --test --test-reporter=tap "tests/porteiro-ok-tg.test.mjs"
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { criarPorteiro, destravar, FRASES } from '../porteiro.mjs';
import { montarOkTg, montarOkTgFechado } from '../lib/ok-tg.mjs';
import { horaBRT } from '../lib/formato.mjs';
import { montarRecado } from '../mensageiro.mjs';
import { NUMERO_DONO } from './lib/dados-whatsapp.mjs';
import { CENTRAL_TESTE, RAIZES_TESTE } from './lib/dados-central.mjs';
import { criarCanalTelegram, tgNovo } from '../canal-telegram.mjs';

const require = createRequire(import.meta.url);
const lib = require('../hooks/lib/sessoes-wpp.js');

const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-03T13:00:00Z'); // 10:00 em Brasilia
const iso = (ms) => new Date(ms).toISOString();
const DONO = 700100200;
const BOT = 700900800;
const ACAO = 'subir o site X em produção';

// Textos do contrato (PLANO-T7.md: "F5 decidida" e "T7b2a", bloco "Textos novos"), por extenso de proposito.
const TXT = {
  anoteiSim: 'Anotei: Sim. Passando pra aba.',
  anoteiNao: 'Anotei: Não. Passando pra aba.',
  jaAnotei: (quem, hora) => `Já anotei: você tocou em ${quem} às ${hora}.`,
  jaRespondido: 'Esse pedido já foi respondido.',
  expirou: 'Esse pedido expirou.',
  mudou: 'Essa pergunta já mudou.',
  travado: 'Travado. Destrava no PC.',
  conferiu: (a, b) => `Você tocou em Sim às ${a}. A aba conferiu às ${b}.`,
  cancelado: (a) => `Você tocou em Não às ${a}. Pedido cancelado.`,
  naoConferiu: (a, b) => `Você tocou em Sim às ${a}, mas a aba não conferiu até ${b}: expirou.`,
  naoEntregue: (a, frase) => `Você tocou em Sim às ${a}, mas não consegui entregar na aba: ${frase}`,
  peloWhatsapp: (a) => `Respondido pelo WhatsApp às ${a}.`,
  expirouSem: (a) => `Expirou às ${a} sem resposta.`,
  naoVale: 'Esse pedido não vale mais.',
};
const SIM = (cod) => ({ texto: 'Sim', dados: `k:${cod}:s`, estilo: 'success' });
const NAO = (cod) => ({ texto: 'Não', dados: `k:${cod}:n`, estilo: 'danger' });
const MAIS = (cod) => ({ texto: 'Mais informações', dados: `k:${cod}:i` });

// ---------- harness (copia do tests/porteiro-telegram.test.mjs + enviarTexto/editarTexto/editarBotoes) ----------

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

// Revisao (item 13): leituras seguidas com o relogio parado ate o duble desistir. Laco sem fim no porteiro (ex.: o
// segurar sem os 2 s entre leituras) vira erro em segundos, nao o estouro dos 900 s do sabotar.
const LEITURAS_SEM_RELOGIO = 200;
const montados = []; // os h do teste em curso (o afterEach confere o laco sem fim e esvazia)

// Duble do criarTelegram. Os message_id saem de UM contador (h.nMid), como no chat de verdade: mensagem do dono e do bot
// se intercalam. `resp<Metodo>` = fila de respostas roteirizadas (objeto ou funcao); vazia = ok. Sem lote na fila: o
// `janela` (Telegram de mentira, filaTelegram) ou a espera vazia que anda o relogio. Revisao (item 13): 200 leituras
// seguidas sem o relogio andar = `lacoSemFim` e toda leitura dai em diante lanca com mensagem clara (o porteiro espera 5 s
// a cada erro e a volta acaba; o afterEach reprova o teste).
function dubleTg(h) {
  const tg = {
    chamadas: [], lotes: [], respEnviar: [], respEnviarTexto: [], respEditarTexto: [], respEditarBotoes: [], respApagar: [], aoToque: null,
    lacoSemFim: false, janela: null,
  };
  const gravar = (metodo, args) => { tg.chamadas.push({ metodo, args }); };
  const novoId = () => { h.nMid += 1; return h.nMid; };
  const roteiro = (fila) => {
    const r = fila.shift();
    return typeof r === 'function' ? r() : r;
  };
  let ultimaT = null;
  let seguidas = 0;
  tg.lerAtualizacoes = async (args) => {
    gravar('lerAtualizacoes', { ...args });
    seguidas = h.t === ultimaT ? seguidas + 1 : 0;
    ultimaT = h.t;
    if (tg.lacoSemFim || seguidas >= LEITURAS_SEM_RELOGIO) {
      tg.lacoSemFim = true;
      throw new Error(`duble: ${LEITURAS_SEM_RELOGIO} leituras seguidas sem o relogio andar (laco sem fim no porteiro?)`);
    }
    if (tg.chamadas.length > 20000) throw new Error('duble: leitura demais (laco sem fim?)');
    const lote = tg.lotes.shift();
    if (lote === undefined) {
      if (typeof tg.janela === 'function') return tg.janela(args);
      h.t += (Number(args?.esperaS) || 0) * 1000;
      return [];
    }
    if (lote instanceof Error) throw lote;
    return typeof lote === 'function' ? lote(args) : lote;
  };
  tg.enviar = async (pedido) => {
    gravar('enviar', [pedido]);
    return roteiro(tg.respEnviar) ?? { ok: true, messageId: novoId(), formato: 'rich' };
  };
  tg.editar = async (messageId, pedido) => { gravar('editar', [messageId, pedido]); return { ok: true }; };
  tg.apagar = async (messageId) => { gravar('apagar', [messageId]); return roteiro(tg.respApagar) ?? { ok: true }; }; // T7j: respApagar
  tg.editarBotoes = async (messageId, botoes) => {
    gravar('editarBotoes', [messageId, botoes]);
    return roteiro(tg.respEditarBotoes) ?? { ok: true };
  };
  tg.responderToque = async (id, texto) => {
    gravar('responderToque', [id, texto]);
    if (tg.aoToque) tg.aoToque(id, texto);
    return { ok: true };
  };
  tg.enviarTexto = async (pedido) => {
    gravar('enviarTexto', [pedido]);
    return roteiro(tg.respEnviarTexto) ?? { ok: true, messageId: novoId() };
  };
  tg.editarTexto = async (messageId, pedido) => {
    gravar('editarTexto', [messageId, pedido]);
    return roteiro(tg.respEditarTexto) ?? { ok: true };
  };
  tg.baixar = async () => ({ ok: false, erro: 'duble sem download' });
  tg.quemSou = async () => { gravar('quemSou', []); return { ok: true, id: BOT, username: 'Teste_ControleBot' }; };
  tg.definirComandos = async (c) => { gravar('definirComandos', [c]); return { ok: true }; };
  tg.de = (metodo) => tg.chamadas.filter((c) => c.metodo === metodo);
  return tg;
}

// `ok` = config.json com telegram.ligado e telegram.ok.ligado (o OK pelo botao ligado); false = sem config.json.
// A1: `identTg` = o chat e o bot que o rodar le do config.json (padrao: os de antes, que estes testes usam).
function montar({ ok = true, ensaio = false, respostasEntrega = [], sondaTg = false, identTg = { chatId: DONO, botId: BOT } } = {}) {
  const raiz = pastaTemp('t7b2a-');
  const env = {
    SESSOES_WPP_DIR: path.join(raiz, 'estado'),
    CLAUDE_SESSIONS_DIR: path.join(raiz, 'sessions'),
    CLAUDE_PROJECTS_DIR: path.join(raiz, 'projects'),
    SESSOES_WPP_LOG: path.join(raiz, 'porteiro.log'),
  };
  for (const d of [env.SESSOES_WPP_DIR, env.CLAUDE_SESSIONS_DIR, env.CLAUDE_PROJECTS_DIR]) fs.mkdirSync(d, { recursive: true });
  if (ok) {
    fs.writeFileSync(path.join(env.SESSOES_WPP_DIR, 'config.json'), JSON.stringify({ telegram: { ligado: true, ok: { ligado: true, naAba: false } } }));
  }
  const h = {
    raiz, env, t: T0, idle: 0, grupo: [], enviados: [], reacoes: [], edicoesGrupo: [], entregas: [], nReg: 0, nMsg: 0,
    nUpd: 100, nMid: 7000, dormidas: [], aberturas: 0,
  };
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
    wpp: h.wpp, numeroDono: NUMERO_DONO, mensageiro: h.mensageiro, ocioso: async () => h.idle, agora: () => h.t, env, ensaio, tg: h.tg,
    abrirCentral: () => { h.aberturas += 1; }, rand: randFixo(), dormir: async (ms) => { h.dormidas.push(ms); h.t += ms; },
    sondaTg, identTg,
    central: CENTRAL_TESTE, raizesSessao: RAIZES_TESTE, // A3a: a central e as pastas como o dono configura
  };
  h.cru = criarPorteiro(h.opcoes);
  h.p = comBomba(h.cru);
  h.t += 1000; // o que o teste cria nasce depois do estado novo (e do iniciadoEm)
  montados.push(h);
  return h;
}
// Revisao (item 13): o duble que desistiu (laco sem fim no porteiro) reprova o teste com a mensagem dele.
afterEach(() => {
  const ruins = montados.filter((h) => h.tg.lacoSemFim);
  montados.length = 0;
  assert.equal(ruins.length, 0, `duble: ${LEITURAS_SEM_RELOGIO} leituras seguidas sem o relogio andar (laco sem fim no porteiro)`);
});
// Telegram de mentira com a semantica da Bot API (revisao): getUpdates(offset > 0) confirma (apaga) os ids < offset e
// devolve os >= offset (ate 100); offset 0 = os 100 primeiros nao confirmados; negativo -N = os N ultimos. A leitura que
// devolve algo gasta `msPorLeitura` (vazia = a espera, como o duble).
function filaTelegram(h, { msPorLeitura = 0 } = {}) {
  const fila = [];
  const confirmados = new Set();
  h.tg.janela = (args) => {
    const off = Number(args?.offset);
    if (Number.isSafeInteger(off) && off > 0) for (const u of fila) if (u.update_id < off) confirmados.add(u.update_id);
    const vivos = fila.filter((u) => !confirmados.has(u.update_id));
    let out;
    if (Number.isSafeInteger(off) && off > 0) out = vivos.filter((u) => u.update_id >= off).slice(0, 100);
    else if (Number.isSafeInteger(off) && off < 0) out = vivos.slice(off);
    else out = vivos.slice(0, 100);
    h.t += out.length ? msPorLeitura : (Number(args?.esperaS) || 0) * 1000;
    return out;
  };
  return { fila, confirmados, por: (u) => fila.push(u) };
}
// Esvazia a fila de entrega (o bombear para em 100 voltas).
async function bombearTudo(p) {
  for (let i = 0; i < 2000; i++) {
    const r = await p.passoEntrega();
    if (!r.emVoo && !r.fila) return;
    await tique();
  }
  throw new Error('bombearTudo: a fila de entrega nao esvaziou');
}
// Resposta de envio incerto (timeout: a mensagem chegou e gastou o id seguinte do chat); `anotar(id)` recebe o id gasto.
function incerto(h, metodo, anotar = () => {}) {
  return () => {
    h.nMid += 1;
    anotar(h.nMid);
    return { ok: false, incerto: true, erro: `${metodo}: timeout`, codigo: 0 };
  };
}
// Porteiro religado sobre o mesmo estado (mesmo duble, mesmo relogio).
function religar(h) {
  h.cru = criarPorteiro(h.opcoes);
  h.p = comBomba(h.cru);
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
function msg(h, o = {}) {
  h.nMsg += 1;
  const m = {
    id: `uuid-${h.nMsg}`, provider_msg_id: `PROV${h.nMsg}`, quoted_msg_id: null, sent_by_agent: false, message_type: 'text',
    content: null, transcription: null, direction: 'received', from_me: false, sender_phone: NUMERO_DONO, message_ts: iso(h.t), ...o,
  };
  h.grupo.push(m);
  return m;
}
const estado = (h, nome = 'estado.json') => JSON.parse(fs.readFileSync(path.join(h.env.SESSOES_WPP_DIR, nome), 'utf8'));
function mexer(h, fn, nome = 'estado.json') {
  const arq = path.join(h.env.SESSOES_WPP_DIR, nome);
  const e = JSON.parse(fs.readFileSync(arq, 'utf8'));
  fn(e);
  fs.writeFileSync(arq, JSON.stringify(e));
}
const ligarTg = (h, nome) => mexer(h, (e) => { e.tg.offset = 0; }, nome); // historico ja pulado
const logs = (h) => {
  try { return fs.readFileSync(h.env.SESSOES_WPP_LOG, 'utf8').split('\n').filter(Boolean); } catch { return []; }
};
async function ligarRua(h) {
  h.idle = 30 * MIN;
  await h.p.passoMinuto();
  assert.equal(estado(h).modoRua.ligado, true);
}

// Mensagem do dono no chat do bot (como o getUpdates devolve).
function msgTg(h, texto, { extra = {} } = {}) {
  h.nUpd += 1;
  h.nMid += 1;
  const m = {
    message_id: h.nMid, date: Math.floor(h.t / 1000),
    chat: { id: DONO, type: 'private', first_name: 'Davi' }, from: { id: DONO, is_bot: false, first_name: 'Davi' }, ...extra,
  };
  if (texto !== undefined) m.text = texto;
  return { update_id: h.nUpd, message: m };
}
// Mensagem de outro chat (o canal ignora): enche lote sem virar fala.
function deFora(h) {
  h.nUpd += 1;
  return { update_id: h.nUpd, message: { message_id: 1, date: Math.floor(h.t / 1000), chat: { id: 555, type: 'private' }, from: { id: 555, is_bot: false }, text: 'oi' } };
}
// Toque num botao de chamado (dados do formato-tg).
function toqueTg(h, dados, messageId) {
  h.nUpd += 1;
  return {
    update_id: h.nUpd,
    callback_query: { id: `q${h.nUpd}`, from: { id: DONO, is_bot: false }, message: { message_id: messageId, chat: { id: DONO, type: 'private' } }, data: dados },
  };
}

// Pedido de OK como o ok-wpp grava (oks/<COD>.json, com o titulo que remonta a mensagem).
const arqOk = (h, cod) => path.join(h.env.SESSOES_WPP_DIR, 'oks', `${cod}.json`);
function pedidoOk(h, { codigo = 'ABC234', sessionId = 'S1', tipo = 'publicacao', acao = ACAO, destinatarios = null, titulo = 'Faro', criado = h.t, status = 'pendente', extra = {} } = {}) {
  fs.mkdirSync(path.dirname(arqOk(h, codigo)), { recursive: true });
  const p = {
    v: 1, codigo, sessionId, titulo, tipo, acao, hashAcao: 'h', destinatarios, criadoEm: iso(criado), expiraEm: iso(criado + 30 * MIN),
    providerMsgId: `PED-${codigo}`, messageId: `UPED-${codigo}`, status, ...extra,
  };
  fs.writeFileSync(arqOk(h, codigo), JSON.stringify(p, null, 2));
  return p;
}
function mudarPedido(h, cod, campos) {
  const p = JSON.parse(fs.readFileSync(arqOk(h, cod), 'utf8'));
  fs.writeFileSync(arqOk(h, cod), JSON.stringify({ ...p, ...campos }, null, 2));
}
// Botoes do porteiro -> o reply_markup que o Telegram devolve no callback_query.message.
const apiTeclado = (botoes) => ({
  inline_keyboard: botoes.map((l) => l.map((b) => ({ text: b.texto, callback_data: b.dados, ...(b.estilo ? { style: b.estilo } : {}) }))),
});
// Toque no botao do pedido de OK, como o getUpdates devolve: a mensagem tocada e a do bot com o texto e o teclado
// montados do pedido (compacto ou completo). Cada campo trocavel pra forjar 1 coisa por vez.
function toqueOk(h, p, acao, o = {}) {
  h.nUpd += 1;
  const r = montarOkTg({ ...p, completo: o.completo === true });
  const letra = { sim: 's', nao: 'n', info: 'i' }[acao];
  return {
    update_id: h.nUpd,
    callback_query: {
      id: `q${h.nUpd}`,
      from: o.from ?? { id: DONO, is_bot: false, first_name: 'Davi' },
      chat_instance: '-1',
      data: o.dados ?? `k:${p.codigo}:${letra}`,
      message: {
        message_id: o.messageId,
        from: { id: BOT, is_bot: true, first_name: 'Bot de Teste' },
        chat: { id: DONO, type: 'private', first_name: 'Davi' },
        date: o.date ?? Math.floor(Date.parse(p.criadoEm) / 1000) + 2,
        text: o.texto ?? r.texto,
        reply_markup: o.teclado ?? apiTeclado(r.botoes),
      },
    },
  };
}
const respostas = (h) => h.tg.de('responderToque').map((c) => (c.args[1] === undefined ? null : c.args[1]));
const okDe = (h, cod) => estado(h).okTg?.mensagens?.[cod];
const enviosOk = (h, cod) => h.tg.de('enviarTexto').filter((c) => c.args[0].botoes?.[0]?.[0]?.dados === `k:${cod}:s`);
const recadosOk = (h) => h.entregas.filter((x) => typeof x.providerMsgId === 'string' && x.providerMsgId.startsWith('tgok-u'));
// Chamado de uma aba ja na tela (montado com um canal auxiliar sobre o estado do disco), pra provar que fica intacto.
async function chamadoNaTela(h, sessionId, titulo) {
  const arq = path.join(h.env.SESSOES_WPP_DIR, 'estado.json');
  const e = JSON.parse(fs.readFileSync(arq, 'utf8'));
  const aux = {
    async enviar() { h.nMid += 1; return { ok: true, messageId: h.nMid, formato: 'rich' }; },
    async editar() { return { ok: true }; },
    async apagar() { return { ok: true }; },
  };
  const canal = criarCanalTelegram({ tg: aux, agora: () => h.t, rand: randFixo() });
  canal.aviso(e, { sessionId, at: iso(h.t), finalTs: iso(h.t), final: 'Pedi o seu OK.\n\nPosso subir?', nome: 'projetos-42' }, titulo);
  await canal.drenar(e);
  fs.writeFileSync(arq, JSON.stringify(e));
  return e.tg.chamados[sessionId].mensagem.messageId;
}
// Recado como chega no transcript da aba (formato medido 27/09).
function peer(pedido, ts) {
  const texto = `Another Claude session sent a message (from repos-99):\n<cross-session-message from="repos-99">\n${montarRecado(pedido)}\n</cross-session-message>`;
  return { type: 'user', isMeta: true, origin: { kind: 'peer', from: 'repos-99' }, timestamp: ts, message: { role: 'user', content: texto } };
}
const falaDaAba = (texto) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: texto }] } });

// Cenario comum: aba S1 "Faro", Telegram com o historico pulado, 1 pedido de OK e a mensagem dele ja no chat.
async function comPedidoNoChat(h, o = {}) {
  aba(h, 'S1', 'Faro');
  ligarTg(h);
  const p = pedidoOk(h, o);
  await h.p.esperarTelegram(15000);
  const m = okDe(h, p.codigo);
  assert.ok(m && Number.isSafeInteger(m.messageId), 'a mensagem do pedido saiu');
  h.tg.chamadas.length = 0;
  return { p, id: m.messageId };
}

// ---------------------------------------------------------------------------------------------------------------
// 80. o pedido sai no chat do bot

test('T7b2a 80. pedido novo com o OK ligado -> 1 enviarTexto (compacto, teclado exato, notificando) e e.okTg.mensagens gravado; nada no grupo nem no canal; 2a volta nao reenvia; antes do iniciadoEm, travado, vencido ou ja decidido nao sai; destravado sai; envio falho tenta de novo em 30 s', async () => {
  const h = montar();
  aba(h, 'S1', 'Faro');
  ligarTg(h);
  const ini = estado(h).okTg?.iniciadoEm;
  assert.ok(Number.isFinite(Date.parse(ini)), 'estado novo ja nasce com o e.okTg.iniciadoEm');
  assert.equal(estado(h).okTg.segurar, null);
  assert.deepEqual(estado(h).okTg.mensagens, {});
  const velho = pedidoOk(h, { codigo: 'VVV234', criado: Date.parse(ini) - MIN }); // de antes do iniciadoEm (ainda no prazo)
  const usado = pedidoOk(h, { codigo: 'UUU234', status: 'usado' });
  const p = pedidoOk(h, { codigo: 'ABC234' });
  await h.p.esperarTelegram(15000);

  const envs = h.tg.de('enviarTexto');
  assert.equal(envs.length, 1, 'so o pedido novo e pendente sai');
  const arg = envs[0].args[0];
  const esperado = montarOkTg({ ...p, completo: false });
  assert.equal(arg.texto, `ℹ️ Faro\nPedido de OK (publicação): ${ACAO}\n\nPosso? Vale até ${horaBRT(p.expiraEm)}.`);
  assert.equal(arg.texto, esperado.texto);
  assert.deepEqual(arg.botoes, [[SIM('ABC234'), NAO('ABC234')], [MAIS('ABC234')]], 'teclado exato');
  assert.notEqual(arg.silencioso, true, 'notificando');
  assert.equal(arg.responderA ?? null, null, 'sem citar nada');
  const m = okDe(h, 'ABC234');
  assert.equal(m.messageId, h.nMid);
  assert.deepEqual(m.outras, []);
  assert.equal(m.sessionId, 'S1');
  assert.equal(m.completo, false);
  assert.equal(m.toque, null);
  assert.equal(m.fechadoEm, null);
  assert.ok(Number.isFinite(Date.parse(m.enviadoEm)));
  assert.equal(okDe(h, velho.codigo), undefined, 'de antes do iniciadoEm nao sai');
  assert.equal(okDe(h, usado.codigo), undefined, 'ja decidido nao sai');
  assert.deepEqual(h.enviados, [], 'nada no grupo');
  assert.deepEqual(h.tg.de('enviar'), [], 'nada no canal (chamados e sistema)');

  await h.p.esperarTelegram(15000);
  assert.equal(h.tg.de('enviarTexto').length, 1, '2a volta nao reenvia');

  // travado nao sai; destravado (no prazo) sai
  mexer(h, (e) => { e.trava = true; });
  const q = pedidoOk(h, { codigo: 'QQQ234' });
  await h.p.esperarTelegram(15000);
  assert.equal(enviosOk(h, 'QQQ234').length, 0, 'travado nao sai');
  destravar({ env: h.env, agora: () => h.t });
  await h.p.esperarTelegram(15000);
  assert.equal(enviosOk(h, 'QQQ234').length, 1, 'destravado no prazo sai');
  assert.equal(okDe(h, q.codigo).sessionId, 'S1');
  // travado ate vencer: depois de destravar nao sai
  mexer(h, (e) => { e.trava = true; });
  pedidoOk(h, { codigo: 'WWW234' });
  h.t += 31 * MIN;
  destravar({ env: h.env, agora: () => h.t });
  await h.p.esperarTelegram(15000);
  assert.equal(enviosOk(h, 'WWW234').length, 0, 'vencido nao sai');

  // envio falho: 1 log e de novo so depois de 30 s
  h.tg.respEnviarTexto.push({ ok: false, erro: 'enviarTexto: fetch failed', codigo: 0 });
  const f = pedidoOk(h, { codigo: 'FFF234' });
  await h.p.esperarTelegram(15000);
  assert.equal(enviosOk(h, f.codigo).length, 1);
  assert.equal(okDe(h, f.codigo), undefined, 'falhou = sem entrada');
  const linhasFalha = logs(h).filter((l) => /FFF234/.test(l) && /falhou/.test(l));
  assert.equal(linhasFalha.length, 1, '1 log');
  assert.ok(linhasFalha.every((l) => !l.includes(ACAO)), 'log sem a acao');
  await h.p.esperarTelegram(15000); // +15 s
  assert.equal(enviosOk(h, f.codigo).length, 1, 'antes de 30 s nao tenta de novo');
  await h.p.esperarTelegram(15000); // +30 s
  assert.equal(enviosOk(h, f.codigo).length, 2, 'com 30 s tenta de novo');
  assert.ok(Number.isSafeInteger(okDe(h, f.codigo).messageId));
  assert.deepEqual(h.enviados, [], 'nada no grupo');
});

test('T7b2a 80b. a sonda do envio incerto nunca sonda nem apaga mensagem de pedido de OK (idsDeFora no drenar)', async () => {
  const h = montar({ sondaTg: true });
  ligarTg(h);
  // 1. a linha do sistema do "status" sai com envio incerto (a mensagem chegou: o id seguinte foi gasto)
  h.tg.respEnviar.push(() => { h.nMid += 1; return { ok: false, incerto: true, erro: 'enviar: timeout', codigo: 0 }; });
  const u1 = msgTg(h, 'status');
  h.tg.lotes.push([u1]);
  await h.p.esperarTelegram(15000);
  const perdido = u1.message.message_id + 1;
  // 2. o pedido de OK sai depois (id acima do da mensagem incerta)
  pedidoOk(h, { codigo: 'ABC234' });
  await h.p.esperarTelegram(15000);
  const idOk = okDe(h, 'ABC234').messageId;
  assert.equal(idOk, perdido + 1);
  // 3. passado o recuo, o reenvio sai e a sonda confere os ids do meio: so o perdido, nunca o do OK
  h.t += 30 * 1000;
  await h.p.esperarTelegram(15000);
  const sondados = h.tg.de('editarBotoes').map((c) => c.args[0]);
  const apagados = h.tg.de('apagar').map((c) => c.args[0]);
  assert.ok(sondados.includes(perdido), 'a sonda esta ligada e olhou o id perdido');
  assert.ok(!sondados.includes(idOk), 'a mensagem do OK nunca e sondada');
  assert.ok(!apagados.includes(idOk), 'a mensagem do OK nunca e apagada');

  // no canal: id do OK que ja estava no apagar (do disco) sai da lista sem chamar a API
  const chamadas = [];
  const tgAux = {
    async enviar() { chamadas.push('enviar'); return { ok: true, messageId: 60, formato: 'rich' }; },
    async editar() { chamadas.push('editar'); return { ok: true }; },
    async apagar(id) { chamadas.push(`apagar ${id}`); return { ok: true }; },
    async editarBotoes(id) { chamadas.push(`sondar ${id}`); return { ok: true }; },
  };
  const canal = criarCanalTelegram({ tg: tgAux, agora: () => h.t, rand: randFixo(), sondar: true });
  const e = { tg: tgNovo() };
  canal.sistema(e, 'linha', {});
  await canal.drenar(e);
  e.tg.sistema.apagar.push({ messageId: 55, sondar: true }, { messageId: 56, doBot: true }, { messageId: 57, sondar: true });
  canal.sistema(e, 'outra linha', {});
  chamadas.length = 0;
  await canal.drenar(e, { idsDeFora: [55, 56] });
  assert.ok(!chamadas.some((c) => /\b5[56]$/.test(c)), `ids de fora sem nenhuma chamada: ${chamadas.join(', ')}`);
  assert.ok(chamadas.includes('sondar 57'), 'o id que nao e de fora segue pra sonda');
  assert.ok(!e.tg.sistema.apagar.some((a) => a.messageId === 55 || a.messageId === 56), 'os ids de fora sairam da lista');
});

// ---------------------------------------------------------------------------------------------------------------
// 81. Sim e Nao validos

test('T7b2a 81. Sim valido -> responde o toque COM texto, anota o toque, liga o segurar e poe 1 recado (sessionId exata, tgok-u, sem a acao); o texto da mensagem nao e editado (T7i: so os botoes saem, teste 110); arquivo, grupo e chamado da aba intactos. Nao -> o mesmo com "Não"', async () => {
  for (const [acao, texto, resposta] of [['sim', 'Sim', TXT.anoteiSim], ['nao', 'Não', TXT.anoteiNao]]) {
    const h = montar();
    aba(h, 'S1', 'Faro');
    ligarTg(h);
    await chamadoNaTela(h, 'S1', 'Faro');
    const p = pedidoOk(h, { codigo: 'ABC234' });
    await h.p.esperarTelegram(15000);
    const idOk = okDe(h, 'ABC234').messageId;
    const bytesAntes = fs.readFileSync(arqOk(h, 'ABC234'), 'utf8');
    const chamadosAntes = JSON.stringify(estado(h).tg.chamados);
    h.tg.chamadas.length = 0;
    const u = toqueOk(h, p, acao, { messageId: idOk });
    const tToque = h.t;
    h.tg.lotes.push([u]);
    await h.p.esperarTelegram(15000);
    await bombear(h.cru);

    assert.deepEqual(h.tg.de('responderToque').map((c) => c.args), [[u.callback_query.id, resposta]], acao);
    assert.deepEqual(h.tg.de('editarTexto'), [], `${acao}: o texto nao e editado enquanto o pedido esta pendente`);
    const m = okDe(h, 'ABC234');
    assert.deepEqual(m.toque, { acao, em: iso(tToque), updateId: u.update_id }, acao);
    assert.equal(m.fechadoEm, null);
    const e = estado(h);
    assert.equal(e.okTg.segurar, u.update_id, `${acao}: segurar = o update do toque`);
    assert.equal(e.tg.offset, u.update_id, `${acao}: offset preso no toque (o getUpdates nao confirma)`);

    const recs = recadosOk(h);
    assert.equal(recs.length, 1, acao);
    const r = recs[0];
    assert.equal(r.sessionId, 'S1', 'sessionId EXATA do pedido');
    assert.equal(r.texto, texto);
    assert.equal(r.canal, 'telegram');
    assert.equal(r.providerMsgId, `tgok-u${u.update_id}`);
    assert.ok(!r.providerMsgId.startsWith('tg-u'), 'nunca tg-u (colide com o recado de uma fala)');
    assert.equal(r.messageId, null);
    assert.equal(r.nota, FRASES.notaPedidoOk('ABC234'));
    assert.equal(r.ok, 'ABC234');
    assert.equal(r.nome, 'projetos-42', 'o mensageiro acha a aba pelo nome');
    assert.equal(r.hora, horaBRT(iso(tToque)));
    assert.ok(!JSON.stringify(r).includes(ACAO) && !JSON.stringify(r).includes('produção'), 'o recado nunca leva a acao');
    assert.ok(!montarRecado(r).includes(ACAO), 'nem o texto que a aba le');
    assert.equal(h.entregas.length, 1, 'so o recado');

    assert.equal(fs.readFileSync(arqOk(h, 'ABC234'), 'utf8'), bytesAntes, 'o porteiro nunca grava o arquivo do pedido');
    assert.deepEqual(h.enviados, [], 'nada no grupo');
    assert.deepEqual(h.reacoes, [], 'nenhuma reacao no grupo');
    assert.deepEqual(h.edicoesGrupo, [], 'nenhuma edicao no grupo');
    assert.equal(JSON.stringify(estado(h).tg.chamados), chamadosAntes, 'o chamado da aba fica como estava');
    assert.deepEqual(h.tg.de('enviar').concat(h.tg.de('editar'), h.tg.de('apagar')), [], 'nada no canal');
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 82. Mais informacoes

test('T7b2a 82. Mais informações -> responde sem texto e edita a mesma mensagem pro completo com [[Sim, Não]], sem recado e sem anotar; Sim no completo -> recado', async () => {
  const h = montar();
  const { p, id } = await comPedidoNoChat(h, { tipo: 'crm', destinatarios: ['Ana', 'Bruno'] });
  const u = toqueOk(h, p, 'info', { messageId: id });
  h.tg.lotes.push([u]);
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.de('responderToque').map((c) => c.args), [[u.callback_query.id, undefined]], 'sem texto');
  const ed = h.tg.de('editarTexto');
  assert.equal(ed.length, 1);
  const completo = montarOkTg({ ...p, completo: true });
  assert.equal(ed[0].args[0], id, 'a mesma mensagem');
  assert.deepEqual(ed[0].args[1], { texto: completo.texto, botoes: [[SIM('ABC234'), NAO('ABC234')]] });
  assert.ok(completo.texto.includes('Pra: Ana, Bruno.') && completo.texto.endsWith('Posso?'));
  assert.equal(okDe(h, 'ABC234').completo, true);
  assert.equal(okDe(h, 'ABC234').toque, null, 'info nao anota toque');
  assert.equal(estado(h).okTg.segurar, null, 'info nao segura');
  await bombear(h.cru);
  assert.deepEqual(recadosOk(h), [], 'info nao vira recado');
  assert.deepEqual(h.enviados, []);

  h.tg.chamadas.length = 0;
  const s = toqueOk(h, p, 'sim', { messageId: id, completo: true });
  h.tg.lotes.push([s]);
  await h.p.esperarTelegram(15000);
  await bombear(h.cru);
  assert.deepEqual(respostas(h), [TXT.anoteiSim]);
  assert.equal(recadosOk(h).length, 1, 'Sim no completo vale');
  assert.equal(recadosOk(h)[0].providerMsgId, `tgok-u${s.update_id}`);
  assert.deepEqual(h.tg.de('editarTexto'), []);
});

// ---------------------------------------------------------------------------------------------------------------
// 83. avisos no topo

test('T7b2a 83. 2o toque igual, Nao depois do Sim, Sim depois do Nao, usado, recusado, expirado, dados ilegiveis, codigo sem arquivo, texto ou teclado que nao confere e travado -> o aviso certo e nenhum recado a mais; toque valido em mensagem desconhecida vale e entra em outras', async () => {
  const h = montar();
  const { p, id } = await comPedidoNoChat(h);
  const toque = async (u) => {
    h.tg.chamadas.length = 0;
    h.tg.lotes.push([u]);
    await h.p.esperarTelegram(15000);
    await bombear(h.cru);
    return respostas(h);
  };
  const s1 = toqueOk(h, p, 'sim', { messageId: id });
  const t1 = h.t;
  assert.deepEqual(await toque(s1), [TXT.anoteiSim]);
  assert.equal(recadosOk(h).length, 1);
  assert.deepEqual(await toque(toqueOk(h, p, 'sim', { messageId: id })), [TXT.jaAnotei('Sim', horaBRT(iso(t1)))], '2o Sim');
  assert.equal(recadosOk(h).length, 1, '2o Sim sem recado');
  const n1 = toqueOk(h, p, 'nao', { messageId: id });
  const tn = h.t;
  assert.deepEqual(await toque(n1), [TXT.anoteiNao], 'Nao depois do Sim vale');
  assert.deepEqual(recadosOk(h).map((r) => r.texto), ['Sim', 'Não']);
  assert.deepEqual(okDe(h, 'ABC234').toque, { acao: 'nao', em: iso(tn), updateId: n1.update_id });
  assert.deepEqual(await toque(toqueOk(h, p, 'nao', { messageId: id })), [TXT.jaAnotei('Não', horaBRT(iso(tn)))], '2o Nao');
  assert.deepEqual(await toque(toqueOk(h, p, 'sim', { messageId: id })), [TXT.jaRespondido], 'Sim depois do Nao');
  assert.equal(recadosOk(h).length, 2, 'nenhum recado a mais');
  assert.deepEqual(h.tg.de('editarTexto'), []);

  // dados ilegiveis, codigo sem arquivo, texto e teclado que nao conferem
  const p2 = pedidoOk(h, { codigo: 'BCD234' });
  await h.p.esperarTelegram(15000);
  const id2 = okDe(h, 'BCD234').messageId;
  assert.deepEqual(await toque(toqueOk(h, p2, 'sim', { messageId: id2, dados: 'k:BCD234:x' })), [TXT.mudou], 'dados ilegiveis');
  const fantasma = { ...p2, codigo: 'GGG234' };
  assert.deepEqual(await toque(toqueOk(h, fantasma, 'sim', { messageId: id2 })), [TXT.mudou], 'codigo sem arquivo');
  const outroTexto = montarOkTg({ ...p2, acao: 'apagar o site X' }).texto;
  assert.deepEqual(await toque(toqueOk(h, p2, 'sim', { messageId: id2, texto: outroTexto })), [TXT.mudou], 'texto que nao confere');
  const semNao = apiTeclado([[SIM('BCD234')], [MAIS('BCD234')]]);
  assert.deepEqual(await toque(toqueOk(h, p2, 'sim', { messageId: id2, teclado: semNao })), [TXT.mudou], 'teclado que nao confere');
  const deOutro = toqueOk(h, p2, 'sim', { messageId: id2 });
  deOutro.callback_query.message.from = { id: 777, is_bot: true };
  assert.deepEqual(await toque(deOutro), [TXT.mudou], 'mensagem de outro bot');
  assert.equal(recadosOk(h).length, 2, 'nenhum recado a mais');
  assert.equal(okDe(h, 'BCD234').toque, null);

  // travado
  mexer(h, (e) => { e.trava = true; });
  assert.deepEqual(await toque(toqueOk(h, p2, 'sim', { messageId: id2 })), [TXT.travado], 'travado');
  assert.equal(okDe(h, 'BCD234').toque, null);
  destravar({ env: h.env, agora: () => h.t });

  // usado, recusado e expirado
  mudarPedido(h, 'BCD234', { status: 'usado', usadoEm: iso(h.t), verificadoPor: { providerMsgId: 'X', texto: 'sim', hora: '10:05' } });
  assert.deepEqual(await toque(toqueOk(h, p2, 'sim', { messageId: id2 })), [TXT.jaRespondido], 'usado');
  const p3 = pedidoOk(h, { codigo: 'CDE234' });
  await h.p.esperarTelegram(15000);
  const id3 = okDe(h, 'CDE234').messageId;
  mudarPedido(h, 'CDE234', { status: 'recusado', decididoEm: iso(h.t), verificadoPor: { providerMsgId: 'Y', texto: 'não', hora: '10:06' } });
  assert.deepEqual(await toque(toqueOk(h, p3, 'nao', { messageId: id3 })), [TXT.jaRespondido], 'recusado');
  const p4 = pedidoOk(h, { codigo: 'DEF234' });
  await h.p.esperarTelegram(15000);
  const id4 = okDe(h, 'DEF234').messageId;
  h.t = Date.parse(p4.expiraEm) + 1000;
  assert.deepEqual(await toque(toqueOk(h, p4, 'sim', { messageId: id4 })), [TXT.expirou], 'expirado');
  assert.equal(recadosOk(h).length, 2, 'nenhum recado a mais');

  // toque valido numa mensagem que o porteiro nao conhecia (envio incerto): vale e entra em outras
  const p5 = pedidoOk(h, { codigo: 'EFG234' });
  await h.p.esperarTelegram(15000);
  const id5 = okDe(h, 'EFG234').messageId;
  const desconhecida = id5 + 50;
  assert.deepEqual(await toque(toqueOk(h, p5, 'sim', { messageId: desconhecida })), [TXT.anoteiSim]);
  assert.deepEqual(okDe(h, 'EFG234').outras, [desconhecida]);
  assert.equal(okDe(h, 'EFG234').messageId, id5);
  assert.equal(recadosOk(h).length, 3);
  // e fecha as duas juntas (T7j: o Sim conferido pelo Telegram apaga as duas do chat)
  mudarPedido(h, 'EFG234', { status: 'usado', usadoEm: iso(h.t), verificadoPor: { canal: 'telegram', updateId: 1, messageId: desconhecida, texto: 'Sim', conferidoEm: iso(h.t) } });
  h.tg.chamadas.length = 0;
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.de('apagar').map((c) => c.args[0]).sort(), [id5, desconhecida].sort(), 'as duas fecham');
  assert.deepEqual(h.enviados, [], 'nada no grupo');
});

// ---------------------------------------------------------------------------------------------------------------
// 84. janela repetida, religar, 1a vida e 409

test('T7b2a 84. update repetido durante o segurar e tratado 1 vez (toque, fala do dono e toque de chamado); religado com os vistos no disco nao repete; 1a vida nada tratado; toque durante a queda tratado ao religar; 409 nada muda', async () => {
  const h = montar();
  const { p, id } = await comPedidoNoChat(h);
  aba(h, 'S2', 'Outra', 'repos-77');
  const s = toqueOk(h, p, 'sim', { messageId: id });
  const fala = msgTg(h, 'Outra: segue o trabalho');
  const velho = toqueTg(h, 'o:ABCDEFGH:0', 4242);
  for (let i = 0; i < 5; i++) h.tg.lotes.push([s, fala, velho]); // o offset fica preso: o Telegram devolve a mesma janela
  await h.p.esperarTelegram(15000);
  await bombear(h.cru);
  assert.equal(h.tg.de('lerAtualizacoes').filter((c) => c.args.offset === s.update_id).length >= 5, true, 'leu a mesma janela');
  assert.equal(recadosOk(h).length, 1, 'o toque vira 1 recado so');
  assert.deepEqual(h.entregas.filter((x) => x.texto === 'segue o trabalho').length, 1, 'a fala do dono repetida nao e repassada de novo');
  assert.equal(respostas(h).filter((x) => x === TXT.anoteiSim).length, 1);
  assert.equal(respostas(h).filter((x) => x === TXT.mudou).length, 1, 'o toque de chamado repetido e respondido 1 vez');

  // religado com os vistos no disco: a janela que volta nao repete
  religar(h);
  h.tg.chamadas.length = 0;
  h.tg.lotes.push([s, fala, velho]);
  await h.p.esperarTelegram(15000);
  await bombear(h.cru);
  assert.equal(recadosOk(h).length, 1);
  assert.equal(h.entregas.filter((x) => x.texto === 'segue o trabalho').length, 1);
  assert.deepEqual(respostas(h), []);

  // 409 = nada muda
  const antes = estado(h);
  h.tg.lotes.push(Object.assign(new Error('getUpdates: Conflict'), { conflito: true }));
  await h.p.esperarTelegram(5000);
  const depois = estado(h);
  assert.equal(depois.tg.offset, antes.tg.offset);
  assert.equal(depois.okTg.segurar, antes.okTg.segurar);
  assert.deepEqual(depois.okTg.mensagens, antes.okTg.mensagens);

  // 1a vida (offset null): o toque do historico nao e tratado
  const h2 = montar();
  aba(h2, 'S1', 'Faro');
  const p2 = pedidoOk(h2, { codigo: 'ABC234' });
  mexer(h2, (e) => { e.okTg.mensagens.ABC234 = { messageId: 9001, outras: [], sessionId: 'S1', completo: false, enviadoEm: iso(h2.t), toque: null, fechadoEm: null, fim: null }; });
  const hist = toqueOk(h2, p2, 'sim', { messageId: 9001 });
  h2.tg.lotes.push([hist]);
  await h2.p.esperarTelegram(15000);
  await bombear(h2.cru);
  assert.deepEqual(recadosOk(h2), [], '1a vida: historico pulado');
  assert.equal(okDe(h2, 'ABC234').toque, null);

  // toque durante a queda: tratado ao religar
  const h3 = montar();
  const r3 = await comPedidoNoChat(h3);
  const offsetAntes = estado(h3).tg.offset;
  const queda = toqueOk(h3, r3.p, 'sim', { messageId: r3.id });
  religar(h3);
  h3.tg.lotes.push([queda]);
  await h3.p.esperarTelegram(15000);
  await bombear(h3.cru);
  assert.equal(h3.tg.de('lerAtualizacoes')[0].args.offset, offsetAntes, 'religou do offset gravado');
  assert.equal(recadosOk(h3).length, 1, 'o toque da queda vale');
});

// ---------------------------------------------------------------------------------------------------------------
// 85. fecho

test('T7b2a 85. fecho (1 vez cada, sem botoes, relendo o arquivo): usado pelo Telegram, usado ou recusado pelo WhatsApp, vencido sem toque, vencido com Sim sem uso, recusado pelo Telegram, arquivo apagado, problema na entrega', async () => {
  // T7j: `some` = o toque dele concluiu (Sim conferido ou Nao recusado pelo Telegram): a mensagem e apagada, sem fecho editado
  const casos = [
    {
      nome: 'usado pelo Telegram', toque: 'sim', some: true,
      mudar: (h, u) => ({ status: 'usado', usadoEm: iso(h.t + MIN), verificadoPor: { canal: 'telegram', updateId: u.update_id, messageId: 1, texto: 'Sim', conferidoEm: iso(h.t + MIN) } }),
      linha: (h, t) => TXT.conferiu(horaBRT(iso(t)), horaBRT(iso(h.t + MIN))),
    },
    {
      nome: 'usado pelo WhatsApp', toque: null,
      mudar: (h) => ({ status: 'usado', usadoEm: iso(h.t + 2 * MIN), verificadoPor: { providerMsgId: 'W', texto: 'sim', hora: '10:03' } }),
      linha: (h) => TXT.peloWhatsapp(horaBRT(iso(h.t + 2 * MIN))),
    },
    {
      nome: 'recusado pelo WhatsApp', toque: null,
      mudar: (h) => ({ status: 'recusado', decididoEm: iso(h.t + 3 * MIN), verificadoPor: { providerMsgId: 'W', texto: 'não', hora: '10:04' } }),
      linha: (h) => TXT.peloWhatsapp(horaBRT(iso(h.t + 3 * MIN))),
    },
    {
      nome: 'recusado pelo Telegram', toque: 'nao', some: true,
      mudar: (h, u) => ({ status: 'recusado', decididoEm: iso(h.t + MIN), verificadoPor: { canal: 'telegram', updateId: u.update_id, messageId: 1, texto: 'Não', conferidoEm: iso(h.t + MIN) } }),
      linha: (h, t) => TXT.cancelado(horaBRT(iso(t))),
    },
    { nome: 'vencido sem toque', toque: null, vencer: true, linha: (h, t, p) => TXT.expirouSem(horaBRT(p.expiraEm)) },
    { nome: 'vencido com Sim sem uso', toque: 'sim', vencer: true, linha: (h, t, p) => TXT.naoConferiu(horaBRT(iso(t)), horaBRT(p.expiraEm)) },
    { nome: 'arquivo apagado', toque: null, apagar: true, linha: () => TXT.naoVale },
  ];
  for (const c of casos) {
    const h = montar();
    const { p, id } = await comPedidoNoChat(h);
    let u = null;
    const t = h.t;
    if (c.toque) {
      u = toqueOk(h, p, c.toque, { messageId: id });
      h.tg.lotes.push([u]);
      await h.p.esperarTelegram(15000);
      await bombear(h.cru);
    }
    assert.deepEqual(h.tg.de('editarTexto'), [], `${c.nome}: aberto enquanto pendente`);
    if (c.mudar) mudarPedido(h, 'ABC234', c.mudar(h, u));
    if (c.apagar) fs.unlinkSync(arqOk(h, 'ABC234'));
    if (c.vencer) h.t = Date.parse(p.expiraEm) + 1000;
    const linha = c.linha(h, t, p);
    h.tg.chamadas.length = 0;
    await h.p.esperarTelegram(15000);
    const ed = h.tg.de('editarTexto');
    if (c.some) { // T7j
      assert.deepEqual(ed, [], `${c.nome}: sem fecho editado`);
      assert.deepEqual(h.tg.de('apagar').map((x) => x.args[0]), [id], `${c.nome}: apagada`);
    } else {
      assert.equal(ed.length, 1, `${c.nome}: 1 edicao`);
      assert.equal(ed[0].args[0], id, c.nome);
      assert.equal(ed[0].args[1].texto, montarOkTgFechado({ ...p, linha }).texto, c.nome);
      // T28: o vencido que fica ganha o botao Tentar novamente; os outros fechos seguem sem botoes
      assert.deepEqual(ed[0].args[1].botoes ?? null, /sem resposta\.$|: expirou\.$/.test(linha) ? [[{ texto: '🔄 Tentar novamente', dados: 'r:ABC234' }]] : null, `${c.nome}: botoes`);
    }
    const m = okDe(h, 'ABC234');
    assert.ok(Number.isFinite(Date.parse(m.fechadoEm)), `${c.nome}: fechadoEm`);
    assert.ok(m.fim, `${c.nome}: fim`);
    assert.equal(estado(h).okTg.segurar, null, `${c.nome}: soltou`);
    h.tg.chamadas.length = 0;
    await h.p.esperarTelegram(15000);
    assert.deepEqual(h.tg.de('editarTexto'), [], `${c.nome}: so 1 vez`);
    assert.deepEqual(h.tg.de('apagar'), [], `${c.nome}: so 1 vez`);
    assert.deepEqual(h.enviados, [], `${c.nome}: nada no grupo`);
    if (!c.apagar && !c.mudar) assert.equal(JSON.parse(fs.readFileSync(arqOk(h, 'ABC234'), 'utf8')).status, 'pendente', `${c.nome}: o porteiro nao grava o arquivo`);
  }

  // problema na entrega do recado: a mensagem do OK fecha com a frase (sem cabecalho), nada no grupo nem no chamado
  const h = montar({ respostasEntrega: [{ status: 'nao_achei', detalhe: '' }] });
  const { p, id } = await comPedidoNoChat(h);
  const u = toqueOk(h, p, 'sim', { messageId: id });
  const t = h.t;
  h.tg.lotes.push([u]);
  await h.p.esperarTelegram(15000);
  await bombear(h.cru);
  const ed = h.tg.de('editarTexto');
  assert.equal(ed.length, 1, 'problema = 1 edicao');
  const frase = 'Não achei a sessão Faro aberta no PC. "status" lista as que estão abertas.';
  assert.equal(ed[0].args[0], id);
  assert.equal(ed[0].args[1].texto, montarOkTgFechado({ ...p, linha: TXT.naoEntregue(horaBRT(iso(t)), frase) }).texto);
  assert.equal(ed[0].args[1].botoes ?? null, null);
  assert.deepEqual(h.enviados, [], 'nada no grupo');
  assert.deepEqual(h.tg.de('enviar'), [], 'nada no chamado da aba');
  assert.equal(okDe(h, 'ABC234').fim !== null, true);
  // depois, vencido: nao edita de novo
  h.t = Date.parse(p.expiraEm) + 1000;
  h.tg.chamadas.length = 0;
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.de('editarTexto'), [], 'ja fechada pelo problema');
});

// ---------------------------------------------------------------------------------------------------------------
// 88. segurar

test('T7b2a 88. segurar: offset preso no menor toque valido (tambem no disco no meio do lote), leitura curta (esperaS 0) a cada 2 s; soltou = offset volta pro maior lido + 1 e a leitura longa volta; lote de 100 solta (1 log) e nao prende de novo; religar com o segurar no disco continua', async () => {
  const h = montar();
  const { p, id } = await comPedidoNoChat(h);
  const p2 = pedidoOk(h, { codigo: 'BCD234' });
  await h.p.esperarTelegram(15000);
  const id2 = okDe(h, 'BCD234').messageId;
  const s1 = toqueOk(h, p, 'sim', { messageId: id });
  const velho = toqueTg(h, 'o:ABCDEFGH:0', 4242);
  const s2 = toqueOk(h, p2, 'nao', { messageId: id2 });
  let offsetNoMeio = null;
  h.tg.aoToque = (qid) => { if (qid === velho.callback_query.id) offsetNoMeio = estado(h).tg.offset; };
  h.tg.chamadas.length = 0;
  h.dormidas.length = 0;
  h.tg.lotes.push([s1, velho, s2]);
  await h.p.esperarTelegram(15000);
  h.tg.aoToque = null;
  assert.equal(offsetNoMeio, s1.update_id, 'no meio do lote o disco ja tem o offset preso no toque');
  let e = estado(h);
  assert.equal(e.okTg.segurar, s1.update_id, 'o menor toque valido');
  assert.equal(e.tg.offset, s1.update_id);
  const leituras = h.tg.de('lerAtualizacoes').map((c) => c.args);
  assert.ok(leituras.length >= 3);
  assert.ok(leituras.slice(1).every((a) => a.offset === s1.update_id && a.esperaS === 0), JSON.stringify(leituras));
  // 2 s entre leituras (a ultima espera para no prazo da volta)
  assert.ok(h.dormidas.length >= 3 && h.dormidas.slice(0, -1).every((ms) => ms === 2000) && h.dormidas.at(-1) <= 2000, `${h.dormidas}`);

  // o 1o pedido foi conferido pela aba: o segurar vai pro outro toque
  mudarPedido(h, 'ABC234', { status: 'usado', usadoEm: iso(h.t), verificadoPor: { canal: 'telegram', updateId: s1.update_id, messageId: id, texto: 'Sim', conferidoEm: iso(h.t) } });
  h.tg.lotes.push([s1, velho, s2]);
  await h.p.esperarTelegram(15000);
  e = estado(h);
  assert.equal(e.okTg.segurar, s2.update_id);
  assert.equal(e.tg.offset, s2.update_id);

  // soltou tudo: o offset volta pro maior lido + 1 e a leitura longa volta
  mudarPedido(h, 'BCD234', { status: 'recusado', decididoEm: iso(h.t), verificadoPor: { canal: 'telegram', updateId: s2.update_id, messageId: id2, texto: 'Não', conferidoEm: iso(h.t) } });
  h.tg.chamadas.length = 0;
  h.tg.lotes.push([s2]);
  await h.p.esperarTelegram(15000);
  e = estado(h);
  assert.equal(e.okTg.segurar, null);
  assert.equal(e.tg.offset, s2.update_id + 1, 'maior lido + 1');
  const depois = h.tg.de('lerAtualizacoes').map((c) => c.args);
  assert.ok(depois.at(-1).esperaS > 0, 'leitura longa de novo');

  // lote de 100 com o segurar ligado: solta (1 log), o offset anda e nao prende de novo
  const p3 = pedidoOk(h, { codigo: 'CDE234' });
  await h.p.esperarTelegram(15000);
  const id3 = okDe(h, 'CDE234').messageId;
  const s3 = toqueOk(h, p3, 'sim', { messageId: id3 });
  h.tg.lotes.push([s3]);
  await h.p.esperarTelegram(5000);
  assert.equal(estado(h).okTg.segurar, s3.update_id);
  const cheio = [s3];
  for (let i = 0; i < 99; i++) cheio.push(deFora(h));
  h.tg.chamadas.length = 0;
  h.tg.lotes.push(cheio);
  await h.p.esperarTelegram(15000);
  e = estado(h);
  assert.equal(e.okTg.segurar, null, 'soltou');
  assert.equal(e.tg.offset, cheio.at(-1).update_id + 1);
  assert.equal(logs(h).filter((l) => /soltei/.test(l)).length, 1, '1 log');
  const apos = h.tg.de('lerAtualizacoes').map((c) => c.args);
  assert.ok(apos.at(-1).esperaS > 0 && apos.at(-1).offset === cheio.at(-1).update_id + 1, 'leitura longa, sem prender de novo');
  await h.p.esperarTelegram(15000);
  assert.equal(estado(h).okTg.segurar, null, 'o toque solto nao prende de novo');

  // religar com o segurar no disco: continua preso, leitura curta, e o toque nao repete
  const h2 = montar();
  const r2 = await comPedidoNoChat(h2);
  const t2 = toqueOk(h2, r2.p, 'sim', { messageId: r2.id });
  h2.tg.lotes.push([t2]);
  await h2.p.esperarTelegram(5000);
  await bombear(h2.cru);
  religar(h2);
  h2.tg.chamadas.length = 0;
  h2.tg.lotes.push([t2]);
  await h2.p.esperarTelegram(5000);
  await bombear(h2.cru);
  const l2 = h2.tg.de('lerAtualizacoes').map((c) => c.args);
  assert.deepEqual(l2[0], { offset: t2.update_id, esperaS: 0 }, 'religado segue preso no toque');
  assert.equal(estado(h2).tg.offset, t2.update_id);
  assert.equal(recadosOk(h2).length, 1, 'o toque nao repete depois de religar');

  // OK desligado: o segurar no disco nao prende nada (como hoje)
  const h3 = montar({ ok: false });
  ligarTg(h3);
  mexer(h3, (x) => { x.okTg = { iniciadoEm: iso(h3.t), segurar: 120, mensagens: {} }; });
  const fala = msgTg(h3, 'qualquer coisa');
  h3.tg.lotes.push([fala]);
  await h3.p.esperarTelegram(15000);
  assert.equal(estado(h3).tg.offset, fala.update_id + 1);
  assert.ok(h3.tg.de('lerAtualizacoes').every((c) => c.args.esperaS !== 0 || c.args.offset === -1), 'leitura longa');
});

// ---------------------------------------------------------------------------------------------------------------
// 90. depois do recado

test('T7b2a 90. depois do recado do toque: entregue nao mexe no chamado da aba; a resposta da aba sai no chamado dela (sem citar), nada no grupo (nem o "Concluído" no aviso dela) e nada na mensagem do OK', async () => {
  const h = montar();
  aba(h, 'S1', 'Faro');
  ligarTg(h);
  // o aviso da aba no grupo (modo rua, canal principal WhatsApp): uma fala do WhatsApp entregue viraria "Concluído" (F4.1)
  await ligarRua(h);
  evento(h, parou(h, 'S1', { final: 'Vou publicar.\n\n---\n🔴 **DECISÃO:** Publico? A) Sim (recomendado) / B) Não', marcas: { decisao: true, fica: false, pergunta: false } }));
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 1, 'o aviso da aba saiu no grupo');
  assert.ok(Object.values(estado(h).avisos).some((a) => a.sessionId === 'S1'));
  h.enviados.length = 0;
  h.t += 1000;
  await chamadoNaTela(h, 'S1', 'Faro');
  const p = pedidoOk(h, { codigo: 'ABC234' });
  await h.p.esperarTelegram(15000);
  const id = okDe(h, 'ABC234').messageId;
  const chamadoAntes = JSON.stringify(estado(h).tg.chamados.S1);
  const u = toqueOk(h, p, 'sim', { messageId: id });
  h.tg.lotes.push([u]);
  await h.p.esperarTelegram(15000);
  await bombear(h.cru);
  assert.equal(recadosOk(h).length, 1);
  assert.equal(JSON.stringify(estado(h).tg.chamados.S1), chamadoAntes, 'entregue com ok nao mexe no chamado');
  assert.ok(estado(h).entregas[`tgok-u${u.update_id}`], 'a entrega e registrada (a resposta da aba volta)');
  assert.deepEqual(h.edicoesGrupo, [], 'o aviso da aba no grupo nao vira "Concluído" (nada no grupo)');
  assert.deepEqual(estado(h).saida, [], 'nada na fila do grupo');

  // a aba recebe o recado e responde
  const rec = recadosOk(h)[0];
  h.t += 2000;
  transcript(h, 'S1', [peer(rec, iso(h.t)), falaDaAba(`> Telegram do Davi (${rec.hora}): «Sim»\nPublicado.`)]);
  h.t += 1000;
  h.tg.chamadas.length = 0;
  evento(h, parou(h, 'S1', { final: `> Telegram do Davi (${rec.hora}): «Sim»\nPublicado no ar.` }));
  await h.p.passoEventos();
  await h.p.esperarTelegram(15000);
  const envs = h.tg.de('enviar');
  assert.equal(envs.length, 1, 'a resposta sai no chamado da aba');
  assert.equal(envs[0].args[0].silencioso, false, 'resposta notifica');
  assert.equal(envs[0].args[0].responderA ?? null, null, 'sem citar (o toque nao tem mensagem do dono)');
  assert.deepEqual(h.tg.de('editarTexto'), [], 'nada na mensagem do OK');
  assert.deepEqual(h.tg.de('enviarTexto'), []);
  assert.deepEqual(h.enviados, [], 'nada no grupo');
  assert.deepEqual(h.edicoesGrupo, [], 'nenhuma edicao no grupo');
  assert.deepEqual(h.reacoes, []);
});

// ---------------------------------------------------------------------------------------------------------------
// 92. F7

// O mesmo roteiro com o OK ligado e desligado: o que sai no grupo (pedido de OK respondido, aviso, status, resposta)
// tem que ser igual byte a byte.
async function roteiroGrupo(ok) {
  const h = montar({ ok });
  aba(h, 'S1', 'Faro');
  aba(h, 'S2', 'Live', 'repos-77');
  ligarTg(h);
  await ligarRua(h);
  const p = pedidoOk(h, { codigo: 'ABC234' });
  h.grupo.push({ id: p.messageId, provider_msg_id: p.providerMsgId, from_me: true, sent_by_agent: true, message_type: 'text', content: 'pedido', message_ts: iso(h.t), direction: 'sent' });
  h.t += 1000;
  await h.p.esperarTelegram(5000);
  // finais de varios jeitos (DECISAO, "Fica com você", pergunta, longa com detalhe, sem precisar do dono)
  const finais = [
    ['Terminei a revisão.\n\n---\n🔴 **DECISÃO:** Publico? A) Sim (recomendado) / B) Não', { decisao: true, fica: false, pergunta: false }],
    ['Subi a versão nova.\n\nFica com você: conferir o site no celular.', { decisao: false, fica: true, pergunta: false }],
    ['Achei 3 leads parados. Quer que eu mande o follow-up agora?', { decisao: false, fica: false, pergunta: true }],
    [`${'Linha longa de relatório com <tags> & *asteriscos* e acentuação. '.repeat(30)}\n\nPosso seguir?`, { decisao: false, fica: false, pergunta: true }],
    ['Feito, sem pendência.', { decisao: false, fica: false, pergunta: false }],
  ];
  for (const [final, marcas] of finais) {
    h.t += 1000;
    evento(h, parou(h, 'S2', { final, marcas }));
    await h.p.passoEventos();
  }
  msg(h, { content: 'sim', quoted_msg_id: p.providerMsgId });
  await h.p.passoGrupo();
  msg(h, { content: 'status' });
  await h.p.passoGrupo();
  msg(h, { content: 'Live: manda o resumo' });
  await h.p.passoGrupo();
  const rec = h.entregas.find((x) => x.texto === 'manda o resumo');
  transcript(h, 'S2', [peer(rec, iso(h.t)), falaDaAba(`> WhatsApp do Davi (${rec.hora}): «manda o resumo»\nResumo pronto.`)]);
  h.t += 1000;
  evento(h, parou(h, 'S2', { final: `> WhatsApp do Davi (${rec.hora}): «manda o resumo»\nResumo pronto.` }));
  await h.p.passoEventos();
  await h.p.esperarTelegram(5000);
  return h;
}

test('T7b2a 92. F7: com o OK ligado, o grupo sai byte a byte igual (resposta ao pedido no grupo, aviso, status, resposta, reacoes, recados); ensaio nunca manda OK pelo Telegram', async () => {
  const com = await roteiroGrupo(true);
  const sem = await roteiroGrupo(false);
  assert.equal(enviosOk(com, 'ABC234').length, 1, 'com o OK ligado a mensagem do pedido saiu no Telegram');
  assert.equal(enviosOk(sem, 'ABC234').length, 0, 'desligado: nada');
  assert.ok(com.enviados.length >= 3, 'o roteiro mandou no grupo');
  assert.deepEqual(com.enviados.map((x) => x.texto), sem.enviados.map((x) => x.texto), 'grupo byte a byte');
  assert.deepEqual(com.reacoes, sem.reacoes);
  assert.deepEqual(com.edicoesGrupo, sem.edicoesGrupo);
  assert.deepEqual(com.entregas.map(montarRecado), sem.entregas.map(montarRecado), 'recados byte a byte');
  assert.ok(com.entregas.some((x) => x.nota === FRASES.notaPedidoOk('ABC234')), 'o sim citando o pedido no grupo segue indo pra aba');

  // ensaio: com o config ligado, nenhuma chamada ao tg e nada do OK no registro do ensaio
  const h = montar({ ensaio: true });
  aba(h, 'S1', 'Faro');
  ligarTg(h, 'estado-ensaio.json');
  pedidoOk(h, { codigo: 'ABC234' });
  await h.p.esperarTelegram(15000);
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.chamadas, [], 'ensaio: nenhuma chamada ao tg');
  const arqEnsaio = path.join(h.env.SESSOES_WPP_DIR, 'ensaio.jsonl');
  const ensaio = fs.existsSync(arqEnsaio) ? fs.readFileSync(arqEnsaio, 'utf8') : '';
  assert.ok(!ensaio.includes('ABC234') && !ensaio.includes('k:'), 'nada do OK no ensaio');
  assert.deepEqual(estado(h, 'estado-ensaio.json').okTg.mensagens, {});
});

// ===============================================================================================================
// Revisao adversarial da etapa D (03/10/2026): 1 teste por item. Itens 1-4, 14 e 15 = defeito (vermelhos no codigo de
// antes da correcao); itens 5-12 = teste que nao prendia (cada um pega a sabotagem que passava); item 13 = o duble.

test('T7b2a 85b (revisao, item 1). recado do toque num pedido de OK da CENTRAL com o mensageiro devolvendo nao_achei: a mensagem do OK fecha com "não consegui entregar" e o recado nunca estaciona (centralSemRecado intacto, nada pra outra central, nenhum falaRecebida)', async () => {
  const h = montar({ respostasEntrega: [{ status: 'nao_achei', detalhe: '' }] });
  aba(h, 'C1', 'Central de sessões de teste', CENTRAL_TESTE.nome);
  ligarTg(h);
  const p = pedidoOk(h, { codigo: 'ABC234', sessionId: 'C1', titulo: 'Controle de sessões' });
  await h.p.esperarTelegram(15000);
  const id = okDe(h, 'ABC234').messageId;
  h.tg.chamadas.length = 0;
  const u = toqueOk(h, p, 'sim', { messageId: id });
  const tToque = h.t;
  h.tg.lotes.push([u]);
  await h.p.esperarTelegram(5000);
  await bombear(h.cru);
  assert.deepEqual(h.entregas.map((x) => [x.sessionId, x.providerMsgId]), [['C1', `tgok-u${u.update_id}`]], 'o recado foi pra central do pedido');
  let e = estado(h);
  assert.deepEqual(e.centralPendentes, [], 'o recado do toque nunca estaciona');
  assert.equal(e.centralSemRecado, null, 'nem marca a central sem recado');
  const ed = h.tg.de('editarTexto');
  assert.equal(ed.length, 1, 'a mensagem do OK fecha');
  assert.equal(ed[0].args[0], id);
  const frase = 'Não achei a sessão Central de sessões de teste aberta no PC. "status" lista as que estão abertas.';
  assert.equal(ed[0].args[1].texto, montarOkTgFechado({ ...p, linha: TXT.naoEntregue(horaBRT(iso(tToque)), frase) }).texto);
  assert.equal(okDe(h, 'ABC234').fim, 'problema');

  // uma central nova sobe: nada pra passar pra ela (nenhuma entrega, nenhum chamado no Telegram)
  aba(h, 'C2', 'Central de sessões de teste', CENTRAL_TESTE.nome);
  h.t += 30 * 1000;
  h.tg.chamadas.length = 0;
  assert.deepEqual(await h.cru.passoCentral(), { pendentes: 0, soltas: 0, expiradas: 0 });
  await bombear(h.cru);
  await h.p.esperarTelegram(5000);
  assert.equal(h.entregas.length, 1, 'nenhuma entrega pra outra sessao');
  e = estado(h);
  assert.deepEqual(Object.keys(e.tg.chamados), [], 'nenhum falaRecebida');
  assert.deepEqual(h.tg.de('enviar'), [], 'nada no chat');
  assert.deepEqual(h.enviados, [], 'nada no grupo');

  // estacionarNaoAchei (a fala da propria central sem recado): o recado de OK na fila da mesma aba nao vai junto
  const h2 = montar({ respostasEntrega: [{ status: 'nao_achei', detalhe: '' }] });
  aba(h2, 'C1', 'Central de sessões de teste', CENTRAL_TESTE.nome);
  ligarTg(h2);
  const p2 = pedidoOk(h2, { codigo: 'ABC234', sessionId: 'C1', titulo: 'Controle de sessões' });
  await h2.p.esperarTelegram(15000);
  const fala = msgTg(h2, 'como ficou o deploy?');
  const toque = toqueOk(h2, p2, 'sim', { messageId: okDe(h2, 'ABC234').messageId });
  h2.tg.lotes.push([fala, toque]); // a fala vai pra central C1 (nao_achei) e o recado do toque fica na fila da C1
  await h2.p.esperarTelegram(5000);
  await bombear(h2.cru);
  const e2 = estado(h2);
  assert.ok(e2.centralPendentes.some((x) => x.pedido.texto === 'como ficou o deploy?'), 'a fala da central estacionou');
  assert.ok(!e2.centralPendentes.some((x) => x.pedido.ok), 'o recado de OK nunca estaciona');
  assert.deepEqual(h2.entregas.map((x) => x.sessionId), ['C1', 'C1'], 'o recado do toque foi pra central do pedido');
});

test('T7b2a 83b (revisao, item 2). Sim e "trava" no mesmo lote: a trava esvazia o recado E o toque anotado (segurar null, offset anda); destravado, o Sim vale de novo (Anotei + 1 recado + segurar)', async () => {
  const h = montar();
  const { p, id } = await comPedidoNoChat(h);
  const s1 = toqueOk(h, p, 'sim', { messageId: id });
  const trava = msgTg(h, 'trava');
  h.tg.lotes.push([s1, trava]);
  await h.p.esperarTelegram(5000);
  await bombear(h.cru);
  assert.deepEqual(respostas(h), [TXT.anoteiSim]);
  assert.equal(recadosOk(h).length, 0, 'a trava esvaziou a fila: o recado nao saiu');
  let e = estado(h);
  assert.equal(e.trava, true);
  assert.equal(e.okTg.mensagens.ABC234.toque, null, 'a trava zera o toque anotado da mensagem aberta');
  assert.equal(e.okTg.segurar, null, 'e o segurar');
  assert.equal(e.tg.offset, trava.update_id + 1, 'o offset anda (nada segurado)');

  destravar({ env: h.env, agora: () => h.t });
  h.t += MIN;
  h.tg.chamadas.length = 0;
  const s2 = toqueOk(h, p, 'sim', { messageId: id });
  h.tg.lotes.push([s2]);
  await h.p.esperarTelegram(5000);
  await bombear(h.cru);
  assert.deepEqual(respostas(h), [TXT.anoteiSim], 'o Sim vale de novo');
  assert.deepEqual(recadosOk(h).map((r) => r.providerMsgId), [`tgok-u${s2.update_id}`]);
  e = estado(h);
  assert.equal(e.okTg.segurar, s2.update_id);
  assert.equal(e.okTg.mensagens.ABC234.toque.updateId, s2.update_id);
});

// Sim tocado e o recado entregue na aba (mensageiro "enviado"): a conferencia fica esperando a aba.
async function toqueEntregue(h) {
  const { p, id } = await comPedidoNoChat(h);
  const u = toqueOk(h, p, 'sim', { messageId: id });
  const t = h.t;
  h.tg.lotes.push([u]);
  await h.p.esperarTelegram(5000);
  await bombear(h.cru);
  assert.ok(estado(h).entregas[`tgok-u${u.update_id}`], 'entrega registrada');
  return { p, id, u, t, rec: recadosOk(h)[0] };
}
const usadoPeloTg = (u, id, t) => ({ status: 'usado', usadoEm: iso(t), verificadoPor: { canal: 'telegram', updateId: u.update_id, messageId: id, texto: 'Sim', conferidoEm: iso(t) } });
const logsDoOk = (h, re) => logs(h).filter((l) => l.includes('ABC234') && re.test(l));

test('T7b2a 85c (revisao, item 3). "ainda não pegou" (naFila) e "não mostrou" (reforco que falhou ou 2a resposta sem a linha) do recado do toque NAO mexem na mensagem do OK (1 linha de log): depois a aba confere = "A aba conferiu"; vence = o fecho do vencido', async () => {
  // naFila e depois usado pelo Telegram
  {
    const h = montar();
    const { p, id, u, t } = await toqueEntregue(h);
    h.t += 10 * MIN + 1000;
    h.tg.chamadas.length = 0;
    await h.p.passoEventos(); // 10 min sem o recado no transcript da aba
    await h.p.esperarTelegram(5000);
    assert.deepEqual(h.tg.de('editarTexto'), [], 'naFila nao mexe na mensagem do OK');
    assert.equal(okDe(h, 'ABC234').fechadoEm, null);
    assert.equal(logsDoOk(h, /ainda nao apareceu/).length, 1, '1 linha de log');
    assert.deepEqual(h.enviados, [], 'nada no grupo');
    h.t += 5 * MIN;
    const tUso = h.t;
    mudarPedido(h, 'ABC234', usadoPeloTg(u, id, tUso));
    await h.p.esperarTelegram(15000);
    // T7j: o Sim conferido pelo Telegram apaga a mensagem (nenhum fecho editado)
    assert.deepEqual(h.tg.de('editarTexto'), [], 'naFila e depois usado: sem fecho editado');
    assert.deepEqual(h.tg.de('apagar').map((x) => x.args[0]), [id], 'naFila e depois usado: apagada 1 vez');
    assert.equal(okDe(h, 'ABC234').fim, 'conferido');
  }
  // naFila e depois vencido
  {
    const h = montar();
    const { p, t } = await toqueEntregue(h);
    h.t += 10 * MIN + 1000;
    await h.p.passoEventos();
    await h.p.esperarTelegram(5000);
    h.t = Date.parse(p.expiraEm) + 1000;
    h.tg.chamadas.length = 0;
    await h.p.esperarTelegram(15000);
    const ed = h.tg.de('editarTexto');
    assert.equal(ed.length, 1, 'naFila e depois vencido: 1 fecho');
    assert.equal(ed[0].args[1].texto, montarOkTgFechado({ ...p, linha: TXT.naoConferiu(horaBRT(iso(t)), horaBRT(p.expiraEm)) }).texto);
  }
  // "não mostrou" na conferencia: a aba respondeu sem a linha ao recado e ao reforco; depois confere
  {
    const h = montar();
    const { p, id, u, t, rec } = await toqueEntregue(h);
    h.t += 2000;
    transcript(h, 'S1', [peer(rec, iso(h.t))]);
    h.t += 1000;
    evento(h, parou(h, 'S1', { final: 'Vou conferir o pedido.' }));
    await h.p.passoEventos();
    const doRecado = h.entregas.filter((x) => x.providerMsgId === rec.providerMsgId);
    assert.equal(doRecado.length, 2, 'o reforco saiu');
    assert.equal(doRecado[1].reforco, true);
    h.t += 2000;
    transcript(h, 'S1', [peer(doRecado[1], iso(h.t))]);
    h.t += 1000;
    evento(h, parou(h, 'S1', { final: 'Conferi.' }));
    h.tg.chamadas.length = 0;
    await h.p.passoEventos();
    await h.p.esperarTelegram(5000);
    assert.deepEqual(h.tg.de('editarTexto'), [], '"não mostrou" nao mexe na mensagem do OK');
    assert.equal(logsDoOk(h, /nao mostrou/).length, 1, '1 linha de log');
    assert.deepEqual(h.enviados, [], 'nada no grupo');
    h.t += MIN;
    const tUso = h.t;
    mudarPedido(h, 'ABC234', usadoPeloTg(u, id, tUso));
    await h.p.esperarTelegram(15000);
    // T7j: conferido pelo Telegram = apagada (nenhum fecho editado)
    assert.deepEqual(h.tg.de('editarTexto'), []);
    assert.deepEqual(h.tg.de('apagar').map((x) => x.args[0]), [id]);
    assert.equal(okDe(h, 'ABC234').fim, 'conferido');
  }
  // "não mostrou" pelo reforco que o mensageiro nao entregou (aplicarResultado); depois vence
  {
    const h = montar({ respostasEntrega: [{ status: 'enviado', detalhe: '' }, { status: 'erro', detalhe: 'estourou o tempo' }] });
    const { p, t, rec } = await toqueEntregue(h);
    h.t += 2000;
    transcript(h, 'S1', [peer(rec, iso(h.t))]);
    h.t += 1000;
    evento(h, parou(h, 'S1', { final: 'Vou conferir o pedido.' }));
    h.tg.chamadas.length = 0;
    await h.p.passoEventos();
    await h.p.esperarTelegram(5000);
    assert.equal(h.entregas.filter((x) => x.reforco === true).length, 1, 'o reforco foi tentado');
    assert.deepEqual(h.tg.de('editarTexto'), [], 'o reforco que falhou nao mexe na mensagem do OK');
    assert.equal(logsDoOk(h, /nao mostrou/).length, 1, '1 linha de log');
    h.t = Date.parse(p.expiraEm) + 1000;
    await h.p.esperarTelegram(15000);
    const ed = h.tg.de('editarTexto');
    assert.equal(ed.length, 1);
    assert.equal(ed[0].args[1].texto, montarOkTgFechado({ ...p, linha: TXT.naoConferiu(horaBRT(iso(t)), horaBRT(p.expiraEm)) }).texto);
  }
});

test('T7b2a 80c (revisao, item 4). envio do pedido de OK que volta incerto abre uma janela no e.okTg (desde = o maior id que o canal conhece); a sonda nunca sonda nem apaga a mensagem incerta; o reenvio ok fecha a janela; a linha do sistema duplicada fora da janela segue sondada como hoje', async () => {
  const h = montar({ sondaTg: true });
  aba(h, 'S1', 'Faro');
  ligarTg(h);
  const orfas = [];
  // a linha do sistema do "/voltei" sai incerta 3 vezes (recuo 30 s, 1 e 2 min) e depois sai (T9: o "status" virou o painel)
  h.tg.respEnviar.push(incerto(h, 'enviar', (x) => orfas.push(x)), incerto(h, 'enviar', (x) => orfas.push(x)), incerto(h, 'enviar', (x) => orfas.push(x)));
  const st = msgTg(h, '/voltei');
  h.tg.lotes.push([st]);
  await h.p.esperarTelegram(15000);
  let idOkIncerto = null;
  h.tg.respEnviarTexto.push(incerto(h, 'enviarTexto', (x) => { idOkIncerto = x; }));
  pedidoOk(h, { codigo: 'ABC234' });
  await h.p.esperarTelegram(15000); // o pedido sai incerto: a mensagem chegou e o porteiro nao sabe o id
  assert.ok(Number.isSafeInteger(idOkIncerto));
  assert.equal(okDe(h, 'ABC234'), undefined, 'sem entrada');
  const desde = st.message.message_id; // o maior id que o canal conhece (a mensagem do dono citada pela linha)
  assert.deepEqual(estado(h).okTg.janelas?.ABC234 && { desde: estado(h).okTg.janelas.ABC234.desde, ate: estado(h).okTg.janelas.ABC234.ate }, { desde, ate: null }, 'janela aberta');
  for (let i = 0; i < 15; i++) await h.p.esperarTelegram(15000);
  const idOk = okDe(h, 'ABC234').messageId;
  assert.ok(idOk > idOkIncerto, 'o reenvio saiu');
  const j = estado(h).okTg.janelas.ABC234;
  assert.deepEqual({ desde: j.desde, ate: j.ate }, { desde, ate: idOk }, 'o reenvio ok fecha a janela no id dele');
  assert.equal(orfas.length, 3);
  const sondados = h.tg.de('editarBotoes').map((c) => c.args[0]);
  const apagados = h.tg.de('apagar').map((c) => c.args[0]);
  assert.ok(!sondados.includes(idOkIncerto) && !apagados.includes(idOkIncerto), `a mensagem do OK incerta nunca e sondada nem apagada (sondados ${sondados}, apagados ${apagados})`);
  assert.deepEqual(sondados, [orfas[2]], 'a orfa de depois da janela (fora dela) e sondada como hoje');
  assert.ok(apagados.includes(orfas[2]), 'e apagada (e do bot)');
  assert.ok(!sondados.includes(orfas[0]) && !sondados.includes(orfas[1]), 'as orfas dentro da janela ficam no chat');
  const nova = estado(h).tg.sistema.mensagem.messageId;
  assert.ok(logs(h).some((l) => l.includes(`telegram sistema: mensagem ${nova} enviada depois de envio incerto; 1 id(s) desconhecido(s) entre ${desde} e ${nova} vao pra sonda`)), 'a conta da sonda sem os ids do OK (nem o principal, que o canal conhece pelo idsDeFora)');
  assert.ok(logs(h).some((l) => l.includes(`3 id(s) entre ${desde} e ${nova} na janela de um pedido de OK`)), 'os ids da janela: 1 linha de log');

  // o roteiro do revisor (rc-outras): o dono toca na mensagem incerta (vira `outras`) e so depois a linha sai
  const h2 = montar({ sondaTg: true });
  ligarTg(h2);
  h2.tg.respEnviar.push(incerto(h2, 'enviar'), incerto(h2, 'enviar'));
  let m1 = null;
  h2.tg.respEnviarTexto.push(incerto(h2, 'enviarTexto', (x) => { m1 = x; }));
  h2.tg.lotes.push([msgTg(h2, '/voltei')]);
  await h2.p.esperarTelegram(5000);
  aba(h2, 'S1', 'Faro');
  const p2 = pedidoOk(h2, { codigo: 'ABC234' });
  await h2.p.esperarTelegram(5000);
  h2.t += 30 * 1000;
  await h2.p.esperarTelegram(5000);
  h2.tg.lotes.push([toqueOk(h2, p2, 'sim', { messageId: m1 })]);
  await h2.p.esperarTelegram(5000);
  await bombear(h2.cru);
  assert.deepEqual(okDe(h2, 'ABC234').outras, [m1]);
  // T7i: o toque tira os botoes da M1 (editarBotoes, a mesma chamada da sonda); a sonda e o que vem depois dele
  const n2 = h2.tg.chamadas.length;
  const antes2 = h2.tg.chamadas.slice(0, n2);
  assert.equal(antes2.filter((c) => c.metodo === 'editarBotoes' && c.args[0] === m1).length, 1, 'antes da sonda: so o toque tirando os botoes da M1, 1 vez');
  assert.ok(!antes2.some((c) => c.metodo === 'apagar' && c.args[0] === m1), 'a M1 nunca apagada');
  h2.t += 60 * 1000;
  await h2.p.esperarTelegram(15000);
  assert.ok(estado(h2).tg.sistema.mensagem, 'a linha do sistema saiu');
  const depois2 = h2.tg.chamadas.slice(n2);
  assert.ok(!depois2.some((c) => ['editarBotoes', 'apagar'].includes(c.metodo) && c.args[0] === m1), 'a M1 nunca');

  // no canal: {sondar} dentro de uma janela (fechada ou aberta) sai da lista sem chamar a API; fora dela, a sonda de hoje;
  // mensagem do bot conhecida ({doBot}) segue apagada mesmo dentro de uma janela aberta; janela torta e ignorada
  const chamadas = [];
  const tgAux = {
    async enviar() { chamadas.push('enviar'); return { ok: true, messageId: 70, formato: 'rich' }; },
    async editar() { chamadas.push('editar'); return { ok: true }; },
    async apagar(x) { chamadas.push(`apagar ${x}`); return { ok: true }; },
    async editarBotoes(x) { chamadas.push(`sondar ${x}`); return { ok: true }; },
  };
  const canal = criarCanalTelegram({ tg: tgAux, agora: () => h.t, rand: randFixo(), sondar: true });
  const e = { tg: tgNovo() };
  canal.sistema(e, 'linha', {});
  await canal.drenar(e);
  e.tg.sistema.apagar.push(...[53, 55, 58, 59, 61].map((x) => ({ messageId: x, sondar: true })), { messageId: 62, doBot: true });
  canal.sistema(e, 'outra linha', {});
  chamadas.length = 0;
  await canal.drenar(e, { janelasDeFora: [{ desde: 54, ate: 59 }, { desde: 60, ate: null }, { desde: 'x', ate: null }, null] });
  assert.ok(!chamadas.some((c) => /\b(55|58|61)$/.test(c)), `ids nas janelas sem nenhuma chamada: ${chamadas.join(', ')}`);
  for (const c of ['sondar 53', 'apagar 53', 'sondar 59', 'apagar 59', 'apagar 62']) assert.ok(chamadas.includes(c), `${c}: ${chamadas.join(', ')}`);
  assert.deepEqual(e.tg.sistema.apagar, [], 'a lista esvaziou');
});

test('T7b2a 88b (revisao, item 5). OK desligado com o segurar do disco ABAIXO do offset (o toque segurado com o OK ligado; o dono tira o telegram.ok e religa): o offset passa do toque e todas as falas novas chegam na aba', async () => {
  const h = montar();
  const { p, id } = await comPedidoNoChat(h);
  const tg = filaTelegram(h, { msPorLeitura: 1000 });
  const toque = toqueOk(h, p, 'sim', { messageId: id });
  tg.por(toque);
  await h.p.esperarTelegram(5000);
  await bombear(h.cru);
  assert.equal(estado(h).okTg.segurar, toque.update_id, 'OK ligado: segurado');
  assert.equal(estado(h).tg.offset, toque.update_id);
  fs.writeFileSync(path.join(h.env.SESSOES_WPP_DIR, 'config.json'), JSON.stringify({ telegram: { ligado: true } }));
  religar(h);
  const N = 120; // mais de 1 lote de 100: o offset preso no toque nunca passaria do 1o lote
  const falas = [];
  for (let i = 0; i < N; i++) {
    const m = msgTg(h, `Faro: fala ${i}`);
    falas.push(m);
    tg.por(m);
  }
  for (let i = 0; i < 2; i++) {
    await h.p.esperarTelegram(5000);
    await bombearTudo(h.cru);
  }
  const chegaram = new Set(h.entregas.filter((x) => /^fala \d+$/.test(x.texto)).map((x) => x.texto));
  assert.equal(chegaram.size, N, 'todas as falas chegaram na aba');
  assert.equal(estado(h).tg.offset, falas.at(-1).update_id + 1, 'o offset passou do toque');
  assert.ok(tg.confirmados.has(toque.update_id), 'o toque foi confirmado (o OK desligado nao segura)');
});

// O "sim" do dono no GRUPO citando o pedido, com o aviso da aba do pedido (S1) no grupo antes dele; `problema` = a
// entrega do "sim" devolve nao_achei (sai a frase do problema no grupo).
async function roteiroGrupoDoPedido(ok, problema) {
  const h = montar({ ok, respostasEntrega: problema ? [{ status: 'nao_achei', detalhe: '' }] : [] });
  aba(h, 'S1', 'Faro');
  ligarTg(h);
  await ligarRua(h);
  evento(h, parou(h, 'S1', { final: 'Vou publicar.\n\n---\n🔴 **DECISÃO:** Publico? A) Sim (recomendado) / B) Não', marcas: { decisao: true, fica: false, pergunta: false } }));
  await h.p.passoEventos();
  h.t += 1000;
  const p = pedidoOk(h, { codigo: 'ABC234' });
  h.grupo.push({ id: p.messageId, provider_msg_id: p.providerMsgId, from_me: true, sent_by_agent: true, message_type: 'text', content: 'pedido', message_ts: iso(h.t), direction: 'sent' });
  h.t += 1000;
  await h.p.esperarTelegram(5000);
  msg(h, { content: 'sim', quoted_msg_id: p.providerMsgId });
  await h.p.passoGrupo();
  await h.p.esperarTelegram(5000);
  return h;
}

test('T7b2a 92b (revisao, item 6). F7 com o aviso da aba do pedido no grupo antes do "sim" citando o pedido: entregue (o "Concluído" no aviso dela) e nao_achei (a frase do problema) saem byte a byte iguais com o OK ligado e desligado; o recado do "sim" do grupo nunca leva `ok`', async () => {
  for (const problema of [false, true]) {
    const com = await roteiroGrupoDoPedido(true, problema);
    const sem = await roteiroGrupoDoPedido(false, problema);
    const caso = problema ? 'nao_achei' : 'entregue';
    assert.equal(enviosOk(com, 'ABC234').length, 1, `${caso}: com o OK ligado a mensagem do pedido saiu no Telegram`);
    assert.equal(enviosOk(sem, 'ABC234').length, 0);
    assert.deepEqual(com.enviados.map((x) => x.texto), sem.enviados.map((x) => x.texto), `${caso}: grupo byte a byte`);
    assert.deepEqual(com.edicoesGrupo, sem.edicoesGrupo, `${caso}: edicoes do grupo byte a byte`);
    assert.deepEqual(com.reacoes, sem.reacoes, caso);
    const rec = com.entregas.find((x) => x.nota === FRASES.notaPedidoOk('ABC234'));
    assert.ok(rec, `${caso}: o sim do grupo foi pra aba`);
    assert.equal(Object.hasOwn(rec, 'ok'), false, `${caso}: o recado do grupo nunca leva ok`);
    if (problema) assert.ok(com.enviados.some((x) => x.texto.includes('Não achei a sessão Faro')), 'a frase do problema saiu no grupo');
    else assert.ok(com.edicoesGrupo.some((x) => x.texto.includes('Concluído')), 'o aviso da aba virou "Concluído"');
  }
});

test('T7b2a 92c (revisao). ensaio nem liga o OK pelo Telegram (a linha de log do ligado nunca sai no ensaio; fora dele, sai)', async () => {
  const h = montar({ ensaio: true });
  assert.ok(!logs(h).some((l) => l.includes('pedido de OK com os botoes Sim e Nao no chat do bot ligado')), 'ensaio: desligado');
  const h2 = montar();
  assert.ok(logs(h2).some((l) => l.includes('pedido de OK com os botoes Sim e Nao no chat do bot ligado')), 'fora do ensaio: ligado');
});

test('T7b2a 90b (revisao, item 7). recado do toque com o mensageiro devolvendo erro mas ja no transcript da aba: a nova tentativa passa pelo registrarJaNaAba e nada sai no grupo (nem o "Concluído" no aviso da aba, nem envio, nem reacao)', async () => {
  const h = montar({ respostasEntrega: [{ status: 'erro', detalhe: 'claude -p estourou o tempo' }] });
  aba(h, 'S1', 'Faro');
  ligarTg(h);
  await ligarRua(h);
  evento(h, parou(h, 'S1', { final: 'Vou publicar.\n\n---\n🔴 **DECISÃO:** Publico? A) Sim (recomendado) / B) Não', marcas: { decisao: true, fica: false, pergunta: false } }));
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 1, 'o aviso da aba saiu no grupo');
  h.enviados.length = 0;
  h.t += 1000;
  const p = pedidoOk(h, { codigo: 'ABC234' });
  await h.p.esperarTelegram(15000);
  const u = toqueOk(h, p, 'sim', { messageId: okDe(h, 'ABC234').messageId });
  h.tg.lotes.push([u]);
  await h.p.esperarTelegram(5000);
  await bombear(h.cru);
  assert.equal(estado(h).repassar.length, 1, '1a tentativa: erro -> nova tentativa');
  const rec = recadosOk(h)[0];
  h.t += 2000;
  transcript(h, 'S1', [peer(rec, iso(h.t))]); // o recado chegou na aba apesar do erro (F3.6)
  h.t += 31 * 1000;
  await h.p.passoGrupo(); // nova tentativa -> jaNaAba -> registrarJaNaAba
  assert.ok(logs(h).some((l) => /entrega S1: recado ja estava na aba/.test(l)), 'o caminho do registrarJaNaAba');
  assert.equal(h.entregas.length, 1, 'nao reenvia');
  assert.ok(estado(h).entregas[rec.providerMsgId], 'a entrega e registrada');
  assert.deepEqual(h.edicoesGrupo, [], 'nenhuma edicao no grupo (nem o "Concluído")');
  assert.deepEqual(h.enviados, [], 'nenhum envio no grupo');
  assert.deepEqual(h.reacoes, [], 'nenhuma reacao');
  assert.deepEqual(estado(h).saida, [], 'nada na fila do grupo');
});

test('T7b2a 83c (revisao, item 8). toque k: com o OK desligado (a mensagem saiu com o OK ligado; o dono tira o telegram.ok e religa): "Essa pergunta já mudou.", nenhum recado tgok-u e nada anotado no e.okTg', async () => {
  const h = montar();
  const { p, id } = await comPedidoNoChat(h);
  const antes = estado(h).okTg;
  fs.writeFileSync(path.join(h.env.SESSOES_WPP_DIR, 'config.json'), JSON.stringify({ telegram: { ligado: true } }));
  religar(h);
  h.tg.chamadas.length = 0;
  const u = toqueOk(h, p, 'sim', { messageId: id });
  h.tg.lotes.push([u]);
  await h.p.esperarTelegram(15000);
  await bombear(h.cru);
  assert.deepEqual(respostas(h), [TXT.mudou]);
  assert.deepEqual(h.entregas, [], 'nenhum recado');
  const depois = estado(h).okTg;
  assert.deepEqual(depois.mensagens, antes.mensagens, 'nada anotado');
  assert.equal(depois.segurar, null);
  assert.equal(estado(h).tg.offset, u.update_id + 1, 'nada segurado');
});

test('T7b2a 83d (revisao, item 9). toque na mensagem de envio incerto SEM entrada (a M1 chegou, nada gravado; toque antes do reenvio de 30 s): a entrada nasce com a M1, segurar = o update do toque, o offset nao passa dele e nenhuma 2a mensagem do pedido depois dos 30 s', async () => {
  const h = montar();
  aba(h, 'S1', 'Faro');
  ligarTg(h);
  const tg = filaTelegram(h);
  let m1 = null;
  h.tg.respEnviarTexto.push(incerto(h, 'enviarTexto', (x) => { m1 = x; }));
  const p = pedidoOk(h, { codigo: 'ABC234' });
  await h.p.esperarTelegram(5000);
  assert.equal(okDe(h, 'ABC234'), undefined, 'envio incerto: sem entrada');
  const u = toqueOk(h, p, 'sim', { messageId: m1 });
  tg.por(u);
  await h.p.esperarTelegram(5000);
  await bombear(h.cru);
  let e = estado(h);
  assert.equal(e.okTg.mensagens.ABC234.messageId, m1, 'a entrada nasce com a M1');
  assert.deepEqual(e.okTg.mensagens.ABC234.outras, []);
  assert.equal(e.okTg.segurar, u.update_id);
  assert.equal(e.tg.offset, u.update_id);
  h.t += 30 * 1000;
  await h.p.esperarTelegram(15000);
  await bombear(h.cru);
  e = estado(h);
  assert.equal(h.tg.de('enviarTexto').length, 1, 'nenhuma 2a mensagem do pedido');
  assert.equal(e.okTg.segurar, u.update_id);
  assert.ok(e.tg.offset <= u.update_id, 'o offset nao passa do toque');
  assert.ok(!tg.confirmados.has(u.update_id), 'o toque segue no Telegram pro verificar');
  assert.equal(recadosOk(h).length, 1);
});

test('T7b2a 80d (revisao, item 10). a mensagem em `outras` fica fora da sonda mesmo sem janela: o porteiro morreu no meio do envio (a M1 chegou, nada gravado), mandou de novo (M2) e o dono tocou na M1; o reenvio da linha do sistema confere os ids do meio e nunca sonda nem apaga a M1', async () => {
  const h = montar({ sondaTg: true });
  aba(h, 'S1', 'Faro');
  ligarTg(h);
  const orfas = [];
  h.tg.respEnviar.push(incerto(h, 'enviar', (x) => orfas.push(x)), incerto(h, 'enviar', (x) => orfas.push(x)));
  h.tg.lotes.push([msgTg(h, 'status')]);
  await h.p.esperarTelegram(5000); // a linha do sistema: incerta
  const p = pedidoOk(h, { codigo: 'ABC234' });
  await h.p.esperarTelegram(5000); // a M1 sai
  const m1 = okDe(h, 'ABC234').messageId;
  mexer(h, (e) => { delete e.okTg.mensagens.ABC234; }); // o porteiro morreu antes de gravar: sem entrada e sem janela
  religar(h);
  await h.p.esperarTelegram(5000); // a linha de novo (incerta) e a M2
  const m2 = okDe(h, 'ABC234').messageId;
  assert.ok(m2 > m1);
  h.tg.lotes.push([toqueOk(h, p, 'sim', { messageId: m1 })]);
  await h.p.esperarTelegram(5000);
  await bombear(h.cru);
  assert.deepEqual(okDe(h, 'ABC234').outras, [m1], 'a M1 entrou em outras');
  assert.deepEqual(estado(h).okTg.janelas ?? {}, {}, 'sem janela: os 2 envios do pedido deram certo');
  // T7i: o toque tira os botoes da M1 e da M2 (editarBotoes, a mesma chamada da sonda); a sonda e o que vem depois dele
  const n0 = h.tg.chamadas.length;
  const antes = h.tg.chamadas.slice(0, n0);
  assert.deepEqual(antes.filter((c) => c.metodo === 'editarBotoes').map((c) => c.args), [[m2, null], [m1, null]], 'antes da sonda: so o toque tirando os botoes das 2, 1 vez cada');
  assert.ok(!antes.some((c) => c.metodo === 'apagar' && [m1, m2].includes(c.args[0])), 'nenhuma das 2 apagada');
  h.t += 30 * 1000;
  await h.p.esperarTelegram(15000); // a linha sai: a sonda confere os ids entre a marca e ela
  const depois = h.tg.chamadas.slice(n0);
  const sondados = depois.filter((c) => c.metodo === 'editarBotoes').map((c) => c.args[0]);
  const apagados = depois.filter((c) => c.metodo === 'apagar').map((c) => c.args[0]);
  assert.deepEqual(sondados, orfas, 'a sonda olhou so as orfas da linha');
  assert.ok(!sondados.includes(m1) && !apagados.includes(m1), 'a M1 (outras) nunca e sondada nem apagada');
});

test('T7b2a 90c (revisao, item 11). o recado do toque entregue nao mexe no chamado da aba: a fala do dono em cima do chamado da Faro esta em nova tentativa (1a entrega em erro) e o chamado segue "enviando" depois que o recado do Sim sai', async () => {
  const h = montar();
  h.mensageiro.entregar = async (x) => {
    h.entregas.push(x);
    return String(x.providerMsgId).startsWith('tgok-u') ? { status: 'enviado', detalhe: '' } : { status: 'erro', detalhe: 'estourou o tempo' };
  };
  aba(h, 'S1', 'Faro');
  ligarTg(h);
  const tela = await chamadoNaTela(h, 'S1', 'Faro');
  const p = pedidoOk(h, { codigo: 'ABC234' });
  await h.p.esperarTelegram(15000);
  const fala = msgTg(h, 'manda o resumo antes', { extra: { reply_to_message: { message_id: tela } } });
  const u = toqueOk(h, p, 'sim', { messageId: okDe(h, 'ABC234').messageId });
  h.tg.lotes.push([fala, u]);
  await h.p.esperarTelegram(15000);
  await bombear(h.cru);
  await h.p.esperarTelegram(5000);
  const e = estado(h);
  assert.deepEqual(h.entregas.map((x) => x.texto), ['manda o resumo antes', 'Sim']);
  assert.ok(e.repassar.some((i) => i?.pedido?.texto === 'manda o resumo antes'), 'a fala do dono espera a nova tentativa');
  assert.ok(e.entregas[`tgok-u${u.update_id}`], 'o recado do Sim saiu');
  assert.equal(e.tg.chamados.S1.versao.estado, 'enviando', 'o chamado da aba segue "enviando"');
});

test('T7b2a 85d (revisao, item 12). guardas do problemaNoOk: o problema atrasado do recado do Sim (o Nao ja trocou o toque) nao fecha a mensagem; o problema depois do usado nao fecha e o fecho e o do usado (T7j: apagada)', async () => {
  // Sim e Nao no mesmo lote; a entrega do Sim devolve nao_achei depois que o Nao ja trocou o toque
  {
    const h = montar({ respostasEntrega: [{ status: 'nao_achei', detalhe: '' }, { status: 'enviado', detalhe: '' }] });
    const { p, id } = await comPedidoNoChat(h);
    const s = toqueOk(h, p, 'sim', { messageId: id });
    const n = toqueOk(h, p, 'nao', { messageId: id });
    h.tg.lotes.push([s, n]);
    await h.p.esperarTelegram(5000);
    await bombear(h.cru);
    await h.p.esperarTelegram(5000);
    assert.deepEqual(recadosOk(h).map((r) => r.texto), ['Sim', 'Não']);
    assert.deepEqual(h.tg.de('editarTexto'), [], 'o problema do recado do Sim nao fecha a mensagem');
    assert.deepEqual(h.tg.de('apagar'), [], 'nem apaga (T7j)');
    assert.equal(okDe(h, 'ABC234').fechadoEm, null);
    mudarPedido(h, 'ABC234', { status: 'recusado', decididoEm: iso(h.t), verificadoPor: { canal: 'telegram', updateId: n.update_id, messageId: id, texto: 'Não', conferidoEm: iso(h.t) } });
    await h.p.esperarTelegram(15000);
    // T7j: recusado pelo Telegram = a mensagem do pedido some (nenhum fecho editado)
    assert.deepEqual(h.tg.de('editarTexto'), []);
    assert.deepEqual(h.tg.de('apagar').map((x) => x.args[0]), [id]);
    assert.deepEqual([okDe(h, 'ABC234').fim, okDe(h, 'ABC234').apagada], ['cancelado', true]);
  }
  // a aba conferiu (usado) e o problema da entrega chega depois: o fecho e o do usado
  {
    const h = montar();
    const { p, id } = await comPedidoNoChat(h);
    const u = toqueOk(h, p, 'sim', { messageId: id });
    let tUso = null;
    h.mensageiro.entregar = async (x) => {
      h.entregas.push(x);
      tUso = h.t;
      mudarPedido(h, 'ABC234', usadoPeloTg(u, id, tUso));
      return { status: 'nao_achei', detalhe: '' };
    };
    h.tg.lotes.push([u]);
    await h.p.esperarTelegram(1500); // o resultado so e aplicado no proximo passoEntrega (antes do fecho da volta seguinte)
    await bombear(h.cru);
    await h.p.esperarTelegram(15000);
    // T7j: o problema depois do usado nao fecha nada a mais; o fecho do usado pelo Telegram apaga a mensagem 1 vez
    assert.deepEqual(h.tg.de('editarTexto'), [], 'nenhum fecho editado');
    assert.deepEqual(h.tg.de('apagar').map((x) => x.args[0]), [id], 'so o apagar do usado');
    assert.equal(okDe(h, 'ABC234').fim, 'conferido');
  }
});

test('T7b2a 84b (revisao, item 14). com o toque segurado a mesma janela volta a cada 2 s: o tratarLoteTg so grava o estado.json quando trata um update novo ou o offset muda (nao 1 gravacao por update repetido)', async () => {
  const h = montar();
  const { p, id } = await comPedidoNoChat(h);
  const tg = filaTelegram(h);
  const toque = toqueOk(h, p, 'sim', { messageId: id });
  tg.por(toque);
  await h.p.esperarTelegram(5000);
  for (let i = 0; i < 20; i++) tg.por(msgTg(h, `Faro: fala ${i}`));
  await h.p.esperarTelegram(5000);
  await bombearTudo(h.cru);
  assert.equal(estado(h).okTg.segurar, toque.update_id);
  assert.equal(h.entregas.filter((x) => /^fala \d+$/.test(x.texto)).length, 20, 'as 20 falas foram 1 vez cada');
  let gravacoes = 0;
  const renomear = fs.renameSync;
  fs.renameSync = function (de, para) {
    if (path.basename(String(para)) === 'estado.json') gravacoes += 1;
    return renomear.apply(this, arguments);
  };
  const l0 = h.tg.de('lerAtualizacoes').length;
  try {
    await h.p.esperarTelegram(10000);
  } finally {
    fs.renameSync = renomear;
  }
  const leituras = h.tg.de('lerAtualizacoes').length - l0;
  assert.ok(leituras >= 4, `leu a janela presa ${leituras} vezes`);
  assert.ok(gravacoes <= 3 * leituras, `${gravacoes} gravacoes em ${leituras} leituras da janela de 21 updates`);
  assert.equal(estado(h).tg.offset, toque.update_id, 'segue preso');
  assert.equal(h.entregas.filter((x) => /^fala \d+$/.test(x.texto)).length, 20, 'nada repassado de novo');
});

// ---------------------------------------------------------------------------------------------------------------
// T7i (PLANO-T7.md, "T7i"; caso real: "Depois que eu tocar no botão sim, é pra sumir os dois botões, tanto
// do sim quanto do não, porque eu já respondi"): no toque valido a mensagem do pedido perde TODOS os botoes (Sim, Não e
// Mais informações) e o texto fica; a trava que zera o toque devolve os botoes (destravado).

// Sim (ou Nao) tocado na mensagem do pedido, com o recado entregue; devolve o update e a hora do toque.
async function tocar(h, p, acao, o = {}) {
  const u = toqueOk(h, p, acao, o);
  const t = h.t;
  h.tg.lotes.push([u]);
  await h.p.esperarTelegram(5000);
  await bombear(h.cru);
  return { u, t };
}
const metodos = (h, nomes) => h.tg.chamadas.filter((c) => nomes.includes(c.metodo)).map((c) => c.metodo);

test('T7i 110. Sim ou Nao valido -> depois do "Anotei" e ANTES da entrega do recado, 1 editarBotoes(id, null) na mensagem do pedido (so o teclado: nenhum editarTexto), semBotoes anotado, a mensagem segue aberta e o recado sai igual; as voltas seguintes nao mexem de novo', async () => {
  for (const [acao, resposta] of [['sim', TXT.anoteiSim], ['nao', TXT.anoteiNao]]) {
    const h = montar();
    const { p, id } = await comPedidoNoChat(h);
    // a entrega do recado entra na mesma linha do tempo das chamadas do Telegram (os botoes saem na hora, nao depois dela)
    h.mensageiro.entregar = async (x) => {
      h.tg.chamadas.push({ metodo: 'entregar', args: [x.providerMsgId] });
      h.entregas.push(x);
      return { status: 'enviado', detalhe: '' };
    };
    await tocar(h, p, acao, { messageId: id });
    assert.deepEqual(metodos(h, ['responderToque', 'editarBotoes', 'editarTexto', 'entregar']), ['responderToque', 'editarBotoes', 'entregar'], `${acao}: o aviso, os botoes saem e so depois o recado`);
    assert.deepEqual(respostas(h), [resposta], acao);
    assert.deepEqual(h.tg.de('editarBotoes')[0].args, [id, null], `${acao}: todos os botoes da mensagem do pedido`);
    const m = okDe(h, 'ABC234');
    assert.equal(m.semBotoes, true, acao);
    assert.equal(m.fechadoEm, null, `${acao}: segue aberta (fecha quando o pedido sai de pendente)`);
    assert.equal(m.toque.acao, acao, acao);
    assert.equal(recadosOk(h).length, 1, `${acao}: o recado sai igual`);
    assert.ok(logs(h).some((l) => l.includes('ABC234') && /sem os botoes/.test(l)), `${acao}: 1 linha de log`);
    h.tg.chamadas.length = 0;
    await h.p.esperarTelegram(15000);
    await h.p.esperarTelegram(15000);
    assert.deepEqual(metodos(h, ['editarBotoes', 'editarTexto']), [], `${acao}: as voltas seguintes nao mexem`);
  }
});

test('T7i 111. toque numa mensagem do envio incerto (entra em outras): a principal e a outra perdem os botoes; um toque numa 3a (tela velha) tira os botoes dela tambem', async () => {
  const h = montar();
  const { p, id } = await comPedidoNoChat(h);
  const outra = id + 50;
  await tocar(h, p, 'sim', { messageId: outra });
  assert.deepEqual(okDe(h, 'ABC234').outras, [outra]);
  assert.deepEqual(h.tg.de('editarBotoes').map((c) => c.args), [[id, null], [outra, null]], 'as duas');
  assert.equal(okDe(h, 'ABC234').semBotoes, true);
  h.tg.chamadas.length = 0;
  const terceira = id + 60;
  await tocar(h, p, 'nao', { messageId: terceira });
  assert.deepEqual(okDe(h, 'ABC234').outras, [outra, terceira]);
  assert.deepEqual(respostas(h), [TXT.anoteiNao], 'o Nao da tela velha vale (troca o Sim)');
  assert.ok(h.tg.de('editarBotoes').some((c) => c.args[0] === terceira && c.args[1] === null), 'a 3a perde os botoes');
  assert.equal(okDe(h, 'ABC234').semBotoes, true);
});

test('T7i 112. tirar os botoes falhou (transporte ou 429) = 1 log e de novo so com 30 s, pelo passoOkTg; 400 (sumiu ou nao da pra editar) conta como feito', async () => {
  for (const falha of [{ ok: false, erro: 'editarBotoes: fetch failed', codigo: 0 }, { ok: false, erro: 'editarBotoes: Too Many Requests', codigo: 429, esperarS: 3 }]) {
    const h = montar();
    const { p, id } = await comPedidoNoChat(h);
    h.tg.respEditarBotoes.push(falha);
    const tA = h.t;
    await tocar(h, p, 'sim', { messageId: id });
    const nome = String(falha.codigo);
    assert.equal(h.tg.de('editarBotoes').length, 1, nome);
    assert.notEqual(okDe(h, 'ABC234').semBotoes, true, `${nome}: falhou = sem a marca`);
    assert.equal(logs(h).filter((l) => l.includes('ABC234') && /botoes/.test(l) && /falhou/.test(l)).length, 1, `${nome}: 1 log`);
    while (h.t < tA + 25 * 1000) await h.p.esperarTelegram(5000);
    assert.equal(h.tg.de('editarBotoes').length, 1, `${nome}: antes de 30 s nao tenta de novo`);
    while (h.t < tA + 40 * 1000) await h.p.esperarTelegram(5000);
    assert.equal(h.tg.de('editarBotoes').length, 2, `${nome}: com 30 s tenta de novo`);
    assert.equal(okDe(h, 'ABC234').semBotoes, true, `${nome}: agora sem botoes`);
    assert.equal(recadosOk(h).length, 1, `${nome}: o recado nao depende dos botoes`);
  }
  // 400 sem espera (a mensagem sumiu): feito, sem nova tentativa
  const h = montar();
  const { p, id } = await comPedidoNoChat(h);
  h.tg.respEditarBotoes.push({ ok: false, erro: 'editarBotoes: Bad Request: message to edit not found', codigo: 400 });
  await tocar(h, p, 'sim', { messageId: id });
  assert.equal(okDe(h, 'ABC234').semBotoes, true, '400 = feito');
  h.t += 40 * 1000;
  await h.p.esperarTelegram(15000);
  assert.equal(h.tg.de('editarBotoes').length, 1, '400: sem nova tentativa');
});

test('T7i 113. tela velha depois do toque: Mais informações = "Já anotei" e nada editado (os botoes nao voltam); 2o Sim = "Já anotei"; Nao depois do Sim (mensagem sem teclado ou com o teclado velho) vale, sem tirar de novo', async () => {
  const h = montar();
  const { p, id } = await comPedidoNoChat(h);
  const { t: t1 } = await tocar(h, p, 'sim', { messageId: id });
  assert.equal(okDe(h, 'ABC234').semBotoes, true);
  const toque = async (acao, o = {}) => {
    h.tg.chamadas.length = 0;
    await tocar(h, p, acao, { messageId: id, ...o });
    return respostas(h);
  };
  assert.deepEqual(await toque('info'), [TXT.jaAnotei('Sim', horaBRT(iso(t1)))], 'Mais informações depois do Sim');
  assert.deepEqual(metodos(h, ['editarTexto', 'editarBotoes']), [], 'nada editado: o completo com [[Sim, Não]] nao volta');
  assert.equal(okDe(h, 'ABC234').completo, false);
  assert.deepEqual(await toque('info', { teclado: { inline_keyboard: [] } }), [TXT.jaAnotei('Sim', horaBRT(iso(t1)))], 'Mais informações sem teclado');
  assert.deepEqual(metodos(h, ['editarTexto', 'editarBotoes']), []);
  assert.deepEqual(await toque('sim'), [TXT.jaAnotei('Sim', horaBRT(iso(t1)))], '2o Sim');
  assert.deepEqual(metodos(h, ['editarTexto', 'editarBotoes']), [], '2o Sim nao mexe');
  assert.deepEqual(await toque('nao', { teclado: { inline_keyboard: [] } }), [TXT.anoteiNao], 'Nao depois do Sim, a mensagem sem teclado (como o Telegram pode devolver agora)');
  assert.deepEqual(recadosOk(h).map((r) => r.texto), ['Sim', 'Não']);
  assert.deepEqual(metodos(h, ['editarTexto', 'editarBotoes']), [], 'ja sem botoes: nao tira de novo');
  assert.equal(okDe(h, 'ABC234').toque.acao, 'nao');
  // teclado PRESENTE e diferente do pedido segue recusado
  const p2 = pedidoOk(h, { codigo: 'BCD234' });
  await h.p.esperarTelegram(15000);
  const id2 = okDe(h, 'BCD234').messageId;
  h.tg.chamadas.length = 0;
  await tocar(h, p2, 'sim', { messageId: id2, teclado: apiTeclado([[SIM('BCD234')]]) });
  assert.deepEqual(respostas(h), [TXT.mudou], 'teclado trocado');
  assert.equal(okDe(h, 'BCD234').toque, null);
  assert.deepEqual(metodos(h, ['editarTexto', 'editarBotoes']), []);
});

test('T7i 114. a trava zera o toque: travado, os botoes nao voltam; destravado (pedido aberto), a mensagem volta pro compacto inteiro com os botoes (editarTexto, 1 vez), completo false; o Sim vale de novo e os botoes saem de novo', async () => {
  const h = montar();
  const { p, id } = await comPedidoNoChat(h, { tipo: 'crm', destinatarios: ['Ana'] });
  // o dono abre o completo e toca em Sim nele
  h.tg.lotes.push([toqueOk(h, p, 'info', { messageId: id })]);
  await h.p.esperarTelegram(5000);
  assert.equal(okDe(h, 'ABC234').completo, true);
  await tocar(h, p, 'sim', { messageId: id, completo: true });
  assert.equal(okDe(h, 'ABC234').semBotoes, true);
  h.tg.lotes.push([msgTg(h, 'trava')]);
  await h.p.esperarTelegram(5000);
  assert.equal(estado(h).trava, true);
  assert.equal(okDe(h, 'ABC234').toque, null, 'a trava zerou o toque');
  h.tg.chamadas.length = 0;
  await h.p.esperarTelegram(15000);
  assert.deepEqual(metodos(h, ['editarTexto', 'editarBotoes']), [], 'travado: os botoes nao voltam');
  assert.equal(okDe(h, 'ABC234').semBotoes, true);

  destravar({ env: h.env, agora: () => h.t });
  await h.p.esperarTelegram(5000);
  const compacto = montarOkTg({ ...p, completo: false });
  assert.deepEqual(h.tg.de('editarTexto').map((c) => c.args), [[id, { texto: compacto.texto, botoes: compacto.botoes }]], 'o compacto inteiro, com Sim, Não e Mais informações');
  assert.deepEqual(compacto.botoes, [[SIM('ABC234'), NAO('ABC234')], [MAIS('ABC234')]]);
  const m = okDe(h, 'ABC234');
  assert.equal(m.semBotoes, false);
  assert.equal(m.completo, false);
  assert.equal(m.fechadoEm, null);
  assert.ok(logs(h).some((l) => l.includes('ABC234') && /botoes de novo/.test(l)), '1 linha de log');
  h.tg.chamadas.length = 0;
  await h.p.esperarTelegram(15000);
  assert.deepEqual(metodos(h, ['editarTexto', 'editarBotoes']), [], 'so 1 vez');

  const { u: s2 } = await tocar(h, p, 'sim', { messageId: id });
  assert.deepEqual(respostas(h), [TXT.anoteiSim], 'o Sim vale de novo');
  assert.equal(recadosOk(h).at(-1).providerMsgId, `tgok-u${s2.update_id}`);
  assert.deepEqual(h.tg.de('editarBotoes').map((c) => c.args), [[id, null]], 'e os botoes saem de novo');
  assert.equal(okDe(h, 'ABC234').semBotoes, true);
  // pedido que venceu travado: destravado, os botoes nao voltam, nem com o fecho falhando (a mensagem fecha depois)
  const h2 = montar();
  const r2 = await comPedidoNoChat(h2);
  await tocar(h2, r2.p, 'sim', { messageId: r2.id });
  h2.tg.lotes.push([msgTg(h2, 'trava')]);
  await h2.p.esperarTelegram(5000);
  h2.t = Date.parse(r2.p.expiraEm) + 1000;
  destravar({ env: h2.env, agora: () => h2.t });
  h2.tg.chamadas.length = 0;
  h2.tg.respEditarTexto.push({ ok: false, erro: 'editarTexto: fetch failed', codigo: 0 });
  await h2.p.esperarTelegram(15000);
  assert.equal(h2.tg.de('editarTexto').length, 1, 'o fecho tentou e falhou');
  assert.ok(h2.tg.de('editarTexto').every((c) => !JSON.stringify(c.args[1].botoes ?? null).includes('"k:')), 'vencido: os botoes do OK nunca voltam (T28: so o Tentar novamente)');
  h2.t += 30 * 1000;
  await h2.p.esperarTelegram(15000);
  const ed = h2.tg.de('editarTexto');
  assert.equal(ed.length, 2, 'o fecho de novo (30 s)');
  assert.ok(ed.every((c) => !JSON.stringify(c.args[1].botoes ?? null).includes('"k:')), 'sem os botoes do OK (T28: so o Tentar novamente)');
  assert.equal(ed[1].args[1].texto, montarOkTgFechado({ ...r2.p, linha: TXT.expirouSem(horaBRT(r2.p.expiraEm)) }).texto);
  assert.ok(okDe(h2, 'ABC234').fechadoEm);
});

test('T7i 115. fecho depois do toque (a mensagem ja sem botoes): vencido com o Sim sem uso = 1 editarTexto pro fechado, como hoje; usado pelo Telegram = apagada (T7j); nenhum editarBotoes a mais', async () => {
  for (const caso of ['usado', 'vencido']) {
    const h = montar();
    const { p, id } = await comPedidoNoChat(h);
    const { u, t } = await tocar(h, p, 'sim', { messageId: id });
    h.tg.chamadas.length = 0;
    if (caso === 'usado') {
      mudarPedido(h, 'ABC234', usadoPeloTg(u, id, h.t));
      await h.p.esperarTelegram(15000);
      assert.deepEqual(h.tg.de('apagar').map((x) => x.args[0]), [id], caso); // T7j
      assert.deepEqual(h.tg.de('editarTexto'), [], `${caso}: nenhum fecho editado`);
    } else {
      h.t = Date.parse(p.expiraEm) + 1000;
      const linha = TXT.naoConferiu(horaBRT(iso(t)), horaBRT(p.expiraEm));
      await h.p.esperarTelegram(15000);
      const ed = h.tg.de('editarTexto');
      assert.equal(ed.length, 1, caso);
      assert.deepEqual(ed[0].args, [id, { texto: montarOkTgFechado({ ...p, linha }).texto, botoes: [[{ texto: '🔄 Tentar novamente', dados: 'r:ABC234' }]] }], caso); // T28
      assert.deepEqual(h.tg.de('apagar'), [], `${caso}: fica no chat`);
    }
    assert.deepEqual(h.tg.de('editarBotoes'), [], `${caso}: nada de botao`);
    assert.ok(okDe(h, 'ABC234').fechadoEm, caso);
  }
});

test('T7i 116. entrada de antes da T7i (toque anotado, sem semBotoes): a 1a volta do passoOkTg tira os botoes (principal e outras); sem toque, fechada ou com o pedido ja decidido fica como esta', async () => {
  const h = montar();
  aba(h, 'S1', 'Faro');
  ligarTg(h);
  pedidoOk(h, { codigo: 'ABC234' });
  pedidoOk(h, { codigo: 'BCD234' });
  pedidoOk(h, { codigo: 'CDE234', status: 'usado' });
  pedidoOk(h, { codigo: 'DEF234' });
  const sim = (n) => ({ acao: 'sim', em: iso(h.t), updateId: n });
  mexer(h, (e) => {
    const base = { sessionId: 'S1', completo: false, enviadoEm: iso(h.t), fechadoEm: null, fim: null };
    e.okTg.mensagens.ABC234 = { ...base, messageId: 9001, outras: [9002], toque: sim(4001) };
    e.okTg.mensagens.BCD234 = { ...base, messageId: 9003, outras: [], toque: null };
    e.okTg.mensagens.CDE234 = { ...base, messageId: 9004, outras: [], toque: sim(4002), fechadoEm: iso(h.t), fim: 'conferido' };
    e.okTg.mensagens.DEF234 = { ...base, messageId: 9005, outras: [], toque: null, semBotoes: false };
  });
  await h.p.esperarTelegram(5000);
  assert.deepEqual(h.tg.de('editarBotoes').map((c) => c.args), [[9001, null], [9002, null]]);
  assert.equal(okDe(h, 'ABC234').semBotoes, true);
  assert.notEqual(okDe(h, 'BCD234').semBotoes, true);
  assert.deepEqual(h.tg.de('editarTexto'), [], 'nada mais editado');
});

// ---------------------------------------------------------------------------------------------------------------
// T7j (PLANO-T7.md, "T7j"; caso real: "quando eu toco no sim ou em algum lugar, ele já tem que concluir e
// some a mensagem"): o pedido de OK que sai de pendente pelo toque dele (Sim conferido, Nao recusado pelo Telegram, ou
// vencido com o Nao anotado) e APAGADO do chat em vez de editado pro fecho. O resto fecha editado, como hoje (a acao nao
// aconteceu e ele precisa ver isso). Apagar recusado (48 h ou 400) = o fecho editado naquela mensagem.

test('T7j 7. porteiro: Sim tocado + pedido usado pelo Telegram -> apagar da principal e da outra, nenhum editarTexto de fecho, fechadoEm, fim "conferido", apagada true; Nao tocado + recusado pelo Telegram -> apagadas ("cancelado"); Nao tocado + vencido -> apagadas ("expirou")', async () => {
  // Sim numa 2a mensagem do pedido (envio incerto: entra em outras) e a aba conferiu
  {
    const h = montar();
    const { p, id } = await comPedidoNoChat(h);
    const outra = id + 50;
    const { u } = await tocar(h, p, 'sim', { messageId: outra });
    assert.deepEqual(okDe(h, 'ABC234').outras, [outra]);
    h.tg.chamadas.length = 0;
    mudarPedido(h, 'ABC234', usadoPeloTg(u, outra, h.t));
    await h.p.esperarTelegram(15000);
    assert.deepEqual(h.tg.de('apagar').map((c) => c.args[0]), [id, outra], 'a principal e a outra saem do chat');
    assert.deepEqual(h.tg.de('editarTexto'), [], 'nenhum fecho editado');
    const m = okDe(h, 'ABC234');
    assert.ok(Number.isFinite(Date.parse(m.fechadoEm)), 'fechadoEm');
    assert.equal(m.fim, 'conferido');
    assert.equal(m.apagada, true);
    assert.equal(estado(h).okTg.segurar, null, 'soltou');
    assert.ok(logs(h).some((l) => l.endsWith('Telegram: pedido de OK ABC234 apagado do chat (conferido)')), logs(h).join('\n'));
    assert.ok(!logs(h).some((l) => l.includes(ACAO)), 'log sem a acao');
    h.tg.chamadas.length = 0;
    await h.p.esperarTelegram(15000);
    assert.deepEqual(metodos(h, ['apagar', 'editarTexto', 'editarBotoes']), [], 'so 1 vez');
    assert.deepEqual(h.enviados, [], 'nada no grupo');
  }
  // Nao tocado e recusado pelo Telegram (a aba conferiu o Nao)
  {
    const h = montar();
    const { p, id } = await comPedidoNoChat(h);
    const { u } = await tocar(h, p, 'nao', { messageId: id });
    h.tg.chamadas.length = 0;
    mudarPedido(h, 'ABC234', { status: 'recusado', decididoEm: iso(h.t), verificadoPor: { canal: 'telegram', updateId: u.update_id, messageId: id, texto: 'Não', conferidoEm: iso(h.t) } });
    await h.p.esperarTelegram(15000);
    assert.deepEqual(h.tg.de('apagar').map((c) => c.args[0]), [id], 'recusado pelo Telegram: apagada');
    assert.deepEqual(h.tg.de('editarTexto'), []);
    const m = okDe(h, 'ABC234');
    assert.ok(m.fechadoEm);
    assert.deepEqual([m.fim, m.apagada], ['cancelado', true]);
  }
  // Nao tocado e o pedido venceu sem a aba conferir (a acao nao acontece, que e o que ele pediu)
  {
    const h = montar();
    const { p, id } = await comPedidoNoChat(h);
    await tocar(h, p, 'nao', { messageId: id });
    h.tg.chamadas.length = 0;
    h.t = Date.parse(p.expiraEm) + 1000;
    await h.p.esperarTelegram(15000);
    assert.deepEqual(h.tg.de('apagar').map((c) => c.args[0]), [id], 'vencido com o Nao: apagada');
    assert.deepEqual(h.tg.de('editarTexto'), []);
    const m = okDe(h, 'ABC234');
    assert.ok(m.fechadoEm);
    assert.deepEqual([m.fim, m.apagada], ['expirou', true]);
  }
});

test('T7j 8. porteiro: nao somem (fecho editado, como hoje): respondido pelo WhatsApp, vencido sem toque, Sim tocado e vencido sem conferencia; apagar do OK com velha numa id -> o fecho editado nela, a outra apagada, apagada false; transporte -> sem fechadoEm e nenhuma chamada antes de 30 s', async () => {
  const casos = [
    {
      nome: 'usado pelo WhatsApp', toque: null,
      mudar: (h) => ({ status: 'usado', usadoEm: iso(h.t), verificadoPor: { providerMsgId: 'W', texto: 'sim', hora: '10:03' } }),
      linha: (h) => TXT.peloWhatsapp(horaBRT(iso(h.t))),
    },
    {
      nome: 'Sim tocado e recusado pelo WhatsApp', toque: 'sim',
      mudar: (h) => ({ status: 'recusado', decididoEm: iso(h.t), verificadoPor: { providerMsgId: 'W', texto: 'não', hora: '10:04' } }),
      linha: (h) => TXT.peloWhatsapp(horaBRT(iso(h.t))),
    },
    { nome: 'vencido sem toque', toque: null, vencer: true, linha: (h, t, p) => TXT.expirouSem(horaBRT(p.expiraEm)) },
    { nome: 'Sim tocado e vencido sem conferencia', toque: 'sim', vencer: true, linha: (h, t, p) => TXT.naoConferiu(horaBRT(iso(t)), horaBRT(p.expiraEm)) },
  ];
  for (const c of casos) {
    const h = montar();
    const { p, id } = await comPedidoNoChat(h);
    const t = h.t;
    if (c.toque) await tocar(h, p, c.toque, { messageId: id });
    h.tg.chamadas.length = 0;
    if (c.mudar) mudarPedido(h, 'ABC234', c.mudar(h));
    if (c.vencer) h.t = Date.parse(p.expiraEm) + 1000;
    const linha = c.linha(h, t, p);
    await h.p.esperarTelegram(15000);
    assert.deepEqual(h.tg.de('apagar'), [], `${c.nome}: nao some`);
    const comR = /sem resposta\.$|: expirou\.$/.test(linha); // T28: o vencido que fica ganha o botao Tentar novamente
    assert.deepEqual(h.tg.de('editarTexto').map((x) => x.args), [[id, comR ? { texto: montarOkTgFechado({ ...p, linha }).texto, botoes: [[{ texto: '🔄 Tentar novamente', dados: 'r:ABC234' }]] } : { texto: montarOkTgFechado({ ...p, linha }).texto }]], `${c.nome}: o fecho editado, como hoje`);
    const m = okDe(h, 'ABC234');
    assert.ok(m.fechadoEm, c.nome);
    assert.equal(m.apagada, undefined, `${c.nome}: nao passou pelo apagar`);
  }

  // apagar recusado numa das mensagens (mais de 48 h): o fecho editado nela; a outra sai; apagada false
  {
    const h = montar();
    const { p, id } = await comPedidoNoChat(h);
    const outra = id + 50;
    const { u, t } = await tocar(h, p, 'sim', { messageId: outra });
    h.tg.chamadas.length = 0;
    const tUso = h.t;
    mudarPedido(h, 'ABC234', usadoPeloTg(u, outra, tUso));
    h.tg.respApagar.push({ ok: false, velha: true }); // a principal
    await h.p.esperarTelegram(15000);
    assert.deepEqual(h.tg.chamadas.filter((x) => ['apagar', 'editarTexto'].includes(x.metodo)).map((x) => [x.metodo, x.args[0]]), [
      ['apagar', id], ['editarTexto', id], ['apagar', outra],
    ]);
    const fecho = montarOkTgFechado({ ...p, linha: TXT.conferiu(horaBRT(iso(t)), horaBRT(iso(tUso))) }).texto;
    assert.deepEqual(h.tg.de('editarTexto')[0].args, [id, { texto: fecho }], 'o mesmo fecho de hoje, sem botoes');
    const m = okDe(h, 'ABC234');
    assert.ok(m.fechadoEm);
    assert.deepEqual([m.fim, m.apagada], ['conferido', false]);
    h.tg.chamadas.length = 0;
    await h.p.esperarTelegram(15000);
    assert.deepEqual(metodos(h, ['apagar', 'editarTexto']), [], 'so 1 vez');
  }
  // 400 sem pausa no apagar: o mesmo do velha
  {
    const h = montar();
    const { p, id } = await comPedidoNoChat(h);
    const { u } = await tocar(h, p, 'sim', { messageId: id });
    h.tg.chamadas.length = 0;
    mudarPedido(h, 'ABC234', usadoPeloTg(u, id, h.t));
    h.tg.respApagar.push({ ok: false, erro: 'apagar: Bad Request: message can not be deleted', codigo: 400 });
    await h.p.esperarTelegram(15000);
    assert.deepEqual(metodos(h, ['apagar', 'editarTexto']), ['apagar', 'editarTexto']);
    assert.deepEqual([okDe(h, 'ABC234').fim, okDe(h, 'ABC234').apagada], ['conferido', false]);
  }
  // transporte no apagar: sem fechadoEm, 1 log, nada antes de 30 s; depois apaga
  {
    const h = montar();
    const { p, id } = await comPedidoNoChat(h);
    const { u } = await tocar(h, p, 'sim', { messageId: id });
    h.tg.chamadas.length = 0;
    mudarPedido(h, 'ABC234', usadoPeloTg(u, id, h.t));
    h.tg.respApagar.push({ ok: false, erro: 'apagar: fetch failed', codigo: 0 });
    await h.p.esperarTelegram(15000);
    assert.deepEqual(metodos(h, ['apagar', 'editarTexto']), ['apagar'], 'tentou 1 vez');
    assert.equal(okDe(h, 'ABC234').fechadoEm, null, 'transporte: segue aberta');
    assert.equal(logsDoOk(h, /falhou/).length, 1, '1 linha de log');
    h.tg.chamadas.length = 0;
    await h.p.esperarTelegram(15000); // +15 s
    assert.deepEqual(metodos(h, ['apagar', 'editarTexto']), [], 'antes de 30 s nao tenta de novo');
    await h.p.esperarTelegram(15000); // +30 s
    assert.deepEqual(h.tg.de('apagar').map((x) => x.args[0]), [id], 'com 30 s tenta de novo');
    const m = okDe(h, 'ABC234');
    assert.ok(m.fechadoEm);
    assert.deepEqual([m.fim, m.apagada], ['conferido', true]);
  }
});

// Revisao da T7j (sabotagem t7b2a #41 passou depois da T7j: o fecho editado com `outras` ficou sem teste, porque os
// casos que tinham a outra mensagem passaram a apagar)
test('T7j 8b. porteiro: nao some com a outra mensagem do pedido (Sim tocado na mensagem do envio incerto e vencido sem conferencia) -> o fecho editado na principal E na outra, nenhum apagar', async () => {
  const h = montar();
  const { p, id } = await comPedidoNoChat(h);
  const outra = id + 50;
  const { t } = await tocar(h, p, 'sim', { messageId: outra });
  assert.deepEqual(okDe(h, 'ABC234').outras, [outra], 'o toque na mensagem que o porteiro nao conhecia entrou em outras');
  h.tg.chamadas.length = 0;
  h.t = Date.parse(p.expiraEm) + 1000;
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.de('apagar'), [], 'nao some');
  const fecho = montarOkTgFechado({ ...p, linha: TXT.naoConferiu(horaBRT(iso(t)), horaBRT(p.expiraEm)) }).texto;
  assert.deepEqual(h.tg.de('editarTexto').map((x) => x.args), [[id, { texto: fecho, botoes: [[{ texto: '🔄 Tentar novamente', dados: 'r:ABC234' }]] }], [outra, { texto: fecho, botoes: [[{ texto: '🔄 Tentar novamente', dados: 'r:ABC234' }]] }]], 'o fecho nas duas (T28: com o botao)');
  const m = okDe(h, 'ABC234');
  assert.ok(m.fechadoEm);
  assert.equal(m.apagada, undefined);
});

// ---------------------------------------------------------------------------------------------------------------
// A1. o toque de OK com o chat e o bot do config.json (PLANO-ABERTO.md, "A1 — Telegram pela configuração", teste 10)

test('A1 10. toque de OK com identTg {chatId: 42, botId: 7}: toque de 42 numa mensagem do bot 7 conta; o mesmo toque vindo do chat de antes (700100200) nao conta; toque de 42 numa mensagem de outro bot nao conta', async () => {
  const ID = { chatId: 42, botId: 7 };
  // o toque do toqueOk (texto e teclado do pedido) com quem tocou, o chat e o bot trocados
  const comoA1 = (u, { chat = 42, bot = 7 } = {}) => {
    u.callback_query.from = { id: chat, is_bot: false, first_name: 'Dono' };
    u.callback_query.message.chat = { id: chat, type: 'private', first_name: 'Dono' };
    u.callback_query.message.from = { id: bot, is_bot: true, first_name: 'Bot' };
    return u;
  };
  const tocarA1 = async (h, opcoes) => {
    const { p, id } = await comPedidoNoChat(h);
    const u = comoA1(toqueOk(h, p, 'sim', { messageId: id }), opcoes);
    h.tg.lotes.push([u]);
    await h.p.esperarTelegram(15000);
    await bombear(h.cru);
    return { p, u };
  };

  // toque de 42 na mensagem do bot 7: conta (Anotei: Sim, toque anotado, 1 recado)
  const h = montar({ identTg: ID });
  const a = await tocarA1(h);
  assert.deepEqual(h.tg.de('responderToque').map((c) => c.args), [[a.u.callback_query.id, TXT.anoteiSim]]);
  assert.equal(okDe(h, a.p.codigo).toque?.acao, 'sim');
  assert.equal(recadosOk(h).length, 1);

  // o mesmo toque vindo do chat 700100200: nao conta (sem Anotei, sem toque, sem recado)
  const h2 = montar({ identTg: ID });
  const b = await tocarA1(h2, { chat: DONO });
  assert.ok(!h2.tg.de('responderToque').some((c) => c.args[1] === TXT.anoteiSim), 'nada de Anotei');
  assert.equal(okDe(h2, b.p.codigo).toque, null, 'toque nao anotado');
  assert.deepEqual(recadosOk(h2), [], 'nenhum recado');

  // toque de 42 numa mensagem do bot 700900800 (o de antes): o canal deixa passar e o conferirToque recusa
  const h3 = montar({ identTg: ID });
  const c = await tocarA1(h3, { bot: BOT });
  assert.deepEqual(h3.tg.de('responderToque').map((x) => x.args), [[c.u.callback_query.id, TXT.mudou]], 'nao confere = a pergunta mudou');
  assert.equal(okDe(h3, c.p.codigo).toque, null);
  assert.deepEqual(recadosOk(h3), []);
});
