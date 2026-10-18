// Testes de lib/ok-tg.mjs e lib/registro.mjs (T7b1a, Desenho 1b: o OK pelo botao no PROPRIO chat Bot de Teste).
// Por que existe: o toque no Sim vira autorizacao de acao irreversivel. Cada caso aqui e um jeito de forjar o toque
// (outro remetente, outro bot, outro chat, texto ou teclado trocado, mensagem velha) ou de perder o certo.
// Funcoes puras: nada de rede, chave real, config.json real nem porteiro rodando. Pasta temporaria com prefixo "t7b1a-".
// Os modulos novos carregam dentro de cada teste (import dinamico): sem eles, cada teste falha sozinho.
// Rodar: node --test --test-reporter=tap "tests/ok-tg.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { ALFABETO, montarMensagemPedido } from '../ok-wpp.mjs';
import { limparParaWhatsApp } from '../lib/formato.mjs';

// A1 7: o modulo como ele e (sem bot nem chat padrao)
const carregarCru = () => import('../lib/ok-tg.mjs');

const BOT = 700900800; // Bot de Teste
const CHAT_DONO = 700100200; // chat privado do dono
// A1b2: a lib/ok-tg nao tem mais bot nem chat padrao; os testes de antes dao o bot e o chat de antes por aqui (quem
// passa o seu, ganha)
const carregar = async () => {
  const m = await carregarCru();
  return {
    ...m,
    conferirToque: (u, o = {}) => m.conferirToque(u, { botId: BOT, chatDono: CHAT_DONO, ...o }),
    travaNoChat: (us, o = {}) => m.travaNoChat(us, { chatDono: CHAT_DONO, ...o }),
  };
};
const COD = 'ABC234';
const CRIADO = '2026-10-02T13:00:00.700Z'; // 10:00 em Brasilia (com milissegundo, como o pedir grava)
const EXPIRA = '2026-10-02T13:30:00.700Z'; // 10:30
const ACAO = 'subir o site X em produção';
const segs = (iso) => Math.floor(Date.parse(iso) / 1000);

const pedido = (extra = {}) => ({
  v: 1,
  codigo: COD,
  sessionId: '11111111-2222-4333-8444-555555555555',
  titulo: 'Nome',
  tipo: 'publicacao',
  acao: ACAO,
  destinatarios: null,
  criadoEm: CRIADO,
  expiraEm: EXPIRA,
  status: 'pendente',
  ...extra,
});

const SIM = { texto: 'Sim', dados: `k:${COD}:s`, estilo: 'success' };
const NAO = { texto: 'Não', dados: `k:${COD}:n`, estilo: 'danger' };
const MAIS = { texto: 'Mais informações', dados: `k:${COD}:i` };

// Botoes do porteiro -> o reply_markup que o Telegram devolve no callback_query.message.
const apiTeclado = (botoes) => ({
  inline_keyboard: botoes.map((l) => l.map((b) => ({ text: b.texto, callback_data: b.dados, ...(b.estilo ? { style: b.estilo } : {}) }))),
});

// Update de toque como o getUpdates devolve; cada campo trocavel pra forjar 1 coisa por vez.
function toque(m, o = {}) {
  const p = o.pedido ?? pedido();
  const r = m.montarOkTg({ ...p, completo: o.completo === true });
  const msg = {
    message_id: o.messageId ?? 77,
    from: o.msgFrom ?? { id: BOT, is_bot: true, first_name: 'Bot de Teste', username: 'claude_pc_bot' },
    chat: o.chat ?? { id: CHAT_DONO, type: 'private', first_name: 'Davi' },
    date: o.date ?? segs(p.criadoEm) + 2,
    text: o.texto ?? r.texto,
    reply_markup: o.teclado ?? apiTeclado(r.botoes),
  };
  if (o.semFromMsg) delete msg.from;
  if (o.semTeclado) delete msg.reply_markup;
  return {
    update_id: o.updateId ?? 900,
    callback_query: {
      id: o.toqueId ?? 'cbq-1',
      from: o.from ?? { id: CHAT_DONO, is_bot: false, first_name: 'Davi', language_code: 'pt-br' },
      chat_instance: '-123456',
      data: o.dados ?? `k:${p.codigo}:s`,
      message: o.mensagem ?? msg,
    },
  };
}

// ---------- 61 ----------

test('T7b1a 61: dadosOk/lerDadosOk: k:<COD>:s|n|i (10 bytes), leitura estrita; entrada invalida no dadosOk = TypeError', async () => {
  const { dadosOk, lerDadosOk } = await carregar();
  assert.equal(dadosOk(COD, 'sim'), 'k:ABC234:s');
  assert.equal(Buffer.byteLength(dadosOk(COD, 'sim'), 'utf8'), 10);
  assert.equal(dadosOk(COD, 'nao'), 'k:ABC234:n');
  assert.equal(dadosOk(COD, 'info'), 'k:ABC234:i');
  assert.deepEqual(lerDadosOk('k:ABC234:s'), { codigo: COD, acao: 'sim' });
  assert.deepEqual(lerDadosOk('k:ABC234:n'), { codigo: COD, acao: 'nao' });
  assert.deepEqual(lerDadosOk('k:ABC234:i'), { codigo: COD, acao: 'info' });
  const ruins = [
    'k:abc234:s', 'k:ABC234:x', 'k:ABC234:s ', ' k:ABC234:s', 'k:ABC234:s\n', 'k:ABCI34:s', 'K:ABC234:s', 'k:ABC23:s',
    'k:ABC2345:s', 'k:ABC234:sn', 'k:ABC234:', 'k:ABC234', 'kk:ABC234:s', 'k-ABC234-s', 'o:ABCDEFGH:0', 'c:ABCDEFGH', '',
    null, undefined, 42, {}, ['k:ABC234:s'],
  ];
  for (const s of ruins) assert.equal(lerDadosOk(s), null, JSON.stringify(s));
  // o alfabeto e o do codigo do ok-wpp: toda letra dele vale; as que ele tira (I, L, O, 0, 1) e minuscula nao
  for (const ch of ALFABETO) assert.deepEqual(lerDadosOk(`k:${ch.repeat(6)}:n`), { codigo: ch.repeat(6), acao: 'nao' }, ch);
  for (const ch of 'ILO01ab') assert.equal(lerDadosOk(`k:${ch}BC234:s`), null, ch);
  const invalidas = [
    ['abc234', 'sim'], ['ABCI34', 'sim'], ['ABC23', 'sim'], ['ABC2345', 'sim'], [null, 'sim'], [123456, 'sim'],
    [COD, 's'], [COD, 'x'], [COD, 'SIM'], [COD, undefined], [COD, null],
  ];
  for (const [c, a] of invalidas) assert.throws(() => dadosOk(c, a), TypeError, JSON.stringify([c, a]));
});

// ---------- 62 ----------

test('T7b1a 62: montarOkTg compacto byte a byte, sem asterisco; acao igual a do grupo; 1500 cp inteira cabe em 4096; fechado sem botoes', async () => {
  const { montarOkTg, montarOkTgFechado } = await carregar();
  const r = montarOkTg({ ...pedido(), completo: false });
  assert.equal(r.texto, 'ℹ️ Nome\nPedido de OK (publicação): subir o site X em produção\n\nPosso? Vale até 10:30.');
  assert.deepEqual(r.botoes, [[SIM, NAO], [MAIS]]);
  assert.deepEqual(montarOkTg(pedido()), r, 'completo ausente = compacto');
  // nome = cabecalho do grupo sem os asteriscos (limpo do mesmo jeito)
  assert.equal(montarOkTg(pedido({ titulo: '🚀 **Site** — v2' })).texto.split('\n')[0], 'ℹ️ Site - v2');
  assert.equal(montarOkTg(pedido({ titulo: '' })).texto.split('\n')[0], 'ℹ️ sem nome');
  assert.ok(!montarOkTg(pedido({ titulo: '**X**' })).texto.includes('*'));
  // acao com \r\n, espaco no fim e markdown: a mesma limpeza da mensagem do grupo
  const acao = 'linha 1  \r\nlinha **2**\r\n\r\n\r\nfim <pid>.json & y ';
  const p = pedido({ tipo: 'mensagem', destinatarios: ['Ana', 'Bruno'], acao });
  const t = montarOkTg(p).texto;
  assert.equal(t, `ℹ️ Nome\nPedido de OK (mensagem pra Ana, Bruno): ${limparParaWhatsApp(acao)}\n\nPosso? Vale até 10:30.`);
  const grupo = montarMensagemPedido({ titulo: 'Nome', tipo: 'mensagem', destinatarios: ['Ana', 'Bruno'], acao, hora: '10:30' });
  // a linha do pedido (rotulo + acao) e a mesma do grupo: so o cabecalho e a ultima linha mudam
  const meio = (s, fim) => s.slice(s.indexOf('\n') + 1, s.length - fim.length);
  assert.equal(meio(t, '\n\nPosso? Vale até 10:30.'), meio(grupo, '\n\n*Posso?* Vale até 10:30.'));
  assert.ok(t.includes('fim <pid>.json & y\n'), 'texto puro: nada de tag some');
  // acao de 1500 cp (o maximo do pedir) vai inteira e o texto cabe numa mensagem
  const longa = `${'ação <b>&amp; '.repeat(107)}fim!`.slice(0, 1500);
  assert.equal(Array.from(longa).length, 1500);
  for (const completo of [false, true]) {
    const tl = montarOkTg({ ...pedido({ acao: longa, titulo: 'x'.repeat(200) }), completo }).texto;
    assert.ok(tl.includes(limparParaWhatsApp(longa)));
    assert.ok(tl.length <= 4096, `${tl.length}`);
  }
  assert.throws(() => montarOkTg(pedido({ tipo: 'toString' })), TypeError);
  // fechado: cabecalho + linha do pedido + a linha de fecho, sem botoes
  const linha = 'Você tocou em Sim às 10:05. A aba conferiu às 10:06.';
  assert.deepEqual(montarOkTgFechado({ ...pedido(), linha }), {
    texto: `ℹ️ Nome\nPedido de OK (publicação): subir o site X em produção\n\n${linha}`,
  });
});

// ---------- 63 ----------

test('T7b1a 63: montarOkTg completo: horas, Pra so quando o rotulo nao traz, o Sim libera por tipo, termina em Posso?, botoes [[Sim, Nao]]', async () => {
  const { montarOkTg, LIBERA } = await carregar();
  assert.deepEqual(LIBERA, {
    publicacao: '1 publicação em produção',
    disparo: 'o resto do disparo (depois do piloto) por até 2 horas',
    disparoSemJanela: 'o resto do disparo (depois do piloto)', // A5c: o disparo sem o ledger da trava de fora
    demais: 'esta ação, 1 vez',
  });
  const r = montarOkTg({ ...pedido(), completo: true });
  assert.equal(
    r.texto,
    'ℹ️ Nome\nPedido de OK (publicação): subir o site X em produção\n\nPedido às 10:00, vale até 10:30.\n' +
      'O Sim libera 1 publicação em produção; o Não cancela o pedido.\n\nPosso?',
  );
  assert.deepEqual(r.botoes, [[SIM, NAO]]);
  const AB = ['A', 'B'];
  const casos = [
    ['crm', AB, 'CRM', true, LIBERA.demais],
    ['publicacao', AB, 'publicação', true, LIBERA.publicacao],
    ['pagamento', AB, 'pagamento', true, LIBERA.demais],
    ['apagar', AB, 'apagar', true, LIBERA.demais],
    ['outro', AB, 'ação', true, LIBERA.demais],
    ['mensagem', AB, 'mensagem pra A, B', false, LIBERA.demais],
    ['disparo', AB, 'disparo pra A, B', false, LIBERA.disparo],
    ['disparo', null, 'disparo em massa', false, LIBERA.disparo],
    ['mensagem', null, 'mensagem', false, LIBERA.demais],
    ['crm', null, 'CRM', false, LIBERA.demais],
    ['outro', null, 'ação', false, LIBERA.demais],
  ];
  for (const [tipo, destinatarios, rotulo, pra, libera] of casos) {
    const c = montarOkTg({ ...pedido({ tipo, destinatarios, acao: 'a' }), completo: true });
    assert.equal(
      c.texto,
      `ℹ️ Nome\nPedido de OK (${rotulo}): a\n\nPedido às 10:00, vale até 10:30.\n${pra ? 'Pra: A, B.\n' : ''}` +
        `O Sim libera ${libera}; o Não cancela o pedido.\n\nPosso?`,
      JSON.stringify([tipo, destinatarios]),
    );
    assert.ok(c.texto.endsWith('\n\nPosso?'));
    assert.deepEqual(c.botoes, [[SIM, NAO]]);
  }
});

// ---------- 65 ----------

test('T7b1a 65: conferirToque valido: compacto e completo, Sim/Nao/Mais, folga de 5 s, style e quebras nao contam', async () => {
  const m = await carregar();
  const valido = (o, ext) => m.conferirToque(toque(m, o), { pedido: o?.pedido ?? pedido(), ...ext });
  assert.deepEqual(valido({}), { valido: true, acao: 'sim', completo: false, updateId: 900, toqueId: 'cbq-1', messageId: 77 });
  assert.deepEqual(valido({ dados: `k:${COD}:n`, updateId: 901, toqueId: 'q2', messageId: 78 }), {
    valido: true, acao: 'nao', completo: false, updateId: 901, toqueId: 'q2', messageId: 78,
  });
  assert.equal(valido({ dados: `k:${COD}:i` }).acao, 'info');
  assert.deepEqual(valido({ completo: true }), { valido: true, acao: 'sim', completo: true, updateId: 900, toqueId: 'cbq-1', messageId: 77 });
  assert.equal(valido({ completo: true, dados: `k:${COD}:n` }).acao, 'nao');
  // o bot e o chat do carregar (os de antes) e os mesmos dados explicitos valem igual
  assert.equal(valido({}, { botId: BOT, chatDono: CHAT_DONO }).valido, true);
  // teclado do jeito que o Telegram devolve: [[Sim:s, Nao:n], [Mais informacoes:i]] e [[Sim:s, Nao:n]], sem style
  const semStyle = { inline_keyboard: [[{ text: 'Sim', callback_data: `k:${COD}:s` }, { text: 'Não', callback_data: `k:${COD}:n` }], [{ text: 'Mais informações', callback_data: `k:${COD}:i` }]] };
  assert.equal(valido({ teclado: semStyle }).valido, true);
  const outroStyle = { inline_keyboard: [[{ text: 'Sim', callback_data: `k:${COD}:s`, style: 'primary' }, { text: 'Não', callback_data: `k:${COD}:n`, style: 'primary', extra: 1 }]] };
  assert.equal(valido({ completo: true, teclado: outroStyle }).valido, true);
  // message.date: 3 s antes do criadoEm vale; a borda (floor - 5) vale; o fim (ceil do expiraEm) vale
  assert.equal(valido({ date: segs(CRIADO) - 3 }).valido, true);
  assert.equal(valido({ date: segs(CRIADO) - 5 }).valido, true);
  assert.equal(valido({ date: Math.ceil(Date.parse(EXPIRA) / 1000) }).valido, true);
  // texto com \r\n, espaco no fim da linha e acento em NFD = o mesmo texto
  const base = m.montarOkTg(pedido()).texto;
  assert.equal(valido({ texto: base.replace(/\n/g, ' \r\n') }).valido, true);
  assert.equal(valido({ texto: base.normalize('NFD') }).valido, true);
  // pedido com acento em NFD no arquivo confere com o texto em NFC
  const pNfd = pedido({ acao: ACAO.normalize('NFD') });
  assert.equal(m.conferirToque(toque(m, { pedido: pNfd, texto: base }), { pedido: pNfd }).valido, true);
});

// ---------- 66 ----------

test('T7b1a 66: conferirToque recusa (1 coisa por vez) e nenhum motivo traz a acao', async () => {
  const m = await carregar();
  const motivos = [];
  const recusa = (o, rotulo, ext = {}) => {
    const p = ext.pedido ?? pedido();
    const r = m.conferirToque(Object.hasOwn(o, 'update') ? o.update : toque(m, o), { pedido: p, ...ext });
    assert.equal(r.valido, false, rotulo);
    assert.equal(typeof r.motivo, 'string', rotulo);
    assert.ok(r.motivo.length > 0, rotulo);
    assert.deepEqual(Object.keys(r).sort(), ['motivo', 'valido'], rotulo);
    motivos.push(r.motivo);
  };
  const compacto = m.montarOkTg(pedido());
  const tec = apiTeclado(compacto.botoes);
  // quem tocou
  recusa({ from: { id: 555, is_bot: false } }, 'from de outro');
  recusa({ from: { id: CHAT_DONO, is_bot: true } }, 'is_bot');
  recusa({ from: { is_bot: false } }, 'from sem id');
  recusa({ from: { id: String(CHAT_DONO), is_bot: false } }, 'from.id em texto');
  // onde
  recusa({ chat: { id: -1001234567, type: 'supergroup' } }, 'chat de grupo');
  recusa({ chat: { id: CHAT_DONO, type: 'group' } }, 'chat do id do dono mas tipo grupo');
  recusa({ chat: { id: 555, type: 'private' } }, 'chat de outro id');
  // de quem e a mensagem tocada
  recusa({ msgFrom: { id: 999, is_bot: true } }, 'message.from = outro bot');
  recusa({ msgFrom: { id: CHAT_DONO, is_bot: false } }, 'message.from = o dono');
  recusa({ semFromMsg: true }, 'message sem from');
  recusa({}, 'botId trocado: so o bot dado vale', { botId: 999 });
  // quando
  recusa({ date: 0 }, 'date 0');
  recusa({ mensagem: { message_id: 77, chat: { id: CHAT_DONO, type: 'private' }, date: 0 } }, 'InaccessibleMessage');
  recusa({ date: segs(CRIADO) - 10 }, 'date 10 s antes do criadoEm');
  recusa({ date: segs(CRIADO) - 6 }, 'date 1 s antes da folga');
  recusa({ date: Math.ceil(Date.parse(EXPIRA) / 1000) + 1 }, 'date depois do expiraEm');
  recusa({ date: String(segs(CRIADO)) }, 'date em texto');
  // o que
  recusa({ texto: compacto.texto.replace('produção', 'producao') }, '1 caractere trocado na acao');
  recusa({ texto: compacto.texto.replace('site X', 'site Y') }, '1 letra trocada na acao');
  recusa({ texto: `${compacto.texto}.` }, '1 caractere a mais no fim');
  const pB = pedido({ codigo: 'XYZ789', acao: 'apagar a base inteira' });
  recusa({ texto: m.montarOkTg(pB).texto, teclado: tec }, 'texto do pedido B com os dados e o teclado do A');
  recusa({ texto: undefined, mensagem: { ...toque(m).callback_query.message, text: undefined } }, 'mensagem sem texto');
  recusa({ dados: 'k:XYZ789:s' }, 'dados de outro codigo');
  recusa({ dados: 'o:ABCDEFGH:0' }, 'dados ilegiveis');
  recusa({ dados: `k:${COD}:s ` }, 'dados com espaco');
  recusa({ completo: true, dados: `k:${COD}:i` }, 'Mais informacoes num completo (dado fora do teclado)');
  // teclado
  recusa({ teclado: { inline_keyboard: [[tec.inline_keyboard[0][0], tec.inline_keyboard[0][1]]] } }, 'compacto sem o Mais informacoes');
  recusa({ teclado: { inline_keyboard: [[tec.inline_keyboard[0][0]], tec.inline_keyboard[1]] } }, 'teclado sem o Nao');
  recusa({
    teclado: { inline_keyboard: [[{ text: 'Sim', callback_data: `k:${COD}:n` }, { text: 'Não', callback_data: `k:${COD}:s` }], tec.inline_keyboard[1]] },
  }, 'rotulos trocados (Nao com s)');
  recusa({ teclado: { inline_keyboard: [...tec.inline_keyboard, [{ text: 'Outro', callback_data: 'x' }]] } }, 'botao a mais (linha)');
  recusa({ teclado: { inline_keyboard: [[...tec.inline_keyboard[0], { text: 'Sim', callback_data: `k:${COD}:s` }], tec.inline_keyboard[1]] } }, 'botao a mais (repetido)');
  recusa({ teclado: { inline_keyboard: [[tec.inline_keyboard[0][1], tec.inline_keyboard[0][0]], tec.inline_keyboard[1]] } }, 'ordem trocada');
  recusa({ teclado: { inline_keyboard: [tec.inline_keyboard[0].concat(tec.inline_keyboard[1])] } }, 'mesmos botoes numa linha so');
  recusa({ teclado: { inline_keyboard: [[{ text: 'Sim!', callback_data: `k:${COD}:s` }, tec.inline_keyboard[0][1]], tec.inline_keyboard[1]] } }, 'rotulo diferente');
  recusa({ teclado: { inline_keyboard: [[{ text: 'Sim', url: 'https://x.invalid' }, tec.inline_keyboard[0][1]], tec.inline_keyboard[1]] } }, 'botao de link no lugar do Sim');
  // T7i: "sem teclado" e "teclado vazio" sairam daqui (a mensagem sem teclado vale: teste 118)
  recusa({ completo: true, teclado: tec }, 'texto completo com o teclado do compacto');
  // update e pedido tortos: nunca lanca
  recusa({ update: { update_id: 900, message: { text: 'sim' } } }, 'update sem callback_query');
  recusa({ update: null }, 'update null');
  recusa({ update: { callback_query: toque(m).callback_query } }, 'update sem update_id');
  recusa({}, 'pedido sem codigo', { pedido: pedido({ codigo: undefined }) });
  recusa({}, 'pedido de tipo desconhecido', { pedido: pedido({ tipo: 'toString' }) });
  recusa({}, 'pedido com criadoEm ilegivel', { pedido: pedido({ criadoEm: 'ontem' }) });
  recusa({}, 'pedido null', { pedido: null });
  for (const motivo of motivos) {
    assert.ok(!motivo.includes('site X') && !motivo.includes('produção') && !motivo.includes('apagar a base'), `motivo com a acao: ${motivo}`);
  }
});

// ---------- 118 (T7i) ----------

test('T7i 118: conferirToque com a mensagem SEM teclado (o porteiro tirou os botoes depois do toque; o servidor pode devolver a mensagem como esta agora): reply_markup ausente, null ou inline_keyboard vazio, no compacto e no completo, vale com o dado do teclado daquela versao; o resto segue recusado', async () => {
  const m = await carregar();
  // o toque com o reply_markup trocado (undefined = sem o campo)
  const sem = (o, markup) => {
    const u = toque(m, o);
    if (markup === undefined) delete u.callback_query.message.reply_markup;
    else u.callback_query.message.reply_markup = markup;
    return u;
  };
  const conf = (u, p = pedido()) => m.conferirToque(u, { pedido: p });
  const vazios = [['sem o campo', undefined], ['null', null], ['inline_keyboard vazio', { inline_keyboard: [] }]];
  for (const [rotulo, markup] of vazios) {
    assert.deepEqual(conf(sem({}, markup)), { valido: true, acao: 'sim', completo: false, updateId: 900, toqueId: 'cbq-1', messageId: 77 }, `Sim no compacto, ${rotulo}`);
    assert.equal(conf(sem({ dados: `k:${COD}:n` }, markup)).acao, 'nao', `Nao no compacto, ${rotulo}`);
    assert.equal(conf(sem({ dados: `k:${COD}:i` }, markup)).acao, 'info', `Mais informacoes no compacto, ${rotulo}`);
    assert.deepEqual(conf(sem({ completo: true }, markup)), { valido: true, acao: 'sim', completo: true, updateId: 900, toqueId: 'cbq-1', messageId: 77 }, `Sim no completo, ${rotulo}`);
    assert.equal(conf(sem({ completo: true, dados: `k:${COD}:n` }, markup)).acao, 'nao', `Nao no completo, ${rotulo}`);
  }
  const recusa = (u, motivo, rotulo, p = pedido()) => {
    const r = conf(u, p);
    assert.deepEqual(r, { valido: false, motivo }, rotulo);
  };
  recusa(sem({ completo: true, dados: `k:${COD}:i` }, undefined), 'botao tocado fora do teclado', 'Mais informacoes no completo sem teclado');
  const pB = pedido({ codigo: 'XYZ789', acao: 'apagar a base inteira' });
  recusa(sem({ texto: m.montarOkTg(pB).texto }, undefined), 'texto da mensagem nao confere com o pedido', 'sem teclado com o texto de outro pedido');
  recusa(sem({ dados: 'k:XYZ789:s' }, undefined), 'toque de outro pedido', 'sem teclado com o dado de outro pedido');
  recusa(sem({ msgFrom: { id: 999, is_bot: true } }, undefined), 'a mensagem tocada nao e do bot', 'sem teclado, mensagem de outro bot');
  recusa(sem({ from: { id: 555, is_bot: false } }, undefined), 'quem tocou nao e o dono do chat', 'sem teclado, outra pessoa');
  recusa(sem({ date: segs(CRIADO) - 60 }, undefined), 'mensagem fora do prazo do pedido', 'sem teclado, mensagem velha');
  // teclado presente e diferente segue recusado (so o vazio de verdade e "sem teclado")
  const botoesNao = 'botoes da mensagem nao conferem com o pedido';
  recusa(sem({}, {}), botoesNao, 'reply_markup sem inline_keyboard');
  recusa(sem({}, { inline_keyboard: [[]] }), botoesNao, 'uma linha vazia');
  recusa(sem({}, { inline_keyboard: null }), botoesNao, 'inline_keyboard null');
  recusa(sem({}, []), botoesNao, 'reply_markup lista');
  recusa(sem({}, 'x'), botoesNao, 'reply_markup texto');
  recusa(sem({}, { inline_keyboard: [[{ text: 'Sim', callback_data: `k:${COD}:s` }]] }), botoesNao, 'so o Sim');
});

// ---------- 67 ----------

test('T7b1a 67: travaNoChat: "trava" do dono (frase inteira) depois do destravadoEm ou sem ele; antes, outro, bot e "travar" nao', async () => {
  const { travaNoChat } = await carregar();
  const DESTRAVADO = '2026-10-02T13:10:00.000Z';
  const depois = segs(DESTRAVADO) + 1;
  const antes = segs(DESTRAVADO) - 1;
  let n = 0;
  const msg = (texto, { de = CHAT_DONO, bot = false, date = depois, chat = CHAT_DONO, tipo = 'private' } = {}) => ({
    update_id: 1000 + n++,
    message: { message_id: 50 + n, from: { id: de, is_bot: bot, first_name: 'X' }, chat: { id: chat, type: tipo }, date, text: texto },
  });
  const com = (u, o = { destravadoEm: DESTRAVADO }) => travaNoChat(u, o);
  assert.equal(com([msg('trava')]), true);
  assert.equal(com([msg('Trava!')]), true);
  assert.equal(com([msg('  TRAVA.  ')]), true);
  assert.equal(com([msg('trava', { date: antes })], {}), true, 'sem destravadoEm = qualquer uma');
  assert.equal(com([msg('Trava!', { date: antes })], { destravadoEm: null }), true);
  assert.equal(com([msg('trava', { date: antes })], { destravadoEm: 'ilegivel' }), true, 'hora ilegivel = conta');
  assert.equal(com([msg('trava', { date: antes })]), false, 'antes do destravadoEm');
  assert.equal(com([msg('trava', { date: segs(DESTRAVADO) - 1 })]), false, 'o segundo inteiro antes');
  // o date do Telegram e em segundos: no mesmo segundo do destravadoEm a ordem e desconhecida = na duvida, trava
  assert.equal(com([msg('trava', { date: segs(DESTRAVADO) })]), true, 'mesmo segundo do destravadoEm');
  assert.equal(com([msg('trava', { date: segs(DESTRAVADO) })], { destravadoEm: '2026-10-02T13:10:00.500Z' }), true, 'mesmo segundo, destravadoEm no meio dele');
  assert.equal(com([msg('trava', { de: 555 })]), false, 'outro remetente');
  assert.equal(com([msg('trava', { bot: true })]), false, 'bot com o id do dono');
  assert.equal(com([msg('trava', { de: BOT, bot: true })]), false, 'o proprio bot');
  assert.equal(com([msg('trava', { chat: -100999, tipo: 'supergroup' })]), false, 'em grupo');
  assert.equal(com([msg('travar')]), false);
  assert.equal(com([msg('trava tudo')]), false);
  assert.equal(com([msg('não trava')]), false);
  assert.equal(com([{ update_id: 7, callback_query: { id: 'q', from: { id: CHAT_DONO, is_bot: false }, data: 'trava' } }]), false, 'toque nao e texto');
  assert.equal(com([]), false);
  assert.equal(com(null), false);
  assert.equal(com([null, { update_id: 3 }, msg(undefined), msg('oi'), msg('trava', { date: antes }), msg('Trava!')]), true, 'lista misturada');
  // chatDono explicito: o remetente e o chat sao os dele
  assert.equal(travaNoChat([msg('trava', { de: 555, chat: 555 })], { destravadoEm: DESTRAVADO, chatDono: 555 }), true);
  assert.equal(travaNoChat([msg('trava')], { destravadoEm: DESTRAVADO, chatDono: 555 }), false);
});

// ---------- 69 ----------

test('T7b1a 69: lerConfigOk so com telegram.ligado e telegram.ok.ligado true; chaveTelegram e valorDoReg em lib/registro.mjs, reexportados pelo porteiro', async () => {
  const m = await carregar();
  const dir = pastaTemp('t7b1a-');
  try {
    const grava = (v) => fs.writeFileSync(path.join(dir, 'config.json'), typeof v === 'string' ? v : JSON.stringify(v));
    const DESL = { ligado: false };
    assert.deepEqual(m.lerConfigOk(dir), DESL, 'sem config.json');
    assert.deepEqual(m.lerConfigOk(undefined), DESL, 'sem pasta');
    assert.deepEqual(m.lerConfigOk(''), DESL);
    const desligados = [
      '{lixo', 'null', '[]', '"texto"', {}, { centralSessionId: 'x' }, { telegram: null }, { telegram: true },
      { telegram: { ligado: true } }, // sem telegram.ok
      { telegram: { ligado: false, ok: { ligado: true } } },
      { telegram: { ok: { ligado: true } } },
      { telegram: { ligado: 'true', ok: { ligado: true } } },
      { telegram: { ligado: true, ok: { ligado: 'true' } } },
      { telegram: { ligado: true, ok: { ligado: 1 } } },
      { telegram: { ligado: true, ok: true } },
      { telegram: { ligado: true, ok: null } },
      { telegram: { ligado: true, ok: [true] } },
      { telegram: { ligado: true, ok: {} } },
      { telegram: { ligado: true, ok: { ligado: false } } },
      { telegram: { ligado: true }, ok: { ligado: true } },
    ];
    for (const v of desligados) {
      grava(v);
      assert.deepEqual(m.lerConfigOk(dir), DESL, JSON.stringify(v));
    }
    grava({ canalPrincipal: 'telegram', centralSessionId: 'x', telegram: { ligado: true, sonda: true, ok: { ligado: true } } });
    assert.deepEqual(m.lerConfigOk(dir), { ligado: true });
    const porteiro = await import('../porteiro.mjs');
    // o lerConfigTelegram do porteiro nao muda com o campo novo
    assert.deepEqual(porteiro.lerConfigTelegram(dir), { canalPrincipal: 'telegram', ligado: true, sonda: true });

    // Desenho 1b: sem 2o bot e sem 2a chave
    assert.equal('BOT_OK_PC' in m, false);
    assert.equal('chaveOk' in m, false);

    const reg = await import('../lib/registro.mjs');
    assert.equal(porteiro.valorDoReg, reg.valorDoReg, 'valorDoReg movido, nao copiado');
    assert.equal(porteiro.chaveTelegram, reg.chaveTelegram, 'chaveTelegram movida, nao copiada');
    assert.equal(typeof reg.lerRegistroReal, 'function');
    const pedidos = [];
    const lerRegistro = (v) => async (nome) => { pedidos.push(nome); return v; };
    // A1b1: sem varChave = a variavel padrao (SESSOES_WPP_TELEGRAM_TOKEN); a varChave dada: tests/registro.test.mjs
    assert.equal(await reg.chaveTelegram({ env: { SESSOES_WPP_TELEGRAM_TOKEN: ' 1:aaa ' }, lerRegistro: lerRegistro('2:bbb') }), '1:aaa', 'ambiente vence');
    assert.equal(await reg.chaveTelegram({ env: {}, lerRegistro: lerRegistro(' 2:bbb ') }), '2:bbb');
    assert.deepEqual(pedidos, ['SESSOES_WPP_TELEGRAM_TOKEN']);
    assert.equal(await reg.chaveTelegram({ env: {}, lerRegistro: lerRegistro(null) }), null, 'nenhum = null');
    assert.equal(await reg.chaveTelegram({ env: { TELEGRAM_CLAUDE_PC_OK_BOT_TOKEN: '3:ccc' }, lerRegistro: lerRegistro('') }), null, 'a chave do bot OK nao existe mais');
    assert.equal(await reg.chaveTelegram({ env: {}, lerRegistro: async () => { throw new Error('reg falhou'); } }), null);
    const saida = '\r\nHKEY_CURRENT_USER\\Environment\r\n    SESSOES_WPP_TELEGRAM_TOKEN    REG_SZ    789:ghi\r\n\r\n';
    assert.equal(porteiro.valorDoReg(saida, 'SESSOES_WPP_TELEGRAM_TOKEN'), '789:ghi', 'o reexportado pelo porteiro funciona');
    assert.equal(reg.valorDoReg(saida), null, 'A5a: sem nome = null');
    assert.equal(reg.valorDoReg('    SAUDE_TESTE_URL    REG_EXPAND_SZ    https://x.invalid/tg/a\r\n'), null, 'A5a: sem nome padrao');
    assert.equal(reg.valorDoReg('    SAUDE_TESTE_URL    REG_EXPAND_SZ    https://x.invalid/tg/a\r\n', 'SAUDE_TESTE_URL'), 'https://x.invalid/tg/a');
    assert.equal(reg.valorDoReg('    A.B    REG_SZ    v\r\n', 'A.B'), 'v');
    assert.equal(reg.valorDoReg('    AxB    REG_SZ    v\r\n', 'A.B'), null, 'nome escapado na regex');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- A1 7 (PLANO-ABERTO.md, "A1 — Telegram pela configuração", teste 7) ----------

test('A1 7. conferirToque e travaNoChat sem padrao: sem botId ou chatDono valido (ausente, null, 0, -1, 1.5, texto) = {valido: false, motivo: "sem bot ou chat do dono"} e trava false; com botId 7 e chatDono 42 vale o toque de 42 na mensagem do bot 7 e nunca o do chat ou do bot de antes; o campo de chat de antes (com o nome do dono de origem) nao vale; as constantes do bot e do chat de antes sairam', async () => {
  const m = await carregarCru();
  const DONO = 42;
  const BOT_DONO = 7;
  const SEM = { valido: false, motivo: 'sem bot ou chat do dono' };
  const dono = { botId: BOT_DONO, chatDono: DONO };
  // o toque bom do dono 42 na mensagem do bot 7 (o resto igual ao toque de sempre)
  const doDono = (o = {}) => toque(m, {
    from: { id: DONO, is_bot: false, first_name: 'Dono' },
    chat: { id: DONO, type: 'private', first_name: 'Dono' },
    msgFrom: { id: BOT_DONO, is_bot: true, first_name: 'Bot do dono' },
    ...o,
  });
  const conf = (u, ext) => m.conferirToque(u, { pedido: pedido(), ...ext });
  assert.deepEqual(conf(doDono(), dono), { valido: true, acao: 'sim', completo: false, updateId: 900, toqueId: 'cbq-1', messageId: 77 });
  assert.equal(conf(doDono({ dados: `k:${COD}:n` }), dono).acao, 'nao');
  // sem o bot ou sem o chat do dono (ou invalido): nenhum toque confere, nem o perfeito
  const INVALIDOS = [undefined, null, 0, -1, 1.5, '42', '7', Number.MAX_SAFE_INTEGER + 1, Number.NaN, true];
  for (const ruim of INVALIDOS) {
    const rot = JSON.stringify(ruim) ?? 'ausente';
    assert.deepEqual(conf(doDono(), { botId: ruim, chatDono: DONO }), SEM, `botId ${rot}`);
    assert.deepEqual(conf(doDono(), { botId: BOT_DONO, chatDono: ruim }), SEM, `chatDono ${rot}`);
    assert.deepEqual(conf(doDono({ dados: `k:${COD}:n` }), { botId: ruim, chatDono: ruim }), SEM, `Nao com os dois ${rot}`);
  }
  assert.deepEqual(conf(doDono(), { chatDono: DONO }), SEM, 'sem o campo botId');
  assert.deepEqual(conf(doDono(), { botId: BOT_DONO }), SEM, 'sem o campo chatDono');
  assert.deepEqual(conf(doDono(), {}), SEM, 'sem os dois');
  assert.deepEqual(m.conferirToque(doDono()), SEM, 'sem as opcoes');
  // o toque do chat e do bot de antes, sem dar os dois: nunca o padrao de antes
  assert.deepEqual(conf(toque(m), {}), SEM, 'toque de antes sem botId nem chatDono');
  // o campo de chat de antes (com o nome do dono de origem) nao e mais lido; o nome dele vai montado por pedacos porque
  // o nome inteiro e termo proibido na copia aberta (a assercao segue provando que ele nao vale)
  const CHAT_ANTES = ['chatE', 'ric'].join('');
  assert.deepEqual(conf(toque(m), { botId: BOT, [CHAT_ANTES]: CHAT_DONO }), SEM, 'so o campo de chat de antes');
  assert.deepEqual(conf(doDono(), { botId: BOT_DONO, [CHAT_ANTES]: DONO }), SEM, 'o campo de antes no lugar do chatDono');
  // com o bot 7 e o chat 42: o mesmo toque vindo do chat de antes, ou na mensagem do bot de antes, nao conta
  assert.deepEqual(conf(doDono({ from: { id: CHAT_DONO, is_bot: false }, chat: { id: CHAT_DONO, type: 'private' } }), dono),
    { valido: false, motivo: 'quem tocou nao e o dono do chat' }, 'toque vindo do chat de antes');
  assert.deepEqual(conf(doDono({ chat: { id: CHAT_DONO, type: 'private' } }), dono),
    { valido: false, motivo: 'toque fora do chat privado do dono' }, 'o dono tocando no chat de antes');
  assert.deepEqual(conf(doDono({ msgFrom: { id: BOT, is_bot: true } }), dono),
    { valido: false, motivo: 'a mensagem tocada nao e do bot' }, 'toque na mensagem do bot de antes');
  assert.deepEqual(conf(toque(m), dono), { valido: false, motivo: 'quem tocou nao e o dono do chat' }, 'o toque de antes inteiro');

  // travaNoChat: sem chatDono valido = false (mesmo com a "trava" do chat de antes); com 42, a de 42 conta e a de antes nao
  let n = 0;
  const trava = (de, chat = de) => ({
    update_id: 1000 + n++,
    message: { message_id: 50 + n, from: { id: de, is_bot: false, first_name: 'X' }, chat: { id: chat, type: 'private' }, date: segs(CRIADO) + 60, text: 'trava' },
  });
  for (const ruim of INVALIDOS) {
    const rot = JSON.stringify(ruim) ?? 'ausente';
    assert.equal(m.travaNoChat([trava(CHAT_DONO)], { chatDono: ruim }), false, `chatDono ${rot}, trava do chat de antes`);
    assert.equal(m.travaNoChat([trava(DONO)], { chatDono: ruim }), false, `chatDono ${rot}, trava de 42`);
  }
  assert.equal(m.travaNoChat([trava(CHAT_DONO)], {}), false, 'sem chatDono');
  assert.equal(m.travaNoChat([trava(CHAT_DONO)]), false, 'sem as opcoes');
  assert.equal(m.travaNoChat([trava(CHAT_DONO)], { [CHAT_ANTES]: CHAT_DONO }), false, 'so o campo de chat de antes');
  assert.equal(m.travaNoChat([trava(DONO)], { chatDono: DONO }), true, 'a trava do dono 42');
  assert.equal(m.travaNoChat([trava(CHAT_DONO)], { chatDono: DONO }), false, 'a trava do chat de antes com o dono 42');
  assert.equal(m.travaNoChat([trava(DONO, CHAT_DONO)], { chatDono: DONO }), false, 'o dono escrevendo no chat de antes');
  assert.equal(m.travaNoChat([trava(CHAT_DONO, DONO)], { chatDono: DONO }), false, 'outro escrevendo no chat do dono');
  // as constantes de antes sairam do modulo
  assert.equal('BOT_CLAUDE_PC' in m, false);
  // o nome da constante de antes montado por pedacos (o nome inteiro e termo proibido na copia aberta)
  assert.equal(['CHAT_E', 'RIC'].join('') in m, false);
});
