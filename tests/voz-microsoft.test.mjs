// tests/voz-microsoft.test.mjs — v1.2.1 as vozes GRATIS da Microsoft (o servico de leitura em voz alta do navegador Edge; o mesmo que o
// Hermes e o OpenClaw usam de fabrica). Sem rede: o servico e de mentira (tests/microsoft-falsa.mjs, socket local) e o WebM tambem
// (tests/webm-falso.mjs). O que esta suite prova: a chave Sec-MS-GEC bate com a conta da referencia; o texto vira SSML seguro e cabe no
// limite; o WebM/Opus do servico vira Ogg/Opus INTEIRO sem recodificar (e o ruim e recusado); o cliente WebSocket proprio conversa com o
// servico (cabecalhos do Edge, ping, fragmento, fechamento) e falha fechado (codigo de fechamento, sem audio, 403, teto, prazo, /parar).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { chaveGec, textoSsml, montarSsml, webmParaOgg, amostrasOpus, falarMicrosoft, TOKEN_EDGE, FORMATO_MICROSOFT, TETO_SSML_BYTES, VERSAO_EDGE, URL_MICROSOFT } from '../lib/voz-microsoft.mjs';
import { problemaOggOpus } from '../lib/voz.mjs';
import { webmOpus, pacoteOpus, el } from './lib/webm-falso.mjs';
import { servidorMicrosoftFalso } from './lib/microsoft-falsa.mjs';

/** Paginas de um Ogg: [{ flags, granule, pacotes }] (so pra conferir o que o remux montou). */
function paginasOgg(buf) {
  const pags = []; let p = 0; let atual = null;
  while (p < buf.length) {
    const nseg = buf[p + 26]; const segs = [...buf.subarray(p + 27, p + 27 + nseg)]; let off = p + 27 + nseg; const pacotes = [];
    for (const lv of segs) { (atual || (atual = [])).push(buf.subarray(off, off + lv)); off += lv; if (lv < 255) { pacotes.push(Buffer.concat(atual)); atual = null; } }
    pags.push({ flags: buf[p + 5], granule: Number(buf.readBigUInt64LE(p + 6)), pacotes }); p = off;
  }
  return pags;
}
const relogioNovo = () => ({ desvioS: 0 });

// T20 (12/10/2026): o endereco antigo (speech.platform.bing.com) recusa com 403 fora dos EUA; o do Edge agora e o api.msedgeservices.com
test('T20 microsoft: o endereco padrao e o novo do Edge (api.msedgeservices.com), nunca o speech.platform.bing.com', () => {
  const u = new URL(URL_MICROSOFT);
  assert.equal(u.protocol, 'wss:');
  assert.equal(u.host, 'api.msedgeservices.com');
  assert.equal(u.pathname, '/tts/cognitiveservices/websocket/v1');
});

test('v1.2.1 microsoft: a chave Sec-MS-GEC e a mesma conta da referencia (conferida com Python em 27/09/2026), em blocos de 5 minutos', () => {
  assert.equal(chaveGec(1790553130), 'D77E0A35998AD93FF2E9C2CD8CFB78237D33C7B3F83C3A225EBB5E5FF772CDD7');
  assert.equal(chaveGec(1790553299.9), 'D77E0A35998AD93FF2E9C2CD8CFB78237D33C7B3F83C3A225EBB5E5FF772CDD7', 'o mesmo bloco de 5 minutos');
  assert.equal(chaveGec(1790553300), '0ED32A91CC44C29C8C0A75FC379B2C55AE40C59A2A5A9DC0379C951FC4088B2B', 'virou o bloco');
  assert.match(TOKEN_EDGE, /^[0-9A-F]{32}$/);
  assert.equal(FORMATO_MICROSOFT, 'webm-24khz-16bit-mono-opus', 'o Ogg direto o servico recusa (sondado: fecha com 1007)');
});

test('v1.2.1 microsoft: texto -> SSML escapado, sem caractere de controle; acima do teto corta na ultima frase inteira e avisa', () => {
  const r = textoSsml('A & B <c> "d"\u000b\u0007fim.');
  assert.equal(r.texto, 'A &amp; B &lt;c&gt; "d"  fim.'); assert.equal(r.cortado, false);
  const longo = 'Esta é uma frase de teste com acentuação. '.repeat(200);
  const c = textoSsml(longo, 400);
  assert.ok(Buffer.byteLength(c.texto) <= 400, `cabe no teto (${Buffer.byteLength(c.texto)} bytes)`);
  assert.equal(c.cortado, true); assert.match(c.texto, /acentuação\. O restante está no texto\.$/);
  assert.ok(Buffer.byteLength(textoSsml('&'.repeat(3000)).texto) <= TETO_SSML_BYTES, 'escape que estoura o limite tambem corta');
  const s = montarSsml('pt-BR-FranciscaNeural', 'oi &amp; tchau');
  assert.match(s, /^<speak version='1\.0' xmlns='http:\/\/www\.w3\.org\/2001\/10\/synthesis' xml:lang='pt-BR'><voice name='pt-BR-FranciscaNeural'>/);
  assert.match(s, />oi &amp; tchau<\/prosody><\/voice><\/speak>$/);
});

test('v1.2.1 microsoft: TOC do pacote Opus -> amostras a 48 kHz (RFC 6716 3.1); pacote torto = 0', () => {
  assert.equal(amostrasOpus(Buffer.from([0xd8, 1])), 960, 'CELT 20 ms, 1 quadro (o que o servico manda)');
  assert.equal(amostrasOpus(Buffer.from([0x00, 1])), 480, 'SILK 10 ms');
  assert.equal(amostrasOpus(Buffer.from([0x18, 1])), 2880, 'SILK 60 ms');
  assert.equal(amostrasOpus(Buffer.from([0x60, 1])), 480, 'hibrido 10 ms');
  assert.equal(amostrasOpus(Buffer.from([0x80, 1])), 120, 'CELT 2,5 ms');
  assert.equal(amostrasOpus(Buffer.from([0xd9, 1])), 1920, '2 quadros iguais');
  assert.equal(amostrasOpus(Buffer.from([0xdb, 0x03, 1])), 2880, 'codigo 3: o 2o byte diz quantos quadros');
  assert.equal(amostrasOpus(Buffer.from([0xdb, 0x07])), 0, 'mais de 120 ms num pacote');
  assert.equal(amostrasOpus(Buffer.from([0xdb])), 0, 'codigo 3 sem o byte da contagem');
  assert.equal(amostrasOpus(Buffer.alloc(0)), 0, 'pacote vazio');
});

test('v1.2.1 microsoft: o WebM do servico vira Ogg/Opus INTEIRO com os mesmos pacotes (sem recodificar), granule e pre-skip certos', () => {
  const ogg = webmParaOgg(webmOpus({ blocos: 130 }));
  assert.equal(problemaOggOpus(ogg), '', 'passa na mesma conferencia dos outros degraus');
  const pags = paginasOgg(ogg);
  assert.equal(pags[0].flags, 2); assert.equal(pags[0].pacotes[0].toString('latin1', 0, 8), 'OpusHead'); assert.equal(pags[0].pacotes[0].readUInt16LE(10), 312, 'o pre-skip do servico fica');
  assert.equal(pags[1].pacotes[0].toString('latin1', 0, 8), 'OpusTags');
  const audio = pags.slice(2).flatMap((p) => p.pacotes);
  assert.equal(audio.length, 130); audio.forEach((p, i) => assert.ok(p.equals(pacoteOpus(i)), `pacote ${i} igual ao do WebM`));
  assert.equal(pags.at(-1).granule, 130 * 960, 'granule final = amostras a 48 kHz');
  assert.equal(pags.at(-1).flags & 4, 4, 'fim de fluxo na ultima');
  assert.ok(pags.length >= 4, 'o audio vem repartido em mais de uma pagina');
  pags.slice(2, -1).forEach((p) => assert.equal(p.flags, 0));
});

test('v1.2.1 microsoft: WebM ruim e recusado com o motivo (falha fechada: melhor so o texto)', () => {
  const bom = webmOpus({ blocos: 10 });
  assert.throws(() => webmParaOgg(bom.subarray(0, bom.length - 7)), /cortado/);
  assert.throws(() => webmParaOgg(webmOpus({ semHead: true })), /OpusHead/);
  assert.throws(() => webmParaOgg(webmOpus({ lacing: true })), /lacing/);
  assert.throws(() => webmParaOgg(webmOpus({ codec: 'A_VORBIS' })), /nao e Opus/);
  assert.throws(() => webmParaOgg(webmOpus({ trilhas: 2 })), /mais de uma trilha/);
  assert.throws(() => webmParaOgg(webmOpus({ blocos: 0 })), /sem audio/);
  assert.throws(() => webmParaOgg(webmOpus({ toc: 0xdb })), /pacote Opus torto/);
  assert.throws(() => webmParaOgg(Buffer.from('OggS isto nao e WebM')), /nao e WebM/);
  assert.throws(() => webmParaOgg(Buffer.alloc(0)), /nao e WebM/);
  assert.throws(() => webmParaOgg(Buffer.concat([bom, el('ec', Buffer.alloc(3))]).subarray(0, bom.length + 2)), /cortado/);
});

test('v1.2.1 microsoft: conversa com o servico de mentira = cabecalhos do Edge, formato webm, voz no SSML, Ogg inteiro (com ping e fragmento)', async () => {
  const f = await servidorMicrosoftFalso({ blocos: 40 });
  try {
    const ogg = await falarMicrosoft('Oi & tchau.', { voz: 'pt-BR-AntonioNeural', url: f.url, relogio: relogioNovo() });
    assert.equal(problemaOggOpus(ogg), '');
    assert.equal(paginasOgg(ogg).slice(2).flatMap((p) => p.pacotes).length, 40, 'todo o audio chegou, inclusive o do fragmento');
    assert.equal(f.pedidos.length, 1); const p = f.pedidos[0];
    assert.equal(p.headers.origin, 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold');
    assert.match(p.headers['user-agent'], / Edg\/\d+/); assert.match(p.headers.cookie, /^muid=[0-9A-F]{32};$/);
    assert.equal(p.headers.upgrade, 'websocket'); assert.equal(p.headers['sec-websocket-version'], '13');
    const q = new URL(`ws://x${p.url}`).searchParams;
    assert.equal(q.get('TrustedClientToken'), TOKEN_EDGE); assert.match(q.get('ConnectionId'), /^[0-9a-f]{32}$/);
    assert.equal(q.get('Ocp-Apim-Subscription-Key'), TOKEN_EDGE, 'T20: o endereco novo le o token por aqui');
    assert.match(q.get('Sec-MS-GEC'), /^[0-9A-F]{64}$/); assert.match(q.get('Sec-MS-GEC-Version'), /^1-\d+\.\d+\.\d+\.\d+$/);
    assert.match(p.textos[0], /\r\nPath:speech\.config\r\n/); assert.match(p.textos[0], /"outputFormat":"webm-24khz-16bit-mono-opus"/);
    assert.match(p.ssml, /<voice name='pt-BR-AntonioNeural'>/); assert.match(p.ssml, /Oi &amp; tchau\./); assert.match(p.ssml, /\r\nX-Timestamp:[^\r]+Z\r\n/);
    assert.equal(p.pong, true, 'respondeu o ping');
    assert.equal(p.fechou, 1000, 'fechou direito no fim');
  } finally { await f.fechar(); }
});

test('v1.2.1 microsoft: fechou antes do fim = erro com o codigo; terminou sem audio = erro; assinatura errada no aperto de mao = erro', async () => {
  for (const [modo, re] of [['fecha-1007', /voz microsoft: fechou 1007/], ['sem-audio', /voz microsoft: sem audio/], ['accept-errado', /voz microsoft: aperto de mao/]]) {
    const f = await servidorMicrosoftFalso({ modo });
    try { await assert.rejects(falarMicrosoft('oi', { voz: 'pt-BR-FranciscaNeural', url: f.url, relogio: relogioNovo() }), re, modo); }
    finally { await f.fechar(); }
  }
});

test('v1.2.1 microsoft: 403 com Date = acerta o relogio e tenta 1 vez de novo (como a referencia); 403 de novo = erro HTTP 403', async () => {
  const f = await servidorMicrosoftFalso({ modo: '403-uma-vez' }); const relogio = relogioNovo();
  try {
    const ogg = await falarMicrosoft('oi', { voz: 'pt-BR-FranciscaNeural', url: f.url, relogio });
    assert.equal(problemaOggOpus(ogg), ''); assert.equal(f.pedidos.length, 2);
    assert.ok(Math.abs(relogio.desvioS - 7200) < 5, `o relogio andou 2 h (${relogio.desvioS})`);
    const gec2 = new URL(`ws://x${f.pedidos[1].url}`).searchParams.get('Sec-MS-GEC'); const agora = Date.now() / 1000 + relogio.desvioS;
    assert.ok([agora - 300, agora, agora + 300].map(chaveGec).includes(gec2), 'a 2a tentativa usou o relogio acertado');
  } finally { await f.fechar(); }
  const g = await servidorMicrosoftFalso({ modo: '403-sempre' });
  try {
    await assert.rejects(falarMicrosoft('oi', { voz: 'pt-BR-FranciscaNeural', url: g.url, relogio: relogioNovo() }), /voz microsoft: HTTP 403/);
    assert.equal(g.pedidos.length, 2, 'so 1 nova tentativa');
  } finally { await g.fechar(); }
});

// v1.2.1: a Microsoft virou a voz de FABRICA; na prova real de 27/09/2026 o servico derrubou 2 de 8 conexoes seguidas (read ECONNRESET)
// antes de responder. O pedido nao tem efeito colateral: 1 nova tentativa, depois de meio segundo; derrubou de novo = erro (a escada desce).
test('v1.2.1 microsoft: conexao derrubada antes da resposta = tenta 1 vez de novo; derrubou de novo = erro', async () => {
  const f = await servidorMicrosoftFalso({ modo: 'derruba-uma-vez' });
  try {
    const ogg = await falarMicrosoft('oi', { voz: 'pt-BR-FranciscaNeural', url: f.url, relogio: relogioNovo() });
    assert.equal(problemaOggOpus(ogg), ''); assert.equal(f.pedidos.length, 2);
  } finally { await f.fechar(); }
  const g = await servidorMicrosoftFalso({ modo: 'derruba-sempre' });
  try {
    await assert.rejects(falarMicrosoft('oi', { voz: 'pt-BR-FranciscaNeural', url: g.url, relogio: relogioNovo() }), /voz microsoft: (read ECONNRESET|a conexao caiu antes do fim)/);
    assert.equal(g.pedidos.length, 2, 'so 1 nova tentativa');
  } finally { await g.fechar(); }
});

// Revisao da voz gratis (pedido do dono: "faz uma revisão do que pode estar dando problema [...] da voz da Microsoft"): o servico
// pode ficar mudo (aceita e nao responde) ou dar 5xx de passagem. Antes, o mudo segurava o prazo inteiro de 60 s antes do proximo degrau.
test('v1.2.1 microsoft: servico mudo no aperto de mao ou no meio do audio = desiste no prazo curto, sem nova tentativa; 5xx de passagem = tenta de novo', async () => {
  for (const [modo, opc] of [['mudo-no-aperto', { prazoConexaoMs: 200 }], ['mudo', { prazoSilencioMs: 200 }]]) {
    const f = await servidorMicrosoftFalso({ modo });
    try {
      const t0 = Date.now();
      const e = await falarMicrosoft('oi', { voz: 'pt-BR-FranciscaNeural', url: f.url, relogio: relogioNovo(), ...opc }).catch((x) => x);
      assert.match(String(e && e.message), /voz microsoft: sem resposta do servico/, modo); assert.equal(e.code, 'ETIMEDOUT');
      assert.ok(Date.now() - t0 < 3000, `${modo}: desistiu cedo (${Date.now() - t0} ms), sem esperar os 60 s`);
      assert.equal(f.pedidos.length, 1, `${modo}: mudo NAO tenta de novo (dobraria a espera antes do proximo degrau: 20 s / 30 s)`);
    } finally { await f.fechar(); }
  }
  const g = await servidorMicrosoftFalso({ modo: '503-uma-vez' });
  try {
    const ogg = await falarMicrosoft('oi', { voz: 'pt-BR-FranciscaNeural', url: g.url, relogio: relogioNovo() });
    assert.equal(problemaOggOpus(ogg), ''); assert.equal(g.pedidos.length, 2);
  } finally { await g.fechar(); }
});

// 2o revisor (27/09/2026): RST depois do turn.end jogava fora o audio INTEIRO, sintetizava de novo e contava pra pausa.
test('v1.2.1 microsoft: conexao derrubada DEPOIS do fim do audio = entrega o audio (nao repete o pedido)', async () => {
  const f = await servidorMicrosoftFalso({ modo: 'rst-depois-do-fim' });
  try {
    const ogg = await falarMicrosoft('oi', { voz: 'pt-BR-FranciscaNeural', url: f.url, relogio: relogioNovo() });
    assert.equal(problemaOggOpus(ogg), ''); assert.equal(f.pedidos.length, 1, 'nao pediu de novo');
  } finally { await f.fechar(); }
});

// A quebra mais comum desse servico na historia da referencia (edge-tts) foi ele passar a exigir versao nova do Edge (403). A versao vira
// ajuste (ROUTER_VOZ_MICROSOFT_VERSAO no voz.mjs): quem instalou corrige sem esperar codigo novo.
test('v1.2.1 microsoft: a versao do Edge vai no Sec-MS-GEC-Version e no User-Agent; versao torta = erro sem conexao', async () => {
  const f = await servidorMicrosoftFalso();
  try {
    await falarMicrosoft('oi', { voz: 'pt-BR-FranciscaNeural', url: f.url, relogio: relogioNovo(), versao: '150.0.3700.12' });
    assert.equal(new URL(`ws://x${f.pedidos[0].url}`).searchParams.get('Sec-MS-GEC-Version'), '1-150.0.3700.12');
    assert.match(f.pedidos[0].headers['user-agent'], /Chrome\/150\.0\.0\.0 Safari\/537\.36 Edg\/150\.0\.0\.0$/);
    await falarMicrosoft('oi', { voz: 'pt-BR-FranciscaNeural', url: f.url, relogio: relogioNovo() });
    assert.equal(new URL(`ws://x${f.pedidos[1].url}`).searchParams.get('Sec-MS-GEC-Version'), `1-${VERSAO_EDGE}`, 'sem versao = a padrao');
    await assert.rejects(falarMicrosoft('oi', { voz: 'pt-BR-FranciscaNeural', url: f.url, versao: '150; rm -rf' }), /voz microsoft: versao do Edge invalida/);
    assert.equal(f.pedidos.length, 2, 'versao torta nem conecta');
  } finally { await f.fechar(); }
});

test('v1.2.1 microsoft: teto de bytes, prazo e /parar interrompem sem pendurar; sem servidor = erro de conexao', async () => {
  const f = await servidorMicrosoftFalso({ modo: 'grande' });
  try { await assert.rejects(falarMicrosoft('oi', { voz: 'pt-BR-FranciscaNeural', url: f.url, relogio: relogioNovo(), teto: 20000 }), /grande demais/); }
  finally { await f.fechar(); }
  const m = await servidorMicrosoftFalso({ modo: 'mudo' });
  try {
    const t0 = Date.now(); const e = await falarMicrosoft('oi', { voz: 'pt-BR-FranciscaNeural', url: m.url, relogio: relogioNovo(), prazoMs: 300 }).catch((x) => x);
    assert.equal(e && e.name, 'TimeoutError'); assert.ok(Date.now() - t0 < 3000, 'o prazo cortou');
    const ac = new AbortController(); setTimeout(() => ac.abort(), 150);
    const e2 = await falarMicrosoft('oi', { voz: 'pt-BR-FranciscaNeural', url: m.url, relogio: relogioNovo(), signal: ac.signal }).catch((x) => x);
    assert.equal(e2 && e2.name, 'AbortError', '/parar interrompe');
  } finally { await m.fechar(); }
  const livre = createServer(); await new Promise((r) => livre.listen(0, '127.0.0.1', r)); const porta = livre.address().port; await new Promise((r) => livre.close(r));
  await assert.rejects(falarMicrosoft('oi', { voz: 'pt-BR-FranciscaNeural', url: `ws://127.0.0.1:${porta}/x`, relogio: relogioNovo() }), (e) => /ECONNREFUSED/.test(`${e.message} ${e.code || ''} ${(e.cause && e.cause.code) || ''}`));
});
