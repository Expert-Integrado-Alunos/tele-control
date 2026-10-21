// Testes do M1 do porte pro Mac (PLANO-MAC.md, "Mapa", linha 0, e "Decisoes"): a camada lib/plataforma.mjs e os
// caminhos POSIX no config (pastas, central, claude, orca, banco do VS Code, python, travas), nas pastas do porteiro
// (pastaNormal, mesmaPasta, raizDaPasta, pastaCurta, os nomes das pastas na frase) e no hook da central.
// Isolamento: a plataforma e trocada pra darwin no `before` e desfeita no `after` (cada arquivo de teste roda num
// processo proprio: a troca nao vaza); o teste 6 volta pra win32 dentro do arquivo e prova que a troca desfaz. Nada
// olha o disco: o `existe` e sempre um duble; dado sintetico.
// Rodar: node --test --test-reporter=tap "tests/mac-m1.test.mjs"
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { plataforma, ehMac, caminhos, trocarPlataformaParaTeste } from '../lib/plataforma.mjs';
import {
  sessoesDoConfig, identidadeCentral, claudeDoConfig, orcaDoConfig, bancoVsCodeDoConfig, transcricaoDoConfig,
  travasDoConfig,
} from '../lib/config.mjs';
import { pastaNormal, mesmaPasta, raizDaPasta, pastaCurta, FRASES } from '../porteiro.mjs';
import { montarAjustes } from '../lib/central.mjs';

const ORIGINAL = process.platform === 'darwin' ? 'darwin' : 'win32';
let desfazer = null;

before(() => {
  desfazer = trocarPlataformaParaTeste('darwin');
});

after(() => {
  desfazer?.();
  assert.equal(plataforma(), ORIGINAL, 'o after devolve a plataforma do processo');
});

// O arg do hook que nega permissao na central (montarAjustes, modo pedir)
const argDoHook = (repo) => montarAjustes({ modo: 'pedir', repo, node: 'node' }).hooks.PermissionRequest[0].hooks[0].args[0];

test('M1 1. darwin: sessoesDoConfig aceita POSIX absoluto, normaliza, tira a barra do fim, mantem a caixa e nao repete sem caso; recusa X:\\, a raiz / e relativo', () => {
  assert.equal(plataforma(), 'darwin');
  assert.equal(ehMac(), true);
  assert.equal(caminhos(), path.posix);
  const { raizes, soNaRaiz } = sessoesDoConfig({
    sessoes: {
      raizes: [
        '  /Users/dono/repos/  ', // aparado, sem a barra do fim
        '/users/DONO/Repos', // a mesma sem caso: fica a 1a
        '/Users/dono/Workspace/./Comercial/../Pastas//', // . e .. resolvidos, barras dobradas
        'C:\\projetos', // Windows: recusado
        'C:/projetos', // Windows com barra: recusado
        '/', // a raiz: recusada
        '//', // a raiz com barra dobrada: recusada
        '/..', // vira a raiz: recusada
        'repos/relativo', // relativo: recusado
        '~/repos', // til nao expande: recusado
        '/Users/dono/a;b', // caractere ruim na pasta: recusado
        42, null,
      ],
    },
  });
  assert.deepEqual(raizes, ['/Users/dono/repos', '/Users/dono/Workspace/Pastas']);
  assert.equal(soNaRaiz, true);
  assert.deepEqual(sessoesDoConfig({ sessoes: { raizes: ['/a/b/', '/A/B'], soNaRaiz: false } }), { raizes: ['/a/b'], soNaRaiz: false });
  assert.deepEqual(sessoesDoConfig({ sessoes: { raizes: ['C:\\x', 'D:\\', '/'] } }).raizes, [], 'so ruins = []');
  assert.deepEqual(sessoesDoConfig({}).raizes, [], 'sem o bloco = []');
});

test('M1 2. darwin: identidadeCentral com central.pasta e repo POSIX (normalizados, caixa como veio); Windows e raiz caem', () => {
  assert.deepEqual(identidadeCentral({}, { repo: '/Users/Dono/repos/sessoes-wpp/' }), {
    pasta: '/Users/Dono/repos/sessoes-wpp', nome: 'Central do Tele Control', modoPermissao: 'pedir',
  });
  assert.equal(identidadeCentral({ central: { pasta: '/Users/dono/central/../Central' } }, { repo: '/x/y' }).pasta, '/Users/dono/Central', 'a pasta do config ganha do repo');
  assert.equal(identidadeCentral({ central: { pasta: 'C:\\central' } }, { repo: '/Users/dono/repos/sessoes-wpp' }).pasta, '/Users/dono/repos/sessoes-wpp', 'pasta Windows cai no repo');
  assert.equal(identidadeCentral({ central: { pasta: '/' } }, { repo: 'C:\\projetos\\sessoes-wpp' }).pasta, null, 'raiz e repo Windows = null');
  assert.equal(identidadeCentral({ central: { nome: 'Central Mac', modoPermissao: 'sozinha' } }, { repo: '/r' }).nome, 'Central Mac');
});

test('M1 3. darwin: claudeDoConfig testa claude.bin, CLAUDE_BIN, $HOME/.local/bin/claude e o PATH (por :) na ordem, sem exigir .exe; nenhum = o do HOME; sem HOME = claude', () => {
  const vistos = [];
  const nenhum = (p) => { vistos.push(p); return false; };
  const env = {
    HOME: ' /Users/dono ', CLAUDE_BIN: '/opt/duble/claude', PATH: '/opt/homebrew/bin: /usr/local/bin ::relativo:/usr/bin/',
  };
  const cfg = { claude: { bin: '/Applications/Claude/claude' } };
  assert.equal(claudeDoConfig(cfg, { env, existe: nenhum }), '/Users/dono/.local/bin/claude', 'nenhum existe = o do HOME');
  assert.deepEqual(vistos, [
    '/Applications/Claude/claude', '/opt/duble/claude', '/Users/dono/.local/bin/claude',
    '/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/usr/bin/claude',
  ], 'os 4 candidatos na ordem; o PATH por :, aparado, sem vazio nem relativo');
  // o 1o que existe ganha, na ordem
  const so = (alvo) => (p) => p === alvo;
  assert.equal(claudeDoConfig(cfg, { env, existe: so('/usr/local/bin/claude') }), '/usr/local/bin/claude');
  assert.equal(claudeDoConfig(cfg, { env, existe: () => true }), '/Applications/Claude/claude');
  assert.equal(claudeDoConfig({}, { env, existe: so('/opt/duble/claude') }), '/opt/duble/claude');
  // claude.bin do Windows, com .exe ou com caractere ruim: pulado (nem pergunta ao disco)
  const vistos2 = [];
  const conta = (p) => { vistos2.push(p); return false; };
  claudeDoConfig({ claude: { bin: 'C:\\Users\\dono\\.local\\bin\\claude.exe' } }, { env: { CLAUDE_BIN: '/a/"b"/claude' }, existe: conta });
  assert.deepEqual(vistos2, [], 'Windows e aspas nao sao candidatos');
  // `existe` que lanca = nao existe
  assert.equal(claudeDoConfig(cfg, { env, existe: () => { throw new Error('x'); } }), '/Users/dono/.local/bin/claude');
  // sem HOME (ou HOME relativo) = 'claude'; o PATH ainda vale
  assert.equal(claudeDoConfig({}, { env: {}, existe: nenhum }), 'claude');
  assert.equal(claudeDoConfig({}, { env: { HOME: 'relativo' }, existe: nenhum }), 'claude');
  assert.equal(claudeDoConfig({}, { env: { PATH: '/opt/homebrew/bin' }, existe: so('/opt/homebrew/bin/claude') }), '/opt/homebrew/bin/claude');
  // USERPROFILE (Windows) nao vale no Mac
  assert.equal(claudeDoConfig({}, { env: { USERPROFILE: 'C:\\Users\\dono' }, existe: nenhum }), 'claude');
});

test('M1 4. darwin: orcaDoConfig (so o orca.bin POSIX que existe, sem padrao), bancoVsCodeDoConfig, transcricaoDoConfig (python3) e travasDoConfig com POSIX', () => {
  // orca: so o do config, POSIX absoluto e existente; senao null (no Mac nao tem caminho padrao)
  const orca = '/Applications/Orca.app/Contents/Resources/bin/orca';
  assert.equal(orcaDoConfig({ orca: { bin: orca } }, { existe: (p) => p === orca }), orca);
  assert.equal(orcaDoConfig({ orca: { bin: orca } }, { existe: () => false }), null, 'nao existe = null');
  assert.equal(orcaDoConfig({}, { env: { LOCALAPPDATA: '/Users/dono/AppData' }, existe: () => true }), null, 'sem padrao no Mac');
  assert.equal(orcaDoConfig({ orca: { bin: 'C:\\orca\\orca.exe' } }, { existe: () => true }), null, 'Windows = null');
  assert.equal(orcaDoConfig({ orca: { bin: '/a/%x%/orca' } }, { existe: () => true }), null, 'caractere ruim = null');
  // banco do VS Code: POSIX absoluto, normalizado, que nao termina em /
  const banco = '/Users/dono/Library/Application Support/Code/User/globalStorage/state.vscdb';
  assert.equal(bancoVsCodeDoConfig({ vscode: { banco: `  ${banco}  ` } }), banco);
  assert.equal(bancoVsCodeDoConfig({ vscode: { banco: '/Users/dono/x/../Code//state.vscdb' } }), '/Users/dono/Code/state.vscdb');
  for (const ruim of ['/Users/dono/Code/', '/', 'C:\\Code\\state.vscdb', 'Code/state.vscdb', '/a/"b".vscdb']) {
    assert.equal(bancoVsCodeDoConfig({ vscode: { banco: ruim } }), null, ruim);
  }
  // python: POSIX absoluto sem .exe; senao SESSOES_WPP_PYTHON; senao python3
  assert.equal(transcricaoDoConfig({ transcricao: { python: ' /opt/homebrew/bin/python3 ' } }).python, '/opt/homebrew/bin/python3');
  assert.equal(transcricaoDoConfig({ transcricao: { python: 'C:\\py\\python.exe' } }, { env: { SESSOES_WPP_PYTHON: ' /venv/bin/python ' } }).python, '/venv/bin/python');
  assert.equal(transcricaoDoConfig({ transcricao: { python: '/a/py;rm' } }).python, 'python3', 'caractere ruim cai no padrao');
  assert.equal(transcricaoDoConfig({}).python, 'python3', 'padrao do Mac');
  assert.equal(transcricaoDoConfig({}).idioma, 'pt', 'o resto nao muda');
  // travas: POSIX absoluto, normalizado, terminado no fim certo
  assert.deepEqual(travasDoConfig({
    travas: { lib: ' /Users/dono/.claude/hooks/lib/../lib/trava.cjs ', deployMarker: '/Users/dono/.claude/m.json', disparoLedger: 'C:\\x\\l.json' },
  }), { lib: '/Users/dono/.claude/hooks/lib/trava.cjs', deployMarker: '/Users/dono/.claude/m.json', disparoLedger: null });
  assert.deepEqual(travasDoConfig({ travas: { lib: '/x/trava.txt', deployMarker: 'rel/m.json', disparoLedger: '/x/<l>.json' } }), {
    lib: null, deployMarker: null, disparoLedger: null,
  });
});

test('M1 5. darwin: pastaNormal, mesmaPasta (sem caso), raizDaPasta, pastaCurta, os nomes das pastas na frase e o hook da central com /', () => {
  assert.equal(pastaNormal(' /Users/dono/repos/ '), '/Users/dono/repos');
  assert.equal(pastaNormal('/Users/dono/./repos//x/../y///'), '/Users/dono/repos/y');
  assert.equal(pastaNormal('/'), '/', 'a raiz fica');
  assert.equal(pastaNormal('C:\\projetos'), null);
  assert.equal(pastaNormal('c:/projetos'), null);
  assert.equal(pastaNormal('repos/x'), null);
  assert.equal(pastaNormal(''), null);
  assert.equal(pastaNormal(undefined), null);
  assert.equal(mesmaPasta('/Users/Dono/Repos', '/users/dono/repos/'), true, 'sem caso, sem a barra do fim');
  assert.equal(mesmaPasta('/Users/dono/repos', '/Users/dono/repos2'), false);
  assert.equal(mesmaPasta('/Users/dono/repos', 'C:\\Users\\dono\\repos'), false);
  const raizes = ['C:\\projetos', '/Users/dono/Workspace', '/Users/dono/repos/'];
  assert.equal(raizDaPasta('/users/dono/REPOS/sessoes-wpp/lib', raizes), '/Users/dono/repos', 'devolve a raiz normalizada');
  assert.equal(raizDaPasta('/Users/dono/repos', raizes), '/Users/dono/repos', 'a propria raiz');
  assert.equal(raizDaPasta('/Users/dono/repos2/x', raizes), null, 'prefixo sem a barra nao conta');
  assert.equal(raizDaPasta('C:\\projetos\\x', raizes), null, 'Windows nao casa no Mac');
  assert.equal(pastaCurta('/Users/dono/repos/sessoes-wpp/lib', raizes), 'repos/sessoes-wpp/lib');
  assert.equal(pastaCurta('/Users/dono/Workspace', raizes), 'Workspace');
  assert.equal(pastaCurta('/Users/dono/Outra/coisa', raizes), 'coisa', 'fora das raizes = o ultimo nome');
  assert.equal(pastaCurta('', raizes), 'a pasta pedida');
  assert.match(FRASES.sessaoPastaRecusada('x', ['/Users/dono/repos', '/Users/dono/Workspace', '/outro/REPOS']), /fica fora de repos e Workspace\.$/);
  assert.equal(argDoHook('/Users/dono/repos/sessoes-wpp/'), '/Users/dono/repos/sessoes-wpp/central/negar-permissao.mjs');
});

test('M1 6. volta pra win32 no mesmo arquivo: as mesmas funcoes dao o de hoje com C:\\ e recusam POSIX; desfazer volta pro darwin', () => {
  assert.throws(() => trocarPlataformaParaTeste('linux'), TypeError);
  assert.throws(() => trocarPlataformaParaTeste(undefined), TypeError);
  assert.equal(plataforma(), 'darwin', 'troca ruim nao muda nada');
  const voltar = trocarPlataformaParaTeste('win32');
  try {
    assert.equal(plataforma(), 'win32');
    assert.equal(ehMac(), false);
    assert.equal(caminhos(), path.win32);
    assert.deepEqual(sessoesDoConfig({ sessoes: { raizes: ['c:/Projetos/', 'C:\\projetos', '/Users/dono/repos', 'C:\\'] } }).raizes, ['C:\\Projetos']);
    assert.equal(identidadeCentral({}, { repo: '/Users/dono/repos/sessoes-wpp' }).pasta, null, 'POSIX recusado');
    assert.equal(identidadeCentral({}, { repo: 'c:\\projetos\\sessoes-wpp\\' }).pasta, 'C:\\projetos\\sessoes-wpp');
    const env = { USERPROFILE: 'C:\\Users\\dono', HOME: '/Users/dono', PATH: '/opt/homebrew/bin' };
    assert.equal(claudeDoConfig({ claude: { bin: '/opt/claude' } }, { env, existe: () => true }), 'C:\\Users\\dono\\.local\\bin\\claude.exe', 'POSIX pulado; o do instalador existe');
    assert.equal(claudeDoConfig({}, { env: { HOME: '/Users/dono' }, existe: () => false }), 'claude.exe');
    assert.equal(orcaDoConfig({ orca: { bin: '/Applications/orca' } }, { env: { LOCALAPPDATA: 'C:\\L' }, existe: () => false }), 'C:\\L\\Programs\\orca\\resources\\bin\\orca.exe');
    assert.equal(bancoVsCodeDoConfig({ vscode: { banco: '/Users/dono/state.vscdb' } }), null);
    assert.equal(bancoVsCodeDoConfig({ vscode: { banco: 'C:/Code/state.vscdb' } }), 'C:\\Code\\state.vscdb');
    assert.equal(transcricaoDoConfig({ transcricao: { python: '/opt/homebrew/bin/python3' } }).python, 'python', 'padrao do Windows');
    assert.equal(transcricaoDoConfig({ transcricao: { python: 'C:\\py\\python.exe' } }).python, 'C:\\py\\python.exe');
    assert.deepEqual(travasDoConfig({ travas: { lib: '/x/trava.cjs', deployMarker: 'C:/x/m.json' } }), { lib: null, deployMarker: 'C:\\x\\m.json', disparoLedger: null });
    assert.equal(pastaNormal('/Users/dono'), null);
    assert.equal(pastaNormal('c:/a/b/'), 'c:\\a\\b');
    assert.equal(mesmaPasta('C:\\Projetos', 'c:/projetos/'), true);
    assert.equal(raizDaPasta('c:\\projetos\\x', ['/Users/dono/repos', 'C:\\Projetos']), 'C:\\Projetos');
    assert.equal(pastaCurta('C:\\projetos\\sessoes-wpp\\lib', ['C:\\projetos']), 'projetos\\sessoes-wpp\\lib');
    assert.match(FRASES.sessaoPastaRecusada('x', ['C:\\projetos', 'G:\\Nuvem\\Workspace']), /fica fora de projetos e Workspace\.$/);
    assert.equal(argDoHook('C:\\projetos\\sessoes-wpp'), 'C:\\projetos\\sessoes-wpp\\central\\negar-permissao.mjs');
  } finally {
    voltar();
  }
  assert.equal(plataforma(), 'darwin', 'desfazer volta pro darwin');
  assert.equal(pastaNormal('/Users/dono/'), '/Users/dono');
});
