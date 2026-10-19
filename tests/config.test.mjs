// Testes de lib/config.mjs (fase A1a do PLANO-ABERTO.md, "A1 — Telegram pela configuração": testes 1, 2 e 3).
// Por que existe: o chat do dono, o id do bot, o nome do bot e a variavel da chave saem do codigo e passam a vir do
// `<estadoDir>/config.json`; config ausente ou ruim nunca derruba quem le (padroes e null).
// Isolamento: o config.json e sempre de uma pasta temporaria (pastaTemp); dado sintetico (nunca o config real).
// O modulo entra por import dinamico em cada teste: no codigo de antes ele nao existe e cada teste fica vermelho sozinho.
// Rodar: node --test --test-reporter=tap "tests/config.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pastaTemp } from './lib/pasta-temp.cjs';

const modulo = () => import('../lib/config.mjs');
const PADRAO_NOME = 'sem nome'; // A4a: o padrao neutro (era o nome do bot do dono)
const PADRAO_VAR = 'SESSOES_WPP_TELEGRAM_TOKEN';

test('A1 1. lerConfig: config.json ausente, JSON podre, array, numero, null e texto = {}; objeto = ele mesmo; nunca lanca nem escreve', async () => {
  const { lerConfig } = await modulo();
  const dir = pastaTemp('a1-config-');
  const arq = path.join(dir, 'config.json');
  assert.deepEqual(lerConfig(dir), {}, 'ausente');
  assert.deepEqual(lerConfig(undefined), {}, 'sem pasta');
  assert.deepEqual(lerConfig(''), {}, 'pasta vazia');
  assert.deepEqual(lerConfig(42), {}, 'pasta que nao e texto');
  for (const [nome, bruto] of [['JSON podre', '{nao e json'], ['array', '[1, 2]'], ['numero', '42'], ['null', 'null'], ['texto', '"x"'], ['vazio', '']]) {
    fs.writeFileSync(arq, bruto);
    assert.deepEqual(lerConfig(dir), {}, nome);
  }
  const obj = { telegram: { ligado: true, chatId: 42, ok: { ligado: true } }, centralNota: 'x', outro: [1, 2] };
  fs.writeFileSync(arq, JSON.stringify(obj));
  assert.deepEqual(lerConfig(dir), obj, 'objeto = ele mesmo, campo desconhecido inclusive');
  const antes = fs.readFileSync(arq, 'utf8');
  lerConfig(dir);
  assert.equal(fs.readFileSync(arq, 'utf8'), antes, 'so le');
  // config.json que e pasta (EISDIR): nunca lanca
  const dir2 = pastaTemp('a1-config-pasta-');
  fs.mkdirSync(path.join(dir2, 'config.json'));
  assert.deepEqual(lerConfig(dir2), {}, 'config.json que e pasta');
});

test('A1 2. identidadeTelegram: chatId/botId inteiro seguro > 0 (numero ou texto de ate 16 digitos) senao null; nomeBot aparado 1-64 e varChave no formato senao o padrao; cfg ruim = padroes e null', async () => {
  const { identidadeTelegram, PADRAO_TG } = await modulo();
  assert.deepEqual({ ...PADRAO_TG }, { nomeBot: PADRAO_NOME, varChave: PADRAO_VAR });
  assert.ok(Object.isFrozen(PADRAO_TG), 'PADRAO_TG congelado');
  const vazio = { chatId: null, botId: null, nomeBot: PADRAO_NOME, varChave: PADRAO_VAR };
  const tg = (telegram) => identidadeTelegram({ telegram });

  assert.deepEqual(tg({ chatId: 42, botId: 7, nomeBot: 'Meu Bot', varChave: 'MINHA_CHAVE' }),
    { chatId: 42, botId: 7, nomeBot: 'Meu Bot', varChave: 'MINHA_CHAVE' }, 'tudo bom = tudo do config');
  for (const campo of ['chatId', 'botId']) {
    assert.equal(tg({ [campo]: 42 })[campo], 42, `${campo} 42`);
    assert.equal(tg({ [campo]: '42' })[campo], 42, `${campo} "42"`);
    assert.equal(tg({ [campo]: '1234567890123456' })[campo], 1234567890123456, `${campo} com 16 digitos`);
    for (const ruim of [0, -1, 1.5, '4a', '12345678901234567', 12345678901234567, '9999999999999999', ' 42', '', '-1', '0', true, null, [42], { id: 42 }, Number.NaN]) {
      assert.equal(tg({ [campo]: ruim })[campo], null, `${campo} ${JSON.stringify(ruim)}`);
    }
    // 17 digitos com valor pequeno: o teto e o do texto (sabotagem a1a #6), nao so o do inteiro seguro
    assert.equal(tg({ [campo]: '00000000000000042' })[campo], null, `${campo} com 17 digitos e valor 42`);
    assert.equal(tg({ [campo]: '0000000000000042' })[campo], 42, `${campo} com 16 digitos e valor 42`);
    assert.equal(tg({})[campo], null, `${campo} ausente`);
  }
  assert.equal(tg({ nomeBot: '  Meu Bot  ' }).nomeBot, 'Meu Bot', 'nomeBot aparado');
  assert.equal(tg({ nomeBot: 'a'.repeat(64) }).nomeBot, 'a'.repeat(64), '64 letras passa');
  for (const ruim of ['', '  ', 7, 'a'.repeat(65), null, ['x'], { nome: 'x' }]) {
    assert.equal(tg({ nomeBot: ruim }).nomeBot, PADRAO_NOME, `nomeBot ${JSON.stringify(ruim)}`);
  }
  for (const bom of ['MINHA_CHAVE', '_A1', 'x', `A${'b'.repeat(99)}`]) {
    assert.equal(tg({ varChave: bom }).varChave, bom, `varChave ${bom}`);
  }
  for (const ruim of ['X Y', '1A', '', ' MINHA_CHAVE', 'MINHA-CHAVE', `A${'b'.repeat(100)}`, 7, null]) {
    assert.equal(tg({ varChave: ruim }).varChave, PADRAO_VAR, `varChave ${JSON.stringify(ruim)}`);
  }
  for (const ruim of [null, undefined, [], [{ telegram: { chatId: 42 } }], 42, 'x', {}, { telegram: null }, { telegram: [] }, { telegram: 'x' }, { telegram: 42 }]) {
    assert.deepEqual(identidadeTelegram(ruim), vazio, `cfg ${JSON.stringify(ruim)}`);
  }
  // um campo ruim nao invalida os outros
  assert.deepEqual(tg({ chatId: 'x', botId: 7, nomeBot: '', varChave: 'MINHA_CHAVE' }),
    { chatId: null, botId: 7, nomeBot: PADRAO_NOME, varChave: 'MINHA_CHAVE' });
});

test('A1 3. botIdDaChave: o numero antes do 1o ":" ou null; nunca devolve o resto', async () => {
  const { botIdDaChave } = await modulo();
  assert.equal(botIdDaChave('123:abc'), 123);
  assert.equal(botIdDaChave('123:abc:def'), 123, 'o 1o ":"');
  for (const ruim of ['abc:1', '123', ':x', '0:x', '-1:x', '12a:x', ' 123:x', '', null, undefined, 123, {}]) {
    assert.equal(botIdDaChave(ruim), null, JSON.stringify(ruim));
  }
  const r = botIdDaChave('777:SEGREDO-falso');
  assert.equal(typeof r, 'number');
  assert.ok(!String(r).includes('SEGREDO'));
});

// T29a (PLANO-TELEGRAM.md, "T29a"; pedido do dono 18/10/2026 18:58, Telegram: «um botão no menu pra ligar ou desligar a
// resposta por voz»): o /voz grava `voz.ligada`; na subida so `false` desliga (ausente ou outro valor = ligada).
test('T29a. vozLigadaDoConfig: so voz.ligada === false desliga; ausente, outro valor, bloco torto ou cfg torto = ligada', async () => {
  const { vozLigadaDoConfig } = await modulo();
  assert.deepEqual(vozLigadaDoConfig({ voz: { ligada: false } }), { ligada: false });
  assert.deepEqual(vozLigadaDoConfig({ voz: { nome: 'pt-BR-AntonioNeural', ligada: false } }), { ligada: false });
  for (const cfg of [
    {}, null, undefined, [], 'x', { voz: {} }, { voz: { ligada: true } }, { voz: { ligada: 'false' } }, { voz: { ligada: 0 } },
    { voz: { ligada: null } }, { voz: 'desligada' }, { voz: [false] }, { voz: null }, { telegram: { voz: { ligada: false } } },
  ]) {
    assert.deepEqual(vozLigadaDoConfig(cfg), { ligada: true }, JSON.stringify(cfg) ?? String(cfg));
  }
});
