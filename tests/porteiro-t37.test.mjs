// sessoes-wpp — T37b1 (rotina do dia, o ENVIO no porteiro): o arquivo lote-<id>.json da pasta <estadoDir>/rotina/ vira 1
// resumo com som, fixado sem som, + ate 5 cartoes sem som com os teclados do lib/rotina-tg.mjs, com estado (e.rotinaTg),
// sem repetir mensagem depois de uma queda e fora da sonda do canal. T37b2 (testes "T37b2 N."): o toque (l:) grava 1
// linha no <estadoDir>/rotina/acoes.jsonl e edita o cartao e o contador do resumo; o "Ver mais" manda a reserva; a
// faxina do lote anterior e melhor esforco e a poda so tira lote limpo com 3 dias.
// Isolamento: pastas temporarias (pastaTemp) via SESSOES_WPP_DIR, CLAUDE_SESSIONS_DIR, CLAUDE_PROJECTS_DIR e
// SESSOES_WPP_LOG; nunca o ~/.claude real. Nenhuma rede: o `tg` e um duble (os message_id saem de UM contador, como no
// chat de verdade; `resp<Metodo>` = respostas roteirizadas). Relogio e `dormir` falsos.
// Harness: o montar e o dubleTg do tests/porteiro-ok-tg.test.mjs (molde do tests/porteiro-t36.test.mjs), com fixar,
// desafixar, enviarTexto e editarBotoes roteirizaveis.
// Rodar: node --test --test-reporter=tap "tests/porteiro-t37.test.mjs"
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { criarPorteiro } from '../porteiro.mjs';
import {
  validarLote, tecladoDoCartao, tecladoDoResumo, linhaDeAcao, textoDepoisDoToque, textoResumoComProgresso,
} from '../lib/rotina-tg.mjs';
import { NUMERO_DONO } from './lib/dados-whatsapp.mjs';
import { CENTRAL_TESTE, RAIZES_TESTE } from './lib/dados-central.mjs';

const MIN = 60 * 1000;
const T0 = Date.parse('2026-11-05T11:30:00Z'); // 08:30 em Brasilia
const iso = (ms) => new Date(ms).toISOString();
const DONO = 700100200; // chat do dono (sintetico)
const BOT = 700900800; // o bot (sintetico)
const NOME_BOT = 'Teste_ControleBot'; // o @ do bot de teste (o painel da T10 usa o mesmo tg.usuarioBot)
const SESSAO = '5a1f0c2e-1b7d-4c3a-9e2f-0123456789ab';
const LEITURAS_SEM_RELOGIO = 200;
const montados = [];

// ---------- harness (copia do tests/porteiro-ok-tg.test.mjs) ----------

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
function dubleTg(h) {
  const tg = {
    chamadas: [], lotes: [], respEnviar: [], respEnviarTexto: [], respEditarBotoes: [], respFixar: [], respDesafixar: [],
    lacoSemFim: false, usuarioBot: NOME_BOT,
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
    const lote = tg.lotes.shift();
    if (lote === undefined) {
      h.t += (Number(args?.esperaS) || 0) * 1000;
      return [];
    }
    return lote;
  };
  tg.enviar = async (pedido) => { gravar('enviar', [pedido]); return roteiro(tg.respEnviar) ?? { ok: true, messageId: novoId(), formato: 'rich' }; };
  tg.editar = async (messageId, pedido) => { gravar('editar', [messageId, pedido]); return { ok: true }; };
  tg.apagar = async (messageId) => { gravar('apagar', [messageId]); return { ok: true }; };
  tg.editarBotoes = async (messageId, botoes) => { gravar('editarBotoes', [messageId, botoes]); return roteiro(tg.respEditarBotoes) ?? { ok: true }; };
  tg.responderToque = async (id, texto) => { gravar('responderToque', [id, texto]); return { ok: true }; };
  tg.enviarTexto = async (pedido) => { gravar('enviarTexto', [pedido]); return roteiro(tg.respEnviarTexto) ?? { ok: true, messageId: novoId() }; };
  tg.editarTexto = async (messageId, pedido) => { gravar('editarTexto', [messageId, pedido]); return { ok: true }; };
  tg.fixar = async (messageId, opcoes) => { gravar('fixar', [messageId, opcoes]); return roteiro(tg.respFixar) ?? { ok: true }; };
  tg.desafixar = async (messageId) => { gravar('desafixar', [messageId]); return roteiro(tg.respDesafixar) ?? { ok: true }; };
  tg.baixar = async () => ({ ok: false, erro: 'duble sem download' });
  tg.quemSou = async () => { gravar('quemSou', []); return { ok: true, id: BOT, username: NOME_BOT }; };
  tg.definirComandos = async (c) => { gravar('definirComandos', [c]); return { ok: true }; };
  tg.de = (metodo) => tg.chamadas.filter((c) => c.metodo === metodo);
  return tg;
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

// `rotina` = config.json com telegram.ligado e telegram.rotina.ligado; false = so telegram.ligado (a rotina desligada).
function montar({ rotina = true, sondaTg = false } = {}) {
  const raiz = pastaTemp('t37b1-');
  const env = {
    SESSOES_WPP_DIR: path.join(raiz, 'estado'),
    CLAUDE_SESSIONS_DIR: path.join(raiz, 'sessions'),
    CLAUDE_PROJECTS_DIR: path.join(raiz, 'projects'),
    SESSOES_WPP_LOG: path.join(raiz, 'porteiro.log'),
  };
  for (const d of [env.SESSOES_WPP_DIR, env.CLAUDE_SESSIONS_DIR, env.CLAUDE_PROJECTS_DIR]) fs.mkdirSync(d, { recursive: true });
  const telegram = rotina ? { ligado: true, rotina: { ligado: true } } : { ligado: true };
  fs.writeFileSync(path.join(env.SESSOES_WPP_DIR, 'config.json'), JSON.stringify({ telegram }));
  const h = { raiz, env, t: T0, idle: 0, grupo: [], enviados: [], entregas: [], nUpd: 100, nMid: 7000 };
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
  h.mensageiro = { async entregar(p) { h.entregas.push(p); return { status: 'enviado', detalhe: '' }; } };
  h.tg = dubleTg(h);
  h.opcoes = {
    wpp: h.wpp, numeroDono: NUMERO_DONO, mensageiro: h.mensageiro, ocioso: async () => h.idle, agora: () => h.t, env, ensaio: false,
    tg: h.tg, abrirCentral: () => {}, rand: randFixo(), dormir: async (ms) => { h.t += ms; }, sondaTg, identTg: { chatId: DONO, botId: BOT },
    central: CENTRAL_TESTE, raizesSessao: RAIZES_TESTE,
  };
  h.cru = criarPorteiro(h.opcoes);
  h.p = comBomba(h.cru);
  mexer(h, (e) => { e.tg.offset = 0; }); // historico ja pulado
  h.t += 1000;
  montados.push(h);
  return h;
}
afterEach(() => {
  const ruins = montados.filter((h) => h.tg.lacoSemFim);
  montados.length = 0;
  assert.equal(ruins.length, 0, `duble: ${LEITURAS_SEM_RELOGIO} leituras seguidas sem o relogio andar (laco sem fim no porteiro)`);
});

// Mensagem do dono no chat do bot (como o getUpdates devolve).
function msgTg(h, texto) {
  h.nUpd += 1;
  h.nMid += 1;
  const m = {
    message_id: h.nMid, date: Math.floor(h.t / 1000), text: texto,
    chat: { id: DONO, type: 'private', first_name: 'Davi' }, from: { id: DONO, is_bot: false, first_name: 'Davi' },
  };
  return { update_id: h.nUpd, message: m };
}

// ---------- o lote da rotina (contrato do validarLote) ----------

const pastaDe = (h) => path.join(h.env.SESSOES_WPP_DIR, 'rotina');
const arquivos = (h) => {
  try { return fs.readdirSync(pastaDe(h)).sort(); } catch { return []; }
};
// 5 cartoes, 1 de cada jeito de teclado: link no Responder, so retorno, aba (link start=a_ com o @ do bot), prazo, promessa.
function loteRotina(h, { id = '20261105m', gerado = h.t, resumo = `Resumo ${id}: 2 decisões e 3 conversas pedem você hoje.`, reserva = [], mais = 0 } = {}) {
  return {
    versao: 1, id, gerado_em: iso(gerado), enviar: true, resumo,
    cartoes: [
      { n: 1, id: 'wa:conversa-1', tipo: 'conversa', titulo: 'Cliente Alfa', texto: 'Cliente Alfa pediu retorno ontem.\nResponder hoje.', verbos: ['responder', 'adiar', 'nao_precisa', 'delegar'], link: 'https://exemplo.test/conversa/1', assinatura: 'a1' },
      { n: 2, id: 'brain:decisao-2', tipo: 'decisao', titulo: 'Preço do curso', texto: 'Subir o preço do curso em dezembro?\nRecomendo sim.', verbos: ['sim', 'nao', 'adiar', 'abrir'], assinatura: 'a2' },
      { n: 3, id: 'aba:3', tipo: 'aba', titulo: 'Aba do site', texto: 'A aba do site espera sua resposta.\nAbra pra ver o A/B.', verbos: ['abrir', 'adiar'], ref: { sessao: SESSAO } },
      { n: 4, id: 'prazo:4', tipo: 'prazo', titulo: 'Contrato Beta', texto: 'Contrato Beta vence hoje às 18h.\nAssinar.', verbos: ['feito', 'adiar', 'delegar', 'abrir'], assinatura: 'a4' },
      { n: 5, id: 'promessa:5', tipo: 'promessa', titulo: 'Material Gama', texto: 'Você prometeu mandar o Material Gama.\nMandar hoje.', verbos: ['feito', 'adiar', 'nao_precisa'], assinatura: 'a5' },
    ],
    reserva, mais,
  };
}
function porLote(h, obj, nome = `lote-${obj.id}.json`) {
  fs.mkdirSync(pastaDe(h), { recursive: true });
  fs.writeFileSync(path.join(pastaDe(h), nome), JSON.stringify(obj, null, 2));
}
// O lote como a lib normaliza (o que o porteiro tem que mandar)
function normal(h, obj) {
  const v = validarLote(obj, { agoraMs: h.t });
  assert.ok(v.ok, `lote de teste invalido: ${v.motivo}`);
  return v.lote;
}
const DA_ROTINA = ['enviarTexto', 'fixar', 'desafixar', 'editarBotoes']; // os metodos do adaptador que a rotina usa
const enviosDaRotina = (h) => h.tg.chamadas.filter((c) => DA_ROTINA.includes(c.metodo));

test('T37b1 1. lote valido = resumo com som e fixado sem som + 5 cartoes sem som com os teclados certos, .enviado.json e estado com os msgId; a volta seguinte nao manda nada', async () => {
  const h = montar();
  const reserva = [{ n: 6, id: 'res:6', tipo: 'prazo', titulo: 'Reserva Delta', texto: 'Um prazo da reserva.\nOlhar amanhã.', verbos: ['feito', 'adiar'] }];
  const obj = loteRotina(h, { reserva, mais: 2 });
  const lote = normal(h, obj);
  porLote(h, obj);
  await h.p.esperarTelegram(15000);

  const textos = h.tg.de('enviarTexto').map((c) => c.args[0]);
  assert.equal(textos.length, 6, 'resumo + 5 cartoes');
  assert.deepEqual(textos[0], { texto: obj.resumo, botoes: tecladoDoResumo(lote), silencioso: false }, 'o resumo sai com som');
  assert.deepEqual(textos[0].botoes, [[{ texto: 'Ver mais 1', dados: 'l:20261105m:0:mais' }]]);
  lote.cartoes.forEach((c, i) => {
    assert.deepEqual(textos[i + 1], { texto: c.texto, botoes: tecladoDoCartao(c, '20261105m', { nomeBot: NOME_BOT }), silencioso: true }, `cartao ${c.n} sem som`);
  });
  assert.deepEqual(textos[1].botoes[0][0], { texto: 'Responder', url: 'https://exemplo.test/conversa/1' }, 'link no Responder');
  assert.ok(textos[3].botoes[0][0].url.includes(NOME_BOT) && textos[3].botoes[0][0].url.includes(SESSAO), 'aba: o Abrir e o link start=a_ do painel');
  assert.deepEqual(textos[2].botoes[0][0], { texto: 'Sim', dados: 'l:20261105m:2:sim' }, 'o resto e botao de retorno');

  const st = estado(h).rotinaTg;
  const l = st.lotes['20261105m'];
  assert.equal(st.atual, '20261105m');
  assert.deepEqual(h.tg.de('fixar').map((c) => c.args), [[l.resumoMsgId, { silencioso: true }]], 'fixa o resumo sem som');
  assert.deepEqual(
    { gerado_em: l.gerado_em, resumo: l.resumo, fixado: l.fixado, mais: l.mais, completo: l.completo },
    { gerado_em: obj.gerado_em, resumo: obj.resumo, fixado: true, mais: 2, completo: true },
  );
  assert.deepEqual(l.cartoes.map((c) => c.msgId), [1, 2, 3, 4, 5].map((i) => l.resumoMsgId + i), 'os cartoes logo depois do resumo, em ordem');
  assert.deepEqual(l.cartoes[0], {
    n: 1, id: 'wa:conversa-1', assinatura: 'a1', titulo: 'Cliente Alfa', tipo: 'conversa', verbos: ['responder', 'adiar', 'nao_precisa', 'delegar'],
    link: 'https://exemplo.test/conversa/1', ref: null, msgId: l.resumoMsgId + 1,
  });
  assert.deepEqual(l.cartoes[2].ref, { sessao: SESSAO });
  assert.equal(l.cartoes[2].assinatura, '', 'assinatura ausente = ""');
  assert.deepEqual(l.reserva, [{
    n: 6, id: 'res:6', assinatura: '', titulo: 'Reserva Delta', tipo: 'prazo', verbos: ['feito', 'adiar'], link: null, ref: null,
    texto: 'Um prazo da reserva.\nOlhar amanhã.',
  }], 'a reserva vai pro estado sem msgId (e com o texto pro "Ver mais")');
  assert.ok(l.cartoes.every((c) => !('texto' in c)), 'o cartao enviado nao guarda o texto');
  assert.deepEqual(arquivos(h), ['lote-20261105m.enviado.json']);

  // a volta seguinte nao manda nada; o mesmo arquivo de novo (mesmo id e gerado_em) = .enviado.json, nada sai
  const n0 = enviosDaRotina(h).length;
  await h.p.esperarTelegram(15000);
  porLote(h, obj);
  await h.p.esperarTelegram(15000);
  assert.equal(enviosDaRotina(h).length, n0, 'nada sai de novo');
  assert.deepEqual(arquivos(h), ['lote-20261105m.enviado.json']);
  assert.deepEqual(estado(h).rotinaTg, st, 'o estado nao muda');
});

test('T37b1 2. o 3o cartao falha (sem esperarS) = a volta seguinte manda so do 3o em diante, nada repetido; 3 falhas no mesmo passo = .falhou.json e o lote fica como esta', async () => {
  const h = montar();
  const obj = loteRotina(h);
  const lote = normal(h, obj);
  porLote(h, obj);
  h.tg.respEnviarTexto.push(undefined, undefined, undefined, { ok: false, erro: 'enviarTexto: Bad Gateway', codigo: 502 });
  await h.p.esperarTelegram(15000);
  const t = (c) => c.texto;
  assert.deepEqual(h.tg.de('enviarTexto').map((c) => c.args[0].texto), [obj.resumo, ...lote.cartoes.slice(0, 3).map(t)], 'resumo, 1, 2 e o 3 que falhou');
  let st = estado(h).rotinaTg;
  assert.equal(st.atual, null, 'o lote so vira atual completo');
  assert.equal(st.lotes['20261105m'].completo, false);
  assert.deepEqual(st.lotes['20261105m'].cartoes.map((c) => Number.isSafeInteger(c.msgId)), [true, true, false, false, false]);
  assert.deepEqual(arquivos(h), ['lote-20261105m.json'], 'o arquivo fica pra volta seguinte');
  assert.ok(logs(h).some((x) => x.includes('rotina 20261105m: cartao 3 falhou') && x.includes('1 de 3')), logs(h).join('\n'));

  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.de('enviarTexto').slice(4).map((c) => c.args[0].texto), lote.cartoes.slice(2).map(t), 'so do 3o em diante');
  assert.equal(h.tg.de('fixar').length, 1, 'o resumo nao sai nem e fixado de novo');
  st = estado(h).rotinaTg;
  const ids = st.lotes['20261105m'].cartoes.map((c) => c.msgId);
  assert.equal(new Set([st.lotes['20261105m'].resumoMsgId, ...ids]).size, 6);
  assert.equal(st.lotes['20261105m'].completo, true);
  assert.equal(st.atual, '20261105m');
  assert.deepEqual(arquivos(h), ['lote-20261105m.enviado.json']);

  // lote da tarde: o 2o cartao falha 3 vezes seguidas = .falhou.json; o que ja saiu fica no estado e nao sai de novo
  porLote(h, loteRotina(h, { id: '20261105t' }));
  const falha = { ok: false, erro: 'enviarTexto: Bad Gateway', codigo: 502 };
  h.tg.respEnviarTexto.push(undefined, undefined, falha, falha, falha);
  const n0 = h.tg.de('enviarTexto').length;
  for (let i = 0; i < 4; i++) await h.p.esperarTelegram(15000);
  const daTarde = h.tg.de('enviarTexto').slice(n0).map((c) => c.args[0].texto);
  const c1 = lote.cartoes[0].texto;
  const c2 = lote.cartoes[1].texto;
  assert.deepEqual(daTarde, ['Resumo 20261105t: 2 decisões e 3 conversas pedem você hoje.', c1, c2, c2, c2], 'resumo, cartao 1 e o 2 tres vezes; nada depois');
  st = estado(h).rotinaTg;
  assert.deepEqual(st.lotes['20261105t'].cartoes.map((c) => Number.isSafeInteger(c.msgId)), [true, false, false, false, false]);
  assert.equal(st.lotes['20261105t'].completo, false);
  assert.equal(st.atual, '20261105m', 'o lote que falhou nao vira atual');
  assert.deepEqual(arquivos(h), ['lote-20261105m.enviado.json', 'lote-20261105t.falhou.json']);
  assert.ok(logs(h).some((x) => x.includes('rotina 20261105t: cartao 2 falhou 3 vezes') && x.includes('.falhou.json')), logs(h).join('\n'));
});

test('T37b1 3. lote novo com o anterior aberto = teclados do anterior tirados e resumo dele desafixado antes do novo; o mesmo id com gerado_em mais novo substitui do mesmo jeito', async () => {
  const h = montar();
  porLote(h, loteRotina(h, { id: '20261105m' }));
  await h.p.esperarTelegram(15000);
  const a = estado(h).rotinaTg.lotes['20261105m'];
  const idsA = [a.resumoMsgId, ...a.cartoes.map((c) => c.msgId)];

  porLote(h, loteRotina(h, { id: '20261105t' }));
  const c0 = h.tg.chamadas.length;
  await h.p.esperarTelegram(15000);
  const fase = h.tg.chamadas.slice(c0).filter((c) => DA_ROTINA.includes(c.metodo));
  const b = estado(h).rotinaTg.lotes['20261105t'];
  assert.deepEqual(fase.slice(0, 7).map((c) => [c.metodo, ...c.args]), [
    ...idsA.map((id) => ['editarBotoes', id, null]), ['desafixar', a.resumoMsgId],
  ], 'primeiro o anterior: sem teclado e desafixado');
  assert.deepEqual(fase.slice(7, 9).map((c) => c.metodo), ['enviarTexto', 'fixar'], 'depois o resumo novo, fixado');
  assert.deepEqual(fase[8].args, [b.resumoMsgId, { silencioso: true }]);
  let st = estado(h).rotinaTg;
  assert.equal(st.atual, '20261105t');
  assert.equal(st.lotes['20261105m'].fixado, false, 'o anterior ficou desafixado no estado');
  assert.equal(st.lotes['20261105t'].fixado, true);

  // o mesmo id com gerado_em mais novo (o dono pediu de novo) = substitui do mesmo jeito; o lote da manha nao e tocado
  const novo = loteRotina(h, { id: '20261105t', resumo: 'Resumo refeito: 1 decisão pede você hoje.' });
  assert.notEqual(novo.gerado_em, b.gerado_em);
  porLote(h, novo);
  const c1 = h.tg.chamadas.length;
  await h.p.esperarTelegram(15000);
  const fase2 = h.tg.chamadas.slice(c1).filter((c) => DA_ROTINA.includes(c.metodo));
  const idsB = [b.resumoMsgId, ...b.cartoes.map((c) => c.msgId)];
  assert.deepEqual(fase2.slice(0, 7).map((c) => [c.metodo, ...c.args]), [
    ...idsB.map((id) => ['editarBotoes', id, null]), ['desafixar', b.resumoMsgId],
  ]);
  assert.deepEqual(fase2[7].args[0].texto, 'Resumo refeito: 1 decisão pede você hoje.');
  st = estado(h).rotinaTg;
  const b2 = st.lotes['20261105t'];
  assert.deepEqual(fase2[8].args, [b2.resumoMsgId, { silencioso: true }]);
  assert.equal(b2.gerado_em, novo.gerado_em);
  assert.equal(b2.completo, true);
  assert.ok(b2.resumoMsgId > Math.max(...idsB), 'mensagens novas');
  assert.equal(st.atual, '20261105t');
  assert.ok(fase2.every((c) => !idsA.includes(c.args[0])), 'o lote da manha nao e tocado de novo');
  assert.deepEqual(arquivos(h), ['lote-20261105m.enviado.json', 'lote-20261105t.enviado.json']);
});

test('T37b1 4. lote velho, invalido ou ilegivel = .recusado.json + log com o motivo e sem o texto do lote, nada enviado; telegram.rotina.ligado ausente = nada enviado e o arquivo fica', async () => {
  const h = montar();
  const velho = loteRotina(h, { id: '20261104n', gerado: h.t - 4 * 60 * MIN, resumo: 'Resumo velho com segredo Xi' });
  const invalido = loteRotina(h, { id: '20261105m', resumo: 'Resumo invalido com segredo Omicron' });
  invalido.cartoes[1].tipo = 'pedido';
  porLote(h, velho);
  porLote(h, invalido);
  fs.writeFileSync(path.join(pastaDe(h), 'lote-20261105t.json'), '{ "versao": 1, "resumo": "Texto ilegivel com segredo Pi",');
  await h.p.esperarTelegram(15000);
  assert.equal(enviosDaRotina(h).length, 0, 'nada enviado');
  assert.deepEqual(arquivos(h), ['lote-20261104n.recusado.json', 'lote-20261105m.recusado.json', 'lote-20261105t.recusado.json']);
  const linhas = logs(h);
  for (const [nome, motivo] of [['lote-20261104n.json', 'velho'], ['lote-20261105m.json', 'cartoes[1].tipo'], ['lote-20261105t.json', 'ilegivel']]) {
    assert.ok(linhas.some((x) => x.includes(`rotina ${nome} recusada (${motivo})`)), `${nome}: ${linhas.join('\n')}`);
  }
  const textosDoLote = [velho, invalido].flatMap((o) => [o.resumo, ...o.cartoes.flatMap((c) => [c.titulo, ...c.texto.split('\n')])]);
  for (const s of [...textosDoLote, 'segredo Pi']) assert.ok(linhas.every((x) => !x.includes(s)), `o log nao leva o texto do lote: ${s}`);
  assert.deepEqual(estado(h).rotinaTg, { atual: null, lotes: {} });

  // a rotina desligada (so telegram.ligado): nada sai e o arquivo continua na pasta
  const h2 = montar({ rotina: false });
  porLote(h2, loteRotina(h2));
  await h2.p.esperarTelegram(15000);
  await h2.p.esperarTelegram(15000);
  assert.equal(enviosDaRotina(h2).length, 0);
  assert.deepEqual(arquivos(h2), ['lote-20261105m.json']);
  assert.ok(logs(h2).every((x) => !x.includes('rotina')), logs(h2).join('\n'));
});

test('T37b1 5. 429 com esperarS = nada ate passar o prazo; depois continua de onde parou', async () => {
  const h = montar();
  const obj = loteRotina(h);
  const lote = normal(h, obj);
  porLote(h, obj);
  h.tg.respEnviarTexto.push(undefined, undefined, { ok: false, erro: 'enviarTexto: Too Many Requests', codigo: 429, esperarS: 40 });
  const t429 = h.t;
  await h.p.esperarTelegram(15000); // resumo e cartao 1 saem; o 2 leva 429 (40 s)
  assert.equal(h.tg.de('enviarTexto').length, 3);
  const n0 = enviosDaRotina(h).length;
  await h.p.esperarTelegram(15000); // +15 s
  await h.p.esperarTelegram(15000); // +30 s
  assert.ok(h.t < t429 + 40 * 1000 + 15000);
  assert.equal(enviosDaRotina(h).length, n0, 'nada antes do prazo');
  assert.deepEqual(arquivos(h), ['lote-20261105m.json']);
  await h.p.esperarTelegram(15000); // +45 s: passou o prazo
  assert.deepEqual(h.tg.de('enviarTexto').slice(3).map((c) => c.args[0].texto), lote.cartoes.slice(1).map((c) => c.texto), 'do 2o em diante');
  assert.equal(h.tg.de('fixar').length, 1);
  const l = estado(h).rotinaTg.lotes['20261105m'];
  assert.equal(l.completo, true);
  assert.equal(new Set([l.resumoMsgId, ...l.cartoes.map((c) => c.msgId)]).size, 6);
  assert.deepEqual(arquivos(h), ['lote-20261105m.enviado.json'], 'o 429 nao conta como falha');
  assert.ok(logs(h).some((x) => x.includes('rotina 20261105m: cartao 2 falhou') && x.includes('de novo em 40 s')), logs(h).join('\n'));
});

test('T37b1 6. os msgId da rotina vao no idsDeFora do drenar: a sonda do envio incerto nunca sonda nem apaga mensagem da rotina', async () => {
  const h = montar({ sondaTg: true });
  // 1. a linha do sistema do "status" sai com envio incerto (a mensagem chegou: o id seguinte foi gasto)
  h.tg.respEnviar.push(() => { h.nMid += 1; return { ok: false, incerto: true, erro: 'enviar: timeout', codigo: 0 }; });
  const u1 = msgTg(h, 'status');
  h.tg.lotes.push([u1]);
  await h.p.esperarTelegram(15000);
  const perdido = u1.message.message_id + 1;
  // 2. a rotina sai depois (ids acima do da mensagem incerta: dentro da janela da sonda)
  porLote(h, loteRotina(h));
  await h.p.esperarTelegram(15000);
  const l = estado(h).rotinaTg.lotes['20261105m'];
  const daRotina = [l.resumoMsgId, ...l.cartoes.map((c) => c.msgId)];
  assert.equal(l.resumoMsgId, perdido + 1);
  // 3. passado o recuo, o reenvio sai e a sonda confere os ids do meio: so o perdido, nunca os da rotina
  h.t += 30 * 1000;
  await h.p.esperarTelegram(15000);
  const sondados = h.tg.de('editarBotoes').map((c) => c.args[0]);
  const apagados = h.tg.de('apagar').map((c) => c.args[0]);
  assert.ok(sondados.includes(perdido), 'a sonda esta ligada e olhou o id perdido');
  for (const id of daRotina) {
    assert.ok(!sondados.includes(id), `a mensagem ${id} da rotina nunca e sondada`);
    assert.ok(!apagados.includes(id), `a mensagem ${id} da rotina nunca e apagada`);
  }
  assert.equal(estado(h).rotinaTg.lotes['20261105m'].completo, true);
});

// ---------- T37b2: o toque nos botoes do lote (l:<lote>:<n>:<verbo>; "Ver mais" = l:<lote>:0:mais) ----------

// Toque do dono num botao (como o getUpdates devolve; molde do tests/porteiro-ok-tg.test.mjs).
function toqueTg(h, dados, messageId) {
  h.nUpd += 1;
  return {
    update_id: h.nUpd,
    callback_query: { id: `q${h.nUpd}`, from: { id: DONO, is_bot: false }, message: { message_id: messageId, chat: { id: DONO, type: 'private' } }, data: dados },
  };
}
// 1 toque numa volta do porteiro -> o texto do balao (undefined = so tirou o relogio). O balao sai sempre, 1 vez.
async function tocar(h, dados, messageId) {
  const u = toqueTg(h, dados, messageId);
  h.tg.lotes.push([u]);
  await h.p.esperarTelegram(5000);
  const r = h.tg.de('responderToque').filter((c) => c.args[0] === u.callback_query.id);
  assert.equal(r.length, 1, `o balao do toque ${dados} sai 1 vez`);
  return r[0].args[1];
}
const arqAcoes = (h) => path.join(pastaDe(h), 'acoes.jsonl');
const acoes = (h) => {
  try { return fs.readFileSync(arqAcoes(h), 'utf8'); } catch { return null; }
};
const MEXEM = ['enviarTexto', 'editarTexto', 'editarBotoes', 'fixar', 'desafixar', 'apagar', 'enviar', 'editar'];
const mexidas = (h, desde) => h.tg.chamadas.slice(desde).filter((c) => MEXEM.includes(c.metodo));
const VELHO = 'Essa pergunta já mudou.';
const RESERVA = [
  { n: 6, id: 'res:6', tipo: 'prazo', titulo: 'Reserva Delta', texto: 'Um prazo da reserva.\nOlhar amanhã.', verbos: ['feito', 'adiar'] },
  { n: 7, id: 'res:7', tipo: 'conversa', titulo: 'Reserva Eta', texto: 'Uma conversa da reserva.\nResponder hoje.', verbos: ['responder', 'adiar'], link: 'https://exemplo.test/conversa/7' },
  { n: 8, id: 'res:8', tipo: 'aba', titulo: 'Reserva Teta', texto: 'Uma aba da reserva.\nAbrir pra ver.', verbos: ['abrir', 'adiar'], ref: { sessao: SESSAO } },
];
// O lote vai pra pasta e sai numa volta -> {obj, lote (normalizado), l (a entrada no estado)}.
async function comLote(h, opcoes) {
  const obj = loteRotina(h, opcoes);
  porLote(h, obj);
  await h.p.esperarTelegram(15000);
  return { obj, lote: normal(h, obj), l: estado(h).rotinaTg.lotes[obj.id] };
}
function religar(h) {
  h.cru = criarPorteiro(h.opcoes);
  h.p = comBomba(h.cru);
}

test('T37b2 1. toque valido = 1 linha no acoes.jsonl (a do linhaDeAcao, na hora do porteiro), balao "Anotado: X.", cartao editado sem teclado e resumo com "1 de 5 resolvidos."; os outros 4 = "Tudo resolvido neste lote."; nada vai pra aba', async () => {
  const h = montar();
  const { l } = await comLote(h);
  const c2 = l.cartoes[1];
  const n0 = h.tg.chamadas.length;
  const t = h.t;
  assert.equal(await tocar(h, 'l:20261105m:2:sim', c2.msgId), 'Anotado: Sim.');
  const c2e = estado(h).rotinaTg.lotes['20261105m'].cartoes[1];
  assert.deepEqual([c2e.escolha, c2e.escolhaEm], ['sim', iso(t)], 'a escolha e a hora (o relogio do porteiro) no estado');
  assert.equal(acoes(h), linhaDeAcao({ ts: iso(t), loteId: '20261105m', cartao: c2, verbo: 'sim' }), '1 linha, a do linhaDeAcao');
  assert.deepEqual(mexidas(h, n0).map((c) => [c.metodo, ...c.args]), [
    ['editarTexto', c2.msgId, { texto: textoDepoisDoToque(c2, 'sim'), botoes: null }],
    ['editarTexto', l.resumoMsgId, { texto: textoResumoComProgresso(l.resumo, 1, 5), botoes: null }],
  ], 'o cartao vira 1 linha sem teclado; o resumo ganha o contador');
  assert.equal(textoDepoisDoToque(c2, 'sim'), '2. Preço do curso: anotado (Sim). Volta no próximo dia útil se seguir pendente.');
  assert.equal(textoResumoComProgresso(l.resumo, 1, 5), `${l.resumo}\n1 de 5 resolvidos.`);

  const baloes = [];
  for (const [n, verbo] of [[1, 'adiar'], [3, 'adiar'], [4, 'feito'], [5, 'nao_precisa']]) baloes.push(await tocar(h, `l:20261105m:${n}:${verbo}`, l.cartoes[n - 1].msgId));
  assert.deepEqual(baloes, ['Anotado: Adiar.', 'Anotado: Adiar.', 'Anotado: Feito.', 'Anotado: Não precisa.']);
  const linhas = acoes(h).split('\n');
  assert.equal(linhas.pop(), '', 'cada linha termina em \\n');
  assert.deepEqual(linhas.map((x) => JSON.parse(x)).map((x) => [x.lote, x.n, x.id, x.assinatura, x.verbo, x.origem]), [
    ['20261105m', 2, 'brain:decisao-2', 'a2', 'sim', 'botao'], ['20261105m', 1, 'wa:conversa-1', 'a1', 'adiar', 'botao'],
    ['20261105m', 3, 'aba:3', '', 'adiar', 'botao'], ['20261105m', 4, 'prazo:4', 'a4', 'feito', 'botao'],
    ['20261105m', 5, 'promessa:5', 'a5', 'nao_precisa', 'botao'],
  ]);
  const resumos = h.tg.de('editarTexto').filter((c) => c.args[0] === l.resumoMsgId).map((c) => c.args[1]);
  assert.deepEqual(resumos.map((x) => x.texto.split('\n')[1]), ['1 de 5 resolvidos.', '2 de 5 resolvidos.', '3 de 5 resolvidos.', '4 de 5 resolvidos.', 'Tudo resolvido neste lote.']);
  assert.deepEqual(resumos.at(-1), { texto: `${l.resumo}\nTudo resolvido neste lote.`, botoes: null });
  assert.ok(estado(h).rotinaTg.lotes['20261105m'].cartoes.every((c) => typeof c.escolha === 'string'));
  assert.equal(h.entregas.length, 0, 'nada vai pra aba');
  assert.deepEqual(estado(h).filaEntrega, [], 'nada na fila de entrega');
});

test('T37b2 2. o mesmo toque de novo = "Já anotado.", o acoes.jsonl continua com 1 linha e so o cartao e editado de novo, com a escolha que ja estava (outro verbo do mesmo cartao idem)', async () => {
  const h = montar();
  const { l } = await comLote(h);
  const c4 = l.cartoes[3];
  assert.equal(await tocar(h, 'l:20261105m:4:feito', c4.msgId), 'Anotado: Feito.');
  const linha = acoes(h);
  const st = estado(h).rotinaTg;
  const n0 = h.tg.chamadas.length;
  assert.equal(await tocar(h, 'l:20261105m:4:feito', c4.msgId), 'Já anotado.');
  assert.equal(await tocar(h, 'l:20261105m:4:adiar', c4.msgId), 'Já anotado.', 'a edicao de antes falhou e os botoes ficaram: a escolha nao muda');
  assert.equal(acoes(h), linha, 'nenhuma linha nova');
  assert.equal(linha.split('\n').filter(Boolean).length, 1);
  const refeita = ['editarTexto', c4.msgId, { texto: '4. Contrato Beta: feito.', botoes: null }];
  assert.deepEqual(mexidas(h, n0).map((c) => [c.metodo, ...c.args]), [refeita, refeita]);
  assert.deepEqual(estado(h).rotinaTg, st, 'o estado nao muda');
});

test('T37b2 3. toque que nao confere (mensagem de outro cartao ou velha, verbo fora do cartao, lote que nao e o atual, cartao que nao existe, l: torto, "Ver mais" fora do resumo) = toque velho, nada gravado nem editado; com a rotina desligada o l: nao entra no ramo da rotina', async () => {
  const h = montar();
  const { l: m } = await comLote(h, { id: '20261105m', reserva: [RESERVA[0]] });
  const { l: t } = await comLote(h, { id: '20261105t' });
  const st = estado(h).rotinaTg;
  assert.equal(st.atual, '20261105t');
  const n0 = h.tg.chamadas.length;
  const ruins = [
    ['l:20261105t:2:sim', t.cartoes[2].msgId], // a mensagem de outro cartao
    ['l:20261105t:2:sim', m.cartoes[1].msgId], // mensagem velha: o mesmo n no lote anterior
    ['l:20261105t:2:feito', t.cartoes[1].msgId], // verbo que nao e do cartao (decisao)
    ['l:20261105m:2:sim', m.cartoes[1].msgId], // lote que nao e o atual (ainda no estado)
    ['l:20261104n:2:sim', t.cartoes[1].msgId], // lote que nao existe
    ['l:20261105t:6:feito', t.cartoes[0].msgId], // cartao que nao existe no lote atual
    ['l:20261105t:2:xyz', t.cartoes[1].msgId], ['l:20261105t:2', t.cartoes[1].msgId], ['l:', t.cartoes[1].msgId],
    ['l:20261105t:11:sim', t.cartoes[1].msgId], ['l:20261105t:2:sim:x', t.cartoes[1].msgId],
    ['l:20261105t:0:mais', t.cartoes[0].msgId], // "Ver mais" fora da mensagem do resumo
    ['l:20261105m:0:mais', m.resumoMsgId], // "Ver mais" de lote que nao e o atual
  ];
  for (const [dados, mid] of ruins) assert.equal(await tocar(h, dados, mid), VELHO, `${dados} na mensagem ${mid}`);
  assert.equal(acoes(h), null, 'nada gravado');
  assert.deepEqual(mexidas(h, n0), [], 'nada editado nem enviado');
  assert.deepEqual(estado(h).rotinaTg, st, 'o estado nao muda');

  // a rotina desligada (o mesmo estado, um toque que valeria): o l: segue como dado desconhecido (o toque velho do canal)
  const h2 = montar({ rotina: false });
  mexer(h2, (e) => { e.rotinaTg = st; });
  const n2 = h2.tg.chamadas.length;
  assert.equal(await tocar(h2, 'l:20261105t:2:sim', t.cartoes[1].msgId), VELHO);
  assert.equal(acoes(h2), null);
  assert.deepEqual(mexidas(h2, n2), []);
  assert.deepEqual(estado(h2).rotinaTg, st);
  assert.ok(logs(h2).every((x) => !x.includes('rotina')), logs(h2).join('\n'));
});

test('T37b2 4. o registro que nao grava (acoes.jsonl que e pasta) = balao "Não consegui anotar. Toque de novo.", o cartao fica com os botoes e nada no estado; o toque de novo, com o disco bom, anota', async () => {
  const h = montar();
  const { l } = await comLote(h);
  fs.mkdirSync(arqAcoes(h));
  const st = estado(h).rotinaTg;
  const n0 = h.tg.chamadas.length;
  assert.equal(await tocar(h, 'l:20261105m:5:feito', l.cartoes[4].msgId), 'Não consegui anotar. Toque de novo.');
  assert.deepEqual(estado(h).rotinaTg, st, 'nada no estado');
  assert.deepEqual(mexidas(h, n0), [], 'o cartao fica com os botoes (nada editado)');
  assert.ok(logs(h).some((x) => x.includes('rotina 20261105m: o toque no cartao 5 nao foi anotado')), logs(h).join('\n'));
  fs.rmdirSync(arqAcoes(h));
  assert.equal(await tocar(h, 'l:20261105m:5:feito', l.cartoes[4].msgId), 'Anotado: Feito.');
  assert.equal(acoes(h).split('\n').filter(Boolean).length, 1);
  assert.equal(estado(h).rotinaTg.lotes['20261105m'].cartoes[4].escolha, 'feito');
});

test('T37b2 5. "Ver mais" = a reserva sem som com os teclados certos, msgId gravados e o botao sai do resumo; falha no 2o = o toque seguinte manda so do 2o em diante; ja mostrado = "Já mostrado."; os msgId da reserva ficam fora da sonda', async () => {
  const h = montar({ sondaTg: true });
  const { lote, l } = await comLote(h, { reserva: RESERVA, mais: 4 });
  const n0 = h.tg.de('enviarTexto').length;
  // 1. o 2o cartao da reserva falha: o 1o fica gravado, o botao fica
  h.tg.respEnviarTexto.push(undefined, { ok: false, erro: 'enviarTexto: Bad Gateway', codigo: 502 });
  assert.equal(await tocar(h, 'l:20261105m:0:mais', l.resumoMsgId), 'Não consegui agora. Toque de novo.');
  let st = estado(h).rotinaTg.lotes['20261105m'];
  assert.ok(Number.isSafeInteger(st.reserva[0].msgId));
  assert.deepEqual(st.reserva.slice(1).map((c) => 'msgId' in c), [false, false]);
  assert.equal(st.maisMostrado, false);
  assert.equal(h.tg.de('editarTexto').length, 0, 'o resumo fica com o botao');
  // 2. envio incerto de outra mensagem (a sonda vai olhar os ids de depois dele)
  h.tg.respEnviar.push(() => { h.nMid += 1; return { ok: false, incerto: true, erro: 'enviar: timeout', codigo: 0 }; });
  const u1 = msgTg(h, 'status');
  h.tg.lotes.push([u1]);
  await h.p.esperarTelegram(15000);
  const perdido = u1.message.message_id + 1;
  // 3. o toque de novo manda so do 2o em diante; tudo enviado = maisMostrado e o resumo sem o botao
  assert.equal(await tocar(h, 'l:20261105m:0:mais', l.resumoMsgId), undefined);
  const esperado = (c) => ({ texto: c.texto, botoes: tecladoDoCartao(c, '20261105m', { nomeBot: NOME_BOT }), silencioso: true });
  assert.deepEqual(h.tg.de('enviarTexto').slice(n0).map((c) => c.args[0]), [0, 1, 1, 2].map((i) => esperado(lote.reserva[i])), 'sem som, o 1o nao sai de novo');
  assert.ok(h.tg.de('enviarTexto').at(-1).args[0].botoes[0][0].url.includes(SESSAO), 'a aba da reserva: o Abrir e o link do painel');
  st = estado(h).rotinaTg.lotes['20261105m'];
  assert.equal(st.maisMostrado, true);
  assert.deepEqual(st.reserva.slice(1).map((c) => c.msgId), [perdido + 1, perdido + 2], 'msgId gravados (logo depois do perdido: na janela da sonda)');
  assert.deepEqual(h.tg.de('editarTexto').map((c) => c.args), [[l.resumoMsgId, { texto: l.resumo, botoes: null }]], 'o botao sai do resumo');
  // 4. ja mostrado; um cartao da reserva tocado conta no total (5 + 3)
  assert.equal(await tocar(h, 'l:20261105m:0:mais', l.resumoMsgId), 'Já mostrado.');
  assert.equal(await tocar(h, 'l:20261105m:6:feito', st.reserva[0].msgId), 'Anotado: Feito.');
  assert.deepEqual(h.tg.de('editarTexto').at(-1).args, [l.resumoMsgId, { texto: `${l.resumo}\n1 de 8 resolvidos.`, botoes: null }]);
  assert.equal(h.tg.de('enviarTexto').length, n0 + 4, 'nada mais saiu');
  // 5. passado o recuo, a sonda confere os ids do meio: o perdido sim, os da reserva nunca
  h.t += 30 * 1000;
  await h.p.esperarTelegram(15000);
  const sondados = h.tg.de('editarBotoes').map((c) => c.args[0]);
  const apagados = h.tg.de('apagar').map((c) => c.args[0]);
  assert.ok(sondados.includes(perdido), 'a sonda esta ligada e olhou o id perdido');
  for (const id of st.reserva.map((c) => c.msgId)) {
    assert.ok(!sondados.includes(id), `a mensagem ${id} da reserva nunca e sondada`);
    assert.ok(!apagados.includes(id), `a mensagem ${id} da reserva nunca e apagada`);
  }
});

// Lote no estado escrito a mao, do jeito que a T37b1 deixava (sem `limpo`), com ids de mensagem sinteticos.
function loteNoEstado({ gerado, resumoMsgId, msgIds, completo = true, limpo }) {
  const l = {
    gerado_em: iso(gerado), resumo: 'Resumo antigo.', resumoMsgId, fixado: true, mais: 0, completo, reserva: [],
    cartoes: msgIds.map((msgId, i) => ({ n: i + 1, id: `prazo:${i + 1}`, assinatura: '', titulo: `Prazo ${i + 1}`, tipo: 'prazo', verbos: ['feito', 'adiar'], link: null, ref: null, msgId })),
  };
  if (limpo !== undefined) l.limpo = limpo;
  return l;
}

test('T37b2 6. faxina em melhor esforco: cartao que o dono apagou num lote anterior + lote que falhou no meio com o resumo fixado = o novo sai inteiro na mesma volta, os dois ficam limpo e desafixados, nenhuma falha contada; poda: nao limpo de 4 dias fica depois de religar, limpo de 4 dias sai', async () => {
  const h = montar();
  mexer(h, (e) => {
    e.rotinaTg = {
      atual: '20261105m',
      lotes: {
        '20261105m': loteNoEstado({ gerado: h.t - 3 * 3600 * 1000, resumoMsgId: 9001, msgIds: [9002, 9003] }),
        '20261105t': loteNoEstado({ gerado: h.t - 3600 * 1000, resumoMsgId: 9010, msgIds: [9011, null], completo: false }),
      },
    };
  });
  const editarBotoes = h.tg.editarBotoes; // o dono apagou o cartao 9002
  h.tg.editarBotoes = async (id, b) => {
    if (id !== 9002) return editarBotoes(id, b);
    h.tg.chamadas.push({ metodo: 'editarBotoes', args: [id, b] });
    return { ok: false, erro: 'editarBotoes: Bad Request: message to edit not found', codigo: 400 };
  };
  porLote(h, loteRotina(h, { id: '20261105n' }));
  const n0 = h.tg.chamadas.length;
  await h.p.esperarTelegram(15000);
  const fase = mexidas(h, n0).map((c) => [c.metodo, c.args[0]]);
  assert.deepEqual(fase.slice(0, 7), [
    ['editarBotoes', 9001], ['editarBotoes', 9002], ['editarBotoes', 9003], ['desafixar', 9001],
    ['editarBotoes', 9010], ['editarBotoes', 9011], ['desafixar', 9010],
  ], 'os dois anteriores: sem teclado e desafixados, o erro do 9002 nao para');
  assert.deepEqual(fase.slice(7).map((x) => x[0]), ['enviarTexto', 'fixar', ...Array(5).fill('enviarTexto')], 'o novo sai inteiro na mesma volta');
  let st = estado(h).rotinaTg;
  assert.equal(st.atual, '20261105n');
  assert.equal(st.lotes['20261105n'].completo, true);
  for (const id of ['20261105m', '20261105t']) assert.deepEqual([st.lotes[id].limpo, st.lotes[id].fixado], [true, false], id);
  assert.deepEqual(arquivos(h), ['lote-20261105n.enviado.json']);
  const linhas = logs(h).filter((x) => x.includes('rotina'));
  assert.ok(linhas.some((x) => x.includes('rotina 20261105m: teclado 9002 nao saiu') && x.includes('segue')), linhas.join('\n'));
  assert.ok(linhas.every((x) => !/\(\d de 3\)|falhou 3 vezes/.test(x)), `nenhuma falha contada: ${linhas.join('\n')}`);

  // a poda (no carregar do porteiro religado): nao limpo de 4 dias fica; limpo de 4 dias sai; nao limpo de 11 dias sai
  const dia = 24 * 3600 * 1000;
  mexer(h, (e) => {
    e.rotinaTg.lotes['20261101m'] = loteNoEstado({ gerado: h.t - 4 * dia, resumoMsgId: 8001, msgIds: [8002] });
    e.rotinaTg.lotes['20261101t'] = loteNoEstado({ gerado: h.t - 4 * dia, resumoMsgId: 8011, msgIds: [8012], limpo: true });
    e.rotinaTg.lotes['20261025m'] = loteNoEstado({ gerado: h.t - 11 * dia, resumoMsgId: 8021, msgIds: [8022] });
  });
  religar(h);
  await h.p.esperarTelegram(5000);
  st = estado(h).rotinaTg;
  assert.deepEqual(Object.keys(st.lotes).sort(), ['20261101m', '20261105m', '20261105n', '20261105t']);
  assert.equal(st.lotes['20261101m'].limpo, false, 'o nao limpo fica pro lote seguinte limpar');
});
