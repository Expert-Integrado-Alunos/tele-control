// sessoes-wpp — formato do chamado no Telegram (markdown da aba -> rich message em html e HTML classico do Telegram).
// Modulo PURO: sem I/O, sem rede, sem disco, sem process.env. Contrato: PLANO-TELEGRAM.md ("Desenho aprovado" itens
// 2-5, "Contratos" T1 e "Textos"). Quem envia e o porteiro (telegram.mjs); aqui so se monta o texto.
//
// Origem de esc, ABRE_CERCA, FECHA_CERCA, separarBlocos, mdParaHtml (la: mdToHtml) e mdParaTexto (la: mdToPlain):
// copia do tgfmt.mjs do repositório telegram-multi-session (commit dbff026).
// Copiado, nao importado: aquele repositorio vai pra org dos alunos pelo publicador.
import { horaBRT, diaBRT, ICONE, ICONE_CONTROLE, partesCurtas, RE_CITACAO_DO_DONO } from './formato.mjs';

// ---------- copia do tgfmt.mjs (telegram-multi-session, commit dbff026); so os nomes mdToHtml/mdToPlain mudaram ----------

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Cercas de codigo como no CommonMark: ABREM numa linha que e so crases (3+) + linguagem opcional e FECHAM numa linha que e so
 *  crases (tantas ou mais que a abertura). Tres crases no MEIO de uma linha de codigo (ex.: marker = "```") nao fecham nada —
 *  GPT-6 r6: a regex antiga fechava ali e o resto do codigo virava prosa (`print(2**3**4)` saia `print(234)`). Cerca sem fechamento
 *  vai ate o fim. A MESMA leitura vale pro HTML, pro texto puro e pro corte em partes (splitMarkdown): os tres concordam sobre o
 *  que e codigo. Devolve o texto com o marcador `\0B<i>\0` no lugar de cada bloco, e os blocos {lang, code}. */
export const ABRE_CERCA = /^\s{0,3}(`{3,})([\w+-]*)\s*$/;
export const FECHA_CERCA = /^\s{0,3}(`{3,})\s*$/;
export function separarBlocos(md) {
  const linhas = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const blocos = []; const out = []; let aberto = null; // { crases, lang, linhas }
  const fechaBloco = () => { out.push(`\0B${blocos.push({ lang: aberto.lang, code: aberto.linhas.join('\n') }) - 1}\0`); aberto = null; };
  for (const l of linhas) {
    if (aberto) { const m = FECHA_CERCA.exec(l); if (m && m[1].length >= aberto.crases) fechaBloco(); else aberto.linhas.push(l); continue; }
    const m = ABRE_CERCA.exec(l);
    if (m) { aberto = { crases: m[1].length, lang: m[2], linhas: [] }; continue; }
    out.push(l);
  }
  if (aberto) fechaBloco();
  return { texto: out.join('\n'), blocos };
}

/** markdown -> HTML do Telegram. */
export function mdParaHtml(md) {
  // 1) blocos de codigo saem antes de qualquer outra regra (leitura por linha, ver separarBlocos)
  const { texto, blocos } = separarBlocos(md);
  const blocks = blocos.map((b) => `<pre><code${b.lang ? ` class="language-${esc(b.lang)}"` : ''}>${esc(b.code)}</code></pre>`);
  // marcadores em caracteres de uso privado: ` B2 ` / ` I3 ` colidiam com texto legitimo (celula B2, codigo com " B0 ") e viravam undefined (GPT-6 r7)
  let s = texto.replace(/\0B(\d+)\0/g, (_, i) => `\uE000B${i}\uE001`);
  const inl = [];
  s = s.replace(/`([^`\n]+)`/g, (_, code) => { const i = inl.push(`<code>${esc(code)}</code>`) - 1; return `\uE000I${i}\uE001`; });
  // 2) escapar o resto
  s = esc(s);
  // 3) links [texto](http...) — url ja escapada pelo esc acima
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  // 4) linha a linha: titulos, listas, citacoes, regua
  s = s.split('\n').map((line) => {
    let m;
    if ((m = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line))) return `<b>${m[1]}</b>`;
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return '━━━━━━━━━━';
    if ((m = /^(\s*)[-*+]\s+(.*)$/.exec(line))) return `${m[1]}• ${m[2]}`;
    if ((m = /^\s*&gt;\s?(.*)$/.exec(line))) return `<blockquote>${m[1]}</blockquote>`;
    return line;
  }).join('\n');
  // 5) enfase: negrito antes de italico; italico so com borda de palavra (snake_case e 2*3 ficam quietos)
  s = s.replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, '<b>$1</b>');
  s = s.replace(/__(?=\S)([\s\S]+?)(?<=\S)__/g, '<b>$1</b>');
  s = s.replace(/~~(?=\S)([\s\S]+?)(?<=\S)~~/g, '<s>$1</s>');
  s = s.replace(/(^|[\s(])\*(?=\S)([^*\n]+?)(?<=\S)\*(?=$|[\s.,;:!?)])/gm, '$1<i>$2</i>');
  s = s.replace(/(^|[\s(])_(?=\S)([^_\n]+?)(?<=\S)_(?=$|[\s.,;:!?)])/gm, '$1<i>$2</i>');
  // 6) devolve codigo
  s = s.replace(/\uE000I(\d+)\uE001/g, (_, i) => inl[Number(i)]);
  s = s.replace(/\uE000B(\d+)\uE001/g, (_, i) => blocks[Number(i)]);
  // <blockquote> vizinhos viram um so
  s = s.replace(/<\/blockquote>\n<blockquote>/g, '\n');
  return s;
}

/** markdown -> texto puro legivel (sem asteriscos), pra parcial e pra fallback. Codigo (bloco e inline) e protegido ANTES
 *  das regras de enfase e devolvido literal no fim, como no mdToHtml — `__name__` e `2**3**4` dentro de codigo ficam como
 *  sao (GPT-6 r4: viravam `name` e `234` na previa e no fallback). */
export function mdParaTexto(md) {
  const { texto, blocos } = separarBlocos(md);
  let s = texto; const inl = [];
  s = s.replace(/`([^`\n]+)`/g, (_, code) => `\0I${inl.push(code) - 1}\0`);
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)');
  s = s.split('\n').map((line) => {
    let m;
    if ((m = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line))) return m[1].toUpperCase();
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return '━━━━━━━━━━';
    if ((m = /^(\s*)[-*+]\s+(.*)$/.exec(line))) return `${m[1]}• ${m[2]}`;
    if ((m = /^\s*>\s?(.*)$/.exec(line))) return `▎${m[1]}`;
    return line;
  }).join('\n');
  s = s.replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, '$1').replace(/__(?=\S)([\s\S]+?)(?<=\S)__/g, '$1').replace(/~~(?=\S)([\s\S]+?)(?<=\S)~~/g, '$1');
  s = s.replace(/(^|[\s(])\*(?=\S)([^*\n]+?)(?<=\S)\*(?=$|[\s.,;:!?)])/gm, '$1$2');
  s = s.replace(/(^|[\s(])_(?=\S)([^_\n]+?)(?<=\S)_(?=$|[\s.,;:!?)])/gm, '$1$2');
  s = s.replace(/\0I(\d+)\0/g, (_, i) => inl[Number(i)]);
  s = s.replace(/\0B(\d+)\0/g, (_, i) => blocos[Number(i)].code);
  return s;
}

// ---------- fim da copia ----------

const LIMITE_CLASSICO = 4096; // sendMessage: caracteres VISIVEIS (sem tags, entidades desfeitas)
const LIMITE_FINAL = 12000; // rich: o final inteiro no <details> ate aqui (code points)
const CABECA_FINAL = 4000;
const CAUDA_FINAL = 8000; // a DECISAO fica no fim: a cauda e maior que a cabeca
const MIOLO = '\n(...)\n';
const MAX_TITULO = 80;
const MAX_FALA = 300;
const MAX_CONTEXTO = 400;
const MAX_LINHAS_CONTEXTO = 3;
const MAX_ROTULO = 40;
// Tetos de seguranca pra o classico caber nos 4096 mesmo com pergunta/lista/frase enormes (valem nos 2 formatos).
const MAX_PERGUNTA = 1000;
const MAX_FRASE = 1000;
// T7d2b (PLANO-T7.md, T7d2): a linha do sistema (a resposta do "pendências", ate ~3400 cp) sai inteira ate aqui (folga
// dos 4096). T15: so a ultima aparece.
const MAX_ULTIMA_SISTEMA = 3500;

const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sem I, L, O, 0 e 1 (nao se confundem na tela)
const RE_ID = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;
const RE_DADOS_OPCAO = /^o:([ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}):([0-9])$/;
// T7c1: `i:<ID>` = Mais informações; `c:<ID>` = legado (o botao "Mais contexto" que ainda esta na tela), le igual.
const RE_DADOS_INFORMACOES = /^[ic]:([ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8})$/;
// T14: `z:<ID>` era o Concluir (so na situacao da aba); saiu na T14c e nao e mais lido (toque velho)

/** Corta em n code points (nunca parte par substituto); o `fim` entra dentro dos n. */
function cortarCp(s, n, fim = '...') {
  const cps = Array.from(String(s ?? ''));
  if (cps.length <= n) return cps.join('');
  return cps.slice(0, Math.max(0, n - Array.from(fim).length)).join('').trimEnd() + fim;
}

// Cortes em unidades UTF-16 sem partir par substituto (o limite do classico se mede assim: nunca passa, conte o
// Telegram em caractere ou em UTF-16).
function cabecaU16(s, n) {
  if (s.length <= n) return s;
  const k = n > 0 && /[\uD800-\uDBFF]/.test(s[n - 1]) ? n - 1 : n;
  return s.slice(0, k);
}
function caudaU16(s, n) {
  if (s.length <= n) return s;
  let k = s.length - n;
  if (/[\uDC00-\uDFFF]/.test(s[k])) k += 1;
  return s.slice(k);
}

/** Uma linha sem markdown (titulo, pergunta): tira marcador de titulo/lista/citacao, crases e enfase. */
function semMarkdown(s) {
  let t = String(s ?? '').replace(/\r?\n/g, ' ');
  t = t.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/^\s*>\s?/, '').replace(/^\s*[-*+•]\s+/, '');
  t = t.replace(/`+/g, '');
  t = t.replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, '$1').replace(/__(?=\S)([\s\S]+?)(?<=\S)__/g, '$1').replace(/~~(?=\S)([\s\S]+?)(?<=\S)~~/g, '$1');
  t = t.replace(/(^|[\s(])\*(?=\S)([^*\n]+?)(?<=\S)\*(?=$|[\s.,;:!?)])/g, '$1$2');
  t = t.replace(/(^|[\s(])_(?=\S)([^_\n]+?)(?<=\S)_(?=$|[\s.,;:!?)])/g, '$1$2');
  return t.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
}

/** "HH:MM" como veio; ISO (ou Date) vira HH:MM no fuso em uso pelo horaBRT (A4a: o do dono); o resto = "??:??". */
function fmtHora(h) {
  if (typeof h === 'string' && /^\d{1,2}:\d{2}$/.test(h.trim())) return h.trim();
  if (h instanceof Date) return Number.isNaN(h.getTime()) ? '??:??' : horaBRT(h.toISOString());
  return horaBRT(h);
}

// ---------- rich ----------

/** HTML classico -> corpo de rich message: \n vira <br> fora de <pre>...</pre>; dentro do <pre> o \n fica. */
export function paraRich(htmlClassico) {
  return String(htmlClassico ?? '')
    .split(/(<pre\b[^>]*>[\s\S]*?<\/pre>)/)
    .map((parte, i) => (i % 2 === 1 ? parte : parte.replace(/\n/g, '<br>')))
    .join('');
}

// ---------- lerFinal ----------

const RE_CITACAO = /^>\s*(WhatsApp|Telegram) d[aeo] \p{L}[^\n()«»]{0,39}? \(/u; // A4b: de qualquer nome (o RE_CITACAO_DO_DONO)
const RE_TEM_DECISAO = /decis[aã]o/i;
const RE_ROTULO = /^decis[aã]o\b\s*:?\s*/i;
// Abertura da linha que nao conta pro rotulo: espaco, #, >, -, * e emoji (com seletor de variacao, ZWJ, tecla).
const RE_ABERTURA = /^(?:[\s#>*-]|\p{Extended_Pictographic}|\p{Regional_Indicator}|\uFE0F|\u200D|\u20E3)+/u;
const RE_FICA = /fica com voc[eê]\s*:/i;
const RE_REGUA = /^\s*-{3,}\s*$/;
const RE_ITEM = /^\s*(?:[-*+•]|\d+[.)])\s+(.*)$/;
// 1a opcao: "A)" no comeco da linha (com ou sem "- ") ou depois de espaco; as outras: " / X)" na mesma linha ou no
// comeco das linhas seguintes. Letra so de A a F.
const RE_PRIMEIRA = /(^|[ \t])(?:[-*+•][ \t]+)?A\)[ \t]*/;
const RE_LINHA_OPCAO = /^[ \t]*(?:[-*+•][ \t]+)?([A-F])\)[ \t]*/;
const RE_SEPARA = /[ \t]+\/[ \t]+([A-F])\)[ \t]*/g;

const semAbertura = (l) => l.replace(/\*\*/g, '').replace(RE_ABERTURA, '');

// Linha da DECISAO: a ultima que tem a palavra COMO ROTULO (comeco da linha, depois de emoji/marcador); sem rotulo em
// lugar nenhum, a ultima que contem a palavra. Assim "decisao" em prosa, numa opcao ou na linha de risco depois do
// bloco nao rouba o bloco.
function acharDecisao(linhas) {
  let ultima = -1;
  let rotulo = -1;
  linhas.forEach((l, i) => {
    if (!RE_TEM_DECISAO.test(l)) return;
    ultima = i;
    if (RE_ROTULO.test(semAbertura(l))) rotulo = i;
  });
  return rotulo >= 0 ? rotulo : ultima;
}

function partirOpcoes(resto, letra) {
  const out = [];
  const re = new RegExp(RE_SEPARA.source, 'g');
  let atual = letra;
  let ini = 0;
  let m;
  while ((m = re.exec(resto))) {
    out.push({ letra: atual, bruto: resto.slice(ini, m.index) });
    atual = m[1];
    ini = re.lastIndex;
  }
  out.push({ letra: atual, bruto: resto.slice(ini) });
  return out;
}

const juntarPergunta = (partes) => partes.join(' ').replace(/\s+/g, ' ').trim().replace(/\s*:+$/, '');

// Bloco da DECISAO (da linha do rotulo ate a 1a linha vazia) -> {pergunta, opcoes}.
function lerBloco(bloco) {
  const linhas = bloco.map((l) => l.replace(/\*\*/g, ''));
  const l0 = linhas[0].replace(RE_ABERTURA, '');
  linhas[0] = l0.replace(RE_ROTULO, '');
  const pergunta = [];
  const opcoes = [];
  let comecou = false;
  for (const l of linhas) {
    if (!comecou) {
      const m = RE_PRIMEIRA.exec(l);
      if (!m) { pergunta.push(l); continue; }
      pergunta.push(l.slice(0, m.index));
      comecou = true;
      opcoes.push(...partirOpcoes(l.slice(m.index + m[0].length), 'A'));
      continue;
    }
    const m = RE_LINHA_OPCAO.exec(l);
    if (m) opcoes.push(...partirOpcoes(l.slice(m[0].length), m[1])); // linha que nao abre opcao: fora dos botoes
  }
  const letras = opcoes.map((o) => o.letra).join('');
  if (opcoes.length < 2 || !'ABCDEF'.startsWith(letras)) return { pergunta: juntarPergunta(linhas), opcoes: [] };
  return {
    pergunta: juntarPergunta(pergunta),
    opcoes: opcoes.map((o) => {
      const texto = o.bruto.replace(/\s+/g, ' ').trim().replace(/\s*\/+$/, '').trim();
      return { letra: o.letra, texto, recomendado: /\(recomendado\)/i.test(texto) };
    }),
  };
}

// Bloco da DECISAO = da linha do rotulo ate a 1a linha vazia. Sem opcoes ali e com a 1a linha nao vazia seguinte
// abrindo em A) = as opcoes vieram depois de uma linha vazia (17 de 1064 blocos reais nos transcripts do PC,
// 29/09/2026): o bloco continua ate a proxima linha vazia. So vale se a juncao der opcoes.
function lerDecisao(linhas, i0) {
  const ate = (i) => {
    const b = [];
    for (; i < linhas.length && linhas[i].trim(); i += 1) b.push(linhas[i]);
    return b;
  };
  const bloco = ate(i0);
  const lido = lerBloco(bloco);
  if (lido.opcoes.length) return lido;
  let j = i0 + bloco.length;
  while (j < linhas.length && !linhas[j].trim()) j += 1;
  const m = j < linhas.length ? RE_LINHA_OPCAO.exec(linhas[j].replace(/\*\*/g, '')) : null;
  if (!m || m[1] !== 'A') return lido;
  const junto = lerBloco([...bloco, ...ate(j)]);
  return junto.opcoes.length ? junto : lido;
}

function lerFica(linhas, i) {
  const linha = linhas[i].replace(/\*\*/g, '');
  const m = RE_FICA.exec(linha);
  const resto = linha.slice(m.index + m[0].length).trim();
  const itens = resto ? [resto] : [];
  let j = i + 1;
  if (!resto) while (j < linhas.length && !linhas[j].trim()) j += 1;
  for (; j < linhas.length; j += 1) {
    const item = RE_ITEM.exec(linhas[j]);
    if (!item) break;
    if (item[1].trim()) itens.push(item[1].trim());
  }
  return itens;
}

function contextoDe(linhas) {
  let i = 0;
  while (i < linhas.length && !linhas[i].trim()) i += 1;
  const par = [];
  while (i < linhas.length && linhas[i].trim()) par.push(linhas[i++].trimEnd());
  if (!par.length) return '';
  const txt = par.slice(0, MAX_LINHAS_CONTEXTO).join('\n');
  if (Array.from(txt).length > MAX_CONTEXTO) return cortarCp(txt, MAX_CONTEXTO);
  if (par.length > MAX_LINHAS_CONTEXTO) return cortarCp(`${txt}...`, MAX_CONTEXTO);
  return txt;
}

/**
 * Le a mensagem final da aba -> {tipo:'decisao'|'fica'|'pergunta'|null, contexto, pergunta, opcoes, fica}.
 * contexto = 1o paragrafo antes do bloco (DECISAO / linha "---" / "Fica com você" / linha da pergunta), ate 3 linhas
 * e 400 caracteres. A linha da pergunta tambem corta (decidido no T1): senao a pergunta aparecia 2 vezes no chamado.
 */
export function lerFinal(final) {
  let linhas = String(final ?? '').normalize('NFC').replace(/\r\n?/g, '\n').split('\n');
  const iCitacao = linhas.findIndex((l) => l.trim());
  if (iCitacao >= 0 && RE_CITACAO.test(linhas[iCitacao])) linhas = linhas.slice(iCitacao + 1);
  const out = { tipo: null, contexto: '', pergunta: '', opcoes: [], fica: [] };
  const cortes = [];
  const iRegua = linhas.findIndex((l) => RE_REGUA.test(l));
  if (iRegua >= 0) cortes.push(iRegua);
  const iDecisao = acharDecisao(linhas);
  let iFica = -1;
  linhas.forEach((l, i) => { if (RE_FICA.test(l.replace(/\*\*/g, ''))) iFica = i; });
  if (iDecisao >= 0) {
    Object.assign(out, { tipo: 'decisao' }, lerDecisao(linhas, iDecisao));
    cortes.push(iDecisao);
  } else if (iFica >= 0) {
    out.tipo = 'fica';
    out.fica = lerFica(linhas, iFica);
    cortes.push(iFica);
  } else {
    let iUltima = linhas.length - 1;
    while (iUltima >= 0 && !linhas[iUltima].trim()) iUltima -= 1;
    if (iUltima >= 0 && linhas[iUltima].trim().endsWith('?')) {
      out.tipo = 'pergunta';
      out.pergunta = semMarkdown(linhas[iUltima]);
      cortes.push(iUltima);
    }
  }
  out.contexto = contextoDe(linhas.slice(0, cortes.length ? Math.min(...cortes) : linhas.length));
  return out;
}

// ---------- montarChamado ----------

// T5a: o icone antes do nome, como em toda mensagem do porteiro no WhatsApp (F4g). `icone` = o da
// mensagem do sistema no movido dela (ICONE_SISTEMA); sem ele, o ICONE.
function tituloDe(t, icone) {
  return `${typeof icone === 'string' && icone ? icone : ICONE} ${cortarCp(semMarkdown(t), MAX_TITULO, '…') || 'sem nome'}`;
}

function falaCurta(fala) {
  return cortarCp(String(fala ?? '').replace(/\s+/g, ' ').trim(), MAX_FALA);
}

function cortarFinal(texto) {
  const cps = Array.from(texto);
  if (cps.length <= LIMITE_FINAL) return texto;
  return `${cps.slice(0, CABECA_FINAL).join('')}${MIOLO}${cps.slice(-CAUDA_FINAL).join('')}`;
}

function detalhes(final) {
  return `<details><summary>Mensagem completa</summary><p>${paraRich(mdParaHtml(cortarFinal(final)))}</p></details>`;
}

function visivel(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .length;
}

// Classico: `fixo` + a mensagem completa em texto puro escapado dentro de <blockquote expandable>, cortada (cabeca 1/3
// + "(...)" + cauda 2/3) pra o total caber nos 4096 visiveis.
function comFinal(fixo, final) {
  if (!final) return fixo;
  const plano = mdParaTexto(final);
  const sobra = LIMITE_CLASSICO - visivel(fixo) - 2; // 2 = "\n\n" antes do blockquote
  let corpo = plano;
  if (plano.length > sobra) {
    const resto = sobra - MIOLO.length;
    if (resto < 60) return fixo; // sem espaco que valha: o chamado vai sem a mensagem completa
    const cabeca = Math.floor(resto / 3);
    corpo = `${cabecaU16(plano, cabeca)}${MIOLO}${caudaU16(plano, resto - cabeca)}`;
  }
  return corpo ? `${fixo}\n\n<blockquote expandable>${esc(corpo)}</blockquote>` : fixo;
}

// T5a, resposta completa (ele pediu detalhe): a mensagem inteira aberta, sem a linha de citacao do dono (como no
// WhatsApp). Rich = o mesmo corte do <details>; classico = texto puro escapado, com o mesmo corte do comFinal.
// T17b: exportado (a resposta em voz nao fala a linha de citacao do dono). `final` tem de ser string. A4b: a linha de
// qualquer nome (o RE_CITACAO_DO_DONO do formato.mjs).
export function semLinhaDoDono(final) {
  return final.replace(/\r\n?/g, '\n').split('\n').filter((l) => !RE_CITACAO_DO_DONO.test(l)).join('\n').replace(/^\n+|\n+$/g, '');
}
// T10c: `linha` = a frase em italico embaixo do titulo (a situacao da aba) | ''.
function completa(T, final, linha = '') {
  const corpo = semLinhaDoDono(final);
  const plano = mdParaTexto(corpo);
  const fixo = `<b>${T}</b>${linha ? `\n<i>${linha}</i>` : ''}`;
  const sobra = LIMITE_CLASSICO - visivel(fixo) - 2;
  const resto = sobra - MIOLO.length;
  const cabeca = Math.floor(resto / 3);
  const texto = plano.length > sobra ? `${cabecaU16(plano, cabeca)}${MIOLO}${caudaU16(plano, resto - cabeca)}` : plano;
  const sob = linha ? `<p><i>${linha}</i></p>` : '';
  return { html: `<h2>${T}</h2>${sob}<p>${paraRich(mdParaHtml(cortarFinal(corpo)))}</p>`, classico: `${fixo}\n\n${esc(texto)}` };
}

// T7c1 (F4): os botoes das opcoes (a recomendada em success) e, na ultima linha, "Mais informações" quando `comInformacoes`
// (ha texto pra abrir e o chamado ainda nao esta aberto). Sem botao nenhum = null.
function botoesDe(opcoes, chamadoId, comInformacoes) {
  const linhas = opcoes.map((o, indice) => [
    { texto: rotuloBotao(o.letra, o.texto), dados: dadosBotao({ chamadoId, acao: 'opcao', indice }), estilo: o.recomendado ? 'success' : undefined },
  ]);
  if (comInformacoes === true) linhas.push([{ texto: 'Mais informações', dados: dadosBotao({ chamadoId, acao: 'informacoes' }) }]);
  return linhas.length ? linhas : null;
}

const ESTADOS = new Set(['aviso', 'resposta', 'enviando', 'entregue', 'contexto', 'problema', 'encerrado', 'movido']);

/**
 * Chamado de 1 aba -> {html (rich), classico (sendMessage parse_mode HTML), botoes (linhas pro telegram.mjs) | null}.
 * Estados: aviso, resposta, enviando, entregue, contexto, problema, encerrado, movido. Botoes so em aviso/resposta
 * (chamadoId obrigatorio quando ha botao: dadosBotao lanca TypeError sem ele). Estado desconhecido = TypeError.
 * T7c1 (PLANO-T7.md, F3/F4): aviso/resposta = so as 2 linhas da F4g (partesCurtas), sem a mensagem completa, + os botoes
 * das opcoes e "Mais informações"; `completo: true` no aviso ou na resposta (ele tocou em Mais informações ou pediu
 * detalhe) = a mensagem inteira aberta e so os botoes das opcoes. O encerrado guarda a mensagem recolhida (historico).
 */
export function montarChamado({ estado, titulo, icone, hora, horaEntrega, final, fala, audio, frase, motivo, chamadoId, completo } = {}) {
  if (!ESTADOS.has(estado)) throw new TypeError(`montarChamado: estado desconhecido: ${String(estado).slice(0, 40)}`);
  const T = esc(tituloDe(titulo, icone));
  const H = esc(fmtHora(hora));
  const txtFinal = typeof final === 'string' && final.trim() ? final : '';

  if (estado === 'movido') {
    return { html: `<p><b>${T}</b>: chamado movido pra baixo.</p>`, classico: `<b>${T}</b>: chamado movido pra baixo.`, botoes: null };
  }

  const linhaFala = () => `${audio === true ? 'Você disse (áudio)' : 'Você respondeu'} às ${H}: «${esc(falaCurta(fala))}»`;

  if (estado === 'enviando' || estado === 'entregue') {
    const fim = estado === 'enviando' ? 'Passando pra aba.' : `Entregue na aba às ${esc(fmtHora(horaEntrega))}. Aguardando a resposta.`;
    return {
      html: `<h2>${T}</h2><p>${linhaFala()}</p><p><i>${fim}</i></p>`,
      classico: `<b>${T}</b>\n${linhaFala()}\n<i>${fim}</i>`,
      botoes: null,
    };
  }

  if (estado === 'contexto') {
    const linha = `Você pediu mais contexto às ${H}.`;
    return {
      html: `<h2>${T}</h2><p>${linha}</p><p><i>Passando pra aba.</i></p>`,
      classico: `<b>${T}</b>\n${linha}\n<i>Passando pra aba.</i>`,
      botoes: null,
    };
  }

  if (estado === 'problema') {
    const temFala = fala != null && String(fala).trim() !== '';
    const f = esc(cortarCp(String(frase ?? '').replace(/\r\n?/g, '\n').trim(), MAX_FRASE));
    return {
      html: `<h2>${T}</h2>${temFala ? `<p>${linhaFala()}</p>` : ''}${f ? `<p>${paraRich(f)}</p>` : ''}`,
      classico: `<b>${T}</b>${temFala ? `\n${linhaFala()}` : ''}${f ? `\n${f}` : ''}`,
      botoes: null,
    };
  }

  if (estado === 'encerrado') {
    const linha = `Encerrada às ${H}: ${motivo === 'whatsapp' ? 'você respondeu pelo WhatsApp.' : 'a aba seguiu no PC.'}`;
    return {
      html: `<h2>${T}</h2><p><i>${linha}</i></p>${txtFinal ? detalhes(txtFinal) : ''}`,
      classico: comFinal(`<b>${T}</b>\n<i>${linha}</i>`, txtFinal),
      botoes: null,
    };
  }

  // aviso | resposta (T10c: o corpo e o mesmo da situacao da aba, no corpoAviso)
  return corpoAviso({ T, txtFinal, chamadoId, completo, vazio: estado === 'aviso' ? 'Parou esperando você.' : 'Respondeu sem texto.' });
}

// O corpo do aviso e da resposta. Os botoes saem das opcoes do lerFinal; as 2 linhas, da regra da F4g (a mesma do
// WhatsApp). T7c1: "Mais informações" so com texto pra abrir (o aberto tira a linha de citacao do dono) e fora do aberto.
// T10c: dividido com a situacao da aba (montarSituacao): `linha` = a frase em italico embaixo do titulo | '';
// `comBotoes` false = sem botao nenhum (as opcoes ficam no texto). `vazio` = a frase sem fato nem pergunta.
// T16: `comOpcoes` false = sem os botoes das opcoes (ficam no texto); o "Mais informações" segue a regra de sempre.
function corpoAviso({ T, txtFinal, chamadoId, completo, vazio, linha = '', comBotoes = true, comOpcoes = true }) {
  const opcoesBotao = comBotoes && comOpcoes ? lerFinal(txtFinal).opcoes : [];
  const temTexto = semLinhaDoDono(txtFinal).trim() !== '';
  if (completo === true && temTexto) {
    return { ...completa(T, txtFinal, linha), botoes: comBotoes ? botoesDe(opcoesBotao, chamadoId, false) : null };
  }
  const botoes = comBotoes ? botoesDe(opcoesBotao, chamadoId, temTexto) : null;
  const { fato, pergunta, temBloco } = partesCurtas(txtFinal);
  const rich = [`<h2>${T}</h2>`];
  const classico = [`<b>${T}</b>`];
  if (linha) {
    rich.push(`<p><i>${linha}</i></p>`);
    classico.push(`<i>${linha}</i>`);
  }
  if (fato) {
    rich.push(`<p>${paraRich(mdParaHtml(fato))}</p>`);
    classico.push(mdParaHtml(fato));
  }
  if (pergunta) {
    // o negrito em texto puro (<b> do Telegram nao pode conter <code>/<pre>); as opcoes so em texto quando nao viraram botao
    const forte = `<b>${esc(cortarCp(semMarkdown(pergunta.forte), MAX_PERGUNTA))}</b>`;
    const resto = pergunta.resto ? ` ${mdParaHtml(pergunta.resto)}` : '';
    const opcoes = pergunta.opcoes && opcoesBotao.length === 0 ? mdParaHtml(pergunta.opcoes) : '';
    if (fato) classico.push('');
    rich.push(`<p>${forte}${paraRich(resto)}${opcoes ? `<br>${paraRich(opcoes)}` : ''}</p>`);
    classico.push(`${forte}${resto}`);
    if (opcoes) classico.push(opcoes);
  }
  if (!fato && !pergunta) {
    const frase = temBloco ? 'Deixou um texto pra copiar.' : vazio;
    rich.push(`<p>${frase}</p>`);
    classico.push(frase);
  }
  return { html: rich.join(''), classico: classico.join('\n'), botoes };
}

// ---------- mensagem do sistema ----------

// O titulo da mensagem viva do sistema (pedido do dono pelo Telegram: «Quero o cabeçalho da mensagem do controle
// de sessões venha com outra formatação: ⚠️ Controle de Sessões»; antes "ℹ️ Controle de sessões"; o ícone virou 🎛️ em 16/10). So ela: o chamado
// das abas segue com o ICONE, e o cabecalho das frases no WhatsApp (porteiro.mjs, CABECALHO) fica como estava.
export const ICONE_SISTEMA = ICONE_CONTROLE; // a voz do controle e 🎛️ (era ⚠️ na T22)
export const TITULO_SISTEMA = 'Controle de Sessões';

/**
 * Mensagem viva "Controle de Sessões" com SO a ultima linha [{hora, texto}] -> {html, classico}, ate MAX_ULTIMA_SISTEMA
 * cp. T15 (pedido do dono, o "Voltei": "deveria só falar que foi desligado e pronto"): as linhas de antes ficam
 * guardadas (MAX_LINHAS do canal) mas nao aparecem; antes saiam as 3 ultimas e o "Modo rua desligado." vinha embaixo de
 * 2 "O pedido de OK se responde..." velhos.
 */
export function montarSistema(linhas) {
  const ult = (Array.isArray(linhas) ? linhas : []).slice(-1).map((l) => ({
    hora: esc(fmtHora(l?.hora)),
    texto: esc(cortarCp(String(l?.texto ?? '').replace(/\r\n?/g, '\n'), MAX_ULTIMA_SISTEMA)),
  }));
  const corpo = ult.map((l) => `${l.hora} ${l.texto.replace(/\n/g, '<br>')}`).join('<br>');
  return {
    html: `<h3>${ICONE_SISTEMA} ${TITULO_SISTEMA}</h3>${ult.length ? `<p>${corpo}</p>` : ''}`,
    classico: `<b>${ICONE_SISTEMA} ${TITULO_SISTEMA}</b>${ult.map((l) => `\n${l.hora} ${l.texto}`).join('')}`,
  };
}

// ---------- painel (T9) ----------

const MAX_PARADAS = 150; // T14: paradas mostradas no rich (o resto vira "(e mais N)"); era o MAX_LISTA da T11
const MAX_TEXTO_PAINEL = 1000;
const MAX_FECHADAS = 150; // T14b: abas mostradas no grupo Fechadas no rich (o resto vira "(e mais N)")
const MARCA_FECHADA = ' (fechada)'; // T14: depois do nome da aba fechada (no Esperando e nas Paradas)
const SEM_GRUPO = 'Sem grupo'; // T11b/T14b: o grupo das Fechadas fora dos grupos do VS Code
const LISTA_ERRO = 'Não consegui ler a lista do VS Code agora.'; // T11

const listaDe = (v) => (Array.isArray(v) ? v : []);
const ehItem = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const nomeAba = (t) => esc(cortarCp(String(t ?? '').replace(/\s+/g, ' ').trim(), MAX_TITULO, '…') || 'sem nome');
// T10: o @ do bot (username do Telegram: 5 a 32 de letra, numero ou _) e o id da aba no link (o start do Telegram leva ate
// 64: "a_" + ate 62 de letra, numero ou -). Fora disso = sem link. Os dois entram no href so assim (nada a escapar).
const RE_BOT = /^[A-Za-z0-9_]{5,32}$/;
const RE_SID_LINK = /^[A-Za-z0-9-]{1,62}$/;
const comLink = (bot, sid, nome) => (bot && typeof sid === 'string' && RE_SID_LINK.test(sid)
  ? `<a href="https://t.me/${bot}?start=a_${sid}">${nome}</a>`
  : nome);
const marcaDe = (x) => (x.fechada === true ? MARCA_FECHADA : ''); // T14
// Trabalhando e paradas: texto (o titulo, sem link) ou {titulo, sid} (T10: com link; T14: fechada === true = a marca)
// -> [{nome, marca}]; sem titulo de texto nao vazio sai.
const titulosDe = (v, bot) => listaDe(v).flatMap((x) => {
  if (typeof x === 'string') return x.trim() ? [{ nome: nomeAba(x), marca: '' }] : [];
  if (ehItem(x) && typeof x.titulo === 'string' && x.titulo.trim()) return [{ nome: comLink(bot, x.sid, nomeAba(x.titulo)), marca: marcaDe(x) }];
  return [];
});

/**
 * T9 (PLANO-TELEGRAM.md, contrato 3): o painel unico das abas (status + pendencias) -> {html, classico}.
 * d = {hora: ISO, modoRua, abertas, esperando: [{titulo, hora, texto}], trabalhando: [titulo], paradas: [titulo]}, ja na
 * ordem de mostrar. Hora de item de outro dia (que o do painel) sai com a data ("04/10 19:41"). Grupo vazio nao aparece;
 * nada esperando = a frase. Classico: <blockquote expandable> no lugar do <details>, ate 4096 visiveis. Entrada torta
 * nao lanca.
 * T10 (PLANO-TELEGRAM.md, contrato 1): d.bot = o @ do bot (sem o @); com ele, o nome de cada aba (esperando com `sid`;
 * trabalhando e paradas como {titulo, sid}) vira link https://t.me/<bot>?start=a_<sid>.
 * T10b (pedido do dono: "tem que ter acordeon pra todas [...] com bolinha, tudo igualzinho"): os grupos sao acordeao
 * com bolinha no titulo (esperando ja aberto: <details open>), 1 aba por paragrafo com o nome em negrito. Classico: cada
 * grupo num <blockquote> (esperando aberto, os outros expandable).
 * T11: d.listaErro === true = a linha LISTA_ERRO no fim.
 * T14 (pedido do dono, "A) Sim, as 4 mudanças"): o grupo "Fechadas" saiu (os campos fechadas e fechadasLista e os
 * nomes de grupo do VS Code da T11/T11b nao aparecem mais). Item com fechada === true (no esperando e nas paradas) leva
 * a marca MARCA_FECHADA depois do nome (antes da hora). Rich: ate MAX_PARADAS paradas com "(e mais N)". Classico: sai
 * primeiro o fim das paradas, depois o fim das esperando, com "(e mais N)".
 * T14b (pedido do dono: "antes eu conseguia ver todas as fechadas" / "eu preciso conseguir ver as
 * mensagens que eu fechei"): o grupo "⚪ Fechadas (N)" volta, recolhido, depois das Paradas. d.fechadas = [{titulo, sid,
 * grupo}] ja na ordem (grupo do VS Code; null = SEM_GRUPO); item sem titulo de texto sai. Como na T11b: no rich o nome
 * do grupo em <h4> negrito a cada troca e 1 aba por paragrafo com o link, ate MAX_FECHADAS com "(e mais N)"; no
 * classico linha em branco antes do grupo (menos o 1o) e o nome em negrito sublinhado. Sem marca MARCA_FECHADA. O
 * classico corta primeiro as fechadas, depois as paradas, depois as esperando.
 * T24 (pedido do dono pelo Telegram: «transforma os que eu não quiser mais mexer agora em aguardando»):
 * d.aguardando = [{titulo, hora, texto, sid, fechada?, em}] no formato do esperando (o `em` e da situacao, nao entra
 * aqui) = o grupo "🔵 Aguardando (N)" logo depois do Esperando (ou da frase do nada esperando), recolhido (<details> sem
 * open; no classico <blockquote expandable>), com as linhas do Esperando, sem teto no rich; N = 0 = sem o grupo. O
 * classico corta as fechadas, as paradas, o aguardando (do fim, com "(e mais N)") e por ultimo as esperando.
 */
export function montarPainel(d) {
  const p = ehItem(d) ? d : {};
  const bot = typeof p.bot === 'string' && RE_BOT.test(p.bot) ? p.bot : null;
  const diaPainel = diaBRT(p.hora);
  const quando = (h) => {
    const hora = horaBRT(h);
    if (hora === '??:??') return hora;
    const dia = diaBRT(h);
    return dia === diaPainel ? hora : `${dia} ${hora}`;
  };
  const abertas = Number.isSafeInteger(p.abertas) && p.abertas >= 0 ? p.abertas : 0;
  // o Esperando e o Aguardando (T24): a mesma linha (nome com link, marca, hora e a pergunta)
  const comPergunta = (v) => listaDe(v).filter(ehItem).map((x) => ({
    titulo: comLink(bot, x.sid, nomeAba(x.titulo)),
    marca: marcaDe(x),
    hora: esc(quando(x.hora)),
    texto: esc(cortarCp(String(x.texto ?? '').replace(/\s+/g, ' ').trim(), MAX_TEXTO_PAINEL)),
  }));
  const esperando = comPergunta(p.esperando);
  const aguardando = comPergunta(p.aguardando);
  const trabalhando = titulosDe(p.trabalhando, bot);
  const paradas = titulosDe(p.paradas, bot);
  // T14b: as fechadas {nome (com link), grupo (escapado; fora do formato = SEM_GRUPO)}
  const fechadas = listaDe(p.fechadas).filter((x) => ehItem(x) && typeof x.titulo === 'string' && x.titulo.trim()).map((x) => {
    const g = typeof x.grupo === 'string' ? x.grupo.replace(/\s+/g, ' ').trim() : '';
    return { nome: comLink(bot, x.sid, nomeAba(x.titulo)), grupo: g ? esc(cortarCp(g, MAX_TITULO, '…')) : SEM_GRUPO };
  });
  const listaErro = p.listaErro === true;
  const linhaRua = `Modo rua: ${p.modoRua === true ? 'ligado' : 'desligado'} · atualizado às ${esc(horaBRT(p.hora))}`;
  const nada = 'Nada esperando resposta sua.';
  const tEsp = `🔴 Esperando você (${esperando.length})`;
  const tAg = `🔵 Aguardando (${aguardando.length})`; // T24: azul (as outras 4 cores ja sao de outro grupo)
  const tTrab = `🟡 Trabalhando (${trabalhando.length})`;
  const tPar = `🟢 Paradas (${paradas.length})`;
  const tFech = `⚪ Fechadas (${fechadas.length})`;
  const mais = (n) => `(e mais ${n})`;
  // T14b: as k primeiras fechadas, com o nome do grupo a cada troca -> [{grupo: true, texto} | {texto}]
  const linhasFechadas = (k) => {
    const out = [];
    let atual = null;
    for (const x of fechadas.slice(0, k)) {
      if (x.grupo !== atual) {
        out.push({ grupo: true, texto: x.grupo });
        atual = x.grupo;
      }
      out.push({ texto: x.nome });
    }
    return out;
  };

  // rich: os grupos em acordeao (T10b), 1 aba por paragrafo
  const verPar = Math.min(paradas.length, MAX_PARADAS);
  const verFech = Math.min(fechadas.length, MAX_FECHADAS);
  const bloco = (x) => `<p><b>${x.titulo}</b>${x.marca} · ${x.hora}<br>${x.texto}</p>`;
  const soNome = (n) => `<p><b>${n.nome}</b>${n.marca}</p>`;
  const rich = [`<h3>Abas abertas: ${abertas}</h3>`, `<p>${linhaRua}</p>`];
  if (esperando.length) rich.push(`<details open><summary>${tEsp}</summary>${esperando.map(bloco).join('')}</details>`);
  else rich.push(`<p>${nada}</p>`);
  if (aguardando.length) rich.push(`<details><summary>${tAg}</summary>${aguardando.map(bloco).join('')}</details>`); // T24: recolhido
  if (trabalhando.length) rich.push(`<details><summary>${tTrab}</summary>${trabalhando.map(soNome).join('')}</details>`);
  if (paradas.length) {
    const resto = paradas.length > verPar ? `<p>${mais(paradas.length - verPar)}</p>` : '';
    rich.push(`<details><summary>${tPar}</summary>${paradas.slice(0, verPar).map(soNome).join('')}${resto}</details>`);
  }
  if (fechadas.length) {
    const linhas = linhasFechadas(verFech).map((l) => (l.grupo ? `<h4><b>${l.texto}</b></h4>` : `<p><b>${l.texto}</b></p>`)).join('');
    const resto = fechadas.length > verFech ? `<p>${mais(fechadas.length - verFech)}</p>` : '';
    rich.push(`<details><summary>${tFech}</summary>${linhas}${resto}</details>`);
  }
  if (listaErro) rich.push(`<p>${LISTA_ERRO}</p>`);

  // classico (kE esperando, kA aguardando, kP paradas e kF fechadas mostradas): cada grupo num <blockquote> (esperando
  // aberto)
  const item = (x) => `<b>${x.titulo}</b>${x.marca} · ${x.hora}\n${x.texto}`;
  const nomes = (v) => v.map((n) => `<b>${n.nome}</b>${n.marca}`);
  const classico = (kE, kA, kP, kF) => {
    const partes = [];
    if (esperando.length) {
      const fim = kE < esperando.length ? [mais(esperando.length - kE)] : [];
      partes.push(`<blockquote><b>${tEsp}</b>\n${[...esperando.slice(0, kE).map(item), ...fim].join('\n\n')}</blockquote>`);
    } else partes.push(nada);
    if (aguardando.length) { // T24
      const fim = kA < aguardando.length ? [mais(aguardando.length - kA)] : [];
      partes.push(`<blockquote expandable><b>${tAg}</b>\n${[...aguardando.slice(0, kA).map(item), ...fim].join('\n\n')}</blockquote>`);
    }
    if (trabalhando.length) partes.push(`<blockquote expandable><b>${tTrab}</b>\n${nomes(trabalhando).join('\n')}</blockquote>`);
    if (paradas.length) {
      const fim = kP < paradas.length ? [mais(paradas.length - kP)] : [];
      partes.push(`<blockquote expandable><b>${tPar}</b>\n${[...nomes(paradas.slice(0, kP)), ...fim].join('\n')}</blockquote>`);
    }
    if (fechadas.length) {
      const fim = kF < fechadas.length ? [mais(fechadas.length - kF)] : [];
      const linhas = linhasFechadas(kF).map((l, i) => (l.grupo ? `${i ? '\n' : ''}<b><u>${l.texto}</u></b>` : `<b>${l.texto}</b>`));
      partes.push(`<blockquote expandable><b>${tFech}</b>\n${[...linhas, ...fim].join('\n')}</blockquote>`);
    }
    if (listaErro) partes.push(LISTA_ERRO);
    return `<b>Abas abertas: ${abertas}</b>\n${linhaRua}\n\n${partes.join('\n')}`;
  };
  let kE = esperando.length;
  let kA = aguardando.length;
  let kP = verPar;
  let kF = verFech;
  while (kF > 0 && visivel(classico(kE, kA, kP, kF)) > LIMITE_CLASSICO) kF -= 1;
  while (kP > 0 && visivel(classico(kE, kA, kP, kF)) > LIMITE_CLASSICO) kP -= 1;
  while (kA > 0 && visivel(classico(kE, kA, kP, kF)) > LIMITE_CLASSICO) kA -= 1; // T24: antes do Esperando
  while (kE > 0 && visivel(classico(kE, kA, kP, kF)) > LIMITE_CLASSICO) kE -= 1;
  return { html: rich.join(''), classico: classico(kE, kA, kP, kF) };
}

// ---------- situacao de uma aba (T10) ----------

const MAX_SITUACAO = 200;

/**
 * T10 (PLANO-TELEGRAM.md, contrato 2): a situacao de 1 aba (o toque no nome dela no painel) -> {html, classico}.
 * T10b (pedido do dono: "a mesma formatação que a gente tem quando o pedido chega por conta própria"): o formato do
 * aviso (montarChamado): titulo com o icone (h2), a situacao em italico embaixo (o porteiro manda a frase: "Esperando
 * você desde HH:MM." | "Trabalhando agora." | "Parada." | "Fechada."), e a ultima mensagem nas 2 linhas do aviso
 * (partesCurtas: fato; pergunta em negrito com o resto e as opcoes embaixo, em texto: sem botao). Sem final = "Ainda
 * sem mensagem dela.". Tudo escapado; entrada torta nao lanca; o classico cabe nos 4096 visiveis (as partes ja vem
 * curtas do partesCurtas).
 * T10c (pedido do dono: "Sim, igual ao aviso"): {chamadoId, completo} = os botoes do aviso (corpoAviso, a mesma regra
 * do montarChamado: 1 por opcao, a recomendada em verde, e "Mais informações" com texto; as opcoes que viram botao saem
 * do texto) e o aberto (completo: a mensagem inteira, so os botoes das opcoes). chamadoId fora do formato = sem botao
 * (as opcoes em texto). Devolve {html, classico, botoes | null}.
 * T14 (pedido do dono): com id, a ultima linha e o botao "Concluir" (z:<id>; tira a aba do painel), tambem na
 * aberta e sem mensagem nenhuma.
 * T14b (pedido do dono: "ele aparece mesmo quando tem mensagem pra enviar"): o Concluir so com p.concluir ===
 * true (o porteiro so pede na aba que esta nas Paradas).
 * T14c (pedido do dono: "nao faz muito sentido o botao concluir"): o Concluir saiu; so os botoes do aviso.
 * T16 (pedido do dono: "quando eu clico numa aba que está trabalhando [...] ele puxa a última decisão"):
 * `trabalhando: true` (so true) = a vez nao acabou: sem os botoes das opcoes (ficam em texto), o "Mais informações" com
 * texto, e sem texto "Ainda sem mensagem neste trabalho.".
 */
export function montarSituacao(d) {
  const p = ehItem(d) ? d : {};
  const T = esc(tituloDe(p.titulo));
  const sit = esc(cortarCp(typeof p.situacao === 'string' ? p.situacao.replace(/\s+/g, ' ').trim() : '', MAX_SITUACAO));
  const final = typeof p.final === 'string' && p.final.trim() ? p.final : '';
  const comBotoes = typeof p.chamadoId === 'string' && RE_ID.test(p.chamadoId);
  const trabalhando = p.trabalhando === true;
  const r = corpoAviso({
    T,
    txtFinal: final,
    chamadoId: p.chamadoId,
    completo: p.completo === true,
    vazio: final ? 'Respondeu sem texto.' : trabalhando ? 'Ainda sem mensagem neste trabalho.' : 'Ainda sem mensagem dela.',
    linha: sit,
    comBotoes,
    comOpcoes: !trabalhando,
  });
  return r;
}

// ---------- botoes ----------

/** callback_data do botao: `o:<ID>:<n>` (opcao, n 0-9) | `i:<ID>` (Mais informações).
 *  Entrada invalida (inclusive a acao 'contexto', que saiu na T7c1, e a 'concluir' (`z:<ID>`), que saiu na T14c) = TypeError. */
export function dadosBotao({ chamadoId, acao, indice } = {}) {
  if (typeof chamadoId !== 'string' || !RE_ID.test(chamadoId)) throw new TypeError('dadosBotao: chamadoId invalido');
  if (acao === 'informacoes') return `i:${chamadoId}`;
  if (acao === 'opcao') {
    if (!Number.isInteger(indice) || indice < 0 || indice > 9) throw new TypeError('dadosBotao: indice invalido');
    return `o:${chamadoId}:${indice}`;
  }
  throw new TypeError('dadosBotao: acao invalida');
}

/** Leitura estrita do callback_data: {acao: 'opcao', chamadoId, indice} | {acao: 'informacoes', chamadoId} (de `i:<ID>`
 *  e do legado `c:<ID>`) | null (qualquer outra coisa; T14c: inclusive o `z:<ID>` do Concluir que saiu). */
export function lerDadosBotao(s) {
  if (typeof s !== 'string') return null;
  let m = RE_DADOS_OPCAO.exec(s);
  if (m) return { acao: 'opcao', chamadoId: m[1], indice: Number(m[2]) };
  m = RE_DADOS_INFORMACOES.exec(s);
  if (m) return { acao: 'informacoes', chamadoId: m[1] };
  return null;
}

/** Id novo de chamado: 8 letras do ALFABETO. `rand` = objeto com getRandomValues (padrao: crypto global do Node). */
export function novoIdChamado(rand = globalThis.crypto) {
  const bytes = new Uint8Array(8);
  rand.getRandomValues(bytes);
  let id = '';
  for (const b of bytes) id += ALFABETO[b % ALFABETO.length];
  return id;
}

/** Texto do botao: `${letra}) ${texto}` em 1 linha, ate 40 code points com "…" (o texto inteiro vai pra aba). */
export function rotuloBotao(letra, texto) {
  return cortarCp(`${letra}) ${String(texto ?? '')}`.replace(/\s+/g, ' ').trim(), MAX_ROTULO, '…');
}
