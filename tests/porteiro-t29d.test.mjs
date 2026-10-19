// Testes da T29d no porteiro (PLANO-TELEGRAM.md, "T29d"; pedido do dono 18/10/2026 19:04, audio no Telegram: «teria que
// ser uma busca dentro da mensagem [...] uma função de buscar alguma palavra dentro daquela própria mensagem»): o painel
// ganha o "Buscar" (p:b); o toque manda "Qual palavra?" com resposta forcada; a resposta a ela (ou "/buscar <palavra>")
// edita o painel so com as abas que batem, com o "Limpar busca" (p:l); a pergunta e a palavra saem do chat nos 2 modos; o
// filtro fica no painel vivo ate o Limpar, um /painel ou 15 min sem uso; a pergunta sem resposta sai em 15 min; outra
// mensagem = o roteamento de hoje; a palavra nunca vai pro log nem pra aba. Por que existe: a lupa do Telegram nao busca
// dentro do balao do painel.
// Isolamento: pastas temporarias (prefixo "t29d-") via SESSOES_WPP_DIR, CLAUDE_SESSIONS_DIR, CLAUDE_PROJECTS_DIR e
// SESSOES_WPP_LOG; nunca o ~/.claude real nem o config.json real. Nenhuma rede: o `tg` e um duble. Relogio e `dormir`
// falsos. Harness copiado do tests/porteiro-t29c.test.mjs (sem importar de outro teste).
// Rodar: node --test --test-reporter=tap "tests/porteiro-t29d.test.mjs"
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

// ---------- harness (copia do tests/porteiro-t29c.test.mjs) ----------

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
  const raiz = pastaTemp('t29d-');
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

// ---------- T29d ----------

const BUSCAR = [[{ texto: 'Buscar', dados: 'p:b' }]];
const LIMPAR = [[{ texto: 'Limpar busca', dados: 'p:l' }]];
const PERGUNTA = { classico: 'Qual palavra?', respostaForcada: 'nome da aba ou palavra', silencioso: true };
const TRAVADO = 'Travado. Destrava no PC.';
const edicoes = (h, id) => h.tg.de('editar').filter((c) => c.args[0] === id).map((c) => c.args[1]);
const toques = (h) => h.tg.de('responderToque').map((c) => c.args[1]);
const temLog = (h, x) => logs(h).some((l) => l.endsWith(x));

// 2 abas (uma com a palavra no nome) e o /painel na tela. Devolve o id do painel.
async function comPainel(h, { manter = false } = {}) {
  aba(h, 'S1', 'Zimbabue projeto');
  aba(h, 'S2', 'Planilha');
  ligarTg(h);
  if (manter) await comando(h, '/modo');
  h.tg.zerar();
  await lerTg(h, [msgTg(h, '/painel')]);
  const p = h.tg.de('enviar').find((c) => String(c.args[0].html).includes('Abas abertas'));
  assert.ok(p, JSON.stringify(h.tg.chamadas.map((c) => c.metodo)));
  assert.deepEqual(p.args[0].botoes, BUSCAR, 'o painel sai com o Buscar');
  return p.id;
}
// O toque no Buscar ate a pergunta sair. Devolve o id da pergunta.
async function tocarBuscar(h, painel) {
  h.tg.zerar();
  await lerTg(h, [toqueTg(h, 'p:b', painel)]);
  const q = h.tg.de('enviar').find((c) => c.args[0].classico === 'Qual palavra?');
  assert.ok(q, JSON.stringify(h.tg.chamadas.map((c) => c.metodo)));
  assert.deepEqual(q.args[0], PERGUNTA);
  assert.deepEqual(toques(h), [undefined], 'o toque responde sem frase');
  return q.id;
}

test('T29d 1. toque no Buscar -> pergunta com resposta forcada; a resposta -> o painel EDITADO so com as que batem e o Limpar; as 2 mensagens saem; nada vai pra aba; a palavra fora do log', async () => {
  const h = montar();
  const painel = await comPainel(h);
  const pergunta = await tocarBuscar(h, painel);
  assert.equal(h.entregas.length, 0);
  const antes = logs(h).length;
  const u = msgTg(h, 'ZIMBABUE', { respondeA: pergunta });
  h.tg.zerar();
  await lerTg(h, [u]);
  const [ed] = edicoes(h, painel);
  assert.ok(ed, JSON.stringify(h.tg.chamadas.map((c) => [c.metodo, c.args[0]])));
  assert.ok(ed.html.startsWith('<h3>Busca: «ZIMBABUE» (1 aba)</h3>') && ed.html.includes('Zimbabue projeto') && !ed.html.includes('Planilha'), ed.html);
  assert.deepEqual(ed.botoes, LIMPAR);
  assert.equal(h.tg.de('enviar').length, 0, 'sem mensagem nova (nem linha do sistema)');
  assert.deepEqual(apagadas(h).sort(), [pergunta, mid(u)].sort(), 'a pergunta e a palavra saem do chat');
  assert.equal(h.entregas.length, 0, 'a palavra nao vai pra aba nenhuma nem pra central');
  const novos = logs(h).slice(antes);
  assert.ok(novos.some((l) => l.endsWith('painel: busca com 1 abas')), novos.join('\n'));
  assert.ok(!novos.join('\n').toLowerCase().includes('zimbab'), 'a palavra nunca vai pro log');
  // Limpar busca: o painel inteiro e o Buscar de volta
  h.tg.zerar();
  await lerTg(h, [toqueTg(h, 'p:l', painel)]);
  const [ed2] = edicoes(h, painel);
  assert.ok(ed2 && ed2.html.includes('Abas abertas') && ed2.html.includes('Planilha'), JSON.stringify(ed2));
  assert.deepEqual(ed2.botoes, BUSCAR);
  assert.deepEqual(toques(h), [undefined]);
  assert.ok(temLog(h, 'painel: busca limpa'));
});

test('T29d 2. "/buscar <palavra>" digitado = a mesma busca (a mensagem sai); "/buscar" sozinho = a pergunta; sem painel na tela = o painel filtrado como mensagem nova', async () => {
  const h = montar();
  const painel = await comPainel(h);
  const u = msgTg(h, '/buscar planilha');
  h.tg.zerar();
  await lerTg(h, [u]);
  const [ed] = edicoes(h, painel);
  assert.ok(ed && ed.html.startsWith('<h3>Busca: «planilha» (1 aba)</h3>'), JSON.stringify(ed));
  assert.deepEqual(apagadas(h), [mid(u)]);
  assert.equal(h.entregas.length, 0);
  h.tg.zerar();
  await lerTg(h, [msgTg(h, '/buscar')]);
  assert.ok(h.tg.de('enviar').some((c) => c.args[0].classico === 'Qual palavra?'), 'a pergunta');
  // sem painel na tela
  const k = montar();
  aba(k, 'S1', 'Zimbabue projeto');
  ligarTg(k);
  k.tg.zerar();
  await lerTg(k, [msgTg(k, '/buscar zimbabue')]);
  const nova = k.tg.de('enviar').find((c) => String(c.args[0].html).startsWith('<h3>Busca: «zimbabue» (1 aba)</h3>'));
  assert.ok(nova, JSON.stringify(k.tg.chamadas.map((c) => [c.metodo, c.args[0]])));
  assert.deepEqual(nova.args[0].botoes, LIMPAR);
});

test('T29d 3. o painel vivo mantem o filtro; 15 min sem uso = volta ao inteiro; /painel novo = inteiro', async () => {
  const h = montar();
  const painel = await comPainel(h);
  await lerTg(h, [msgTg(h, '/buscar zimbabue')]);
  aba(h, 'S3', 'Zimbabue site');
  h.t += MIN;
  h.tg.zerar();
  await h.p.esperarTelegram(1500);
  const vivo = edicoes(h, painel).at(-1);
  assert.ok(vivo && vivo.html.startsWith('<h3>Busca: «zimbabue» (2 abas)</h3>'), JSON.stringify(vivo));
  assert.deepEqual(vivo.botoes, LIMPAR);
  h.t += 15 * MIN;
  h.tg.zerar();
  await h.p.esperarTelegram(1500);
  const volta = edicoes(h, painel).at(-1);
  assert.ok(volta && volta.html.includes('Abas abertas') && volta.html.includes('Planilha'), JSON.stringify(volta));
  assert.deepEqual(volta.botoes, BUSCAR);
  assert.ok(temLog(h, 'painel: busca limpa'));
  // /painel novo volta ao inteiro
  await lerTg(h, [msgTg(h, '/buscar planilha')]);
  h.tg.zerar();
  await lerTg(h, [msgTg(h, '/painel')]);
  const outro = h.tg.de('enviar').find((c) => String(c.args[0].html).includes('Abas abertas'));
  assert.ok(outro && outro.args[0].html.includes('Zimbabue'), 'o painel novo e o inteiro');
  assert.deepEqual(outro.args[0].botoes, BUSCAR);
});

test('T29d 4. pergunta sem resposta em 15 min sai e nada muda; mensagem que nao responde a pergunta = o roteamento de hoje', async () => {
  const h = montar();
  const painel = await comPainel(h);
  const pergunta = await tocarBuscar(h, painel);
  // outra mensagem (sem citar a pergunta) com ela aberta: nao vira busca
  h.tg.zerar();
  await lerTg(h, [msgTg(h, 'Zimbabue projeto: pode seguir')]);
  await bombear(h.cru);
  assert.equal(edicoes(h, painel).length, 0, 'o painel nao mudou');
  assert.equal(h.entregas.at(-1)?.sessionId, 'S1', 'foi pra aba pelo roteamento de hoje');
  assert.equal(estado(h).tg.painel.pergunta.messageId, pergunta, 'a pergunta segue aberta');
  // 15 min: a pergunta sai e nada muda
  h.t += 15 * MIN;
  h.tg.zerar();
  await h.p.esperarTelegram(1500);
  assert.deepEqual(apagadas(h), [pergunta]);
  assert.equal(edicoes(h, painel).length, 0);
  assert.ok(temLog(h, 'painel: pergunta da busca sem resposta em 15 min; sai'));
  // a resposta em cima da pergunta vencida = o roteamento de hoje (nao edita o painel)
  h.tg.zerar();
  await lerTg(h, [msgTg(h, 'planilha', { respondeA: pergunta })]);
  assert.ok(!edicoes(h, painel).some((x) => x.html.includes('Busca:')), 'nao vira busca');
});

test('T29d 5. no modo manter a pergunta e a palavra saem do chat tambem; travado = a frase da trava e nada', async () => {
  const h = montar();
  const painel = await comPainel(h, { manter: true });
  assert.equal(cfg(h).telegram?.resolvidas, 'manter');
  const pergunta = await tocarBuscar(h, painel);
  const u = msgTg(h, 'planilha', { respondeA: pergunta });
  h.tg.zerar();
  await lerTg(h, [u]);
  assert.deepEqual(apagadas(h).sort(), [pergunta, mid(u)].sort());
  assert.ok(edicoes(h, painel).at(-1).html.startsWith('<h3>Busca: «planilha» (1 aba)</h3>'));
  await lerTg(h, [msgTg(h, 'trava')]);
  h.tg.zerar();
  await lerTg(h, [toqueTg(h, 'p:l', painel)]);
  assert.deepEqual(toques(h), [TRAVADO]);
  assert.equal(edicoes(h, painel).length, 0);
});
