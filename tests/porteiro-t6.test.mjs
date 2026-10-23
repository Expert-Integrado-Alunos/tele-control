// Testes da T6 (PLANO-TELEGRAM.md, "T6 — sessão nova pelo Telegram"; pedido do dono: "Continua e
// termina tudo o que faltou [...] pra eu poder controlar do WhatsApp e do Telegram"). Antes: a fala do Telegram nunca
// abria sessao nova (o abrirSessao so procurava a fala no grupo: o id `tg-u...` dava "Não achei a mensagem" no grupo).
// Agora o abrirSessao faz o caminho do `encaminhar` (T3c): fala do `recebidas`, item e pedido com `canal: 'telegram'`,
// frases na linha do sistema do Telegram (em cima da fala dele), o nome calado (T7f: so o resultado) e a central que so
// pediu a sessao nova calada (F8).
// - T6 1 a 3b: feliz, a resposta da sessao nova volta pelo Telegram, so o resultado (o calado e so da fala do pedido).
// - T6 4 a 7: fala que nao vale, guardas, retry, pasta/abridor/prazo.
// - T6 8 e 9: Telegram desligado e regressao do WhatsApp (F4f) com o Telegram ligado.
// - T6 10 a 12: o nome que nao pegou, o estado no disco (porteiro religado), audio e anexo.
// - T6 13: as instrucoes da central (item 16) e da sessao escondida.
// - T6 14: sem o abridor escondido (o caminho do VS Code, F4b/F4c): canal no item e no pedido, frases no Telegram.
// Isolamento: pastas temporarias via SESSOES_WPP_DIR, CLAUDE_SESSIONS_DIR, CLAUDE_PROJECTS_DIR e SESSOES_WPP_LOG (nunca o
// ~/.claude real); raizes de mentira (repos e Area) dentro da pasta temporaria. Nenhuma rede: `tg`, `wpp`,
// mensageiro e o abridor da sessao escondida sao dubles. Relogio e `dormir` falsos. Harness copiado do
// tests/porteiro-t7f.test.mjs + os dubles da F4f do tests/porteiro.test.mjs.
// Rodar: node --test --test-reporter=tap "tests/porteiro-t6.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { criarPorteiro } from '../porteiro.mjs';
import { NUMERO_DONO } from './lib/dados-whatsapp.mjs';
import { CENTRAL_TESTE } from './lib/dados-central.mjs';
import { montarRecado } from '../mensageiro.mjs';

const require = createRequire(import.meta.url);
const lib = require('../hooks/lib/sessoes-wpp.js');
const PORTEIRO = fileURLToPath(new URL('../porteiro.mjs', import.meta.url));

const MIN = 60 * 1000;
const T0 = Date.parse('2026-09-29T15:00:00Z'); // 12:00 em Brasilia
const iso = (ms) => new Date(ms).toISOString();
const DONO = 700100200;
const BOT = 700900800;
const CAB = '🎛️ *Controle de sessões*';

const NOME = 'Revisão Porteiro';
const FALA = 'abre uma sessão pra revisar o porteiro';
const LINHA = `> Telegram do Davi (12:00): «${FALA}»`;
// Frases do porteiro sem o cabecalho (como saem na linha do sistema do Telegram), por extenso de proposito.
const TXT6 = {
  naoAcheiMsg: `Não achei a mensagem pra passar pra ${NOME}.`,
  jaPassada: `Essa mensagem já foi passada pra ${NOME}.`,
  pastaRecusada: `Não abri a sessão ${NOME}: a pasta não existe ou fica fora de repos e Area.`, // A3a: os nomes das pastas do config
  escFalhou: `Não consegui abrir a sessão ${NOME} no PC.`,
  escNaoAbriu: `Não consegui abrir a sessão ${NOME} no PC: ela não apareceu em 3 min.`,
  aberta: (p) => `Abri a sessão ${NOME} em ${p} e passei o seu pedido.`,
  semNome: (p) => `Abri a sessão ${NOME} em ${p} e passei o seu pedido. O nome não pegou; renomeie no PC.`,
  // o caminho do VS Code (sem o abridor escondido)
  vsFalhou: `Não consegui abrir o VS Code pra sessão ${NOME}.`,
  jaAberta: (p) => `Não abri a sessão ${NOME}: ${p} já está aberta numa janela do VS Code. Abre a aba nova nela no PC.`,
  vsNaoAbriu: `Não consegui abrir a sessão ${NOME}: o VS Code não mostrou a aba nova em 3 min.`,
};
const CURTA = 'repos\\sessoes-wpp';
const DECISAO = { decisao: true, fica: false, pergunta: false };

// ---------- harness (copia do tests/porteiro-t7f.test.mjs + os dubles da F4f) ----------

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
    passoSessoes: async () => { await cru.passoSessoes(); await bombear(cru); },
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

// Duble do criarTelegram. enviar devolve 900 + n.
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

// Porteiro com o Telegram (ou sem: `tg: false`) e o modo escondido da F4f: raizes de mentira (repos e Area) e o
// duble do abridor (`h.escondidas` = chamadas; `falha` = rejeita). O VS Code nunca entra (`h.vsCode` anota). `h.leituras`
// = leituras do grupo. `vsCode` = sem o abridor escondido (o caminho do VS Code): foto das janelas (`h.janelas`; abrir poe
// a janela nova, `h.janelaAoAbrir` = 'nova' ou null = a pasta ja tinha janela), `h.vsFalha` = o abrir rejeita, `h.links`.
function montarT6({ tg: comTg = true, falha = null, vsCode = false } = {}) {
  const raiz = pastaTemp('porteiro-t6-');
  const env = {
    SESSOES_WPP_DIR: path.join(raiz, 'estado'),
    CLAUDE_SESSIONS_DIR: path.join(raiz, 'sessions'),
    CLAUDE_PROJECTS_DIR: path.join(raiz, 'projects'),
    SESSOES_WPP_LOG: path.join(raiz, 'porteiro.log'),
  };
  for (const d of [env.SESSOES_WPP_DIR, env.CLAUDE_SESSIONS_DIR, env.CLAUDE_PROJECTS_DIR]) fs.mkdirSync(d, { recursive: true });
  const repos = path.join(raiz, 'repos');
  const workspace = path.join(raiz, 'Meus Docs', 'trabalho', 'Area');
  for (const d of [path.join(repos, 'sessoes-wpp'), path.join(workspace, 'Comercial'), path.join(raiz, 'fora')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const h = {
    raiz, env, t: T0, idle: 0, grupo: [], enviados: [], reacoes: [], entregas: [], nReg: 0, nMsg: 0, nUpd: 100, nMid: 7000,
    aberturas: 0, dormidas: [], leituras: 0, repos, workspace, pasta: path.join(repos, 'sessoes-wpp'), escondidas: [],
    escFalha: falha, vsCode: [],
  };
  h.abrirCentral = () => { h.aberturas += 1; };
  let seq = 0;
  h.wpp = {
    async lerGrupo(limit) { h.leituras += 1; return h.grupo.slice(-limit); },
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
  h.tg = comTg ? dubleTg(h) : null;
  const opcoes = {
    wpp: h.wpp, numeroDono: NUMERO_DONO, mensageiro: h.mensageiro, ocioso: async () => h.idle, agora: () => h.t, env, abrirCentral: h.abrirCentral,
    rand: randFixo(), dormir: async (ms) => { h.dormidas.push(ms); h.t += ms; },
    raizesSessao: [repos, workspace], ensaio: false, central: CENTRAL_TESTE, // A3a: a central como o dono configura
    abrirSessaoEscondida: async (pasta, nome) => {
      h.escondidas.push([pasta, nome]);
      if (h.escFalha) throw new Error(h.escFalha);
    },
    abrirSessaoVsCode: async (pasta) => { h.vsCode.push(['abrir', pasta]); },
  };
  if (vsCode) {
    Object.assign(h, { janelas: { sessao: '20260930T085209', ids: [1], comClaude: [1] }, janelaAoAbrir: 'nova', vsFalha: null, links: [] });
    delete opcoes.abrirSessaoEscondida;
    opcoes.abrirSessaoVsCode = async (pasta) => {
      h.vsCode.push(['abrir', pasta]);
      if (h.vsFalha) throw new Error(h.vsFalha);
      if (h.janelaAoAbrir !== null) h.janelas.ids.push(Math.max(0, ...h.janelas.ids) + 1);
    };
    opcoes.janelasVsCode = () => structuredClone(h.janelas);
    opcoes.abrirLinkVsCode = async (n) => { h.links.push(n); };
  }
  if (comTg) Object.assign(opcoes, { tg: h.tg, identTg: { chatId: DONO, botId: BOT } }); // A1: o chat e o bot de antes
  h.opcoes = opcoes;
  religar(h);
  h.t += 1000; // mensagens dos testes nascem depois do cursor inicial
  return h;
}
// Porteiro novo sobre o mesmo estado do disco (o religar de verdade).
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
  const arq = path.join(dir, `${sessionId}.jsonl`);
  fs.appendFileSync(arq, entradas.map((x) => `${JSON.stringify(x)}\n`).join(''));
  return arq;
}
const custom = (t) => ({ type: 'custom-title', customTitle: t, sessionId: 'x' });
function aba(h, sessionId, titulo, name = 'projetos-42') {
  sessao(h, { sessionId, name });
  transcript(h, sessionId, [custom(titulo)]);
}
const CENTRAL = 'Central de sessões de teste';
// Registro como o `claude -n` grava (cli, nome dado, nameSource user; cwd = a pasta).
function sessaoEscondida(h, { sessionId, name = NOME, cwd = h.pasta, entrypoint = 'cli', startedAt = h.t } = {}) {
  h.nReg += 1;
  fs.writeFileSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${100000 + h.nReg}.json`), JSON.stringify({
    pid: process.pid, sessionId, cwd, entrypoint, kind: 'interactive', name, nameSource: 'user', status: 'idle', startedAt, updatedAt: h.t,
  }));
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
const estado = (h) => JSON.parse(fs.readFileSync(path.join(h.env.SESSOES_WPP_DIR, 'estado.json'), 'utf8'));
function mexer(h, fn) {
  const arq = path.join(h.env.SESSOES_WPP_DIR, 'estado.json');
  const e = JSON.parse(fs.readFileSync(arq, 'utf8'));
  fn(e);
  fs.writeFileSync(arq, JSON.stringify(e));
}
const ligarTg = (h) => mexer(h, (e) => { e.tg.offset = 0; });
const logs = (h) => {
  try { return fs.readFileSync(h.env.SESSOES_WPP_LOG, 'utf8').split('\n').filter(Boolean); } catch { return []; }
};
const linhasSistema = (h) => estado(h).tg.sistema.linhas.map((l) => l.texto);
const chamado = (h, sid) => estado(h).tg.chamados[sid];

function msgTg(h, texto) {
  h.nUpd += 1;
  h.nMid += 1;
  const m = {
    message_id: h.nMid, date: Math.floor(h.t / 1000),
    chat: { id: DONO, type: 'private', first_name: 'Davi' }, from: { id: DONO, is_bot: false, first_name: 'Davi' },
  };
  if (texto !== undefined) m.text = texto;
  return { update_id: h.nUpd, message: m };
}
const pid = (u) => `tg-u${u.update_id}`;
const mid = (u) => u.message.message_id;

// Recado como chega no transcript da aba (formato medido 27/09).
function peer(pedido, ts) {
  const texto = `Another Claude session sent a message (from repos-99):\n<cross-session-message from="repos-99">\n${montarRecado(pedido)}\n</cross-session-message>`;
  return { type: 'user', isMeta: true, origin: { kind: 'peer', from: 'repos-99' }, timestamp: ts, message: { role: 'user', content: texto } };
}
// Fala do dono pelo Telegram ate o resultado do mensageiro aplicado.
async function falarTg(h, texto) {
  const u = msgTg(h, texto);
  h.tg.lotes.push([u]);
  await h.p.esperarTelegram(15000);
  await bombear(h.cru);
  return u;
}
// Recado de cada pedido no transcript da aba + o parou dela 1 min depois (o recado entrou antes da fala final).
function abaResponde(h, sid, pedidos, o = {}, pasta = 'c--projetos') {
  transcript(h, sid, pedidos.map((p, i) => peer(p, iso(h.t + 1000 * (i + 1)))), pasta);
  h.t += MIN;
  const ev = parou(h, sid, o);
  evento(h, ev);
  return ev;
}

// A central viva (SC) e o Telegram ligado; a fala do dono pelo Telegram foi pra central (entrega A). Leituras do grupo
// zeradas no fim.
async function cenaT6(o = {}) {
  const h = montarT6(o);
  aba(h, 'SC', CENTRAL, 'repos-99');
  ligarTg(h);
  const u = await falarTg(h, FALA);
  assert.deepEqual(h.entregas.map((p) => [p.sessionId, p.providerMsgId, p.canal]), [['SC', pid(u), 'telegram']]);
  h.t += 10 * 1000;
  h.leituras = 0;
  return { h, A: pid(u), u };
}
// O `abrir-sessao` que a central grava.
const pedirEv = (h, o = {}) => evento(h, {
  v: 1, tipo: 'abrir-sessao', at: iso(h.t), nome: NOME, pasta: h.pasta, providerMsgId: null, por: 'SC', ...o,
});
// A sessao escondida aparece e firma (2 checagens com 10 s).
async function firmar(h, sessionId) {
  h.t += 3000;
  sessaoEscondida(h, { sessionId });
  await h.p.passoSessoes();
  h.t += 10 * 1000;
  await h.p.passoSessoes();
}
// O recado no transcript da sessao nova (nasce com ele) e o nome na volta seguinte.
async function receber(h, sessionId, pedido) {
  const arq = transcript(h, sessionId, [peer(pedido, iso(h.t + 1000))], 'c--projetos-sessoes-wpp');
  h.t += 3000;
  await h.p.passoSessoes();
  return arq;
}

// ---------- T6 1 a 3 ----------

// Mac-testes (A): os testes marcados com SO_WINDOWS conferem a premissa do Windows (caminho X:\, .exe, wscript/.vbs,
// cmd.exe, APPDATA/LOCALAPPDATA, pipe \\.\pipe, barra invertida na frase, PowerShell, VS Code/Orca abertos pelo
// porteiro); fora do win32 eles pulam. O caminho do Mac tem os testes proprios em tests/mac-*.test.mjs.
const SO_WINDOWS = process.platform !== 'win32' && 'premissa do Windows (o Mac tem os tests/mac-*)';

test('T6 1. feliz: fala do Telegram -> central -> abrir-sessao com o tg-u = a sessao escondida abre sem ler o grupo; item e pedido com canal telegram e a fala dele (messageId da original); recado "Telegram do Davi"; o nome entra no transcript e (T32) o "Abri a sessão" sai na linha do sistema SEM notificar, em cima da fala dele', { skip: SO_WINDOWS }, async () => {
  const { h, A, u } = await cenaT6();
  const linhasAntes = linhasSistema(h);
  pedirEv(h, { providerMsgId: A });
  await h.p.passoEventos();
  assert.deepEqual(h.escondidas, [[h.pasta, NOME]]);
  assert.deepEqual(h.vsCode, [], 'o VS Code nunca entra');
  assert.equal(h.leituras, 0, 'nao le o grupo');
  const item = estado(h).sessoesNovas;
  assert.equal(item.length, 1);
  assert.equal(item[0].canal, 'telegram');
  assert.equal(item[0].escondida, true);
  assert.deepEqual(item[0].fala, { texto: FALA, audio: false, hora: '12:00', messageId: mid(u), anexos: [] });

  await firmar(h, 'E1');
  assert.equal(h.entregas.length, 2);
  assert.deepEqual(h.entregas[1], {
    sessionId: 'E1', nome: NOME, titulo: NOME, texto: FALA, audio: false, hora: '12:00', providerMsgId: `${A}-E1`,
    messageId: mid(u), anexos: [], encaminhado: true, nomear: NOME, pasta: h.pasta, canal: 'telegram',
  });
  assert.match(montarRecado(h.entregas[1]), new RegExp(`^Telegram do dono \\(12:00, id ${A}-E1\\)`));
  assert.deepEqual(estado(h).sessoesNovas, [], 'o item saiu');
  // a fala chegou e o transcript ainda nao existe: o nome fica pendente com o canal e a fala dele (T32: vai pro disco)
  assert.deepEqual(estado(h).nomesPendentes.map((x) => [x.sessionId, x.canal, x.citar]), [['E1', 'telegram', mid(u)]]);
  assert.deepEqual(linhasSistema(h), linhasAntes, 'antes do nome, nada');

  const arq = await receber(h, 'E1', h.entregas[1]);
  assert.ok(fs.readFileSync(arq, 'utf8').endsWith(`${JSON.stringify({ type: 'custom-title', customTitle: NOME, sessionId: 'E1' })}\n`), 'o nome gravado');
  assert.ok(logs(h).some((l) => l.includes(`sessao E1 nomeada ${NOME}`)));
  assert.deepEqual(h.enviados, [], 'nada no grupo');
  // T32 (caso real 18/10/2026: o silencio de minutos virou o mesmo pedido de novo)
  assert.deepEqual(linhasSistema(h), [...linhasAntes, TXT6.aberta(CURTA)], '1 linha nova no sistema');
  assert.equal(estado(h).tg.sistema.notificar, false, 'sem notificar');
  assert.equal(estado(h).tg.sistema.citar, mid(u), 'em cima da fala dele');
  assert.equal(chamado(h, 'E1'), undefined, 'nunca o chamado da sessao nova');
  assert.equal(h.leituras, 0);
  h.tg.zerar();
  await h.p.esperarTelegram(15000);
  const envios = h.tg.de('enviar').map((c) => c.args[0]);
  assert.equal(envios.length, 1, 'so a mensagem do sistema');
  assert.equal(envios[0].silencioso, true, 'sem notificar');
  assert.equal(envios[0].responderA, mid(u), 'em cima da fala dele');
  assert.ok(envios[0].html.includes(TXT6.aberta(CURTA)), envios[0].html);
});

test('T6 2. a resposta da sessao nova volta pelo Telegram: conferida e respondida, 1 mensagem nova com notificacao em cima da fala dele, o nome da sessao no titulo, a DECISAO em botoes; nada no grupo', async () => {
  const { h, A, u } = await cenaT6();
  pedirEv(h, { providerMsgId: A });
  await h.p.passoEventos();
  await firmar(h, 'E1');
  await receber(h, 'E1', h.entregas[1]);
  await h.p.esperarTelegram(15000); // T32: a linha "Abri a sessão" sai antes
  h.t += MIN;
  const final = `${LINHA}\n\nRevisei o porteiro.\n\n---\n🔴 **DECISÃO:** Publico? A) Sim (recomendado) / B) Não`;
  evento(h, parou(h, 'E1', { nome: NOME, final, marcas: DECISAO }));
  await h.p.passoEventos();
  const e = estado(h);
  assert.equal(e.entregas[`${A}-E1`].respondida, true);
  assert.equal(e.entregas[`${A}-E1`].conferido, true);
  assert.equal(chamado(h, 'E1').versao.estado, 'resposta');
  h.tg.zerar();
  await h.p.esperarTelegram(15000);
  const envios = h.tg.de('enviar').map((c) => c.args[0]);
  assert.equal(envios.length, 1);
  assert.equal(envios[0].silencioso, false, 'notifica');
  assert.equal(envios[0].responderA, mid(u), 'em cima da fala dele');
  assert.ok(envios[0].html.includes('Revisei o porteiro.'), envios[0].html);
  assert.ok(envios[0].html.includes(NOME), 'o nome da sessao no titulo');
  assert.ok(Array.isArray(envios[0].botoes) && envios[0].botoes.length > 0, 'as opcoes em botoes');
  assert.deepEqual(h.enviados, [], 'nada no grupo');
});

test('T6 3. so o resultado (T7f, F8): a resposta da central que so pediu a sessao nova (item esperando) nao vai pro Telegram e o chamado dela encerra calado; depois sai a linha "Abri a sessão" sem notificar (T32) e o resultado da sessao nova; a central que precisa dele sai como hoje', async () => {
  let { h, A } = await cenaT6();
  pedirEv(h, { providerMsgId: A });
  abaResponde(h, 'SC', [h.entregas[0]], { nome: 'repos-99', final: `${LINHA}\n\nPedi pro porteiro abrir a sessão ${NOME} em repos.` });
  await h.p.passoEventos();
  let e = estado(h);
  assert.equal(e.sessoesNovas.length, 1, 'o item espera a sessao');
  assert.equal(e.entregas[A].respondida, true);
  assert.equal(chamado(h, 'SC'), undefined, 'o chamado da central encerrou calado');
  assert.deepEqual([e.parouGuardado.SC.noTelegram, e.parouGuardado.SC.caladoTg], [true, true]);
  h.tg.zerar();
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.de('enviar'), [], 'nada da central');

  await firmar(h, 'E1');
  await receber(h, 'E1', h.entregas[1]);
  h.tg.zerar();
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.de('enviar').map((c) => [c.args[0].silencioso, c.args[0].html.includes('Abri a sessão')]), [[true, true]],
    'T32: so a linha "Abri a sessão", sem notificar');
  h.t += MIN;
  evento(h, parou(h, 'E1', { nome: NOME, final: `${LINHA}\n\nRevisei o porteiro.` }));
  await h.p.passoEventos();
  h.tg.zerar();
  await h.p.esperarTelegram(15000);
  const envios = h.tg.de('enviar').map((c) => c.args[0]);
  assert.equal(envios.length, 1, 'so o resultado da sessao nova');
  assert.ok(envios[0].html.includes('Revisei o porteiro.'));
  assert.ok(!envios.some((x) => x.html.includes('Pedi pro porteiro')));
  assert.deepEqual(h.enviados, []);

  // a central que precisa dele (DECISAO) sai como hoje, mesmo com o item esperando
  ({ h, A } = await cenaT6());
  pedirEv(h, { providerMsgId: A });
  abaResponde(h, 'SC', [h.entregas[0]], {
    nome: 'repos-99', final: `${LINHA}\n\nAbri; quer que eu avise quando ela responder?\n\n---\n🔴 **DECISÃO:** Aviso? A) Sim (recomendado) / B) Não`, marcas: DECISAO,
  });
  await h.p.passoEventos();
  e = estado(h);
  assert.equal(e.sessoesNovas.length, 1);
  assert.equal(chamado(h, 'SC').versao.estado, 'resposta');
  h.tg.zerar();
  await h.p.esperarTelegram(15000);
  assert.equal(h.tg.de('enviar').length, 1, 'a pergunta da central sai');
});

test('T6 3b. com a sessao nova esperando, a resposta da central a OUTRA fala do Telegram (que ela nao encaminhou) sai como hoje, em cima dela: o calado e so da fala que virou pedido de sessao nova', async () => {
  const { h, A } = await cenaT6();
  pedirEv(h, { providerMsgId: A });
  abaResponde(h, 'SC', [h.entregas[0]], { nome: 'repos-99', final: `${LINHA}\n\nPedi pro porteiro abrir a sessão ${NOME} em repos.` });
  await h.p.passoEventos();
  assert.equal(estado(h).sessoesNovas.length, 1, 'o item espera a sessao');
  assert.equal(chamado(h, 'SC'), undefined, 'a do pedido encerrou calada');

  const u2 = await falarTg(h, 'e o site, está no ar?');
  assert.deepEqual(h.entregas.map((p) => p.providerMsgId), [A, pid(u2)]);
  h.t += 10 * 1000;
  abaResponde(h, 'SC', [h.entregas[1]], { nome: 'repos-99', final: '> Telegram do Davi (12:01): «e o site, está no ar?»\n\nO site está no ar.' });
  await h.p.passoEventos();
  assert.equal(estado(h).sessoesNovas.length, 1, 'o item segue esperando');
  assert.equal(estado(h).entregas[pid(u2)].respondida, true);
  h.tg.zerar();
  await h.p.esperarTelegram(15000);
  const envios = h.tg.de('enviar').map((c) => c.args[0]);
  assert.equal(envios.length, 1, 'a resposta da outra fala sai');
  assert.ok(envios[0].html.includes('O site está no ar.'), envios[0].html);
  assert.equal(envios[0].responderA, mid(u2), 'em cima da outra fala');
  assert.deepEqual(h.enviados, []);
});

// ---------- T6 4 a 7 ----------

test('T6 4. fala do Telegram que nao vale (fora das recebidas, de outra pessoa, mais de 2 h, sem texto) = "Não achei a mensagem" na linha do sistema (notifica, em cima da fala quando ela existe), nada abre, nada no grupo, sem ler o grupo', async () => {
  const conferir = async (h, rotulo, motivo, citar) => {
    await h.p.passoEventos();
    const e = estado(h);
    assert.deepEqual(h.escondidas, [], `${rotulo}: nada abre`);
    assert.deepEqual(e.sessoesNovas, [], rotulo);
    assert.equal(e.tg.sistema.linhas.at(-1)?.texto, TXT6.naoAcheiMsg, rotulo);
    assert.equal(e.tg.sistema.notificar, true, `${rotulo}: notifica`);
    assert.equal(e.tg.sistema.citar, citar, `${rotulo}: citar`);
    assert.deepEqual(h.enviados, [], `${rotulo}: nada no grupo`);
    assert.equal(h.leituras, 0, `${rotulo}: nao le o grupo`);
    assert.ok(logs(h).some((l) => l.includes(`abrir-sessao da central: ${motivo}; nao abre`)), `${rotulo}: ${motivo}`);
  };

  let { h, A, u } = await cenaT6();
  pedirEv(h, { providerMsgId: 'tg-u999' });
  await conferir(h, 'fora das recebidas', 'mensagem fora das recebidas do Telegram', null);

  // de outra pessoa: o normalizarUpdate nunca deixa a fala entrar no recebidas
  ({ h } = await cenaT6());
  const outro = msgTg(h, FALA);
  outro.message.from = { id: 555, is_bot: false, first_name: 'Outro' };
  h.tg.lotes.push([outro]);
  await h.p.esperarTelegram(15000);
  await bombear(h.cru);
  assert.equal(Object.hasOwn(estado(h).tg.recebidas, pid(outro)), false);
  h.leituras = 0;
  pedirEv(h, { providerMsgId: pid(outro) });
  await conferir(h, 'outra pessoa', 'mensagem fora das recebidas do Telegram', null);

  ({ h, A, u } = await cenaT6());
  h.t += 2 * 60 * MIN + 1000;
  pedirEv(h, { providerMsgId: A });
  await conferir(h, 'mais de 2 h', 'mensagem com mais de 2 h', mid(u));

  ({ h } = await cenaT6());
  mexer(h, (e) => {
    e.tg.recebidas['tg-u777'] = { at: iso(h.t), texto: '   ', audio: false, anexos: [], respondeA: null, messageId: 7777 };
  });
  pedirEv(h, { providerMsgId: 'tg-u777' });
  await conferir(h, 'sem texto', 'mensagem sem texto', 7777);
});

test('T6 5. guardas iguais as do grupo: travado e pedido que nao veio da central viva = so log; nada abre, nada no Telegram nem no grupo', async () => {
  let { h, A } = await cenaT6();
  let antes = linhasSistema(h);
  mexer(h, (e) => { e.trava = true; });
  pedirEv(h, { providerMsgId: A });
  await h.p.passoEventos();
  assert.deepEqual(h.escondidas, []);
  assert.ok(logs(h).some((l) => l.includes('abrir-sessao ignorado: travado')));
  assert.deepEqual(linhasSistema(h), antes);
  assert.deepEqual(h.enviados, []);

  ({ h, A } = await cenaT6());
  antes = linhasSistema(h);
  pedirEv(h, { providerMsgId: A, por: 'OUTRA' });
  await h.p.passoEventos();
  assert.deepEqual(h.escondidas, []);
  assert.ok(logs(h).some((l) => l.includes('abrir-sessao ignorado: nao veio da central viva')));
  assert.deepEqual(linhasSistema(h), antes);
  assert.deepEqual(h.enviados, []);
});

test('T6 6. retry: o 2o abrir-sessao da mesma fala com a sessao esperando = nada (1 abertura, nenhuma frase); depois de passada = "Essa mensagem já foi passada" na linha do sistema, em cima da fala dele; nada no grupo', async () => {
  const { h, A, u } = await cenaT6();
  const antes = linhasSistema(h);
  pedirEv(h, { providerMsgId: A });
  await h.p.passoEventos();
  h.t += 1000;
  pedirEv(h, { providerMsgId: A });
  await h.p.passoEventos();
  assert.deepEqual(h.escondidas, [[h.pasta, NOME]], '1 abertura');
  assert.deepEqual(linhasSistema(h), antes, 'nenhuma frase com a sessao esperando');
  await firmar(h, 'E1');
  assert.equal(h.entregas.length, 2);
  h.t += 1000;
  pedirEv(h, { providerMsgId: A });
  await h.p.passoEventos();
  assert.deepEqual(h.escondidas, [[h.pasta, NOME]], 'nenhuma 2a janela');
  assert.deepEqual(linhasSistema(h), [...antes, TXT6.jaPassada]);
  assert.equal(estado(h).tg.sistema.notificar, true);
  assert.equal(estado(h).tg.sistema.citar, mid(u));
  assert.deepEqual(h.enviados, []);
});

// A frase do problema da sessao nova: a ultima linha do sistema do Telegram, 1 vez, notificando, em cima da fala dele;
// nada esperando e nada no grupo.
function conferirFrase(h, frase, u, rotulo) {
  const e = estado(h);
  assert.equal(e.tg.sistema.linhas.at(-1)?.texto, frase, rotulo);
  assert.equal(e.tg.sistema.linhas.filter((l) => l.texto === frase).length, 1, `${rotulo}: 1 vez`);
  assert.equal(e.tg.sistema.notificar, true, `${rotulo}: notifica`);
  assert.equal(e.tg.sistema.citar, mid(u), `${rotulo}: em cima da fala`);
  assert.deepEqual(e.sessoesNovas, [], `${rotulo}: nada esperando`);
  assert.deepEqual(h.enviados, [], `${rotulo}: nada no grupo`);
}

test('T6 7. pasta recusada, abridor que falha e sessao que nao aparece em 3 min: a frase na linha do sistema do Telegram (notifica, em cima da fala dele), 1 vez, nada no grupo', async () => {
  let { h, A, u } = await cenaT6();
  pedirEv(h, { providerMsgId: A, pasta: path.join(h.raiz, 'fora') });
  await h.p.passoEventos();
  assert.deepEqual(h.escondidas, [], 'pasta recusada: nada abre');
  conferirFrase(h, TXT6.pastaRecusada, u, 'pasta recusada');

  ({ h, A, u } = await cenaT6({ falha: 'wscript falhou' }));
  pedirEv(h, { providerMsgId: A });
  await h.p.passoEventos();
  assert.deepEqual(h.escondidas, [[h.pasta, NOME]]);
  conferirFrase(h, TXT6.escFalhou, u, 'abridor falhou');

  ({ h, A, u } = await cenaT6());
  pedirEv(h, { providerMsgId: A });
  await h.p.passoEventos();
  for (let i = 0; i < 17; i++) {
    h.t += 10 * 1000;
    await h.p.passoSessoes();
  }
  assert.equal(linhasSistema(h).includes(TXT6.escNaoAbriu), false, 'antes dos 180 s nada');
  h.t += 20 * 1000;
  await h.p.passoSessoes();
  conferirFrase(h, TXT6.escNaoAbriu, u, 'nao apareceu em 3 min');
  h.t += 60 * 1000;
  await h.p.passoSessoes();
  conferirFrase(h, TXT6.escNaoAbriu, u, 'a frase sai 1 vez so');
  assert.equal(h.entregas.length, 1);
});

// ---------- T6 8 e 9 ----------

test('T6 8. Telegram desligado: o tg-u segue o caminho do grupo (le o grupo e nao acha) = "Não achei a mensagem" no grupo, nada abre', async () => {
  const h = montarT6({ tg: false });
  aba(h, 'SC', CENTRAL, 'repos-99');
  mexer(h, (e) => { e.tg.recebidas['tg-u105'] = { at: iso(h.t), texto: FALA, audio: false, anexos: [], respondeA: null }; });
  h.leituras = 0;
  pedirEv(h, { providerMsgId: 'tg-u105' });
  await h.p.passoEventos();
  assert.equal(h.leituras, 1, 'a leitura do grupo de hoje');
  assert.deepEqual(h.enviados.map((x) => x.texto), [`${CAB}\n${TXT6.naoAcheiMsg}`]);
  assert.deepEqual(h.escondidas, []);
  assert.deepEqual(estado(h).sessoesNovas, []);
});

test('T6 9. regressao (F4f) com o Telegram ligado: fala do grupo = le o grupo; item e pedido sem canal; "Abri a sessão" no grupo; nada no Telegram', { skip: SO_WINDOWS }, async () => {
  const h = montarT6();
  aba(h, 'SC', CENTRAL, 'repos-99');
  ligarTg(h);
  const m = msg(h, { content: FALA });
  await h.p.passoGrupo();
  assert.deepEqual(h.entregas.map((p) => [p.sessionId, p.providerMsgId, p.canal]), [['SC', m.provider_msg_id, undefined]]);
  h.t += 10 * 1000;
  h.leituras = 0;
  pedirEv(h, { providerMsgId: m.provider_msg_id });
  await h.p.passoEventos();
  assert.equal(h.leituras, 1);
  assert.deepEqual(h.escondidas, [[h.pasta, NOME]]);
  assert.equal(Object.hasOwn(estado(h).sessoesNovas[0], 'canal'), false);
  await firmar(h, 'E1');
  assert.deepEqual(h.entregas[1], {
    sessionId: 'E1', nome: NOME, titulo: NOME, texto: FALA, audio: false, hora: '12:00', providerMsgId: `${m.provider_msg_id}-E1`,
    messageId: m.id, anexos: [], encaminhado: true, nomear: NOME, pasta: h.pasta,
  });
  assert.match(montarRecado(h.entregas[1]), /^WhatsApp do dono \(/);
  assert.deepEqual(estado(h).nomesPendentes.map((x) => [x.sessionId, 'canal' in x, 'citar' in x]), [['E1', false, false]], 'T32: o do WhatsApp nunca guarda citar');
  await receber(h, 'E1', h.entregas[1]);
  assert.deepEqual(h.enviados.map((x) => x.texto), [`${CAB}\n${TXT6.aberta(CURTA)}`]);
  assert.deepEqual(linhasSistema(h), []);
  h.tg.zerar();
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.tela(), [], 'nada no Telegram');
});

// ---------- T6 10 a 12 ----------

test('T6 10. o nome nao pegou em 2 min (sessao sem transcript): a linha do sistema do Telegram SEM notificar (o titulo ja vem do -n), em cima da fala dele (T32), nada no grupo e nenhum chamado da sessao nova', { skip: SO_WINDOWS }, async () => {
  const { h, A, u } = await cenaT6();
  const antes = linhasSistema(h);
  pedirEv(h, { providerMsgId: A });
  await h.p.passoEventos();
  await firmar(h, 'E1');
  assert.equal(estado(h).nomesPendentes.length, 1, 'sem transcript: o nome fica pendente');
  h.t += 2 * MIN + 1000;
  await h.p.passoSessoes();
  const e = estado(h);
  assert.deepEqual(e.nomesPendentes, []);
  assert.deepEqual(linhasSistema(h), [...antes, TXT6.semNome(CURTA)]);
  assert.equal(e.tg.sistema.notificar, false, 'sem notificar');
  assert.equal(e.tg.sistema.citar, mid(u), 'em cima da fala dele (T32)');
  assert.equal(e.tg.chamados.E1, undefined, 'nunca o chamado problema');
  assert.deepEqual(h.enviados, []);
});

test('T6 11. porteiro religado no meio: o canal do item esperando e do nome pendente sobrevive no disco (a entrega e a frase do nome seguem pro Telegram, em cima da fala dele: T32); item gravado sem canal = WhatsApp', { skip: SO_WINDOWS }, async () => {
  let { h, A, u } = await cenaT6();
  const antes = linhasSistema(h);
  pedirEv(h, { providerMsgId: A });
  await h.p.passoEventos();
  religar(h);
  await firmar(h, 'E1');
  assert.equal(h.entregas[1].canal, 'telegram');
  religar(h);
  h.t += 2 * MIN + 1000;
  await h.p.passoSessoes();
  assert.deepEqual(linhasSistema(h), [...antes, TXT6.semNome(CURTA)]);
  assert.equal(estado(h).tg.sistema.citar, mid(u), 'o citar do nome pendente sobreviveu no disco');
  assert.deepEqual(h.enviados, []);

  // item de antes da T6 (sem o campo) = o WhatsApp de hoje: pedido sem canal, o nome no grupo
  ({ h, A } = await cenaT6());
  pedirEv(h, { providerMsgId: A });
  await h.p.passoEventos();
  mexer(h, (e) => { delete e.sessoesNovas[0].canal; });
  await firmar(h, 'E1');
  assert.equal(Object.hasOwn(h.entregas[1], 'canal'), false);
  await receber(h, 'E1', h.entregas[1]);
  assert.deepEqual(h.enviados.map((x) => x.texto), [`${CAB}\n${TXT6.aberta(CURTA)}`]);
});

test('T32 1. o citar do nome pendente que volta torto do disco nao vale: a linha "Abri a sessão" sai sem citar novo, ainda sem notificar', { skip: SO_WINDOWS }, async () => {
  const { h, A } = await cenaT6();
  const antes = linhasSistema(h);
  pedirEv(h, { providerMsgId: A });
  await h.p.passoEventos();
  await firmar(h, 'E1');
  const citarAntes = estado(h).tg.sistema.citar ?? null;
  mexer(h, (e) => { e.nomesPendentes[0].citar = String(e.nomesPendentes[0].citar); });
  await receber(h, 'E1', h.entregas[1]);
  assert.deepEqual(linhasSistema(h), [...antes, TXT6.aberta(CURTA)]);
  assert.equal(estado(h).tg.sistema.citar ?? null, citarAntes, 'sem citar novo');
  assert.equal(estado(h).tg.sistema.notificar, false, 'sem notificar');
});

test('T6 12. fala do Telegram com audio transcrito e anexo: item e pedido levam audio true e o anexo que ainda existe no PC; o recado diz "áudio transcrito"', async () => {
  const { h } = await cenaT6();
  const foto = path.join(h.raiz, 'foto.jpg');
  fs.writeFileSync(foto, 'x');
  const sumiu = path.join(h.raiz, 'sumiu.jpg');
  mexer(h, (e) => {
    e.tg.recebidas['tg-u888'] = {
      at: iso(h.t), texto: FALA, audio: true, respondeA: null, messageId: 8888,
      anexos: [{ tipo: 'foto', caminho: foto, nome: 'foto.jpg' }, { tipo: 'foto', caminho: sumiu, nome: 'sumiu.jpg' }],
    };
  });
  pedirEv(h, { providerMsgId: 'tg-u888' });
  await h.p.passoEventos();
  const anexos = [{ tipo: 'foto', caminho: foto, nome: 'foto.jpg' }];
  const item = estado(h).sessoesNovas[0];
  assert.deepEqual(item.fala, { texto: FALA, audio: true, hora: '12:00', messageId: 8888, anexos });
  await firmar(h, 'E1');
  assert.equal(h.entregas[1].audio, true);
  assert.deepEqual(h.entregas[1].anexos, anexos);
  assert.equal(h.entregas[1].canal, 'telegram');
  assert.match(montarRecado(h.entregas[1]), /^Telegram do dono \(12:00, áudio transcrito, id tg-u888-E1\)/);
});

// ---------- T6 13 ----------

const ler = (arq) => fs.readFileSync(path.join(path.dirname(PORTEIRO), 'central', arq), 'utf8');
const corrido = (s) => s.replace(/\s+/g, ' ').trim();

test('T6 13. instrucoes: o item 16 da central ensina a sessao nova pelo Telegram (o tg-u do PEDIDO no --msg; a resposta volta pro Telegram), 18 itens; a sessao escondida fala do grupo e do Telegram', () => {
  const instr = ler('instrucoes.md');
  // A5d: o modelo (a duvida e sobre a pasta de projeto, nao mais entre 2 pastas fixas)
  const ITEM_16 = '16. Sessão nova pelo Telegram: a regra do item 9, com o id `tg-u...` da fala do PEDIDO no `--msg` (na dúvida '
    + 'sobre a pasta, pergunte e depois use o id do pedido, não o da resposta; `ler-grupo.mjs 15 --telegram` mostra '
    + 'os ids). A resposta da sessão nova volta sozinha pro Telegram, em cima do pedido dele; se não der pra abrir, o porteiro '
    + 'avisa lá.';
  const item = /^16\. [\s\S]*?(?=\r?\n17\. )/m.exec(instr);
  assert.ok(item, 'item 16 seguido do 17');
  assert.equal(corrido(item[0]), ITEM_16);
  assert.doesNotMatch(instr, /sessão nova se pede no WhatsApp|não rode o `abrir-sessao`/);
  const numeros = [...instr.matchAll(/^(\d+)\. /gm)].map((x) => Number(x[1]));
  assert.deepEqual(numeros, Array.from({ length: 19 }, (_, i) => i + 1), 'itens 1 a 19 em ordem, 1 vez cada (T24: o 18; T35: o 19)');

  const ses = ler('instrucoes-sessao.md');
  assert.doesNotMatch(ses, /^# Sessão aberta pelo WhatsApp/m);
  assert.ok(corrido(ses).includes('no chat do bot no Telegram'), 'aberta tambem pelo Telegram');
  assert.ok(corrido(ses).includes('volta sozinha pro canal do pedido'), 'a resposta volta pro canal do pedido');
  assert.ok(corrido(ses).includes('conta dele no Telegram'), 'o que vale do Telegram');
  assert.deepEqual([...ses.matchAll(/^(\d+)\. /gm)].map((x) => Number(x[1])), [1, 2, 3, 4, 5, 6]); // T8: a 6
});

// ---------- T6 14 ----------

// Registro de aba do VS Code na pasta, como a extensao grava (letra do drive minuscula, startedAt em ms).
function abaVsCode(h, sessionId) {
  h.nReg += 1;
  const cwd = h.pasta.slice(0, 1).toLowerCase() + h.pasta.slice(1);
  fs.writeFileSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${100000 + h.nReg}.json`), JSON.stringify({
    pid: process.pid, sessionId, cwd, entrypoint: 'claude-vscode', name: `aba-${sessionId.toLowerCase()}`, nameSource: 'derived',
    status: 'idle', startedAt: h.t, updatedAt: h.t,
  }));
}

test('T6 14. sem o abridor escondido (o caminho do VS Code): o item e o pedido levam o canal; o VS Code que falha, a pasta ja aberta (20 s) e a aba que nao aparece em 3 min = a frase na linha do sistema do Telegram, em cima da fala dele; nada no grupo', { skip: SO_WINDOWS }, async () => {
  // feliz: janela nova e a aba nova firma em 10 s
  let { h, A, u } = await cenaT6({ vsCode: true });
  pedirEv(h, { providerMsgId: A });
  await h.p.passoEventos();
  assert.deepEqual([h.vsCode, h.escondidas], [[['abrir', h.pasta]], []]);
  const item = estado(h).sessoesNovas;
  assert.equal(item.length, 1);
  assert.equal(item[0].canal, 'telegram');
  assert.equal(Object.hasOwn(item[0], 'escondida'), false, 'o item do VS Code');
  h.t += 3000;
  abaVsCode(h, 'N1');
  await h.p.passoSessoes();
  h.t += 10 * 1000;
  await h.p.passoSessoes();
  assert.deepEqual(h.entregas.slice(1).map((p) => [p.sessionId, p.providerMsgId, p.canal]), [['N1', `${A}-E1`, 'telegram']]);
  assert.deepEqual(h.enviados, []);

  ({ h, A, u } = await cenaT6({ vsCode: true }));
  h.vsFalha = 'code.cmd falhou';
  pedirEv(h, { providerMsgId: A });
  await h.p.passoEventos();
  conferirFrase(h, TXT6.vsFalhou, u, 'o VS Code falhou');

  // a pasta ja tinha janela: nenhuma janela nova e nenhuma aba em 20 s
  ({ h, A, u } = await cenaT6({ vsCode: true }));
  h.janelaAoAbrir = null;
  pedirEv(h, { providerMsgId: A });
  await h.p.passoEventos();
  h.t += 10 * 1000;
  await h.p.passoSessoes();
  assert.equal(estado(h).sessoesNovas.length, 1, '10 s: espera');
  h.t += 11 * 1000;
  await h.p.passoSessoes();
  conferirFrase(h, TXT6.jaAberta(CURTA), u, 'pasta ja aberta');

  // janela nova sem aba nova em 3 min
  ({ h, A, u } = await cenaT6({ vsCode: true }));
  pedirEv(h, { providerMsgId: A });
  await h.p.passoEventos();
  h.t += 10 * 1000;
  await h.p.passoSessoes();
  assert.equal(estado(h).sessoesNovas[0].janela, 2, 'a janela nova');
  h.t += 171 * 1000;
  await h.p.passoSessoes();
  conferirFrase(h, TXT6.vsNaoAbriu, u, 'a aba nao apareceu em 3 min');
  assert.deepEqual(h.links, [], 'sem o Claude na janela nova = sem link');
});
