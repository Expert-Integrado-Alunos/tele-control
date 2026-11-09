// Testes de lib/lista-vscode.mjs (T11, PLANO-TELEGRAM.md, "T11 — as abas fechadas da lista do VS Code no painel"; pedido
// do dono: "tem que pegar todas as sessões que não estão arquivadas ou concluídas"). A lista do VS Code vive no
// banco global do VS Code (state.vscdb, tabela ItemTable), na chave da extensao do Claude Code (medido 06/10 23h1x,
// extensao 2.1.287): hiddenSessionIds = arquivadas; sessionGroups:<pasta da janela> = os grupos, na ordem da tela.
// Banco de teste feito com o node:sqlite numa pasta temporaria (nunca o banco do VS Code de verdade).
// Rodar: node --test --test-reporter=tap "tests/lista-vscode.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { lerListaVsCode, caminhoBancoVsCode, raizNormal, nomeDoGrupo, ehConcluido, lerAbasVsCode, caminhoAbasVsCode } from '../lib/lista-vscode.mjs';
import { trocarPlataformaParaTeste } from '../lib/plataforma.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const ESTADO = {
  thinkingLevel: 'high',
  hiddenSessionIds: ['arq-1', 'arq-2'],
  'sessionGroups:c:\\projetos': [
    { id: 'g1', name: '❗Prioridade', collapsed: false, sessionIds: ['s1', 's2'] },
    { id: 'g2', name: '✔️ CONCLUÍDO', collapsed: true, sessionIds: ['s3'] },
  ],
  'sessionGroups:d:\\Meus Docs\\trabalho\\Area': [
    { id: 'g3', name: 'ℹ️ Aulas', collapsed: false, sessionIds: ['w1'] },
  ],
  'sessionUnread:c:\\projetos': ['s1'],
};

// Banco como o do VS Code: ItemTable(key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB). `linhas` = [[chave, valor]].
function banco(linhas, { tabela = true } = {}) {
  const arq = path.join(pastaTemp('lista-vscode-'), 'state.vscdb');
  const db = new DatabaseSync(arq);
  if (tabela) {
    db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    const ins = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
    for (const [k, v] of linhas) ins.run(k, v);
  }
  db.close();
  return arq;
}
const outras = [['workbench.panel.x', '{"a":1}'], ['segredo.de.outra.extensao', '{"token":"nao-ler"}']];

// Mac-testes (A): os testes marcados com SO_WINDOWS conferem a premissa do Windows (caminho X:\, .exe, wscript/.vbs,
// cmd.exe, APPDATA/LOCALAPPDATA, pipe \\.\pipe, barra invertida na frase, PowerShell, VS Code/Orca abertos pelo
// porteiro); fora do win32 eles pulam. O caminho do Mac tem os testes proprios em tests/mac-*.test.mjs.
const SO_WINDOWS = process.platform !== 'win32' && 'premissa do Windows (o Mac tem os tests/mac-*)';

test('T11 L1. le as arquivadas e os grupos de cada janela (pasta normalizada, ordem da tela); o resto da chave e das outras chaves fica de fora', { skip: SO_WINDOWS }, () => {
  const arq = banco([...outras, ['Anthropic.claude-code', JSON.stringify(ESTADO)]]);
  const l = lerListaVsCode(arq);
  assert.deepEqual([...l.arquivadas], ['arq-1', 'arq-2']);
  assert.deepEqual([...l.grupos.keys()], ['c:\\projetos', 'd:\\meus docs\\trabalho\\area']);
  assert.deepEqual(l.grupos.get(raizNormal('C:\\projetos')), [
    { nome: '❗Prioridade', ids: ['s1', 's2'] },
    { nome: '✔️ CONCLUÍDO', ids: ['s3'] },
  ]);
  assert.deepEqual(l.grupos.get(raizNormal('D:/Meus Docs/trabalho/Area/')), [{ nome: 'ℹ️ Aulas', ids: ['w1'] }]);
  assert.deepEqual(Object.keys(l).sort(), ['arquivadas', 'grupos']);
});

test('T11 L2. valor em BLOB e chave com outra caixa valem; sem hiddenSessionIds = nenhuma arquivada; grupo torto sai e id que nao e texto sai', () => {
  const v = {
    'sessionGroups:c:\\projetos': [
      { name: 'Ok', sessionIds: ['a', 7, null, 'b'] },
      null,
      { name: 3, sessionIds: ['x'] },
      { name: 'Sem ids' },
      'texto',
    ],
    'sessionGroups:': [{ name: 'Sem pasta', sessionIds: ['z'] }],
    'sessionGroups:c:\\outra': 'nao e lista',
  };
  const arq = banco([['anthropic.claude-code', Buffer.from(JSON.stringify(v), 'utf8')]]);
  const l = lerListaVsCode(arq);
  assert.deepEqual([...l.arquivadas], []);
  assert.deepEqual([...l.grupos.entries()], [['c:\\projetos', [{ nome: 'Ok', ids: ['a', 'b'] }]]]);
});

test('T11 L3. ilegivel = null, sem lancar: sem caminho, nao e banco, sem a tabela, valor que nao e JSON, JSON que nao e objeto, hiddenSessionIds que nao e lista (A3b: o banco que nao existe e o sem a chave da extensao viraram a lista vazia, no tests/a3b.test.mjs)', () => {
  const pasta = pastaTemp('lista-vscode-ruim-');
  const naoBanco = path.join(pasta, 'texto.vscdb');
  fs.writeFileSync(naoBanco, 'isto nao e sqlite');
  const casos = [
    [null, 'sem caminho'],
    ['', 'caminho vazio'],
    [naoBanco, 'nao e banco'],
    [banco([], { tabela: false }), 'sem tabela'],
    [banco([['Anthropic.claude-code', '{nao json']]), 'nao e JSON'],
    [banco([['Anthropic.claude-code', '[1,2]']]), 'lista'],
    [banco([['Anthropic.claude-code', 'null']]), 'null'],
    [banco([['Anthropic.claude-code', JSON.stringify({ hiddenSessionIds: 'x' })]]), 'hidden torto'],
  ];
  for (const [arq, quem] of casos) assert.equal(lerListaVsCode(arq), null, quem);
});

test('T11 L4. so leitura: o banco sai com os mesmos bytes; e da pra apagar logo depois (fechou)', () => {
  const arq = banco([['Anthropic.claude-code', JSON.stringify(ESTADO)]]);
  const antes = fs.readFileSync(arq);
  assert.ok(lerListaVsCode(arq));
  assert.ok(lerListaVsCode(arq));
  assert.deepEqual(fs.readFileSync(arq), antes);
  fs.unlinkSync(arq);
});

test('T11 L5. caminho do banco (SESSOES_WPP_VSCODE_DB, senao o do VS Code no APPDATA; sem nenhum = null); pasta normalizada; nome do grupo sem o icone; concluido sem acento e sem caixa', { skip: SO_WINDOWS }, () => {
  assert.equal(caminhoBancoVsCode({ SESSOES_WPP_VSCODE_DB: 'C:\\x\\y.vscdb', APPDATA: 'C:\\A' }), 'C:\\x\\y.vscdb');
  assert.equal(caminhoBancoVsCode({ APPDATA: 'C:\\A' }), path.join('C:\\A', 'Code', 'User', 'globalStorage', 'state.vscdb'));
  assert.equal(caminhoBancoVsCode({}), null);
  assert.equal(raizNormal('C:/Projetos/'), 'c:\\projetos');
  assert.equal(raizNormal('d:\\Meus Docs\\trabalho\\Area'), 'd:\\meus docs\\trabalho\\area');
  for (const [de, para] of [['❗Prioridade', 'Prioridade'], ['🟢 Ativos', 'Ativos'], ['ℹ️ Aulas', 'Aulas'], ['🟠 Backlog', 'Backlog'], ['Sem ícone', 'Sem ícone'], ['  ', ''], ['⏸️', '']]) {
    assert.equal(nomeDoGrupo(de), para, de);
  }
  for (const n of ['✔️ CONCLUÍDO', 'Concluidas', 'concluído em set']) assert.equal(ehConcluido(n), true, n);
  for (const n of ['❗Prioridade', 'Conclave', '', null]) assert.equal(ehConcluido(n), false, String(n));
});

// T38 (PLANO-TELEGRAM.md, "T38"): as abas abertas de cada janela do VS Code. O banco de cada janela fica em
// `workspaceStorage/<hash>/state.vscdb` (irmao do globalStorage); a janela se acha pelo `workspace.json` da subpasta
// (`folder` = `file:///c%3A/projetos`) e as abas sao o `panelTabSessions[].sessionId` da chave da extensao (medido 07/11).
// Pasta de teste feita aqui (nunca o workspaceStorage de verdade).
const abas = (...ids) => ({ panelTabSessions: ids.map((id) => ({ sessionId: id, title: `t-${id}`, fullEditor: false })) });

// Uma subpasta `<hash>` em `ws`: `workspace` = objeto (vira JSON) ou texto cru (undefined = sem workspace.json); `estado`
// = o valor da chave (objeto vira JSON; undefined = banco sem a linha da chave; `false` = sem state.vscdb); `mtime` =
// segundos do state.vscdb.
function janela(ws, hash, workspace, estado, { mtime } = {}) {
  const sub = path.join(ws, hash);
  fs.mkdirSync(sub, { recursive: true });
  if (workspace !== undefined) {
    fs.writeFileSync(path.join(sub, 'workspace.json'), typeof workspace === 'string' ? workspace : JSON.stringify(workspace));
  }
  if (estado === false) return sub;
  const arq = path.join(sub, 'state.vscdb');
  const db = new DatabaseSync(arq);
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  const ins = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
  for (const [k, v] of outras) ins.run(k, v);
  if (estado !== undefined) ins.run('Anthropic.claude-code', typeof estado === 'string' ? estado : JSON.stringify(estado));
  db.close();
  if (mtime !== undefined) fs.utimesSync(arq, mtime, mtime);
  return sub;
}
const comoObjeto = (m) => (m === null ? null : Object.fromEntries([...m].map(([k, s]) => [k, [...s].sort()])));

test('T38 A1. caminhoAbasVsCode: o workspaceStorage irmao do globalStorage (Windows path.join); entrada que nao e texto nao vazio = null', { skip: SO_WINDOWS }, () => {
  assert.equal(caminhoAbasVsCode('C:\\U\\AppData\\Roaming\\Code\\User\\globalStorage\\state.vscdb'), 'C:\\U\\AppData\\Roaming\\Code\\User\\workspaceStorage');
  assert.equal(caminhoAbasVsCode('C:/U/Code/User/globalStorage/state.vscdb'), 'C:\\U\\Code\\User\\workspaceStorage');
  for (const x of [null, undefined, '', 7, {}, ['C:\\a\\b\\c']]) assert.equal(caminhoAbasVsCode(x), null, String(x));
});

test('T38 A2. caminhoAbasVsCode no Mac: path.posix (o banco do Library/Application Support)', () => {
  const desfazer = trocarPlataformaParaTeste('darwin');
  try {
    assert.equal(
      caminhoAbasVsCode('/Users/x/Library/Application Support/Code/User/globalStorage/state.vscdb'),
      '/Users/x/Library/Application Support/Code/User/workspaceStorage',
    );
    assert.equal(caminhoAbasVsCode(''), null);
  } finally {
    desfazer();
  }
});

test('T38 A3. lerAbasVsCode: decodifica o folder (%3A, %20, barra antes do drive) e casa com a raiz normalizada; so os sessionId de texto', { skip: SO_WINDOWS }, () => {
  const ws = pastaTemp('abas-vscode-');
  janela(ws, 'h1', { folder: 'file:///c%3A/projetos' }, {
    thinkingLevel: 'high',
    panelSessionIds: ['nao-e-aba'],
    panelTabSessions: [{ sessionId: 's1', title: 'a', fullEditor: false }, { sessionId: 's2' }, { sessionId: '' }, { sessionId: 7 }, null, 'x', { title: 'sem id' }],
  });
  janela(ws, 'h2', { folder: 'file:///d%3A/Meus%20Docs/Area/' }, abas('w1'));
  janela(ws, 'h3', { folder: 'file:///c%3A/outra' }, abas('fora'));
  fs.writeFileSync(path.join(ws, 'solto.txt'), 'nao e pasta');
  const m = lerAbasVsCode(ws, ['C:\\Projetos', 'd:/Meus Docs/Area', 'c:\\sem-janela']);
  assert.deepEqual(comoObjeto(m), { 'c:\\projetos': ['s1', 's2'], 'd:\\meus docs\\area': ['w1'] });
  assert.ok(m.get(raizNormal('c:/projetos/')) instanceof Set);
});

test('T38 A4. lerAbasVsCode ignora a subpasta torta: JSON torto, sem folder, so workspace (multi-pasta), remoto, file com host, sem workspace.json', { skip: SO_WINDOWS }, () => {
  const ws = pastaTemp('abas-vscode-ign-');
  janela(ws, 'torto', '{nao json', abas('t1'));
  janela(ws, 'lista', '["file:///c%3A/projetos"]', abas('t2'));
  janela(ws, 'vazio', {}, abas('t3'));
  janela(ws, 'multi', { workspace: 'file:///c%3A/projetos/tudo.code-workspace' }, abas('t4'));
  janela(ws, 'remoto', { folder: 'vscode-remote://wsl%2Bubuntu/c%3A/projetos' }, abas('t5'));
  janela(ws, 'host', { folder: 'file://servidor/c%3A/projetos' }, abas('t6'));
  janela(ws, 'semjson', undefined, abas('t7'));
  janela(ws, 'pct', { folder: 'file:///c%3A/projetos%ZZ' }, abas('t8'));
  janela(ws, 'nao-texto', { folder: 7 }, abas('t9'));
  assert.deepEqual(comoObjeto(lerAbasVsCode(ws, ['c:\\projetos'])), {});
  janela(ws, 'boa', { folder: 'file:///c%3A/projetos' }, abas('ok'));
  assert.deepEqual(comoObjeto(lerAbasVsCode(ws, ['c:\\projetos'])), { 'c:\\projetos': ['ok'] });
});

test('T38 A5. lerAbasVsCode: 2 hashes da mesma raiz (um velho) = vale o state.vscdb com mtime mais novo, em qualquer ordem de nome', { skip: SO_WINDOWS }, () => {
  const ws = pastaTemp('abas-vscode-hash-');
  janela(ws, 'aaa', { folder: 'file:///c%3A/projetos' }, abas('novo'), { mtime: 2_000_000_000 });
  janela(ws, 'zzz', { folder: 'file:///C%3A/Projetos/' }, abas('velho'), { mtime: 1_000_000_000 });
  janela(ws, 'bbb', { folder: 'file:///c%3A/work' }, abas('w-velho'), { mtime: 1_000_000_000 });
  janela(ws, 'yyy', { folder: 'file:///c%3A/work' }, abas('w-novo'), { mtime: 2_000_000_000 });
  janela(ws, 'ccc', { folder: 'file:///c%3A/work' }, false);
  assert.deepEqual(comoObjeto(lerAbasVsCode(ws, ['c:\\projetos', 'c:\\work'])), { 'c:\\projetos': ['novo'], 'c:\\work': ['w-novo'] });
});

test('T38 A6. lerAbasVsCode: sem a linha da chave, sem o campo panelTabSessions ou sem o state.vscdb = Set vazio', { skip: SO_WINDOWS }, () => {
  const ws = pastaTemp('abas-vscode-vazio-');
  janela(ws, 'h1', { folder: 'file:///c%3A/a' }, undefined);
  janela(ws, 'h2', { folder: 'file:///c%3A/b' }, { panelSessionIds: ['nao-e-aba'] });
  janela(ws, 'h3', { folder: 'file:///c%3A/c' }, false);
  janela(ws, 'h4', { folder: 'file:///c%3A/d' }, { panelTabSessions: [] });
  assert.deepEqual(comoObjeto(lerAbasVsCode(ws, ['c:\\a', 'c:\\b', 'c:\\c', 'c:\\d'])), { 'c:\\a': [], 'c:\\b': [], 'c:\\c': [], 'c:\\d': [] });
});

test('T38 A7. lerAbasVsCode ilegivel = null, sem lancar: pastaWs que nao e texto, banco que nao abre, valor que nao e JSON de objeto, panelTabSessions que nao e lista', { skip: SO_WINDOWS }, () => {
  for (const x of [null, undefined, '', 7, {}]) assert.equal(lerAbasVsCode(x, ['c:\\projetos']), null, String(x));
  const casos = [
    ['{nao json', 'nao e JSON'],
    ['[1,2]', 'lista'],
    ['null', 'null'],
    [JSON.stringify({ panelTabSessions: 'x' }), 'panelTabSessions texto'],
    [JSON.stringify({ panelTabSessions: { sessionId: 's1' } }), 'panelTabSessions objeto'],
  ];
  for (const [valor, quem] of casos) {
    const ws = pastaTemp('abas-vscode-ruim-');
    janela(ws, 'boa', { folder: 'file:///c%3A/outra' }, abas('o1'));
    janela(ws, 'ruim', { folder: 'file:///c%3A/projetos' }, valor);
    assert.equal(lerAbasVsCode(ws, ['c:\\projetos', 'c:\\outra']), null, quem);
  }
  const ws = pastaTemp('abas-vscode-naobanco-');
  const sub = janela(ws, 'h1', { folder: 'file:///c%3A/projetos' }, false);
  fs.writeFileSync(path.join(sub, 'state.vscdb'), 'isto nao e sqlite');
  assert.equal(lerAbasVsCode(ws, ['c:\\projetos']), null, 'nao e banco');
  // a raiz que nao foi pedida nao e lida: o banco torto dela nao derruba a leitura
  assert.deepEqual(comoObjeto(lerAbasVsCode(ws, ['c:\\outra'])), {});
});

test('T38 A8. lerAbasVsCode: pasta que nao existe = Map vazio (o VS Code nunca rodou); raizes que nao sao lista = nenhuma', () => {
  const ws = path.join(pastaTemp('abas-vscode-nada-'), 'workspaceStorage');
  const m = lerAbasVsCode(ws, ['c:\\projetos']);
  assert.ok(m instanceof Map);
  assert.equal(m.size, 0);
  assert.equal(fs.existsSync(ws), false);
  for (const r of [null, undefined, 'c:\\projetos', 7]) assert.equal(lerAbasVsCode(ws, r).size, 0, String(r));
});

test('T38 A9. lerAbasVsCode so le: nenhum arquivo criado ou alterado (mtime e tamanho iguais) e os bancos se apagam logo depois (fechou)', { skip: SO_WINDOWS }, () => {
  const ws = pastaTemp('abas-vscode-leitura-');
  janela(ws, 'h1', { folder: 'file:///c%3A/projetos' }, abas('s1'), { mtime: 2_000_000_000 });
  janela(ws, 'h2', { folder: 'file:///c%3A/projetos' }, abas('s0'), { mtime: 1_000_000_000 });
  janela(ws, 'h3', { folder: 'file:///c%3A/work' }, undefined);
  const foto = () => {
    const r = [];
    for (const sub of fs.readdirSync(ws).sort()) {
      for (const f of fs.readdirSync(path.join(ws, sub)).sort()) {
        const st = fs.statSync(path.join(ws, sub, f));
        r.push([sub, f, st.mtimeMs, st.size]);
      }
    }
    return r;
  };
  const antes = foto();
  assert.deepEqual(comoObjeto(lerAbasVsCode(ws, ['c:\\projetos', 'c:\\work'])), { 'c:\\projetos': ['s1'], 'c:\\work': [] });
  assert.deepEqual(comoObjeto(lerAbasVsCode(ws, ['c:\\projetos', 'c:\\work'])), { 'c:\\projetos': ['s1'], 'c:\\work': [] });
  assert.deepEqual(foto(), antes);
  for (const sub of ['h1', 'h2', 'h3']) fs.unlinkSync(path.join(ws, sub, 'state.vscdb'));
});
