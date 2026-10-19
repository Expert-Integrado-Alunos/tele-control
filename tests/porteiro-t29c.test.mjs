// Testes da T29c no porteiro (PLANO-TELEGRAM.md, "T29c"; pedido do dono 18/10/2026 19:04, audio no Telegram: «quando
// eu clico em mais informações, ele expande [...] eu queria que tivesse um botão de comprimir de volta, a não ser quando
// tem um botão de pergunta e resposta, que daí eu sou obrigado a apertar»): o aberto sem botao de resposta ganha o
// "Menos informações" (m:<ID>), que volta a mesma mensagem pro compacto por edicao, sem notificar e sem ida ate a aba;
// com opcao, como hoje; toque velho = "Essa pergunta já mudou."; travado = a frase da trava. Vale no aviso/resposta e na
// situacao (inclusive a de aba trabalhando, T16). Por que existe: antes o aberto nao tinha volta.
// Isolamento: pastas temporarias (prefixo "t29c-") via SESSOES_WPP_DIR, CLAUDE_SESSIONS_DIR, CLAUDE_PROJECTS_DIR e
// SESSOES_WPP_LOG; nunca o ~/.claude real nem o config.json real. Nenhuma rede: o `tg` e o transcrever sao dubles.
// Relogio e `dormir` falsos. Harness copiado do tests/porteiro-t29b.test.mjs (sem importar de outro teste).
// Rodar: node --test --test-reporter=tap "tests/porteiro-t29c.test.mjs"
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
import { dadosBotao } from '../lib/formato-tg.mjs';

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
const MENU_6 = [
  { command: 'painel', description: 'Painel das abas' },
  { command: 'rua', description: 'Tô na rua' },
  { command: 'voltei', description: 'Voltei pro PC' },
  { command: 'voz', description: 'Resposta por voz: ligar ou desligar' },
  { command: 'modo', description: 'Mensagens: limpo ou manter tudo' },
  { command: 'central', description: 'Reabrir a central (atende o que não é de uma aba)' },
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

// ---------- harness (copia do tests/porteiro-t29b.test.mjs) ----------

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
  const raiz = pastaTemp('t29c-');
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
// A linha do sistema com `frase`, em cima do comando `u`
const linha = (h, frase, u) => h.tg.de('enviar').some((c) => String(c.args[0].html).includes(frase) && c.args[0].responderA === mid(u));
const linhas = (h) => JSON.stringify(h.tg.de('enviar').map((c) => [c.args[0].responderA, c.args[0].html]));

// ---------- T29c ----------

const LONGO = 'Publiquei o site.\n\nO deploy levou 2 min e o cache foi limpo.\n\nTudo conferido no ar.'; // com "Mais informações"
const NADA = { decisao: false, fica: false, pergunta: false };
const FINAL_MEIO = 'Achei a causa: o campo estava com o nome velho.\n\n---\n🔴 **DECISÃO:** Sigo assim? A) Sim (recomendado) / B) Não';
const MENOS = (id) => [[{ texto: 'Menos informações', dados: `m:${id}` }]];
const MAIS = (id) => [[{ texto: 'Mais informações', dados: `i:${id}` }]];
// Textos do contrato (por extenso de proposito: o teste prende o texto)
const VELHO = 'Essa pergunta já mudou.';
const TRAVADO = 'Travado. Destrava no PC.';
const RECOLHIDO = 'S1 resposta: recolhido (compacto)';
const RECOLHIDA = 'situacao: recolhida (compacto)';

// A leitura curta (1,5 s de relogio): o lote e tratado na hora exata do h.t
async function lerCurto(h, updates) {
  h.tg.lotes.push(updates);
  await h.p.esperarTelegram(1500);
}
const enviadaEm = (h, id) => Date.parse(estado(h).tg.mensagens[id].at);
const toques = (h) => h.tg.de('responderToque').map((c) => c.args[1]);
const edicoes = (h, id) => h.tg.de('editar').filter((c) => c.args[0] === id).map((c) => c.args[1]);
const menos = (id) => dadosBotao({ chamadoId: id, acao: 'menos' });
const mais = (id) => dadosBotao({ chamadoId: id, acao: 'informacoes' });
function registroDe(h, sid) {
  return fs.readdirSync(h.env.CLAUDE_SESSIONS_DIR).map((n) => path.join(h.env.CLAUDE_SESSIONS_DIR, n))
    .find((a) => JSON.parse(fs.readFileSync(a, 'utf8')).sessionId === sid);
}
function mudarStatus(h, sid, status) {
  const a = registroDe(h, sid);
  fs.writeFileSync(a, JSON.stringify({ ...JSON.parse(fs.readFileSync(a, 'utf8')), status }));
}
const falaDaAba = (texto, ts) => ({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: texto }] } });
const pedidoNaAba = (texto, ts) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: texto } });

// Audio X dele -> a aba responde com `final` em cima de X. Devolve {x, tela, voz}.
async function respostaCom(h, tr, final, marcas, { sid = 'S1', titulo = 'Faro' } = {}) {
  aba(h, sid, titulo);
  const tela0 = await chamadoNaTela(h, sid, titulo);
  ligarTg(h);
  await ligarRua(h);
  const a = audioTg(h, { respondeA: tela0 });
  await audioTranscrito(h, tr, a, { ok: true, texto: 'Pode publicar.' });
  await h.p.esperarTelegram(15000);
  await bombear(h.cru);
  abaResponde(h, sid, [h.entregas.at(-1)], { final, marcas });
  await h.p.passoEventos();
  h.tg.zerar();
  await h.p.esperarTelegram(15000);
  const x = mid(a);
  const [resp] = h.tg.de('enviar').filter((c) => c.args[0].responderA === x);
  assert.ok(resp, `a resposta saiu: ${JSON.stringify(h.tg.chamadas.map((c) => c.metodo))}`);
  return { x, tela: resp.id, voz: h.tg.de('enviarVoz')[0]?.id ?? null };
}

// A aba S1 trabalhando com texto desta vez (opcoes em texto, T16) e a situacao dela pedida pelo painel. Devolve {id, tela}.
async function situacaoTrabalhando(h) {
  aba(h, 'S1', 'Aula');
  ligarTg(h);
  transcript(h, 'S1', [pedidoNaAba('pode seguir', iso(h.t - 2 * MIN)), falaDaAba(FINAL_MEIO, iso(h.t - MIN))]);
  mudarStatus(h, 'S1', 'busy');
  h.tg.zerar();
  await lerTg(h, [msgTg(h, '/start a_S1')]);
  const s = estado(h).tg.situacao;
  assert.equal(s.dados.trabalhando, true);
  assert.deepEqual(h.tg.de('enviar').at(-1).args[0].botoes, MAIS(s.chamadoId), 'T16: so o "Mais informações"');
  return { id: s.chamadoId, tela: s.mensagem.messageId };
}

test('T29c P1. toque real: "Mais informações" abre com o "Menos informações"; o "Menos" volta a MESMA mensagem pro compacto por edicao (sem notificar, sem ida ate a aba) com o "Mais" de volta; abre e fecha de novo; 1 log sem texto', async () => {
  const tr = dubleTranscrever();
  const h = montar({ canalPrincipal: 'telegram', transcrever: tr.fn, resolvidasTg: 'manter' });
  const r = await respostaCom(h, tr, LONGO, NADA);
  const id = chamado(h, 'S1').versao.chamadoId;
  const entregas = h.entregas.length;
  for (let volta = 0; volta < 3; volta += 1) {
    h.tg.zerar();
    await lerCurto(h, [toqueTg(h, mais(id), r.tela)]);
    let ed = edicoes(h, r.tela);
    assert.equal(ed.length, 1, `volta ${volta}: abriu ${JSON.stringify(h.tg.chamadas.map((c) => c.metodo))}`);
    assert.deepEqual(ed[0].botoes, MENOS(id), 'aberto sem opcao: o "Menos informações"');
    assert.ok(ed[0].html.includes('Tudo conferido no ar.'), 'o texto inteiro');
    h.tg.zerar();
    await lerCurto(h, [toqueTg(h, menos(id), r.tela)]);
    ed = edicoes(h, r.tela);
    assert.equal(ed.length, 1, `volta ${volta}: recolheu ${JSON.stringify(h.tg.chamadas.map((c) => c.metodo))}`);
    assert.deepEqual(ed[0].botoes, MAIS(id), 'o "Mais informações" de volta');
    assert.ok(!ed[0].html.includes('Tudo conferido no ar.'), 'compacto');
    assert.equal(h.tg.de('enviar').length, 0, 'nada novo no chat (sem notificar)');
    assert.deepEqual(h.tg.de('apagar'), [], 'nada sai');
    assert.deepEqual(toques(h), [undefined], 'o toque responde sem frase');
    assert.equal(h.entregas.length, entregas, 'nada vai pra aba');
    const v = chamado(h, 'S1').versao;
    assert.equal(v.completo, false);
    assert.equal(v.chamadoId, id, 'mesmo chamadoId');
  }
  assert.equal(logs(h).filter((l) => l.endsWith(RECOLHIDO)).length, 3, logs(h).join('\n'));
  assert.ok(!logs(h).some((l) => l.includes('Publiquei') || l.includes('Tudo conferido')), 'log sem texto');
});

test('T29c P2. toque velho no "Menos informações" (ja compacta, outro chamadoId, outra mensagem, chamado novo) = "Essa pergunta já mudou." e a tela nao muda', async () => {
  const tr = dubleTranscrever();
  const h = montar({ canalPrincipal: 'telegram', transcrever: tr.fn, resolvidasTg: 'manter' });
  const r = await respostaCom(h, tr, LONGO, NADA);
  const id = chamado(h, 'S1').versao.chamadoId;
  h.tg.zerar();
  await lerCurto(h, [toqueTg(h, menos(id), r.tela)]);
  assert.deepEqual(toques(h), [VELHO], 'ja compacta');
  assert.deepEqual(h.tg.de('editar'), []);
  await lerCurto(h, [toqueTg(h, mais(id), r.tela)]);
  assert.equal(chamado(h, 'S1').versao.completo, true);
  h.tg.zerar();
  await lerCurto(h, [toqueTg(h, menos('ZZZZZZZZ'), r.tela), toqueTg(h, menos(id), r.tela + 999)]);
  assert.deepEqual(toques(h), [VELHO, VELHO], 'outro chamadoId; outra mensagem');
  assert.deepEqual(h.tg.de('editar'), []);
  assert.equal(chamado(h, 'S1').versao.completo, true, 'continua aberto');
  // a aba parou de novo: chamado novo; o m: do velho = toque velho
  abaResponde(h, 'S1', [], { final: LONGO, marcas: NADA });
  await h.p.passoEventos();
  await h.p.esperarTelegram(15000);
  assert.notEqual(chamado(h, 'S1').versao.chamadoId, id);
  h.tg.zerar();
  await lerCurto(h, [toqueTg(h, menos(id), r.tela)]);
  assert.deepEqual(toques(h), [VELHO], 'chamado novo');
  assert.ok(!logs(h).some((l) => l.endsWith(RECOLHIDO)), logs(h).join('\n'));
});

test('T29c P3. aberto COM opcao: sem o "Menos informações" (ele responde tocando); o m: forjado = "Essa pergunta já mudou." e a tela fica aberta', async () => {
  const tr = dubleTranscrever();
  const h = montar({ canalPrincipal: 'telegram', transcrever: tr.fn, resolvidasTg: 'manter' });
  const r = await respostaCom(h, tr, FINAL_T23, DECISAO);
  const id = chamado(h, 'S1').versao.chamadoId;
  h.tg.zerar();
  await lerCurto(h, [toqueTg(h, mais(id), r.tela)]);
  const [ed] = edicoes(h, r.tela);
  assert.ok(ed, 'abriu');
  assert.deepEqual(ed.botoes.flat().map((b) => b.dados), [`o:${id}:0`, `o:${id}:1`], 'so as opcoes');
  h.tg.zerar();
  await lerCurto(h, [toqueTg(h, menos(id), r.tela)]);
  assert.deepEqual(toques(h), [VELHO]);
  assert.deepEqual(h.tg.de('editar'), []);
  assert.equal(chamado(h, 'S1').versao.completo, true);
});

test('T29c P4. situacao de aba trabalhando (so o "Mais informações", T16): abre com o "Menos informações" e fecha por edicao, sem ir pra aba; toque velho depois = "Essa pergunta já mudou."', async () => {
  const h = montar({ resolvidasTg: 'manter' });
  const { id, tela } = await situacaoTrabalhando(h);
  for (let volta = 0; volta < 2; volta += 1) {
    h.tg.zerar();
    await lerCurto(h, [toqueTg(h, mais(id), tela)]);
    assert.deepEqual(edicoes(h, tela).map((x) => x.botoes), [MENOS(id)], `volta ${volta}`);
    h.tg.zerar();
    await lerCurto(h, [toqueTg(h, menos(id), tela)]);
    const ed = edicoes(h, tela);
    assert.equal(ed.length, 1, JSON.stringify(h.tg.chamadas.map((c) => c.metodo)));
    assert.deepEqual(ed[0].botoes, MAIS(id));
    assert.ok(ed[0].html.includes('A) Sim (recomendado) / B) Não'), 'compacta: as opcoes em texto');
    assert.deepEqual(toques(h), [undefined]);
    assert.equal(h.tg.de('enviar').length, 0);
    assert.equal(estado(h).tg.situacao.completo, false);
  }
  assert.equal(h.entregas.length, 0, 'nada vai pra aba');
  assert.equal(logs(h).filter((l) => l.endsWith(RECOLHIDA)).length, 2, logs(h).join('\n'));
  assert.ok(!logs(h).some((l) => l.includes('Achei a causa')), 'log sem texto');
  h.tg.zerar();
  await lerCurto(h, [toqueTg(h, menos(id), tela)]);
  assert.deepEqual(toques(h), [VELHO], 'ja compacta');
  assert.deepEqual(h.tg.de('editar'), []);
});

test('T29c P5. travado: o toque no "Menos informações" = a frase da trava e nada muda', async () => {
  const tr = dubleTranscrever();
  const h = montar({ canalPrincipal: 'telegram', transcrever: tr.fn, resolvidasTg: 'manter' });
  const r = await respostaCom(h, tr, LONGO, NADA);
  const id = chamado(h, 'S1').versao.chamadoId;
  await lerCurto(h, [toqueTg(h, mais(id), r.tela)]);
  assert.equal(chamado(h, 'S1').versao.completo, true);
  mexer(h, (e) => { e.trava = true; });
  h.tg.zerar();
  await lerCurto(h, [toqueTg(h, menos(id), r.tela)]);
  assert.deepEqual(toques(h), [TRAVADO]);
  assert.deepEqual(h.tg.de('editar'), []);
  assert.equal(chamado(h, 'S1').versao.completo, true, 'continua aberto');
  assert.ok(!logs(h).some((l) => l.endsWith(RECOLHIDO)), logs(h).join('\n'));
});

test('T29c P6. T29b no limpo: o toque no "Menos informações" aos 61 s nao apaga a propria mensagem naquele passo (ela volta pro compacto); a interacao seguinte (5 s depois) a tira', async () => {
  const tr = dubleTranscrever();
  const h = montar({ canalPrincipal: 'telegram', transcrever: tr.fn });
  const r = await respostaCom(h, tr, LONGO, NADA);
  const t0 = enviadaEm(h, r.tela);
  const id = chamado(h, 'S1').versao.chamadoId;
  h.t = t0 + 30 * 1000;
  await lerCurto(h, [toqueTg(h, mais(id), r.tela)]);
  assert.equal(chamado(h, 'S1').versao.completo, true);
  h.t = t0 + 61 * 1000;
  h.tg.zerar();
  await lerCurto(h, [toqueTg(h, menos(id), r.tela)]);
  assert.deepEqual(edicoes(h, r.tela).map((x) => x.botoes), [MAIS(id)], 'recolheu');
  assert.ok(!h.tg.de('apagar').some((c) => c.args[0] === r.tela), 'a do proprio toque fica nesse passo');
  h.t += 5000;
  await lerCurto(h, [toqueTg(h, 'o:ZZZZZZZZ:0', 1)]);
  assert.ok(h.tg.de('apagar').some((c) => c.args[0] === r.tela), 'sai na interacao seguinte (o "Menos" nao renovou a hora)');
});
