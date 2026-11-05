// Testes de lib/rotina-tg.mjs (T37a): a rotina do dia que chega pelo porteiro no chat do dono.
// A biblioteca e pura: nenhum teste toca disco (fora ler o proprio fonte), rede de verdade ou relogio (o agora entra
// por parametro). Ids, bot e sessao sinteticos.
// Rodar: node --test --test-reporter=tap "tests/rotina-tg.test.mjs"
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  VERBOS_POR_TIPO, ROTULOS, validarLote, tecladoDoCartao, tecladoDoResumo, lerToqueRotina, textoDepoisDoToque,
  avisoDoToque, textoResumoComProgresso, linhaDeAcao,
} from '../lib/rotina-tg.mjs';
import { linkDaAba } from '../lib/formato-tg.mjs';
import { criarTelegram } from '../telegram.mjs';

const AGORA = Date.parse('2026-11-05T11:30:00.000Z'); // 08h30 em Brasilia
const UMA_HORA = 3600 * 1000;
const BOT = 'bot_sintetico';
const SESSAO = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0';
const LINK = 'https://exemplo.com/conversa/1';

function cartao(extra = {}) {
  return {
    n: 1,
    id: 'wa:contato-1@pessoal',
    tipo: 'conversa',
    titulo: 'Proposta da padaria',
    texto: 'Pediu o preço ontem. Responder hoje.',
    verbos: ['responder', 'adiar', 'nao_precisa', 'delegar'],
    ...extra,
  };
}

function lote(extra = {}) {
  return {
    versao: 1,
    id: '20261105m',
    gerado_em: '2026-11-05T11:25:00.000Z',
    enviar: true,
    resumo: '3 itens: 1 conversa, 1 decisão, 1 aba.\nPrazo mais cedo: 10h.',
    cartoes: [
      cartao(),
      cartao({ n: 2, id: 'brain:t2', tipo: 'decisao', titulo: 'Fornecedor novo', texto: 'Fechar com o fornecedor B?', verbos: ['sim', 'nao', 'adiar', 'abrir'], link: 'https://exemplo.com/cartao/2', assinatura: 'v1' }),
      cartao({ n: 3, id: 'aba:x', tipo: 'aba', titulo: 'Aba do site', texto: 'Esperando o seu A/B.', verbos: ['abrir', 'adiar'], ref: { sessao: SESSAO } }),
    ],
    mais: 0,
    ...extra,
  };
}

const sem = (o, campo) => {
  const c = { ...o };
  delete c[campo];
  return c;
};
const comCartao = (extra) => lote({ cartoes: [cartao(extra)] });

// ---------- A.1 validarLote ----------

describe('T37a A.1 validarLote', () => {
  test('lote válido: ok e o lote normalizado (reserva ausente = [], link ausente = null, assinatura ausente = "", campo a mais fora)', () => {
    const entrada = lote({ extra: 'campo a mais' });
    entrada.cartoes[0].sobra = 'outro campo';
    const r = validarLote(entrada, { agoraMs: AGORA });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(Object.keys(r.lote), ['versao', 'id', 'gerado_em', 'enviar', 'resumo', 'cartoes', 'reserva', 'mais']);
    assert.deepEqual(r.lote.reserva, []);
    assert.equal(r.lote.mais, 0);
    assert.equal(r.lote.resumo, entrada.resumo);
    assert.deepEqual(r.lote.cartoes[0], {
      n: 1, id: 'wa:contato-1@pessoal', tipo: 'conversa', titulo: 'Proposta da padaria', texto: 'Pediu o preço ontem. Responder hoje.',
      verbos: ['responder', 'adiar', 'nao_precisa', 'delegar'], link: null, ref: null, assinatura: '',
    });
    assert.equal(r.lote.cartoes[1].link, 'https://exemplo.com/cartao/2');
    assert.equal(r.lote.cartoes[1].assinatura, 'v1');
    assert.deepEqual(r.lote.cartoes[2].ref, { sessao: SESSAO });
    assert.equal('extra' in r.lote, false);
  });

  test('reserva com até 5 cartões, n até 10 e únicos no lote; mais = inteiro >= 0', () => {
    const reserva = [4, 5, 6, 7, 10].map((n) => cartao({ n, id: `brain:r${n}`, tipo: 'prazo', verbos: ['feito', 'adiar', 'delegar'] }));
    const r = validarLote(lote({ reserva, mais: 7 }), { agoraMs: AGORA });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.lote.reserva.map((c) => c.n), [4, 5, 6, 7, 10]);
    assert.equal(r.lote.mais, 7);
    assert.equal(validarLote(lote({ reserva: null }), { agoraMs: AGORA }).ok, true, 'reserva null = ausente');
  });

  test('idade: no limite exato de maxIdadeMs passa, 1 ms a mais = velho; padrão 3 h; maxIdadeMs próprio vale', () => {
    const gerado = (ms) => lote({ gerado_em: new Date(AGORA - ms).toISOString() });
    assert.equal(validarLote(gerado(3 * UMA_HORA), { agoraMs: AGORA }).ok, true);
    assert.deepEqual(validarLote(gerado(3 * UMA_HORA + 1), { agoraMs: AGORA }), { ok: false, motivo: 'velho' });
    assert.deepEqual(validarLote(gerado(UMA_HORA + 1), { agoraMs: AGORA, maxIdadeMs: UMA_HORA }), { ok: false, motivo: 'velho' });
    assert.equal(validarLote(gerado(UMA_HORA), { agoraMs: AGORA, maxIdadeMs: UMA_HORA }).ok, true);
  });

  test('agoraMs ausente ou torto = TypeError (o relógio nunca é implícito)', () => {
    assert.throws(() => validarLote(lote()), TypeError);
    assert.throws(() => validarLote(lote(), { agoraMs: '2026-11-05' }), TypeError);
    assert.throws(() => validarLote(lote(), { agoraMs: NaN }), TypeError);
    assert.throws(() => validarLote(lote(), { agoraMs: AGORA, maxIdadeMs: -1 }), TypeError);
  });

  // 1 teste por regra de rejeicao: [nome, motivo (texto ou RegExp), variantes que reprovam]
  const REGRAS = [
    ['não é objeto', 'formato', [null, [], 'lote', 7, undefined]],
    ['versao diferente de 1', 'versao', [lote({ versao: 2 }), lote({ versao: '1' }), sem(lote(), 'versao')]],
    ['id fora de AAAAMMDD + m|t|n', 'id', [lote({ id: '20261105x' }), lote({ id: '2026115m' }), lote({ id: '20261105M' }), lote({ id: ' 20261105m' }), lote({ id: 20261105 }), sem(lote(), 'id')]],
    ['gerado_em ilegível', 'gerado_em', [lote({ gerado_em: 'ontem' }), lote({ gerado_em: '' }), lote({ gerado_em: AGORA }), sem(lote(), 'gerado_em')]],
    ['gerado_em mais velho que maxIdadeMs', 'velho', [lote({ gerado_em: new Date(AGORA - 3 * UMA_HORA - 1).toISOString() }), lote({ gerado_em: '2026-11-04T22:00:00.000Z' })]],
    ['enviar diferente de true', 'nao_enviar', [lote({ enviar: false }), lote({ enviar: 'true' }), lote({ enviar: 1 }), sem(lote(), 'enviar')]],
    ['resumo fora de 1..400', 'resumo', [lote({ resumo: '' }), lote({ resumo: '   ' }), lote({ resumo: 'x'.repeat(401) }), lote({ resumo: 5 }), sem(lote(), 'resumo')]],
    ['cartoes fora de 1..5', 'cartoes', [lote({ cartoes: [] }), lote({ cartoes: [1, 2, 3, 4, 5, 6].map((n) => cartao({ n })) }), lote({ cartoes: cartao() }), sem(lote(), 'cartoes')]],
    ['reserva fora de 0..5', 'reserva', [lote({ reserva: [4, 5, 6, 7, 8, 9].map((n) => cartao({ n })) }), lote({ reserva: {} }), lote({ reserva: 'x' })]],
    ['mais que não é inteiro >= 0', 'mais', [lote({ mais: -1 }), lote({ mais: 1.5 }), lote({ mais: '2' }), sem(lote(), 'mais')]],
    ['cartão que não é objeto', /^(cartoes|reserva)\[0\]$/, [lote({ cartoes: [null] }), lote({ cartoes: ['x'] }), lote({ cartoes: [[]] }), lote({ reserva: [7] })]],
    ['n fora de 1..10', 'cartoes[0].n', [comCartao({ n: 0 }), comCartao({ n: 11 }), comCartao({ n: 1.5 }), comCartao({ n: '1' }), comCartao({ n: undefined })]],
    ['n repetido no lote (cartões + reserva)', /^(cartoes\[1\]|reserva\[0\])\.n_repetido$/, [lote({ cartoes: [cartao(), cartao()] }), lote({ reserva: [cartao({ n: 2 })] })]],
    ['id do cartão fora de 1..160', 'cartoes[0].id', [comCartao({ id: '' }), comCartao({ id: 'x'.repeat(161) }), comCartao({ id: 7 }), comCartao({ id: undefined })]],
    ['tipo fora de conversa|decisao|prazo|agenda|aba|promessa', 'cartoes[0].tipo', [comCartao({ tipo: 'tarefa' }), comCartao({ tipo: 'constructor' }), comCartao({ tipo: '__proto__' }), comCartao({ tipo: 'Conversa' }), comCartao({ tipo: undefined })]],
    ['titulo fora de 1..40', 'cartoes[0].titulo', [comCartao({ titulo: '' }), comCartao({ titulo: 'x'.repeat(41) }), comCartao({ titulo: null })]],
    ['texto fora de 1..300', 'cartoes[0].texto', [comCartao({ texto: '' }), comCartao({ texto: 'x'.repeat(301) }), comCartao({ texto: ['x'] })]],
    ['verbos vazios, de outro tipo ou desconhecidos', 'cartoes[0].verbos', [comCartao({ verbos: [] }), comCartao({ verbos: ['sim'] }), comCartao({ verbos: ['responder', 'toString'] }), comCartao({ verbos: ['constructor'] }), comCartao({ verbos: ['mais'] }), comCartao({ verbos: 'responder' }), comCartao({ verbos: undefined })]],
    ['link que não é https:// sem espaço até 300', 'cartoes[0].link', [comCartao({ link: 'http://exemplo.com' }), comCartao({ link: 'https://' }), comCartao({ link: 'https://exemplo.com/a b' }), comCartao({ link: `https://x.com/${'a'.repeat(287)}` }), comCartao({ link: 'javascript:alert(1)' }), comCartao({ link: 42 }), comCartao({ link: '' })]],
    ['ref.sessao fora de [0-9a-f-]{8,64}', 'cartoes[0].ref.sessao', [comCartao({ ref: { sessao: 'zz-nao-hex' } }), comCartao({ ref: { sessao: 'abc1234' } }), comCartao({ ref: { sessao: 'a'.repeat(65) } }), comCartao({ ref: { sessao: 12345678 } }), comCartao({ ref: { sessao: '' } })]],
    ['assinatura acima de 200 ou que não é texto', 'cartoes[0].assinatura', [comCartao({ assinatura: 'x'.repeat(201) }), comCartao({ assinatura: 3 }), comCartao({ assinatura: {} })]],
    ['cartão da reserva passa pelas mesmas regras', 'reserva[0].tipo', [lote({ reserva: [cartao({ n: 4, tipo: 'tarefa' })] })]],
  ];
  for (const [nome, motivo, variantes] of REGRAS) {
    test(`rejeita: ${nome} -> ${motivo}`, () => {
      for (const [i, v] of variantes.entries()) {
        const r = validarLote(v, { agoraMs: AGORA });
        assert.equal(r.ok, false, `variante ${i}: ${JSON.stringify(r)}`);
        if (motivo instanceof RegExp) assert.match(r.motivo, motivo, `variante ${i}`);
        else assert.equal(r.motivo, motivo, `variante ${i}`);
        assert.equal('lote' in r, false);
      }
    });
  }
});

// ---------- A.2 a tabela ----------

describe('T37a A.2 VERBOS_POR_TIPO e ROTULOS', () => {
  test('a tabela do contrato, exata e congelada', () => {
    assert.deepEqual(VERBOS_POR_TIPO, {
      conversa: ['responder', 'adiar', 'nao_precisa', 'delegar'],
      decisao: ['sim', 'nao', 'adiar', 'abrir'],
      prazo: ['feito', 'adiar', 'delegar', 'abrir'],
      agenda: ['manter', 'remarcar', 'recusar', 'abrir'],
      promessa: ['feito', 'adiar', 'nao_precisa'],
      aba: ['abrir', 'adiar'],
    });
    assert.deepEqual(ROTULOS, {
      responder: 'Responder', adiar: 'Adiar', nao_precisa: 'Não precisa', delegar: 'Delegar', sim: 'Sim', nao: 'Não',
      abrir: 'Abrir', feito: 'Feito', manter: 'Manter', remarcar: 'Remarcar', recusar: 'Recusar',
    });
    assert.ok(Object.isFrozen(VERBOS_POR_TIPO) && Object.isFrozen(ROTULOS));
    assert.ok(Object.values(VERBOS_POR_TIPO).every(Object.isFrozen));
  });

  test('a biblioteca é pura: só importa o formato-tg e não lê relógio, disco nem rede', () => {
    const fonte = readFileSync(new URL('../lib/rotina-tg.mjs', import.meta.url), 'utf8');
    const imports = [...fonte.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    assert.deepEqual(imports, ['./formato-tg.mjs']);
    for (const proibido of ['Date.now', 'new Date(', 'performance.now', 'process.', 'fetch(', 'require(', 'setTimeout']) {
      assert.equal(fonte.includes(proibido), false, proibido);
    }
  });
});

// ---------- A.3 tecladoDoCartao ----------

describe('T37a A.3 tecladoDoCartao', () => {
  test('retorno: 2 botões por linha na ordem dos verbos, dados l:<lote>:<n>:<verbo>', () => {
    assert.deepEqual(tecladoDoCartao(cartao({ n: 4 }), '20261105m', { nomeBot: BOT }), [
      [{ texto: 'Responder', dados: 'l:20261105m:4:responder' }, { texto: 'Adiar', dados: 'l:20261105m:4:adiar' }],
      [{ texto: 'Não precisa', dados: 'l:20261105m:4:nao_precisa' }, { texto: 'Delegar', dados: 'l:20261105m:4:delegar' }],
    ]);
    assert.deepEqual(tecladoDoCartao(cartao({ n: 2, tipo: 'prazo', verbos: ['feito', 'adiar', 'delegar'] }), '20261105t'), [
      [{ texto: 'Feito', dados: 'l:20261105t:2:feito' }, { texto: 'Adiar', dados: 'l:20261105t:2:adiar' }],
      [{ texto: 'Delegar', dados: 'l:20261105t:2:delegar' }],
    ]);
  });

  test('link: responder e abrir com link viram botão de link (url, sem retorno); os outros seguem de retorno', () => {
    const t = tecladoDoCartao(cartao({ link: LINK }), '20261105m');
    assert.deepEqual(t[0], [{ texto: 'Responder', url: LINK }, { texto: 'Adiar', dados: 'l:20261105m:1:adiar' }]);
    const d = tecladoDoCartao(cartao({ n: 2, tipo: 'decisao', verbos: ['sim', 'nao', 'adiar', 'abrir'], link: LINK }), '20261105m');
    assert.deepEqual(d, [
      [{ texto: 'Sim', dados: 'l:20261105m:2:sim' }, { texto: 'Não', dados: 'l:20261105m:2:nao' }],
      [{ texto: 'Adiar', dados: 'l:20261105m:2:adiar' }, { texto: 'Abrir', url: LINK }],
    ]);
    assert.deepEqual(tecladoDoCartao(cartao({ n: 2, tipo: 'decisao', verbos: ['abrir'] }), '20261105m'), [[{ texto: 'Abrir', dados: 'l:20261105m:2:abrir' }]], 'sem link: retorno');
    assert.deepEqual(tecladoDoCartao(cartao({ link: 'http://exemplo.com' }), '20261105m')[0][0], { texto: 'Responder', dados: 'l:20261105m:1:responder' }, 'link fora da regra: retorno');
  });

  test('prazo e agenda com abrir: com link = botão de link; sem link = retorno (ajuste do contrato A.2)', () => {
    const prazo = cartao({ n: 5, tipo: 'prazo', titulo: 'Relatório do mês', verbos: ['feito', 'adiar', 'delegar', 'abrir'], link: LINK });
    const r = validarLote(lote({ cartoes: [prazo] }), { agoraMs: AGORA });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(tecladoDoCartao(r.lote.cartoes[0], '20261105m'), [
      [{ texto: 'Feito', dados: 'l:20261105m:5:feito' }, { texto: 'Adiar', dados: 'l:20261105m:5:adiar' }],
      [{ texto: 'Delegar', dados: 'l:20261105m:5:delegar' }, { texto: 'Abrir', url: LINK }],
    ]);
    assert.deepEqual(tecladoDoCartao({ ...prazo, link: undefined }, '20261105m')[1][1], { texto: 'Abrir', dados: 'l:20261105m:5:abrir' });
    const agenda = cartao({ n: 6, tipo: 'agenda', verbos: ['manter', 'remarcar', 'recusar', 'abrir'], link: LINK });
    assert.equal(validarLote(lote({ cartoes: [agenda] }), { agoraMs: AGORA }).ok, true);
    assert.deepEqual(tecladoDoCartao(agenda, '20261105n')[1], [{ texto: 'Recusar', dados: 'l:20261105n:6:recusar' }, { texto: 'Abrir', url: LINK }]);
  });

  test('aba: abrir com ref.sessao e nomeBot = link start=a_<sessão> do painel (linkDaAba, T10); faltando um = retorno', () => {
    const c = cartao({ n: 3, tipo: 'aba', verbos: ['abrir', 'adiar'], ref: { sessao: SESSAO } });
    const t = tecladoDoCartao(c, '20261105n', { nomeBot: BOT });
    assert.deepEqual(t, [[{ texto: 'Abrir', url: `https://t.me/${BOT}?start=a_${SESSAO}` }, { texto: 'Adiar', dados: 'l:20261105n:3:adiar' }]]);
    assert.equal(t[0][0].url, linkDaAba(BOT, SESSAO), 'o mesmo endereço que o painel monta');
    const retorno = { texto: 'Abrir', dados: 'l:20261105n:3:abrir' };
    assert.deepEqual(tecladoDoCartao(c, '20261105n')[0][0], retorno, 'sem nomeBot');
    assert.deepEqual(tecladoDoCartao(c, '20261105n', { nomeBot: 'x y' })[0][0], retorno, 'nomeBot torto');
    assert.deepEqual(tecladoDoCartao({ ...c, ref: undefined }, '20261105n', { nomeBot: BOT })[0][0], retorno, 'sem ref');
    assert.deepEqual(tecladoDoCartao({ ...c, tipo: 'decisao' }, '20261105n', { nomeBot: BOT })[0][0], retorno, 'so o cartão de aba');
    // sessao de 64 vale no lote, mas o start do Telegram so leva a_ + 62: sem link, retorno
    const longa = 'a'.repeat(64);
    assert.equal(validarLote(lote({ cartoes: [{ ...c, ref: { sessao: longa } }] }), { agoraMs: AGORA }).ok, true);
    assert.deepEqual(tecladoDoCartao({ ...c, ref: { sessao: longa } }, '20261105n', { nomeBot: BOT })[0][0], retorno, 'sessão longa');
    // link explicito ganha (regra 1 vem antes)
    assert.deepEqual(tecladoDoCartao({ ...c, link: LINK }, '20261105n', { nomeBot: BOT })[0][0], { texto: 'Abrir', url: LINK });
  });

  test('pior caso do retorno cabe em 64 bytes: l:20261105m:10:nao_precisa', () => {
    const maior = Object.keys(ROTULOS).reduce((a, b) => (b.length > a.length ? b : a));
    assert.equal(maior, 'nao_precisa');
    const dados = tecladoDoCartao(cartao({ n: 10 }), '20261105m').flat().map((b) => b.dados);
    assert.ok(dados.includes('l:20261105m:10:nao_precisa'));
    for (const d of dados) assert.ok(Buffer.byteLength(d, 'utf8') <= 64, d);
    assert.ok(Buffer.byteLength('l:20261105m:10:nao_precisa', 'utf8') <= 64);
  });

  test('o teclado do cartão passa no adaptador: link vira url e retorno vira callback_data no corpo da API', async () => {
    const corpos = [];
    const fetch = async (url, opts) => {
      corpos.push({ metodo: String(url).split('/').pop(), corpo: JSON.parse(opts.body) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), { status: 200 });
    };
    const tg = criarTelegram({ token: 'chave-falsa-de-teste', chatId: 700100200, fetch, dormir: async () => {}, intervaloMs: 0 });
    const botoes = tecladoDoCartao(cartao({ n: 10, link: LINK }), '20261105m');
    assert.deepEqual(await tg.enviarTexto({ texto: '10. Proposta da padaria', botoes, silencioso: true }), { ok: true, messageId: 77 });
    assert.deepEqual(corpos[0].corpo.reply_markup, {
      inline_keyboard: [
        [{ text: 'Responder', url: LINK }, { text: 'Adiar', callback_data: 'l:20261105m:10:adiar' }],
        [{ text: 'Não precisa', callback_data: 'l:20261105m:10:nao_precisa' }, { text: 'Delegar', callback_data: 'l:20261105m:10:delegar' }],
      ],
    });
  });

  test('entrada torta = TypeError (lote, n ou verbo fora do formato)', () => {
    assert.throws(() => tecladoDoCartao(cartao(), '2026110m'), TypeError);
    assert.throws(() => tecladoDoCartao(cartao({ n: 11 }), '20261105m'), TypeError);
    assert.throws(() => tecladoDoCartao(cartao({ verbos: ['apagar'] }), '20261105m'), TypeError);
    assert.throws(() => tecladoDoCartao(cartao({ verbos: [] }), '20261105m'), TypeError);
    assert.throws(() => tecladoDoCartao(null, '20261105m'), TypeError);
  });
});

// ---------- A.4 tecladoDoResumo ----------

describe('T37a A.4 tecladoDoResumo', () => {
  test('Ver mais N com reserva e antes de mostrar; null sem reserva ou depois de mostrar', () => {
    const reserva = [4, 5].map((n) => cartao({ n }));
    const l = validarLote(lote({ reserva }), { agoraMs: AGORA }).lote;
    const esperado = [[{ texto: 'Ver mais 2', dados: 'l:20261105m:0:mais' }]];
    assert.deepEqual(tecladoDoResumo(l), esperado);
    assert.deepEqual(tecladoDoResumo(l, { jaMostrouMais: false }), esperado);
    assert.equal(tecladoDoResumo(l, { jaMostrouMais: true }), null);
    assert.equal(tecladoDoResumo(validarLote(lote(), { agoraMs: AGORA }).lote), null);
    assert.deepEqual(lerToqueRotina(esperado[0][0].dados), { loteId: '20261105m', n: 0, verbo: 'mais' });
  });
});

// ---------- A.5 lerToqueRotina ----------

describe('T37a A.5 lerToqueRotina', () => {
  test('válido: os 11 verbos com n 1..10 e mais com n=0; ida e volta com o teclado', () => {
    for (const verbo of Object.keys(ROTULOS)) {
      for (const n of [1, 9, 10]) assert.deepEqual(lerToqueRotina(`l:20261105t:${n}:${verbo}`), { loteId: '20261105t', n, verbo });
    }
    assert.deepEqual(lerToqueRotina('l:20261106n:0:mais'), { loteId: '20261106n', n: 0, verbo: 'mais' });
    for (const b of tecladoDoCartao(cartao({ n: 7 }), '20261105m').flat()) {
      assert.deepEqual(lerToqueRotina(b.dados), { loteId: '20261105m', n: 7, verbo: b.dados.split(':')[3] });
    }
  });

  test('inválido = null: verbo desconhecido, n fora, mais com n≠0, verbo de cartão com n=0, formato torto', () => {
    const tortos = [
      'l:20261105m:1:apagar', 'l:20261105m:1:constructor', 'l:20261105m:1:__proto__', 'l:20261105m:1:hasownproperty',
      'l:20261105m:11:adiar', 'l:20261105m:0:adiar', 'l:20261105m:100:adiar',
      'l:20261105m:1:mais', 'l:20261105m:10:mais',
      'l:20261105x:1:adiar', 'l:2026110m:1:adiar', 'l:20261105m:1:Adiar', 'l:20261105m::adiar', 'l:20261105m:1:a',
      'l:20261105m:1:adiar ', ' l:20261105m:1:adiar', 'l:20261105m:1:adiar\n', 'o:ABCDEFGH:1', '',
      null, undefined, 42, {},
    ];
    for (const s of tortos) assert.equal(lerToqueRotina(s), null, JSON.stringify(s));
  });
});

// ---------- A.6 / A.7 textos do toque ----------

describe('T37a A.6 textoDepoisDoToque e A.7 avisoDoToque', () => {
  const c = cartao({ n: 2, titulo: 'Fornecedor novo' });

  test('adiar: "<n>. <titulo>: adiado; volta no próximo dia útil às 8h30."', () => {
    assert.equal(textoDepoisDoToque(c, 'adiar'), '2. Fornecedor novo: adiado; volta no próximo dia útil às 8h30.');
  });

  test('nao_precisa, feito e manter: fora da lista / feito / mantido', () => {
    assert.equal(textoDepoisDoToque(c, 'nao_precisa'), '2. Fornecedor novo: fora da lista.');
    assert.equal(textoDepoisDoToque(c, 'feito'), '2. Fornecedor novo: feito.');
    assert.equal(textoDepoisDoToque(c, 'manter'), '2. Fornecedor novo: mantido.');
  });

  test('os demais: "anotado (<Rótulo>). Volta no próximo dia útil se seguir pendente." (T37b2: na sexta "amanhã" seria sábado)', () => {
    const demais = { responder: 'Responder', delegar: 'Delegar', sim: 'Sim', nao: 'Não', abrir: 'Abrir', remarcar: 'Remarcar', recusar: 'Recusar' };
    for (const [verbo, rotulo] of Object.entries(demais)) {
      assert.equal(textoDepoisDoToque(c, verbo), `2. Fornecedor novo: anotado (${rotulo}). Volta no próximo dia útil se seguir pendente.`);
    }
  });

  test('textoDepoisDoToque: verbo desconhecido ou mais = TypeError', () => {
    for (const v of ['mais', 'apagar', 'constructor', undefined]) assert.throws(() => textoDepoisDoToque(c, v), TypeError, String(v));
  });

  test('avisoDoToque: "Anotado: <Rótulo>." para os 11 (até 200); mais ou desconhecido = TypeError', () => {
    assert.equal(avisoDoToque('nao_precisa'), 'Anotado: Não precisa.');
    assert.equal(avisoDoToque('sim'), 'Anotado: Sim.');
    for (const [verbo, rotulo] of Object.entries(ROTULOS)) {
      const a = avisoDoToque(verbo);
      assert.equal(a, `Anotado: ${rotulo}.`);
      assert.ok(a.length <= 200);
    }
    for (const v of ['mais', 'toString', null]) assert.throws(() => avisoDoToque(v), TypeError, String(v));
  });
});

// ---------- A.8 textoResumoComProgresso ----------

describe('T37a A.8 textoResumoComProgresso', () => {
  test('0 resolvidos = o resumo igual', () => {
    assert.equal(textoResumoComProgresso('3 itens.\nPrazo mais cedo: 10h.', 0, 3), '3 itens.\nPrazo mais cedo: 10h.');
    assert.equal(textoResumoComProgresso('3 itens.', 0, 3), '3 itens.');
  });

  test('parcial: "<r> de <t> resolvidos." no fim da 2ª linha; nunca 3 linhas', () => {
    assert.equal(textoResumoComProgresso('3 itens.', 1, 3), '3 itens.\n1 de 3 resolvidos.');
    assert.equal(textoResumoComProgresso('3 itens.\nPrazo mais cedo: 10h.', 2, 3), '3 itens.\nPrazo mais cedo: 10h. 2 de 3 resolvidos.');
    const tres = textoResumoComProgresso('a\nb\nc', 1, 2);
    assert.equal(tres, 'a\nb c 1 de 2 resolvidos.');
    assert.equal(tres.split('\n').length, 2);
  });

  test('total: "Tudo resolvido neste lote." no lugar do contador', () => {
    assert.equal(textoResumoComProgresso('3 itens.', 3, 3), '3 itens.\nTudo resolvido neste lote.');
    assert.equal(textoResumoComProgresso('3 itens.\nPrazo mais cedo: 10h.', 3, 3), '3 itens.\nPrazo mais cedo: 10h. Tudo resolvido neste lote.');
  });

  test('contagem torta = TypeError', () => {
    assert.throws(() => textoResumoComProgresso('x', -1, 3), TypeError);
    assert.throws(() => textoResumoComProgresso('x', 1.5, 3), TypeError);
    assert.throws(() => textoResumoComProgresso(null, 1, 3), TypeError);
  });
});

// ---------- A.9 linhaDeAcao ----------

describe('T37a A.9 linhaDeAcao', () => {
  test('1 linha JSON + \\n com ts, lote, n, id, assinatura, verbo e origem botao; nada de texto do cartão', () => {
    const c = cartao({ n: 2, id: 'brain:t2', titulo: 'TITULO-NAO-VAI', texto: 'TEXTO-NAO-VAI', assinatura: 'v7', link: 'https://exemplo.com/LINK-NAO-VAI', ref: { sessao: SESSAO } });
    const s = linhaDeAcao({ ts: '2026-11-05T11:31:00.000Z', loteId: '20261105m', cartao: c, verbo: 'adiar' });
    assert.equal(s.indexOf('\n'), s.length - 1, 'uma linha só, terminada em \\n');
    const j = JSON.parse(s);
    assert.deepEqual(Object.keys(j), ['ts', 'lote', 'n', 'id', 'assinatura', 'verbo', 'origem']);
    assert.deepEqual(j, { ts: '2026-11-05T11:31:00.000Z', lote: '20261105m', n: 2, id: 'brain:t2', assinatura: 'v7', verbo: 'adiar', origem: 'botao' });
    assert.equal(s.includes('NAO-VAI'), false);
    assert.equal(s.includes(SESSAO), false);
    assert.equal(JSON.parse(linhaDeAcao({ ts: '2026-11-05T11:31:00.000Z', loteId: '20261105m', cartao: cartao(), verbo: 'nao_precisa' })).assinatura, '');
  });

  test('ts que não é data, lote torto, sem cartão ou verbo desconhecido = TypeError', () => {
    const ok = { ts: '2026-11-05T11:31:00.000Z', loteId: '20261105m', cartao: cartao(), verbo: 'adiar' };
    assert.throws(() => linhaDeAcao({ ...ok, ts: 'agora' }), TypeError);
    assert.throws(() => linhaDeAcao({ ...ok, ts: AGORA }), TypeError);
    assert.throws(() => linhaDeAcao({ ...ok, loteId: 'x' }), TypeError);
    assert.throws(() => linhaDeAcao({ ...ok, cartao: null }), TypeError);
    assert.throws(() => linhaDeAcao({ ...ok, verbo: 'mais' }), TypeError);
  });
});

// ---------- o link da aba (T10) reusado ----------

describe('T37a linkDaAba (o endereço da T10, exportado pra rotina reusar)', () => {
  test('https://t.me/<bot>?start=a_<sessão>; bot ou sessão fora do formato = null', () => {
    assert.equal(linkDaAba(BOT, SESSAO), `https://t.me/${BOT}?start=a_${SESSAO}`);
    assert.equal(linkDaAba('abc', SESSAO), null, 'bot curto');
    assert.equal(linkDaAba(null, SESSAO), null);
    assert.equal(linkDaAba(BOT, 'a'.repeat(63)), null, 'start acima de 64');
    assert.equal(linkDaAba(BOT, 'tem espaço'), null);
    assert.equal(linkDaAba(BOT, undefined), null);
  });
});
