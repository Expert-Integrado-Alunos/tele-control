// Testes do M6 do porte pro Mac (PLANO-MAC.md, "Plano B", "Teste num Mac do GitHub"): o ensaio num macOS do GitHub, so
// por disparo manual (.github/workflows/ensaio-mac.yml), e o roteiro dele (tools/mac/ensaio-mac.mjs, so darwin).
// - 1: o YAML (lido como texto): so workflow_dispatch, teto de 15 min, macos-15, contents: read, nenhuma chave.
// - 2: fora do darwin o ensaio sai 2 com 1 linha e nao cria nada no TEMP (prefixo m6-). No Mac ele pula: la o ensaio
//   roda de verdade (no passo proprio do workflow), nunca dentro da bateria.
// - 3: as funcoes puras do relatorio: a linha da tabela, o escape do |, o codigo de saida pela contagem de ❌ e a leitura
//   do TAP da bateria.
// - 4: node --check do ensaio.
// Na copia aberta o tools/ e o .github/ nao vao (export-ignore): sem o YAML o teste 1 pula; sem o ensaio-mac.mjs, os
// testes 2-4. Nada aqui roda launchctl, tmux, security nem rede.
// Rodar: node --test --test-reporter=tap "tests/mac-m6.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const YAML = path.join(REPO, '.github', 'workflows', 'ensaio-mac.yml');
const ENSAIO = path.join(REPO, 'tools', 'mac', 'ensaio-mac.mjs');
const SEM_ENSAIO = fs.existsSync(ENSAIO) ? false : 'sem o tools/mac/ensaio-mac.mjs (fica fora da copia aberta)';
const SEM_YAML = fs.existsSync(YAML) ? false : 'sem o .github/ (fica fora da copia aberta)';
const NO_MAC = process.platform === 'darwin' ? 'no Mac o ensaio roda de verdade (passo proprio do workflow)' : false;

// As pastas m6-* do TEMP do sistema (o ensaio cria a dele ali, so no darwin)
const m6NoTemp = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('m6-')).sort(); // fora do pastaTemp: confere o TEMP do sistema

test('M6 1. workflow: so disparo manual, macos-15 com teto de 15 min, contents: read e nenhuma chave', { skip: SEM_YAML }, () => {
  // checkout no Windows com core.autocrlf=true poe CRLF (o `.` da regex do bloco on: nao casa o \r)
  const y = fs.readFileSync(YAML, 'utf8').replace(/\r\n/g, '\n');
  assert.match(y, /^\s*workflow_dispatch:\s*$/m);
  assert.doesNotMatch(y, /\bpush\s*:/);
  assert.doesNotMatch(y, /pull_request/);
  assert.doesNotMatch(y, /schedule/);
  // o bloco `on:` tem so o workflow_dispatch (nenhum outro gatilho escrito de outro jeito)
  const on = /^on:\s*\n((?:[ \t]+.*\n|\s*\n)*)/m.exec(y);
  assert.ok(on, 'tem o bloco on:');
  assert.deepEqual(on[1].split('\n').map((l) => l.trim()).filter(Boolean), ['workflow_dispatch:']);
  assert.match(y, /^\s*timeout-minutes:\s*15\s*$/m);
  assert.match(y, /^\s*runs-on:\s*macos-15\s*$/m);
  assert.match(y, /^\s*contents:\s*read\s*$/m);
  assert.match(y, /^\s*group:\s*ensaio-mac\s*$/m);
  assert.match(y, /^\s*cancel-in-progress:\s*false\s*$/m);
  assert.doesNotMatch(y, /secrets\./);
  assert.doesNotMatch(y, /upload-artifact/);
  assert.match(y, /actions\/checkout@v4/);
  assert.match(y, /actions\/setup-node@v4/);
  assert.match(y, /node-version:\s*'22'/);
  assert.match(y, /command -v tmux/);
  assert.match(y, /node --test .*"tests\/mac-\*\.test\.mjs"/);
  assert.match(y, /continue-on-error:\s*true/);
  assert.match(y, /node tools\/mac\/ensaio-mac\.mjs/);
});

test('M6 2. fora do darwin o ensaio sai 2 com 1 linha e nao cria nada m6- no TEMP', { skip: SEM_ENSAIO || NO_MAC }, () => {
  const antes = m6NoTemp();
  const r = spawnSync(process.execPath, [ENSAIO], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(r.status, 2, r.stderr);
  const linhas = `${r.stdout}${r.stderr}`.split(/\r?\n/).filter((l) => l.trim());
  assert.equal(linhas.length, 1, linhas.join(' / '));
  assert.match(linhas[0], /macOS/);
  assert.deepEqual(m6NoTemp(), antes);
});

test('M6 3. relatorio: linha da tabela, escape do |, codigo de saida pelos ❌ e o TAP da bateria (puras)', { skip: SEM_ENSAIO }, async () => {
  const m = await import(pathToFileURL(ENSAIO).href);
  const { OK, FALHA, INFO } = m.SINAIS;
  assert.deepEqual([OK, FALHA, INFO], ['✅', '❌', 'ℹ️']);
  assert.equal(m.linhaDaTabela({ medicao: 'a1 ps', esperado: 'nome node', visto: 'nome node', sinal: OK }),
    '| a1 ps | nome node | nome node | ✅ |');
  // o | do texto vira \| e a quebra de linha vira ⏎: a linha continua com 4 celulas
  const l = m.linhaDaTabela({ medicao: 'x|y', esperado: '', visto: 'a | b\r\nc', sinal: INFO });
  assert.equal(l, '| x\\|y |  | a \\| b ⏎ c | ℹ️ |');
  assert.equal(l.match(/(?<!\\)\|/g).length, 5);
  assert.equal(m.escaparCelula(null), '');
  assert.equal(m.escaparCelula('a\\|b'), 'a\\\\\\|b');
  assert.ok(m.escaparCelula('x'.repeat(2000)).length <= 600, 'celula longa e cortada');
  assert.equal(m.codigoDeSaida([]), 0);
  assert.equal(m.codigoDeSaida([{ sinal: OK }, { sinal: INFO }]), 0);
  assert.equal(m.codigoDeSaida([{ sinal: OK }, { sinal: FALHA }, { sinal: INFO }]), 1);
  assert.deepEqual(m.contarSinais([{ sinal: OK }, { sinal: FALHA }, { sinal: FALHA }, { sinal: INFO }]), { ok: 1, falha: 2, info: 1 });
  const tap = [
    'TAP version 13', '# Subtest: a', 'ok 1 - a', 'not ok 2 - b falhou', '  ---', '  ...',
    '    not ok 1 - sub \\# 2', 'not ok 3 - pendente # TODO depois', 'ok 4 - pulado # SKIP sem tmux',
    '# tests 4', '# pass 1', '# fail 2', '',
  ].join('\n');
  assert.deepEqual(m.lerTap(tap), { pass: 1, fail: 2, falhas: ['b falhou', 'sub \\# 2'] });
  assert.deepEqual(m.lerTap(''), { pass: null, fail: null, falhas: [] });
  const rel = m.montarRelatorio({ titulo: 'Ensaio', linhas: [{ medicao: 'a', esperado: 'b', visto: 'c', sinal: FALHA }], secoes: ['## Extra', 'x'] });
  assert.match(rel, /^# Ensaio$/m);
  assert.match(rel, /^\| medição \| esperado \| visto \| {2}\|$/m);
  assert.match(rel, /^\| a \| b \| c \| ❌ \|$/m);
  assert.match(rel, /1 ❌/);
  assert.match(rel, /^## Extra$/m);
});

test('M6 4. node --check do ensaio', { skip: SEM_ENSAIO }, () => {
  const r = spawnSync(process.execPath, ['--check', ENSAIO], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
});
