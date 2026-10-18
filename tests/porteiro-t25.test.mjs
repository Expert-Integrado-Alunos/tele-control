// Testes da T25 (PLANO-TELEGRAM.md, "T25 — a pergunta de aba fechada vai sozinha pro "Aguardando" depois de 2 dias";
// pedido do dono, no chat: «dá pra "limpar"? Ta com muuuito chat lá que eu acho qeu nao ta mais ativo na real», e a
// resposta «a» ao "Limpar agora e mover sozinho após 2 dias sem resposta"). O porteiro: o aguardarSozinho do
// passoMinuto (fechada com 48 h vai, com menos fica, aberta fica, pedido de OK fica, a que ja esta no Aguardando nao
// muda, trava e lista vazia = nada); o e.fixasNoEsperando (a trazida de volta fica, pergunta nova volta a valer, o mover
// a mao tira) e a poda; o painel e o pendencias com a movida; a frase do item 18 da central.
// Isolamento: pastas temporarias via SESSOES_WPP_DIR, CLAUDE_SESSIONS_DIR, CLAUDE_PROJECTS_DIR e SESSOES_WPP_LOG (nunca o
// ~/.claude real). Nenhuma rede: `tg` e `wpp` sao dubles; o pedido de OK e um arquivo na pasta temporaria. Harness
// copiado (enxuto) do tests/porteiro-t24.test.mjs. Nomes de aba sinteticos.
// Rodar: node --test --test-reporter=tap "tests/porteiro-t25.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { criarPorteiro } from '../porteiro.mjs';
import { NUMERO_DONO } from './lib/dados-whatsapp.mjs';
import { CENTRAL_TESTE, RAIZES_TESTE } from './lib/dados-central.mjs';

const require = createRequire(import.meta.url);
const lib = require('../hooks/lib/sessoes-wpp.js');
const PORTEIRO = fileURLToPath(new URL('../porteiro.mjs', import.meta.url));

const MIN = 60 * 1000;
const HORA = 60 * MIN;
const T0 = Date.parse('2026-10-14T15:00:00Z'); // 12:00 em Brasilia
const iso = (ms) => new Date(ms).toISOString();
const DONO = 700100200;
const BOT = 700900800;
const BOT_NOME = 'Teste_ControleBot';
const S = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SC = S(99); // a central
const CENTRAL = 'Central de sessões de teste';
const CAB = '🎛️ *Controle de sessões*';
const FINAL = [
  'Terminei a revisão.',
  '',
  '---',
  '🔴 **DECISÃO:** Publico? A) Sim, tudo hoje (recomendado) / B) Só as correções',
].join('\n');
const DECISAO = { decisao: true, fica: false, pergunta: false };
const COM_PERGUNTA = { decisao: false, fica: false, pergunta: true };
const FINAL_PERGUNTA = 'Rodei a migração no banco de teste.\n\nPosso apagar a tabela velha?';
const LOG_MOVEU = (n) => `aguardar sozinho: ${n} pergunta(s) de aba fechada sem resposta ha 2 dias pra Aguardando`;

// ---------- harness (copia enxuta do tests/porteiro-t24.test.mjs) ----------

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
  const raiz = pastaTemp('porteiro-t25-');
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
function pedidoOk(h, { codigo, sessionId, criado = h.t - MIN, expira = criado + 30 * MIN, status = 'pendente' }) {
  const dir = path.join(h.env.SESSOES_WPP_DIR, 'oks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${codigo}.json`), JSON.stringify({
    v: 1, codigo, sessionId, tipo: 'crm', acao: 'x', hashAcao: 'h', destinatarios: null,
    criadoEm: iso(criado), expiraEm: iso(expira), providerMsgId: 'P1', messageId: 'uuid-a', status,
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
// o passo de minuto na hora `ms` (os eventos pendentes antes, como no laco)
async function minutoEm(h, ms) {
  h.t = ms;
  await h.p.passoEventos();
  await h.p.passoMinuto();
}

// A cena: a central; Alfa (viva, pergunta das 12:10), Bravo (fechada, pergunta das 12:11), Charlie (fechada, pergunta das
// 12:20) e Delta (fechada, parada sem pergunta). Termina as 12:30.
async function cena(h) {
  aba(h, SC, CENTRAL, 'repos-99');
  for (const [n, t] of [[1, 'Alfa'], [2, 'Bravo'], [3, 'Charlie'], [4, 'Delta']]) aba(h, S(n), t);
  mexer(h, (e) => { e.tg.offset = 0; });
  h.tg.usuarioBot = BOT_NOME;
  await pararAs(h, '12:10', S(1), FINAL, DECISAO);
  await pararAs(h, '12:11', S(2), FINAL, DECISAO);
  await pararAs(h, '12:20', S(3), FINAL_PERGUNTA, COM_PERGUNTA);
  await pararAs(h, '12:21', S(4), 'Feito.', undefined);
  for (const sid of [S(2), S(3), S(4)]) fecharAba(h, sid);
  h.t = aos('12:30');
}

// ---------- 1. a regra ----------

test('T25 1. fechada com 48 h vai pro Aguardando (em = a hora do passo, finalTs da pergunta), com menos fica; aberta com 48 h fica; parada sem pergunta nada; 1 linha de log so quando move; painel e pendencias com a movida', async () => {
  const h = montar();
  await cena(h);
  await minutoEm(h, aos('12:11') + 48 * HORA - MIN); // Bravo com 47h59
  assert.deepEqual(estado(h).aguardando, {}, 'com menos de 48 h fica');
  assert.ok(!logs(h).some((l) => l.includes('aguardar sozinho')), 'sem mover = sem log');

  const t1 = aos('12:11') + 48 * HORA;
  await minutoEm(h, t1);
  assert.deepEqual(estado(h).aguardando, { [S(2)]: { em: iso(t1), finalTs: iso(aos('12:11')) } }, 'so o Bravo (o Alfa esta aberto)');
  assert.equal(logs(h).filter((l) => l.endsWith(LOG_MOVEU(1))).length, 1, logs(h).join('\n'));

  // o minuto seguinte nao mexe de novo nem loga
  await minutoEm(h, t1 + MIN);
  assert.deepEqual(estado(h).aguardando[S(2)], { em: iso(t1), finalTs: iso(aos('12:11')) }, 'a hora do mover nao muda');
  assert.equal(logs(h).filter((l) => l.includes('aguardar sozinho')).length, 1);

  // Charlie (12:20) chega nas 48 h
  const t2 = aos('12:20') + 48 * HORA;
  await minutoEm(h, t2);
  assert.deepEqual(Object.keys(estado(h).aguardando).sort(), [S(2), S(3)].sort());
  assert.equal(estado(h).aguardando[S(3)].em, iso(t2));
  assert.equal(estado(h).aguardando[S(1)], undefined, 'aberta com mais de 48 h fica no Esperando');
  assert.equal(estado(h).aguardando[S(4)], undefined, 'parada sem pergunta nao entra');

  await lerTg(h, [msgTg(h, '/painel')]);
  const d = painel(h);
  assert.deepEqual(d.esperando.map((x) => x.sid), [S(1)]);
  assert.deepEqual(d.aguardando.map((x) => [x.sid, x.fechada, x.em]), [[S(2), true, iso(t1)], [S(3), true, iso(t2)]]);
  h.enviados.length = 0;
  msg(h, { content: 'pendencias' });
  await h.p.passoGrupo();
  assert.equal(h.enviados.length, 1);
  assert.ok(h.enviados[0].texto.startsWith(`${CAB}\n- Alfa (`), h.enviados[0].texto);
  assert.ok(h.enviados[0].texto.endsWith('\nAguardando (2): Bravo, Charlie.'), h.enviados[0].texto);
});

test('T25 2. ficam: pedido de OK da aba fechada, a que ja esta no Aguardando (a hora do mover a mao), chave fora do UUID; trava ligada e nenhuma aba viva na lista = nada', async () => {
  const h = montar();
  await cena(h);
  aguardarEv(h, [S(3)]); // o dono ja moveu o Charlie as 12:30
  await h.p.passoEventos();
  const emMao = estado(h).aguardando[S(3)].em;
  const fts = iso(aos('12:15'));
  mexer(h, (e) => { e.ultimosParou['nao-e-uuid'] = { finalTs: fts, precisa: true, at: fts, titulo: 'Golf', nome: null, pergunta: 'Sigo?' }; });
  const t1 = aos('12:30') + 48 * HORA;
  mexer(h, (e) => { e.trava = true; });
  await minutoEm(h, t1);
  assert.deepEqual(Object.keys(estado(h).aguardando), [S(3)], 'travado = nada (o Bravo ja tem 48 h)');
  mexer(h, (e) => { e.trava = false; });
  // pedido de OK do Bravo criado ha mais de 48 h e ainda no prazo: o item dele e o OK (com a hora do OK)
  const okVelho = { codigo: 'ABC234', sessionId: S(2), criado: aos('12:12'), expira: t1 + 24 * HORA };
  pedidoOk(h, okVelho);
  await minutoEm(h, t1 + MIN);
  assert.deepEqual(estado(h).aguardando, { [S(3)]: { em: emMao, finalTs: iso(aos('12:20')) } }, 'o OK fica; o Charlie nao muda; a chave torta nao entra');
  assert.ok(!logs(h).some((l) => l.includes('aguardar sozinho')), logs(h).join('\n'));

  // o OK saiu: a pergunta do Bravo pode ir
  pedidoOk(h, { ...okVelho, status: 'usado' });
  // nenhuma aba viva na lista (a leitura falhou ou o PC sem sessao) = nao mexe
  for (const sid of [SC, S(1)]) fecharAba(h, sid);
  await minutoEm(h, t1 + 2 * MIN);
  assert.equal(estado(h).aguardando[S(2)], undefined, 'lista vazia = nao sabe quem esta fechada');
  // a central de volta na lista: vai o Bravo (o OK saiu) e o Alfa (fechou e a pergunta tem mais de 48 h)
  aba(h, SC, CENTRAL, 'repos-99');
  await minutoEm(h, t1 + 3 * MIN);
  assert.deepEqual(estado(h).aguardando[S(2)], { em: iso(t1 + 3 * MIN), finalTs: iso(aos('12:11')) });
  assert.deepEqual(estado(h).aguardando[S(1)], { em: iso(t1 + 3 * MIN), finalTs: iso(aos('12:10')) });
  assert.equal(logs(h).filter((l) => l.endsWith(LOG_MOVEU(2))).length, 1, logs(h).join('\n'));
});

// ---------- 2. a trazida de volta ----------

test('T25 3. trazida de volta: o --voltar grava e.fixasNoEsperando e a regra nao leva de novo; pergunta nova volta a valer (o registro sai na poda); o mover a mao tira o registro', async () => {
  const h = montar();
  await cena(h);
  const t1 = aos('12:20') + 48 * HORA;
  await minutoEm(h, t1);
  assert.deepEqual(Object.keys(estado(h).aguardando).sort(), [S(2), S(3)].sort());

  h.t = t1 + 5 * MIN;
  aguardarEv(h, [S(2)], { voltar: true, providerMsgId: 'PROV-V' });
  await h.p.passoEventos();
  assert.deepEqual(estado(h).fixasNoEsperando, { [S(2)]: { em: iso(t1 + 5 * MIN), finalTs: iso(aos('12:11')) } });
  await minutoEm(h, t1 + 6 * MIN);
  await minutoEm(h, t1 + 3 * 24 * HORA);
  assert.equal(estado(h).aguardando[S(2)], undefined, 'a trazida de volta fica no Esperando');
  await lerTg(h, [msgTg(h, '/painel')]);
  assert.deepEqual(painel(h).esperando.map((x) => x.sid), [S(1), S(2)]);

  // a aba reabre, pergunta de novo e fecha: a regra volta a valer pra pergunta nova
  aba(h, S(2), 'Bravo');
  const t2 = t1 + 3 * 24 * HORA + 10 * MIN;
  h.t = t2;
  evento(h, parou(h, S(2), { final: FINAL_PERGUNTA, marcas: COM_PERGUNTA }));
  await h.p.passoEventos();
  fecharAba(h, S(2));
  assert.deepEqual(estado(h).fixasNoEsperando, {}, 'pergunta nova = o registro de volta sai');
  await minutoEm(h, t2 + 48 * HORA);
  assert.deepEqual(estado(h).aguardando[S(2)], { em: iso(t2 + 48 * HORA), finalTs: iso(t2) });

  // trazer de volta e depois mover a mao: o registro de volta sai
  h.t = t2 + 48 * HORA + MIN;
  aguardarEv(h, [S(2)], { voltar: true, providerMsgId: 'PROV-V2' });
  await h.p.passoEventos();
  assert.ok(estado(h).fixasNoEsperando[S(2)]);
  h.t += MIN;
  aguardarEv(h, [S(2)], { providerMsgId: 'PROV-M2' });
  await h.p.passoEventos();
  assert.deepEqual(estado(h).fixasNoEsperando, {}, 'o mover a mao tira o registro');
  assert.ok(estado(h).aguardando[S(2)]);
});

test('T25 4. estado: e.fixasNoEsperando = {} no estado velho; poda: chave que nao e UUID, `em` ilegivel, sem a pergunta guardada, outro finalTs e parou sem pergunta saem; teto de 200 (as mais novas)', async () => {
  const h = montar();
  mexer(h, (e) => { delete e.fixasNoEsperando; });
  evento(h, parou(h, S(9)));
  await h.p.passoEventos();
  assert.deepEqual(estado(h).fixasNoEsperando, {}, 'estado velho sem a chave = {}');

  const fts = iso(h.t - 10 * MIN);
  const up = (titulo, o = {}) => ({ finalTs: fts, precisa: true, at: iso(h.t), titulo, nome: null, pergunta: 'Publico?', ...o });
  mexer(h, (e) => {
    e.ultimosParou = {
      [S(1)]: up('Alfa'), [S(2)]: up('Bravo'), [S(3)]: { finalTs: fts, precisa: false, at: iso(h.t) }, [S(4)]: up('Delta'),
      'nao-e-uuid': up('Golf'),
    };
    e.fixasNoEsperando = {
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
  assert.deepEqual(estado(h).fixasNoEsperando, { [S(1)]: { em: iso(h.t - MIN), finalTs: fts } });

  mexer(h, (e) => {
    e.ultimosParou = {};
    e.fixasNoEsperando = {};
    for (let i = 0; i < 205; i += 1) {
      e.ultimosParou[S(1000 + i)] = up(`Aba ${i}`);
      e.fixasNoEsperando[S(1000 + i)] = { em: iso(h.t - i * MIN), finalTs: fts };
    }
  });
  evento(h, parou(h, S(9), { finalTs: iso(h.t + 2) }));
  await h.p.passoEventos();
  const fx = estado(h).fixasNoEsperando;
  assert.equal(Object.keys(fx).length, 200);
  for (const i of [0, 199]) assert.ok(fx[S(1000 + i)], `S(${1000 + i}) fica`);
  for (const i of [200, 204]) assert.equal(fx[S(1000 + i)], undefined, `S(${1000 + i}) sai`);
});

// ---------- 3. a central ----------

test('T25 5. item 18 das instrucoes da central: a pergunta de aba fechada sem resposta ha 2 dias vai sozinha; a trazida de volta fica ate perguntar de novo', () => {
  const instr = fs.readFileSync(path.join(path.dirname(PORTEIRO), 'central', 'instrucoes.md'), 'utf8');
  const item = /^18\. [\s\S]*$/m.exec(instr);
  assert.ok(item, 'item 18 no fim');
  const corrido = item[0].replace(/\s+/g, ' ');
  assert.ok(corrido.includes('A pergunta de aba fechada sem resposta há 2 dias o porteiro move sozinho pra Aguardando'), corrido);
  assert.ok(corrido.includes('a que o dono trouxe de volta fica no Esperando até a aba perguntar de novo'), corrido);
});
