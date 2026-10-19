// Testes da T23c (PLANO-TELEGRAM.md, "T23", bloco "Contrato": modo `apagar` itens 1 e 7, modo `manter` item 3 e "Config
// e instalacao"): o porteiro passa o modo das mensagens resolvidas (telegram.resolvidas) ao canal e usa no fecho do pedido
// de OK, a resposta em voz guarda o `citar` (a fala dele em cima da qual saiu), o lerConfigTelegram, o rodar e o
// instalador. O canal do modo `apagar` e da T23a (tests/canal-telegram.test.mjs); aqui so a ponta a ponta pelo porteiro.
// Nada de rede, porteiro real, ok-wpp real nem script .vbs/.ps1: duble do Telegram (1 contador de message_id, como o chat
// de verdade), do mensageiro, do transcrever e da voz; o instalar.mjs pela funcao executar com pastas temporarias.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { criarPorteiro, lerConfigTelegram } from '../porteiro.mjs';
import { executar } from '../instalar.mjs';
import { montarOkTg } from '../lib/ok-tg.mjs';
import { montarRecado } from '../mensageiro.mjs';
import { NUMERO_DONO } from './lib/dados-whatsapp.mjs';
import { CENTRAL_TESTE, RAIZES_TESTE } from './lib/dados-central.mjs';
import { criarCanalTelegram } from '../canal-telegram.mjs';

const require = createRequire(import.meta.url);
const lib = require('../hooks/lib/sessoes-wpp.js');
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-14T15:00:00Z'); // 12:00 em Brasilia
const iso = (ms) => new Date(ms).toISOString();
const DONO = 700100200;
const BOT = 700900800;
const ACAO = 'subir o site X em produção';
const OK_NOS_BOTOES = 'O pedido de OK se responde nos botões Sim e Não da mensagem dele.';
// Resposta da aba com opcoes (a linha do dono em cima; o falar recebe sem ela)
const FINAL_T23 = '> Telegram do Davi (12:00): «Pode publicar.»\n\nPubliquei o site.\n\n---\n🔴 **DECISÃO:** Sigo pro próximo? A) Sim (recomendado) / B) Não';
const DECISAO = { decisao: true, fica: false, pergunta: false };
const LOG_TORTO = 'Telegram: telegram.resolvidas fora de "apagar"/"manter" no config.json; fica no modo manter (nada se apaga)';

// ---------- harness (copia do tests/porteiro-telegram.test.mjs e do tests/porteiro-ok-tg.test.mjs) ----------

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
  tg.enviarVoz = criar('enviarVoz'); // T17b: a resposta em voz (sendVoice)
  tg.enviarTexto = criar('enviarTexto'); // T7b2a: o pedido de OK
  tg.editar = async (messageId, pedido) => { gravar('editar', [messageId, pedido]); return { ok: true }; };
  tg.editarTexto = async (messageId, pedido) => { gravar('editarTexto', [messageId, pedido]); return { ok: true }; };
  tg.editarBotoes = async (messageId, botoes) => { gravar('editarBotoes', [messageId, botoes]); return { ok: true }; };
  tg.apagar = async (messageId) => { gravar('apagar', [messageId]); return { ok: true }; };
  tg.responderToque = async (id, texto) => { gravar('responderToque', [id, texto]); return { ok: true }; };
  // T4a: baixar grava um arquivo falso no destino + a extensao (tg.ext[fileId]); nenhuma rede
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

// `ok` = config.json com telegram.ligado e telegram.ok.ligado (o OK pelo botao); `resolvidasTg` so entra se vier.
function montar({ ok = false, resolvidasTg, transcrever, falar, canalPrincipal } = {}) {
  const raiz = pastaTemp('t23c-');
  const env = {
    SESSOES_WPP_DIR: path.join(raiz, 'estado'),
    CLAUDE_SESSIONS_DIR: path.join(raiz, 'sessions'),
    CLAUDE_PROJECTS_DIR: path.join(raiz, 'projects'),
    SESSOES_WPP_LOG: path.join(raiz, 'porteiro.log'),
  };
  for (const d of [env.SESSOES_WPP_DIR, env.CLAUDE_SESSIONS_DIR, env.CLAUDE_PROJECTS_DIR]) fs.mkdirSync(d, { recursive: true });
  if (ok) fs.writeFileSync(path.join(env.SESSOES_WPP_DIR, 'config.json'), JSON.stringify({ telegram: { ligado: true, ok: { ligado: true, naAba: false } } }));
  const h = { raiz, env, t: T0, idle: 0, grupo: [], enviados: [], entregas: [], nReg: 0, nUpd: 100, nMid: 7000, nAux: 0 };
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
  if (transcrever) h.opcoes.transcrever = transcrever; // T4a: duble (nunca o python de verdade)
  if (falar) h.opcoes.falar = falar; // T17b: a voz duble (nunca a Microsoft)
  if (resolvidasTg !== undefined) h.opcoes.resolvidasTg = resolvidasTg;
  h.cru = criarPorteiro(h.opcoes);
  h.p = comBomba(h.cru);
  h.t += 1000; // o que o teste cria nasce depois do estado novo
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

// Mensagem do dono no chat do Bot de Teste (como o getUpdates devolve).
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
// Toque num botao de chamado (dados do formato-tg).
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

// Duble do transcrever: cada chamada guarda o arquivo e a funcao que resolve a promessa (o teste decide quando).
function dubleTranscrever() {
  const d = { chamadas: [], resolver: [] };
  d.fn = (arquivo) => new Promise((ok) => { d.chamadas.push(arquivo); d.resolver.push(ok); });
  return d;
}
// Duble do falar (nunca a Microsoft): Buffer na hora.
function dubleFalar() {
  const d = { textos: [] };
  d.fn = (texto) => {
    d.textos.push(texto);
    return Promise.resolve(Buffer.from(`ogg ${d.textos.length}`));
  };
  return d;
}
// Audio do dono ate a transcricao aplicada (duble do transcrever resolvido com `resposta`).
async function audioTranscrito(h, tr, a, resposta) {
  await lerTg(h, [a]);
  await h.cru.passoAudioTg();
  await tique();
  tr.resolver.at(-1)(resposta);
  await tique();
  await h.cru.passoAudioTg();
}

// Chamado de uma aba ja na tela (montado com um canal auxiliar sobre o estado do disco); devolve o message_id.
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
// Recado como chega no transcript da aba (formato medido 27/09).
function peer(pedido, ts) {
  const texto = `Another Claude session sent a message (from repos-99):\n<cross-session-message from="repos-99">\n${montarRecado(pedido)}\n</cross-session-message>`;
  return { type: 'user', isMeta: true, origin: { kind: 'peer', from: 'repos-99' }, timestamp: ts, message: { role: 'user', content: texto } };
}
// Recado de cada pedido no transcript da aba + o parou dela 1 min depois.
function abaResponde(h, sid, pedidos, o = {}) {
  transcript(h, sid, pedidos.map((p, i) => peer(p, iso(h.t + 1000 * (i + 1)))));
  h.t += MIN;
  evento(h, parou(h, sid, o));
}

// Audio X dele em cima do chamado da Faro -> a aba responde com opcoes -> a resposta em texto e a voz saem, as duas em
// cima de X. Devolve {x, tela, voz, chamadoId}.
async function respostaComVoz(h, tr) {
  aba(h, 'S1', 'Faro');
  const tela0 = await chamadoNaTela(h, 'S1', 'Faro');
  ligarTg(h);
  await ligarRua(h);
  const a = audioTg(h, { respondeA: tela0 });
  await audioTranscrito(h, tr, a, { ok: true, texto: 'Pode publicar.' });
  await h.p.esperarTelegram(15000);
  await bombear(h.cru);
  abaResponde(h, 'S1', [h.entregas.at(-1)], { final: FINAL_T23, marcas: DECISAO });
  await h.p.passoEventos();
  assert.equal(chamado(h, 'S1').versao.estado, 'resposta');
  h.tg.zerar();
  await h.p.esperarTelegram(15000);
  const x = mid(a);
  const [resp] = h.tg.de('enviar').filter((c) => c.args[0].responderA === x);
  const [voz] = h.tg.de('enviarVoz');
  assert.ok(resp && voz, `a resposta e a voz sairam: ${JSON.stringify(h.tg.chamadas.map((c) => c.metodo))}`);
  assert.equal(voz.args[0].responderA, x, 'a voz em cima de X');
  const c = chamado(h, 'S1');
  assert.equal(c.mensagem.messageId, resp.id, 'a tela da resposta');
  return { x, tela: resp.id, voz: voz.id, chamadoId: c.versao.chamadoId };
}

// Pedido de OK como o ok-wpp grava (oks/<COD>.json, com o titulo que remonta a mensagem).
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
// Toque no botao do pedido de OK, como o getUpdates devolve (a mensagem tocada com o texto e o teclado do pedido).
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
// Sim (ou Nao) tocado na mensagem do pedido, com o recado entregue; devolve o update.
async function tocar(h, p, acao, messageId) {
  const u = toqueOk(h, p, acao, messageId);
  h.tg.lotes.push([u]);
  await h.p.esperarTelegram(5000);
  await bombear(h.cru);
  return u;
}
// Aba S1 "Faro", Telegram com o historico pulado, 1 pedido de OK e a mensagem dele ja no chat.
async function comPedidoNoChat(h) {
  aba(h, 'S1', 'Faro');
  ligarTg(h);
  const p = pedidoOk(h);
  await h.p.esperarTelegram(15000);
  const m = okDe(h, p.codigo);
  assert.ok(m && Number.isSafeInteger(m.messageId), 'a mensagem do pedido saiu');
  h.tg.zerar();
  return { p, id: m.messageId };
}
const conferida = (u, id, t) => ({ status: 'usado', usadoEm: iso(t), verificadoPor: { canal: 'telegram', updateId: u.update_id, messageId: id, texto: 'Sim', conferidoEm: iso(t) } });
const cancelada = (u, id, t) => ({ status: 'recusado', decididoEm: iso(t), verificadoPor: { canal: 'telegram', updateId: u.update_id, messageId: id, texto: 'Não', conferidoEm: iso(t) } });

// O instalar.mjs com a pasta de estado, a do Claude e a do Inicializar temporarias.
function ambienteDoInstalador() {
  const base = pastaTemp('t23c-instalar-');
  const estadoDir = path.join(base, 'estado');
  const claudeDir = path.join(base, 'claude');
  const inicio = path.join(base, 'inicio');
  for (const p of [estadoDir, claudeDir, inicio]) fs.mkdirSync(p, { recursive: true });
  return { estado: estadoDir, env: { SESSOES_WPP_DIR: estadoDir, SESSOES_WPP_CLAUDE_DIR: claudeDir, SESSOES_WPP_STARTUP_DIR: inicio } };
}
const cfgDe = (a) => JSON.parse(fs.readFileSync(path.join(a.estado, 'config.json'), 'utf8'));

// ---------------------------------------------------------------------------------------------------------------

test('T23c 1. modo padrao, ponta a ponta: audio X do dono -> a resposta da aba e a voz em cima de X (o registro da voz guarda citar X) -> toque numa opcao da resposta -> apagar(tela), apagar(voz), apagar(X), nessa ordem', async () => {
  const tr = dubleTranscrever();
  const fv = dubleFalar();
  const h = montar({ canalPrincipal: 'telegram', transcrever: tr.fn, falar: fv.fn });
  const { x, tela, voz, chamadoId } = await respostaComVoz(h, tr);
  const e = estado(h);
  assert.equal(e.tg.mensagens[voz].voz, true);
  assert.equal(e.tg.mensagens[voz].citar, x, 'o vozEnviada recebeu o citar da voz (a fala X)');
  assert.ok(e.tg.idsDoDono.includes(x), 'X no anel das mensagens do dono');
  h.tg.zerar();
  await lerTg(h, [toqueTg(h, `o:${chamadoId}:0`, tela)]);
  await bombear(h.cru);
  for (let i = 0; i < 3; i++) await h.p.esperarTelegram(15000);
  assert.deepEqual(apagadas(h), [tela, voz, x], 'a tela tocada, a voz e o audio dele, nessa ordem e 1 vez cada');
  assert.equal(estado(h).tg.mensagens[voz], undefined, 'a voz sai do registro');
  assert.equal(h.entregas.at(-1).texto, 'A) Sim (recomendado)', 'o toque foi pra aba');
});

// T30 (Eric 18/10/2026 19:43): so o "sim"/"nao" em cima do pedido vira a linha dos botoes (o resto vai pra aba) e a fala
// recusada (que nao chegou a aba nenhuma) FICA no chat quando a linha troca: o "texto dele sai" deste teste virou "fica".
test('T23c 2 (T30). modo padrao: "sim" do dono em cima do pedido de OK -> a linha okNosBotoes em cima dele; trocada pela versao nova do sistema -> a linha antiga sai e o "sim" dele FICA (nao chegou a aba nenhuma); o pedido de OK e a fala nova ficam', async () => {
  const h = montar({ ok: true });
  const { id } = await comPedidoNoChat(h);
  const y = msgTg(h, 'sim', { respondeA: id });
  await lerTg(h, [y]);
  const [linha1] = h.tg.de('enviar');
  assert.ok(linha1 && linha1.args[0].html.includes(OK_NOS_BOTOES), JSON.stringify(h.tg.chamadas.map((c) => c.metodo)));
  assert.equal(linha1.args[0].responderA, mid(y), 'a linha em cima do texto dele');
  assert.deepEqual(apagadas(h), [], 'nada sai ainda');
  h.tg.zerar();
  const z = msgTg(h, 'n', { respondeA: id });
  await lerTg(h, [z]);
  await h.p.esperarTelegram(15000);
  const [linha2] = h.tg.de('enviar');
  assert.ok(linha2 && linha2.args[0].html.includes(OK_NOS_BOTOES));
  assert.equal(linha2.args[0].responderA, mid(z), 'a versao nova em cima da fala nova');
  assert.deepEqual(apagadas(h), [linha1.id], 'a linha antiga sai; o "sim" dele fica (T30)');
  assert.ok(!logs(h).some((l) => l.endsWith(`mensagem ${mid(y)} do dono apagada (conversa resolvida)`)), logs(h).join('\n'));
  assert.equal(okDe(h, 'ABC234').fechadoEm ?? null, null, 'o pedido de OK segue aberto no chat');
});

test('T23c 3. resolvidasTg "manter": toque com voz e X = a voz e X ficam no chat; pedido de OK conferido, cancelado ou com o Nao vencido = o fecho editado (editarTexto), nenhum apagar das mensagens do OK', async () => {
  const tr = dubleTranscrever();
  const fv = dubleFalar();
  const h = montar({ canalPrincipal: 'telegram', transcrever: tr.fn, falar: fv.fn, resolvidasTg: 'manter' });
  const { x, tela, voz, chamadoId } = await respostaComVoz(h, tr);
  assert.equal(estado(h).tg.mensagens[voz].citar, x, 'a voz guarda o citar nos 2 modos');
  h.tg.zerar();
  await lerTg(h, [toqueTg(h, `o:${chamadoId}:0`, tela)]);
  await bombear(h.cru);
  for (let i = 0; i < 3; i++) await h.p.esperarTelegram(15000);
  assert.equal(h.entregas.at(-1).texto, 'A) Sim (recomendado)', 'o toque foi pra aba');
  assert.ok(!apagadas(h).includes(voz), `a voz fica: ${JSON.stringify(apagadas(h))}`);
  assert.ok(!apagadas(h).includes(x), `o audio dele fica: ${JSON.stringify(apagadas(h))}`);
  assert.equal(estado(h).tg.mensagens[voz].voz, true, 'o registro da voz fica');

  const casos = [
    ['conferido', 'sim', (k, u, id) => mudarPedido(k, 'ABC234', conferida(u, id, k.t)), /A aba conferiu às/],
    ['cancelado', 'nao', (k, u, id) => mudarPedido(k, 'ABC234', cancelada(u, id, k.t)), /Pedido cancelado\./],
    ['expirou', 'nao', (k, u, id, p) => { k.t = Date.parse(p.expiraEm) + 1000; }, /Pedido cancelado\./],
  ];
  for (const [fim, acao, decidir, frase] of casos) {
    const k = montar({ ok: true, resolvidasTg: 'manter' });
    const { p, id } = await comPedidoNoChat(k);
    const u = await tocar(k, p, acao, id);
    k.tg.zerar();
    decidir(k, u, id, p);
    await k.p.esperarTelegram(15000);
    assert.deepEqual(apagadas(k), [], `${fim}: nenhum apagar`);
    const ed = k.tg.de('editarTexto');
    assert.deepEqual(ed.map((c) => c.args[0]), [id], `${fim}: 1 fecho editado na mensagem do pedido`);
    assert.match(ed[0].args[1].texto, frase, fim);
    const m = okDe(k, 'ABC234');
    assert.ok(Number.isFinite(Date.parse(m.fechadoEm)), `${fim}: fechadoEm`);
    assert.equal(m.fim, fim);
    assert.equal(m.apagada, undefined, `${fim}: nunca "apagada"`);
    assert.ok(logs(k).some((l) => l.endsWith(`Telegram: pedido de OK ABC234 fechado no chat (${fim})`)), logs(k).join('\n'));
    k.tg.zerar();
    await k.p.esperarTelegram(15000);
    assert.deepEqual(k.tg.de('editarTexto').concat(k.tg.de('apagar')), [], `${fim}: so 1 vez`);
  }
});

test('T23c 4. lerConfigTelegram: telegram.resolvidas ausente ou "apagar" = o retorno de antes (sem o campo); "manter" e qualquer valor torto = resolvidas "manter"; o resto do retorno igual', () => {
  const dir = pastaTemp('t23c-cfg-');
  const cfg = (x) => fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(x));
  const BASE = { canalPrincipal: 'telegram', ligado: true };
  cfg({ telegram: { ligado: true } });
  assert.deepEqual(lerConfigTelegram(dir), BASE, 'ausente');
  cfg({ telegram: { ligado: true, resolvidas: 'apagar' } });
  assert.deepEqual(lerConfigTelegram(dir), BASE, '"apagar"');
  cfg({ telegram: { ligado: true, resolvidas: 'manter' } });
  assert.deepEqual(lerConfigTelegram(dir), { ...BASE, resolvidas: 'manter' }, '"manter"');
  for (const torto of ['APAGAR', 'Manter', 'tudo', '', ' apagar', true, false, null, 0, 1, {}, [], ['apagar'], { modo: 'apagar' }]) {
    cfg({ telegram: { ligado: true, resolvidas: torto } });
    assert.deepEqual(lerConfigTelegram(dir), { ...BASE, resolvidas: 'manter' }, JSON.stringify(torto));
  }
  // o resto do retorno (canalPrincipal, ligado, sonda, voz) nao muda com o campo
  const resto = { canalPrincipal: 'whatsapp', ligado: false, sonda: true, voz: false };
  cfg({ canalPrincipal: 'whatsapp', telegram: { ligado: false, sonda: true, voz: false, resolvidas: 'tudo' } });
  assert.deepEqual(lerConfigTelegram(dir), { ...resto, resolvidas: 'manter' });
  cfg({ canalPrincipal: 'whatsapp', telegram: { ligado: false, sonda: true, voz: false, resolvidas: 'apagar' } });
  assert.deepEqual(lerConfigTelegram(dir), resto);
});

test('T23c 5. rodar (fonte): o criarPorteiro recebe resolvidasTg do configTg (so "manter" vira manter; o resto = apagar), junto do sondaTg; o telegram.resolvidas torto do mesmo config = 1 linha de log antes do subiu', () => {
  const fonte = fs.readFileSync(path.join(REPO, 'porteiro.mjs'), 'utf8');
  // so o corpo do rodar (ate a proxima funcao do topo do arquivo): o esperando, depois dele no arquivo, tambem le o config (A4a)
  const ini = fonte.indexOf('async function rodar(');
  const fim = fonte.slice(ini + 1).search(/\n(?:async )?function /);
  const rodar = fim === -1 ? fonte.slice(ini) : fonte.slice(ini, ini + 1 + fim);
  assert.equal(rodar.match(/\blerConfig\(/g)?.length, 1, 'o config lido 1 vez');
  const inicio = rodar.indexOf('criarPorteiro({');
  const chamada = rodar.slice(inicio, rodar.indexOf('});', inicio));
  const linha = "resolvidasTg: configTg.resolvidas === 'manter' ? 'manter' : 'apagar',";
  assert.ok(chamada.includes(linha), linha);
  assert.equal(chamada.split('resolvidasTg:').length, 2, '1 vez so');
  const sonda = chamada.indexOf('sondaTg: configTg.sonda === true,');
  assert.ok(sonda > 0 && chamada.indexOf(linha) > sonda, 'junto do sondaTg');
  assert.equal(chamada.slice(sonda, chamada.indexOf(linha)).split('\n').length, 2, 'na linha logo depois da do sondaTg');
  const logEm = rodar.indexOf(`log('${LOG_TORTO}');`);
  assert.ok(logEm > rodar.indexOf('const cfg = lerConfig(C.estadoDir);'), 'o log depois do config lido');
  assert.ok(logEm > 0 && logEm < rodar.indexOf('log(`subiu (pid'), 'antes do subiu');
  const antes = rodar.slice(rodar.lastIndexOf('\n  const ', logEm), logEm);
  assert.match(antes, /cfg\.telegram\?\.resolvidas/, 'o valor do mesmo config');
  assert.match(antes, /!== undefined && \w+ !== 'apagar' && \w+ !== 'manter'/, 'so com o campo presente e fora dos 2');
});

test('T23c 6. criarPorteiro: resolvidasTg fora de "apagar"/"manter" com o Telegram = TypeError (o do canal sobe); "apagar", "manter" e ausente valem; ausente = o modo padrao (o OK conferido sai do chat)', async () => {
  const g = montar({ ok: true });
  for (const v of ['x', 'APAGAR', '', null, 0, true, {}]) {
    assert.throws(() => criarPorteiro({ ...g.opcoes, resolvidasTg: v }), TypeError, JSON.stringify(v));
  }
  for (const v of ['apagar', 'manter', undefined]) criarPorteiro({ ...g.opcoes, resolvidasTg: v });

  const h = montar({ ok: true });
  const { p, id } = await comPedidoNoChat(h);
  const u = await tocar(h, p, 'sim', id);
  h.tg.zerar();
  mudarPedido(h, 'ABC234', conferida(u, id, h.t));
  await h.p.esperarTelegram(15000);
  assert.deepEqual(apagadas(h), [id], 'o padrao e o apagar: a mensagem do pedido sai');
  assert.deepEqual(h.tg.de('editarTexto'), [], 'nenhum fecho editado');
  assert.deepEqual([okDe(h, 'ABC234').fim, okDe(h, 'ABC234').apagada], ['conferido', true]);
});

test('T23c 7. instalar.mjs config: telegram.resolvidas "manter" grava; outro valor = erro de uso (codigo 2) e nada gravado; trocar "apagar" -> "manter" so com --trocar (sem ele = conflito, fica o gravado)', async () => {
  const a = ambienteDoInstalador();
  const r = await executar(['config', '--dados', '{"telegram":{"resolvidas":"manter"}}'], { env: a.env });
  assert.equal(r.codigo, 0, JSON.stringify(r.saida));
  assert.deepEqual(cfgDe(a), { telegram: { resolvidas: 'manter' } });
  for (const v of ['tudo', 'APAGAR', 'Manter', '', true, null, 1, {}, ['apagar']]) {
    const b = ambienteDoInstalador();
    const r2 = await executar(['config', '--dados', JSON.stringify({ telegram: { chatId: 7, resolvidas: v } })], { env: b.env });
    assert.equal(r2.codigo, 2, JSON.stringify(v));
    assert.equal(r2.saida.erro, 'telegram.resolvidas tem que ser "apagar" ou "manter"', JSON.stringify(v));
    assert.equal(fs.existsSync(path.join(b.estado, 'config.json')), false, `nada gravado: ${JSON.stringify(v)}`);
  }
  const c = ambienteDoInstalador();
  fs.writeFileSync(path.join(c.estado, 'config.json'), JSON.stringify({ telegram: { chatId: 42, resolvidas: 'apagar' } }));
  const sem = await executar(['config', '--dados', '{"telegram":{"resolvidas":"manter"}}'], { env: c.env });
  assert.equal(sem.codigo, 0, JSON.stringify(sem.saida));
  assert.deepEqual(sem.saida.conflitos.map((x) => x.caminho), ['telegram.resolvidas']);
  assert.deepEqual(cfgDe(c), { telegram: { chatId: 42, resolvidas: 'apagar' } }, 'sem --trocar fica o gravado');
  const com = await executar(['config', '--dados', '{"telegram":{"resolvidas":"manter"}}', '--trocar'], { env: c.env });
  assert.equal(com.codigo, 0, JSON.stringify(com.saida));
  assert.deepEqual(com.saida.trocadas, ['telegram.resolvidas']);
  assert.deepEqual(cfgDe(c), { telegram: { chatId: 42, resolvidas: 'manter' } });
});

// Integracao da T23b com a T23c (principal, 14/10/2026): o teste do porteiro que depende das 2 (o canal da T23b com o
// modo que o porteiro da T23c repassa).
test('T23 8 (integracao). resolvidasTg "manter": toque numa opcao da resposta = a tela tocada so perde os botoes (editarBotoes null; o registro com fica: true); nada sai do chat, nem a voz nem o audio dele', async () => {
  const tr = dubleTranscrever();
  const fv = dubleFalar();
  const h = montar({ canalPrincipal: 'telegram', transcrever: tr.fn, falar: fv.fn, resolvidasTg: 'manter' });
  const { x, tela, voz, chamadoId } = await respostaComVoz(h, tr);
  h.tg.zerar();
  await lerTg(h, [toqueTg(h, `o:${chamadoId}:0`, tela)]);
  await bombear(h.cru);
  for (let i = 0; i < 3; i++) await h.p.esperarTelegram(15000);
  assert.equal(h.entregas.at(-1).texto, 'A) Sim (recomendado)', 'o toque foi pra aba');
  assert.deepEqual(apagadas(h), [], 'nenhum apagar');
  assert.deepEqual(h.tg.de('editarBotoes').map((c) => c.args), [[tela, null]], 'a tela tocada so perde os botoes');
  const e = estado(h);
  assert.equal(e.tg.mensagens[tela].fica, true, 'a tela fica no chat');
  assert.equal(e.tg.mensagens[voz].voz, true, 'o registro da voz fica');
  assert.ok(e.tg.idsDoDono.includes(x), 'o audio dele segue no anel');
  assert.ok(logs(h).some((l) => l.endsWith(`mensagem ${tela} fica no chat sem os botoes (modo manter)`)), logs(h).join('\n'));
});
