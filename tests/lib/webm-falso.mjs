// tests/webm-falso.mjs — WebM/Opus pequeno no MESMO formato que o servico de voz da Microsoft devolve (sondado em 27/09/2026): EBML com
// DocType webm, Segment e Clusters com tamanho DESCONHECIDO (fluxo ao vivo), 1 trilha A_OPUS com o OpusHead no CodecPrivate e SimpleBlocks
// sem lacing, 1 pacote Opus de 20 ms cada (TOC 0xd8). O audio e de mentira; a embalagem e de verdade. As opcoes montam os casos ruins.

const vint = (n) => { // tamanho EBML com o menor numero de bytes (ate 2^56 - 2)
  for (let len = 1; len <= 8; len++) if (n < 2 ** (7 * len) - 1) { const b = Buffer.alloc(len); let v = n; for (let i = len - 1; i >= 0; i--) { b[i] = v % 256; v = Math.floor(v / 256); } b[0] |= 0x80 >> (len - 1); return b; }
  throw new Error('grande demais');
};
const DESCONHECIDO = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
const id = (hex) => Buffer.from(hex, 'hex');
export const el = (hex, corpo) => Buffer.concat([id(hex), vint(corpo.length), corpo]);
const uint = (n, bytes = 1) => { const b = Buffer.alloc(bytes); b.writeUIntBE(n, 0, bytes); return b; };

/** OpusHead de 1 canal (RFC 7845): pre-skip e taxa de entrada como a Microsoft manda (312 e 24 kHz). */
export const opusHeadMs = (preSkip = 312) => { const h = Buffer.alloc(19); h.write('OpusHead', 0, 'latin1'); h[8] = 1; h[9] = 1; h.writeUInt16LE(preSkip, 10); h.writeUInt32LE(24000, 12); return h; };

/** Pacote Opus de mentira: TOC + corpo. 0xd8 = CELT 20 ms, 1 quadro (= 960 amostras a 48 kHz). */
export const pacoteOpus = (i, toc = 0xd8, tam = 60) => Buffer.concat([Buffer.from([toc]), Buffer.alloc(tam - 1, (i * 7 + 1) & 0xff)]);

/**
 * @param {object} o
 * @param {number} o.blocos     pacotes de audio (repartidos em Clusters de 25, como o servico: 1 Cluster a cada 500 ms)
 * @param {string} o.codec      CodecID da trilha
 * @param {boolean} o.semHead   sem CodecPrivate
 * @param {boolean} o.lacing    marca lacing no 1o bloco (o servico nao usa; o remux recusa)
 * @param {number} o.toc        TOC dos pacotes
 * @param {number} o.trilhas    quantas TrackEntry
 */
export function webmOpus({ blocos = 5, codec = 'A_OPUS', semHead = false, lacing = false, toc = 0xd8, trilhas = 1, preSkip = 312 } = {}) {
  const ebml = el('1a45dfa3', Buffer.concat([el('4286', uint(1)), el('4282', Buffer.from('webm\0', 'latin1')), el('4287', uint(2)), el('4285', uint(2))]));
  const info = el('1549a966', el('2ad7b1', uint(1000000, 3)));
  const trilha = (n) => el('ae', Buffer.concat([el('d7', uint(n)), el('83', uint(2)), el('86', Buffer.from(`${codec}\0`, 'latin1')),
    ...(semHead ? [] : [el('63a2', opusHeadMs(preSkip))]), el('e1', Buffer.concat([el('b5', Buffer.from('40d7700000000000', 'hex')), el('9f', uint(1))]))]));
  const tracks = el('1654ae6b', Buffer.concat(Array.from({ length: trilhas }, (_, i) => trilha(i + 1))));
  const clusters = [];
  for (let c = 0; c * 25 < blocos; c++) {
    const partes = [id('1f43b675'), DESCONHECIDO, el('e7', uint(c * 500, 2))];
    for (let i = c * 25; i < Math.min(blocos, (c + 1) * 25); i++) {
      const flags = 0x80 | (lacing && i === 0 ? 0x02 : 0);
      partes.push(el('a3', Buffer.concat([Buffer.from([0x81]), uint((i - c * 25) * 20, 2), Buffer.from([flags]), pacoteOpus(i, toc)])));
    }
    clusters.push(Buffer.concat(partes));
  }
  return Buffer.concat([ebml, id('18538067'), DESCONHECIDO, info, tracks, ...clusters]);
}
