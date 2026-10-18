// Testes da T7b1b (Desenho 1b): o ramo Telegram do verificar do ok-wpp.mjs. O dono toca em Sim ou Nao na mensagem do
// pedido no PROPRIO chat do bot e o processo do verificar rele o toque no servidor do Telegram (espiar a partir do
// offset que o porteiro gravou no estado.json).
// Por que existe: o toque vira autorizacao de acao irreversivel. Cada caso aqui e um jeito de forjar o Sim (prova local,
// toque de outro pedido, arquivo trocado, porteiro parado), de perder o Nao ou a trava, ou de mudar o WhatsApp de hoje.
// Isolamento: SESSOES_WPP_DIR, CLAUDE_SESSIONS_DIR, CLAUDE_PROJECTS_DIR, SESSOES_WPP_LOG, markerPath e disparoPath em
// pasta temporaria (prefixo "t7b1b-"); wpp, espiar, porteiroVivo e dormir dublados. Nada de rede, chave real, config.json
// real nem porteiro rodando.
// Rodar: node --test --test-reporter=tap "tests/ok-wpp-tg.test.mjs"
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pastaTemp } from './lib/pasta-temp.cjs';
import * as okWpp from '../ok-wpp.mjs';
import { montarOkTg } from '../lib/ok-tg.mjs';
import { horaBRT } from '../lib/formato.mjs';
import { NUMERO_DONO, NUMERO_ROBO, GRUPO, WHATSAPP } from './lib/dados-whatsapp.mjs';

const { criarOkWpp, montarMensagemPedido } = okWpp;
const OK_WPP = fileURLToPath(new URL('../ok-wpp.mjs', import.meta.url));
// A variavel da chave de antes (a do dono), montada por pedacos: o nome inteiro e termo proibido na copia aberta, e os
// testes ainda provam que ela nao conta (A1 11b) e que o filho nunca a herda do ambiente.
const VAR_ANTIGA = ['TELEGRAM_CLAUDE', '_PC_BOT_TOKEN'].join('');
const MIN = 60 * 1000;
const T0 = Date.parse('2026-09-27T19:00:00Z'); // 16:00 em Brasilia; o pedido vale ate 16:30
const SID = '11111111-2222-4333-8444-555555555555';
const OUTRA = '99999999-8888-4777-8666-555555555555';
const PID = 4242;
const BOT = 700900800; // o bot (sintetico)
const DONO = 700100200; // chat privado do dono (sintetico)
const OFFSET = 500; // o e.tg.offset que o porteiro gravou no estado.json
const ACAO = 'Publicar o site v2 em producao';
const iso = (ms) => new Date(ms).toISOString();
// Formato que o read do WhatsApp devolve (medido 27/09): "2026-09-27T21:26:33+00:00".
const tsWpp = (ms) => iso(ms).replace(/\.\d{3}Z$/, '+00:00');
const segs = (isoTxt) => Math.floor(Date.parse(isoTxt) / 1000);
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function montar({ estado = { v: 1, trava: false, tg: { offset: OFFSET } } } = {}) {
  const raiz = pastaTemp('t7b1b-');
  const env = {
    SESSOES_WPP_DIR: path.join(raiz, 'estado'),
    CLAUDE_SESSIONS_DIR: path.join(raiz, 'sessions'),
    CLAUDE_PROJECTS_DIR: path.join(raiz, 'projects'),
    SESSOES_WPP_LOG: path.join(raiz, 'ok-wpp.log'),
    CLAUDE_CODE_SESSION_ID: SID,
  };
  for (const d of [env.SESSOES_WPP_DIR, env.CLAUDE_SESSIONS_DIR, env.CLAUDE_PROJECTS_DIR]) fs.mkdirSync(d, { recursive: true });
  const estadoArq = path.join(env.SESSOES_WPP_DIR, 'estado.json');
  if (estado !== null) fs.writeFileSync(estadoArq, typeof estado === 'string' ? estado : JSON.stringify(estado));
  const reg = { pid: PID, sessionId: SID, cwd: 'C:\\projetos', name: 'repos-f3', nameSource: 'derived', entrypoint: 'claude-vscode', status: 'idle', updatedAt: T0 };
  fs.writeFileSync(path.join(env.CLAUDE_SESSIONS_DIR, `${PID}.json`), JSON.stringify(reg));
  fs.writeFileSync(path.join(env.CLAUDE_SESSIONS_DIR, `${PID}.abc123.key`), 'SEGREDO-NAO-LER');
  const pasta = path.join(env.CLAUDE_PROJECTS_DIR, 'c--projetos');
  fs.mkdirSync(pasta, { recursive: true });
  fs.writeFileSync(path.join(pasta, `${SID}.jsonl`), [
    { type: 'ai-title', aiTitle: 'Ajuste do Painel' },
    { type: 'custom-title', customTitle: 'Faro', sessionId: SID },
    { type: 'user', message: { content: 'oi' } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const h = {
    raiz,
    env,
    t: T0,
    prof: [],
    pes: [],
    membros: [NUMERO_DONO, NUMERO_ROBO],
    chamadasMembros: 0,
    enviados: [],
    reacoes: [],
    leituras: [],
    nMsg: 0,
    markerPath: path.join(raiz, 'logs', 'publicacao-ok.json'),
    disparoPath: path.join(raiz, 'logs', 'disparo-estado.json'),
    estadoArq,
    lockArq: path.join(env.SESSOES_WPP_DIR, 'porteiro.lock'),
    tg: [], // o que o servidor do Telegram devolve na espiada
    espiadas: [], // cada chamada do espiar ({offset})
    espiarErros: [], // erros lancados, 1 por chamada, antes de devolver
    dormidas: [], // esperas entre as tentativas do espiar (ms)
    vivo: true, // porteiroVivo() do duble
  };
  let seq = 0;
  h.aoLer = null; // (instancia) => void: roda dentro do lerGrupo, antes de devolver
  h.aoEspiar = null; // () => void: roda dentro do espiar, antes de devolver
  h.wpp = {
    async lerGrupo(limit, opts = {}) {
      const instancia = opts.conferencia === true ? 'pessoal' : 'profissional';
      h.leituras.push({ limit, instancia });
      if (h.aoLer) h.aoLer(instancia);
      return (instancia === 'pessoal' ? h.pes : h.prof).slice(-limit);
    },
    async enviarGrupo(texto, opts) {
      h.enviados.push({ texto, opts });
      seq += 1;
      const r = { ok: true, providerMsgId: `3EB0PED${seq}`, messageId: `uuid-ped-${seq}` };
      h.prof.push({
        id: r.messageId, provider_msg_id: r.providerMsgId, from_me: true, sent_by_agent: true, sender_phone: null,
        message_type: 'text', content: texto, quoted_msg_id: null, message_ts: tsWpp(h.t),
      });
      return r;
    },
    async reagir(messageId, emoji) {
      h.reacoes.push({ messageId, emoji });
      return { ok: true };
    },
    async membros() {
      h.chamadasMembros += 1;
      return [...h.membros];
    },
  };
  h.tgOk = {
    async espiar(arg) {
      h.espiadas.push(arg);
      if (h.aoEspiar) h.aoEspiar();
      if (h.espiarErros.length) throw h.espiarErros.shift();
      return JSON.parse(JSON.stringify(h.tg));
    },
    botId: BOT, // A1b2: o bot e o chat do dono vem no tgOk (aqui, os do teste)
    chatDono: DONO,
  };
  h.ok = (extra = {}) => criarOkWpp({
    wpp: h.wpp,
    env: h.env,
    agora: () => h.t,
    markerPath: h.markerPath,
    disparoPath: h.disparoPath,
    tgOk: h.tgOk,
    porteiroVivo: () => h.vivo,
    dormir: async (ms) => { h.dormidas.push(ms); },
    numeroDono: NUMERO_DONO, // A2a: os 2 numeros do config
    numeroRobo: NUMERO_ROBO,
    ...extra,
  });
  h.oksDir = path.join(env.SESSOES_WPP_DIR, 'oks');
  h.arquivo = (cod) => path.join(h.oksDir, `${cod}.json`);
  h.pedido = (cod) => JSON.parse(fs.readFileSync(h.arquivo(cod), 'utf8'));
  h.markers = () => (fs.existsSync(h.markerPath) ? JSON.parse(fs.readFileSync(h.markerPath, 'utf8')) : null);
  h.ledger = () => (fs.existsSync(h.disparoPath) ? JSON.parse(fs.readFileSync(h.disparoPath, 'utf8')) : null);
  h.log = () => (fs.existsSync(env.SESSOES_WPP_LOG) ? fs.readFileSync(env.SESSOES_WPP_LOG, 'utf8') : '');
  h.logTg = () => h.log().split('\n').filter((l) => l.includes('ok-wpp: telegram:'));
  return h;
}

// Resposta do dono no grupo (profissional) + a copia no pessoal (mesmo provider_msg_id), como o banco grava.
function responder(h, texto, { cita, ts = h.t, tipo = 'chat', transcription } = {}) {
  h.nMsg += 1;
  const n = h.nMsg;
  const provider = `A5C7RESP${n}`;
  const base = {
    provider_msg_id: provider,
    quoted_msg_id: cita,
    message_type: tipo,
    content: tipo === 'ptt' ? null : texto,
    transcription: tipo === 'ptt' ? (transcription ?? null) : undefined,
    sender_phone: NUMERO_DONO,
    message_ts: tsWpp(ts),
  };
  h.prof.push({ id: `uuid-resp-${n}`, ...base, sent_by_agent: false, direction: 'received', from_me: false });
  h.pes.push({ id: `uuid-pes-${n}`, ...base, sent_by_agent: false, direction: 'sent', from_me: true });
  return { id: `uuid-resp-${n}`, provider };
}

async function pedidoCom(h, tipo = 'publicacao', acao = ACAO) {
  const ok = h.ok();
  const r = await ok.pedir({ tipo, acao, destinatarios: tipo === 'mensagem' ? 'Ana' : undefined });
  assert.equal(r.status, 'pedido');
  const p = h.pedido(r.codigo);
  return { ok, cod: r.codigo, prov: p.providerMsgId, uuid: p.messageId };
}

// Update de toque como o getUpdates devolve, montado do ARQUIVO do pedido (o texto e o teclado que o porteiro manda);
// cada campo trocavel pra forjar 1 coisa por vez.
function toque(h, cod, acao = 'sim', o = {}) {
  const p = o.pedido ?? h.pedido(cod);
  const r = montarOkTg({ ...p, completo: o.completo === true });
  const letra = { sim: 's', nao: 'n', info: 'i' }[acao];
  const updateId = o.updateId ?? 501;
  return {
    update_id: updateId,
    callback_query: {
      id: `cbq-${updateId}`,
      from: o.from ?? { id: DONO, is_bot: false, first_name: 'Davi', language_code: 'pt-br' },
      chat_instance: '-123456',
      data: o.dados ?? `k:${p.codigo}:${letra}`,
      message: {
        message_id: o.messageId ?? 77,
        from: o.msgFrom ?? { id: BOT, is_bot: true, first_name: 'Bot de Teste', username: 'Teste_ControleBot' },
        chat: o.chat ?? { id: DONO, type: 'private', first_name: 'Davi' },
        date: o.date ?? segs(p.criadoEm) + 2,
        text: o.texto ?? r.texto,
        reply_markup: {
          inline_keyboard: r.botoes.map((l) => l.map((b) => ({ text: b.texto, callback_data: b.dados, ...(b.estilo ? { style: b.estilo } : {}) }))),
        },
      },
    },
  };
}

// Mensagem qualquer no grupo (profissional), campo a campo: pra "trava" ou "nao" que NAO vem do dono no celular (eco dos
// agentes, from_me, robo, outro numero). Padrao = como a resposta do dono, solta, agora.
function noGrupo(h, campos = {}) {
  h.nMsg += 1;
  const n = h.nMsg;
  const m = {
    id: `uuid-grp-${n}`, provider_msg_id: `A5C7GRP${n}`, message_type: 'chat', content: null, quoted_msg_id: null,
    sender_phone: NUMERO_DONO, from_me: false, sent_by_agent: false, message_ts: tsWpp(h.t), ...campos,
  };
  h.prof.push(m);
  return m;
}

// A leitura do Telegram que nao aconteceu (espiar falhou ou estado.json sem o offset do porteiro): rastro no resultado.
const IGN_LEITURA = { canal: 'telegram', updateId: null, motivo: 'nao consegui ler o Telegram agora; tenta de novo' };

// Texto do dono no chat do bot (ex.: "trava"), como o getUpdates devolve.
function textoTg(texto, { updateId = 600, date = segs(iso(T0)) + 30, de = DONO } = {}) {
  return {
    update_id: updateId,
    message: { message_id: 90 + updateId, from: { id: de, is_bot: false, first_name: 'Davi' }, chat: { id: DONO, type: 'private', first_name: 'Davi' }, date, text: texto },
  };
}

const semEfeito = (h, cod, nome) => {
  assert.equal(h.pedido(cod).status, 'pendente', nome);
  assert.equal(h.pedido(cod).usadoEm, undefined, nome);
  assert.equal(h.pedido(cod).decididoEm, undefined, nome);
  assert.equal(h.markers(), null, nome);
  assert.equal(h.ledger(), null, nome);
  assert.deepEqual(h.reacoes, [], nome);
};

const pidMorto = () => Number(String(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout));
// mtime do estado.json = gravado ha `ms` no relogio do teste (o porteiroVivo padrao mede a idade dele)
const idadeDoEstado = (h, ms) => { const d = new Date(h.t - ms); fs.utimesSync(h.estadoArq, d, d); };
const conflito = () => Object.assign(new Error('getUpdates: Conflict: terminated by other getUpdates request'), { conflito: true });

// ---------- 70 ----------

test('T7b1b 70: Sim valido + porteiro vivo + sem trava = ok pelo Telegram (usado, verificadoPor, marker/ledger k telegram), sem membros nem reacao', async () => {
  const casos = [
    ['publicacao', 'publicacao', ACAO, {}],
    ['disparo', 'disparo', 'Convite da live pros 120 inscritos', {}],
    ['crm', 'crm', 'Mover o deal 123 pra Ganho', {}],
    ['publicacao longa (trecho de 80)', 'publicacao', 'P'.repeat(120), {}],
    ['toque no completo (depois do Mais informacoes)', 'publicacao', ACAO, { completo: true }],
  ];
  for (const [nome, tipo, acao, o] of casos) {
    const h = montar();
    const { ok, cod } = await pedidoCom(h, tipo, acao);
    h.t = T0 + MIN;
    h.tg = [toque(h, cod, 'sim', { updateId: 501, messageId: 77, ...o })];
    const r = await ok.verificar(cod);
    assert.deepEqual(r, { status: 'ok', canal: 'telegram', codigo: cod, tipo, acao, destinatarios: null, hora: '16:01' }, nome);
    const p = h.pedido(cod);
    assert.equal(p.status, 'usado', nome);
    assert.equal(p.usadoEm, iso(T0 + MIN), nome);
    assert.deepEqual(p.verificadoPor, { canal: 'telegram', updateId: 501, messageId: 77, texto: 'Sim', conferidoEm: iso(T0 + MIN) }, nome);
    // a espiada parte do offset do PORTEIRO (estado.tg.offset), nunca de um offset proprio
    assert.deepEqual(h.espiadas, [{ offset: OFFSET }], nome);
    assert.equal(h.chamadasMembros, 0, nome);
    assert.deepEqual(h.reacoes, [], nome);
    assert.ok(h.leituras.every((l) => l.instancia === 'profissional'), nome); // a copia do pessoal e do WhatsApp
    const trecho = `${cod} pelo Telegram: ${acao.slice(0, 80)}`;
    if (tipo === 'publicacao') assert.deepEqual(h.markers(), { [SID]: { at: T0 + MIN, k: 'telegram', trecho, usos: 0 } }, nome);
    else assert.equal(h.markers(), null, nome);
    if (tipo === 'disparo') assert.deepEqual(h.ledger()[SID].ok, { at: T0 + MIN, k: 'telegram', trecho, usos: 0 }, nome);
    else assert.equal(h.ledger(), null, nome);
    // log sem a acao
    assert.match(h.log(), new RegExp(`verificar ok ${cod} sessao=11111111`), nome);
    assert.doesNotMatch(h.log(), /Publicar o site|Convite da live|Mover o deal|PPPP/, nome);
  }
  // o offset vem do estado.json do porteiro, qualquer que seja
  const g = montar({ estado: { v: 1, trava: false, tg: { offset: 777 } } });
  const y = await pedidoCom(g);
  g.t = T0 + MIN;
  g.tg = [toque(g, y.cod, 'sim')];
  assert.equal((await y.ok.verificar(y.cod)).canal, 'telegram');
  assert.deepEqual(g.espiadas, [{ offset: 777 }]);
});

// ---------- 71 ----------

// 1 verificar num processo filho, com dubles (wpp sem rede, espiar devolvendo os updates, porteiro vivo).
const FILHO = `
const { criarOkWpp } = await import(process.env.T7B1B_OKWPP);
const d = JSON.parse(process.env.T7B1B_DADOS);
const nunca = (nome) => async () => { throw new Error(nome + ' nunca'); };
const wpp = { lerGrupo: async () => [], membros: nunca('membros'), reagir: nunca('reagir'), enviarGrupo: nunca('enviarGrupo') };
const ok = criarOkWpp({ wpp, env: d.env, agora: () => d.agora, markerPath: d.markerPath, disparoPath: d.disparoPath,
  esperaTravaMs: 20000, tgOk: { espiar: async () => d.updates, botId: ${BOT}, chatDono: ${DONO} }, porteiroVivo: () => true, dormir: async () => {},
  numeroDono: '${NUMERO_DONO}', numeroRobo: '${NUMERO_ROBO}' });
process.stdout.write(JSON.stringify(await ok.verificar(d.cod)));
`;
function rodarFilho(dados) {
  return new Promise((resolver, rejeitar) => {
    const env = { ...process.env, T7B1B_OKWPP: pathToFileURL(OK_WPP).href, T7B1B_DADOS: JSON.stringify(dados) };
    delete env[VAR_ANTIGA]; // o filho nunca le chave: o espiar e duble
    const c = spawn(process.execPath, ['--input-type=module', '-e', FILHO], { env });
    let out = '';
    let err = '';
    c.stdout.on('data', (b) => { out += b; });
    c.stderr.on('data', (b) => { err += b; });
    c.on('error', rejeitar);
    c.on('close', (code) => {
      try { resolver(JSON.parse(out)); } catch { rejeitar(new Error(`filho saiu ${code}: ${err.slice(0, 600)}`)); }
    });
  });
}

test('T7b1b 71: 2o verificar do mesmo codigo = "ja usado" sem espiar; 2 verificar em 2 processos ao mesmo tempo = exatamente 1 ok', async () => {
  const h = montar();
  const { ok, cod } = await pedidoCom(h);
  h.t = T0 + MIN;
  h.tg = [toque(h, cod, 'sim')];
  assert.equal((await ok.verificar(cod)).status, 'ok');
  h.espiadas.length = 0;
  assert.deepEqual(await ok.verificar(cod), { status: 'invalido', motivo: 'ja usado' });
  assert.deepEqual(h.espiadas, []);
  assert.deepEqual(Object.keys(h.markers()), [SID]);

  const g = montar();
  const y = await pedidoCom(g);
  const dados = {
    env: g.env, agora: T0 + MIN, markerPath: g.markerPath, disparoPath: g.disparoPath, cod: y.cod, updates: [toque(g, y.cod, 'sim')],
  };
  const rs = await Promise.all([rodarFilho(dados), rodarFilho(dados)]);
  assert.deepEqual(rs.map((r) => r.status).sort(), ['invalido', 'ok'], JSON.stringify(rs));
  assert.equal(rs.find((r) => r.status === 'ok').canal, 'telegram');
  assert.deepEqual(rs.find((r) => r.status === 'invalido'), { status: 'invalido', motivo: 'ja usado' });
  assert.equal(g.pedido(y.cod).status, 'usado');
  assert.equal(g.pedido(y.cod).verificadoPor.canal, 'telegram');
  assert.deepEqual(g.markers(), { [SID]: { at: T0 + MIN, k: 'telegram', trecho: `${y.cod} pelo Telegram: ${ACAO}`, usos: 0 } });
});

// ---------- 72 ----------

test('T7b1b 72: Nao valido = recusado (sem exigir porteiro vivo), sem marker, sem membros nem reacao; depois "ja recusado"', async () => {
  for (const tipo of ['publicacao', 'disparo']) {
    const h = montar();
    const { ok, cod } = await pedidoCom(h, tipo);
    h.t = T0 + MIN;
    h.vivo = false; // porteiro parado: o Nao vale igual (recusar nunca libera nada)
    h.tg = [toque(h, cod, 'nao', { updateId: 502, messageId: 78 })];
    const r = await ok.verificar(cod);
    assert.deepEqual(r, { status: 'recusado', motivo: 'o dono tocou em Nao no Telegram', codigo: cod, hora: '16:01' }, tipo);
    const p = h.pedido(cod);
    assert.equal(p.status, 'recusado', tipo);
    assert.equal(p.decididoEm, iso(T0 + MIN), tipo);
    assert.equal(p.usadoEm, undefined, tipo);
    assert.deepEqual(p.verificadoPor, { canal: 'telegram', updateId: 502, messageId: 78, texto: 'Não', conferidoEm: iso(T0 + MIN) }, tipo);
    assert.equal(h.markers(), null, tipo);
    assert.equal(h.ledger(), null, tipo);
    assert.equal(h.chamadasMembros, 0, tipo);
    assert.deepEqual(h.reacoes, [], tipo);
    assert.deepEqual(await ok.verificar(cod), { status: 'invalido', motivo: 'ja recusado' }, tipo);
  }
});

// ---------- 73 ----------

test('T7b1b 73: o Nao vence: Sim e Nao no Telegram (qualquer ordem) ou Sim + "nao" citando no grupo = recusado; leitura do grupo lancando = ok', async () => {
  for (const [nome, ordem] of [['Sim e depois Nao', ['sim', 'nao']], ['Nao e depois Sim', ['nao', 'sim']]]) {
    const h = montar();
    const { ok, cod } = await pedidoCom(h);
    h.t = T0 + MIN;
    h.tg = ordem.map((a, i) => toque(h, cod, a, { updateId: 501 + i }));
    assert.deepEqual(await ok.verificar(cod), { status: 'recusado', motivo: 'o dono tocou em Nao no Telegram', codigo: cod, hora: '16:01' }, nome);
    const p = h.pedido(cod);
    assert.equal(p.status, 'recusado', nome);
    assert.equal(p.verificadoPor.texto, 'Não', nome);
    assert.equal(p.verificadoPor.updateId, 501 + ordem.indexOf('nao'), nome);
    assert.equal(h.markers(), null, nome);
  }
  // Sim no Telegram + "Não." do dono citando o pedido no grupo = recusado (a resposta do grupo, como o "e" de hoje)
  {
    const h = montar();
    const { ok, cod, prov } = await pedidoCom(h);
    h.t = T0 + 30 * 1000;
    const resp = responder(h, 'Não.', { cita: prov });
    h.t = T0 + MIN;
    h.tg = [toque(h, cod, 'sim')];
    assert.deepEqual(await ok.verificar(cod), { status: 'recusado', motivo: 'o dono respondeu que nao', codigo: cod, hora: '16:00' });
    const p = h.pedido(cod);
    assert.equal(p.status, 'recusado');
    assert.equal(p.decididoEm, iso(T0 + MIN));
    assert.deepEqual(p.verificadoPor, { providerMsgId: resp.provider, texto: 'Não.', hora: '16:00' });
    assert.equal(h.markers(), null);
    assert.deepEqual(h.reacoes, []);
    assert.equal(h.chamadasMembros, 0);
  }
  // Sim + leitura do grupo lancando: melhor esforco, segue = ok pelo Telegram
  {
    const h = montar();
    const { ok, cod } = await pedidoCom(h);
    h.t = T0 + MIN;
    h.tg = [toque(h, cod, 'sim')];
    h.aoLer = () => { throw new Error('Z-API 502'); };
    const r = await ok.verificar(cod);
    assert.equal(r.status, 'ok');
    assert.equal(r.canal, 'telegram');
    assert.equal(h.markers()[SID].k, 'telegram');
  }
});

// ---------- 74 ----------

test('T7b1b 74: porteiro parado (duble, lock sem pid vivo, sem lock, estado.json de 61 s) + Sim valido = toque nas ignoradas e o WhatsApp de hoje decide', async () => {
  const morto = pidMorto();
  const IGN = { canal: 'telegram', updateId: 501, motivo: 'porteiro parado: o toque do Telegram so vale com o porteiro vivo' };
  const casos = [
    ['duble: porteiroVivo() false', (h) => { h.vivo = false; }, {}],
    ['lock com pid morto', (h) => { fs.writeFileSync(h.lockArq, String(morto)); idadeDoEstado(h, 5 * 1000); }, { porteiroVivo: undefined }],
    ['sem lock', (h) => { idadeDoEstado(h, 5 * 1000); }, { porteiroVivo: undefined }],
    ['estado.json gravado ha 61 s', (h) => { fs.writeFileSync(h.lockArq, String(process.pid)); idadeDoEstado(h, 61 * 1000); }, { porteiroVivo: undefined }],
  ];
  for (const [nome, parar, extra] of casos) {
    for (const comSim of [true, false]) {
      const rotulo = `${nome}${comSim ? ' + sim no grupo' : ''}`;
      const h = montar();
      const { cod, prov } = await pedidoCom(h);
      let resp = null;
      if (comSim) {
        h.t = T0 + 30 * 1000;
        resp = responder(h, 'sim', { cita: prov });
      }
      h.t = T0 + MIN;
      h.tg = [toque(h, cod, 'sim', { updateId: 501 })];
      parar(h);
      const r = await h.ok(extra).verificar(cod);
      if (comSim) {
        // o WhatsApp de hoje decide: ok k whatsapp, com a reacao e a copia do pessoal; o toque fica nas ignoradas
        assert.deepEqual(r, { status: 'ok', codigo: cod, tipo: 'publicacao', acao: ACAO, destinatarios: null, hora: '16:00', ignoradas: [IGN] }, rotulo);
        assert.deepEqual(h.markers(), { [SID]: { at: T0 + MIN, k: 'whatsapp', trecho: `${cod}: ${ACAO}`, usos: 0 } }, rotulo);
        assert.deepEqual(h.reacoes, [{ messageId: resp.id, emoji: '✅' }], rotulo);
        assert.deepEqual(h.pedido(cod).verificadoPor, { providerMsgId: resp.provider, texto: 'sim', hora: '16:00' }, rotulo);
        assert.equal(h.chamadasMembros, 1, rotulo);
      } else {
        assert.deepEqual(r, { status: 'pendente', motivo: 'sem resposta do dono ainda', ignoradas: [IGN] }, rotulo);
        semEfeito(h, cod, rotulo);
      }
      assert.deepEqual(h.espiadas, [{ offset: OFFSET }], rotulo);
    }
  }
  // controle do porteiroVivo padrao: lock com o pid vivo e estado.json de 59 s = vivo, o toque vale
  const v = montar();
  const y = await pedidoCom(v);
  v.t = T0 + MIN;
  v.tg = [toque(v, y.cod, 'sim')];
  fs.writeFileSync(v.lockArq, String(process.pid));
  idadeDoEstado(v, 59 * 1000);
  const r = await v.ok({ porteiroVivo: undefined }).verificar(y.cod);
  assert.equal(r.status, 'ok');
  assert.equal(r.canal, 'telegram');
});

// ---------- 75 ----------

test('T7b1b 75: trava = invalido "travado pelo dono": estado.trava (sem espiar), "trava" no chat depois do destravadoEm, "trava" no grupo, trava gravada antes do consumo', async () => {
  // estado.trava: nega antes de espiar
  {
    const h = montar({ estado: { v: 1, trava: true, tg: { offset: OFFSET } } });
    const { ok, cod } = await pedidoCom(h);
    h.t = T0 + MIN;
    h.tg = [toque(h, cod, 'sim')];
    assert.deepEqual(await ok.verificar(cod), { status: 'invalido', motivo: 'travado pelo dono' });
    assert.deepEqual(h.espiadas, []);
    semEfeito(h, cod, 'estado.trava');
  }
  // "trava" do dono no chat do bot, lida pela propria espiada (o porteiro pode nem ter visto)
  const casosChat = [
    ['"trava" sem destravadoEm', undefined, (h, cod) => [toque(h, cod, 'sim'), textoTg('trava')]],
    ['"Trava!" depois do destravadoEm', iso(T0 + 10 * 1000), (h, cod) => [textoTg('Trava!', { date: segs(iso(T0)) + 30 }), toque(h, cod, 'sim')]],
    ['"trava" sem nenhum toque, com "sim" no grupo', undefined, () => [textoTg('trava')]],
  ];
  for (const [nome, destravadoEm, lista] of casosChat) {
    const h = montar({ estado: { v: 1, trava: false, tg: { offset: OFFSET }, ...(destravadoEm ? { destravadoEm } : {}) } });
    const { ok, cod, prov } = await pedidoCom(h);
    h.t = T0 + 40 * 1000;
    responder(h, 'sim', { cita: prov });
    h.t = T0 + MIN;
    h.tg = lista(h, cod);
    assert.deepEqual(await ok.verificar(cod), { status: 'invalido', motivo: 'travado pelo dono' }, nome);
    semEfeito(h, cod, nome);
  }
  // controle: "trava" ANTES do destravadoEm nao conta (o dono ja destravou no PC)
  {
    const h = montar({ estado: { v: 1, trava: false, tg: { offset: OFFSET }, destravadoEm: iso(T0 + 50 * 1000) } });
    const { ok, cod } = await pedidoCom(h);
    h.t = T0 + MIN;
    h.tg = [textoTg('trava', { date: segs(iso(T0)) + 30 }), toque(h, cod, 'sim')];
    assert.equal((await ok.verificar(cod)).canal, 'telegram');
  }
  // "trava" do dono no grupo, na mesma leitura do grupo do ramo Telegram
  {
    const h = montar();
    const { ok, cod } = await pedidoCom(h);
    h.t = T0 + 20 * 1000;
    responder(h, 'trava', { cita: null });
    h.t = T0 + MIN;
    h.tg = [toque(h, cod, 'sim')];
    assert.deepEqual(await ok.verificar(cod), { status: 'invalido', motivo: 'travado pelo dono' });
    semEfeito(h, cod, 'trava no grupo');
  }
  // trava gravada pelo porteiro entre a leitura do estado e o consumo: o consumo rele e o arquivo segue pendente
  for (const [nome, acao, onde] of [['Sim, trava durante o espiar', 'sim', 'espiar'], ['Sim, trava durante a leitura do grupo', 'sim', 'grupo'], ['Nao, trava durante o espiar', 'nao', 'espiar']]) {
    const h = montar();
    const { ok, cod } = await pedidoCom(h);
    h.t = T0 + MIN;
    h.tg = [toque(h, cod, acao)];
    const travar = () => fs.writeFileSync(h.estadoArq, JSON.stringify({ v: 1, trava: true, tg: { offset: OFFSET } }));
    if (onde === 'espiar') h.aoEspiar = travar;
    else h.aoLer = travar;
    assert.deepEqual(await ok.verificar(cod), { status: 'invalido', motivo: 'travado pelo dono' }, nome);
    semEfeito(h, cod, nome);
  }
});

// ---------- 76 ----------

test('T7b1b 76: prova local nao vale: toque anotado no e.okTg e campo toqueTg no arquivo, espiar vazio e grupo sem resposta = pendente "sem resposta do dono ainda"', async () => {
  const h = montar();
  const { ok, cod } = await pedidoCom(h);
  h.t = T0 + MIN;
  const anotado = { acao: 'sim', em: iso(T0 + 30 * 1000), updateId: 501 };
  fs.writeFileSync(h.estadoArq, JSON.stringify({
    v: 1,
    trava: false,
    tg: { offset: OFFSET },
    okTg: {
      iniciadoEm: iso(T0 - MIN),
      segurar: 501,
      mensagens: { [cod]: { messageId: 77, outras: [], sessionId: SID, completo: false, enviadoEm: iso(T0 + 1000), toque: anotado, fechadoEm: null, fim: null } },
    },
  }));
  fs.writeFileSync(h.arquivo(cod), JSON.stringify({ ...h.pedido(cod), toqueTg: { ...anotado, messageId: 77 } }, null, 2));
  h.tg = []; // o servidor do Telegram nao tem toque nenhum
  assert.deepEqual(await ok.verificar(cod), { status: 'pendente', motivo: 'sem resposta do dono ainda', ignoradas: [] });
  assert.deepEqual(h.espiadas, [{ offset: OFFSET }]);
  semEfeito(h, cod, 'prova local');
});

// ---------- 77 ----------

test('T7b1b 77: toque do pedido B no espiar do A nao conta; forjados nao conferem (ignoradas); arquivo do A trocado = "pedido diferente do que o dono viu"', async () => {
  {
    const h = montar();
    const a = await pedidoCom(h, 'publicacao', 'Publicar o site A');
    const b = await pedidoCom(h, 'publicacao', 'Publicar o site B');
    h.t = T0 + MIN;
    // toque valido do B: nao e deste pedido (nem ignorada: e de outro codigo)
    h.tg = [toque(h, b.cod, 'sim', { updateId: 501 })];
    assert.deepEqual(await a.ok.verificar(a.cod), { status: 'pendente', motivo: 'sem resposta do dono ainda', ignoradas: [] });
    semEfeito(h, a.cod, 'toque do B');
    assert.equal(h.pedido(b.cod).status, 'pendente', 'o verificar do A nunca mexe no B');
    // Mais informacoes valido do A: nao e Sim nem Nao, nao conta
    h.tg = [toque(h, a.cod, 'info', { updateId: 502 })];
    assert.deepEqual(await a.ok.verificar(a.cod), { status: 'pendente', motivo: 'sem resposta do dono ainda', ignoradas: [] });
    // forjados com os dados do A: cada um nas ignoradas com o motivo do conferirToque (nunca com a acao)
    const forjados = [
      ['texto e teclado do B com os dados do A', { pedido: h.pedido(b.cod), dados: `k:${a.cod}:s` }, 'texto da mensagem nao confere com o pedido'],
      ['outra pessoa tocou', { from: { id: 555, is_bot: false, first_name: 'X' } }, 'quem tocou nao e o dono do chat'],
      ['mensagem de outro bot', { msgFrom: { id: 1234, is_bot: true, first_name: 'Outro' } }, 'a mensagem tocada nao e do bot'],
      ['chat de grupo', { chat: { id: -100123, type: 'supergroup', title: 'G' } }, 'toque fora do chat privado do dono'],
      ['mensagem velha (antes do pedido)', { date: segs(iso(T0)) - 60 }, 'mensagem fora do prazo do pedido'],
    ];
    let id = 510;
    for (const [nome, o, motivo] of forjados) {
      id += 1;
      h.tg = [toque(h, a.cod, 'sim', { updateId: id, ...o })];
      const r = await a.ok.verificar(a.cod);
      assert.deepEqual(r, {
        status: 'pendente', motivo: 'sem resposta do dono ainda', ignoradas: [{ canal: 'telegram', updateId: id, motivo: `toque do Telegram nao confere: ${motivo}` }],
      }, nome);
      assert.doesNotMatch(JSON.stringify(r), /site A/, nome);
      semEfeito(h, a.cod, nome);
    }
  }
  // arquivo do A trocado (acao e tipo, hash recalculado) com o toque no texto antigo: o toque nao confere e o grupo acusa
  {
    const h = montar();
    const { ok, cod } = await pedidoCom(h, 'crm', 'ler o deal 123');
    h.t = T0 + MIN;
    const tq = toque(h, cod, 'sim', { updateId: 501 }); // montado do arquivo ORIGINAL: o que o dono viu e tocou
    const p = h.pedido(cod);
    p.tipo = 'apagar';
    p.acao = 'apagar o deal 123';
    p.hashAcao = sha256(JSON.stringify([p.tipo, p.acao, p.destinatarios ?? null]));
    fs.writeFileSync(h.arquivo(cod), JSON.stringify(p));
    h.tg = [tq];
    assert.deepEqual(await ok.verificar(cod), { status: 'invalido', motivo: 'pedido diferente do que o dono viu' });
    semEfeito(h, cod, 'arquivo trocado');
  }
});

// ---------- 78 ----------

test('T7b1b 78: expirado com toque valido = "expirou"; pedido de outra sessao = "pedido de outra sessao"; nos 2 o espiar nunca e chamado', async () => {
  // no ultimo milissegundo do prazo o toque vale; 1 ms depois, expirou sem espiar
  {
    const h = montar();
    const { ok, cod } = await pedidoCom(h);
    h.tg = [toque(h, cod, 'sim')];
    h.t = T0 + 30 * MIN + 1;
    assert.deepEqual(await ok.verificar(cod), { status: 'invalido', motivo: 'expirou' });
    assert.deepEqual(h.espiadas, []);
    semEfeito(h, cod, 'expirado');
    h.t = T0 + 30 * MIN;
    assert.equal((await ok.verificar(cod)).canal, 'telegram');
    assert.deepEqual(h.espiadas, [{ offset: OFFSET }]);
  }
  {
    const h = montar();
    const { cod } = await pedidoCom(h);
    h.t = T0 + MIN;
    h.tg = [toque(h, cod, 'sim')];
    const outra = h.ok({ env: { ...h.env, CLAUDE_CODE_SESSION_ID: OUTRA } });
    assert.deepEqual(await outra.verificar(cod), { status: 'invalido', motivo: 'pedido de outra sessao' });
    assert.deepEqual(h.espiadas, []);
    semEfeito(h, cod, 'outra sessao');
    assert.equal((await h.ok().verificar(cod)).canal, 'telegram', 'a sessao dona confere o mesmo toque');
  }
});

// ---------- 79 ----------

test('T7b1b 79: espiar falha (rede, 429, 409 nas 3, resposta que nao e lista) = o WhatsApp de hoje decide + 1 linha de log + a ignorada "nao consegui ler o Telegram" na frente; 409 passageiro = de novo depois de 500 ms e 1 s', async () => {
  const rede = () => new Error('getUpdates: fetch failed');
  const muitas = () => Object.assign(new Error('getUpdates: Too Many Requests: retry after 3'), { esperarS: 3 });
  const casos = [
    // [nome, erros lancados pelo espiar, o que a espiada devolve (null = o toque), espiadas, esperas, erro na linha do log]
    ['rede', [rede()], null, 1, [], 'getUpdates: fetch failed'],
    ['429', [muitas()], null, 1, [], 'getUpdates: Too Many Requests: retry after 3'],
    ['409 nas 3', [conflito(), conflito(), conflito()], null, 3, [500, 1000], 'getUpdates: Conflict: terminated by other getUpdates request'],
    ['resposta que nao e lista', [], { ok: true, result: [] }, 1, [], 'resposta sem lista'],
  ];
  for (const [nome, erros, devolve, nEspiadas, dormidas, noLog] of casos) {
    for (const comSim of [true, false]) {
      const rotulo = `${nome}${comSim ? ' + sim no grupo' : ''}`;
      const h = montar();
      const { ok, cod, prov } = await pedidoCom(h);
      let resp = null;
      if (comSim) {
        h.t = T0 + 30 * 1000;
        resp = responder(h, 'sim', { cita: prov });
      }
      h.t = T0 + MIN;
      h.tg = devolve ?? [toque(h, cod, 'sim')]; // o toque so seria lido numa espiada que deu certo
      h.espiarErros = erros.slice();
      const r = await ok.verificar(cod);
      if (comSim) {
        // o WhatsApp de hoje decide; a leitura que faltou fica no resultado, na frente das ignoradas
        assert.deepEqual(r, { status: 'ok', codigo: cod, tipo: 'publicacao', acao: ACAO, destinatarios: null, hora: '16:00', ignoradas: [IGN_LEITURA] }, rotulo);
        assert.deepEqual(h.markers()[SID], { at: T0 + MIN, k: 'whatsapp', trecho: `${cod}: ${ACAO}`, usos: 0 }, rotulo);
        assert.deepEqual(h.reacoes, [{ messageId: resp.id, emoji: '✅' }], rotulo);
      } else {
        assert.deepEqual(r, { status: 'pendente', motivo: 'sem resposta do dono ainda', ignoradas: [IGN_LEITURA] }, rotulo);
        semEfeito(h, cod, rotulo);
      }
      assert.equal(h.espiadas.length, nEspiadas, rotulo);
      assert.deepEqual(h.dormidas, dormidas, rotulo);
      const linhas = h.logTg();
      assert.equal(linhas.length, 1, `${rotulo}: ${linhas.join(' / ')}`);
      assert.ok(linhas[0].endsWith(`ok-wpp: telegram: leitura falhou (${noLog}); segui pelo WhatsApp`), linhas[0]);
    }
  }
  // 409 2 vezes e depois a leitura: o toque vale (sem linha de falha no log)
  const h = montar();
  const { ok, cod } = await pedidoCom(h);
  h.t = T0 + MIN;
  h.tg = [toque(h, cod, 'sim')];
  h.espiarErros = [conflito(), conflito()];
  assert.equal((await ok.verificar(cod)).canal, 'telegram');
  assert.deepEqual(h.espiadas, [{ offset: OFFSET }, { offset: OFFSET }, { offset: OFFSET }], 'as 3 com o offset do porteiro');
  assert.deepEqual(h.dormidas, [500, 1000]);
  assert.deepEqual(h.logTg(), []);
});

test('T7b1b 79: estado.json sem tg.offset (ausente, nao inteiro ou < 1) = espiar nunca chamado, 1 linha de log, a ignorada "nao consegui ler o Telegram", o WhatsApp decide', async () => {
  const estados = [
    ['sem tg', { v: 1, trava: false }],
    ['tg sem offset', { v: 1, trava: false, tg: {} }],
    ['offset 0', { v: 1, trava: false, tg: { offset: 0 } }],
    ['offset negativo', { v: 1, trava: false, tg: { offset: -100 } }],
    ['offset quebrado', { v: 1, trava: false, tg: { offset: 1.5 } }],
    ['offset em texto', { v: 1, trava: false, tg: { offset: '500' } }],
    ['tg null', { v: 1, trava: false, tg: null }],
  ];
  for (const [nome, estado] of estados) {
    for (const comSim of [true, false]) {
      const rotulo = `${nome}${comSim ? ' + sim no grupo' : ''}`;
      const h = montar({ estado });
      const { ok, cod, prov } = await pedidoCom(h);
      if (comSim) {
        h.t = T0 + 30 * 1000;
        responder(h, 'sim', { cita: prov });
      }
      h.t = T0 + MIN;
      h.tg = [toque(h, cod, 'sim')];
      const r = await ok.verificar(cod);
      if (comSim) {
        assert.deepEqual(r, { status: 'ok', codigo: cod, tipo: 'publicacao', acao: ACAO, destinatarios: null, hora: '16:00', ignoradas: [IGN_LEITURA] }, rotulo);
        assert.equal(h.markers()[SID].k, 'whatsapp', rotulo);
      } else {
        assert.deepEqual(r, { status: 'pendente', motivo: 'sem resposta do dono ainda', ignoradas: [IGN_LEITURA] }, rotulo);
      }
      assert.deepEqual(h.espiadas, [], rotulo);
      const linhas = h.logTg();
      assert.equal(linhas.length, 1, `${rotulo}: ${linhas.join(' / ')}`);
      assert.ok(linhas[0].endsWith('ok-wpp: telegram: sem o offset do porteiro no estado.json; segui pelo WhatsApp'), linhas[0]);
    }
  }
});

test('T7b1b 79: OK pelo Telegram desligado (tgOk null) = o ramo nao existe; pedir devolve telegram certo e o texto do grupo byte a byte', async () => {
  const TEXTO = 'ℹ️ *Faro*\nPedido de OK (CRM): Mover o deal 123 (Ana) pra *Ganho*\n\n*Posso?* Vale até 16:30.';
  const CHAVES = ['v', 'codigo', 'sessionId', 'titulo', 'tipo', 'acao', 'hashAcao', 'destinatarios', 'libera', 'criadoEm', 'expiraEm', 'providerMsgId', 'messageId', 'status']; // A5c: libera
  for (const [nome, extra, telegram] of [['ligado', {}, true], ['desligado (null)', { tgOk: null }, false], ['sem tgOk', { tgOk: undefined }, false]]) {
    const h = montar();
    const r = await h.ok(extra).pedir({ tipo: 'crm', acao: 'Mover o deal 123 (Ana) pra **Ganho**' });
    assert.deepEqual(r, { status: 'pedido', codigo: r.codigo, expiraEm: iso(T0 + 30 * MIN), hora: '16:30', telegram }, nome);
    assert.deepEqual(h.enviados.map((e) => e.texto), [TEXTO], nome);
    assert.equal(montarMensagemPedido({ titulo: 'Faro', tipo: 'crm', destinatarios: null, acao: 'Mover o deal 123 (Ana) pra **Ganho**', hora: '16:30' }), TEXTO, nome);
    assert.deepEqual(Object.keys(h.pedido(r.codigo)), CHAVES, nome);
    assert.deepEqual(h.espiadas, [], `${nome}: o pedir nunca espia`);
  }
  // desligado: o toque existe no servidor, mas o ramo nao existe (nem espiada nem log); o WhatsApp decide como hoje
  for (const comSim of [true, false]) {
    const h = montar();
    const { cod, prov } = await pedidoCom(h);
    if (comSim) {
      h.t = T0 + 30 * 1000;
      responder(h, 'sim', { cita: prov });
    }
    h.t = T0 + MIN;
    h.tg = [toque(h, cod, 'sim')];
    h.vivo = true;
    const r = await h.ok({ tgOk: null }).verificar(cod);
    if (comSim) {
      assert.deepEqual(r, { status: 'ok', codigo: cod, tipo: 'publicacao', acao: ACAO, destinatarios: null, hora: '16:00' });
      assert.equal(h.markers()[SID].k, 'whatsapp');
    } else {
      assert.deepEqual(r, { status: 'pendente', motivo: 'sem resposta do dono ainda', ignoradas: [] });
    }
    assert.deepEqual(h.espiadas, []);
    assert.deepEqual(h.logTg(), []);
  }
});

test('T7b1b 79: tgOk do main (tgOkPreguicoso): so com telegram.ok.ligado no config E a chave do bot; cliente so na 1a espiada; o espiar e (A1b2) o bot e o chat do dono', async () => {
  const { tgOkPreguicoso } = okWpp;
  assert.equal(typeof tgOkPreguicoso, 'function', 'ok-wpp.mjs exporta o tgOkPreguicoso que o main usa');
  const raiz = pastaTemp('t7b1b-');
  const criados = [];
  const criar = ({ token }) => {
    criados.push(token);
    return {
      espiar: async (a) => [{ update_id: 1, eco: a }],
      enviarTexto: async () => { throw new Error('nunca'); },
    };
  };
  const semRegistro = async () => null;
  // A1b1: o config daqui nao tem varChave = a chave pela variavel padrao (a varChave dada: o A1 11b)
  const comRegistro = async (nome) => (nome === 'SESSOES_WPP_TELEGRAM_TOKEN' ? 'chave-do-registro' : null);
  const comChave = { SESSOES_WPP_TELEGRAM_TOKEN: 'chave-falsa' };
  const cfg = (obj) => fs.writeFileSync(path.join(raiz, 'config.json'), JSON.stringify(obj));
  const montarTg = (env, lerRegistro) => tgOkPreguicoso({ estadoDir: raiz, env, lerRegistro, criar });

  assert.equal(await montarTg(comChave, comRegistro), null, 'sem config.json');
  cfg({ telegram: { ligado: true } });
  assert.equal(await montarTg(comChave, comRegistro), null, 'sem telegram.ok');
  cfg({ telegram: { ligado: false, ok: { ligado: true } } });
  assert.equal(await montarTg(comChave, comRegistro), null, 'telegram desligado');
  cfg({ telegram: { ligado: true, ok: { ligado: 'true' } } });
  assert.equal(await montarTg(comChave, comRegistro), null, 'ligado em texto');
  cfg({ telegram: { ligado: true, chatId: DONO, ok: { ligado: true } } }); // A1: com o chat do config.json
  assert.equal(await montarTg({}, semRegistro), null, 'sem chave (nem no ambiente nem no registro)');
  assert.deepEqual(criados, [], 'nenhum cliente sem config ou sem chave');

  const t = await montarTg(comChave, semRegistro);
  // A1b2: o espiar e o bot e o chat do dono (a chave daqui nao tem id e o config nao tem botId: null; o A1 11c)
  assert.deepEqual(Object.keys(t).sort(), ['botId', 'chatDono', 'espiar']);
  assert.equal(t.botId, null);
  assert.equal(t.chatDono, DONO);
  assert.deepEqual(criados, [], 'o cliente so nasce na 1a espiada');
  assert.deepEqual(await t.espiar({ offset: 9 }), [{ update_id: 1, eco: { offset: 9 } }]);
  await t.espiar({ offset: 10 });
  assert.deepEqual(criados, ['chave-falsa'], '1 cliente, com a chave do ambiente');
  const t2 = await montarTg({}, comRegistro);
  await t2.espiar({ offset: 1 });
  assert.deepEqual(criados, ['chave-falsa', 'chave-do-registro'], 'sem a do ambiente, a do registro');
});

// Preload do processo da CLI: qualquer fetch (Telegram ou whatsapp-agent) vira erro e deixa rastro no stderr. Junto com
// a HOME temporaria (sem ~/.claude.json) e a chave falsa no ambiente, a CLI nao tem como sair pra rede nem ler a chave real.
const SEM_REDE = "data:text/javascript,globalThis.fetch=async()=>{process.stderr.write('REDE-TENTADA\\n');throw new Error('sem rede no teste')}";

// A1b1: na CLI a chave falsa vai na variavel que o config do teste nomeia (telegram.varChave = VAR_FALSA). Do ambiente
// do filho saem a variavel de antes e a padrao, em qualquer grafia (o process.env pode ter a de verdade; o Windows nao
// diferencia maiuscula): com o ramo ligado, o filho acha a falsa no ambiente e nunca chega no `reg query` de verdade.
const VAR_FALSA = 'CHAVE_FALSA_T7B1B';
function envDoFilho(base, chave) {
  const env = Object.fromEntries(Object.entries(base).filter(([k]) => !new RegExp(`^(${VAR_ANTIGA}|SESSOES_WPP_TELEGRAM_TOKEN)$`, 'i').test(k)));
  return { ...env, [VAR_FALSA]: chave };
}

test('T7b1b 79: CLI: o main liga o ramo do Telegram so com telegram.ok.ligado e a chave (HOME temporaria, chave falsa, fetch bloqueado)', async () => {
  const CHAVE = 'chave-falsa-t7b1b';
  // A2a: o WhatsApp so com o bloco `whatsapp` completo (os 3 casos o trazem: "o WhatsApp de hoje decide")
  for (const [nome, config, temLinha] of [
    ['ligado, com chave', { telegram: { ligado: true, chatId: DONO, ok: { ligado: true }, varChave: VAR_FALSA }, whatsapp: WHATSAPP }, true],
    ['so o WhatsApp (sem o bloco telegram)', { whatsapp: WHATSAPP }, false],
    ['config sem telegram.ok', { telegram: { ligado: true }, whatsapp: WHATSAPP }, false],
  ]) {
    // estado.json sem tg.offset: com o tgOk, o verificar loga "sem o offset" e nunca espia (nunca cria o cliente)
    const h = montar({ estado: { v: 1, trava: false } });
    h.t = Date.now(); // a CLI usa o relogio real: o pedido vale agora
    const { cod } = await pedidoCom(h);
    if (config) fs.writeFileSync(path.join(h.env.SESSOES_WPP_DIR, 'config.json'), JSON.stringify(config));
    const home = path.join(h.raiz, 'home');
    fs.mkdirSync(home);
    const env = envDoFilho({ ...process.env, ...h.env, USERPROFILE: home, HOME: home }, CHAVE);
    const v = spawnSync(process.execPath, ['--import', SEM_REDE, OK_WPP, 'verificar', cod], { env, encoding: 'utf8' });
    // o WhatsApp de hoje decide: sem ~/.claude.json os membros falham = pendente passageiro (exit 2); com o ramo ligado, a
    // leitura do Telegram que faltou (sem offset) fica nas ignoradas
    assert.equal(v.status, 2, `${nome}: ${v.stderr}`);
    assert.deepEqual(JSON.parse(v.stdout), { status: 'pendente', motivo: 'nao consegui conferir os membros agora; tenta de novo', ignoradas: temLinha ? [IGN_LEITURA] : [] }, nome);
    assert.doesNotMatch(v.stderr, /REDE-TENTADA/, nome);
    const linhas = h.logTg();
    assert.deepEqual(linhas.map((l) => l.replace(/^\S+ /, '')), temLinha ? ['ok-wpp: telegram: sem o offset do porteiro no estado.json; segui pelo WhatsApp'] : [], nome);
    assert.ok(!`${v.stdout}${v.stderr}${h.log()}`.includes(CHAVE), `${nome}: a chave nunca sai`);
    assert.equal(h.pedido(cod).status, 'pendente', nome);
  }
});

// ---------- revisao adversarial da T7b1b (03/10/2026): os furos achados pelos revisores, presos ----------

// Item 1. No Windows o rename do arquivo falha com EPERM por instantes quando outro processo esta com ele aberto (o 2o
// verificar relendo o pedido: o 71 de 2 processos caia ~1 em 10 rodadas). Duble do fs.renameSync (o MESMO objeto que o
// ok-wpp usa), so pro arquivo alvo; o resto do disco e real.
test('T7b1b 71 (rename no Windows): o rename repete no EPERM/EBUSY/EACCES ate 5 vezes, ~25 ms entre elas; o 5o ou outro erro sobe e o tmp sai', async () => {
  const renameReal = fs.renameSync;
  const falhar = (alvo, codigo, n) => {
    const tentativas = [];
    fs.renameSync = (de, para) => {
      if (path.resolve(String(para)) === path.resolve(alvo)) {
        tentativas.push(performance.now());
        if (tentativas.length <= n) throw Object.assign(new Error(`${codigo}: rename falhou (duble)`), { code: codigo });
      }
      return renameReal(de, para);
    };
    return tentativas;
  };
  const semTmp = (h, nome) => assert.deepEqual(fs.readdirSync(h.oksDir).filter((n) => n.includes('.tmp')), [], `${nome}: tmp sobrando`);
  const espacadas = (tentativas, nome) => {
    for (let i = 1; i < tentativas.length; i++) {
      const ms = tentativas[i] - tentativas[i - 1];
      assert.ok(ms >= 20, `${nome}: so ${ms.toFixed(1)} ms entre a tentativa ${i} e a ${i + 1}`);
    }
  };
  try {
    // o consumo do Sim pelo Telegram: falha 4 vezes e passa na 5a
    for (const codigo of ['EPERM', 'EBUSY', 'EACCES']) {
      const h = montar();
      const { ok, cod } = await pedidoCom(h);
      h.t = T0 + MIN;
      h.tg = [toque(h, cod, 'sim')];
      const tentativas = falhar(h.arquivo(cod), codigo, 4);
      const r = await ok.verificar(cod);
      fs.renameSync = renameReal;
      assert.equal(r.status, 'ok', `${codigo}: ${JSON.stringify(r)}`);
      assert.equal(r.canal, 'telegram', codigo);
      assert.equal(tentativas.length, 5, codigo);
      espacadas(tentativas, codigo);
      assert.equal(h.pedido(cod).status, 'usado', codigo);
      assert.equal(h.markers()[SID].k, 'telegram', codigo);
      semTmp(h, codigo);
    }
    // o pedir: o rename do pedido novo falha 2 vezes e passa (codigo sorteado fixo: AAAAAA)
    {
      const h = montar();
      const tentativas = falhar(h.arquivo('AAAAAA'), 'EPERM', 2);
      const r = await h.ok({ randomInt: () => 0 }).pedir({ tipo: 'publicacao', acao: ACAO });
      fs.renameSync = renameReal;
      assert.equal(r.status, 'pedido', JSON.stringify(r));
      assert.equal(r.codigo, 'AAAAAA');
      assert.equal(tentativas.length, 3);
      espacadas(tentativas, 'pedir');
      assert.equal(h.pedido('AAAAAA').status, 'pendente');
      semTmp(h, 'pedir');
    }
    // 5 seguidas: desiste na 5a (nunca uma 6a); outro erro (nao e o arquivo aberto por outro processo): sobe na 1a. Nos
    // dois o erro sobe, o pedido segue pendente e o tmp sai
    for (const [nome, codigo, n] of [['EPERM nas 5', 'EPERM', 5], ['ENOSPC', 'ENOSPC', 1]]) {
      const h = montar();
      const { ok, cod } = await pedidoCom(h);
      h.t = T0 + MIN;
      h.tg = [toque(h, cod, 'sim')];
      const tentativas = falhar(h.arquivo(cod), codigo, 99);
      const r = await ok.verificar(cod);
      fs.renameSync = renameReal;
      assert.deepEqual(r, { status: 'invalido', motivo: `erro: ${codigo}: rename falhou (duble)` }, nome);
      assert.equal(tentativas.length, n, nome);
      semEfeito(h, cod, nome);
      semTmp(h, nome);
    }
  } finally {
    fs.renameSync = renameReal;
  }
});

// Item 2. Uso unico do consumo pelo Telegram preso sem depender de sorte (o 71 de 2 processos fica de fumaca).
// Trava de OUTRA conferencia viva e recente no arquivo do pedido (o dono e este processo de teste, que esta vivo).
const travaAlheia = (arq) => {
  const conteudo = JSON.stringify({ pid: process.pid, at: Date.now(), token: 'outra-conferencia' });
  fs.writeFileSync(`${arq}.lock`, conteudo);
  return conteudo;
};

test('T7b1b 71 (uso unico, trava): trava viva de outra conferencia no pedido = "pedido ocupado" (Sim, Nao e "Não." do grupo), pendente e sem marker; solta = o toque decide', async () => {
  const casos = [
    // [nome, toque, resposta no grupo citando o pedido, status depois de soltar a trava]
    ['Sim', 'sim', null, 'ok'],
    ['Nao', 'nao', null, 'recusado'],
    ['Sim + "Não." citando no grupo', 'sim', 'Não.', 'recusado'],
  ];
  for (const [nome, acao, grupo, depois] of casos) {
    const h = montar();
    const { cod, prov } = await pedidoCom(h);
    if (grupo) {
      h.t = T0 + 30 * 1000;
      responder(h, grupo, { cita: prov });
    }
    h.t = T0 + MIN;
    h.tg = [toque(h, cod, acao)];
    const alheia = travaAlheia(h.arquivo(cod));
    const ok = h.ok({ esperaTravaMs: 150 });
    assert.deepEqual(await ok.verificar(cod), { status: 'invalido', motivo: 'pedido ocupado por outra conferencia (rodar o verificar de novo)' }, nome);
    semEfeito(h, cod, nome);
    assert.equal(fs.readFileSync(`${h.arquivo(cod)}.lock`, 'utf8'), alheia, `${nome}: a trava do outro fica intacta`);
    fs.unlinkSync(`${h.arquivo(cod)}.lock`);
    assert.equal((await ok.verificar(cod)).status, depois, nome);
    assert.equal(fs.existsSync(`${h.arquivo(cod)}.lock`), false, `${nome}: o verificar solta a propria trava`);
  }
});

test('T7b1b 71 (uso unico, mesmo processo): 2 verificar do mesmo codigo cruzando juntos na espiada = exatamente 1 decide; o outro "ja usado" ou "ja recusado"', async () => {
  const casos = [
    // [nome, toque, resposta no grupo citando o pedido, os 2 resultados (ordenados), status final do arquivo]
    ['Sim', 'sim', null, ['invalido: ja usado', 'ok'], 'usado'],
    ['Nao', 'nao', null, ['invalido: ja recusado', 'recusado'], 'recusado'],
    ['Sim + "Não." citando no grupo', 'sim', 'Não.', ['invalido: ja recusado', 'recusado'], 'recusado'],
  ];
  for (const [nome, acao, grupo, esperado, final] of casos) {
    const h = montar();
    const { cod, prov } = await pedidoCom(h);
    if (grupo) {
      h.t = T0 + 30 * 1000;
      responder(h, grupo, { cita: prov });
    }
    h.t = T0 + MIN;
    h.tg = [toque(h, cod, acao)];
    // barreira: cada espiada so volta quando as 2 chegaram (os 2 ja leram o pedido pendente e cruzam no mesmo passo)
    let chegaram = 0;
    let abrir;
    const barreira = new Promise((r) => { abrir = r; });
    const tgOk = {
      async espiar() {
        chegaram += 1;
        if (chegaram === 2) abrir();
        await barreira;
        return JSON.parse(JSON.stringify(h.tg));
      },
      botId: BOT, // A1b2: o bot e o chat de antes
      chatDono: DONO,
    };
    const rs = await Promise.all([h.ok({ tgOk }).verificar(cod), h.ok({ tgOk }).verificar(cod)]);
    assert.equal(chegaram, 2, nome);
    assert.deepEqual(rs.map((r) => (r.status === 'invalido' ? `invalido: ${r.motivo}` : r.status)).sort(), esperado, `${nome}: ${JSON.stringify(rs)}`);
    assert.equal(h.pedido(cod).status, final, nome);
  }
});

// Item 3. O controle do grupo no ramo Telegram: a regra da "trava" no grupo e a do d2 (uma funcao so pros dois).
test('T7b1b 75 (controle do grupo): "trava" antes do destravadoEm, com from_me, com sent_by_agent, de outro numero ou eco dos agentes nao conta: o Sim vale pelo Telegram', async () => {
  const casos = [
    ['"trava" do dono antes do destravadoEm', iso(T0 + 50 * 1000), (h) => { h.t = T0 + 20 * 1000; responder(h, 'trava', { cita: null }); }],
    ['"trava" com from_me true', undefined, (h) => { h.t = T0 + 20 * 1000; noGrupo(h, { content: 'trava', from_me: true }); }],
    ['"trava" com sent_by_agent true', undefined, (h) => { h.t = T0 + 20 * 1000; noGrupo(h, { content: 'trava', sent_by_agent: true }); }],
    ['"trava" de outro numero', undefined, (h) => { h.t = T0 + 20 * 1000; noGrupo(h, { content: 'trava', sender_phone: '5511988887777' }); }],
    ['eco dos agentes', undefined, (h) => { h.t = T0 + 20 * 1000; noGrupo(h, { content: 'trava', sender_phone: null, from_me: true, sent_by_agent: true }); }],
  ];
  for (const [nome, destravadoEm, preparar] of casos) {
    const h = montar({ estado: { v: 1, trava: false, tg: { offset: OFFSET }, ...(destravadoEm ? { destravadoEm } : {}) } });
    const { ok, cod } = await pedidoCom(h);
    preparar(h);
    h.t = T0 + MIN;
    h.tg = [toque(h, cod, 'sim')];
    const r = await ok.verificar(cod);
    assert.equal(r.status, 'ok', `${nome}: ${JSON.stringify(r)}`);
    assert.equal(r.canal, 'telegram', nome);
    assert.equal(h.markers()[SID].k, 'telegram', nome);
  }
  // o par do controle: a mesma "trava" do dono DEPOIS do destravadoEm trava (a regra do d2)
  {
    const h = montar({ estado: { v: 1, trava: false, tg: { offset: OFFSET }, destravadoEm: iso(T0 + 10 * 1000) } });
    const { ok, cod } = await pedidoCom(h);
    h.t = T0 + 20 * 1000;
    responder(h, 'trava', { cita: null });
    h.t = T0 + MIN;
    h.tg = [toque(h, cod, 'sim')];
    assert.deepEqual(await ok.verificar(cod), { status: 'invalido', motivo: 'travado pelo dono' });
    semEfeito(h, cod, 'trava depois do destravadoEm');
  }
});

// Item 4. O Nao vence tambem o "nao" SOLTO que o d (WhatsApp) atribuiria a este pedido: a mesma regra do d (F3.2).
test('T7b1b 73 (nao solto): Sim + "não" SOLTO que o d atribuiria a este pedido (o unico aberto, sem mensagem dos agentes depois da do pedido) = recusado, gravado como o e', async () => {
  const casos = [
    ['"não" solto', 'não', {}],
    ['"Cancela!" solto', 'Cancela!', {}],
    ['audio "Não." solto', 'Não.', { tipo: 'ptt', transcription: 'Não.' }],
  ];
  for (const [nome, texto, o] of casos) {
    const h = montar();
    const { ok, cod } = await pedidoCom(h);
    h.t = T0 + 40 * 1000;
    const resp = responder(h, o.tipo === 'ptt' ? null : texto, { cita: null, ...o });
    h.t = T0 + MIN;
    h.tg = [toque(h, cod, 'sim', { updateId: 501 })];
    assert.deepEqual(await ok.verificar(cod), { status: 'recusado', motivo: 'o dono respondeu que nao', codigo: cod, hora: '16:00' }, nome);
    const p = h.pedido(cod);
    assert.equal(p.status, 'recusado', nome);
    assert.equal(p.decididoEm, iso(T0 + MIN), nome);
    assert.equal(p.usadoEm, undefined, nome);
    assert.deepEqual(p.verificadoPor, { providerMsgId: resp.provider, texto, hora: '16:00' }, nome);
    assert.equal(h.markers(), null, nome);
    assert.equal(h.ledger(), null, nome);
    assert.deepEqual(h.reacoes, [], nome);
    assert.equal(h.chamadasMembros, 0, nome);
  }
  // a mesma regra do d: sem toque, o WhatsApp sozinho recusa com esse "não" e grava o mesmo verificadoPor
  {
    const h = montar();
    const { ok, cod } = await pedidoCom(h);
    h.t = T0 + 40 * 1000;
    const resp = responder(h, 'não', { cita: null });
    h.t = T0 + MIN;
    h.tg = [];
    assert.deepEqual(await ok.verificar(cod), { status: 'recusado', motivo: 'o dono respondeu que nao', codigo: cod, hora: '16:00' });
    assert.deepEqual(h.pedido(cod).verificadoPor, { providerMsgId: resp.provider, texto: 'não', hora: '16:00' });
  }
});

test('T7b1b 73 (nao solto, controles): o "nao" que o d NAO atribuiria a este pedido nao vence o Sim (ok pelo Telegram)', async () => {
  const casos = [
    // [nome, preparar(h) -> {ok, cod, prov} do pedido conferido]
    ['"não" solto com 2 pedidos abertos (o outro antes deste)', async (h) => {
      await pedidoCom(h, 'crm', 'Mover o deal 9 pra Ganho');
      h.t = T0 + 5 * 1000;
      const a = await pedidoCom(h);
      h.t = T0 + 40 * 1000;
      responder(h, 'não', { cita: null });
      return a;
    }],
    ['"não" solto depois de outra mensagem dos agentes', async (h) => {
      const a = await pedidoCom(h);
      h.t = T0 + 20 * 1000;
      noGrupo(h, { content: 'Recebido, ja vejo.', sender_phone: null, from_me: true, sent_by_agent: true });
      h.t = T0 + 40 * 1000;
      responder(h, 'não', { cita: null });
      return a;
    }],
    ['"não" solto antes da mensagem do pedido entrar no grupo', async (h) => {
      const a = await pedidoCom(h);
      h.prof.find((m) => m.provider_msg_id === a.prov).message_ts = tsWpp(T0 + 30 * 1000);
      h.t = T0 + 20 * 1000;
      responder(h, 'não', { cita: null });
      return a;
    }],
    ['"obrigado" citando o pedido', async (h) => {
      const a = await pedidoCom(h);
      h.t = T0 + 40 * 1000;
      responder(h, 'obrigado', { cita: a.prov });
      return a;
    }],
    ['"Não." citando com from_me true (nao e o dono no celular)', async (h) => {
      const a = await pedidoCom(h);
      h.t = T0 + 40 * 1000;
      noGrupo(h, { content: 'Não.', quoted_msg_id: a.prov, from_me: true });
      return a;
    }],
    ['"Não." citando com sent_by_agent true', async (h) => {
      const a = await pedidoCom(h);
      h.t = T0 + 40 * 1000;
      noGrupo(h, { content: 'Não.', quoted_msg_id: a.prov, sent_by_agent: true });
      return a;
    }],
    ['"Não." citando de outro numero', async (h) => {
      const a = await pedidoCom(h);
      h.t = T0 + 40 * 1000;
      noGrupo(h, { content: 'Não.', quoted_msg_id: a.prov, sender_phone: '5511988887777' });
      return a;
    }],
    ['"Não." citando com hora de antes do criadoEm', async (h) => {
      const a = await pedidoCom(h);
      responder(h, 'Não.', { cita: a.prov, ts: T0 - 10 * 1000 });
      return a;
    }],
    ['"Não." citando OUTRO pedido', async (h) => {
      const a = await pedidoCom(h);
      h.t = T0 + 5 * 1000;
      const b = await pedidoCom(h, 'crm', 'Mover o deal 9 pra Ganho');
      h.t = T0 + 40 * 1000;
      responder(h, 'Não.', { cita: b.prov });
      return a;
    }],
  ];
  for (const [nome, preparar] of casos) {
    const h = montar();
    const a = await preparar(h);
    h.t = T0 + MIN;
    h.tg = [toque(h, a.cod, 'sim')];
    const r = await a.ok.verificar(a.cod);
    assert.equal(r.status, 'ok', `${nome}: ${JSON.stringify(r)}`);
    assert.equal(r.canal, 'telegram', nome);
    assert.equal(h.pedido(a.cod).verificadoPor.canal, 'telegram', nome);
    assert.equal(h.markers()[SID].k, 'telegram', nome);
  }
});

// Item 5. F7 com o Telegram ligado: espiada que deu certo sem toque deste pedido = o WhatsApp de hoje, igual.
test('T7b1b 79 (F7 com o Telegram ligado): espiada vazia, ou so com toques de OUTRO codigo, + "sim" citando = ok pelo WhatsApp de hoje (k whatsapp, reacao, verificadoPor do WhatsApp)', async () => {
  const casos = [
    ['espiada vazia', () => []],
    ['so toques de outro codigo', (h, outro) => [toque(h, outro, 'sim', { updateId: 501 }), toque(h, outro, 'nao', { updateId: 502 })]],
  ];
  for (const [nome, lista] of casos) {
    const h = montar();
    const outro = await pedidoCom(h, 'crm', 'Mover o deal 9 pra Ganho');
    const { ok, cod, prov } = await pedidoCom(h);
    h.t = T0 + 30 * 1000;
    const resp = responder(h, 'sim', { cita: prov });
    h.t = T0 + MIN;
    h.tg = lista(h, outro.cod);
    const r = await ok.verificar(cod);
    assert.deepEqual(r, { status: 'ok', codigo: cod, tipo: 'publicacao', acao: ACAO, destinatarios: null, hora: '16:00' }, nome);
    assert.deepEqual(h.markers(), { [SID]: { at: T0 + MIN, k: 'whatsapp', trecho: `${cod}: ${ACAO}`, usos: 0 } }, nome);
    assert.deepEqual(h.reacoes, [{ messageId: resp.id, emoji: '✅' }], nome);
    assert.deepEqual(h.pedido(cod).verificadoPor, { providerMsgId: resp.provider, texto: 'sim', hora: '16:00' }, nome);
    assert.equal(h.chamadasMembros, 1, nome);
    assert.deepEqual(h.espiadas, [{ offset: OFFSET }], nome);
    assert.deepEqual(h.logTg(), [], nome);
    assert.equal(h.pedido(outro.cod).status, 'pendente', `${nome}: o outro pedido nunca e tocado`);
  }
});

// Item 6. O main liga o tgOk no pedir (o "telegram" do retorno), no esquema do teste de CLI do verificar: HOME temporaria
// com um ~/.claude.json falso (whatsapp-agent num url de mentira), chave falsa no ambiente e o fetch dublado no preload (o
// "send" responde daqui e fica gravado; qualquer outro fetch vira erro e rastro no stderr). Nada sai do PC; com a chave
// falsa no ambiente o registro (a chave real) nunca e lido.
const STUB_WPP = [
  "import fs from 'node:fs';",
  "const FALSO = 'http://127.0.0.1:9/mcp';",
  'globalThis.fetch = async (url, init = {}) => {',
  '  if (String(url) === FALSO) {',
  "    const corpo = JSON.parse(String(init.body || '{}'));",
  "    fs.appendFileSync(process.env.T7B1B_STUB_SAIDA, JSON.stringify(corpo.params) + '\\n');",
  "    const texto = corpo?.params?.name === 'send'",
  "      ? JSON.stringify({ ok: true, provider_msg_id: '3EB0STUB1', message_id: 'uuid-stub-1' })",
  "      : JSON.stringify({ ok: false, error: 'stub' });",
  "    return new Response(JSON.stringify({ jsonrpc: '2.0', id: corpo.id, result: { content: [{ type: 'text', text: texto }] } }), { status: 200, headers: { 'content-type': 'application/json' } });",
  '  }',
  "  process.stderr.write('REDE-TENTADA\\n');",
  "  throw new Error('sem rede no teste');",
  '};',
].join('\n');

test('T7b1b 79 (CLI pedir): "telegram" true so com telegram.ok.ligado e a chave; o texto do grupo e o arquivo iguais nos tres (HOME temporaria, whatsapp-agent dublado, sem rede)', async () => {
  const CHAVE = 'chave-falsa-t7b1b-pedir';
  const ACAO_CLI = 'Mover o deal 123 (Ana) pra **Ganho**';
  const CHAVES = ['v', 'codigo', 'sessionId', 'titulo', 'tipo', 'acao', 'hashAcao', 'destinatarios', 'libera', 'criadoEm', 'expiraEm', 'providerMsgId', 'messageId', 'status']; // A5c: libera
  const RE_COD = new RegExp(`^[${okWpp.ALFABETO}]{6}$`);
  // A2a: o WhatsApp so com o bloco `whatsapp` completo (o pedido sai pro grupo dele, pela entrada whatsapp-agent)
  for (const [nome, config, telegram] of [
    ['ligado, com chave', { telegram: { ligado: true, chatId: DONO, ok: { ligado: true }, varChave: VAR_FALSA }, whatsapp: WHATSAPP }, true],
    ['so o WhatsApp (sem o bloco telegram)', { whatsapp: WHATSAPP }, false],
    ['config sem telegram.ok', { telegram: { ligado: true }, whatsapp: WHATSAPP }, false],
  ]) {
    const h = montar();
    if (config) fs.writeFileSync(path.join(h.env.SESSOES_WPP_DIR, 'config.json'), JSON.stringify(config));
    const home = path.join(h.raiz, 'home');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'whatsapp-agent': { url: 'http://127.0.0.1:9/mcp', headers: {} } } }));
    const stub = path.join(h.raiz, 'stub-wpp.mjs');
    fs.writeFileSync(stub, STUB_WPP);
    const saida = path.join(h.raiz, 'enviados.jsonl');
    const env = envDoFilho({ ...process.env, ...h.env, USERPROFILE: home, HOME: home, T7B1B_STUB_SAIDA: saida }, CHAVE);
    const v = spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, OK_WPP, 'pedir', '--tipo', 'crm', '--acao', ACAO_CLI], { env, encoding: 'utf8' });
    assert.equal(v.status, 0, `${nome}: ${v.stdout} ${v.stderr}`);
    const r = JSON.parse(v.stdout);
    assert.deepEqual(r, { status: 'pedido', codigo: r.codigo, expiraEm: r.expiraEm, hora: horaBRT(r.expiraEm), telegram }, nome);
    assert.match(r.codigo, RE_COD, nome);
    assert.doesNotMatch(v.stderr, /REDE-TENTADA/, nome);
    assert.ok(!`${v.stdout}${v.stderr}${h.log()}`.includes(CHAVE), `${nome}: a chave nunca sai`);
    const p = h.pedido(r.codigo);
    assert.deepEqual(Object.keys(p), CHAVES, nome);
    assert.deepEqual([p.providerMsgId, p.messageId, p.status, p.titulo, p.expiraEm], ['3EB0STUB1', 'uuid-stub-1', 'pendente', 'Faro', r.expiraEm], nome);
    assert.equal(Date.parse(p.expiraEm) - Date.parse(p.criadoEm), 30 * MIN, nome);
    const enviados = fs.readFileSync(saida, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(enviados.map((e) => [e.name, e.arguments.to, e.arguments.content]), [
      ['send', GRUPO, montarMensagemPedido({ titulo: 'Faro', tipo: 'crm', destinatarios: null, acao: ACAO_CLI, hora: r.hora })],
    ], nome);
  }
});

// Item 7. Casos que faltavam: os destinatarios no ok pelo Telegram e o relogio do estado.json no futuro.
test('T7b1b 70 (destinatarios): Sim pelo Telegram num pedido de mensagem pra Ana = ok com destinatarios ["Ana"] (os do arquivo)', async () => {
  const h = montar();
  const acao = 'Mandar o resumo da call pra Ana';
  const { ok, cod } = await pedidoCom(h, 'mensagem', acao);
  assert.deepEqual(h.pedido(cod).destinatarios, ['Ana']);
  h.t = T0 + MIN;
  h.tg = [toque(h, cod, 'sim')];
  assert.deepEqual(await ok.verificar(cod), { status: 'ok', canal: 'telegram', codigo: cod, tipo: 'mensagem', acao, destinatarios: ['Ana'], hora: '16:01' });
  assert.equal(h.pedido(cod).status, 'usado');
  assert.equal(h.markers(), null);
  assert.equal(h.ledger(), null);
});

test('T7b1b 74 (relogio): estado.json gravado 10 s no FUTURO = porteiro parado (o Sim vai pras ignoradas e o WhatsApp decide); 4 s no futuro = vivo (folga de 5 s)', async () => {
  const IGN = { canal: 'telegram', updateId: 501, motivo: 'porteiro parado: o toque do Telegram so vale com o porteiro vivo' };
  for (const comSim of [true, false]) {
    const rotulo = `10 s no futuro${comSim ? ' + sim no grupo' : ''}`;
    const h = montar();
    const { cod, prov } = await pedidoCom(h);
    let resp = null;
    if (comSim) {
      h.t = T0 + 30 * 1000;
      resp = responder(h, 'sim', { cita: prov });
    }
    h.t = T0 + MIN;
    h.tg = [toque(h, cod, 'sim', { updateId: 501 })];
    fs.writeFileSync(h.lockArq, String(process.pid)); // o pid do lock esta vivo: so o relogio do estado.json nega
    idadeDoEstado(h, -10 * 1000);
    const r = await h.ok({ porteiroVivo: undefined }).verificar(cod);
    if (comSim) {
      assert.deepEqual(r, { status: 'ok', codigo: cod, tipo: 'publicacao', acao: ACAO, destinatarios: null, hora: '16:00', ignoradas: [IGN] }, rotulo);
      assert.equal(h.markers()[SID].k, 'whatsapp', rotulo);
      assert.deepEqual(h.reacoes, [{ messageId: resp.id, emoji: '✅' }], rotulo);
    } else {
      assert.deepEqual(r, { status: 'pendente', motivo: 'sem resposta do dono ainda', ignoradas: [IGN] }, rotulo);
      semEfeito(h, cod, rotulo);
    }
  }
  const h = montar();
  const { cod } = await pedidoCom(h);
  h.t = T0 + MIN;
  h.tg = [toque(h, cod, 'sim')];
  fs.writeFileSync(h.lockArq, String(process.pid));
  idadeDoEstado(h, -4 * 1000);
  const r = await h.ok({ porteiroVivo: undefined }).verificar(cod);
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.equal(r.canal, 'telegram');
});

// ---------- 119 (T7i) ----------

test('T7i 119: o toque relido com a mensagem SEM teclado (o porteiro tirou os botoes depois do toque; o servidor pode devolver a mensagem como esta agora) vale: Sim = ok pelo Telegram, Nao = recusado; teclado presente e trocado segue nas ignoradas', async () => {
  for (const [rotulo, mexer] of [
    ['sem o campo', (u) => { delete u.callback_query.message.reply_markup; }],
    ['inline_keyboard vazio', (u) => { u.callback_query.message.reply_markup = { inline_keyboard: [] }; }],
  ]) {
    const h = montar();
    const { ok, cod } = await pedidoCom(h);
    h.t = T0 + MIN;
    const u = toque(h, cod, 'sim', { updateId: 501, messageId: 77 });
    mexer(u);
    h.tg = [u];
    assert.deepEqual(await ok.verificar(cod), { status: 'ok', canal: 'telegram', codigo: cod, tipo: 'publicacao', acao: ACAO, destinatarios: null, hora: '16:01' }, rotulo);
    assert.deepEqual(h.pedido(cod).verificadoPor, { canal: 'telegram', updateId: 501, messageId: 77, texto: 'Sim', conferidoEm: iso(T0 + MIN) }, rotulo);
    const g = montar();
    const y = await pedidoCom(g);
    g.t = T0 + MIN;
    const n = toque(g, y.cod, 'nao', { updateId: 502, completo: true });
    mexer(n);
    g.tg = [n];
    assert.equal((await y.ok.verificar(y.cod)).status, 'recusado', `Nao no completo, ${rotulo}`);
  }
  const h = montar();
  const { ok, cod } = await pedidoCom(h);
  h.t = T0 + MIN;
  const u = toque(h, cod, 'sim', { updateId: 503 });
  u.callback_query.message.reply_markup = { inline_keyboard: [[{ text: 'Sim', callback_data: `k:${cod}:s` }]] };
  h.tg = [u];
  assert.deepEqual(await ok.verificar(cod), {
    status: 'pendente', motivo: 'sem resposta do dono ainda',
    ignoradas: [{ canal: 'telegram', updateId: 503, motivo: 'toque do Telegram nao confere: botoes da mensagem nao conferem com o pedido' }],
  });
  semEfeito(h, cod, 'teclado trocado');
});

// ---------- A1. o chat do config.json no tgOkPreguicoso (PLANO-ABERTO.md, "A1 — Telegram pela configuração", teste 11,
// so a parte do chatId: o botId e o chatDono no retorno sao da A1b) ----------

test('A1 11. tgOkPreguicoso: config sem telegram.chatId (ou invalido) = null e a chave nem e lida; com chatId, o criar recebe {token, chatId} so na 1a espiada', async () => {
  const { tgOkPreguicoso } = okWpp;
  const raiz = pastaTemp('a1-tgok-');
  const cfg = (obj) => fs.writeFileSync(path.join(raiz, 'config.json'), JSON.stringify(obj));
  // ambiente e registro que anotam toda leitura (nenhuma chave de verdade)
  const leituras = [];
  const envEspiao = () => new Proxy({}, { get(_alvo, nome) { leituras.push(`env:${String(nome)}`); return undefined; } });
  const regEspiao = async (nome) => { leituras.push(`reg:${nome}`); return null; };
  const criados = [];
  const criar = (args) => {
    criados.push({ ...args });
    return { espiar: async (a) => [{ update_id: 1, eco: a }] };
  };
  // varChave = um nome dado no config (a A1b passa a ler a chave por ele)
  const base = { ligado: true, ok: { ligado: true }, varChave: 'CHAVE_TG_TESTE' };

  for (const semChat of [{ ...base }, { ...base, chatId: null }, { ...base, chatId: 0 }, { ...base, chatId: 'x' }, { ...base, chatId: -42 }]) {
    cfg({ telegram: semChat });
    leituras.length = 0;
    assert.equal(await tgOkPreguicoso({ estadoDir: raiz, env: envEspiao(), lerRegistro: regEspiao, criar }), null, JSON.stringify(semChat));
    assert.deepEqual(leituras, [], `${JSON.stringify(semChat)}: a chave nem e lida`);
  }
  assert.deepEqual(criados, [], 'nenhum cliente sem chatId');

  for (const chatId of [42, '42']) {
    cfg({ telegram: { ...base, chatId } });
    criados.length = 0;
    const t = await tgOkPreguicoso({ estadoDir: raiz, env: { CHAVE_TG_TESTE: '7:x' }, lerRegistro: async () => null, criar });
    assert.ok(t && typeof t.espiar === 'function', `chatId ${JSON.stringify(chatId)}`);
    assert.deepEqual(criados, [], 'o cliente so nasce na 1a espiada');
    assert.deepEqual(await t.espiar({ offset: 9 }), [{ update_id: 1, eco: { offset: 9 } }]);
    await t.espiar({ offset: 10 });
    assert.deepEqual(criados, [{ token: '7:x', chatId: 42 }], `chatId ${JSON.stringify(chatId)}: 1 cliente, com o chat do config`);
  }
});

// ---------- A1b1. a chave pela varChave do config.json no tgOkPreguicoso (PLANO-ABERTO.md, "A1", teste 11, a chave) ----------

test('A1 11b. tgOkPreguicoso: a chave pela varChave do config (ambiente e registro pedidos so por esse nome); sem varChave (ou fora do formato) = SESSOES_WPP_TELEGRAM_TOKEN; a chave de uma variavel de outro nome nao serve', async () => {
  const { tgOkPreguicoso } = okWpp;
  const raiz = pastaTemp('a1b1-tgok-');
  const cfg = (telegram) => fs.writeFileSync(path.join(raiz, 'config.json'), JSON.stringify({ telegram }));
  const base = { ligado: true, chatId: 42, ok: { ligado: true } };
  const PADRAO = 'SESSOES_WPP_TELEGRAM_TOKEN';
  // ambiente-espiao e registro-espiao: anotam todo nome lido (e a varredura) e so devolvem o que `valores` tem
  const leituras = [];
  const lidos = () => [...new Set(leituras)];
  const envEspiao = (valores = {}) => new Proxy({ ...valores }, {
    get(alvo, nome) { leituras.push(`env:${String(nome)}`); return alvo[nome]; },
    has(alvo, nome) { leituras.push(`env?${String(nome)}`); return nome in alvo; },
    ownKeys(alvo) { leituras.push('env:*'); return Reflect.ownKeys(alvo); },
  });
  const regEspiao = (valores = {}) => async (nome) => { leituras.push(`reg:${nome}`); return valores[nome] ?? null; };
  const criados = [];
  const criar = (args) => {
    criados.push({ ...args });
    return { espiar: async () => [] };
  };
  // monta e (se montou) espia 1 vez: o cliente nasce com a chave que foi lida
  const montarTg = async (env, lerRegistro) => {
    leituras.length = 0;
    criados.length = 0;
    const t = await tgOkPreguicoso({ estadoDir: raiz, env, lerRegistro, criar });
    if (t) await t.espiar({ offset: 1 });
    return t;
  };
  // as variaveis de outro nome tem chave (a padrao e a de antes): nunca servem quando o config nomeia outra
  const OUTRAS = { [PADRAO]: '1:padrao', [VAR_ANTIGA]: '2:antes', OUTRA_CHAVE: '3:outra' };

  cfg({ ...base, varChave: 'MINHA_CHAVE_TG' });
  // do ambiente, pelo nome do config: o registro nem e chamado
  assert.ok(await montarTg(envEspiao({ ...OUTRAS, MINHA_CHAVE_TG: ' 7:minha ' }), regEspiao(OUTRAS)), 'chave no ambiente');
  assert.deepEqual(criados, [{ token: '7:minha', chatId: 42 }]);
  assert.deepEqual(lidos(), ['env:MINHA_CHAVE_TG'], 'so o nome do config');
  // sem ela no ambiente: o registro, pelo mesmo nome
  assert.ok(await montarTg(envEspiao(OUTRAS), regEspiao({ ...OUTRAS, MINHA_CHAVE_TG: '8:do-registro' })), 'chave no registro');
  assert.deepEqual(criados, [{ token: '8:do-registro', chatId: 42 }]);
  assert.deepEqual(lidos(), ['env:MINHA_CHAVE_TG', 'reg:MINHA_CHAVE_TG']);
  // so as de outro nome (no ambiente e no registro) = sem chave: null e nenhum cliente
  assert.equal(await montarTg(envEspiao(OUTRAS), regEspiao(OUTRAS)), null, 'a chave de outro nome nao serve');
  assert.deepEqual(criados, []);
  assert.deepEqual(lidos(), ['env:MINHA_CHAVE_TG', 'reg:MINHA_CHAVE_TG']);

  // config sem varChave, ou com ela fora do formato = a padrao (identidadeTelegram); a de antes nao conta
  const { [PADRAO]: _padrao, ...semPadrao } = OUTRAS;
  for (const varChave of [undefined, 'X Y', '1A', '', 7, null]) {
    cfg({ ...base, varChave });
    const rotulo = `varChave ${JSON.stringify(varChave)}`;
    assert.ok(await montarTg(envEspiao(OUTRAS), regEspiao(OUTRAS)), rotulo);
    assert.deepEqual(criados, [{ token: '1:padrao', chatId: 42 }], rotulo);
    assert.deepEqual(lidos(), [`env:${PADRAO}`], `${rotulo}: o ambiente pelo nome padrao`);
    assert.ok(await montarTg(envEspiao(semPadrao), regEspiao({ ...semPadrao, [PADRAO]: '9:padrao-reg' })), rotulo);
    assert.deepEqual(criados, [{ token: '9:padrao-reg', chatId: 42 }], rotulo);
    assert.deepEqual(lidos(), [`env:${PADRAO}`, `reg:${PADRAO}`], `${rotulo}: o registro pelo nome padrao`);
    assert.equal(await montarTg(envEspiao(semPadrao), regEspiao(semPadrao)), null, `${rotulo}: so a de antes = sem chave`);
    assert.deepEqual(criados, [], rotulo);
  }
});

// ---------- A1b2. o bot e o chat do dono dentro do tgOk (PLANO-ABERTO.md, "A1", teste 11, botId/chatDono) ----------

test('A1 11c. tgOkPreguicoso devolve {espiar, botId, chatDono} (chatDono = o chatId do config; botId = o do config, senao o id da chave, senao null); o criarOkWpp confere o toque e a trava so com o botId e o chatDono do proprio tgOk: sem um deles, ou de outro dono, o Nao perfeito vai pras ignoradas e nao recusa', async () => {
  const { tgOkPreguicoso } = okWpp;
  const raiz = pastaTemp('a1b2-tgok-');
  const cfg = (telegram) => fs.writeFileSync(path.join(raiz, 'config.json'), JSON.stringify({ telegram }));
  const VAR = 'CHAVE_FALSA_A1B2';
  const base = { ligado: true, ok: { ligado: true }, chatId: 42, varChave: VAR };
  const criados = [];
  const criar = (args) => {
    criados.push({ ...args });
    return { espiar: async () => [] };
  };
  for (const [rotulo, telegram, chave, botId, chatDono] of [
    ['config sem botId: o id da chave', base, '7:x', 7, 42],
    ['o botId do config ganha do da chave', { ...base, botId: 9 }, '7:x', 9, 42],
    ['botId do config em texto de digitos', { ...base, botId: '9' }, '7:x', 9, 42],
    ['botId do config com a chave sem id', { ...base, botId: 9 }, 'sem-id', 9, 42],
    ['botId invalido no config: o id da chave', { ...base, botId: 0 }, '7:x', 7, 42],
    ['chave sem id e config sem botId = null', base, 'sem-id', null, 42],
    ['chave com id torto e config sem botId = null', base, 'abc:1', null, 42],
    ['chatId em texto de digitos', { ...base, chatId: '43' }, '7:x', 7, 43],
  ]) {
    cfg(telegram);
    criados.length = 0;
    const t = await tgOkPreguicoso({ estadoDir: raiz, env: { [VAR]: chave }, lerRegistro: async () => null, criar });
    assert.ok(t, rotulo);
    assert.deepEqual(Object.keys(t).sort(), ['botId', 'chatDono', 'espiar'], rotulo);
    assert.equal(typeof t.espiar, 'function', rotulo);
    assert.equal(t.botId, botId, `${rotulo}: botId`);
    assert.equal(t.chatDono, chatDono, `${rotulo}: chatDono`);
    assert.deepEqual(criados, [], `${rotulo}: o cliente so nasce na 1a espiada`);
    await t.espiar({ offset: 1 });
    assert.deepEqual(criados, [{ token: chave, chatId: chatDono }], rotulo);
  }

  // o Nao perfeito (o mesmo toque que o T7b1b 72 recusa) com um tgOk sem o bot, sem o chat ou de outro dono: nao recusa
  const verificarCom = async (extra, lista) => {
    const h = montar();
    const { cod } = await pedidoCom(h);
    h.t = T0 + MIN;
    const updates = lista ?? [toque(h, cod, 'nao', { updateId: 502, messageId: 78 })];
    const tgOk = { espiar: async () => JSON.parse(JSON.stringify(updates)), ...extra };
    return { h, cod, r: await h.ok({ tgOk }).verificar(cod) };
  };
  const SEM = 'sem bot ou chat do dono';
  for (const [rotulo, extra, motivo] of [
    ['sem botId', { chatDono: DONO }, SEM],
    ['sem chatDono', { botId: BOT }, SEM],
    ['sem os dois (o tgOk de antes)', {}, SEM],
    ['botId null e chatDono em texto', { botId: null, chatDono: String(DONO) }, SEM],
    ['chatDono de outro dono', { botId: BOT, chatDono: 42 }, 'quem tocou nao e o dono do chat'],
    ['botId de outro dono', { botId: 7, chatDono: DONO }, 'a mensagem tocada nao e do bot'],
  ]) {
    const { h, cod, r } = await verificarCom(extra);
    assert.deepEqual(r, {
      status: 'pendente', motivo: 'sem resposta do dono ainda',
      ignoradas: [{ canal: 'telegram', updateId: 502, motivo: `toque do Telegram nao confere: ${motivo}` }],
    }, rotulo);
    semEfeito(h, cod, rotulo);
  }
  // com os dois certos: recusado como hoje
  {
    const { h, cod, r } = await verificarCom({ botId: BOT, chatDono: DONO });
    assert.deepEqual(r, { status: 'recusado', motivo: 'o dono tocou em Nao no Telegram', codigo: cod, hora: '16:01' });
    assert.equal(h.pedido(cod).status, 'recusado');
  }

  // a "trava" no chat e a do chatDono do tgOk: com o dono 42, a "trava" de 42 trava e a do chat de antes nao
  const travaDe = (de) => ({
    update_id: 610,
    message: { message_id: 700, from: { id: de, is_bot: false, first_name: 'X' }, chat: { id: de, type: 'private' }, date: segs(iso(T0)) + 30, text: 'trava' },
  });
  {
    const { h, cod, r } = await verificarCom({ botId: BOT, chatDono: 42 }, [travaDe(42)]);
    assert.deepEqual(r, { status: 'invalido', motivo: 'travado pelo dono' }, 'trava do dono 42');
    semEfeito(h, cod, 'trava do dono 42');
  }
  {
    const { h, cod, r } = await verificarCom({ botId: BOT, chatDono: 42 }, [travaDe(DONO)]);
    assert.deepEqual(r, { status: 'pendente', motivo: 'sem resposta do dono ainda', ignoradas: [] }, 'trava do chat de antes com o dono 42');
    semEfeito(h, cod, 'trava do chat de antes com o dono 42');
  }
  {
    const { r } = await verificarCom({ botId: BOT }, [travaDe(DONO)]);
    assert.deepEqual(r, { status: 'pendente', motivo: 'sem resposta do dono ainda', ignoradas: [] }, 'sem chatDono: nem a trava do chat de antes');
  }
});

// A1b, sabotagem t7b1b A49 (05/10/2026): sem a conferencia do lerConfigOk o tgOkPreguicoso continuava null nos casos do
// T7b1b 79 so porque o config deles nao tem chatId (a regra da A1a vem logo depois). Aqui o config tem o chat e a chave.
test('A1 11d. tgOkPreguicoso com o chatId e a chave no config: sem telegram.ok.ligado true (ausente, falso, em texto) ou com o telegram desligado = null, sem ler a chave e sem criar cliente', async () => {
  const { tgOkPreguicoso } = okWpp;
  const raiz = pastaTemp('a1b-tgok-config-');
  const VAR = 'CHAVE_FALSA_A1B';
  const chamadas = [];
  const criados = [];
  const lerRegistro = async (nome) => {
    chamadas.push(nome);
    return '7:x';
  };
  const criar = (a) => {
    criados.push(a);
    return { espiar: async () => [] };
  };
  const cfg = (telegram) => fs.writeFileSync(path.join(raiz, 'config.json'), JSON.stringify({ telegram }));
  const base = { ligado: true, chatId: DONO, botId: 7, varChave: VAR };
  for (const [rotulo, telegram] of [
    ['sem telegram.ok', base],
    ['telegram.ok sem ligado', { ...base, ok: {} }],
    ['telegram.ok.ligado false', { ...base, ok: { ligado: false } }],
    ['telegram.ok.ligado em texto', { ...base, ok: { ligado: 'true' } }],
    ['telegram desligado com o ok ligado', { ...base, ligado: false, ok: { ligado: true } }],
  ]) {
    cfg(telegram);
    chamadas.length = 0;
    assert.equal(await tgOkPreguicoso({ estadoDir: raiz, env: {}, lerRegistro, criar }), null, rotulo);
    assert.deepEqual(chamadas, [], `${rotulo}: a chave nem e lida`);
  }
  assert.deepEqual(criados, [], 'nenhum cliente');
  // controle: o mesmo config com o ok ligado da o tgOk (a chave vem do registro duble, pela varChave)
  cfg({ ...base, ok: { ligado: true } });
  chamadas.length = 0;
  const t = await tgOkPreguicoso({ estadoDir: raiz, env: {}, lerRegistro, criar });
  assert.ok(t, 'com telegram.ok.ligado: o tgOk');
  assert.deepEqual(chamadas, [VAR]);
  assert.equal(t.botId, 7);
  assert.equal(t.chatDono, DONO);
});

// ---------- T26a (PLANO-TELEGRAM.md, "T26a"): o Sim tocado na mensagem da aba (o bloco do OK no fim) ----------

// T28 (PLANO-TELEGRAM.md, "T28", contrato 2; caso (i) da prova): o toque no botao "🔄 Tentar novamente" (dados r:<COD>)
// nunca vira Sim no verificar: no prazo o pedido continua pendente (o toque e ignorado); vencido = expirou.
describe('T28 o toque r: no lote do verificar', () => {
  test('T28 i: toque r:<COD> do dono, na mensagem do bot = pendente (ignorado, sem efeito); depois do prazo = expirou', async () => {
    {
      const h = montar();
      const { ok, cod } = await pedidoCom(h);
      h.t = T0 + MIN;
      h.tg = [toque(h, cod, 'sim', { updateId: 601, dados: `r:${cod}` })];
      const r = await ok.verificar(cod);
      // o verificar nem conta o toque fora do k: (ignorado calado): continua pendente
      assert.deepEqual(r, { status: 'pendente', motivo: 'sem resposta do dono ainda', ignoradas: [] });
      semEfeito(h, cod, 'toque r:');
    }
    {
      const h = montar();
      const { ok, cod } = await pedidoCom(h);
      h.tg = [toque(h, cod, 'sim', { updateId: 602, dados: `r:${cod}` })];
      h.t = T0 + 30 * MIN + 1;
      assert.deepEqual(await ok.verificar(cod), { status: 'invalido', motivo: 'expirou' });
      assert.equal(h.pedido(cod).status, 'pendente');
    }
  });
});

describe('T26a o verificar aceita o Sim tocado na mensagem da aba', () => {
  // O texto que o Telegram devolve da mensagem mandada em HTML: sem tags, entidades desfeitas (a conta do semTags do
  // telegram.mjs)
  const semTags = (html) => String(html ?? '').replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  // A mensagem da aba com o OK dentro, montada do ARQUIVO do pedido (como o canal fara na T26b)
  const daAba = async (p, { completo = false, final = 'Terminei o `<pid>.json` & o resto.\n\n**Posso publicar?** A) Sim / B) Não' } = {}) => {
    const { montarBlocoOk } = await import('../lib/ok-tg.mjs');
    const { montarChamadoComOk } = await import('../lib/formato-tg.mjs');
    const bloco = { compacto: montarBlocoOk({ ...p, completo: false }), completo: montarBlocoOk({ ...p, completo: true }) };
    const r = montarChamadoComOk({ estado: 'resposta', titulo: 'repos-f3', final, chamadoId: 'ABCDEFGH' }, { bloco, completo });
    return { texto: semTags(r.classico), botoes: r.botoes, bloco: completo ? bloco.completo : bloco.compacto };
  };

  test('T26a 1: Sim no compacto e no completo da mensagem da aba = ok pelo Telegram (usado, verificadoPor), igual ao de hoje', async () => {
    for (const completo of [false, true]) {
      const h = montar();
      const { ok, cod } = await pedidoCom(h);
      h.t = T0 + MIN;
      const aba = await daAba(h.pedido(cod), { completo });
      assert.ok(aba.texto.endsWith(`\n${aba.bloco.texto}`), 'o bloco no fim');
      assert.ok(aba.texto.includes('<pid>.json & o resto'), 'a parte da aba em cima');
      // o teclado do helper e o do montarOkTg da mesma versao: o mesmo do bloco
      assert.deepEqual(aba.botoes, montarOkTg({ ...h.pedido(cod), completo }).botoes);
      h.tg = [toque(h, cod, 'sim', { updateId: 501, messageId: 77, completo, texto: aba.texto })];
      const r = await ok.verificar(cod);
      assert.deepEqual(r, { status: 'ok', canal: 'telegram', codigo: cod, tipo: 'publicacao', acao: ACAO, destinatarios: null, hora: '16:01' }, `completo=${completo}`);
      const p = h.pedido(cod);
      assert.equal(p.status, 'usado');
      assert.deepEqual(p.verificadoPor, { canal: 'telegram', updateId: 501, messageId: 77, texto: 'Sim', conferidoEm: iso(T0 + MIN) });
      assert.deepEqual(h.markers(), { [SID]: { at: T0 + MIN, k: 'telegram', trecho: `${cod} pelo Telegram: ${ACAO}`, usos: 0 } });
    }
  });

  test('T26a 2: o Nao tocado na mensagem da aba cancela; bloco no meio ou de outro pedido = ignorada, sem efeito', async () => {
    {
      const h = montar();
      const { ok, cod } = await pedidoCom(h);
      h.t = T0 + MIN;
      const aba = await daAba(h.pedido(cod));
      h.tg = [toque(h, cod, 'nao', { updateId: 501, texto: aba.texto })];
      const r = await ok.verificar(cod);
      assert.deepEqual(r, { status: 'recusado', motivo: 'o dono tocou em Nao no Telegram', codigo: cod, hora: '16:01' });
      assert.equal(h.pedido(cod).status, 'recusado');
      assert.equal(h.markers(), null);
    }
    {
      const h = montar();
      const a = await pedidoCom(h, 'publicacao', 'Publicar o site A');
      const b = await pedidoCom(h, 'publicacao', 'Publicar o site B');
      h.t = T0 + MIN;
      const abaA = await daAba(h.pedido(a.cod));
      const abaB = await daAba(h.pedido(b.cod));
      const forjados = [
        ['bloco no meio (texto depois dele)', `${abaA.texto}\nPS: e mais isso`],
        ['bloco do B com os dados do A', abaB.texto],
        ['bloco do A colado sem quebra', abaA.texto.replace(`\n\n${abaA.bloco.texto}`, abaA.bloco.texto)],
      ];
      let id = 510;
      for (const [nome, texto] of forjados) {
        id += 1;
        h.tg = [toque(h, a.cod, 'sim', { updateId: id, texto })];
        const r = await a.ok.verificar(a.cod);
        assert.deepEqual(r, {
          status: 'pendente', motivo: 'sem resposta do dono ainda',
          ignoradas: [{ canal: 'telegram', updateId: id, motivo: 'toque do Telegram nao confere: texto da mensagem nao confere com o pedido' }],
        }, nome);
        assert.doesNotMatch(JSON.stringify(r), /site A/, nome);
        semEfeito(h, a.cod, nome);
      }
    }
  });
});
