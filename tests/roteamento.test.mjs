// Testes de lib/roteamento.mjs (node:test, sem dependencia).
// Rodar: node --test "tests/*.test.mjs"  (no Node 24 a pasta sozinha nao expande)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizar, textoDaMensagem, rotear, ehTrava, casarSessoes, intencaoRua } from '../lib/roteamento.mjs';
import { NUMERO_DONO } from './lib/dados-whatsapp.mjs';

// Linha do read do whatsapp-agent (formato real de 27/09/2026).
function msg(extra = {}) {
  return {
    id: '0f0f0f0f-0000-0000-0000-000000000000',
    provider_msg_id: '3EB0AAAA0000BBBB1111CC',
    quoted_msg_id: null,
    sent_by_agent: false,
    message_type: 'text',
    content: 'oi',
    direction: 'received',
    from_me: false,
    sender_phone: NUMERO_DONO,
    message_ts: '2026-09-27T19:09:29.001+00:00',
    ...extra,
  };
}

const CTX = {
  avisos: {
    AVISO_FARO: { sessionId: 's-faro', titulo: 'Faro', nome: 'repos-f3' },
  },
  sessoes: [
    { sessionId: 's-faro', titulo: 'Faro', nome: 'repos-f3' },
    { sessionId: 's-88', titulo: null, nome: 'projetos-42' },
    { sessionId: 's-central', titulo: 'Central de sessões de teste', nome: 'repos-c1' },
  ],
};

// ---------- normalizar ----------

test('normalizar: caixa, acento, espacos e pontuacao final', () => {
  assert.equal(normalizar('  Tô   na RUA!  '), 'to na rua');
  assert.equal(normalizar('Tó no PC.'), 'to no pc');
  assert.equal(normalizar('Voltei!!!'), 'voltei');
  assert.equal(normalizar('status?!'), 'status');
  assert.equal(normalizar('Ação\n\tçãõ;:'), 'acao cao');
  assert.equal(normalizar(null), '');
  assert.equal(normalizar(undefined), '');
});

// ---------- textoDaMensagem ----------

test('textoDaMensagem: texto usa content; audio e ptt usam a transcricao', () => {
  assert.deepEqual(textoDaMensagem(msg({ content: 'olá' })), { texto: 'olá', audio: false });
  assert.deepEqual(
    textoDaMensagem(msg({ message_type: 'audio', content: '[audio]', transcription: 'pode seguir' })),
    { texto: 'pode seguir', audio: true },
  );
  assert.deepEqual(textoDaMensagem(msg({ message_type: 'ptt', content: null, transcription: null })), {
    texto: '',
    audio: true,
  });
  assert.deepEqual(textoDaMensagem(msg({ content: null })), { texto: '', audio: false });
});

// ---------- rotear ----------

test('cenario 5: resposta citando o aviso vira repasse pra sessao do aviso', () => {
  const r = rotear(msg({ quoted_msg_id: 'AVISO_FARO', content: 'pode subir' }), CTX);
  assert.deepEqual(r, { tipo: 'repasse', via: 'citacao', sessionId: 's-faro', texto: 'pode subir', audio: false });
});

test('citacao vence comando e nome ("status" citando aviso = repasse)', () => {
  const r = rotear(msg({ quoted_msg_id: 'AVISO_FARO', content: 'status' }), CTX);
  assert.equal(r.tipo, 'repasse');
  assert.equal(r.via, 'citacao');
});

test('citacao de mensagem que nao e aviso segue pro resto do roteamento', () => {
  const r = rotear(msg({ quoted_msg_id: 'OUTRA', content: 'e isso aqui?' }), CTX);
  assert.deepEqual(r, { tipo: 'central', texto: 'e isso aqui?', quoted_msg_id: 'OUTRA', audio: false });
  const proto = rotear(msg({ quoted_msg_id: 'constructor', content: 'x' }), CTX);
  assert.equal(proto.tipo, 'central'); // chave herdada do Object nao conta como aviso
});

test('cenario 6: "Tô na rua!" vira comando rua; demais comandos', () => {
  assert.deepEqual(rotear(msg({ content: 'Tô na rua!' }), CTX), { tipo: 'comando', cmd: 'rua', audio: false });
  assert.equal(rotear(msg({ content: 'na rua' }), CTX).cmd, 'rua');
  assert.equal(rotear(msg({ content: 'Status' }), CTX).cmd, 'status');
  assert.equal(rotear(msg({ content: 'Voltei.' }), CTX).cmd, 'pc');
  assert.equal(rotear(msg({ content: 'tó no PC' }), CTX).cmd, 'pc');
  assert.equal(rotear(msg({ content: 'TRAVA' }), CTX).cmd, 'trava');
  assert.equal(rotear(msg({ content: 'status da faro' }), CTX).tipo, 'central'); // comando e a frase inteira
});

test('cenario 7: "faro: pode seguir" casa a sessao de titulo Faro', () => {
  const r = rotear(msg({ content: 'faro: pode seguir' }), CTX);
  assert.deepEqual(r, { tipo: 'repasse', via: 'nome', sessionId: 's-faro', texto: 'pode seguir', audio: false });
});

test('nome: casa pelo nome derivado quando nao ha titulo, e por prefixo unico', () => {
  assert.equal(rotear(msg({ content: 'projetos-42: oi' }), CTX).sessionId, 's-88');
  assert.equal(rotear(msg({ content: 'Central: como vai?' }), CTX).sessionId, 's-central');
  const r = rotear(msg({ content: 'Faro:\nlinha 1\nlinha 2' }), CTX);
  assert.equal(r.texto, 'linha 1\nlinha 2');
});

test('cenario 7b: "Far: x" com Faro e Farm = ambiguo', () => {
  const ctx = {
    avisos: {},
    sessoes: [
      { sessionId: 'a', titulo: 'Faro', nome: 'repos-f3' },
      { sessionId: 'b', titulo: 'Farm', nome: 'repos-9a' },
      { sessionId: 'c', titulo: 'Outra', nome: 'repos-77' },
    ],
  };
  const r = rotear(msg({ content: 'Far: x' }), ctx);
  assert.deepEqual(r, {
    tipo: 'ambiguo',
    candidatos: [
      { sessionId: 'a', titulo: 'Faro', nome: 'repos-f3' },
      { sessionId: 'b', titulo: 'Farm', nome: 'repos-9a' },
    ],
    texto: 'Far: x',
    audio: false,
  });
  // igual exato vence prefixo: "Farm: x" vai direto pra Farm, mesmo com Faro comecando parecido
  assert.equal(rotear(msg({ content: 'Farm: x' }), ctx).sessionId, 'b');
});

test('nome que nao casa nenhuma sessao segue pra central', () => {
  const r = rotear(msg({ content: 'Obs: amanha cedo' }), CTX);
  assert.deepEqual(r, { tipo: 'central', texto: 'Obs: amanha cedo', quoted_msg_id: null, audio: false });
  // nome com mais de 60 chars ou com quebra de linha antes dos dois pontos nao e nome
  assert.equal(rotear(msg({ content: 'Faro\nisso: aquilo' }), CTX).tipo, 'central');
  assert.equal(rotear(msg({ content: 'S'.repeat(61) + ': x' }), CTX).tipo, 'central');
});

test('cenario 8: audio usa a transcricao (comando, nome e citacao)', () => {
  const audio = (t, extra = {}) => msg({ message_type: 'ptt', content: null, transcription: t, ...extra });
  assert.deepEqual(rotear(audio('Tô na rua.'), CTX), { tipo: 'comando', cmd: 'rua', audio: true });
  assert.deepEqual(rotear(audio('Faro: pode seguir.'), CTX), {
    tipo: 'repasse',
    via: 'nome',
    sessionId: 's-faro',
    texto: 'pode seguir.',
    audio: true,
  });
  assert.deepEqual(rotear(audio('manda bala', { message_type: 'audio', quoted_msg_id: 'AVISO_FARO' }), CTX), {
    tipo: 'repasse',
    via: 'citacao',
    sessionId: 's-faro',
    texto: 'manda bala',
    audio: true,
  });
});

// F3.3 (fase 3, 27/09): "trava" vence tudo no porteiro, inclusive a citacao de aviso; so ela, e so a frase inteira.
test('F3.3 rotear: "trava" citando aviso = comando trava (texto e audio); "trava o deploy" citando aviso segue repasse', () => {
  assert.deepEqual(rotear(msg({ quoted_msg_id: 'AVISO_FARO', content: 'trava' }), CTX), { tipo: 'comando', cmd: 'trava', audio: false });
  assert.deepEqual(rotear(msg({ quoted_msg_id: 'AVISO_FARO', content: '  Trava. ' }), CTX), { tipo: 'comando', cmd: 'trava', audio: false });
  assert.deepEqual(
    rotear(msg({ message_type: 'ptt', content: null, transcription: 'Trava!', quoted_msg_id: 'AVISO_FARO' }), CTX),
    { tipo: 'comando', cmd: 'trava', audio: true },
  );
  assert.deepEqual(rotear(msg({ quoted_msg_id: 'AVISO_FARO', content: 'trava o deploy' }), CTX), {
    tipo: 'repasse', via: 'citacao', sessionId: 's-faro', texto: 'trava o deploy', audio: false,
  });
  // so a trava ganha a prioridade: os outros comandos citando aviso continuam repasse
  assert.equal(rotear(msg({ quoted_msg_id: 'AVISO_FARO', content: 'voltei' }), CTX).tipo, 'repasse');
  assert.equal(ehTrava('Trava!'), true);
  assert.equal(ehTrava('TRAVA'), true);
  assert.equal(ehTrava('trava o deploy'), false);
  assert.equal(ehTrava('status'), false);
  assert.equal(ehTrava(''), false);
  assert.equal(ehTrava(null), false);
});

// F3.9/F3.10 (fase 3, 27/09): "abre central" (e "abrir central") no grupo reabre a central; frase inteira, normalizada.
test('CENTRAL rotear: "abre central"/"abrir central" (texto e audio) = comando central; frase com mais coisa ou citando aviso nao e', () => {
  assert.deepEqual(rotear(msg({ content: 'Abre central!' }), CTX), { tipo: 'comando', cmd: 'central', audio: false });
  assert.deepEqual(rotear(msg({ content: '  abrir   Central. ' }), CTX), { tipo: 'comando', cmd: 'central', audio: false });
  assert.deepEqual(rotear(msg({ message_type: 'ptt', content: null, transcription: 'Abre central.' }), CTX), {
    tipo: 'comando', cmd: 'central', audio: true,
  });
  // audio transcrito traz o artigo
  assert.deepEqual(rotear(msg({ content: 'Abre a central.' }), CTX), { tipo: 'comando', cmd: 'central', audio: false });
  assert.deepEqual(rotear(msg({ message_type: 'ptt', content: null, transcription: 'Abrir a central' }), CTX), {
    tipo: 'comando', cmd: 'central', audio: true,
  });
  assert.equal(rotear(msg({ content: 'abre central agora' }), CTX).tipo, 'central');
  // so a trava vence a citacao de aviso: "abre central" citando aviso segue repasse pra aba do aviso
  assert.equal(rotear(msg({ quoted_msg_id: 'AVISO_FARO', content: 'abre central' }), CTX).tipo, 'repasse');
  assert.equal(ehTrava('abre central'), false);
});

// ENC (fase 3, 27/09): o porteiro resolve o destino do "encaminhar" da central com o MESMO casamento de nome do rotear.
test('ENC casarSessoes exportada: exato vence prefixo, prefixo unico casa, sem casar = []', () => {
  const ids = (nome) => casarSessoes(nome, CTX.sessoes).map((s) => s.sessionId);
  assert.deepEqual(ids('faro'), ['s-faro']);
  assert.deepEqual(ids('projetos-42'), ['s-88']);
  assert.deepEqual(ids('central'), ['s-central']);
  assert.deepEqual(ids('loja online'), []);
  const dup = [{ sessionId: 'a', titulo: 'Site Novo' }, { sessionId: 'b', titulo: 'Site Velho' }, { sessionId: 'a', titulo: 'Site Novo' }];
  assert.deepEqual(casarSessoes('site', dup).map((s) => s.sessionId), ['a', 'b'], 'sessionId repetido conta 1 vez');
});

test('rotear: ctx vazio ou ausente nao quebra', () => {
  assert.deepEqual(rotear(msg({ content: 'qualquer: coisa' }), undefined), {
    tipo: 'central',
    texto: 'qualquer: coisa',
    quoted_msg_id: null,
    audio: false,
  });
});

// RUA LIVRE (pedido do dono): "quando eu pedir... posso so mandar um audio falando o, to na rua ai se precisar de
// alguma coisa me avisa, e ai ja vai ligar". So o aviso de rua = comando (so o ✅, nada pra central); aviso de rua com
// pedido junto = liga o modo rua E o pedido segue o roteamento normal (nunca engolir pedido).
test('RUA LIVRE intencaoRua: so o aviso = "so"; com pedido = "pedido"; negacao, "da rua" e nome de rua = null', () => {
  for (const t of [
    'ó, tô na rua aí se precisar de alguma coisa me avisa',
    'Ó, tô na rua, aí se precisar de alguma coisa, me avisa.',
    'estou na rua',
    'Tô saindo, qualquer coisa me chama',
    'saí do PC, volto às 15h',
    'Gente, vou sair pra almoçar, volto daqui a pouco',
    'to fora do computador, me avisa pelo whats',
  ]) assert.equal(intencaoRua(t), 'so', t);
  for (const t of [
    'tô na rua, me manda o resumo do deal da PSP',
    'estou na rua. Faro pode publicar',
    'to saindo, confere se o deploy subiu',
  ]) assert.equal(intencaoRua(t), 'pedido', t);
  for (const t of ['não tô na rua', 'nao estou mais na rua', 'cheguei da rua', 'o escritório fica na Rua Augusta', 'voltei', 'status', '', null]) {
    assert.equal(intencaoRua(t), null, String(t));
  }
});

test('RUA LIVRE rotear: aviso livre (texto e audio) = comando rua; com pedido = central/repasse com rua:true', () => {
  assert.deepEqual(rotear(msg({ content: 'ó, tô na rua aí se precisar de alguma coisa me avisa' }), CTX), { tipo: 'comando', cmd: 'rua', audio: false });
  assert.deepEqual(
    rotear(msg({ message_type: 'ptt', content: null, transcription: 'Ó, tô na rua, aí se precisar de alguma coisa, me avisa.' }), CTX),
    { tipo: 'comando', cmd: 'rua', audio: true },
  );
  assert.deepEqual(rotear(msg({ content: 'tô na rua, me manda o resumo do deal' }), CTX), {
    tipo: 'central', texto: 'tô na rua, me manda o resumo do deal', quoted_msg_id: null, audio: false, rua: true,
  });
  assert.deepEqual(rotear(msg({ content: 'Faro: to na rua, pode seguir' }), CTX), {
    tipo: 'repasse', via: 'nome', sessionId: 's-faro', texto: 'to na rua, pode seguir', audio: false, rua: true,
  });
  // citando aviso: vai pra aba do aviso (mesmo so o aviso de rua) e liga o modo rua
  assert.deepEqual(rotear(msg({ quoted_msg_id: 'AVISO_FARO', content: 'tô na rua, vejo depois' }), CTX), {
    tipo: 'repasse', via: 'citacao', sessionId: 's-faro', texto: 'tô na rua, vejo depois', audio: false, rua: true,
  });
  // sem intencao de rua: nada muda (sem a chave rua)
  assert.deepEqual(rotear(msg({ content: 'o escritório fica na Rua Augusta?' }), CTX), {
    tipo: 'central', texto: 'o escritório fica na Rua Augusta?', quoted_msg_id: null, audio: false,
  });
});

// RUA LIVRE 30/09/2026: 2 avisos reais do dono nao ligaram o modo rua (cairam na central como mensagem comum):
// 21:48 «Eu tô aqui na sala, se precisar de alguma coisa que eu precise interagir me avisa aqui.» e 21:51 «Estou fora de
// casa.» Agora valem "fora de casa", "saindo de casa", "to (aqui) na sala", "to no carro", "to dirigindo".
test('RUA LIVRE 30/09: "fora de casa", "na sala", carro; as 2 frases reais = so o aviso; negacao e sala sem sujeito = null', () => {
  for (const t of [
    'Eu tô aqui na sala, se precisar de alguma coisa que eu precise interagir me avisa aqui.',
    'Estou fora de casa.',
    'tô saindo de casa, qualquer coisa me chama',
    'saí de casa agora',
    'to na sala, me avisa pelo whats',
    'tô no carro',
    'estou dirigindo, me manda no whats',
  ]) assert.equal(intencaoRua(t), 'so', t);
  assert.equal(intencaoRua('estou fora de casa, me manda o resumo do deal da PSP'), 'pedido');
  for (const t of ['não estou fora de casa', 'nao to na sala', 'a reunião é na sala 3', 'cheguei em casa', 'liga a luz da sala']) {
    assert.equal(intencaoRua(t), null, t);
  }
  assert.deepEqual(rotear(msg({ content: 'Estou fora de casa.' }), CTX), { tipo: 'comando', cmd: 'rua', audio: false });
  assert.deepEqual(
    rotear(msg({ message_type: 'ptt', content: null, transcription: 'Eu tô aqui na sala, se precisar de alguma coisa que eu precise interagir me avisa aqui.' }), CTX),
    { tipo: 'comando', cmd: 'rua', audio: true },
  );
});

// T7d2b (PLANO-T7.md, T7d2, teste 25): as variantes do "pendências" (acento, caixa, singular, pontuacao final) caem no
// mesmo comando, por texto e por audio; frase com mais coisa ou citando aviso segue o roteamento de sempre (F7).
test('T7d2b 25. "pendências", "Pendências?", "pendência." e "PENDENCIAS" (texto e audio) = comando pendencias; com mais coisa ou citando aviso nao e', () => {
  for (const t of ['pendências', 'Pendências?', 'pendência.', 'PENDENCIAS', 'pendencias', '  Pendências!  ', 'PENDÊNCIA']) {
    assert.deepEqual(rotear(msg({ content: t }), CTX), { tipo: 'comando', cmd: 'pendencias', audio: false }, t);
    assert.deepEqual(
      rotear(msg({ message_type: 'ptt', content: null, transcription: t }), CTX),
      { tipo: 'comando', cmd: 'pendencias', audio: true },
      `audio: ${t}`,
    );
  }
  assert.equal(rotear(msg({ content: 'pendências da Faro' }), CTX).tipo, 'central');
  assert.equal(rotear(msg({ quoted_msg_id: 'AVISO_FARO', content: 'Pendências?' }), CTX).tipo, 'repasse');
  assert.deepEqual(rotear(msg({ content: 'Status?' }), CTX), { tipo: 'comando', cmd: 'status', audio: false });
});
