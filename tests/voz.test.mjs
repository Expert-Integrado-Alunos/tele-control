// tests/voz.test.mjs — T17a: a voz Antonio (lib/voz.mjs). Os testes de textoParaFala e problemaOggOpus sao os da VPS
// (os do roteador do Telegram de origem, v1.2.1), adaptados pro lib/voz.mjs; os do `falar` sao novos.
// Sem rede: a Microsoft e de mentira (funcao injetada) e o Ogg tambem (tests/lib/ogg-falso.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { textoParaFala, problemaOggOpus, falar, TETO_FALA, VOZ_ANTONIO } from '../lib/voz.mjs';
import { oggOpus, pagina, opusHead, opusTags } from './lib/ogg-falso.mjs';

const OGG = oggOpus();

test('v1.2.0 voz: textoParaFala tira codigo, link, marcacao e emoji; fim de linha vira pausa', () => {
  const md = [
    '# Resumo do dia',
    'O **relatório** ficou _pronto_ e o `status` é ~~ruim~~ bom 🚀.',
    '- item um',
    '- item dois',
    'Veja [a planilha](https://exemplo.com/a?b=1) ou https://exemplo.com/x.',
    '```js',
    'const segredo = 1;',
    '```',
    '| Mês | Valor |',
    '|---|---|',
    '| jan | 10 |',
    '> citação importante',
  ].join('\n');
  const { texto, cortado } = textoParaFala(md);
  assert.equal(cortado, false);
  assert.equal(texto, 'Resumo do dia. O relatório ficou pronto e o status é ruim bom. item um. item dois. Veja a planilha ou (link no texto). (tem um trecho de código no texto). Mês, Valor. jan, 10. citação importante.');
  assert.doesNotMatch(texto, /segredo|https?:|\*|`|#|🚀/);
  assert.deepEqual(textoParaFala(''), { texto: '', cortado: false });
  assert.deepEqual(textoParaFala('```\nso codigo\n```').texto, '(tem um trecho de código no texto).');
  assert.equal(textoParaFala('🚀🔥').texto, '', 'so emoji = nada a falar');
  assert.equal(textoParaFala('snake_case_nome e 2*3*4 ficam').texto, 'snake_case_nome e 2*3*4 ficam.', 'sublinhado no meio da palavra e conta nao sao italico');
});

test('v1.2.0 voz: texto longo corta na ultima frase inteira e avisa que o resto esta no texto', () => {
  const frase = 'Esta é uma frase de teste com algumas palavras. ';
  const { texto, cortado } = textoParaFala(frase.repeat(100));
  assert.equal(cortado, true);
  assert.ok(texto.length <= TETO_FALA + 30, `passou do teto: ${texto.length}`);
  assert.match(texto, /palavras\. O restante está no texto\.$/);
  const semPonto = textoParaFala('palavra '.repeat(600), { teto: 100 });
  assert.equal(semPonto.cortado, true); assert.match(semPonto.texto, /^(palavra ){10,}/); assert.match(semPonto.texto, /palavra O restante está no texto\.$/);
});

test('Ogg/Opus INTEIRO (GPT-6 r1 da v1.2): 4 bytes "OggS", cortado, CRC errado, sem fim de fluxo, sem OpusHead ou 2 fluxos = recusado e o degrau seguinte fala', () => {
  assert.equal(problemaOggOpus(OGG), '', 'o Ogg dos testes e inteiro');
  const casos = {
    '4 bytes': Buffer.from('OggS'),
    'cortado no meio da pagina': OGG.subarray(0, OGG.length - 10),
    'lixo depois do fim': Buffer.concat([OGG, Buffer.from('xx')]),
    'sem fim de fluxo': oggOpus({ eos: false }),
    'so cabecalhos': oggOpus({ audio: 0 }),
    'mp3': Buffer.from('ID3 isto e mp3 com mais de vinte e sete bytes'),
  };
  const crc = Buffer.from(OGG); crc[crc.length - 1] ^= 0xff; casos['CRC errado'] = crc;
  const opus = Buffer.from(OGG); opus.write('VorbHead', 28, 'latin1'); casos['nao e Opus'] = opus;
  const dois = Buffer.concat([OGG.subarray(0, OGG.length), oggOpus()]); casos['2 fluxos em sequencia'] = dois;
  for (const [nome, b] of Object.entries(casos)) assert.notEqual(problemaOggOpus(b), '', `${nome} passou`);
});

test('Ogg/Opus com AUDIO de verdade (GPT-6 r2 da v1.2): cabecalhos + pagina de fim vazia, 0 canais, versao estranha, pagina fora de ordem ou continuacao errada = recusado; tags em 2 paginas e varios pacotes por pagina passam', () => {
  const [H, T, A] = [opusHead(), opusTags(), Buffer.alloc(40, 0xf8)];
  const ogg = (...pags) => Buffer.concat(pags);
  const casos = {
    'fim vazio, sem pacote de audio': ogg(pagina({ flags: 2, seq: 0, pacotes: [H] }), pagina({ seq: 1, pacotes: [T] }), pagina({ flags: 4, seq: 2, pacotes: [] })),
    'so pacote de audio vazio': ogg(pagina({ flags: 2, seq: 0, pacotes: [H] }), pagina({ seq: 1, pacotes: [T] }), pagina({ flags: 4, seq: 2, granule: 960, pacotes: [Buffer.alloc(0)] })),
    '0 canais': ogg(pagina({ flags: 2, seq: 0, pacotes: [opusHead(0)] }), pagina({ seq: 1, pacotes: [T] }), pagina({ flags: 4, seq: 2, granule: 960, pacotes: [A] })),
    '3 canais na familia 0': ogg(pagina({ flags: 2, seq: 0, pacotes: [opusHead(3)] }), pagina({ seq: 1, pacotes: [T] }), pagina({ flags: 4, seq: 2, granule: 960, pacotes: [A] })),
    'versao 0x10': ogg(pagina({ flags: 2, seq: 0, pacotes: [opusHead(1, 0x10)] }), pagina({ seq: 1, pacotes: [T] }), pagina({ flags: 4, seq: 2, granule: 960, pacotes: [A] })),
    'pagina pulada': ogg(pagina({ flags: 2, seq: 0, pacotes: [H] }), pagina({ seq: 1, pacotes: [T] }), pagina({ flags: 4, seq: 9, granule: 960, pacotes: [A] })),
    'continuacao sem pacote aberto': ogg(pagina({ flags: 2, seq: 0, pacotes: [H] }), pagina({ seq: 1, pacotes: [T] }), pagina({ flags: 1 | 4, seq: 2, granule: 960, pacotes: [A] })),
    'pacote aberto sem continuacao': ogg(pagina({ flags: 2, seq: 0, pacotes: [H] }), pagina({ seq: 1, pacotes: [Buffer.alloc(300, 0x41)], aberto: true }), pagina({ flags: 4, seq: 2, granule: 960, pacotes: [A] })),
    'OpusHead junto com outro pacote': ogg(pagina({ flags: 2, seq: 0, pacotes: [H, T] }), pagina({ flags: 4, seq: 1, granule: 960, pacotes: [A] })),
    'dois inicios de fluxo': ogg(pagina({ flags: 2, seq: 0, pacotes: [H] }), pagina({ flags: 2, seq: 1, pacotes: [T] }), pagina({ flags: 4, seq: 2, granule: 960, pacotes: [A] })),
  };
  for (const [nome, b] of Object.entries(casos)) assert.notEqual(problemaOggOpus(b), '', `${nome} passou`);
  // validos que encoder de verdade gera: OpusTags grande atravessando a divisa da pagina (continuacao) e varios pacotes numa pagina
  const tagsGrande = opusTags('x'.repeat(600)); const p1 = tagsGrande.subarray(0, 255 * 2); const p2 = tagsGrande.subarray(255 * 2);
  const tagsEm2 = ogg(pagina({ flags: 2, seq: 0, pacotes: [H] }), pagina({ seq: 1, granule: 2n ** 64n - 1n, pacotes: [p1], aberto: true }), pagina({ flags: 1, seq: 2, pacotes: [p2] }), pagina({ flags: 4, seq: 3, granule: 1920, pacotes: [A, A] }));
  assert.equal(problemaOggOpus(tagsEm2), '', 'tags em 2 paginas + 2 pacotes de audio numa pagina');
});

/** Microsoft de mentira: guarda cada chamada e devolve o que `resp` mandar. */
function microsoftFalsa(resp) {
  const chamadas = [];
  const f = async (texto, o) => { chamadas.push({ texto, o }); return resp(); };
  f.chamadas = chamadas; return f;
}
const FALA = 'Resposta secreta da aba sobre o cliente Fulano.';

test('T17a falar: Antonio devolve o Ogg/Opus inteiro; a Microsoft recebe a voz pt-BR-AntonioNeural, o texto e o prazo', async () => {
  const ms = microsoftFalsa(() => OGG);
  const buf = await falar(FALA, { falarMicrosoft: ms, prazoMs: 1234 });
  assert.ok(Buffer.isBuffer(buf) && buf.equals(OGG));
  assert.equal(VOZ_ANTONIO, 'pt-BR-AntonioNeural');
  assert.equal(ms.chamadas.length, 1);
  assert.equal(ms.chamadas[0].texto, FALA);
  assert.equal(ms.chamadas[0].o.voz, 'pt-BR-AntonioNeural');
  assert.equal(ms.chamadas[0].o.prazoMs, 1234);
});

test('T17a falar: Ogg torto (lixo, cortado) = lanca "voz: ogg torto (<motivo>)" sem o texto falado', async () => {
  for (const ruim of [Buffer.from('ID3 isto e mp3 com mais de vinte e sete bytes'), OGG.subarray(0, OGG.length - 10), Buffer.alloc(0)]) {
    const e = await falar(FALA, { falarMicrosoft: microsoftFalsa(() => ruim) }).then(() => null, (x) => x);
    assert.ok(e instanceof Error, 'Ogg torto tinha de lancar');
    assert.match(e.message, /^voz: ogg torto \(.+\)$/);
    assert.ok(!e.message.includes(FALA) && !/secreta|Fulano/.test(e.message), 'o texto falado nunca vai no erro');
  }
});

test('T17a falar: texto vazio, so espaco ou nao-texto = lanca sem chamar a Microsoft', async () => {
  const ms = microsoftFalsa(() => OGG);
  for (const t of ['', '   \n\t ', null, undefined]) {
    await assert.rejects(falar(t, { falarMicrosoft: ms }), /^Error: voz: nada a falar$/);
  }
  assert.equal(ms.chamadas.length, 0, 'a Microsoft nao foi chamada');
});

test('T17a falar: falha da Microsoft passa adiante e a mensagem de erro nunca contem o texto falado', async () => {
  const ms = async () => { throw new Error('voz microsoft: fechou 1007'); };
  const e = await falar(FALA, { falarMicrosoft: ms }).then(() => null, (x) => x);
  assert.equal(e.message, 'voz microsoft: fechou 1007');
  assert.ok(!e.message.includes(FALA));
  const sinal = new AbortController(); sinal.abort(new Error('parou'));
  let recebido = null;
  await falar(FALA, { falarMicrosoft: async (_t, o) => { recebido = o.signal; return OGG; }, signal: sinal.signal });
  assert.equal(recebido, sinal.signal, 'o sinal de desistir chega na Microsoft');
});
