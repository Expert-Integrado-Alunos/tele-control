// Testes de canal-telegram.mjs (node:test, sem dependencia). Nenhuma rede: o `tg` e um duble que grava cada chamada
// ({metodo, args}) e devolve respostas roteirizadas; relogio falso por `agora`; `rand` fixo (ids de chamado previsiveis).
// Rodar: node --test --test-reporter=tap "tests/canal-telegram.test.mjs" "tests/telegram.test.mjs" "tests/formato-tg.test.mjs"
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { criarCanalTelegram, tgNovo, completarTg } from '../canal-telegram.mjs';
import { montarChamado, montarSistema, montarPainel, montarSituacao, montarChamadoComOk, esc } from '../lib/formato-tg.mjs';
import { montarBlocoOk, montarBlocoOkFechado } from '../lib/ok-tg.mjs'; // T26b1

const DONO = 700100200;
const T0 = Date.parse('2026-09-29T15:00:00.000Z'); // 12:00 em Brasilia
const MIN = 60 * 1000;
const H = 60 * MIN;
const DIA = 24 * H;
const iso = (ms) => new Date(ms).toISOString();

const FINAL = [
  'Terminei a revisão do `<pid>.json`.',
  '',
  '---',
  '🔴 **DECISÃO:** Faço X? A) Sim, tudo hoje (recomendado) / B) Só as correções',
].join('\n');
const OPCOES = [
  { letra: 'A', texto: 'Sim, tudo hoje (recomendado)' },
  { letra: 'B', texto: 'Só as correções' },
];

// Duble do telegram.mjs. roteiro[metodo] = lista (cada chamada consome 1 resposta; vazia = padrao) ou funcao
// (args) -> resposta | undefined (undefined = padrao). Padrao: enviar ok com messageId 500 + n (n = enviar numero n),
// formato rich; editar, editarBotoes (T7f: o chamado que o dono respondeu perde os botoes) e apagar ok.
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

function novo({ roteiro, ensaio = false, ehCentral, resolvidas } = {}) {
  const relogio = { t: T0 };
  const logs = [];
  const ensaios = [];
  const tg = dubleTg(roteiro);
  const canal = criarCanalTelegram({
    tg,
    chatId: DONO, // A1: o chat do config.json (os testes de antes: o chat de antes)
    log: (m) => logs.push(m),
    agora: () => relogio.t,
    ensaio,
    registrarEnsaio: (x) => ensaios.push(x),
    rand: randFixo(),
    ehCentral, // T22b: ausente nos testes de antes
    resolvidas, // T23a: ausente nos testes de antes (= 'apagar')
  });
  return { canal, tg, e: { tg: tgNovo() }, logs, ensaios, relogio };
}

const parou = (sessionId, final = FINAL, at = iso(T0)) => ({ sessionId, at, finalTs: at, final });
// resumo das chamadas: enviar -> ['enviar', silencioso]; editar/apagar -> [metodo, messageId]
const passos = (tg) => tg.chamadas.map((c) => (c.metodo === 'enviar' ? ['enviar', c.args[0].silencioso] : [c.metodo, c.args[0]]));

// ---------- 1. normalizarUpdate ----------

describe('1. normalizarUpdate', () => {
  const DATA = 1790000000;
  const msg = (extra = {}) => ({
    message_id: 70,
    date: DATA,
    chat: { id: DONO, type: 'private', first_name: 'Davi' },
    from: { id: DONO, is_bot: false, first_name: 'Davi' },
    ...extra,
  });

  test('mensagem do dono: texto, caption, voice, audio, a maior foto, documento, video, reply, encaminhada e hora', () => {
    const { canal, logs } = novo();
    assert.deepEqual(canal.normalizarUpdate({ update_id: 10, message: msg({ text: 'oi aba' }) }), {
      tipo: 'mensagem',
      updateId: 10,
      messageId: 70,
      texto: 'oi aba',
      audio: null,
      midias: [],
      respondeA: null,
      encaminhada: false,
      hora: iso(DATA * 1000),
    });

    const foto = canal.normalizarUpdate({
      update_id: 11,
      message: msg({ caption: 'olha isso', photo: [{ file_id: 'p1', file_size: 100 }, { file_id: 'p3', file_size: 900 }, { file_id: 'p2', file_size: 400 }] }),
    });
    assert.equal(foto.texto, 'olha isso');
    assert.deepEqual(foto.midias, [{ tipo: 'foto', fileId: 'p3', nome: null, bytes: 900 }]);

    const semTamanho = canal.normalizarUpdate({ update_id: 12, message: msg({ photo: [{ file_id: 'q1' }, { file_id: 'q2' }] }) });
    assert.equal(semTamanho.texto, '');
    assert.deepEqual(semTamanho.midias, [{ tipo: 'foto', fileId: 'q2', nome: null, bytes: null }]); // sem tamanho = a ultima

    const voz = canal.normalizarUpdate({ update_id: 13, message: msg({ voice: { file_id: 'v1', duration: 11, mime_type: 'audio/ogg', file_size: 5000 } }) });
    assert.deepEqual(voz.audio, { fileId: 'v1', segundos: 11, mime: 'audio/ogg' });
    assert.equal(voz.texto, '');
    const aud = canal.normalizarUpdate({ update_id: 14, message: msg({ audio: { file_id: 'a1', duration: 30, mime_type: 'audio/mpeg' } }) });
    assert.deepEqual(aud.audio, { fileId: 'a1', segundos: 30, mime: 'audio/mpeg' });

    const doc = canal.normalizarUpdate({
      update_id: 15,
      message: msg({
        caption: 'segue',
        document: { file_id: 'd1', file_name: 'nota.pdf', file_size: 1234 },
        video: { file_id: 'w1', file_name: 'clip.mp4', file_size: 99 },
        reply_to_message: { message_id: 55, text: 'chamado' },
        forward_origin: { type: 'user', date: DATA },
      }),
    });
    assert.equal(doc.texto, 'segue');
    assert.deepEqual(doc.midias, [
      { tipo: 'documento', fileId: 'd1', nome: 'nota.pdf', bytes: 1234 },
      { tipo: 'video', fileId: 'w1', nome: 'clip.mp4', bytes: 99 },
    ]);
    assert.equal(doc.respondeA, 55);
    assert.equal(doc.encaminhada, true);
    assert.deepEqual(logs, []);
  });

  test('toque do dono: id do toque, mensagem do botao, dados e hora = agora', () => {
    const { canal, relogio } = novo();
    relogio.t = T0 + 7 * MIN;
    const u = {
      update_id: 20,
      callback_query: { id: 'q-9', from: { id: DONO, is_bot: false }, message: { message_id: 501, chat: { id: DONO, type: 'private' } }, data: 'o:ABCDEFGH:0' },
    };
    assert.deepEqual(canal.normalizarUpdate(u), {
      tipo: 'toque',
      updateId: 20,
      toqueId: 'q-9',
      messageId: 501,
      dados: 'o:ABCDEFGH:0',
      hora: iso(T0 + 7 * MIN),
    });
  });

  test('recusa outro chat, outro remetente, bot, grupo, edited_message e toque de outro chat; o log nao leva o texto', () => {
    const { canal, logs } = novo();
    const SEGREDO = 'texto-secreto-do-davi';
    const recusados = [
      { update_id: 30, message: msg({ text: SEGREDO, chat: { id: 999, type: 'private' } }) },
      { update_id: 31, message: msg({ text: SEGREDO, from: { id: 999, is_bot: false } }) },
      { update_id: 32, message: msg({ text: SEGREDO, from: { id: DONO, is_bot: true } }) },
      { update_id: 33, message: msg({ text: SEGREDO, chat: { id: -100123, type: 'supergroup', title: 'Grupo' } }) },
      { update_id: 34, edited_message: msg({ text: SEGREDO }) },
      { update_id: 35, callback_query: { id: 'q', from: { id: DONO }, message: { message_id: 1, chat: { id: -100123, type: 'supergroup' } }, data: SEGREDO } },
      { update_id: 36, callback_query: { id: 'q', from: { id: 999 }, message: { message_id: 1, chat: { id: DONO, type: 'private' } }, data: SEGREDO } },
    ];
    for (const u of recusados) assert.equal(canal.normalizarUpdate(u), null, `update ${u.update_id}`);
    assert.equal(logs.length, recusados.length);
    logs.forEach((l, i) => {
      assert.ok(l.includes(String(recusados[i].update_id)), l);
      assert.ok(!l.includes(SEGREDO), l);
      assert.ok(!l.includes('\n'), l);
    });
    assert.equal(canal.normalizarUpdate(null), null);
    assert.equal(canal.normalizarUpdate({ update_id: 37 }), null);
  });
});

// ---------- 2. aviso -> drenar ----------

describe('2. aviso -> drenar', () => {
  test('aviso: 1 enviar com notificacao e html/classico/botoes do montarChamado; chamado e mensagens registrados', async () => {
    const { canal, tg, e } = novo();
    assert.equal(canal.aviso(e, parou('aba-1'), 'Aba Azul'), undefined);
    const c = e.tg.chamados['aba-1'];
    assert.equal(c.versao.estado, 'aviso');
    assert.equal(c.versao.chamadoId, 'ABCDEFGH');
    assert.deepEqual(c.versao.opcoes, OPCOES);
    assert.equal(c.versao.final, FINAL);
    assert.equal(c.versao.hora, iso(T0));
    assert.equal(c.descer, true);
    assert.equal(c.mensagem, null);
    assert.equal(c.mudouEm, iso(T0));
    assert.deepEqual(e.tg.saida, [{ sessionId: 'aba-1', entrouEm: iso(T0), falhas: 0 }]);
    assert.equal(tg.chamadas.length, 0); // evento nao chama a API

    await canal.drenar(e);
    const esperado = montarChamado({ estado: 'aviso', titulo: 'Aba Azul', hora: iso(T0), final: FINAL, chamadoId: 'ABCDEFGH' });
    assert.deepEqual(tg.chamadas, [{ metodo: 'enviar', args: [{ ...esperado, silencioso: false }] }]);
    assert.equal(esperado.botoes.length, 3); // A, B e Mais contexto
    assert.deepEqual(c.mensagem, { messageId: 501, formato: 'rich', versaoId: c.versao.id });
    assert.equal(c.descer, false);
    assert.deepEqual(c.apagar, []);
    assert.deepEqual(e.tg.mensagens, { 501: { sessionId: 'aba-1', at: iso(T0), formato: 'rich' } });
    assert.deepEqual(e.tg.saida, []);
    assert.equal(e.tg.saude.envioOkEm, iso(T0));
  });

  test('2o aviso da mesma aba: enviar do novo ANTES do apagar do antigo, com chamadoId novo', async () => {
    const { canal, tg, e } = novo();
    canal.aviso(e, parou('aba-1'), 'Aba');
    await canal.drenar(e);
    canal.aviso(e, parou('aba-1', 'Outra pergunta?'), 'Aba');
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false], ['enviar', false], ['apagar', 501]]);
    const c = e.tg.chamados['aba-1'];
    assert.equal(c.versao.chamadoId, 'JKMNPQRS');
    assert.deepEqual(c.mensagem, { messageId: 502, formato: 'rich', versaoId: c.versao.id });
    assert.deepEqual(c.apagar, []);
    assert.deepEqual(Object.keys(e.tg.mensagens), ['502']);
    assert.deepEqual(e.tg.saida, []);
  });

  test('enviar que falha: nada apagado, a antiga fica na tela e o item fica no comeco da fila', async () => {
    const { canal, tg, e } = novo({ roteiro: { enviar: [undefined, { ok: false, erro: 'sendRichMessage: Internal Server Error', codigo: 500 }] } });
    canal.aviso(e, parou('aba-1'), 'Aba');
    await canal.drenar(e);
    canal.aviso(e, parou('aba-1', 'De novo?'), 'Aba');
    canal.aviso(e, parou('aba-2'), 'Outra');
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false], ['enviar', false]]); // o drenar para na falha (aba-2 espera)
    const c = e.tg.chamados['aba-1'];
    assert.equal(c.mensagem.messageId, 501);
    assert.deepEqual(c.apagar, []);
    assert.equal(c.descer, true);
    assert.deepEqual(e.tg.saida.map((i) => [i.sessionId, i.falhas]), [['aba-1', 1], ['aba-2', 0]]);
    assert.ok(e.tg.mensagens[501]);
  });
});

// ---------- 3. fala do dono ----------

describe('3. fala do dono', () => {
  // T7d1a (F1): a mensagem do dono fica no chat. T7f (F8): enviando e entregue ficam so no estado (nenhuma mensagem nova
  // nem edicao do texto); o chamado que ele respondeu fica na tela e so perde os botoes (editarBotoes, sem notificar)
  test('falaRecebida: enviando so no estado (nenhuma mensagem nova; a do dono fica); o chamado na tela perde os botoes (editarBotoes) e fica; entregue so no estado', async () => {
    const { canal, tg, e, relogio } = novo();
    canal.aviso(e, parou('aba-1'), 'Aba');
    await canal.drenar(e);
    const vAviso = e.tg.chamados['aba-1'].versao.id;
    relogio.t = T0 + 5 * MIN;
    const fala = 'A) Sim, tudo hoje (recomendado)';
    canal.falaRecebida(e, { sessionId: 'aba-1', fala, audio: false, hora: iso(T0 + 5 * MIN), messageIdDono: 77 });
    const c = e.tg.chamados['aba-1'];
    assert.deepEqual(
      { estado: c.versao.estado, titulo: c.versao.titulo, final: c.versao.final, chamadoId: c.versao.chamadoId, opcoes: c.versao.opcoes, fala: c.versao.fala },
      { estado: 'enviando', titulo: 'Aba', final: FINAL, chamadoId: null, opcoes: [], fala },
    );
    assert.equal(c.versao.citar, 77); // T7d1a (F1): fica no estado
    assert.equal(c.descer, false); // T7f (F8): o enviando nao pede mensagem nova
    assert.deepEqual(c.apagar, []); // T7d1a (F1)
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false], ['editarBotoes', 501]]); // T7f (F8): sem enviar; T7d1a (F1): sem apagar(77)
    assert.deepEqual(tg.chamadas[1], { metodo: 'editarBotoes', args: [501, null] }); // so os botoes saem: o texto fica e nao notifica
    assert.deepEqual(c.mensagem, { messageId: 501, formato: 'rich', versaoId: vAviso }); // o chamado respondido fica na tela
    assert.deepEqual(Object.keys(e.tg.mensagens), ['501']);

    relogio.t = T0 + 6 * MIN;
    canal.entregue(e, 'aba-1', iso(T0 + 6 * MIN));
    assert.equal(c.versao.estado, 'entregue');
    assert.equal(c.versao.citar, 77);
    assert.equal(c.descer, false);
    await canal.drenar(e);
    assert.equal(tg.chamadas.length, 2); // T7f (F8): o entregue nao edita nada
    assert.deepEqual(c.mensagem, { messageId: 501, formato: 'rich', versaoId: vAviso });
    assert.deepEqual(e.tg.saida, []);
  });

  test('lerToque: opcao certa, Mais informações (i: e o legado c:), 2o toque obsoleto, toque em outra mensagem obsoleto; sessaoDaMensagem', async () => {
    const { canal, e } = novo();
    canal.aviso(e, parou('aba-1'), 'Aba');
    await canal.drenar(e); // mensagem 501 com o chamado ABCDEFGH
    assert.deepEqual(canal.lerToque(e, 'o:ABCDEFGH:1', 501), { sessionId: 'aba-1', acao: 'opcao', opcao: OPCOES[1] });
    assert.deepEqual(canal.lerToque(e, 'o:ABCDEFGH:0', '501'), { sessionId: 'aba-1', acao: 'opcao', opcao: OPCOES[0] });
    // T7c2: o botao de baixo e "Mais informações" (i:); o "Mais contexto" de antes (c:) ainda no chat abre igual
    assert.deepEqual(canal.lerToque(e, 'i:ABCDEFGH', 501), { sessionId: 'aba-1', acao: 'informacoes' });
    assert.deepEqual(canal.lerToque(e, 'c:ABCDEFGH', 501), { sessionId: 'aba-1', acao: 'informacoes' });
    assert.deepEqual(canal.lerToque(e, 'o:ABCDEFGH:5', 501), { obsoleto: true }); // indice fora das opcoes
    assert.deepEqual(canal.lerToque(e, 'o:ABCDEFGH:0', 999), { obsoleto: true }); // toque em outra mensagem
    assert.deepEqual(canal.lerToque(e, 'o:JKMNPQRS:0', 501), { obsoleto: true }); // outro chamado
    assert.deepEqual(canal.lerToque(e, 'lixo', 501), { obsoleto: true });
    assert.deepEqual(canal.lerToque(e, null, 501), { obsoleto: true });

    // versao fora de aviso/resposta nao aceita toque nem com o chamadoId e a mensagem certos (estado forjado)
    const c = e.tg.chamados['aba-1'];
    c.versao.estado = 'encerrado';
    assert.deepEqual(canal.lerToque(e, 'c:ABCDEFGH', 501), { obsoleto: true });
    c.versao.estado = 'aviso';

    // o porteiro passou o 1o toque pra aba: o 2o toque no mesmo botao ja e velho
    canal.falaRecebida(e, { sessionId: 'aba-1', fala: 'B) Só as correções', hora: iso(T0 + MIN) });
    assert.deepEqual(canal.lerToque(e, 'o:ABCDEFGH:1', 501), { obsoleto: true });

    assert.equal(canal.sessaoDaMensagem(e, 501), 'aba-1');
    assert.equal(canal.sessaoDaMensagem(e, '501'), 'aba-1');
    assert.equal(canal.sessaoDaMensagem(e, 12345), null);
    assert.equal(canal.sessaoDaMensagem(e, 'x'), null);
    canal.sistema(e, 'Modo rua ligado.');
    await canal.drenar(e);
    assert.equal(canal.sessaoDaMensagem(e, 501), 'aba-1'); // T7f (F8): o chamado respondido fica na tela (sem os botoes)
    assert.equal(canal.sessaoDaMensagem(e, e.tg.sistema.mensagem.messageId), null); // a do sistema
    canal.resposta(e, parou('aba-1', 'Feito.'), 'Aba'); // T7f: o resultado desce e a tela antiga e apagada
    await canal.drenar(e);
    const nova = e.tg.chamados['aba-1'].mensagem.messageId;
    assert.equal(canal.sessaoDaMensagem(e, nova), 'aba-1');
    assert.equal(canal.sessaoDaMensagem(e, 501), null); // apagada
  });

  // T7f (F8): o enviando fica so no estado (com o citar do audio); sem chamado na tela, nada
  test('falaRecebida de AUDIO em aba sem chamado: cria o chamado so no estado (T7f: nada na tela) com o citar do audio, e o audio fica no chat', async () => {
    const { canal, tg, e } = novo();
    canal.falaRecebida(e, { sessionId: 'aba-7', titulo: 'Aba Nova', fala: 'Aba Nova: roda os testes', audio: true, hora: iso(T0), messageIdDono: 60 });
    const c = e.tg.chamados['aba-7'];
    assert.deepEqual([c.versao.estado, c.versao.titulo, c.versao.final, c.versao.audio, c.descer, c.mensagem], ['enviando', 'Aba Nova', '', true, false, null]);
    assert.equal(c.versao.citar, 60);
    await canal.drenar(e);
    assert.deepEqual(passos(tg), []); // T7f (F8): nenhuma chamada (e o audio, 60, nunca e apagado)
    assert.equal(c.mensagem, null);
    assert.deepEqual(e.tg.saida, []);
  });
});

// ---------- 4. reconciliacao (versao x tela) ----------

describe('4. reconciliacao', () => {
  test('aviso + resposta antes de 1 drenar = 1 enviar so (a resposta)', async () => {
    const { canal, tg, e } = novo();
    canal.aviso(e, parou('aba-1'), 'Aba');
    canal.resposta(e, parou('aba-1', 'Pronto, feito.'), 'Aba');
    assert.equal(e.tg.saida.length, 1); // aba ja na fila nao entra de novo
    await canal.drenar(e);
    const v = e.tg.chamados['aba-1'].versao;
    assert.equal(v.estado, 'resposta');
    assert.equal(v.chamadoId, 'JKMNPQRS');
    const esperado = montarChamado({ estado: 'resposta', titulo: 'Aba', hora: iso(T0), final: 'Pronto, feito.', chamadoId: 'JKMNPQRS' });
    assert.deepEqual(tg.chamadas, [{ metodo: 'enviar', args: [{ ...esperado, silencioso: false }] }]);
  });

  // T7d1a (F1): a mensagem do dono (80) fica no chat. T7f (F8): nenhuma mensagem nova; so os botoes da tela saem
  test('falaRecebida + entregue antes do drenar = nenhuma mensagem nova (T7f): so os botoes da tela antiga saem e ela fica', async () => {
    const { canal, tg, e } = novo();
    canal.aviso(e, parou('aba-1'), 'Aba');
    await canal.drenar(e);
    canal.falaRecebida(e, { sessionId: 'aba-1', fala: 'faz só as correções', hora: iso(T0 + MIN), messageIdDono: 80 });
    canal.entregue(e, 'aba-1', iso(T0 + 2 * MIN));
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false], ['editarBotoes', 501]]); // T7f (F8); T7d1a (F1): nada com o 80
    const c = e.tg.chamados['aba-1'];
    assert.deepEqual([c.versao.estado, c.versao.citar, c.versao.horaEntrega, c.mensagem.messageId], ['entregue', 80, iso(T0 + 2 * MIN), 501]);
  });

  test('encerrar de aviso na tela = editar sem botoes com o final; botao dele vira obsoleto', async () => {
    const { canal, tg, e } = novo();
    canal.aviso(e, parou('aba-1'), 'Aba');
    await canal.drenar(e);
    canal.encerrar(e, 'aba-1', iso(T0 + 3 * MIN), 'pc');
    await canal.drenar(e);
    const encerrado = montarChamado({ estado: 'encerrado', titulo: 'Aba', hora: iso(T0 + 3 * MIN), final: FINAL, motivo: 'pc' });
    assert.deepEqual(tg.chamadas[1], { metodo: 'editar', args: [501, { ...encerrado, formato: 'rich' }] });
    assert.equal(encerrado.botoes, null);
    assert.ok(encerrado.html.includes('Mensagem completa'));
    assert.equal(tg.chamadas.length, 2);
    assert.deepEqual(canal.lerToque(e, 'o:ABCDEFGH:0', 501), { obsoleto: true });
    assert.deepEqual(e.tg.saida, []);
  });

  test('encerrar de aviso que nunca saiu e sem tela = nenhuma chamada e o chamado sai', async () => {
    const { canal, tg, e } = novo();
    canal.aviso(e, parou('aba-1'), 'Aba');
    canal.encerrar(e, 'aba-1', iso(T0 + MIN), 'whatsapp');
    assert.deepEqual(e.tg.chamados, {});
    assert.deepEqual(e.tg.saida, []);
    await canal.drenar(e);
    assert.equal(tg.chamadas.length, 0);
  });

  test('encerrar de resposta que nao saiu, com outra mensagem na tela: descer desliga e a tela vira o encerrado', async () => {
    const { canal, tg, e } = novo();
    canal.aviso(e, parou('aba-1'), 'Aba');
    await canal.drenar(e);
    canal.falaRecebida(e, { sessionId: 'aba-1', fala: 'vai', hora: iso(T0 + MIN) });
    await canal.drenar(e);
    canal.entregue(e, 'aba-1', iso(T0 + 2 * MIN));
    await canal.drenar(e);
    canal.resposta(e, parou('aba-1', 'Feito, subiu.', iso(T0 + 9 * MIN)), 'Aba');
    canal.encerrar(e, 'aba-1', iso(T0 + 10 * MIN), 'whatsapp');
    const c = e.tg.chamados['aba-1'];
    assert.equal(c.descer, false);
    await canal.drenar(e);
    // T7f (F8): a outra mensagem na tela e o aviso (sem os botoes desde a fala), nao mais o enviando/entregue
    assert.deepEqual(passos(tg), [['enviar', false], ['editarBotoes', 501], ['editar', 501]]);
    const encerrado = montarChamado({ estado: 'encerrado', titulo: 'Aba', hora: iso(T0 + 10 * MIN), final: 'Feito, subiu.', motivo: 'whatsapp' });
    assert.deepEqual(tg.chamadas[2].args[1], { ...encerrado, formato: 'rich' });
  });

  // T27 (PLANO-TELEGRAM.md, "T27", contrato 3; caso real 18/10: a resposta virou edicao calada da mensagem antiga)
  test('T27 1. encerrar "pc" de resposta que nao saiu = nada muda: a resposta sai como mensagem nova, com notificacao', async () => {
    const { canal, tg, e, logs } = novo();
    canal.aviso(e, parou('aba-1'), 'Aba');
    await canal.drenar(e); // 501
    canal.falaRecebida(e, { sessionId: 'aba-1', fala: 'vai', hora: iso(T0 + MIN) });
    await canal.drenar(e);
    canal.entregue(e, 'aba-1', iso(T0 + 2 * MIN));
    await canal.drenar(e);
    canal.resposta(e, parou('aba-1', 'Feito, subiu.', iso(T0 + 9 * MIN)), 'Aba');
    const antes = JSON.stringify(e.tg);
    canal.encerrar(e, 'aba-1', iso(T0 + 10 * MIN), 'pc');
    assert.equal(JSON.stringify(e.tg), antes, 'nada muda no estado');
    assert.ok(logs.some((l) => l.includes('aba-1') && l.includes('resposta') && l.includes('encerrar')), logs.join('\n'));
    const c = e.tg.chamados['aba-1'];
    assert.deepEqual([c.versao.estado, c.descer], ['resposta', true]);
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false], ['editarBotoes', 501], ['enviar', false], ['apagar', 501]]);
    assert.deepEqual(tg.chamadas[2].args[0], { ...montarChamado(c.versao), silencioso: false });
    // a resposta ja na tela: o encerrar "pc" segue o de hoje (edicao, sem botoes)
    canal.encerrar(e, 'aba-1', iso(T0 + 11 * MIN), 'pc');
    assert.deepEqual([e.tg.chamados['aba-1'].versao.estado, e.tg.chamados['aba-1'].descer], ['encerrado', false]);
  });

  test('T27 1b. resposta que ja saiu e perdeu a tela (tela torta que a leitura tira; sem descer): o encerrar "pc" segue o de hoje (o chamado sai sem mensagem)', async () => {
    const { canal, tg, e } = novo();
    canal.resposta(e, parou('aba-1', 'Feito, subiu.', iso(T0 + 9 * MIN)), 'Aba');
    await canal.drenar(e); // 501
    e.tg.chamados['aba-1'].mensagem = { messageId: 'torta' };
    canal.encerrar(e, 'aba-1', iso(T0 + 10 * MIN), 'pc');
    assert.deepEqual(e.tg.chamados, {});
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false]]);
  });

  test('entregue fora de enviando/contexto e encerrar fora de aviso/resposta = nada', async () => {
    const { canal, tg, e } = novo();
    canal.aviso(e, parou('aba-1'), 'Aba');
    await canal.drenar(e);
    const antes = structuredClone(e.tg);
    canal.entregue(e, 'aba-1', iso(T0 + MIN)); // a resposta ja chegou: nada
    canal.entregue(e, 'aba-x', iso(T0 + MIN)); // aba sem chamado: nada
    assert.deepEqual(e.tg, antes);
    canal.falaRecebida(e, { sessionId: 'aba-1', fala: 'vai', hora: iso(T0 + MIN) });
    await canal.drenar(e);
    const depois = structuredClone(e.tg);
    canal.encerrar(e, 'aba-1', iso(T0 + 2 * MIN), 'pc'); // enviando nao tem botoes: nada
    canal.encerrar(e, 'aba-x', iso(T0 + 2 * MIN), 'pc');
    assert.deepEqual(e.tg, depois);
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false], ['editarBotoes', 501]]); // T7f (F8): a fala so tira os botoes
  });

  test('estado contexto de antes (T7c2: ninguem mais cria): falaRecebida com contexto: true vira enviando; a versao contexto gravada antes ainda sai em silencio e o entregue (T7f) fica so no estado', async () => {
    const { canal, tg, e } = novo();
    canal.aviso(e, parou('aba-1'), 'Aba');
    await canal.drenar(e);
    canal.falaRecebida(e, { sessionId: 'aba-1', contexto: true, fala: 'B) Só as correções', hora: iso(T0 + MIN) });
    const c = e.tg.chamados['aba-1'];
    const v = c.versao;
    assert.equal(v.estado, 'enviando', 'T7c2: falaRecebida nao tem mais o campo contexto');
    assert.equal(v.fala, 'B) Só as correções');
    assert.equal(c.descer, false, 'T7f (F8): o enviando de hoje nao desce');
    // a versao como o porteiro de antes gravou no disco (estado contexto, descendo): o desenho antigo continua
    v.estado = 'contexto';
    v.fala = 'Mais contexto';
    c.descer = true;
    await canal.drenar(e);
    assert.deepEqual(tg.chamadas[1].args[0], { ...montarChamado({ estado: 'contexto', titulo: 'Aba', hora: iso(T0 + MIN) }), silencioso: true });
    canal.entregue(e, 'aba-1', iso(T0 + 2 * MIN));
    assert.equal(c.versao.estado, 'entregue');
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false], ['enviar', true], ['apagar', 501]]); // T7f (F8): o entregue nao edita
    assert.ok(tg.chamadas[1].args[0].html.includes('Você pediu mais contexto'));
  });
});

// ---------- 5. 48 h e edicao que falha ----------

describe('5. 48 h e edicao que falha', () => {
  // T7d1a (F1): a mensagem do dono (80) nunca vai pro apagar (antes: velha do dono = nada)
  test('apagar velha de mensagem do bot = editar pra movido no formato dela; a do dono fica no chat; jaSumiu = ok', async () => {
    const { canal, tg, e } = novo({
      roteiro: {
        enviar: [{ ok: true, messageId: 501, formato: 'classico' }],
        apagar: [{ ok: false, velha: true }, { ok: true, jaSumiu: true }],
      },
    });
    canal.aviso(e, parou('aba-1'), 'Aba');
    await canal.drenar(e); // 501 no formato classico
    canal.falaRecebida(e, { sessionId: 'aba-1', fala: 'vai', hora: iso(T0 + MIN), messageIdDono: 80 });
    await canal.drenar(e); // T7f (F8): so os botoes do 501 saem; 80 (do dono) fica no chat sem chamar a API
    canal.entregue(e, 'aba-1', iso(T0 + 2 * MIN));
    await canal.drenar(e); // T7f (F8): nada
    canal.resposta(e, parou('aba-1', 'Feito.'), 'Aba');
    await canal.drenar(e); // 502; 501 velha -> movido
    canal.resposta(e, parou('aba-1', 'Feito de novo.'), 'Aba');
    await canal.drenar(e); // 503; 502 ja sumiu = ok
    assert.deepEqual(passos(tg), [
      ['enviar', false],
      ['editarBotoes', 501],
      ['enviar', false],
      ['apagar', 501],
      ['editar', 501],
      ['enviar', false],
      ['apagar', 502],
    ]);
    assert.deepEqual(tg.chamadas[4].args[1], { ...montarChamado({ estado: 'movido', titulo: 'Aba' }), formato: 'classico' });
    assert.ok(!tg.chamadas.some((x) => x.args[0] === 80), 'a do dono nunca passa pela API');
    assert.equal(e.tg.mensagens[501].movido, true);
    assert.deepEqual(Object.keys(e.tg.mensagens), ['501', '503']);
    assert.deepEqual(e.tg.chamados['aba-1'].apagar, []);
    assert.deepEqual(e.tg.saida, []);
  });

  // T7f (F8): o entregue nao edita mais; a edicao do teste e a do encerrado (aviso na tela que a aba seguiu no PC)
  test('editar com codigo 400 = mensagem nova na hora + apagar da antiga', async () => {
    const { canal, tg, e, logs } = novo({ roteiro: { editar: [{ ok: false, erro: 'editMessageText: Bad Request: message to edit not found', codigo: 400 }] } });
    canal.aviso(e, parou('aba-1'), 'Aba');
    await canal.drenar(e); // 501
    canal.encerrar(e, 'aba-1', iso(T0 + 2 * MIN), 'pc');
    await canal.drenar(e); // editar 501 = 400 -> enviar 502 + apagar 501
    assert.deepEqual(passos(tg), [['enviar', false], ['editar', 501], ['enviar', true], ['apagar', 501]]);
    const c = e.tg.chamados['aba-1'];
    assert.deepEqual(tg.chamadas[2].args[0], { ...montarChamado(c.versao), silencioso: true });
    assert.deepEqual(c.mensagem, { messageId: 502, formato: 'rich', versaoId: c.versao.id });
    assert.equal(c.descer, false);
    assert.deepEqual(e.tg.saude.envioFalhaDesde, null); // 400 nao marca
    assert.ok(logs.some((l) => l.includes('aba-1') && l.includes('message to edit not found')));
  });
});

// ---------- 6. fila e saude ----------

describe('6. fila e saude', () => {
  test('429: pausa em memoria; nenhuma chamada antes de passar esperarS; depois sai; falhas e saude nao contam', async () => {
    const { canal, tg, e, relogio } = novo({ roteiro: { enviar: [{ ok: false, erro: 'sendRichMessage: Too Many Requests: retry after 30', codigo: 429, esperarS: 30 }] } });
    canal.aviso(e, parou('aba-1'), 'Aba');
    canal.aviso(e, parou('aba-2'), 'Outra');
    const r = await canal.drenar(e);
    assert.equal(tg.chamadas.length, 1);
    assert.deepEqual(e.tg.saida.map((i) => [i.sessionId, i.falhas]), [['aba-1', 0], ['aba-2', 0]]);
    assert.deepEqual(e.tg.saude, tgNovo().saude);
    assert.deepEqual(r, { chamadas: 1, pendentes: 2, pausaAte: iso(T0 + 30 * 1000) });
    relogio.t = T0 + 29 * 1000;
    await canal.drenar(e);
    assert.equal(tg.chamadas.length, 1);
    relogio.t = T0 + 30 * 1000;
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false], ['enviar', false], ['enviar', false]]);
    assert.deepEqual(e.tg.saida, []);
    assert.equal(e.tg.saude.envioOkEm, iso(T0 + 30 * 1000));
  });

  test('transporte (rede, 5xx, sem codigo): item fica no comeco com falhas; marca envioFalhaDesde (so a 1a) e envioUltimaFalhaEm; sucesso limpa', async () => {
    const { canal, tg, e, relogio, logs } = novo({
      roteiro: {
        enviar: [
          { ok: false, erro: 'sendRichMessage: fetch failed', codigo: 0 },
          { ok: false, erro: 'sendMessage: Bad Gateway', codigo: 502 },
          { ok: false, erro: 'enviar: sem resposta' },
        ],
      },
    });
    canal.aviso(e, parou('aba-1'), 'Aba');
    canal.aviso(e, parou('aba-2'), 'Outra');
    await canal.drenar(e);
    assert.equal(tg.chamadas.length, 1);
    assert.deepEqual(e.tg.saida.map((i) => [i.sessionId, i.falhas]), [['aba-1', 1], ['aba-2', 0]]);
    assert.equal(e.tg.saude.envioFalhaDesde, iso(T0));
    assert.equal(e.tg.saude.envioUltimaFalhaEm, iso(T0));
    relogio.t = T0 + MIN;
    await canal.drenar(e);
    relogio.t = T0 + 2 * MIN;
    await canal.drenar(e);
    assert.equal(e.tg.saida[0].falhas, 3);
    assert.equal(e.tg.saude.envioFalhaDesde, iso(T0));
    assert.equal(e.tg.saude.envioUltimaFalhaEm, iso(T0 + 2 * MIN));
    assert.equal(e.tg.saude.envioOkEm, null);
    assert.equal(logs.filter((l) => /falhou/.test(l)).length, 1); // log na 1a (e a cada 20)
    relogio.t = T0 + 3 * MIN;
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false], ['enviar', false], ['enviar', false], ['enviar', false], ['enviar', false]]);
    assert.deepEqual(e.tg.saida, []);
    const s = e.tg.saude;
    assert.deepEqual([s.envioOkEm, s.envioFalhaDesde, s.envioUltimaFalhaEm], [iso(T0 + 3 * MIN), null, null]);
  });

  test('enviar ok e apagar com transporte: na proxima so o apagar (nada reenviado)', async () => {
    const { canal, tg, e } = novo({ roteiro: { apagar: [{ ok: false, erro: 'deleteMessage: fetch failed', codigo: 0 }] } });
    canal.aviso(e, parou('aba-1'), 'Aba');
    await canal.drenar(e);
    canal.aviso(e, parou('aba-1', 'De novo?'), 'Aba');
    await canal.drenar(e);
    const c = e.tg.chamados['aba-1'];
    assert.equal(c.mensagem.messageId, 502);
    assert.deepEqual(c.apagar, [{ messageId: 501, doBot: true, formato: 'rich' }]);
    assert.equal(e.tg.saida[0].falhas, 1);
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false], ['enviar', false], ['apagar', 501], ['apagar', 501]]);
    assert.deepEqual(c.apagar, []);
    assert.deepEqual(e.tg.saida, []);
  });

  test('2 h na fila = perdida (log com as falhas); log de falha na 1a e na 20a', async () => {
    const falha = () => ({ ok: false, erro: 'sendRichMessage: Service Unavailable', codigo: 503 });
    const { canal, tg, e, relogio, logs } = novo({ roteiro: { enviar: falha } });
    canal.aviso(e, parou('aba-1'), 'Aba');
    for (let i = 0; i < 20; i += 1) {
      relogio.t = T0 + i * MIN;
      await canal.drenar(e);
    }
    assert.equal(e.tg.saida[0].falhas, 20);
    assert.equal(logs.filter((l) => /falhou/.test(l)).length, 2);
    relogio.t = T0 + 2 * H - 1;
    await canal.drenar(e);
    assert.equal(e.tg.saida.length, 1);
    relogio.t = T0 + 2 * H;
    await canal.drenar(e);
    assert.equal(tg.chamadas.length, 21);
    assert.deepEqual(e.tg.saida, []);
    assert.ok(logs.some((l) => /perdida/.test(l) && l.includes('aba-1') && l.includes('21')), logs.join('\n'));
  });

  test('400 no enviar = recusado: item sai (log) e o proximo segue; 400 nao marca saude', async () => {
    const { canal, tg, e, logs } = novo({ roteiro: { enviar: [{ ok: false, erro: "sendMessage: Bad Request: can't parse entities", codigo: 400 }] } });
    canal.aviso(e, parou('aba-1'), 'Aba');
    canal.aviso(e, parou('aba-2'), 'Outra');
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false], ['enviar', false]]);
    assert.deepEqual(e.tg.saida, []);
    assert.equal(e.tg.chamados['aba-1'].mensagem, null);
    assert.equal(e.tg.chamados['aba-2'].mensagem.messageId, 502);
    assert.equal(e.tg.saude.envioFalhaDesde, null);
    assert.equal(e.tg.saude.envioUltimaFalhaEm, null);
    assert.ok(logs.some((l) => l.includes('aba-1') && /recusad/.test(l)), logs.join('\n'));
  });

  test('travado: item de aba sai da fila sem mandar (log); o do sistema sai normal', async () => {
    const { canal, tg, e, logs } = novo();
    canal.aviso(e, parou('aba-1'), 'Aba');
    canal.sistema(e, 'Travado. Destrava no PC.');
    await canal.drenar(e, { travado: true });
    assert.deepEqual(passos(tg), [['enviar', true]]);
    assert.equal(tg.chamadas[0].args[0].html, montarSistema(e.tg.sistema.linhas).html);
    assert.deepEqual(e.tg.saida, []);
    assert.equal(e.tg.chamados['aba-1'].mensagem, null);
    assert.ok(logs.some((l) => l.includes('aba-1') && /travado/.test(l)), logs.join('\n'));
  });

  test('fora do modo rua: aviso que nao esta na tela sai da fila sem mandar (dono no PC); resposta sai', async () => {
    const { canal, tg, e, logs } = novo();
    canal.aviso(e, parou('aba-1'), 'Aba');
    canal.resposta(e, parou('aba-2', 'Feito.'), 'Outra');
    await canal.drenar(e, { modoRua: false });
    assert.deepEqual(passos(tg), [['enviar', false]]);
    assert.deepEqual(tg.chamadas[0].args[0], { ...montarChamado(e.tg.chamados['aba-2'].versao), silencioso: false });
    assert.equal(e.tg.chamados['aba-1'].mensagem, null);
    assert.deepEqual(e.tg.saida, []);
    assert.ok(logs.some((l) => l.includes('aba-1') && /dono no PC/.test(l)), logs.join('\n'));
  });
});

// ---------- 7. sistema e problema ----------

describe('7. sistema e problema', () => {
  test('so a ultima linha na tela (T15; as 10 ultimas guardadas); linha sem notificar e sem citar = editar silencioso da mensagem do sistema', async () => {
    const { canal, tg, e, relogio } = novo();
    canal.sistema(e, 'linha 1');
    await canal.drenar(e);
    assert.deepEqual(tg.chamadas[0], { metodo: 'enviar', args: [{ ...montarSistema(e.tg.sistema.linhas), botoes: null, silencioso: true }] });
    for (const n of [2, 3, 4]) {
      relogio.t += MIN;
      canal.sistema(e, `linha ${n}`);
    }
    assert.equal(e.tg.saida.length, 1);
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', true], ['editar', 501]]);
    const pedido = tg.chamadas[1].args[1];
    assert.deepEqual(pedido, { ...montarSistema(e.tg.sistema.linhas), botoes: null, formato: 'rich' });
    assert.ok(pedido.html.includes('linha 4') && !pedido.html.includes('linha 3') && !pedido.html.includes('linha 2'), pedido.html);
    assert.deepEqual(e.tg.sistema.linhas.map((l) => l.texto), ['linha 1', 'linha 2', 'linha 3', 'linha 4']);
    assert.deepEqual(e.tg.mensagens[501], { sessionId: 'sistema', at: iso(T0), formato: 'rich' });
    assert.equal(e.tg.sistema.mensagem.versaoId, e.tg.sistema.versaoId);
    assert.deepEqual(e.tg.saida, []);
  });

  test('com notificar = mensagem nova com notificacao + apagar da antiga; a seguinte volta a ser edicao', async () => {
    const { canal, tg, e } = novo();
    canal.sistema(e, 'Status: 2 abas.');
    await canal.drenar(e);
    canal.sistema(e, 'O WhatsApp caiu.', { notificar: true });
    assert.equal(e.tg.sistema.notificar, true);
    assert.equal(e.tg.sistema.descer, true);
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', true], ['enviar', false], ['apagar', 501]]);
    assert.equal(e.tg.sistema.notificar, false);
    assert.equal(e.tg.sistema.descer, false);
    assert.equal(e.tg.sistema.mensagem.messageId, 502);
    canal.sistema(e, 'O WhatsApp voltou.');
    await canal.drenar(e);
    assert.deepEqual(passos(tg).slice(3), [['editar', 502]]);
  });

  // pedido do dono (Telegram): o titulo dela e "🎛️ Controle de Sessões", no movido tambem
  test('a do sistema com mais de 48 h vira movido com o titulo dela (🎛️ Controle de Sessões)', async () => {
    const { canal, tg, e } = novo({ roteiro: { apagar: [{ ok: false, velha: true }] } });
    canal.sistema(e, 'Status: 2 abas.');
    await canal.drenar(e);
    assert.ok(tg.chamadas[0].args[0].html.startsWith('<h3>🎛️ Controle de Sessões</h3>'), tg.chamadas[0].args[0].html);
    canal.sistema(e, 'O WhatsApp caiu.', { notificar: true });
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', true], ['enviar', false], ['apagar', 501], ['editar', 501]]);
    const movido = tg.chamadas[3].args[1];
    assert.equal(movido.html, '<p><b>🎛️ Controle de Sessões</b>: chamado movido pra baixo.</p>');
    assert.equal(movido.classico, '<b>🎛️ Controle de Sessões</b>: chamado movido pra baixo.');
    assert.equal(e.tg.mensagens[501].movido, true);
  });

  // T22b (pedido do dono, Telegram: «A gente pode colocar os dois iguais»): o chamado da central com o titulo do
  // sistema; as outras abas seguem com "ℹ️ <nome>"
  describe('T22b. o chamado da central com o titulo do sistema', () => {
    const daCentral = (sid, titulo) => sid === 'central-1' && titulo === 'Controle';

    test('o aviso da central sai com "🎛️ Controle de Sessões"; o da aba, com "ℹ️ <nome>"; o ehCentral recebe o sessionId e o titulo', async () => {
      const vistos = [];
      const { canal, tg, e } = novo({ ehCentral: (sid, titulo) => { vistos.push([sid, titulo]); return daCentral(sid, titulo); } });
      canal.aviso(e, parou('central-1'), 'Controle');
      canal.aviso(e, parou('aba-1'), 'Aba Azul');
      await canal.drenar(e);
      const html = tg.chamadas.filter((x) => x.metodo === 'enviar').map((x) => x.args[0].html);
      const doSistema = montarChamado({ estado: 'aviso', titulo: 'Controle de Sessões', icone: '🎛️', hora: iso(T0), final: FINAL, chamadoId: 'ABCDEFGH' });
      assert.equal(html[0], doSistema.html);
      assert.ok(html[0].startsWith('<h2>🎛️ Controle de Sessões</h2>'), html[0]);
      assert.equal(tg.chamadas.filter((x) => x.metodo === 'enviar')[0].args[0].classico, doSistema.classico);
      assert.ok(html[1].startsWith('<h2>ℹ️ Aba Azul</h2>'), html[1]);
      assert.equal(e.tg.chamados['central-1'].versao.titulo, 'Controle', 'o estado guarda o titulo da aba (so a tela muda)');
      assert.ok(vistos.some(([sid, t]) => sid === 'central-1' && t === 'Controle'), JSON.stringify(vistos));
      assert.ok(vistos.some(([sid, t]) => sid === 'aba-1' && t === 'Aba Azul'), JSON.stringify(vistos));
    });

    test('o movido da central (mais de 48 h) sai com "🎛️ Controle de Sessões"; o da aba, com "ℹ️ <nome>"', async () => {
      const { canal, tg, e } = novo({ ehCentral: daCentral, roteiro: { apagar: [{ ok: false, velha: true }, { ok: false, velha: true }] } });
      canal.aviso(e, parou('central-1'), 'Controle');
      await canal.drenar(e);
      canal.aviso(e, parou('central-1', 'Outra pergunta?'), 'Controle');
      await canal.drenar(e);
      assert.deepEqual(passos(tg), [['enviar', false], ['enviar', false], ['apagar', 501], ['editar', 501]]);
      assert.equal(tg.chamadas[3].args[1].html, '<p><b>🎛️ Controle de Sessões</b>: chamado movido pra baixo.</p>');
      assert.equal(tg.chamadas[3].args[1].classico, '<b>🎛️ Controle de Sessões</b>: chamado movido pra baixo.');
      canal.aviso(e, parou('aba-1'), 'Aba Azul');
      await canal.drenar(e);
      canal.aviso(e, parou('aba-1', 'Outra pergunta?'), 'Aba Azul');
      await canal.drenar(e);
      const ed = tg.chamadas.filter((x) => x.metodo === 'editar').at(-1).args[1];
      assert.equal(ed.html, '<p><b>ℹ️ Aba Azul</b>: chamado movido pra baixo.</p>');
    });

    test('ehCentral que lanca ou devolve outra coisa que true = aba como as outras, sem lancar pra fora; ehCentral que nao e funcao = TypeError', async () => {
      for (const ehCentral of [() => { throw new Error('x'); }, () => 1, () => 'sim']) {
        const { canal, tg, e } = novo({ ehCentral });
        canal.aviso(e, parou('central-1'), 'Controle');
        await canal.drenar(e);
        assert.ok(tg.chamadas.filter((x) => x.metodo === 'enviar')[0].args[0].html.startsWith('<h2>ℹ️ Controle</h2>'), tg.chamadas.filter((x) => x.metodo === 'enviar')[0].args[0].html);
      }
      for (const ehCentral of [true, 'central-1', {}]) {
        assert.throws(() => criarCanalTelegram({ tg: dubleTg(), chatId: DONO, ehCentral }), TypeError);
      }
      assert.doesNotThrow(() => criarCanalTelegram({ tg: dubleTg(), chatId: DONO, ehCentral: null }));
    });
  });

  // T7d1a (F1): o apagarDoDono saiu; citar = mensagem nova silenciosa em cima da do dono, que fica no chat
  test('com citar = mensagem nova silenciosa em cima da do dono + apagar so da antiga; apagarDoDono = TypeError', async () => {
    const { canal, tg, e } = novo();
    canal.sistema(e, 'Status: 2 abas.');
    await canal.drenar(e);
    canal.sistema(e, 'Modo rua ligado.', { citar: 90 });
    assert.deepEqual(e.tg.sistema.apagar, []);
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', true], ['enviar', true], ['apagar', 501]]);
    assert.equal(tg.chamadas[1].args[0].responderA, 90);
    assert.deepEqual(e.tg.sistema.apagar, []);
    assert.throws(() => canal.sistema(e, 'x', { apagarDoDono: [90] }), TypeError);
  });

  test('problema = mensagem nova com notificacao, mantem a fala que ele tentou e apaga o anterior', async () => {
    const { canal, tg, e } = novo();
    canal.aviso(e, parou('aba-1'), 'Aba');
    await canal.drenar(e);
    canal.falaRecebida(e, { sessionId: 'aba-1', fala: 'faz X', audio: true, hora: iso(T0 + MIN) });
    await canal.drenar(e); // T7f (F8): so os botoes do aviso saem
    canal.problema(e, 'aba-1', 'A aba fechou antes de receber.');
    const v = e.tg.chamados['aba-1'].versao;
    assert.deepEqual([v.estado, v.fala, v.audio, v.hora, v.frase, v.titulo], ['problema', 'faz X', true, iso(T0 + MIN), 'A aba fechou antes de receber.', 'Aba']);
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false], ['editarBotoes', 501], ['enviar', false], ['apagar', 501]]); // T7f: o anterior e o aviso
    const esperado = montarChamado({ estado: 'problema', titulo: 'Aba', hora: iso(T0 + MIN), fala: 'faz X', audio: true, frase: 'A aba fechou antes de receber.' });
    assert.deepEqual(tg.chamadas[2].args[0], { ...esperado, silencioso: false });
    assert.ok(esperado.html.includes('faz X'));
    // problema com dados proprios e sem chamado antes
    canal.problema(e, 'aba-2', 'Aba não encontrada.', { titulo: 'Nova', fala: 'oi', hora: iso(T0 + 2 * MIN) });
    const v2 = e.tg.chamados['aba-2'].versao;
    assert.deepEqual([v2.estado, v2.titulo, v2.fala, v2.audio, v2.hora], ['problema', 'Nova', 'oi', false, iso(T0 + 2 * MIN)]);
  });
});

// ---------- 8. ensaio, podar, completarTg, entrada invalida e log sem conteudo ----------

describe('8. ensaio, podar, completarTg e log', () => {
  test('ensaio: nenhuma chamada ao tg; registrarEnsaio com cada acao; messageId negativo e unico, formato rich', async () => {
    // T7f (F8): a fala e o entregue nao registram mensagem (so o editarBotoes do aviso); o enviar com responderA e a
    // edicao passam a vir da resposta e do encerrado
    const { canal, tg, e, ensaios } = novo({ ensaio: true });
    canal.aviso(e, parou('aba-1'), 'Aba'); // versao 1
    await canal.drenar(e); // enviar -> -2
    canal.falaRecebida(e, { sessionId: 'aba-1', fala: 'vai', hora: iso(T0 + MIN), messageIdDono: 70 }); // versao 3
    await canal.drenar(e); // editarBotoes -2; a 70 (do dono) fica (T7d1a, F1)
    canal.entregue(e, 'aba-1', iso(T0 + 2 * MIN)); // versao 4
    await canal.drenar(e); // nada
    canal.resposta(e, parou('aba-1', 'Feito.'), 'Aba', { citar: 70 }); // versao 5
    await canal.drenar(e); // enviar -> -6 (em cima da 70), apagar -2
    canal.encerrar(e, 'aba-1', iso(T0 + 3 * MIN), 'pc'); // versao 7
    await canal.drenar(e); // editar -6
    canal.sistema(e, 'Modo rua ligado.'); // versao 8
    await canal.drenar(e); // enviar -> -9
    assert.equal(tg.chamadas.length, 0);
    assert.deepEqual(ensaios.map((x) => x.acao), ['tg.enviar', 'tg.editarBotoes', 'tg.enviar', 'tg.apagar', 'tg.editar', 'tg.enviar']);
    const aviso = montarChamado({ estado: 'aviso', titulo: 'Aba', hora: iso(T0), final: FINAL, chamadoId: 'ABCDEFGH' });
    assert.deepEqual(ensaios[0], { acao: 'tg.enviar', sessionId: 'aba-1', estado: 'aviso', silencioso: false, ...aviso });
    assert.deepEqual(ensaios[1], { acao: 'tg.editarBotoes', sessionId: 'aba-1', messageId: -2, botoes: null });
    assert.deepEqual(ensaios[2].estado, 'resposta');
    assert.deepEqual(ensaios[2].silencioso, false);
    assert.equal(ensaios[2].responderA, 70); // T7d1a (F1): o registro leva o responderA quando existe
    assert.ok(!('responderA' in ensaios[0])); // e nao leva quando nao existe
    assert.deepEqual(ensaios[3], { acao: 'tg.apagar', messageId: -2 });
    const encerrado = montarChamado(e.tg.chamados['aba-1'].versao);
    assert.deepEqual(ensaios[4], { acao: 'tg.editar', sessionId: 'aba-1', messageId: -6, estado: 'encerrado', ...encerrado });
    assert.deepEqual(ensaios[5], { acao: 'tg.enviar', sessionId: 'sistema', estado: 'sistema', silencioso: true, ...montarSistema(e.tg.sistema.linhas), botoes: null });
    assert.deepEqual(e.tg.chamados['aba-1'].mensagem, { messageId: -6, formato: 'rich', versaoId: 7 });
    assert.deepEqual(e.tg.sistema.mensagem, { messageId: -9, formato: 'rich', versaoId: 8 });
    assert.deepEqual(Object.keys(e.tg.mensagens).sort(), ['-6', '-9']);
    assert.deepEqual(e.tg.saida, []);
  });

  test('podar: chamado parado 24 h e fora da fila sai; mensagens de 7 dias saem; sistema fica nas 10 ultimas linhas', async () => {
    const { canal, e, relogio } = novo();
    canal.aviso(e, parou('aba-1'), 'Aba');
    await canal.drenar(e); // aba-1 fora da fila, mensagem 501 as T0
    relogio.t = T0 + H;
    canal.aviso(e, parou('aba-2'), 'Outra'); // aba-2 fica na fila (sem drenar)
    for (let i = 1; i <= 12; i += 1) canal.sistema(e, `linha ${i}`);
    assert.equal(e.tg.sistema.linhas.length, 10);
    assert.equal(e.tg.sistema.linhas[0].texto, 'linha 3');
    e.tg.sistema.linhas.unshift({ hora: iso(T0), texto: 'velha 1' }, { hora: iso(T0), texto: 'velha 2' }); // estado antigo com 12
    canal.podar(e, T0 + DIA - 1);
    assert.deepEqual(Object.keys(e.tg.chamados).sort(), ['aba-1', 'aba-2']);
    assert.equal(e.tg.sistema.linhas.length, 10);
    assert.equal(e.tg.sistema.linhas[0].texto, 'linha 3');
    canal.podar(e, T0 + DIA);
    assert.deepEqual(Object.keys(e.tg.chamados), ['aba-2']); // aba-2 esta na fila
    canal.podar(e, T0 + 30 * DIA);
    assert.deepEqual(Object.keys(e.tg.chamados), ['aba-2']);
    assert.deepEqual(Object.keys(e.tg.mensagens), []);
    // mensagens: 7 dias exatos saem, 1 ms antes ficam
    const outro = novo();
    outro.canal.aviso(outro.e, parou('aba-1'), 'Aba');
    await outro.canal.drenar(outro.e);
    outro.canal.podar(outro.e, T0 + 7 * DIA - 1);
    assert.deepEqual(Object.keys(outro.e.tg.mensagens), ['501']);
    outro.canal.podar(outro.e, T0 + 7 * DIA);
    assert.deepEqual(Object.keys(outro.e.tg.mensagens), []);
  });

  test('completarTg: bruto vazio, campo de tipo errado, saude e sistema parciais', () => {
    const vazio = tgNovo();
    assert.deepEqual(vazio, {
      offset: null,
      vistos: [],
      seq: 0,
      chamados: {},
      mensagens: {},
      saida: [],
      sistema: { linhas: [], versaoId: 0, descer: false, notificar: false, citar: null, mensagem: null, apagar: [] }, // T7d1a: citar
      painel: { dados: null, versaoId: 0, descer: false, citar: null, mensagem: null, apagar: [] }, // T9
      situacao: { aba: null, dados: null, chamadoId: null, completo: false, versaoId: 0, descer: false, citar: null, mensagem: null, apagar: [] }, // T10; T10c: chamadoId e completo
      recebidas: {},
      audios: {},
      midiaPendente: [],
      idsDoDono: [], // T7e2: idsDoDono
      saude: {
        leituraOkEm: null,
        leituraFalhaDesde: null,
        envioOkEm: null,
        envioFalhaDesde: null,
        envioUltimaFalhaEm: null,
        quebrado: false,
        causaLeitura: null,
        causaEnvio: null,
        avisoEm: null,
        voltouPendente: null,
      },
    });
    assert.notEqual(tgNovo().saida, tgNovo().saida); // cada chamada = objeto novo
    for (const bruto of [undefined, null, 'lixo', 7, [1, 2], {}]) assert.deepEqual(completarTg(bruto), vazio);
    const errado = completarTg({
      offset: 'x',
      vistos: {},
      seq: -3,
      chamados: [],
      mensagens: 'x',
      saida: {},
      sistema: 5,
      recebidas: [],
      audios: null,
      midiaPendente: 'x',
      saude: [],
      sobra: 1,
    });
    assert.deepEqual(errado, vazio);
    const bom = completarTg({
      offset: 812,
      vistos: [811],
      seq: 9,
      chamados: { 'aba-1': { versao: { id: 4, estado: 'aviso' }, descer: false, mensagem: null, apagar: [], mudouEm: iso(T0) } },
      saida: [{ sessionId: 'aba-1', entrouEm: iso(T0), falhas: 0 }],
      saude: { envioOkEm: iso(T0), quebrado: 'sim', causaEnvio: 42 },
      sistema: { linhas: [{ hora: iso(T0), texto: 'oi' }], descer: true, versaoId: 'x', mensagem: 'x' },
    });
    assert.equal(bom.offset, 812);
    assert.deepEqual(bom.vistos, [811]);
    assert.equal(bom.seq, 9);
    assert.equal(bom.chamados['aba-1'].versao.id, 4);
    assert.equal(bom.saida.length, 1);
    assert.deepEqual(bom.saude, { ...vazio.saude, envioOkEm: iso(T0) });
    assert.deepEqual(bom.sistema, { ...vazio.sistema, linhas: [{ hora: iso(T0), texto: 'oi' }], descer: true });
    // seq ilegivel com versao no estado: nunca abaixo do maior id ja usado (id novo nao colide com a tela)
    const semSeq = completarTg({ seq: 'x', chamados: { 'aba-1': { versao: { id: 4, estado: 'aviso' }, mensagem: { messageId: 9, formato: 'rich', versaoId: 4 } } } });
    assert.equal(semSeq.seq, 4);
  });

  test('entrada de programacao invalida = TypeError; o resto nunca lanca', async () => {
    assert.throws(() => criarCanalTelegram({}), TypeError);
    assert.throws(() => criarCanalTelegram({ ensaio: true }), TypeError);
    const { canal, e } = novo();
    assert.throws(() => canal.aviso({}, parou('aba-1'), 'Aba'), TypeError);
    assert.throws(() => canal.aviso(e, { at: iso(T0) }, 'Aba'), TypeError);
    assert.throws(() => canal.aviso(e, parou('sistema'), 'Aba'), TypeError);
    assert.throws(() => canal.falaRecebida(e, {}), TypeError);
    assert.throws(() => canal.encerrar(e, 'aba-1', iso(T0), 'outro'), TypeError);
    assert.throws(() => canal.sistema(e, 42), TypeError);
    await assert.rejects(canal.drenar({}), TypeError);
    await assert.rejects(canal.drenar(e, { aoMudar: 'salvar' }), TypeError); // aoMudar que nao e funcao (sab t7e2 39)
    // estado estranho no disco nao derruba: chamado ilegivel sai da fila
    e.tg.chamados['aba-9'] = { versao: { id: 1, estado: 'aviso', chamadoId: 'x' }, descer: true, mensagem: null, apagar: [] };
    e.tg.saida.push({ sessionId: 'aba-9', entrouEm: iso(T0), falhas: 0 }, null, { sessionId: 'aba-sem-chamado', entrouEm: 'x', falhas: 0 });
    await canal.drenar(e);
    assert.deepEqual(e.tg.saida, []);
    assert.deepEqual(canal.lerToque(e, 'o:ABCDEFGH:0', 1), { obsoleto: true });
    assert.equal(canal.sessaoDaMensagem(e, 1), null);
  });

  test('nenhum log leva o texto do dono, a fala, o final, a frase, o titulo nem html', async () => {
    let proxima;
    const { canal, e, relogio, logs } = novo({
      roteiro: {
        enviar: () => {
          const r = proxima;
          proxima = undefined;
          return r;
        },
        editar: [{ ok: false, erro: 'editMessageText: Bad Request: message is too old', codigo: 400 }],
        apagar: [{ ok: false, velha: true }, { ok: false, erro: 'deleteMessage: Bad Request: chat not found', codigo: 400 }],
      },
    });
    const final = 'Contexto FINAL-SECRETO.\n\n🔴 **DECISÃO:** Sigo com FINAL-SECRETO? A) Sim / B) Não';
    canal.normalizarUpdate({ update_id: 1, message: { message_id: 5, date: 1790000000, chat: { id: 7, type: 'private' }, from: { id: 7 }, text: 'TEXTO-SECRETO' } });
    canal.normalizarUpdate({ update_id: 2, callback_query: { id: 'q', from: { id: 7 }, message: { message_id: 1, chat: { id: 7 } }, data: 'TEXTO-SECRETO' } });
    canal.aviso(e, parou('aba-1', final), 'TITULO-SECRETO');
    proxima = { ok: false, erro: 'sendRichMessage: fetch failed', codigo: 0 };
    await canal.drenar(e); // transporte
    proxima = { ok: false, erro: 'sendRichMessage: Too Many Requests: retry after 1', codigo: 429, esperarS: 1 };
    await canal.drenar(e); // 429
    relogio.t += 2000;
    await canal.drenar(e); // sai
    canal.falaRecebida(e, { sessionId: 'aba-1', fala: 'FALA-SECRETA', hora: iso(relogio.t), messageIdDono: 90 });
    await canal.drenar(e); // velha -> movido (400) e apagar 90 com 400
    canal.entregue(e, 'aba-1', iso(relogio.t));
    await canal.drenar(e);
    canal.problema(e, 'aba-1', 'FRASE-SECRETA');
    proxima = { ok: false, erro: "sendMessage: Bad Request: can't parse entities", codigo: 400 };
    await canal.drenar(e); // recusado
    canal.sistema(e, 'SISTEMA-SECRETO', { notificar: true });
    canal.aviso(e, parou('aba-2', final), 'TITULO-SECRETO');
    await canal.drenar(e, { travado: true });
    canal.aviso(e, parou('aba-3', final), 'TITULO-SECRETO');
    await canal.drenar(e, { modoRua: false });
    canal.aviso(e, parou('aba-4', final), 'TITULO-SECRETO');
    canal.encerrar(e, 'aba-4', iso(relogio.t), 'pc');
    canal.aviso(e, parou('aba-5', final), 'TITULO-SECRETO');
    relogio.t += 3 * H;
    await canal.drenar(e); // perdida
    const tudo = logs.join('\n');
    for (const s of ['TEXTO-SECRETO', 'FALA-SECRETA', 'FINAL-SECRETO', 'FRASE-SECRETA', 'SISTEMA-SECRETO', 'TITULO-SECRETO']) {
      assert.ok(!tudo.includes(s), `log com ${s}:\n${tudo}`);
    }
    assert.ok(!tudo.includes('<'), tudo);
    for (const l of logs) assert.ok(!l.includes('\n'), l);
    for (const re of [/ignorado/, /falhou/, /429/, /recusad/, /travado/, /dono no PC/, /perdida/, /movido/]) assert.ok(re.test(tudo), `${re}:\n${tudo}`);
  });
});

// ---------- 9. T3b (item 4): mensagem de chamado podado que ficou no chat ----------

describe('9. T3b: chamado novo apaga as mensagens da aba que ficaram no chat', () => {
  test('aviso -> drenar -> podar com 24 h -> aviso novo da mesma aba -> drenar = enviar do novo e depois apagar da velha', async () => {
    const { canal, tg, e, relogio, logs } = novo();
    canal.aviso(e, parou('aba-1'), 'Aba');
    await canal.drenar(e); // 501 na tela
    relogio.t = T0 + DIA;
    canal.podar(e, relogio.t);
    assert.deepEqual(e.tg.chamados, {}, 'o chamado saiu');
    assert.deepEqual(Object.keys(e.tg.mensagens), ['501'], 'a mensagem dele ficou no chat');
    canal.aviso(e, parou('aba-1', FINAL, iso(relogio.t)), 'Aba');
    assert.deepEqual(e.tg.chamados['aba-1'].apagar, [{ messageId: 501, doBot: true, formato: 'rich' }]);
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false], ['enviar', false], ['apagar', 501]], 'a nova sai antes; a velha sai depois');
    assert.deepEqual(Object.keys(e.tg.mensagens), ['502']);
    assert.deepEqual(e.tg.chamados['aba-1'].apagar, []);
    assert.deepEqual(e.tg.saida, []);
    assert.ok(logs.some((l) => /aba-1: chamado novo; 1 mensagem\(ns\) antiga\(s\) da aba no chat vao pro apagar/.test(l)), logs.join('\n'));
    // o 2o evento da mesma aba (chamado ja existe) nao herda nada
    canal.falaRecebida(e, { sessionId: 'aba-1', fala: 'vai', hora: iso(relogio.t), messageIdDono: 80 });
    assert.deepEqual(e.tg.chamados['aba-1'].apagar, []); // T7d1a (F1): a do dono (80) nunca entra no apagar
  });

  // T7d1a (F1): a do dono (90) fica no chat; o chamado sai em cima dela. T7f (F8): a fala nao poe nada na tela; as
  // mensagens que ficaram no chat saem depois da mensagem nova do chamado (o resultado)
  test('so as da aba e sem movido, no formato de cada uma (a do dono fica); com 48 h vira "movido"; as de outra aba e a do sistema ficam', async () => {
    const { canal, tg, e } = novo({ roteiro: { apagar: [{ ok: false, velha: true }] } });
    const at = iso(T0 - 3 * DIA);
    e.tg.mensagens = {
      400: { sessionId: 'aba-1', at, formato: 'classico' },
      401: { sessionId: 'aba-1', at, formato: 'rich', movido: true },
      402: { sessionId: 'aba-2', at, formato: 'rich' },
      403: { sessionId: 'sistema', at, formato: 'rich' },
      404: 'lixo',
    };
    canal.falaRecebida(e, { sessionId: 'aba-1', titulo: 'Aba', fala: 'publica', hora: iso(T0), messageIdDono: 90 });
    assert.deepEqual(e.tg.chamados['aba-1'].apagar, [{ messageId: 400, doBot: true, formato: 'classico' }]);
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [], 'T7f (F8): a fala nao poe nada na tela; o apagar espera a mensagem nova');
    canal.resposta(e, parou('aba-1', 'Publiquei.'), 'Aba', { citar: 90 });
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false], ['apagar', 400], ['editar', 400]]); // T7d1a (F1): sem apagar(90)
    assert.equal(tg.chamadas[0].args[0].responderA, 90);
    const movido = montarChamado({ estado: 'movido', titulo: 'Aba' });
    assert.deepEqual(tg.chamadas[2].args, [400, { ...movido, botoes: null, formato: 'classico' }], 'movido no formato dela');
    assert.equal(e.tg.mensagens[400].movido, true);
    assert.deepEqual(Object.keys(e.tg.mensagens).sort(), ['400', '401', '402', '403', '404', '501']);
    // a aba-2 ganha chamado novo: so a dela vai pro apagar (a movida da aba-1 e a do sistema nunca)
    canal.aviso(e, parou('aba-2'), 'Outra');
    assert.deepEqual(e.tg.chamados['aba-2'].apagar, [{ messageId: 402, doBot: true, formato: 'rich' }]);
  });
});

// ---------- 10. T7d1a (F1): nenhuma mensagem do dono e apagada; a do bot que responde sai em cima dela ----------
// PLANO-T7.md, "T7d1a: F1 no canal". Pedido do dono: "mantem meu audio e a resposta tem que vir em resposta ao
// meu audio" (o principal estendeu pra toda mensagem dele, decisao F1).

describe('10. T7d1a: F1 no canal', () => {
  // T7f (F8): enviando e entregue so no estado (com o citar); a tela so perde os botoes
  test('1. texto: aviso na tela (501) + fala 77 -> apagar sem o 77 e citar 77 no estado; drenar = so os botoes do 501 saem (T7f); entregue herda o citar e nao edita; resposta sem citar nao herda', async () => {
    const { canal, tg, e } = novo();
    canal.aviso(e, parou('aba-1'), 'Aba');
    await canal.drenar(e); // 501 na tela
    const vAviso = e.tg.chamados['aba-1'].versao.id;
    const fala = 'faz só as correções';
    canal.falaRecebida(e, { sessionId: 'aba-1', fala, audio: false, hora: iso(T0 + MIN), messageIdDono: 77 });
    const c = e.tg.chamados['aba-1'];
    assert.deepEqual(c.apagar, [], 'nada do dono no apagar');
    assert.equal(c.versao.citar, 77);
    await canal.drenar(e);
    assert.deepEqual(passos(tg).slice(1), [['editarBotoes', 501]]); // T7f (F8): nenhuma mensagem nova
    assert.deepEqual(tg.chamadas[1].args, [501, null]);
    assert.deepEqual(c.mensagem, { messageId: 501, formato: 'rich', versaoId: vAviso });
    assert.deepEqual(c.apagar, []);

    canal.entregue(e, 'aba-1', iso(T0 + 2 * MIN));
    assert.equal(c.versao.citar, 77, 'entregue herda o citar');
    await canal.drenar(e);
    assert.equal(tg.chamadas.length, 2, 'T7f (F8): o entregue nao edita');

    canal.resposta(e, parou('aba-1', 'Pronto, feito.'), 'Aba');
    assert.equal(c.versao.citar, null, 'resposta sem citar nao herda');
    await canal.drenar(e);
    assert.deepEqual(passos(tg).slice(2), [['enviar', false], ['apagar', 501]]);
    assert.ok(!('responderA' in tg.chamadas[2].args[0]));
    assert.ok(!tg.chamadas.some((x) => x.metodo === 'apagar' && x.args[0] === 77), 'a mensagem dele nunca e apagada');
  });

  // T7f (F8): o toque so tira os botoes; o problema herda o citar da fala (toque = null) e sai sem a chave responderA
  test('2. toque (opcao e Mais contexto, sem messageIdDono) -> citar null; so os botoes saem (T7f); o problema que herda sai sem a chave responderA', async () => {
    const { canal, tg, e } = novo();
    canal.aviso(e, parou('aba-1'), 'Aba');
    canal.aviso(e, parou('aba-2'), 'Outra');
    await canal.drenar(e); // 501 (aba-1) e 502 (aba-2)
    canal.falaRecebida(e, { sessionId: 'aba-1', fala: 'A) Sim, tudo hoje (recomendado)', hora: iso(T0 + MIN) });
    canal.falaRecebida(e, { sessionId: 'aba-2', contexto: true, hora: iso(T0 + MIN) });
    assert.equal(e.tg.chamados['aba-1'].versao.citar, null);
    assert.equal(e.tg.chamados['aba-2'].versao.citar, null);
    await canal.drenar(e);
    assert.deepEqual(passos(tg).slice(2), [['editarBotoes', 501], ['editarBotoes', 502]]);
    canal.problema(e, 'aba-1', 'A aba fechou antes de receber.');
    canal.problema(e, 'aba-2', 'A aba fechou antes de receber.');
    assert.equal(e.tg.chamados['aba-1'].versao.citar, null);
    assert.equal(e.tg.chamados['aba-2'].versao.citar, null);
    await canal.drenar(e);
    assert.deepEqual(passos(tg).slice(4), [['enviar', false], ['apagar', 501], ['enviar', false], ['apagar', 502]]);
    for (const i of [4, 6]) assert.ok(!('responderA' in tg.chamadas[i].args[0]), JSON.stringify(Object.keys(tg.chamadas[i].args[0])));
  });

  test('3. audio 60: enviando so no estado com o citar 60 (T7f); resposta {citar: 60} em cima do 60; aviso novo 3 h depois SEM responderA; problema {citar: 61} em cima do 61; problema sem citar herda', async () => {
    const { canal, tg, e, relogio } = novo();
    canal.falaRecebida(e, { sessionId: 'aba-1', titulo: 'Aba', fala: 'roda os testes', audio: true, hora: iso(T0), messageIdDono: 60 });
    await canal.drenar(e); // T7f (F8): nada na tela
    assert.deepEqual(passos(tg), []);
    assert.equal(e.tg.chamados['aba-1'].versao.citar, 60);
    canal.entregue(e, 'aba-1', iso(T0 + MIN));
    await canal.drenar(e); // T7f (F8): nada
    assert.deepEqual(passos(tg), []);

    relogio.t = T0 + 5 * MIN;
    canal.resposta(e, parou('aba-1', 'Rodei: 12 verdes.', iso(relogio.t)), 'Aba', { citar: 60 });
    assert.equal(e.tg.chamados['aba-1'].versao.citar, 60);
    await canal.drenar(e); // 501 em cima do 60
    assert.deepEqual(passos(tg), [['enviar', false]]);
    assert.equal(tg.chamadas[0].args[0].responderA, 60);

    relogio.t = T0 + 3 * H;
    canal.aviso(e, parou('aba-1', FINAL, iso(relogio.t)), 'Aba');
    assert.equal(e.tg.chamados['aba-1'].versao.citar, null);
    await canal.drenar(e); // 502; apagar 501
    assert.deepEqual(passos(tg).slice(1), [['enviar', false], ['apagar', 501]]);
    assert.ok(!('responderA' in tg.chamadas[1].args[0]), 'o aviso novo nao sai em cima do audio velho');

    canal.problema(e, 'aba-1', 'A aba fechou antes de receber.', { citar: 61 });
    await canal.drenar(e); // 503 em cima do 61; apagar 502
    assert.deepEqual(passos(tg).slice(3), [['enviar', false], ['apagar', 502]]);
    assert.equal(tg.chamadas[3].args[0].responderA, 61);
    canal.problema(e, 'aba-1', 'De novo.');
    assert.equal(e.tg.chamados['aba-1'].versao.citar, 61, 'problema sem citar herda');
    await canal.drenar(e); // 504 em cima do 61; apagar 503
    assert.deepEqual(passos(tg).slice(5), [['enviar', false], ['apagar', 503]]);
    assert.equal(tg.chamadas[5].args[0].responderA, 61);
    assert.ok(!tg.chamadas.some((x) => x.metodo === 'apagar' && (x.args[0] === 60 || x.args[0] === 61)), 'a do dono nunca e apagada');
  });

  test('4. sistema {citar: 90}: nova silenciosa em cima do 90, nenhum apagar(90), s.citar null depois; linha sem citar = editar; notificar + citar = notificacao em cima; citar que nao saiu fica (e sobrevive ao disco); apagarDoDono = TypeError', async () => {
    const { canal, tg, e } = novo();
    canal.sistema(e, 'Status: 2 abas.');
    await canal.drenar(e); // 501
    canal.sistema(e, 'Modo rua ligado.', { citar: 90 });
    assert.deepEqual([e.tg.sistema.citar, e.tg.sistema.descer, e.tg.sistema.notificar], [90, true, false]);
    assert.deepEqual(e.tg.sistema.apagar, []);
    await canal.drenar(e); // 502 em cima do 90; apagar 501
    assert.deepEqual(passos(tg), [['enviar', true], ['enviar', true], ['apagar', 501]]);
    assert.deepEqual(tg.chamadas[1].args[0], { ...montarSistema(e.tg.sistema.linhas), botoes: null, silencioso: true, responderA: 90 });
    assert.equal(e.tg.sistema.citar, null, 'o aoSair zera o citar');
    assert.equal(e.tg.sistema.descer, false);

    canal.sistema(e, 'x');
    await canal.drenar(e); // editar 502
    assert.deepEqual(passos(tg).slice(3), [['editar', 502]]);
    assert.ok(!('responderA' in tg.chamadas[3].args[1]));

    canal.sistema(e, 'Não consegui abrir a central no PC.', { notificar: true, citar: 91 });
    await canal.drenar(e); // 503 com notificacao em cima do 91; apagar 502
    assert.deepEqual(passos(tg).slice(4), [['enviar', false], ['apagar', 502]]);
    assert.equal(tg.chamadas[4].args[0].responderA, 91);
    assert.deepEqual([e.tg.sistema.citar, e.tg.sistema.notificar, e.tg.sistema.descer], [null, false, false]);

    // linha nova sem citar antes do drenar nao apaga o citar que ainda nao saiu (nem no disco)
    canal.sistema(e, 'Modo rua desligado.', { citar: 92 });
    canal.sistema(e, 'O WhatsApp caiu.');
    assert.equal(e.tg.sistema.citar, 92);
    e.tg = completarTg(JSON.parse(JSON.stringify(e.tg)));
    assert.equal(e.tg.sistema.citar, 92, 'completarTg guarda o citar do sistema');
    await canal.drenar(e); // 504 em cima do 92; apagar 503
    assert.deepEqual(passos(tg).slice(6), [['enviar', true], ['apagar', 503]]);
    assert.equal(tg.chamadas[6].args[0].responderA, 92);
    assert.ok(!tg.chamadas.some((x) => x.metodo === 'apagar' && [90, 91, 92].includes(x.args[0])), 'a do dono nunca e apagada');
    assert.equal(completarTg({ sistema: { citar: 'lixo' } }).sistema.citar, null);

    // apagarDoDono saiu: TypeError antes de mexer no estado
    const antes = structuredClone(e.tg);
    assert.throws(() => canal.sistema(e, 'y', { apagarDoDono: [90] }), TypeError);
    assert.throws(() => canal.sistema(e, 'y', { apagarDoDono: [] }), TypeError);
    assert.throws(() => canal.sistema(e, 'y', { notificar: true, apagarDoDono: [90] }), TypeError);
    assert.deepEqual(e.tg, antes);
  });

  test('5. estado de antes (a do dono no apagar da aba e do sistema, citarAntigo 60 do 3d85713): o drenar nunca apaga 80 nem 90 (log F1) e o proximo aviso sai sem responderA', async () => {
    const { canal, tg, e, logs } = novo();
    canal.aviso(e, parou('aba-1'), 'Aba');
    canal.sistema(e, 'Status: 2 abas.');
    await canal.drenar(e); // 501 (aba-1) e 502 (sistema)
    // o estado.json como o 3d85713 gravava: a mensagem do dono no apagar e o citarAntigo do audio no chamado
    const disco = JSON.parse(JSON.stringify(e.tg));
    disco.chamados['aba-1'].apagar.push({ messageId: 80, doBot: false, formato: null });
    disco.chamados['aba-1'].citarAntigo = 60;
    disco.sistema.apagar.push({ messageId: 90, doBot: false, formato: null });
    disco.saida.push({ sessionId: 'aba-1', entrouEm: iso(T0), falhas: 0 }, { sessionId: 'sistema', entrouEm: iso(T0), falhas: 0 });
    e.tg = completarTg(disco);
    tg.chamadas.length = 0;
    await canal.drenar(e);
    assert.deepEqual(tg.chamadas, [], 'nenhuma chamada: nem apagar(80) nem apagar(90)');
    assert.deepEqual(e.tg.chamados['aba-1'].apagar, []);
    assert.deepEqual(e.tg.sistema.apagar, []);
    assert.deepEqual(e.tg.saida, []);
    assert.ok(logs.includes('telegram aba-1: mensagem 80 do dono fica no chat (F1); sai da lista sem apagar'), logs.join('\n'));
    assert.ok(logs.includes('telegram sistema: mensagem 90 do dono fica no chat (F1); sai da lista sem apagar'), logs.join('\n'));

    canal.aviso(e, parou('aba-1', 'Outra pergunta?'), 'Aba');
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false], ['apagar', 501]]);
    assert.ok(!('responderA' in tg.chamadas[0].args[0]), 'a chave velha citarAntigo e ignorada');
  });

  // T7f (F8): a tela da velha (o chamado que ele respondeu) perde os botoes e fica ate o resultado da nova descer
  test('6. herdar de aba que fechou com a fala do dono no apagar da velha: a tela da velha perde os botoes (T7f); com o resultado, a mensagem do bot da velha e apagada; a do dono, nunca', async () => {
    const { canal, tg, e, logs } = novo();
    canal.aviso(e, parou('aba-velha'), 'Financeiro');
    await canal.drenar(e); // 501 na tela da velha
    e.tg.chamados['aba-velha'].apagar.push({ messageId: 70, doBot: false, formato: null }); // estado de antes
    canal.falaRecebida(e, { sessionId: 'aba-nova', titulo: 'Financeiro', fala: 'sim', hora: iso(T0 + MIN), messageIdDono: 77, herdarDe: 'aba-velha' });
    assert.equal(e.tg.chamados['aba-velha'], undefined);
    const c = e.tg.chamados['aba-nova'];
    assert.deepEqual(c.apagar, [{ messageId: 501, doBot: true, formato: 'rich' }, { messageId: 70, doBot: false, formato: null }]);
    assert.equal(c.versao.citar, 77);
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false], ['editarBotoes', 501]]); // T7f (F8): nenhuma mensagem nova
    assert.equal(c.apagar.length, 2, 'T7f: o apagar espera a mensagem nova do chamado');
    canal.resposta(e, parou('aba-nova', 'Feito.'), 'Financeiro', { citar: 77 });
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false], ['editarBotoes', 501], ['enviar', false], ['apagar', 501]]);
    assert.equal(tg.chamadas[2].args[0].responderA, 77);
    assert.deepEqual(c.apagar, []);
    assert.ok(!tg.chamadas.some((x) => x.metodo === 'apagar' && (x.args[0] === 70 || x.args[0] === 77)), 'nada do dono apagado');
    assert.ok(logs.includes('telegram aba-nova: mensagem 70 do dono fica no chat (F1); sai da lista sem apagar'), logs.join('\n'));
  });

  // T7f (F8): a fala nao registra nada; o enviar com citar do chamado e o do resultado (resposta {citar: 70})
  test('7. ensaio: enviar com citar registra responderA; sem citar o registro e o de hoje (sem a chave); a fala (T7f) nao registra nada', async () => {
    const { canal, tg, e, ensaios } = novo({ ensaio: true });
    canal.falaRecebida(e, { sessionId: 'aba-1', titulo: 'Aba', fala: 'vai', hora: iso(T0), messageIdDono: 70 }); // versao 1
    await canal.drenar(e); // T7f (F8): nada
    assert.deepEqual(ensaios, []);
    canal.resposta(e, parou('aba-1', 'Feito.'), 'Aba', { citar: 70 }); // versao 2
    await canal.drenar(e); // enviar -> -3
    canal.sistema(e, 'Status: 2 abas.'); // versao 4
    await canal.drenar(e); // enviar -> -5
    canal.sistema(e, 'Modo rua ligado.', { citar: 71 }); // versao 6
    await canal.drenar(e); // enviar -> -7; apagar -5
    assert.equal(tg.chamadas.length, 0);
    assert.deepEqual(ensaios.map((x) => x.acao), ['tg.enviar', 'tg.enviar', 'tg.enviar', 'tg.apagar']);
    const resposta = montarChamado(e.tg.chamados['aba-1'].versao);
    assert.deepEqual(ensaios[0], { acao: 'tg.enviar', sessionId: 'aba-1', estado: 'resposta', silencioso: false, ...resposta, responderA: 70 });
    const linha1 = [{ hora: iso(T0), texto: 'Status: 2 abas.' }];
    assert.deepEqual(ensaios[1], { acao: 'tg.enviar', sessionId: 'sistema', estado: 'sistema', silencioso: true, ...montarSistema(linha1), botoes: null });
    assert.deepEqual(ensaios[2], {
      acao: 'tg.enviar', sessionId: 'sistema', estado: 'sistema', silencioso: true, ...montarSistema(e.tg.sistema.linhas), botoes: null, responderA: 71,
    });
    assert.deepEqual(ensaios[3], { acao: 'tg.apagar', messageId: -5 });
  });
});

// ---------- 11. T7c2: Mais informações no canal (PLANO-T7.md, "T7c2") ----------

describe('11. T7c2: Mais informações no canal', () => {
  test('T7c2 45. aviso na tela (501) -> abrir = true; drenar = so editar 501 (sem enviar e sem notificacao), mesmo chamadoId; o:<ID>:0 continua valendo; abrir de novo = false e 0 chamadas; resposta igual', async () => {
    const { canal, tg, e, logs, relogio } = novo();
    canal.aviso(e, { ...parou('aba-1'), nome: 'Financeiro' }, 'Aba');
    await canal.drenar(e); // 501, chamado ABCDEFGH
    const c = e.tg.chamados['aba-1'];
    const antes = structuredClone(c.versao);
    assert.equal(antes.completo, false);
    relogio.t = T0 + 3 * MIN;
    assert.equal(canal.abrir(e, 'aba-1'), true);
    const v = c.versao;
    assert.ok(v.id > antes.id, 'versao nova (++seq)');
    assert.equal(v.id, e.tg.seq);
    assert.deepEqual({ ...v, id: antes.id }, { ...antes, completo: true }, 'os mesmos campos (chamadoId, opcoes, final, citar, titulo, hora, nome) + completo');
    assert.equal(v.chamadoId, 'ABCDEFGH');
    assert.equal(c.descer, false, 'edicao: o abrir nao liga o descer');
    assert.equal(c.mudouEm, iso(T0 + 3 * MIN));
    assert.deepEqual(e.tg.saida.map((i) => i.sessionId), ['aba-1']);
    assert.ok(logs.includes('telegram aba-1 aviso: aberto (texto completo)'), logs.join('\n'));

    tg.chamadas.length = 0;
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['editar', 501]], 'sem enviar, sem apagar');
    const aberto = montarChamado({ ...antes, completo: true });
    assert.notEqual(aberto.html, montarChamado(antes).html, 'o aberto e o texto completo, nao o compacto');
    assert.deepEqual(tg.chamadas[0].args[1], { ...aberto, formato: 'rich' });
    assert.ok(!('silencioso' in tg.chamadas[0].args[1]), 'edicao nao notifica');
    assert.deepEqual(aberto.botoes.flat().map((b) => b.dados), ['o:ABCDEFGH:0', 'o:ABCDEFGH:1'], 'so os botoes das opcoes');
    assert.deepEqual(c.mensagem, { messageId: 501, formato: 'rich', versaoId: v.id });
    assert.deepEqual(e.tg.saida, []);
    assert.deepEqual(canal.lerToque(e, 'o:ABCDEFGH:0', 501), { sessionId: 'aba-1', acao: 'opcao', opcao: OPCOES[0] });

    const depois = structuredClone(e.tg);
    assert.equal(canal.abrir(e, 'aba-1'), false, 'ja aberto');
    assert.deepEqual(e.tg, depois, 'nada muda');
    tg.chamadas.length = 0;
    await canal.drenar(e);
    assert.equal(tg.chamadas.length, 0);

    // resposta (em cima da fala 77 do dono): abre igual, o citar fica na versao e a edicao sai sem responderA
    canal.resposta(e, parou('aba-2', FINAL, iso(T0 + 3 * MIN)), 'Outra', { citar: 77 });
    await canal.drenar(e); // 502
    const c2 = e.tg.chamados['aba-2'];
    const antes2 = structuredClone(c2.versao);
    tg.chamadas.length = 0;
    assert.equal(canal.abrir(e, 'aba-2'), true);
    assert.deepEqual({ ...c2.versao, id: antes2.id }, { ...antes2, completo: true });
    assert.equal(c2.versao.citar, 77);
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['editar', 502]]);
    assert.deepEqual(tg.chamadas[0].args[1], { ...montarChamado({ ...antes2, completo: true }), formato: 'rich' });
    assert.ok(logs.includes('telegram aba-2 resposta: aberto (texto completo)'), logs.join('\n'));
  });

  test('T7c2 46. dono no PC (modoRua false): a edicao do aberto sai; aviso NOVO (sem tela, ou com outra mensagem da aba na tela) continua saindo da fila sem enviar', async () => {
    const { canal, tg, e, logs } = novo();
    canal.aviso(e, parou('aba-1'), 'Aba');
    canal.aviso(e, parou('aba-3'), 'Terceira');
    await canal.drenar(e); // 501 (aba-1) e 502 (aba-3), em modo rua
    tg.chamadas.length = 0;
    assert.equal(canal.abrir(e, 'aba-1'), true);
    canal.aviso(e, parou('aba-2'), 'Outra'); // aviso novo, aba sem mensagem na tela
    canal.aviso(e, parou('aba-3', 'Outra coisa.\n\n🔴 **DECISÃO:** Sigo? A) Sim / B) Não'), 'Terceira'); // aviso novo, a 502 na tela
    await canal.drenar(e, { modoRua: false });
    assert.deepEqual(passos(tg), [['editar', 501]]);
    const c1 = e.tg.chamados['aba-1'];
    assert.deepEqual(c1.mensagem, { messageId: 501, formato: 'rich', versaoId: c1.versao.id });
    assert.equal(e.tg.chamados['aba-2'].mensagem, null);
    assert.equal(e.tg.chamados['aba-3'].mensagem.messageId, 502);
    assert.deepEqual(e.tg.saida, []);
    for (const sid of ['aba-2', 'aba-3']) assert.ok(logs.includes(`telegram ${sid} aviso saiu da fila sem enviar (dono no PC)`), logs.join('\n'));
    assert.ok(!logs.some((l) => l.startsWith('telegram aba-1 aviso saiu da fila')), logs.join('\n'));
  });

  test('T7c2 47. abrir em enviando, entregue, encerrado, problema, contexto (estado de antes), sem chamado, sem final ou ja completo = false e nada muda', async () => {
    const { canal, tg, e } = novo();
    canal.falaRecebida(e, { sessionId: 'a-env', titulo: 'Env', fala: 'vai', hora: iso(T0) });
    canal.aviso(e, parou('a-ent'), 'Ent');
    canal.falaRecebida(e, { sessionId: 'a-ent', fala: 'A) Sim', hora: iso(T0) });
    canal.entregue(e, 'a-ent', iso(T0));
    canal.aviso(e, parou('a-enc'), 'Enc');
    await canal.drenar(e);
    canal.encerrar(e, 'a-enc', iso(T0), 'pc');
    canal.problema(e, 'a-pro', 'Não achei a sessão.', { titulo: 'Pro', fala: 'vai' });
    canal.aviso(e, parou('a-ctx'), 'Ctx');
    canal.falaRecebida(e, { sessionId: 'a-ctx', fala: 'x', hora: iso(T0) });
    canal.aviso(e, parou('a-vazio', ''), 'Vazio');
    canal.resposta(e, parou('a-comp'), 'Comp', { completo: true });
    await canal.drenar(e);
    const ctx = e.tg.chamados['a-ctx'].versao; // gravado pelo porteiro de antes
    ctx.estado = 'contexto';
    ctx.fala = 'Mais contexto';
    const estados = Object.fromEntries(Object.entries(e.tg.chamados).map(([s, c]) => [s, [c.versao.estado, c.versao.completo]]));
    assert.deepEqual(estados, {
      'a-env': ['enviando', false], 'a-ent': ['entregue', false], 'a-enc': ['encerrado', false], 'a-pro': ['problema', false],
      'a-ctx': ['contexto', false], 'a-vazio': ['aviso', false], 'a-comp': ['resposta', true],
    });
    const antes = structuredClone(e.tg);
    tg.chamadas.length = 0;
    for (const sid of [...Object.keys(estados), 'aba-sem-chamado']) assert.equal(canal.abrir(e, sid), false, sid);
    assert.deepEqual(e.tg, antes, 'nada muda');
    await canal.drenar(e);
    assert.equal(tg.chamadas.length, 0);
  });

  test('T7c2 48. lerToque: i:<ID> e o legado c:<ID> = informacoes; de outro chamado ou de outra mensagem = obsoleto; depois do abrir o i: continua valendo', async () => {
    const { canal, e } = novo();
    canal.aviso(e, parou('aba-1'), 'Aba');
    canal.aviso(e, parou('aba-2'), 'Outra');
    await canal.drenar(e); // 501 ABCDEFGH (aba-1) e 502 JKMNPQRS (aba-2)
    assert.deepEqual(canal.lerToque(e, 'i:ABCDEFGH', 501), { sessionId: 'aba-1', acao: 'informacoes' });
    assert.deepEqual(canal.lerToque(e, 'c:ABCDEFGH', '501'), { sessionId: 'aba-1', acao: 'informacoes' });
    assert.deepEqual(canal.lerToque(e, 'i:JKMNPQRS', 502), { sessionId: 'aba-2', acao: 'informacoes' });
    assert.deepEqual(canal.lerToque(e, 'c:JKMNPQRS', 502), { sessionId: 'aba-2', acao: 'informacoes' });
    assert.deepEqual(canal.lerToque(e, 'i:JKMNPQRS', 501), { obsoleto: true }); // botao de outro chamado
    assert.deepEqual(canal.lerToque(e, 'i:ABCDEFGH', 999), { obsoleto: true }); // outra mensagem
    assert.deepEqual(canal.lerToque(e, 'c:ABCDEFGH', 502), { obsoleto: true });
    assert.deepEqual(canal.lerToque(e, 'i:TUVWXYZ2', 501), { obsoleto: true }); // chamado que nao existe
    assert.equal(canal.abrir(e, 'aba-1'), true);
    assert.deepEqual(canal.lerToque(e, 'i:ABCDEFGH', 501), { sessionId: 'aba-1', acao: 'informacoes' }, 'aberto: mesmo chamado');
    canal.aviso(e, parou('aba-1'), 'Aba'); // chamado novo da aba-1: o botao da 501 e de um chamado velho
    assert.deepEqual(canal.lerToque(e, 'i:ABCDEFGH', 501), { obsoleto: true });
    assert.deepEqual(canal.lerToque(e, 'c:ABCDEFGH', 501), { obsoleto: true });
  });
});

// ---------- 12. T7e2: envio incerto e salvar no meio do drenar ----------

describe('12. T7e2: envio incerto e salvar no meio do drenar', () => {
  // Duble com a sonda (editarBotoes). roteiro[metodo] = lista (cada chamada consome 1 item; item funcao = chamada com
  // os args; undefined = padrao) ou funcao (args) -> resposta | undefined. Padrao: enviar ok com 500 + n, o resto ok.
  // semEditarBotoes = adaptador sem o metodo.
  function dubleSonda(roteiro = {}, { semEditarBotoes = false } = {}) {
    const chamadas = [];
    const filas = {};
    for (const m of ['enviar', 'editar', 'apagar', 'editarBotoes']) filas[m] = Array.isArray(roteiro[m]) ? [...roteiro[m]] : roteiro[m];
    let enviadas = 0;
    function responder(metodo, args, padrao) {
      chamadas.push({ metodo, args });
      const f = filas[metodo];
      let r;
      if (typeof f === 'function') r = f(...args);
      else if (Array.isArray(f) && f.length) r = f.shift();
      if (typeof r === 'function') r = r(...args);
      return r === undefined ? padrao : r;
    }
    const tg = {
      chamadas,
      async enviar(pedido) {
        enviadas += 1;
        return responder('enviar', [pedido], { ok: true, messageId: 500 + enviadas, formato: 'rich' });
      },
      async editar(messageId, pedido) { return responder('editar', [messageId, pedido], { ok: true }); },
      async apagar(messageId) { return responder('apagar', [messageId], { ok: true }); },
    };
    if (!semEditarBotoes) tg.editarBotoes = async (messageId, botoes) => responder('editarBotoes', [messageId, botoes], { ok: true });
    return tg;
  }

  function montarSonda({ roteiro, sondar, semEditarBotoes, ensaio = false, tg: tgDado } = {}) {
    const relogio = { t: T0 };
    const logs = [];
    const ensaios = [];
    const tg = tgDado ?? dubleSonda(roteiro, { semEditarBotoes });
    const opcoes = { tg, log: (m) => logs.push(m), agora: () => relogio.t, ensaio, registrarEnsaio: (x) => ensaios.push(x), rand: randFixo() };
    if (sondar !== undefined) opcoes.sondar = sondar;
    return { canal: criarCanalTelegram(opcoes), tg, e: { tg: tgNovo() }, logs, ensaios, relogio };
  }

  const INCERTO = { ok: false, erro: 'enviar: The operation was aborted due to timeout', codigo: 0, incerto: true };
  const enviou = (messageId) => ({ ok: true, messageId, formato: 'rich' });
  // enviar -> ['enviar', '-']; o resto -> [metodo, messageId]
  const metodos = (tg) => tg.chamadas.map((c) => [c.metodo, c.metodo === 'enviar' ? '-' : c.args[0]]);

  // fetch falso por metodo da API (nenhuma rede): cada metodo consome a sua lista (corpo JSON ou Error pra lancar);
  // vazia = {ok: true, result: true}.
  const TOKEN_FALSO = '424242:SEGREDO-falso-de-teste';
  function fetchPorMetodo(roteiro = {}) {
    const chamadas = [];
    const filas = Object.fromEntries(Object.entries(roteiro).map(([k, v]) => [k, [...v]]));
    async function fetch(url, opts = {}) {
      const u = String(url);
      const metodo = u.slice(u.lastIndexOf('/') + 1);
      chamadas.push({ metodo, corpo: opts.body ? JSON.parse(opts.body) : {} });
      const fila = filas[metodo];
      const passo = fila && fila.length ? fila.shift() : { ok: true, result: true };
      if (passo instanceof Error) throw passo;
      return new Response(JSON.stringify(passo), { status: 200 });
    }
    fetch.chamadas = chamadas;
    return fetch;
  }
  const saiu = (id) => ({ ok: true, result: { message_id: id } });
  const tempoEsgotado = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  const naApi = (fetch, desde = 0) => fetch.chamadas.slice(desde).map((c) => [c.metodo, c.corpo.message_id ?? null]);

  // 501 na tela da aba-1; a versao nova desce e o envio dela (2a chamada de sendRichMessage) fica incerto
  async function incertoNaAba(sondar) {
    const { criarTelegram } = await import('../telegram.mjs');
    const fetch = fetchPorMetodo({ sendRichMessage: [saiu(501), tempoEsgotado(), saiu(504)] });
    const tg = criarTelegram({ token: TOKEN_FALSO, chatId: DONO, fetch, dormir: async () => {}, intervaloMs: 0 });
    const m = montarSonda({ tg, sondar });
    m.canal.aviso(m.e, parou('aba-1'), 'Aba');
    await m.canal.drenar(m.e);
    m.canal.aviso(m.e, parou('aba-1'), 'Aba');
    const r = await m.canal.drenar(m.e);
    assert.equal(r.chamadas, 1);
    const item = m.e.tg.saida[0];
    assert.equal(item.sessionId, 'aba-1');
    assert.deepEqual(item.incerto, { desde: 501 }, 'desde = maior id conhecido');
    assert.equal(item.envio, undefined, 'a marca sai depois da resposta');
    assert.equal(m.e.tg.chamados['aba-1'].mensagem.messageId, 501, 'a tela continua a 501');
    assert.ok(m.logs.includes(
      'telegram aba-1 aviso: envio incerto (sendRichMessage: The operation was aborted due to timeout): pode ter chegado; confere antes de apagar (ids depois de 501)',
    ), m.logs.join('\n'));
    const antes = fetch.chamadas.length;
    m.relogio.t += 29 * 1000;
    assert.equal((await m.canal.drenar(m.e)).chamadas, 0, 'recuo de 30 s: nada sai');
    assert.equal(fetch.chamadas.length, antes);
    m.canal.mensagemDoDono(m.e, 502); // o dono escreveu no meio (desde+1)
    m.relogio.t += 1000;
    await m.canal.drenar(m.e);
    return { ...m, fetch, antes };
  }

  test('T7e2 55. enviar incerto (TimeoutError no adaptador de verdade, fetch falso): desde = maior id conhecido, nada antes de 30 s; reenvio ok com desde+3 e desde+1 do dono = 1 sonda so (desde+2), sonda ok = apagar; o do dono nunca', async () => {
    const { fetch, antes, logs, e } = await incertoNaAba(true);
    assert.deepEqual(naApi(fetch, antes), [
      ['sendRichMessage', null],
      ['editMessageReplyMarkup', 503], // a sonda: so o id desconhecido
      ['deleteMessage', 503], // provado do bot: apagado
      ['deleteMessage', 501], // a tela antiga
    ]);
    assert.deepEqual(fetch.chamadas.find((c) => c.metodo === 'editMessageReplyMarkup').corpo.reply_markup, { inline_keyboard: [] });
    assert.ok(!fetch.chamadas.some((c) => c.corpo.message_id === 502), 'a mensagem do dono nunca e sondada nem apagada');
    assert.deepEqual(e.tg.saida, []);
    assert.ok(logs.includes('telegram aba-1 aviso: mensagem 504 enviada depois de envio incerto; 1 id(s) desconhecido(s) entre 501 e 504 vao pra sonda'), logs.join('\n'));
    assert.ok(logs.includes('telegram aba-1: id 503 e do bot (sonda): vai pro apagar'));
  });

  test('T7e2 55 (padrao). sonda desligada por padrao: o mesmo incerto e o mesmo recuo; o reenvio ok so loga os ids desconhecidos (nenhuma sonda, nada a mais no apagar)', async () => {
    const { fetch, antes, logs, e } = await incertoNaAba(undefined);
    assert.deepEqual(naApi(fetch, antes), [['sendRichMessage', null], ['deleteMessage', 501]]);
    assert.ok(!fetch.chamadas.some((c) => c.metodo === 'editMessageReplyMarkup'), 'nenhuma sonda');
    assert.deepEqual(e.tg.saida, []);
    assert.ok(logs.includes('telegram aba-1 aviso: mensagem 504 enviada depois de envio incerto; 1 id(s) desconhecido(s) entre 501 e 504 ficam no chat (sonda desligada): 503'), logs.join('\n'));
  });

  test('T7e2 55 (recuo). incertos seguidos: 30 s, 1, 2 e 4 min (teto), com o desde mais antigo; a 1a chamada ok zera o recuo', async () => {
    const { canal, e, relogio, tg, logs } = montarSonda({
      roteiro: { enviar: [enviou(501), INCERTO, INCERTO, INCERTO, INCERTO, INCERTO, enviou(520), INCERTO, enviou(530)] },
    });
    const nEnviar = () => tg.chamadas.filter((c) => c.metodo === 'enviar').length;
    canal.aviso(e, parou('aba-1'), 'Aba');
    await canal.drenar(e); // 501
    canal.aviso(e, parou('aba-1'), 'Aba');
    await canal.drenar(e); // incerto 1: recuo de 30 s
    assert.equal(nEnviar(), 2);
    canal.mensagemDoDono(e, 510); // o maior id conhecido sobe, o desde do incerto nao
    for (const [espera, n] of [[30, 3], [60, 4], [120, 5], [240, 6], [240, 7]]) {
      relogio.t += espera * 1000 - 1;
      await canal.drenar(e);
      assert.equal(nEnviar(), n - 1, `antes de ${espera} s nada sai`);
      relogio.t += 1;
      await canal.drenar(e);
      assert.equal(nEnviar(), n, `com ${espera} s sai`);
      if (n < 7) assert.deepEqual(e.tg.saida[0].incerto, { desde: 501 }, 'o desde mais antigo');
    }
    assert.equal(e.tg.chamados['aba-1'].mensagem.messageId, 520);
    assert.ok(logs.includes('telegram aba-1 aviso: mensagem 520 enviada depois de envio incerto; 17 id(s) desconhecido(s) entre 501 e 520 ficam no chat (sonda desligada): 502, 503, 504, 505, 506, 507, 508, 509, 511, 512, 513, 514, 515, 516, 517, 518, 519'), logs.join('\n'));
    canal.aviso(e, parou('aba-1'), 'Aba');
    await canal.drenar(e); // incerto de novo, depois de ok: o recuo voltou pros 30 s
    assert.equal(nEnviar(), 8);
    assert.deepEqual(e.tg.saida[0].incerto, { desde: 520 });
    relogio.t += 30 * 1000;
    await canal.drenar(e);
    assert.equal(nEnviar(), 9);
    assert.equal(e.tg.chamados['aba-1'].mensagem.messageId, 530);
  });

  test('T7e2 56. sonda: 400 = sai sem apagar; transporte = fica; sem editarBotoes = sai; {sondar} nunca vai direto pro apagar; desde 0 ou 21 desconhecidos = nenhuma sonda (20 = os 20); ensaio registra tg.sondar', async () => {
    // a tela 501 na aba-1 e 1 id a sondar no comeco do apagar (como o reenvio deixa, ou como volta do disco)
    async function comSonda(opcoes = {}) {
      const m = montarSonda({ sondar: true, ...opcoes });
      m.canal.aviso(m.e, parou('aba-1'), 'Aba');
      await m.canal.drenar(m.e);
      m.e.tg.chamados['aba-1'].apagar.push({ messageId: 600, sondar: true });
      m.e.tg.saida.push({ sessionId: 'aba-1', entrouEm: iso(T0), falhas: 0 });
      m.tg.chamadas.length = 0;
      m.ensaios.length = 0;
      return m;
    }
    const recusa = await comSonda({ roteiro: { editarBotoes: [{ ok: false, erro: "editarBotoes: Bad Request: message can't be edited", codigo: 400 }] } });
    await recusa.canal.drenar(recusa.e);
    assert.deepEqual(metodos(recusa.tg), [['editarBotoes', 600]]);
    assert.deepEqual(recusa.tg.chamadas[0].args, [600, null]);
    assert.deepEqual(recusa.e.tg.chamados['aba-1'].apagar, []);
    assert.deepEqual(recusa.e.tg.saida, []);
    assert.ok(recusa.logs.includes("telegram aba-1: id 600 nao e do bot ou sumiu (sonda: editarBotoes: Bad Request: message can't be edited); fica no chat"), recusa.logs.join('\n'));

    const caiu = await comSonda({ roteiro: { editarBotoes: [{ ok: false, erro: 'editarBotoes: socket hang up', codigo: 0 }] } });
    await caiu.canal.drenar(caiu.e);
    assert.deepEqual(metodos(caiu.tg), [['editarBotoes', 600]]);
    assert.deepEqual(caiu.e.tg.chamados['aba-1'].apagar, [{ messageId: 600, sondar: true }], 'fica pra proxima');
    assert.equal(caiu.e.tg.saida.length, 1);

    const antigo = await comSonda({ semEditarBotoes: true });
    await antigo.canal.drenar(antigo.e);
    assert.deepEqual(metodos(antigo.tg), [], 'nenhuma chamada: nem sonda nem apagar');
    assert.deepEqual(antigo.e.tg.chamados['aba-1'].apagar, []);

    // F1: o {sondar: true} so e apagado depois da prova (editarBotoes ok ou "not modified"), nunca direto
    const prova = await comSonda();
    await prova.canal.drenar(prova.e);
    assert.deepEqual(metodos(prova.tg), [['editarBotoes', 600], ['apagar', 600]]);
    const igual = await comSonda({ roteiro: { editarBotoes: [{ ok: false, erro: 'editarBotoes: Bad Request: message is not modified', codigo: 400 }] } });
    await igual.canal.drenar(igual.e);
    assert.deepEqual(metodos(igual.tg), [['editarBotoes', 600], ['apagar', 600]]);
    for (const sondar of [false, undefined]) { // desligada (ou padrao): o {sondar} que volta do disco sai sem chamada nenhuma
      const desligada = await comSonda({ sondar });
      await desligada.canal.drenar(desligada.e);
      assert.deepEqual(metodos(desligada.tg), [], `sondar ${sondar}: nunca apaga sem prova`);
      assert.deepEqual(desligada.e.tg.chamados['aba-1'].apagar, []);
    }

    const ens = await comSonda({ ensaio: true });
    await ens.canal.drenar(ens.e);
    assert.deepEqual(ens.ensaios.map((x) => [x.acao, x.messageId]), [['tg.sondar', 600], ['tg.apagar', 600]]);

    // desde 0 (nada conhecido antes do envio incerto): nao sonda, so loga
    const zero = montarSonda({ sondar: true, roteiro: { enviar: [INCERTO, enviou(3)] } });
    zero.canal.aviso(zero.e, parou('aba-1'), 'Aba');
    await zero.canal.drenar(zero.e);
    assert.deepEqual(zero.e.tg.saida[0].incerto, { desde: 0 });
    zero.relogio.t += 30 * 1000;
    await zero.canal.drenar(zero.e);
    assert.deepEqual(metodos(zero.tg), [['enviar', '-'], ['enviar', '-']], 'nenhuma sonda');
    assert.ok(zero.logs.includes('telegram aba-1 aviso: 2 ids desconhecidos entre 0 e 3: nao sondo nenhum (mais de 20 ou sem base)'), zero.logs.join('\n'));

    // 21 desconhecidos = nenhuma sonda; 20 = sonda os 20, em ordem
    for (const [n, sondas] of [[523, 0], [522, 20]]) {
      const m = montarSonda({ sondar: true, roteiro: { enviar: [enviou(501), INCERTO, enviou(n)] } });
      m.canal.aviso(m.e, parou('aba-1'), 'Aba');
      await m.canal.drenar(m.e);
      m.canal.aviso(m.e, parou('aba-1'), 'Aba');
      await m.canal.drenar(m.e);
      m.relogio.t += 30 * 1000;
      await m.canal.drenar(m.e);
      const sondados = m.tg.chamadas.filter((c) => c.metodo === 'editarBotoes').map((c) => c.args[0]);
      assert.deepEqual(sondados, Array.from({ length: sondas }, (_, i) => 502 + i), `N = ${n}`);
      if (!sondas) assert.ok(m.logs.includes(`telegram aba-1 aviso: 21 ids desconhecidos entre 501 e ${n}: nao sondo nenhum (mais de 20 ou sem base)`), m.logs.join('\n'));
      assert.deepEqual(m.e.tg.saida, []);
    }
  });

  test('T7e2 57. drenar com aoMudar: depois da marca envio e de cada chamada ok, ja com o estado mudado; aoMudar que lanca nao para o drenar', async () => {
    const fotos = [];
    const noEnvio = [];
    const m = montarSonda({ roteiro: { enviar: () => { noEnvio.push(fotos.at(-1)); } } });
    const aoMudar = () => { fotos.push(structuredClone(m.e.tg)); };
    m.canal.aviso(m.e, parou('aba-1'), 'Aba');
    await m.canal.drenar(m.e, { aoMudar });
    assert.equal(fotos.length, 2, 'a marca + o enviar ok');
    assert.deepEqual(noEnvio[0].saida[0].envio, { desde: 0 }, 'a marca ja estava salva quando o pedido saiu');
    assert.equal(noEnvio[0].chamados['aba-1'].mensagem, null);
    assert.equal(fotos[1].chamados['aba-1'].mensagem.messageId, 501, 'depois do ok: a mensagem nova ja esta no estado');
    assert.ok(fotos[1].mensagens['501']);
    assert.equal(fotos[1].saida[0].envio, undefined);

    m.canal.aviso(m.e, parou('aba-1'), 'Aba');
    await m.canal.drenar(m.e, { aoMudar });
    assert.equal(fotos.length, 5, 'a marca + o enviar ok + o apagar ok');
    assert.deepEqual(fotos[2].saida[0].envio, { desde: 501 });
    assert.equal(fotos[3].chamados['aba-1'].mensagem.messageId, 502);
    assert.deepEqual(fotos[3].chamados['aba-1'].apagar, [{ messageId: 501, doBot: true, formato: 'rich' }]);
    assert.deepEqual(fotos[4].chamados['aba-1'].apagar, []);
    assert.equal(fotos[4].mensagens['501'], undefined);

    const q = montarSonda();
    q.canal.aviso(q.e, parou('aba-1'), 'Aba');
    q.canal.aviso(q.e, parou('aba-2'), 'Outra');
    let n = 0;
    const r = await q.canal.drenar(q.e, { aoMudar: () => { n += 1; throw new RangeError('disco cheio'); } });
    assert.equal(r.pendentes, 0);
    assert.deepEqual(metodos(q.tg), [['enviar', '-'], ['enviar', '-']]);
    assert.equal(n, 4);
    assert.equal(q.logs.filter((l) => l === 'telegram aoMudar falhou (RangeError)').length, 4);
  });

  test('T7e2 58. item com a marca envio no disco (o porteiro morreu no meio do envio) = incerto: o proximo envio ok faz a sonda do intervalo', async () => {
    let disco = null;
    let noPedido = null;
    const a = montarSonda({ sondar: true, roteiro: { enviar: [undefined, () => { noPedido = disco; return { ok: false, erro: 'enviar: morreu', codigo: 0 }; }] } });
    const aoMudar = () => { disco = JSON.stringify(a.e.tg); };
    a.canal.aviso(a.e, parou('aba-1'), 'Aba');
    await a.canal.drenar(a.e, { aoMudar }); // 501
    a.canal.aviso(a.e, parou('aba-1'), 'Aba');
    await a.canal.drenar(a.e, { aoMudar }); // o porteiro "morre" neste pedido: vale o disco da hora
    const gravado = JSON.parse(noPedido);
    assert.deepEqual(gravado.saida[0].envio, { desde: 501 });

    const b = montarSonda({ sondar: true, roteiro: { enviar: [enviou(504)] } });
    const e2 = { tg: completarTg(gravado) };
    await b.canal.drenar(e2);
    assert.deepEqual(metodos(b.tg), [
      ['enviar', '-'], ['editarBotoes', 502], ['apagar', 502], ['editarBotoes', 503], ['apagar', 503], ['apagar', 501],
    ]);
    assert.deepEqual(e2.tg.saida, []);
    assert.equal(e2.tg.chamados['aba-1'].mensagem.messageId, 504);
    assert.ok(b.logs.includes('telegram aba-1 aviso: envio incerto (o porteiro parou no meio do envio): pode ter chegado; confere antes de apagar (ids depois de 501)'), b.logs.join('\n'));
    assert.ok(b.logs.includes('telegram aba-1 aviso: mensagem 504 enviada depois de envio incerto; 2 id(s) desconhecido(s) entre 501 e 504 vao pra sonda'));
  });

  test('T7e2 60. tgNovo com idsDoDono: []; mensagemDoDono guarda 300 sem repetir; completarTg com idsDoDono torto = []', () => {
    assert.deepEqual(tgNovo().idsDoDono, []);
    const { canal, e } = montarSonda();
    for (let id = 1; id <= 305; id += 1) canal.mensagemDoDono(e, id);
    canal.mensagemDoDono(e, 305);
    canal.mensagemDoDono(e, 200);
    for (const ruim of [0, -3, 'x', null, undefined, 1.5]) canal.mensagemDoDono(e, ruim);
    assert.equal(e.tg.idsDoDono.length, 300);
    assert.equal(e.tg.idsDoDono[0], 6);
    assert.equal(e.tg.idsDoDono.at(-1), 305);
    assert.equal(new Set(e.tg.idsDoDono).size, 300, 'sem repetir');
    for (const torto of ['x', 7, { a: 1 }, null, [0, -1, 'y', null, 2.5]]) {
      assert.deepEqual(completarTg({ idsDoDono: torto }).idsDoDono, [], JSON.stringify(torto));
    }
    assert.deepEqual(completarTg({ idsDoDono: [10, 'z', 11, 10, 12] }).idsDoDono, [10, 11, 12]);
    assert.equal(completarTg({ idsDoDono: Array.from({ length: 350 }, (_, i) => i + 1) }).idsDoDono.length, 300);
  });
});

// ---------- 13. T7j: o toque conclui e a mensagem some (PLANO-T7.md, "T7j"; pedido do dono) ----------
// O toque numa opcao (falaRecebida com toque: true) poe a tela do chamado (com botoes) no `apagarJa`: o drenar apaga ela
// antes de tudo e a resposta da aba desce como mensagem nova. Sem toque (texto, audio) = T7f: a tela so perde os botoes.

describe('13. T7j: o toque conclui e a mensagem some', () => {
  const FALA_A = 'A) Sim, tudo hoje (recomendado)';

  test('T7j 1. canal: toque em opcao com o aviso 501 na tela (com botoes) -> drenar [apagar 501], nenhum editarBotoes; c.mensagem null; a resposta depois = mensagem nova, sem editar nem apagar o 501 de novo; o apagar que o chamado ja tinha (400) so sai depois da nova', async () => {
    const { canal, tg, e, logs } = novo();
    canal.aviso(e, parou('aba-1'), 'Aba');
    await canal.drenar(e); // 501 na tela, com os botoes da DECISAO
    const c = e.tg.chamados['aba-1'];
    c.apagar.push({ messageId: 400, doBot: true, formato: 'rich' }); // o que o chamado ja tinha no apagar
    tg.chamadas.length = 0;
    canal.falaRecebida(e, { sessionId: 'aba-1', titulo: 'Aba', fala: FALA_A, hora: iso(T0 + MIN), toque: true });
    assert.deepEqual(c.apagarJa, [501], 'a tela tocada vai pro apagarJa');
    assert.equal(c.mensagem, null, 'a resposta desce como mensagem nova (nunca edicao da apagada)');
    assert.equal(c.tirarBotoes, undefined, 'fora do tirarBotoes');
    assert.deepEqual(c.apagar, [{ messageId: 400, doBot: true, formato: 'rich' }]);
    assert.equal(c.versao.estado, 'enviando');
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['apagar', 501]], 'so o apagar da tela tocada (nenhum editarBotoes)');
    assert.equal(c.apagarJa, undefined, 'a lista vazia some do chamado');
    assert.equal(e.tg.mensagens['501'], undefined);
    assert.deepEqual(c.apagar, [{ messageId: 400, doBot: true, formato: 'rich' }], 'o 400 espera a mensagem nova');
    assert.deepEqual(e.tg.saida, []);
    assert.ok(logs.includes('telegram aba-1: mensagem 501 apagada (o dono tocou numa opcao)'), logs.join('\n'));

    canal.entregue(e, 'aba-1', iso(T0 + 2 * MIN));
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['apagar', 501]], 'o entregue nao mexe na tela');

    canal.resposta(e, parou('aba-1', 'Feito.'), 'Aba');
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['apagar', 501], ['enviar', false], ['apagar', 400]], 'a nova sai, depois o 400; o 501 nunca de novo');
    assert.deepEqual(c.mensagem, { messageId: 502, formato: 'rich', versaoId: c.versao.id });
    assert.deepEqual(c.apagar, []);
    assert.deepEqual(e.tg.saida, []);
  });

  test('T7j 2. canal (regressao): fala por texto (77) e por audio (78), sem toque (e com toque que nao e o booleano true) -> tirarBotoes como hoje; a tela fica ate a resposta e sai no apagar depois da nova; no mesmo drenar, so o toque de verdade apaga a tela da aba dele', async () => {
    const { canal, tg, e } = novo();
    for (const sid of ['aba-1', 'aba-2', 'aba-3', 'aba-4']) canal.aviso(e, parou(sid), sid);
    await canal.drenar(e); // 501 a 504, cada uma com botoes
    tg.chamadas.length = 0;
    const hora = iso(T0 + MIN);
    canal.falaRecebida(e, { sessionId: 'aba-1', fala: 'faz só as correções', hora, messageIdDono: 77 });
    canal.falaRecebida(e, { sessionId: 'aba-2', fala: 'pode seguir', audio: true, hora, messageIdDono: 78 });
    canal.falaRecebida(e, { sessionId: 'aba-3', fala: FALA_A, hora, toque: 'true' }); // so o booleano true e toque
    canal.falaRecebida(e, { sessionId: 'aba-4', fala: FALA_A, hora, toque: true });
    for (const [sid, id] of [['aba-1', 501], ['aba-2', 502], ['aba-3', 503]]) {
      const c = e.tg.chamados[sid];
      assert.deepEqual(c.tirarBotoes, [id], `${sid}: tirarBotoes, como hoje`);
      assert.equal(c.apagarJa, undefined, sid);
      assert.equal(c.mensagem.messageId, id, `${sid}: a tela fica`);
    }
    assert.deepEqual(e.tg.chamados['aba-4'].apagarJa, [504], 'aba-4: o toque');
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['editarBotoes', 501], ['editarBotoes', 502], ['editarBotoes', 503], ['apagar', 504]]);
    for (const [sid, id] of [['aba-1', 501], ['aba-2', 502], ['aba-3', 503]]) {
      assert.equal(e.tg.chamados[sid].mensagem.messageId, id, `${sid}: a tela fica, sem os botoes`);
    }

    tg.chamadas.length = 0;
    canal.resposta(e, parou('aba-1', 'Feito.'), 'aba-1', { citar: 77 });
    canal.resposta(e, parou('aba-2', 'Feito.'), 'aba-2', { citar: 78 });
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false], ['apagar', 501], ['enviar', false], ['apagar', 502]], 'a tela sai no apagar depois da nova');
    assert.ok(!tg.chamadas.some((x) => x.metodo === 'apagar' && [77, 78].includes(x.args[0])), 'a mensagem dele fica (F1)');
  });

  test('T7j 3. canal: apagar do toque recusado: velha -> no passo seguinte editarBotoes(501, null) e a lista some; 400 sem pausa -> igual; transporte -> nenhum editarBotoes, o 501 fica no apagarJa e sai no drenar seguinte; 429 -> pausa', async () => {
    async function tocado(resposta) {
      const m = novo({ roteiro: { apagar: [resposta] } });
      m.canal.aviso(m.e, parou('aba-1'), 'Aba');
      await m.canal.drenar(m.e); // 501
      m.tg.chamadas.length = 0;
      m.canal.falaRecebida(m.e, { sessionId: 'aba-1', fala: FALA_A, hora: iso(T0), toque: true });
      m.r = await m.canal.drenar(m.e);
      return { ...m, c: m.e.tg.chamados['aba-1'] };
    }
    for (const [rotulo, resposta] of [
      ['velha', { ok: false, velha: true }],
      ['400', { ok: false, erro: "apagar: Bad Request: message can't be deleted for everyone", codigo: 400 }],
    ]) {
      const { tg, c, e, logs } = await tocado(resposta);
      assert.deepEqual(passos(tg), [['apagar', 501], ['editarBotoes', 501]], rotulo);
      assert.deepEqual(tg.chamadas[1].args, [501, null], `${rotulo}: so os botoes saem (o caminho de hoje)`);
      assert.equal(c.apagarJa, undefined, `${rotulo}: a lista some`);
      assert.equal(c.tirarBotoes, undefined, rotulo);
      assert.deepEqual(e.tg.saida, [], rotulo);
      const linhas = logs.filter((l) => /^telegram aba-1: apagar 501 recusado \(.+\); fica sem os botoes$/.test(l));
      assert.equal(linhas.length, 1, `${rotulo}: 1 linha de log\n${logs.join('\n')}`);
    }

    // transporte: nenhum editarBotoes; o 501 fica no apagarJa (falhas 1) e sai no drenar seguinte
    const caiu = await tocado({ ok: false, erro: 'apagar: fetch failed' });
    assert.deepEqual(passos(caiu.tg), [['apagar', 501]]);
    assert.deepEqual(caiu.c.apagarJa, [501], 'transporte: fica');
    assert.deepEqual(caiu.e.tg.saida.map((i) => [i.sessionId, i.falhas]), [['aba-1', 1]]);
    await caiu.canal.drenar(caiu.e);
    assert.deepEqual(passos(caiu.tg), [['apagar', 501], ['apagar', 501]]);
    assert.equal(caiu.c.apagarJa, undefined);
    assert.deepEqual(caiu.e.tg.saida, []);
    assert.ok(!caiu.tg.chamadas.some((x) => x.metodo === 'editarBotoes'), 'transporte: nenhum editarBotoes');

    // 429: pausa (falhas nao conta, nada antes do esperarS); depois sai
    const lim = await tocado({ ok: false, erro: 'apagar: Too Many Requests: retry after 3', codigo: 429, esperarS: 3 });
    assert.deepEqual(passos(lim.tg), [['apagar', 501]]);
    assert.equal(lim.r.pausaAte, iso(T0 + 3000));
    assert.deepEqual(lim.c.apagarJa, [501], '429: fica');
    assert.deepEqual(lim.e.tg.saida.map((i) => [i.sessionId, i.falhas]), [['aba-1', 0]]);
    lim.relogio.t = T0 + 2000;
    await lim.canal.drenar(lim.e);
    assert.deepEqual(passos(lim.tg), [['apagar', 501]], 'dentro da pausa: nada');
    lim.relogio.t = T0 + 3000;
    await lim.canal.drenar(lim.e);
    assert.deepEqual(passos(lim.tg), [['apagar', 501], ['apagar', 501]]);
    assert.equal(lim.c.apagarJa, undefined);
    assert.ok(!lim.tg.chamadas.some((x) => x.metodo === 'editarBotoes'), '429: nenhum editarBotoes');
  });

  test('T7j 4. canal: toque herdado (a aba da tela 601, com botoes e apagar [590], fechou; a fala vai pra aberta com o mesmo nome) -> apagar(601) no 1o drenar; o 590 so sai depois da 1a mensagem nova da aberta', async () => {
    const { canal, tg, e, logs } = novo({ roteiro: { enviar: [{ ok: true, messageId: 601, formato: 'rich' }] } });
    canal.aviso(e, parou('aba-velha'), 'Financeiro');
    await canal.drenar(e); // 601 na tela da velha
    e.tg.chamados['aba-velha'].apagar.push({ messageId: 590, doBot: true, formato: 'rich' });
    tg.chamadas.length = 0;
    canal.falaRecebida(e, { sessionId: 'aba-nova', titulo: 'Financeiro', fala: FALA_A, hora: iso(T0 + MIN), herdarDe: 'aba-velha', toque: true });
    assert.equal(e.tg.chamados['aba-velha'], undefined);
    const c = e.tg.chamados['aba-nova'];
    assert.deepEqual(c.apagarJa, [601], 'a tela da velha (com botoes) vai pro apagarJa');
    assert.deepEqual(c.apagar, [{ messageId: 590, doBot: true, formato: 'rich' }], 'fora das sobras; o resto do apagar da velha espera a mensagem nova');
    assert.equal(c.tirarBotoes, undefined, 'fora do tirarBotoes');
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['apagar', 601]]);
    assert.equal(c.apagarJa, undefined);
    assert.deepEqual(c.apagar, [{ messageId: 590, doBot: true, formato: 'rich' }], 'o 590 espera');
    assert.ok(logs.includes('telegram aba-nova: mensagem 601 apagada (o dono tocou numa opcao)'), logs.join('\n'));
    canal.resposta(e, parou('aba-nova', 'Feito.'), 'Financeiro');
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['apagar', 601], ['enviar', false], ['apagar', 590]]);
    assert.deepEqual(c.apagar, []);
  });

  test('T7j 5. canal: apagarJa salvo e relido (JSON + completarTg) antes do drenar -> apagar(501); apagarJa com id de pedido de OK (idsDeFora) -> sai sem chamar a API (1 log); id invalido sai calado', async () => {
    const { canal, tg, e, logs } = novo();
    canal.aviso(e, parou('aba-1'), 'Aba');
    await canal.drenar(e); // 501
    tg.chamadas.length = 0;
    canal.falaRecebida(e, { sessionId: 'aba-1', fala: FALA_A, hora: iso(T0 + MIN), toque: true });
    e.tg = completarTg(JSON.parse(JSON.stringify(e.tg))); // o porteiro gravou e releu o estado.json
    assert.deepEqual(e.tg.chamados['aba-1'].apagarJa, [501], 'o apagarJa sobrevive ao disco');
    assert.equal(e.tg.chamados['aba-1'].mensagem, null);
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['apagar', 501]]);
    assert.equal(e.tg.chamados['aba-1'].apagarJa, undefined);
    assert.deepEqual(e.tg.saida, []);

    // estado torto: id de pedido de OK (de fora do canal) e id invalido no apagarJa
    canal.aviso(e, parou('aba-2'), 'Outra');
    await canal.drenar(e); // 502
    canal.falaRecebida(e, { sessionId: 'aba-2', fala: FALA_A, hora: iso(T0 + 2 * MIN), toque: true });
    const c2 = e.tg.chamados['aba-2'];
    assert.deepEqual(c2.apagarJa, [502]);
    c2.apagarJa.unshift('lixo', 9001);
    tg.chamadas.length = 0;
    logs.length = 0;
    await canal.drenar(e, { idsDeFora: [9001] });
    assert.deepEqual(passos(tg), [['apagar', 502]], 'o 9001 (do OK) e o invalido sem nenhuma chamada');
    assert.equal(c2.apagarJa, undefined);
    assert.deepEqual(logs.filter((l) => l.includes('9001')), ['telegram aba-2: mensagem 9001 e de um pedido de OK; sai do apagarJa sem apagar']);
    assert.ok(!logs.some((l) => l.includes('lixo')), logs.join('\n'));
  });
});

// ---------- 14. T7k: nada some antes da resposta ----------

describe('14. T7k: nada some antes da resposta', () => {
  const TELA = 877;
  // A central com a resposta 877 na tela; a fala dele (70) foi pra ela (enviando, nada na tela) e ela so repassou.
  // `enviar` = o roteiro do enviar depois do 877 (a 1a mensagem nova seguinte, sem roteiro, e a 502).
  async function centralNaTela(enviar = []) {
    const m = novo({ roteiro: { enviar: [{ ok: true, messageId: TELA, formato: 'rich' }, ...enviar] } });
    m.canal.resposta(m.e, parou('central', 'Pedi pro porteiro passar o seu pedido.'), 'Central');
    await m.canal.drenar(m.e); // 877 na tela
    m.canal.falaRecebida(m.e, { sessionId: 'central', fala: 'esse audio era pra outra sessao', hora: iso(T0 + MIN), messageIdDono: 70 });
    await m.canal.drenar(m.e); // enviando: nada na tela
    assert.equal(m.e.tg.chamados.central.mensagem.messageId, TELA);
    m.tg.chamadas.length = 0;
    m.logs.length = 0;
    return m;
  }
  const naFila = (e, sid) => e.tg.saida.push({ sessionId: sid, entrouEm: iso(T0), falhas: 0 });

  test('T7k 1. canal: central com a tela 877 -> calar(e, sid, {esperar: [tg-u1]}) -> drenar sem nenhuma chamada; a tela e o esperando ficam, iguais depois de salvar e reler (JSON); esperando torto do disco = so texto nao vazio, sem repetir; outra coisa some', async () => {
    const { canal, tg, e, logs } = await centralNaTela();
    canal.calar(e, 'central', { esperar: ['tg-u1'] });
    const c = e.tg.chamados.central;
    assert.equal(c.versao.estado, 'calado');
    assert.deepEqual(c.esperando, ['tg-u1']);
    assert.equal(c.mensagem.messageId, TELA, 'a tela fica');
    assert.deepEqual(c.apagar, [], 'nada vai pro apagar');
    assert.deepEqual(logs, [`telegram central enviando: encerrado calado; a tela ${TELA} fica ate a resposta de 1 fala(s) repassada(s)`]);
    const antes = JSON.parse(JSON.stringify(c));
    e.tg = completarTg(JSON.parse(JSON.stringify(e.tg))); // o porteiro gravou e releu o estado.json
    await canal.drenar(e);
    assert.deepEqual(tg.chamadas, [], 'nenhuma chamada');
    assert.deepEqual(e.tg.saida, [], 'o item saiu da fila sem chamar a API');
    assert.deepEqual(e.tg.chamados.central, antes, 'a tela e o esperando ficam, iguais');
    e.tg = completarTg(JSON.parse(JSON.stringify(e.tg)));
    assert.deepEqual(e.tg.chamados.central, antes, 'iguais depois de salvar e reler de novo');

    // esperando torto relido do disco: so texto nao vazio, sem repetir
    const c2 = e.tg.chamados.central;
    c2.esperando = ['tg-u1', '', 7, 'tg-u1', null, 'tg-u2'];
    naFila(e, 'central');
    await canal.drenar(e);
    assert.deepEqual(tg.chamadas, []);
    assert.deepEqual(c2.esperando, ['tg-u1', 'tg-u2']);
    assert.equal(c2.mensagem.messageId, TELA);
    // outra coisa = some (o calado sem esperando segue como hoje)
    c2.esperando = 'lixo';
    naFila(e, 'central');
    await canal.drenar(e);
    assert.deepEqual(tg.chamadas, []);
    assert.equal(e.tg.chamados.central?.esperando, undefined);
  });

  test('T7k 2. canal: depois, a resposta da aba B com liberar [tg-u1] -> no drenar, primeiro a mensagem nova da B, depois apagar(877), e o chamado da central sai; o liberar nao vale 2 vezes; a edicao ok da versao com liberar tambem solta', async () => {
    const { canal, tg, e, logs } = await centralNaTela();
    canal.calar(e, 'central', { esperar: ['tg-u1'] });
    await canal.drenar(e);
    assert.deepEqual(tg.chamadas, []);
    canal.resposta(e, parou('aba-b', 'Publiquei o site.'), 'Faro', { citar: 70, liberar: ['tg-u1', '', 'tg-u1'] });
    assert.deepEqual(e.tg.chamados['aba-b'].versao.liberar, ['tg-u1'], 'o liberar fica na versao (texto nao vazio, sem repetir)');
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false], ['apagar', TELA]], 'a resposta da B sai e so depois a tela da central');
    assert.equal(tg.chamadas[0].args[0].responderA, 70);
    assert.equal(e.tg.chamados.central, undefined, 'o chamado da central saiu');
    assert.equal(e.tg.chamados['aba-b'].versao.liberar, undefined, 'o liberar some da versao');
    assert.deepEqual(e.tg.saida, []);
    assert.ok(logs.includes(`telegram central: a resposta de aba-b chegou; a tela ${TELA} vai pro apagar`), logs.join('\n'));

    // o liberar nao vale 2 vezes: a central na tela de novo (503) e calada esperando a mesma fala; a mesma versao da B
    // volta pra tela (mensagem nova 504) = nada solto
    canal.resposta(e, parou('central', 'Passei de novo.'), 'Central');
    await canal.drenar(e); // 503
    canal.calar(e, 'central', { esperar: ['tg-u1'] });
    e.tg.chamados['aba-b'].descer = true;
    naFila(e, 'aba-b');
    tg.chamadas.length = 0;
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false], ['apagar', 502]], 'so a B (a tela antiga dela sai); a central fica');
    assert.equal(e.tg.chamados.central.mensagem.messageId, 503);
    assert.deepEqual(e.tg.chamados.central.esperando, ['tg-u1']);

    // a edicao ok de uma versao com liberar solta igual: resposta nova da B que vai por edicao da tela 504
    canal.resposta(e, parou('aba-b', 'Publiquei de novo.'), 'Faro', { liberar: ['tg-u1'] });
    e.tg.chamados['aba-b'].descer = false;
    tg.chamadas.length = 0;
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['editar', 504], ['apagar', 503]]);
    assert.equal(e.tg.chamados.central, undefined);
    assert.equal(e.tg.chamados['aba-b'].versao.liberar, undefined);
  });

  test('T7k 3. canal: a mensagem da B falha (transporte) -> nada apagado; no drenar seguinte ela sai e so entao apagar(877)', async () => {
    const { canal, tg, e } = await centralNaTela([{ ok: false, erro: 'enviar: fetch failed' }]);
    canal.calar(e, 'central', { esperar: ['tg-u1'] });
    canal.resposta(e, parou('aba-b', 'Publiquei o site.'), 'Faro', { citar: 70, liberar: ['tg-u1'] });
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false]], 'a B falhou: nada apagado');
    assert.deepEqual(e.tg.saida.map((i) => [i.sessionId, i.falhas]), [['aba-b', 1]]);
    const c = e.tg.chamados.central;
    assert.equal(c.mensagem.messageId, TELA);
    assert.deepEqual(c.esperando, ['tg-u1']);
    assert.deepEqual(c.apagar, []);
    assert.deepEqual(e.tg.chamados['aba-b'].versao.liberar, ['tg-u1'], 'o liberar espera a mensagem sair');
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false], ['enviar', false], ['apagar', TELA]]);
    assert.equal(e.tg.chamados.central, undefined);
    assert.deepEqual(e.tg.saida, []);
  });

  test('T7k 4. canal: fala nova pra central com o calado esperando -> versao enviando, sem esperando; a 877 so sai depois da mensagem nova da central', async () => {
    const { canal, tg, e } = await centralNaTela();
    canal.calar(e, 'central', { esperar: ['tg-u1'] });
    await canal.drenar(e);
    canal.falaRecebida(e, { sessionId: 'central', fala: 'e o outro site?', hora: iso(T0 + 2 * MIN), messageIdDono: 71 });
    const c = e.tg.chamados.central;
    assert.equal(c.versao.estado, 'enviando');
    assert.equal(c.esperando, undefined);
    assert.equal(c.mensagem.messageId, TELA, 'a tela fica');
    await canal.drenar(e);
    assert.deepEqual(tg.chamadas, [], 'o enviando nao mexe na tela');
    // a resposta da B a fala antiga nao mexe mais na central
    canal.resposta(e, parou('aba-b', 'Publiquei o site.'), 'Faro', { citar: 70, liberar: ['tg-u1'] });
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false]], 'so a resposta da B');
    assert.equal(c.mensagem.messageId, TELA);
    canal.resposta(e, parou('central', 'O outro tambem.'), 'Central', { citar: 71 });
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false], ['enviar', false], ['apagar', TELA]], 'a 877 sai depois da nova da central');
    assert.deepEqual(e.tg.chamados.central.apagar, []);
  });

  test('T7k 5. canal (regressao): calar sem esperar (ou so com item invalido) = a tela vai pro apagar na hora, como hoje; sem tela = o chamado sai na hora, mesmo com esperar; 1 fala valida no meio = a tela fica', async () => {
    for (const opcoes of [undefined, {}, { esperar: [] }, { esperar: ['', 7, null] }, { esperar: 'tg-u1' }]) {
      const rotulo = JSON.stringify(opcoes) ?? 'sem opcoes';
      const { canal, tg, e, logs } = await centralNaTela();
      canal.calar(e, 'central', opcoes);
      assert.equal(e.tg.chamados.central.esperando, undefined, rotulo);
      assert.deepEqual(logs, ['telegram central enviando: encerrado calado; 1 mensagem(ns) vao pro apagar'], rotulo);
      await canal.drenar(e);
      assert.deepEqual(passos(tg), [['apagar', TELA]], rotulo);
      assert.equal(e.tg.chamados.central, undefined, rotulo);
    }
    for (const opcoes of [undefined, { esperar: ['tg-u1'] }]) {
      const rotulo = JSON.stringify(opcoes) ?? 'sem opcoes';
      const { canal, tg, e, logs } = novo();
      canal.falaRecebida(e, { sessionId: 'central', fala: 'oi', hora: iso(T0), messageIdDono: 70 });
      canal.calar(e, 'central', opcoes);
      assert.equal(e.tg.chamados.central, undefined, rotulo);
      assert.deepEqual(e.tg.saida, [], rotulo);
      assert.ok(logs.includes('telegram central enviando: encerrado calado, sem mensagem na tela'), `${rotulo}\n${logs.join('\n')}`);
      await canal.drenar(e);
      assert.deepEqual(tg.chamadas, [], rotulo);
    }
    const { canal, tg, e } = await centralNaTela();
    canal.calar(e, 'central', { esperar: ['', 'tg-u1', 7, 'tg-u1'] });
    assert.deepEqual(e.tg.chamados.central.esperando, ['tg-u1']);
    await canal.drenar(e);
    assert.deepEqual(tg.chamadas, [], '1 fala valida: a tela fica');
    assert.equal(e.tg.chamados.central.mensagem.messageId, TELA);
  });

  test('T7k 9. canal: central com a tela 877 (com botoes) e tirarBotoes [877] pendente (a fala dele chegou e o drenar ainda nao rodou) -> calar(e, sid, {esperar: [tg-u1]}) -> drenar = editarBotoes(877) e nenhum apagar; o item sai da fila; depois a resposta da B com liberar [tg-u1] -> enviar da B e apagar(877), sem outro editarBotoes', async () => {
    const { canal, tg, e } = novo({ roteiro: { enviar: [{ ok: true, messageId: TELA, formato: 'rich' }] } });
    canal.aviso(e, parou('central'), 'Central'); // o FINAL tem a DECISAO com A e B = botoes
    await canal.drenar(e); // 877 na tela, com botoes
    canal.falaRecebida(e, { sessionId: 'central', fala: 'esse audio era pra outra sessao', hora: iso(T0 + MIN), messageIdDono: 70 });
    assert.deepEqual(e.tg.chamados.central.tirarBotoes, [TELA], 'a 877 perde os botoes no proximo drenar');
    tg.chamadas.length = 0;
    canal.calar(e, 'central', { esperar: ['tg-u1'] }); // a central so repassou, antes do drenar
    const c = e.tg.chamados.central;
    assert.deepEqual([c.versao.estado, c.mensagem.messageId, c.esperando, c.tirarBotoes], ['calado', TELA, ['tg-u1'], [TELA]]);
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['editarBotoes', TELA]], 'so os botoes saem (edicao); nada apagado');
    assert.equal(tg.chamadas[0].args[1], null, 'editarBotoes sem teclado');
    assert.deepEqual(e.tg.saida, [], 'o item saiu da fila');
    assert.equal(c.tirarBotoes, undefined);
    assert.equal(c.mensagem.messageId, TELA, 'a tela fica');
    assert.deepEqual(c.esperando, ['tg-u1']);
    assert.deepEqual(c.apagar, []);

    canal.resposta(e, parou('aba-b', 'Publiquei o site.'), 'Faro', { citar: 70, liberar: ['tg-u1'] });
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['editarBotoes', TELA], ['enviar', false], ['apagar', TELA]], 'a resposta da B e so depois a 877; sem outro editarBotoes');
    assert.equal(e.tg.chamados.central, undefined, 'o chamado da central saiu');
    assert.deepEqual(e.tg.saida, []);
  });

  // Sabotagem t7k #13 (1 resposta solta o calado que ainda espera outra fala) passou sem este teste (04/10/2026).
  test('T7k 2b. canal: o calado esperando 2 falas (tg-u1 e tg-u2) -> a resposta da B com liberar [tg-u1] sai e a tela da central fica, esperando [tg-u2]; a resposta da C com liberar [tg-u2] -> enviar da C e so entao apagar(877)', async () => {
    const { canal, tg, e, logs } = await centralNaTela();
    canal.calar(e, 'central', { esperar: ['tg-u1', 'tg-u2'] });
    await canal.drenar(e);
    assert.deepEqual(tg.chamadas, []);
    canal.resposta(e, parou('aba-b', 'Publiquei o site.'), 'Faro', { citar: 70, liberar: ['tg-u1'] });
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false]], 'so a resposta da B; a tela da central fica');
    const c = e.tg.chamados.central;
    assert.equal(c.mensagem.messageId, TELA);
    assert.deepEqual(c.esperando, ['tg-u2'], 'falta a resposta da outra fala');
    assert.deepEqual(c.apagar, []);
    assert.deepEqual(e.tg.saida, []);
    assert.ok(!logs.some((l) => l.includes('vai pro apagar')), logs.join('\n'));

    canal.resposta(e, parou('aba-c', 'Mandei o e-mail.'), 'Site Novo', { liberar: ['tg-u2'] });
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false], ['enviar', false], ['apagar', TELA]], 'a resposta da C e so depois a 877');
    assert.equal(e.tg.chamados.central, undefined, 'o chamado da central saiu');
    assert.deepEqual(e.tg.saida, []);
  });
});

// ---------- A1. o chat pela configuracao (PLANO-ABERTO.md, "A1 — Telegram pela configuração", teste 6) ----------

test('A1 6. canal com chatId 42: mensagem e toque de 42 aceitos, de outro id (o chat de antes inclusive) recusados; canal sem chatId (ou invalido) recusa tudo e nao lanca', () => {
  const DATA = 1790000000;
  let n = 0;
  const msgDe = (chat, de = chat) => ({
    update_id: ++n,
    message: { message_id: 70, date: DATA, chat: { id: chat, type: 'private' }, from: { id: de, is_bot: false }, text: 'oi' },
  });
  const toqueDe = (chat, de = chat) => ({
    update_id: ++n,
    callback_query: { id: `q${n}`, from: { id: de, is_bot: false }, message: { message_id: 501, chat: { id: chat, type: 'private' } }, data: 'o:ABCDEFGH:0' },
  });
  const criar = (extra) => {
    const logs = [];
    const canal = criarCanalTelegram({ tg: dubleTg(), log: (m) => logs.push(m), agora: () => T0, rand: randFixo(), ...extra });
    return { canal, logs };
  };

  const { canal, logs } = criar({ chatId: 42 });
  const m = canal.normalizarUpdate(msgDe(42));
  assert.equal(m?.tipo, 'mensagem', 'mensagem do 42');
  assert.equal(m.texto, 'oi');
  const q = canal.normalizarUpdate(toqueDe(42));
  assert.equal(q?.tipo, 'toque', 'toque do 42');
  assert.equal(q.dados, 'o:ABCDEFGH:0');
  assert.deepEqual(logs, []);
  const recusados = [
    msgDe(DONO), msgDe(43), msgDe(42, DONO), msgDe(DONO, 42), msgDe(42, 43),
    toqueDe(DONO), toqueDe(43), toqueDe(42, DONO), toqueDe(DONO, 42),
  ];
  for (const u of recusados) assert.equal(canal.normalizarUpdate(u), null, JSON.stringify(u));
  assert.equal(logs.length, recusados.length, 'cada recusa = 1 linha de log');

  // sem chatId (ou invalido): tudo recusado, nada lanca; inclusive o update sem id de chat/remetente
  const semIds = [
    { update_id: ++n, message: { message_id: 1, date: DATA, chat: { type: 'private' }, from: { is_bot: false }, text: 'oi' } },
    { update_id: ++n, message: { message_id: 1, date: DATA, chat: { id: null, type: 'private' }, from: { id: null, is_bot: false }, text: 'oi' } },
    { update_id: ++n, callback_query: { id: 'q', from: { is_bot: false }, message: { message_id: 1, chat: { type: 'private' } }, data: 'x' } },
    { update_id: ++n, callback_query: { id: 'q', from: { id: null, is_bot: false }, message: { message_id: 1, chat: { id: null, type: 'private' } }, data: 'x' } },
  ];
  for (const extra of [{}, { chatId: undefined }, { chatId: null }, { chatId: 0 }, { chatId: -42 }, { chatId: 1.5 }, { chatId: '42' }, { chatId: [42] }]) {
    const sem = criar(extra);
    const todos = [msgDe(42), toqueDe(42), msgDe(DONO), toqueDe(DONO), msgDe('42'), toqueDe('42'), ...semIds];
    for (const u of todos) assert.equal(sem.canal.normalizarUpdate(u), null, `${JSON.stringify(extra)}: ${JSON.stringify(u)}`);
    assert.equal(sem.logs.length, todos.length, JSON.stringify(extra));
  }
});

// ---------- T9: o painel (status + pendencias) numa mensagem propria (PLANO-TELEGRAM.md, T9, contrato 2) ----------

const DADOS = {
  hora: iso(T0),
  modoRua: false,
  abertas: 2,
  esperando: [{ titulo: 'Aba', hora: iso(T0), texto: 'Publico?' }],
  trabalhando: [],
  paradas: ['Outra'],
  fechadas: [],
};

describe('T9 4. painel: mensagem propria, nova a cada pedido, em cima da do dono, a anterior sai depois', () => {
  test('1o painel = mensagem nova silenciosa em cima da do dono, fora da do sistema; registra em mensagens; o 2o desce e apaga o 1o', async () => {
    const { canal, tg, e } = novo();
    canal.sistema(e, 'Modo rua ligado.');
    await canal.drenar(e); // 501 = sistema
    canal.painel(e, DADOS, { citar: 90 });
    assert.deepEqual(e.tg.saida.map((i) => i.sessionId), ['painel']);
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', true], ['enviar', true]]);
    assert.deepEqual(tg.chamadas[1].args[0], { ...montarPainel(DADOS), botoes: null, silencioso: true, responderA: 90 });
    assert.deepEqual(e.tg.mensagens[502], { sessionId: 'painel', at: iso(T0), formato: 'rich', citar: 90 }); // T23a: o registro guarda o citar
    assert.equal(e.tg.sistema.mensagem.messageId, 501, 'a do sistema nao mexe');
    assert.deepEqual(e.tg.sistema.linhas.map((l) => l.texto), ['Modo rua ligado.']);
    assert.equal(e.tg.painel.mensagem.messageId, 502);
    assert.equal(e.tg.painel.citar, null, 'o reply ja saiu');
    // 2o pedido: mensagem nova em cima da nova fala dele, e a 502 sai depois
    canal.painel(e, { ...DADOS, abertas: 9 }, { citar: 91 });
    await canal.drenar(e);
    assert.deepEqual(passos(tg).slice(2), [['enviar', true], ['apagar', 502]]);
    assert.equal(tg.chamadas[2].args[0].responderA, 91);
    assert.ok(tg.chamadas[2].args[0].html.includes('Abas abertas: 9'));
    assert.equal(e.tg.painel.mensagem.messageId, 503);
    assert.deepEqual(Object.keys(e.tg.mensagens).sort(), ['501', '503']);
    assert.deepEqual(e.tg.saida, []);
  });

  test('envio que falha fica na fila e sai no proximo drenar; 2 pedidos antes do drenar = 1 mensagem so (a versao nova)', async () => {
    const { canal, tg, e } = novo({ roteiro: { enviar: [{ ok: false, erro: 'fetch failed' }] } });
    canal.painel(e, DADOS, { citar: 90 });
    await canal.drenar(e);
    assert.deepEqual(e.tg.saida.map((i) => i.sessionId), ['painel']);
    canal.painel(e, { ...DADOS, abertas: 7 }, { citar: 91 });
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', true], ['enviar', true]]);
    assert.ok(tg.chamadas[1].args[0].html.includes('Abas abertas: 7'));
    assert.equal(tg.chamadas[1].args[0].responderA, 91);
    assert.deepEqual(e.tg.saida, []);
  });

  test('resposta em cima do painel nao vira aba; dados copiados; dados invalidos = TypeError; "painel" nao e sessionId de aba', async () => {
    const { canal, e } = novo();
    const d = { ...DADOS, trabalhando: ['A'] };
    canal.painel(e, d, { citar: 90 });
    d.trabalhando.push('B');
    await canal.drenar(e);
    assert.equal(canal.sessaoDaMensagem(e, 501), null);
    assert.equal(canal.chamadoDaAba(e, 'painel'), null);
    assert.deepEqual(e.tg.painel.dados.trabalhando, ['A'], 'mudar o objeto depois nao muda o painel');
    for (const ruim of [null, 'x', 3, []]) assert.throws(() => canal.painel(e, ruim), TypeError);
    assert.throws(() => canal.aviso(e, parou('painel'), 'Aba'), TypeError);
  });

  test('volta do disco (completarTg): painel igual; campo torto = o padrao; o seq nunca abaixo da versao do painel; estado sem painel completa na hora', async () => {
    const { canal, e } = novo();
    canal.painel(e, DADOS, { citar: 90 });
    await canal.drenar(e);
    const lido = completarTg(JSON.parse(JSON.stringify(e.tg)));
    assert.deepEqual(lido.painel, e.tg.painel);
    assert.deepEqual(completarTg({ painel: 5 }).painel, tgNovo().painel);
    assert.deepEqual(completarTg({ painel: { dados: 'x', versaoId: -1, descer: 'sim', citar: 'lixo', mensagem: 'x', apagar: {} } }).painel, tgNovo().painel);
    assert.equal(completarTg({ painel: { versaoId: 12, mensagem: { messageId: 7, formato: 'rich', versaoId: 12 } } }).seq, 12);
    const velho = novo();
    delete velho.e.tg.painel; // estado de antes da T9
    velho.canal.painel(velho.e, DADOS, { citar: 90 });
    await velho.canal.drenar(velho.e);
    assert.equal(velho.e.tg.painel.mensagem.messageId, 501);
  });

  test('ensaio: o painel vira tg.enviar com sessionId e estado "painel"', async () => {
    const { canal, e, ensaios } = novo({ ensaio: true });
    canal.painel(e, DADOS, { citar: 90 });
    await canal.drenar(e);
    assert.deepEqual(ensaios, [{ acao: 'tg.enviar', sessionId: 'painel', estado: 'painel', silencioso: true, ...montarPainel(DADOS), botoes: null, responderA: 90 }]);
  });
});

// ---------- T10: a situacao da aba (o toque no nome dela no painel; PLANO-TELEGRAM.md, T10, contrato 3 e 4) ----------

const DS = { titulo: 'Faro', situacao: 'trabalhando', final: 'Rodando a bateria agora.' };

describe('T10 3. situacao da aba: mensagem propria em cima do citar, a anterior sai, o painel fica, resposta em cima dela = a aba', () => {
  test('1a situacao: nova silenciosa em cima do citar, fora do painel; mensagens guarda a aba; a 2a desce e apaga a 1a; o painel fica', async () => {
    const { canal, tg, e } = novo();
    canal.painel(e, DADOS, { citar: 90 });
    await canal.drenar(e); // 501 = painel
    canal.situacao(e, 'S1', DS, { citar: 77 });
    assert.deepEqual(e.tg.saida.map((i) => i.sessionId), ['situacao']);
    await canal.drenar(e); // 502
    assert.deepEqual(tg.chamadas[1].args[0], { ...montarSituacao({ ...DS, chamadoId: 'ABCDEFGH' }), silencioso: true, responderA: 77 }); // T10c: os botoes do aviso
    assert.deepEqual(e.tg.mensagens[502], { sessionId: 'situacao', aba: 'S1', at: iso(T0), formato: 'rich', citar: 77 }); // T23a: o registro guarda o citar
    assert.equal(canal.sessaoDaMensagem(e, 502), 'S1', 'resposta em cima da situacao vai pra aba');
    assert.equal(canal.sessaoDaMensagem(e, 501), null, 'em cima do painel continua solta');
    assert.equal(e.tg.situacao.citar, null, 'o reply ja saiu');
    // 2a situacao (outra aba): nova em cima do citar novo; a 502 sai depois; o painel fica
    canal.situacao(e, 'S2', { ...DS, titulo: 'Site' }, { citar: 78 });
    await canal.drenar(e);
    // T26d (regra 3): a S1 nao tem chamado com tela: a 502 fica no chat sem os botoes, como mensagem da S1
    assert.deepEqual(passos(tg).slice(2), [['enviar', true], ['editarBotoes', 502]]);
    assert.equal(tg.chamadas[2].args[0].responderA, 78);
    assert.equal(e.tg.painel.mensagem.messageId, 501);
    assert.equal(e.tg.situacao.mensagem.messageId, 503);
    assert.equal(canal.sessaoDaMensagem(e, 503), 'S2');
    assert.deepEqual(Object.keys(e.tg.mensagens).sort(), ['501', '502', '503']); // T26d: a 502 e da S1
    assert.equal(canal.sessaoDaMensagem(e, 502), 'S1');
    assert.deepEqual(e.tg.saida, []);
  });

  test('aba invalida ou dados invalidos = TypeError; dados copiados; "situacao" nao e sessionId de aba', async () => {
    const { canal, e } = novo();
    for (const sid of ['', 'sistema', 'painel', 'situacao', null, 5]) assert.throws(() => canal.situacao(e, sid, DS), TypeError, String(sid));
    for (const ruim of [null, 'x', 3, []]) assert.throws(() => canal.situacao(e, 'S1', ruim), TypeError);
    assert.throws(() => canal.aviso(e, parou('situacao'), 'Aba'), TypeError);
    assert.equal(canal.chamadoDaAba(e, 'situacao'), null);
    const d = { ...DS };
    canal.situacao(e, 'S1', d, { citar: 77 });
    d.titulo = 'Outra';
    assert.equal(e.tg.situacao.dados.titulo, 'Faro', 'mudar o objeto depois nao muda a situacao');
  });

  test('telaDaAba: o messageId do chamado da aba na tela | null (sem chamado, sem tela, "painel"/"sistema")', async () => {
    const { canal, e } = novo();
    assert.equal(canal.telaDaAba(e, 'S1'), null, 'sem chamado');
    canal.aviso(e, parou('S1'), 'Faro');
    assert.equal(canal.telaDaAba(e, 'S1'), null, 'chamado ainda fora da tela');
    await canal.drenar(e);
    assert.equal(canal.telaDaAba(e, 'S1'), 501);
    for (const sid of ['painel', 'sistema', 'situacao', '', null]) assert.equal(canal.telaDaAba(e, sid), null, String(sid));
  });

  test('volta do disco (completarTg): situacao igual; campo torto = o padrao; o seq nunca abaixo dela; estado sem a situacao completa na hora', async () => {
    const { canal, e } = novo();
    canal.situacao(e, 'S1', DS, { citar: 77 });
    await canal.drenar(e);
    const lido = completarTg(JSON.parse(JSON.stringify(e.tg)));
    assert.deepEqual(lido.situacao, e.tg.situacao);
    assert.deepEqual(tgNovo().situacao, { aba: null, dados: null, chamadoId: null, completo: false, versaoId: 0, descer: false, citar: null, mensagem: null, apagar: [] });
    assert.deepEqual(completarTg({ situacao: 5 }).situacao, tgNovo().situacao);
    assert.deepEqual(completarTg({ situacao: { aba: 'painel', dados: 'x', chamadoId: 'abc', completo: 'sim', versaoId: -1, descer: 'sim', citar: 'lixo', mensagem: 'x', apagar: {}, apagarJa: 'x' } }).situacao, tgNovo().situacao);
    assert.equal(completarTg({ situacao: { versaoId: 15, mensagem: { messageId: 7, formato: 'rich', versaoId: 15 } } }).seq, 15);
    const velho = novo();
    delete velho.e.tg.situacao; // estado de antes da T10
    velho.canal.situacao(velho.e, 'S1', DS, { citar: 77 });
    await velho.canal.drenar(velho.e);
    assert.equal(velho.e.tg.situacao.mensagem.messageId, 501);
  });
});

// ---------- T10c: os botoes do aviso na situacao (PLANO-TELEGRAM.md, "T10c") ----------

describe('T10c 2. situacao com os botoes do aviso: id proprio, lerToque, abrirSituacao, situacaoTocada', () => {
  const DSP = { titulo: 'Faro', situacao: 'Esperando você desde 12:00.', final: FINAL };

  test('a situacao sai com os botoes (id proprio, novo a cada situacao); lerToque: opcao e informacoes da situacao na tela', async () => {
    const { canal, tg, e } = novo();
    canal.situacao(e, 'S1', DSP, { citar: 77 });
    await canal.drenar(e); // 501
    assert.equal(e.tg.situacao.chamadoId, 'ABCDEFGH');
    assert.deepEqual(tg.chamadas[0].args[0].botoes, montarSituacao({ ...DSP, chamadoId: 'ABCDEFGH' }).botoes);
    assert.equal(tg.chamadas[0].args[0].botoes[0][0].dados, 'o:ABCDEFGH:0');
    assert.deepEqual(canal.lerToque(e, 'o:ABCDEFGH:0', 501), { sessionId: 'S1', acao: 'opcao', opcao: OPCOES[0], situacao: true });
    assert.deepEqual(canal.lerToque(e, 'o:ABCDEFGH:1', 501), { sessionId: 'S1', acao: 'opcao', opcao: OPCOES[1], situacao: true });
    assert.deepEqual(canal.lerToque(e, 'i:ABCDEFGH', 501), { sessionId: 'S1', acao: 'informacoes', situacao: true });
    for (const [dados, mid] of [['o:ABCDEFGH:0', 999], ['o:ABCDEFGH:5', 501], ['o:JKMNPQRS:0', 501], ['lixo', 501]]) {
      assert.deepEqual(canal.lerToque(e, dados, mid), { obsoleto: true }, `${dados} ${mid}`);
    }
    // a 2a situacao ganha id novo; o toque na 1a (ja apagada) = obsoleto
    canal.situacao(e, 'S2', DSP, { citar: 78 });
    await canal.drenar(e); // 502, apaga a 501
    assert.equal(e.tg.situacao.chamadoId, 'JKMNPQRS');
    assert.deepEqual(canal.lerToque(e, 'o:ABCDEFGH:0', 501), { obsoleto: true });
    assert.equal(canal.lerToque(e, 'o:JKMNPQRS:0', 502).sessionId, 'S2');
  });

  test('abrirSituacao: a situacao vira o texto completo ali mesmo (edicao, sem notificar), com os botoes das opcoes; 2a vez ou sem texto = false', async () => {
    const { canal, tg, e } = novo();
    assert.equal(canal.abrirSituacao(e), false, 'sem situacao');
    canal.situacao(e, 'S1', DSP, { citar: 77 });
    await canal.drenar(e); // 501
    assert.equal(canal.abrirSituacao(e), true);
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', true], ['editar', 501]]);
    const ed = tg.chamadas[1].args[1];
    const aberta = montarSituacao({ ...DSP, chamadoId: 'ABCDEFGH', completo: true });
    assert.equal(ed.html, aberta.html);
    assert.deepEqual(ed.botoes, aberta.botoes);
    assert.equal(canal.abrirSituacao(e), false, 'ja aberta');
    assert.deepEqual(canal.lerToque(e, 'o:ABCDEFGH:1', 501), { sessionId: 'S1', acao: 'opcao', opcao: OPCOES[1], situacao: true });
    assert.deepEqual(canal.lerToque(e, 'i:ABCDEFGH', 501), { sessionId: 'S1', acao: 'informacoes', situacao: true });
    const v = novo();
    v.canal.situacao(v.e, 'S1', { ...DSP, final: null }, { citar: 77 });
    await v.canal.drenar(v.e);
    assert.equal(v.canal.abrirSituacao(v.e), false, 'sem texto pra abrir');
  });

  test('situacaoTocada: a mensagem da situacao sai (apagar), sai do mensagens e nao volta; toque depois = obsoleto; o painel fica', async () => {
    const { canal, tg, e } = novo();
    canal.painel(e, DADOS, { citar: 90 });
    canal.situacao(e, 'S1', DSP, { citar: 77 });
    await canal.drenar(e); // 501 painel, 502 situacao
    canal.situacaoTocada(e);
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', true], ['enviar', true], ['apagar', 502]]);
    assert.equal(e.tg.situacao.mensagem, null);
    assert.equal(e.tg.situacao.dados, null);
    assert.deepEqual(Object.keys(e.tg.mensagens), ['501']);
    assert.deepEqual(e.tg.saida, []);
    await canal.drenar(e);
    assert.equal(tg.chamadas.length, 3, 'nao reenvia');
    assert.deepEqual(canal.lerToque(e, 'o:ABCDEFGH:0', 502), { obsoleto: true });
    assert.equal(e.tg.painel.mensagem.messageId, 501, 'o painel fica');
    canal.situacaoTocada(e); // sem situacao na tela: nada
    await canal.drenar(e);
    assert.equal(tg.chamadas.length, 3);
  });

  // T14 (PLANO-TELEGRAM.md, "T14"): o "Concluir" (z:<id>) da situacao. T14c (pedido do dono): saiu; o z: = obsoleto
  test('T14c: lerToque do z:<id> = obsoleto em tudo (situacao na tela, mesmo com concluir: true nos dados, curta e aberta; chamado); a situacao nao tem o botao', async () => {
    const { canal, tg, e } = novo();
    canal.aviso(e, parou('aba-1'), 'Aba');
    await canal.drenar(e); // 501 ABCDEFGH: o aviso (chamado) da aba-1
    assert.deepEqual(canal.lerToque(e, 'z:ABCDEFGH', 501), { obsoleto: true }, 'chamado');
    canal.situacao(e, 'S1', { ...DSP, concluir: true }, { citar: 77 });
    await canal.drenar(e); // 502 JKMNPQRS: a situacao
    const env = tg.chamadas.at(-1).args[0];
    assert.deepEqual(env.botoes, montarSituacao({ ...DSP, chamadoId: 'JKMNPQRS' }).botoes);
    assert.ok(!env.botoes.flat().some((b) => b.dados.startsWith('z:')), JSON.stringify(env.botoes));
    assert.deepEqual(canal.lerToque(e, 'z:JKMNPQRS', 502), { obsoleto: true });
    assert.deepEqual(canal.lerToque(e, 'i:JKMNPQRS', 502), { sessionId: 'S1', acao: 'informacoes', situacao: true });
    assert.equal(canal.abrirSituacao(e), true);
    assert.deepEqual(canal.lerToque(e, 'z:JKMNPQRS', 502), { obsoleto: true }, 'aberta');
  });

  test('volta do disco: chamadoId, completo e apagarJa da situacao', async () => {
    const { canal, e } = novo();
    canal.situacao(e, 'S1', DSP, { citar: 77 });
    await canal.drenar(e);
    canal.abrirSituacao(e);
    const lido = completarTg(JSON.parse(JSON.stringify(e.tg)));
    assert.deepEqual(lido.situacao, e.tg.situacao);
    assert.equal(lido.situacao.completo, true);
    assert.deepEqual(completarTg({ situacao: { aba: 'S1', apagarJa: [502, 'x', 0] } }).situacao.apagarJa, [502]);
    assert.equal(completarTg({ situacao: { chamadoId: 'abc' } }).situacao.chamadoId, null);
    // a tocada volta do disco no meio do apagar: o drenar apaga e nao reenvia
    const v = novo();
    v.e.tg = completarTg({ situacao: { aba: 'S1', dados: null, mensagem: null, apagarJa: [502] }, saida: [{ sessionId: 'situacao', entrouEm: iso(T0), falhas: 0 }] });
    await v.canal.drenar(v.e);
    assert.deepEqual(passos(v.tg), [['apagar', 502]]);
    assert.deepEqual(v.e.tg.saida, []);
    // a tocada com a situacao anterior ainda por apagar: apaga as duas e nao manda nada novo
    const w = novo();
    w.e.tg = completarTg({ situacao: { aba: 'S1', dados: null, mensagem: null, apagarJa: [502], apagar: [{ messageId: 501, doBot: true }] }, saida: [{ sessionId: 'situacao', entrouEm: iso(T0), falhas: 0 }] });
    await w.canal.drenar(w.e);
    assert.deepEqual(passos(w.tg), [['apagar', 502], ['apagar', 501]]);
    assert.deepEqual(w.e.tg.saida, []);
  });
});

// T16 (PLANO-TELEGRAM.md, "T16"; pedido do dono): a situacao da aba trabalhando nao tem os botoes das opcoes, e o
// o: dela nunca vale (a vez nao acabou).
describe('T16 2. situacao de aba trabalhando: so o "Mais informações"; o o: dela = obsoleto', () => {
  const DST = { titulo: 'Aula', situacao: 'Trabalhando agora, desde 12:00.', final: FINAL, trabalhando: true };

  test('a flag fica nos dados; o envio sem os botoes das opcoes; o: = obsoleto e i: vale (curta e aberta); volta do disco', async () => {
    const { canal, tg, e } = novo();
    canal.situacao(e, 'S1', DST, { citar: 77 });
    await canal.drenar(e); // 501
    assert.equal(e.tg.situacao.dados.trabalhando, true);
    assert.deepEqual(tg.chamadas[0].args[0].botoes, [[{ texto: 'Mais informações', dados: 'i:ABCDEFGH' }]]);
    assert.ok(tg.chamadas[0].args[0].html.includes('A) Sim, tudo hoje (recomendado)'), 'as opcoes em texto');
    for (const dados of ['o:ABCDEFGH:0', 'o:ABCDEFGH:1']) assert.deepEqual(canal.lerToque(e, dados, 501), { obsoleto: true }, dados);
    assert.deepEqual(canal.lerToque(e, 'i:ABCDEFGH', 501), { sessionId: 'S1', acao: 'informacoes', situacao: true });
    assert.equal(canal.abrirSituacao(e), true);
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', true], ['editar', 501]]);
    const aberta = montarSituacao({ ...DST, chamadoId: 'ABCDEFGH', completo: true });
    assert.equal(aberta.botoes, null);
    assert.equal(tg.chamadas[1].args[1].html, aberta.html);
    assert.deepEqual(canal.lerToque(e, 'o:ABCDEFGH:0', 501), { obsoleto: true }, 'aberta');
    const lido = completarTg(JSON.parse(JSON.stringify(e.tg)));
    assert.equal(lido.situacao.dados.trabalhando, true);
    // a situacao seguinte sem a flag volta a ter os botoes das opcoes
    canal.situacao(e, 'S2', { ...DST, trabalhando: undefined, situacao: 'Parada.' }, { citar: 78 });
    await canal.drenar(e); // 502
    assert.deepEqual(canal.lerToque(e, 'o:JKMNPQRS:0', 502), { sessionId: 'S2', acao: 'opcao', opcao: OPCOES[0], situacao: true });
  });
});

// ---------- T8: a aba fechou e voltou como a copia (reaberta pelo celular) ----------

describe('T8 1. trocarAba: o que era da aba fechada no Telegram passa pra copia reaberta', () => {
  const DSF = { titulo: 'Faro', situacao: 'Fechada.', final: FINAL };

  test('aviso na tela: o chamado, as mensagens do bot e a fila passam pra copia; resposta e toque em cima da antiga vao pra copia; o drenar segue nela', async () => {
    const { canal, tg, e, logs } = novo();
    canal.aviso(e, parou('S1'), 'Faro');
    await canal.drenar(e); // 501
    const id = e.tg.chamados.S1.versao.chamadoId;
    const antes = structuredClone(e.tg.chamados.S1);
    assert.equal(canal.trocarAba(e, 'S1', 'C1'), true);
    assert.equal(e.tg.chamados.S1, undefined);
    assert.deepEqual(e.tg.chamados.C1, antes, 'o chamado inteiro, sem mudar nada');
    assert.equal(canal.sessaoDaMensagem(e, 501), 'C1');
    assert.equal(canal.telaDaAba(e, 'C1'), 501);
    assert.deepEqual(canal.lerToque(e, `o:${id}:0`, 501), { sessionId: 'C1', acao: 'opcao', opcao: OPCOES[0] });
    assert.deepEqual(canal.chamadoDaAba(e, 'C1'), { nome: null, titulo: 'Faro', final: FINAL });
    assert.equal(logs.filter((l) => l.includes('S1: a aba voltou como C1')).length, 1);
    // a fala dele vai pra copia: o chamado dela perde os botoes na tela (T7f) e a fila do canal e dela
    canal.falaRecebida(e, { sessionId: 'C1', fala: 'sim', hora: iso(T0), messageIdDono: 77 });
    assert.ok(e.tg.saida.some((i) => i.sessionId === 'C1'));
    assert.ok(!e.tg.saida.some((i) => i.sessionId === 'S1'));
    await canal.drenar(e);
    assert.deepEqual(passos(tg).slice(1), [['editarBotoes', 501]]);
  });

  test('item da antiga ja na fila do canal: vira da copia (sem 2 itens); a copia ja tinha item = o da antiga sai', async () => {
    const { canal, e } = novo();
    canal.aviso(e, parou('S1'), 'Faro');
    assert.deepEqual(e.tg.saida.map((i) => i.sessionId), ['S1']);
    canal.trocarAba(e, 'S1', 'C1');
    assert.deepEqual(e.tg.saida.map((i) => i.sessionId), ['C1']);
    const v = novo();
    v.canal.aviso(v.e, parou('S1'), 'Faro');
    v.e.tg.saida.push({ sessionId: 'C1', entrouEm: iso(T0), falhas: 0 });
    v.canal.trocarAba(v.e, 'S1', 'C1');
    assert.deepEqual(v.e.tg.saida.map((i) => i.sessionId), ['C1'], 'o chamado passou, a fila da copia fica 1 so');
  });

  test('a copia ja tinha chamado: o da antiga sai pelo herdar (a tela dela vai pro apagar da copia, sem botoes)', async () => {
    const { canal, tg, e } = novo();
    canal.aviso(e, parou('S1'), 'Faro');
    await canal.drenar(e); // 501
    canal.aviso(e, parou('C1', 'Pronto.'), 'Faro');
    await canal.drenar(e); // 502
    tg.chamadas.length = 0;
    assert.equal(canal.trocarAba(e, 'S1', 'C1'), true);
    assert.equal(e.tg.chamados.S1, undefined);
    assert.equal(e.tg.chamados.C1.mensagem.messageId, 502, 'a tela da copia fica');
    assert.deepEqual(e.tg.chamados.C1.apagar.map((a) => a.messageId), [501]);
    assert.equal(canal.sessaoDaMensagem(e, 501), 'C1');
  });

  test('situacao da antiga (e a mensagem dela) passam pra copia; sem chamado da antiga, so isso muda', async () => {
    const { canal, e } = novo();
    canal.situacao(e, 'S1', DSF, { citar: 77 });
    await canal.drenar(e); // 501
    assert.equal(canal.sessaoDaMensagem(e, 501), 'S1');
    assert.equal(canal.trocarAba(e, 'S1', 'C1'), true);
    assert.equal(e.tg.situacao.aba, 'C1');
    assert.equal(canal.sessaoDaMensagem(e, 501), 'C1');
    assert.equal(canal.lerToque(e, 'o:ABCDEFGH:0', 501).sessionId, 'C1');
    assert.equal(e.tg.chamados.C1, undefined, 'nao inventa chamado');
  });

  test('nada a trocar, a mesma aba, nome reservado ou id torto = false e o estado fica igual', async () => {
    const { canal, e } = novo();
    canal.aviso(e, parou('S1'), 'Faro');
    await canal.drenar(e);
    const antes = structuredClone(e.tg);
    for (const [de, para] of [['S9', 'C1'], ['S1', 'S1'], ['S1', 'painel'], ['sistema', 'C1'], ['situacao', 'C1'], ['S1', ''], [null, 'C1'], ['S1', 7]]) {
      assert.equal(canal.trocarAba(e, de, para), false, `${de} -> ${para}`);
    }
    assert.deepEqual(e.tg, antes);
  });
});

// ---------- T12: o toque no nome da aba no painel (PLANO-TELEGRAM.md, T12; pedido do dono) ----------
// apagarToque = o "/start" do toque sai do chat (antes da situacao, que deixa de citar ele); painelNaTela/atualizarPainel
// = o painel na tela se atualiza por edicao (sem notificar); edicao recusada = o painel sai do estado (nao volta sozinho).

describe('T12 1. apagarToque: o "/start" do toque sai do chat antes da situacao', () => {
  test('apaga o /start (mensagem do dono) antes de mandar a situacao; a situacao sem citar; a lista some; log', async () => {
    const { canal, tg, e, logs } = novo();
    canal.painel(e, DADOS, { citar: 90 });
    await canal.drenar(e); // 501 = painel
    assert.equal(canal.apagarToque(e, 95), true);
    canal.situacao(e, 'S1', DS);
    await canal.drenar(e);
    assert.deepEqual(passos(tg).slice(1), [['apagar', 95], ['enviar', true]]);
    assert.ok(!('responderA' in tg.chamadas[2].args[0]), 'a situacao nao cita o /start');
    assert.equal(e.tg.situacao.apagarToque, undefined, 'a lista vazia some');
    assert.ok(logs.some((l) => l.includes('mensagem 95 do dono apagada (o /start do toque no painel)')), logs.join('\n'));
    assert.equal(e.tg.painel.mensagem.messageId, 501, 'o painel fica');
  });

  test('sozinho (sem situacao nova) so apaga; id torto = false e nada muda; o mesmo id 2x = 1 apagar', async () => {
    const { canal, tg, e } = novo();
    for (const ruim of [0, -3, 1.5, '95', null, undefined]) assert.equal(canal.apagarToque(e, ruim), false, String(ruim));
    assert.deepEqual(e.tg.saida, []);
    canal.apagarToque(e, 95);
    canal.apagarToque(e, 95);
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['apagar', 95]]);
    assert.deepEqual(e.tg.saida, []);
  });

  test('recusado (400) ou com mais de 48 h = fica no chat, sai da lista com 1 log e a situacao sai igual; transporte = fica na fila e tenta de novo', async () => {
    for (const [nome, r] of [
      ['velha', { ok: false, velha: true }],
      ['400', { ok: false, erro: "deleteMessage: Bad Request: message can't be deleted", codigo: 400 }],
    ]) {
      const { canal, tg, e, logs } = novo({ roteiro: { apagar: [r] } });
      canal.apagarToque(e, 95);
      canal.situacao(e, 'S1', DS);
      await canal.drenar(e);
      assert.deepEqual(passos(tg), [['apagar', 95], ['enviar', true]], nome);
      assert.equal(e.tg.situacao.apagarToque, undefined, nome);
      assert.ok(logs.some((l) => l.includes('apagar 95 recusado') && l.includes('o /start fica no chat')), `${nome}: ${logs.join('\n')}`);
    }
    const { canal, tg, e } = novo({ roteiro: { apagar: [{ ok: false, erro: 'fetch failed' }] } });
    canal.apagarToque(e, 95);
    await canal.drenar(e);
    assert.deepEqual(e.tg.situacao.apagarToque, [95], 'transporte: fica');
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['apagar', 95], ['apagar', 95]]);
    assert.equal(e.tg.situacao.apagarToque, undefined);
  });

  test('mensagem de pedido de OK (idsDeFora) nunca e apagada; volta do disco (completarTg) guarda a lista, torta sai', async () => {
    const { canal, tg, e, logs } = novo();
    canal.apagarToque(e, 95);
    await canal.drenar(e, { idsDeFora: [95] });
    assert.deepEqual(passos(tg), []);
    assert.ok(logs.some((l) => l.includes('mensagem 95 e de um pedido de OK')), logs.join('\n'));
    const d = novo();
    d.canal.apagarToque(d.e, 96);
    assert.deepEqual(completarTg(JSON.parse(JSON.stringify(d.e.tg))).situacao.apagarToque, [96]);
    assert.equal(completarTg({ situacao: { apagarToque: ['x', -1] } }).situacao.apagarToque, undefined);
  });
});

describe('T12 2. painelNaTela e atualizarPainel: o painel na tela se atualiza por edicao', () => {
  test('sem painel = null/false e nada na fila; com o painel na tela = edita a mesma mensagem, sem mensagem nova, e os dados novos ficam', async () => {
    const { canal, tg, e } = novo();
    assert.equal(canal.painelNaTela(e), null);
    assert.equal(canal.atualizarPainel(e, DADOS), false);
    assert.deepEqual(e.tg.saida, []);
    canal.painel(e, DADOS, { citar: 90 });
    await canal.drenar(e); // 501
    const naTela = canal.painelNaTela(e);
    assert.deepEqual(naTela, DADOS);
    naTela.abertas = 99;
    assert.equal(e.tg.painel.dados.abertas, 2, 'copia');
    assert.equal(canal.atualizarPainel(e, { ...DADOS, abertas: 5 }), true);
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', true], ['editar', 501]]);
    assert.ok(tg.chamadas[1].args[1].html.includes('Abas abertas: 5'), tg.chamadas[1].args[1].html);
    assert.equal(e.tg.painel.mensagem.messageId, 501);
    assert.equal(canal.painelNaTela(e).abertas, 5);
    for (const ruim of [null, 'x', 3, []]) assert.throws(() => canal.atualizarPainel(e, ruim), TypeError);
  });

  test('painel pedido e ainda nao enviado: atualizarPainel troca os dados do que vai sair (1 mensagem so)', async () => {
    const { canal, tg, e } = novo();
    canal.painel(e, DADOS, { citar: 90 });
    assert.deepEqual(canal.painelNaTela(e), DADOS);
    assert.equal(canal.atualizarPainel(e, { ...DADOS, abertas: 7 }), true);
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', true]]);
    assert.ok(tg.chamadas[0].args[0].html.includes('Abas abertas: 7'));
    assert.equal(tg.chamadas[0].args[0].responderA, 90);
  });

  test('edicao recusada (o dono apagou o painel) = o painel sai do estado, nenhuma mensagem nova; depois atualizarPainel = false', async () => {
    const { canal, tg, e, logs } = novo({ roteiro: { editar: [{ ok: false, erro: 'editMessageText: Bad Request: message to edit not found', codigo: 400 }] } });
    canal.painel(e, DADOS, { citar: 90 });
    await canal.drenar(e); // 501
    canal.atualizarPainel(e, { ...DADOS, abertas: 5 });
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', true], ['editar', 501]]);
    assert.equal(e.tg.painel.mensagem, null);
    assert.equal(e.tg.painel.dados, null);
    assert.deepEqual(e.tg.saida, []);
    assert.ok(logs.some((l) => l.includes('edicao da mensagem 501 recusada') && l.includes('o painel sai')), logs.join('\n'));
    assert.equal(canal.painelNaTela(e), null);
    assert.equal(canal.atualizarPainel(e, DADOS), false);
    await canal.drenar(e);
    assert.equal(tg.chamadas.length, 2);
  });
});

describe('T12 3. a fila do painel sem painel', () => {
  test('item do painel na fila sem painel (estado do disco, ou depois da edicao recusada) nao manda nada; com o apagar dele, so apaga', async () => {
    const { canal, tg, e, logs } = novo();
    e.tg.saida.push({ sessionId: 'painel', entrouEm: iso(T0), falhas: 0 });
    await canal.drenar(e);
    assert.deepEqual(passos(tg), []);
    assert.deepEqual(e.tg.saida, []);
    assert.ok(logs.some((l) => l.includes('painel saiu da fila (nenhum painel)')), logs.join('\n'));
    e.tg.painel.apagar = [{ messageId: 480, doBot: true, formato: 'rich' }];
    e.tg.saida.push({ sessionId: 'painel', entrouEm: iso(T0), falhas: 0 });
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['apagar', 480]]);
    assert.deepEqual(e.tg.painel.apagar, []);
  });
});

// ---------- T17b: a resposta em voz no estado do canal (PLANO-TELEGRAM.md, "T17", item 5) ----------

describe('T17b 1. vozEnviada e naFila: a voz da aba e mensagem do bot dela que nunca vai pro apagar', () => {
  test('vozEnviada registra com voz: true; resposta em cima dela = a aba; id ou aba invalido = nada', () => {
    const { canal, e } = novo();
    canal.vozEnviada(e, 'aba-1', 905);
    assert.deepEqual(e.tg.mensagens[905], { sessionId: 'aba-1', at: iso(T0), formato: 'texto', voz: true });
    assert.equal(canal.sessaoDaMensagem(e, 905), 'aba-1');
    for (const [sid, id] of [['aba-1', 0], ['aba-1', 'x'], ['aba-1', null], ['aba-1', 1.5], ['', 906], [null, 906], ['sistema', 906], ['painel', 906], ['__proto__', 906]]) {
      canal.vozEnviada(e, sid, id);
    }
    assert.deepEqual(Object.keys(e.tg.mensagens), ['905']);
  });

  test('chamado novo da aba (o velho podado): a voz fica fora do apagar; a mensagem de texto antiga vai', async () => {
    const { canal, e, relogio } = novo();
    canal.aviso(e, parou('aba-1'), 'Aba');
    await canal.drenar(e); // 501
    canal.vozEnviada(e, 'aba-1', 905);
    relogio.t = T0 + DIA;
    canal.podar(e, relogio.t);
    assert.deepEqual(e.tg.chamados, {});
    assert.deepEqual(Object.keys(e.tg.mensagens).sort(), ['501', '905'], 'a voz tem menos de 7 dias: fica');
    canal.aviso(e, parou('aba-1', FINAL, iso(relogio.t)), 'Aba');
    assert.deepEqual(e.tg.chamados['aba-1'].apagar, [{ messageId: 501, doBot: true, formato: 'rich' }], 'so o texto antigo');
    await canal.drenar(e);
    assert.equal(e.tg.mensagens[905].voz, true, 'a voz continua no chat');
    relogio.t = T0 + 8 * DIA;
    canal.podar(e, relogio.t);
    assert.equal(e.tg.mensagens[905], undefined, 'a faxina de 7 dias vale igual');
  });

  test('trocarAba leva a voz (resposta em cima dela vai pra copia); naFila = a aba tem item na fila do canal', async () => {
    const { canal, e } = novo();
    canal.vozEnviada(e, 'S1', 905);
    assert.equal(canal.trocarAba(e, 'S1', 'C1'), true);
    assert.equal(canal.sessaoDaMensagem(e, 905), 'C1');
    assert.equal(e.tg.mensagens[905].voz, true);
    assert.equal(canal.naFila(e, 'C1'), false);
    canal.resposta(e, parou('C1', 'Feito.'), 'Faro', { citar: 90 });
    assert.equal(canal.naFila(e, 'C1'), true);
    assert.equal(canal.naFila(e, 'S1'), false);
    await canal.drenar(e);
    assert.equal(canal.naFila(e, 'C1'), false, 'a resposta saiu');
  });
});

// ---------- T23a: modo "apagar", a conversa resolvida leva a voz e a mensagem do dono (PLANO-TELEGRAM.md, "T23") ----------
// O registro de cada mensagem do robo guarda o `citar` (o responderA do envio; a voz pelo vozEnviada). Quando o robo apaga
// (ok ou ja sumiu) a ultima mensagem dele que nao e voz em cima da fala X do dono e X esta no anel, as vozes em cima de X
// e X vao pro comeco do `limpar` do alvo e saem 1 por passo, antes da tela.

describe('T23a. modo "apagar": a conversa resolvida leva a voz e a mensagem do dono', () => {
  const FALA_A = 'A) Sim, tudo hoje (recomendado)';
  const VELHA = { ok: false, velha: true };
  const R400 = { ok: false, erro: "deleteMessage: Bad Request: message can't be deleted", codigo: 400 };
  const R429 = { ok: false, erro: 'deleteMessage: Too Many Requests: retry after 1', codigo: 429, esperarS: 1 };

  // a fala x do dono (no anel, salvo anel: false) -> a resposta da aba em cima de x (mensagem nova, com os botoes da
  // DECISAO) -> as vozes em cima de x. Devolve o message_id da resposta.
  async function respondida({ canal, e }, sid, x, vozes = [], { anel = true } = {}) {
    if (anel) canal.mensagemDoDono(e, x);
    canal.falaRecebida(e, { sessionId: sid, titulo: 'Aba', fala: 'faz só as correções', hora: iso(T0 + MIN), messageIdDono: x });
    canal.resposta(e, parou(sid), 'Aba', { citar: x });
    await canal.drenar(e);
    for (const v of vozes) canal.vozEnviada(e, sid, v, { citar: x });
    return e.tg.chamados[sid].mensagem.messageId;
  }
  // o toque numa opcao da tela da aba (a tela vai pro apagarJa)
  const tocar = ({ canal, e }, sid) => canal.falaRecebida(e, { sessionId: sid, titulo: 'Aba', fala: FALA_A, hora: iso(T0 + 2 * MIN), toque: true });
  // roteiro do apagar por id: respostas[id] = lista (cada chamada consome 1; vazia ou ausente = ok)
  const porId = (respostas) => ({ apagar: (id) => (Array.isArray(respostas[id]) && respostas[id].length ? respostas[id].shift() : undefined) });
  const temLogs = (logs, lista) => {
    for (const l of lista) assert.ok(logs.includes(l), `${l}\n---\n${logs.join('\n')}`);
  };

  test('T23a 1. toque: aviso -> fala 70 (no anel) -> resposta 502 em cima de 70 + voz 905 em cima de 70 -> toque numa opcao: drenar = [apagar 502, apagar 905, apagar 70]; os registros da tela e da voz saem; a voz sem citar fica; logs; o limpar some', async () => {
    const { canal, tg, e, logs } = novo();
    canal.aviso(e, parou('aba-1'), 'Aba');
    await canal.drenar(e); // 501, com os botoes da DECISAO
    canal.mensagemDoDono(e, 70);
    canal.falaRecebida(e, { sessionId: 'aba-1', titulo: 'Aba', fala: 'faz só as correções', hora: iso(T0 + MIN), messageIdDono: 70 });
    canal.resposta(e, parou('aba-1'), 'Aba', { citar: 70 });
    await canal.drenar(e); // 502 em cima de 70; o aviso 501 (sem citar) sai depois da nova e nao limpa nada
    const c = e.tg.chamados['aba-1'];
    assert.equal(c.mensagem.messageId, 502);
    assert.equal(tg.chamadas.at(-2).args[0].responderA, 70);
    assert.deepEqual(passos(tg).slice(-2), [['enviar', false], ['apagar', 501]]);
    assert.deepEqual(e.tg.mensagens['502'], { sessionId: 'aba-1', at: iso(T0), formato: 'rich', citar: 70 }, 'o registro guarda o citar (o responderA do envio)');
    assert.equal(c.limpar, undefined, 'o aviso nao tinha citar: nada a limpar');
    canal.vozEnviada(e, 'aba-1', 905, { citar: 70 });
    canal.vozEnviada(e, 'aba-1', 906); // sem o 4o argumento = como hoje (sem citar)
    assert.deepEqual(e.tg.mensagens['905'], { sessionId: 'aba-1', at: iso(T0), formato: 'texto', voz: true, citar: 70 });
    assert.deepEqual(e.tg.mensagens['906'], { sessionId: 'aba-1', at: iso(T0), formato: 'texto', voz: true });
    tg.chamadas.length = 0;
    canal.falaRecebida(e, { sessionId: 'aba-1', titulo: 'Aba', fala: FALA_A, hora: iso(T0 + 2 * MIN), toque: true });
    assert.deepEqual(c.apagarJa, [502]);
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['apagar', 502], ['apagar', 905], ['apagar', 70]], 'a tela, a voz e a fala dele, nessa ordem');
    assert.equal(e.tg.mensagens['502'], undefined);
    assert.equal(e.tg.mensagens['905'], undefined, 'a voz sai do t.mensagens');
    assert.equal(e.tg.mensagens['906'].voz, true, 'a voz sem citar fica');
    assert.equal(c.limpar, undefined, 'a lista vazia some do chamado');
    assert.equal(c.apagarJa, undefined);
    assert.deepEqual(e.tg.saida, []);
    temLogs(logs, [
      'telegram aba-1: mensagem 502 apagada (o dono tocou numa opcao)',
      'telegram aba-1: voz 905 apagada (conversa resolvida)',
      'telegram aba-1: mensagem 70 do dono apagada (conversa resolvida)',
    ]);
  });

  test('T23a 2. versao nova em cima de outra fala 80 (no anel): [enviar a nova, apagar a antiga 501, apagar a voz 905 de 70, apagar 70]; o 80 fica (a nova esta em cima dele)', async () => {
    const k = novo();
    const { canal, tg, e, logs } = k;
    assert.equal(await respondida(k, 'aba-1', 70, [905]), 501);
    canal.mensagemDoDono(e, 80);
    canal.falaRecebida(e, { sessionId: 'aba-1', titulo: 'Aba', fala: 'e o resto?', hora: iso(T0 + 2 * MIN), messageIdDono: 80 });
    canal.resposta(e, parou('aba-1', 'Feito.'), 'Aba', { citar: 80 });
    tg.chamadas.length = 0;
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false], ['apagar', 501], ['apagar', 905], ['apagar', 70]]);
    assert.equal(tg.chamadas[0].args[0].responderA, 80);
    assert.deepEqual(Object.keys(e.tg.mensagens), ['502']);
    assert.equal(e.tg.mensagens['502'].citar, 80);
    assert.equal(e.tg.chamados['aba-1'].limpar, undefined);
    assert.deepEqual(e.tg.saida, []);
    temLogs(logs, ['telegram aba-1: voz 905 apagada (conversa resolvida)', 'telegram aba-1: mensagem 70 do dono apagada (conversa resolvida)']);
  });

  test('T23a 3. duas respostas seguidas em cima do mesmo 70: so [enviar, apagar a antiga 501]; o 70 e a voz ficam (a 502 esta em cima de 70); o toque na 502 resolve a conversa', async () => {
    const k = novo();
    const { canal, tg, e } = k;
    await respondida(k, 'aba-1', 70, [905]); // 501
    canal.resposta(e, parou('aba-1'), 'Aba', { citar: 70 });
    tg.chamadas.length = 0;
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false], ['apagar', 501]], 'so a antiga');
    assert.deepEqual(Object.keys(e.tg.mensagens).sort(), ['502', '905']);
    assert.equal(e.tg.mensagens['502'].citar, 70);
    assert.equal(e.tg.chamados['aba-1'].limpar, undefined);
    tocar(k, 'aba-1');
    tg.chamadas.length = 0;
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['apagar', 502], ['apagar', 905], ['apagar', 70]], 'a ultima em cima de 70 saiu');
  });

  test('T23a 4. nada alem do de hoje: 70 fora do anel (o toque so apaga a tela) e registro sem citar (estado de antes)', async () => {
    const k = novo();
    await respondida(k, 'aba-1', 70, [905], { anel: false });
    assert.equal(k.e.tg.mensagens['501'].citar, 70, 'o citar e gravado mesmo fora do anel');
    tocar(k, 'aba-1');
    k.tg.chamadas.length = 0;
    await k.canal.drenar(k.e);
    assert.deepEqual(passos(k.tg), [['apagar', 501]]);
    assert.equal(k.e.tg.mensagens['905'].voz, true, 'a voz fica');
    assert.equal(k.e.tg.chamados['aba-1'].limpar, undefined);
    assert.deepEqual(k.e.tg.saida, []);

    const k2 = novo();
    await respondida(k2, 'aba-1', 70, [905]);
    delete k2.e.tg.mensagens['501'].citar; // o registro de antes da T23a
    tocar(k2, 'aba-1');
    k2.tg.chamadas.length = 0;
    await k2.canal.drenar(k2.e);
    assert.deepEqual(passos(k2.tg), [['apagar', 501]]);
    assert.equal(k2.e.tg.mensagens['905'].voz, true);
    assert.equal(k2.e.tg.chamados['aba-1'].limpar, undefined);
    assert.deepEqual(k2.e.tg.saida, []);
  });

  test('T23a 5. a limpeza: voz velha fica no chat (sem "movido"), 400 sai com log, 429 fica e o drenar seguinte apaga; 70 velha fica no chat (log, sem editar)', async () => {
    const k = novo({ roteiro: porId({ 905: [VELHA], 906: [R400], 907: [R429], 70: [VELHA] }) });
    const { canal, tg, e, logs, relogio } = k;
    await respondida(k, 'aba-1', 70, [905, 906, 907]); // 501
    tocar(k, 'aba-1');
    tg.chamadas.length = 0;
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['apagar', 501], ['apagar', 905], ['apagar', 906], ['apagar', 907]], 'o 429 para o drenar');
    const c = e.tg.chamados['aba-1'];
    assert.deepEqual(c.limpar, [{ messageId: 907, voz: true }, { messageId: 70, dono: true }], 'o do 429 fica no comeco');
    assert.deepEqual(e.tg.saida.map((i) => i.sessionId), ['aba-1']);
    relogio.t += 2 * 1000;
    await canal.drenar(e);
    assert.deepEqual(passos(tg).slice(4), [['apagar', 907], ['apagar', 70]]);
    assert.ok(!tg.chamadas.some((x) => x.metodo === 'editar'), 'nunca vira "movido"');
    assert.equal(c.limpar, undefined);
    assert.deepEqual(e.tg.saida, []);
    assert.deepEqual(e.tg.mensagens['905'], { sessionId: 'aba-1', at: iso(T0), formato: 'texto', voz: true, citar: 70 }, 'a voz velha fica no chat, sem movido');
    assert.equal(e.tg.mensagens['906'].voz, true, 'a recusada fica no chat');
    assert.equal(e.tg.mensagens['907'], undefined, 'a apagada sai');
    temLogs(logs, [
      'telegram aba-1: voz 905 fica no chat (mais de 48 h)',
      "telegram aba-1: apagar 906 recusado (deleteMessage: Bad Request: message can't be deleted); fica no chat",
      'telegram aba-1: voz 907 apagada (conversa resolvida)',
      'telegram aba-1: mensagem 70 do dono fica no chat (mais de 48 h)',
    ]);
  });

  test('T23a 6. apagar da mensagem do robo recusado = nenhuma limpeza: velha (vira "movido") na versao nova; 400 no toque (fica sem os botoes); 400 na versao nova', async () => {
    const k = novo({ roteiro: { apagar: [VELHA] } });
    await respondida(k, 'aba-1', 70, [905]); // 501
    k.canal.mensagemDoDono(k.e, 80);
    k.canal.resposta(k.e, parou('aba-1', 'Feito.'), 'Aba', { citar: 80 });
    k.tg.chamadas.length = 0;
    await k.canal.drenar(k.e);
    assert.deepEqual(passos(k.tg), [['enviar', false], ['apagar', 501], ['editar', 501]]);
    assert.equal(k.e.tg.mensagens['501'].movido, true);
    assert.equal(k.e.tg.mensagens['905'].voz, true);
    assert.equal(k.e.tg.chamados['aba-1'].limpar, undefined);

    const k2 = novo({ roteiro: { apagar: [R400] } });
    await respondida(k2, 'aba-1', 70, [905]);
    tocar(k2, 'aba-1');
    k2.tg.chamadas.length = 0;
    await k2.canal.drenar(k2.e);
    assert.deepEqual(passos(k2.tg), [['apagar', 501], ['editarBotoes', 501]]);
    assert.equal(k2.e.tg.mensagens['905'].voz, true);
    assert.equal(k2.e.tg.chamados['aba-1'].limpar, undefined);

    const k3 = novo({ roteiro: { apagar: [R400] } });
    await respondida(k3, 'aba-1', 70, [905]);
    k3.canal.resposta(k3.e, parou('aba-1', 'Feito.'), 'Aba');
    k3.tg.chamadas.length = 0;
    await k3.canal.drenar(k3.e);
    assert.deepEqual(passos(k3.tg), [['enviar', false], ['apagar', 501]]);
    assert.equal(k3.e.tg.mensagens['501'].citar, 70, 'a recusada continua no chat em cima de 70');
    assert.equal(k3.e.tg.chamados['aba-1'].limpar, undefined);
  });

  test('T23a 7. a linha do sistema em cima de 70 trocada por outra em cima de 80 = 70 sai; o calado com limpar so some com a lista vazia; o herdar leva o limpar (sem repetir id); painel e situacao sem dados limpam antes de sair da fila; do disco, entrada torta sai; resolvidas invalido = TypeError; manter = sem limpeza', async () => {
    const k = novo();
    k.canal.mensagemDoDono(k.e, 70);
    k.canal.sistema(k.e, 'Linha 1.', { citar: 70 });
    await k.canal.drenar(k.e); // 501 em cima de 70
    assert.equal(k.e.tg.mensagens['501'].citar, 70);
    k.canal.mensagemDoDono(k.e, 80);
    k.canal.sistema(k.e, 'Linha 2.', { citar: 80 });
    k.tg.chamadas.length = 0;
    await k.canal.drenar(k.e);
    assert.deepEqual(passos(k.tg), [['enviar', true], ['apagar', 501], ['apagar', 70]]);
    assert.equal(k.e.tg.sistema.limpar, undefined);
    temLogs(k.logs, ['telegram sistema: mensagem 70 do dono apagada (conversa resolvida)']);

    // calado: a tela 501 em cima de 70 sai; o 70 da 429 e o calado fica ate a lista esvaziar
    let n70 = 0;
    const k2 = novo({ roteiro: { apagar: (id) => (id === 70 && n70++ === 0 ? R429 : undefined) } });
    await respondida(k2, 'aba-1', 70, [905]);
    k2.canal.calar(k2.e, 'aba-1');
    k2.tg.chamadas.length = 0;
    await k2.canal.drenar(k2.e);
    assert.deepEqual(passos(k2.tg), [['apagar', 501], ['apagar', 905], ['apagar', 70]]);
    assert.deepEqual(k2.e.tg.chamados['aba-1'].limpar, [{ messageId: 70, dono: true }], 'o calado fica com o limpar');
    assert.ok(!k2.logs.includes('telegram aba-1: chamado calado saiu'));
    k2.relogio.t += 2 * 1000;
    await k2.canal.drenar(k2.e);
    assert.deepEqual(passos(k2.tg).slice(3), [['apagar', 70]]);
    assert.equal(k2.e.tg.chamados['aba-1'], undefined, 'lista vazia: o calado some');
    temLogs(k2.logs, ['telegram aba-1: chamado calado saiu']);
    assert.deepEqual(k2.e.tg.saida, []);

    // herdar: a aba-1 (limpar [905, 70]; o 905 deu 429) fecha e a fala vai pra aba-2, que ja tem o 70 no limpar
    let n905 = 0;
    const k3 = novo({ roteiro: { apagar: (id) => (id === 905 && n905++ === 0 ? R429 : undefined) } });
    await respondida(k3, 'aba-1', 70, [905]);
    tocar(k3, 'aba-1');
    await k3.canal.drenar(k3.e);
    assert.deepEqual(k3.e.tg.chamados['aba-1'].limpar, [{ messageId: 905, voz: true }, { messageId: 70, dono: true }]);
    k3.canal.aviso(k3.e, parou('aba-2'), 'Aba 2');
    k3.e.tg.chamados['aba-2'].limpar = [{ messageId: 70, dono: true }];
    k3.canal.falaRecebida(k3.e, { sessionId: 'aba-2', titulo: 'Aba 2', fala: 'segue aqui', hora: iso(T0 + 3 * MIN), messageIdDono: 90, herdarDe: 'aba-1' });
    assert.equal(k3.e.tg.chamados['aba-1'], undefined);
    assert.deepEqual(k3.e.tg.chamados['aba-2'].limpar, [{ messageId: 70, dono: true }, { messageId: 905, voz: true }], 'veio o 905; o 70 nao repete');
    k3.tg.chamadas.length = 0;
    k3.relogio.t += 2 * 1000;
    await k3.canal.drenar(k3.e);
    assert.deepEqual(passos(k3.tg), [['apagar', 70], ['apagar', 905]]);
    assert.equal(k3.e.tg.chamados['aba-2'].limpar, undefined);
    assert.deepEqual(k3.e.tg.saida, []);

    // painel sem dados e situacao sem aba: limpam antes de sair da fila; id de pedido de OK e entrada torta saem sem a API
    const k5 = novo();
    k5.e.tg.painel.limpar = [{ messageId: 7001, dono: true }, { messageId: 70, dono: true }];
    k5.e.tg.situacao.limpar = [{ messageId: 'x', dono: true }, { messageId: 905, voz: true }];
    k5.e.tg.saida.push({ sessionId: 'painel', entrouEm: iso(T0), falhas: 0 }, { sessionId: 'situacao', entrouEm: iso(T0), falhas: 0 });
    await k5.canal.drenar(k5.e, { idsDeFora: [7001] });
    assert.deepEqual(passos(k5.tg), [['apagar', 70], ['apagar', 905]]);
    assert.equal(k5.e.tg.painel.limpar, undefined);
    assert.equal(k5.e.tg.situacao.limpar, undefined);
    assert.deepEqual(k5.e.tg.saida, []);
    temLogs(k5.logs, [
      'telegram painel: mensagem 7001 e de um pedido de OK; sai do limpar sem apagar',
      'telegram painel: mensagem 70 do dono apagada (conversa resolvida)',
      'telegram painel saiu da fila (nenhum painel)',
      'telegram situacao: voz 905 apagada (conversa resolvida)',
      'telegram situacao saiu da fila (nenhuma situacao na tela)',
    ]);

    // do disco: entrada torta sai (sem repetir id; vazia = sem a lista)
    const tortas =[null, 5, { messageId: 0, dono: true }, { messageId: 'x', voz: true }, { messageId: 71 }, { messageId: 72, voz: true, dono: true }, { messageId: 73, voz: 'sim' }];
    const boas = [{ messageId: 906, voz: true }, { messageId: '70', dono: true }, { messageId: 70, dono: true }];
    const limpos = [{ messageId: 906, voz: true }, { messageId: 70, dono: true }];
    const base = tgNovo();
    const lido = completarTg({
      ...base,
      sistema: { ...base.sistema, limpar: [...tortas, ...boas] },
      painel: { ...base.painel, limpar: boas },
      situacao: { ...base.situacao, limpar: tortas },
      chamados: { 'aba-1': { versao: { id: 1, estado: 'enviando' }, mensagem: null, apagar: [], limpar: [...tortas, ...boas] }, 'aba-2': { limpar: tortas } },
    });
    assert.deepEqual(lido.sistema.limpar, limpos);
    assert.deepEqual(lido.painel.limpar, limpos);
    assert.equal('limpar' in lido.situacao, false);
    assert.deepEqual(lido.chamados['aba-1'].limpar, limpos);
    assert.equal('limpar' in lido.chamados['aba-2'], false);
    assert.equal('limpar' in completarTg(base).sistema, false);

    // resolvidas: undefined = 'apagar'; 'apagar' e 'manter'; o resto = TypeError
    for (const resolvidas of ['', 'APAGAR', 'sim', null, 0, true, {}]) {
      assert.throws(() => criarCanalTelegram({ tg: dubleTg(), chatId: DONO, resolvidas }), { name: 'TypeError', message: 'criarCanalTelegram: resolvidas invalido' }, String(resolvidas));
    }
    for (const resolvidas of [undefined, 'apagar', 'manter']) assert.equal(typeof criarCanalTelegram({ tg: dubleTg(), chatId: DONO, resolvidas }).drenar, 'function');

    // manter (T23b: o toque so tira os botoes da tela) e nada mais; limpar que volte do disco sai sem chamar a API
    const k4 = novo({ resolvidas: 'manter' });
    await respondida(k4, 'aba-1', 70, [905]);
    tocar(k4, 'aba-1');
    k4.tg.chamadas.length = 0;
    await k4.canal.drenar(k4.e);
    assert.deepEqual(passos(k4.tg), [['editarBotoes', 501]]);
    assert.equal(k4.e.tg.mensagens['905'].voz, true);
    const c4 = k4.e.tg.chamados['aba-1'];
    assert.equal(c4.limpar, undefined);
    c4.limpar = [{ messageId: 905, voz: true }, { messageId: 70, dono: true }];
    k4.canal.entregue(k4.e, 'aba-1', iso(T0 + 3 * MIN));
    await k4.canal.drenar(k4.e);
    assert.deepEqual(passos(k4.tg), [['editarBotoes', 501]], 'no manter nada do limpar e apagado');
    assert.equal(c4.limpar, undefined);
    assert.deepEqual(k4.e.tg.saida, []);
    temLogs(k4.logs, ['telegram aba-1: voz 905 fica no chat (modo manter)', 'telegram aba-1: mensagem 70 do dono fica no chat (modo manter)']);
  });

  // revisao da T23a (principal): o calar de chamado sem tela e sem apagar saia na hora e perdia o limpar pendente
  test('T23a 8. calar sem tela e sem apagar, com o limpar pendente (429 no meio da limpeza): o calado fica ate a lista esvaziar', async () => {
    let n905 = 0;
    const k = novo({ roteiro: { apagar: (id) => (id === 905 && n905++ === 0 ? R429 : undefined) } });
    await respondida(k, 'aba-1', 70, [905]);
    tocar(k, 'aba-1');
    await k.canal.drenar(k.e);
    const c = k.e.tg.chamados['aba-1'];
    assert.equal(c.mensagem, null, 'a tela tocada saiu');
    assert.deepEqual(c.apagar, []);
    assert.deepEqual(c.limpar, [{ messageId: 905, voz: true }, { messageId: 70, dono: true }]);
    k.canal.calar(k.e, 'aba-1');
    assert.ok(k.e.tg.chamados['aba-1'], 'com o limpar pendente o calado nao sai na hora');
    k.tg.chamadas.length = 0;
    k.relogio.t += 2 * 1000;
    await k.canal.drenar(k.e);
    assert.deepEqual(passos(k.tg), [['apagar', 905], ['apagar', 70]]);
    assert.equal(k.e.tg.chamados['aba-1'], undefined, 'lista vazia: o calado some');
    assert.deepEqual(k.e.tg.saida, []);
    temLogs(k.logs, ['telegram aba-1: chamado calado saiu']);
  });

  // revisao da T23a (principal): a ordem da lista e o "sem repetir id" do que a conversa resolvida poe no limpar
  test('T23a 9. limpar pendente (sobra de um 429) + toque: o apagarJa vem antes; a conversa resolvida entra no COMECO do limpar, sem repetir o id que ja esta nele; situacao sem aba: o apagarJa antes do limpar', async () => {
    const k = novo();
    const { canal, tg, e } = k;
    await respondida(k, 'aba-1', 70, [905]); // 501 em cima de 70
    const c = e.tg.chamados['aba-1'];
    c.limpar = [{ messageId: 999, voz: true }, { messageId: 70, dono: true }]; // sobra de antes, ja com o 70
    tocar(k, 'aba-1');
    tg.chamadas.length = 0;
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['apagar', 501], ['apagar', 905], ['apagar', 999], ['apagar', 70]], 'a tela tocada; a voz no comeco; o 70 uma vez so');
    assert.equal(c.limpar, undefined);
    assert.deepEqual(e.tg.saida, []);

    const k2 = novo();
    k2.e.tg.situacao.apagarJa = [601];
    k2.e.tg.situacao.limpar = [{ messageId: 906, voz: true }];
    k2.e.tg.saida.push({ sessionId: 'situacao', entrouEm: iso(T0), falhas: 0 });
    await k2.canal.drenar(k2.e);
    assert.deepEqual(passos(k2.tg), [['apagar', 601], ['apagar', 906]]);
    assert.equal(k2.e.tg.situacao.limpar, undefined);
    assert.deepEqual(k2.e.tg.saida, []);
  });
});

describe('T23b. modo "manter": nada da conversa e apagado; a mensagem do robo so perde os botoes', () => {
  const FALA_A = 'A) Sim, tudo hoje (recomendado)';
  const VELHA = { ok: false, velha: true };
  const NAO_MUDOU = { ok: false, erro: 'editarBotoes: Bad Request: message is not modified', codigo: 400 };
  const R400 = { ok: false, erro: "editarBotoes: Bad Request: message can't be edited", codigo: 400 };
  const R429 = { ok: false, erro: 'editarBotoes: Too Many Requests: retry after 1', codigo: 429, esperarS: 1 };
  const manter = (opcoes = {}) => novo({ ...opcoes, resolvidas: 'manter' });
  // roteiro do editarBotoes por id: respostas[id] = lista (cada chamada consome 1; vazia ou ausente = ok)
  const botoesPorId = (respostas) => ({ editarBotoes: (id) => (Array.isArray(respostas[id]) && respostas[id].length ? respostas[id].shift() : undefined) });
  const nadaApagado = (tg) => assert.ok(!tg.chamadas.some((x) => x.metodo === 'apagar'), `nenhum apagar: ${JSON.stringify(passos(tg))}`);
  const temLogs = (logs, lista) => {
    for (const l of lista) assert.ok(logs.includes(l), `${l}\n---\n${logs.join('\n')}`);
  };
  // registros do robo de uma aba sem chamado (o que o chamado novo encontra no t.mensagens)
  const registrar = (e, sid, ids, extra = {}) => {
    for (const id of ids) e.tg.mensagens[id] = { sessionId: sid, at: iso(T0), formato: 'rich', ...extra };
  };
  const ficou = (id, sid = 'aba-1') => `telegram ${sid}: mensagem ${id} fica no chat sem os botoes (modo manter)`;

  test('T23b 1. toque: aviso 501 -> fala 70 (no anel) -> resposta 502 em cima de 70 (o aviso so perde os botoes) + voz 905 em cima de 70 -> toque numa opcao: drenar = [editarBotoes 502] e nenhum apagar; a tela fica (fica: true), a voz e o 70 ficam, o limpar nunca nasce; a resposta seguinte desce como mensagem nova', async () => {
    const { canal, tg, e, logs } = manter();
    canal.aviso(e, parou('aba-1'), 'Aba');
    await canal.drenar(e); // 501, com os botoes da DECISAO
    canal.mensagemDoDono(e, 70);
    canal.falaRecebida(e, { sessionId: 'aba-1', titulo: 'Aba', fala: 'faz só as correções', hora: iso(T0 + MIN), messageIdDono: 70 });
    canal.resposta(e, parou('aba-1'), 'Aba', { citar: 70 });
    await canal.drenar(e);
    const c = e.tg.chamados['aba-1'];
    assert.equal(c.mensagem.messageId, 502);
    assert.equal(tg.chamadas.at(-2).args[0].responderA, 70);
    assert.deepEqual(passos(tg).slice(-2), [['enviar', false], ['editarBotoes', 501]], 'a nova e depois a antiga sem os botoes');
    assert.deepEqual(tg.chamadas.at(-1).args, [501, null]);
    assert.deepEqual(e.tg.mensagens['501'], { sessionId: 'aba-1', at: iso(T0), formato: 'rich', fica: true });
    canal.vozEnviada(e, 'aba-1', 905, { citar: 70 });
    const antes = tg.chamadas.length;
    canal.falaRecebida(e, { sessionId: 'aba-1', titulo: 'Aba', fala: FALA_A, hora: iso(T0 + 2 * MIN), toque: true });
    assert.deepEqual(c.apagarJa, [502]);
    await canal.drenar(e);
    assert.deepEqual(passos(tg).slice(antes), [['editarBotoes', 502]]);
    assert.deepEqual(tg.chamadas[antes].args, [502, null]);
    assert.deepEqual(e.tg.mensagens['502'], { sessionId: 'aba-1', at: iso(T0), formato: 'rich', citar: 70, fica: true }, 'a tela tocada fica no chat, sem os botoes');
    assert.deepEqual(e.tg.mensagens['905'], { sessionId: 'aba-1', at: iso(T0), formato: 'texto', voz: true, citar: 70 }, 'a voz fica');
    assert.equal(c.apagarJa, undefined);
    assert.equal(c.mensagem, null);
    assert.equal(c.limpar, undefined, 'no manter o limpar nunca ganha item');
    assert.deepEqual(e.tg.saida, []);
    canal.resposta(e, parou('aba-1', 'Feito.'), 'Aba');
    await canal.drenar(e);
    assert.deepEqual(passos(tg).slice(antes), [['editarBotoes', 502], ['enviar', false]], 'a resposta desce como mensagem nova; a tela tocada nao e mexida');
    nadaApagado(tg);
    assert.equal(c.limpar, undefined);
    temLogs(logs, [ficou(501), ficou(502)]);
  });

  test('T23b 2. versao nova: [enviar a nova, editarBotoes da antiga] e nenhum apagar no chamado, no sistema, no painel e na situacao (o limpar nao nasce); com a antiga de 48 h (o duble devolve velha no apagar) igual, sem editar de "movido"', async () => {
    for (const velha of [false, true]) {
      const { canal, tg, e, logs } = manter(velha ? { roteiro: { apagar: () => VELHA } } : {});
      canal.mensagemDoDono(e, 70);
      canal.mensagemDoDono(e, 80);
      canal.aviso(e, parou('aba-1'), 'Aba');
      canal.sistema(e, 'Linha 1.', { citar: 70 });
      canal.painel(e, DADOS, { citar: 90 });
      canal.situacao(e, 'S1', DS);
      await canal.drenar(e);
      assert.deepEqual(e.tg.saida, []);
      const antigas = [e.tg.chamados['aba-1'], e.tg.sistema, e.tg.painel, e.tg.situacao].map((d) => d.mensagem.messageId);
      const [aba, sis, pai, sit] = antigas;
      tg.chamadas.length = 0;
      canal.resposta(e, parou('aba-1', 'Feito.'), 'Aba');
      canal.sistema(e, 'Linha 2.', { citar: 80 });
      canal.painel(e, { ...DADOS, abertas: 9 }, { citar: 91 });
      canal.situacao(e, 'S1', { ...DS, final: 'Rodando a segunda bateria.' });
      await canal.drenar(e);
      assert.deepEqual(passos(tg), [
        ['enviar', false], ['editarBotoes', aba], ['enviar', true], ['editarBotoes', sis],
        ['enviar', true], ['editarBotoes', pai], ['enviar', true], ['editarBotoes', sit],
      ], `velha ${velha}`);
      for (const x of tg.chamadas.filter((y) => y.metodo === 'editarBotoes')) assert.equal(x.args[1], null);
      for (const id of antigas) assert.equal(e.tg.mensagens[id].fica, true, `${id} fica no chat (velha ${velha})`);
      assert.equal(e.tg.sistema.limpar, undefined, 'a linha antiga estava em cima de 70 (no anel): o manter nao limpa');
      assert.deepEqual(e.tg.saida, []);
      temLogs(logs, [ficou(aba), ficou(sis, 'sistema'), ficou(pai, 'painel'), ficou(sit, 'situacao')]);
    }
  });

  test('T23b 3. calado: o que era dele (a tela 502 e a antiga 501, presa no apagar por um 429) perde os botoes em ordem e o chamado sai; nenhum apagar', async () => {
    const { canal, tg, e, logs, relogio } = manter({ roteiro: botoesPorId({ 501: [R429] }) });
    canal.aviso(e, parou('aba-1'), 'Aba');
    await canal.drenar(e); // 501
    canal.resposta(e, parou('aba-1', 'Feito.'), 'Aba');
    await canal.drenar(e); // 502; a 501 da 429 no editarBotoes e fica no apagar
    const c = e.tg.chamados['aba-1'];
    assert.deepEqual(c.apagar.map((a) => a.messageId), [501]);
    canal.calar(e, 'aba-1');
    assert.deepEqual(c.apagar.map((a) => a.messageId), [502, 501]);
    tg.chamadas.length = 0;
    relogio.t += 2 * 1000;
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['editarBotoes', 502], ['editarBotoes', 501]]);
    assert.equal(e.tg.chamados['aba-1'], undefined, 'o calado sai');
    assert.deepEqual(e.tg.saida, []);
    assert.equal(e.tg.mensagens['501'].fica, true);
    assert.equal(e.tg.mensagens['502'].fica, true);
    temLogs(logs, [ficou(502), ficou(501), 'telegram aba-1: chamado calado saiu']);
  });

  test('T23b 4. sobras: o chamado novo nao leva o registro com fica: true (nos 2 modos); o sem fica (estado de antes) vai e, no manter, so perde os botoes', async () => {
    for (const resolvidas of ['manter', 'apagar']) {
      const { canal, tg, e, logs } = novo({ resolvidas });
      registrar(e, 'aba-1', [601], { fica: true });
      registrar(e, 'aba-1', [602]);
      canal.aviso(e, parou('aba-1'), 'Aba');
      assert.deepEqual(e.tg.chamados['aba-1'].apagar, [{ messageId: 602, doBot: true, formato: 'rich' }], resolvidas);
      await canal.drenar(e);
      assert.deepEqual(passos(tg).slice(1), [[resolvidas === 'manter' ? 'editarBotoes' : 'apagar', 602]], resolvidas);
      assert.deepEqual(e.tg.mensagens['601'], { sessionId: 'aba-1', at: iso(T0), formato: 'rich', fica: true }, `${resolvidas}: o que ficou no chat nao e mexido`);
      if (resolvidas === 'manter') {
        assert.equal(e.tg.mensagens['602'].fica, true);
        temLogs(logs, [ficou(602)]);
      } else {
        assert.equal(e.tg.mensagens['602'], undefined);
      }
      assert.deepEqual(e.tg.saida, []);
    }
  });

  test('T23b 5. respostas do editarBotoes: "not modified" = ok; 400 = sai, fica e log; 429 = fica na lista e o drenar seguinte tira (apagar e apagarJa); adaptador sem editarBotoes = sai, fica e log', async () => {
    const k = manter({ roteiro: botoesPorId({ 601: [NAO_MUDOU], 602: [R400], 603: [R429] }) });
    registrar(k.e, 'aba-1', [601, 602, 603, 604]);
    k.canal.aviso(k.e, parou('aba-1'), 'Aba');
    await k.canal.drenar(k.e);
    assert.deepEqual(passos(k.tg).slice(1), [['editarBotoes', 601], ['editarBotoes', 602], ['editarBotoes', 603]], 'o 429 para o drenar');
    const c = k.e.tg.chamados['aba-1'];
    assert.deepEqual(c.apagar.map((a) => a.messageId), [603, 604], 'o do 429 fica no comeco');
    assert.equal(k.e.tg.mensagens['601'].fica, true, '"not modified" = ok');
    assert.equal(k.e.tg.mensagens['602'].fica, true, '400 = fica no chat');
    assert.equal(k.e.tg.mensagens['603'].fica, undefined, '429: ainda nao');
    assert.deepEqual(k.e.tg.saida.map((i) => i.sessionId), ['aba-1']);
    assert.ok(k.logs.some((l) => l.includes('429 no editarBotoes')), k.logs.join('\n'));
    k.relogio.t += 2 * 1000;
    await k.canal.drenar(k.e);
    assert.deepEqual(passos(k.tg).slice(4), [['editarBotoes', 603], ['editarBotoes', 604]]);
    assert.deepEqual(c.apagar, []);
    assert.deepEqual(k.e.tg.saida, []);
    for (const id of [603, 604]) assert.equal(k.e.tg.mensagens[id].fica, true);
    nadaApagado(k.tg);
    temLogs(k.logs, [ficou(601), "telegram aba-1: tirar os botoes da mensagem 602 recusado (editarBotoes: Bad Request: message can't be edited); fica no chat", ficou(603), ficou(604)]);

    // o toque com 429: a tela fica no apagarJa e o drenar seguinte tira os botoes
    const k2 = manter({ roteiro: botoesPorId({ 501: [R429] }) });
    k2.canal.aviso(k2.e, parou('aba-1'), 'Aba');
    await k2.canal.drenar(k2.e); // 501
    k2.canal.falaRecebida(k2.e, { sessionId: 'aba-1', titulo: 'Aba', fala: FALA_A, hora: iso(T0 + MIN), toque: true });
    await k2.canal.drenar(k2.e);
    assert.deepEqual(k2.e.tg.chamados['aba-1'].apagarJa, [501]);
    k2.relogio.t += 2 * 1000;
    await k2.canal.drenar(k2.e);
    assert.deepEqual(passos(k2.tg).slice(1), [['editarBotoes', 501], ['editarBotoes', 501]]);
    assert.equal(k2.e.tg.chamados['aba-1'].apagarJa, undefined);
    assert.equal(k2.e.tg.mensagens['501'].fica, true);
    assert.deepEqual(k2.e.tg.saida, []);
    nadaApagado(k2.tg);

    // adaptador sem editarBotoes (fora do ensaio): sai, fica e log, nas sobras e no toque
    const k3 = manter();
    delete k3.tg.editarBotoes;
    registrar(k3.e, 'aba-1', [602]);
    k3.canal.aviso(k3.e, parou('aba-1'), 'Aba');
    await k3.canal.drenar(k3.e); // 501; a sobra 602 sai sem chamar a API
    k3.canal.falaRecebida(k3.e, { sessionId: 'aba-1', titulo: 'Aba', fala: FALA_A, hora: iso(T0 + MIN), toque: true });
    await k3.canal.drenar(k3.e);
    assert.deepEqual(passos(k3.tg).map((p) => p[0]), ['enviar']);
    const c3 = k3.e.tg.chamados['aba-1'];
    assert.deepEqual(c3.apagar, []);
    assert.equal(c3.apagarJa, undefined);
    assert.equal(k3.e.tg.mensagens['602'].fica, true);
    assert.equal(k3.e.tg.mensagens['501'].fica, true);
    assert.deepEqual(k3.e.tg.saida, []);
    temLogs(k3.logs, [
      'telegram aba-1: mensagem 602 fica no chat com os botoes (adaptador sem editarBotoes)',
      'telegram aba-1: mensagem 501 fica no chat com os botoes (adaptador sem editarBotoes)',
    ]);
  });

  test('T23b 6. iguais nos 2 modos: o /start do toque no painel e apagado; a sonda apaga a duplicata provada; pedido de OK e mensagem do dono saem sem chamar a API', async () => {
    for (const resolvidas of ['manter', 'apagar']) {
      const k = novo({ resolvidas });
      k.canal.apagarToque(k.e, 95);
      k.canal.situacao(k.e, 'S1', DS);
      await k.canal.drenar(k.e);
      assert.deepEqual(passos(k.tg), [['apagar', 95], ['enviar', true]], `${resolvidas}: o /start sai do chat`);
      assert.ok(k.logs.some((l) => l.includes('mensagem 95 do dono apagada (o /start do toque no painel)')), k.logs.join('\n'));

      // a sonda do envio incerto: a duplicata provada do robo e apagada
      const logs = [];
      const tg = dubleTg();
      const canal = criarCanalTelegram({ tg, chatId: DONO, log: (m) => logs.push(m), agora: () => T0, rand: randFixo(), sondar: true, resolvidas });
      const e = { tg: tgNovo() };
      canal.aviso(e, parou('aba-1'), 'Aba');
      await canal.drenar(e); // 501
      e.tg.chamados['aba-1'].apagar.push({ messageId: 600, sondar: true });
      e.tg.saida.push({ sessionId: 'aba-1', entrouEm: iso(T0), falhas: 0 });
      tg.chamadas.length = 0;
      await canal.drenar(e);
      assert.deepEqual(passos(tg), [['editarBotoes', 600], ['apagar', 600]], `${resolvidas}: a sonda prova e apaga`);
      assert.deepEqual(e.tg.chamados['aba-1'].apagar, []);
      assert.deepEqual(e.tg.saida, []);
      temLogs(logs, ['telegram aba-1: id 600 e do bot (sonda): vai pro apagar']);

      // pedido de OK (no apagarJa e no apagar) e a mensagem do dono no apagar: saem sem chamar a API
      const k2 = novo({ resolvidas });
      k2.canal.aviso(k2.e, parou('aba-1'), 'Aba');
      await k2.canal.drenar(k2.e); // 501
      const c = k2.e.tg.chamados['aba-1'];
      c.apagarJa = [7001];
      c.apagar.push({ messageId: 7002, doBot: true, formato: 'rich' }, { messageId: 70 });
      k2.e.tg.saida.push({ sessionId: 'aba-1', entrouEm: iso(T0), falhas: 0 });
      k2.tg.chamadas.length = 0;
      await k2.canal.drenar(k2.e, { idsDeFora: [7001, 7002] });
      assert.deepEqual(passos(k2.tg), [], `${resolvidas}: nenhuma chamada`);
      assert.equal(c.apagarJa, undefined);
      assert.deepEqual(c.apagar, []);
      assert.deepEqual(k2.e.tg.saida, []);
      temLogs(k2.logs, [
        'telegram aba-1: mensagem 7001 e de um pedido de OK; sai do apagarJa sem apagar',
        'telegram aba-1: mensagem 7002 e de um pedido de OK; sai da lista sem sondar nem apagar',
        'telegram aba-1: mensagem 70 do dono fica no chat (F1); sai da lista sem apagar',
      ]);
    }
  });
});

// ---------- T26b1: o OK dentro do chamado da aba ----------

describe('T26b1 — o OK dentro do chamado da aba (c.ok)', () => {
  const COD = 'ABC234';
  const COD2 = 'DEF567';
  const pedidoOk = (codigo = COD, extra = {}) => ({
    v: 1,
    codigo,
    sessionId: 'aba-1',
    titulo: 'Aba',
    tipo: 'publicacao',
    acao: 'subir o site <pid> & X em produção',
    destinatarios: null,
    criadoEm: iso(T0),
    expiraEm: iso(T0 + 30 * MIN),
    status: 'pendente',
    ...extra,
  });
  const blocoDe = (p) => ({ compacto: montarBlocoOk(p), completo: montarBlocoOk({ ...p, completo: true }) });
  const okDe = (codigo = COD) => ({ cod: codigo, bloco: blocoDe(pedidoOk(codigo)), titulo: 'Aba', nome: 'aba' });
  // o telegram.mjs real: sem html = sai no classico
  const soClassico = () => {
    let n = 600;
    return { enviar: (p) => (p.html ? undefined : { ok: true, messageId: ++n, formato: 'classico' }) };
  };
  const cabecalho = montarChamado({ estado: 'ok', titulo: 'Aba' }).classico;
  const aberto = (ok, extra = {}) => ({ bloco: ok.bloco, completo: false, toque: null, fechado: null, ...extra });

  test('okAbriu sem chamado: 1 enviar classico (cabecalho + bloco compacto), com notificacao, no COMECO da fila; mesmo cod = nada muda; outro cod = substituido', async () => {
    const { canal, tg, e } = novo({ roteiro: soClassico() });
    canal.aviso(e, parou('aba-2'), 'Outra');
    const ok = okDe();
    assert.deepEqual(canal.okAbriu(e, 'aba-1', ok), { aceito: true, substituido: null });
    const c = e.tg.chamados['aba-1'];
    assert.equal(c.versao.estado, 'ok');
    assert.equal(c.versao.titulo, 'Aba');
    assert.equal(c.versao.nome, 'aba');
    assert.equal(c.versao.hora, iso(T0));
    assert.deepEqual(
      { cod: c.ok.cod, completo: c.ok.completo, toque: c.ok.toque, fechado: c.ok.fechado, notificar: c.ok.notificar, em: c.ok.em, naTelaEm: c.ok.naTelaEm },
      { cod: COD, completo: false, toque: null, fechado: null, notificar: true, em: iso(T0), naTelaEm: null },
    );
    assert.equal(c.descer, true);
    assert.deepEqual(e.tg.saida.map((i) => i.sessionId), ['aba-1', 'aba-2']); // a aba do OK vai pro comeco
    assert.equal(tg.chamadas.length, 0);

    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false], ['enviar', false]]);
    const p = tg.chamadas[0].args[0];
    assert.equal(p.html, undefined); // sem html: sai sempre no classico
    assert.equal(p.classico, `${cabecalho}\n\n${esc(ok.bloco.compacto.texto)}`);
    assert.deepEqual(p.botoes, ok.bloco.compacto.botoes);
    assert.equal(p.responderA, undefined);
    assert.deepEqual(c.mensagem, { messageId: 601, formato: 'classico', versaoId: c.versao.id, ok: COD });
    assert.equal(c.ok.notificar, false);
    assert.equal(c.ok.naTelaEm, iso(T0));
    assert.equal(canal.okNaMensagem(e, 601), COD);
    assert.equal(canal.okNaMensagem(e, 502), null); // a tela de outra aba (sem OK)

    // mesmo cod = aceito, nada muda
    const antes = JSON.stringify(e.tg);
    assert.deepEqual(canal.okAbriu(e, 'aba-1', ok), { aceito: true, substituido: null });
    assert.equal(JSON.stringify(e.tg), antes);

    // outro OK aberto sem toque = substituido; mensagem nova com o bloco novo e a antiga apagada
    const ok2 = okDe(COD2);
    assert.deepEqual(canal.okAbriu(e, 'aba-1', ok2), { aceito: true, substituido: COD });
    assert.equal(c.ok.cod, COD2);
    await canal.drenar(e);
    assert.deepEqual(passos(tg).slice(2), [['enviar', false], ['apagar', 601]]);
    assert.equal(tg.chamadas[2].args[0].classico, `${cabecalho}\n\n${esc(ok2.bloco.compacto.texto)}`);
    assert.deepEqual(c.mensagem, { messageId: 602, formato: 'classico', versaoId: c.versao.id, ok: COD2 });
    assert.equal(canal.okNaMensagem(e, 601), null); // tela velha
    assert.equal(canal.okNaMensagem(e, 602), COD2);
    assert.deepEqual(e.tg.saida, []);
  });

  test('okAbriu com resposta na tela: mensagem NOVA (resposta sem os botoes das opcoes + bloco) em cima do citar, a antiga apagada depois; com a fala em voo (enviando): so cabecalho + bloco, com notificacao, em cima do citar; o entregue nao edita', async () => {
    const { canal, tg, e } = novo({ roteiro: soClassico() });
    canal.resposta(e, parou('aba-1'), 'Aba', { citar: 77 });
    await canal.drenar(e); // 501 rich
    const c = e.tg.chamados['aba-1'];
    const vAntes = c.versao.id;
    const ok = okDe();
    assert.deepEqual(canal.okAbriu(e, 'aba-1', ok), { aceito: true, substituido: null });
    assert.equal(c.versao.estado, 'resposta');
    assert.notEqual(c.versao.id, vAntes);
    assert.equal(c.descer, true);
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false], ['enviar', false], ['apagar', 501]]); // nova antes do apagar; nunca edicao
    const p = tg.chamadas[1].args[0];
    assert.equal(p.html, undefined);
    assert.equal(p.responderA, 77);
    const esperado = montarChamadoComOk(c.versao, aberto(ok));
    assert.equal(p.classico, esperado.classico);
    assert.ok(p.classico.endsWith(`\n\n${esc(ok.bloco.compacto.texto)}`));
    assert.ok(p.classico.includes('Só as correções')); // as opcoes em texto
    assert.deepEqual(p.botoes, ok.bloco.compacto.botoes); // sem os botoes das opcoes
    assert.deepEqual(c.mensagem, { messageId: 601, formato: 'classico', versaoId: c.versao.id, ok: COD });
    assert.deepEqual(c.apagar, []);

    // a fala dele em voo (enviando): a mensagem sai mesmo assim (nao vai pro passoSemTela)
    const b = novo({ roteiro: soClassico() });
    b.canal.aviso(b.e, parou('aba-1'), 'Aba');
    await b.canal.drenar(b.e); // 501 rich
    b.canal.falaRecebida(b.e, { sessionId: 'aba-1', fala: 'faz', audio: false, hora: iso(T0), messageIdDono: 88 });
    await b.canal.drenar(b.e); // editarBotoes 501
    const cb = b.e.tg.chamados['aba-1'];
    assert.equal(cb.versao.estado, 'enviando');
    assert.deepEqual(b.canal.okAbriu(b.e, 'aba-1', ok), { aceito: true, substituido: null });
    await b.canal.drenar(b.e);
    assert.deepEqual(passos(b.tg), [['enviar', false], ['editarBotoes', 501], ['enviar', false], ['apagar', 501]]);
    const pb = b.tg.chamadas[2].args[0];
    assert.equal(pb.html, undefined);
    assert.equal(pb.silencioso, false); // o enviando e silencioso; o OK notifica
    assert.equal(pb.responderA, 88);
    assert.equal(pb.classico, `${cabecalho}\n\n${esc(ok.bloco.compacto.texto)}`);
    assert.deepEqual(cb.mensagem, { messageId: 601, formato: 'classico', versaoId: cb.versao.id, ok: COD });
    b.canal.entregue(b.e, 'aba-1', iso(T0 + MIN));
    await b.canal.drenar(b.e);
    assert.equal(b.tg.chamadas.length, 4); // o entregue nao mexe na tela do OK
    assert.deepEqual(b.e.tg.saida, []);
  });

  test('juncao: resposta ate 60 s depois do naTelaEm = 1 editar da mesma mensagem (resposta + bloco), nenhum enviar; a 61 s = enviar novo com notificacao e a antiga apagada', async () => {
    const { canal, tg, e, relogio } = novo({ roteiro: soClassico() });
    const ok = okDe();
    canal.okAbriu(e, 'aba-1', ok);
    await canal.drenar(e); // 601
    const c = e.tg.chamados['aba-1'];
    relogio.t = T0 + 60 * 1000;
    canal.resposta(e, parou('aba-1'), 'Aba');
    assert.equal(c.descer, false);
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false], ['editar', 601]]);
    const [id, pe] = tg.chamadas[1].args;
    assert.equal(id, 601);
    const esperado = montarChamadoComOk(c.versao, aberto(ok));
    assert.deepEqual(pe, { html: undefined, classico: esperado.classico, botoes: ok.bloco.compacto.botoes, formato: 'classico' });
    assert.ok(pe.classico.includes('Só as correções'));
    assert.deepEqual(c.mensagem, { messageId: 601, formato: 'classico', versaoId: c.versao.id, ok: COD });

    relogio.t = T0 + 61 * 1000;
    canal.resposta(e, parou('aba-1', 'Outra pergunta?'), 'Aba');
    assert.equal(c.descer, true);
    await canal.drenar(e);
    assert.deepEqual(passos(tg).slice(2), [['enviar', false], ['apagar', 601]]);
    const pn = tg.chamadas[2].args[0];
    assert.equal(pn.html, undefined);
    assert.equal(pn.classico, montarChamadoComOk(c.versao, aberto(ok)).classico);
    assert.ok(pn.classico.includes('Outra pergunta?'));
    assert.deepEqual(pn.botoes, ok.bloco.compacto.botoes);
    assert.deepEqual(c.mensagem, { messageId: 602, formato: 'classico', versaoId: c.versao.id, ok: COD });
    assert.equal(c.ok.naTelaEm, iso(T0)); // so a 1a vez
  });

  test('okInfo = 1 editar pro bloco completo (de novo = false); okToque sim = so editarBotoes(tela, null); okToque null = 1 editar com o mesmo texto e os botoes do bloco', async () => {
    const { canal, tg, e } = novo({ roteiro: soClassico() });
    canal.resposta(e, parou('aba-1'), 'Aba');
    await canal.drenar(e); // 501 rich
    const ok = okDe();
    canal.okAbriu(e, 'aba-1', ok);
    await canal.drenar(e); // 601 classico, apagar 501
    const c = e.tg.chamados['aba-1'];
    assert.equal(canal.okInfo(e, COD2), false);
    assert.equal(canal.okInfo(e, COD), true);
    assert.equal(c.ok.completo, true);
    await canal.drenar(e);
    assert.deepEqual(passos(tg).slice(3), [['editar', 601]]);
    const completo = montarChamadoComOk(c.versao, aberto(ok, { completo: true }));
    assert.deepEqual(tg.chamadas[3].args[1], { html: undefined, classico: completo.classico, botoes: ok.bloco.completo.botoes, formato: 'classico' });
    assert.ok(completo.classico.endsWith(`\n\n${esc(ok.bloco.completo.texto)}`));
    assert.notEqual(completo.classico, montarChamadoComOk(c.versao, aberto(ok)).classico); // a parte aberta
    assert.equal(canal.okInfo(e, COD), false);
    await canal.drenar(e);
    assert.equal(tg.chamadas.length, 4);

    assert.equal(canal.okToque(e, COD2, 'sim'), false);
    assert.equal(canal.okToque(e, COD, 'sim'), true);
    assert.equal(c.ok.toque.acao, 'sim');
    assert.equal(c.ok.toque.em, iso(T0));
    await canal.drenar(e);
    assert.deepEqual(tg.chamadas.slice(4), [{ metodo: 'editarBotoes', args: [601, null] }]); // nenhum editar de texto
    assert.equal(canal.okNaMensagem(e, 601), COD); // aberto (com toque) e na tela
    assert.equal(canal.okInfo(e, COD), false);

    assert.equal(canal.okToque(e, COD, null), true);
    assert.equal(c.ok.toque, null);
    await canal.drenar(e);
    assert.deepEqual(passos(tg).slice(5), [['editar', 601]]);
    assert.deepEqual(tg.chamadas[5].args[1], { html: undefined, classico: completo.classico, botoes: ok.bloco.completo.botoes, formato: 'classico' });
    assert.deepEqual(e.tg.saida, []);
  });

  test('okFechou some: com resposta = editar sem o bloco e com os botoes do chamado; so OK = apagar e o chamado sai; enviando = apagar com manterConversa e o chamado fica', async () => {
    const { canal, tg, e } = novo({ roteiro: soClassico() });
    canal.resposta(e, parou('aba-1'), 'Aba');
    await canal.drenar(e); // 501 rich
    canal.okAbriu(e, 'aba-1', okDe());
    await canal.drenar(e); // 601 classico, apagar 501
    const c = e.tg.chamados['aba-1'];
    assert.equal(canal.okFechou(e, COD2, { texto: 'x', some: true }), false);
    assert.equal(canal.okFechou(e, COD, { texto: 'x', some: true }), true);
    assert.equal(c.ok, undefined);
    await canal.drenar(e);
    assert.deepEqual(passos(tg).slice(3), [['editar', 601]]);
    const m = montarChamado(c.versao);
    assert.ok(m.botoes.length >= 3); // A, B e Mais informações
    assert.deepEqual(tg.chamadas[3].args[1], { html: m.html, classico: m.classico, botoes: m.botoes, formato: 'classico' });
    assert.deepEqual(c.mensagem, { messageId: 601, formato: 'classico', versaoId: c.versao.id });
    assert.equal(canal.okNaMensagem(e, 601), null);

    // so OK (versao 'ok'): a tela e apagada e o chamado sai (como o calado)
    const s = novo({ roteiro: soClassico() });
    s.canal.okAbriu(s.e, 'aba-1', okDe());
    await s.canal.drenar(s.e); // 601
    assert.equal(s.canal.okFechou(s.e, COD, { texto: 'x', some: true }), true);
    await s.canal.drenar(s.e);
    assert.deepEqual(passos(s.tg), [['enviar', false], ['apagar', 601]]);
    assert.equal(s.e.tg.chamados['aba-1'], undefined);
    assert.deepEqual(s.e.tg.saida, []);

    // versao enviando (a fala dele em voo): a tela vai pro apagar com manterConversa e o chamado fica
    const v = novo({ roteiro: soClassico() });
    v.canal.aviso(v.e, parou('aba-1'), 'Aba');
    await v.canal.drenar(v.e); // 501
    v.canal.falaRecebida(v.e, { sessionId: 'aba-1', fala: 'faz', audio: false, hora: iso(T0), messageIdDono: 88 });
    v.canal.okAbriu(v.e, 'aba-1', okDe());
    await v.canal.drenar(v.e); // 601, apagar 501
    const cv = v.e.tg.chamados['aba-1'];
    const n = v.tg.chamadas.length;
    assert.equal(v.canal.okFechou(v.e, COD, { texto: 'x', some: true }), true);
    assert.equal(cv.ok, undefined);
    assert.equal(cv.mensagem, null);
    assert.deepEqual(cv.apagar, [{ messageId: 601, doBot: true, formato: 'classico', manterConversa: true }]);
    await v.canal.drenar(v.e);
    assert.deepEqual(passos(v.tg).slice(n), [['apagar', 601]]);
    assert.equal(v.e.tg.chamados['aba-1'], cv); // o chamado fica
    assert.equal(cv.versao.estado, 'enviando');
    assert.deepEqual(v.e.tg.saida, []);
  });

  test('okFechou fecho (some false; some true no manter) = editar com o bloco fechado e sem botoes; a proxima mensagem nova nao leva o bloco fechado; OK que nunca chegou na tela sai sem mensagem', async () => {
    const { canal, tg, e } = novo({ roteiro: soClassico() });
    canal.okAbriu(e, 'aba-1', okDe());
    await canal.drenar(e); // 601
    const c = e.tg.chamados['aba-1'];
    const fechado = montarBlocoOkFechado({ ...pedidoOk(), linha: 'Aprovado às 12:01.' });
    assert.equal(canal.okFechou(e, COD, { texto: fechado, some: false }), true);
    assert.equal(c.ok.fechado, fechado);
    assert.equal(canal.okFechou(e, COD, { texto: fechado, some: false }), false); // ja fechado
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false], ['editar', 601]]);
    assert.deepEqual(tg.chamadas[1].args[1], { html: undefined, classico: `${cabecalho}\n\n${esc(fechado)}`, botoes: null, formato: 'classico' });
    assert.equal(c.mensagem.ok, COD);
    assert.equal(canal.okNaMensagem(e, 601), null); // fechado
    assert.equal(canal.okInfo(e, COD), false);
    assert.equal(canal.okToque(e, COD, 'sim'), false);

    // a proxima mensagem NOVA da aba nao leva o bloco fechado
    canal.resposta(e, parou('aba-1'), 'Aba');
    await canal.drenar(e);
    assert.deepEqual(passos(tg).slice(2), [['enviar', false], ['apagar', 601]]);
    const esperado = montarChamado(c.versao);
    assert.deepEqual(tg.chamadas[2].args[0], { ...esperado, silencioso: false });
    assert.equal(c.ok, undefined);
    assert.deepEqual(c.mensagem, { messageId: 502, formato: 'rich', versaoId: c.versao.id });

    // modo 'manter': o some vira fecho
    const k = novo({ roteiro: soClassico(), resolvidas: 'manter' });
    k.canal.okAbriu(k.e, 'aba-1', okDe());
    await k.canal.drenar(k.e); // 601
    assert.equal(k.canal.okFechou(k.e, COD, { texto: fechado, some: true }), true);
    assert.equal(k.e.tg.chamados['aba-1'].ok.fechado, fechado);
    await k.canal.drenar(k.e);
    assert.deepEqual(passos(k.tg), [['enviar', false], ['editar', 601]]);
    assert.equal(k.tg.chamadas[1].args[1].botoes, null);

    // nunca chegou na tela (ainda na fila): sai sem mensagem nenhuma
    const f = novo({ roteiro: soClassico() });
    f.canal.okAbriu(f.e, 'aba-1', okDe());
    assert.equal(f.canal.okFechou(f.e, COD, { texto: fechado, some: false }), true);
    assert.equal(f.e.tg.chamados['aba-1'], undefined);
    assert.deepEqual(f.e.tg.saida, []);
    await f.canal.drenar(f.e);
    assert.equal(f.tg.chamadas.length, 0);
    // com uma resposta na tela: o c.ok sai e a tela fica como estava
    f.canal.resposta(f.e, parou('aba-1'), 'Aba');
    await f.canal.drenar(f.e); // 501
    f.canal.okAbriu(f.e, 'aba-1', okDe());
    assert.equal(f.canal.okFechou(f.e, COD, { texto: 'x', some: true }), true);
    await f.canal.drenar(f.e);
    assert.equal(f.tg.chamadas.length, 1);
    const cf = f.e.tg.chamados['aba-1'];
    assert.equal(cf.ok, undefined);
    assert.equal(cf.descer, false);
    assert.equal(cf.mensagem.versaoId, cf.versao.id);
  });
});

// ---------- T26b2 (PLANO-TELEGRAM.md, "T26b2"): a tela trancada e as guardas ----------

describe('T26b2 — a tela trancada e as guardas do OK no canal', () => {
  const COD = 'ABC234';
  const COD2 = 'DEF567';
  const pedidoOk = (codigo = COD) => ({
    v: 1,
    codigo,
    sessionId: 'aba-1',
    titulo: 'Aba',
    tipo: 'publicacao',
    acao: 'subir o site <pid> & X em produção',
    destinatarios: null,
    criadoEm: iso(T0),
    expiraEm: iso(T0 + 30 * MIN),
    status: 'pendente',
  });
  const blocoDe = (p) => ({ compacto: montarBlocoOk(p), completo: montarBlocoOk({ ...p, completo: true }) });
  const okDe = (codigo = COD) => ({ cod: codigo, bloco: blocoDe(pedidoOk(codigo)), titulo: 'Aba', nome: 'aba' });
  const fechadoDe = (codigo = COD) => montarBlocoOkFechado({ ...pedidoOk(codigo), linha: 'Aprovado às 12:01.' });
  const aberto = (ok, extra = {}) => ({ bloco: ok.bloco, completo: false, toque: null, fechado: null, ...extra });
  // o telegram.mjs real: sem html = sai no classico. `gancho.f` (opcional) roda 1 vez DENTRO do proximo enviar (em voo)
  const soClassico = (gancho = null) => {
    let n = 600;
    return {
      enviar: (p) => {
        if (gancho && typeof gancho.f === 'function') {
          const f = gancho.f;
          gancho.f = null;
          f();
        }
        return p.html ? undefined : { ok: true, messageId: ++n, formato: 'classico' };
      },
    };
  };
  // resposta na tela (501 rich) e o OK por cima (601 classico: resposta + bloco; a 501 apagada)
  async function comOkNaTela({ gancho = null, resolvidas } = {}) {
    const x = novo({ roteiro: soClassico(gancho), resolvidas });
    x.canal.resposta(x.e, parou('aba-1'), 'Aba');
    await x.canal.drenar(x.e);
    x.ok = okDe();
    x.canal.okAbriu(x.e, 'aba-1', x.ok);
    await x.canal.drenar(x.e);
    x.c = x.e.tg.chamados['aba-1'];
    return x;
  }

  test('trancada: com a resposta nova esperando, o drenar so tira os botoes e apaga o que esta no apagar (nunca editar nem apagar a tela) e o item sai com 1 log; okAbriu = recusa sem mudar nada; depois do fecho a resposta sai', async () => {
    const { canal, tg, e, c, logs, relogio } = await comOkNaTela();
    assert.equal(canal.okToque(e, COD, 'sim'), true);
    relogio.t = T0 + 2 * MIN;
    canal.resposta(e, parou('aba-1', 'Outra pergunta?'), 'Aba');
    assert.equal(c.descer, true);
    c.apagar.push({ messageId: 450, doBot: true, formato: 'rich' });
    const n = tg.chamadas.length;
    const nLogs = logs.length;
    await canal.drenar(e);
    assert.deepEqual(passos(tg).slice(n), [['editarBotoes', 601], ['apagar', 450]]);
    assert.deepEqual(tg.chamadas[n].args, [601, null]);
    assert.deepEqual(e.tg.saida, []);
    assert.equal(logs.slice(nLogs).filter((l) => l.includes('trancada')).length, 1);
    assert.equal(c.mensagem.messageId, 601);
    assert.equal(c.mensagem.ok, COD);
    assert.equal(canal.okNaMensagem(e, 601), COD);
    // outra resposta: continua esperando, nenhuma chamada
    canal.resposta(e, parou('aba-1', 'Mais uma?'), 'Aba');
    await canal.drenar(e);
    assert.equal(tg.chamadas.length, n + 2);
    assert.deepEqual(e.tg.saida, []);
    // okAbriu de outro pedido com a tela trancada = recusa, nada muda
    const antes = JSON.stringify(e.tg);
    assert.deepEqual(canal.okAbriu(e, 'aba-1', okDe(COD2)), { aceito: false, motivo: 'trancada' });
    assert.equal(JSON.stringify(e.tg), antes);
    // o fecho poe a aba de volta na fila: a resposta sai (sem o bloco) e a tela trancada e apagada depois
    assert.equal(canal.okFechou(e, COD, { texto: fechadoDe(), some: false }), true);
    assert.deepEqual(e.tg.saida.map((i) => i.sessionId), ['aba-1']);
    await canal.drenar(e);
    assert.deepEqual(passos(tg).slice(n + 2), [['enviar', false], ['apagar', 601]]);
    assert.deepEqual(tg.chamadas[n + 2].args[0], { ...montarChamado(c.versao), silencioso: false });
    assert.equal(c.ok, undefined);
    assert.equal(c.mensagem.ok, undefined);
    assert.deepEqual(e.tg.saida, []);
  });

  test('trancada: okToque(null) poe a aba de volta na fila e a resposta que esperava sai com o bloco aberto e os botoes do OK', async () => {
    const { canal, tg, e, c, ok, relogio } = await comOkNaTela();
    canal.okToque(e, COD, 'sim');
    await canal.drenar(e); // editarBotoes 601
    relogio.t = T0 + 2 * MIN;
    canal.resposta(e, parou('aba-1', 'Outra pergunta?'), 'Aba');
    await canal.drenar(e); // trancada: nada
    const n = tg.chamadas.length;
    assert.equal(canal.okToque(e, COD, null), true);
    assert.deepEqual(e.tg.saida.map((i) => i.sessionId), ['aba-1']);
    await canal.drenar(e);
    assert.deepEqual(passos(tg).slice(n), [['enviar', false], ['apagar', 601]]);
    const p = tg.chamadas[n].args[0];
    assert.equal(p.html, undefined);
    assert.equal(p.classico, montarChamadoComOk(c.versao, aberto(ok)).classico);
    assert.ok(p.classico.includes('Outra pergunta?'));
    assert.deepEqual(p.botoes, ok.bloco.compacto.botoes);
    assert.deepEqual(c.mensagem, { messageId: 602, formato: 'classico', versaoId: c.versao.id, ok: COD });
  });

  test('telaComBotoes = false com a tela mostrando o OK: a falaRecebida (texto ou toque) nao tira os botoes do OK nem apaga a tela', async () => {
    const { canal, tg, e, c } = await comOkNaTela();
    const n = tg.chamadas.length;
    canal.falaRecebida(e, { sessionId: 'aba-1', fala: 'faz', audio: false, hora: iso(T0), messageIdDono: 88 });
    assert.equal(c.versao.estado, 'enviando');
    assert.equal(c.tirarBotoes, undefined);
    assert.equal(c.apagarJa, undefined);
    await canal.drenar(e);
    assert.equal(tg.chamadas.length, n);
    canal.falaRecebida(e, { sessionId: 'aba-1', fala: 'A', audio: false, hora: iso(T0), toque: true });
    assert.equal(c.apagarJa, undefined);
    assert.equal(c.tirarBotoes, undefined);
    assert.equal(c.mensagem.messageId, 601);
    await canal.drenar(e);
    assert.equal(tg.chamadas.length, n);
    assert.equal(canal.okNaMensagem(e, 601), COD);
  });

  test('encerrar e calar com o OK aberto = nada muda (1 log cada); com o OK fechado ele sai e o resto e o de hoje, byte a byte', async () => {
    const { canal, e, logs } = await comOkNaTela();
    const antes = JSON.stringify(e.tg);
    const nLogs = logs.length;
    canal.encerrar(e, 'aba-1', iso(T0), 'pc');
    canal.calar(e, 'aba-1');
    // T26d (conserto): o encerrar com o OK aberto fica guardado no chamado (o resto nao muda; o calar segue igual)
    assert.deepEqual(e.tg.chamados['aba-1'].encerrarDepois, { hora: iso(T0), motivo: 'pc' });
    delete e.tg.chamados['aba-1'].encerrarDepois;
    assert.equal(JSON.stringify(e.tg), antes);
    assert.equal(logs.length, nLogs + 2);
    assert.ok(logs.slice(nLogs).every((l) => l.includes('aba-1') && l.includes(COD)));
    // fechado na tela
    canal.okFechou(e, COD, { texto: fechadoDe(), some: false });
    await canal.drenar(e); // editar 601 com o bloco fechado
    for (const acao of ['encerrar', 'calar']) {
      const a = novo();
      a.e.tg = JSON.parse(JSON.stringify(e.tg));
      const b = novo();
      b.e.tg = JSON.parse(JSON.stringify(e.tg));
      delete b.e.tg.chamados['aba-1'].ok;
      delete b.e.tg.chamados['aba-1'].mensagem.ok;
      if (acao === 'encerrar') {
        a.canal.encerrar(a.e, 'aba-1', iso(T0), 'pc');
        b.canal.encerrar(b.e, 'aba-1', iso(T0), 'pc');
      } else {
        a.canal.calar(a.e, 'aba-1');
        b.canal.calar(b.e, 'aba-1');
      }
      assert.equal(a.e.tg.chamados['aba-1'].ok, undefined, acao);
      await a.canal.drenar(a.e);
      await b.canal.drenar(b.e);
      assert.ok(a.tg.chamadas.length > 0, acao);
      assert.deepEqual(a.tg.chamadas, b.tg.chamadas, acao);
      assert.equal(JSON.stringify(a.e.tg), JSON.stringify(b.e.tg), acao);
    }
  });

  test('herdar: a aba que fechou leva o OK embora; a tela dela vai pro apagar da nova (sem tirarBotoes nem apagarJa) e a nova nao herda OK', async () => {
    for (const toque of [false, true]) {
      const { canal, e } = await comOkNaTela();
      canal.falaRecebida(e, { sessionId: 'aba-2', fala: 'faz', audio: false, hora: iso(T0), messageIdDono: 90, herdarDe: 'aba-1', toque });
      assert.equal(e.tg.chamados['aba-1'], undefined);
      const c2 = e.tg.chamados['aba-2'];
      assert.equal(c2.ok, undefined);
      assert.deepEqual(c2.apagar, [{ messageId: 601, doBot: true, formato: 'classico' }]);
      assert.equal(c2.tirarBotoes, undefined);
      assert.equal(c2.apagarJa, undefined);
      assert.equal(canal.okNaMensagem(e, 601), null);
      assert.equal(canal.okToque(e, COD, 'sim'), false);
      assert.deepEqual(e.tg.saida.map((i) => i.sessionId), ['aba-2']);
    }
  });

  test('okSemTela: o OK aberto fora da tela (ou descendo) e fora da fila volta pro COMECO da fila, no maximo 1 vez por minuto por aba; na fila, na tela ou trancado = 0', async () => {
    const { canal, tg, e, relogio } = novo({ roteiro: soClassico() });
    canal.okAbriu(e, 'aba-1', okDe());
    assert.equal(canal.okSemTela(e), 0); // na fila
    await canal.drenar(e, { travado: true }); // sai sem enviar
    assert.deepEqual(e.tg.saida, []);
    canal.aviso(e, parou('aba-2'), 'Outra');
    assert.equal(canal.okSemTela(e), 1);
    assert.deepEqual(e.tg.saida.map((i) => i.sessionId), ['aba-1', 'aba-2']);
    assert.equal(canal.okSemTela(e), 0); // ja na fila
    await canal.drenar(e, { travado: true });
    assert.deepEqual(e.tg.saida, []);
    relogio.t = T0 + 59 * 1000;
    assert.equal(canal.okSemTela(e), 0); // menos de 1 minuto
    relogio.t = T0 + 60 * 1000;
    assert.equal(canal.okSemTela(e), 1);
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false]]);
    relogio.t = T0 + 2 * MIN;
    assert.equal(canal.okSemTela(e), 0); // na tela
    // descendo (resposta nova sem a juncao) e fora da fila = volta
    relogio.t = T0 + 4 * MIN;
    canal.resposta(e, parou('aba-1'), 'Aba');
    await canal.drenar(e, { travado: true });
    assert.equal(canal.okSemTela(e), 1);
    // trancada = 0
    canal.okToque(e, COD, 'sim');
    await canal.drenar(e); // editarBotoes; a resposta espera
    assert.deepEqual(passos(tg).slice(1), [['editarBotoes', 601]]);
    relogio.t = T0 + 10 * MIN;
    assert.equal(canal.okSemTela(e), 0);
    assert.deepEqual(e.tg.saida, []);
  });

  test('conversaResolvida pula a entrada com manterConversa: o OK que some com a fala dele em voo apaga so a tela (a fala dele fica)', async () => {
    const { canal, tg, e } = novo({ roteiro: soClassico() });
    canal.aviso(e, parou('aba-1'), 'Aba');
    await canal.drenar(e); // 501
    e.tg.idsDoDono = [88];
    canal.falaRecebida(e, { sessionId: 'aba-1', fala: 'faz', audio: false, hora: iso(T0), messageIdDono: 88 });
    canal.okAbriu(e, 'aba-1', okDe());
    await canal.drenar(e); // 601 em cima da 88, apagar 501
    assert.equal(e.tg.mensagens[601].citar, 88);
    const n = tg.chamadas.length;
    assert.equal(canal.okFechou(e, COD, { texto: 'x', some: true }), true);
    await canal.drenar(e);
    assert.deepEqual(passos(tg).slice(n), [['apagar', 601]]);
    assert.equal(e.tg.chamados['aba-1'].limpar, undefined);
    assert.deepEqual(e.tg.saida, []);
  });

  test('completarTg: c.ok torto sai (o resto do chamado fica); versaoId e antes tortos saem sozinhos; c.mensagem.ok que nao e texto sai; sem ok = igual a hoje', async () => {
    const { e } = await comOkNaTela();
    const bom = JSON.parse(JSON.stringify(e.tg));
    assert.equal(typeof bom.chamados['aba-1'].ok.versaoId, 'number');
    assert.equal(typeof bom.chamados['aba-1'].ok.antes, 'object');
    assert.deepEqual(completarTg(JSON.parse(JSON.stringify(bom))).chamados, bom.chamados);
    const com = (f) => {
      const x = JSON.parse(JSON.stringify(bom));
      f(x.chamados['aba-1']);
      return completarTg(x).chamados['aba-1'];
    };
    const { ok, ...resto } = bom.chamados['aba-1'];
    const tortos = [
      (c) => { c.ok.cod = 'abc234'; },
      (c) => { c.ok.cod = 'ABC1O0'; },
      (c) => { delete c.ok.cod; },
      (c) => { delete c.ok.bloco.completo; },
      (c) => { c.ok.bloco.compacto.texto = ''; },
      (c) => { c.ok.bloco = 'x'; },
      (c) => { c.ok.completo = 'sim'; },
      (c) => { c.ok.notificar = 1; },
      (c) => { c.ok.toque = { acao: 'talvez', em: iso(T0) }; },
      (c) => { c.ok.fechado = 5; },
      (c) => { c.ok.em = null; },
      (c) => { c.ok.naTelaEm = 7; },
      (c) => { c.ok = 'x'; },
    ];
    for (const [i, f] of tortos.entries()) assert.deepEqual(com(f), resto, `torto ${i}`);
    assert.deepEqual(com((c) => { c.ok.toque = { acao: 'sim', em: iso(T0) }; }).ok.toque, { acao: 'sim', em: iso(T0) });
    const semVersao = com((c) => { c.ok.versaoId = 'x'; });
    assert.equal('versaoId' in semVersao.ok, false);
    assert.deepEqual(semVersao.ok.antes, ok.antes);
    for (const antes of [{ versaoId: 1.5, descer: false }, { versaoId: 3, descer: 'nao' }, 'x']) {
      const c = com((x) => { x.ok.antes = antes; });
      assert.equal('antes' in c.ok, false);
      assert.equal(c.ok.versaoId, ok.versaoId);
    }
    const semOkNaTela = com((c) => { c.mensagem.ok = 5; });
    assert.deepEqual(semOkNaTela.mensagem, { messageId: 601, formato: 'classico', versaoId: resto.mensagem.versaoId });
    assert.equal(semOkNaTela.ok.cod, COD);
    // sem ok nenhum: igual a hoje
    const s = novo();
    s.canal.resposta(s.e, parou('aba-1'), 'Aba');
    await s.canal.drenar(s.e);
    const semOk = JSON.parse(JSON.stringify(s.e.tg));
    assert.deepEqual(completarTg(JSON.parse(JSON.stringify(semOk))), semOk);
  });

  test('conserto 1: OK substituido que fecha sem chegar na tela = a tela sai do OK antigo (editar sem bloco nenhum, com os botoes do chamado); versao ok = a tela apagada', async () => {
    const { canal, tg, e, c } = await comOkNaTela();
    const n = tg.chamadas.length;
    assert.deepEqual(canal.okAbriu(e, 'aba-1', okDe(COD2)), { aceito: true, substituido: COD });
    assert.equal(canal.okFechou(e, COD2, { texto: 'x', some: true }), true);
    assert.equal(c.ok, undefined);
    await canal.drenar(e);
    assert.deepEqual(passos(tg).slice(n), [['editar', 601]]);
    const m = montarChamado(c.versao);
    assert.ok(m.botoes.length >= 3);
    assert.deepEqual(tg.chamadas[n].args[1], { html: m.html, classico: m.classico, botoes: m.botoes, formato: 'classico' });
    assert.deepEqual(c.mensagem, { messageId: 601, formato: 'classico', versaoId: c.versao.id });
    assert.equal(c.descer, false);
    assert.deepEqual(e.tg.saida, []);
    // versao 'ok' (sem parte da aba): a tela do OK antigo e apagada e o chamado sai
    const s = novo({ roteiro: soClassico() });
    s.canal.okAbriu(s.e, 'aba-1', okDe());
    await s.canal.drenar(s.e); // 601
    s.canal.okAbriu(s.e, 'aba-1', okDe(COD2));
    assert.equal(s.canal.okFechou(s.e, COD2, { texto: 'x', some: false }), true);
    await s.canal.drenar(s.e);
    assert.deepEqual(passos(s.tg), [['enviar', false], ['apagar', 601]]);
    assert.equal(s.e.tg.chamados['aba-1'], undefined);
    assert.deepEqual(s.e.tg.saida, []);
  });

  test('conserto 2: o OK fecha com a mensagem dele em voo = a tela nunca fica com o bloco aberto sem dono', async () => {
    // (a) OK sem chamado (versao 'ok') que fecha durante o 1o enviar: a tela e apagada e o chamado sai
    const gancho = { f: null };
    const a = novo({ roteiro: soClassico(gancho) });
    a.canal.okAbriu(a.e, 'aba-1', okDe());
    let fechou = null;
    gancho.f = () => { fechou = a.canal.okFechou(a.e, COD, { texto: fechadoDe(), some: false }); };
    await a.canal.drenar(a.e);
    assert.equal(fechou, true);
    assert.deepEqual(passos(a.tg), [['enviar', false], ['apagar', 601]]);
    assert.equal(a.e.tg.chamados['aba-1'], undefined);
    assert.deepEqual(a.e.tg.saida, []);
    assert.equal(a.canal.okNaMensagem(a.e, 601), null);

    // (b) a resposta nova desce com o OK (depois dos 60 s) e o OK fecha durante o enviar: a mensagem nova e EDITADA pro
    // bloco fechado (nenhuma outra mensagem nova) e a antiga e apagada
    const g2 = { f: null };
    const b = await comOkNaTela({ gancho: g2 });
    b.relogio.t = T0 + 2 * MIN;
    b.canal.resposta(b.e, parou('aba-1', 'Outra pergunta?'), 'Aba');
    const n = b.tg.chamadas.length;
    const fechado = fechadoDe();
    g2.f = () => { fechou = b.canal.okFechou(b.e, COD, { texto: fechado, some: false }); };
    fechou = null;
    await b.canal.drenar(b.e);
    assert.equal(fechou, true);
    assert.deepEqual(passos(b.tg).slice(n), [['enviar', false], ['editar', 602], ['apagar', 601]]);
    const esperado = montarChamadoComOk(b.c.versao, aberto(b.ok, { fechado }));
    assert.ok(esperado.classico.includes('Outra pergunta?'));
    assert.deepEqual(b.tg.chamadas[n + 1].args[1], { html: undefined, classico: esperado.classico, botoes: null, formato: 'classico' });
    assert.deepEqual(b.c.mensagem, { messageId: 602, formato: 'classico', versaoId: b.c.versao.id, ok: COD });
    assert.equal(b.c.descer, false);
    assert.deepEqual(b.e.tg.saida, []);
  });

  test('conserto 3 (manter): o fecho com a mensagem nova pendente EDITA a tela antiga pro bloco fechado (com a parte dela, sem botoes) antes da nova sair; ela fica no chat sem o tirar-botoes', async () => {
    const { canal, tg, e, c, ok, relogio } = await comOkNaTela({ resolvidas: 'manter' });
    const vTela = c.versao;
    canal.okToque(e, COD, 'sim');
    await canal.drenar(e); // editarBotoes 601
    relogio.t = T0 + 2 * MIN;
    canal.resposta(e, parou('aba-1', 'Outra pergunta?'), 'Aba');
    await canal.drenar(e); // trancada: nada
    const n = tg.chamadas.length;
    const fechado = fechadoDe();
    assert.equal(canal.okFechou(e, COD, { texto: fechado, some: true }), true); // no manter o some vira fecho
    await canal.drenar(e);
    assert.deepEqual(passos(tg).slice(n), [['editar', 601], ['enviar', false]]);
    const esperado = montarChamadoComOk(vTela, aberto(ok, { fechado }));
    assert.ok(!esperado.classico.includes('Outra pergunta?'));
    assert.deepEqual(tg.chamadas[n].args[1], { html: undefined, classico: esperado.classico, botoes: null, formato: 'classico' });
    assert.equal(tg.chamadas[n + 1].args[0].classico, montarChamado(c.versao).classico);
    assert.equal(e.tg.mensagens[601].fica, true);
    assert.equal(c.ok, undefined);
    assert.notEqual(c.mensagem.messageId, 601);
    assert.deepEqual(e.tg.saida, []);
  });

  // T26s (as sabotagens da T26 que passavam): 1 teste minimo por regra
  test('T26s: a resposta em 60 s com o OK TOCADO na tela nao junta (espera o fecho como mensagem nova)', async () => {
    const { canal, e, c } = await comOkNaTela();
    assert.equal(canal.okToque(e, COD, 'sim'), true);
    canal.resposta(e, parou('aba-1', 'Outra pergunta?'), 'Aba');
    assert.equal(c.descer, true);
  });

  test('T26s: okInfo com o OK tocado = false e o completo fica false', async () => {
    const { canal, e, c } = await comOkNaTela();
    assert.equal(canal.okToque(e, COD, 'sim'), true);
    assert.equal(canal.okInfo(e, COD), false);
    assert.equal(c.ok.completo, false);
  });

  test('T26s: a montagem com OK (sem html) nunca edita uma tela rich: vira mensagem nova', async () => {
    const x = novo({ roteiro: soClassico() });
    x.canal.resposta(x.e, parou('aba-1'), 'Aba');
    await x.canal.drenar(x.e);
    const c = x.e.tg.chamados['aba-1'];
    const tela = c.mensagem.messageId;
    assert.equal(c.mensagem.formato, 'rich');
    x.canal.okAbriu(x.e, 'aba-1', okDe());
    c.descer = false; // estado forcado: sem o descer, a montagem com OK cairia na edicao da tela rich
    const n = x.tg.chamadas.length;
    await x.canal.drenar(x.e);
    const p = passos(x.tg).slice(n);
    assert.equal(p.filter(([m, id]) => m === 'editar' && id === tela).length, 0, JSON.stringify(p));
    assert.equal(p.filter(([m]) => m === 'enviar').length, 1, JSON.stringify(p));
  });

  test('T26s: a tela trancada que aparece no apagar sai da lista sem ser apagada', async () => {
    const { canal, tg, e, c } = await comOkNaTela();
    assert.equal(canal.okToque(e, COD, 'sim'), true);
    const tela = c.mensagem.messageId;
    c.apagar.push({ messageId: tela, doBot: true, formato: 'classico' });
    const n = tg.chamadas.length;
    await canal.drenar(e);
    assert.equal(passos(tg).slice(n).filter(([m, id]) => m === 'apagar' && id === tela).length, 0);
    assert.equal(c.apagar.some((a) => a.messageId === tela), false);
    assert.equal(c.mensagem.messageId, tela);
  });

  test('T26s: okSemTela devolve pra fila o OK aberto que a tela nao mostra (sem mensagem pendente)', async () => {
    const { canal, e, c } = await comOkNaTela();
    delete c.mensagem.ok; // estado forcado: a tela atual nao mostra o OK e nada desce
    c.descer = false;
    e.tg.saida.length = 0;
    assert.equal(canal.okSemTela(e), 1);
    assert.equal(e.tg.saida[0]?.sessionId, 'aba-1');
  });
});
// ---------- T26d: a situacao conta como a mensagem da aba (PLANO-TELEGRAM.md, "T26d") ----------

describe('T26d — a situacao da aba conta como a mensagem da aba (1 mensagem viva por aba)', () => {
  const DSX = { titulo: 'Aba', situacao: 'Esperando você desde 12:00.', final: FINAL };
  const COD = 'ABC234';
  const pedidoOk = (codigo = COD) => ({
    v: 1,
    codigo,
    sessionId: 'aba-1',
    titulo: 'Aba',
    tipo: 'publicacao',
    acao: 'subir o site <pid> & X em produção',
    destinatarios: null,
    criadoEm: iso(T0),
    expiraEm: iso(T0 + 30 * MIN),
    status: 'pendente',
  });
  const blocoDe = (p) => ({ compacto: montarBlocoOk(p), completo: montarBlocoOk({ ...p, completo: true }) });
  const okDe = (codigo = COD) => ({ cod: codigo, bloco: blocoDe(pedidoOk(codigo)), titulo: 'Aba', nome: 'aba' });
  const fechadoDe = (codigo = COD) => montarBlocoOkFechado({ ...pedidoOk(codigo), linha: 'Aprovado às 12:01.' });
  // o telegram.mjs real: sem html = sai no classico
  const soClassico = () => {
    let n = 600;
    return { enviar: (p) => (p.html ? undefined : { ok: true, messageId: ++n, formato: 'classico' }) };
  };
  // a resposta da aba-1 na tela (501, em cima da fala 88 do dono, que esta no anel) e a situacao dela por cima (502):
  // a regra 1 ja rodou
  async function regra1({ resolvidas } = {}) {
    const x = novo({ resolvidas });
    x.canal.mensagemDoDono(x.e, 88);
    x.canal.resposta(x.e, parou('aba-1'), 'Aba', { citar: 88 });
    await x.canal.drenar(x.e); // 501
    x.c = x.e.tg.chamados['aba-1'];
    x.canal.situacao(x.e, 'aba-1', DSX, { citar: 501 });
    await x.canal.drenar(x.e); // 502 e a 501 sai
    return x;
  }
  // resposta (501 rich) e o OK aberto por cima (601 classico; a 501 apagada)
  async function comOkNaTela() {
    const x = novo({ roteiro: soClassico() });
    x.canal.resposta(x.e, parou('aba-1'), 'Aba');
    await x.canal.drenar(x.e);
    x.canal.okAbriu(x.e, 'aba-1', okDe());
    await x.canal.drenar(x.e);
    x.c = x.e.tg.chamados['aba-1'];
    return x;
  }

  test('regra 1: a situacao sai SEM citar e DEPOIS a tela do chamado sai (manterConversa: a fala dele fica); o chamado fica em dia sem tela e nao volta', async () => {
    const { canal, tg, e, c } = await regra1();
    assert.deepEqual(passos(tg), [['enviar', false], ['enviar', true], ['apagar', 501]]);
    assert.equal(tg.chamadas[0].args[0].responderA, 88);
    assert.deepEqual(tg.chamadas[1].args[0], { ...montarSituacao({ ...DSX, chamadoId: 'JKMNPQRS' }), silencioso: true });
    assert.equal('responderA' in tg.chamadas[1].args[0], false, 'sem reply: a citacao apontaria pra mensagem que some');
    assert.deepEqual(e.tg.mensagens[502], { sessionId: 'situacao', aba: 'aba-1', at: iso(T0), formato: 'rich' });
    assert.equal(e.tg.mensagens[501], undefined);
    assert.equal(c.mensagem, null);
    assert.equal(c.versao.estado, 'resposta');
    assert.deepEqual(c.apagar, []);
    assert.equal(c.limpar, undefined, 'a fala 88 do dono nao vai pro limpar');
    assert.equal(canal.telaDaAba(e, 'aba-1'), null);
    assert.equal(canal.sessaoDaMensagem(e, 502), 'aba-1');
    assert.equal(e.tg.situacao.mensagem.messageId, 502);
    assert.deepEqual(e.tg.saida, []);
    // nenhum enviar do chamado depois: nem no drenar seguinte, nem com a aba de volta na fila
    await canal.drenar(e);
    e.tg.saida.push({ sessionId: 'aba-1', entrouEm: iso(T0), falhas: 0 });
    await canal.drenar(e);
    assert.equal(tg.chamadas.length, 3);
    assert.deepEqual(e.tg.saida, []);
    // volta do disco igual; a marca torta sai
    const lido = completarTg(JSON.parse(JSON.stringify(e.tg)));
    assert.deepEqual(lido.chamados['aba-1'], c);
    assert.equal(completarTg({ chamados: { 'aba-1': { ...JSON.parse(JSON.stringify(c)), naSituacao: 'x' } } }).chamados['aba-1'].naSituacao, undefined);
  });

  test('regra 1 no "manter": nada e apagado; a tela do chamado so perde os botoes (editarBotoes(tela, null)) e fica', async () => {
    const { canal, tg, e, c } = await regra1({ resolvidas: 'manter' });
    assert.deepEqual(passos(tg), [['enviar', false], ['enviar', true], ['editarBotoes', 501]]);
    assert.deepEqual(tg.chamadas[2].args, [501, null]);
    assert.equal('responderA' in tg.chamadas[1].args[0], false);
    assert.equal(e.tg.mensagens[501].fica, true);
    assert.equal(c.mensagem, null);
    await canal.drenar(e);
    assert.equal(tg.chamadas.length, 3);
    assert.ok(!tg.chamadas.some((x) => x.metodo === 'apagar'));
  });

  test('regra 1, as excecoes: chamado com OK aberto = a situacao sai com o citar e a tela do OK fica; chamado de OUTRA aba na tela = nada muda nele', async () => {
    const { canal, tg, e, c } = await comOkNaTela();
    const n = tg.chamadas.length;
    canal.situacao(e, 'aba-1', DSX, { citar: 601 });
    await canal.drenar(e);
    assert.deepEqual(passos(tg).slice(n), [['enviar', true]]);
    assert.equal(tg.chamadas[n].args[0].responderA, 601);
    assert.equal(c.mensagem.messageId, 601);
    assert.equal(c.ok.cod, COD);
    assert.equal(canal.okNaMensagem(e, 601), COD);
    assert.deepEqual(c.apagar, []);
    // outra aba
    const o = novo();
    o.canal.aviso(o.e, parou('aba-2'), 'Outra');
    await o.canal.drenar(o.e); // 501
    o.canal.situacao(o.e, 'aba-1', DSX, { citar: 77 });
    await o.canal.drenar(o.e);
    assert.deepEqual(passos(o.tg), [['enviar', false], ['enviar', true]]);
    assert.equal(o.tg.chamadas[1].args[0].responderA, 77);
    assert.equal(o.e.tg.chamados['aba-2'].mensagem.messageId, 501);
    assert.deepEqual(o.e.tg.chamados['aba-2'].apagar, []);
    await o.canal.drenar(o.e);
    assert.equal(o.tg.chamadas.length, 2);
  });

  test('regra 2: a fala dele (enviando/entregue) nao tira a situacao; a resposta nova = 1 enviar com notificacao e DEPOIS o apagar da situacao (vazia); no "manter" ela so perde os botoes', async () => {
    for (const resolvidas of ['apagar', 'manter']) {
      const { canal, tg, e, c } = await regra1({ resolvidas });
      canal.mensagemDoDono(e, 89);
      canal.falaRecebida(e, { sessionId: canal.sessaoDaMensagem(e, 502), fala: 'faz', audio: false, hora: iso(T0), messageIdDono: 89 });
      canal.entregue(e, 'aba-1', iso(T0));
      await canal.drenar(e);
      assert.equal(tg.chamadas.length, 3, resolvidas);
      assert.equal(e.tg.situacao.mensagem.messageId, 502, resolvidas);
      canal.resposta(e, parou('aba-1', 'Feito.'), 'Aba', { citar: 89 });
      await canal.drenar(e);
      const fim = resolvidas === 'apagar' ? ['apagar', 502] : ['editarBotoes', 502];
      assert.deepEqual(passos(tg).slice(3), [['enviar', false], fim], resolvidas);
      assert.equal(tg.chamadas[3].args[0].responderA, 89);
      assert.equal(c.mensagem.messageId, 503);
      const s = e.tg.situacao;
      assert.deepEqual([s.aba, s.dados, s.mensagem, s.descer], [null, null, null, false], resolvidas);
      assert.deepEqual(canal.lerToque(e, 'o:JKMNPQRS:0', 502), { obsoleto: true });
      if (resolvidas === 'apagar') assert.equal(e.tg.mensagens[502], undefined);
      else assert.equal(e.tg.mensagens[502].fica, true);
      assert.deepEqual(e.tg.saida, []);
      await canal.drenar(e);
      assert.equal(tg.chamadas.length, 5, resolvidas);
    }
  });

  test('regra 2: a situacao da aba ainda na fila quando a resposta chega = cancelada (nao sai); depois da regra 1, o encerrado e o OK sao mensagem nova e a situacao sai depois', async () => {
    const { canal, tg, e } = novo();
    canal.aviso(e, parou('aba-1'), 'Aba');
    await canal.drenar(e); // 501
    canal.situacao(e, 'aba-1', DSX, { citar: 501 });
    canal.resposta(e, parou('aba-1', 'Feito.'), 'Aba');
    assert.equal(e.tg.situacao.dados, null);
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false], ['enviar', false], ['apagar', 501]]);
    assert.equal(tg.chamadas[1].args[0].classico, montarChamado(e.tg.chamados['aba-1'].versao).classico);
    assert.equal(e.tg.situacao.mensagem, null);
    assert.deepEqual(e.tg.saida, []);
    // encerrar depois da regra 1: mensagem nova (silenciosa, sem botoes) e a situacao sai depois
    const a = await regra1();
    a.canal.encerrar(a.e, 'aba-1', iso(T0 + MIN), 'pc');
    await a.canal.drenar(a.e);
    assert.deepEqual(passos(a.tg).slice(3), [['enviar', true], ['apagar', 502]]);
    assert.equal(a.c.versao.estado, 'encerrado');
    assert.equal(a.c.mensagem.messageId, 503);
    assert.equal(a.tg.chamadas[3].args[0].botoes, null);
    assert.equal(a.e.tg.situacao.mensagem, null);
    // o OK depois da regra 1: mensagem nova com notificacao e a situacao sai depois
    const b = await regra1();
    assert.deepEqual(b.canal.okAbriu(b.e, 'aba-1', okDe()), { aceito: true, substituido: null });
    await b.canal.drenar(b.e);
    assert.deepEqual(passos(b.tg).slice(3), [['enviar', false], ['apagar', 502]]);
    assert.equal(b.c.mensagem.ok, COD);
    assert.equal(b.e.tg.situacao.mensagem, null);
  });

  test('regra 3: a situacao de X substituida pela de Y, X sem chamado com tela = perde os botoes, vira mensagem de X (resposta em cima = X) e sai depois da proxima mensagem nova de X', async () => {
    const { canal, tg, e } = novo();
    canal.situacao(e, 'S1', DSX, { citar: 77 });
    await canal.drenar(e); // 501
    canal.situacao(e, 'S2', { ...DSX, titulo: 'Site' }, { citar: 78 });
    await canal.drenar(e); // 502
    assert.deepEqual(passos(tg), [['enviar', true], ['enviar', true], ['editarBotoes', 501]]);
    assert.deepEqual(tg.chamadas[2].args, [501, null]);
    assert.deepEqual(e.tg.mensagens[501], { sessionId: 'S1', at: iso(T0), formato: 'rich', citar: 77, exSituacao: true });
    assert.equal(canal.sessaoDaMensagem(e, 501), 'S1');
    assert.deepEqual(canal.lerToque(e, 'o:ABCDEFGH:0', 501), { obsoleto: true });
    assert.equal(e.tg.situacao.mensagem.messageId, 502);
    assert.equal(e.tg.situacao.aba, 'S2');
    assert.deepEqual(e.tg.saida, []);
    // a proxima mensagem nova de S1 (o chamado) apaga a 501 depois de sair; a situacao de S2 fica
    canal.aviso(e, parou('S1'), 'Faro');
    await canal.drenar(e);
    assert.deepEqual(passos(tg).slice(3), [['enviar', false], ['apagar', 501]]);
    assert.equal(e.tg.mensagens[501], undefined);
    assert.equal(e.tg.situacao.mensagem.messageId, 502);
    // a proxima mensagem nova de X pode ser a situacao dela: a 502 vira mensagem de S2 e a 501 (de S1) sai depois
    const k = novo();
    k.canal.situacao(k.e, 'S1', DSX, { citar: 77 });
    await k.canal.drenar(k.e); // 501
    k.canal.situacao(k.e, 'S2', DSX, { citar: 78 });
    await k.canal.drenar(k.e); // 502; a 501 vira de S1
    k.canal.situacao(k.e, 'S1', DSX, { citar: 79 });
    await k.canal.drenar(k.e); // 503; a 502 vira de S2; a 501 sai
    assert.deepEqual(passos(k.tg).slice(3), [['enviar', true], ['editarBotoes', 502], ['apagar', 501]]);
    assert.equal(k.e.tg.mensagens[502].sessionId, 'S2');
    assert.equal(k.canal.sessaoDaMensagem(k.e, 503), 'S1');
  });

  test('regra 3: X com o chamado em dia sem tela (regra 1) tambem vira mensagem de X; no "manter" fica pra sempre; X com chamado na tela = apagada como hoje', async () => {
    const { canal, tg, e } = await regra1();
    canal.situacao(e, 'S2', DSX, { citar: 78 });
    await canal.drenar(e); // 503
    assert.deepEqual(passos(tg).slice(3), [['enviar', true], ['editarBotoes', 502]]);
    assert.equal(canal.sessaoDaMensagem(e, 502), 'aba-1');
    canal.resposta(e, parou('aba-1', 'Feito.'), 'Aba');
    await canal.drenar(e);
    assert.deepEqual(passos(tg).slice(5), [['enviar', false], ['apagar', 502]]);
    // manter
    const m = novo({ resolvidas: 'manter' });
    m.canal.situacao(m.e, 'S1', DSX, { citar: 77 });
    await m.canal.drenar(m.e);
    m.canal.situacao(m.e, 'S2', DSX, { citar: 78 });
    await m.canal.drenar(m.e);
    assert.deepEqual(passos(m.tg), [['enviar', true], ['enviar', true], ['editarBotoes', 501]]);
    assert.equal(m.e.tg.mensagens[501].fica, true);
    assert.equal(m.e.tg.mensagens[501].sessionId, 'S1');
    m.canal.aviso(m.e, parou('S1'), 'Faro');
    await m.canal.drenar(m.e);
    assert.deepEqual(passos(m.tg).slice(3), [['enviar', false]]);
    // X com chamado na tela (o OK aberto) = a situacao dela e apagada como hoje
    const o = await comOkNaTela();
    o.canal.situacao(o.e, 'aba-1', DSX, { citar: 601 });
    await o.canal.drenar(o.e);
    const sit = o.e.tg.situacao.mensagem.messageId;
    const n = o.tg.chamadas.length;
    o.canal.situacao(o.e, 'S2', DSX, { citar: 78 });
    await o.canal.drenar(o.e);
    assert.deepEqual(passos(o.tg).slice(n), [['enviar', true], ['apagar', sit]]);
    assert.equal(o.e.tg.mensagens[sit], undefined);
  });

  test('conserto da T26b2: o encerrar com o OK aberto fica guardado (c.encerrarDepois, 1 log) e o okFechou (some ou fecho) aplica o encerrar de sempre; a resposta nova descarta; completarTg tira o torto', async () => {
    for (const some of [true, false]) {
      const { canal, tg, e, c, logs } = await comOkNaTela();
      const nLogs = logs.length;
      canal.encerrar(e, 'aba-1', iso(T0 + MIN), 'pc');
      assert.deepEqual(c.encerrarDepois, { hora: iso(T0 + MIN), motivo: 'pc' });
      assert.equal(c.versao.estado, 'resposta');
      assert.equal(logs.length, nLogs + 1);
      assert.ok(logs.at(-1).includes('aba-1') && logs.at(-1).includes(COD));
      const lido = completarTg(JSON.parse(JSON.stringify(e.tg)));
      assert.deepEqual(lido.chamados['aba-1'].encerrarDepois, c.encerrarDepois);
      const n = tg.chamadas.length;
      await canal.drenar(e);
      assert.equal(tg.chamadas.length, n, 'nada sai antes do fecho');
      assert.equal(canal.okFechou(e, COD, { texto: fechadoDe(), some }), true);
      assert.equal(c.ok, undefined, 'o OK fechado sai com o encerrar');
      assert.equal(c.encerrarDepois, undefined);
      assert.equal(c.versao.estado, 'encerrado');
      assert.equal(c.versao.motivo, 'pc');
      assert.equal(c.versao.hora, iso(T0 + MIN));
      await canal.drenar(e);
      assert.deepEqual(passos(tg).slice(n), [['editar', 601]], String(some));
      assert.equal(tg.chamadas[n].args[1].classico, montarChamado(c.versao).classico);
      assert.equal(tg.chamadas[n].args[1].botoes, null);
      assert.deepEqual(e.tg.saida, []);
    }
    // a resposta nova da aba com o OK aberto descarta o encerrar guardado
    const r = await comOkNaTela();
    r.canal.encerrar(r.e, 'aba-1', iso(T0), 'whatsapp');
    r.canal.resposta(r.e, parou('aba-1', 'Outra?'), 'Aba');
    assert.equal(r.c.encerrarDepois, undefined);
    r.canal.okFechou(r.e, COD, { some: true });
    assert.equal(r.c.versao.estado, 'resposta');
    // completarTg: o valido fica, o torto sai
    const base = JSON.parse(JSON.stringify(r.c));
    const com = (v) => completarTg({ chamados: { 'aba-1': { ...base, encerrarDepois: v } } }).chamados['aba-1'].encerrarDepois;
    assert.deepEqual(com({ hora: iso(T0), motivo: 'whatsapp' }), { hora: iso(T0), motivo: 'whatsapp' });
    for (const torto of ['x', null, { hora: iso(T0), motivo: 'outro' }, { hora: 5, motivo: 'pc' }, []]) assert.equal(com(torto), undefined, JSON.stringify(torto));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T28 (PLANO-TELEGRAM.md, "T28"; pedido do dono 16/10/2026 08:29 e 18/10 15:36; troca do 18/10 15:49: sem X vermelho, so
// negrito, botao com 🔄): o OK fechado de vencido fica na tela com a linha em negrito e o botao "🔄 Tentar novamente"; o
// encerrar (o guardado da T26d e o que vier depois) NAO tira esse bloco (a tela mostra a linha do encerrado e o bloco); o
// okDeNovo tira o botao e poe a 2a linha. Por que existe: o OK que expirava sumia sem rastro quando a aba encerrava.
describe('T28 — o OK vencido fica na tela com o botao Tentar novamente', () => {
  const COD = 'ABC234';
  const COD2 = 'DEF567';
  const pedidoOk = (codigo = COD) => ({
    v: 1, codigo, sessionId: 'aba-1', titulo: 'Aba', tipo: 'publicacao', acao: 'subir o site <pid> & X em produção', destinatarios: null,
    criadoEm: iso(T0), expiraEm: iso(T0 + 30 * MIN), status: 'pendente',
  });
  const blocoDe = (p) => ({ compacto: montarBlocoOk(p), completo: montarBlocoOk({ ...p, completo: true }) });
  const okDe = (codigo = COD) => ({ cod: codigo, bloco: blocoDe(pedidoOk(codigo)), titulo: 'Aba', nome: 'aba' });
  const LINHA = 'Expirou às 12:30 sem resposta.';
  const FECHADO = montarBlocoOkFechado({ ...pedidoOk(), linha: LINHA });
  const BOTAO = [[{ texto: '🔄 Tentar novamente', dados: `r:${COD}` }]];
  const VENCIDO = { texto: FECHADO, some: false, forte: LINHA, botoes: BOTAO };
  const soClassico = () => {
    let n = 600;
    return { enviar: (p) => (p.html ? undefined : { ok: true, messageId: ++n, formato: 'classico' }) };
  };
  const cabecalho = montarChamado({ estado: 'ok', titulo: 'Aba' }).classico;
  const blocoForte = `${esc(FECHADO.slice(0, -LINHA.length))}<b>${esc(LINHA)}</b>`;

  test('T28 c1: fecho de vencido = 1 editar com a linha em negrito e o botao; okDeNovo tira o botao e poe a 2a linha (troca na 2a vez); outro cod ou OK aberto = false', async () => {
    const { canal, tg, e } = novo({ roteiro: soClassico() });
    canal.okAbriu(e, 'aba-1', okDe());
    await canal.drenar(e); // 601
    const c = e.tg.chamados['aba-1'];
    assert.equal(canal.okDeNovo(e, COD, 'x'), false, 'OK aberto: nada');
    assert.equal(canal.okFechou(e, COD, VENCIDO), true);
    assert.equal(c.ok.fechado, FECHADO);
    assert.equal(c.ok.forte, LINHA);
    assert.deepEqual(c.ok.botoesFechado, BOTAO);
    await canal.drenar(e);
    assert.deepEqual(passos(tg), [['enviar', false], ['editar', 601]]);
    assert.deepEqual(tg.chamadas[1].args[1], { html: undefined, classico: `${cabecalho}\n\n${blocoForte}`, botoes: BOTAO, formato: 'classico' });
    assert.ok(!tg.chamadas[1].args[1].classico.includes('❌'));
    assert.equal(c.mensagem.ok, COD);
    assert.equal(canal.okNaMensagem(e, 601), null, 'fechado: o toque de OK nao confere nele');

    assert.equal(canal.okDeNovo(e, COD2, 'x'), false, 'outro cod');
    assert.equal(canal.okDeNovo(e, COD, 'Pedi de novo à aba às 12:40.'), true);
    assert.equal(c.ok.botoesFechado, undefined);
    await canal.drenar(e);
    assert.deepEqual(passos(tg).slice(2), [['editar', 601]]);
    assert.deepEqual(tg.chamadas[2].args[1], { html: undefined, classico: `${cabecalho}\n\n${blocoForte}\nPedi de novo à aba às 12:40.`, botoes: null, formato: 'classico' });
    assert.equal(canal.okDeNovo(e, COD, 'Não consegui pedir de novo à aba: Não achei a sessão Aba aberta no PC.'), true);
    await canal.drenar(e);
    assert.equal(tg.chamadas[3].args[1].classico, `${cabecalho}\n\n${blocoForte}\nNão consegui pedir de novo à aba: Não achei a sessão Aba aberta no PC.`);
    assert.equal(tg.chamadas[3].args[1].botoes, null, 'o botao nao volta');
  });

  // T28s (sabotagem #30 da t28.mjs): o okDeNovo so no fechado de vencido (com o forte)
  test('T28s: okDeNovo num OK fechado sem o forte (os outros fechos) = false; o fechado fica como esta', async () => {
    const { canal, tg, e } = novo({ roteiro: soClassico() });
    canal.okAbriu(e, 'aba-1', okDe());
    await canal.drenar(e); // 601
    assert.equal(canal.okFechou(e, COD, { texto: FECHADO, some: false }), true);
    await canal.drenar(e);
    const c = e.tg.chamados['aba-1'];
    const n = tg.chamadas.length;
    assert.equal(canal.okDeNovo(e, COD, 'Pedi de novo à aba às 12:40.'), false);
    assert.equal(c.ok.depois, undefined);
    await canal.drenar(e);
    assert.equal(tg.chamadas.length, n, 'nada editado');
  });

  test('T28 c2: OK aberto + encerrar guardado + vence = a tela do encerrado com a linha dele e o bloco com o botao (1 editar, nada novo nem apagado); os outros fechos no encerrar = como hoje (sem o bloco)', async () => {
    for (const vencido of [true, false]) {
      const { canal, tg, e } = novo({ roteiro: soClassico() });
      canal.resposta(e, parou('aba-1'), 'Aba');
      await canal.drenar(e); // 501 rich
      canal.okAbriu(e, 'aba-1', okDe());
      await canal.drenar(e); // 601 + apagar 501
      const c = e.tg.chamados['aba-1'];
      canal.encerrar(e, 'aba-1', iso(T0 + 31 * MIN), 'pc');
      assert.ok(c.encerrarDepois, 'guardado');
      const n = tg.chamadas.length;
      const fecho = vencido ? VENCIDO : { texto: montarBlocoOkFechado({ ...pedidoOk(), linha: 'Respondido pelo WhatsApp às 12:20.' }), some: false };
      assert.equal(canal.okFechou(e, COD, fecho), true);
      assert.equal(c.versao.estado, 'encerrado');
      await canal.drenar(e);
      assert.deepEqual(passos(tg).slice(n), [['editar', 601]], JSON.stringify(passos(tg).slice(n)));
      const ed = tg.chamadas[n].args[1];
      if (vencido) {
        assert.equal(ed.classico, `${cabecalho}\n<i>Encerrada às 12:31: a aba seguiu no PC.</i>\n\n${blocoForte}`);
        assert.deepEqual(ed.botoes, BOTAO);
        assert.equal(c.ok.cod, COD, 'o bloco fica no chamado');
      } else {
        assert.equal(ed.classico, montarChamado(c.versao).classico, 'como hoje: o encerrado sem o bloco');
        assert.equal(c.ok, undefined);
      }
    }
  });

  test('T28 c3: o encerrar que chega DEPOIS do vencido tambem mantem o bloco; aviso novo da aba = mensagem nova sem o bloco e a antiga apagada (regra de hoje)', async () => {
    const { canal, tg, e } = novo({ roteiro: soClassico() });
    canal.resposta(e, parou('aba-1'), 'Aba');
    await canal.drenar(e);
    canal.okAbriu(e, 'aba-1', okDe());
    await canal.drenar(e); // 601
    canal.okFechou(e, COD, VENCIDO);
    await canal.drenar(e);
    const c = e.tg.chamados['aba-1'];
    canal.encerrar(e, 'aba-1', iso(T0 + 40 * MIN), 'pc');
    await canal.drenar(e);
    const ult = tg.chamadas.at(-1);
    assert.deepEqual([ult.metodo, ult.args[0]], ['editar', 601]);
    assert.equal(ult.args[1].classico, `${cabecalho}\n<i>Encerrada às 12:40: a aba seguiu no PC.</i>\n\n${blocoForte}`);
    assert.deepEqual(ult.args[1].botoes, BOTAO);
    const n = tg.chamadas.length;
    canal.aviso(e, parou('aba-1', 'Outra pergunta?'), 'Aba');
    await canal.drenar(e);
    assert.deepEqual(passos(tg).slice(n), [['enviar', false], ['apagar', 601]]);
    assert.ok(!JSON.stringify(tg.chamadas[n].args[0]).includes('r:ABC234'), 'a mensagem nova sem o botao');
    assert.equal(c.ok, undefined);
  });

  test('T28 c4: o pedido novo da aba (okAbriu) com o fechado de vencido na tela substitui: mensagem nova com o bloco novo, a antiga apagada', async () => {
    const { canal, tg, e } = novo({ roteiro: soClassico() });
    canal.okAbriu(e, 'aba-1', okDe());
    await canal.drenar(e); // 601
    canal.okFechou(e, COD, VENCIDO);
    await canal.drenar(e);
    canal.okDeNovo(e, COD, 'Pedi de novo à aba às 12:40.');
    await canal.drenar(e);
    const ok2 = okDe(COD2);
    assert.deepEqual(canal.okAbriu(e, 'aba-1', ok2), { aceito: true, substituido: null });
    const n = tg.chamadas.length;
    await canal.drenar(e);
    assert.deepEqual(passos(tg).slice(n), [['enviar', false], ['apagar', 601]]);
    assert.equal(tg.chamadas[n].args[0].classico, `${cabecalho}\n\n${esc(ok2.bloco.compacto.texto)}`);
    assert.deepEqual(tg.chamadas[n].args[0].botoes, ok2.bloco.compacto.botoes);
    assert.equal(e.tg.chamados['aba-1'].ok.cod, COD2);
  });

  test('T28 c5: completarTg guarda forte, botoesFechado e depois validos e tira os tortos (o c.ok fica)', () => {
    const ok = { cod: COD, bloco: blocoDe(pedidoOk()), completo: false, toque: null, fechado: FECHADO, notificar: false, em: iso(T0), naTelaEm: iso(T0) };
    const com = (extra) => completarTg({ chamados: { 'aba-1': { versao: { id: 1, estado: 'ok', titulo: 'Aba' }, descer: false, mensagem: null, apagar: [], ok: { ...ok, ...extra } } } }).chamados['aba-1'].ok;
    const bom = com({ forte: LINHA, botoesFechado: BOTAO, depois: 'Pedi de novo à aba às 12:40.' });
    assert.equal(bom.forte, LINHA);
    assert.deepEqual(bom.botoesFechado, BOTAO);
    assert.equal(bom.depois, 'Pedi de novo à aba às 12:40.');
    const torto = com({ forte: 5, botoesFechado: 'x', depois: {} });
    assert.equal(torto.cod, COD);
    assert.equal(torto.forte, undefined);
    assert.equal(torto.botoesFechado, undefined);
    assert.equal(torto.depois, undefined);
  });
});
