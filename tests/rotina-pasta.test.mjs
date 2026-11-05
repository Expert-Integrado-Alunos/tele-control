// sessoes-wpp — T37b1: o lado do DISCO da rotina do dia (lib/rotina-pasta.mjs): a chave telegram.rotina.ligado do
// config.json, o filtro dos nomes da pasta de entrada <estadoDir>/rotina/, a leitura (JSON ilegivel = motivo 'ilegivel')
// e o renomear pro fim (.enviado/.recusado/.falhou, num rename so; o destino que ja existe e substituido). T37b2: o
// append do registro de acoes (acoes.jsonl).
// Isolamento: so pastas temporarias (pastaTemp). Rodar: node --test --test-reporter=tap "tests/rotina-pasta.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pastaTemp } from './lib/pasta-temp.cjs';
import {
  lerConfigRotina, pastaRotina, listarLotesRotina, lerLoteRotina, marcarLoteRotina, anotarAcaoRotina,
} from '../lib/rotina-pasta.mjs';
import { linhaDeAcao } from '../lib/rotina-tg.mjs';

test('T37b1 rotina-pasta 1. lerConfigRotina: so telegram.ligado === true e telegram.rotina.ligado === true ligam', () => {
  const dir = pastaTemp('t37b1-cfg-');
  const grava = (cfg) => fs.writeFileSync(path.join(dir, 'config.json'), typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
  assert.deepEqual(lerConfigRotina(dir), { ligado: false }, 'sem config.json');
  grava({ telegram: { ligado: true, rotina: { ligado: true } } });
  assert.deepEqual(lerConfigRotina(dir), { ligado: true });
  for (const cfg of [
    '{ nao e json',
    { telegram: { ligado: true } },
    { telegram: { ligado: true, ok: { ligado: true } } },
    { telegram: { ligado: false, rotina: { ligado: true } } },
    { telegram: { ligado: 'true', rotina: { ligado: true } } },
    { telegram: { ligado: true, rotina: { ligado: 'true' } } },
    { telegram: { ligado: true, rotina: { ligado: 1 } } },
    { telegram: { ligado: true, rotina: {} } },
    { telegram: { ligado: true, rotina: true } },
    { telegram: { ligado: true, rotina: [{ ligado: true }] } },
    { telegram: [], rotina: { ligado: true } },
    { rotina: { ligado: true } },
  ]) {
    grava(cfg);
    assert.deepEqual(lerConfigRotina(dir), { ligado: false }, JSON.stringify(cfg));
  }
  assert.deepEqual(lerConfigRotina(''), { ligado: false });
  assert.deepEqual(lerConfigRotina(undefined), { ligado: false });
});

test('T37b1 rotina-pasta 2. listarLotesRotina: so lote-<AAAAMMDD><m|t|n>.json, em ordem; pasta ausente = []', () => {
  const dir = pastaTemp('t37b1-lista-');
  const pasta = pastaRotina(dir);
  assert.equal(pasta, path.join(dir, 'rotina'));
  assert.deepEqual(listarLotesRotina(pasta), [], 'pasta ausente');
  fs.mkdirSync(pasta);
  assert.deepEqual(listarLotesRotina(pasta), [], 'pasta vazia');
  const fora = [
    'lote-20261105m.enviado.json', 'lote-20261105m.recusado.json', 'lote-20261105m.falhou.json', 'lote-20261105m.json.tmp',
    'lote-2026110m.json', 'lote-202611051m.json', 'lote-20261105x.json', 'lote-20261107M.json', 'Lote-20261108m.json',
    'lote-20261109m.JSON', 'xlote-20261110m.json', 'lote-20261111.json', 'outro.json', 'leia.txt',
  ];
  for (const n of ['lote-20261105t.json', 'lote-20261105m.json', 'lote-20261104n.json', ...fora]) fs.writeFileSync(path.join(pasta, n), '{}');
  fs.mkdirSync(path.join(pasta, 'lote-20261106m.json')); // pasta com o nome certo: fica de fora
  assert.deepEqual(listarLotesRotina(pasta), ['lote-20261104n.json', 'lote-20261105m.json', 'lote-20261105t.json']);
});

test('T37b1 rotina-pasta 3. lerLoteRotina: JSON legivel = {ok, obj}; ilegivel = motivo ilegivel; sumiu = motivo sumiu', () => {
  const pasta = pastaTemp('t37b1-ler-');
  fs.writeFileSync(path.join(pasta, 'lote-20261105m.json'), JSON.stringify({ versao: 1, id: '20261105m' }));
  assert.deepEqual(lerLoteRotina(pasta, 'lote-20261105m.json'), { ok: true, obj: { versao: 1, id: '20261105m' } });
  for (const conteudo of ['{ nao e json', '', '{"versao": 1,', '\u0000\u0001']) {
    fs.writeFileSync(path.join(pasta, 'lote-20261105t.json'), conteudo);
    assert.deepEqual(lerLoteRotina(pasta, 'lote-20261105t.json'), { ok: false, motivo: 'ilegivel' }, JSON.stringify(conteudo));
  }
  fs.mkdirSync(path.join(pasta, 'lote-20261106m.json')); // le uma pasta = erro de leitura que nao e ENOENT
  assert.deepEqual(lerLoteRotina(pasta, 'lote-20261106m.json'), { ok: false, motivo: 'ilegivel' });
  assert.deepEqual(lerLoteRotina(pasta, 'lote-20261105n.json'), { ok: false, motivo: 'sumiu' });
  assert.throws(() => lerLoteRotina(pasta, '../config.json'), TypeError);
  assert.throws(() => lerLoteRotina(pasta, 'lote-20261105m.enviado.json'), TypeError);
});

test('T37b1 rotina-pasta 4. marcarLoteRotina: .enviado/.recusado/.falhou num rename so; o destino que ja existe e substituido', () => {
  const pasta = pastaTemp('t37b1-marcar-');
  const arq = (n) => path.join(pasta, n);
  for (const fim of ['enviado', 'recusado', 'falhou']) {
    fs.writeFileSync(arq('lote-20261105m.json'), `novo ${fim}`);
    fs.writeFileSync(arq(`lote-20261105m.${fim}.json`), 'antigo'); // o destino ja existe
    assert.deepEqual(marcarLoteRotina(pasta, 'lote-20261105m.json', fim), { ok: true, destino: `lote-20261105m.${fim}.json` });
    assert.equal(fs.existsSync(arq('lote-20261105m.json')), false, 'a entrada sumiu');
    assert.equal(fs.readFileSync(arq(`lote-20261105m.${fim}.json`), 'utf8'), `novo ${fim}`, 'o destino antigo foi substituido');
  }
  assert.deepEqual(listarLotesRotina(pasta), [], 'o renomeado nunca volta pra lista');
  assert.deepEqual(marcarLoteRotina(pasta, 'lote-20261105t.json', 'enviado'), { ok: false, erro: 'ENOENT' }, 'arquivo que sumiu');
  assert.throws(() => marcarLoteRotina(pasta, 'lote-20261105m.json', 'apagado'), TypeError);
  assert.throws(() => marcarLoteRotina(pasta, '../estado.json', 'enviado'), TypeError);
});

test('T37b2 rotina-pasta 5. anotarAcaoRotina: cria a pasta, acrescenta sem reescrever (2 linhas = 2 JSON legiveis); disco que falha = {ok:false, erro}; linha torta = TypeError', () => {
  const dir = pastaTemp('t37b2-acoes-');
  const pasta = pastaRotina(dir);
  const arq = path.join(pasta, 'acoes.jsonl');
  const cartao = (n, assinatura) => ({ n, id: `prazo:${n}`, assinatura, titulo: 'Titulo que nao vai pra linha', texto: 'Texto que nao vai' });
  const l1 = linhaDeAcao({ ts: '2026-11-05T11:31:00.000Z', loteId: '20261105m', cartao: cartao(2, 'a2'), verbo: 'sim' });
  const l2 = linhaDeAcao({ ts: '2026-11-05T11:32:00.000Z', loteId: '20261105m', cartao: cartao(4, ''), verbo: 'adiar' });
  assert.equal(fs.existsSync(pasta), false, 'a pasta ainda nao existe');
  assert.deepEqual(anotarAcaoRotina(pasta, l1), { ok: true });
  assert.equal(fs.readFileSync(arq, 'utf8'), l1, 'criou a pasta e o arquivo com a 1a linha');
  assert.deepEqual(anotarAcaoRotina(pasta, l2), { ok: true });
  const texto = fs.readFileSync(arq, 'utf8');
  assert.equal(texto, l1 + l2, 'a 1a linha ficou como estava e a 2a veio no fim');
  const linhas = texto.split('\n');
  assert.equal(linhas.pop(), '', 'termina em \\n');
  assert.deepEqual(linhas.map((x) => JSON.parse(x)), [
    { ts: '2026-11-05T11:31:00.000Z', lote: '20261105m', n: 2, id: 'prazo:2', assinatura: 'a2', verbo: 'sim', origem: 'botao' },
    { ts: '2026-11-05T11:32:00.000Z', lote: '20261105m', n: 4, id: 'prazo:4', assinatura: '', verbo: 'adiar', origem: 'botao' },
  ], '2 linhas = 2 JSON legiveis');

  // o disco que falha (acoes.jsonl que e uma pasta) = {ok:false, erro} com o codigo, nunca excecao
  const outra = pastaRotina(pastaTemp('t37b2-acoes-ruim-'));
  fs.mkdirSync(path.join(outra, 'acoes.jsonl'), { recursive: true });
  const r = anotarAcaoRotina(outra, l1);
  assert.equal(r.ok, false);
  assert.ok(typeof r.erro === 'string' && r.erro.length > 0 && r.erro.length <= 40, JSON.stringify(r));
  for (const ruim of ['', '\n', 'sem fim de linha', 'duas\nlinhas\n', 'com retorno\r\n', 42, null, undefined]) {
    assert.throws(() => anotarAcaoRotina(pasta, ruim), TypeError, JSON.stringify(ruim));
  }
  assert.equal(fs.readFileSync(arq, 'utf8'), l1 + l2, 'a linha torta nao encostou no arquivo');
});
