// Testes da T39 no canal-telegram.mjs (node:test, sem dependencia): a mensagem "Ajustes" (o /rua, /modo e /voz do menu),
// no molde do painel. Nenhuma rede: o `tg` e um duble que grava cada chamada ({metodo, args}) e devolve respostas
// roteirizadas; relogio falso por `agora`; `rand` fixo. Os ajudantes vem de tests/canal-telegram.test.mjs (linhas 1-95).
// Rodar: node --test --test-reporter=tap "tests/canal-telegram-t39.test.mjs"
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { criarCanalTelegram, tgNovo, completarTg } from '../canal-telegram.mjs';
import { montarAjustes, botoesAjustes } from '../lib/formato-tg.mjs';

const DONO = 700100200;
const T0 = Date.parse('2026-09-29T15:00:00.000Z'); // 12:00 em Brasilia

// Duble do telegram.mjs. roteiro[metodo] = lista (cada chamada consome 1 resposta; vazia = padrao) ou funcao
// (args) -> resposta | undefined (undefined = padrao). Padrao: enviar ok com messageId 500 + n (n = enviar numero n),
// formato rich; editar, editarBotoes e apagar ok.
function dubleTg(roteiro = {}) {
  const chamadas = [];
  const filas = {};
  for (const m of ['enviar', 'editar', 'editarBotoes', 'apagar']) filas[m] = Array.isArray(roteiro[m]) ? [...roteiro[m]] : roteiro[m];
  let enviadas = 0;
  function responder(metodo, args, padrao) {
    chamadas.push({ metodo, args });
    const f = filas[metodo];
    let r;
    if (typeof f === 'function') r = f(...args);
    else if (Array.isArray(f) && f.length) r = f.shift();
    return r === undefined ? padrao : r;
  }
  return {
    chamadas,
    async enviar(pedido) {
      enviadas += 1;
      return responder('enviar', [pedido], { ok: true, messageId: 500 + enviadas, formato: 'rich' });
    },
    async editar(messageId, pedido) {
      return responder('editar', [messageId, pedido], { ok: true });
    },
    async editarBotoes(messageId, botoes) {
      return responder('editarBotoes', [messageId, botoes], { ok: true });
    },
    async apagar(messageId) {
      return responder('apagar', [messageId], { ok: true });
    },
  };
}

// rand fixo: 1o id de chamado = ABCDEFGH, 2o = JKMNPQRS, 3o = TUVWXYZ2 (ALFABETO do formato-tg)
function randFixo() {
  let n = 0;
  return {
    getRandomValues(b) {
      for (let i = 0; i < b.length; i += 1) b[i] = (n * b.length + i) % 256;
      n += 1;
      return b;
    },
  };
}

function novo({ roteiro, resolvidas } = {}) {
  const relogio = { t: T0 };
  const logs = [];
  const tg = dubleTg(roteiro);
  const canal = criarCanalTelegram({
    tg,
    chatId: DONO,
    log: (m) => logs.push(m),
    agora: () => relogio.t,
    ensaio: false,
    registrarEnsaio: () => {},
    rand: randFixo(),
    resolvidas, // ausente = 'apagar'
  });
  return { canal, tg, e: { tg: tgNovo() }, logs, relogio };
}

// resumo das chamadas: enviar -> ['enviar', silencioso]; editar/apagar -> [metodo, messageId]
const passos = (tg) => tg.chamadas.map((c) => (c.metodo === 'enviar' ? ['enviar', c.args[0].silencioso] : [c.metodo, c.args[0]]));

// Os dados que o porteiro manda montar (lib/formato-tg.mjs, montarAjustes)
const RUA = { qual: 'rua', rua: false, voz: false, painel: 'padrao', mensagens: 'apagar' };
const RUA_LIGADO = { ...RUA, rua: true };
const MODO = { ...RUA, qual: 'modo' };
const VOZ = { ...RUA, qual: 'voz', voz: true };
const RECUSADA = { ok: false, erro: 'editMessageText: Bad Request: message to edit not found', codigo: 400 };

describe('T39 1. ajustes(): mensagem nova em silencio, em cima da mensagem do dono', () => {
  test('html e botoes certos; o 2o ajustes() = mensagem nova e a anterior apagada no limpo; 2 pedidos antes do drenar = 1 mensagem; no manter a anterior so perde os botoes', async () => {
    const { canal, tg, e } = novo();
    canal.ajustes(e, RUA, { citar: 90 });
    await canal.drenar(e); // 501
    assert.deepEqual(passos(tg), [['enviar', true]]);
    const p = tg.chamadas[0].args[0];
    assert.equal(p.html, montarAjustes(RUA).html);
    assert.equal(p.classico, montarAjustes(RUA).classico);
    assert.ok(p.html.includes('Modo rua: desligado.'), p.html);
    assert.deepEqual(p.botoes, botoesAjustes(RUA));
    assert.deepEqual(p.botoes, [[{ texto: 'Ligar modo rua', dados: 'a:r1' }]]);
    assert.equal(p.responderA, 90);
    assert.equal(e.tg.ajustes.mensagem.messageId, 501);
    assert.equal(e.tg.ajustes.citar, null, 'o citar sai com o envio');
    assert.deepEqual(canal.ajustesNaTela(e), RUA);

    canal.ajustes(e, MODO, { citar: 91 });
    await canal.drenar(e); // 502
    assert.deepEqual(passos(tg), [['enviar', true], ['enviar', true], ['apagar', 501]]);
    assert.equal(tg.chamadas[1].args[0].responderA, 91);
    assert.equal(tg.chamadas[1].args[0].html, montarAjustes(MODO).html);
    assert.deepEqual(tg.chamadas[1].args[0].botoes, botoesAjustes(MODO));
    assert.equal(e.tg.ajustes.mensagem.messageId, 502);
    assert.deepEqual(e.tg.ajustes.apagar, []);
    for (const ruim of [null, 'x', 3, [], undefined]) assert.throws(() => canal.ajustes(e, ruim), TypeError);

    const d = novo();
    d.canal.ajustes(d.e, RUA, { citar: 90 });
    d.canal.ajustes(d.e, VOZ, { citar: 91 });
    await d.canal.drenar(d.e);
    assert.deepEqual(passos(d.tg), [['enviar', true]], '2 pedidos antes do drenar = 1 mensagem so');
    assert.equal(d.tg.chamadas[0].args[0].html, montarAjustes(VOZ).html);
    assert.equal(d.tg.chamadas[0].args[0].responderA, 91);

    const k = novo({ resolvidas: 'manter' });
    k.canal.ajustes(k.e, RUA, { citar: 90 });
    await k.canal.drenar(k.e); // 501
    k.canal.ajustes(k.e, RUA_LIGADO, { citar: 91 });
    await k.canal.drenar(k.e); // 502
    assert.deepEqual(passos(k.tg), [['enviar', true], ['enviar', true], ['editarBotoes', 501]], 'manter: a anterior fica, sem os botoes');
    assert.equal(k.tg.chamadas[2].args[1], null);
    assert.equal(k.e.tg.ajustes.mensagem.messageId, 502);
  });
});

describe('T39 2. ajustesNaTela e atualizarAjustes: edicao no lugar', () => {
  test('sem ajustes = null/false e nada na fila; com os ajustes na tela = edita a mesma mensagem, sem mensagem nova; dados tortos = TypeError', async () => {
    const { canal, tg, e } = novo();
    assert.equal(canal.ajustesNaTela(e), null);
    assert.equal(canal.atualizarAjustes(e, RUA), false);
    assert.deepEqual(e.tg.saida, []);
    canal.ajustes(e, RUA, { citar: 90 });
    await canal.drenar(e); // 501
    const naTela = canal.ajustesNaTela(e);
    assert.deepEqual(naTela, RUA);
    naTela.rua = 'x';
    assert.equal(e.tg.ajustes.dados.rua, false, 'copia');
    assert.equal(canal.atualizarAjustes(e, RUA_LIGADO), true);
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', true], ['editar', 501]]);
    assert.equal(tg.chamadas[1].args[1].html, montarAjustes(RUA_LIGADO).html);
    assert.deepEqual(tg.chamadas[1].args[1].botoes, [[{ texto: 'Desligar modo rua', dados: 'a:r0' }]]);
    assert.equal(e.tg.ajustes.mensagem.messageId, 501);
    assert.deepEqual(canal.ajustesNaTela(e), RUA_LIGADO);
    for (const ruim of [null, 'x', 3, []]) assert.throws(() => canal.atualizarAjustes(e, ruim), TypeError);
    assert.deepEqual(canal.ajustesNaTela(e), RUA_LIGADO, 'o torto nao muda nada');
  });

  test('ajuste pedido e ainda nao enviado: atualizarAjustes troca os dados do que vai sair (1 mensagem so)', async () => {
    const { canal, tg, e } = novo();
    canal.ajustes(e, RUA, { citar: 90 });
    assert.deepEqual(canal.ajustesNaTela(e), RUA);
    assert.equal(canal.atualizarAjustes(e, RUA_LIGADO), true);
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', true]]);
    assert.equal(tg.chamadas[0].args[0].html, montarAjustes(RUA_LIGADO).html);
    assert.equal(tg.chamadas[0].args[0].responderA, 90);
  });
});

describe('T39 3. edicao recusada (400): os ajustes saem do estado', () => {
  test('nenhuma mensagem nova; depois atualizarAjustes = false; a fila sem ajustes sai com o log', async () => {
    const { canal, tg, e, logs } = novo({ roteiro: { editar: [RECUSADA] } });
    canal.ajustes(e, RUA, { citar: 90 });
    await canal.drenar(e); // 501
    canal.atualizarAjustes(e, RUA_LIGADO);
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', true], ['editar', 501]]);
    assert.equal(e.tg.ajustes.mensagem, null);
    assert.equal(e.tg.ajustes.dados, null);
    assert.deepEqual(e.tg.saida, []);
    assert.ok(logs.some((l) => l.includes('ajustes: edicao da mensagem 501 recusada (') && l.includes('); os ajustes saem (voltam no menu)')), logs.join('\n'));
    assert.equal(canal.ajustesNaTela(e), null);
    assert.equal(canal.atualizarAjustes(e, RUA), false);
    await canal.drenar(e);
    assert.equal(tg.chamadas.length, 2);

    const k = novo();
    k.canal.ajustes(k.e, RUA);
    k.e.tg.ajustes.dados = null; // saiu do estado antes do envio
    await k.canal.drenar(k.e);
    assert.deepEqual(k.tg.chamadas, []);
    assert.deepEqual(k.e.tg.saida, []);
    assert.ok(k.logs.some((l) => l.includes('ajustes saiu da fila (nenhum ajuste)')), k.logs.join('\n'));
  });
});

describe('T39 4. vistasSemNada no limpo: os ajustes saem como a linha do sistema', () => {
  test('60 s ou mais na tela = sai e a mensagem do dono citada sai junto; 59 s fica; a tocada fica; nao volta; no manter 0', async () => {
    const { canal, tg, e, relogio, logs } = novo();
    canal.mensagemDoDono(e, 90);
    canal.ajustes(e, RUA, { citar: 90 });
    await canal.drenar(e); // 501
    tg.chamadas.length = 0;
    relogio.t = T0 + 59 * 1000;
    assert.equal(canal.vistasSemNada(e), 0, '59 s: fica');
    await canal.drenar(e);
    assert.deepEqual(tg.chamadas, []);
    relogio.t = T0 + 60 * 1000;
    assert.equal(canal.vistasSemNada(e, { tocada: 501 }), 0, 'a tocada fica nesse passo');
    assert.equal(e.tg.ajustes.mensagem.messageId, 501);
    assert.equal(canal.vistasSemNada(e), 1);
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['apagar', 501], ['apagar', 90]], 'a do dono citada sai junto (T23a)');
    assert.equal(e.tg.ajustes.mensagem, null);
    assert.equal(e.tg.ajustes.dados, null);
    assert.deepEqual(e.tg.saida, []);
    assert.ok(logs.some((l) => l.includes('ajustes: mensagem 501 apagada (vista e sem nada pra você)')), logs.join('\n'));
    assert.equal(canal.ajustesNaTela(e), null, 'nao volta (so no menu)');
    assert.equal(canal.atualizarAjustes(e, RUA_LIGADO), false);
    assert.equal(canal.vistasSemNada(e), 0, 'nada mais na tela');
    await canal.drenar(e);
    assert.equal(tg.chamadas.length, 2);

    const m = novo({ resolvidas: 'manter' });
    m.canal.mensagemDoDono(m.e, 90);
    m.canal.ajustes(m.e, RUA, { citar: 90 });
    await m.canal.drenar(m.e);
    m.relogio.t = T0 + 10 * 60 * 1000;
    assert.equal(m.canal.vistasSemNada(m.e), 0, 'manter: nada sai');
    assert.equal(m.e.tg.ajustes.mensagem.messageId, 501);
  });
});

describe('T39 6. definirResolvidas(manter) descarta o limpar dos ajustes', () => {
  test('o limpar pendente dos ajustes (do disco) some sem chamar a API; no apagar fica', async () => {
    const bruto = JSON.parse(JSON.stringify(tgNovo()));
    bruto.ajustes = { dados: null, versaoId: 4, descer: false, citar: null, mensagem: null, apagar: [], limpar: [{ messageId: 90, dono: true }] };
    bruto.saida = [{ sessionId: 'ajustes', entrouEm: new Date(T0).toISOString() }];
    const a = novo();
    a.e.tg = completarTg(JSON.parse(JSON.stringify(bruto)));
    a.canal.definirResolvidas(a.e, 'apagar');
    assert.deepEqual(a.e.tg.ajustes.limpar, [{ messageId: 90, dono: true }], 'apagar: o limpar fica');

    const k = novo({ resolvidas: 'manter' });
    k.e.tg = completarTg(JSON.parse(JSON.stringify(bruto)));
    assert.deepEqual(k.e.tg.ajustes.limpar, [{ messageId: 90, dono: true }]);
    k.canal.definirResolvidas(k.e, 'manter');
    assert.equal(k.e.tg.ajustes.limpar, undefined, 'manter: o limpar dos ajustes some');
    await k.canal.drenar(k.e);
    assert.deepEqual(k.tg.chamadas, [], 'sem chamar a API');
  });
});

describe('T39 5. o estado dos ajustes: completarTg e tgDe', () => {
  test('completarTg: os ajustes fazem ida e volta; torto vira o padrao; estado sem ajustes completa no tgDe sem lancar', async () => {
    const PADRAO = { dados: null, versaoId: 0, descer: false, citar: null, mensagem: null, apagar: [] };
    assert.deepEqual(tgNovo().ajustes, PADRAO);

    const t = tgNovo();
    t.seq = 3;
    t.ajustes = {
      dados: { qual: 'rua', rua: true, voz: false, painel: 'padrao', mensagens: 'apagar' },
      versaoId: 7,
      descer: false,
      citar: 90,
      mensagem: { messageId: 501, versaoId: 7, formato: 'rich' },
      apagar: [{ messageId: 480, doBot: true, formato: 'rich' }],
      limpar: [{ messageId: 90, dono: true }],
    };
    const volta = completarTg(JSON.parse(JSON.stringify(t)));
    assert.deepEqual(volta.ajustes, t.ajustes);
    assert.ok(volta.seq >= 7, 'o seq nunca fica abaixo da versao dos ajustes (maiorId)');

    for (const torto of ['x', 3, [], null, { dados: 'x', versaoId: -1, descer: 'sim', citar: 'a', mensagem: [], apagar: {}, limpar: [{ messageId: 5 }] }]) {
      const b = JSON.parse(JSON.stringify(tgNovo()));
      b.ajustes = torto;
      assert.deepEqual(completarTg(b).ajustes, PADRAO, JSON.stringify(torto));
    }
    const semAjustes = JSON.parse(JSON.stringify(tgNovo()));
    delete semAjustes.ajustes;
    assert.deepEqual(completarTg(semAjustes).ajustes, PADRAO, 'o estado de antes da T39 (sem ajustes)');

    for (const antes of [undefined, 'x', { apagar: 'x' }, { apagar: [], versaoId: 'a' }]) {
      const { canal, e } = novo();
      if (antes === undefined) delete e.tg.ajustes;
      else e.tg.ajustes = antes;
      assert.doesNotThrow(() => canal.definirResolvidas(e, 'apagar'));
      await canal.drenar(e);
      assert.deepEqual(e.tg.ajustes, PADRAO, `tgDe completa ${JSON.stringify(antes)}`);
    }
  });
});

describe('T39 7. o resto do estado conhece os ajustes (sabotagens 18, 31, 32 e 33)', () => {
  test('a mensagem dos ajustes nao e de aba: resposta em cima dela = null; "ajustes" nao e nome de aba', async () => {
    const { canal, e } = novo();
    canal.ajustes(e, RUA, { citar: 90 });
    await canal.drenar(e); // 501
    assert.equal(e.tg.mensagens[501].sessionId, 'ajustes');
    assert.equal(canal.sessaoDaMensagem(e, 501), null, 'a resposta em cima dos ajustes nao vira aba "ajustes"');
    assert.equal(canal.telaDaAba(e, 'ajustes'), null);
  });

  test('completarTg: o seq nunca fica abaixo da versao do ajuste pedido e ainda nao enviado (sem mensagem na tela)', () => {
    const t = JSON.parse(JSON.stringify(tgNovo()));
    t.seq = 0;
    t.ajustes = { dados: RUA, versaoId: 50, descer: true, citar: 90, mensagem: null, apagar: [] };
    const volta = completarTg(t);
    assert.equal(volta.ajustes.versaoId, 50);
    assert.ok(volta.seq >= 50, `seq ${volta.seq}`);
  });

  test('envio incerto: a mensagem do dono que os ajustes citam conta como conhecida (o desde sobe; nao entra na lista dos desconhecidos)', async () => {
    const INCERTO = { ok: false, erro: 'enviar: The operation was aborted due to timeout', codigo: 0, incerto: true };
    const { canal, e, relogio, logs } = novo({ roteiro: { enviar: [{ ok: true, messageId: 501, formato: 'rich' }, INCERTO, { ok: true, messageId: 504, formato: 'rich' }] } });
    canal.ajustes(e, RUA, { citar: 90 });
    await canal.drenar(e); // 501
    canal.ajustes(e, MODO, { citar: 502 }); // o /modo do dono e o 502 (so os ajustes conhecem)
    await canal.drenar(e); // incerto
    assert.deepEqual(e.tg.saida[0].incerto, { desde: 502 }, 'desde = maior id conhecido (o citar dos ajustes)');
    relogio.t += 30 * 1000;
    await canal.drenar(e); // 504
    assert.equal(e.tg.ajustes.mensagem.messageId, 504);
    assert.ok(logs.includes('telegram ajustes: mensagem 504 enviada depois de envio incerto; 1 id(s) desconhecido(s) entre 502 e 504 ficam no chat (sonda desligada): 503'), logs.join('\n'));
  });

  test('no limpo, a situacao que ficou como mensagem da aba e ja esta no apagar dos ajustes nao entra 2 vezes no apagar', () => {
    const { canal, e, relogio } = novo();
    e.tg.mensagens[700] = { sessionId: 'aba-1', at: new Date(T0 - 2 * 60 * 1000).toISOString(), formato: 'rich', exSituacao: true, semNada: true };
    e.tg.ajustes.apagar.push({ messageId: 700, doBot: true, formato: 'rich' });
    relogio.t = T0;
    assert.equal(canal.vistasSemNada(e), 0);
    assert.deepEqual(e.tg.situacao.apagar, []);
    assert.deepEqual(e.tg.saida, []);
  });
});
