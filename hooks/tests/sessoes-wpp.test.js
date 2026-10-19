#!/usr/bin/env node
'use strict';
/*
 * Teste do D1 do sessoes-wpp (plano: PLANO.md).
 *
 * Cobre a lib hooks/lib/sessoes-wpp.js e os dois gatilhos:
 *   - hooks/sessao-parou.js      (Stop)       -> evento "parou" em eventos.jsonl
 *   - hooks/pergunta-modo-rua.js (PreToolUse) -> deny do AskUserQuestion + evento "pergunta-barrada"
 *
 * Por que existe: esses hooks rodam em TODA vez que uma aba do VS Code termina e em todo
 * AskUserQuestion. Erro que vaza vira ruido na sessao do dono; deny indevido prende os botoes
 * dele no PC; leitura do arquivo .key do registro vaza segredo. Os cenarios abaixo sao o
 * criterio de aceite do disparo D1.
 *
 * Isolamento: cada teste monta uma pasta temporaria (pastaTemp de tests/lib/pasta-temp.cjs, apagada no fim) e passa
 * SESSOES_WPP_DIR, CLAUDE_SESSIONS_DIR, SESSOES_WPP_LOG, HOME e USERPROFILE apontando pra ela.
 * Nada le ~/.claude real nem transcript real. Os hooks rodam como processo filho com stdin JSON.
 *
 * Rodar: node --test hooks/tests/sessoes-wpp.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pastaTemp } = require('../../tests/lib/pasta-temp.cjs');

const HOOKS = path.join(__dirname, '..');
const PAROU = path.join(HOOKS, 'sessao-parou.js');
const PERGUNTA = path.join(HOOKS, 'pergunta-modo-rua.js');
const lib = require('../lib/sessoes-wpp.js');

const DENY_TEXTO = 'A pessoa que usa este PC está fora dele (modo rua). Não use AskUserQuestion agora: escreva a pergunta em texto, no bloco 🔴 **DECISÃO:** com as opções A/B, e encerre a vez. Os botões voltam quando ela estiver no PC.';

// ---------------------------------------------------------------- utilitarios de fixture

function ambiente() {
  const raiz = pastaTemp('sessoes-wpp-teste-');
  const amb = {
    raiz,
    estadoDir: path.join(raiz, 'estado'),
    sessionsDir: path.join(raiz, 'sessions'),
    logFile: path.join(raiz, 'logs', 'sessoes-wpp.log'),
    home: path.join(raiz, 'home'),
    projetos: path.join(raiz, 'projects'),
  };
  fs.mkdirSync(amb.sessionsDir, { recursive: true });
  fs.mkdirSync(amb.home, { recursive: true });
  fs.mkdirSync(amb.projetos, { recursive: true });
  return amb;
}

// Apaga SO a pasta temporaria que o proprio teste criou.
function limpar(amb) {
  fs.rmSync(amb.raiz, { recursive: true, force: true });
}

function envDe(amb, extra) {
  const env = Object.assign({}, process.env);
  for (const k of ['SESSOES_WPP_DIR', 'CLAUDE_SESSIONS_DIR', 'SESSOES_WPP_LOG']) delete env[k];
  return Object.assign(env, {
    SESSOES_WPP_DIR: amb.estadoDir,
    CLAUDE_SESSIONS_DIR: amb.sessionsDir,
    SESSOES_WPP_LOG: amb.logFile,
    HOME: amb.home,
    USERPROFILE: amb.home,
  }, extra || {});
}

function rodar(hook, amb, payload, extraEnv) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return spawnSync(process.execPath, [hook], {
    input,
    env: envDe(amb, extraEnv),
    encoding: 'utf8',
    timeout: 30000,
  });
}

function eventos(amb) {
  const f = path.join(amb.estadoDir, 'eventos.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function lerLog(amb) {
  return fs.existsSync(amb.logFile) ? fs.readFileSync(amb.logFile, 'utf8') : '';
}

let seq = 0;
function registro(over) {
  seq += 1;
  return Object.assign({
    pid: 166100 + seq,
    sessionId: `0a1b2c3d-41bd-44c4-96d8-${String(seq).padStart(12, '0')}`,
    cwd: 'c:\\projetos',
    startedAt: 1790535352438,
    version: '2.1.280',
    kind: 'interactive',
    entrypoint: 'claude-vscode',
    name: 'projetos-42',
    nameSource: 'derived',
    status: 'busy',
    updatedAt: 1790536332243,
  }, over || {});
}

function registrar(amb, reg) {
  fs.writeFileSync(path.join(amb.sessionsDir, `${reg.pid}.json`), JSON.stringify(reg));
  return reg;
}

function transcript(amb, nome, linhas) {
  const f = path.join(amb.projetos, `${nome}.jsonl`);
  const corpo = linhas.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
  fs.writeFileSync(f, corpo);
  return f;
}

const L = {
  titulo: (t, sid) => ({ type: 'custom-title', customTitle: t, sessionId: sid }),
  user: (texto, ts) => ({ type: 'user', message: { role: 'user', content: texto }, timestamp: ts }),
  assistente: (blocos, ts) => ({ type: 'assistant', message: { role: 'assistant', content: blocos }, timestamp: ts }),
  texto: (t) => ({ type: 'text', text: t }),
  ferramenta: () => ({ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }),
};

function stop(sid, tp, over) {
  return Object.assign({
    session_id: sid,
    transcript_path: tp,
    cwd: 'c:\\projetos',
    stop_hook_active: false,
    hook_event_name: 'Stop',
  }, over || {});
}

const QUESTOES = [
  {
    question: 'Qual caminho seguimos?',
    header: 'Caminho',
    multiSelect: false,
    options: [
      { label: 'A) Seguir agora', description: 'faz hoje' },
      { label: 'B) Esperar', description: 'faz amanha' },
    ],
  },
  {
    question: 'Publica junto?',
    header: 'Publicar',
    multiSelect: false,
    options: [{ label: 'Sim', description: '' }, { label: 'Nao', description: '' }],
  },
];

function ask(sid, tp, over) {
  return Object.assign({
    session_id: sid,
    transcript_path: tp,
    cwd: 'c:\\projetos',
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: { questions: QUESTOES },
  }, over || {});
}

function gravarEstado(amb, modoRua) {
  fs.mkdirSync(amb.estadoDir, { recursive: true });
  fs.writeFileSync(path.join(amb.estadoDir, 'estado.json'), JSON.stringify({ modoRua }));
}

const TEXTO_DECISAO = [
  'Terminei a primeira parte e o teste passou.',
  '',
  '---',
  '🔴 **DECISÃO:** Publico a pagina hoje?',
  'A) Publicar agora (recomendado) / B) Esperar a revisao',
].join('\n');

// ---------------------------------------------------------------- cenario 1

test('1. Stop de claude-vscode com custom-title e DECISAO -> 1 evento "parou" completo', () => {
  const amb = ambiente();
  try {
    const reg = registrar(amb, registro({ name: 'projetos-42', nameSource: 'derived' }));
    const tp = transcript(amb, reg.sessionId, [
      L.user('faz a pagina', '2026-09-27T18:00:00.000Z'),
      L.titulo('Faro', reg.sessionId),
      L.assistente([L.texto('Vou comecar.'), L.ferramenta()], '2026-09-27T18:01:00.000Z'),
      L.assistente([L.ferramenta()], '2026-09-27T18:02:00.000Z'),
      L.assistente([{ type: 'thinking', thinking: 'hmm' }, L.texto(TEXTO_DECISAO)], '2026-09-27T18:05:19.799Z'),
      { type: 'system', subtype: 'stop_hook_summary', timestamp: '2026-09-27T18:05:20.000Z' },
    ]);
    const r = rodar(PAROU, amb, stop(reg.sessionId, tp, { stop_hook_active: true }));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    const evs = eventos(amb);
    assert.equal(evs.length, 1);
    const ev = evs[0];
    assert.equal(ev.v, 1);
    assert.equal(ev.tipo, 'parou');
    assert.ok(!Number.isNaN(Date.parse(ev.at)) && ev.at.endsWith('Z'), `at ISO UTC: ${ev.at}`);
    assert.equal(ev.sessionId, reg.sessionId);
    assert.equal(ev.pid, reg.pid);
    assert.equal(ev.nome, 'projetos-42');
    assert.equal(ev.titulo, 'Faro');
    assert.equal(ev.cwd, 'c:\\projetos');
    assert.equal(ev.entrypoint, 'claude-vscode');
    assert.equal(ev.final, TEXTO_DECISAO);
    assert.equal(ev.finalTs, '2026-09-27T18:05:19.799Z');
    assert.deepEqual(ev.marcas, { decisao: true, fica: false, pergunta: false });
  } finally { limpar(amb); }
});

// T27 (PLANO-TELEGRAM.md, "T27", contrato 1; caso real 18/10: o hook de captura fez a aba continuar e o 2o parou
// engoliu a resposta): stop_hook_active true = `continuacao: true`; false ou ausente = sem a chave
test('T27 1. Stop com stop_hook_active true -> o evento ganha continuacao: true; false ou ausente -> sem a chave', () => {
  const amb = ambiente();
  try {
    const reg = registrar(amb, registro({ name: 'projetos-42', nameSource: 'derived' }));
    const tp = transcript(amb, reg.sessionId, [
      L.user('faz a pagina', '2026-09-27T18:00:00.000Z'),
      L.assistente([L.texto('Feito.')], '2026-09-27T18:01:00.000Z'),
    ]);
    const semCampo = stop(reg.sessionId, tp);
    delete semCampo.stop_hook_active;
    for (const payload of [stop(reg.sessionId, tp, { stop_hook_active: true }), stop(reg.sessionId, tp), semCampo]) {
      assert.equal(rodar(PAROU, amb, payload).status, 0);
    }
    const evs = eventos(amb);
    assert.equal(evs.length, 3);
    assert.equal(evs[0].continuacao, true);
    assert.equal(Object.hasOwn(evs[1], 'continuacao'), false);
    assert.equal(Object.hasOwn(evs[2], 'continuacao'), false);
  } finally { limpar(amb); }
});

// ---------------------------------------------------------------- cenario 2

test('2. Stop de sdk-cli e de claude-desktop SEM canal de recado -> 0 eventos', () => {
  const amb = ambiente();
  try {
    // F4i: o Desktop so entra com messagingSocketPath (medido 05/10/2026: 1 de 3 sessoes vivas sem o campo, fora do
    // ListAgents); sdk-cli nunca entra, nem com o campo
    const casos = [
      { entrypoint: 'sdk-cli' },
      { entrypoint: 'sdk-cli', messagingSocketPath: '\\\\.\\pipe\\LOCAL\\cc-msg-aaaa' },
      { entrypoint: 'claude-desktop' },
      { entrypoint: 'claude-desktop', messagingSocketPath: '' },
      { entrypoint: 'claude-desktop', messagingSocketPath: null },
    ];
    for (const over of casos) {
      const reg = registrar(amb, registro(over));
      const tp = transcript(amb, reg.sessionId, [L.assistente([L.texto(TEXTO_DECISAO)], '2026-09-27T18:05:19.799Z')]);
      const r = rodar(PAROU, amb, stop(reg.sessionId, tp));
      assert.equal(r.status, 0, JSON.stringify(over));
      assert.equal(r.stdout, '', JSON.stringify(over));
    }
    assert.equal(eventos(amb).length, 0);
  } finally { limpar(amb); }
});

test('2c. F4i: Stop de sessao do Claude Desktop COM canal de recado -> 1 evento parou com o titulo do Desktop', () => {
  const amb = ambiente();
  try {
    const reg = registrar(amb, registro({
      entrypoint: 'claude-desktop', name: 'Teste Tele Control', nameSource: undefined, hostSessionId: 'local_0000',
      messagingSocketPath: '\\\\.\\pipe\\LOCAL\\cc-msg-bbbb', cwd: 'C:\\tmp\\teste',
    }));
    const tp = transcript(amb, reg.sessionId, [
      L.titulo('Teste Tele Control', reg.sessionId),
      L.assistente([L.texto(TEXTO_DECISAO)], '2026-10-05T23:50:00.000Z'),
    ]);
    const r = rodar(PAROU, amb, stop(reg.sessionId, tp));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    const evs = eventos(amb);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].tipo, 'parou');
    assert.equal(evs[0].sessionId, reg.sessionId);
    assert.equal(evs[0].entrypoint, 'claude-desktop');
    assert.equal(evs[0].nome, 'Teste Tele Control');
    assert.equal(evs[0].titulo, 'Teste Tele Control');
    assert.equal(evs[0].cwd, 'C:\\tmp\\teste');
    assert.equal(evs[0].final, TEXTO_DECISAO);
    assert.deepEqual(evs[0].marcas, { decisao: true, fica: false, pergunta: false });
  } finally { limpar(amb); }
});

test('2b. F3.9: Stop de sessao interativa do terminal (entrypoint cli, a central) -> 1 evento parou', () => {
  const amb = ambiente();
  try {
    const reg = registrar(amb, registro({ entrypoint: 'cli' }));
    const tp = transcript(amb, reg.sessionId, [L.assistente([L.texto(TEXTO_DECISAO)], '2026-09-27T18:05:19.799Z')]);
    const r = rodar(PAROU, amb, stop(reg.sessionId, tp));
    assert.equal(r.status, 0);
    const evs = eventos(amb);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].tipo, 'parou');
    assert.equal(evs[0].entrypoint, 'cli');
  } finally { limpar(amb); }
});

test('2d. T21: ORCA_TERMINAL_HANDLE no ambiente -> parou com app "orca" e nenhum valor do Orca no evento; sem a variavel -> sem a chave app', () => {
  const amb = ambiente();
  try {
    // o ambiente do teste herda o de quem roda (pode ser um terminal do Orca): o filho recebe a variavel so quando o caso
    // pede, e o caso "sem" apaga ela
    const rodarCom = (sid, tp, handle) => {
      const env = envDe(amb);
      for (const k of Object.keys(env)) if (k.toUpperCase().startsWith('ORCA_')) delete env[k];
      if (handle !== undefined) Object.assign(env, { ORCA_TERMINAL_HANDLE: handle, ORCA_AGENT_HOOK_TOKEN: 'segredo_teste' });
      return spawnSync(process.execPath, [PAROU], { input: JSON.stringify(stop(sid, tp)), env, encoding: 'utf8', timeout: 30000 });
    };
    const com = registrar(amb, registro({ entrypoint: 'cli' }));
    const tpCom = transcript(amb, com.sessionId, [L.assistente([L.texto(TEXTO_DECISAO)], '2026-09-27T18:05:19.799Z')]);
    assert.equal(rodarCom(com.sessionId, tpCom, 'term_teste').status, 0);
    const sem = registrar(amb, registro({ entrypoint: 'cli' }));
    const tpSem = transcript(amb, sem.sessionId, [L.assistente([L.texto(TEXTO_DECISAO)], '2026-09-27T18:05:19.799Z')]);
    assert.equal(rodarCom(sem.sessionId, tpSem, undefined).status, 0);
    const vazio = registrar(amb, registro({ entrypoint: 'cli' }));
    const tpVazio = transcript(amb, vazio.sessionId, [L.assistente([L.texto(TEXTO_DECISAO)], '2026-09-27T18:05:19.799Z')]);
    assert.equal(rodarCom(vazio.sessionId, tpVazio, '').status, 0);
    const evs = eventos(amb);
    assert.equal(evs.length, 3);
    const de = (sid) => evs.find((x) => x.sessionId === sid);
    assert.equal(de(com.sessionId).app, 'orca');
    assert.equal(Object.hasOwn(de(sem.sessionId), 'app'), false);
    assert.equal(Object.hasOwn(de(vazio.sessionId), 'app'), false, 'variavel vazia = como sem');
    // o resto do evento e o de hoje: as mesmas chaves, so com `app` a mais
    assert.deepEqual(Object.keys(de(com.sessionId)).filter((k) => k !== 'app').sort(), Object.keys(de(sem.sessionId)).sort());
    const bruto = fs.readFileSync(path.join(amb.estadoDir, 'eventos.jsonl'), 'utf8');
    assert.equal(bruto.includes('term_teste'), false, 'o handle nunca vai pro evento');
    assert.equal(bruto.includes('segredo_teste'), false, 'o token do Orca nunca vai pro evento');
  } finally { limpar(amb); }
});

// ---------------------------------------------------------------- cenario 3

test('3. Stop com session_id sem registro -> 0 eventos, exit 0, stdout vazio', () => {
  const amb = ambiente();
  try {
    registrar(amb, registro());
    const tp = transcript(amb, 'orfa', [L.assistente([L.texto('oi')], '2026-09-27T18:05:19.799Z')]);
    const r = rodar(PAROU, amb, stop('sessao-que-nao-existe', tp));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(eventos(amb).length, 0);
  } finally { limpar(amb); }
});

// ---------------------------------------------------------------- cenario 4

test('4. Sem custom-title: nameSource "user" -> titulo = name; "derived" -> titulo null', () => {
  const amb = ambiente();
  try {
    const regUser = registrar(amb, registro({ name: 'Controle pelo WhatsApp', nameSource: 'user' }));
    const tpUser = transcript(amb, regUser.sessionId, [L.assistente([L.texto('feito')], '2026-09-27T18:05:19.799Z')]);
    const regDer = registrar(amb, registro({ name: 'projetos-f3', nameSource: 'derived' }));
    const tpDer = transcript(amb, regDer.sessionId, [L.assistente([L.texto('feito')], '2026-09-27T18:06:00.000Z')]);
    assert.equal(rodar(PAROU, amb, stop(regUser.sessionId, tpUser)).status, 0);
    assert.equal(rodar(PAROU, amb, stop(regDer.sessionId, tpDer)).status, 0);
    const evs = eventos(amb);
    assert.equal(evs.length, 2);
    assert.equal(evs[0].sessionId, regUser.sessionId);
    assert.equal(evs[0].titulo, 'Controle pelo WhatsApp');
    assert.equal(evs[1].sessionId, regDer.sessionId);
    assert.equal(evs[1].titulo, null);
    assert.equal(evs[1].nome, 'projetos-f3');
  } finally { limpar(amb); }
});

test('4b. tituloDe: vale o ULTIMO custom-title', () => {
  const ents = [
    L.titulo('Antigo', 's'),
    L.user('x', 't'),
    L.titulo('Faro', 's'),
    L.assistente([L.texto('y')], 't'),
  ];
  assert.equal(lib.tituloDe(ents, { name: 'projetos-42', nameSource: 'user' }), 'Faro');
  assert.equal(lib.tituloDe([], { name: 'projetos-42', nameSource: 'user' }), 'projetos-42');
  assert.equal(lib.tituloDe([], { name: 'projetos-42', nameSource: 'derived' }), null);
  assert.equal(lib.tituloDe([], null), null);
});

// Medido num caso real: aba que o dono nao renomeou mostra o titulo automatico (ai-title), reescrito a cada vez.
test('4c. tituloDe: custom-title > name(user) > ULTIMO ai-title > null', () => {
  const ai = (t) => ({ type: 'ai-title', aiTitle: t, sessionId: 's' });
  const ents = [ai('Leitura de tarefa'), L.user('x', 't'), ai('Controle de sessões pelo WhatsApp')];
  assert.equal(lib.tituloDe(ents, { name: 'projetos-42', nameSource: 'derived' }), 'Controle de sessões pelo WhatsApp');
  assert.equal(lib.tituloDe(ents, { name: 'Tito', nameSource: 'user' }), 'Tito');
  assert.equal(lib.tituloDe([...ents, L.titulo('Faro', 's')], { name: 'Tito', nameSource: 'user' }), 'Faro');
  assert.equal(lib.tituloDe([ai('')], { name: 'projetos-42', nameSource: 'derived' }), null);
});

// ---------------------------------------------------------------- cenario 5

test('5. Transcript inexistente -> 0 eventos; linhas corrompidas no meio -> usa as boas', () => {
  const amb = ambiente();
  try {
    const reg = registrar(amb, registro());
    const r1 = rodar(PAROU, amb, stop(reg.sessionId, path.join(amb.projetos, 'nao-existe.jsonl')));
    assert.equal(r1.status, 0);
    assert.equal(r1.stdout, '');
    assert.equal(eventos(amb).length, 0);

    const tp = transcript(amb, reg.sessionId, [
      L.titulo('Faro', reg.sessionId),
      '{"type":"assistant","message":{"role":"assis',
      'lixo que nao e json',
      L.assistente([L.texto('Resposta boa, tudo certo?')], '2026-09-27T18:05:19.799Z'),
      '{"type":"user", quebrado',
      '',
    ]);
    const r2 = rodar(PAROU, amb, stop(reg.sessionId, tp));
    assert.equal(r2.status, 0);
    assert.equal(r2.stdout, '');
    const evs = eventos(amb);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].final, 'Resposta boa, tudo certo?');
    assert.equal(evs[0].titulo, 'Faro');
    assert.deepEqual(evs[0].marcas, { decisao: false, fica: false, pergunta: true });
  } finally { limpar(amb); }
});

// ---------------------------------------------------------------- cenario 6

test('6z. F4i: AskUserQuestion no modo rua numa sessao do Claude Desktop: com canal = deny + evento; sem canal = calado', () => {
  const amb = ambiente();
  try {
    gravarEstado(amb, { ligado: true, motivo: 'dono', desde: new Date(Date.now() - 3600e3).toISOString(), atualizadoEm: new Date().toISOString() });
    const com = registrar(amb, registro({ entrypoint: 'claude-desktop', name: 'Aba D', nameSource: undefined, messagingSocketPath: '\\\\.\\pipe\\LOCAL\\cc-msg-cccc' }));
    const tpCom = transcript(amb, com.sessionId, [L.titulo('Aba D', com.sessionId), L.user('x', '2026-10-05T23:00:00.000Z')]);
    const r1 = rodar(PERGUNTA, amb, ask(com.sessionId, tpCom));
    assert.equal(r1.status, 0);
    assert.equal(JSON.parse(r1.stdout).hookSpecificOutput.permissionDecision, 'deny');
    const sem = registrar(amb, registro({ entrypoint: 'claude-desktop', name: 'Aba E', nameSource: undefined }));
    const tpSem = transcript(amb, sem.sessionId, [L.titulo('Aba E', sem.sessionId), L.user('x', '2026-10-05T23:00:00.000Z')]);
    const r2 = rodar(PERGUNTA, amb, ask(sem.sessionId, tpSem));
    assert.equal(r2.status, 0);
    assert.equal(r2.stdout, '');
    const evs = eventos(amb);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].tipo, 'pergunta-barrada');
    assert.equal(evs[0].sessionId, com.sessionId);
    assert.equal(evs[0].titulo, 'Aba D');
  } finally { limpar(amb); }
});

test('6. AskUserQuestion com modo rua ligado e fresco -> deny literal + evento "pergunta-barrada"', () => {
  const amb = ambiente();
  try {
    const reg = registrar(amb, registro({ name: 'projetos-42', nameSource: 'derived' }));
    const tp = transcript(amb, reg.sessionId, [L.titulo('Faro', reg.sessionId), L.user('x', '2026-09-27T18:00:00.000Z')]);
    gravarEstado(amb, { ligado: true, motivo: 'dono', desde: new Date(Date.now() - 3600e3).toISOString(), atualizadoEm: new Date().toISOString() });
    const r = rodar(PERGUNTA, amb, ask(reg.sessionId, tp));
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: DENY_TEXTO,
      },
    });
    const evs = eventos(amb);
    assert.equal(evs.length, 1);
    const ev = evs[0];
    assert.equal(ev.v, 1);
    assert.equal(ev.tipo, 'pergunta-barrada');
    assert.ok(!Number.isNaN(Date.parse(ev.at)));
    assert.equal(ev.sessionId, reg.sessionId);
    assert.equal(ev.pid, reg.pid);
    assert.equal(ev.nome, 'projetos-42');
    assert.equal(ev.titulo, 'Faro');
    assert.equal(ev.cwd, 'c:\\projetos');
    assert.deepEqual(ev.perguntas, [
      { pergunta: 'Qual caminho seguimos?', opcoes: ['A) Seguir agora', 'B) Esperar'] },
      { pergunta: 'Publica junto?', opcoes: ['Sim', 'Nao'] },
    ]);
  } finally { limpar(amb); }
});

// ---------------------------------------------------------------- cenario 7

test('7. Modo rua desligado, estado ausente ou velho (10 min) -> stdout vazio, 0 eventos', () => {
  const amb = ambiente();
  try {
    const reg = registrar(amb, registro());
    const tp = transcript(amb, reg.sessionId, [L.user('x', '2026-09-27T18:00:00.000Z')]);

    // estado.json ausente
    let r = rodar(PERGUNTA, amb, ask(reg.sessionId, tp));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');

    // desligado
    gravarEstado(amb, { ligado: false, motivo: 'dono', desde: new Date().toISOString(), atualizadoEm: new Date().toISOString() });
    r = rodar(PERGUNTA, amb, ask(reg.sessionId, tp));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');

    // ligado mas velho (porteiro morto)
    gravarEstado(amb, { ligado: true, motivo: 'ocioso', desde: new Date(Date.now() - 3600e3).toISOString(), atualizadoEm: new Date(Date.now() - 10 * 60e3).toISOString() });
    r = rodar(PERGUNTA, amb, ask(reg.sessionId, tp));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');

    assert.equal(eventos(amb).length, 0);
  } finally { limpar(amb); }
});

test('7b. Outra ferramenta ou sessao fora do VS Code -> calado, mesmo com modo rua ligado', () => {
  const amb = ambiente();
  try {
    const reg = registrar(amb, registro());
    const regCli = registrar(amb, registro({ entrypoint: 'sdk-cli' }));
    const tp = transcript(amb, reg.sessionId, [L.user('x', '2026-09-27T18:00:00.000Z')]);
    gravarEstado(amb, { ligado: true, motivo: 'dono', desde: new Date().toISOString(), atualizadoEm: new Date().toISOString() });
    let r = rodar(PERGUNTA, amb, ask(reg.sessionId, tp, { tool_name: 'Bash', tool_input: { command: 'ls' } }));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    r = rodar(PERGUNTA, amb, ask(regCli.sessionId, tp));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    r = rodar(PERGUNTA, amb, ask('sem-registro', tp));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(eventos(amb).length, 0);
  } finally { limpar(amb); }
});

test('7c. lerModoRua: fresco = atualizadoEm ha no maximo 5 min (futuro distante nao prende)', () => {
  const amb = ambiente();
  try {
    const agora = Date.parse('2026-09-27T19:00:00.000Z');
    assert.deepEqual(lib.lerModoRua(amb.estadoDir, agora), { ligado: false, fresco: false, efetivo: false });
    gravarEstado(amb, { ligado: true, atualizadoEm: '2026-09-27T18:56:00.000Z' });
    assert.deepEqual(lib.lerModoRua(amb.estadoDir, agora), { ligado: true, fresco: true, efetivo: true });
    gravarEstado(amb, { ligado: true, atualizadoEm: '2026-09-27T18:54:59.000Z' });
    assert.deepEqual(lib.lerModoRua(amb.estadoDir, agora), { ligado: true, fresco: false, efetivo: false });
    gravarEstado(amb, { ligado: false, atualizadoEm: '2026-09-27T18:59:00.000Z' });
    assert.deepEqual(lib.lerModoRua(amb.estadoDir, agora), { ligado: false, fresco: true, efetivo: false });
    gravarEstado(amb, { ligado: true, atualizadoEm: '2099-01-01T00:00:00.000Z' });
    assert.equal(lib.lerModoRua(amb.estadoDir, agora).efetivo, false);
    gravarEstado(amb, { ligado: true, atualizadoEm: 'isso nao e data' });
    assert.equal(lib.lerModoRua(amb.estadoDir, agora).efetivo, false);
    fs.writeFileSync(path.join(amb.estadoDir, 'estado.json'), '{corrompido');
    assert.deepEqual(lib.lerModoRua(amb.estadoDir, agora), { ligado: false, fresco: false, efetivo: false });
  } finally { limpar(amb); }
});

// ---------------------------------------------------------------- cenario 8

test('8. Registro ao lado de .key nao-JSON -> acha o certo; final > 6000 chars fica com os ultimos 6000', () => {
  const amb = ambiente();
  try {
    const reg = registrar(amb, registro({ pid: 123 }));
    fs.writeFileSync(path.join(amb.sessionsDir, '123.abc.key'), 'isto-nao-e-json \x00\x01 segredo');
    fs.writeFileSync(path.join(amb.sessionsDir, '555.json'), '{registro corrompido');
    const grande = 'INICIO-' + 'x'.repeat(7000) + ' fim da resposta. Fica com você: aprovar o deploy.';
    const tp = transcript(amb, reg.sessionId, [L.assistente([L.texto(grande)], '2026-09-27T18:05:19.799Z')]);
    const r = rodar(PAROU, amb, stop(reg.sessionId, tp));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
    const evs = eventos(amb);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].pid, 123);
    assert.equal(evs[0].final.length, 6000);
    assert.equal(evs[0].final, grande.slice(-6000));
    assert.equal(evs[0].marcas.fica, true);
  } finally { limpar(amb); }
});

test('8b. acharRegistro nunca abre arquivo .key (nem com JSON valido dentro)', () => {
  const amb = ambiente();
  try {
    const sid = 'sid-do-segredo';
    fs.writeFileSync(path.join(amb.sessionsDir, '999.abc.key'), JSON.stringify({ pid: 999, sessionId: sid, entrypoint: 'claude-vscode', name: 'VAZOU' }));
    fs.writeFileSync(path.join(amb.sessionsDir, '999.json.bak'), JSON.stringify({ pid: 999, sessionId: sid }));
    fs.writeFileSync(path.join(amb.sessionsDir, 'abc.json'), JSON.stringify({ pid: 1, sessionId: sid }));
    const lidos = [];
    const original = fs.readFileSync;
    fs.readFileSync = function (p, ...rest) { lidos.push(String(p)); return original.call(fs, p, ...rest); };
    let achado;
    try { achado = lib.acharRegistro(sid, amb.sessionsDir); } finally { fs.readFileSync = original; }
    assert.equal(achado, null);
    assert.deepEqual(lidos.filter((p) => !/[\\/]\d+\.json$/.test(p)), []);

    const reg = registrar(amb, registro({ pid: 999, sessionId: sid }));
    assert.deepEqual(lib.acharRegistro(sid, amb.sessionsDir), reg);
    assert.equal(lib.acharRegistro(sid, path.join(amb.raiz, 'pasta-que-nao-existe')), null);
    assert.equal(lib.acharRegistro('', amb.sessionsDir), null);
  } finally { limpar(amb); }
});

// ---------------------------------------------------------------- desempenho (cauda)

test('Transcript de ~20 MB -> sessao-parou termina em < 2 s (le so a cauda)', () => {
  const amb = ambiente();
  try {
    const reg = registrar(amb, registro());
    const f = path.join(amb.projetos, `${reg.sessionId}.jsonl`);
    const enchimento = 'y'.repeat(1000);
    const bloco = [];
    for (let i = 0; i < 1000; i++) {
      bloco.push(JSON.stringify(L.user(`pedido ${i} ${enchimento}`, '2026-09-27T17:00:00.000Z')));
      bloco.push(JSON.stringify(L.assistente([L.texto(`resposta ${i} ${enchimento}`)], '2026-09-27T17:00:01.000Z')));
    }
    const pedaco = bloco.join('\n') + '\n';
    const fd = fs.openSync(f, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(L.titulo('Titulo antigo la no comeco', reg.sessionId)) + '\n');
      while (fs.fstatSync(fd).size < 20 * 1024 * 1024) fs.writeSync(fd, pedaco);
      fs.writeSync(fd, JSON.stringify(L.titulo('Faro', reg.sessionId)) + '\n');
      fs.writeSync(fd, JSON.stringify(L.assistente([L.texto('Ultima resposta. Fica com voce: revisar?')], '2026-09-27T18:05:19.799Z')) + '\n');
    } finally { fs.closeSync(fd); }
    assert.ok(fs.statSync(f).size >= 20 * 1024 * 1024);

    // So a cauda (2 MB): o custom-title do comeco do arquivo nao entra na janela.
    const cauda = lib.lerCauda(f);
    assert.ok(cauda.length > 0 && cauda.length < 2200, `entradas na cauda: ${cauda.length}`);
    assert.equal(cauda.some((e) => e.customTitle === 'Titulo antigo la no comeco'), false);

    const t0 = Date.now();
    const r = rodar(PAROU, amb, stop(reg.sessionId, f));
    const ms = Date.now() - t0;
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.ok(ms < 2000, `demorou ${ms} ms`);
    const evs = eventos(amb);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].final, 'Ultima resposta. Fica com voce: revisar?');
    assert.equal(evs[0].titulo, 'Faro');
    assert.deepEqual(evs[0].marcas, { decisao: false, fica: true, pergunta: true });
  } finally { limpar(amb); }
});

// ---------------------------------------------------------------- erro interno nunca vaza

test('Erro interno: stdin invalido ou pasta de estado impossivel -> exit 0, stdout vazio, vai pro log', () => {
  const amb = ambiente();
  try {
    let r = rodar(PAROU, amb, 'isto nao e json');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    r = rodar(PERGUNTA, amb, '{quebrado');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');

    // SESSOES_WPP_DIR aponta pra um ARQUIVO: o append do evento falha por dentro.
    const reg = registrar(amb, registro());
    const tp = transcript(amb, reg.sessionId, [L.assistente([L.texto('oi')], '2026-09-27T18:05:19.799Z')]);
    const arquivoNoLugar = path.join(amb.raiz, 'estado-e-arquivo');
    fs.writeFileSync(arquivoNoLugar, 'x');
    r = rodar(PAROU, amb, stop(reg.sessionId, tp), { SESSOES_WPP_DIR: arquivoNoLugar });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
    const log = lerLog(amb);
    assert.match(log, /sessao-parou/);
    assert.match(log, /pergunta-modo-rua/);
  } finally { limpar(amb); }
});

test('Evento que nao grava nao impede o deny (o bloco DECISAO em texto ainda gera "parou")', () => {
  const amb = ambiente();
  try {
    const reg = registrar(amb, registro());
    const tp = transcript(amb, reg.sessionId, [L.user('x', '2026-09-27T18:00:00.000Z')]);
    gravarEstado(amb, { ligado: true, motivo: 'dono', desde: new Date().toISOString(), atualizadoEm: new Date().toISOString() });
    // eventos.jsonl vira PASTA: appendFileSync falha, a leitura do estado segue ok.
    fs.mkdirSync(path.join(amb.estadoDir, 'eventos.jsonl'));
    const r = rodar(PERGUNTA, amb, ask(reg.sessionId, tp));
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.match(lerLog(amb), /pergunta-modo-rua/);
  } finally { limpar(amb); }
});

// ---------------------------------------------------------------- lib pura

test('marcas: DECISAO em qualquer caixa, Fica com voce/você, pergunta na ultima linha nao vazia', () => {
  assert.deepEqual(lib.marcas('🔴 **DECISÃO:** x'), { decisao: true, fica: false, pergunta: false });
  assert.deepEqual(lib.marcas('a decisao e sua'), { decisao: true, fica: false, pergunta: false });
  assert.deepEqual(lib.marcas('Decisão tomada'), { decisao: true, fica: false, pergunta: false });
  // NFD (a + til combinante) conta como DECISÃO
  assert.equal(lib.marcas('DECISA\u0303O').decisao, true);
  assert.deepEqual(lib.marcas('Fica com você: logar'), { decisao: false, fica: true, pergunta: false });
  assert.deepEqual(lib.marcas('**Fica com voce:** logar'), { decisao: false, fica: true, pergunta: false });
  assert.deepEqual(lib.marcas('Tudo certo?\n\n  \n'), { decisao: false, fica: false, pergunta: true });
  assert.deepEqual(lib.marcas('Tudo certo?\nfeito.'), { decisao: false, fica: false, pergunta: false });
  assert.deepEqual(lib.marcas('Pergunta?   '), { decisao: false, fica: false, pergunta: true });
  assert.deepEqual(lib.marcas(''), { decisao: false, fica: false, pergunta: false });
  assert.deepEqual(lib.marcas(null), { decisao: false, fica: false, pergunta: false });
});

test('ultimaResposta: ultima entrada assistant com bloco text, textos juntados com \\n', () => {
  const ents = [
    L.assistente([L.texto('velha')], 't1'),
    L.assistente([L.texto('parte 1'), L.ferramenta(), L.texto('parte 2')], 't2'),
    L.assistente([L.ferramenta()], 't3'),
    L.user('ok', 't4'),
  ];
  assert.deepEqual(lib.ultimaResposta(ents), { texto: 'parte 1\nparte 2', ts: 't2' });
  assert.equal(lib.ultimaResposta([L.user('x', 't')]), null);
  assert.equal(lib.ultimaResposta([]), null);
});

test('lerCauda: descarta a 1a linha cortada no meio e pula linha ruim; linha inteira na borda fica', () => {
  const amb = ambiente();
  try {
    const f = path.join(amb.raiz, 't.jsonl');
    const l1 = JSON.stringify({ n: 1, pad: 'a'.repeat(50) });
    const l2 = JSON.stringify({ n: 2 });
    const l3 = JSON.stringify({ n: 3 });
    fs.writeFileSync(f, `${l1}\n${l2}\nruim\n${l3}\n`);
    const total = fs.statSync(f).size;
    // corta no meio da linha 1
    assert.deepEqual(lib.lerCauda(f, total - 10).map((o) => o.n), [2, 3]);
    // corta exatamente no inicio da linha 2 (linha inteira na borda nao se perde)
    const inicioL2 = Buffer.byteLength(l1) + 1;
    assert.deepEqual(lib.lerCauda(f, total - inicioL2).map((o) => o.n), [2, 3]);
    // arquivo inteiro
    assert.deepEqual(lib.lerCauda(f).map((o) => o.n), [1, 2, 3]);
    // CRLF
    const g = path.join(amb.raiz, 'crlf.jsonl');
    fs.writeFileSync(g, `${l2}\r\n${l3}\r\n`);
    assert.deepEqual(lib.lerCauda(g).map((o) => o.n), [2, 3]);
    // inexistente
    assert.deepEqual(lib.lerCauda(path.join(amb.raiz, 'nada.jsonl')), []);
  } finally { limpar(amb); }
});

test('caminhos: env manda; sem env cai em ~/.claude', () => {
  const c = lib.caminhos({ SESSOES_WPP_DIR: 'A', CLAUDE_SESSIONS_DIR: 'B', SESSOES_WPP_LOG: 'C' });
  assert.deepEqual(c, { estadoDir: 'A', sessionsDir: 'B', logFile: 'C' });
  const d = lib.caminhos({});
  const base = path.join(os.homedir(), '.claude');
  assert.deepEqual(d, {
    estadoDir: path.join(base, 'sessoes-wpp'),
    sessionsDir: path.join(base, 'sessions'),
    logFile: path.join(base, 'logs', 'sessoes-wpp.log'),
  });
});

test('anexarEvento cria a pasta e grava 1 linha JSON por evento; log nunca lanca', () => {
  const amb = ambiente();
  try {
    lib.anexarEvento(amb.estadoDir, { v: 1, tipo: 'parou', n: 1 });
    lib.anexarEvento(amb.estadoDir, { v: 1, tipo: 'parou', n: 2 });
    assert.deepEqual(eventos(amb).map((e) => e.n), [1, 2]);
    lib.log(amb.logFile, 'linha de teste');
    assert.match(lerLog(amb), /linha de teste/);
    const arquivo = path.join(amb.raiz, 'arquivo');
    fs.writeFileSync(arquivo, 'x');
    assert.doesNotThrow(() => lib.log(path.join(arquivo, 'dentro', 'x.log'), 'nao grava'));
  } finally { limpar(amb); }
});

// ---------------------------------------------------------------- F4f: sessao escondida (SESSOES_WPP_ESCONDIDA=1)

const DENY_ESCONDIDA = 'Esta sessão roda escondida no PC (aberta pelo celular): ninguém vê os botões. Escreva a pergunta em texto, no bloco 🔴 **DECISÃO:** com as opções A/B, e encerre a vez.';

test('F4f. sessao escondida (SESSOES_WPP_ESCONDIDA=1) + registro interativo -> deny com o motivo proprio e evento, mesmo sem modo rua; sem a variavel ou com "0" = hoje (libera)', () => {
  const amb = ambiente();
  try {
    const reg = registrar(amb, registro({ entrypoint: 'cli', name: 'Edição de Vídeos', nameSource: 'user' }));
    const tp = transcript(amb, reg.sessionId, [L.user('x', '2026-09-30T23:00:00.000Z')]);
    // sem estado.json (modo rua ausente) e com a variavel: nega
    let r = rodar(PERGUNTA, amb, ask(reg.sessionId, tp), { SESSOES_WPP_ESCONDIDA: '1' });
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: DENY_ESCONDIDA },
    });
    let evs = eventos(amb);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].tipo, 'pergunta-barrada');
    assert.equal(evs[0].sessionId, reg.sessionId);
    assert.equal(evs[0].nome, 'Edição de Vídeos');
    // modo rua desligado e fresco + a variavel: nega igual
    gravarEstado(amb, { ligado: false, motivo: null, desde: new Date().toISOString(), atualizadoEm: new Date().toISOString() });
    r = rodar(PERGUNTA, amb, ask(reg.sessionId, tp), { SESSOES_WPP_ESCONDIDA: '1' });
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, DENY_ESCONDIDA);
    assert.equal(eventos(amb).length, 2);
    // sem a variavel e modo rua desligado: libera (como hoje)
    r = rodar(PERGUNTA, amb, ask(reg.sessionId, tp), { SESSOES_WPP_ESCONDIDA: '' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    r = rodar(PERGUNTA, amb, ask(reg.sessionId, tp), { SESSOES_WPP_ESCONDIDA: '0' });
    assert.equal(r.stdout, '');
    assert.equal(eventos(amb).length, 2, 'liberado nao grava evento');
    // com a variavel, mas outra ferramenta: libera
    r = rodar(PERGUNTA, amb, ask(reg.sessionId, tp, { tool_name: 'Bash' }), { SESSOES_WPP_ESCONDIDA: '1' });
    assert.equal(r.stdout, '');
    // com a variavel, mas sessao sem registro: libera (sai calado, como hoje)
    r = rodar(PERGUNTA, amb, ask('sem-registro', tp), { SESSOES_WPP_ESCONDIDA: '1' });
    assert.equal(r.stdout, '');
  } finally { limpar(amb); }
});

// ---------------------------------------------------------------- F4f b: resposta que chega no disco depois do Stop

// Medido 01/10/2026 00:45 (CLI 2.1.286, 1a vez de uma sessao escondida aberta pelo abrir-sessao.vbs): no Stop, a resposta
// final ainda nao estava no transcript (as 25 primeiras entradas, sem nenhum texto do assistente); ~20 ms depois, estava.
// Sem esperar, o hook nao gravava evento nenhum e a resposta da sessao nova nunca voltava pro grupo.
function rodarAsync(hook, amb, payload, extraEnv) {
  return new Promise((resolve) => {
    const filho = spawn(process.execPath, [hook], { env: envDe(amb, extraEnv), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    filho.stdout.on('data', (d) => { stdout += d; });
    filho.stderr.on('data', (d) => { stderr += d; });
    filho.on('close', (status) => resolve({ status, stdout, stderr }));
    filho.stdin.end(JSON.stringify(payload));
  });
}
const linhaJson = (o) => `${JSON.stringify(o)}\n`;

test('F4f b. respostaFresca: a resposta da vez ja esta no transcript (texto do assistente depois do ultimo usuario, sem tool_use pendente)', () => {
  const u = L.user('p', 't');
  const a = L.assistente([L.texto('r')], 't');
  const pensando = L.assistente([{ type: 'thinking', thinking: 'hmm' }], 't');
  const soFerramenta = L.assistente([L.ferramenta()], 't');
  const textoEFerramenta = L.assistente([L.texto('Vou rodar.'), L.ferramenta()], 't');
  const resultado = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } };
  const resto = [{ type: 'attachment' }, { type: 'last-prompt' }, L.titulo('X', 's'), { type: 'system', subtype: 'stop_hook_summary' }];
  assert.equal(lib.respostaFresca([]), true, 'nada no arquivo = nada a esperar');
  assert.equal(lib.respostaFresca([a]), true);
  assert.equal(lib.respostaFresca([u, a, ...resto]), true);
  assert.equal(lib.respostaFresca([u, pensando, a]), true);
  assert.equal(lib.respostaFresca([u, a, pensando]), true, 'so pensamento depois do texto nao muda');
  assert.equal(lib.respostaFresca([u]), false, 'pedido sem resposta');
  assert.equal(lib.respostaFresca([u, ...resto]), false);
  assert.equal(lib.respostaFresca([u, a, u]), false, 'pedido novo depois da resposta velha');
  assert.equal(lib.respostaFresca([u, a, soFerramenta]), false, 'a vez nunca termina num tool_use');
  assert.equal(lib.respostaFresca([u, textoEFerramenta]), false);
  assert.equal(lib.respostaFresca([u, soFerramenta, resultado]), false);
  assert.equal(lib.respostaFresca([u, soFerramenta, resultado, a, ...resto]), true);
  assert.equal(lib.respostaFresca(null), true);
});

// T16 (PLANO-TELEGRAM.md, "T16"; pedido do dono): a situacao da aba trabalhando so com o que e desta vez.
test('T16. vezAtual: a vez comeca no usuario com conteudo logo depois do assistente (ou sem nada antes); o texto e o passo descrito mais novos dela', () => {
  const velha = L.assistente([L.texto('Terminei.\n\n🔴 **DECISÃO:** Publico? A) Sim / B) Não')], 'tv');
  const pedido = L.user('faz o X', 'tp');
  const passo = (description, ts, name = 'Bash') => L.assistente([{ type: 'tool_use', id: 'toolu_9', name, input: { command: 'npm test', description } }], ts);
  const semDescricao = (ts) => L.assistente([{ type: 'tool_use', id: 'toolu_8', name: 'Read', input: { file_path: 'a.js' } }], ts);
  const resultado = (ts) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'ok' }] }, timestamp: ts });
  const meta = (texto, ts, origin) => ({ type: 'user', isMeta: true, ...(origin ? { origin } : {}), timestamp: ts, message: { role: 'user', content: [{ type: 'text', text: texto }] } });
  const peer = (ts) => meta('Another Claude session sent a message (from repos-99):\n<cross-session-message>a) Sim</cross-session-message>', ts, { kind: 'peer', from: 'repos-99' });
  const pensando = (ts) => L.assistente([{ type: 'thinking', thinking: 'hmm' }], ts);
  const resto = [{ type: 'attachment' }, { type: 'last-prompt' }, L.titulo('X', 's'), { type: 'system', subtype: 'stop_hook_summary' }];
  const vez = (inicioTs, texto, textoTs, passo, passoTs) => ({ inicioTs, texto, textoTs, passo, passoTs });
  const NADA = vez(null, null, null, null, null);

  // a decisao velha antes do pedido nao conta; so passos na vez = sem texto e o passo descrito mais novo (o Read nao tem)
  assert.deepEqual(lib.vezAtual([velha, pedido, pensando('t0'), passo('Rodar a bateria', 't1'), resultado('t2'), semDescricao('t3'), resultado('t4'), ...resto]),
    vez('tp', null, null, 'Rodar a bateria', 't1'));
  // o texto da vez e o passo depois dele; o passo de antes do texto nao entra
  assert.deepEqual(lib.vezAtual([velha, pedido, passo('Ler', 't1'), resultado('t2'), L.assistente([L.texto('Achei a causa.')], 't3'), passo('Corrigir e testar', 't4'), resultado('t5')]),
    vez('tp', 'Achei a causa.', 't3', 'Corrigir e testar', 't4'));
  assert.deepEqual(lib.vezAtual([pedido, passo('Ler', 't1'), resultado('t2'), L.assistente([L.texto('parte 1'), L.texto('parte 2')], 't3')]),
    vez('tp', 'parte 1\nparte 2', 't3', null, null));
  // 2 passos descritos na vez: o mais novo
  assert.deepEqual(lib.vezAtual([pedido, passo('Primeiro passo', 't1'), resultado('t2'), passo('Segundo passo', 't3'), resultado('t4')]),
    vez('tp', null, null, 'Segundo passo', 't3'));
  // 2 textos na vez: o mais novo (e o passo so depois dele)
  assert.deepEqual(lib.vezAtual([pedido, L.assistente([L.texto('Primeiro.')], 't1'), passo('Meio', 't2'), resultado('t3'), L.assistente([L.texto('Segundo.')], 't4')]),
    vez('tp', 'Segundo.', 't4', null, null));
  // resultado de ferramenta com texto junto (aviso de trava na mesma entrada) nao comeca a vez
  const resultadoComTexto = { type: 'user', timestamp: 'tr', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'ok' }, { type: 'text', text: 'aviso da trava' }] } };
  assert.deepEqual(lib.vezAtual([velha, pedido, passo('Rodar', 't1'), resultadoComTexto]), vez('tp', null, null, 'Rodar', 't1'));
  assert.deepEqual(lib.vezAtual([pedido, { type: 'assistant', message: { role: 'assistant', content: 'texto puro' }, timestamp: 't1' }]),
    vez('tp', 'texto puro', 't1', null, null));
  // o recado (peer) depois da resposta comeca a vez; o que chega no meio dela (depois do resultado) nao
  assert.deepEqual(lib.vezAtual([pedido, velha, peer('tq'), passo('Publicar', 't1'), resultado('t2')]), vez('tq', null, null, 'Publicar', 't1'));
  assert.deepEqual(lib.vezAtual([pedido, L.assistente([L.texto('Vou rodar.')], 't1'), passo('Rodar', 't2'), resultado('t3'), peer('tq')]),
    vez('tp', 'Vou rodar.', 't1', 'Rodar', 't2'));
  // o recado que chega com a aba trabalhando entra como anexo (queued_command) e nao abre vez nova (visto 09/10 23:56 na aula)
  const anexo = (ts) => ({ type: 'attachment', timestamp: ts, attachment: { type: 'queued_command', prompt: 'a) Sim', origin: { kind: 'peer' }, isMeta: true } });
  assert.deepEqual(lib.vezAtual([velha, pedido, passo('Rodar', 't1'), anexo('tq'), resultado('t2'), L.assistente([L.texto('Visto.')], 't3')]),
    vez('tp', 'Visto.', 't3', null, null));
  // o texto da skill depois do resultado e o [Image ...] depois do pedido com imagem sao da mesma vez
  assert.deepEqual(lib.vezAtual([velha, pedido, L.assistente([L.texto('Carregando.')], 't1'), passo('skill', 't2', 'Skill'), resultado('t3'), meta('Base directory for this skill: X', 't4')]),
    vez('tp', 'Carregando.', 't1', 'skill', 't2'));
  const comImagem = { type: 'user', timestamp: 'ti', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'x' } }, { type: 'text', text: 'olha' }] } };
  assert.deepEqual(lib.vezAtual([velha, comImagem, meta('[Image: source: C:\\x.png]', 'tm'), passo('Ver', 't1')]), vez('ti', null, null, 'Ver', 't1'));
  // so imagem (sem texto) tambem comeca; o pedido agendado (meta sem origem) e o aviso de tarefa depois da resposta tambem
  const soImagem = { type: 'user', timestamp: 'ts', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'x' } }] } };
  assert.equal(lib.vezAtual([velha, soImagem]).inicioTs, 'ts');
  assert.equal(lib.vezAtual([velha, meta('[Vigia da madrugada] confere o notebook', 'tg')]).inicioTs, 'tg');
  assert.equal(lib.vezAtual([velha, L.user('<task-notification>feito</task-notification>', 'tn')]).inicioTs, 'tn');
  // sem comeco na parte lida = tudo e desta vez (o resultado logo depois do assistente nao comeca nada)
  assert.deepEqual(lib.vezAtual([passo('A', 't1'), resultado('t2'), L.assistente([L.texto('Meio do caminho.')], 't3'), passo('B', 't4'), resultado('t5'), ...resto]),
    vez(null, 'Meio do caminho.', 't3', 'B', 't4'));
  // a 1a entrada da parte lida e do usuario = comeco
  assert.deepEqual(lib.vezAtual([L.user('x', 't0'), L.assistente([L.texto('r')], 't1')]), vez('t0', 'r', 't1', null, null));
  // descricao vazia ou que nao e texto nao conta; texto em branco nao conta
  assert.deepEqual(lib.vezAtual([pedido, passo('Rodar', 't1'), resultado('t2'), passo('   ', 't3'), resultado('t4'), passo(7, 't5'), L.assistente([L.texto('  ')], 't6')]),
    vez('tp', null, null, 'Rodar', 't1'));
  // pedido sem nada depois; vazio e torto
  assert.deepEqual(lib.vezAtual([velha, pedido]), vez('tp', null, null, null, null));
  for (const torto of [[], null, undefined, 'x', [null, 5, 'x', { type: 'user' }, { type: 'assistant' }]]) {
    assert.deepEqual(lib.vezAtual(torto), NADA, JSON.stringify(torto));
  }
});

test('F4f b. Stop antes da resposta chegar no disco: o hook espera e grava a resposta NOVA (1a vez e vez seguinte); ja no disco = sem espera', async () => {
  const amb = ambiente();
  try {
    const reg = registrar(amb, registro({ entrypoint: 'cli', name: 'Edição de Vídeos', nameSource: 'user' }));
    // 1a vez: so o recado no arquivo; a resposta chega 300 ms depois do hook comecar
    const tp = transcript(amb, reg.sessionId, [L.user('recado do porteiro', '2026-10-01T03:45:13.966Z'), { type: 'attachment' }]);
    let t0 = Date.now();
    let p = rodarAsync(PAROU, amb, stop(reg.sessionId, tp));
    setTimeout(() => fs.appendFileSync(tp, linhaJson(L.assistente([L.texto('OK')], '2026-10-01T03:45:18.097Z'))), 300);
    let r = await p;
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    let evs = eventos(amb);
    assert.equal(evs.length, 1, 'a 1a vez gera o evento');
    assert.equal(evs[0].final, 'OK');
    assert.equal(evs[0].finalTs, '2026-10-01T03:45:18.097Z');
    assert.ok(Date.now() - t0 < 2500, `nao espera o prazo inteiro (${Date.now() - t0} ms)`);

    // vez seguinte: a resposta velha e o recado novo no arquivo; a nova chega 300 ms depois
    fs.appendFileSync(tp, linhaJson(L.user('recado 2', '2026-10-01T03:50:00.000Z')));
    t0 = Date.now();
    p = rodarAsync(PAROU, amb, stop(reg.sessionId, tp));
    setTimeout(() => fs.appendFileSync(tp, linhaJson(L.assistente([L.texto('OK2')], '2026-10-01T03:50:04.000Z'))), 300);
    r = await p;
    assert.equal(r.status, 0);
    evs = eventos(amb);
    assert.equal(evs.length, 2);
    assert.equal(evs[1].final, 'OK2', 'nunca a resposta velha');
    assert.equal(evs[1].finalTs, '2026-10-01T03:50:04.000Z');

    // ja no disco: sem espera
    t0 = Date.now();
    r = await rodarAsync(PAROU, amb, stop(reg.sessionId, tp));
    assert.equal(r.status, 0);
    assert.ok(Date.now() - t0 < 1500, `sem espera (${Date.now() - t0} ms)`);
    assert.equal(eventos(amb).length, 3);
  } finally { limpar(amb); }
});

test('F4f b. a resposta nova nunca chega: o hook desiste em ~3 s e segue como antes (resposta velha, ou nada se nao ha nenhuma)', async () => {
  const amb = ambiente();
  try {
    const reg = registrar(amb, registro({ entrypoint: 'cli' }));
    const tp = transcript(amb, reg.sessionId, [
      L.user('recado 1', '2026-10-01T03:40:00.000Z'),
      L.assistente([L.texto('resposta velha')], '2026-10-01T03:40:05.000Z'),
      L.user('recado 2', '2026-10-01T03:42:00.000Z'),
    ]);
    let t0 = Date.now();
    let r = await rodarAsync(PAROU, amb, stop(reg.sessionId, tp));
    let ms = Date.now() - t0;
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.ok(ms >= 2500 && ms < 6000, `desistiu em ${ms} ms`);
    const evs = eventos(amb);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].final, 'resposta velha');
    assert.equal(evs[0].finalTs, '2026-10-01T03:40:05.000Z', 'o porteiro deduplica pelo finalTs repetido');

    const reg2 = registrar(amb, registro({ entrypoint: 'cli' }));
    const tp2 = transcript(amb, reg2.sessionId, [L.user('so o recado', '2026-10-01T03:44:00.000Z')]);
    t0 = Date.now();
    r = await rodarAsync(PAROU, amb, stop(reg2.sessionId, tp2));
    ms = Date.now() - t0;
    assert.equal(r.status, 0);
    assert.ok(ms < 6000, `desistiu em ${ms} ms`);
    assert.equal(eventos(amb).length, 1, 'sem resposta nenhuma = nenhum evento');
  } finally { limpar(amb); }
});

// ---------------------------------------------------------------- F4f c: o texto final vem do proprio Stop

// Medido 06/10/2026 06:06 (CLI 2.1.290, a central no terminal escondido, PC carregado): a resposta foi gravada no
// transcript ~4 s depois do Stop; o hook esperou os 3 s, gravou a resposta da vez ANTERIOR (21:41 da vespera) e o porteiro
// descartou o evento como repetido: a resposta nunca chegou no Telegram. A doc oficial (code.claude.com/docs/en/hooks):
// o transcript e gravado de forma assincrona e pode atrasar; quem precisa do texto final usa `last_assistant_message`
// do Stop. Contrato: com o campo (texto nao vazio), final = ele (sem esperar o arquivo); finalTs = o da ultima resposta do
// transcript quando ela e a mesma (espacos nao contam; o campo pode trazer mais blocos antes); senao, a hora do evento.
// `fonteFinal`: 'stop' (veio do campo) | 'transcript' (sem o campo, como antes).

test('F4f c. Stop com last_assistant_message e o transcript atrasado (so a resposta velha): final = o do Stop, sem esperar, finalTs novo, log de 1 linha', async () => {
  const amb = ambiente();
  try {
    const reg = registrar(amb, registro({ entrypoint: 'cli', name: 'Controle', nameSource: 'user' }));
    const tp = transcript(amb, reg.sessionId, [
      L.user('recado de ontem', '2026-10-06T00:41:00.000Z'),
      L.assistente([L.texto('resposta de ontem')], '2026-10-06T00:41:59.246Z'),
      L.user('recado de hoje', '2026-10-06T09:05:48.000Z'),
      L.assistente([L.ferramenta()], '2026-10-06T09:06:14.000Z'),
    ]);
    const t0 = Date.now();
    const antes = new Date().toISOString();
    const r = await rodarAsync(PAROU, amb, stop(reg.sessionId, tp, { last_assistant_message: TEXTO_DECISAO }));
    const ms = Date.now() - t0;
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.ok(ms < 2000, `sem esperar o arquivo (${ms} ms)`);
    const evs = eventos(amb);
    assert.equal(evs.length, 1);
    const ev = evs[0];
    assert.equal(ev.final, TEXTO_DECISAO);
    assert.notEqual(ev.finalTs, '2026-10-06T00:41:59.246Z', 'nunca o finalTs da resposta velha');
    assert.ok(ev.finalTs >= antes && ev.finalTs <= ev.at, `finalTs = a hora do evento (${ev.finalTs})`);
    assert.deepEqual(ev.marcas, { decisao: true, fica: false, pergunta: false });
    assert.equal(ev.fonteFinal, 'stop');
    assert.equal(ev.titulo, 'Controle');
    const log = lerLog(amb);
    assert.match(log, /sessao-parou: transcript atrasado/);
    assert.ok(!log.includes('Publico a pagina'), 'o log nao leva o texto');

    // a resposta de hoje com o MESMO texto da de ontem, o arquivo ainda sem ela: finalTs novo (senao o porteiro descarta)
    const reg2 = registrar(amb, registro({ entrypoint: 'cli' }));
    const tp2 = transcript(amb, reg2.sessionId, [
      L.user('recado de ontem', '2026-10-06T00:41:00.000Z'),
      L.assistente([L.texto('Feito.')], '2026-10-06T00:41:59.246Z'),
      L.user('recado de hoje', '2026-10-06T09:05:48.000Z'),
    ]);
    await rodarAsync(PAROU, amb, stop(reg2.sessionId, tp2, { last_assistant_message: 'Feito.' }));
    const ev2 = eventos(amb).at(-1);
    assert.equal(ev2.sessionId, reg2.sessionId);
    assert.equal(ev2.final, 'Feito.');
    assert.notEqual(ev2.finalTs, '2026-10-06T00:41:59.246Z', 'mesmo texto da vez anterior: nunca o finalTs dela');

    // o arquivo parou num texto do MEIO da vez (o caso das 21:42 de 05/10: "Owner is clear..." saiu como final): o final
    // e o do Stop e o finalTs nunca e o do texto do meio
    const reg3 = registrar(amb, registro({ entrypoint: 'cli' }));
    const tp3 = transcript(amb, reg3.sessionId, [
      L.user('recado', '2026-10-06T00:41:00.000Z'),
      L.assistente([L.texto('Vou conferir o estado antes.')], '2026-10-06T00:41:55.916Z'),
    ]);
    await rodarAsync(PAROU, amb, stop(reg3.sessionId, tp3, { last_assistant_message: 'Deixei das 9h às 19h.' }));
    const ev3 = eventos(amb).at(-1);
    assert.equal(ev3.sessionId, reg3.sessionId);
    assert.equal(ev3.final, 'Deixei das 9h às 19h.');
    assert.notEqual(ev3.finalTs, '2026-10-06T00:41:55.916Z', 'nunca o finalTs do texto do meio');
  } finally { limpar(amb); }
});

test('F4f c. Stop com last_assistant_message igual a ultima resposta do transcript: final = o do Stop, finalTs = o do transcript (o porteiro deduplica como antes), sem log', async () => {
  const amb = ambiente();
  try {
    const reg = registrar(amb, registro({}));
    const tp = transcript(amb, reg.sessionId, [
      L.user('faz', '2026-10-06T09:00:00.000Z'),
      L.assistente([{ type: 'thinking', thinking: 'hmm' }, L.texto(TEXTO_DECISAO)], '2026-10-06T09:01:00.000Z'),
      { type: 'system', subtype: 'stop_hook_summary', timestamp: '2026-10-06T09:01:01.000Z' },
    ]);
    // igual com espacos diferentes, e com um bloco a mais antes (o campo traz a mensagem toda)
    for (const campo of [TEXTO_DECISAO, `  ${TEXTO_DECISAO.replace(/\n/g, '\n\n')}\n`, `Primeiro bloco.\n\n${TEXTO_DECISAO}`]) {
      const r = await rodarAsync(PAROU, amb, stop(reg.sessionId, tp, { last_assistant_message: campo }));
      assert.equal(r.status, 0);
      const ev = eventos(amb).at(-1);
      assert.equal(ev.final, campo.trim(), 'o texto do Stop');
      assert.equal(ev.finalTs, '2026-10-06T09:01:00.000Z', JSON.stringify(campo.slice(0, 30)));
      assert.equal(ev.fonteFinal, 'stop');
    }
    assert.equal(eventos(amb).length, 3);
    assert.doesNotMatch(lerLog(amb), /transcript atrasado/);
  } finally { limpar(amb); }
});

test('F4f c. 1a vez da sessao (transcript sem resposta nenhuma) com last_assistant_message = 1 evento (antes: nenhum)', async () => {
  const amb = ambiente();
  try {
    const reg = registrar(amb, registro({ entrypoint: 'cli' }));
    const tp = transcript(amb, reg.sessionId, [L.user('so o recado', '2026-10-06T09:10:00.000Z')]);
    const t0 = Date.now();
    const r = await rodarAsync(PAROU, amb, stop(reg.sessionId, tp, { last_assistant_message: 'Feito, abri a aba.' }));
    assert.equal(r.status, 0);
    assert.ok(Date.now() - t0 < 2000, `sem esperar (${Date.now() - t0} ms)`);
    const evs = eventos(amb);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].final, 'Feito, abri a aba.');
    assert.equal(evs[0].fonteFinal, 'stop');
  } finally { limpar(amb); }
});

test('F4f c. last_assistant_message vazio, so espacos ou que nao e texto = como antes (o transcript, com a espera); fonteFinal "transcript"', async () => {
  const amb = ambiente();
  try {
    const reg = registrar(amb, registro({}));
    const tp = transcript(amb, reg.sessionId, [
      L.user('faz', '2026-10-06T09:00:00.000Z'),
      L.assistente([L.texto('Pronto.')], '2026-10-06T09:01:00.000Z'),
    ]);
    for (const campo of [undefined, '', '   \n', null, 42, { texto: 'x' }]) {
      const extra = campo === undefined ? {} : { last_assistant_message: campo };
      const r = await rodarAsync(PAROU, amb, stop(reg.sessionId, tp, extra));
      assert.equal(r.status, 0);
      const ev = eventos(amb).at(-1);
      assert.equal(ev.final, 'Pronto.', JSON.stringify(campo));
      assert.equal(ev.finalTs, '2026-10-06T09:01:00.000Z');
      assert.equal(ev.fonteFinal, 'transcript');
    }
    // texto do Stop maior que 6000 chars: os ultimos 6000, marcas do texto inteiro
    const longo = `${'x'.repeat(7000)}\n\nPosso seguir?`;
    await rodarAsync(PAROU, amb, stop(reg.sessionId, tp, { last_assistant_message: longo }));
    const ev = eventos(amb).at(-1);
    assert.equal(ev.final.length, 6000);
    assert.ok(longo.endsWith(ev.final));
    assert.equal(ev.marcas.pergunta, true);
  } finally { limpar(amb); }
});

test('T31. ultimoEntrypoint: o entrypoint da ULTIMA linha que tem o campo (a conversa que nasceu no Desktop e segue no VS Code = claude-vscode); linha sem o campo, vazio ou que nao e texto pula; nenhuma = null; entrada que nao e lista = null', () => {
  assert.equal(lib.ultimoEntrypoint([{ entrypoint: 'claude-desktop' }, { type: 'x' }, { entrypoint: 'claude-vscode' }, { type: 'ai-title' }]), 'claude-vscode');
  assert.equal(lib.ultimoEntrypoint([{ entrypoint: 'claude-vscode' }, { entrypoint: 'claude-desktop' }]), 'claude-desktop');
  assert.equal(lib.ultimoEntrypoint([{ entrypoint: 'cli' }, { entrypoint: '' }, { entrypoint: 7 }, null, 'texto']), 'cli');
  assert.equal(lib.ultimoEntrypoint([{ type: 'custom-title' }]), null);
  assert.equal(lib.ultimoEntrypoint([]), null);
  for (const x of [null, undefined, 'cli', { entrypoint: 'cli' }]) assert.equal(lib.ultimoEntrypoint(x), null);
});
