// Testes da T29a no porteiro (PLANO-TELEGRAM.md, "T29" e "T29a"; pedido do dono 18/10/2026 18:58, pelo Telegram: «Quero
// tambem que tenha um botão no menu pra ligar ou desligar a resposta por voz e pra mudar o modo de limpo (apaga as msgs)
// pros outros modos»): o menu do bot ganha "voz" e "modo" (depois do "voltei"); cada toque (ou o comando digitado)
// alterna, vale na hora (sem religar), grava so a chave no config.json da pasta de estado (escrita atomica) e responde na
// linha do sistema em cima do comando. Gravacao que falha = nada muda. Por que existe: antes o modo so mudava gravando o
// config e religando, e a voz (T17) nao tinha como desligar. T39 (D3): o /voz e o /modo so abrem a mensagem de ajustes;
// a troca e o toque no botao do estado ALVO (a:v1/a:v0, a:mm/a:ml) e a frase sai no balao do toque (ajudante `ajustar`).
// Isolamento: pastas temporarias (prefixo "t29a-") via SESSOES_WPP_DIR, CLAUDE_SESSIONS_DIR, CLAUDE_PROJECTS_DIR e
// SESSOES_WPP_LOG; nunca o ~/.claude real nem o config.json real. Nenhuma rede: o `tg`, o transcrever e a voz sao dubles.
// Relogio e `dormir` falsos. Harness copiado do tests/porteiro-t23.test.mjs (sem importar de outro teste).
// Rodar: node --test --test-reporter=tap "tests/porteiro-t29a.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { criarPorteiro, COMANDOS_TG, ligarTelegram } from '../porteiro.mjs';
import { montarOkTg } from '../lib/ok-tg.mjs';
import { montarRecado } from '../mensageiro.mjs';
import { NUMERO_DONO } from './lib/dados-whatsapp.mjs';
import { CENTRAL_TESTE, RAIZES_TESTE } from './lib/dados-central.mjs';
import { criarCanalTelegram } from '../canal-telegram.mjs';

const require = createRequire(import.meta.url);
const lib = require('../hooks/lib/sessoes-wpp.js');
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-18T22:00:00Z'); // 19:00 em Brasilia
const iso = (ms) => new Date(ms).toISOString();
const DONO = 700100200;
const BOT = 700900800;
const ACAO = 'subir o site X em produção';
const FINAL_T23 = '> Telegram do Davi (19:00): «Pode publicar.»\n\nPubliquei o site.\n\n---\n🔴 **DECISÃO:** Sigo pro próximo? A) Sim (recomendado) / B) Não';
const DECISAO = { decisao: true, fica: false, pergunta: false };
// Textos do contrato da T29a (por extenso de proposito: o teste prende o texto)
const VOZ_DESLIGADA = 'Resposta por voz desligada.';
const VOZ_LIGADA = 'Resposta por voz ligada.';
const MODO_LIMPO = 'Modo limpo: o que já foi resolvido sai do chat.';
const MODO_MANTER = 'Modo manter tudo: nada sai do chat; o resolvido só perde os botões.';
const FALHA = 'Não consegui gravar o ajuste; nada mudou.';
const MENU_5 = [ // T39: a ordem do dono (o voltei saiu do menu)
  { command: 'painel', description: 'Painel das abas' },
  { command: 'central', description: 'Reabrir a central (atende o que não é de uma aba)' },
  { command: 'rua', description: 'Modo rua: ligar ou desligar' },
  { command: 'modo', description: 'Modo do painel e das mensagens' },
  { command: 'voz', description: 'Resposta por voz: ligar ou desligar' },
];
// config.json como o instalador grava (2 espacos e a quebra de linha no fim)
const FORMATO = (cfg) => `${JSON.stringify(cfg, null, 2)}\n`;
const CFG_OK = { telegram: { ligado: true, ok: { ligado: true, naAba: false } } };
const CHEIO = {
  canalPrincipal: 'telegram',
  telegram: {
    ligado: true, chatId: String(DONO), botId: String(BOT), nomeBot: 'Bot de Teste', varChave: 'TG_TESTE_CHAVE',
    resolvidas: 'apagar', ok: { ligado: true, naAba: true }, sonda: false,
  },
  whatsapp: { ligado: false },
  dono: { nome: 'Davi', fuso: 'America/Sao_Paulo' },
  voz: { nome: 'pt-BR-AntonioNeural' },
  modoRua: { automatico: true, ociosoMin: 30 },
  transcricao: { ligada: false },
  sessoes: { raizes: ['C:\\projetos'], soNaRaiz: true },
  maquina: { nome: 'pc' },
};

// ---------- harness (copia do tests/porteiro-t23.test.mjs) ----------

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

// Duble do criarTelegram: os message_id saem de UM contador (h.nMid), o do dono e o do bot intercalados.
function dubleTg(h) {
  const tg = { chamadas: [], lotes: [], ext: {} };
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
  const criar = (metodo, extra = {}) => async (pedido) => {
    const id = novoId();
    gravar(metodo, [pedido], id);
    return { ok: true, messageId: id, ...extra };
  };
  tg.enviar = criar('enviar', { formato: 'rich' });
  tg.enviarVoz = criar('enviarVoz');
  tg.enviarTexto = criar('enviarTexto');
  tg.editar = async (messageId, pedido) => { gravar('editar', [messageId, pedido]); return { ok: true }; };
  tg.editarTexto = async (messageId, pedido) => { gravar('editarTexto', [messageId, pedido]); return { ok: true }; };
  tg.editarBotoes = async (messageId, botoes) => { gravar('editarBotoes', [messageId, botoes]); return { ok: true }; };
  tg.apagar = async (messageId) => { gravar('apagar', [messageId]); return { ok: true }; };
  tg.responderToque = async (id, texto) => { gravar('responderToque', [id, texto]); return { ok: true }; };
  tg.baixar = async (fileId, destino) => {
    gravar('baixar', [fileId, destino]);
    const caminho = destino + (tg.ext[fileId] ?? '.bin');
    fs.mkdirSync(path.dirname(caminho), { recursive: true });
    fs.writeFileSync(caminho, `falso ${fileId}`);
    return { ok: true, caminho, bytes: 6 };
  };
  tg.quemSou = async () => { gravar('quemSou', []); return { ok: true, id: BOT, username: 'Teste_ControleBot' }; };
  tg.definirComandos = async (c) => { gravar('definirComandos', [c]); return { ok: true }; };
  tg.de = (metodo) => tg.chamadas.filter((c) => c.metodo === metodo);
  tg.zerar = () => { tg.chamadas.length = 0; };
  return tg;
}

// `config` = o config.json da pasta de estado: objeto (gravado no FORMATO do instalador), texto (cru) ou null (sem
// arquivo). `resolvidasTg` e `vozTg` so entram se vierem (o rodar passa os 2 do mesmo config).
function montar({ config = { telegram: { ligado: true } }, resolvidasTg, vozTg, transcrever, falar, canalPrincipal } = {}) {
  const raiz = pastaTemp('t29a-');
  const env = {
    SESSOES_WPP_DIR: path.join(raiz, 'estado'),
    CLAUDE_SESSIONS_DIR: path.join(raiz, 'sessions'),
    CLAUDE_PROJECTS_DIR: path.join(raiz, 'projects'),
    SESSOES_WPP_LOG: path.join(raiz, 'porteiro.log'),
  };
  for (const d of [env.SESSOES_WPP_DIR, env.CLAUDE_SESSIONS_DIR, env.CLAUDE_PROJECTS_DIR]) fs.mkdirSync(d, { recursive: true });
  const arqCfg = path.join(env.SESSOES_WPP_DIR, 'config.json');
  if (config !== null) fs.writeFileSync(arqCfg, typeof config === 'string' ? config : FORMATO(config));
  const h = { raiz, env, arqCfg, t: T0, idle: 0, grupo: [], enviados: [], entregas: [], nReg: 0, nUpd: 100, nMid: 7000, nAux: 0 };
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
  h.opcoes = {
    wpp: h.wpp, numeroDono: NUMERO_DONO, mensageiro: h.mensageiro, ocioso: async () => h.idle, agora: () => h.t, env, ensaio: false,
    abrirCentral: () => {}, rand: randFixo(), dormir: async (ms) => { h.t += ms; },
    tg: h.tg, identTg: { chatId: DONO, botId: BOT }, central: CENTRAL_TESTE, raizesSessao: RAIZES_TESTE,
  };
  if (canalPrincipal) h.opcoes.canalPrincipal = canalPrincipal;
  if (transcrever) h.opcoes.transcrever = transcrever;
  if (falar) h.opcoes.falar = falar;
  if (resolvidasTg !== undefined) h.opcoes.resolvidasTg = resolvidasTg;
  if (vozTg !== undefined) h.opcoes.vozTg = vozTg;
  h.cru = criarPorteiro(h.opcoes);
  h.p = comBomba(h.cru);
  h.t += 1000;
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
const logs = (h) => {
  try { return fs.readFileSync(h.env.SESSOES_WPP_LOG, 'utf8').split('\n').filter(Boolean); } catch { return []; }
};
async function ligarRua(h) {
  h.idle = 30 * MIN;
  await h.p.passoMinuto();
  assert.equal(estado(h).modoRua.ligado, true);
}
const chamado = (h, sid) => estado(h).tg.chamados[sid];
const apagadas = (h) => h.tg.de('apagar').map((c) => c.args[0]);
const cfgTexto = (h) => fs.readFileSync(h.arqCfg, 'utf8');
const cfg = (h) => JSON.parse(cfgTexto(h));

function msgTg(h, texto, { respondeA = null, extra = {} } = {}) {
  h.nUpd += 1;
  h.nMid += 1;
  const m = {
    message_id: h.nMid, date: Math.floor(h.t / 1000),
    chat: { id: DONO, type: 'private', first_name: 'Davi' }, from: { id: DONO, is_bot: false, first_name: 'Davi' }, ...extra,
  };
  if (texto !== undefined) m.text = texto;
  if (respondeA != null) m.reply_to_message = { message_id: respondeA };
  return { update_id: h.nUpd, message: m };
}
const mid = (u) => u.message.message_id;
function audioTg(h, { respondeA = null } = {}) {
  const fileId = `V${h.nUpd + 1}`;
  h.tg.ext[fileId] = '.oga';
  return msgTg(h, undefined, { respondeA, extra: { voice: { file_id: fileId, duration: 4, mime_type: 'audio/ogg' } } });
}
function toqueTg(h, dados, messageId) {
  h.nUpd += 1;
  return {
    update_id: h.nUpd,
    callback_query: { id: `q${h.nUpd}`, from: { id: DONO, is_bot: false }, message: { message_id: messageId, chat: { id: DONO, type: 'private' } }, data: dados },
  };
}
async function lerTg(h, updates) {
  h.tg.lotes.push(updates);
  await h.p.esperarTelegram(15000);
}
function dubleTranscrever() {
  const d = { chamadas: [], resolver: [] };
  d.fn = (arquivo) => new Promise((ok) => { d.chamadas.push(arquivo); d.resolver.push(ok); });
  return d;
}
function dubleFalar() {
  const d = { textos: [] };
  d.fn = (texto) => {
    d.textos.push(texto);
    return Promise.resolve(Buffer.from(`ogg ${d.textos.length}`));
  };
  return d;
}
async function audioTranscrito(h, tr, a, resposta) {
  await lerTg(h, [a]);
  await h.cru.passoAudioTg();
  await tique();
  tr.resolver.at(-1)(resposta);
  await tique();
  await h.cru.passoAudioTg();
}
async function chamadoNaTela(h, sessionId, titulo) {
  const arq = path.join(h.env.SESSOES_WPP_DIR, 'estado.json');
  const e = JSON.parse(fs.readFileSync(arq, 'utf8'));
  const aux = {
    async enviar() { h.nMid += 1; return { ok: true, messageId: h.nMid, formato: 'rich' }; },
    async editar() { return { ok: true }; },
    async apagar() { return { ok: true }; },
  };
  const canal = criarCanalTelegram({ tg: aux, agora: () => h.t, rand: randFixo() });
  canal.aviso(e, { sessionId, at: iso(h.t), finalTs: iso(h.t), final: 'Terminei a revisão.\n\nPublico?', nome: 'projetos-42' }, titulo);
  await canal.drenar(e);
  fs.writeFileSync(arq, JSON.stringify(e));
  return e.tg.chamados[sessionId].mensagem.messageId;
}
function peer(pedido, ts) {
  const texto = `Another Claude session sent a message (from repos-99):\n<cross-session-message from="repos-99">\n${montarRecado(pedido)}\n</cross-session-message>`;
  return { type: 'user', isMeta: true, origin: { kind: 'peer', from: 'repos-99' }, timestamp: ts, message: { role: 'user', content: texto } };
}
function abaResponde(h, sid, pedidos, o = {}) {
  transcript(h, sid, pedidos.map((p, i) => peer(p, iso(h.t + 1000 * (i + 1)))));
  h.t += MIN;
  evento(h, parou(h, sid, o));
}

// Audio X dele em cima do chamado da aba -> a aba responde com opcoes -> a resposta em texto sai em cima de X (e a voz, se
// ligada). `primeira` = liga o Telegram e o modo rua antes. Devolve {x, tela, voz (id | null), vozes, chamadoId}.
async function respostaDeAudio(h, tr, sid = 'S1', titulo = 'Faro', { primeira = true } = {}) {
  aba(h, sid, titulo);
  const tela0 = await chamadoNaTela(h, sid, titulo);
  if (primeira) {
    ligarTg(h);
    await ligarRua(h);
  }
  const a = audioTg(h, { respondeA: tela0 });
  await audioTranscrito(h, tr, a, { ok: true, texto: 'Pode publicar.' });
  await h.p.esperarTelegram(15000);
  await bombear(h.cru);
  assert.equal(h.entregas.at(-1).sessionId, sid, 'a fala foi pra aba');
  abaResponde(h, sid, [h.entregas.at(-1)], { final: FINAL_T23, marcas: DECISAO });
  await h.p.passoEventos();
  assert.equal(chamado(h, sid).versao.estado, 'resposta');
  h.tg.zerar();
  await h.p.esperarTelegram(15000);
  const x = mid(a);
  const [resp] = h.tg.de('enviar').filter((c) => c.args[0].responderA === x);
  assert.ok(resp, `a resposta saiu: ${JSON.stringify(h.tg.chamadas.map((c) => c.metodo))}`);
  const vozes = h.tg.de('enviarVoz');
  return { x, tela: resp.id, voz: vozes[0]?.id ?? null, vozes: vozes.length, chamadoId: chamado(h, sid).versao.chamadoId };
}

// O comando digitado (ou tocado no menu: chega igual, "/voz") ate a linha do sistema sair.
async function comando(h, texto) {
  const u = msgTg(h, texto);
  h.tg.zerar();
  await lerTg(h, [u]);
  await h.p.esperarTelegram(15000);
  return u;
}
const linhas = (h) => JSON.stringify(h.tg.de('enviar').map((c) => [c.args[0].responderA, c.args[0].html]));

// T39 (D3): o /voz e o /modo (tocados no menu ou digitados) abrem a mensagem de ajustes em cima do comando, com o estado
// e o botao do estado ALVO; a troca e o toque nesse botao e a frase sai no balao do toque (responderToque).
// O comando `/<qual>` ate a mensagem de ajustes (1 so, com botoes "a:") em cima dele: {u, id, pedido}
async function abrirAjustes(h, qual) {
  const u = await comando(h, `/${qual}`);
  const env = h.tg.de('enviar').filter((c) => c.args[0].responderA === mid(u) && JSON.stringify(c.args[0].botoes ?? null).includes('"a:'));
  assert.equal(env.length, 1, `/${qual}: 1 mensagem de ajustes em cima do comando: ${linhas(h)}`);
  return { u, id: env[0].id, pedido: env[0].args[0] };
}
// O toque `dados` (a:v1/a:v0, a:mm/a:ml) na mensagem de ajustes `id` (zera as chamadas antes)
async function tocarAjuste(h, dados, id) {
  h.tg.zerar();
  await lerTg(h, [toqueTg(h, dados, id)]);
}
// O /<qual> e o toque `dados` na mensagem de ajustes que ele abriu: {u, id, pedido}
async function ajustar(h, qual, dados) {
  const a = await abrirAjustes(h, qual);
  await tocarAjuste(h, dados, a.id);
  return a;
}
const baloes = (h) => h.tg.de('responderToque').map((c) => c.args[1]);
const balao = (h, frase) => baloes(h).includes(frase);

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
function mudarPedido(h, cod, campos) {
  const p = JSON.parse(fs.readFileSync(arqOk(h, cod), 'utf8'));
  fs.writeFileSync(arqOk(h, cod), JSON.stringify({ ...p, ...campos }, null, 2));
}
const okDe = (h, cod) => estado(h).okTg?.mensagens?.[cod];
const apiTeclado = (botoes) => ({
  inline_keyboard: botoes.map((l) => l.map((b) => ({ text: b.texto, callback_data: b.dados, ...(b.estilo ? { style: b.estilo } : {}) }))),
});
function toqueOk(h, p, acao, messageId) {
  h.nUpd += 1;
  const r = montarOkTg({ ...p, completo: false });
  return {
    update_id: h.nUpd,
    callback_query: {
      id: `q${h.nUpd}`, from: { id: DONO, is_bot: false, first_name: 'Davi' }, chat_instance: '-1',
      data: `k:${p.codigo}:${{ sim: 's', nao: 'n' }[acao]}`,
      message: {
        message_id: messageId, from: { id: BOT, is_bot: true, first_name: 'Bot de Teste' }, chat: { id: DONO, type: 'private', first_name: 'Davi' },
        date: Math.floor(Date.parse(p.criadoEm) / 1000) + 2, text: r.texto, reply_markup: apiTeclado(r.botoes),
      },
    },
  };
}
async function tocar(h, p, acao, messageId) {
  const u = toqueOk(h, p, acao, messageId);
  h.tg.lotes.push([u]);
  await h.p.esperarTelegram(5000);
  await bombear(h.cru);
  return u;
}
const conferida = (u, id, t) => ({ status: 'usado', usadoEm: iso(t), verificadoPor: { canal: 'telegram', updateId: u.update_id, messageId: id, texto: 'Sim', conferidoEm: iso(t) } });

// ---------------------------------------------------------------------------------------------------------------

test('T29a 1. o toque em Desligar voz: a fala em audio depois nao gera voz (o texto sai); o /voz (digitado com o @ do bot) e o toque em Ligar voz ligam e geram de novo; a mensagem de ajustes em cima do comando e a frase no balao do toque; o config.json ganha voz.ligada; nada vai pra aba', async () => {
  const tr = dubleTranscrever();
  const fv = dubleFalar();
  const h = montar({ canalPrincipal: 'telegram', transcrever: tr.fn, falar: fv.fn });
  const r1 = await respostaDeAudio(h, tr);
  assert.equal(r1.vozes, 1, 'ligada (o padrao): a voz sai');
  const entregas = h.entregas.length;
  await ajustar(h, 'voz', 'a:v0');
  assert.ok(balao(h, VOZ_DESLIGADA), JSON.stringify(baloes(h)));
  assert.deepEqual(cfg(h), { telegram: { ligado: true }, voz: { ligada: false } });
  const sinteses = fv.textos.length;
  const r2 = await respostaDeAudio(h, tr, 'S2', 'Ana', { primeira: false });
  assert.equal(r2.vozes, 0, 'desligada: nenhuma voz (o texto saiu)');
  assert.equal(fv.textos.length, sinteses, 'nem a sintese comeca');
  await ajustar(h, 'voz@Teste_ControleBot', 'a:v1');
  assert.ok(balao(h, VOZ_LIGADA), JSON.stringify(baloes(h)));
  assert.deepEqual(cfg(h), { telegram: { ligado: true }, voz: { ligada: true } });
  const r3 = await respostaDeAudio(h, tr, 'S3', 'Bia', { primeira: false });
  assert.equal(r3.vozes, 1, 'ligada de novo: a voz sai');
  assert.equal(h.entregas.length, entregas + 2, 'so as 2 falas em audio foram pras abas (os comandos e os toques nao)');
  assert.ok(logs(h).some((l) => l.endsWith('Telegram: voz pelo botão: desligada (config.json gravado)')), logs(h).join('\n'));
  assert.ok(logs(h).some((l) => l.endsWith('Telegram: voz pelo botão: ligada (config.json gravado)')), logs(h).join('\n'));
});

// T39 (D3): a mensagem de ajustes ja na tela antes da resposta da aba, e o toque em Desligar voz com a voz ja na fila (o
// /voz digitado depois da voz na fila drenaria a voz antes do toque). Como no /voz da T29a, a voz sai na mesma volta do
// esperarTelegram que le o toque (o drenar vem antes da leitura).
test('T29a 2. a voz que ja estava na fila sai mesmo com o toque em Desligar voz depois dela', async () => {
  const tr = dubleTranscrever();
  const fv = dubleFalar();
  const h = montar({ canalPrincipal: 'telegram', transcrever: tr.fn, falar: fv.fn });
  aba(h, 'S1', 'Faro');
  const tela0 = await chamadoNaTela(h, 'S1', 'Faro');
  ligarTg(h);
  await ligarRua(h);
  const a = audioTg(h, { respondeA: tela0 });
  await audioTranscrito(h, tr, a, { ok: true, texto: 'Pode publicar.' });
  await h.p.esperarTelegram(15000);
  await bombear(h.cru);
  const fala = h.entregas.at(-1);
  const aj = await abrirAjustes(h, 'voz');
  assert.equal(fv.textos.length, 0, 'a aba ainda nao respondeu');
  abaResponde(h, 'S1', [fala], { final: FINAL_T23, marcas: DECISAO });
  await h.p.passoEventos();
  assert.equal(fv.textos.length, 1, 'a voz ja esta na fila');
  await tocarAjuste(h, 'a:v0', aj.id);
  for (let i = 0; i < 3; i++) await h.p.esperarTelegram(15000);
  assert.ok(balao(h, VOZ_DESLIGADA), JSON.stringify(baloes(h)));
  assert.equal(h.tg.de('enviarVoz').length, 1, 'a voz da fila saiu');
  assert.equal(h.tg.de('enviarVoz')[0].args[0].responderA, mid(a));
});

test('T29a 3. o toque em Mensagens: usar manter tudo: o toque numa opcao so tira os botoes (a tela, a voz e o audio dele ficam); o toque em Mensagens: usar modo limpo volta: o toque seguinte apaga a tela, a voz e o audio; o config.json ganha telegram.resolvidas', async () => {
  const tr = dubleTranscrever();
  const fv = dubleFalar();
  const h = montar({ canalPrincipal: 'telegram', transcrever: tr.fn, falar: fv.fn });
  const r1 = await respostaDeAudio(h, tr);
  assert.ok(r1.voz);
  await ajustar(h, 'modo', 'a:mm');
  assert.ok(balao(h, MODO_MANTER), JSON.stringify(baloes(h)));
  assert.deepEqual(cfg(h), { telegram: { ligado: true, resolvidas: 'manter' } });
  h.tg.zerar();
  await lerTg(h, [toqueTg(h, `o:${r1.chamadoId}:0`, r1.tela)]);
  await bombear(h.cru);
  for (let i = 0; i < 3; i++) await h.p.esperarTelegram(15000);
  assert.equal(h.entregas.at(-1).texto, 'A) Sim (recomendado)', 'o toque foi pra aba');
  assert.deepEqual(apagadas(h), [], 'no manter nada sai do chat');
  assert.ok(h.tg.de('editarBotoes').some((c) => c.args[0] === r1.tela && c.args[1] === null), 'a tela tocada so perde os botoes');
  await ajustar(h, 'modo', 'a:ml');
  assert.ok(balao(h, MODO_LIMPO), JSON.stringify(baloes(h)));
  assert.deepEqual(cfg(h), { telegram: { ligado: true, resolvidas: 'apagar' } });
  const r2 = await respostaDeAudio(h, tr, 'S2', 'Ana', { primeira: false });
  assert.ok(r2.voz);
  h.tg.zerar();
  await lerTg(h, [toqueTg(h, `o:${r2.chamadoId}:0`, r2.tela)]);
  await bombear(h.cru);
  for (let i = 0; i < 3; i++) await h.p.esperarTelegram(15000);
  const alvo = [r2.tela, r2.voz, r2.x];
  assert.deepEqual(apagadas(h).filter((id) => alvo.includes(id)), alvo, `de volta no limpo: ${JSON.stringify(apagadas(h))}`);
  for (const id of [r1.tela, r1.voz, r1.x]) assert.ok(!apagadas(h).includes(id), `o que ficou no manter continua (${id})`);
});

test('T29a 4. o toque em Mensagens: usar manter tudo: o pedido de OK conferido fecha editado (nenhum apagar); de volta no limpo (o toque em Mensagens: usar modo limpo), o seguinte sai do chat', async () => {
  const h = montar({ config: CFG_OK });
  aba(h, 'S1', 'Faro');
  ligarTg(h);
  const p = pedidoOk(h);
  await h.p.esperarTelegram(15000);
  const id = okDe(h, p.codigo).messageId;
  assert.ok(Number.isSafeInteger(id), 'a mensagem do pedido saiu');
  await ajustar(h, 'modo', 'a:mm');
  assert.ok(balao(h, MODO_MANTER), JSON.stringify(baloes(h)));
  const t1 = await tocar(h, p, 'sim', id);
  h.tg.zerar();
  mudarPedido(h, p.codigo, conferida(t1, id, h.t));
  await h.p.esperarTelegram(15000);
  assert.deepEqual(apagadas(h), [], 'manter: nenhum apagar');
  assert.deepEqual(h.tg.de('editarTexto').map((c) => c.args[0]), [id], 'manter: o fecho editado');
  assert.equal(okDe(h, p.codigo).fim, 'conferido');
  assert.equal(okDe(h, p.codigo).apagada, undefined);
  await ajustar(h, 'modo', 'a:ml');
  assert.ok(balao(h, MODO_LIMPO), JSON.stringify(baloes(h)));
  const p2 = pedidoOk(h, { codigo: 'DEF567' });
  await h.p.esperarTelegram(15000);
  const id2 = okDe(h, 'DEF567').messageId;
  const t2 = await tocar(h, p2, 'sim', id2);
  h.tg.zerar();
  mudarPedido(h, 'DEF567', conferida(t2, id2, h.t));
  await h.p.esperarTelegram(15000);
  assert.ok(apagadas(h).includes(id2), `limpo: o pedido sai do chat: ${JSON.stringify(h.tg.chamadas.map((c) => [c.metodo, c.args[0]]))}`);
  assert.ok(!apagadas(h).includes(id), 'o fechado no manter continua');
  assert.equal(okDe(h, 'DEF567').apagada, true);
});

test('T29a 5. config.json cheio: cada toque (Desligar voz, manter tudo, Ligar voz, modo limpo) le o arquivo, muda so a chave e grava (o resto igual, no formato do instalador); nenhum temporario sobra na pasta', async () => {
  const h = montar({ config: CHEIO });
  ligarTg(h);
  const esperado = structuredClone(CHEIO);
  const passos = [
    ['voz', 'a:v0', VOZ_DESLIGADA, (c) => { c.voz.ligada = false; }],
    ['modo', 'a:mm', MODO_MANTER, (c) => { c.telegram.resolvidas = 'manter'; }],
    ['voz', 'a:v1', VOZ_LIGADA, (c) => { c.voz.ligada = true; }],
    ['modo', 'a:ml', MODO_LIMPO, (c) => { c.telegram.resolvidas = 'apagar'; }],
  ];
  for (const [qual, dados, frase, mudar] of passos) {
    await ajustar(h, qual, dados);
    assert.ok(balao(h, frase), `${dados}: ${JSON.stringify(baloes(h))}`);
    mudar(esperado);
    assert.equal(cfgTexto(h), FORMATO(esperado), dados);
    assert.deepEqual(fs.readdirSync(h.env.SESSOES_WPP_DIR).filter((n) => n.startsWith('config.json')), ['config.json'], `${dados}: nenhum temporario`);
  }
});

test('T29a 6. gravacao que falha (config.json ausente, ilegivel, nao objeto, bloco torto ou o temporario impedido) = o balao de falha no toque, o arquivo igual e nada muda em memoria (o /voz e o /modo seguintes mostram o estado de antes; consertado, o mesmo toque faz a 1a troca)', async () => {
  const BOM = FORMATO({ telegram: { ligado: true } });
  const tmpDe = (h) => `${h.arqCfg}.${process.pid}.tmp`;
  // [qual, o toque, o nome no log, a linha do estado de antes na mensagem de ajustes, a frase da 1a troca]
  const VOZ = ['voz', 'a:v0', 'voz', 'Resposta por voz: ligada.', VOZ_DESLIGADA];
  const MODO = ['modo', 'a:mm', 'mensagens', 'Mensagens: modo limpo.', MODO_MANTER];
  const casos = [
    ['ausente', null, null, [VOZ, MODO]],
    ['ilegivel', '{"telegram": {"ligado": true', null, [VOZ, MODO]],
    ['nao objeto', '[1, 2]\n', null, [VOZ, MODO]],
    ['voz torta', FORMATO({ telegram: { ligado: true }, voz: 'desligada' }), null, [VOZ]],
    ['telegram torto', FORMATO({ telegram: ['ligado'] }), null, [MODO]],
    ['temporario impedido', BOM, (h) => fs.mkdirSync(tmpDe(h)), [VOZ, MODO]],
  ];
  for (const [rotulo, conteudo, preparar, ajustes] of casos) {
    const h = montar({ config: conteudo });
    ligarTg(h);
    if (preparar) preparar(h);
    const antes = conteudo === null ? null : cfgTexto(h);
    for (const [qual, dados, nomeLog] of ajustes) {
      await ajustar(h, qual, dados);
      assert.deepEqual(baloes(h), [FALHA], `${rotulo} ${dados}`);
      assert.equal(fs.existsSync(h.arqCfg) ? cfgTexto(h) : null, antes, `${rotulo} ${dados}: o arquivo igual`);
      assert.ok(logs(h).some((l) => l.includes(`Telegram: ${nomeLog}: o config.json nao foi gravado (`)), `${rotulo}: ${logs(h).join('\n')}`);
    }
    if (fs.existsSync(tmpDe(h))) fs.rmdirSync(tmpDe(h));
    fs.writeFileSync(h.arqCfg, BOM);
    for (const [qual, dados, , estadoAntes, frase] of ajustes) {
      const a = await ajustar(h, qual, dados);
      assert.ok(String(a.pedido.html).includes(estadoAntes), `${rotulo} /${qual}: a memoria igual: ${a.pedido.html}`);
      assert.ok(balao(h, frase), `${rotulo} ${dados} consertado: ${JSON.stringify(baloes(h))}`);
    }
  }
});

test('T29a 7. subida com voz.ligada false (vozTg false) = desligada: a fala em audio nao gera voz, o /voz mostra desligada com o Ligar voz e o toque liga; rodar (fonte): o vozTg sai do vozLigadaDoConfig do mesmo config, junto do telegram.voz da T17b', async () => {
  const tr = dubleTranscrever();
  const fv = dubleFalar();
  const h = montar({ config: { telegram: { ligado: true }, voz: { ligada: false } }, vozTg: false, canalPrincipal: 'telegram', transcrever: tr.fn, falar: fv.fn });
  const r1 = await respostaDeAudio(h, tr);
  assert.equal(r1.vozes, 0, 'desligada desde a subida');
  const a = await ajustar(h, 'voz', 'a:v1');
  assert.ok(String(a.pedido.html).includes('Resposta por voz: desligada.'), a.pedido.html);
  assert.deepEqual(a.pedido.botoes, [[{ texto: 'Ligar voz', dados: 'a:v1' }]]);
  assert.ok(balao(h, VOZ_LIGADA), JSON.stringify(baloes(h)));
  assert.deepEqual(cfg(h), { telegram: { ligado: true }, voz: { ligada: true } });

  const fonte = fs.readFileSync(path.join(REPO, 'porteiro.mjs'), 'utf8');
  const ini = fonte.indexOf('async function rodar(');
  const fim = fonte.slice(ini + 1).search(/\n(?:async )?function /);
  const rodar = fim === -1 ? fonte.slice(ini) : fonte.slice(ini, ini + 1 + fim);
  const inicio = rodar.indexOf('criarPorteiro({');
  const chamada = rodar.slice(inicio, rodar.indexOf('});', inicio));
  const esperada = 'vozTg: vozLigadaDoConfig(cfg).ligada && configTg.voz !== false,';
  assert.ok(chamada.includes(esperada), esperada);
  assert.equal(chamada.split('vozTg:').length, 2, '1 vez so');
  assert.ok(rodar.indexOf('const cfg = lerConfig(C.estadoDir);') < inicio, 'o mesmo config lido antes');
});

test('T29a 8. menu: os 5 itens na ordem do dono (T39: painel, central, rua, modo, voz) e a subida manda a lista nova (setMyCommands pelo definirComandos)', async () => {
  assert.deepEqual(COMANDOS_TG, MENU_5);
  const menus = [];
  const tg = {
    quemSou: async () => ({ ok: true, id: BOT, username: 'Teste_ControleBot' }),
    definirComandos: async (c) => { menus.push(c); return { ok: true }; },
  };
  const r = await ligarTelegram({ config: { ligado: true }, token: `${BOT}:falso`, ident: { chatId: DONO, botId: BOT }, criarTelegram: () => tg });
  assert.equal(r, tg, 'ligado');
  assert.deepEqual(menus, [MENU_5], 'a lista nova vai pro Telegram na subida');
});
