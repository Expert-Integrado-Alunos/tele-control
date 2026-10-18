// Testes da T7b2b no mensageiro (etapa E da aceleracao; PLANO-T7.md, "T7b2b-resto e T7b3 no Desenho 1b", com o texto
// do fimRecadoOkTg da secao "F5 decidida"). O toque do dono no botao Sim ou Nao do pedido de OK (chat do bot) vira um
// recado com id `tgok-u<update_id>` e canal telegram: o fim e o fimRecadoOkTg. O recado do Telegram (`tg-u`) e o do
// WhatsApp ficam byte a byte.
// Funcao pura (montarRecado) + 1 entrega com o spawn dublado: nada de claude real, rede ou ~/.claude real.
// Rodar: node --test --test-reporter=tap "tests/mensageiro-ok.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { criarMensageiro, montarRecado } from '../mensageiro.mjs';

// Textos por extenso de proposito (o teste prende o texto).
const NOTA = 'Resposta ao seu pedido de OK ABC234. Antes de agir, rode: node C:/projetos/sessoes-wpp/ok-wpp.mjs verificar ABC234 (so age com status ok).';
const FIM_OK = (id) => `Veio do toque do dono no botão Sim ou Não do pedido de OK (Telegram), conferido pelo porteiro (id ${id}). Rode o verificar da nota antes de agir. A sua próxima resposta volta pro Telegram sozinha: 1 frase do que aconteceu e, se precisar de uma escolha dele, o bloco 🔴 **DECISÃO:** com as opções A) / B).`;
// O reforco sai sem a nota e depois de a aba ja ter agido: fecha sem a frase do verificar (revisao da etapa E).
const FIM_OK_REFORCO = (id) => `Veio do toque do dono no botão Sim ou Não do pedido de OK (Telegram), conferido pelo porteiro (id ${id}). A sua próxima resposta volta pro Telegram sozinha: 1 frase do que aconteceu e, se precisar de uma escolha dele, o bloco 🔴 **DECISÃO:** com as opções A) / B).`;
const FIM_TG = 'Veio do Telegram do dono, conferido pelo porteiro (id tg-u5001). A sua próxima resposta volta pro Telegram sozinha, mas lá só aparecem a 1ª frase depois da linha de citação e a pergunta (o texto inteiro, só quando ele toca em Mais informações ou pede detalhe). Então: 1 frase do que aconteceu e, se precisar de uma escolha dele, o bloco 🔴 **DECISÃO:** com as opções A) / B): elas viram botões.';
const FIM_WPP = 'Veio do número do dono no grupo do WhatsApp, conferido pelo porteiro (id 3EB0AAAA0000BBBB1111CC). A sua próxima resposta volta pro grupo sozinha, mas lá só chegam a 1ª frase depois da linha de citação e a pergunta (o resto, só se ele pedir detalhe). Então: 1 frase do que aconteceu e, se precisar dele, o bloco 🔴 **DECISÃO:** com as opções A) / B).';

// O recado do toque como a etapa D poe na fila (PLANO-T7.md, "T7b2a no Desenho 1b"): sem a acao, messageId null.
const TOQUE = {
  sessionId: 's-faro', nome: 'projetos-f3', titulo: 'Faro', texto: 'Sim', audio: false, hora: '15:05',
  providerMsgId: 'tgok-u77', messageId: null, anexos: [], canal: 'telegram', nota: NOTA, ok: 'ABC234',
};
const FALA = 'sim, pode preencher só os campos vazios';
const PEDIDO_WPP = {
  sessionId: 's-faro', nome: 'projetos-f3', titulo: 'Faro', texto: FALA, audio: false, hora: '15:05',
  providerMsgId: '3EB0AAAA0000BBBB1111CC', messageId: 'uuid-1', anexos: [],
};
const PEDIDO_TG = { ...PEDIDO_WPP, providerMsgId: 'tg-u5001', messageId: 7001, canal: 'telegram' };

test('T7b2b 91. recado do toque (tgok-u77, canal telegram): a 1a linha e a citacao do Telegram, a nota e o fimRecadoOkTg no fim, com o id na 1a e na ultima linha; o Nao igual', () => {
  assert.equal(montarRecado(TOQUE), [
    'Telegram do dono (15:05, id tgok-u77). Abra a sua resposta com esta linha, literal:',
    '> Telegram do dono (15:05): «Sim»',
    '',
    'Sim',
    '',
    NOTA,
    '',
    FIM_OK('tgok-u77'),
  ].join('\n'));
  assert.equal(montarRecado({ ...TOQUE, texto: 'Não', providerMsgId: 'tgok-u78' }), [
    'Telegram do dono (15:05, id tgok-u78). Abra a sua resposta com esta linha, literal:',
    '> Telegram do dono (15:05): «Não»',
    '',
    'Não',
    '',
    NOTA,
    '',
    FIM_OK('tgok-u78'),
  ].join('\n'));
  const r = montarRecado(TOQUE);
  assert.ok(!r.includes('Mais informações') && !r.includes('elas viram botões'), 'nada do fim do tg-u');
  assert.ok(!r.includes('WhatsApp') && !r.includes('grupo'), 'nada de WhatsApp nem grupo');
  // o porteiro acha o recado no transcript pelo id: na 1a linha e na ultima (o claude -p ja juntou linhas, 28/09/2026)
  const linhas = r.split('\n');
  assert.ok(linhas[0].includes('id tgok-u77'));
  assert.ok(linhas.at(-1).includes('(id tgok-u77)'));
});

test('T7b2b 91b. o prefixo tgok-u decide o fim (tambem no reforco, que segue sem a nota e sem a frase do verificar); tg-u e o que nao comeca com tgok-u ficam com o fim do Telegram', () => {
  const reforco = montarRecado({ ...TOQUE, reforco: true });
  assert.equal(reforco, [
    'Telegram do dono (15:05, id tgok-u77). A sua resposta a esta mensagem saiu sem a linha de citação.',
    'Não repita nenhuma ação que você já fez por causa dela. Só reescreva a resposta, abrindo com esta linha, literal:',
    '> Telegram do dono (15:05): «Sim»',
    '',
    FIM_OK_REFORCO('tgok-u77'),
  ].join('\n'));
  assert.ok(!reforco.includes(NOTA), 'reforco sem a nota (como hoje)');
  assert.ok(!reforco.includes('verificar'), 'reforco sem mandar rodar o verificar (a aba ja agiu e a nota nao vem)');
  // so o PREFIXO vale
  for (const id of ['tg-u77', 'tg-utgok-u77', 'xtgok-u77']) {
    const fim = montarRecado({ ...TOQUE, providerMsgId: id }).split('\n').at(-1);
    assert.ok(fim.startsWith('Veio do Telegram do dono,'), id);
    assert.ok(!fim.includes('toque do dono'), id);
  }
});

test('T7b2b 91c. tg-u5001 e WhatsApp byte a byte (o recado e o reforco de hoje)', () => {
  assert.equal(montarRecado(PEDIDO_TG), [
    'Telegram do dono (15:05, id tg-u5001). Abra a sua resposta com esta linha, literal:',
    `> Telegram do dono (15:05): «${FALA}»`, '', FALA, '', FIM_TG,
  ].join('\n'));
  assert.equal(montarRecado({ ...PEDIDO_TG, texto: 'roda os testes e publica', nota: 'NOTA', reforco: true }), [
    'Telegram do dono (15:05, id tg-u5001). A sua resposta a esta mensagem saiu sem a linha de citação.',
    'Não repita nenhuma ação que você já fez por causa dela. Só reescreva a resposta, abrindo com esta linha, literal:',
    '> Telegram do dono (15:05): «roda os testes e publica»',
    '',
    FIM_TG,
  ].join('\n'));
  const hoje = [
    'WhatsApp do dono (15:05, id 3EB0AAAA0000BBBB1111CC). Abra a sua resposta com esta linha, literal:',
    `> WhatsApp do dono (15:05): «${FALA}»`, '', FALA, '', FIM_WPP,
  ].join('\n');
  for (const canal of [undefined, 'whatsapp']) {
    assert.equal(montarRecado({ ...PEDIDO_WPP, canal }), hoje, String(canal));
    assert.equal(montarRecado({ ...PEDIDO_WPP, canal, nota: NOTA }), [
      'WhatsApp do dono (15:05, id 3EB0AAAA0000BBBB1111CC). Abra a sua resposta com esta linha, literal:',
      `> WhatsApp do dono (15:05): «${FALA}»`, '', FALA, '', NOTA, '', FIM_WPP,
    ].join('\n'), `${canal}: o pedido de OK do grupo segue com o fim de hoje`);
  }
});

test('T7b2b 91d. entregar o recado do toque: o claude -p (dublado) recebe o recado inteiro, com o fimRecadoOkTg', async () => {
  const chamadas = [];
  const spawn = (bin, args, opts) => {
    chamadas.push({ bin, args, opts });
    const filho = new EventEmitter();
    filho.stdout = new EventEmitter();
    filho.stderr = new EventEmitter();
    filho.kill = () => true;
    setImmediate(() => {
      filho.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ENVIADO' })));
      filho.emit('close', 0);
    });
    return filho;
  };
  const m = criarMensageiro({ claudeBin: 'claude-falso', spawn, estadoDir: pastaTemp('mens-ok-') });
  assert.equal((await m.entregar(TOQUE)).status, 'enviado');
  assert.equal(chamadas.length, 1);
  assert.ok(chamadas[0].args[1].includes(montarRecado(TOQUE)), 'o recado vai inteiro');
  assert.ok(chamadas[0].args[1].includes(FIM_OK('tgok-u77')));
});
