// Testes da A3b (PLANO-ABERTO.md, "A3b — apps, Orca e VS Code"): o `apps`, o `orca.bin` e o `vscode.banco` pelo
// config.json, a lista do VS Code vazia (sem erro) pra quem nao tem o VS Code, o rodar que so liga a lista e o Orca pelo
// `apps`, e o instalador (o Node minimo, o `apps` no passo config e a dica do VS Code no cartao).
// Por que existe: a copia aberta vai tambem pra quem so usa o terminal, o Desktop ou o Orca. Antes, a falta do banco do
// VS Code virava erro e tirava do painel as fechadas inteiras (as do terminal e do Orca tambem), e o caminho do orca.exe
// era fixo. Valor trocado aqui = painel sem as conversas fechadas, a lista do VS Code de outro banco ou o Orca errado.
// Isolamento: pastas temporarias (prefixo "a3b-"); banco de teste feito com o node:sqlite (nunca o do VS Code de verdade);
// spawn dublado no abrirNoOrcaReal (nenhum orca.exe roda); o instalar.mjs pela funcao executar, com a pasta de estado
// temporaria. Nada de rede, config.json real nem porteiro rodando. O painel com a lista vazia fica no
// tests/porteiro-t11.test.mjs (o harness do painel mora la).
// Os modulos entram por `import * as`: funcao que ainda nao existe deixa so o teste dela vermelho.
// Rodar: node --test --test-reporter=tap "tests/a3b.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { pastaTemp } from './lib/pasta-temp.cjs';
import * as config from '../lib/config.mjs';
import * as lista from '../lib/lista-vscode.mjs';
import * as porteiro from '../porteiro.mjs';
import * as instalarLib from '../lib/instalar.mjs';
import * as instalar from '../instalar.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');
const S1 = '5a1f0c2e-1b7d-4c3a-9e2f-0123456789ab';
const TRES = ['vscode', 'desktop', 'orca'];

// Banco como o do VS Code: ItemTable(key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB). `linhas` = [[chave, valor]].
function banco(linhas) {
  const arq = path.join(pastaTemp('a3b-banco-'), 'state.vscdb');
  const db = new DatabaseSync(arq);
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  const ins = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
  for (const [k, v] of linhas) ins.run(k, v);
  db.close();
  return arq;
}
// A lista vazia: so as 2 chaves, nenhuma arquivada e nenhum grupo
const vazia = (l) => Boolean(l) && l.arquivadas instanceof Set && l.arquivadas.size === 0 && l.grupos instanceof Map
  && l.grupos.size === 0 && Object.keys(l).sort().join() === 'arquivadas,grupos';

// spawn falso do orca.exe: grava cada chamada; o filho sai 0 com o JSON de ok no proximo tique.
function spawnOrcaFalso() {
  const chamadas = [];
  const fn = (cmd, args, opts) => {
    const filho = new EventEmitter();
    filho.stdout = new EventEmitter();
    filho.kill = () => {};
    chamadas.push({ cmd, args, opts });
    setImmediate(() => {
      filho.stdout.emit('data', Buffer.from('{"ok":true,"terminal":{"handle":"t-1"}}\n'));
      filho.emit('close', 0, null);
    });
    return filho;
  };
  fn.chamadas = chamadas;
  return fn;
}

// O instalar.mjs com a pasta de estado, a do Claude e a do Inicializar temporarias
function ambienteDoInstalador() {
  const base = pastaTemp('a3b-instalar-');
  const estado = path.join(base, 'estado');
  const claudeDir = path.join(base, 'claude');
  const inicio = path.join(base, 'inicio');
  for (const p of [estado, claudeDir, inicio]) fs.mkdirSync(p, { recursive: true });
  return { estado, env: { SESSOES_WPP_DIR: estado, SESSOES_WPP_CLAUDE_DIR: claudeDir, SESSOES_WPP_STARTUP_DIR: inicio } };
}

// ---------- 1-3. config ----------

test('A3b 1. appsDoConfig: os conhecidos (aparados, sem caixa, sem repetir, na ordem do config); lista presente manda ([] e so desconhecidos = []); ausente ou que nao e lista = os 3 de hoje; lista nova a cada chamada', () => {
  assert.deepEqual(config.APPS, ['vscode', 'desktop', 'orca', 'terminal']);
  assert.deepEqual(config.PADRAO_APPS, TRES);
  const a = config.appsDoConfig;
  assert.deepEqual(a({ apps: ['vscode', 'desktop', 'orca', 'terminal'] }), ['vscode', 'desktop', 'orca', 'terminal']);
  assert.deepEqual(a({ apps: [' Orca ', 'TERMINAL', 'orca', 'VSCode', 7, null, {}, ['desktop'], 'cursor', ''] }), ['orca', 'terminal', 'vscode']);
  assert.deepEqual(a({ apps: ['terminal'] }), ['terminal']);
  assert.deepEqual(a({ apps: [] }), [], 'lista vazia manda');
  assert.deepEqual(a({ apps: ['cursor', 'zed'] }), [], 'so desconhecidos = nenhum');
  for (const cfg of [{}, null, undefined, 42, 'x', [], [{ apps: ['orca'] }], { apps: 'vscode' }, { apps: null }, { apps: {} }, { apps: 5 }]) {
    assert.deepEqual(a(cfg), TRES, JSON.stringify(cfg));
  }
  const x = a({});
  x.push('terminal');
  const y = a({ apps: ['orca'] });
  y.push('vscode');
  assert.deepEqual([a({}), a({ apps: ['orca'] }), config.PADRAO_APPS], [TRES, ['orca'], TRES], 'mexer na lista devolvida nao muda o padrao');
});

test('A3b 2. orcaDoConfig: orca.bin > o do instalador do Orca no LOCALAPPDATA; so absoluto, .exe, sem caractere ruim e que existe; nenhum = o do instalador mesmo assim; sem LOCALAPPDATA = null; nunca lanca', () => {
  const o = config.orcaDoConfig;
  assert.equal(typeof o, 'function', 'orcaDoConfig exportada');
  const LOCAL = 'C:\\Users\\Fulano de Tal\\AppData\\Local';
  const PADRAO = `${LOCAL}\\Programs\\orca\\resources\\bin\\orca.exe`;
  const MEU = 'D:\\Meus Apps\\Orca\\resources\\bin\\orca.exe';
  const env = { LOCALAPPDATA: LOCAL };
  const sim = () => true;
  const nao = () => false;
  assert.equal(o({ orca: { bin: MEU } }, { env, existe: sim }), MEU);
  assert.equal(o({ orca: { bin: MEU } }, { env, existe: (p) => p !== MEU }), PADRAO, 'o do config nao existe = o do instalador');
  assert.equal(o({}, { env, existe: sim }), PADRAO);
  assert.equal(o({}, { env, existe: nao }), PADRAO, 'nenhum existe = o do instalador mesmo assim');
  assert.equal(o({ orca: { bin: MEU } }, { env: {}, existe: sim }), MEU, 'sem LOCALAPPDATA o do config vale');
  assert.equal(o({ orca: { bin: MEU } }, { env: {}, existe: nao }), null);
  assert.equal(o({}, { env: { LOCALAPPDATA: '   ' }, existe: sim }), null);
  assert.equal(o({ orca: { bin: 'D:\\Apps\\ORCA.EXE' } }, { env, existe: sim }), 'D:\\Apps\\ORCA.EXE', '.exe sem caso');
  // fora do formato: o do config nao vale e nem vai ao disco
  for (const ruim of ['orca.exe', 'D:\\Apps\\orca', 'D:\\Apps\\or"ca.exe', 'D:\\%X%\\orca.exe', 'D:\\a;b\\orca.exe',
    'D:\\a\nb\\orca.exe', 'D:\\a\tb\\orca.exe', '\\\\servidor\\orca.exe', ' D:\\Apps\\orca.exe', 7, null, '']) {
    const vistos = [];
    assert.equal(o({ orca: { bin: ruim } }, { env, existe: (p) => { vistos.push(p); return true; } }), PADRAO, JSON.stringify(ruim));
    assert.deepEqual(vistos, [PADRAO], `so o do instalador vai ao disco: ${JSON.stringify(ruim)}`);
  }
  // existe que lanca = nao existe; cfg e opcoes tortos nao lancam
  assert.equal(o({ orca: { bin: MEU } }, { env, existe: (p) => { if (p === MEU) throw new Error('EPERM'); return true; } }), PADRAO);
  for (const cfg of [null, undefined, 42, 'x', [], { orca: null }, { orca: MEU }, { orca: [MEU] }]) {
    assert.equal(o(cfg, { env, existe: sim }), PADRAO, JSON.stringify(cfg));
  }
  assert.equal(o(null, null), null, 'sem opcoes = sem LOCALAPPDATA');
  // existe que nao e funcao = o disco de verdade (os 2 caminhos de mentira nao existem): o do instalador mesmo assim
  assert.equal(o({ orca: { bin: MEU } }, { env, existe: 'sim' }), PADRAO);
});

test('A3b 3. bancoVsCodeDoConfig: o vscode.banco absoluto e sem caractere ruim, aparado e com as barras do Windows; o resto = null (o leitor cai no SESSOES_WPP_VSCODE_DB e no APPDATA); nao olha o disco', () => {
  const b = config.bancoVsCodeDoConfig;
  assert.equal(typeof b, 'function', 'bancoVsCodeDoConfig exportada');
  const INS = 'C:\\Users\\Fulano de Tal\\AppData\\Roaming\\Code - Insiders\\User\\globalStorage\\state.vscdb';
  assert.equal(b({ vscode: { banco: INS } }), INS);
  assert.equal(b({ vscode: { banco: `  ${INS}  ` } }), INS, 'aparado');
  assert.equal(b({ vscode: { banco: 'c:/Users/Fulano/AppData/Roaming/Cursor/User/globalStorage/state.vscdb' } }),
    'c:\\Users\\Fulano\\AppData\\Roaming\\Cursor\\User\\globalStorage\\state.vscdb', 'barras do Windows');
  assert.equal(b({ vscode: { banco: 'D:\\nao\\existe.vscdb' } }), 'D:\\nao\\existe.vscdb', 'nao olha o disco');
  for (const ruim of ['state.vscdb', '.\\state.vscdb', '%APPDATA%\\Code\\User\\globalStorage\\state.vscdb',
    'C:\\Users\\%USERNAME%\\AppData\\Roaming\\Code\\User\\globalStorage\\state.vscdb', 'C:\\a"b\\state.vscdb',
    'C:\\a<b.vscdb', 'C:\\a>b.vscdb', 'C:\\a|b.vscdb', 'C:\\a*b.vscdb', 'C:\\a?b.vscdb', 'C:\\a\nb\\state.vscdb', 'C:\\a\tb.vscdb',
    'C:\\', 'C:/', '  C:\\  ', 'C:\\pasta\\', '\\\\servidor\\state.vscdb', 7, null, '', '   ']) {
    assert.equal(b({ vscode: { banco: ruim } }), null, JSON.stringify(ruim));
  }
  for (const cfg of [{}, null, undefined, 42, 'x', [], { vscode: null }, { vscode: INS }, { vscode: {} }, { vscode: [INS] }]) {
    assert.equal(b(cfg), null, JSON.stringify(cfg));
  }
});

// ---------- 4-5. a lista do VS Code ----------

test('A3b 4. lista do VS Code: listaVsCodeVazia (objeto novo a cada vez); o banco que nao existe (sem criar) e o banco sem a chave da extensao = a lista vazia, sem erro; sem caminho, nao e banco, sem a tabela, valor nulo e valor que nao e JSON seguem null', () => {
  assert.equal(typeof lista.listaVsCodeVazia, 'function', 'listaVsCodeVazia exportada');
  const v1 = lista.listaVsCodeVazia();
  const v2 = lista.listaVsCodeVazia();
  assert.ok(vazia(v1) && vazia(v2));
  assert.notEqual(v1.arquivadas, v2.arquivadas, 'objeto novo a cada vez');
  v1.arquivadas.add('x');
  v1.grupos.set('c:\\x', []);
  assert.ok(vazia(lista.listaVsCodeVazia()), 'mexer na devolvida nao muda a proxima');
  const pasta = pastaTemp('a3b-lista-');
  const nao = path.join(pasta, 'nao-existe.vscdb');
  assert.ok(vazia(lista.lerListaVsCode(nao)), 'o banco que nao existe = vazia (o VS Code nunca rodou ali)');
  assert.equal(fs.existsSync(nao), false, 'nao cria o banco');
  assert.ok(vazia(lista.lerListaVsCode(banco([['workbench.panel.x', '{"a":1}']]))), 'sem a chave da extensao = vazia (VS Code sem o Claude Code)');
  // seguem erro
  const naoBanco = path.join(pasta, 'texto.vscdb');
  fs.writeFileSync(naoBanco, 'isto nao e sqlite, so texto comprido o bastante pra nao parecer um banco vazio');
  const semTabela = path.join(pasta, 'sem-tabela.vscdb');
  const db = new DatabaseSync(semTabela);
  db.exec('CREATE TABLE Outra (x)');
  db.close();
  for (const [arq, quem] of [[null, 'sem caminho'], ['', 'caminho vazio'], [7, 'nao e texto'], [naoBanco, 'nao e banco'],
    [semTabela, 'sem a tabela'], [banco([['Anthropic.claude-code', null]]), 'valor nulo'], [banco([['Anthropic.claude-code', '{x']]), 'nao e JSON']]) {
    assert.equal(lista.lerListaVsCode(arq), null, quem);
  }
});

test('A3b 5. caminhoBancoVsCode(env, banco): o do config > SESSOES_WPP_VSCODE_DB > o do APPDATA > null; lerListaVsCodeReal({env, banco}) le o do config e, se ele nao existe, devolve a lista vazia (nao cai noutro banco)', () => {
  const c = lista.caminhoBancoVsCode;
  const env = { SESSOES_WPP_VSCODE_DB: 'C:\\x\\y.vscdb', APPDATA: 'C:\\A' };
  assert.equal(c(env, 'D:\\cfg\\state.vscdb'), 'D:\\cfg\\state.vscdb');
  assert.equal(c({}, 'D:\\cfg\\state.vscdb'), 'D:\\cfg\\state.vscdb');
  for (const semBanco of [null, undefined, '', 7]) assert.equal(c(env, semBanco), 'C:\\x\\y.vscdb', JSON.stringify(semBanco));
  assert.equal(c(env), 'C:\\x\\y.vscdb');
  assert.equal(c({ APPDATA: 'C:\\A' }, null), path.join('C:\\A', 'Code', 'User', 'globalStorage', 'state.vscdb'));
  assert.equal(c({}, null), null);
  // o leitor real
  const doCfg = banco([['Anthropic.claude-code', JSON.stringify({ hiddenSessionIds: [S1] })]]);
  const doEnv = banco([['Anthropic.claude-code', JSON.stringify({ hiddenSessionIds: ['outra'] })]]);
  const l = porteiro.lerListaVsCodeReal({ env: { SESSOES_WPP_VSCODE_DB: doEnv }, banco: doCfg })();
  assert.deepEqual([...l.arquivadas], [S1], 'o do config na frente do ambiente');
  const semArquivo = porteiro.lerListaVsCodeReal({ env: { SESSOES_WPP_VSCODE_DB: doEnv }, banco: path.join(pastaTemp('a3b-sem-'), 'nao.vscdb') })();
  assert.ok(vazia(semArquivo), 'o do config que nao existe = vazia, sem cair no do ambiente');
  assert.deepEqual([...porteiro.lerListaVsCodeReal({ env: { SESSOES_WPP_VSCODE_DB: doEnv } })().arquivadas], ['outra'], 'sem banco = o do ambiente, como antes');
});

// ---------- 6-7. o porteiro: o Orca do config e o rodar ----------

test('A3b 6. abrirNoOrcaReal({exe}): roda o exe dado (caminho com espaco inteiro, sem shell) e confere ele no disco a cada abertura; exe que nao existe rejeita sem spawn; exe vazio ou que nao e texto = o do LOCALAPPDATA, como antes; o --command segue com o claude do PATH', async () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\Fulano de Tal\\AppData\\Local', PATH: 'x' };
  const PADRAO = 'C:\\Users\\Fulano de Tal\\AppData\\Local\\Programs\\orca\\resources\\bin\\orca.exe';
  const MEU = 'D:\\Meus Apps\\Orca\\resources\\bin\\orca.exe';
  const vistos = [];
  const existe = (p) => { vistos.push(p); return true; };
  let sp = spawnOrcaFalso();
  const abrir = porteiro.abrirNoOrcaReal({ spawn: sp, env, existe, exe: MEU });
  await abrir('C:\\projetos\\x', 'Teste Orca', { retomar: S1 });
  await abrir('C:\\projetos\\x', 'Teste Orca', { retomar: S1 });
  assert.deepEqual(vistos, [MEU, MEU], 'confere o exe dado, a cada abertura');
  assert.deepEqual(sp.chamadas.map((c) => c.cmd), [MEU, MEU]);
  assert.equal(sp.chamadas[0].opts.shell, false);
  assert.deepEqual(sp.chamadas[0].args, ['terminal', 'create', '--worktree', 'path:C:\\projetos\\x', '--title', 'Teste Orca',
    '--command', `claude -n "Teste Orca" --resume ${S1}`, '--json'], 'o claude do PATH no --command');
  // o exe que nao existe: rejeita sem spawn (nao cai no do LOCALAPPDATA)
  sp = spawnOrcaFalso();
  await assert.rejects(porteiro.abrirNoOrcaReal({ spawn: sp, env, existe: (p) => p !== MEU, exe: MEU })('C:\\projetos\\x', 'Teste Orca', { retomar: S1 }), /orca\.exe nao encontrado/);
  assert.equal(sp.chamadas.length, 0);
  // exe vazio, so espaco, ausente ou que nao e texto = o do LOCALAPPDATA
  for (const exe of ['', '   ', null, undefined, 7]) {
    sp = spawnOrcaFalso();
    await porteiro.abrirNoOrcaReal({ spawn: sp, env, existe: () => true, exe })('C:\\projetos\\x', 'Teste Orca', { retomar: S1 });
    assert.equal(sp.chamadas[0]?.cmd, PADRAO, JSON.stringify(exe));
  }
});

test('A3b 7. o rodar le o apps do mesmo config e liga por ele a lista do VS Code (sem o vscode = a lista vazia, nunca null) e o Orca (sem o orca = null); o banco e o orca.exe do config; 1 linha "apps:" depois da "sessoes:" e antes do subiu', () => {
  const fonte = fs.readFileSync(path.join(REPO, 'porteiro.mjs'), 'utf8');
  // so o corpo do rodar (ate a proxima funcao do topo do arquivo): o esperando, depois dele no arquivo, tambem le o config (A4a)
  const ini = fonte.indexOf('async function rodar(');
  const fim = fonte.slice(ini + 1).search(/\n(?:async )?function /);
  const rodar = fim === -1 ? fonte.slice(ini) : fonte.slice(ini, ini + 1 + fim);
  assert.equal(rodar.match(/\blerConfig\(/g)?.length, 1, 'o config lido 1 vez');
  const cfgEm = rodar.indexOf('const cfg = lerConfig(C.estadoDir);');
  const appsEm = rodar.indexOf('const apps = appsDoConfig(cfg);');
  const inicio = rodar.indexOf('criarPorteiro({');
  assert.ok(cfgEm > 0 && appsEm > cfgEm && appsEm < inicio, 'o apps do mesmo cfg, antes do criarPorteiro');
  const chamada = rodar.slice(inicio, rodar.indexOf('});', inicio));
  for (const trecho of [
    "lerListaVsCode: apps.includes('vscode') ? lerListaVsCodeReal({ env, banco: bancoVsCodeDoConfig(cfg) }) : listaVsCodeVazia,",
    "abrirNoOrca: apps.includes('orca') ? abrirNoOrcaReal({ env, exe: orcaDoConfig(cfg, { env }) }) : null,",
    "orcaAberto: apps.includes('orca') ? orcaAbertoReal({}) : null,",
  ]) assert.ok(chamada.includes(trecho), trecho);
  for (const velho of ['lerListaVsCode: lerListaVsCodeReal({ env })', 'abrirNoOrca: abrirNoOrcaReal({ env })', 'orcaAberto: orcaAbertoReal({}),']) {
    assert.ok(!chamada.includes(velho), `saiu: ${velho}`);
  }
  const logEm = rodar.indexOf("log(`apps: ${apps.length ? apps.join(', ') : 'nenhum'}`);");
  assert.ok(logEm > rodar.indexOf("'sessoes: nenhuma pasta de projeto no config"), 'depois da linha sessoes:');
  assert.ok(logEm > 0 && logEm < rodar.indexOf('log(`subiu (pid'), 'antes do subiu');
});

// ---------- 8-9. o instalador ----------

test('A3b 8. instalar.mjs config: o apps vai em minuscula e sem repetir; apps que nao e lista ou com valor fora dos 4 = erro de uso dizendo os 4 e nada gravado; lista vazia vale', async () => {
  const a = ambienteDoInstalador();
  const r = await instalar.executar(['config', '--dados', JSON.stringify({ apps: ['Orca', 'vscode', 'orca', ' Terminal '], dono: { nome: 'Fulano' } })], { env: a.env });
  assert.equal(r.codigo, 0, JSON.stringify(r.saida));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(a.estado, 'config.json'), 'utf8')), { apps: ['orca', 'vscode', 'terminal'], dono: { nome: 'Fulano' } });
  for (const apps of ['vscode', ['vscode', 'cursor'], [7], [null], null, {}, [['orca']], ['']]) {
    const b = ambienteDoInstalador();
    const r2 = await instalar.executar(['config', '--dados', JSON.stringify({ apps, dono: { nome: 'Fulano' } })], { env: b.env });
    assert.equal(r2.codigo, 2, JSON.stringify(apps));
    assert.match(r2.saida.erro, /vscode, desktop, orca ou terminal/, JSON.stringify(apps));
    assert.equal(fs.existsSync(path.join(b.estado, 'config.json')), false, `nada gravado: ${JSON.stringify(apps)}`);
  }
  const c = ambienteDoInstalador();
  assert.equal((await instalar.executar(['config', '--dados', '{"apps":[]}'], { env: c.env })).codigo, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(c.estado, 'config.json'), 'utf8')), { apps: [] });
  // sem apps nos dados: nada muda no que ja estava gravado
  const d = ambienteDoInstalador();
  fs.writeFileSync(path.join(d.estado, 'config.json'), JSON.stringify({ apps: ['VSCode', 'cursor'] }));
  assert.equal((await instalar.executar(['config', '--dados', '{"dono":{"nome":"Fulano"}}'], { env: d.env })).codigo, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d.estado, 'config.json'), 'utf8')).apps, ['VSCode', 'cursor']);
});

test('A3b 9. o Node minimo e 22.16.0 (o node:sqlite sem flag no 22.13; o prazo da leitura no 22.16) e a falta diz a versao; a dica do VS Code no cartao fala do grupo de concluidas e das arquivadas', async () => {
  assert.equal(instalarLib.MINIMO.node, '22.16.0');
  const base = { plataforma: 'win32', release: '10.0.22631', rodar: () => ({ status: null }), existe: () => true, env: {} };
  for (const [v, ok] of [['v22.12.0', false], ['v22.15.1', false], ['v22.16.0', true], ['v22.20.0', true], ['v24.1.0', true], ['v26.0.0', true]]) {
    const r = instalarLib.checar({ ...base, versaoNode: v });
    assert.equal(r.itens.node.ok, ok, v);
    if (!ok) assert.match(r.itens.node.falta, /Node\.js 22\.16 ou mais novo/, v);
  }
  const a = ambienteDoInstalador();
  fs.writeFileSync(path.join(a.estado, 'config.json'), JSON.stringify({ apps: ['vscode'] }));
  const r = await instalar.executar(['cartao'], { env: a.env });
  assert.equal(r.saida.dicas.length, 1);
  assert.match(r.saida.dicas[0], /^VS Code: /);
  assert.match(r.saida.dicas[0], /"Concluído"/);
  assert.match(r.saida.dicas[0], /arquivadas/);
});
