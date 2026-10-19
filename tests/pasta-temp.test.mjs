// Pasta temporaria dos testes (caso real, "PC lento", medido: 286 mil pastas de teste com
// mais de 1 dia no %TEMP%, ~2,9 mil novas por hora, e a limpeza do Windows entrou 6 vezes na madrugada pra percorrer essas
// pastas e parou em todas). Toda pasta temporaria de teste nasce pelo `pastaTemp` (tests/lib/pasta-temp.cjs), dentro de
// 1 raiz por processo que sai inteira quando o processo termina; a bateria e o sabotar ainda rodam com um TEMP proprio,
// apagado no fim (pega o processo morto no meio).
// - 1 e 2: a raiz sai no fim (saida normal e process.exit com codigo); arquivo preso no fim nunca derruba o processo.
// - 3: pastas novas e vazias na mesma raiz.
// - 4: nenhum teste cria pasta temporaria por fora do pastaTemp (o detector e conferido com amostras).
// - 5: o sabotar roda cada mutante com o TEMP numa pasta propria e apaga ela no fim (sem o tools/, que fica fora da
//   copia aberta, o 5 pula).
// Rodar: node --test --test-reporter=tap "tests/pasta-temp.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pastaTemp } from './lib/pasta-temp.cjs';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const AJUDANTE = path.join(REPO, 'tests', 'lib', 'pasta-temp.cjs');
const SABOTAR = path.join(REPO, 'tools', 'integrar', 'sabotar.mjs');
// Na copia aberta o tools/ nao vai (export-ignore): sem o sabotar, o teste 5 pula; na fonte roda igual.
const SEM_SABOTAR = fs.existsSync(SABOTAR) ? false : 'sem o tools/integrar/sabotar.mjs (fica fora da copia aberta)';

// Roda `codigo` num node filho (CommonJS) com o ajudante em `p`. -> o spawnSync e o JSON da ultima linha do stdout.
function filho(codigo) {
  const r = spawnSync(process.execPath, ['-e', `const p = require(${JSON.stringify(AJUDANTE)});\n${codigo}`], {
    encoding: 'utf8', timeout: 60000,
  });
  const linhas = String(r.stdout || '').trim().split(/\r?\n/);
  let o = null;
  try { o = JSON.parse(linhas.at(-1)); } catch { /* sem JSON: quem chama ve o r */ }
  return { r, o };
}

test('pasta-temp 1. a raiz do processo sai inteira quando ele termina: saida normal e process.exit com codigo (o codigo nao muda)', () => {
  for (const fim of ['', 'process.exit(3);']) {
    const { r, o } = filho(`
      const fs = require('node:fs');
      const path = require('node:path');
      const a = p.pastaTemp('teste-a-');
      const b = p.pastaTemp('teste b ');
      fs.mkdirSync(path.join(a, 'x', 'y'), { recursive: true });
      fs.writeFileSync(path.join(a, 'x', 'y', 'z.json'), '{}');
      fs.writeFileSync(path.join(b, 'w.txt'), 'w');
      const tmp = require('node:os').tmpdir(); // fora do pastaTemp: o teste confere onde a raiz nasce
      console.log(JSON.stringify({ a, b, tmp, existe: fs.existsSync(path.join(a, 'x', 'y', 'z.json')) }));
      ${fim}`);
    assert.equal(r.status, fim ? 3 : 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.ok(o, r.stdout);
    assert.equal(o.existe, true);
    const raiz = path.dirname(o.a);
    assert.equal(path.dirname(o.b), raiz, 'as 2 pastas na mesma raiz');
    assert.equal(path.dirname(raiz), path.resolve(o.tmp), 'a raiz no TEMP do processo');
    assert.match(path.basename(raiz), /^sessoes-wpp-testes-\d+-/);
    assert.match(path.basename(o.a), /^teste-a-/);
    assert.match(path.basename(o.b), /^teste b /);
    assert.equal(fs.existsSync(raiz), false, `a raiz saiu (${fim || 'saida normal'})`);
  }
});

test('pasta-temp 2. arquivo ainda aberto na pasta no fim nunca derruba o processo (codigo 0, stderr vazio)', () => {
  const { r, o } = filho(`
    const fs = require('node:fs');
    const path = require('node:path');
    const a = p.pastaTemp('preso-');
    const fd = fs.openSync(path.join(a, 'aberto.txt'), 'w'); // fica aberto ate o processo acabar
    fs.writeSync(fd, 'x');
    console.log(JSON.stringify({ a }));`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.ok(o, r.stdout);
  fs.rmSync(path.dirname(o.a), { recursive: true, force: true }); // o Windows pode ter segurado: sobra limpa aqui
});

test('pasta-temp 3. pastaTemp: cada chamada = pasta nova e vazia, com o prefixo, na mesma raiz', () => {
  const a = pastaTemp('x-');
  const b = pastaTemp('x-');
  assert.notEqual(a, b);
  assert.equal(path.dirname(a), path.dirname(b));
  assert.match(path.basename(a), /^x-/);
  assert.deepEqual(fs.readdirSync(a), []);
  assert.deepEqual(fs.readdirSync(b), []);
});

// O que cria pasta ou arquivo temporario por fora do pastaTemp: mkdtemp (sincrono ou nao) e o tmpdir() do node:os. A
// classe [p]/[r] deixa a propria linha da regra fora do que ela pega. Linha com "fora do pastaTemp:" (o motivo) passa.
const POR_FORA = /\bmkdtem[p](?:Sync)?\s*\(|\btmpdi[r]\s*\(/;
const LIBERADA = /fora do pastaTemp:/;
const COMENTARIO = /^\s*(\/\/|\*|\/\*)/;
const porFora = (l) => POR_FORA.test(l) && !LIBERADA.test(l) && !COMENTARIO.test(l);

test('pasta-temp 4. nenhum teste cria pasta temporaria por fora do pastaTemp (o detector pega as formas de antes)', () => {
  const amostra = (s) => s.replaceAll('@', ''); // o @ deixa as amostras fora da varredura deste arquivo
  for (const s of [
    "  const raiz = fs.mkdtemp@Sync(path.join(os.tmp@dir(), 'porteiro-'));",
    "  const estadoDir = mkdtemp@Sync(join(tmp@dir(), 'mens-'));",
    "  const d = await fs.promises.mkdtemp@(path.join('x', 'y-'));",
    '  const t = os.tmp@dir();',
  ]) assert.equal(porFora(amostra(s)), true, amostra(s));
  for (const s of [
    "  const raiz = pastaTemp('porteiro-');",
    "  // antes: fs.mkdtemp@Sync(path.join(os.tmp@dir(), 'porteiro-'))",
    '  const t = os.tmp@dir(); // fora do pastaTemp: o motivo',
  ]) assert.equal(porFora(amostra(s)), false, amostra(s));

  const arquivos = [
    ...fs.readdirSync(path.join(REPO, 'tests')).filter((f) => f.endsWith('.test.mjs')).map((f) => path.join('tests', f)),
    ...fs.readdirSync(path.join(REPO, 'hooks', 'tests')).filter((f) => f.endsWith('.test.js')).map((f) => path.join('hooks', 'tests', f)),
  ];
  assert.ok(arquivos.length >= 20, `${arquivos.length} arquivos de teste`);
  const fora = [];
  for (const rel of arquivos) {
    fs.readFileSync(path.join(REPO, rel), 'utf8').split(/\r?\n/).forEach((l, i) => {
      if (porFora(l)) fora.push(`${rel}:${i + 1}`);
    });
  }
  assert.deepEqual(fora, [], 'pasta temporaria por fora do pastaTemp');
});

test('pasta-temp 5. o sabotar roda o mutante com o TEMP numa pasta propria e apaga ela no fim (vermelho continua vermelho)', { skip: SEM_SABOTAR }, () => {
  const co = pastaTemp('sabotar-');
  fs.mkdirSync(path.join(co, 'tests'));
  fs.writeFileSync(path.join(co, 'alvo.mjs'), 'export const VALOR = 1;\n');
  const marca = path.join(co, 'tmp-do-mutante.txt');
  // o teste do checkout anota o TEMP que recebeu, cria uma pasta e um arquivo nele (sem apagar) e fica vermelho com o
  // alvo sabotado
  fs.writeFileSync(path.join(co, 'tests', 'alvo.test.mjs'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import fs from 'node:fs';",
    "import os from 'node:os';",
    "import path from 'node:path';",
    "import { VALOR } from '../alvo.mjs';",
    "test('alvo', () => {",
    '  const t = os.tmpdir(); // fora do pastaTemp: o mutante anota o TEMP que recebeu',
    `  fs.writeFileSync(${JSON.stringify(marca)}, t);`,
    "  fs.mkdirSync(path.join(t, 'sobra-do-mutante'), { recursive: true });",
    "  fs.writeFileSync(path.join(t, 'sobra-do-mutante', 'x.txt'), 'x');",
    '  assert.equal(VALOR, 1);',
    '});',
    '',
  ].join('\n'));
  const lista = path.join(co, 'lista.mjs');
  fs.writeFileSync(lista, [
    "export const TESTES = { 'alvo.mjs': ['tests/alvo.test.mjs'] };",
    "export const S = [['valor trocado', 'alvo.mjs', [['VALOR = 1', 'VALOR = 2']]]];",
    '',
  ].join('\n'));
  // sem o NODE_TEST_CONTEXT deste runner: com ele, o node --test que o sabotar abre vira "filho" e nao imprime o resumo
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [SABOTAR, co, lista], { encoding: 'utf8', timeout: 120000, env });
  assert.match(r.stdout, /valor trocado: VERMELHO/, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(path.join(co, 'alvo.mjs'), 'utf8'), 'export const VALOR = 1;\n', 'o alvo voltou igual');
  const tmpMutante = fs.readFileSync(marca, 'utf8');
  assert.match(path.basename(tmpMutante), /^sessoes-wpp-sabotagem-/, `TEMP do mutante: ${tmpMutante}`);
  assert.equal(fs.existsSync(tmpMutante), false, 'o TEMP do mutante saiu com a sobra dele');
});

// 18/10/2026 (t30, mutantes 22-24): o mutante com erro de sintaxe derrubava o arquivo de teste ao carregar e contava como
// VERMELHO sem teste nenhum pegar. Agora sai "MUTANTE QUEBRADO", nao roda, conta como ruim (e o --checar ja acusa).
test('pasta-temp 5b. o sabotar recusa o mutante com erro de sintaxe (nunca conta como vermelho), no --checar tambem', { skip: SEM_SABOTAR }, () => {
  const co = pastaTemp('sabotar-sintaxe-');
  fs.mkdirSync(path.join(co, 'tests'));
  const original = 'export const VALOR = 1; // um: comentario\n';
  fs.writeFileSync(path.join(co, 'alvo.mjs'), original);
  fs.writeFileSync(path.join(co, 'tests', 'alvo.test.mjs'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { VALOR } from '../alvo.mjs';",
    "test('alvo', () => assert.equal(VALOR, 1));",
    '',
  ].join('\n'));
  const lista = path.join(co, 'lista.mjs');
  // a ancora corta o comentario no meio: sobra ": comentario" depois do codigo novo
  fs.writeFileSync(lista, [
    "export const TESTES = { 'alvo.mjs': ['tests/alvo.test.mjs'] };",
    "export const S = [['comentario cortado', 'alvo.mjs', [['VALOR = 1; // um', 'VALOR = 2,']]]];",
    '',
  ].join('\n'));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (const extra of [[], ['--checar']]) {
    const r = spawnSync(process.execPath, [SABOTAR, co, lista, ...extra], { encoding: 'utf8', timeout: 120000, env });
    assert.match(r.stdout, /comentario cortado: MUTANTE QUEBRADO \(erro de sintaxe/, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /VERMELHO|todas vermelhas|alvos conferidos/, r.stdout);
    assert.match(r.stdout, /== 1 sabotagem\(ns\) sem pegar/, r.stdout);
    assert.equal(fs.readFileSync(path.join(co, 'alvo.mjs'), 'utf8'), original, 'o alvo nao foi tocado');
  }
});
