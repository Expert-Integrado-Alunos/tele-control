// tests/ogg-falso.mjs — Ogg/Opus pequeno e INTEIRO pros testes da voz (desde a r1 do GPT-6 na v1.2 o voz.mjs confere a estrutura:
// paginas encadeadas, CRC, OpusHead/OpusTags, audio e fim de fluxo). O audio e de mentira (o Telegram falso nao toca), a embalagem e de
// verdade. `oggOpus({ eos: false })` e um pedaco (`subarray`) montam os casos ruins.
import { crcOgg } from '../../lib/voz.mjs';

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
/** 1 pagina Ogg com CRC certo. `aberto: true` = o ultimo pacote continua na proxima pagina (sem o valor < 255 que fecha). */
export function pagina({ flags = 0, serial = 0x7e57, seq, granule = 0, pacotes, aberto = false }) {
  const segs = []; pacotes.forEach((p, k) => { let n = p.length; while (n >= 255) { segs.push(255); n -= 255; } if (!(aberto && k === pacotes.length - 1)) segs.push(n); });
  const h = Buffer.alloc(27 + segs.length);
  h.write('OggS', 0, 'latin1'); h[5] = flags; h.writeBigUInt64LE(BigInt(granule), 6); h.writeUInt32LE(serial, 14); h.writeUInt32LE(seq, 18); h[26] = segs.length;
  segs.forEach((v, i) => { h[27 + i] = v; });
  const pag = Buffer.concat([h, ...pacotes]); pag.writeUInt32LE(crcOgg(pag), 22);
  return pag;
}
/** 1 canal, 48 kHz; `audio` paginas de audio com 1 pacote cada; `eos` marca a ultima; `rotulo` entra no OpusTags (pra diferenciar). */
export const opusHead = (canais = 1, versao = 1) => Buffer.concat([Buffer.from('OpusHead', 'latin1'), Buffer.from([versao, canais, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0])]);
export const opusTags = (rotulo = 'teste') => Buffer.concat([Buffer.from('OpusTags', 'latin1'), u32(rotulo.length), Buffer.from(rotulo, 'latin1'), u32(0)]);
export function oggOpus({ audio = 3, eos = true, rotulo = 'teste' } = {}) {
  const head = opusHead(); const tags = opusTags(rotulo);
  const pags = [pagina({ flags: 2, seq: 0, pacotes: [head] }), pagina({ seq: 1, pacotes: [tags] })];
  for (let i = 0; i < audio; i++) pags.push(pagina({ flags: eos && i === audio - 1 ? 4 : 0, seq: 2 + i, granule: 960 * (i + 1), pacotes: [Buffer.alloc(40, 0xf8)] }));
  return Buffer.concat(pags);
}
