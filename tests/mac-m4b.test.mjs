// Testes do M4b do porte pro Mac (PLANO-MAC.md, "Mapa", linhas 6 e 11, e "Plano B", M4, "Bot"): o config.json do Mac
// montado a partir do de outra maquina (tools/mac/config-mac.mjs), a chave do bot guardada no Keychain sem passar pela
// linha de comando (bin/chave-mac.sh), a bateria sem o cygpath fora do Windows (tools/integrar/bateria.sh) e o
// instalador do Mac parando o porteiro solto antes do launchd (tools/mac/instalar-mac.sh, passo 7).
// Isolamento: a plataforma so e trocada pra darwin no teste 4, e desfeita no finally. Nada roda o `security` de verdade:
// o SECURITY_BIN aponta pra um duble .sh numa pasta temporaria (pastaTemp, prefixo m4b-). Dado sintetico (/Users/dono,
// C:\Users\dono, C:\projetos, bot e chat 123456).
// Na copia aberta o tools/ nao vai (export-ignore): sem o config-mac.mjs os testes 1-4 pulam e sem os 2 scripts o 6 pula.
// O caminho de repositorio do Windows e montado por pedacos (o literal inteiro e termo proibido na copia aberta).
// Rodar: node --test --test-reporter=tap "tests/mac-m4b.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { plataforma, trocarPlataformaParaTeste } from '../lib/plataforma.mjs';
import {
  sessoesDoConfig, identidadeCentral, travasDoConfig, transcricaoDoConfig, appsDoConfig, identidadeTelegram,
} from '../lib/config.mjs';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG_MAC = path.join(REPO, 'tools', 'mac', 'config-mac.mjs');
const CHAVE_MAC = path.join(REPO, 'bin', 'chave-mac.sh');
const BATERIA = path.join(REPO, 'tools', 'integrar', 'bateria.sh');
const INSTALAR = path.join(REPO, 'tools', 'mac', 'instalar-mac.sh');
const SEM_CONFIG_MAC = fs.existsSync(CONFIG_MAC) ? false : 'sem o tools/mac/config-mac.mjs (fica fora da copia aberta)';
const temBash = (() => {
  const r = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 && r.stdout.trim() === 'ok';
})();
const SEM_BASH = temBash ? false : 'sem bash no PATH';
const SEM_SCRIPTS = !temBash ? 'sem bash no PATH'
  : fs.existsSync(BATERIA) && fs.existsSync(INSTALAR) ? false : 'sem o tools/ (fica fora da copia aberta)';

// O bash do Windows (Git Bash) le C:/x/y; no Mac e no Linux o caminho ja e POSIX
const barra = (p) => p.replace(/\\/g, '/');
const mod = () => import(pathToFileURL(CONFIG_MAC).href);

const HOME_PC = 'C:\\Users\\dono';
const HOME_MAC = '/Users/dono';
const REPOS_PC = 'C:\\' + 'repos';
const HOMES = { homePc: HOME_PC, homeMac: HOME_MAC };

// Config de origem sintetico (o de um PC): os campos que o Mac copia, os que ele refaz e os que ficam de fora
const ORIGEM = Object.freeze({
  canalPrincipal: 'whatsapp',
  telegram: { ligado: false, chatId: 123456, botId: 654321, nomeBot: 'Bot do PC', varChave: 'CHAVE_DO_PC', sonda: true, ok: { botoes: true }, resolvidas: 'manter' },
  whatsapp: { ligado: true, grupo: '1234567890-group' },
  sessoes: { raizes: ['C:\\projetos'], soNaRaiz: false },
  central: { pasta: `${REPOS_PC}\\sessoes-wpp`, nome: 'Central de Teste', modoPermissao: 'sozinha' },
  apps: ['vscode', 'desktop', 'orca'],
  transcricao: { ligada: true, python: 'C:\\Python\\python.exe', idioma: 'pt' },
  maquina: { nome: 'pc' },
  travas: {
    lib: `${HOME_PC}\\.claude\\hooks\\lib\\trava.js`,
    deployMarker: 'c:\\USERS\\Dono\\.claude\\marker.json', // sem caso
    disparoLedger: `${REPOS_PC}\\x\\ledger.json`,
  },
  dono: { nome: 'Dono', artigo: 'o' },
  modoRua: { automatico: true, ociosoMin: 30 },
  mensageiro: { modelo: 'sonnet' },
  voz: { ligada: true, nome: 'pt-BR-AntonioNeural' },
  saude: { varUrl: 'URL_DA_SAUDE' },
  centralNota: 'nota da central',
  orca: { bin: 'C:\\x\\orca.exe' },
});

const BASE = ['--home-mac', HOME_MAC, '--home-pc', HOME_PC, '--var-chave', 'CHAVE_DO_MAC', '--nome-bot', 'Bot do Mac', '--bot-id', '123456'];

// Grava o config de origem (objeto ou texto cru) numa pasta m4b- e roda o CLI; devolve a pasta, o desfecho e o JSON
function gerar(origem, extra = [], { semBase = false } = {}) {
  const dir = pastaTemp('m4b-');
  const de = path.join(dir, 'origem.json');
  fs.writeFileSync(de, typeof origem === 'string' ? origem : JSON.stringify(origem));
  const r = spawnSync(process.execPath, [CONFIG_MAC, '--de', de, ...(semBase ? [] : BASE), ...extra],
    { encoding: 'utf8', windowsHide: true });
  let cfg = null;
  try { cfg = JSON.parse(r.stdout); } catch { /* sem JSON no stdout */ }
  return { dir, de, status: r.status, stdout: r.stdout, stderr: r.stderr, cfg };
}

test('M4b 1. mapear: dentro do home do PC (sem caso), igual ao home, o repositorio do disco C e o resto = null', { skip: SEM_CONFIG_MAC }, async () => {
  const { mapear } = await mod();
  assert.equal(mapear(`${HOME_PC}\\.claude\\hooks\\trava.js`, HOMES), '/Users/dono/.claude/hooks/trava.js');
  assert.equal(mapear('c:\\users\\DONO\\Workspace\\Pasta', HOMES), '/Users/dono/Workspace/Pasta', 'sem caso; o resto mantem a caixa');
  assert.equal(mapear(HOME_PC, HOMES), HOME_MAC, 'igual ao home');
  assert.equal(mapear('c:\\Users\\Dono\\', HOMES), HOME_MAC, 'igual ao home, sem caso e com a barra do fim');
  assert.equal(mapear(`${REPOS_PC}\\sessoes-wpp`, HOMES), '/Users/dono/repos/sessoes-wpp');
  assert.equal(mapear(REPOS_PC, HOMES), '/Users/dono/repos');
  assert.equal(mapear('C:/Users/dono/a/b.json', HOMES), '/Users/dono/a/b.json', 'barra normal no caminho do Windows');
  assert.equal(mapear('C:\\Users\\dono2\\x', HOMES), null, 'outro usuario com o mesmo comeco');
  assert.equal(mapear(`${REPOS_PC}x\\y`, HOMES), null, 'outra pasta com o mesmo comeco');
  assert.equal(mapear('C:\\projetos\\x', HOMES), null, 'fora do home e do repositorio');
  assert.equal(mapear('D:\\Users\\dono\\x', HOMES), null, 'outro disco');
  assert.equal(mapear('/Users/dono/x', HOMES), null, 'POSIX nao e caminho do Windows');
  for (const ruim of [undefined, null, 42, '', 'relativo\\x']) assert.equal(mapear(ruim, HOMES), null);
  assert.equal(mapear(`${HOME_PC}\\a`, { homePc: 'C:\\Users\\dono\\', homeMac: '/Users/dono/' }), '/Users/dono/a', 'homes com a barra do fim');
});

test('M4b 2. config-mac.mjs: campos do Mac, whatsapp fora, travas mapeadas (null sai), --saida com 0600 e recusa de sobrescrever (3)', { skip: SEM_CONFIG_MAC }, () => {
  const r = gerar(ORIGEM, ['--raiz', '/Users/dono/projetos', '--raiz', '/Users/dono/Workspace', '--maquina', 'mac-dono']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, JSON.stringify(r.cfg, null, 2) + '\n', 'JSON com 2 espacos');
  assert.deepEqual(r.cfg, {
    canalPrincipal: 'telegram',
    telegram: {
      ligado: true, chatId: 123456, sonda: true, ok: { botoes: true }, resolvidas: 'manter',
      botId: 123456, nomeBot: 'Bot do Mac', varChave: 'CHAVE_DO_MAC',
    },
    sessoes: { raizes: ['/Users/dono/projetos', '/Users/dono/Workspace'], soNaRaiz: false },
    central: { nome: 'Central de Teste', modoPermissao: 'sozinha', pasta: '/Users/dono/repos/sessoes-wpp' },
    apps: ['vscode', 'terminal'],
    transcricao: { ligada: false },
    maquina: { nome: 'mac-dono' },
    travas: {
      lib: '/Users/dono/.claude/hooks/lib/trava.js',
      deployMarker: '/Users/dono/.claude/marker.json',
      disparoLedger: '/Users/dono/repos/x/ledger.json',
    },
    dono: { nome: 'Dono', artigo: 'o' },
    modoRua: { automatico: true, ociosoMin: 30 },
    mensageiro: { modelo: 'sonnet' },
    voz: { ligada: true, nome: 'pt-BR-AntonioNeural' },
    saude: { varUrl: 'URL_DA_SAUDE' },
    centralNota: 'nota da central',
  });
  assert.equal('whatsapp' in r.cfg, false, 'WhatsApp desligado no Mac');

  // Origem minima: raizes padrao (<home-mac>/repos), central fora do mapa = <home-mac>/repos, trava fora = sai,
  // maquina padrao 'mac', copiados ausentes nao aparecem
  const m = gerar({ telegram: { chatId: '123456' }, central: { pasta: 'C:\\projetos' }, travas: { lib: 'D:\\fora\\t.js', deployMarker: `${HOME_PC}\\m.json` } });
  assert.equal(m.status, 0, m.stderr);
  assert.deepEqual(m.cfg, {
    canalPrincipal: 'telegram',
    telegram: { ligado: true, chatId: '123456', botId: 123456, nomeBot: 'Bot do Mac', varChave: 'CHAVE_DO_MAC' },
    sessoes: { raizes: ['/Users/dono/repos'] },
    central: { pasta: '/Users/dono/repos' },
    apps: ['vscode', 'terminal'],
    transcricao: { ligada: false },
    maquina: { nome: 'mac' },
    travas: { deployMarker: '/Users/dono/m.json' },
  });

  // --saida: grava (0600 fora do Windows), imprime so o caminho, e recusa o existente sem --sobrescrever
  const saida = path.join(r.dir, 'estado', 'config.json');
  const g = gerar(ORIGEM, ['--saida', saida]);
  assert.equal(g.status, 0, g.stderr);
  assert.equal(g.stdout.includes('{'), false, 'com --saida o JSON nao vai pro stdout');
  const gravado = fs.readFileSync(saida, 'utf8');
  assert.equal(JSON.parse(gravado).telegram.varChave, 'CHAVE_DO_MAC');
  if (process.platform !== 'win32') assert.equal(fs.statSync(saida).mode & 0o777, 0o600);
  const de2 = gerar({ ...ORIGEM, centralNota: 'outra' }, ['--saida', saida]);
  assert.equal(de2.status, 3, 'existente sem --sobrescrever');
  assert.match(de2.stderr, /sobrescrever/);
  assert.equal(fs.readFileSync(saida, 'utf8'), gravado, 'o existente fica intacto');
  const s = gerar({ ...ORIGEM, centralNota: 'outra' }, ['--saida', saida, '--sobrescrever']);
  assert.equal(s.status, 0, s.stderr);
  assert.equal(JSON.parse(fs.readFileSync(saida, 'utf8')).centralNota, 'outra');
  if (process.platform !== 'win32') assert.equal(fs.statSync(saida).mode & 0o777, 0o600, '0600 tambem ao sobrescrever');
});

test('M4b 3. config-mac.mjs: argumento ruim = saida 2, 1 linha no stderr e nada gravado', { skip: SEM_CONFIG_MAC }, () => {
  const troca = (nome, valor) => { const a = [...BASE]; a[a.indexOf(nome) + 1] = valor; return a; };
  const casos = [
    ['--home-mac relativo', ORIGEM, troca('--home-mac', 'Users/dono')],
    ['--home-mac do Windows', ORIGEM, troca('--home-mac', 'C:\\Users\\dono')],
    ['--home-mac raiz', ORIGEM, troca('--home-mac', '/')],
    ['--raiz relativa', ORIGEM, [...BASE, '--raiz', 'projetos']],
    ['--home-pc POSIX', ORIGEM, troca('--home-pc', '/Users/dono')],
    ['--home-pc relativo', ORIGEM, troca('--home-pc', 'Users\\dono')],
    ['--bot-id com letra', ORIGEM, troca('--bot-id', '12a456')],
    ['--var-chave minuscula', ORIGEM, troca('--var-chave', 'chave_do_mac')],
    ['--var-chave com hifen', ORIGEM, troca('--var-chave', 'CHAVE-DO-MAC')],
    ['--nome-bot vazio', ORIGEM, troca('--nome-bot', '   ')],
    ['--de lista', '[1, 2]', BASE],
    ['--de texto', '"config"', BASE],
    ['--de sem JSON', '{ quebrado', BASE],
    ['sem --var-chave', ORIGEM, BASE.filter((_, i) => i !== BASE.indexOf('--var-chave') && i !== BASE.indexOf('--var-chave') + 1)],
    ['argumento desconhecido', ORIGEM, [...BASE, '--outro']],
  ];
  for (const [nome, origem, args] of casos) {
    const dir = pastaTemp('m4b-');
    const saida = path.join(dir, 'config.json');
    const r = gerar(origem, [...args, '--saida', saida], { semBase: true });
    assert.equal(r.status, 2, `${nome}: ${r.stderr}`);
    assert.equal(r.stdout, '', `${nome}: nada no stdout`);
    assert.equal(r.stderr.trim().split('\n').length, 1, `${nome}: 1 linha no stderr`);
    assert.equal(fs.existsSync(saida), false, `${nome}: nada gravado`);
  }
  // o --var-chave e o NOME que o bin/chave-mac.sh guarda: maiusculas, 3 a 64 (o RE_VAR_CHAVE do config aceitaria
  // minuscula, mas o chave-mac.sh recusaria guardar)
  assert.equal(gerar(ORIGEM, troca('--var-chave', 'ABC'), { semBase: true }).status, 0);
  assert.equal(gerar(ORIGEM, troca('--var-chave', 'AB'), { semBase: true }).status, 2);
});

test('M4b 4. o config gerado lido pelo porteiro no darwin: raizes, central, travas, transcricao, apps e varChave', { skip: SEM_CONFIG_MAC }, () => {
  const r = gerar(ORIGEM, ['--raiz', '/Users/dono/projetos', '--raiz', '/Users/dono/Workspace']);
  assert.equal(r.status, 0, r.stderr);
  const cfg = r.cfg;
  const desfazer = trocarPlataformaParaTeste('darwin');
  try {
    assert.equal(plataforma(), 'darwin');
    assert.deepEqual(sessoesDoConfig(cfg), { raizes: ['/Users/dono/projetos', '/Users/dono/Workspace'], soNaRaiz: false });
    assert.deepEqual(identidadeCentral(cfg, { repo: '/Users/dono/outra' }),
      { pasta: '/Users/dono/repos/sessoes-wpp', nome: 'Central de Teste', modoPermissao: 'sozinha' });
    assert.deepEqual(travasDoConfig(cfg), {
      lib: '/Users/dono/.claude/hooks/lib/trava.js',
      deployMarker: '/Users/dono/.claude/marker.json',
      disparoLedger: '/Users/dono/repos/x/ledger.json',
    });
    assert.equal(transcricaoDoConfig(cfg).ligada, false);
    assert.deepEqual(appsDoConfig(cfg), ['vscode', 'terminal']);
    assert.deepEqual(identidadeTelegram(cfg), { chatId: 123456, botId: 123456, nomeBot: 'Bot do Mac', varChave: 'CHAVE_DO_MAC' });
  } finally {
    desfazer();
  }
  assert.equal(plataforma(), process.platform === 'darwin' ? 'darwin' : 'win32', 'o finally devolve a plataforma');
});

test('M4b 5. chave-mac.sh: o valor vai pelo STDIN do security -i (nunca nos argumentos), nome e valor ruins = 2 sem ecoar', { skip: SEM_BASH }, () => {
  const dir = pastaTemp('m4b-');
  const duble = path.join(dir, 'security.sh');
  // Duble do security: grava os argumentos e o stdin e sai 0 (no find tambem, salvo M4B_FIND_FALHA)
  fs.writeFileSync(duble, [
    '#!/usr/bin/env bash',
    'printf \'%s\\n\' "$*" >> "$M4B_DIR/args.txt"',
    'cat >> "$M4B_DIR/stdin.txt"',
    'if [ "$1" = find-generic-password ] && [ -n "${M4B_FIND_FALHA:-}" ]; then exit 44; fi',
    'exit 0',
    '',
  ].join('\n'));
  fs.chmodSync(duble, 0o755);
  const VALOR = 'valor-sintetico:abc_DEF.123+x=';
  const rodar = (nome, entrada, extra = {}) => {
    for (const f of ['args.txt', 'stdin.txt']) fs.rmSync(path.join(dir, f), { force: true });
    return spawnSync('bash', [barra(CHAVE_MAC), nome], {
      input: entrada, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, CHAVE_MAC_FORCAR: '1', SECURITY_BIN: barra(duble), M4B_DIR: barra(dir), USER: 'dono', ...extra },
    });
  };
  const ler = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : null);

  const ok = rodar('CHAVE_DO_MAC', `${VALOR}\r\n`); // o \r do fim sai
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, 'guardada: CHAVE_DO_MAC\n');
  assert.equal(ler('stdin.txt'), `add-generic-password -U -a dono -s CHAVE_DO_MAC -w ${VALOR}\n`, 'o valor chega pelo stdin');
  assert.equal(ler('args.txt'), '-i\nfind-generic-password -s CHAVE_DO_MAC\n', 'os argumentos: -i e a conferencia sem -w');
  assert.equal(ler('args.txt').includes(VALOR), false, 'o valor nunca vai nos argumentos');
  assert.equal(`${ok.stdout}${ok.stderr}`.includes(VALOR), false, 'o valor nunca e impresso');

  const falhou = rodar('CHAVE_DO_MAC', `${VALOR}\n`, { M4B_FIND_FALHA: '1' });
  assert.equal(falhou.status, 1);
  assert.match(`${falhou.stdout}${falhou.stderr}`, /nao guardou: CHAVE_DO_MAC/);
  assert.equal(`${falhou.stdout}${falhou.stderr}`.includes(VALOR), false);

  for (const nome of ['chave_minuscula', 'AB', '1CHAVE', 'CHAVE-MAC', '']) {
    const r = rodar(nome, `${VALOR}\n`);
    assert.equal(r.status, 2, `nome ruim: ${nome}`);
    assert.equal(ler('args.txt'), null, `nome ruim (${nome}): o security nem roda`);
  }
  assert.equal(rodar('CHAVE_DO_MAC', `${'a'.repeat(4096)}\n`).status, 0, '4096 = o teto, aceito');
  for (const ruim of ['valor com espaco 123', 'curto', 'valor"com"aspas123', 'a'.repeat(4097), '']) {
    const r = rodar('CHAVE_DO_MAC', `${ruim}\n`);
    assert.equal(r.status, 2, `valor ruim: ${ruim}`);
    if (ruim) assert.equal(`${r.stdout}${r.stderr}`.includes(ruim), false, 'o valor ruim nao e ecoado');
    assert.equal(ler('args.txt'), null, 'valor ruim: o security nem roda');
  }
});

test('M4b 6. bateria.sh sem cygpath fora do Windows e instalar-mac.sh parando o porteiro solto antes do bootout (bash -n e leitura)', { skip: SEM_SCRIPTS }, () => {
  for (const f of [BATERIA, INSTALAR, CHAVE_MAC]) {
    const r = spawnSync('bash', ['-n', barra(f)], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, `bash -n ${path.basename(f)}: ${r.stderr}`);
  }
  const bateria = fs.readFileSync(BATERIA, 'utf8');
  assert.match(bateria, /if command -v cygpath >\/dev\/null 2>&1; then TW="\$\(cygpath -m "\$T"\)"; else TW="\$T"; fi/);
  const inst = fs.readFileSync(INSTALAR, 'utf8');
  const parar = inst.indexOf('node "$REPO/porteiro.mjs" parar');
  const bootout = inst.indexOf('launchctl bootout "$ALVO/$LABEL"');
  assert.ok(parar > 0 && bootout > 0 && parar < bootout, 'o parar vem antes do bootout');
  assert.ok(inst.indexOf('porteiro.lock') > 0 && inst.indexOf('kill -0') > 0, 'o pid sai do porteiro.lock e e conferido com kill -0');
  assert.ok(inst.includes('feito "porteiro anterior parado"'), 'FEITO so com o anterior vivo');
  assert.ok(inst.includes('ok "faria: parar o porteiro anterior (pid $ANTERIOR)"'), 'o ensaio so diz o que faria');
});
