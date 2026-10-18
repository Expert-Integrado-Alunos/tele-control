// Testes da A3a (PLANO-ABERTO.md, "A3a — pastas de projeto, central e o claude"): as pastas de projeto, a central e o
// claude.exe pelo config.json.
// Por que existe: as 2 pastas de projeto do dono (a de codigo e a de documentos), o nome e a pasta da central e o caminho do
// claude.exe saem do codigo e passam a vir do config.json (blocos `sessoes`, `central` e `claude`), pra copia aberta
// servir a qualquer pessoa; o que nao vem do config sai da pasta do proprio repositorio. Valor trocado aqui = sessao
// aberta na pasta errada, central que o porteiro nao reconhece (a fala do dono sem destino) ou o claude errado.
// Isolamento: pastas temporarias (prefixo "a3a-"); spawn dublado nos abridores (nada de wscript, wt.exe ou claude real);
// o abrir-central.vbs roda pelo cscript em modo ensaio (escreve o que faria e sai), e so o .vbs que tem o ensaio (ver o
// rodarVbs); o esconder-central.ps1 so pelo fonte (rodar esconderia janela de verdade se a guarda quebrasse). Nada de
// rede, config.json real nem porteiro rodando.
// Os modulos entram por `import * as`: funcao que ainda nao existe deixa so o teste dela vermelho.
// Rodar: node --test --test-reporter=tap "tests/a3a.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pastaTemp } from './lib/pasta-temp.cjs';
import * as config from '../lib/config.mjs';
import * as porteiro from '../porteiro.mjs';
import * as abas from '../abas.mjs';
import * as mensageiro from '../mensageiro.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');
const VBS_CENTRAL = path.join(REPO, 'central', 'abrir-central.vbs');
const PS1_ESCONDER = path.join(REPO, 'central', 'esconder-central.ps1');
const ABAS = path.join(REPO, 'abas.mjs');
const CSCRIPT = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cscript.exe');
const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-14T19:00:00Z'); // 16:00 em Brasilia
const iso = (ms) => new Date(ms).toISOString();
const CAB = '🎛️ *Controle de sessões*'; // a voz do controle e 🎛️ (pedido do dono)
const PADRAO = 'Central do Tele Control';
// O nome antigo da central do dono, montado por pedacos: as assercoes negativas (12 e 13) provam que esse literal nao
// volta pros arquivos da central nem pro porteiro (e o 8, que ele nao e especial no listarFechadas); o nome inteiro nao
// pode aparecer neste arquivo (termo proibido na copia aberta).
const NOME_DONO = ['Controle de sessoes', ' pelo WhatsApp'].join('');
// Os literais de antes no codigo (a pasta de projetos e a pasta do Drive do dono), montados por pedacos pelo mesmo
// motivo: as assercoes negativas (12 e 13) provam que nao voltam.
const PASTA_ANTIGA = ['C:\\', 'repos'].join('');
const DRIVE_ANTIGO = ['claude', '-workspace'].join('');
const RAIZES_DONO = ['C:\\projetos', 'D:\\Meus Docs\\trabalho\\Area'];
// A letra do disco maiuscula (o que o identidadeCentral devolve pra pasta do repositorio)
const REPO_NORMAL = REPO[0].toUpperCase() + REPO.slice(1);

// ---------- 1-3. config ----------

test('A3a 1. sessoesDoConfig: as pastas absolutas boas, normalizadas (letra maiuscula, sem barra no fim, . e .. resolvidos), sem repetir, no maximo 20, na ordem; o resto fica de fora; soNaRaiz so false com === false', () => {
  const { sessoesDoConfig } = config;
  assert.equal(typeof sessoesDoConfig, 'function');
  // o config do dono
  assert.deepEqual(sessoesDoConfig({ sessoes: { raizes: RAIZES_DONO, soNaRaiz: true } }), { raizes: RAIZES_DONO, soNaRaiz: true });
  // normalizacao, cada uma sozinha
  const normais = [
    ['c:\\projetos', 'C:\\projetos'], ['C:/projetos/', 'C:\\projetos'], ['C:\\projetos\\\\', 'C:\\projetos'], ['  D:\\proj  ', 'D:\\proj'],
    ['C:\\projetos\\x\\..', 'C:\\projetos'], ['d:\\Meus Docs\\.\\W', 'D:\\Meus Docs\\W'], ['C:\\a//b\\c', 'C:\\a\\b\\c'],
    ['e:\\Pasta (2)\\x-y_z.1', 'E:\\Pasta (2)\\x-y_z.1'],
  ];
  for (const [bruta, esperada] of normais) {
    assert.deepEqual(sessoesDoConfig({ sessoes: { raizes: [bruta] } }).raizes, [esperada], JSON.stringify(bruta));
  }
  // fora: relativa, sem disco, rede, so o disco, a raiz do disco, caractere ruim, nao-texto
  const ruins = [
    'repos', '.\\repos', '\\repos', '/repos', '\\\\servidor\\pasta', '//servidor/pasta', 'C:', 'C:repos', 'C:\\', 'C:/',
    'c:\\..', 'C:\\projetos\\..\\..', '', '   ', 'C:\\re"pos', 'C:\\%USERPROFILE%', 'C:\\a;b', 'C:\\a<b', 'C:\\a>b',
    'C:\\a|b', 'C:\\a*', 'C:\\a?', 'C:\\a\nb', 'C:\\a\rb', 'C:\\a\tb', 'C:\\a\u0000b', 'C:\\a\u007fb', '1:\\x', 'CD:\\x',
    5, null, undefined, true, {}, ['C:\\projetos'],
  ];
  for (const r of ruins) {
    assert.deepEqual(sessoesDoConfig({ sessoes: { raizes: [r] } }).raizes, [], JSON.stringify(r));
  }
  // os bons seguem com os ruins no meio, na ordem do config
  assert.deepEqual(sessoesDoConfig({ sessoes: { raizes: ['x', 'D:\\b', 5, 'C:\\a', 'C:\\'] } }).raizes, ['D:\\b', 'C:\\a']);
  // sem repetir (sem caso, depois de normalizar): fica a 1a
  assert.deepEqual(sessoesDoConfig({ sessoes: { raizes: ['C:\\projetos', 'c:\\PROJETOS\\', 'C:/projetos', 'D:\\x', 'd:\\X'] } }).raizes,
    ['C:\\projetos', 'D:\\x']);
  // no maximo 20 (as 20 primeiras boas)
  const muitas = Array.from({ length: 25 }, (_, i) => `D:\\p${i}`);
  assert.deepEqual(sessoesDoConfig({ sessoes: { raizes: ['ruim', ...muitas] } }).raizes, muitas.slice(0, 20));
  // soNaRaiz: so false com === false
  for (const v of [true, undefined, null, 'false', 0, '', 'nao', {}]) {
    const s = { raizes: ['C:\\projetos'] };
    if (v !== undefined) s.soNaRaiz = v;
    assert.equal(sessoesDoConfig({ sessoes: s }).soNaRaiz, true, JSON.stringify(v));
  }
  assert.equal(sessoesDoConfig({ sessoes: { raizes: ['C:\\projetos'], soNaRaiz: false } }).soNaRaiz, false);
  // um campo ruim nao derruba o outro
  assert.deepEqual(sessoesDoConfig({ sessoes: { raizes: 'C:\\projetos', soNaRaiz: false } }), { raizes: [], soNaRaiz: false });
  // cfg ou bloco ruim: nada e o padrao
  for (const cfg of [{}, null, undefined, 42, 'x', [], [{ sessoes: { raizes: RAIZES_DONO } }], { sessoes: null },
    { sessoes: [] }, { sessoes: 'C:\\projetos' }, { sessoes: { raizes: null } }, { sessoes: { raizes: {} } }]) {
    assert.deepEqual(sessoesDoConfig(cfg), { raizes: [], soNaRaiz: true }, JSON.stringify(cfg));
  }
});

test('A3a 2. identidadeCentral: o nome do config (aparado, so ASCII no formato) senao PADRAO_CENTRAL; a pasta do config com as regras de uma raiz senao a do repositorio; um campo ruim nao derruba o outro', () => {
  const { identidadeCentral, PADRAO_CENTRAL } = config;
  assert.equal(typeof identidadeCentral, 'function');
  assert.deepEqual(PADRAO_CENTRAL, { nome: PADRAO });
  assert.ok(Object.isFrozen(PADRAO_CENTRAL));
  const repo = 'D:\\clones\\tele-control';
  // o config do dono
  // (A5d: + modoPermissao, 'pedir' sem o campo; o modo tem o teste dele em tests/a5d.test.mjs)
  assert.deepEqual(identidadeCentral({ central: { pasta: 'C:\\projetos', nome: NOME_DONO } }, { repo }), { pasta: 'C:\\projetos', nome: NOME_DONO, modoPermissao: 'pedir' });
  // sem config: o padrao na pasta do repositorio
  assert.deepEqual(identidadeCentral({}, { repo }), { pasta: repo, nome: PADRAO, modoPermissao: 'pedir' });
  // nomes bons (aparado; limites 1 e 60)
  for (const [bruto, nome] of [['  Minha Central  ', 'Minha Central'], ['A', 'A'], ['9', '9'], [`A${'b'.repeat(59)}`, `A${'b'.repeat(59)}`],
    ['Central (PC 2) v1.0_teste-x', 'Central (PC 2) v1.0_teste-x']]) {
    assert.equal(identidadeCentral({ central: { nome: bruto } }, { repo }).nome, nome, JSON.stringify(bruto));
  }
  // nomes ruins = o padrao
  for (const ruim of ['', '   ', `A${'b'.repeat(60)}`, ' -x'.trim(), '-x', '.x', '(x)', 'Central de sessões', 'Céu', 'a"b', 'a%b',
    'a;b', 'a|b', 'a/b', 'a\\b', 'a:b', 'a\nb', 'a\tb', 'a&b', 'a!b', 'a,b', 5, null, true, {}, ['x']]) {
    assert.equal(identidadeCentral({ central: { pasta: 'C:\\projetos', nome: ruim } }, { repo }).nome, PADRAO, JSON.stringify(ruim));
  }
  // pasta: as regras de uma raiz (normalizada); ruim = a do repositorio
  assert.equal(identidadeCentral({ central: { pasta: 'c:/projetos/' } }, { repo }).pasta, 'C:\\projetos');
  for (const ruim of ['repos', 'C:\\', 'C:\\a;b', 'C:\\a"b', 'C:\\%x%', '\\\\srv\\x', '', 5, null]) {
    const r = identidadeCentral({ central: { pasta: ruim, nome: 'Minha Central' } }, { repo });
    assert.deepEqual(r, { pasta: repo, nome: 'Minha Central', modoPermissao: 'pedir' }, JSON.stringify(ruim));
  }
  // o repositorio tambem passa pelas regras (normalizado); ruim e sem pasta no config = null
  assert.equal(identidadeCentral({}, { repo: 'd:/clones/tele-control/' }).pasta, 'D:\\clones\\tele-control');
  for (const r of ['relativa', 'D:\\a;b', 'C:\\', null, undefined, 5]) {
    assert.equal(identidadeCentral({}, { repo: r }).pasta, null, JSON.stringify(r));
  }
  assert.equal(identidadeCentral({ central: { pasta: 'E:\\c' } }, { repo: null }).pasta, 'E:\\c', 'a do config nao depende do repo');
  assert.deepEqual(identidadeCentral({}), { pasta: null, nome: PADRAO, modoPermissao: 'pedir' }, 'sem o 2o argumento');
  // cfg ou bloco ruim: o padrao
  for (const cfg of [null, undefined, 42, 'x', [], { central: null }, { central: [] }, { central: 'C:\\projetos' }]) {
    assert.deepEqual(identidadeCentral(cfg, { repo }), { pasta: repo, nome: PADRAO, modoPermissao: 'pedir' }, JSON.stringify(cfg));
  }
});

test('A3a 3. claudeDoConfig: claude.bin > CLAUDE_BIN > %USERPROFILE%\\.local\\bin\\claude.exe > o 1o claude.exe do PATH; so absoluto, .exe, sem caractere ruim e que existe; nenhum = o local mesmo assim; sem USERPROFILE = claude.exe; nunca lanca', () => {
  const { claudeDoConfig } = config;
  assert.equal(typeof claudeDoConfig, 'function');
  const PERFIL = 'C:\\Users\\Pessoa Teste';
  const LOCAL = `${PERFIL}\\.local\\bin\\claude.exe`;
  const BIN = 'D:\\ferramentas\\claude.exe';
  const DUBLE = 'D:\\duble\\claude.exe';
  const P1 = 'E:\\npm\\claude.exe';
  const P2 = 'F:\\outro\\claude.exe';
  const env = { USERPROFILE: PERFIL, CLAUDE_BIN: DUBLE, Path: 'E:\\vazia;E:\\npm;F:\\outro' };
  const existeEm = (lista) => (p) => lista.some((x) => x.toLowerCase() === String(p).toLowerCase());
  const todos = existeEm([BIN, DUBLE, LOCAL, P1, P2]);
  // a ordem: cada um some e o seguinte vale
  assert.equal(claudeDoConfig({ claude: { bin: BIN } }, { env, existe: todos }), BIN);
  assert.equal(claudeDoConfig({}, { env, existe: todos }), DUBLE);
  assert.equal(claudeDoConfig({}, { env: { ...env, CLAUDE_BIN: undefined }, existe: todos }), LOCAL);
  assert.equal(claudeDoConfig({}, { env: { ...env, CLAUDE_BIN: '' }, existe: existeEm([P1, P2]) }), P1, 'o 1o do PATH que existe');
  assert.equal(claudeDoConfig({}, { env: { ...env, CLAUDE_BIN: '' }, existe: existeEm([P2]) }), P2);
  // existir conta: o do config que nao existe passa a vez
  assert.equal(claudeDoConfig({ claude: { bin: BIN } }, { env, existe: existeEm([DUBLE]) }), DUBLE);
  // a chave do PATH sem caso; pasta entre aspas perde as aspas; pasta vazia ou ruim e pulada
  for (const chave of ['PATH', 'Path', 'path']) {
    const e = { USERPROFILE: PERFIL, [chave]: ';"E:\\com espaco";E:\\npm' };
    assert.equal(claudeDoConfig({}, { env: e, existe: existeEm(['E:\\com espaco\\claude.exe', P1]) }), 'E:\\com espaco\\claude.exe', chave);
  }
  assert.equal(claudeDoConfig({}, { env: { USERPROFILE: PERFIL, Path: 'relativa;E:\\%X%;E:\\npm' }, existe: () => true }),
    LOCAL, 'o local vem antes do PATH');
  assert.equal(claudeDoConfig({}, { env: { Path: 'relativa;E:\\%X%;E:\\npm' }, existe: () => true }), P1, 'sem USERPROFILE: o PATH');
  // so absoluto (X:\), terminado em .exe (sem caso), sem aspas, % nem caractere de controle: senao passa a vez (mesmo existindo)
  for (const ruim of ['claude.exe', '.\\claude.exe', '\\\\srv\\c\\claude.exe', 'D:\\x\\claude', 'D:\\x\\claude.cmd', 'D:\\x\\claude.exe.txt',
    'D:\\x"\\claude.exe', 'D:\\%X%\\claude.exe', 'D:\\x;y\\claude.exe', 'D:\\x\n\\claude.exe', 'D:\\x\t\\claude.exe', '', 5, null, {}]) {
    assert.equal(claudeDoConfig({ claude: { bin: ruim } }, { env: { USERPROFILE: PERFIL }, existe: () => true }), LOCAL, JSON.stringify(ruim));
    assert.equal(claudeDoConfig({}, { env: { USERPROFILE: PERFIL, CLAUDE_BIN: ruim }, existe: () => true }), LOCAL, `CLAUDE_BIN ${JSON.stringify(ruim)}`);
  }
  assert.equal(claudeDoConfig({ claude: { bin: 'D:\\X\\CLAUDE.EXE' } }, { env: {}, existe: () => true }), 'D:\\X\\CLAUDE.EXE', '.EXE vale');
  // nenhum: o local mesmo assim; sem USERPROFILE = claude.exe
  assert.equal(claudeDoConfig({ claude: { bin: BIN } }, { env, existe: () => false }), LOCAL);
  assert.equal(claudeDoConfig({}, { env: { Path: 'E:\\npm' }, existe: () => false }), 'claude.exe');
  // existe que lanca = nao existe; nunca lanca
  assert.equal(claudeDoConfig({ claude: { bin: BIN } }, { env, existe: () => { throw new Error('x'); } }), LOCAL);
  for (const cfg of [null, undefined, 5, 'x', [], { claude: null }, { claude: 'D:\\x\\claude.exe' }]) {
    assert.equal(claudeDoConfig(cfg, { env, existe: todos }), DUBLE, JSON.stringify(cfg));
  }
  for (const e of [null, undefined, 5, 'x']) assert.equal(typeof claudeDoConfig({}, { env: e, existe: () => false }), 'string');
  // o existe de verdade (arquivo; pasta nao serve) e o env padrao (process.env)
  const dir = pastaTemp('a3a-claude-');
  const exe = path.join(dir, 'claude.exe');
  fs.writeFileSync(exe, '');
  fs.mkdirSync(path.join(dir, 'pasta.exe'));
  assert.equal(claudeDoConfig({ claude: { bin: exe } }, { env: {} }), exe);
  assert.equal(claudeDoConfig({ claude: { bin: path.join(dir, 'pasta.exe') } }, { env: {} }), 'claude.exe', 'pasta nao e o claude');
  assert.equal(claudeDoConfig({ claude: { bin: path.join(dir, 'nao.exe') } }, { env: {} }), 'claude.exe');
  assert.equal(typeof claudeDoConfig({}), 'string');
});

// ---------- 4-6. porteiro: frases e abridores ----------

test('A3a 4. as frases da pasta (o ultimo nome de cada raiz, sem repetir) e a nota do OK com o caminho do repositorio (barras normais; aspas so com espaco)', () => {
  const { FRASES, caminhoPraComando } = porteiro;
  assert.equal(typeof caminhoPraComando, 'function');
  assert.equal(caminhoPraComando('C:\\projetos\\sessoes-wpp\\ok-wpp.mjs'), 'C:/projetos/sessoes-wpp/ok-wpp.mjs');
  assert.equal(caminhoPraComando('C:\\Users\\Pessoa Teste\\tele-control\\ok-wpp.mjs'), '"C:/Users/Pessoa Teste/tele-control/ok-wpp.mjs"');
  const ok = caminhoPraComando(path.join(REPO, 'ok-wpp.mjs'));
  assert.equal(FRASES.notaPedidoOk('ABC234'),
    `Resposta ao seu pedido de OK ABC234. Antes de agir, rode: node ${ok} verificar ABC234 (so age com status ok).`);
  assert.ok(!FRASES.notaPedidoOk('ABC234').includes('\\'), 'sem barra invertida');
  const N = 'Revisão';
  const fora = (nomes) => `${CAB}\nNão abri a sessão ${N}: a pasta não existe ou fica fora de ${nomes}.`;
  assert.equal(FRASES.sessaoPastaRecusada(N, []), `${CAB}\nNão abri a sessão ${N}: nenhuma pasta de projeto configurada.`);
  assert.equal(FRASES.sessaoPastaRecusada(N, ['C:\\projetos']), fora('projetos'));
  assert.equal(FRASES.sessaoPastaRecusada(N, RAIZES_DONO), fora('projetos e Area'));
  assert.equal(FRASES.sessaoPastaRecusada(N, [...RAIZES_DONO, 'D:\\clientes']), fora('projetos, Area e clientes'));
  assert.equal(FRASES.sessaoPastaRecusada(N, ['D:\\a', 'D:\\b', 'D:\\c', 'D:\\d']), fora('a, b, c e d'));
  assert.equal(FRASES.sessaoPastaRecusada(N, ['C:\\projetos', 'D:\\Projetos', 'E:\\x']), fora('projetos e x'), 'sem repetir (sem caso)');
  assert.equal(porteiro.CENTRAL_TITULO, undefined, 'o titulo fixo da central saiu');
});

// spawn falso do wscript: devolve o filho e SO DEPOIS emite 'spawn' (central, destacada) ou 'exit' 0 (escondida).
function spawnFalso(evento = 'spawn') {
  const chamadas = [];
  const fn = (cmd, args, opts) => {
    const filho = new EventEmitter();
    filho.unref = () => {};
    filho.kill = () => true;
    chamadas.push({ cmd, args, opts });
    setImmediate(() => (evento === 'exit' ? filho.emit('exit', 0, null) : filho.emit('spawn')));
    return filho;
  };
  fn.chamadas = chamadas;
  return fn;
}

// A5d2: o gravarCentral dublado (a pasta montada e o modo; o de verdade e a ordem dele estao no tests/a5d.test.mjs)
const MONTADA = 'D:\\estado\\central';
const MONTAR = (o) => ({ pasta: MONTADA, modo: o.modo });

test('A3a 5. abrirCentralReal: wscript //nologo abrir-central.vbs <pasta> <nome> <claude> <montada> <modo>, destacado; a central passa pelo identidadeCentral (nome ruim = o padrao; pasta ruim = a do repositorio); sem claude = claudeDoConfig({}); claude ruim = rejeita sem rodar nada', async () => {
  const log = () => {};
  const CLAUDE = 'D:\\bin\\claude.exe';
  let sp = spawnFalso();
  await porteiro.abrirCentralReal(log, { spawn: sp, gravarCentral: MONTAR, central: { pasta: 'E:\\central', nome: 'Minha Central' }, claude: CLAUDE })();
  assert.equal(sp.chamadas.length, 1);
  assert.equal(sp.chamadas[0].cmd, 'wscript.exe');
  assert.deepEqual(sp.chamadas[0].args, ['//nologo', VBS_CENTRAL, 'E:\\central', 'Minha Central', CLAUDE, MONTADA, 'auto']);
  assert.equal(sp.chamadas[0].opts.detached, true);
  assert.equal(sp.chamadas[0].opts.stdio, 'ignore');
  assert.equal(sp.chamadas[0].opts.windowsHide, true);
  // normalizada; nome ruim = o padrao; pasta ruim = a do repositorio; sem central = o padrao no repositorio
  for (const [central, pasta, nome] of [
    [{ pasta: 'e:/central/', nome: '  Minha Central ' }, 'E:\\central', 'Minha Central'],
    [{ pasta: 'E:\\central', nome: 'Céu "x"' }, 'E:\\central', PADRAO],
    [{ pasta: 'E:\\a;b', nome: 'Minha Central' }, REPO_NORMAL, 'Minha Central'],
    [null, REPO_NORMAL, PADRAO],
    [undefined, REPO_NORMAL, PADRAO],
    ['C:\\projetos', REPO_NORMAL, PADRAO],
  ]) {
    sp = spawnFalso();
    await porteiro.abrirCentralReal(log, { spawn: sp, gravarCentral: MONTAR, central, claude: CLAUDE })();
    assert.deepEqual(sp.chamadas[0].args.slice(2), [pasta, nome, CLAUDE, MONTADA, 'auto'], JSON.stringify(central));
  }
  // sem claude: o do claudeDoConfig({}) (o mesmo processo, o mesmo ambiente)
  sp = spawnFalso();
  await porteiro.abrirCentralReal(log, { spawn: sp, gravarCentral: MONTAR, central: { pasta: 'E:\\central' } })();
  assert.equal(sp.chamadas[0].args[4], config.claudeDoConfig({}, { env: process.env }));
  // claude ruim: rejeita sem rodar nada
  for (const ruim of ['', 'D:\\x"\\claude.exe', 'D:\\%X%\\claude.exe', 'D:\\x;y\\claude.exe', 'D:\\x\n\\claude.exe', 'D:\\x\r\\claude.exe', 5, {}]) {
    sp = spawnFalso();
    await assert.rejects(porteiro.abrirCentralReal(log, { spawn: sp, gravarCentral: MONTAR, central: { pasta: 'E:\\central' }, claude: ruim })(), JSON.stringify(ruim));
    assert.equal(sp.chamadas.length, 0, JSON.stringify(ruim));
  }
});

test('A3a 6. abrirSessaoEscondidaReal com claude: o ambiente do wscript leva SESSOES_WPP_CLAUDE (o abrir-sessao.vbs le); sem claude = como antes; claude ruim = rejeita sem rodar nada', async () => {
  const PASTA = 'C:\\projetos\\x';
  const CLAUDE = 'D:\\bin\\claude.exe';
  let sp = spawnFalso('exit');
  await porteiro.abrirSessaoEscondidaReal({ spawn: sp, gravarCentral: MONTAR, env: { USERPROFILE: 'C:\\Users\\P' }, claude: CLAUDE })(PASTA, 'Nova');
  assert.equal(sp.chamadas.length, 1);
  assert.equal(sp.chamadas[0].opts.env.SESSOES_WPP_CLAUDE, CLAUDE);
  assert.equal(sp.chamadas[0].opts.env.USERPROFILE, 'C:\\Users\\P');
  assert.match(sp.chamadas[0].args[1], /central[\\/]abrir-sessao\.vbs$/);
  // a retomada tambem
  sp = spawnFalso('exit');
  await porteiro.abrirSessaoEscondidaReal({ spawn: sp, gravarCentral: MONTAR, env: {}, claude: CLAUDE })(PASTA, null, { retomar: '0b3e6f2a-1c2d-4e5f-8a9b-0c1d2e3f4a5b' });
  assert.equal(sp.chamadas[0].opts.env.SESSOES_WPP_CLAUDE, CLAUDE);
  // sem claude: o ambiente como antes (sem a variavel)
  sp = spawnFalso('exit');
  await porteiro.abrirSessaoEscondidaReal({ spawn: sp, gravarCentral: MONTAR, env: { USERPROFILE: 'C:\\Users\\P' } })(PASTA, 'Nova');
  assert.equal('SESSOES_WPP_CLAUDE' in sp.chamadas[0].opts.env, false);
  // claude ruim: rejeita sem rodar nada
  for (const ruim of ['D:\\x"\\claude.exe', 'D:\\%X%\\claude.exe', 'D:\\x;y\\claude.exe', 'D:\\x\n\\claude.exe', '']) {
    sp = spawnFalso('exit');
    await assert.rejects(porteiro.abrirSessaoEscondidaReal({ spawn: sp, gravarCentral: MONTAR, env: {}, claude: ruim })(PASTA, 'Nova'), JSON.stringify(ruim));
    assert.equal(sp.chamadas.length, 0, JSON.stringify(ruim));
  }
});

// ---------- 7-9. abas.mjs ----------

const edicao = (ms, alvo) => ({
  type: 'assistant', timestamp: iso(ms),
  message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${ms}`, name: 'Edit', input: { file_path: alvo, old_string: 'a', new_string: 'b' } }] },
});

test('A3a 7. abas: RAIZ_CONTROLE = a pasta do proprio repositorio (minuscula, barra no fim); ultimaEdicaoNoControle e listarAbas usam ela por padrao e listarAbas aceita outra', () => {
  assert.equal(abas.RAIZ_CONTROLE, `${REPO.toLowerCase()}\\`);
  const desdeMs = T0 - 24 * 60 * MIN;
  assert.equal(abas.ultimaEdicaoNoControle([edicao(T0 - MIN, path.join(REPO, 'porteiro.mjs'))], { desdeMs }), T0 - MIN);
  assert.equal(abas.ultimaEdicaoNoControle([edicao(T0 - MIN, `${REPO}-outro\\porteiro.mjs`)], { desdeMs }), null);
  // listarAbas: a raiz passada vale no lugar da do repositorio
  const raiz = pastaTemp('a3a-abas-');
  const sessions = path.join(raiz, 'sessions');
  const projects = path.join(raiz, 'projects');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(path.join(projects, 'D--proj'), { recursive: true });
  fs.writeFileSync(path.join(sessions, '100.json'), JSON.stringify({
    pid: process.pid, sessionId: 'A', cwd: 'D:\\proj', entrypoint: 'claude-vscode', status: 'idle', updatedAt: T0 - MIN,
  }));
  fs.writeFileSync(path.join(projects, 'D--proj', 'A.jsonl'),
    `${JSON.stringify({ type: 'custom-title', customTitle: 'Aba A', sessionId: 'A' })}\n${JSON.stringify(edicao(T0 - 5 * MIN, 'D:\\proj\\x.mjs'))}\n`);
  const env = { CLAUDE_SESSIONS_DIR: sessions, CLAUDE_PROJECTS_DIR: projects };
  const vivo = (pid) => Number(pid) === process.pid;
  assert.deepEqual(abas.listarAbas({ env, agora: T0, controle: true, pidVivo: vivo, raiz: 'D:\\proj\\' }).map((x) => x.sessionId), ['A']);
  assert.deepEqual(abas.listarAbas({ env, agora: T0, controle: true, pidVivo: vivo }), [], 'a raiz padrao e a do repositorio');
});

function conversaFechada(projects, dir, sid, { titulo, ultima, entrypoint = 'cli', cwd = 'c:\\projetos' }) {
  fs.mkdirSync(path.join(projects, dir), { recursive: true });
  const arq = path.join(projects, dir, `${sid}.jsonl`);
  fs.writeFileSync(arq, [
    { type: 'custom-title', customTitle: titulo, sessionId: sid },
    { type: 'user', sessionId: sid, entrypoint, cwd, timestamp: iso(ultima - MIN), message: { role: 'user', content: 'oi' } },
  ].map((l) => `${JSON.stringify(l)}\n`).join(''));
  fs.utimesSync(arq, new Date(ultima), new Date(ultima));
}

test('A3a 8. listarFechadas({nomeCentral}): a central sai pelo nome (sem acento e sem caso); padrao = PADRAO_CENTRAL; o nome antigo do dono nao e especial', () => {
  const raiz = pastaTemp('a3a-fechadas-');
  const sessions = path.join(raiz, 'sessions');
  const projects = path.join(raiz, 'projects');
  fs.mkdirSync(sessions, { recursive: true });
  conversaFechada(projects, 'c--projetos', 'P', { titulo: PADRAO, ultima: T0 - 10 * MIN });
  conversaFechada(projects, 'c--projetos', 'E', { titulo: 'Controle de sessões pelo WhatsApp', ultima: T0 - 20 * MIN });
  conversaFechada(projects, 'c--projetos', 'M', { titulo: 'minha central', ultima: T0 - 30 * MIN });
  const env = { CLAUDE_SESSIONS_DIR: sessions, CLAUDE_PROJECTS_DIR: projects };
  const ids = (o) => abas.listarFechadas({ env, agora: T0, pidVivo: () => false, ...o }).map((x) => x.sessionId);
  assert.deepEqual(ids({}), ['E', 'M'], 'padrao: sai a do Tele Control');
  assert.deepEqual(ids({ nomeCentral: 'Minha Central' }), ['P', 'E'], 'a do config (sem caso)');
  assert.deepEqual(ids({ nomeCentral: NOME_DONO }), ['P', 'M'], 'a do dono (sem acento)');
});

test('A3a 9. abas.mjs --fechadas: a linha de comando le o nome da central do config.json da pasta de estado (SESSOES_WPP_DIR); sem config = o padrao', () => {
  const raiz = pastaTemp('a3a-fechadas-cli-');
  const sessions = path.join(raiz, 'sessions');
  const projects = path.join(raiz, 'projects');
  const estado = path.join(raiz, 'estado');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(estado, { recursive: true });
  const agora = Date.now();
  conversaFechada(projects, 'c--projetos', 'P', { titulo: PADRAO, ultima: agora - 10 * MIN });
  conversaFechada(projects, 'c--projetos', 'M', { titulo: 'Minha Central', ultima: agora - 20 * MIN });
  const rodar = () => spawnSync(process.execPath, [ABAS, '--fechadas'], {
    env: { ...process.env, CLAUDE_SESSIONS_DIR: sessions, CLAUDE_PROJECTS_DIR: projects, SESSOES_WPP_DIR: estado },
    encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  const ids = (r) => [...r.stdout.matchAll(/sessionId (\w+)/g)].map((m) => m[1]);
  let r = rodar();
  assert.equal(r.status, 0);
  assert.deepEqual(ids(r), ['M'], 'sem config: sai a do padrao');
  fs.writeFileSync(path.join(estado, 'config.json'), JSON.stringify({ central: { nome: 'Minha Central', pasta: 'C:\\projetos' } }));
  r = rodar();
  assert.equal(r.status, 0);
  assert.deepEqual(ids(r), ['P'], 'com config: sai a do config');
});

// ---------- 10. mensageiro ----------

test('A3a 10. criarMensageiro sem claudeBin = o claudeDoConfig({}) do ambiente (o mesmo claude da central e da escondida)', async () => {
  const chamadas = [];
  const spawn = (bin, args, opts) => {
    chamadas.push({ bin, args, opts });
    const filho = new EventEmitter();
    filho.stdout = new EventEmitter();
    filho.stderr = new EventEmitter();
    filho.kill = () => true;
    setImmediate(() => {
      filho.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ENVIADO' })));
      filho.emit('close', 0, null);
    });
    return filho;
  };
  const m = mensageiro.criarMensageiro({ spawn, estadoDir: pastaTemp('a3a-mens-'), dormir: async () => {} });
  const r = await m.entregar({
    sessionId: 's-x', nome: 'repos-x', titulo: 'X', texto: 'oi', audio: false, hora: '16:00', providerMsgId: 'P1', messageId: 'u1', anexos: [],
  });
  assert.equal(r.status, 'enviado');
  assert.equal(chamadas[0].bin, config.claudeDoConfig({}, { env: process.env }));
});

// ---------- 11-12. os arquivos da central ----------

// cscript no abrir-central.vbs: SESSOES_WPP_VBS_ENSAIO=1 (so escreve o que faria) e LOCALAPPDATA temporario (nada gravado
// la). O PATH vazio NAO segura nada: o WScript.Shell.Run acha o wt.exe sem o PATH (medido 14/10/2026 16:45, na fase
// vermelha da A3a: o abrir-central.vbs antigo, sem o ensaio e com o claude fixo, rodou de verdade e abriu 3 centrais a
// mais, fechadas na mao). Por isso o teste so roda o .vbs que tem o ensaio e recebe o claude por argumento (o dos testes
// e um arquivo vazio numa pasta temporaria); o resto falha sem rodar nada.
function vbsTemEnsaio() {
  const fonte = fs.readFileSync(VBS_CENTRAL, 'utf8');
  return /SESSOES_WPP_VBS_ENSAIO/.test(fonte) && /WScript\.Arguments/.test(fonte) && !/%USERPROFILE%|\.local\\bin/i.test(fonte);
}
function rodarVbs(args) {
  if (!vbsTemEnsaio()) throw new Error('abrir-central.vbs sem o modo ensaio ou com o claude fixo: o teste nao roda o .vbs (abriria a central de verdade)');
  const raiz = pastaTemp('a3a-vbs-');
  const vazia = path.join(raiz, 'path-vazio');
  const local = path.join(raiz, 'localappdata');
  fs.mkdirSync(vazia);
  fs.mkdirSync(local);
  const env = {
    SystemRoot: process.env.SystemRoot, windir: process.env.windir, TEMP: raiz, TMP: raiz, PATH: vazia, LOCALAPPDATA: local,
    SESSOES_WPP_VBS_ENSAIO: '1',
  };
  const r = spawnSync(CSCRIPT, ['//nologo', VBS_CENTRAL, ...args], { env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  return { status: r.status, linhas: String(r.stdout || '').split(/\r?\n/).filter(Boolean), stderr: String(r.stderr || ''), local };
}

test('A3a 11. abrir-central.vbs (cscript, ensaio): o perfil e as 2 linhas de comando com a pasta, o nome e o claude dos argumentos (A5d2: mais a pasta montada e o modo); pasta da central = a do .vbs; saida 2 (argumento faltando, vazio ou com caractere ruim; a raiz do disco) e 3 (pasta ou claude que nao existe); nada gravado', () => {
  const raiz = pastaTemp('a3a-central-');
  const pasta = path.join(raiz, 'minha pasta');
  const claude = path.join(raiz, 'bin', 'claude.exe');
  fs.mkdirSync(pasta);
  fs.mkdirSync(path.dirname(claude));
  fs.writeFileSync(claude, '');
  // A5d2: a pasta montada (o instrucoes.md e o ajustes.json que o gravarCentral grava) e o modo
  const montada = path.join(raiz, 'estado', 'central');
  fs.mkdirSync(montada, { recursive: true });
  for (const a of ['instrucoes.md', 'ajustes.json']) fs.writeFileSync(path.join(montada, a), '');
  const fim = [montada, 'bypassPermissions'];
  const NOME = 'Minha Central (2)';
  const central = path.dirname(VBS_CENTRAL);
  const r = rodarVbs([pasta, NOME, claude, ...fim]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.linhas.length, 3, r.linhas.join('\n'));
  assert.deepEqual(JSON.parse(r.linhas[0]), { profiles: [{ name: NOME, hidden: true, closeOnExit: 'always' }] });
  assert.equal(r.linhas[1].toLowerCase(), [
    `wt.exe -w new -p "${NOME}" --title "${NOME}" -d "${pasta}" "${claude}" -n "${NOME}" --permission-mode bypassPermissions`,
    `--settings "${montada}\\ajustes.json" --append-system-prompt-file "${montada}\\instrucoes.md"`,
  ].join(' ').toLowerCase());
  assert.equal(r.linhas[2].toLowerCase(),
    `powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${central}\\esconder-central.ps1" -Titulos "${NOME}"`.toLowerCase());
  assert.deepEqual(fs.readdirSync(r.local), [], 'ensaio: nada gravado no LOCALAPPDATA');
  // a barra do fim da pasta sai (senao o \" fecharia as aspas na linha do wt.exe)
  const comBarra = rodarVbs([`${pasta}\\`, NOME, claude, ...fim]);
  assert.equal(comBarra.status, 0, comBarra.stderr);
  assert.ok(comBarra.linhas[1].includes(` -d "${pasta}" `), comBarra.linhas[1]);
  // saida 2: argumentos
  for (const args of [[], [pasta], [pasta, NOME], [pasta, NOME, claude], [pasta, NOME, claude, ...fim, 'x'], ...[['', NOME, claude],
    [pasta, '', claude], [pasta, NOME, ''], [pasta, 'a%b', claude], [pasta, 'a;b', claude], [pasta, 'a|b', claude],
    [`${pasta}%x`, NOME, claude], [`${pasta};x`, NOME, claude], [pasta, NOME, `${claude}%`], [pasta, NOME, `${claude};x`],
    [path.parse(pasta).root, NOME, claude]].map((a) => [...a, ...fim])]) {
    const x = rodarVbs(args);
    assert.equal(x.status, 2, JSON.stringify(args));
    assert.deepEqual(x.linhas, [], JSON.stringify(args));
    assert.deepEqual(fs.readdirSync(x.local), [], JSON.stringify(args));
  }
  // saida 3: pasta ou claude que nao existe (confere antes do ensaio)
  for (const args of [[path.join(raiz, 'nao-existe'), NOME, claude, ...fim], [pasta, NOME, path.join(raiz, 'bin', 'nao.exe'), ...fim],
    [pasta, NOME, path.dirname(claude), ...fim]]) {
    const x = rodarVbs(args);
    assert.equal(x.status, 3, JSON.stringify(args));
    assert.deepEqual(x.linhas, [], JSON.stringify(args));
  }
});

test('A3a 12. os arquivos da central sem o nome, a pasta e o claude do dono: abrir-central.vbs pelos argumentos; esconder-central.ps1 sem titulo padrao (vazio = nao esconde nada, antes de olhar janela); wt-perfil.json saiu', () => {
  const vbs = fs.readFileSync(VBS_CENTRAL, 'utf8');
  for (const fixo of ['Central WhatsApp', NOME_DONO, PASTA_ANTIGA, '.local\\bin', 'wt-perfil.json', 'USERPROFILE']) {
    assert.ok(!vbs.includes(fixo), `abrir-central.vbs sem ${fixo}`);
  }
  assert.match(vbs, /^central = fso\.GetParentFolderName\(WScript\.ScriptFullName\)\r?$/m, 'a pasta da central sai do proprio .vbs');
  assert.match(vbs, /SESSOES_WPP_VBS_ENSAIO/);
  const ps1 = fs.readFileSync(PS1_ESCONDER, 'utf8');
  assert.match(ps1, /\[string\]\$Titulos = ""/, 'sem titulo padrao');
  assert.ok(!ps1.includes('Central WhatsApp') && !ps1.includes(NOME_DONO), 'sem os titulos do dono');
  // a guarda do vazio vem antes do Add-Type (antes de olhar qualquer janela)
  const guarda = ps1.search(/\$lista\.Count -eq 0/);
  assert.ok(guarda > 0, 'guarda do vazio');
  assert.ok(guarda < ps1.indexOf('Add-Type'), 'a guarda vem antes de olhar janela');
  assert.match(ps1.slice(guarda, ps1.indexOf('Add-Type')), /"escondidas=0"[\s\S]*exit 0/);
  assert.match(ps1, /Where-Object \{ \$_ \}/, 'item vazio sai da lista (Contains("") casaria toda janela)');
  // o titulo casa igual ao nome ou no fim depois de um espaco (o Claude Code poe um sinal antes do nome: medido 14/10/2026
  // na central viva), nunca "contem": um nome curto esconderia outras janelas do terminal
  assert.ok(!/\.Contains\(/.test(ps1), 'sem "contem"');
  assert.match(ps1, /titulo == x \|\| titulo\.EndsWith\(" " \+ x, StringComparison\.Ordinal\)/);
  assert.equal(fs.existsSync(path.join(REPO, 'central', 'wt-perfil.json')), false);
});

// ---------- 13. o rodar (fonte: o rodar nao tem teste) ----------

test('A3a 13. o rodar le o config 1 vez e passa as pastas, a central e o claude (central, escondida e mensageiro); 1 linha de log na subida; as constantes do dono sairam do porteiro', () => {
  const fonte = fs.readFileSync(path.join(REPO, 'porteiro.mjs'), 'utf8');
  for (const fixo of ['RAIZES_SESSAO', 'CENTRAL_TITULO', 'CENTRAL_NOME_N', 'CENTRAL_CWD', DRIVE_ANTIGO, NOME_DONO]) {
    assert.ok(!fonte.includes(fixo), `porteiro.mjs sem ${fixo}`);
  }
  // so o corpo do rodar (ate a proxima funcao do topo do arquivo): o esperando, depois dele no arquivo, tambem le o config (A4a)
  const ini = fonte.indexOf('async function rodar(');
  const fim = fonte.slice(ini + 1).search(/\n(?:async )?function /);
  const rodar = fim === -1 ? fonte.slice(ini) : fonte.slice(ini, ini + 1 + fim);
  assert.equal(rodar.match(/\blerConfig\(/g)?.length, 1, 'o config lido 1 vez');
  assert.match(rodar, /const cfg = lerConfig\(C\.estadoDir\);/);
  assert.match(rodar, /const sessoes = sessoesDoConfig\(cfg\);/);
  assert.match(rodar, /const central = identidadeCentral\(cfg, \{ repo: REPO \}\);/);
  assert.match(rodar, /const claude = claudeDoConfig\(cfg, \{ env \}\);/);
  assert.match(rodar, /criarMensageiro\(\{ estadoDir: C\.estadoDir, claudeBin: claude, dono\b/); // A5a: depois vem o modelo
  const inicio = rodar.indexOf('criarPorteiro({');
  const chamada = rodar.slice(inicio, rodar.indexOf('});', inicio));
  // A5d2: os 2 abridores levam tambem a montagem da central (a pasta de estado, o dono e as pastas; tests/a5d.test.mjs)
  for (const re of [/\babrirCentral: abrirCentralReal\(log, \{ central, claude, env, \.\.\.montagem \}\)/, /\braizesSessao: sessoes\.raizes,/,
    /\bsessaoSoNaRaiz: sessoes\.soNaRaiz,/, /[\s{,]central,/, /\babrirSessaoEscondida: abrirSessaoEscondidaReal\(\{ env, claude, central, log, \.\.\.montagem \}\)/]) {
    assert.match(chamada, re);
  }
  assert.doesNotMatch(chamada, /sessaoSoNaRaiz: true/);
  // a linha de log, antes do "subiu" (o religar.mjs so olha o "ambiente:", o Telegram e o "subiu")
  const log = rodar.indexOf('sessoes: nenhuma pasta de projeto no config (nao abre nem reabre conversa)');
  assert.ok(log > 0, 'log sem raiz');
  assert.ok(rodar.includes('`sessoes: ${sessoes.raizes.length} pasta(s) de projeto, central em ${central.pasta}`'), 'log com raiz');
  assert.ok(log < rodar.indexOf('log(`subiu (pid'), 'antes do subiu');
});
