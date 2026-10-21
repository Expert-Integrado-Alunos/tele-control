// Testes do M4a do porte pro Mac (PLANO-MAC.md, "Mapa", linha 1): o porteiro sobe no login e se mantem vivo pelo
// LaunchAgent do launchd. Cobrem o gerador do plist (lib/launchagent.mjs), o `garantirMac` (kickstart, bootstrap e os
// 2 desfechos que caem no spawn de hoje), o `segurarAcordado` (caffeinate -s -w <pid>) e o CLI tools/mac/gerar-plist.mjs.
// Isolamento: a plataforma e trocada pra darwin no `before` e desfeita no `after` (cada arquivo de teste roda num
// processo proprio: a troca nao vaza). Nada roda launchctl nem caffeinate de verdade: o execFileSync, o spawn e o
// `existe` sao sempre dubles; dado sintetico (/Users/dono).
// Rodar: node --test --test-reporter=tap "tests/mac-m4a.test.mjs"
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { plataforma, trocarPlataformaParaTeste } from '../lib/plataforma.mjs';
import { caminhoDoPlist, plistDoPorteiro } from '../lib/launchagent.mjs';
import { garantirMac, segurarAcordado } from '../porteiro.mjs';

const require = createRequire(import.meta.url);
const { LABEL_MAC } = require('../hooks/lib/sessoes-wpp.js');
const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GERAR = path.join(REPO, 'tools', 'mac', 'gerar-plist.mjs');
// Na copia aberta o tools/ nao vai (export-ignore): sem o gerador, o teste 4 pula; na fonte roda igual.
const SEM_GERAR = fs.existsSync(GERAR) ? false : 'sem o tools/mac/gerar-plist.mjs (fica fora da copia aberta)';

const ORIGINAL = process.platform === 'darwin' ? 'darwin' : 'win32';
let desfazer = null;

before(() => {
  desfazer = trocarPlataformaParaTeste('darwin');
});

after(() => {
  desfazer?.();
  assert.equal(plataforma(), ORIGINAL, 'o after devolve a plataforma do processo');
});

const HOME = '/Users/dono';
const PLIST = `${HOME}/Library/LaunchAgents/${LABEL_MAC}.plist`;

// Leitor minimo de plist XML (dict, array, string, integer, true, false), so pros testes: devolve o objeto do <dict> raiz.
function lerPlist(xml) {
  const desfazerEscape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const fichas = [...xml.replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>/g, '').matchAll(/<(\/?)(\w+)(?:\s[^>]*?)?(\/?)>|([^<]+)/g)]
    .map((m) => (m[4] !== undefined ? { texto: m[4] } : { fecha: m[1] === '/', tag: m[2], vazia: m[3] === '/' }))
    .filter((f) => f.texto === undefined || f.texto.trim() !== '');
  let i = 0;
  const abre = (tag) => {
    const f = fichas[i++];
    assert.ok(f && !f.fecha && f.tag === tag, `esperava <${tag}>, veio ${JSON.stringify(f)}`);
    return f;
  };
  const fecha = (tag) => {
    const f = fichas[i++];
    assert.ok(f && f.fecha && f.tag === tag, `esperava </${tag}>, veio ${JSON.stringify(f)}`);
  };
  const texto = (tag) => {
    abre(tag);
    let t = '';
    if (fichas[i]?.texto !== undefined) t = fichas[i++].texto;
    fecha(tag);
    return desfazerEscape(t);
  };
  const valor = () => {
    const f = fichas[i];
    if (f.tag === 'true' || f.tag === 'false') {
      assert.ok(f.vazia, `<${f.tag}/> vazio`);
      i++;
      return f.tag === 'true';
    }
    if (f.tag === 'string') return texto('string');
    if (f.tag === 'integer') return Number(texto('integer'));
    if (f.tag === 'array') {
      abre('array');
      const a = [];
      while (!fichas[i].fecha) a.push(valor());
      fecha('array');
      return a;
    }
    if (f.tag === 'dict') {
      abre('dict');
      const o = {};
      while (!fichas[i].fecha) {
        const k = texto('key');
        o[k] = valor();
      }
      fecha('dict');
      return o;
    }
    throw new Error(`tag inesperada: ${JSON.stringify(f)}`);
  };
  abre('plist');
  const raiz = valor();
  fecha('plist');
  assert.equal(i, fichas.length, 'nada depois do </plist>');
  return raiz;
}

test('M4a 1. plistDoPorteiro: todas as chaves e valores do LaunchAgent, escape de & e <, caminho fora do POSIX absoluto lanca TypeError', () => {
  assert.equal(LABEL_MAC, 'com.expertintegrado.tele-control', 'o label e a fonte unica do CJS');
  assert.equal(caminhoDoPlist(HOME), PLIST);
  assert.equal(caminhoDoPlist(`${HOME}/`, 'com.exemplo.ensaio'), `${HOME}/Library/LaunchAgents/com.exemplo.ensaio.plist`);
  const base = { node: '/opt/homebrew/bin/node', repo: `${HOME}/repos/sessoes-wpp`, home: HOME, logFile: `${HOME}/.claude/logs/sessoes-wpp.log` };
  const xml = plistDoPorteiro(base);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN" "http:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd">\n<plist version="1\.0">/);
  assert.deepEqual(lerPlist(xml), {
    Label: LABEL_MAC,
    ProgramArguments: ['/opt/homebrew/bin/node', `${HOME}/repos/sessoes-wpp/porteiro.mjs`, 'rodar'],
    WorkingDirectory: `${HOME}/repos/sessoes-wpp`,
    RunAtLoad: true,
    KeepAlive: { SuccessfulExit: false },
    ThrottleInterval: 60,
    ProcessType: 'Interactive',
    EnvironmentVariables: {
      HOME,
      PATH: `/opt/homebrew/bin:/usr/local/bin:${HOME}/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      LANG: 'en_US.UTF-8',
    },
    StandardOutPath: `${HOME}/.claude/logs/sessoes-wpp.log`,
    StandardErrorPath: `${HOME}/.claude/logs/sessoes-wpp.log`,
  });
  assert.equal(lerPlist(plistDoPorteiro({ ...base, label: 'com.exemplo.ensaio' })).Label, 'com.exemplo.ensaio', 'o label de ensaio (M6)');

  // escape: & < > " ' viram entidade no XML e voltam iguais na leitura
  const estranho = { ...base, repo: `${HOME}/a&b<c>"d'e`, logFile: `${HOME}/l&<.log` };
  const xmlEstranho = plistDoPorteiro(estranho);
  assert.ok(xmlEstranho.includes('/a&amp;b&lt;c&gt;&quot;d&apos;e/porteiro.mjs'), 'o repo escapado no ProgramArguments');
  assert.ok(xmlEstranho.includes('/l&amp;&lt;.log'));
  assert.doesNotMatch(xmlEstranho, /&(?!amp;|lt;|gt;|quot;|apos;)/, 'nenhum & cru');
  const lido = lerPlist(xmlEstranho);
  assert.equal(lido.WorkingDirectory, `${HOME}/a&b<c>"d'e`);
  assert.equal(lido.StandardErrorPath, `${HOME}/l&<.log`);

  // cada caminho: relativo, Windows, vazio ou nao-texto = TypeError
  for (const campo of ['node', 'repo', 'home', 'logFile']) {
    for (const ruim of ['repos/relativo', 'C:\\Program Files\\nodejs\\node.exe', 'C:/x', '', null, undefined, 42]) {
      assert.throws(() => plistDoPorteiro({ ...base, [campo]: ruim }), TypeError, `${campo} = ${JSON.stringify(ruim)}`);
    }
  }
  assert.throws(() => caminhoDoPlist('Users/dono'), TypeError);
  assert.throws(() => plistDoPorteiro({ ...base, label: 'com.x/../y' }), TypeError, 'label com barra');
});

test('M4a 2. garantirMac: sem plist, kickstart, bootstrap (kickstart lancou) e falhou (os 2 lancaram)', () => {
  const cenario = ({ temPlist = true, falha = [] } = {}, extra = {}) => {
    const chamadas = [];
    const vistos = [];
    const r = garantirMac({
      execFileSync: (cmd, args) => {
        chamadas.push([cmd, args]);
        if (falha.includes(args[0])) throw new Error(`launchctl ${args[0]}: falhou`);
        return '';
      },
      existe: (p) => {
        vistos.push(p);
        return temPlist;
      },
      uid: 501,
      home: HOME,
      ...extra,
    });
    return { r, chamadas, vistos };
  };
  const KICK = ['launchctl', ['kickstart', `gui/501/${LABEL_MAC}`]];
  const BOOT = ['launchctl', ['bootstrap', 'gui/501', PLIST]];

  let c = cenario({ temPlist: false });
  assert.equal(c.r, 'sem-plist');
  assert.deepEqual(c.vistos, [PLIST]);
  assert.deepEqual(c.chamadas, [], 'sem plist nao chama o launchctl');

  c = cenario();
  assert.equal(c.r, 'kickstart');
  assert.deepEqual(c.chamadas, [KICK]);

  c = cenario({ falha: ['kickstart'] });
  assert.equal(c.r, 'bootstrap');
  assert.deepEqual(c.chamadas, [KICK, BOOT]);

  c = cenario({ falha: ['kickstart', 'bootstrap'] });
  assert.equal(c.r, 'falhou');
  assert.deepEqual(c.chamadas, [KICK, BOOT]);

  // o label de ensaio (M6) troca o plist e o alvo do kickstart
  c = cenario({}, { label: 'com.exemplo.ensaio' });
  assert.equal(c.r, 'kickstart');
  assert.deepEqual(c.vistos, [`${HOME}/Library/LaunchAgents/com.exemplo.ensaio.plist`]);
  assert.deepEqual(c.chamadas, [['launchctl', ['kickstart', 'gui/501/com.exemplo.ensaio']]]);

  // uid que nao e inteiro >= 0 = falhou sem chamar nada
  for (const uid of [undefined, null, -1, 1.5, '501']) {
    c = cenario({}, { uid });
    assert.equal(c.r, 'falhou', `uid ${JSON.stringify(uid)}`);
    assert.deepEqual(c.chamadas, []);
  }

  // M6 (rodada 2 no Mac do GitHub): o kickstart que passa do prazo (o launchd segurando o ThrottleInterval) = o pedido
  // ficou com o launchd: 'kickstart', sem bootstrap; o prazo do launchctl e 15 s
  const lentas = [];
  c = cenario({}, {
    execFileSync: (cmd, args, opts) => {
      lentas.push([cmd, args, opts?.timeout]);
      throw Object.assign(new Error('spawnSync launchctl ETIMEDOUT'), { code: 'ETIMEDOUT' });
    },
  });
  assert.equal(c.r, 'kickstart');
  assert.deepEqual(lentas, [[...KICK, 15000]]);
});

test('M4a 3. segurarAcordado: /usr/bin/caffeinate -s -w <pid> destacado, unref e true; spawn que lanca ou pid ruim = false; erro depois de subir nao derruba', async () => {
  const filhos = [];
  const chamadas = [];
  const spawnFalso = (cmd, args, opts) => {
    chamadas.push([cmd, args, opts]);
    const f = new EventEmitter();
    f.soltos = 0;
    f.unref = () => { f.soltos++; };
    filhos.push(f);
    return f;
  };
  const falhas = [];
  assert.equal(segurarAcordado({ spawn: spawnFalso, pid: 4242, aoFalhar: (e) => falhas.push(e.message) }), true);
  assert.deepEqual(chamadas, [['/usr/bin/caffeinate', ['-s', '-w', '4242'], { detached: true, stdio: 'ignore' }]]);
  assert.equal(filhos[0].soltos, 1, 'unref 1 vez');

  // o caffeinate que nao existe da 'error' depois do spawn: sem ouvinte, o processo cairia
  filhos[0].emit('error', new Error('spawn /usr/bin/caffeinate ENOENT'));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(falhas, ['spawn /usr/bin/caffeinate ENOENT']);
  assert.equal(segurarAcordado({ spawn: spawnFalso, pid: 7 }), true, 'sem aoFalhar tambem ouve o erro');
  assert.doesNotThrow(() => filhos[1].emit('error', new Error('x')));

  assert.equal(segurarAcordado({ spawn: () => { throw new Error('EAGAIN'); }, pid: 4242 }), false, 'spawn que lanca = false');
  const antes = chamadas.length;
  for (const pid of [0, -3, 1.5, '4242', undefined]) {
    assert.equal(segurarAcordado({ spawn: spawnFalso, pid }), false, `pid ${JSON.stringify(pid)}`);
  }
  assert.equal(chamadas.length, antes, 'pid ruim nao spawna');
});

test('M4a 4. tools/mac/gerar-plist.mjs: com --forcar imprime o plist (ProgramArguments, HOME, log); fora do darwin sem --forcar sai 2 com 1 linha no stderr', { skip: SEM_GERAR }, () => {
  const env = { ...process.env, HOME, USERPROFILE: HOME };
  delete env.SESSOES_WPP_LOG;
  const gerar = (args, extra = {}) => spawnSync(process.execPath, [GERAR, ...args], { encoding: 'utf8', timeout: 30000, env: { ...env, ...extra }, windowsHide: true });

  const r = gerar(['--forcar']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  const p = lerPlist(r.stdout);
  assert.equal(p.Label, LABEL_MAC);
  assert.equal(p.ProgramArguments.length, 3);
  assert.match(p.ProgramArguments[0], /^\/.*node/, 'o node deste processo, em POSIX');
  assert.match(p.ProgramArguments[1], /^\/.*\/porteiro\.mjs$/, 'o porteiro da raiz do repo');
  assert.equal(p.ProgramArguments[2], 'rodar');
  assert.equal(`${p.WorkingDirectory}/porteiro.mjs`, p.ProgramArguments[1], 'a pasta de trabalho e a raiz do repo');
  assert.equal(p.EnvironmentVariables.HOME, HOME);
  assert.equal(p.StandardOutPath, `${HOME}/.claude/logs/sessoes-wpp.log`);

  const comLog = lerPlist(gerar(['--forcar'], { SESSOES_WPP_LOG: `${HOME}/logs/m4a-teste.log` }).stdout);
  assert.equal(comLog.StandardErrorPath, `${HOME}/logs/m4a-teste.log`, 'SESSOES_WPP_LOG manda');

  if (process.platform !== 'darwin') {
    const fora = gerar([]);
    assert.equal(fora.status, 2);
    assert.equal(fora.stdout, '');
    assert.equal(fora.stderr.trim().split(/\r?\n/).length, 1, fora.stderr);
    assert.match(fora.stderr, /macOS|darwin/);
  }
});
