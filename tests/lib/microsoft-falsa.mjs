// tests/microsoft-falsa.mjs — o servico de voz da Microsoft (o do navegador Edge) DE MENTIRA, num socket local: aperto de mao do WebSocket
// (RFC 6455) e o protocolo do servico como sondado em 27/09/2026 (speech.config + ssml do cliente; turn.start, response, audio em binario
// com cabecalho de 2 bytes, turn.end). A resposta vem picada como a de verdade, com um ping no meio e 1 mensagem em 2 fragmentos.
// Modos: ok | fecha-1007 (fecha com codigo antes do fim) | sem-audio | 403-uma-vez (403 com Date 2 h adiantado, depois ok) | 403-sempre |
// mudo (aceita e nunca responde) | grande (audio sem fim) | accept-errado (aperto de mao com a assinatura errada) | derruba-uma-vez (RST
// antes de responder, depois ok) | derruba-sempre | mudo-no-aperto (recebe o pedido e nunca responde, nem o 101) | 503-uma-vez.
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { webmOpus } from './webm-falso.mjs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Quadro do servidor pro cliente (sem mascara, RFC 6455 5.1). */
export function quadro(opcode, dados, { fin = true } = {}) {
  const b0 = (fin ? 0x80 : 0) | opcode; const n = dados.length; let cab;
  if (n < 126) cab = Buffer.from([b0, n]);
  else if (n < 65536) { cab = Buffer.alloc(4); cab[0] = b0; cab[1] = 126; cab.writeUInt16BE(n, 2); }
  else { cab = Buffer.alloc(10); cab[0] = b0; cab[1] = 127; cab.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([cab, dados]);
}

/** Quadros do cliente (com mascara). Devolve os inteiros e o resto que ainda nao chegou todo. */
function lerQuadros(buf) {
  const quadros = []; let p = 0;
  for (;;) {
    if (buf.length - p < 2) break;
    const op = buf[p] & 0x0f; const mascara = !!(buf[p + 1] & 0x80); let n = buf[p + 1] & 0x7f; let q = p + 2;
    if (n === 126) { if (buf.length - q < 2) break; n = buf.readUInt16BE(q); q += 2; } else if (n === 127) { if (buf.length - q < 8) break; n = Number(buf.readBigUInt64BE(q)); q += 8; }
    const chave = mascara ? buf.subarray(q, q + 4) : null; if (mascara) q += 4;
    if (buf.length - q < n) break;
    const dados = Buffer.from(buf.subarray(q, q + n)); if (chave) for (let i = 0; i < n; i++) dados[i] ^= chave[i & 3];
    quadros.push({ op, mascara, dados }); p = q + n;
  }
  return { quadros, resto: buf.subarray(p) };
}

const cabBin = (ct) => Buffer.from(`X-RequestId:0123456789abcdef0123456789abcdef\r\n${ct ? `Content-Type:${ct}\r\n` : ''}X-StreamId:ABCDEF0123456789ABCDEF0123456789\r\nPath:audio\r\n`);
const mensagemBin = (dados, ct = 'audio/webm; codec=opus') => { const cab = cabBin(ct); const l = Buffer.alloc(2); l.writeUInt16BE(cab.length); return Buffer.concat([l, cab, dados]); };
const mensagemTxt = (path, corpo = '{}') => Buffer.from(`X-RequestId:0123456789abcdef0123456789abcdef\r\nContent-Type:application/json; charset=utf-8\r\nPath:${path}\r\n\r\n${corpo}`);

export async function servidorMicrosoftFalso({ modo = 'ok', blocos = 30 } = {}) {
  const pedidos = []; const conexoes = new Set(); let n403 = 0; let nDerruba = 0; let n503 = 0;
  const srv = createServer((sock) => {
    conexoes.add(sock); sock.on('close', () => conexoes.delete(sock)); sock.on('error', () => {});
    let buf = Buffer.alloc(0); let aberto = false; const ped = { url: '', headers: {}, textos: [], ssml: '', pong: false, fechou: null };
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!aberto) {
        const fim = buf.indexOf('\r\n\r\n'); if (fim < 0) return;
        const linhas = buf.subarray(0, fim).toString('latin1').split('\r\n'); buf = buf.subarray(fim + 4);
        ped.url = linhas[0].split(' ')[1];
        for (const l of linhas.slice(1)) { const i = l.indexOf(':'); if (i > 0) ped.headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
        pedidos.push(ped);
        if (modo === 'derruba-sempre' || (modo === 'derruba-uma-vez' && nDerruba++ === 0)) { // RST antes de responder (read ECONNRESET no cliente)
          if (typeof sock.resetAndDestroy === 'function') sock.resetAndDestroy(); else sock.destroy(); return;
        }
        if (modo === 'mudo-no-aperto') return; // recebeu o pedido e nunca responde (nem o 101)
        if (modo === '503-uma-vez' && n503++ === 0) { sock.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return; }
        if (modo === '403-sempre' || (modo === '403-uma-vez' && n403++ === 0)) {
          sock.end(`HTTP/1.1 403 Forbidden\r\nDate: ${new Date(Date.now() + 7200 * 1000).toUTCString()}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`); return;
        }
        const accept = createHash('sha1').update(`${ped.headers['sec-websocket-key']}${GUID}`).digest('base64');
        sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${modo === 'accept-errado' ? 'assinatura-errada' : accept}\r\n\r\n`);
        aberto = true;
      }
      const { quadros, resto } = lerQuadros(buf); buf = resto;
      for (const q of quadros) {
        if (!q.mascara) { sock.destroy(); return; } // RFC 6455: quadro do cliente sem mascara derruba a conexao
        if (q.op === 8 && modo === 'rst-depois-do-fim') { if (typeof sock.resetAndDestroy === 'function') sock.resetAndDestroy(); else sock.destroy(); return; } // audio inteiro entregue; derruba em vez do eco
        if (q.op === 8) { ped.fechou = q.dados.length >= 2 ? q.dados.readUInt16BE(0) : 1005; sock.end(quadro(8, q.dados.subarray(0, 2))); return; }
        if (q.op === 10) ped.pong = true;
        if (q.op === 1) { const t = q.dados.toString('utf8'); ped.textos.push(t); if (/\r\nPath:ssml\r\n/.test(t)) { ped.ssml = t; responder(sock); } }
      }
    });
  });
  function responder(sock) {
    if (modo === 'mudo') return;
    sock.write(quadro(1, mensagemTxt('turn.start')));
    if (modo === 'fecha-1007') { const c = Buffer.alloc(2); c.writeUInt16BE(1007); sock.end(quadro(8, Buffer.concat([c, Buffer.from('Unsupported Edge output format')]))); return; }
    sock.write(quadro(1, mensagemTxt('response', '{"context":{"serviceTag":"abc"},"audio":{"type":"inline","streamId":"ABC"}}')));
    if (modo === 'grande') { const pedaco = mensagemBin(Buffer.alloc(4000, 1)); const t = setInterval(() => { if (sock.destroyed) clearInterval(t); else sock.write(quadro(2, pedaco)); }, 5); return; }
    if (modo !== 'sem-audio') {
      const webm = webmOpus({ blocos }); const a = Math.min(100, webm.length); const meio = Math.max(a, Math.floor(webm.length / 2));
      sock.write(quadro(2, mensagemBin(webm.subarray(0, a))));
      sock.write(quadro(9, Buffer.from('ping'))); // o cliente responde pong (com mascara)
      const msg = mensagemBin(webm.subarray(a, meio)); const corte = Math.floor(msg.length / 2); // 1 mensagem binaria em 2 fragmentos
      sock.write(quadro(2, msg.subarray(0, corte), { fin: false })); sock.write(quadro(0, msg.subarray(corte)));
      if (meio < webm.length) sock.write(quadro(2, mensagemBin(webm.subarray(meio))));
      sock.write(quadro(2, mensagemBin(Buffer.alloc(0), null))); // binario vazio sem Content-Type: o servico manda um desses no fim
    }
    sock.write(quadro(1, mensagemTxt('turn.end')));
  }
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${srv.address().port}/consumer/speech/synthesize/readaloud/edge/v1`;
  return { url, pedidos, fechar: () => new Promise((r) => { for (const s of conexoes) s.destroy(); srv.close(() => r()); }) };
}
