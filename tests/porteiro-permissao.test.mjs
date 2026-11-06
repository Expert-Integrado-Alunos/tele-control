// Testes do pedido de PERMISSAO DO APP no porteiro (06/11/2026; caso real: a aba do Desktop ficou 6 h parada num
// "Permitir uma vez" com o dono na rua e nada chegou no Telegram). O hook PermissionRequest (hooks/lib/permissao-telegram.js)
// pede pelo ok-wpp com o tipo `permissao`; o porteiro manda na mensagem da aba como todo OK, mas: (1) o toque NAO vira
// recado pra aba (ela esta parada no "Permitir"; o hook le o toque e confere pelo verificar); (2) o cancelado pelo hook
// fecha: na-tela some (respondido no computador), sem-resposta fica com a linha propria; (3) vencido nunca ganha o
// "Tentar novamente" (o hook ja desistiu). Os outros tipos seguem como hoje (os testes da T28 cobrem).
// Isolamento e harness: copiados do tests/porteiro-t28.test.mjs (pastas temporarias, Telegram e relogio dublados).
// Rodar: node --test --test-reporter=tap "tests/porteiro-permissao.test.mjs"
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
function pedidoOk(h, { codigo = 'ABC234', sessionId = 'S1', criado = h.t, tipo = 'permissao', validadeMin = 10 } = {}) {
  fs.mkdirSync(path.dirname(arqOk(h, codigo)), { recursive: true });
  // o pedido de permissao nasce sem os ids do grupo (so Telegram)
  const p = {
    v: 1, codigo, sessionId, titulo: 'Faro', tipo, acao: ACAO, hashAcao: 'h', destinatarios: null,
    criadoEm: iso(criado), expiraEm: iso(criado + validadeMin * MIN), providerMsgId: null, messageId: null, status: 'pendente',
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
// Permissao do app

const temR = (chs) => chs.some((c) => JSON.stringify(c.args).includes('"r:'));
const ultimaEdicao = (h, tela, marca) => desde(h, marca).filter((c) => c.metodo === 'editar' && c.args[0] === tela).at(-1);

describe('permissao do app no porteiro', () => {
  test('1. o pedido sai na mensagem da aba com Sim e Não e o rótulo "permissão do app"', async () => {
    const h = montar({ prefixo: 'perm-' });
    const { p, tela } = await comOkNaAba(h);
    const v = ultimaVersao(h, tela);
    assert.ok(semTags(v.classico).includes(`Pedido de OK (permissão do app): ${ACAO}`), v.classico);
    assert.ok(comBotaoDoOk(v, p.codigo));
  });

  test('2. toque Sim: "Anotei", os botões saem, NENHUM recado pra aba e o toque fica anotado pro hook conferir', async () => {
    const h = montar({ prefixo: 'perm-' });
    const { p, tela } = await comOkNaAba(h);
    const marca = h.tg.chamadas.length;
    const u = await tocarNaAba(h, p, 'sim', tela);
    assert.deepEqual(respostas(desde(h, marca)), [ANOTEI_SIM]);
    assert.equal(recadosOk(h).length, 0, 'o toque de permissao nao vira recado');
    assert.equal(h.entregas.length, 0);
    const t = okDe(h, p.codigo).toque;
    assert.equal(t.acao, 'sim');
    assert.equal(t.updateId, u.update_id);
    assert.equal(estado(h).okTg.segurar, u.update_id, 'o offset segura o toque pro verificar ler');
    assert.ok(logs(h).some((l) => l.includes(`toque sim no pedido de permissao ${p.codigo}`) && l.includes('o hook da aba S1 confere')));
  });

  test('3. toque Não: o mesmo caminho (sem recado), anotado como nao', async () => {
    const h = montar({ prefixo: 'perm-' });
    const { p, tela } = await comOkNaAba(h);
    await tocarNaAba(h, p, 'nao', tela);
    assert.equal(recadosOk(h).length, 0);
    assert.equal(okDe(h, p.codigo).toque.acao, 'nao');
  });

  test('4. o outro tipo (publicação) continua mandando o recado do toque pra aba', async () => {
    const h = montar({ prefixo: 'perm-' });
    const { p, tela } = await comOkNaAba(h, { tipo: 'publicacao', validadeMin: 30 });
    await tocarNaAba(h, p, 'sim', tela);
    assert.equal(recadosOk(h).length, 1);
  });

  test('5. cancelado na tela (o hook foi encerrado): fecha com fim na-tela e o bloco some, sem Tentar novamente', async () => {
    const h = montar({ prefixo: 'perm-' });
    const { p } = await comOkNaAba(h);
    h.t += 20 * 1000;
    mudarPedido(h, p.codigo, { status: 'cancelado', canceladoEm: iso(h.t), motivoCancelamento: 'na-tela' });
    await h.p.esperarTelegram(2000);
    assert.equal(okDe(h, p.codigo).fim, 'na-tela');
    assert.ok(okDe(h, p.codigo).fechadoEm);
    assert.equal(temR(h.tg.chamadas), false);
    assert.ok(!JSON.stringify(h.tg.chamadas).includes('Respondido na tela do computador às'), 'o some tira o bloco: a linha nao aparece');
  });

  test('6. cancelado sem resposta: fecha com a linha "Ninguém respondeu até ...", sem Tentar novamente', async () => {
    const h = montar({ prefixo: 'perm-' });
    const { p, tela } = await comOkNaAba(h);
    h.t += 9 * MIN;
    mudarPedido(h, p.codigo, { status: 'cancelado', canceladoEm: iso(h.t), motivoCancelamento: 'sem-resposta' });
    const marca = h.tg.chamadas.length;
    await h.p.esperarTelegram(2000);
    assert.equal(okDe(h, p.codigo).fim, 'sem-resposta');
    const ed = ultimaEdicao(h, tela, marca);
    assert.ok(ed, JSON.stringify(desde(h, marca).map((c) => c.metodo)));
    assert.ok(semTags(ed.args[1].classico).endsWith(`Ninguém respondeu até ${horaBRT(iso(h.t))}: a aba seguiu sem essa ação.`), ed.args[1].classico);
    assert.equal(temR(h.tg.chamadas), false);
  });

  test('7. vencido sem cancelar (o hook morreu sem sinal): fecha como expirou, SEM o botão Tentar novamente', async () => {
    const h = montar({ prefixo: 'perm-' });
    const { p, tela } = await comOkNaAba(h);
    h.t = Date.parse(p.expiraEm) + 1000;
    const marca = h.tg.chamadas.length;
    await h.p.esperarTelegram(2000);
    assert.equal(okDe(h, p.codigo).fim, 'expirou');
    const ed = ultimaEdicao(h, tela, marca);
    assert.ok(ed);
    assert.ok(semTags(ed.args[1].classico).endsWith(`Expirou às ${horaBRT(p.expiraEm)} sem resposta.`), ed.args[1].classico);
    assert.equal(temR(h.tg.chamadas), false, 'sem o botao r:');
  });

  test('8. vencido com o Sim tocado e nao conferido: a linha de hoje, sem o botão', async () => {
    const h = montar({ prefixo: 'perm-' });
    const { p, tela } = await comOkNaAba(h);
    await tocarNaAba(h, p, 'sim', tela);
    h.t = Date.parse(p.expiraEm) + 1000;
    await h.p.esperarTelegram(2000);
    assert.equal(okDe(h, p.codigo).fim, 'expirou');
    assert.equal(temR(h.tg.chamadas), false);
  });

  test('9. cancelado de outro tipo (estado fabricado) = "não vale mais", como antes', async () => {
    const h = montar({ prefixo: 'perm-' });
    const { p } = await comOkNaAba(h, { tipo: 'publicacao', validadeMin: 30 });
    h.t += 1000;
    mudarPedido(h, p.codigo, { status: 'cancelado', canceladoEm: iso(h.t), motivoCancelamento: 'na-tela' });
    await h.p.esperarTelegram(2000);
    assert.equal(okDe(h, p.codigo).fim, 'nao-vale');
  });
});
