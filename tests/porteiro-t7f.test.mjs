// Testes da T7f (PLANO-T7.md, "T7f: no Telegram, só o resultado"; decisao F8 do principal sobre um pedido do dono (caso
// real): "eu só quero direto o resultado que eu pedi. Ou seja, essa primeira mensagem que você me mandou, ela
// não deveria vir."). Testes 93 a 98:
// - 93: a fala do dono nao gera mensagem nova (enviando e entregue so no estado); o chamado respondido, na tela com
//   botoes, perde os botoes numa edicao (sem notificar); sem chamado na tela, nada.
// - 94: o resultado (resposta da aba) sai como hoje: mensagem nova com notificacao, em cima da fala dele.
// - 95: a resposta da central que so repassou (pedido ou entrega `encaminhado: true` com id `<id>-E<n>`) e nao precisa
//   do dono nao vai pro Telegram; o chamado dela encerra calado (a mensagem dela na tela e apagada: e do bot).
// - 96: a resposta da central que precisa do dono sai como hoje.
// - 97: o problema continua saindo (mensagem nova com notificacao, em cima da fala dele) e a linha do sistema da central
//   travada (T7a1) tambem.
// - 98: WhatsApp byte a byte (F7) e o ensaio do canal registra igual ao real.
// - Revisao adversarial (03/10/2026), no fim do arquivo: 94b, 95e a 95j, 93c, 93d e 97c.
// Isolamento: pastas temporarias via SESSOES_WPP_DIR, CLAUDE_SESSIONS_DIR, CLAUDE_PROJECTS_DIR e SESSOES_WPP_LOG (nunca o
// ~/.claude real). Nenhuma rede: o `tg` e um duble com os metodos do criarTelegram (inclusive o editarBotoes, que tira os
// botoes de uma mensagem sem mexer no texto). Relogio e `dormir` falsos. Harness copiado do tests/porteiro-telegram.test.mjs.
// Rodar: node --test --test-reporter=tap "tests/porteiro-t7f.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { criarPorteiro } from '../porteiro.mjs';
import { NUMERO_DONO } from './lib/dados-whatsapp.mjs';
import { CENTRAL_TESTE, RAIZES_TESTE } from './lib/dados-central.mjs';
import { montarRecado } from '../mensageiro.mjs';
import { criarCanalTelegram, tgNovo } from '../canal-telegram.mjs';

const require = createRequire(import.meta.url);
const lib = require('../hooks/lib/sessoes-wpp.js');

const MIN = 60 * 1000;
const T0 = Date.parse('2026-09-29T15:00:00Z'); // 12:00 em Brasilia
const iso = (ms) => new Date(ms).toISOString();
const DONO = 700100200;
const BOT = 700900800;

const FINAL = [
  'Terminei a revisão.',
  '',
  '---',
  '🔴 **DECISÃO:** Publico? A) Sim, tudo hoje (recomendado) / B) Só as correções',
].join('\n');

// ---------- harness (copia do tests/porteiro-telegram.test.mjs; o duble ganha o editarBotoes) ----------

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

// Duble do criarTelegram. enviar devolve 900 + n. editarBotoes grava [messageId, botoes].
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
  tg.editar = async (messageId, pedido) => { gravar('editar', [messageId, pedido]); return { ok: true }; };
  tg.editarBotoes = async (messageId, botoes) => { gravar('editarBotoes', [messageId, botoes]); return { ok: true }; };
  tg.apagar = async (messageId) => { gravar('apagar', [messageId]); return { ok: true }; };
  tg.responderToque = async (id, texto) => { gravar('responderToque', [id, texto]); return { ok: true }; };
  tg.baixar = async (fileId, destino) => {
    gravar('baixar', [fileId, destino]);
    const caminho = `${destino}.bin`;
    fs.mkdirSync(path.dirname(caminho), { recursive: true });
    fs.writeFileSync(caminho, `falso ${fileId}`);
    return { ok: true, caminho, bytes: 6 };
  };
  tg.quemSou = async () => { gravar('quemSou', []); return { ok: true, id: BOT, username: 'Teste_ControleBot' }; };
  tg.definirComandos = async (c) => { gravar('definirComandos', [c]); return { ok: true }; };
  tg.de = (metodo) => tg.chamadas.filter((c) => c.metodo === metodo);
  // tela: enviar -> ['enviar', silencioso]; editar/editarBotoes/apagar -> [metodo, messageId]
  tg.tela = () => tg.chamadas.filter((c) => ['enviar', 'editar', 'editarBotoes', 'apagar'].includes(c.metodo))
    .map((c) => (c.metodo === 'enviar' ? ['enviar', c.args[0].silencioso] : [c.metodo, c.args[0]]));
  tg.zerar = () => { tg.chamadas.length = 0; };
  return tg;
}

function montar({ tg: comTg = true, respostasEntrega = [], canalPrincipal } = {}) {
  const raiz = pastaTemp('porteiro-t7f-');
  const env = {
    SESSOES_WPP_DIR: path.join(raiz, 'estado'),
    CLAUDE_SESSIONS_DIR: path.join(raiz, 'sessions'),
    CLAUDE_PROJECTS_DIR: path.join(raiz, 'projects'),
    SESSOES_WPP_LOG: path.join(raiz, 'porteiro.log'),
  };
  for (const d of [env.SESSOES_WPP_DIR, env.CLAUDE_SESSIONS_DIR, env.CLAUDE_PROJECTS_DIR]) fs.mkdirSync(d, { recursive: true });
  const h = {
    raiz, env, t: T0, idle: 0, grupo: [], enviados: [], reacoes: [], entregas: [], nReg: 0, nMsg: 0, nUpd: 100, nMid: 7000,
    aberturas: 0, dormidas: [], nAux: 0, randAux: randFixo(), edicoes: [],
  };
  h.abrirCentral = () => { h.aberturas += 1; };
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
    async editarGrupo(id, texto) { h.edicoes.push([id, texto]); return { ok: true }; },
  };
  const filaEntrega = [...respostasEntrega];
  h.mensageiro = {
    async entregar(p) {
      h.entregas.push(p);
      return filaEntrega.length ? filaEntrega.shift() : { status: 'enviado', detalhe: '' };
    },
  };
  h.tg = comTg ? dubleTg(h) : null;
  const opcoes = {
    wpp: h.wpp, numeroDono: NUMERO_DONO, mensageiro: h.mensageiro, ocioso: async () => h.idle, agora: () => h.t, env, abrirCentral: h.abrirCentral,
    rand: randFixo(), dormir: async (ms) => { h.dormidas.push(ms); h.t += ms; },
    central: CENTRAL_TESTE, raizesSessao: RAIZES_TESTE, // A3a: a central e as pastas como o dono configura
  };
  if (comTg) Object.assign(opcoes, { tg: h.tg, identTg: { chatId: DONO, botId: BOT } }); // A1: o chat e o bot de antes
  if (canalPrincipal) opcoes.canalPrincipal = canalPrincipal;
  h.opcoes = opcoes;
  h.cru = criarPorteiro(opcoes);
  h.p = comBomba(h.cru);
  h.t += 1000; // mensagens dos testes nascem depois do cursor inicial
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
const CENTRAL = 'Central de sessões de teste';

const DECISAO = { decisao: true, fica: false, pergunta: false };
const COM_PERGUNTA = { decisao: false, fica: false, pergunta: true };
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
const ligarTg = (h) => mexer(h, (e) => { e.tg.offset = 0; });
async function ligarRua(h) {
  h.idle = 30 * MIN;
  await h.p.passoMinuto();
  assert.equal(estado(h).modoRua.ligado, true);
}
const linhasSistema = (h) => estado(h).tg.sistema.linhas.map((l) => l.texto);

function msgTg(h, texto, { respondeA = null } = {}) {
  h.nUpd += 1;
  h.nMid += 1;
  const m = {
    message_id: h.nMid, date: Math.floor(h.t / 1000),
    chat: { id: DONO, type: 'private', first_name: 'Davi' }, from: { id: DONO, is_bot: false, first_name: 'Davi' },
  };
  if (texto !== undefined) m.text = texto;
  if (respondeA != null) m.reply_to_message = { message_id: respondeA };
  return { update_id: h.nUpd, message: m };
}
function toqueTg(h, dados, messageId) {
  h.nUpd += 1;
  return {
    update_id: h.nUpd,
    callback_query: {
      id: `q${h.nUpd}`, from: { id: DONO, is_bot: false }, message: { message_id: messageId, chat: { id: DONO, type: 'private' } }, data: dados,
    },
  };
}
const pid = (u) => `tg-u${u.update_id}`;
const mid = (u) => u.message.message_id;

// Chamado de uma aba ja na tela (o aviso com os botoes da DECISAO): monta com um canal auxiliar sobre o estado do disco.
// A mensagem do aviso = 500 + n.
async function chamadoNaTela(h, sessionId, titulo, final = FINAL, nome = undefined) {
  const arq = path.join(h.env.SESSOES_WPP_DIR, 'estado.json');
  const e = JSON.parse(fs.readFileSync(arq, 'utf8'));
  const aux = {
    async enviar() { h.nAux += 1; return { ok: true, messageId: 500 + h.nAux, formato: 'rich' }; },
    async editar() { return { ok: true }; },
    async apagar() { return { ok: true }; },
  };
  const canal = criarCanalTelegram({ tg: aux, agora: () => h.t, rand: h.randAux });
  canal.aviso(e, { sessionId, at: iso(h.t), finalTs: iso(h.t), final, ...(nome !== undefined ? { nome } : {}) }, titulo);
  await canal.drenar(e);
  fs.writeFileSync(arq, JSON.stringify(e));
  const c = e.tg.chamados[sessionId];
  assert.ok(Array.isArray(c.versao.opcoes) && c.versao.opcoes.length > 0, 'o chamado na tela tem botoes');
  return { messageId: c.mensagem.messageId, chamadoId: c.versao.chamadoId };
}

// Recado como chega no transcript da aba (formato medido 27/09).
function peer(pedido, ts) {
  const texto = `Another Claude session sent a message (from repos-99):\n<cross-session-message from="repos-99">\n${montarRecado(pedido)}\n</cross-session-message>`;
  return { type: 'user', isMeta: true, origin: { kind: 'peer', from: 'repos-99' }, timestamp: ts, message: { role: 'user', content: texto } };
}

const chamado = (h, sid) => estado(h).tg.chamados[sid];
// Fala do dono pelo Telegram ate o resultado do mensageiro aplicado (o evento fica no chamado; a tela so muda na proxima
// espera).
async function falarTg(h, texto, opts) {
  const u = msgTg(h, texto, opts);
  h.tg.lotes.push([u]);
  await h.p.esperarTelegram(15000);
  await bombear(h.cru);
  return u;
}
// Recado de cada pedido no transcript da aba + o parou dela 1 min depois (o recado entrou antes da fala final).
function abaResponde(h, sid, pedidos, o = {}) {
  transcript(h, sid, pedidos.map((p, i) => peer(p, iso(h.t + 1000 * (i + 1)))));
  h.t += MIN;
  const ev = parou(h, sid, o);
  evento(h, ev);
  return ev;
}
const encaminharTg = (h, o = {}) => evento(h, { v: 1, tipo: 'encaminhar', at: iso(h.t), para: 'Faro', providerMsgId: null, por: 'SC', ...o });
const textoTg = (h) => JSON.stringify(h.tg.chamadas.filter((c) => ['enviar', 'editar'].includes(c.metodo)).map((c) => c.args));

// Faro + central vivas, Telegram ligado; a fala do dono pelo Telegram foi pra central (entrega A). `tela` = a central
// com um chamado na tela (com botoes) e a fala em cima dele.
const LINHA = '> Telegram do Davi (12:00): «publica o site de novo»';
const SO_REPASSOU = `${LINHA}\n\nPedi pro porteiro passar o seu pedido pra aba "Faro".`;
// `respostasEntrega` (revisao 03/10): o roteiro do mensageiro (a 1a e a da fala pra central)
async function cenaCentral({ tela = false, respostasEntrega = [] } = {}) {
  const h = montar({ respostasEntrega });
  aba(h, 'S1', 'Faro');
  aba(h, 'SC', CENTRAL, 'repos-99');
  const naTela = tela ? await chamadoNaTela(h, 'SC', CENTRAL, FINAL, 'repos-99') : null;
  ligarTg(h);
  const u = await falarTg(h, 'publica o site de novo', naTela ? { respondeA: naTela.messageId } : undefined);
  assert.deepEqual(h.entregas.map((p) => [p.sessionId, p.providerMsgId, p.canal]), [['SC', pid(u), 'telegram']]);
  h.t += 10 * 1000;
  return { h, A: pid(u), u, naTela };
}

// ---------- T7a1c (copia do tests/porteiro-telegram.test.mjs): central travada que o porteiro fecha e reabre ----------
const NOME_DO_N_TG = 'Central de sessoes de teste'; // o -n do central/abrir-central.vbs
const PID_CS_TG = 424243;
function regPipeTg(h, { sessionId, pipe, comCanal = true, name = 'projetos-42', nameSource = 'derived', entrypoint = 'claude-vscode', idadeMs = 10 * MIN }) {
  h.nReg += 1;
  const inicio = h.t - idadeMs;
  const reg = {
    pid: process.pid, sessionId, cwd: 'C:\\projetos', entrypoint, name, nameSource, status: 'idle', updatedAt: h.t, startedAt: inicio,
    procStart: String((BigInt(inicio) + 11644473600000n) * 10000n), messagingSocketPath: `\\\\.\\pipe\\${pipe}`,
  };
  fs.writeFileSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${100000 + h.nReg}.json`), JSON.stringify(reg));
  if (comCanal && h.pipes) h.pipes.add(pipe);
}
function abaComPipeTg(h, sessionId, titulo) {
  regPipeTg(h, { sessionId, pipe: `claude-${sessionId.toLowerCase()}` });
  transcript(h, sessionId, [custom(titulo)]);
}
const centralTg = (h, sessionId, comCanal, o = {}) => regPipeTg(h, {
  sessionId, pipe: `claude-${sessionId.toLowerCase()}`, comCanal, name: NOME_DO_N_TG, nameSource: 'user', entrypoint: 'cli', ...o,
});
async function soltarCentralTg(h) {
  const r = await h.cru.passoCentral();
  await bombear(h.cru);
  return r;
}
function montarT7cTg(o = {}) {
  const h = montar(o);
  h.pipes = new Set();
  h.vivos = new Set();
  h.infos = new Map();
  h.mortes = [];
  h.pidVivo = (p) => Number(p) === process.pid || h.vivos.has(Number(p));
  h.processos = {
    info: (p) => h.infos.get(p) ?? null,
    matarArvore: (p) => { h.mortes.push(p); h.vivos.delete(p); return true; },
  };
  h.naoAchei = new Set();
  const orig = h.mensageiro.entregar;
  h.mensageiro.entregar = async (p) => {
    if (!h.naoAchei.has(p.sessionId)) return orig(p);
    h.entregas.push(p);
    return { status: 'nao_achei', detalhe: '' };
  };
  h.opcoes = { ...h.opcoes, listarPipes: () => new Set(h.pipes), pidVivo: h.pidVivo, processos: h.processos };
  h.cru = criarPorteiro(h.opcoes);
  h.p = comBomba(h.cru);
  return h;
}
function centralT7cTg(h, sessionId, { comCanal = true, idadeMs = 10 * MIN, pid: p = PID_CS_TG, status = 'idle' } = {}) {
  h.nReg += 1;
  const inicio = h.t - idadeMs;
  const pipe = `claude-${sessionId.toLowerCase()}`;
  const reg = {
    pid: p, sessionId, cwd: 'C:\\projetos', entrypoint: 'cli', name: NOME_DO_N_TG, nameSource: 'user', status, updatedAt: h.t,
    startedAt: inicio, procStart: String((BigInt(inicio) + 11644473600000n) * 10000n), messagingSocketPath: `\\\\.\\pipe\\${pipe}`,
  };
  fs.writeFileSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${100000 + h.nReg}.json`), JSON.stringify(reg));
  if (comCanal) h.pipes.add(pipe);
  h.vivos.add(p);
  h.infos.set(p, { nome: 'claude.exe', paiPid: 4321, criadoEm: inicio });
}
const FRASE_REABERTA = 'A central travou; reabri e passei sua pergunta de novo.';
const enviosComFrase = (h) => h.tg.de('enviar').map((c) => c.args[0]).filter((x) => String(x.html).includes('A central travou'));

// Texto do naoAchei do porteiro (sem o cabecalho do WhatsApp), por extenso de proposito.
const NAO_ACHEI = 'Não achei a sessão Faro aberta no PC. "status" lista as que estão abertas.';

// ===============================================================================================================

// Mac-testes (A): os testes marcados com SO_WINDOWS conferem a premissa do Windows (caminho X:\, .exe, wscript/.vbs,
// cmd.exe, APPDATA/LOCALAPPDATA, pipe \\.\pipe, barra invertida na frase, PowerShell, VS Code/Orca abertos pelo
// porteiro); fora do win32 eles pulam. O caminho do Mac tem os testes proprios em tests/mac-*.test.mjs.
const SO_WINDOWS = process.platform !== 'win32' && 'premissa do Windows (o Mac tem os tests/mac-*)';

test('T7f 93. fala do dono nao gera mensagem nova (enviando e entregue so no estado); o chamado respondido na tela com botoes perde os botoes numa edicao, sem notificar; sem chamado na tela, nada', async () => {
  // (a) em cima do chamado, toque na opcao e "Nome: texto" com o aviso da aba na tela (com botoes)
  const cenas = [
    ['em cima do chamado', async (h, tela) => falarTg(h, 'pode publicar', { respondeA: tela.messageId }), 'pode publicar'],
    ['toque na opcao', async (h, tela) => {
      h.tg.lotes.push([toqueTg(h, `o:${tela.chamadoId}:0`, tela.messageId)]);
      await h.p.esperarTelegram(15000);
      await bombear(h.cru);
      return null;
    }, 'A) Sim, tudo hoje (recomendado)'],
    ['"Nome: texto"', async (h) => falarTg(h, 'Faro: pode publicar'), 'pode publicar'],
  ];
  for (const [rotulo, falar, fala] of cenas) {
    const h = montar();
    aba(h, 'S1', 'Faro');
    const tela = await chamadoNaTela(h, 'S1', 'Faro');
    ligarTg(h);
    const u = await falar(h, tela);
    assert.equal(h.entregas.length, 1, `${rotulo}: a fala foi pra aba`);
    assert.equal(h.entregas[0].sessionId, 'S1', rotulo);
    await h.p.esperarTelegram(15000); // drena o "entregue"
    const c = chamado(h, 'S1');
    assert.equal(c.versao.estado, 'entregue', `${rotulo}: entregue no estado`);
    assert.equal(c.versao.fala, fala, `${rotulo}: a fala fica no estado`);
    assert.equal(c.versao.citar, u ? mid(u) : null, `${rotulo}: o citar fica no estado (toque = sem mensagem dele)`);
    if (rotulo === 'toque na opcao') {
      // T7j: o toque conclui e a mensagem some (apagada no drenar, sem tirar os botoes antes)
      assert.equal(c.mensagem, null, `${rotulo}: a tela tocada saiu do chamado`);
      assert.deepEqual(h.tg.tela(), [['apagar', tela.messageId]], `${rotulo}: a mensagem tocada sai do chat, 1 vez; nada novo nem editado`);
    } else {
      assert.equal(c.mensagem.messageId, tela.messageId, `${rotulo}: o chamado respondido continua na tela`);
      assert.deepEqual(h.tg.de('enviar'), [], `${rotulo}: nenhuma mensagem nova (nem enviando, nem entregue)`);
      assert.deepEqual(h.tg.de('editar'), [], `${rotulo}: o texto do chamado nao muda`);
      assert.deepEqual(h.tg.de('apagar'), [], `${rotulo}: nada sai do chat`);
      assert.deepEqual(h.tg.de('editarBotoes').map((x) => x.args), [[tela.messageId, null]], `${rotulo}: a mesma mensagem perde os botoes (edicao, sem notificar), 1 vez`);
    }
    // 2a fala pra mesma aba: o chamado na tela ja esta sem botoes = nada na tela
    h.tg.zerar();
    await falarTg(h, 'Faro: e o deploy?');
    await h.p.esperarTelegram(15000);
    assert.equal(h.entregas.length, 2, rotulo);
    assert.deepEqual(h.tg.tela(), [], `${rotulo}: 2a fala, nada na tela`);
    assert.deepEqual(h.enviados, [], `${rotulo}: nada no grupo`);
  }

  // (b) sem chamado na tela: "Nome: texto" pra aba sem chamado e fala solta pra central = nenhuma chamada na tela
  const s = montar();
  aba(s, 'S1', 'Faro');
  aba(s, 'SC', CENTRAL, 'repos-99');
  ligarTg(s);
  await falarTg(s, 'Faro: publica');
  await falarTg(s, 'bom dia');
  await s.p.esperarTelegram(15000);
  assert.deepEqual(s.entregas.map((p) => p.sessionId), ['S1', 'SC']);
  for (const sid of ['S1', 'SC']) {
    assert.equal(chamado(s, sid).versao.estado, 'entregue', `${sid}: entregue so no estado`);
    assert.equal(chamado(s, sid).mensagem, null, `${sid}: nada na tela`);
  }
  assert.deepEqual(s.tg.tela(), [], 'sem chamado na tela: nada');
  assert.deepEqual(estado(s).tg.mensagens, {}, 'nenhuma mensagem do bot no chat');
});

test('T7f 94. o resultado (resposta da aba) sai como hoje: mensagem nova com notificacao, em cima da fala dele; o chamado respondido (ja sem botoes) sai depois', async () => {
  const h = montar();
  aba(h, 'S1', 'Faro');
  const tela = await chamadoNaTela(h, 'S1', 'Faro');
  ligarTg(h);
  const u = await falarTg(h, 'pode publicar', { respondeA: tela.messageId });
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.tela(), [['editarBotoes', tela.messageId]]);
  h.tg.zerar();
  abaResponde(h, 'S1', [h.entregas[0]], { final: `> Telegram do Davi (12:00): «pode publicar»\n\n${FINAL}`, marcas: DECISAO });
  await h.p.passoEventos();
  assert.equal(chamado(h, 'S1').versao.estado, 'resposta');
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.tela(), [['enviar', false], ['apagar', tela.messageId]], 'mensagem nova com notificacao; o chamado respondido sai depois');
  const env = h.tg.de('enviar')[0].args[0];
  assert.equal(env.responderA, mid(u), 'em cima da fala dele');
  assert.equal(env.silencioso, false);
  assert.equal(env.html, '<h2>ℹ️ Faro</h2><p>Terminei a revisão.</p><p><b>Publico?</b></p>');
  assert.deepEqual(env.botoes.map((l) => l[0].texto), ['A) Sim, tudo hoje (recomendado)', 'B) Só as correções', 'Mais informações']);
  assert.deepEqual(h.enviados, [], 'nada no grupo');

  // sem chamado na tela: a fala nao mostra nada e a resposta sai sozinha, em cima dela (nada pra apagar)
  const n = montar();
  aba(n, 'S1', 'Faro');
  ligarTg(n);
  const v = await falarTg(n, 'Faro: roda os testes');
  await n.p.esperarTelegram(15000);
  assert.deepEqual(n.tg.tela(), []);
  abaResponde(n, 'S1', [n.entregas[0]], { final: '> Telegram do Davi (12:00): «roda os testes»\n\nRodei: 12 de 12 passaram.' });
  await n.p.passoEventos();
  await n.p.esperarTelegram(15000);
  assert.deepEqual(n.tg.tela(), [['enviar', false]], 'a resposta sem pergunta tambem sai (so a da central que repassou fica calada)');
  const r = n.tg.de('enviar')[0].args[0];
  assert.equal(r.responderA, mid(v));
  assert.ok(r.html.includes('Rodei: 12 de 12 passaram.'), r.html);
});

test('T7f 95. resposta da central que so repassou (pedido ou entrega encaminhado -E<n>) e nao precisa do dono: nada no Telegram e o chamado dela encerra calado (a mensagem dela na tela e apagada); pelo parou guardado igual; sem repassar sai como hoje', async () => {
  // (a) o encaminhar e a resposta da central no mesmo passo: o pedido -E1 ainda na fila de entrega; central sem tela
  const { h, A, u } = await cenaCentral();
  assert.deepEqual(h.tg.tela(), [], 'a fala nao mostrou nada');
  encaminharTg(h, { providerMsgId: A });
  abaResponde(h, 'SC', [h.entregas[0]], { nome: 'repos-99', final: SO_REPASSOU });
  await h.cru.passoEventos(); // sem bombear: o -E1 fica na fila
  let e = estado(h);
  assert.deepEqual(e.filaEntrega.map((q) => [q.pedido.providerMsgId, q.pedido.encaminhado]), [[`${A}-E1`, true]]);
  assert.equal(e.entregas[A].respondida, true, 'a resposta da central conta como resposta');
  assert.equal(e.tg.chamados.SC, undefined, 'o chamado da central encerrou calado');
  await bombear(h.cru);
  assert.equal(h.entregas.length, 2);
  assert.equal(h.entregas[1].providerMsgId, `${A}-E1`);
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.tela(), [], 'nada no Telegram: nem a resposta da central, nem enviando ou entregue');
  // o resultado da Faro sai como hoje, em cima da fala dele
  abaResponde(h, 'S1', [h.entregas[1]], { final: `${LINHA}\n\nPubliquei o site.` });
  await h.p.passoEventos();
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.tela(), [['enviar', false]], 'so o resultado');
  const res = h.tg.de('enviar')[0].args[0];
  assert.ok(res.html.includes('Publiquei o site.'), res.html);
  assert.equal(res.responderA, mid(u));
  assert.doesNotMatch(textoTg(h), /Pedi pro porteiro/, 'a resposta da central nunca sai');
  assert.deepEqual(h.enviados, [], 'nada no grupo');

  // (b) a entrega -E1 ja registrada; a central tinha um chamado na tela (com botoes) e ele respondeu em cima dele.
  // Revisao 03/10: o drenar de cada volta (esperarTelegram) roda antes do parou, como no porteiro real: o "entregue" da
  // central ja saiu da fila do canal, e so o calar pode por o chamado de volta nela (prende o enfileirar do calar).
  const b = await cenaCentral({ tela: true });
  await b.h.p.esperarTelegram(15000);
  assert.deepEqual(estado(b.h).tg.saida, [], 'a fila do canal vazia antes do parou');
  assert.deepEqual(b.h.tg.tela(), [['editarBotoes', b.naTela.messageId]], 'a pergunta da central perdeu os botoes');
  b.h.tg.zerar();
  encaminharTg(b.h, { providerMsgId: b.A });
  await b.h.p.passoEventos(); // o -E1 entregue: e.entregas[<A>-E1] com encaminhado
  assert.equal(estado(b.h).entregas[`${b.A}-E1`]?.pedido?.encaminhado, true);
  abaResponde(b.h, 'SC', [b.h.entregas[0]], { nome: 'repos-99', final: SO_REPASSOU });
  await b.h.p.passoEventos();
  assert.equal(estado(b.h).entregas[b.A].respondida, true);
  await b.h.p.esperarTelegram(15000);
  // T7k: a mensagem da central na tela fica ate a resposta da Faro a fala repassada (T7k 6 segue ate o apagar)
  assert.deepEqual(b.h.tg.tela(), [], 'a mensagem da central na tela fica ate a resposta da Faro; nenhuma nova');
  assert.equal(chamado(b.h, 'SC').versao.estado, 'calado', 'o chamado da central encerrou calado');
  assert.deepEqual(chamado(b.h, 'SC').esperando, [b.A]);
  assert.deepEqual(b.h.enviados, []);

  // (c) parou guardado: a central respondeu antes do "enviado" da entrega dela; aplicado depois = calada igual
  const x = montar();
  aba(x, 'S1', 'Faro');
  aba(x, 'SC', CENTRAL, 'repos-99');
  ligarTg(x);
  const ux = msgTg(x, 'publica o site de novo');
  x.tg.lotes.push([ux]);
  await x.p.esperarTelegram(15000); // o mensageiro saiu; o resultado so e aplicado no proximo passoEntrega
  assert.equal(x.entregas.length, 1);
  x.t += 10 * 1000;
  encaminharTg(x, { providerMsgId: pid(ux) });
  abaResponde(x, 'SC', [x.entregas[0]], { nome: 'repos-99', final: SO_REPASSOU });
  await x.cru.passoEventos(); // sem a entrega da central registrada: o parou fica guardado
  assert.equal(estado(x).entregas[pid(ux)], undefined);
  await bombear(x.cru); // "enviado" aplicado: registra a entrega e passa o parou guardado
  assert.equal(estado(x).entregas[pid(ux)].respondida, true);
  assert.equal(estado(x).parouGuardado.SC.noTelegram, true, 'o parou guardado nao volta pro Telegram');
  assert.equal(chamado(x, 'SC'), undefined, 'o chamado da central encerrou calado');
  x.tg.zerar();
  await x.p.esperarTelegram(15000);
  assert.deepEqual(x.tg.tela(), [], 'nada no Telegram');
  assert.doesNotMatch(textoTg(x), /Pedi pro porteiro/);

  // (d) a central respondeu sem repassar (nenhum -E<n>), sem precisar dele: sai como hoje
  const d = await cenaCentral();
  abaResponde(d.h, 'SC', [d.h.entregas[0]], { nome: 'repos-99', final: `${LINHA}\n\nO site já está publicado desde as 11h.` });
  await d.h.p.passoEventos();
  assert.equal(chamado(d.h, 'SC').versao.estado, 'resposta');
  d.h.tg.zerar();
  await d.h.p.esperarTelegram(15000);
  assert.deepEqual(d.h.tg.tela(), [['enviar', false]]);
  const rd = d.h.tg.de('enviar')[0].args[0];
  assert.equal(rd.responderA, mid(d.u));
  assert.ok(rd.html.includes('O site já está publicado desde as 11h.'), rd.html);
});

test('T7f 96. resposta da central que precisa do dono sai como hoje (mensagem nova com notificacao, em cima da fala dele), mesmo depois de repassar e pelo parou guardado', async () => {
  // (a) repassou e pede uma decisao
  const { h, A, u } = await cenaCentral();
  encaminharTg(h, { providerMsgId: A });
  const decide = `${LINHA}\n\nPassei pra Faro.\n\n---\n🔴 **DECISÃO:** Aviso o time quando ela terminar? A) Sim (recomendado) / B) Não`;
  abaResponde(h, 'SC', [h.entregas[0]], { nome: 'repos-99', final: decide, marcas: DECISAO });
  await h.cru.passoEventos();
  assert.equal(estado(h).filaEntrega.length, 1, 'o -E1 na fila (repassou)');
  assert.equal(chamado(h, 'SC').versao.estado, 'resposta');
  h.tg.zerar();
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.tela(), [['enviar', false]]);
  const env = h.tg.de('enviar')[0].args[0];
  assert.ok(env.html.includes('Passei pra Faro.'), env.html);
  assert.equal(env.responderA, mid(u));
  assert.ok(Array.isArray(env.botoes) && env.botoes.length > 0, 'com os botoes da DECISAO');

  // (b) "qual aba?" (pergunta, sem repassar)
  const q = await cenaCentral();
  abaResponde(q.h, 'SC', [q.h.entregas[0]], { nome: 'repos-99', final: `${LINHA}\n\nTem duas abas de site abertas: Site A e Site B. Qual delas?`, marcas: COM_PERGUNTA });
  await q.h.p.passoEventos();
  q.h.tg.zerar();
  await q.h.p.esperarTelegram(15000);
  assert.deepEqual(q.h.tg.tela(), [['enviar', false]]);
  const rq = q.h.tg.de('enviar')[0].args[0];
  assert.equal(rq.responderA, mid(q.u));
  assert.ok(rq.html.includes('Qual delas?'), rq.html);

  // (c) parou guardado que repassou e pergunta: sai
  const x = montar();
  aba(x, 'S1', 'Faro');
  aba(x, 'SC', CENTRAL, 'repos-99');
  ligarTg(x);
  const ux = msgTg(x, 'publica o site de novo');
  x.tg.lotes.push([ux]);
  await x.p.esperarTelegram(15000);
  x.t += 10 * 1000;
  encaminharTg(x, { providerMsgId: pid(ux) });
  abaResponde(x, 'SC', [x.entregas[0]], { nome: 'repos-99', final: decide, marcas: DECISAO });
  await x.cru.passoEventos();
  await bombear(x.cru);
  assert.equal(chamado(x, 'SC').versao.estado, 'resposta');
  x.tg.zerar();
  await x.p.esperarTelegram(15000);
  assert.deepEqual(x.tg.tela(), [['enviar', false]]);
  assert.equal(x.tg.de('enviar')[0].args[0].responderA, mid(ux));
});

test('T7f 97. problema continua saindo (mensagem nova com notificacao, em cima da fala dele; o chamado sem botoes sai depois) e a linha do sistema da central travada (T7a1) tambem', { skip: SO_WINDOWS }, async () => {
  // (a) a aba nao foi achada: problema em cima da fala dele
  const h = montar({ respostasEntrega: [{ status: 'nao_achei', detalhe: '' }] });
  aba(h, 'S1', 'Faro');
  const tela = await chamadoNaTela(h, 'S1', 'Faro');
  ligarTg(h);
  const u = await falarTg(h, 'pode publicar', { respondeA: tela.messageId });
  assert.equal(chamado(h, 'S1').versao.estado, 'problema');
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.tela(), [['editarBotoes', tela.messageId], ['enviar', false], ['apagar', tela.messageId]]);
  const env = h.tg.de('enviar')[0].args[0];
  assert.equal(env.silencioso, false, 'problema notifica');
  assert.equal(env.responderA, mid(u), 'em cima da fala dele');
  assert.ok(env.html.includes(NAO_ACHEI), env.html);
  assert.ok(env.html.includes('«pode publicar»'), env.html);
  assert.deepEqual(h.enviados, [], 'nada no grupo');

  // sem chamado na tela: o problema sai sozinho, em cima da fala
  const n = montar({ respostasEntrega: [{ status: 'nao_achei', detalhe: '' }] });
  aba(n, 'S1', 'Faro');
  ligarTg(n);
  const v = await falarTg(n, 'Faro: publica');
  await n.p.esperarTelegram(15000);
  assert.deepEqual(n.tg.tela(), [['enviar', false]]);
  assert.equal(n.tg.de('enviar')[0].args[0].responderA, mid(v));
  assert.ok(n.tg.de('enviar')[0].args[0].html.includes(NAO_ACHEI));

  // (b) a central travou (nao_achei): o porteiro fecha, abre outra e passa a fala de novo = a linha do sistema com
  // notificacao; o "entregue" da nova fica so no estado
  const k = montarT7cTg();
  abaComPipeTg(k, 'S1', 'Faro');
  centralT7cTg(k, 'CS');
  k.naoAchei.add('CS');
  ligarTg(k);
  k.idle = 0;
  await falarTg(k, 'bom dia');
  await k.p.esperarTelegram(15000);
  assert.equal(estado(k).centralPendentes[0]?.porque, 'nao_achei');
  await k.p.passoMinuto();
  assert.deepEqual(k.mortes, [PID_CS_TG]);
  k.t += 30 * 1000;
  centralTg(k, 'CN', true, { idadeMs: 20 * 1000 });
  await soltarCentralTg(k);
  await k.p.esperarTelegram(15000);
  assert.equal(k.entregas.length, 2);
  assert.equal(k.entregas[1].sessionId, 'CN');
  assert.equal(chamado(k, 'CN')?.versao.estado, 'entregue');
  assert.equal(chamado(k, 'CN')?.mensagem, null, 'o entregue da nova fica so no estado');
  assert.deepEqual(linhasSistema(k).filter((l) => l === FRASE_REABERTA), [FRASE_REABERTA]);
  const fr = enviosComFrase(k);
  assert.equal(fr.length, 1, 'a linha do sistema sai');
  assert.equal(fr[0].silencioso, false, 'com notificacao');
  assert.doesNotMatch(textoTg(k), /Passando pra aba|Entregue na aba|Você disse|Você respondeu/, 'nada de enviando/entregue na tela');
  assert.deepEqual(k.enviados, [], 'nada no grupo');
});

test('T7f 98. WhatsApp byte a byte (F7): a central que repassa pelo grupo responde no grupo como hoje, igual com e sem o Telegram; o ensaio do canal registra igual ao real (sem enviando/entregue)', async () => {
  // (a) fala solta no grupo -> central -> encaminhar -> Faro; as duas respostas no grupo, iguais com e sem o Telegram
  const rodar = async (comTg) => {
    const h = montar({ tg: comTg });
    aba(h, 'S1', 'Faro');
    aba(h, 'SC', CENTRAL, 'repos-99');
    if (comTg) ligarTg(h);
    const m = msg(h, { content: 'publica o site de novo' });
    await h.p.passoGrupo();
    h.t += 10 * 1000;
    encaminharTg(h, { providerMsgId: m.provider_msg_id });
    const linha = '> WhatsApp do Davi (12:00): «publica o site de novo»';
    abaResponde(h, 'SC', [h.entregas[0]], { nome: 'repos-99', final: `${linha}\n\nPedi pro porteiro passar o seu pedido pra aba "Faro".` });
    await h.p.passoEventos();
    assert.equal(h.entregas.length, 2);
    abaResponde(h, 'S1', [h.entregas[1]], { final: `${linha}\n\nPubliquei o site.` });
    await h.p.passoEventos();
    if (comTg) {
      h.tg.zerar();
      await h.p.esperarTelegram(15000);
    }
    return h;
  };
  const sem = await rodar(false);
  const com = await rodar(true);
  assert.equal(sem.enviados.length, 2, 'sem o Telegram: a resposta da central e a da Faro no grupo');
  assert.ok(sem.enviados[0].texto.includes('Pedi pro porteiro passar o seu pedido'), sem.enviados[0].texto);
  assert.deepEqual(com.enviados, sem.enviados, 'o grupo recebe byte a byte o mesmo (a central que repassou continua no grupo)');
  assert.deepEqual(com.reacoes, sem.reacoes);
  assert.deepEqual(com.entregas, sem.entregas, 'os recados byte a byte');
  assert.deepEqual(com.tg.tela(), [], 'o Telegram calado');

  // (b) ensaio x real: a mesma sequencia no canal (aviso, fala, entregue, resposta) = as mesmas acoes
  const roteiro = async (canal, e) => {
    canal.aviso(e, { sessionId: 'aba-1', at: iso(T0), finalTs: iso(T0), final: FINAL }, 'Faro');
    await canal.drenar(e);
    const tela = e.tg.chamados['aba-1'].mensagem.messageId;
    canal.falaRecebida(e, { sessionId: 'aba-1', titulo: 'Faro', fala: 'pode publicar', hora: iso(T0), messageIdDono: 77 });
    await canal.drenar(e);
    canal.entregue(e, 'aba-1', iso(T0));
    await canal.drenar(e);
    assert.equal(e.tg.chamados['aba-1'].versao.estado, 'entregue');
    canal.resposta(e, { sessionId: 'aba-1', at: iso(T0), finalTs: iso(T0), final: 'Publiquei.' }, 'Faro', { citar: 77 });
    await canal.drenar(e);
    return tela;
  };
  const chamadas = [];
  const tgReal = {
    async enviar(p) { chamadas.push(['enviar', p.silencioso, p.responderA ?? null]); return { ok: true, messageId: 600 + chamadas.length, formato: 'rich' }; },
    async editar(id) { chamadas.push(['editar', id]); return { ok: true }; },
    async editarBotoes(id, botoes) { chamadas.push(['editarBotoes', id, botoes]); return { ok: true }; },
    async apagar(id) { chamadas.push(['apagar', id]); return { ok: true }; },
  };
  const real = { tg: tgNovo() };
  const telaReal = await roteiro(criarCanalTelegram({ tg: tgReal, agora: () => T0, rand: randFixo() }), real);
  assert.deepEqual(chamadas, [
    ['enviar', false, null], ['editarBotoes', telaReal, null], ['enviar', false, 77], ['apagar', telaReal],
  ], 'real: o aviso, os botoes saem, o resultado em cima da fala, o aviso sai');
  const registros = [];
  const ens = { tg: tgNovo() };
  const telaEns = await roteiro(criarCanalTelegram({ ensaio: true, registrarEnsaio: (r) => registros.push(r), agora: () => T0, rand: randFixo() }), ens);
  assert.deepEqual(registros.map((r) => r.acao), ['tg.enviar', 'tg.editarBotoes', 'tg.enviar', 'tg.apagar'], 'ensaio: as mesmas acoes');
  assert.equal(registros[1].messageId, telaEns);
  assert.equal(registros[1].botoes, null);
  assert.deepEqual([registros[2].estado, registros[2].silencioso, registros[2].responderA], ['resposta', false, 77]);
  assert.equal(registros[3].messageId, telaEns);
  assert.ok(!registros.some((r) => r.estado === 'enviando' || r.estado === 'entregue'), 'enviando e entregue nunca registram mensagem');
});

// ===============================================================================================================
// Revisao adversarial da T7f (03/10/2026): o que os testes 93 a 98 nao pegavam. Defeitos (vermelhos antes da correcao):
// 94b (so a resposta DA CENTRAL cala), 95e e 95i (corrida do mensageiro: calado nao e "ja foi", nos 2 lugares que calam)
// e 97c (problema depois do calar com o titulo da aba). Os outros prendem o que ja estava certo e nenhuma sabotagem pegava:
// 95f (o every), 95g (o -E1 na fila de nova tentativa), 95h (o enfileirar do calar), 95j (o -E<n> ancorado, que a
// conferencia da central passou a esconder), 93c (tela de versao anterior) e 93d (erros do tirar os botoes).

// Canal sozinho (sem o porteiro): duble do criarTelegram com roteiro por metodo (lista: cada chamada consome 1 resposta;
// vazia = padrao). Padrao: enviar ok com messageId 500 + n; editar, editarBotoes e apagar ok. semEditarBotoes = o
// adaptador sem o metodo.
function canalT7f({ roteiro = {}, semEditarBotoes = false } = {}) {
  const chamadas = [];
  const filas = {};
  for (const m of ['enviar', 'editar', 'editarBotoes', 'apagar']) filas[m] = [...(roteiro[m] ?? [])];
  let enviadas = 0;
  const responder = (metodo, args, padrao) => {
    chamadas.push({ metodo, args });
    return filas[metodo].length ? filas[metodo].shift() : padrao;
  };
  const tg = {
    chamadas,
    async enviar(p) { enviadas += 1; return responder('enviar', [p], { ok: true, messageId: 500 + enviadas, formato: 'rich' }); },
    async editar(id, p) { return responder('editar', [id, p], { ok: true }); },
    async apagar(id) { return responder('apagar', [id], { ok: true }); },
  };
  if (!semEditarBotoes) tg.editarBotoes = async (id, botoes) => responder('editarBotoes', [id, botoes], { ok: true });
  const relogio = { t: T0 };
  const logs = [];
  const canal = criarCanalTelegram({ tg, log: (m) => logs.push(m), agora: () => relogio.t, rand: randFixo() });
  return { canal, tg, e: { tg: tgNovo() }, logs, relogio };
}
const parouCanal = (sessionId, final = FINAL) => ({ sessionId, at: iso(T0), finalTs: iso(T0), final });
// enviar -> ['enviar', silencioso]; editar/editarBotoes/apagar -> [metodo, messageId]
const passosCanal = (tg) => tg.chamadas.map((c) => (c.metodo === 'enviar' ? ['enviar', c.args[0].silencioso] : [c.metodo, c.args[0]]));
const DUAS_LINHAS = '> Telegram do Davi (12:00): «publica o site de novo»\n> Telegram do Davi (12:00): «quantos leads entraram hoje?»';

test('T7f 94b. so a resposta DA CENTRAL cala: o resultado de uma aba comum (Faro) cuja fala a central re-encaminhou pra outra aba (-E1) sai como hoje, com notificacao e em cima da fala dele', async () => {
  const h = montar();
  aba(h, 'S1', 'Faro');
  aba(h, 'S2', 'Site', 'repos-77');
  aba(h, 'SC', CENTRAL, 'repos-99');
  ligarTg(h);
  const uA = await falarTg(h, 'Faro: publica o site'); // direto pra Faro
  const uB = await falarTg(h, 'passa a minha ultima mensagem pro Site tambem'); // solta: vai pra central
  assert.deepEqual(h.entregas.map((p) => [p.sessionId, p.providerMsgId]), [['S1', pid(uA)], ['SC', pid(uB)]]);
  h.t += 10 * 1000;
  // a central re-encaminha a fala da Faro pro Site e responde a fala dela (essa resposta, que nao repassou a fala que
  // ela respondeu, sai como hoje e fica fora daqui: o drenar abaixo leva ela)
  encaminharTg(h, { providerMsgId: pid(uA), para: 'S2' });
  abaResponde(h, 'SC', [h.entregas[1]], {
    nome: 'repos-99', final: '> Telegram do Davi (12:00): «passa a minha ultima mensagem pro Site tambem»\n\nPedi pro porteiro passar pro Site.',
  });
  await h.p.passoEventos();
  assert.deepEqual(h.entregas.slice(2).map((p) => [p.sessionId, p.providerMsgId, p.encaminhado]), [['S2', `${pid(uA)}-E1`, true]]);
  await h.p.esperarTelegram(15000);
  h.tg.zerar();
  // a Faro (aba comum, nao a central) responde a fala dela com o resultado
  abaResponde(h, 'S1', [h.entregas[0]], { final: '> Telegram do Davi (12:00): «publica o site»\n\nPubliquei o site.' });
  await h.p.passoEventos();
  assert.equal(estado(h).entregas[pid(uA)].respondida, true);
  assert.equal(chamado(h, 'S1')?.versao.estado, 'resposta', 'o chamado da Faro nao encerra calado');
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.tela(), [['enviar', false]], 'o resultado da Faro sai, com notificacao');
  const env = h.tg.de('enviar')[0].args[0];
  assert.ok(env.html.includes('Publiquei o site.'), env.html);
  assert.equal(env.responderA, mid(uA), 'em cima da fala dele');
  assert.deepEqual(h.enviados, [], 'nada no grupo');
});

test('T7f 95e. corrida do mensageiro (D5b1): calado nao e "ja foi" (caladoTg). 2 falas soltas pra central, A encaminhada (-E1) e B ainda em voo no parou: B respondida por ela = a resposta sai depois, em cima de B; B repassada tambem = so marca, nada no Telegram', async () => {
  const cena = async (repassaB) => {
    const h = montar();
    aba(h, 'S1', 'Faro');
    aba(h, 'SC', CENTRAL, 'repos-99');
    ligarTg(h);
    const uA = await falarTg(h, 'publica o site de novo'); // A entregue e registrada
    const uB = msgTg(h, 'quantos leads entraram hoje?');
    h.tg.lotes.push([uB]);
    await h.p.esperarTelegram(15000); // B lida e no mensageiro: o "enviado" so e aplicado no proximo passoEntrega
    assert.deepEqual(h.entregas.map((p) => p.providerMsgId), [pid(uA), pid(uB)]);
    assert.deepEqual(Object.keys(estado(h).entregas), [pid(uA)], 'B em voo: ainda nao registrada');
    h.t += 10 * 1000;
    encaminharTg(h, { providerMsgId: pid(uA) });
    if (repassaB) encaminharTg(h, { providerMsgId: pid(uB) });
    const final = repassaB
      ? `${DUAS_LINHAS}\n\nPedi pro porteiro passar os dois pedidos pra aba "Faro".`
      : `${DUAS_LINHAS}\n\nHoje entraram 42 leads. O site eu passei pra Faro.`;
    abaResponde(h, 'SC', [h.entregas[0], h.entregas[1]], { nome: 'repos-99', final });
    await h.cru.passoEventos(); // sem bombear: B continua em voo; o parou so ve a A (encaminhada) = calado
    const g = estado(h).parouGuardado.SC; // as marcas do parou calado (conferidas depois do que sai na tela)
    assert.equal(chamado(h, 'SC'), undefined, 'o chamado da central encerrou calado');
    await bombear(h.cru); // o "enviado" de B: registra B e passa o parou guardado
    assert.equal(estado(h).entregas[pid(uB)].respondida, true, 'o parou guardado responde B');
    h.tg.zerar();
    await h.p.esperarTelegram(15000);
    return { h, uB, g };
  };
  // (a) B respondida pela central (nao repassada): a resposta sai em cima de B, com notificacao; ja foi de verdade
  const a = await cena(false);
  assert.deepEqual(a.h.tg.tela(), [['enviar', false]], 'a resposta da central a B sai');
  const env = a.h.tg.de('enviar')[0].args[0];
  assert.ok(env.html.includes('Hoje entraram 42 leads.'), env.html);
  assert.equal(env.responderA, mid(a.uB), 'em cima da fala B');
  assert.equal(chamado(a.h, 'SC').versao.estado, 'resposta');
  assert.deepEqual(a.h.enviados, [], 'nada no grupo');
  assert.deepEqual([a.g.noTelegram, a.g.caladoTg], [true, true], 'o parou calado marca a parte (caladoTg)');
  const ga = estado(a.h).parouGuardado.SC;
  assert.deepEqual([ga.noTelegram, ga.caladoTg], [true, false], 'depois da resposta: ja foi pro Telegram de verdade (nao sai de novo)');
  // (b) B repassada tambem: so marca (B respondida), nada no Telegram e o chamado continua fora
  const b = await cena(true);
  assert.deepEqual(b.h.tg.tela(), [], 'nada no Telegram');
  assert.equal(chamado(b.h, 'SC'), undefined);
  assert.doesNotMatch(textoTg(b.h), /Pedi pro porteiro/);
  assert.deepEqual([b.g.noTelegram, b.g.caladoTg], [true, true]);
  const gb = estado(b.h).parouGuardado.SC;
  assert.deepEqual([gb.noTelegram, gb.caladoTg], [true, true], 'continua calado');
});

test('T7f 95f. so repassou = TODA fala respondida encaminhada (every): 2 falas soltas pra central registradas, so a 1a encaminhada, respondidas no mesmo parou = a resposta sai (com notificacao, em cima da mais nova) e o chamado da central fica em resposta', async () => {
  const h = montar();
  aba(h, 'S1', 'Faro');
  aba(h, 'SC', CENTRAL, 'repos-99');
  ligarTg(h);
  const uA = await falarTg(h, 'publica o site de novo');
  const uB = await falarTg(h, 'quantos leads entraram hoje?');
  h.t += 10 * 1000;
  encaminharTg(h, { providerMsgId: pid(uA) });
  await h.p.passoEventos();
  const e0 = estado(h);
  assert.equal(e0.entregas[`${pid(uA)}-E1`]?.pedido?.encaminhado, true, 'a A encaminhada');
  assert.equal(Object.keys(e0.entregas).some((k) => k.startsWith(`${pid(uB)}-E`)), false, 'a B nao');
  abaResponde(h, 'SC', [h.entregas[0], h.entregas[1]], { nome: 'repos-99', final: `${DUAS_LINHAS}\n\nHoje entraram 42 leads. O site eu passei pra Faro.` });
  await h.p.passoEventos();
  const e = estado(h);
  assert.deepEqual([e.entregas[pid(uA)].respondida, e.entregas[pid(uB)].respondida], [true, true], 'as 2 no mesmo parou');
  assert.equal(chamado(h, 'SC')?.versao.estado, 'resposta', 'nao encerra calado');
  h.tg.zerar();
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.tela(), [['enviar', false]], 'a resposta sai com notificacao');
  const env = h.tg.de('enviar')[0].args[0];
  assert.equal(env.responderA, mid(uB), 'em cima da fala mais nova');
  assert.ok(env.html.includes('Hoje entraram 42 leads.'), env.html);
});

test('T7f 95g. o -E1 na fila de nova tentativa (e.repassar) conta como repassado: "erro" na 1a tentativa do -E1, e porteiro religado com o -E1 em voo; o parou da central que so repassou = nada no Telegram e o chamado dela encerrado', async () => {
  // (a) o mensageiro devolve "erro" na 1a tentativa do -E1: ele espera o proximo passoGrupo em e.repassar
  const a = await cenaCentral({ respostasEntrega: [{ status: 'enviado', detalhe: '' }, { status: 'erro', detalhe: 'claude -p caiu' }] });
  encaminharTg(a.h, { providerMsgId: a.A });
  await a.h.p.passoEventos();
  let e = estado(a.h);
  assert.deepEqual(e.repassar.map((x) => [x.pedido.providerMsgId, x.pedido.encaminhado]), [[`${a.A}-E1`, true]], 'o -E1 na nova tentativa');
  assert.deepEqual([e.filaEntrega.length, e.entregas[`${a.A}-E1`]], [0, undefined], 'nem na fila de entrega nem entregue');
  abaResponde(a.h, 'SC', [a.h.entregas[0]], { nome: 'repos-99', final: SO_REPASSOU });
  await a.h.p.passoEventos();
  assert.equal(estado(a.h).entregas[a.A].respondida, true);
  assert.equal(chamado(a.h, 'SC'), undefined, '(a) o chamado da central encerrou calado');
  a.h.tg.zerar();
  await a.h.p.esperarTelegram(15000);
  assert.deepEqual(a.h.tg.tela(), [], '(a) nada no Telegram');
  assert.doesNotMatch(textoTg(a.h), /Pedi pro porteiro/);

  // (b) o porteiro caiu com o -E1 em voo e foi religado: o -E1 vira nova tentativa (so depois de 3 min)
  const r = await cenaCentral();
  encaminharTg(r.h, { providerMsgId: r.A });
  await r.h.cru.passoEventos(); // o -E1 entra na fila de entrega
  mexer(r.h, (x) => { x.filaEntrega[0].emVooDesde = iso(r.h.t); }); // o mensageiro saiu com ele e o porteiro caiu
  const p2 = criarPorteiro(r.h.opcoes); // religado
  e = estado(r.h);
  assert.deepEqual(e.repassar.map((x) => [x.pedido.providerMsgId, Boolean(x.naoAntesDe)]), [[`${r.A}-E1`, true]], 'o -E1 na nova tentativa');
  assert.equal(e.filaEntrega.length, 0);
  abaResponde(r.h, 'SC', [r.h.entregas[0]], { nome: 'repos-99', final: SO_REPASSOU });
  await p2.passoEventos();
  assert.equal(estado(r.h).entregas[r.A].respondida, true);
  assert.equal(chamado(r.h, 'SC'), undefined, '(b) o chamado da central encerrou calado');
  r.h.tg.zerar();
  await p2.esperarTelegram(15000);
  assert.deepEqual(r.h.tg.tela(), [], '(b) nada no Telegram');
  assert.doesNotMatch(textoTg(r.h), /Pedi pro porteiro/);
});

test('T7f 95h. calar poe o chamado na fila mesmo com ela vazia (o drenar da volta ja levou o entregue): a mensagem dele na tela e apagada e o chamado sai', async () => {
  const { canal, tg, e } = canalT7f();
  canal.aviso(e, parouCanal('SC'), 'Central');
  await canal.drenar(e); // 501 na tela, com botoes
  canal.falaRecebida(e, { sessionId: 'SC', fala: 'A) Sim', hora: iso(T0), messageIdDono: 77 });
  await canal.drenar(e);
  canal.entregue(e, 'SC', iso(T0));
  await canal.drenar(e);
  assert.deepEqual(e.tg.saida, [], 'a fila vazia antes do calar');
  assert.deepEqual(passosCanal(tg), [['enviar', false], ['editarBotoes', 501]]);
  tg.chamadas.length = 0;
  canal.calar(e, 'SC');
  await canal.drenar(e);
  assert.deepEqual(passosCanal(tg), [['apagar', 501]], 'a mensagem do bot na tela sai; nenhuma nova');
  assert.equal(e.tg.chamados.SC, undefined, 'o chamado saiu');
  assert.equal(e.tg.mensagens[501], undefined);
  assert.deepEqual(e.tg.saida, []);
});

test('T7f 95i. o calado do PAROU GUARDADO tambem nao e "ja foi" (o 2o lugar que cala): X voltou "erro" com o recado ja na aba e Y (encaminhada) estava em voo; o parou da central responde as duas; Y registrada = calado; X registrada depois (nova tentativa) = a resposta sai em cima de X', async () => {
  const h = montar({ respostasEntrega: [{ status: 'erro', detalhe: 'claude -p estourou o tempo' }, { status: 'enviado', detalhe: '' }] });
  aba(h, 'S1', 'Faro');
  aba(h, 'SC', CENTRAL, 'repos-99');
  ligarTg(h);
  const uX = msgTg(h, 'quantos leads entraram hoje?');
  h.tg.lotes.push([uX]);
  await h.p.esperarTelegram(15000); // X no mensageiro (o "erro" fica pro proximo passoEntrega)
  const uY = msgTg(h, 'publica o site de novo');
  h.tg.lotes.push([uY]);
  await h.p.esperarTelegram(15000); // o "erro" de X aplicado (nova tentativa); Y no mensageiro (o "enviado" fica pendente)
  let e = estado(h);
  assert.deepEqual(e.repassar.map((x) => x.pedido.providerMsgId), [pid(uX)], 'X na nova tentativa');
  assert.deepEqual(Object.keys(e.entregas), [], 'nenhuma registrada');
  h.t += 10 * 1000;
  encaminharTg(h, { providerMsgId: pid(uY) });
  // os 2 recados ja estao na aba (o de X chegou apesar do "erro"): a central repassa Y e responde X ela mesma
  const linhas = '> Telegram do Davi (12:00): «quantos leads entraram hoje?»\n> Telegram do Davi (12:00): «publica o site de novo»';
  abaResponde(h, 'SC', [h.entregas[0], h.entregas[1]], { nome: 'repos-99', final: `${linhas}\n\nHoje entraram 42 leads. O site eu passei pra Faro.` });
  await h.cru.passoEventos(); // nenhuma entrega registrada: o parou fica guardado
  assert.equal(estado(h).parouGuardado.SC.noTelegram, false);
  await bombear(h.cru); // o "enviado" de Y: registra Y e passa o parou guardado (Y repassada = calado)
  e = estado(h);
  assert.equal(e.entregas[pid(uY)].respondida, true);
  const gY = e.parouGuardado.SC; // as marcas do calado (conferidas depois do que sai na tela)
  assert.equal(chamado(h, 'SC'), undefined, 'o chamado da central encerrou calado');
  await h.p.passoGrupo(); // a nova tentativa de X: o recado ja estava na aba = registra sem reenviar e passa o parou guardado
  e = estado(h);
  assert.equal(e.entregas[pid(uX)]?.respondida, true, 'X registrada e respondida pelo mesmo parou');
  assert.equal(h.entregas.filter((p) => p.providerMsgId === pid(uX)).length, 1, 'X nao foi reenviada');
  h.tg.zerar();
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.tela(), [['enviar', false]], 'a resposta da central a X sai, com notificacao');
  const env = h.tg.de('enviar')[0].args[0];
  assert.ok(env.html.includes('Hoje entraram 42 leads.'), env.html);
  assert.equal(env.responderA, mid(uX), 'em cima da fala X');
  assert.deepEqual([gY.noTelegram, gY.caladoTg], [true, true], 'o parou guardado calado marca a parte (caladoTg)');
  assert.deepEqual([e.parouGuardado.SC.noTelegram, e.parouGuardado.SC.caladoTg], [true, false], 'depois da resposta: ja foi de verdade');
});

test('T7f 95j. foiEncaminhada ancorada no -E<n>: a central responde a fala tg-u10 e repassou a tg-u101 (-E1) = a resposta a tg-u10 sai (o -E1 de outra fala com o mesmo comeco nao conta)', async () => {
  const h = montar();
  aba(h, 'S1', 'Faro');
  aba(h, 'SC', CENTRAL, 'repos-99');
  ligarTg(h);
  h.nUpd = 9;
  const u10 = await falarTg(h, 'quantos leads entraram hoje?');
  h.nUpd = 100;
  const u101 = await falarTg(h, 'publica o site de novo');
  assert.deepEqual([pid(u10), pid(u101)], ['tg-u10', 'tg-u101']);
  h.t += 10 * 1000;
  encaminharTg(h, { providerMsgId: pid(u101) });
  await h.p.passoEventos();
  assert.equal(estado(h).entregas['tg-u101-E1']?.pedido?.encaminhado, true);
  abaResponde(h, 'SC', [h.entregas[0]], { nome: 'repos-99', final: '> Telegram do Davi (12:00): «quantos leads entraram hoje?»\n\nHoje entraram 42 leads.' });
  await h.p.passoEventos();
  assert.equal(estado(h).entregas['tg-u10'].respondida, true);
  assert.equal(chamado(h, 'SC')?.versao.estado, 'resposta', 'nao encerra calado');
  h.tg.zerar();
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.tela(), [['enviar', false]]);
  const env = h.tg.de('enviar')[0].args[0];
  assert.ok(env.html.includes('Hoje entraram 42 leads.'), env.html);
  assert.equal(env.responderA, mid(u10));
});

test('T7f 93c. o chamado respondido com a tela de uma versao anterior (o aviso novo nao saiu: o dono no PC) tambem perde os botoes: editarBotoes(501, null), a tela fica', async () => {
  const { canal, tg, e } = canalT7f();
  canal.aviso(e, parouCanal('S1'), 'Faro');
  await canal.drenar(e); // 501, com os botoes do 1o aviso
  canal.aviso(e, parouCanal('S1', 'Outra coisa.\n\n---\n🔴 **DECISÃO:** E agora? A) X (recomendado) / B) Y'), 'Faro');
  await canal.drenar(e, { modoRua: false }); // o dono no PC: o aviso novo sai da fila sem enviar; a 501 fica com os botoes do 1o
  assert.deepEqual(passosCanal(tg), [['enviar', false]]);
  const c = e.tg.chamados.S1;
  assert.notEqual(c.mensagem.versaoId, c.versao.id, 'a tela e de uma versao anterior');
  canal.falaRecebida(e, { sessionId: 'S1', fala: 'pode publicar', hora: iso(T0), messageIdDono: 80 });
  await canal.drenar(e, { modoRua: false });
  assert.deepEqual(passosCanal(tg), [['enviar', false], ['editarBotoes', 501]]);
  assert.deepEqual(tg.chamadas[1].args, [501, null], 'so os botoes saem (o texto fica, sem notificar)');
  assert.equal(e.tg.chamados.S1.mensagem.messageId, 501, 'a tela fica ate o resultado descer');
  assert.equal(e.tg.chamados.S1.tirarBotoes, undefined);
  assert.deepEqual(e.tg.saida, []);
});

test('T7f 93d. tirar os botoes: 400 (a mensagem sumiu) e adaptador sem editarBotoes saem da lista com 1 linha de log e o resultado de outra aba sai no mesmo drenar; transporte fica (falhas 1, na lista); 429 fica com pausa', async () => {
  // o aviso da aba-1 na tela (501); a fala dele em cima dela e o resultado da aba-2 no mesmo drenar
  const cena = async (o) => {
    const m = canalT7f(o);
    m.canal.aviso(m.e, parouCanal('aba-1'), 'Aba 1');
    await m.canal.drenar(m.e);
    m.canal.falaRecebida(m.e, { sessionId: 'aba-1', fala: 'vai', hora: iso(T0), messageIdDono: 90 });
    m.canal.resposta(m.e, parouCanal('aba-2', 'Rodei: 12 de 12.'), 'Aba 2', { citar: 91 });
    m.tg.chamadas.length = 0;
    m.logs.length = 0;
    m.r = await m.canal.drenar(m.e);
    return m;
  };
  const linhas501 = (m) => m.logs.filter((l) => l.startsWith('telegram aba-1') && l.includes('501'));

  // 400: sai da lista com 1 linha de log; a aba-2 sai no mesmo drenar, em cima da fala dela
  const r400 = await cena({ roteiro: { editarBotoes: [{ ok: false, erro: 'editarBotoes: Bad Request: message to edit not found', codigo: 400 }] } });
  assert.deepEqual(passosCanal(r400.tg), [['editarBotoes', 501], ['enviar', false]]);
  assert.equal(r400.tg.chamadas[1].args[0].responderA, 91);
  assert.deepEqual(linhas501(r400), ['telegram aba-1: tirar os botoes da mensagem 501 recusado (editarBotoes: Bad Request: message to edit not found); sai da lista']);
  assert.equal(r400.e.tg.chamados['aba-1'].tirarBotoes, undefined, '400: saiu da lista');
  assert.deepEqual(r400.e.tg.saida, []);
  assert.equal(r400.e.tg.saude.envioFalhaDesde, null, '400 nao e falha de transporte');

  // sem editarBotoes no adaptador: o mesmo (sem chamar nada)
  const sem = await cena({ semEditarBotoes: true });
  assert.deepEqual(passosCanal(sem.tg), [['enviar', false]]);
  assert.deepEqual(linhas501(sem), ['telegram aba-1: mensagem 501 fica com os botoes (adaptador sem editarBotoes)']);
  assert.equal(sem.e.tg.chamados['aba-1'].tirarBotoes, undefined);
  assert.deepEqual(sem.e.tg.saida, []);

  // transporte: fica (falhas 1, na lista) e a fila para; o proximo drenar tira os botoes e a aba-2 sai
  const caiu = await cena({ roteiro: { editarBotoes: [{ ok: false, erro: 'editarBotoes: socket hang up', codigo: 0 }] } });
  assert.deepEqual(passosCanal(caiu.tg), [['editarBotoes', 501]]);
  assert.deepEqual(caiu.e.tg.saida.map((i) => [i.sessionId, i.falhas]), [['aba-1', 1], ['aba-2', 0]]);
  assert.deepEqual(caiu.e.tg.chamados['aba-1'].tirarBotoes, [501], 'transporte: fica na lista');
  assert.equal(caiu.e.tg.saude.envioFalhaDesde, iso(T0));
  caiu.tg.chamadas.length = 0;
  await caiu.canal.drenar(caiu.e);
  assert.deepEqual(passosCanal(caiu.tg), [['editarBotoes', 501], ['enviar', false]]);
  assert.equal(caiu.e.tg.chamados['aba-1'].tirarBotoes, undefined);

  // 429: fica com pausa (falhas nao conta); nada sai antes da pausa; depois, o mesmo do ok
  const lim = await cena({ roteiro: { editarBotoes: [{ ok: false, erro: 'editarBotoes: Too Many Requests: retry after 7', codigo: 429, esperarS: 7 }] } });
  assert.deepEqual(passosCanal(lim.tg), [['editarBotoes', 501]]);
  assert.equal(lim.r.pausaAte, iso(T0 + 7000));
  assert.deepEqual(lim.e.tg.saida.map((i) => [i.sessionId, i.falhas]), [['aba-1', 0], ['aba-2', 0]]);
  assert.deepEqual(lim.e.tg.chamados['aba-1'].tirarBotoes, [501], '429: fica na lista');
  lim.tg.chamadas.length = 0;
  lim.relogio.t = T0 + 6000;
  await lim.canal.drenar(lim.e);
  assert.deepEqual(passosCanal(lim.tg), [], 'dentro da pausa: nada');
  lim.relogio.t = T0 + 7000;
  await lim.canal.drenar(lim.e);
  assert.deepEqual(passosCanal(lim.tg), [['editarBotoes', 501], ['enviar', false]]);
});

test('T7f 97c. problema depois do calar: a 2a fala pra central, em voo no parou que so repassou a 1a, volta "duplicado" = o problema sai com o titulo da aba (nao "sem nome"), com notificacao, em cima da fala dele', async () => {
  const h = montar({ respostasEntrega: [{ status: 'enviado', detalhe: '' }, { status: 'duplicado', detalhe: '' }] });
  aba(h, 'S1', 'Faro');
  aba(h, 'SC', CENTRAL, 'repos-99');
  ligarTg(h);
  const uA = await falarTg(h, 'publica o site de novo');
  const uB = msgTg(h, 'e roda os testes do site');
  h.tg.lotes.push([uB]);
  await h.p.esperarTelegram(15000); // B no mensageiro: o resultado fica pro proximo passoEntrega
  assert.equal(chamado(h, 'SC').versao.fala, 'e roda os testes do site', 'o chamado da central guarda a fala B');
  h.t += 10 * 1000;
  encaminharTg(h, { providerMsgId: pid(uA) });
  abaResponde(h, 'SC', [h.entregas[0]], { nome: 'repos-99', final: SO_REPASSOU });
  await h.cru.passoEventos(); // a A so repassou: o chamado da central (com a fala B) encerra calado
  assert.equal(chamado(h, 'SC'), undefined);
  await bombear(h.cru); // B volta "duplicado"
  h.tg.zerar();
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.tela(), [['enviar', false]], 'o problema sai, com notificacao');
  const env = h.tg.de('enviar')[0].args[0];
  // T22b (caso real): o chamado da central sai com o titulo da mensagem do sistema; o titulo da aba segue no
  // estado (e e por ele que o porteiro reconhece a central: sem ele sairia "ℹ️ sem nome")
  assert.ok(env.html.startsWith('<h2>🎛️ Controle de Sessões</h2>'), env.html);
  assert.equal(chamado(h, 'SC').versao.titulo, CENTRAL, 'o problema guarda o titulo da aba (nao "sem nome")');
  assert.ok(env.html.includes('Tem duas abas com o nome interno repos-99.'), env.html);
  assert.equal(env.responderA, mid(uB), 'em cima da fala dele');
  assert.deepEqual(h.enviados, [], 'nada no grupo');
});

// ---------------------------------------------------------------------------------------------------------------
// T7j (PLANO-T7.md, "T7j"; caso real: "quando eu toco no sim ou em algum lugar, ele já tem que concluir e
// some a mensagem"): o toque numa opcao responde "Anotei: <letra>. Passando pra aba." no topo da tela e a mensagem do
// chamado tocado e apagada no drenar (nao so perde os botoes); "Mais informações" fica como hoje.

test('T7j 6. porteiro: toque em opcao da tela atual -> responderToque com "Anotei: A. Passando pra aba." antes do recado e, no drenar, apagar(<tela>) sem editarBotoes(<tela>); "Mais informações" -> responderToque sem texto e a tela vira o completo (igual)', async () => {
  const h = montar();
  aba(h, 'S1', 'Faro');
  aba(h, 'S2', 'Brain', 'repos-f3');
  const tela = await chamadoNaTela(h, 'S1', 'Faro');
  ligarTg(h);
  // a entrega do recado entra na mesma linha do tempo das chamadas do Telegram
  const entregar = h.mensageiro.entregar;
  h.mensageiro.entregar = async (p) => {
    h.tg.chamadas.push({ metodo: 'entregar', args: [p.providerMsgId] });
    return entregar(p);
  };
  const q = toqueTg(h, `o:${tela.chamadoId}:0`, tela.messageId);
  h.tg.lotes.push([q]);
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.de('responderToque').map((c) => c.args), [[q.callback_query.id, 'Anotei: A. Passando pra aba.']]);
  assert.deepEqual(h.tg.tela(), [['apagar', tela.messageId]], 'a mensagem do chamado tocado sai do chat; nenhum editarBotoes');
  let c = chamado(h, 'S1');
  assert.equal(c.versao.estado, 'enviando');
  assert.equal(c.mensagem, null, 'a resposta da aba desce como mensagem nova');
  assert.equal(c.apagarJa, undefined);
  assert.equal(c.tirarBotoes, undefined);
  assert.equal(estado(h).tg.mensagens[tela.messageId], undefined);
  await bombear(h.cru);
  const ordem = h.tg.chamadas.filter((x) => ['responderToque', 'apagar', 'entregar'].includes(x.metodo)).map((x) => x.metodo);
  assert.deepEqual(ordem, ['responderToque', 'apagar', 'entregar'], 'o aviso do toque sai antes do recado');
  assert.deepEqual(h.entregas.map((p) => [p.sessionId, p.texto, p.providerMsgId]), [['S1', 'A) Sim, tudo hoje (recomendado)', pid(q)]]);
  // o "enviado" do mensageiro: entregue so no estado, nada na tela
  h.tg.zerar();
  await h.p.esperarTelegram(15000);
  assert.equal(chamado(h, 'S1').versao.estado, 'entregue');
  assert.deepEqual(h.tg.tela(), []);
  // o resultado da aba: mensagem nova com notificacao, sem apagar a tocada de novo
  abaResponde(h, 'S1', [h.entregas[0]], { final: '> Telegram do Davi (12:00): «A) Sim, tudo hoje (recomendado)»\n\nPubliquei.' });
  await h.p.passoEventos();
  h.tg.zerar();
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.tela(), [['enviar', false]], 'o resultado desce; nada mais apagado');
  c = chamado(h, 'S1');
  assert.equal(c.versao.estado, 'resposta');
  assert.equal(c.mensagem.messageId, 901);

  // "Mais informações": responde o toque sem texto e a mensagem vira o texto completo (edicao), como hoje
  const c2 = await chamadoNaTela(h, 'S2', 'Brain');
  h.tg.zerar();
  const qi = toqueTg(h, `i:${c2.chamadoId}`, c2.messageId);
  h.tg.lotes.push([qi]);
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.de('responderToque').map((x) => x.args), [[qi.callback_query.id, undefined]]);
  assert.deepEqual(h.tg.tela(), [['editar', c2.messageId]]);
  const v2 = chamado(h, 'S2').versao;
  assert.deepEqual([v2.estado, v2.completo, v2.chamadoId], ['aviso', true, c2.chamadoId]);
  assert.equal(h.entregas.length, 1, 'Mais informações nao vira pedido');
});

// ---------- T7k 6: o calado da central espera a resposta da aba de destino ----------

test('T7k 6. porteiro: a central so repassou a fala (encaminhada pra Faro, -E1) = a tela dela fica (nenhum apagar); a Faro responde o -E1 = a resposta dela sai e so depois apagar(<tela da central>); pelo parou guardado (da central e da Faro) igual', async () => {
  const { h, A, u, naTela } = await cenaCentral({ tela: true });
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.tela(), [['editarBotoes', naTela.messageId]], 'a pergunta da central perdeu os botoes');
  h.tg.zerar();
  encaminharTg(h, { providerMsgId: A });
  await h.p.passoEventos(); // o -E1 entregue na Faro
  assert.deepEqual([h.entregas[1].sessionId, h.entregas[1].providerMsgId], ['S1', `${A}-E1`]);
  abaResponde(h, 'SC', [h.entregas[0]], { nome: 'repos-99', final: SO_REPASSOU });
  await h.p.passoEventos();
  assert.equal(estado(h).entregas[A].respondida, true);
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.tela(), [], 'a tela da central fica (nenhum apagar) ate a resposta da Faro');
  const c = chamado(h, 'SC');
  assert.equal(c.versao.estado, 'calado');
  assert.equal(c.mensagem.messageId, naTela.messageId);
  assert.deepEqual(c.esperando, [A]);

  abaResponde(h, 'S1', [h.entregas[1]], { final: `${LINHA}\n\nPubliquei o site.` });
  await h.p.passoEventos();
  assert.deepEqual(chamado(h, 'S1').versao.liberar, [A], 'a resposta da Faro libera a fala de origem (sem o -E1)');
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.tela(), [['enviar', false], ['apagar', naTela.messageId]], 'a resposta da Faro sai e so depois a tela da central');
  const res = h.tg.de('enviar')[0].args[0];
  assert.ok(res.html.includes('Publiquei o site.'), res.html);
  assert.equal(res.responderA, mid(u));
  assert.equal(chamado(h, 'SC'), undefined, 'o chamado da central saiu');
  assert.equal(chamado(h, 'S1').versao.liberar, undefined);
  assert.deepEqual(h.enviados, []);

  // (b) o 2o lugar que cala (parou guardado): a central respondeu antes do "enviado" da entrega dela = a tela fica igual
  const x = montar();
  aba(x, 'S1', 'Faro');
  aba(x, 'SC', CENTRAL, 'repos-99');
  const telaX = await chamadoNaTela(x, 'SC', CENTRAL, FINAL, 'repos-99');
  ligarTg(x);
  const ux = msgTg(x, 'publica o site de novo', { respondeA: telaX.messageId });
  x.tg.lotes.push([ux]);
  await x.p.esperarTelegram(15000); // o mensageiro saiu; o resultado so e aplicado no proximo passoEntrega
  assert.equal(x.entregas.length, 1);
  x.t += 10 * 1000;
  x.tg.zerar();
  encaminharTg(x, { providerMsgId: pid(ux) });
  abaResponde(x, 'SC', [x.entregas[0]], { nome: 'repos-99', final: SO_REPASSOU });
  await x.cru.passoEventos(); // sem a entrega da central registrada: o parou fica guardado
  assert.equal(estado(x).entregas[pid(ux)], undefined);
  await bombear(x.cru); // "enviado" aplicado: registra a entrega e passa o parou guardado (so repassou = calado)
  assert.equal(estado(x).parouGuardado.SC.caladoTg, true);
  assert.deepEqual(chamado(x, 'SC').esperando, [pid(ux)], 'o calado do parou guardado tambem espera');
  await x.p.esperarTelegram(15000);
  const semBotoes = (hh) => hh.tg.tela().filter(([m]) => m !== 'editarBotoes');
  assert.deepEqual(semBotoes(x), [], 'a tela da central fica');
  const eX = x.entregas.find((p) => p.providerMsgId === `${pid(ux)}-E1`);
  assert.equal(eX?.sessionId, 'S1');
  abaResponde(x, 'S1', [eX], { final: `${LINHA}\n\nPubliquei o site.` });
  await x.p.passoEventos();
  await x.p.esperarTelegram(15000);
  assert.deepEqual(semBotoes(x), [['enviar', false], ['apagar', telaX.messageId]]);
  assert.equal(chamado(x, 'SC'), undefined);

  // (c) o 2o lugar que responde (parou guardado da aba de destino): a Faro respondeu antes do "enviado" do -E1
  const y = await cenaCentral({ tela: true });
  await y.h.p.esperarTelegram(15000);
  y.h.tg.zerar();
  encaminharTg(y.h, { providerMsgId: y.A });
  abaResponde(y.h, 'SC', [y.h.entregas[0]], { nome: 'repos-99', final: SO_REPASSOU });
  await y.h.cru.passoEventos(); // o -E1 na fila de entrega; a central calada esperando
  assert.deepEqual(chamado(y.h, 'SC').esperando, [y.A]);
  await y.h.cru.passoEntrega(); // o -E1 sai pro mensageiro; o "enviado" fica pro proximo passoEntrega
  assert.equal(y.h.entregas[1]?.providerMsgId, `${y.A}-E1`);
  abaResponde(y.h, 'S1', [y.h.entregas[1]], { final: `${LINHA}\n\nPubliquei o site.` });
  await y.h.cru.passoEventos(); // sem o -E1 registrado: o parou da Faro fica guardado
  assert.equal(estado(y.h).entregas[`${y.A}-E1`], undefined);
  await bombear(y.h.cru); // o "enviado" do -E1: registra e passa o parou guardado = resposta com o liberar
  assert.deepEqual(chamado(y.h, 'S1').versao.liberar, [y.A]);
  await y.h.p.esperarTelegram(15000);
  assert.deepEqual(y.h.tg.tela(), [['enviar', false], ['apagar', y.naTela.messageId]]);
  assert.equal(chamado(y.h, 'SC'), undefined);
});

// ---------- T7k 7 e 8: a resposta que o gancho perdeu (o parou repetido) ----------

// Resposta da aba no transcript (linha do assistant com 1 bloco text).
const falaDaAba = (texto, ts) => ({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: texto }] } });
const linhasDoLog = (h, trecho) => (fs.existsSync(h.env.SESSOES_WPP_LOG) ? fs.readFileSync(h.env.SESSOES_WPP_LOG, 'utf8') : '')
  .split('\n').filter((l) => l.includes(trecho));
const eventosDoArquivo = (h) => fs.readFileSync(path.join(h.env.SESSOES_WPP_DIR, 'eventos.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const ANTIGA = 'Pedi pro porteiro passar o seu pedido pra aba "Faro".';
const NOVA = `${LINHA}\n\nDeu certo: o site novo esta no ar.`;
const RELENDO = 'parou SC: resposta repetida com fala sem resposta; relendo a conversa em 5 s';
const DESISTI = 'parou SC: releitura sem resposta nova; desisti';
// O caso real: a central respondeu antes (finalTs F0, chave ja vista); a fala do dono pelo Telegram vai pra
// ela (entrega A), o recado entra no transcript e, 23 s depois, o gancho grava o parou de novo com o F0 (a resposta da
// vez, de 20 s depois do recado, ainda fora do arquivo). `vezes` = parou repetidos no mesmo passo.
async function cenaRepetida({ vezes = 1 } = {}) {
  const h = montar();
  aba(h, 'S1', 'Faro');
  aba(h, 'SC', CENTRAL, 'repos-99');
  ligarTg(h);
  const F0 = iso(h.t);
  transcript(h, 'SC', [falaDaAba(ANTIGA, F0)]);
  evento(h, parou(h, 'SC', { nome: 'repos-99', final: ANTIGA, finalTs: F0 }));
  await h.p.passoEventos(); // a chave SC|F0 vista
  h.t += MIN;
  const u = await falarTg(h, 'publica o site de novo');
  assert.deepEqual(h.entregas.map((p) => [p.sessionId, p.providerMsgId, p.canal]), [['SC', pid(u), 'telegram']]);
  const A = pid(u);
  h.t += 10 * 1000;
  transcript(h, 'SC', [peer(h.entregas[0], iso(h.t))]);
  const respostaTs = iso(h.t + 20 * 1000);
  h.t += 23 * 1000;
  for (let i = 0; i < vezes; i += 1) evento(h, parou(h, 'SC', { nome: 'repos-99', final: ANTIGA, finalTs: F0 }));
  const nEventos = eventosDoArquivo(h).length;
  await h.p.passoEventos();
  assert.notEqual(estado(h).entregas[A].respondida, true, 'o parou repetido nao responde a fala');
  return { h, A, u, F0, respostaTs, nEventos };
}

test('T7k 7. porteiro: parou repetido (o mesmo finalTs) com fala do Telegram entregue e sem resposta -> em 5 s a releitura acha a resposta nova no transcript -> 1 evento parou com releitura: true em eventos.jsonl (lido no mesmo passo) -> resposta no Telegram em cima da mensagem dele; 1 releitura por aba; o final = os ultimos 6000 caracteres, sem metade de par surrogate', async () => {
  const { h, A, u, F0, respostaTs, nEventos } = await cenaRepetida({ vezes: 2 });
  assert.equal(linhasDoLog(h, RELENDO).length, 1, '1 releitura por aba (2 parou repetidos)');
  evento(h, parou(h, 'SC', { nome: 'repos-99', final: ANTIGA, finalTs: F0 }));
  await h.p.passoEventos(); // um 3o com a releitura ja marcada: nada novo
  assert.equal(linhasDoLog(h, RELENDO).length, 1);
  const n0 = eventosDoArquivo(h).length;
  assert.equal(n0, nEventos + 1);

  transcript(h, 'SC', [falaDaAba(NOVA, respostaTs)]); // a resposta da vez chega no arquivo depois do gancho
  h.tg.zerar();
  h.t += 5 * 1000 - 1;
  await h.p.passoEventos();
  assert.equal(eventosDoArquivo(h).length, n0, 'antes dos 5 s nada');
  h.t += 1;
  await h.p.passoEventos();
  assert.deepEqual(eventosDoArquivo(h).slice(n0), [{
    v: 1, tipo: 'parou', at: iso(h.t), sessionId: 'SC', pid: process.pid, nome: 'repos-99', titulo: null, cwd: 'C:\\projetos',
    entrypoint: 'claude-vscode', final: NOVA, finalTs: respostaTs, marcas: lib.marcas(NOVA), releitura: true,
  }]);
  assert.equal(linhasDoLog(h, 'parou SC: releitura achou a resposta nova (tentativa 1)').length, 1);
  const e = estado(h);
  assert.equal(e.entregas[A].respondida, true, 'o evento gravado foi lido no mesmo passo');
  assert.ok(e.vistosEventos.includes(`SC|${respostaTs}`));
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.tela(), [['enviar', false]], 'a resposta desce com notificacao');
  const res = h.tg.de('enviar')[0].args[0];
  assert.ok(res.html.includes('Deu certo: o site novo esta no ar.'), res.html);
  assert.equal(res.responderA, mid(u), 'em cima da mensagem dele');
  h.t += 2 * MIN;
  await h.p.passoEventos();
  assert.equal(eventosDoArquivo(h).length, n0 + 1, 'a releitura acabou: nada mais gravado');
  assert.equal(linhasDoLog(h, 'releitura').length, 1);
  assert.deepEqual(h.enviados, []);

  // (b) resposta longa: o final = os ultimos 6000 caracteres; o par surrogate cortado ao meio sai inteiro
  const y = await cenaRepetida();
  const longa = `${LINHA}\n\n${'a'.repeat(100)}😀${'b'.repeat(5998)}?`;
  transcript(y.h, 'SC', [falaDaAba(longa, y.respostaTs)]);
  y.h.t += 5 * 1000;
  await y.h.p.passoEventos();
  const novos = eventosDoArquivo(y.h).slice(y.nEventos);
  assert.equal(novos.length, 1);
  assert.equal(novos[0].final, `${'b'.repeat(5998)}?`);
  assert.deepEqual(novos[0].marcas, { decisao: false, fica: false, pergunta: true });
  assert.equal(novos[0].finalTs, y.respostaTs);
  assert.equal(estado(y.h).entregas[y.A].respondida, true);
});

test('T7k 8. porteiro: releitura sem resposta nova -> tenta em 5, 15 e 45 s (cada espera contada da tentativa anterior), desiste com 1 log; a resposta que chega depois da 1a sai na 2a; parou repetido SEM fala pendente -> nenhuma releitura; fala respondida antes da hora -> a releitura sai calada', async () => {
  // (a) a resposta nunca chega: 3 tentativas e 1 log so
  const { h, A, nEventos } = await cenaRepetida();
  assert.equal(linhasDoLog(h, RELENDO).length, 1);
  for (const passo of [5000, 15000 - 1, 1, 45000 - 1]) {
    h.t += passo;
    await h.p.passoEventos();
    assert.equal(linhasDoLog(h, DESISTI).length, 0, `ainda nao desistiu (+${passo} ms)`);
  }
  h.t += 1; // a 3a: 45 s depois da 2a
  await h.p.passoEventos();
  assert.equal(linhasDoLog(h, DESISTI).length, 1);
  h.t += 10 * MIN;
  await h.p.passoEventos();
  assert.equal(linhasDoLog(h, DESISTI).length, 1, '1 log so');
  assert.equal(linhasDoLog(h, 'releitura achou').length, 0);
  assert.equal(eventosDoArquivo(h).length, nEventos, 'nenhum evento gravado');
  assert.notEqual(estado(h).entregas[A].respondida, true);

  // (b) a resposta chega depois da 1a tentativa: sai na 2a, 15 s depois da 1a
  const b = await cenaRepetida();
  b.h.t += 5000;
  await b.h.p.passoEventos(); // a 1a: o recado e a ultima entrada (sem resposta)
  transcript(b.h, 'SC', [falaDaAba(NOVA, b.respostaTs)]);
  b.h.t += 15000 - 1;
  await b.h.p.passoEventos();
  assert.equal(eventosDoArquivo(b.h).length, b.nEventos, 'a 2a so 15 s depois da 1a');
  b.h.t += 1;
  await b.h.p.passoEventos();
  assert.deepEqual(eventosDoArquivo(b.h).slice(b.nEventos).map((x) => [x.releitura, x.finalTs]), [[true, b.respostaTs]]);
  assert.equal(linhasDoLog(b.h, 'parou SC: releitura achou a resposta nova (tentativa 2)').length, 1);
  assert.equal(estado(b.h).entregas[b.A].respondida, true);
  assert.equal(linhasDoLog(b.h, DESISTI).length, 0);

  // (c) parou repetido SEM fala pendente (a fala ja respondida pelo parou de antes): nenhuma releitura
  const c = montar();
  aba(c, 'SC', CENTRAL, 'repos-99');
  ligarTg(c);
  const uc = await falarTg(c, 'publica o site de novo');
  c.t += 10 * 1000;
  const evc = abaResponde(c, 'SC', [c.entregas[0]], { nome: 'repos-99', final: NOVA });
  transcript(c, 'SC', [falaDaAba(NOVA, evc.finalTs)]);
  await c.p.passoEventos();
  assert.equal(estado(c).entregas[pid(uc)].respondida, true);
  c.t += 3000;
  evento(c, { ...evc, at: iso(c.t) }); // o gancho de novo, com o mesmo finalTs
  const nc = eventosDoArquivo(c).length;
  for (const passo of [0, 5000, 15000, 45000]) {
    c.t += passo;
    await c.p.passoEventos();
  }
  assert.equal(linhasDoLog(c, 'relendo a conversa').length, 0);
  assert.equal(linhasDoLog(c, 'releitura').length, 0);
  assert.equal(eventosDoArquivo(c).length, nc);

  // (d) a fala respondida antes da hora (o parou certo chegou): a releitura vencida sai calada
  const d = await cenaRepetida();
  transcript(d.h, 'SC', [falaDaAba(NOVA, d.respostaTs)]);
  d.h.t += 2000;
  evento(d.h, parou(d.h, 'SC', { nome: 'repos-99', final: NOVA, finalTs: d.respostaTs })); // o parou certo, com a chave nova
  await d.h.p.passoEventos();
  assert.equal(estado(d.h).entregas[d.A].respondida, true);
  const nd = eventosDoArquivo(d.h).length;
  for (const passo of [5000, 15000, 45000]) {
    d.h.t += passo;
    await d.h.p.passoEventos();
  }
  assert.equal(eventosDoArquivo(d.h).length, nd, 'nada gravado');
  assert.equal(linhasDoLog(d.h, 'releitura').length, 0, 'sai calada');
  assert.equal(linhasDoLog(d.h, RELENDO).length, 1);
});

// Revisao da T7k2 (o caso real): o parou repetido chegou ANTES de a entrega ser registrada. No caso real o "enviado"
// do mensageiro foi aplicado ~3 s depois de o parou repetido ser gravado; a releitura que so marca com a
// entrega ja registrada nao teria pego o caso.
test('T7k 7c. porteiro: o parou repetido chega ANTES de a entrega ser registrada (o "enviado" ainda nao aplicado) -> a releitura fica marcada mesmo assim e, em 5 s, com a entrega registrada, acha a resposta nova, que sai em cima da mensagem dele', async () => {
  const h = montar();
  aba(h, 'S1', 'Faro');
  aba(h, 'SC', CENTRAL, 'repos-99');
  ligarTg(h);
  const F0 = iso(h.t);
  transcript(h, 'SC', [falaDaAba(ANTIGA, F0)]);
  evento(h, parou(h, 'SC', { nome: 'repos-99', final: ANTIGA, finalTs: F0 }));
  await h.p.passoEventos(); // a chave SC|F0 vista
  h.t += MIN;
  const u = msgTg(h, 'Deu certo?');
  h.tg.lotes.push([u]);
  await h.p.esperarTelegram(15000); // o mensageiro saiu; o "enviado" so e aplicado no proximo passoEntrega
  assert.deepEqual(h.entregas.map((p) => [p.sessionId, p.providerMsgId]), [['SC', pid(u)]]);
  const A = pid(u);
  h.t += 10 * 1000;
  transcript(h, 'SC', [peer(h.entregas[0], iso(h.t))]);
  const respostaTs = iso(h.t + 10 * 1000);
  h.t += 13 * 1000;
  evento(h, parou(h, 'SC', { nome: 'repos-99', final: ANTIGA, finalTs: F0 })); // o gancho com a resposta anterior
  await h.cru.passoEventos(); // a entrega ainda nao registrada
  assert.equal(estado(h).entregas[A], undefined, 'o parou repetido chegou antes da entrega');
  await bombear(h.cru); // o "enviado" aplicado: a entrega registrada (o parou guardado e o de antes: nao responde)
  assert.ok(estado(h).entregas[A]);
  assert.notEqual(estado(h).entregas[A].respondida, true);
  transcript(h, 'SC', [falaDaAba(NOVA, respostaTs)]); // a resposta da vez chega no arquivo
  h.tg.zerar();
  h.t += 5 * 1000;
  await h.p.passoEventos();
  assert.equal(estado(h).entregas[A].respondida, true, 'a releitura achou a resposta');
  assert.equal(linhasDoLog(h, 'parou SC: releitura achou a resposta nova (tentativa 1)').length, 1);
  await h.p.esperarTelegram(15000);
  const res = h.tg.de('enviar')[0]?.args[0];
  assert.ok(res?.html.includes('Deu certo: o site novo esta no ar.'), JSON.stringify(res));
  assert.equal(res.responderA, mid(u), 'em cima da mensagem dele');
});

test('T7k 7d. porteiro: a entrega registrada so DEPOIS da 1a releitura (mais de 5 s depois do parou repetido) -> a 1a sai calada sem ler, a 2a (15 s depois) acha a fala pendente e a resposta nova; nenhum log de "relendo" (a fala nao estava registrada na hora)', async () => {
  const h = montar();
  aba(h, 'S1', 'Faro');
  aba(h, 'SC', CENTRAL, 'repos-99');
  ligarTg(h);
  const F0 = iso(h.t);
  transcript(h, 'SC', [falaDaAba(ANTIGA, F0)]);
  evento(h, parou(h, 'SC', { nome: 'repos-99', final: ANTIGA, finalTs: F0 }));
  await h.p.passoEventos();
  h.t += MIN;
  const u = msgTg(h, 'Deu certo?');
  h.tg.lotes.push([u]);
  await h.p.esperarTelegram(15000);
  const A = pid(u);
  h.t += 10 * 1000;
  transcript(h, 'SC', [peer(h.entregas[0], iso(h.t))]);
  const respostaTs = iso(h.t + 10 * 1000);
  h.t += 13 * 1000;
  evento(h, parou(h, 'SC', { nome: 'repos-99', final: ANTIGA, finalTs: F0 }));
  await h.cru.passoEventos(); // marcada, sem fala registrada
  const n0 = eventosDoArquivo(h).length;
  transcript(h, 'SC', [falaDaAba(NOVA, respostaTs)]);
  h.t += 5 * 1000;
  await h.cru.passoEventos(); // a 1a: a entrega ainda nao registrada = calada, sem gravar
  assert.equal(eventosDoArquivo(h).length, n0, 'a 1a sem fala registrada nao grava');
  assert.equal(estado(h).entregas[A], undefined);
  await bombear(h.cru); // o "enviado" aplicado 6 s depois do parou repetido
  assert.notEqual(estado(h).entregas[A].respondida, true);
  h.t += 15 * 1000 - 1;
  await h.p.passoEventos();
  assert.equal(eventosDoArquivo(h).length, n0, 'a 2a so 15 s depois da 1a');
  h.t += 1;
  await h.p.passoEventos();
  assert.equal(estado(h).entregas[A].respondida, true);
  assert.equal(linhasDoLog(h, 'parou SC: releitura achou a resposta nova (tentativa 2)').length, 1);
  assert.equal(linhasDoLog(h, 'relendo a conversa').length, 0);
  await h.p.esperarTelegram(15000);
  assert.equal(h.tg.de('enviar')[0]?.args[0]?.responderA, mid(u));
});
