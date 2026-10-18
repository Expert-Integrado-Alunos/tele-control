// voz-microsoft.mjs — v1.2.1 as vozes GRATIS da Microsoft (caso real: "tem alguma voz que seja de graça? As que vêm nativas do
// Hermes e do OpenClaw são grátis né?" -> "b"; depois "por padrão, venha sempre com a voz grátis", o Antonio de fabrica). E o servico
// de leitura em voz alta do navegador Edge: gratis, sem chave e SEM contrato (nao e API oficial: pode mudar ou parar sem aviso). Por isso
// falha de passagem tenta 1 vez de novo, servico mudo desiste no prazo curto (sem repetir), queda depois do audio inteiro entrega, a versao do Edge e ajustavel (ROUTER_VOZ_MICROSOFT_VERSAO)
// e o voz.mjs desce a escada (e pausa a Microsoft 5 min depois de 2 falhas seguidas).
// Protocolo (sondado em 27/09/2026 e conferido no codigo-fonte da biblioteca edge-tts, lido como referencia; nada instalado, nada
// copiado): WebSocket (no api.msedgeservices.com desde a T20, abaixo) com o token PUBLICO do Edge (vem dentro do navegador, igual em toda instalacao; nao e
// segredo) e a chave Sec-MS-GEC (SHA-256 de "hora do Windows em blocos de 5 min + token"); o cliente manda speech.config (formato) e o
// SSML; o servico devolve turn.start, response, o audio em mensagens binarias (2 bytes com o tamanho do cabecalho + cabecalho + audio) e
// turn.end. Relogio fora = 403 com Date: acerta o relogio e tenta 1 vez de novo (como a referencia).
// Formato: o Ogg/Opus que o Telegram quer o servico RECUSA (fecha com 1007); o WebM/Opus ele aceita. `webmParaOgg` remonta os MESMOS
// pacotes Opus em paginas Ogg (sem recodificar, sem ffmpeg) e o voz.mjs confere o Ogg como confere o dos outros degraus.
// Cliente WebSocket proprio (RFC 6455, node:tls/node:net): o Node 20 do container nao tem WebSocket global e o servico exige cabecalhos
// (Origin, User-Agent, Cookie) que o WebSocket padrao nao deixa mandar. Modulo puro: sem Telegram, sem disco; o texto nunca vai pra log.
// Copiado do bot de sessoes do Telegram do dono (v1.2.1) em 11/10/2026 (T17, PLANO-TELEGRAM.md); conserto vale nos dois.
// T20 (12/10/2026): o speech.platform.bing.com passou a recusar o aperto de mao (403) fora dos EUA desde ~10/10/2026 (issue #490 da
// edge-tts; aqui a ultima resposta em voz saiu 11/10 22:26 e todas desde 12/10 00:18 deram 403). O Edge sintetiza agora pelo
// api.msedgeservices.com, com o MESMO token publico tambem em Ocp-Apim-Subscription-Key e a mesma Sec-MS-GEC (PR #491 da edge-tts,
// aberto em 12/10/2026; sondado daqui no mesmo dia: o endereco antigo 403, o novo devolve o audio).
'use strict';
import { connect as conectarTls } from 'node:tls';
import { connect as conectarTcp } from 'node:net';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { crcOgg } from './voz.mjs';

export const URL_MICROSOFT = 'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1'; // T20; o de antes: speech.platform.bing.com
export const TOKEN_EDGE = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'; // publico: embutido no navegador Edge (o mesmo em toda instalacao)
export const VERSAO_EDGE = '143.0.3650.75';                     // versao do navegador que o servico espera ver (a da referencia em 27/09/2026)
export const FORMATO_MICROSOFT = 'webm-24khz-16bit-mono-opus';  // o ogg-* o servico recusa (fecha com 1007, sondado em 27/09/2026)
export const TETO_SSML_BYTES = 4000;                            // o servico aceita ate 4.096 bytes de texto por pedido; folga pro escape
export const RELOGIO = { desvioS: 0 };                          // acerto do relogio pelo Date de um 403; vale pro processo
// Revisao de 27/09/2026 (caso real: "faz uma revisão do que pode estar dando problema"): servico mudo segurava o prazo inteiro (60 s) antes do
// proximo degrau. O aperto de mao leva menos de 1 s e o audio chega em pedacos seguidos: sem nada nesses prazos = desiste (e tenta 1 vez).
export const PRAZO_CONEXAO_MS = 10 * 1000;                      // da conexao ate o "101" do WebSocket
export const PRAZO_SILENCIO_MS = 15 * 1000;                     // depois do "101", o maior intervalo sem nenhum byte do servico
const VERSAO_RE = /^\d{1,4}(?:\.\d{1,6}){3}$/;
const ORIGEM_EDGE = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
/** User-Agent do Edge da versao dada (o servico olha o numero maior). */
const uaEdge = (versao) => { const m = versao.split('.')[0]; return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${m}.0.0.0 Safari/537.36 Edg/${m}.0.0.0`; };
const GUID_WS = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'; // RFC 6455 1.3
const VOZ_RE = /^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/;
const AVISO_CORTE = ' O restante está no texto.';

/** Chave Sec-MS-GEC: SHA-256 (maiusculo) de "hora do Windows (100 ns desde 1601) arredondada pra baixo em 5 min" + token. */
export function chaveGec(unixS) {
  let t = Math.floor(unixS) + 11644473600; // segundos desde 1601-01-01 (epoca do Windows)
  t -= t % 300;
  return createHash('sha256').update(`${BigInt(t) * 10000000n}${TOKEN_EDGE}`, 'ascii').digest('hex').toUpperCase();
}

const escapar = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cabe = (s, lim) => Buffer.byteLength(escapar(s)) <= lim;
/** Texto -> conteudo do SSML: sem caractere de controle (o servico recusa; a tabulacao vertical vem de PDF), escapado e dentro do teto
 *  em bytes. Acima do teto corta na ultima frase inteira (senao na ultima palavra) e avisa que o resto esta no texto. */
export function textoSsml(texto, teto = TETO_SSML_BYTES) {
  const limpo = String(texto ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ');
  if (cabe(limpo, teto)) return { texto: escapar(limpo), cortado: false };
  const lim = teto - Buffer.byteLength(AVISO_CORTE);
  let base = '';
  for (const f of limpo.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) || []) { if (!cabe((base + f).trimEnd(), lim)) break; base += f; }
  if (!base.trim()) { base = ''; for (const w of limpo.split(/(\s+)/)) { if (!cabe(base + w, lim)) break; base += w; } }
  if (!base.trim()) { base = ''; for (const ch of limpo) { if (!cabe(base + ch, lim)) break; base += ch; } } // nem uma palavra cabe
  return { texto: `${escapar(base.trimEnd())}${AVISO_CORTE}`, cortado: true };
}

/** SSML do pedido (voz = nome curto da Microsoft, ex.: pt-BR-FranciscaNeural; `escapado` ja passou pelo textoSsml). A5a: o xml:lang
 *  sai do proprio nome da voz (os 5 primeiros caracteres: pt-BR, en-US; o falarMicrosoft ja conferiu o VOZ_RE). */
export const montarSsml = (voz, escapado, rate = '+0%') => `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${String(voz).slice(0, 5)}'><voice name='${voz}'><prosody pitch='+0Hz' rate='${rate}' volume='+0%'>${escapado}</prosody></voice></speak>`;
/** v1.2.1 28/09: velocidade (1 = normal; 0,9 = mais devagar; 1,15 = mais rapida) -> rate do SSML ('-10%', '+15%'), limitada a -50%..+100%. */
export const rateSsml = (velocidade = 1) => { const n = Number(velocidade); const p = Math.max(-50, Math.min(100, Math.round(((Number.isFinite(n) ? n : 1) - 1) * 100))); return `${p >= 0 ? '+' : ''}${p}%`; };

/** Amostras (a 48 kHz) de 1 pacote Opus pelo TOC (RFC 6716 3.1). 0 = pacote torto (vazio, sem contagem, mais de 120 ms). */
export function amostrasOpus(p) {
  if (!p || p.length < 1) return 0;
  const cfg = p[0] >> 3; const c = p[0] & 3;
  const quadro = cfg < 12 ? [480, 960, 1920, 2880][cfg & 3] : cfg < 16 ? [480, 960][cfg & 1] : [120, 240, 480, 960][cfg & 3];
  let n = 1;
  if (c === 1 || c === 2) n = 2;
  else if (c === 3) { if (p.length < 2) return 0; n = p[1] & 0x3f; }
  return n > 0 && n * quadro <= 5760 ? n * quadro : 0;
}

// ---- WebM (Matroska/EBML) -> Ogg/Opus, sem recodificar ----
const ID = { EBML: 0x1a45dfa3, SEGMENT: 0x18538067, CLUSTER: 0x1f43b675, TRACKS: 0x1654ae6b, TRILHA: 0xae, GRUPO: 0xa0, CODEC: 0x86, PRIVADO: 0x63a2, SIMPLES: 0xa3, BLOCO: 0xa1 };
const ENTRAR = new Set([ID.SEGMENT, ID.CLUSTER, ID.TRACKS, ID.TRILHA, ID.GRUPO]); // contem elementos: o laco entra neles (o servico manda Segment e Cluster SEM tamanho)
function lerVint(b, p, ehId) {
  if (p >= b.length) throw new Error('WebM cortado');
  const f = b[p]; if (f === 0) throw new Error('WebM torto');
  const n = Math.clz32(f) - 23; // zeros a esquerda no 1o byte + 1
  if (n > (ehId ? 4 : 8)) throw new Error('WebM torto');
  if (p + n > b.length) throw new Error('WebM cortado');
  let v = ehId ? f : f & (0xff >> n); let tudo1 = !ehId && v === (0xff >> n);
  for (let i = 1; i < n; i++) { v = v * 256 + b[p + i]; if (b[p + i] !== 0xff) tudo1 = false; }
  return { v, n, desconhecido: tudo1 };
}
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const SERIAL_OGG = 0x566f7a31; // "Voz1"
const PACOTES_POR_PAGINA = 50;  // ~1 s de audio por pagina (pacotes de 20 ms)
function paginaOgg({ flags, granule, seq, pacotes }) {
  const segs = []; for (const p of pacotes) { let n = p.length; while (n >= 255) { segs.push(255); n -= 255; } segs.push(n); }
  const h = Buffer.alloc(27 + segs.length);
  h.write('OggS', 0, 'latin1'); h[5] = flags; h.writeBigUInt64LE(BigInt(granule), 6); h.writeUInt32LE(SERIAL_OGG, 14); h.writeUInt32LE(seq, 18); h[26] = segs.length;
  segs.forEach((v, i) => { h[27 + i] = v; });
  const pag = Buffer.concat([h, ...pacotes]); pag.writeUInt32LE(crcOgg(pag), 22);
  return pag;
}
/** Os pacotes Opus do WebM em paginas Ogg (RFC 7845): OpusHead do CodecPrivate sozinho na 1a, OpusTags na 2a, audio em paginas de ate
 *  50 pacotes com o granule = amostras a 48 kHz ate o ultimo pacote da pagina, fim de fluxo na ultima. Erro = motivo curto. */
export function webmParaOgg(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf.readUInt32BE(0) !== ID.EBML) throw new Error('nao e WebM');
  let p = 0; let codec = ''; let head = null; let trilhas = 0; const pacotes = [];
  while (p < buf.length) {
    const id = lerVint(buf, p, true); const tam = lerVint(buf, p + id.n, false); const ini = p + id.n + tam.n;
    if (id.v === ID.TRILHA) trilhas++;
    if (ENTRAR.has(id.v)) { p = ini; continue; }
    if (tam.desconhecido) throw new Error('WebM torto (elemento sem tamanho)');
    const fim = ini + tam.v; if (fim > buf.length) throw new Error('WebM cortado');
    if (id.v === ID.CODEC) codec = buf.toString('latin1', ini, fim).replace(/\0+$/, '');
    else if (id.v === ID.PRIVADO) head = Buffer.from(buf.subarray(ini, fim));
    else if (id.v === ID.SIMPLES || id.v === ID.BLOCO) {
      const trk = lerVint(buf, ini, false); const off = ini + trk.n + 3; if (off > fim) throw new Error('WebM cortado');
      if (buf[ini + trk.n + 2] & 0x06) throw new Error('bloco com lacing (o servico nao usa)');
      pacotes.push(Buffer.from(buf.subarray(off, fim)));
    }
    p = fim;
  }
  if (trilhas > 1) throw new Error('mais de uma trilha');
  if (codec !== 'A_OPUS') throw new Error(`a trilha nao e Opus (${codec || 'sem codec'})`);
  if (!head || head.length < 19 || head.toString('latin1', 0, 8) !== 'OpusHead') throw new Error('sem OpusHead');
  if (!pacotes.length) throw new Error('sem audio');
  const vendor = Buffer.from('telegram-multi-session', 'latin1');
  const tags = Buffer.concat([Buffer.from('OpusTags', 'latin1'), u32(vendor.length), vendor, u32(0)]);
  const pags = [paginaOgg({ flags: 2, granule: 0, seq: 0, pacotes: [head] }), paginaOgg({ flags: 0, granule: 0, seq: 1, pacotes: [tags] })];
  let granule = 0; let seq = 2; let lote = []; let segs = 0;
  pacotes.forEach((pk, i) => {
    const n = amostrasOpus(pk); if (!n) throw new Error(`pacote Opus torto (${i + 1})`);
    const s = Math.floor(pk.length / 255) + 1; if (s > 255) throw new Error('pacote Opus grande demais');
    if (lote.length && (segs + s > 255 || lote.length >= PACOTES_POR_PAGINA)) { pags.push(paginaOgg({ flags: 0, granule, seq: seq++, pacotes: lote })); lote = []; segs = 0; }
    lote.push(pk); segs += s; granule += n;
  });
  pags.push(paginaOgg({ flags: 4, granule, seq, pacotes: lote }));
  return Buffer.concat(pags);
}

// ---- cliente WebSocket minimo (RFC 6455) ----
/** Data no formato do JavaScript do navegador, em UTC (o servico quer assim no X-Timestamp). */
const dataJs = (d = new Date()) => d.toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) (\S+) GMT$/, '$1 $3 $2 $4 $5 GMT+0000 (Coordinated Universal Time)');
/** Quadro do servidor: null = ainda nao chegou o cabecalho; { falta } = cabecalho chegou, o corpo nao; { erro }; ou o quadro inteiro. */
function lerQuadro(b) {
  if (b.length < 2) return null;
  if (b[0] & 0x70) return { erro: 'quadro com bits reservados' };
  if (b[1] & 0x80) return { erro: 'quadro do servidor com mascara' };
  let n = b[1] & 0x7f; let p = 2;
  if (n === 126) { if (b.length < 4) return null; n = b.readUInt16BE(2); p = 4; }
  else if (n === 127) { if (b.length < 10) return null; const g = b.readBigUInt64BE(2); if (g > BigInt(Number.MAX_SAFE_INTEGER)) return { erro: 'quadro gigante' }; n = Number(g); p = 10; }
  if (b.length < p + n) return { falta: n };
  return { fin: !!(b[0] & 0x80), op: b[0] & 0x0f, dados: b.subarray(p, p + n), tam: p + n };
}
/** Quadro do cliente: sempre com mascara (RFC 6455 5.3). */
function quadroCliente(op, dados) {
  const n = dados.length; const m = randomBytes(4); let cab;
  if (n < 126) cab = Buffer.from([0x80 | op, 0x80 | n]);
  else if (n < 65536) { cab = Buffer.alloc(4); cab[0] = 0x80 | op; cab[1] = 0x80 | 126; cab.writeUInt16BE(n, 2); }
  else { cab = Buffer.alloc(10); cab[0] = 0x80 | op; cab[1] = 0x80 | 127; cab.writeBigUInt64BE(BigInt(n), 2); }
  const corpo = Buffer.from(dados); for (let i = 0; i < n; i++) corpo[i] ^= m[i & 3];
  return Buffer.concat([cab, m, corpo]);
}

/** 1 conexao = 1 pedido: devolve o WebM inteiro (Buffer) ou rejeita. Erro de HTTP leva `.status` e, com Date, `.dataServidor` (s);
 *  servico mudo alem do prazo leva `.code = 'ETIMEDOUT'`. */
function pedirWebm(base, voz, escapado, { sinal, teto, relogio, versao = VERSAO_EDGE, prazoConexaoMs = PRAZO_CONEXAO_MS, prazoSilencioMs = PRAZO_SILENCIO_MS, rate = '+0%' }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(base); } catch (_) { reject(new Error('voz microsoft: endereco invalido')); return; }
    if (u.protocol !== 'wss:' && u.protocol !== 'ws:') { reject(new Error('voz microsoft: endereco invalido')); return; }
    u.searchParams.set('TrustedClientToken', TOKEN_EDGE);
    u.searchParams.set('Ocp-Apim-Subscription-Key', TOKEN_EDGE); // T20: o endereco novo le o token por aqui
    u.searchParams.set('ConnectionId', randomUUID().replace(/-/g, ''));
    u.searchParams.set('Sec-MS-GEC', chaveGec(Date.now() / 1000 + relogio.desvioS));
    u.searchParams.set('Sec-MS-GEC-Version', `1-${versao}`);
    const seguro = u.protocol === 'wss:'; const porta = Number(u.port) || (seguro ? 443 : 80);
    let sock; let acabou = false; let fechoTimer = null; let vigia = null;
    let buf = Buffer.alloc(0); let aberto = false; let frag = null; let viuFim = false; const audio = []; let bytes = 0; let brutos = 0;
    const err = (m) => new Error(`voz microsoft: ${m}`);
    const fim = (erro, valor) => {
      if (acabou) return; acabou = true;
      if (sinal) sinal.removeEventListener('abort', aoParar);
      clearTimeout(fechoTimer); clearTimeout(vigia); if (sock) sock.destroy();
      if (erro) reject(erro); else resolve(valor);
    };
    /** (Re)arma o prazo de "servico mudo": o do aperto de mao ate o 101; depois, a cada byte que chega, o do silencio. */
    const armar = (ms, etapa) => {
      clearTimeout(vigia);
      vigia = setTimeout(() => { const e = err(`sem resposta do servico em ${Math.round(ms / 100) / 10} s (${etapa})`); e.code = 'ETIMEDOUT'; fim(e); }, ms);
    };
    const aoParar = () => fim(sinal.reason || err('interrompido'));
    const entregar = () => fim(null, Buffer.concat(audio, bytes));
    if (sinal && sinal.aborted) { aoParar(); return; }
    if (sinal) sinal.addEventListener('abort', aoParar, { once: true });
    const chave = randomBytes(16).toString('base64');
    const enviar = (op, dados) => { if (!acabou) sock.write(quadroCliente(op, dados)); };
    const mensagem = (op, m) => {
      if (op === 1) {
        const path = (m.toString('utf8').match(/(?:^|\r\n)Path:([^\r\n]*)/) || [])[1];
        if (path !== 'turn.end') return; // turn.start, response, audio.metadata: nada a fazer
        viuFim = true;
        if (!bytes) { fim(err('sem audio')); return; }
        const c = Buffer.alloc(2); c.writeUInt16BE(1000); enviar(8, c); // fecha direito e espera o eco (no maximo 2 s)
        fechoTimer = setTimeout(entregar, 2000); return;
      }
      if (m.length < 2) { fim(err('binario sem cabecalho')); return; }
      const h = m.readUInt16BE(0); if (2 + h > m.length) { fim(err('binario com cabecalho torto')); return; }
      if (!/(?:^|\r\n)Path:audio(?:\r\n|$)/.test(m.toString('latin1', 2, 2 + h))) { fim(err('binario que nao e audio')); return; }
      const dados = m.subarray(2 + h); if (!dados.length) return; // o binario vazio do fim
      bytes += dados.length; if (bytes > teto) { fim(err(`resposta grande demais (mais de ${teto} bytes)`)); return; }
      audio.push(Buffer.from(dados));
    };
    const tratar = (q) => {
      if (q.op === 9) { enviar(10, q.dados); return; } // ping -> pong
      if (q.op === 10) return;
      if (q.op === 8) {
        if (viuFim) { entregar(); return; }
        const cod = q.dados.length >= 2 ? q.dados.readUInt16BE(0) : 1005;
        const motivo = q.dados.length > 2 ? q.dados.toString('utf8', 2).replace(/[^\x20-\x7e]/g, '').slice(0, 80) : '';
        fim(err(`fechou ${cod}${motivo ? ` (${motivo})` : ''}`)); return;
      }
      if (q.op === 0) {
        if (!frag) { fim(err('continuacao sem inicio')); return; }
        frag.partes.push(Buffer.from(q.dados)); if (!q.fin) return;
        const { op, partes } = frag; frag = null; mensagem(op, Buffer.concat(partes)); return;
      }
      if (q.op === 1 || q.op === 2) {
        if (frag) { fim(err('mensagem no meio de outra')); return; }
        if (!q.fin) { frag = { op: q.op, partes: [Buffer.from(q.dados)] }; return; }
        mensagem(q.op, q.dados); return;
      }
      fim(err(`quadro desconhecido (${q.op})`));
    };
    const aoReceber = (d) => {
      if (acabou) return;
      if (aberto) armar(prazoSilencioMs, 'audio');
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      if (!aberto) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) { if (buf.length > 16384) fim(err('resposta torta')); return; }
        const linhas = buf.subarray(0, i).toString('latin1').split('\r\n'); buf = buf.subarray(i + 4);
        const status = Number((linhas[0].match(/^HTTP\/1\.[01] (\d{3})/) || [])[1]) || 0;
        const hs = {}; for (const l of linhas.slice(1)) { const k = l.indexOf(':'); if (k > 0) hs[l.slice(0, k).trim().toLowerCase()] = l.slice(k + 1).trim(); }
        if (status !== 101) { const e = err(`HTTP ${status || '?'}`); e.status = status; const dt = Date.parse(hs.date || ''); if (Number.isFinite(dt)) e.dataServidor = dt / 1000; fim(e); return; }
        const esperado = createHash('sha1').update(`${chave}${GUID_WS}`).digest('base64');
        if (hs['sec-websocket-accept'] !== esperado || !/^websocket$/i.test(hs.upgrade || '')) { fim(err('aperto de mao torto')); return; }
        aberto = true; armar(prazoSilencioMs, 'audio');
        enviar(1, Buffer.from(`X-Timestamp:${dataJs()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"${FORMATO_MICROSOFT}"}}}}\r\n`));
        enviar(1, Buffer.from(`X-RequestId:${randomUUID().replace(/-/g, '')}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${dataJs()}Z\r\nPath:ssml\r\n\r\n${montarSsml(voz, escapado, rate)}`)); // o "Z" a mais e do proprio Edge
      }
      while (!acabou) {
        const q = lerQuadro(buf);
        if (!q) return;
        if (q.erro) { fim(err(q.erro)); return; }
        if (q.falta != null) { if (q.falta > teto + 65536) fim(err(`resposta grande demais (mais de ${teto} bytes)`)); return; }
        brutos += q.dados.length; if (brutos > teto + 1024 * 1024) { fim(err(`resposta grande demais (mais de ${teto} bytes)`)); return; }
        buf = buf.subarray(q.tam); tratar(q);
      }
    };
    const aoFechar = () => { if (viuFim) entregar(); else fim(err('a conexao caiu antes do fim')); };
    try {
      sock = seguro ? conectarTls({ host: u.hostname, port: porta, servername: u.hostname, ALPNProtocols: ['http/1.1'] }) : conectarTcp({ host: u.hostname, port: porta });
    } catch (e) { fim(err(String((e && e.message) || e))); return; }
    armar(prazoConexaoMs, 'aperto de mao');
    sock.once(seguro ? 'secureConnect' : 'connect', () => {
      sock.write([`GET ${u.pathname}${u.search} HTTP/1.1`, `Host: ${u.host}`, 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${chave}`, 'Sec-WebSocket-Version: 13',
        'Pragma: no-cache', 'Cache-Control: no-cache', `Origin: ${ORIGEM_EDGE}`, `User-Agent: ${uaEdge(versao)}`, 'Accept-Language: en-US,en;q=0.9',
        `Cookie: muid=${randomBytes(16).toString('hex').toUpperCase()};`, '', ''].join('\r\n'));
    });
    sock.on('data', aoReceber);
    sock.on('error', (e) => { // 2o revisor (27/09/2026): conexao derrubada DEPOIS do turn.end nao joga fora o audio que ja chegou inteiro
      if (viuFim && bytes) { entregar(); return; }
      const x = err(String((e && e.message) || e)); x.code = e && e.code; x.cause = e; fim(x); });
    sock.on('end', aoFechar);
    sock.on('close', aoFechar);
  });
}

/** Espera `ms` ou ate o sinal (/parar ou prazo) disparar, o que vier antes (rejeita com o motivo do sinal). */
const pausa = (ms, sinal) => new Promise((resolve, reject) => {
  if (sinal.aborted) { reject(sinal.reason); return; }
  const aoParar = () => { clearTimeout(tm); reject(sinal.reason); };
  const tm = setTimeout(() => { sinal.removeEventListener('abort', aoParar); resolve(); }, ms);
  sinal.addEventListener('abort', aoParar, { once: true });
});

/**
 * Fala `texto` com uma voz da Microsoft. Devolve o Ogg/Opus (Buffer). Erro = `voz microsoft: <motivo>` (nunca o texto).
 * @param {string} texto  ja limpo pra fala (voz.mjs textoParaFala)
 * @param {object} o      voz (nome curto, ex.: pt-BR-FranciscaNeural), url (vazio = o do Edge), signal (/parar), prazoMs (total), teto
 *                        (bytes), relogio ({ desvioS }, o do processo por padrao), versao (do Edge; vazio = VERSAO_EDGE),
 *                        prazoConexaoMs / prazoSilencioMs (servico mudo)
 */
export async function falarMicrosoft(texto, { voz, url = '', signal = null, prazoMs = 60 * 1000, teto = 20 * 1024 * 1024, relogio = RELOGIO,
  versao = '', prazoConexaoMs = PRAZO_CONEXAO_MS, prazoSilencioMs = PRAZO_SILENCIO_MS, velocidade = 1 } = {}) {
  if (!VOZ_RE.test(String(voz || ''))) throw new Error('voz microsoft: voz invalida');
  const ver = String(versao || VERSAO_EDGE); if (!VERSAO_RE.test(ver)) throw new Error('voz microsoft: versao do Edge invalida');
  const { texto: escapado } = textoSsml(texto);
  if (!escapado.trim()) throw new Error('voz microsoft: nada a falar');
  const t = AbortSignal.timeout(prazoMs); const sinal = signal ? AbortSignal.any([signal, t]) : t;
  // v1.2.1: falha DE PASSAGEM = 1 nova tentativa depois de meio segundo (o pedido nao tem efeito colateral; a Microsoft e a voz de fabrica e,
  // sem isso, a resposta caia pro proximo degrau): conexao derrubada (read ECONNRESET: 2 de 8 conexoes seguidas na prova real de
  // 27/09/2026), rede que piscou (DNS, EPIPE) e erro 5xx no aperto de mao. Servico MUDO (ETIMEDOUT) nao repete: raramente e de passagem e
  // a 2a espera dobrava o atraso antes do proximo degrau (20 s / 30 s; 2o revisor). 403 tem a regra dele (relogio) e o resto (4xx,
  // formato, TLS) e falha de verdade: desce direto.
  const TRANSITORIO = new Set(['ECONNRESET', 'EPIPE', 'EAI_AGAIN', 'ECONNABORTED']);
  const passageiro = (e) => e && (TRANSITORIO.has(e.code) || e.status >= 500 || /a conexao caiu antes do fim/.test(String(e.message || '')));
  for (let tentativa = 0; ; tentativa++) {
    let webm;
    try { webm = await pedirWebm(url || URL_MICROSOFT, voz, escapado, { sinal, teto, relogio, versao: ver, prazoConexaoMs, prazoSilencioMs, rate: rateSsml(velocidade) }); }
    catch (e) {
      if (e && e.status === 403 && e.dataServidor && tentativa === 0 && !sinal.aborted) { relogio.desvioS += e.dataServidor - (Date.now() / 1000 + relogio.desvioS); continue; }
      if (passageiro(e) && tentativa === 0 && !sinal.aborted) { await pausa(500, sinal); continue; }
      throw e;
    }
    try { return webmParaOgg(webm); } catch (e) { throw new Error(`voz microsoft: ${e.message}`); }
  }
}
