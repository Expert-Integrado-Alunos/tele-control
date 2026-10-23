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
import { lerListaVsCode, caminhoBancoVsCode, raizNormal, nomeDoGrupo, ehConcluido } from '../lib/lista-vscode.mjs';

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
