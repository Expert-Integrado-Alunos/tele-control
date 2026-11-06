#!/usr/bin/env node
'use strict';
/*
 * Teste do hooks/lib/permissao-telegram.js (o pedido de permissao do app repassado pro Telegram com Sim e Nao).
 *
 * Por que existe (06/11/2026): a aba do Claude Desktop ficou 6 h parada num "Permitir uma vez" com o dono na rua e nada
 * chegou no Telegram. O repasse e quem decide allow/deny no lugar da janela: allow so com o Sim conferido pelo ok-wpp
 * (que rele o toque no servidor do Telegram); qualquer falha antes do pedido sair = null (o caminho de antes segue).
 *
 * Isolamento: pasta temporaria por teste (SESSOES_WPP_DIR, CLAUDE_SESSIONS_DIR, SESSOES_WPP_LOG); o ok-wpp, o relogio,
 * o sono, os sinais e o process.exit dublados. O porteiro "vivo" e este processo (pid real) com o estado.json recem-gravado.
 *
 * Rodar: node --test hooks/tests/permissao-telegram.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { pastaTemp } = require('../../tests/lib/pasta-temp.cjs');
const pt = require('../lib/permissao-telegram.js');

const SID = '11111111-2222-4333-8444-555555555555';
const COD = 'ABCD23';
const CHAT = 700100200;
const iso = (ms) => new Date(ms).toISOString();

function montar({ config, estado, registro } = {}) {
  const raiz = pastaTemp('perm-tg-');
  const estadoDir = path.join(raiz, 'estado');
  const sessionsDir = path.join(raiz, 'sessions');
  fs.mkdirSync(estadoDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  const h = {
    raiz, estadoDir, sessionsDir,
    log: path.join(raiz, 'sessoes-wpp.log'),
    env: { SESSOES_WPP_DIR: estadoDir, CLAUDE_SESSIONS_DIR: sessionsDir, SESSOES_WPP_LOG: path.join(raiz, 'sessoes-wpp.log') },
    t: Date.now(),
    chamadas: [],
    dormidos: [],
    cancelados: [],
    saidas: [],
    sinais: new EventEmitter(),
    verificar: [{ code: 0, json: { status: 'ok', codigo: COD } }],
    aoDormir: null,
  };
  h.config = (c) => fs.writeFileSync(path.join(estadoDir, 'config.json'), JSON.stringify(c));
  h.estado = (e) => fs.writeFileSync(path.join(estadoDir, 'estado.json'), JSON.stringify(e));
  h.lerEstado = () => JSON.parse(fs.readFileSync(path.join(estadoDir, 'estado.json'), 'utf8'));
  h.pedido = (p) => {
    fs.mkdirSync(path.join(estadoDir, 'oks'), { recursive: true });
    fs.writeFileSync(path.join(estadoDir, 'oks', `${COD}.json`), JSON.stringify({ codigo: COD, tipo: 'permissao', ...p }));
  };
  h.toque = (toque) => {
    const e = h.lerEstado();
    e.okTg = { mensagens: { [COD]: { toque } } };
    h.estado(e);
  };
  h.config(config || { telegram: { ligado: true, chatId: CHAT, ok: { ligado: true } } });
  h.estado(estado || { v: 1, trava: false });
  fs.writeFileSync(path.join(estadoDir, 'porteiro.lock'), String(process.pid));
  const reg = registro === undefined
    ? { pid: 4242, sessionId: SID, entrypoint: 'claude-desktop', messagingSocketPath: '/tmp/s.sock', updatedAt: h.t }
    : registro;
  if (reg) fs.writeFileSync(path.join(sessionsDir, '4242.json'), JSON.stringify(reg));
  h.entrada = (extra = {}) => ({
    hook_event_name: 'PermissionRequest', session_id: SID, tool_name: 'mcp__ccd_session__start_session',
    tool_input: { title: 'Demo do cartão' }, ...extra,
  });
  h.okWpp = async (args) => {
    h.chamadas.push(args);
    if (args[0] === 'pedir') {
      const v = Number(args[args.indexOf('--validade-min') + 1]);
      return { code: 0, json: { status: 'pedido', codigo: COD, expiraEm: iso(h.t + v * 60000) } };
    }
    if (args[0] === 'verificar') return h.verificar.length > 1 ? h.verificar.shift() : h.verificar[0];
    if (args[0] === 'cancelar') return { code: 0, json: { status: 'cancelado', codigo: COD } };
    return { code: 1, json: null };
  };
  h.opcoes = (extra = {}) => ({
    env: h.env,
    agora: () => h.t,
    dormir: async (ms) => { h.dormidos.push(ms); h.t += ms; if (h.aoDormir) h.aoDormir(); },
    okWpp: h.okWpp,
    cancelarSync: (cod, motivo) => { h.cancelados.push([cod, motivo]); },
    sinais: h.sinais,
    sair: (c) => { h.saidas.push(c); },
    ...extra,
  });
  h.pedir = () => h.chamadas.find((a) => a[0] === 'pedir');
  h.de = (verbo) => h.chamadas.filter((a) => a[0] === verbo);
  h.textoLog = () => { try { return fs.readFileSync(h.log, 'utf8'); } catch (_) { return ''; } };
  return h;
}

// ---------- disponivel ----------

test('D1. tudo ligado, porteiro vivo e aba interativa = disponivel', () => {
  const h = montar();
  assert.deepEqual(pt.disponivel(h.entrada(), { env: h.env }), { ok: true });
});

test('D2. cada recusa tem o seu motivo (e nenhuma lanca)', () => {
  const casos = [
    ['entrada ilegivel', (h) => [null]],
    ['nao e pedido de permissao', (h) => [h.entrada({ hook_event_name: 'PreToolUse' })]],
    ['ajudante', (h) => [h.entrada({ agent_id: 'a1' })]],
    ['ferramenta com caminho proprio', (h) => [h.entrada({ tool_name: 'AskUserQuestion' })]],
    ['ferramenta com caminho proprio', (h) => [h.entrada({ tool_name: 'ExitPlanMode' })]],
    ['ferramenta com caminho proprio', (h) => [h.entrada({ tool_name: '' })]],
    ['sem sessao', (h) => [h.entrada({ session_id: '../x' })]],
    ['desligado pelo ambiente', (h) => [h.entrada(), { env: { ...h.env, SESSOES_WPP_PERMISSAO_TG: '0' } }]],
    ['OK pelo Telegram desligado', (h) => { h.config({ telegram: { ligado: false, chatId: CHAT, ok: { ligado: true } } }); return [h.entrada()]; }],
    ['OK pelo Telegram desligado', (h) => { h.config({ telegram: { ligado: true, chatId: CHAT } }); return [h.entrada()]; }],
    ['sem o chat do dono no config', (h) => { h.config({ telegram: { ligado: true, ok: { ligado: true } } }); return [h.entrada()]; }],
    ['repasse de permissao desligado no config', (h) => { h.config({ telegram: { ligado: true, chatId: CHAT, ok: { ligado: true, permissao: false } } }); return [h.entrada()]; }],
    ['estado do porteiro ilegivel', (h) => { fs.writeFileSync(path.join(h.estadoDir, 'estado.json'), '{quebrado'); return [h.entrada()]; }],
    ['travado pelo dono', (h) => { h.estado({ v: 1, trava: true }); return [h.entrada()]; }],
    ['porteiro parado', (h) => { fs.rmSync(path.join(h.estadoDir, 'porteiro.lock')); return [h.entrada()]; }],
    ['porteiro parado', (h) => { fs.writeFileSync(path.join(h.estadoDir, 'porteiro.lock'), '0'); return [h.entrada()]; }],
    ['porteiro parado', (h) => [h.entrada(), { env: h.env, agora: () => Date.now() + 2 * 60 * 1000 }]],
    ['sessao nao interativa', (h) => { fs.rmSync(path.join(h.sessionsDir, '4242.json')); return [h.entrada()]; }],
    ['sessao nao interativa', (h) => { fs.writeFileSync(path.join(h.sessionsDir, '4242.json'), JSON.stringify({ pid: 4242, sessionId: SID, entrypoint: 'sdk-cli' })); return [h.entrada()]; }],
    ['sessao nao interativa', (h) => { fs.writeFileSync(path.join(h.sessionsDir, '4242.json'), JSON.stringify({ pid: 4242, sessionId: SID, entrypoint: 'claude-desktop' })); return [h.entrada()]; }],
  ];
  for (const [motivo, preparar] of casos) {
    const h = montar();
    const [entrada, opcoes = { env: h.env }] = preparar(h);
    const r = pt.disponivel(entrada, opcoes);
    assert.equal(r.ok, false, motivo);
    assert.equal(r.motivo, motivo);
  }
});

// ---------- texto do pedido ----------

test('T1. descrever: frase por ferramenta, mcp com o servidor, prefixo "A aba quer"', () => {
  assert.equal(pt.descrever('Bash', { command: 'ls -la', description: 'Lista' }), 'A aba quer rodar no terminal: ls -la (Lista)');
  assert.equal(pt.descrever('mcp__ccd_session__start_session', { title: 'Demo' }), 'A aba quer abrir uma sessão nova: Demo');
  assert.equal(pt.descrever('mcp__Claude_Browser__preview_start', { name: 'web' }), 'A aba quer abrir o navegador do app em web');
  assert.equal(pt.descrever('mcp__terminal__run_in_terminal', { command: 'npm test' }), 'A aba quer rodar no terminal do app: npm test');
  assert.equal(pt.descrever('Write', { file_path: '/a/b.txt' }), 'A aba quer gravar o arquivo /a/b.txt');
  assert.equal(pt.descrever('Edit', { file_path: '/a/b.txt' }), 'A aba quer editar o arquivo /a/b.txt');
  assert.equal(pt.descrever('WebFetch', { url: 'https://exemplo.com' }), 'A aba quer abrir a página https://exemplo.com');
  assert.equal(pt.descrever('mcp__pipedrive__update_deal', { id: 1 }), 'A aba quer usar update_deal (pipedrive): {"id":1}');
  assert.equal(pt.descrever('Glob', null), 'A aba quer usar Glob');
});

test('T2. mascarar: senha, chave, Bearer, usuario:senha na URL e sequencia longa viram ***', () => {
  const longa = 'Q'.repeat(40);
  assert.equal(pt.mascarar('run --password abc123 x'), 'run --password *** x');
  assert.equal(pt.mascarar('API_KEY=xyz9 ok'), 'API_KEY=*** ok');
  assert.equal(pt.mascarar('curl -H "Authorization: Bearer abc.def"'), 'curl -H "Authorization: Bearer ***');
  assert.equal(pt.mascarar('git clone https://eu:segredo@host/r.git'), 'git clone https://eu:***@host/r.git');
  assert.equal(pt.mascarar(`chave ${longa} fim`), 'chave *** fim');
  assert.match(pt.descrever('Bash', { command: `echo ${longa}` }), /echo \*\*\*/);
});

test('T3. descrever corta em 700 caracteres com reticencias', () => {
  const r = pt.descrever('Bash', { command: 'palavra '.repeat(300) });
  assert.ok(Array.from(r).length <= 700, String(Array.from(r).length));
  assert.ok(r.endsWith('…'));
});

// ---------- repassar ----------

test('R1. sem modo rua: espera 45 s, pede (so permissao, validade do que sobra do teto), Sim conferido = allow', async () => {
  const h = montar();
  h.aoDormir = () => { if (h.pedir() && !h.lerEstado().okTg) h.toque({ acao: 'sim', updateId: 501 }); };
  const r = await pt.repassar(h.entrada(), h.opcoes());
  assert.deepEqual(r, { decisao: 'allow', por: 'sim', motivo: null, codigo: COD });
  assert.equal(h.dormidos.slice(0, 30).reduce((a, b) => a + b, 0), pt.ATRASO_MS, 'espera os 45 s em passos curtos (olhando a tela)');
  assert.ok(h.dormidos.slice(0, 30).every((ms) => ms <= 1500));
  const p = h.pedir();
  assert.deepEqual(p.slice(0, 5), ['pedir', '--tipo', 'permissao', '--validade-min', '9']);
  assert.equal(p[6], 'A aba quer abrir uma sessão nova: Demo do cartão');
  assert.deepEqual(h.de('verificar'), [['verificar', COD]]);
  assert.equal(h.sinais.listenerCount('SIGTERM'), 0, 'solta os sinais no fim');
  assert.ok(!h.textoLog().includes('Demo do cartão'), 'o log nao leva o texto da acao');
});

test('R2. modo rua ligado ou sessao escondida = direto, validade 10 min', async () => {
  for (const prep of [
    (h) => { h.estado({ v: 1, trava: false, modoRua: { ligado: true, atualizadoEm: iso(h.t) } }); return h.env; },
    (h) => ({ ...h.env, SESSOES_WPP_ESCONDIDA: '1' }),
  ]) {
    const h = montar();
    const env = prep(h);
    h.aoDormir = () => { if (!h.lerEstado().okTg) h.toque({ acao: 'sim', updateId: 501 }); };
    const r = await pt.repassar(h.entrada(), h.opcoes({ env }));
    assert.equal(r.decisao, 'allow');
    assert.notEqual(h.dormidos[0], pt.ATRASO_MS);
    assert.equal(h.pedir()[4], '10');
  }
});

test('R3. Nao no Telegram = deny com o motivo de nao repetir', async () => {
  const h = montar();
  h.verificar = [{ code: 3, json: { status: 'recusado', codigo: COD } }];
  h.aoDormir = () => { if (h.pedir() && !h.lerEstado().okTg) h.toque({ acao: 'nao', updateId: 502 }); };
  const r = await pt.repassar(h.entrada(), h.opcoes());
  assert.deepEqual(r, { decisao: 'deny', por: 'nao', motivo: pt.MOTIVO.nao, codigo: COD });
});

test('R4. ninguem responde no prazo = cancela (sem-resposta) e deny; nunca allow sem toque', async () => {
  const h = montar();
  const r = await pt.repassar(h.entrada(), h.opcoes({ pollMs: 30000 }));
  assert.deepEqual(r, { decisao: 'deny', por: 'sem-resposta', motivo: pt.MOTIVO.semResposta, codigo: COD });
  assert.deepEqual(h.de('cancelar'), [['cancelar', COD, '--motivo', 'sem-resposta']]);
  assert.equal(h.de('verificar').length, 0);
});

test('R5. o arquivo do pedido ja decidido manda: usado = allow, recusado = deny, cancelado por fora = null', async () => {
  for (const [status, esperado] of [['usado', 'allow'], ['recusado', 'deny'], ['cancelado', null]]) {
    const h = montar();
    h.aoDormir = () => { if (h.pedir()) h.pedido({ status }); };
    const r = await pt.repassar(h.entrada(), h.opcoes());
    assert.equal(r ? r.decisao : null, esperado, status);
    assert.equal(h.de('verificar').length, 0);
  }
});

test('R6. conferencia invalida: ja usado/ja recusado/trava/expirou decidem; o resto cancela e devolve pra tela (null)', async () => {
  const casos = [
    ['ja usado', { decisao: 'allow', por: 'sim' }],
    ['ja recusado', { decisao: 'deny', por: 'nao' }],
    ['travado pelo dono', { decisao: 'deny', por: 'trava' }],
    ['expirou', { decisao: 'deny', por: 'sem-resposta' }],
    ['pedido de outra sessao', null],
  ];
  for (const [motivo, esperado] of casos) {
    const h = montar();
    h.verificar = [{ code: 2, json: { status: 'invalido', motivo } }];
    h.aoDormir = () => { if (h.pedir() && !h.lerEstado().okTg) h.toque({ acao: 'sim', updateId: 501 }); };
    const r = await pt.repassar(h.entrada(), h.opcoes());
    if (esperado) {
      assert.equal(r.decisao, esperado.decisao, motivo);
      assert.equal(r.por, esperado.por, motivo);
      assert.equal(h.de('cancelar').length, 0, motivo);
    } else {
      assert.equal(r, null, motivo);
      assert.deepEqual(h.de('cancelar'), [['cancelar', COD, '--motivo', 'sem-resposta']]);
    }
  }
  const h = montar();
  h.verificar = [{ code: 2, json: { status: 'invalido', motivo: 'travado pelo dono' } }];
  h.aoDormir = () => { if (h.pedir() && !h.lerEstado().okTg) h.toque({ acao: 'sim', updateId: 501 }); };
  assert.equal((await pt.repassar(h.entrada(), h.opcoes())).motivo, pt.MOTIVO.trava);
});

test('R7. conferencia pendente (Telegram ocupado) tenta de novo e o Sim conferido depois vale', async () => {
  const h = montar();
  h.verificar = [{ code: 4, json: { status: 'pendente', motivo: 'Telegram ocupado' } }, { code: 0, json: { status: 'ok', codigo: COD } }];
  h.aoDormir = () => { if (h.pedir() && !h.lerEstado().okTg) h.toque({ acao: 'sim', updateId: 501 }); };
  const r = await pt.repassar(h.entrada(), h.opcoes());
  assert.equal(r.decisao, 'allow');
  assert.equal(h.de('verificar').length, 2);
});

test('R8. toque solto (soltoEm) ou sem updateId nao vai pra conferencia', async () => {
  for (const toque of [{ acao: 'sim', updateId: 501, soltoEm: iso(Date.now()) }, { acao: 'sim' }, { acao: 'talvez', updateId: 501 }]) {
    const h = montar();
    h.aoDormir = () => { if (h.pedir() && !h.lerEstado().okTg) h.toque(toque); };
    const r = await pt.repassar(h.entrada(), h.opcoes({ pollMs: 60000 }));
    assert.equal(r.por, 'sem-resposta');
    assert.equal(h.de('verificar').length, 0);
  }
});

test('R9. ficou indisponivel na espera (trava ligada) ou o pedido nao saiu = null, sem pedido no Telegram', async () => {
  const h = montar();
  h.aoDormir = () => { h.estado({ v: 1, trava: true }); };
  assert.equal(await pt.repassar(h.entrada(), h.opcoes()), null);
  assert.equal(h.de('pedir').length, 0);
  for (const resposta of [{ code: 2, json: { status: 'invalido', motivo: 'x' } }, { code: null, json: null }, { code: 0, json: { status: 'pedido', codigo: 'abc' } }]) {
    const h2 = montar();
    const r = await pt.repassar(h2.entrada(), h2.opcoes({ okWpp: async (a) => { h2.chamadas.push(a); return resposta; } }));
    assert.equal(r, null);
    assert.equal(h2.de('pedir').length, 1);
  }
});

test('R10. teto sem 1 minuto inteiro = null sem pedir; erro no ok-wpp = null (nunca lanca)', async () => {
  const h = montar();
  assert.equal(await pt.repassar(h.entrada(), h.opcoes({ tetoMs: 50 * 1000, atrasoMs: 0 })), null);
  assert.equal(h.de('pedir').length, 0);
  const h2 = montar();
  assert.equal(await pt.repassar(h2.entrada(), h2.opcoes({ okWpp: async () => { throw new Error('quebrou'); } })), null);
  assert.match(h2.textoLog(), /erro: quebrou/);
});

test('R11. a tela respondeu antes (sinal de encerramento) = cancela na-tela, sai 0 e devolve null', async () => {
  const h = montar();
  h.aoDormir = () => { if (h.pedir() && h.saidas.length === 0) h.sinais.emit('SIGTERM'); };
  const r = await pt.repassar(h.entrada(), h.opcoes());
  assert.equal(r, null);
  assert.deepEqual(h.cancelados, [[COD, 'na-tela']]);
  assert.deepEqual(h.saidas, [0]);
  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) assert.equal(h.sinais.listenerCount(s), 0, s);
});

// ---------- respondido na tela (o app do Desktop nao encerra o hook: medido 06/11/2026) ----------

function conversa(h, linhas) {
  const arq = path.join(h.raiz, 'conversa.jsonl');
  fs.writeFileSync(arq, linhas.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return arq;
}
const usoDe = (id, name, input) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const resultadoDe = (id) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const FERR = 'mcp__ccd_session__start_session';

test('C1. idDaChamada: o tool_use_id da entrada manda; senao o ultimo tool_use igual (nome e entrada, chaves em qualquer ordem) sem resultado', () => {
  const h = montar();
  const arq = conversa(h, [
    usoDe('t1', FERR, { title: 'Demo do cartão', extra: 1 }), resultadoDe('t1'),
    usoDe('t2', FERR, { extra: 1, title: 'Demo do cartão' }),
    usoDe('t3', 'Bash', { command: 'ls' }),
  ]);
  const e = h.entrada({ transcript_path: arq, tool_input: { title: 'Demo do cartão', extra: 1 } });
  assert.equal(pt.idDaChamada(e), 't2');
  assert.equal(pt.idDaChamada({ ...e, tool_use_id: 'toolu_x' }), 'toolu_x');
  assert.equal(pt.idDaChamada({ ...e, tool_input: { title: 'Outra' } }), null);
  assert.equal(pt.idDaChamada({ ...e, transcript_path: 'relativo.jsonl' }), null);
  assert.equal(pt.idDaChamada({ ...e, transcript_path: path.join(h.raiz, 'nao-existe.jsonl') }), null);
  assert.equal(pt.respondidaNaTela(e, 't1'), true);
  assert.equal(pt.respondidaNaTela(e, 't2'), false);
});

test('C2. a tela respondeu durante a espera dos 45 s = nada vai pro Telegram (null, sem pedido)', async () => {
  const h = montar();
  const arq = conversa(h, [usoDe('t9', FERR, { title: 'Demo do cartão' })]);
  let passos = 0;
  h.aoDormir = () => { if (++passos === 3) fs.appendFileSync(arq, JSON.stringify(resultadoDe('t9')) + '\n'); };
  const r = await pt.repassar(h.entrada({ transcript_path: arq }), h.opcoes());
  assert.equal(r, null);
  assert.equal(h.de('pedir').length, 0);
  assert.match(h.textoLog(), /respondido na tela; nada vai pro Telegram/);
});

test('C3. a tela respondeu com o pedido no ar = cancela (na-tela) e devolve null; o Sim que chegar depois nao vale', async () => {
  const h = montar();
  const arq = conversa(h, [usoDe('t9', FERR, { title: 'Demo do cartão' })]);
  h.aoDormir = () => {
    if (!h.pedir() || fs.readFileSync(arq, 'utf8').includes('tool_result')) return;
    fs.appendFileSync(arq, JSON.stringify(resultadoDe('t9')) + '\n');
    h.toque({ acao: 'sim', updateId: 501 });
  };
  const r = await pt.repassar(h.entrada({ transcript_path: arq }), h.opcoes({ atrasoMs: 0 }));
  assert.equal(r, null);
  assert.deepEqual(h.de('cancelar'), [['cancelar', COD, '--motivo', 'na-tela']]);
  assert.equal(h.de('verificar').length, 0);
});

test('C4. sem a chamada no transcript: segue como antes (o Sim conferido vale) e fica 1 linha no log', async () => {
  const h = montar();
  const arq = conversa(h, [usoDe('t9', 'Bash', { command: 'ls' })]);
  h.aoDormir = () => { if (h.pedir() && !h.lerEstado().okTg) h.toque({ acao: 'sim', updateId: 501 }); };
  const r = await pt.repassar(h.entrada({ transcript_path: arq }), h.opcoes({ atrasoMs: 0 }));
  assert.equal(r.decisao, 'allow');
  assert.match(h.textoLog(), /sem a chamada no transcript/);
});
