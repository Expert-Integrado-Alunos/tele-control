#!/usr/bin/env node
'use strict';
/*
 * Teste do hooks/porteiro-supervisor.js (SessionStart que religa o porteiro morto do sessoes-wpp).
 *
 * Por que existe: o hook roda em TODA abertura de sessao do Claude Code na frota. Erro que vaza no stdout vira texto no
 * contexto da sessao; religar quando nao devia sobe porteiro em maquina sem o recurso ou contra a vontade do dono; nao
 * religar deixa o grupo mudo. Os cenarios abaixo sao o criterio de aceite do item 12 da rodada 2 do GPT-6.
 *
 * Isolamento: pasta temporaria por teste (SESSOES_WPP_DIR, SESSOES_WPP_LOG) e um .vbs de teste
 * (SESSOES_WPP_PORTEIRO_VBS) que so grava um arquivo-marca: o wscript roda de verdade, o porteiro real nunca.
 *
 * Rodar: node --test hooks/tests/porteiro-supervisor.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pastaTemp } = require('../../tests/lib/pasta-temp.cjs');

const HOOK = path.join(__dirname, '..', 'porteiro-supervisor.js');
// Mac-testes (A): os testes que esperam o .vbs rodar (wscript) so fazem sentido no Windows; fora dele o hook vai pelo
// launchd (os testes M4a darwin do fim do arquivo, com dubles)
const SO_WINDOWS = process.platform !== 'win32' && 'so no Windows (o hook religa pelo wscript e o .vbs)';
const VBS_TESTE = [
  'Set sh = CreateObject("Wscript.Shell")',
  'm = sh.ExpandEnvironmentStrings("%SUP_TESTE_MARCA%")',
  'Set fso = CreateObject("Scripting.FileSystemObject")',
  'Set f = fso.CreateTextFile(m, True)',
  'f.WriteLine "rodou"',
  'f.Close',
  '',
].join('\r\n');

function pasta({ config = true, vbs = true } = {}) {
  const d = pastaTemp('porteiro-sup-');
  const estado = path.join(d, 'estado');
  fs.mkdirSync(estado);
  if (config) fs.writeFileSync(path.join(estado, 'config.json'), '{}');
  if (vbs) fs.writeFileSync(path.join(d, 'teste.vbs'), VBS_TESTE);
  return {
    d, estado,
    log: path.join(d, 'sessoes-wpp.log'),
    marca: path.join(d, 'marca.txt'),
    vbs: path.join(d, 'teste.vbs'),
  };
}

function rodar(p) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'teste' }),
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      // Mac-testes: HOME temporario = no Mac o hook nunca acha o plist de verdade (nada de launchctl kickstart no
      // porteiro do dono enquanto a bateria roda)
      HOME: p.d,
      SESSOES_WPP_DIR: p.estado,
      SESSOES_WPP_LOG: p.log,
      SESSOES_WPP_PORTEIRO_VBS: p.vbs,
      SUP_TESTE_MARCA: p.marca,
    },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function esperarMarca(arq, ms) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (fs.existsSync(arq)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return fs.existsSync(arq);
}

const lerLog = (p) => { try { return fs.readFileSync(p.log, 'utf8'); } catch (_) { return ''; } };
const tentou = (p) => fs.existsSync(path.join(p.estado, 'supervisor.json'));

function pidMorto() {
  const r = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  return r.pid;
}

function semLancar(p, r) {
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', 'SessionStart nao pode escrever no stdout (vira contexto da sessao)');
  assert.equal(tentou(p), false, 'nao devia marcar tentativa');
  assert.doesNotMatch(lerLog(p), /religando/);
  assert.equal(esperarMarca(p.marca, 800), false, 'o .vbs nao devia ter rodado');
}

test('sem trava: religa pelo .vbs, marca a tentativa, loga e fica mudo no stdout', { skip: SO_WINDOWS }, () => {
  const p = pasta();
  const r = rodar(p);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(esperarMarca(p.marca, 8000), true, 'o .vbs devia ter rodado');
  assert.equal(tentou(p), true);
  assert.match(lerLog(p), /supervisor: porteiro sem trava; religando/);
});

test('trava com pid morto: religa e o log cita o pid', { skip: SO_WINDOWS }, () => {
  const p = pasta();
  const morto = pidMorto();
  fs.writeFileSync(path.join(p.estado, 'porteiro.lock'), String(morto));
  const r = rodar(p);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(esperarMarca(p.marca, 8000), true);
  assert.match(lerLog(p), new RegExp(`morto \\(pid ${morto}\\)`));
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.estado, 'supervisor.json'), 'utf8')).pidMorto, morto);
});

test('trava com pid vivo: nao faz nada', () => {
  const p = pasta();
  fs.writeFileSync(path.join(p.estado, 'porteiro.lock'), String(process.pid));
  semLancar(p, rodar(p));
});

test('maquina sem o recurso (sem config.json): silencio total, nem log', () => {
  const p = pasta({ config: false });
  semLancar(p, rodar(p));
  assert.equal(lerLog(p), '');
});

test('arquivo "desligado" na pasta de estado: parado de proposito fica parado', () => {
  const p = pasta();
  fs.writeFileSync(path.join(p.estado, 'desligado'), '');
  semLancar(p, rodar(p));
});

test('tentativa ha menos de 3 min: nao repete (porteiro que morre ao subir nao vira laco)', () => {
  const p = pasta();
  fs.writeFileSync(path.join(p.estado, 'supervisor.json'), JSON.stringify({ em: Date.now() - 60 * 1000 }));
  const r = rodar(p);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.doesNotMatch(lerLog(p), /religando/);
  assert.equal(esperarMarca(p.marca, 800), false);
});

test('tentativa ha mais de 3 min: tenta de novo', { skip: SO_WINDOWS }, () => {
  const p = pasta();
  fs.writeFileSync(path.join(p.estado, 'supervisor.json'), JSON.stringify({ em: Date.now() - 4 * 60 * 1000 }));
  const r = rodar(p);
  assert.equal(r.status, 0);
  assert.equal(esperarMarca(p.marca, 8000), true);
});

test('supervisor.json corrompido: trata como sem tentativa e religa', { skip: SO_WINDOWS }, () => {
  const p = pasta();
  fs.writeFileSync(path.join(p.estado, 'supervisor.json'), '{quebrado');
  const r = rodar(p);
  assert.equal(r.status, 0);
  assert.equal(esperarMarca(p.marca, 8000), true);
});

test('lancador ausente: nao marca tentativa, loga o motivo, exit 0 e stdout vazio', { skip: SO_WINDOWS }, () => {
  const p = pasta({ vbs: false });
  const r = rodar(p);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(tentou(p), false);
  assert.match(lerLog(p), /o lancador nao existe/);
});

// M4a (PLANO-MAC.md, "Mapa", linha 1): no Mac o lancador e o LaunchAgent (launchctl kickstart), nao o .vbs. Os 3 abaixo
// chamam o main({ platform: 'darwin', ... }) neste processo com dubles: o spawn so anota (launchctl nunca roda), o
// `existe` responde pelo plist sintetico (/Users/dono) e cai no disco pro resto; a pasta de estado vem do env (restaurado).
const { EventEmitter } = require('events');
const { LABEL_MAC } = require('../lib/sessoes-wpp.js');
const PLIST_MAC = `/Users/dono/Library/LaunchAgents/${LABEL_MAC}.plist`;

async function rodarMac(p, { temPlist }) {
  const { main } = require(HOOK);
  const chamadas = [];
  const spawnFalso = (cmd, args, opts) => {
    chamadas.push({ cmd, args, opts });
    const f = new EventEmitter();
    f.unref = () => {};
    setImmediate(() => f.emit('spawn'));
    return f;
  };
  const existe = (arq) => (arq === PLIST_MAC ? temPlist : fs.existsSync(arq));
  const antes = { SESSOES_WPP_DIR: process.env.SESSOES_WPP_DIR, SESSOES_WPP_LOG: process.env.SESSOES_WPP_LOG };
  process.env.SESSOES_WPP_DIR = p.estado;
  process.env.SESSOES_WPP_LOG = p.log;
  try {
    await main({ platform: 'darwin', spawn: spawnFalso, uid: 501, home: '/Users/dono', existe });
  } finally {
    for (const [k, v] of Object.entries(antes)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return chamadas;
}

test('M4a darwin: sem o plist do LaunchAgent nao chama o spawn, nao marca tentativa e loga o motivo', async () => {
  const p = pasta({ vbs: false });
  const chamadas = await rodarMac(p, { temPlist: false });
  assert.deepEqual(chamadas, []);
  assert.equal(tentou(p), false);
  assert.match(lerLog(p), /supervisor: porteiro morto e o plist do launchd nao existe \(.*com\.expertintegrado\.tele-control\.plist\); nada feito/);
  assert.doesNotMatch(lerLog(p), /religando/);
});

test('M4a darwin: com o plist e o porteiro morto, religa por launchctl kickstart gui/<uid>/<label> destacado e loga "religando pelo launchd"', async () => {
  const p = pasta({ vbs: false });
  const morto = pidMorto();
  fs.writeFileSync(path.join(p.estado, 'porteiro.lock'), String(morto));
  const chamadas = await rodarMac(p, { temPlist: true });
  assert.deepEqual(chamadas, [{ cmd: 'launchctl', args: ['kickstart', `gui/501/${LABEL_MAC}`], opts: { detached: true, stdio: 'ignore' } }]);
  assert.match(lerLog(p), new RegExp(`supervisor: porteiro morto \\(pid ${morto}\\); religando pelo launchd`));
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.estado, 'supervisor.json'), 'utf8')).pidMorto, morto);
  assert.equal(esperarMarca(p.marca, 300), false, 'nada de .vbs no Mac');
});

test('M4a darwin: com o arquivo "desligado" nao chama nada (nem com o plist)', async () => {
  const p = pasta({ vbs: false });
  fs.writeFileSync(path.join(p.estado, 'desligado'), '');
  const chamadas = await rodarMac(p, { temPlist: true });
  assert.deepEqual(chamadas, []);
  assert.equal(tentou(p), false);
  assert.equal(lerLog(p), '');
});

test('stdin ausente ou lixo nao muda nada: continua exit 0 e mudo', () => {
  const p = pasta();
  fs.writeFileSync(path.join(p.estado, 'porteiro.lock'), String(process.pid));
  const r = spawnSync(process.execPath, [HOOK], {
    input: 'isso nao e json',
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, SESSOES_WPP_DIR: p.estado, SESSOES_WPP_LOG: p.log, SESSOES_WPP_PORTEIRO_VBS: p.vbs, SUP_TESTE_MARCA: p.marca },
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});
