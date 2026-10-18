// Testes da T24a (PLANO-TELEGRAM.md, "T24 — tirar do "Esperando você" o que ele não quer mexer agora: o grupo
// "Aguardando""; pedido do dono, pelo Telegram: «transforma os que eu não quiser mais mexer agora em aguardando
// ou em alguma coisa assim»). O porteiro: o estado e.aguardando e a poda; os comandos `esperando` e `aguardar` da
// central; o evento (mover, voltar, fora do Esperando, desconhecida, pedido de OK, central errada, trava, repetido); a
// volta sozinha com pergunta nova e a saida com resposta; os dados do painel, as tocadas, a situacao, o pendencias e o
// status. O grupo no montarPainel e o item 18 das instrucoes sao da T24b (tests/formato-tg.test.mjs e porteiro.test.mjs).
// Isolamento: pastas temporarias via SESSOES_WPP_DIR, CLAUDE_SESSIONS_DIR, CLAUDE_PROJECTS_DIR e SESSOES_WPP_LOG (nunca o
// ~/.claude real). Nenhuma rede: `tg` e `wpp` sao dubles; o pedido de OK e um arquivo na pasta temporaria. Harness
// copiado (enxuto) do tests/porteiro-telegram.test.mjs. Nomes de aba sinteticos.
// Rodar: node --test --test-reporter=tap "tests/porteiro-t24.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { criarPorteiro } from '../porteiro.mjs';
import { horaBRT, diaBRT } from '../lib/formato.mjs';
import { NUMERO_DONO } from './lib/dados-whatsapp.mjs';
import { CENTRAL_TESTE, RAIZES_TESTE } from './lib/dados-central.mjs';

const require = createRequire(import.meta.url);
const lib = require('../hooks/lib/sessoes-wpp.js');
const PORTEIRO = fileURLToPath(new URL('../porteiro.mjs', import.meta.url));

const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-14T15:00:00Z'); // 12:00 em Brasilia
const iso = (ms) => new Date(ms).toISOString();
const DONO = 700100200;
const BOT = 700900800;
const BOT_NOME = 'Teste_ControleBot';
const S = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SC = S(99); // a central
const CENTRAL = 'Central de sessões de teste';
const CAB = '🎛️ *Controle de sessões*'; // F4g: cabecalho das frases do WhatsApp
const LINK = (sid) => `https://t.me/${BOT_NOME}?start=a_${sid}`;
const FINAL = [
  'Terminei a revisão.',
  '',
  '---',
  '🔴 **DECISÃO:** Publico? A) Sim, tudo hoje (recomendado) / B) Só as correções',
].join('\n');
const DECISAO = { decisao: true, fica: false, pergunta: false };
const COM_PERGUNTA = { decisao: false, fica: false, pergunta: true };
const FINAL_PERGUNTA = 'Rodei a migração no banco de teste.\n\nPosso apagar a tabela velha?';

// ---------- harness (copia enxuta do tests/porteiro-telegram.test.mjs) ----------

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
    return lote;
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
  tg.baixar = async () => ({ ok: false, erro: 'sem rede no teste' });
  tg.quemSou = async () => { gravar('quemSou', []); return { ok: true, id: BOT, username: BOT_NOME }; };
  tg.definirComandos = async () => ({ ok: true });
  tg.de = (metodo) => tg.chamadas.filter((c) => c.metodo === metodo);
  tg.zerar = () => { tg.chamadas.length = 0; };
  return tg;
}

function montar() {
  const raiz = pastaTemp('porteiro-t24-');
  const env = {
    SESSOES_WPP_DIR: path.join(raiz, 'estado'),
    CLAUDE_SESSIONS_DIR: path.join(raiz, 'sessions'),
    CLAUDE_PROJECTS_DIR: path.join(raiz, 'projects'),
    SESSOES_WPP_LOG: path.join(raiz, 'porteiro.log'),
  };
  for (const d of [env.SESSOES_WPP_DIR, env.CLAUDE_SESSIONS_DIR, env.CLAUDE_PROJECTS_DIR]) fs.mkdirSync(d, { recursive: true });
  const h = { raiz, env, t: T0, idle: 0, grupo: [], enviados: [], entregas: [], nReg: 0, nMsg: 0, nUpd: 100, nMid: 7000 };
  let seq = 0;
  const wpp = {
    async lerGrupo(limit) { return h.grupo.slice(-limit); },
    async enviarGrupo(texto, opts) {
      h.enviados.push({ texto, opts });
      seq += 1;
      return { ok: true, providerMsgId: `P${seq}`, messageId: `U${seq}` };
    },
    async reagir() { return { ok: true }; },
    async editarGrupo() { return { ok: true }; },
  };
  const mensageiro = { async entregar(p) { h.entregas.push(p); return { status: 'enviado', detalhe: '' }; } };
  h.tg = dubleTg(h);
  h.cru = criarPorteiro({
    wpp, numeroDono: NUMERO_DONO, mensageiro, ocioso: async () => h.idle, agora: () => h.t, env, abrirCentral: () => {},
    rand: randFixo(), dormir: async (ms) => { h.t += ms; }, central: CENTRAL_TESTE, raizesSessao: RAIZES_TESTE,
    tg: h.tg, identTg: { chatId: DONO, botId: BOT },
  });
  h.p = comBomba(h.cru);
  h.t += 1000; // mensagens dos testes nascem depois do cursor inicial
  return h;
}

function sessao(h, { sessionId, name = 'projetos-42', status = 'idle' }) {
  h.nReg += 1;
  const reg = { pid: process.pid, sessionId, cwd: 'c:\\projetos', entrypoint: 'claude-vscode', name, nameSource: 'derived', status, updatedAt: h.t };
  fs.writeFileSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${100000 + h.nReg}.json`), JSON.stringify(reg));
}
function transcript(h, sessionId, entradas) {
  const dir = path.join(h.env.CLAUDE_PROJECTS_DIR, 'c--projetos');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${sessionId}.jsonl`), entradas.map((x) => `${JSON.stringify(x)}\n`).join(''));
}
const custom = (t) => ({ type: 'custom-title', customTitle: t, sessionId: 'x' });
function aba(h, sessionId, titulo, name = 'projetos-42') {
  sessao(h, { sessionId, name });
  transcript(h, sessionId, [custom(titulo)]);
}
const falaDaAba = (texto) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: texto }] } });
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
const logs = (h) => {
  try { return fs.readFileSync(h.env.SESSOES_WPP_LOG, 'utf8').split('\n').filter(Boolean); } catch { return []; }
};
const linhasSistema = (h) => estado(h).tg.sistema.linhas.map((l) => l.texto);
const painel = (h) => estado(h).tg.painel?.dados ?? null;
function msgTg(h, texto) {
  h.nUpd += 1;
  h.nMid += 1;
  return {
    update_id: h.nUpd,
    message: {
      message_id: h.nMid, date: Math.floor(h.t / 1000), text: texto,
      chat: { id: DONO, type: 'private', first_name: 'Davi' }, from: { id: DONO, is_bot: false, first_name: 'Davi' },
    },
  };
}
async function lerTg(h, updates) {
  h.tg.lotes.push(updates);
  await h.p.esperarTelegram(15000);
}
const pid = (u) => `tg-u${u.update_id}`;
const mid = (u) => u.message.message_id;
function pedidoOk(h, { codigo, sessionId, criado = h.t - MIN, status = 'pendente' }) {
  const dir = path.join(h.env.SESSOES_WPP_DIR, 'oks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${codigo}.json`), JSON.stringify({
    v: 1, codigo, sessionId, tipo: 'crm', acao: 'x', hashAcao: 'h', destinatarios: null,
    criadoEm: iso(criado), expiraEm: iso(criado + 30 * MIN), providerMsgId: 'P1', messageId: 'uuid-a', status,
  }));
}
function registroDe(h, sid) {
  return fs.readdirSync(h.env.CLAUDE_SESSIONS_DIR).map((n) => path.join(h.env.CLAUDE_SESSIONS_DIR, n))
    .find((a) => JSON.parse(fs.readFileSync(a, 'utf8')).sessionId === sid);
}
const fecharAba = (h, sid) => fs.rmSync(registroDe(h, sid)); // a aba fechou: o registro some
// "HH:MM" de Brasilia no dia do T0 (T0 = 12:00)
const aos = (hhmm) => { const [hh, mm] = hhmm.split(':').map(Number); return T0 + ((hh - 12) * 60 + mm) * MIN; };
async function pararAs(h, hhmm, sid, final, marcas) {
  h.t = aos(hhmm);
  evento(h, parou(h, sid, { final, marcas }));
  await h.p.passoEventos();
}
const aguardarEv = (h, sessoes, o = {}) => evento(h, {
  v: 1, tipo: 'aguardar', at: iso(h.t), sessoes, voltar: false, providerMsgId: 'PROV-X', por: SC, ...o,
});

// A cena: a central; Alfa (viva, pergunta das 12:10), Bravo (fechada, pergunta das 12:11), Charlie (viva, pergunta das
// 12:12) e Delta (viva, parada sem pergunta). Termina as 12:30, com o painel sem nada na tela.
async function cena(h) {
  aba(h, SC, CENTRAL, 'repos-99');
  for (const [n, t] of [[1, 'Alfa'], [2, 'Bravo'], [3, 'Charlie'], [4, 'Delta']]) aba(h, S(n), t);
  mexer(h, (e) => { e.tg.offset = 0; });
  h.tg.usuarioBot = BOT_NOME;
  await pararAs(h, '12:10', S(1), FINAL, DECISAO);
  await pararAs(h, '12:11', S(2), FINAL, DECISAO);
  await pararAs(h, '12:12', S(3), FINAL, DECISAO);
  await pararAs(h, '12:13', S(4), 'Feito.', undefined);
  fecharAba(h, S(2));
  h.t = aos('12:30');
}
// A fala solta do dono no Telegram (vai pra central): a que o `--msg` do aguardar cita.
async function falaPraCentral(h, texto) {
  const u = msgTg(h, texto);
  await lerTg(h, [u]);
  await bombear(h.cru);
  return u;
}

// ---------- 1. estado e poda ----------

test('T24 1. estado: e.aguardando = {} no estado velho; poda: chave que nao e UUID, `em` ilegivel, sem a pergunta guardada, outro finalTs e parou sem pergunta saem; teto de 200 (as mais novas)', async () => {
  const h = montar();
  mexer(h, (e) => { delete e.aguardando; });
  evento(h, parou(h, S(9)));
  await h.p.passoEventos();
  assert.deepEqual(estado(h).aguardando, {}, 'estado velho sem a chave = {}');

  const fts = iso(h.t - 10 * MIN);
  const up = (titulo, o = {}) => ({ finalTs: fts, precisa: true, at: iso(h.t), titulo, nome: null, pergunta: 'Publico?', ...o });
  mexer(h, (e) => {
    e.ultimosParou = {
      [S(1)]: up('Alfa'), [S(2)]: up('Bravo'), [S(3)]: { finalTs: fts, precisa: false, at: iso(h.t) }, [S(4)]: up('Delta'),
      'nao-e-uuid': up('Golf'),
    };
    e.aguardando = {
      [S(1)]: { em: iso(h.t - MIN), finalTs: fts }, // fica
      [S(2)]: { em: iso(h.t - MIN), finalTs: iso(h.t - 20 * MIN) }, // outra pergunta
      [S(3)]: { em: iso(h.t - MIN), finalTs: fts }, // parou sem pergunta
      [S(4)]: { em: 'ontem', finalTs: fts }, // em ilegivel
      [S(5)]: { em: iso(h.t - MIN), finalTs: fts }, // sem ultimosParou
      'nao-e-uuid': { em: iso(h.t - MIN), finalTs: fts },
    };
  });
  evento(h, parou(h, S(9), { finalTs: iso(h.t + 1) }));
  await h.p.passoEventos();
  assert.deepEqual(estado(h).aguardando, { [S(1)]: { em: iso(h.t - MIN), finalTs: fts } });

  // teto de 200: as mais novas (pelo `em`) ficam
  mexer(h, (e) => {
    e.ultimosParou = {};
    e.aguardando = {};
    for (let i = 0; i < 205; i += 1) {
      e.ultimosParou[S(1000 + i)] = up(`Aba ${i}`);
      e.aguardando[S(1000 + i)] = { em: iso(h.t - i * MIN), finalTs: fts };
    }
  });
  evento(h, parou(h, S(9), { finalTs: iso(h.t + 2) }));
  await h.p.passoEventos();
  const ag = estado(h).aguardando;
  assert.equal(Object.keys(ag).length, 200);
  for (const i of [0, 199]) assert.ok(ag[S(1000 + i)], `S(${1000 + i}) fica`);
  for (const i of [200, 204]) assert.equal(ag[S(1000 + i)], undefined, `S(${1000 + i}) sai`);
});

// ---------- 2 e 3. os comandos da central ----------

function cli(estadoJson) {
  const raiz = pastaTemp('porteiro-t24-cli-');
  const env = { ...process.env, SESSOES_WPP_DIR: path.join(raiz, 'estado'), SESSOES_WPP_LOG: path.join(raiz, 'p.log'), CLAUDE_CODE_SESSION_ID: SC };
  delete env.SESSOES_WPP_ENSAIO;
  fs.mkdirSync(env.SESSOES_WPP_DIR, { recursive: true });
  if (estadoJson !== undefined) fs.writeFileSync(path.join(env.SESSOES_WPP_DIR, 'estado.json'), estadoJson);
  const rodar = (args) => spawnSync(process.execPath, [PORTEIRO, ...args], { env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  const eventos = () => {
    try {
      return fs.readFileSync(path.join(env.SESSOES_WPP_DIR, 'eventos.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  };
  return { raiz, env, rodar, eventos };
}

test('T24 2. CLI esperando: so le o estado.json; as abas com pergunta guardada (precisa, 30 dias, sem fala dele depois), a mais nova primeiro, nos blocos "Esperando você:" e "Aguardando:"; nada = "nada esperando resposta"', () => {
  const vazio = cli();
  let r = vazio.rodar(['esperando']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'nada esperando resposta');
  assert.equal(fs.existsSync(path.join(vazio.env.SESSOES_WPP_DIR, 'estado.json')), false, 'nao cria estado');

  const agora = Date.now();
  const q = (min) => iso(agora - min * MIN);
  const up = (titulo, min, o = {}) => ({ finalTs: q(min), precisa: true, at: q(min), titulo, nome: null, pergunta: 'Publico?', ...o });
  const est = {
    ultimosParou: {
      [S(1)]: up('Alfa', 5),
      [S(2)]: up('Bravo', 60 * 30), // 30 h atras: com a data
      [S(3)]: up('Charlie', 10),
      [S(4)]: up('Delta', 15, { precisa: false }), // sem pergunta
      [S(5)]: up('Eco', 31 * 24 * 60), // 31 dias
      [S(6)]: up('Foxtrot', 20), // respondida (fala dele depois)
      [S(7)]: { finalTs: q(25), precisa: true, at: q(25), titulo: null, nome: 'repos-77' }, // sem titulo: o nome
      [S(8)]: up('Hotel\nquebrado', 26), // titulo numa linha so
      'nao-e-uuid': up('Golf', 1),
    },
    aguardando: { [S(2)]: { em: q(60), finalTs: q(60 * 30) }, [S(3)]: { em: q(2), finalTs: q(10) } },
    entregas: { 'tg-u1': { sessionId: S(6), at: q(19) } },
  };
  const c = cli(JSON.stringify(est));
  r = c.rodar(['esperando']);
  assert.equal(r.status, 0, r.stderr);
  const quando = (min) => {
    const t = q(min);
    return diaBRT(t) === diaBRT(iso(agora)) ? horaBRT(t) : `${diaBRT(t)} ${horaBRT(t)}`;
  };
  assert.equal(r.stdout.trim(), [
    'Esperando você:',
    `- Alfa (sessionId ${S(1)}, pergunta das ${quando(5)})`,
    `- repos-77 (sessionId ${S(7)}, pergunta das ${quando(25)})`,
    `- Hotel quebrado (sessionId ${S(8)}, pergunta das ${quando(26)})`,
    'Aguardando:',
    `- Charlie (sessionId ${S(3)}, pergunta das ${quando(10)})`,
    `- Bravo (sessionId ${S(2)}, pergunta das ${quando(60 * 30)})`,
  ].join('\n'));
  assert.ok(!r.stdout.includes('Publico?'), 'a pergunta nao sai (a central acha pelo nome)');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(c.env.SESSOES_WPP_DIR, 'estado.json'), 'utf8')), est, 'so le');
  // so o Aguardando: o bloco do Esperando nao aparece
  const so = cli(JSON.stringify({ ultimosParou: { [S(3)]: up('Charlie', 10) }, aguardando: { [S(3)]: { em: q(2), finalTs: q(10) } } }));
  r = so.rodar(['esperando']);
  assert.equal(r.stdout.trim(), ['Aguardando:', `- Charlie (sessionId ${S(3)}, pergunta das ${quando(10)})`].join('\n'));
  // estado ilegivel = nada
  r = cli('{ quebrado').rodar(['esperando']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'nada esperando resposta');
  for (const x of [vazio, c, so]) fs.rmSync(x.raiz, { recursive: true, force: true });
});

test('T24 3. CLI aguardar: grava 1 evento {v, tipo, at, sessoes, voltar, providerMsgId, por}; ids separados por virgula, sem repetir; --voltar; faltou opcao, id fora do UUID ou mais de 20 = exit 1 com {ok:false} e nada gravado; o uso lista os 2 comandos', () => {
  const c = cli();
  let r = c.rodar(['aguardar', '--sessao', `${S(1)}, ${S(2)},${S(1)}`, '--msg', 'tg-u123']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { ok: true });
  r = c.rodar(['aguardar', '--sessao', S(3), '--msg', 'PROV9', '--voltar']);
  assert.equal(r.status, 0, r.stderr);
  let evs = c.eventos();
  assert.deepEqual(evs.map((x) => [x.v, x.tipo, x.sessoes, x.voltar, x.providerMsgId, x.por]), [
    [1, 'aguardar', [S(1), S(2)], false, 'tg-u123', SC],
    [1, 'aguardar', [S(3)], true, 'PROV9', SC],
  ]);
  for (const x of evs) assert.ok(Number.isFinite(Date.parse(x.at)));
  const vinteUm = Array.from({ length: 21 }, (_, i) => S(i + 1)).join(',');
  for (const args of [
    ['aguardar', '--msg', 'tg-u1'],
    ['aguardar', '--sessao', S(1)],
    ['aguardar', '--sessao', '--voltar', '--msg', 'tg-u1'],
    ['aguardar', '--sessao', 'abc', '--msg', 'tg-u1'],
    ['aguardar', '--sessao', `${S(1)},abc`, '--msg', 'tg-u1'],
    ['aguardar', '--sessao', ' , ', '--msg', 'tg-u1'],
    ['aguardar', '--sessao', vinteUm, '--msg', 'tg-u1'],
  ]) {
    r = c.rodar(args);
    assert.equal(r.status, 1, JSON.stringify(args));
    assert.equal(JSON.parse(r.stdout).ok, false, JSON.stringify(args));
  }
  evs = c.eventos();
  assert.equal(evs.length, 2, 'nada gravado nas recusadas');
  r = c.rodar(['aguardar', '--sessao', Array.from({ length: 20 }, (_, i) => S(i + 1)).join(','), '--msg', 'tg-u1']);
  assert.equal(r.status, 0, '20 ids passam');
  r = c.rodar([]);
  assert.match(r.stdout, /node porteiro\.mjs esperando/);
  assert.match(r.stdout, /aguardar --sessao "<sessionId>\[,<sessionId>\.\.\.\]" --msg <id da mensagem do dono> \[--voltar\]/);
  fs.rmSync(c.raiz, { recursive: true, force: true });
});

// ---------- 4 a 7. o evento ----------

test('T24 4. mover pelo Telegram: vai so a aba no Esperando pela pergunta (viva e fechada); pedido de OK, aba fora do Esperando e id desconhecido ficam; 1 frase em linhas no sistema, em cima da fala dele; o painel com o grupo', async () => {
  const h = montar();
  await cena(h);
  pedidoOk(h, { codigo: 'ABC234', sessionId: S(3) });
  const u = await falaPraCentral(h, 'deixa o Alfa, o Bravo, o Charlie e o Delta aguardando');
  assert.deepEqual(h.entregas.map((p) => p.sessionId), [SC], 'a fala solta vai pra central');
  const agora = h.t;
  aguardarEv(h, [S(1), S(2), S(3), S(4), S(5)], { providerMsgId: pid(u) });
  await h.p.passoEventos();
  assert.deepEqual(estado(h).aguardando, {
    [S(1)]: { em: iso(agora), finalTs: iso(aos('12:10')) },
    [S(2)]: { em: iso(agora), finalTs: iso(aos('12:11')) },
  });
  h.tg.zerar();
  await lerTg(h, []);
  assert.equal(linhasSistema(h).at(-1), [
    'Movi pra Aguardando: Alfa e Bravo. Volta sozinha pro Esperando você se a aba perguntar de novo.',
    'Charlie: o pedido de OK não vai pra Aguardando (vence sozinho).',
    'Delta não está no Esperando você agora.',
    'Não achei a aba 00000000.',
  ].join('\n'));
  const env = h.tg.de('enviar').map((c) => c.args[0]).filter((x) => String(x.html).includes('Movi pra Aguardando'));
  assert.equal(env.length, 1);
  assert.equal(env[0].responderA, mid(u), 'em cima da fala dele');
  assert.equal(h.entregas.length, 1, 'nada vai pra aba nenhuma');
  assert.ok(logs(h).some((l) => l.endsWith('aguardar da central (mover): 2 pra Aguardando, 3 sem mudar')), logs(h).join('\n'));

  await lerTg(h, [msgTg(h, '/painel')]);
  const d = painel(h);
  assert.deepEqual(d.esperando.map((x) => x.sid), [S(3)], 'o pedido de OK fica no Esperando');
  assert.deepEqual(d.aguardando, [
    { titulo: 'Alfa', hora: iso(aos('12:10')), texto: 'Publico?', sid: S(1), em: iso(agora) },
    { titulo: 'Bravo', hora: iso(aos('12:11')), texto: 'Publico?', sid: S(2), fechada: true, em: iso(agora) },
  ]);
  assert.ok(!d.paradas.some((x) => [S(1), S(2)].includes(x.sid)) && !d.fechadas.some((x) => [S(1), S(2)].includes(x.sid)), 'em 1 grupo so');
  const { html } = h.tg.de('enviar').at(-1).args[0];
  assert.ok(html.includes('<details open><summary>🔴 Esperando você (1)</summary>'), html);
  assert.ok(html.includes(`<details><summary>🔵 Aguardando (2)</summary><p><b><a href="${LINK(S(1))}">Alfa</a></b> · 12:10<br>Publico?</p>`), html);
});

test('T24 5. voltar pelo grupo do WhatsApp: a aba do Aguardando volta pro Esperando; a que nao esta no Aguardando fica; a frase no grupo com o cabecalho; mover de novo a que ja esta no Aguardando = fica como estava', async () => {
  const h = montar();
  await cena(h);
  aguardarEv(h, [S(1)]);
  await h.p.passoEventos();
  assert.deepEqual(Object.keys(estado(h).aguardando), [S(1)]);
  // mover de novo: fica como estava (a hora do mover nao muda)
  const em = estado(h).aguardando[S(1)].em;
  h.t += MIN;
  h.enviados.length = 0;
  aguardarEv(h, [S(1)], { providerMsgId: 'PROV-R' });
  await h.p.passoEventos();
  assert.deepEqual(h.enviados.map((x) => x.texto), [`${CAB}\nAlfa não está no Esperando você agora.`]);
  assert.equal(estado(h).aguardando[S(1)].em, em);
  h.t += MIN;
  h.enviados.length = 0;
  aguardarEv(h, [S(1), S(3)], { providerMsgId: 'PROV-Y', voltar: true });
  await h.p.passoEventos();
  assert.deepEqual(estado(h).aguardando, {});
  assert.deepEqual(h.enviados.map((x) => x.texto), [`${CAB}\nVoltou pro Esperando você: Alfa.\nCharlie não está no Aguardando agora.`]);
  assert.ok(logs(h).some((l) => l.endsWith('aguardar da central (voltar): 1 de volta pro Esperando, 1 sem mudar')), logs(h).join('\n'));
  await lerTg(h, [msgTg(h, '/painel')]);
  assert.deepEqual(painel(h).esperando.map((x) => x.sid), [S(1), S(2), S(3)]);
  assert.equal(Object.hasOwn(painel(h), 'aguardando'), false, 'N = 0 = sem o grupo nos dados');
});

test('T24 6. pedido de OK: com o registro do aguardar, a aba fica no Esperando pelo OK enquanto ele esta aberto e volta pro Aguardando quando ele sai; voltar com o OK aberto tira o registro', async () => {
  const h = montar();
  await cena(h);
  aguardarEv(h, [S(1), S(3)]);
  await h.p.passoEventos();
  assert.deepEqual(Object.keys(estado(h).aguardando).sort(), [S(1), S(3)].sort());
  pedidoOk(h, { codigo: 'ABC234', sessionId: S(3) });
  await lerTg(h, [msgTg(h, '/painel')]);
  assert.deepEqual(painel(h).esperando.map((x) => x.sid), [S(2), S(3)], 'Charlie no Esperando pelo OK');
  assert.deepEqual(painel(h).aguardando.map((x) => x.sid), [S(1)]);
  assert.ok(estado(h).aguardando[S(3)], 'o registro fica');
  pedidoOk(h, { codigo: 'ABC234', sessionId: S(3), status: 'usado' });
  await lerTg(h, [msgTg(h, '/painel')]);
  assert.deepEqual(painel(h).esperando.map((x) => x.sid), [S(2)]);
  assert.deepEqual(painel(h).aguardando.map((x) => x.sid), [S(1), S(3)], 'o OK saiu: o registro vale de novo');
  // voltar com o OK aberto
  pedidoOk(h, { codigo: 'ABC235', sessionId: S(3) });
  h.enviados.length = 0;
  aguardarEv(h, [S(3)], { providerMsgId: 'PROV-Z', voltar: true });
  await h.p.passoEventos();
  assert.deepEqual(h.enviados.map((x) => x.texto), [`${CAB}\nVoltou pro Esperando você: Charlie.`]);
  assert.equal(estado(h).aguardando[S(3)], undefined);
  pedidoOk(h, { codigo: 'ABC235', sessionId: S(3), status: 'usado' });
  await lerTg(h, [msgTg(h, '/painel')]);
  assert.deepEqual(painel(h).esperando.map((x) => x.sid), [S(2), S(3)], 'sem o registro: a pergunta no Esperando');
});

test('T24 7. guardas: so da central viva (outro `por` = so log), travado = so log, evento sem id ou com sessao invalida = so log, a mesma linha 1 vez so', async () => {
  const h = montar();
  await cena(h);
  h.enviados.length = 0;
  aguardarEv(h, [S(1)], { por: S(4) });
  await h.p.passoEventos();
  assert.deepEqual(estado(h).aguardando, {});
  assert.ok(logs(h).some((l) => /aguardar ignorado: nao veio da central viva/.test(l)), logs(h).join('\n'));
  mexer(h, (e) => { e.trava = true; });
  aguardarEv(h, [S(1)], { providerMsgId: 'PROV-T' });
  await h.p.passoEventos();
  assert.deepEqual(estado(h).aguardando, {});
  assert.ok(logs(h).some((l) => l.endsWith('aguardar ignorado: travado')), logs(h).join('\n'));
  mexer(h, (e) => { e.trava = false; });
  h.enviados.length = 0;
  aguardarEv(h, ['nao-e-uuid', S(1)], { providerMsgId: 'PROV-1' });
  aguardarEv(h, [], { providerMsgId: 'PROV-2' });
  aguardarEv(h, [S(1)], { providerMsgId: '' });
  aguardarEv(h, 'x', { providerMsgId: 'PROV-3' });
  aguardarEv(h, Array.from({ length: 21 }, (_, i) => S(200 + i)), { providerMsgId: 'PROV-4' });
  await h.p.passoEventos();
  assert.deepEqual(estado(h).aguardando, {});
  assert.equal(logs(h).filter((l) => l.endsWith('aguardar ignorado: sem id da mensagem ou com sessao invalida')).length, 5);
  assert.deepEqual(h.enviados, [], 'nenhuma frase');
  // a mesma linha 2 vezes no eventos.jsonl = 1 vez so
  const ev = { v: 1, tipo: 'aguardar', at: iso(h.t), sessoes: [S(1)], voltar: false, providerMsgId: 'PROV-5', por: SC };
  evento(h, ev);
  evento(h, ev);
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 1);
  assert.ok(estado(h).aguardando[S(1)]);
});

// ---------- 8. volta sozinha e saida com resposta ----------

test('T24 8. volta sozinha: a aba no Aguardando que pergunta de novo volta pro Esperando (o registro sai); respondida sai dos dois', async () => {
  const h = montar();
  await cena(h);
  aguardarEv(h, [S(1), S(3)]);
  await h.p.passoEventos();
  await pararAs(h, '12:40', S(1), FINAL_PERGUNTA, COM_PERGUNTA); // Alfa pergunta de novo
  assert.deepEqual(Object.keys(estado(h).aguardando), [S(3)], 'o registro do Alfa saiu');
  h.t = aos('12:45');
  msg(h, { content: 'Charlie: manda ver' }); // o dono responde o Charlie
  await h.p.passoGrupo();
  assert.deepEqual(h.entregas.map((p) => p.sessionId), [S(3)]);
  await lerTg(h, [msgTg(h, '/painel')]);
  const d = painel(h);
  assert.deepEqual(d.esperando.map((x) => [x.sid, x.texto]), [[S(2), 'Publico?'], [S(1), 'Posso apagar a tabela velha?']]);
  assert.equal(Object.hasOwn(d, 'aguardando'), false, 'a respondida sai dos dois');
});

// ---------- 9 e 10. tocadas e situacao ----------

test('T24 9. tocada: o toque no nome de uma aba do Aguardando tira ela do painel na tela (lugar aguardando:<hora>); de volta pro Esperando, ela reaparece', async () => {
  const h = montar();
  await cena(h);
  aguardarEv(h, [S(1)]);
  await h.p.passoEventos();
  await lerTg(h, [msgTg(h, '/painel')]);
  assert.deepEqual(painel(h).aguardando.map((x) => x.sid), [S(1)]);
  await lerTg(h, [msgTg(h, `/start a_${S(1)}`)]);
  assert.equal(estado(h).painelTg.tocadas[S(1)], `aguardando:${iso(aos('12:10'))}`);
  assert.deepEqual(painel(h).aguardando ?? [], [], 'a tocada sai do painel na tela');
  assert.ok(logs(h).some((l) => l.endsWith(`Telegram: a aba ${S(1)} saiu do painel (tocada; aguardando)`)), logs(h).join('\n'));
  aguardarEv(h, [S(1)], { providerMsgId: 'PROV-V', voltar: true });
  await h.p.passoEventos();
  h.t += 31 * 1000;
  await lerTg(h, []);
  assert.deepEqual(painel(h).esperando.map((x) => x.sid), [S(1), S(2), S(3)], 'mudou de lugar: volta no painel');
  assert.equal(Object.hasOwn(estado(h).painelTg.tocadas, S(1)), false);
});

test('T24 10. situacao (toque no nome): aba viva no Aguardando = "Aguardando desde HH:MM." (a hora do mover; outro dia com a data); fechada = como antes', async () => {
  const h = montar();
  await cena(h);
  transcript(h, S(1), [falaDaAba(FINAL)]);
  aguardarEv(h, [S(1), S(2)]);
  await h.p.passoEventos();
  h.t = aos('12:50');
  h.tg.zerar();
  await lerTg(h, [msgTg(h, `/start a_${S(1)}`)]);
  let env = h.tg.de('enviar').at(-1).args[0];
  assert.equal(env.html, '<h2>ℹ️ Alfa</h2><p><i>Aguardando desde 12:30.</i></p><p>Terminei a revisão.</p><p><b>Publico?</b></p>');
  assert.ok(logs(h).some((l) => l.includes(`Telegram: situacao da aba ${S(1)} pedida pelo link do painel (aguardando;`)), logs(h).join('\n'));
  h.tg.zerar();
  await lerTg(h, [msgTg(h, `/start a_${S(2)}`)]);
  env = h.tg.de('enviar').at(-1).args[0];
  assert.ok(env.html.startsWith('<h2>ℹ️ Bravo</h2><p><i>Fechada.</i></p>'), env.html);
  h.t = aos('12:30') + 24 * 60 * MIN;
  h.tg.zerar();
  await lerTg(h, [msgTg(h, `/start a_${S(1)}`)]);
  env = h.tg.de('enviar').at(-1).args[0];
  assert.ok(env.html.startsWith('<h2>ℹ️ Alfa</h2><p><i>Aguardando desde 14/10 12:30.</i></p>'), env.html);
});

// ---------- 11 e 12. pendencias e status ----------

test('T24 11. pendencias do grupo: so o Esperando e, no fim, "Aguardando (N): <t1>, <t2>."; Esperando vazio = a frase de nada e a linha; status = "aguardando desde HH:MM"', async () => {
  const h = montar();
  await cena(h);
  aguardarEv(h, [S(1), S(2)]);
  await h.p.passoEventos();
  h.enviados.length = 0;
  msg(h, { content: 'pendencias' });
  await h.p.passoGrupo();
  assert.deepEqual(h.enviados.map((x) => x.texto), [`${CAB}\n- Charlie (12:12): Publico?\nAguardando (2): Alfa, Bravo.`]);
  h.enviados.length = 0;
  msg(h, { content: 'status' });
  await h.p.passoGrupo();
  const st = h.enviados.at(-1).texto;
  assert.ok(st.includes('- Alfa (aguardando desde 12:30)'), st);
  assert.ok(st.includes('- Charlie (esperando você desde 12:12)'), st);
  aguardarEv(h, [S(3)], { providerMsgId: 'PROV-W' });
  await h.p.passoEventos();
  h.t += 2 * MIN; // o grupo manda no maximo 4 por minuto (a frase do mover foi a 4a)
  h.enviados.length = 0;
  msg(h, { content: 'pendencias' });
  await h.p.passoGrupo();
  assert.deepEqual(h.enviados.map((x) => x.texto), [`${CAB}\nNada esperando resposta sua.\nAguardando (3): Alfa, Bravo, Charlie.`]);
});

test('T24 12. pendencias no teto: a linha do Aguardando leva os nomes que cabem + "(e mais N)" e o Esperando e cortado antes dela; o texto inteiro cabe no teto', async () => {
  const h = montar();
  aba(h, SC, CENTRAL, 'repos-99');
  const fts = iso(aos('11:00'));
  mexer(h, (e) => {
    for (let i = 0; i < 60; i += 1) {
      const sid = S(100 + i);
      e.ultimosParou[sid] = {
        finalTs: fts, precisa: true, at: iso(h.t), titulo: `Aba com um nome bem comprido ${String(i).padStart(2, '0')}`, nome: null,
        pergunta: `Pergunta ${'longa '.repeat(30)}?`,
      };
      if (i >= 20) e.aguardando[sid] = { em: iso(h.t), finalTs: fts };
    }
  });
  h.enviados.length = 0;
  msg(h, { content: 'pendencias' });
  await h.p.passoGrupo();
  const t = h.enviados.at(-1).texto;
  assert.ok(Array.from(t).length <= 3400, String(Array.from(t).length));
  const linhas = t.split('\n');
  const ultima = linhas.at(-1);
  assert.match(ultima, /^Aguardando \(40\): Aba com um nome bem comprido 20, Aba com um nome bem comprido 21, .+ \(e mais \d+\)\.$/);
  assert.ok(Array.from(ultima).length <= 600, String(Array.from(ultima).length));
  assert.match(linhas.at(-2), /^\(e mais \d+\)$/, 'o Esperando cortado antes da linha');
});
