// sessoes-wpp — a resposta da aba em VOZ, com o Antonio da Microsoft (T17, PLANO-TELEGRAM.md, "T17 — resposta em áudio quando
// ele fala por áudio").
// Por que existe: o dono fala com as abas por audio no carro e quer ouvir a resposta (caso real: "usar a mesma voz
// nativa que temos no Telegram que usamos nos outros bots da VPS"; escolheu «b» = o Antonio, gratis). A voz e a do bot da VPS:
// `textoParaFala`, a tabela CRC, `crcOgg` e `problemaOggOpus` sao COPIA FIEL do voz.mjs do bot de sessoes do Telegram do dono (v1.2.1)
// em 11/10/2026 (conserto vale nos dois); o cliente da Microsoft e o lib/voz-microsoft.mjs (copia do mesmo lugar).
// Contrato T17: a fala = o texto da resposta limpo pra ouvir ate TETO_FALA caracteres (acima corta na ultima frase inteira e avisa);
// `falar` sintetiza com o Antonio e so devolve Ogg/Opus INTEIRO (o que o sendVoice do Telegram toca). Modulo puro: sem Telegram, sem
// disco, sem estado; o texto falado nunca vai pra mensagem de erro (nem pro log de quem chama).

export const TETO_FALA = 2500;                      // caracteres falados por resposta (o resto fica no texto)
export const VOZ_ANTONIO = 'pt-BR-AntonioNeural';   // a voz gratis da Microsoft, a mesma do bot da VPS

const EMOJI_RE = /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*\uFE0F?/gu;
/**
 * Texto da resposta (markdown do Claude) -> texto pra FALAR: sem bloco de codigo (vira um aviso curto), sem link cru, sem marcacao, sem
 * emoji, uma linha por frase. Acima de `teto` corta na ultima frase inteira e avisa que o resto esta no texto.
 * @returns {{texto:string, cortado:boolean}} texto vazio = nada a falar
 */
export function textoParaFala(md, { teto = TETO_FALA } = {}) {
  let t = String(md ?? '').replace(/\r\n?/g, '\n');
  t = t.replace(/```[\s\S]*?(?:```|$)/g, '\n(tem um trecho de código no texto)\n'); // bloco de codigo, fechado ou aberto ate o fim
  t = t.replace(/`([^`\n]+)`/g, '$1');                                             // codigo no meio da frase: fica o conteudo
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');                                  // imagem: o texto alternativo
  t = t.replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, '$1');                    // link: fica o texto
  t = t.replace(/<https?:\/\/[^>\s]+>/g, '(link no texto)');
  t = t.replace(/\bhttps?:\/\/\S+/g, '(link no texto)');                           // endereco nao se le em voz alta
  t = t.replace(/<\/?[a-z][^>\n]*>/gi, '');                                        // tag HTML
  t = t.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');                                  // titulo
  t = t.replace(/^[ \t]{0,3}>[ \t]?/gm, '');                                       // citacao
  t = t.replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, ''); // separador de tabela
  t = t.replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '');                     // linha horizontal
  t = t.replace(/^[ \t]*\|/gm, '').replace(/\|[ \t]*$/gm, '').replace(/[ \t]*\|[ \t]*/g, ', '); // celulas de tabela
  t = t.replace(/^[ \t]*[-*+•][ \t]+/gm, '');                                      // marcador de lista
  t = t.replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2');                        // negrito, riscado
  t = t.replace(/(^|[\s(])[*_](?=\S)([^*_\n]*?\S)[*_](?=[\s).,;:!?]|$)/gm, '$1$2'); // italico
  t = t.replace(EMOJI_RE, '').replace(/[ \t]+([.,;:!?…])/g, '$1'); // o que sobrou do emoji nao deixa espaco antes da pontuacao
  const linhas = t.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => /[\p{L}\p{N}]/u.test(l));
  t = linhas.map((l) => (/[.!?:;,…]$/.test(l) ? l : `${l}.`)).join(' '); // fim de linha vira pausa (item de lista, titulo)
  if (t.length <= teto) return { texto: t, cortado: false };
  const cabe = t.slice(0, teto);
  const fim = Math.max(cabe.lastIndexOf('. '), cabe.lastIndexOf('! '), cabe.lastIndexOf('? '));
  const base = fim >= teto * 0.5 ? cabe.slice(0, fim + 1) : cabe.replace(/\s+\S*$/, '');
  return { texto: `${base} O restante está no texto.`, cortado: true };
}

// CRC das paginas Ogg (polinomio 0x04C11DB7, sem reflexao, comeca em 0: RFC 3533)
const TABELA_CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let r = i << 24; for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1; t[i] = r >>> 0; } return t; })();
export function crcOgg(buf) { let c = 0; for (let i = 0; i < buf.length; i++) c = ((c << 8) ^ TABELA_CRC[((c >>> 24) ^ buf[i]) & 0xff]) >>> 0; return c >>> 0; }

/** Ogg/Opus inteiro (RFC 3533 + RFC 7845)? '' = sim; senao o motivo curto (vai pro log). Paginas encadeadas ate o ultimo byte, CRC de
 *  cada uma, 1 fluxo so, numeradas em ordem, continuacao de pacote coerente; 1a pagina = OpusHead sozinho com inicio de fluxo e campos
 *  validos (versao, >= 1 canal, mapa de canais); depois o OpusTags; pelo menos 1 pacote de AUDIO de verdade (contar pagina nao prova
 *  audio: GPT-6 r2 da v1.2) e a ultima pagina com fim de fluxo (pega o arquivo cortado bem na divisa de uma pagina). */
export function problemaOggOpus(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 27) return 'curto demais';
  let pos = 0; let n = 0; let serial = null; let flagsUltima = 0;
  const pacotes = []; let atual = null; // atual = partes do pacote que ainda nao terminou (atravessa a divisa da pagina)
  while (pos < buf.length) {
    if (flagsUltima & 4) return 'pagina depois do fim de fluxo'; // 2o fluxo emendado (ou lixo com cara de pagina) depois do fim
    if (buf.length - pos < 27 || buf.toString('latin1', pos, pos + 4) !== 'OggS' || buf[pos + 4] !== 0) return `pagina ${n + 1} torta`;
    const flags = buf[pos + 5]; const nseg = buf[pos + 26];
    if (buf.length - pos < 27 + nseg) return `pagina ${n + 1} cortada`;
    let corpo = 0; for (let i = 0; i < nseg; i++) corpo += buf[pos + 27 + i];
    const fim = pos + 27 + nseg + corpo; if (fim > buf.length) return `pagina ${n + 1} cortada`;
    const pag = Buffer.from(buf.subarray(pos, fim)); const crc = pag.readUInt32LE(22); pag.writeUInt32LE(0, 22);
    if (crcOgg(pag) !== crc) return `pagina ${n + 1} com CRC errado`;
    const s = buf.readUInt32LE(pos + 14); if (serial == null) serial = s; else if (s !== serial) return 'mais de um fluxo';
    if (buf.readUInt32LE(pos + 18) !== n) return `pagina ${n + 1} fora de ordem`;
    if (n === 0 ? !(flags & 2) : !!(flags & 2)) return n === 0 ? 'nao comeca com OpusHead' : 'mais de um inicio de fluxo';
    if (!!(flags & 1) !== !!atual) return `pagina ${n + 1} com continuacao errada`;
    let off = pos + 27 + nseg; const antes = pacotes.length;
    for (let i = 0; i < nseg; i++) {
      const lv = buf[pos + 27 + i]; (atual || (atual = [])).push(buf.subarray(off, off + lv)); off += lv;
      if (lv < 255) { pacotes.push(Buffer.concat(atual)); atual = null; } // valor < 255 fecha o pacote
    }
    if (n === 0 && (pacotes.length - antes !== 1 || atual)) return 'a primeira pagina tem de ter so o OpusHead';
    flagsUltima = flags; pos = fim; n++;
  }
  if (atual) return 'ultimo pacote cortado';
  const head = pacotes[0];
  if (!head || head.length < 19 || head.toString('latin1', 0, 8) !== 'OpusHead') return 'nao comeca com OpusHead';
  const versao = head[8]; const canais = head[9]; const familia = head[18];
  if (versao === 0 || (versao & 0xf0)) return 'OpusHead com versao desconhecida';
  if (canais < 1) return 'OpusHead sem canal';
  if (familia === 0 ? canais > 2 : head.length < 21 + canais) return 'OpusHead com mapa de canais errado';
  if (!pacotes[1] || pacotes[1].toString('latin1', 0, 8) !== 'OpusTags') return 'sem OpusTags';
  if (!pacotes.slice(2).some((p) => p.length > 0)) return 'sem audio';
  if (!(flagsUltima & 4)) return 'sem fim de fluxo (cortado?)';
  return '';
}

/**
 * Fala `texto` (ja limpo pelo textoParaFala) com a `voz` (padrao o Antonio) e devolve o Ogg/Opus (Buffer) conferido pelo problemaOggOpus.
 * Erro = `voz: <motivo>` ou `voz microsoft: <motivo>` (o do lib/voz-microsoft.mjs, que ja repete 1 vez a falha de passagem); nunca o texto.
 * @param {string} texto
 * @param {object} o  voz (A5a: o nome curto da Microsoft, o vozDoConfig do config.json; sem ela = o VOZ_ANTONIO), falarMicrosoft
 *                    (injetado nos testes; sem ele = o do lib/voz-microsoft.mjs, por import dinamico como o falarCom da
 *                    VPS: o voz-microsoft.mjs importa o crcOgg daqui, entao import estatico seria circular), prazoMs (sintese inteira),
 *                    signal (desistir antes)
 * @returns {Promise<Buffer>}
 */
export async function falar(texto, { voz = VOZ_ANTONIO, falarMicrosoft = null, prazoMs = 60000, signal = null } = {}) {
  if (typeof texto !== 'string' || !texto.trim()) throw new Error('voz: nada a falar');
  const fm = typeof falarMicrosoft === 'function' ? falarMicrosoft : (await import('./voz-microsoft.mjs')).falarMicrosoft;
  const buf = await fm(texto, { voz, prazoMs, signal });
  const p = problemaOggOpus(buf);
  if (p) throw new Error(`voz: ogg torto (${p})`);
  return buf;
}
