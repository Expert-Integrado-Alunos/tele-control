// Testes de telegram.mjs (node:test, sem dependencia). Nenhuma chamada de rede de verdade: todo teste usa fetch
// falso (Response do proprio Node) e o baixar grava numa pasta temporaria do teste.
// Rodar: node --test --test-reporter=tap "tests/telegram.test.mjs" "tests/formato-tg.test.mjs"
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { criarTelegram as criarTelegramReal } from '../telegram.mjs';

const TOKEN = '424242:SEGREDO-falso-de-teste';
// A1: o chat sai do telegram.mjs e vem na criacao; os testes de antes dao o chat de antes (o teste A1 5 usa o real)
const CHAT_ID_DONO = 700100200;
const criarTelegram = (o = {}) => criarTelegramReal({ chatId: CHAT_ID_DONO, ...o });
const BASE = `https://api.telegram.org/bot${TOKEN}/`;

const res = (corpo, status = 200) => new Response(typeof corpo === 'string' ? corpo : JSON.stringify(corpo), { status });
const ok = (result) => res({ ok: true, result });
const erro = (codigo, description, extra = {}) => res({ ok: false, error_code: codigo, description, ...extra }, codigo);

// fetch falso: cada chamada consome 1 passo do roteiro (Response, Error pra lancar, ou funcao); sem roteiro = ok(true).
function falso(roteiro = []) {
  const fila = [...roteiro];
  const chamadas = [];
  async function fetch(url, opts = {}) {
    const u = String(url);
    // T17a: corpo FormData (sendVoice) nao e JSON: fica so no bruto
    chamadas.push({ url: u, metodo: u.slice(u.lastIndexOf('/') + 1), opts, corpo: typeof opts.body === 'string' ? JSON.parse(opts.body) : undefined, bruto: opts.body });
    const passo = fila.length ? fila.shift() : ok(true);
    if (passo instanceof Error) throw passo;
    return typeof passo === 'function' ? passo(u, opts) : passo;
  }
  fetch.chamadas = chamadas;
  return fetch;
}

function novo(roteiro, extra = {}) {
  const fetch = falso(roteiro);
  const tg = criarTelegram({ token: TOKEN, fetch, dormir: async () => {}, intervaloMs: 0, ...extra });
  return { tg, fetch };
}

const MAIS_API = { text: 'Mais contexto', callback_data: 'c:ABCDEFGH' };

// ---------- 1. enviar ----------

describe('1. enviar', () => {
  test('rich ok: destino fixo, silencioso, reply_parameters e botoes mapeados (style, disabled so com true)', async () => {
    const { tg, fetch } = novo([ok({ message_id: 901 })]);
    const r = await tg.enviar({
      html: '<h2>T</h2>',
      classico: '<b>T</b>',
      silencioso: true,
      responderA: 55,
      botoes: [
        [{ texto: 'A) Sim', dados: 'o:ABCDEFGH:0', estilo: 'success' }, { texto: 'B) Não', dados: 'o:ABCDEFGH:1', desativado: false }],
        [{ texto: 'Mais contexto', dados: 'c:ABCDEFGH', desativado: true }],
      ],
      chat_id: 999, // ignorado: nenhum metodo recebe chat
      chat: 999,
    });
    assert.deepEqual(r, { ok: true, messageId: 901, formato: 'rich' });
    assert.equal(fetch.chamadas.length, 1);
    const c = fetch.chamadas[0];
    assert.equal(c.url, `${BASE}sendRichMessage`);
    assert.equal(c.opts.method, 'POST');
    assert.equal(c.opts.headers['Content-Type'], 'application/json');
    assert.ok(c.opts.signal instanceof AbortSignal);
    assert.deepEqual(c.corpo, {
      chat_id: CHAT_ID_DONO,
      rich_message: { html: '<h2>T</h2>' },
      disable_notification: true,
      reply_markup: {
        inline_keyboard: [
          [{ text: 'A) Sim', callback_data: 'o:ABCDEFGH:0', style: 'success' }, { text: 'B) Não', callback_data: 'o:ABCDEFGH:1' }],
          [{ ...MAIS_API, disabled: {} }],
        ],
      },
      reply_parameters: { message_id: 55, allow_sending_without_reply: true },
    });
  });

  test('sem silencioso, responderA e botoes: disable_notification false e campo ausente nao vai no JSON', async () => {
    const { tg, fetch } = novo([ok({ message_id: 2 })]);
    assert.deepEqual(await tg.enviar({ html: '<p>x</p>', classico: 'x' }), { ok: true, messageId: 2, formato: 'rich' });
    const { corpo, bruto } = fetch.chamadas[0];
    assert.deepEqual(corpo, { chat_id: CHAT_ID_DONO, rich_message: { html: '<p>x</p>' }, disable_notification: false });
    assert.ok(!bruto.includes('reply_markup') && !bruto.includes('reply_parameters'));
  });

  test('400 no rich -> classico (parse_mode HTML, mesmos extras); 400 de novo -> texto sem tags e sem parse_mode', async () => {
    const extrasApi = {
      disable_notification: true,
      reply_markup: { inline_keyboard: [[MAIS_API]] },
      reply_parameters: { message_id: 9, allow_sending_without_reply: true },
    };
    const pedido = { html: '<h2>x</h2>', silencioso: true, responderA: 9, botoes: [[{ texto: 'Mais contexto', dados: 'c:ABCDEFGH' }]] };
    const classico = '<b>Aba &amp; cia</b>\n<i>&lt;pid&gt;.json</i> &quot;x&quot; &amp;lt;';

    const dois = novo([erro(400, "Bad Request: can't parse rich message"), ok({ message_id: 6 })]);
    assert.deepEqual(await dois.tg.enviar({ ...pedido, classico }), { ok: true, messageId: 6, formato: 'classico' });
    assert.deepEqual(dois.fetch.chamadas[1].corpo, { chat_id: CHAT_ID_DONO, text: classico, parse_mode: 'HTML', ...extrasApi });

    const tres = novo([erro(400, "Bad Request: can't parse rich message"), erro(400, "Bad Request: can't parse entities"), ok({ message_id: 7 })]);
    assert.deepEqual(await tres.tg.enviar({ ...pedido, classico }), { ok: true, messageId: 7, formato: 'texto' });
    assert.deepEqual(tres.fetch.chamadas.map((c) => c.metodo), ['sendRichMessage', 'sendMessage', 'sendMessage']);
    assert.deepEqual(tres.fetch.chamadas[2].corpo, { chat_id: CHAT_ID_DONO, text: 'Aba & cia\n<pid>.json "x" &lt;', ...extrasApi });
  });

  test('sem html comeca no classico; 429 -> esperarS sem o formato seguinte; rede, 403 e resposta ilegivel -> erro', async () => {
    const semHtml = novo([ok({ message_id: 3 })]);
    assert.deepEqual(await semHtml.tg.enviar({ classico: '<b>oi</b>' }), { ok: true, messageId: 3, formato: 'classico' });
    assert.equal(semHtml.fetch.chamadas[0].metodo, 'sendMessage');
    assert.equal(semHtml.fetch.chamadas[0].corpo.parse_mode, 'HTML');

    const lento = novo([erro(429, 'Too Many Requests: retry after 3', { parameters: { retry_after: 3 } })]);
    const r429 = await lento.tg.enviar({ html: '<p>x</p>', classico: 'x' });
    assert.equal(r429.ok, false);
    assert.equal(r429.esperarS, 3);
    assert.match(r429.erro, /Too Many Requests/);
    assert.equal(lento.fetch.chamadas.length, 1);

    const rede = novo([new Error('socket hang up')]);
    const rr = await rede.tg.enviar({ html: '<p>x</p>', classico: 'x' });
    assert.equal(rr.ok, false);
    assert.match(rr.erro, /socket hang up/);
    assert.equal(rr.esperarS, undefined);
    assert.equal(rede.fetch.chamadas.length, 1);

    const bloqueado = novo([erro(403, 'Forbidden: bot was blocked by the user')]);
    assert.match((await bloqueado.tg.enviar({ html: '<p>x</p>', classico: 'x' })).erro, /blocked/);
    assert.equal(bloqueado.fetch.chamadas.length, 1);

    const ilegivel = novo([res('<html>bad gateway</html>', 502)]);
    const ri = await ilegivel.tg.enviar({ classico: 'x' });
    assert.equal(ri.ok, false);
    assert.match(ri.erro, /502/);

    const nada = novo([]);
    assert.equal((await nada.tg.enviar({})).ok, false);
    assert.equal(nada.fetch.chamadas.length, 0);
  });
});

// ---------- 2. chave limpa ----------

describe('2. a chave nunca aparece', () => {
  test('fetch que lanca com a URL e corpo de erro com a chave: nenhum retorno ou erro contem a chave', async () => {
    const dir = pastaTemp('tg-chave-');
    try {
      const falha = new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed, reason: ECONNRESET`);
      falha.cause = new Error(`connect https://api.telegram.org/file/bot${TOKEN}/voice/x.oga`);
      const fetch = async (url) => {
        const m = String(url).split('/').pop();
        if (m === 'getMe') return res({ ok: false, error_code: 401, description: `Unauthorized: ${TOKEN}` }, 401);
        if (m === 'setMyCommands') return res({ ok: false, error_code: 400, description: `Bad Request: bot${TOKEN} invalido` }, 400);
        throw falha;
      };
      const tg = criarTelegram({ token: TOKEN, fetch, dormir: async () => {}, intervaloMs: 0 });
      const vistos = [
        await tg.enviar({ html: '<p>x</p>', classico: 'x' }),
        await tg.editar(5, { classico: 'x', formato: 'classico' }),
        await tg.editarBotoes(5, null),
        await tg.apagar(5),
        await tg.responderToque('q1', 'ok'),
        await tg.definirComandos([{ command: 'status', description: 'Status' }]),
        await tg.quemSou(),
        await tg.baixar('f1', join(dir, 'x')),
      ];
      const err = await tg.lerAtualizacoes({ offset: 1, esperaS: 0 }).then(() => null, (e) => e);
      assert.ok(err instanceof Error);
      for (const v of [...vistos, err.message, String(err), err.stack, JSON.stringify(err), String(err.cause ?? '')]) {
        const s = typeof v === 'string' ? v : JSON.stringify(v);
        assert.ok(!s.includes(TOKEN) && !s.includes('SEGREDO'), `vazou: ${s}`);
      }
      for (const v of vistos) assert.equal(v.ok, false);
      assert.match(vistos[0].erro, /api\.telegram\.org\/bot<chave>\/sendMessage/);
      assert.match(err.message, /bot<chave>/);
      // limpar sozinho: a chave, qualquer /bot<algo>/ e /file/bot<algo>/ (inclusive cortado no fim)
      assert.equal(tg.limpar(`x ${TOKEN} y`), 'x <chave> y');
      assert.equal(tg.limpar('https://api.telegram.org/bot1:OUTRA/getMe'), 'https://api.telegram.org/bot<chave>/getMe');
      assert.equal(tg.limpar('https://api.telegram.org/file/bot1:OUTRA/voice/a.oga'), 'https://api.telegram.org/file/bot<chave>/voice/a.oga');
      assert.equal(tg.limpar('falhou https://api.telegram.org/bot424242:SEGR'), 'falhou https://api.telegram.org/bot<chave>');
      assert.throws(() => criarTelegram({ token: '', fetch }), TypeError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- 3. lerAtualizacoes ----------

describe('3. lerAtualizacoes', () => {
  test('parametros enviados e prazo do fetch = esperaS + 15 s', async () => {
    const original = AbortSignal.timeout;
    const prazos = [];
    AbortSignal.timeout = (ms) => {
      prazos.push(ms);
      return original.call(AbortSignal, ms);
    };
    try {
      const { tg, fetch } = novo([ok([{ update_id: 11 }, { update_id: 12 }])]);
      assert.deepEqual(await tg.lerAtualizacoes({ offset: 11, esperaS: 30 }), [{ update_id: 11 }, { update_id: 12 }]);
      const c = fetch.chamadas[0];
      assert.equal(c.url, `${BASE}getUpdates`);
      assert.equal(c.opts.method, 'POST');
      assert.deepEqual(c.corpo, { offset: 11, timeout: 30, allowed_updates: ['message', 'callback_query'] });
      assert.deepEqual(prazos, [45000]);
    } finally {
      AbortSignal.timeout = original;
    }
  });

  test('409 (error_code ou so HTTP) -> err.conflito; 429 -> err.esperarS; rede e lixo lancam com mensagem limpa', async () => {
    const pegar = (roteiro) => novo(roteiro).tg.lerAtualizacoes({ offset: 1, esperaS: 0 }).then(() => null, (e) => e);

    const c1 = await pegar([erro(409, 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running')]);
    assert.ok(c1 instanceof Error);
    assert.equal(c1.conflito, true);
    assert.match(c1.message, /Conflict/);

    const c2 = await pegar([res('<html>conflict</html>', 409)]);
    assert.equal(c2.conflito, true);

    const lento = await pegar([erro(429, 'Too Many Requests: retry after 9', { parameters: { retry_after: 9 } })]);
    assert.equal(lento.esperarS, 9);
    assert.equal(lento.conflito, undefined);

    const rede = await pegar([new Error(`request to ${BASE}getUpdates failed, reason: ETIMEDOUT`)]);
    assert.ok(rede instanceof Error);
    assert.ok(!rede.message.includes(TOKEN));
    assert.match(rede.message, /ETIMEDOUT/);
    assert.equal(rede.conflito, undefined);

    assert.ok((await pegar([res('nao e json', 200)])) instanceof Error);
    assert.ok((await pegar([ok({ nao: 'e lista' })])) instanceof Error);
  });
});

// ---------- 4. apagar, editar, baixar e o resto ----------

describe('4. apagar, editar, baixar, toque, comandos, quemSou', () => {
  test('apagar: ok, jaSumiu (not found), velha (cant be deleted), outro erro; id invalido nem chama', async () => {
    const { tg, fetch } = novo([
      ok(true),
      erro(400, 'Bad Request: message to delete not found'),
      erro(400, "Bad Request: message can't be deleted"),
      erro(400, 'Bad Request: chat not found'),
      ok(true),
    ]);
    assert.deepEqual(await tg.apagar(77), { ok: true });
    assert.equal(fetch.chamadas[0].metodo, 'deleteMessage');
    assert.deepEqual(fetch.chamadas[0].corpo, { chat_id: CHAT_ID_DONO, message_id: 77 });
    assert.deepEqual(await tg.apagar(78), { ok: true, jaSumiu: true });
    assert.deepEqual(await tg.apagar(79), { ok: false, velha: true });
    const outro = await tg.apagar(80);
    assert.equal(outro.ok, false);
    assert.match(outro.erro, /chat not found/);
    assert.deepEqual(await tg.apagar('81'), { ok: true }); // id que voltou de chave de objeto (string) vale
    assert.equal(fetch.chamadas[4].corpo.message_id, 81);
    assert.equal((await tg.apagar(undefined)).ok, false);
    assert.equal(fetch.chamadas.length, 5);
  });

  test('editar: rich x classico x texto; "not modified" = ok; 429 = esperarS; editarBotoes(null) limpa', async () => {
    const { tg, fetch } = novo([
      ok({ message_id: 5 }),
      erro(400, 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same'),
      ok(true),
      erro(429, 'Too Many Requests: retry after 2', { parameters: { retry_after: 2 } }),
      ok(true),
      erro(400, 'Bad Request: message is not modified'),
    ]);
    const botoes = [[{ texto: 'Mais contexto', dados: 'c:ABCDEFGH' }]];
    assert.deepEqual(await tg.editar(5, { html: '<h2>T</h2>', classico: '<b>T</b>', botoes, formato: 'rich' }), { ok: true });
    assert.equal(fetch.chamadas[0].metodo, 'editMessageText');
    assert.deepEqual(fetch.chamadas[0].corpo, {
      chat_id: CHAT_ID_DONO,
      message_id: 5,
      rich_message: { html: '<h2>T</h2>' },
      reply_markup: { inline_keyboard: [[MAIS_API]] },
    });
    assert.deepEqual(await tg.editar(5, { html: '<h2>T</h2>', classico: '<b>T</b>', formato: 'classico' }), { ok: true });
    assert.deepEqual(fetch.chamadas[1].corpo, { chat_id: CHAT_ID_DONO, message_id: 5, text: '<b>T</b>', parse_mode: 'HTML' });
    assert.deepEqual(await tg.editar(6, { classico: '<b>T &amp; U</b>', formato: 'texto' }), { ok: true });
    assert.deepEqual(fetch.chamadas[2].corpo, { chat_id: CHAT_ID_DONO, message_id: 6, text: 'T & U' });
    const lento = await tg.editar(6, { classico: 'x', formato: 'classico' });
    assert.equal(lento.ok, false);
    assert.equal(lento.esperarS, 2);
    assert.deepEqual(await tg.editarBotoes(6, null), { ok: true });
    assert.equal(fetch.chamadas[4].metodo, 'editMessageReplyMarkup');
    assert.deepEqual(fetch.chamadas[4].corpo, { chat_id: CHAT_ID_DONO, message_id: 6, reply_markup: { inline_keyboard: [] } });
    assert.deepEqual(await tg.editarBotoes(6, botoes), { ok: true }); // not modified = ok
    assert.deepEqual(fetch.chamadas[5].corpo.reply_markup, { inline_keyboard: [[MAIS_API]] });
    assert.equal((await tg.editar(6, { classico: 'x', formato: 'outro' })).ok, false);
    assert.equal(fetch.chamadas.length, 6);
  });

  test('baixar: > 20 MB recusa sem baixar; grava com a extensao do file_path e cria a pasta; download ruim nao grava', async () => {
    const dir = pastaTemp('tg-baixar-');
    try {
      const grande = novo([ok({ file_id: 'f1', file_path: 'voice/file_1.oga', file_size: 20 * 1024 * 1024 + 1 })]);
      assert.deepEqual(await grande.tg.baixar('f1', join(dir, 'a')), { ok: false, erro: 'arquivo maior que 20 MB' });
      assert.deepEqual(grande.fetch.chamadas.map((c) => c.metodo), ['getFile']);
      assert.deepEqual(grande.fetch.chamadas[0].corpo, { file_id: 'f1' });

      const bytes = Buffer.from('OggS-audio');
      const bom = novo([ok({ file_id: 'f2', file_path: 'voice/file_2.oga', file_size: bytes.length }), new Response(bytes, { status: 200 })]);
      const destino = join(dir, 'sub', 'pasta', 'audio-1');
      assert.deepEqual(await bom.tg.baixar('f2', destino), { ok: true, caminho: `${destino}.oga`, bytes: bytes.length });
      assert.deepEqual(readFileSync(`${destino}.oga`), bytes);
      const d = bom.fetch.chamadas[1];
      assert.equal(d.url, `https://api.telegram.org/file/bot${TOKEN}/voice/file_2.oga`);
      assert.equal(d.opts.method, 'GET');

      const ruim = novo([ok({ file_path: 'photos/p.jpg', file_size: 3 }), new Response('nope', { status: 404 })]);
      const r = await ruim.tg.baixar('f3', join(dir, 'b'));
      assert.equal(r.ok, false);
      assert.ok(!r.erro.includes(TOKEN));
      assert.ok(!existsSync(join(dir, 'b.jpg')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('responderToque corta em 200; definirComandos (setMyCommands) e quemSou (getMe) nunca lancam', async () => {
    const { tg, fetch } = novo([
      ok(true),
      ok(true),
      ok({ id: 111, is_bot: true, username: 'bot_de_teste' }),
      erro(401, 'Unauthorized'),
      new Error('offline'),
    ]);
    assert.deepEqual(await tg.responderToque('q-1', 'x'.repeat(250)), { ok: true });
    assert.equal(fetch.chamadas[0].metodo, 'answerCallbackQuery');
    assert.deepEqual(fetch.chamadas[0].corpo, { callback_query_id: 'q-1', text: 'x'.repeat(200) });
    const comandos = [{ command: 'status', description: 'Status das abas' }, { command: 'rua', description: 'Tô na rua' }];
    assert.deepEqual(await tg.definirComandos(comandos), { ok: true });
    assert.equal(fetch.chamadas[1].metodo, 'setMyCommands');
    assert.deepEqual(fetch.chamadas[1].corpo, { commands: comandos, scope: { type: 'chat', chat_id: CHAT_ID_DONO } });
    assert.deepEqual(await tg.quemSou(), { ok: true, id: 111, username: 'bot_de_teste' });
    const r401 = await tg.quemSou();
    assert.equal(r401.ok, false);
    assert.match(r401.erro, /Unauthorized/);
    assert.equal((await tg.definirComandos(comandos)).ok, false);
  });
});

// ---------- 5. fila ----------

describe('5. fila do adaptador', () => {
  test('3 envios seguidos: inicios separados por intervaloMs (relogio falso), ordem mantida', async () => {
    let t = 50000;
    const inicios = [];
    const dormidas = [];
    const fetch = async () => {
      inicios.push(t);
      return ok({ message_id: inicios.length });
    };
    const tg = criarTelegram({ token: TOKEN, fetch, agora: () => t, dormir: async (ms) => { dormidas.push(ms); t += ms; } });
    const rs = await Promise.all([tg.enviar({ classico: '1' }), tg.enviar({ classico: '2' }), tg.enviar({ classico: '3' })]);
    assert.deepEqual(rs.map((r) => r.messageId), [1, 2, 3]);
    assert.deepEqual(inicios, [50000, 51100, 52200]); // intervaloMs padrao = 1100
    assert.deepEqual(dormidas, [1100, 1100]);
  });

  test('editar, editarBotoes, apagar e responderToque entram na mesma fila; chamada lenta nao soma espera', async () => {
    let t = 0;
    const inicios = [];
    const fetch = async (url) => {
      inicios.push([String(url).split('/').pop(), t]);
      if (inicios.length === 2) t += 5000; // a 2a demora 5 s: a 3a sai logo depois, sem dormir
      return ok(true);
    };
    const tg = criarTelegram({ token: TOKEN, fetch, agora: () => t, dormir: async (ms) => { t += ms; }, intervaloMs: 1000 });
    await Promise.all([
      tg.enviar({ classico: 'x' }),
      tg.editar(1, { classico: 'y', formato: 'classico' }),
      tg.editarBotoes(1, null),
      tg.apagar(1),
      tg.responderToque('q', 'ok'),
    ]);
    assert.deepEqual(inicios, [
      ['sendMessage', 0],
      ['editMessageText', 1000],
      ['editMessageReplyMarkup', 6000],
      ['deleteMessage', 7000],
      ['answerCallbackQuery', 8000],
    ]);
  });

  test('lerAtualizacoes, quemSou e definirComandos nao esperam a fila (que sai 1 por vez)', async () => {
    let soltar;
    const presa = new Promise((r) => { soltar = r; });
    const log = [];
    const fetch = async (url) => {
      const m = String(url).split('/').pop();
      log.push(m);
      if (m === 'sendMessage' && log.filter((x) => x === 'sendMessage').length === 1) await presa;
      if (m === 'getUpdates') return ok([]);
      if (m === 'getMe') return ok({ id: 1, username: 'b' });
      return ok({ message_id: 1 });
    };
    const tg = criarTelegram({ token: TOKEN, fetch, agora: () => 0, dormir: async () => {}, intervaloMs: 1100 });
    const p1 = tg.enviar({ classico: '1' });
    const p2 = tg.enviar({ classico: '2' });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(await tg.lerAtualizacoes({ offset: 1, esperaS: 0 }), []);
    assert.equal((await tg.quemSou()).ok, true);
    assert.equal((await tg.definirComandos([{ command: 'status', description: 'Status' }])).ok, true);
    assert.deepEqual(log, ['sendMessage', 'getUpdates', 'getMe', 'setMyCommands']); // o 2o envio espera o 1o
    soltar();
    await Promise.all([p1, p2]);
    assert.deepEqual(log.slice(4), ['sendMessage']);
  });

  test('dados com mais de 64 bytes UTF-8: recusa sem chamar a API (64 exatos passa)', async () => {
    const { tg, fetch } = novo([ok({ message_id: 1 })]);
    const r = await tg.enviar({ classico: 'x', botoes: [[{ texto: 'A', dados: 'é'.repeat(33) }]] }); // 66 bytes
    assert.equal(r.ok, false);
    assert.match(r.erro, /64 bytes/);
    assert.equal((await tg.editarBotoes(1, [[{ texto: 'A', dados: 'x'.repeat(65) }]])).ok, false);
    assert.equal((await tg.editar(1, { classico: 'x', formato: 'classico', botoes: [[{ texto: 'A', dados: 'x'.repeat(65) }]] })).ok, false);
    assert.equal(fetch.chamadas.length, 0);
    assert.equal((await tg.enviar({ classico: 'x', botoes: [[{ texto: 'A', dados: 'x'.repeat(64) }]] })).ok, true);
    assert.equal(fetch.chamadas.length, 1);
  });
});

// ---------- 6. codigo nas falhas (T2: o drenar do canal separa 400 de transporte) ----------

describe('6. codigo nas falhas', () => {
  test('400 no editar devolve codigo 400; rede devolve codigo 0; 429 devolve codigo 429 com esperarS', async () => {
    const { tg } = novo([
      erro(400, 'Bad Request: message to edit not found'),
      new Error('socket hang up'),
      erro(429, 'Too Many Requests: retry after 4', { parameters: { retry_after: 4 } }),
      new Error('ECONNRESET'),
      res('<html>bad gateway</html>', 502),
    ]);
    assert.deepEqual(await tg.editar(5, { classico: 'x', formato: 'classico' }), {
      ok: false,
      erro: 'editMessageText: Bad Request: message to edit not found',
      codigo: 400,
    });
    const rede = await tg.editar(5, { classico: 'x', formato: 'classico' });
    assert.equal(rede.ok, false);
    assert.equal(rede.codigo, 0);
    assert.match(rede.erro, /socket hang up/);
    assert.equal(rede.esperarS, undefined);
    assert.deepEqual(await tg.editar(5, { classico: 'x', formato: 'classico' }), {
      ok: false,
      erro: 'editMessageText: Too Many Requests: retry after 4',
      codigo: 429,
      esperarS: 4,
    });
    const redeEnviar = await tg.enviar({ html: '<p>x</p>', classico: 'x' });
    assert.equal(redeEnviar.codigo, 0);
    const ilegivel = await tg.apagar(7); // sem JSON: o codigo e o HTTP
    assert.equal(ilegivel.ok, false);
    assert.equal(ilegivel.codigo, 502);
  });
});

// ---------- 7. T7e2: envio incerto ----------

describe('7. T7e2: envio incerto', () => {
  // Erro de rede como o fetch do Node (undici) lanca: TypeError('fetch failed') com a causa trazendo o codigo.
  const redeCom = (codigo) => {
    const err = new TypeError('fetch failed');
    err.cause = Object.assign(new Error(`causa ${codigo}`), { code: codigo });
    return err;
  };
  const tempoEsgotado = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');

  test('T7e2 54. incerto: TimeoutError, ECONNRESET, UND_ERR_SOCKET, sem codigo e corpo ilegivel (2xx inclusive); nunca ENOTFOUND, ECONNREFUSED, UND_ERR_CONNECT_TIMEOUT nem JSON; rich com timeout = 1 chamada so', async () => {
    const t1 = novo([tempoEsgotado()]);
    const r1 = await t1.tg.enviar({ classico: 'x' });
    assert.equal(r1.ok, false);
    assert.equal(r1.codigo, 0);
    assert.equal(r1.incerto, true, 'TimeoutError = incerto');
    assert.match(r1.erro, /timeout/i);
    assert.equal(t1.fetch.chamadas.length, 1);

    for (const [nome, falha] of [
      ['ECONNRESET', redeCom('ECONNRESET')],
      ['EPIPE', redeCom('EPIPE')],
      ['UND_ERR_SOCKET', redeCom('UND_ERR_SOCKET')],
      ['UND_ERR_HEADERS_TIMEOUT', redeCom('UND_ERR_HEADERS_TIMEOUT')],
      ['UND_ERR_BODY_TIMEOUT', redeCom('UND_ERR_BODY_TIMEOUT')],
      ['ETIMEDOUT (fora das 2 listas = incerto)', redeCom('ETIMEDOUT')],
      ['sem codigo', new Error('socket hang up')],
    ]) {
      const { tg, fetch } = novo([falha]);
      const r = await tg.enviar({ classico: 'x' });
      assert.equal(r.ok, false, nome);
      assert.equal(r.codigo, 0, nome);
      assert.equal(r.incerto, true, nome);
      assert.equal(fetch.chamadas.length, 1, nome);
    }

    const agregado = new TypeError('fetch failed'); // varios enderecos recusados (IPv4 e IPv6)
    agregado.cause = new AggregateError([
      Object.assign(new Error('a'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('b'), { code: 'ECONNREFUSED' }),
    ], 'connect');
    for (const [nome, falha] of [
      ['ENOTFOUND', redeCom('ENOTFOUND')],
      ['EAI_AGAIN', redeCom('EAI_AGAIN')],
      ['ECONNREFUSED', redeCom('ECONNREFUSED')],
      ['ENETUNREACH', redeCom('ENETUNREACH')],
      ['EHOSTUNREACH', redeCom('EHOSTUNREACH')],
      ['UND_ERR_CONNECT_TIMEOUT', redeCom('UND_ERR_CONNECT_TIMEOUT')],
      ['ECONNREFUSED agregado', agregado],
    ]) {
      const { tg } = novo([falha]);
      const r = await tg.enviar({ classico: 'x' });
      assert.equal(r.ok, false, nome);
      assert.equal(r.codigo, 0, nome);
      assert.equal(r.incerto, undefined, `${nome}: nao saiu (nunca incerto)`);
    }

    for (const [nome, resposta] of [
      ['200 ilegivel', res('<html>ok?</html>', 200)],
      ['200 vazio', res('', 200)],
      ['502 ilegivel', res('<html>bad gateway</html>', 502)],
    ]) {
      const { tg, fetch } = novo([resposta]);
      const r = await tg.enviar({ classico: 'x' });
      assert.equal(r.ok, false, nome);
      assert.equal(r.incerto, true, nome);
      assert.equal(fetch.chamadas.length, 1, nome);
    }

    // resposta JSON = o Telegram respondeu: nunca incerto (o formato de hoje, sem campo novo)
    const j400 = novo([erro(400, 'Bad Request: message to edit not found')]);
    assert.deepEqual(await j400.tg.editar(5, { classico: 'x', formato: 'classico' }), {
      ok: false, erro: 'editMessageText: Bad Request: message to edit not found', codigo: 400,
    });
    const j429 = novo([erro(429, 'Too Many Requests: retry after 3', { parameters: { retry_after: 3 } })]);
    assert.deepEqual(await j429.tg.enviar({ html: '<p>x</p>', classico: 'x' }), {
      ok: false, erro: 'sendRichMessage: Too Many Requests: retry after 3', codigo: 429, esperarS: 3,
    });

    // rich com timeout: incerto em 1 chamada so (pode ter saido: nao cai pro classico)
    const rich = novo([tempoEsgotado()]);
    const rr = await rich.tg.enviar({ html: '<p>x</p>', classico: 'x' });
    assert.equal(rr.incerto, true);
    assert.deepEqual(rich.fetch.chamadas.map((c) => c.metodo), ['sendRichMessage']);
    // (c) incerto com HTTP 400 de corpo ilegivel tambem nao cai pro formato seguinte
    const rich400 = novo([res('<html>bad request</html>', 400)]);
    const r4 = await rich400.tg.enviar({ html: '<p>x</p>', classico: 'x' });
    assert.equal(r4.incerto, true);
    assert.equal(r4.codigo, 400);
    assert.deepEqual(rich400.fetch.chamadas.map((c) => c.metodo), ['sendRichMessage']);
    const classico400 = novo([res('<html>bad request</html>', 400)]);
    assert.equal((await classico400.tg.enviar({ classico: '<b>x</b>' })).incerto, true);
    assert.equal(classico400.fetch.chamadas.length, 1, 'o classico incerto nao vira texto sem tags');
  });
});

// ---------- T7b1a 68: enviarTexto, editarTexto e espiar (o OK pelo botao no chat Bot de Teste) ----------

describe('T7b1a 68: enviarTexto, editarTexto e espiar', () => {
  // texto com cara de tag e entidade: o semTags apagaria <pid> e <b>x</b> e trocaria &amp; por &
  const TEXTO = 'ℹ️ Nome\nPedido de OK (apagar): apagar <pid>.json & y <b>x</b> &amp; &lt;\n\nPosso? Vale até 10:30.';
  const BOTOES = [
    [{ texto: 'Sim', dados: 'k:ABC234:s', estilo: 'success' }, { texto: 'Não', dados: 'k:ABC234:n', estilo: 'danger' }],
    [{ texto: 'Mais informações', dados: 'k:ABC234:i' }],
  ];
  const TECLADO_API = {
    inline_keyboard: [
      [{ text: 'Sim', callback_data: 'k:ABC234:s', style: 'success' }, { text: 'Não', callback_data: 'k:ABC234:n', style: 'danger' }],
      [{ text: 'Mais informações', callback_data: 'k:ABC234:i' }],
    ],
  };

  test('enviarTexto: sendMessage sem parse_mode, texto intacto, botoes com style, destino fixo, notificando', async () => {
    const { tg, fetch } = novo([ok({ message_id: 501 })]);
    assert.deepEqual(await tg.enviarTexto({ texto: TEXTO, botoes: BOTOES, chat_id: 999 }), { ok: true, messageId: 501 });
    assert.equal(fetch.chamadas.length, 1);
    const c = fetch.chamadas[0];
    assert.equal(c.url, `${BASE}sendMessage`);
    assert.deepEqual(c.corpo, { chat_id: CHAT_ID_DONO, text: TEXTO, disable_notification: false, reply_markup: TECLADO_API });
    assert.ok(!c.bruto.includes('parse_mode'));
    assert.equal(JSON.parse(c.bruto).text, TEXTO);

    const s = novo([ok({ message_id: 502 })]);
    assert.deepEqual(await s.tg.enviarTexto({ texto: 'x', silencioso: true, responderA: 55 }), { ok: true, messageId: 502 });
    assert.deepEqual(s.fetch.chamadas[0].corpo, {
      chat_id: CHAT_ID_DONO, text: 'x', disable_notification: true, reply_parameters: { message_id: 55, allow_sending_without_reply: true },
    });
  });

  test('enviarTexto: 400 nao tenta outro formato; sem texto ou botao torto = erro sem API; 429 e incerto como o enviar', async () => {
    const r400 = novo([erro(400, 'Bad Request: message is too long')]);
    const f = await r400.tg.enviarTexto({ texto: TEXTO });
    assert.equal(f.ok, false);
    assert.equal(f.codigo, 400);
    assert.match(f.erro, /too long/);
    assert.equal(r400.fetch.chamadas.length, 1, 'nada de cair pro texto sem tags');

    const vazio = novo([]);
    for (const texto of ['', undefined, null, 42]) assert.equal((await vazio.tg.enviarTexto({ texto })).ok, false, String(texto));
    assert.equal((await vazio.tg.enviarTexto({ texto: 'x', botoes: [[{ texto: 'A', dados: 'x'.repeat(65) }]] })).ok, false);
    assert.equal((await vazio.tg.enviarTexto({ texto: 'x', botoes: 'torto' })).ok, false);
    assert.equal(vazio.fetch.chamadas.length, 0);

    const lento = await novo([erro(429, 'Too Many Requests: retry after 3', { parameters: { retry_after: 3 } })]).tg.enviarTexto({ texto: 'x' });
    assert.deepEqual(lento, { ok: false, erro: 'sendMessage: Too Many Requests: retry after 3', codigo: 429, esperarS: 3 });
    const incerto = await novo([res('<html>bad gateway</html>', 502)]).tg.enviarTexto({ texto: 'x' });
    assert.equal(incerto.incerto, true);
  });

  test('editarTexto: editMessageText sem parse_mode, texto intacto; sem botoes = sem teclado; "not modified" = ok; id torto = erro sem API', async () => {
    const { tg, fetch } = novo([
      ok(true),
      ok(true),
      erro(400, 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same'),
      erro(400, 'Bad Request: message to edit not found'),
    ]);
    assert.deepEqual(await tg.editarTexto(77, { texto: TEXTO, botoes: [BOTOES[0]] }), { ok: true });
    assert.equal(fetch.chamadas[0].url, `${BASE}editMessageText`);
    assert.deepEqual(fetch.chamadas[0].corpo, {
      chat_id: CHAT_ID_DONO, message_id: 77, text: TEXTO, reply_markup: { inline_keyboard: [TECLADO_API.inline_keyboard[0]] },
    });
    assert.ok(!fetch.chamadas[0].bruto.includes('parse_mode'));
    assert.deepEqual(await tg.editarTexto('78', { texto: 'fecho' }), { ok: true });
    assert.deepEqual(fetch.chamadas[1].corpo, { chat_id: CHAT_ID_DONO, message_id: 78, text: 'fecho' });
    assert.deepEqual(await tg.editarTexto(77, { texto: 'igual' }), { ok: true });
    const sumiu = await tg.editarTexto(77, { texto: 'x' });
    assert.equal(sumiu.ok, false);
    assert.equal(sumiu.codigo, 400);
    const antes = fetch.chamadas.length;
    for (const id of [0, -1, 'x', null, 1.5]) assert.equal((await tg.editarTexto(id, { texto: 'x' })).ok, false, String(id));
    assert.equal((await tg.editarTexto(77, { texto: '' })).ok, false);
    assert.equal((await tg.editarTexto(77, {})).ok, false);
    assert.equal((await tg.editarTexto(77, { texto: 'x', botoes: 'torto' })).ok, false);
    assert.equal(fetch.chamadas.length, antes);
  });

  test('espiar: getUpdates com o offset RECEBIDO, timeout 0, limit 100 e os allowed_updates; nunca guarda nem avanca o offset', async () => {
    const original = AbortSignal.timeout;
    const prazos = [];
    AbortSignal.timeout = (ms) => {
      prazos.push(ms);
      return original.call(AbortSignal, ms);
    };
    try {
      const lote = [{ update_id: 900, callback_query: { id: 'q', data: 'k:ABC234:s' } }];
      const { tg, fetch } = novo([ok(lote), ok(lote), ok([])]);
      assert.deepEqual(await tg.espiar({ offset: 850 }), lote);
      assert.deepEqual(await tg.espiar({ offset: 850 }), lote, 'ja devolveu o 900 e pede o mesmo de novo');
      assert.deepEqual(await tg.espiar({ offset: 1 }), []);
      const esperado = (offset) => ({ offset, timeout: 0, limit: 100, allowed_updates: ['message', 'callback_query'] });
      assert.deepEqual(fetch.chamadas.map((c) => c.corpo), [esperado(850), esperado(850), esperado(1)]);
      assert.equal(fetch.chamadas[0].bruto, fetch.chamadas[1].bruto, '2 chamadas com o mesmo offset = 2 pedidos iguais');
      for (const c of fetch.chamadas) assert.equal(c.url, `${BASE}getUpdates`);
      assert.deepEqual(prazos, [15000, 15000, 15000]);
      // depois de devolver o 900, sem offset continua recusando (nada guardado)
      await assert.rejects(tg.espiar({}), Error);
      assert.equal(fetch.chamadas.length, 3);
    } finally {
      AbortSignal.timeout = original;
    }
  });

  test('espiar: offset ausente, nao inteiro ou menor que 1 lanca SEM chamar a API (nunca negativo)', async () => {
    const { tg, fetch } = novo([]);
    for (const offset of [undefined, null, 0, -1, -100, 1.5, '5', Number.NaN, Infinity, 2 ** 53, true]) {
      await assert.rejects(tg.espiar({ offset }), Error, String(offset));
    }
    await assert.rejects(tg.espiar(), Error);
    assert.equal(fetch.chamadas.length, 0);
  });

  test('espiar: 409 lanca conflito, 429 lanca esperarS, a chave nunca no erro; fora da fila do adaptador', async () => {
    const pegar = (roteiro) => novo(roteiro).tg.espiar({ offset: 10 }).then(() => null, (e) => e);
    const c = await pegar([erro(409, 'Conflict: terminated by other getUpdates request')]);
    assert.ok(c instanceof Error);
    assert.equal(c.conflito, true);
    assert.equal((await pegar([res('<html>conflict</html>', 409)])).conflito, true);
    const lento = await pegar([erro(429, 'Too Many Requests: retry after 7', { parameters: { retry_after: 7 } })]);
    assert.equal(lento.esperarS, 7);
    assert.equal(lento.conflito, undefined);
    const rede = await pegar([new Error(`request to ${BASE}getUpdates failed, reason: ECONNRESET`)]);
    assert.ok(rede instanceof Error);
    for (const v of [rede.message, String(rede), rede.stack, JSON.stringify(rede)]) {
      assert.ok(!String(v).includes(TOKEN) && !String(v).includes('SEGREDO'), v);
    }
    assert.ok((await pegar([ok({ nao: 'lista' })])) instanceof Error);

    // fora da fila: com um envio preso, o espiar sai na hora
    let soltar;
    const presa = new Promise((r) => { soltar = r; });
    const log = [];
    const fetch = async (url) => {
      const m = String(url).split('/').pop();
      log.push(m);
      if (m === 'sendMessage' && log.filter((x) => x === 'sendMessage').length === 1) await presa;
      if (m === 'getUpdates') return ok([]);
      return ok({ message_id: 1 });
    };
    const tg = criarTelegram({ token: TOKEN, fetch, agora: () => 0, dormir: async () => {}, intervaloMs: 1100 });
    const p1 = tg.enviarTexto({ texto: '1' });
    const p2 = tg.editarTexto(5, { texto: '2' });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(await tg.espiar({ offset: 3 }), []);
    assert.deepEqual(log, ['sendMessage', 'getUpdates'], 'enviarTexto e editarTexto na fila; espiar fora');
    soltar();
    await Promise.all([p1, p2]);
    assert.deepEqual(log, ['sendMessage', 'getUpdates', 'editMessageText']);
  });

  test('enviarTexto e editarTexto: a chave nunca no retorno nem no erro', async () => {
    const falha = new Error(`request to ${BASE}sendMessage failed, reason: ECONNRESET`);
    const fetch = async (url) => {
      if (String(url).endsWith('editMessageText')) return res({ ok: false, error_code: 401, description: `Unauthorized: ${TOKEN}` }, 401);
      throw falha;
    };
    const tg = criarTelegram({ token: TOKEN, fetch, dormir: async () => {}, intervaloMs: 0 });
    for (const v of [await tg.enviarTexto({ texto: 'x' }), await tg.editarTexto(5, { texto: 'x' })]) {
      assert.equal(v.ok, false);
      const s = JSON.stringify(v);
      assert.ok(!s.includes(TOKEN) && !s.includes('SEGREDO'), s);
    }
  });
});

// ---------- A1. o chat pela configuracao (PLANO-ABERTO.md, "A1 — Telegram pela configuração", teste 5) ----------

test('A1 5. criarTelegram({token, chatId: 42}): enviar, editar, editarBotoes, apagar, definirComandos (e os de texto puro) saem com chat_id 42; sem chatId, 0, "42" ou outro nao inteiro positivo = lanca na criacao, sem fetch, sem a chave na mensagem', async () => {
  const fetch = falso();
  const tg = criarTelegramReal({ token: TOKEN, chatId: 42, fetch, dormir: async () => {}, intervaloMs: 0 });
  await tg.enviar({ html: '<p>x</p>', classico: 'x' });
  await tg.editar(5, { html: '<p>x</p>', formato: 'rich' });
  await tg.editar(5, { classico: 'x', formato: 'classico' });
  await tg.editar(5, { classico: 'x', formato: 'texto' });
  await tg.editarBotoes(5, null);
  await tg.apagar(5);
  await tg.definirComandos([{ command: 'status', description: 'Status' }]);
  await tg.enviarTexto({ texto: 'x' });
  await tg.editarTexto(5, { texto: 'x' });
  assert.deepEqual(fetch.chamadas.map((c) => c.metodo), [
    'sendRichMessage', 'editMessageText', 'editMessageText', 'editMessageText', 'editMessageReplyMarkup', 'deleteMessage',
    'setMyCommands', 'sendMessage', 'editMessageText',
  ]);
  for (const c of fetch.chamadas) {
    const chat = c.metodo === 'setMyCommands' ? c.corpo.scope.chat_id : c.corpo.chat_id;
    assert.equal(chat, 42, c.metodo);
    assert.ok(!c.bruto.includes('700100200'), `${c.metodo}: nenhum chat fixo no corpo`);
  }
  assert.deepEqual(fetch.chamadas[6].corpo.scope, { type: 'chat', chat_id: 42 }, 'o menu so no chat dado');

  for (const ruim of [undefined, null, 0, -1, 1.5, '42', Number.NaN, 2 ** 53, [42], { id: 42 }]) {
    const f = falso();
    const extra = ruim === undefined ? {} : { chatId: ruim };
    assert.throws(() => criarTelegramReal({ token: TOKEN, fetch: f, ...extra }), (e) => {
      assert.ok(e instanceof TypeError, `chatId ${String(ruim)}: TypeError`);
      assert.ok(!e.message.includes(TOKEN) && !e.message.includes('SEGREDO'), e.message);
      return true;
    }, `chatId ${String(ruim)}`);
    assert.equal(f.chamadas.length, 0, `chatId ${String(ruim)}: nenhuma chamada`);
  }
});

// Sabotagens a1a #18 e #19 (05/10/2026): o A1 5 so passa pelo rich; o classico e o texto puro do enviar (depois de um
// 400) ficavam sem teste com outro chat, e os testes de antes usam o chat de antes.
test('A1 5b. enviar com chatId 42: o classico (400 no rich) e o texto puro (400 no classico) saem com chat_id 42', async () => {
  const fetch = falso([erro(400, "Bad Request: can't parse rich message"), erro(400, "Bad Request: can't parse entities"), ok({ message_id: 7 })]);
  const tg = criarTelegramReal({ token: TOKEN, chatId: 42, fetch, dormir: async () => {}, intervaloMs: 0 });
  assert.deepEqual(await tg.enviar({ html: '<p>x</p>', classico: '<b>x</b>' }), { ok: true, messageId: 7, formato: 'texto' });
  assert.deepEqual(fetch.chamadas.map((c) => c.metodo), ['sendRichMessage', 'sendMessage', 'sendMessage']);
  for (const c of fetch.chamadas) {
    assert.equal(c.corpo.chat_id, 42, c.metodo);
    assert.ok(!c.bruto.includes('700100200'), `${c.metodo}: nenhum chat fixo no corpo`);
  }
});

// ---------- T17a: enviarVoz (a resposta em audio, sendVoice multipart) ----------

describe('T17a: enviarVoz', () => {
  const OGG = Buffer.from('OggS de mentira: o adaptador nao confere o audio (quem confere e o lib/voz.mjs)');

  test('enviarVoz: sendVoice multipart com chat_id fixo, voice resposta.ogg (audio/ogg), caption cortada em 1024, notificacao e citacao; sem Content-Type JSON', async () => {
    const { tg, fetch } = novo([ok({ message_id: 901 })]);
    const legenda = `${'x'.repeat(1023)}🎙️ resto`;
    assert.deepEqual(await tg.enviarVoz({ audio: OGG, legenda, responderA: '77', chat_id: 999 }), { ok: true, messageId: 901 });
    assert.equal(fetch.chamadas.length, 1);
    const c = fetch.chamadas[0];
    assert.equal(c.url, `${BASE}sendVoice`);
    assert.ok(c.bruto instanceof FormData, 'corpo multipart');
    assert.equal(c.opts.headers, undefined, 'sem Content-Type: o fetch poe o boundary');
    assert.ok(c.opts.signal instanceof AbortSignal);
    const f = c.bruto;
    assert.equal(f.get('chat_id'), String(CHAT_ID_DONO), 'o chat fixo da criacao, nunca o do chamador');
    const voz = f.get('voice');
    assert.equal(voz.name, 'resposta.ogg');
    assert.equal(voz.type, 'audio/ogg');
    assert.ok(Buffer.from(await voz.arrayBuffer()).equals(OGG));
    assert.equal(f.get('caption'), 'x'.repeat(1023), 'cortada em 1024 sem partir o par substituto');
    assert.equal(f.get('disable_notification'), 'false');
    assert.deepEqual(JSON.parse(f.get('reply_parameters')), { message_id: 77, allow_sending_without_reply: true });
    assert.deepEqual([...f.keys()].sort(), ['caption', 'chat_id', 'disable_notification', 'reply_parameters', 'voice']);

    const s = novo([ok({ message_id: 902 })]);
    assert.deepEqual(await s.tg.enviarVoz({ audio: OGG, silencioso: true, responderA: 'torto' }), { ok: true, messageId: 902 });
    const g = s.fetch.chamadas[0].bruto;
    assert.equal(g.get('disable_notification'), 'true');
    assert.equal(g.has('caption'), false, 'sem legenda = sem caption');
    assert.equal(g.has('reply_parameters'), false, 'responderA invalido = sem citacao');
  });

  test('enviarVoz: sem audio ou Buffer vazio = erro sem chamar a API', async () => {
    const { tg, fetch } = novo([]);
    for (const audio of [undefined, null, Buffer.alloc(0), 'OggS', new Uint8Array([1, 2, 3])]) {
      assert.deepEqual(await tg.enviarVoz({ audio, legenda: 'x' }), { ok: false, erro: 'enviarVoz: sem audio' }, String(audio));
    }
    assert.deepEqual(await tg.enviarVoz(), { ok: false, erro: 'enviarVoz: sem audio' });
    assert.equal(fetch.chamadas.length, 0);
  });

  test('enviarVoz: 400 = ok:false com o codigo, sem a chave no erro e sem tentar de novo; 429 traz esperarS', async () => {
    const r400 = novo([erro(400, `Bad Request: wrong file at https://api.telegram.org/bot${TOKEN}/sendVoice (${TOKEN})`)]);
    const f = await r400.tg.enviarVoz({ audio: OGG });
    assert.equal(f.ok, false);
    assert.equal(f.codigo, 400);
    assert.match(f.erro, /^sendVoice: Bad Request: wrong file/);
    assert.ok(!f.erro.includes(TOKEN) && !f.erro.includes('SEGREDO'), 'a chave nunca no erro');
    assert.equal(f.incerto, undefined);
    assert.equal(r400.fetch.chamadas.length, 1, 'o envio nao tenta de novo');
    const lento = await novo([erro(429, 'Too Many Requests: retry after 4', { parameters: { retry_after: 4 } })]).tg.enviarVoz({ audio: OGG });
    assert.deepEqual(lento, { ok: false, erro: 'sendVoice: Too Many Requests: retry after 4', codigo: 429, esperarS: 4 });
  });

  test('enviarVoz: rede que estourou o prazo = incerto:true (pode ter chegado), sem a chave; mesma fila do adaptador', async () => {
    const tempo = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const { tg, fetch } = novo([tempo]);
    const r = await tg.enviarVoz({ audio: OGG, legenda: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.incerto, true);
    assert.equal(r.codigo, 0);
    assert.ok(!r.erro.includes(TOKEN));
    assert.equal(fetch.chamadas.length, 1);

    // mesma fila: com intervalo, a voz espera a vez depois do texto
    const esperas = [];
    let relogio = 1000;
    const fila = falso([ok({ message_id: 1 }), ok({ message_id: 2 })]);
    const tg2 = criarTelegram({ token: TOKEN, fetch: fila, intervaloMs: 1100, agora: () => relogio, dormir: async (ms) => { esperas.push(ms); relogio += ms; } });
    const [a, b] = await Promise.all([tg2.enviarTexto({ texto: 'resposta' }), tg2.enviarVoz({ audio: OGG })]);
    assert.deepEqual([a.messageId, b.messageId], [1, 2]);
    assert.deepEqual(fila.chamadas.map((c) => c.metodo), ['sendMessage', 'sendVoice']);
    assert.deepEqual(esperas, [1100], 'a voz entrou na fila do adaptador');
  });
});

// ---------- T29d: a pergunta da busca com resposta forcada (PLANO-TELEGRAM.md, "T29d") ----------

describe('T29d: enviar com respostaForcada', () => {
  test('respostaForcada (texto) = reply_markup {force_reply: true, input_field_placeholder}; o resto do corpo igual', async () => {
    const { tg, fetch } = novo([ok({ message_id: 77 })]);
    const r = await tg.enviar({ classico: 'Qual palavra?', silencioso: true, respostaForcada: 'nome da aba ou palavra' });
    assert.deepEqual(r, { ok: true, messageId: 77, formato: 'classico' });
    assert.equal(fetch.chamadas.length, 1);
    assert.equal(fetch.chamadas[0].metodo, 'sendMessage');
    assert.deepEqual(fetch.chamadas[0].corpo, {
      chat_id: CHAT_ID_DONO, text: 'Qual palavra?', parse_mode: 'HTML', disable_notification: true,
      reply_markup: { force_reply: true, input_field_placeholder: 'nome da aba ou palavra' },
    });
  });

  test('respostaForcada true = so o force_reply; exemplo longo corta em 64; com botoes = erro sem chamar a API; sem ela = como antes', async () => {
    const a = novo([ok({ message_id: 1 })]);
    await a.tg.enviar({ classico: 'x', respostaForcada: true });
    assert.deepEqual(a.fetch.chamadas[0].corpo.reply_markup, { force_reply: true });
    const b = novo([ok({ message_id: 2 })]);
    await b.tg.enviar({ classico: 'x', respostaForcada: 'y'.repeat(100) });
    assert.equal(b.fetch.chamadas[0].corpo.reply_markup.input_field_placeholder, 'y'.repeat(64));
    const c = novo();
    const r = await c.tg.enviar({ classico: 'x', respostaForcada: 'z', botoes: [[{ texto: 'B', dados: 'p:b' }]] });
    assert.equal(r.ok, false);
    assert.match(r.erro, /^enviar: /);
    assert.equal(c.fetch.chamadas.length, 0);
    const d = novo([ok({ message_id: 3 })]);
    await d.tg.enviar({ classico: 'x', botoes: [[{ texto: 'B', dados: 'p:b' }]] });
    assert.deepEqual(d.fetch.chamadas[0].corpo.reply_markup, { inline_keyboard: [[{ text: 'B', callback_data: 'p:b' }]] });
    const f = novo([ok({ message_id: 4 })]);
    await f.tg.enviar({ classico: 'x' });
    assert.equal(f.fetch.chamadas[0].corpo.reply_markup, undefined);
  });
});
