// sessoes-wpp — formato do chamado no Telegram (markdown da aba -> rich message em html e HTML classico do Telegram).
// Modulo PURO: sem I/O, sem rede, sem disco, sem process.env. Contrato: PLANO-TELEGRAM.md ("Desenho aprovado" itens
// 2-5, "Contratos" T1 e "Textos"). Quem envia e o porteiro (telegram.mjs); aqui so se monta o texto.
//
// Origem de esc, ABRE_CERCA, FECHA_CERCA, separarBlocos, mdParaHtml (la: mdToHtml) e mdParaTexto (la: mdToPlain):
// copia do tgfmt.mjs do repositório telegram-multi-session (commit dbff026).
// Copiado, nao importado: aquele repositorio vai pra org dos alunos pelo publicador.
import { horaBRT, diaBRT, ICONE, ICONE_CONTROLE, partesCurtas, RE_CITACAO_DO_DONO } from './formato.mjs';
import { normalizar } from './roteamento.mjs'; // T29d: a busca no painel (sem maiuscula, sem acento)
import { nomeDoGrupo } from './lista-vscode.mjs'; // T38: a busca no espelho compara o nome do grupo sem o icone

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
// T29c: `m:<ID>` = Menos informações (o aberto sem botao de resposta volta pro compacto)
const RE_DADOS_MENOS = /^m:([ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8})$/;

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
// T26a: `reserva` = os visiveis que vem DEPOIS deste classico (o bloco do OK + a quebra dupla); o corte desconta. Sem
// reserva (0), o de sempre, byte a byte.
function completa(T, final, linha = '', reserva = 0) {
  const corpo = semLinhaDoDono(final);
  const plano = mdParaTexto(corpo);
  const fixo = `<b>${T}</b>${linha ? `\n<i>${linha}</i>` : ''}`;
  const sobra = LIMITE_CLASSICO - visivel(fixo) - 2 - reserva;
  const resto = Math.max(0, sobra - MIOLO.length);
  const cabeca = Math.floor(resto / 3);
  const texto = plano.length > sobra ? `${cabecaU16(plano, cabeca)}${MIOLO}${caudaU16(plano, resto - cabeca)}` : plano;
  const sob = linha ? `<p><i>${linha}</i></p>` : '';
  return { html: `<h2>${T}</h2>${sob}<p>${paraRich(mdParaHtml(cortarFinal(corpo)))}</p>`, classico: `${fixo}\n\n${esc(texto)}` };
}

// T7c1 (F4): os botoes das opcoes (a recomendada em success) e, na ultima linha, "Mais informações" quando `comInformacoes`
// (ha texto pra abrir e o chamado ainda nao esta aberto). T29c: "Menos informações" na ultima linha quando `comMenos` (o
// aberto sem botao de resposta). Sem botao nenhum = null.
function botoesDe(opcoes, chamadoId, comInformacoes, comMenos = false) {
  const linhas = opcoes.map((o, indice) => [
    { texto: rotuloBotao(o.letra, o.texto), dados: dadosBotao({ chamadoId, acao: 'opcao', indice }), estilo: o.recomendado ? 'success' : undefined },
  ]);
  if (comInformacoes === true) linhas.push([{ texto: 'Mais informações', dados: dadosBotao({ chamadoId, acao: 'informacoes' }) }]);
  if (comMenos === true) linhas.push([{ texto: 'Menos informações', dados: dadosBotao({ chamadoId, acao: 'menos' }) }]); // T29c
  return linhas.length ? linhas : null;
}

// A linha do encerrado (`H` = a hora ja escapada). T28: tambem no encerrado com o bloco do OK vencido (montarChamadoComOk)
const linhaEncerrado = (H, motivo) => `Encerrada às ${H}: ${motivo === 'whatsapp' ? 'você respondeu pelo WhatsApp.' : 'a aba seguiu no PC.'}`;

// T26a: 'ok' = so o cabecalho (a mensagem da aba que vai levar o OK dentro, sem parte da aba viva)
const ESTADOS = new Set(['aviso', 'resposta', 'enviando', 'entregue', 'contexto', 'problema', 'encerrado', 'movido', 'ok']);

/**
 * Chamado de 1 aba -> {html (rich), classico (sendMessage parse_mode HTML), botoes (linhas pro telegram.mjs) | null}.
 * Estados: aviso, resposta, enviando, entregue, contexto, problema, encerrado, movido, ok (T26a: so o cabecalho, html
 * `<h2>T</h2>`, classico `<b>T</b>`, sem botao; o OK em si vem do montarChamadoComOk). Botoes so em aviso/resposta
 * (chamadoId obrigatorio quando ha botao: dadosBotao lanca TypeError sem ele). Estado desconhecido = TypeError.
 * T7c1 (PLANO-T7.md, F3/F4): aviso/resposta = so as 2 linhas da F4g (partesCurtas), sem a mensagem completa, + os botoes
 * das opcoes e "Mais informações"; `completo: true` no aviso ou na resposta (ele tocou em Mais informações ou pediu
 * detalhe) = a mensagem inteira aberta e so os botoes das opcoes. O encerrado guarda a mensagem recolhida (historico).
 * T29c (PLANO-TELEGRAM.md, "T29c"): o aberto sem opcao (nenhum botao de resposta) = so o "Menos informações" (`m:<ID>`).
 */
export function montarChamado({ estado, titulo, icone, hora, horaEntrega, final, fala, audio, frase, motivo, chamadoId, completo } = {}) {
  if (!ESTADOS.has(estado)) throw new TypeError(`montarChamado: estado desconhecido: ${String(estado).slice(0, 40)}`);
  const T = esc(tituloDe(titulo, icone));
  const H = esc(fmtHora(hora));
  const txtFinal = typeof final === 'string' && final.trim() ? final : '';

  if (estado === 'movido') {
    return { html: `<p><b>${T}</b>: chamado movido pra baixo.</p>`, classico: `<b>${T}</b>: chamado movido pra baixo.`, botoes: null };
  }

  if (estado === 'ok') return { html: `<h2>${T}</h2>`, classico: `<b>${T}</b>`, botoes: null };

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
    const linha = linhaEncerrado(H, motivo);
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
// T26a: `reserva` = os visiveis do que vem depois (o bloco do OK + 2), descontados no corte do aberto (completa).
// T29c: o aberto sem botao de opcao na tela ganha o "Menos informações"; `comBotoes` false (o OK dentro da mensagem, no
// montarChamadoComOk) = nenhum botao, entao o OK fica de fora.
function corpoAviso({ T, txtFinal, chamadoId, completo, vazio, linha = '', comBotoes = true, comOpcoes = true, reserva = 0 }) {
  const opcoesBotao = comBotoes && comOpcoes ? lerFinal(txtFinal).opcoes : [];
  const temTexto = semLinhaDoDono(txtFinal).trim() !== '';
  if (completo === true && temTexto) {
    return { ...completa(T, txtFinal, linha, reserva), botoes: comBotoes ? botoesDe(opcoesBotao, chamadoId, false, opcoesBotao.length === 0) : null };
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

// ---------- o chamado com o OK dentro (T26a) ----------

/**
 * T26a (PLANO-TELEGRAM.md, "T26a"; pedido do dono 18/10: "o ok fica lá dentro. E não mensagem separada"): a mensagem
 * da aba com o pedido de OK no fim -> {classico, botoes | null}. Sem html: sai sempre no classico.
 * `versao` = o que o montarChamado recebe; `ok` = {bloco: {compacto: {texto, botoes}, completo: {texto, botoes}},
 * completo, toque, fechado} (os blocos do montarBlocoOk do lib/ok-tg.mjs, montados do arquivo do pedido).
 * - parte da aba: aviso ou resposta = o corpo do aviso SEM botao (as opcoes em texto), aberto quando `versao.completo` ou
 *   `ok.completo`; qualquer outro estado = so o cabecalho `<b>T</b>`;
 * - classico = `<parte>\n\n<bloco escapado>`; o bloco = `ok.fechado` (string) quando fechado; senao o completo
 *   (`ok.completo`) ou o compacto;
 * - botoes = nenhum com `fechado` ou `toque`; senao os do bloco;
 * - o total visivel cabe nos 4096: o corte e so na parte da aba (o aberto desconta o bloco; o curto que nao couber vira
 *   so o cabecalho), nunca no bloco (o conferirToque confere o fim do texto). Um bloco maior que o limite sozinho sai
 *   assim mesmo (o pedir limita a acao a 1500).
 * Sem o bloco que vai aparecer (nem fechado) = TypeError.
 * T28 (PLANO-TELEGRAM.md, "T28"; troca do dono 18/10 15:49: «Deixa sem os X vermelhos, só em negrito»): no fechado,
 * `ok.forte` (texto) = a linha do fecho que fecha o `fechado` sai em `<b>` (o negrito vem deste campo, nunca de HTML do
 * texto do pedido, que segue escapado; forte que nao fecha o texto = ignorado); `ok.depois` (texto) = a 2a linha embaixo
 * do fecho; `ok.botoesFechado` (linhas) = os botoes do fechado ("🔄 Tentar novamente"). O encerrado com o bloco mostra a
 * linha dele (em italico, embaixo do cabecalho).
 */
export function montarChamadoComOk(versao, ok) {
  if (!ok || typeof ok !== 'object') throw new TypeError('montarChamadoComOk: ok invalido');
  const completo = ok.completo === true;
  const fechado = typeof ok.fechado === 'string';
  let texto;
  let botoes = null;
  let fim;
  if (fechado) {
    texto = ok.fechado;
    const forte = typeof ok.forte === 'string' && ok.forte !== '' && texto.endsWith(ok.forte) ? ok.forte : null;
    fim = forte ? `${esc(texto.slice(0, texto.length - forte.length))}<b>${esc(forte)}</b>` : esc(texto);
    if (typeof ok.depois === 'string' && ok.depois !== '') fim += `\n${esc(ok.depois)}`;
    if (Array.isArray(ok.botoesFechado) && ok.botoesFechado.length) botoes = ok.botoesFechado;
  } else {
    const b = ok.bloco && typeof ok.bloco === 'object' ? ok.bloco[completo ? 'completo' : 'compacto'] : null;
    if (!b || typeof b !== 'object' || typeof b.texto !== 'string') throw new TypeError('montarChamadoComOk: bloco invalido');
    texto = b.texto;
    fim = esc(texto);
    if (!ok.toque && Array.isArray(b.botoes) && b.botoes.length) botoes = b.botoes;
  }
  const v = versao && typeof versao === 'object' ? versao : {};
  const T = esc(tituloDe(v.titulo, v.icone));
  const cabeca = v.estado === 'encerrado' ? `<b>${T}</b>\n<i>${linhaEncerrado(esc(fmtHora(v.hora)), v.motivo)}</i>` : `<b>${T}</b>`;
  const reserva = visivel(fim) + 2; // 2 = "\n\n" antes do bloco
  let parte = cabeca;
  if (v.estado === 'aviso' || v.estado === 'resposta') {
    const txtFinal = typeof v.final === 'string' && v.final.trim() ? v.final : '';
    parte = corpoAviso({
      T,
      txtFinal,
      completo: v.completo === true || completo,
      vazio: v.estado === 'aviso' ? 'Parou esperando você.' : 'Respondeu sem texto.',
      comBotoes: false,
      reserva,
    }).classico;
    if (visivel(parte) + reserva > LIMITE_CLASSICO) parte = cabeca;
  }
  return { classico: `${parte}\n\n${fim}`, botoes };
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

// ---------- ajustes (T39) ----------

// T39 (PLANO-TELEGRAM.md, "T39"; pedido do dono: «quando clico no modo tem que ter o botão de escolher»): o /rua, o
// /modo e o /voz do menu abrem a mensagem "Ajustes" com o estado e o botao de troca. Funcoes puras, nunca lancam.
export const TITULO_AJUSTES = 'Ajustes';

const QUAIS_AJUSTE = new Set(['rua', 'modo', 'voz']);

// d = {qual: 'rua'|'modo'|'voz', rua, voz, painel, mensagens} valido? (null, texto, lista e qual fora da lista = nao)
function ajusteValido(d) {
  return d !== null && typeof d === 'object' && !Array.isArray(d) && QUAIS_AJUSTE.has(d.qual);
}

function linhasAjustes(d) {
  if (!ajusteValido(d)) return [];
  if (d.qual === 'rua') return [d.rua === true ? 'Modo rua: ligado.' : 'Modo rua: desligado.'];
  if (d.qual === 'voz') return [d.voz === true ? 'Resposta por voz: ligada.' : 'Resposta por voz: desligada.'];
  return [
    d.painel === 'vscode' ? 'Painel: modo VS Code.' : 'Painel: modo padrão.',
    d.mensagens === 'manter' ? 'Mensagens: manter tudo.' : 'Mensagens: modo limpo.',
  ];
}

/** T39: a mensagem "Ajustes" -> {html, classico}: o titulo + 1 linha por estado (qual 'modo' = Painel e Mensagens).
 *  Entrada torta = so o titulo. */
export function montarAjustes(d) {
  const linhas = linhasAjustes(d);
  return {
    html: `<h3>${ICONE_SISTEMA} ${TITULO_AJUSTES}</h3>${linhas.map((l) => `<p>${esc(l)}</p>`).join('')}`,
    classico: `<b>${ICONE_SISTEMA} ${TITULO_AJUSTES}</b>${linhas.map((l) => `\n${esc(l)}`).join('')}`,
  };
}

/** T39: os botoes da mensagem "Ajustes" (formato do botoesPainel): o botao leva o estado ALVO (dadosAjuste), nunca
 *  "alternar". rua e voz = 1 linha com 1 botao; modo = 2 linhas (Painel, Mensagens). Entrada torta = null. */
export function botoesAjustes(d) {
  if (!ajusteValido(d)) return null;
  if (d.qual === 'rua') {
    return [[d.rua === true
      ? { texto: 'Desligar modo rua', dados: dadosAjuste({ alvo: 'rua', valor: false }) }
      : { texto: 'Ligar modo rua', dados: dadosAjuste({ alvo: 'rua', valor: true }) }]];
  }
  if (d.qual === 'voz') {
    return [[d.voz === true
      ? { texto: 'Desligar voz', dados: dadosAjuste({ alvo: 'voz', valor: false }) }
      : { texto: 'Ligar voz', dados: dadosAjuste({ alvo: 'voz', valor: true }) }]];
  }
  return [
    [d.painel === 'vscode'
      ? { texto: 'Painel: usar modo padrão', dados: dadosAjuste({ alvo: 'painel', valor: 'padrao' }) }
      : { texto: 'Painel: usar modo VS Code', dados: dadosAjuste({ alvo: 'painel', valor: 'vscode' }) }],
    [d.mensagens === 'manter'
      ? { texto: 'Mensagens: usar modo limpo', dados: dadosAjuste({ alvo: 'mensagens', valor: 'apagar' }) }
      : { texto: 'Mensagens: usar manter tudo', dados: dadosAjuste({ alvo: 'mensagens', valor: 'manter' }) }],
  ];
}

// ---------- painel (T9) ----------

const MAX_PARADAS = 150; // T14: paradas mostradas no rich (o resto vira "(e mais N)"); era o MAX_LISTA da T11
const MAX_TEXTO_PAINEL = 1000;
const MAX_FECHADAS = 150; // T14b: abas mostradas no grupo Fechadas no rich (o resto vira "(e mais N)")
const MARCA_FECHADA = ' (fechada)'; // T14: depois do nome da aba fechada (no Esperando e nas Paradas)
const SEM_GRUPO = 'Sem grupo'; // T11b/T14b: o grupo das Fechadas fora dos grupos do VS Code
const LISTA_ERRO = 'Não consegui ler a lista do VS Code agora.'; // T11

/**
 * T33 (PLANO-TELEGRAM.md, "T33", decisao 3): a linha do fim do painel com o foco ligado (d.foco = {grupo, fora}) -> o
 * texto escapado ("Só o grupo X do VS Code (N conversas fora do painel)."; fora 0 ou torto = sem os parenteses) | null
 * (sem foco ou grupo sem texto).
 * T35 ("T35", decisao 3): com `postas` (as que a central pos no painel fora do grupo) = "O grupo X do VS Code e mais N
 * que você pôs (...)."; sem o foco (grupo null) e com as tiradas pela central = "N conversas fora do painel.".
 */
export function linhaDoFoco(f) {
  if (!ehItem(f)) return null;
  const n = Number.isSafeInteger(f.fora) && f.fora > 0 ? f.fora : 0;
  const fora = `${n} ${n === 1 ? 'conversa' : 'conversas'} fora do painel`;
  if (f.grupo === null) return n ? `${fora}.` : null;
  if (typeof f.grupo !== 'string') return null;
  const g = f.grupo.replace(/\s+/g, ' ').trim();
  if (!g) return null;
  const nome = esc(cortarCp(g, MAX_TITULO, '…'));
  const p = Number.isSafeInteger(f.postas) && f.postas > 0 ? f.postas : 0;
  const base = p ? `O grupo ${nome} do VS Code e mais ${p} que você pôs` : `Só o grupo ${nome} do VS Code`;
  return n ? `${base} (${fora}).` : `${base}.`;
}

const listaDe = (v) => (Array.isArray(v) ? v : []);
const ehItem = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const nomeAba = (t) => esc(cortarCp(String(t ?? '').replace(/\s+/g, ' ').trim(), MAX_TITULO, '…') || 'sem nome');
// T10: o @ do bot (username do Telegram: 5 a 32 de letra, numero ou _) e o id da aba no link (o start do Telegram leva ate
// 64: "a_" + ate 62 de letra, numero ou -). Fora disso = sem link. Os dois entram no href so assim (nada a escapar).
const RE_BOT = /^[A-Za-z0-9_]{5,32}$/;
const RE_SID_LINK = /^[A-Za-z0-9-]{1,62}$/;
/** T10: o endereco que abre a aba pelo bot (https://t.me/<bot>?start=a_<sid>; o porteiro responde com a situacao e o
 *  A/B dela) | null (bot ou sid fora do formato). T37a: o botao "Abrir" do cartao de aba da rotina do dia
 *  (lib/rotina-tg.mjs) usa este mesmo endereco. */
export function linkDaAba(bot, sid) {
  return typeof bot === 'string' && RE_BOT.test(bot) && typeof sid === 'string' && RE_SID_LINK.test(sid)
    ? `https://t.me/${bot}?start=a_${sid}`
    : null;
}
const comLink = (bot, sid, nome) => {
  const url = linkDaAba(bot, sid);
  return url ? `<a href="${url}">${nome}</a>` : nome;
};
const marcaDe = (x) => (x.fechada === true ? MARCA_FECHADA : ''); // T14
// Trabalhando e paradas: texto (o titulo, sem link) ou {titulo, sid} (T10: com link; T14: fechada === true = a marca)
// -> [{nome, marca}]; sem titulo de texto nao vazio sai.
const titulosDe = (v, bot) => listaDe(v).flatMap((x) => {
  if (typeof x === 'string') return x.trim() ? [{ nome: nomeAba(x), marca: '' }] : [];
  if (ehItem(x) && typeof x.titulo === 'string' && x.titulo.trim()) return [{ nome: comLink(bot, x.sid, nomeAba(x.titulo)), marca: marcaDe(x) }];
  return [];
});

// ---------- T29d: a busca no painel (PLANO-TELEGRAM.md, "T29d") ----------

export const PERGUNTA_BUSCA = 'Qual palavra?'; // a pergunta com resposta forcada (o toque no "Buscar")
export const EXEMPLO_BUSCA = 'nome da aba ou palavra'; // o texto de exemplo no campo de digitacao
const MAX_BUSCA = 64; // a palavra guardada e mostrada (code points)

/** T29d: a palavra da busca (espacos colapsados, ate MAX_BUSCA) | '' (vazia, so espaco ou sem letra que o normalizar guarde). */
export function palavraDaBusca(s) {
  if (typeof s !== 'string') return '';
  const p = cortarCp(s.replace(/\s+/g, ' ').trim(), MAX_BUSCA);
  return normalizar(p) ? p : '';
}

/**
 * T29d (decisao 2): os dados do painel so com as abas que batem com `palavra` (sem diferenca de maiuscula e acento, pelo
 * normalizar do roteamento) no nome, no grupo (as Fechadas; sem grupo = SEM_GRUPO) ou na pergunta/1a frase que o painel
 * mostra (Esperando e Aguardando), em todos os grupos, ANTES do corte "e mais N" -> {dados, n} (n = abas que batem). Item
 * torto (que o montarPainel nao mostra) sai. Palavra vazia = os dados como estao e n = null.
 */
export function filtrarPainel(d, palavra) {
  const p = ehItem(d) ? d : {};
  const q = normalizar(palavraDaBusca(palavra));
  if (!q) return { dados: p, n: null };
  const bate = (...textos) => textos.some((x) => normalizar(String(x ?? '').replace(/\s+/g, ' ')).includes(q));
  if (p.modo === 'vscode') return filtrarEspelho(p, bate); // T38
  const mostrado = (x) => cortarCp(String(x.texto ?? '').replace(/\s+/g, ' ').trim(), MAX_TEXTO_PAINEL);
  const comPergunta = (v) => listaDe(v).filter((x) => ehItem(x) && bate(x.titulo, mostrado(x)));
  const soNome = (v) => listaDe(v).filter((x) => (typeof x === 'string' ? x.trim() !== '' && bate(x)
    : ehItem(x) && typeof x.titulo === 'string' && x.titulo.trim() !== '' && bate(x.titulo)));
  const grupoDe = (x) => (typeof x.grupo === 'string' && x.grupo.replace(/\s+/g, ' ').trim() ? x.grupo : SEM_GRUPO);
  const fechadas = listaDe(p.fechadas).filter((x) => ehItem(x) && typeof x.titulo === 'string' && x.titulo.trim() && bate(x.titulo, grupoDe(x)));
  const dados = { ...p, esperando: comPergunta(p.esperando), trabalhando: soNome(p.trabalhando), paradas: soNome(p.paradas), fechadas };
  if (p.aguardando !== undefined) dados.aguardando = comPergunta(p.aguardando);
  const n = dados.esperando.length + listaDe(dados.aguardando).length + dados.trabalhando.length + dados.paradas.length + fechadas.length;
  return { dados, n };
}

/**
 * T29d (decisao 1 e 2): o botao do painel: sem busca "Buscar" (`p:b`); com busca "Limpar busca" (`p:l`), no lugar dele.
 * T38 (PLANO-TELEGRAM.md, "T38"): com `modo` ('padrao' ou 'vscode', o modoPainelDoConfig), a linha 2: o botao que troca
 * de modo ("Modo VS Code" `p:mv` no padrao; "Modo padrão" `p:mp` no espelho) e o "Sincronizar" (`p:s`). Outro `modo`
 * (inclusive ausente) = so a linha 1, como antes.
 */
export function botoesPainel(busca, modo) {
  const linha1 = palavraDaBusca(busca)
    ? [{ texto: 'Limpar busca', dados: dadosBotao({ acao: 'limparBusca' }) }]
    : [{ texto: 'Buscar', dados: dadosBotao({ acao: 'buscar' }) }];
  if (modo !== 'padrao' && modo !== 'vscode') return [linha1];
  const troca = modo === 'vscode'
    ? { texto: 'Modo padrão', dados: dadosBotao({ acao: 'modoPadrao' }) }
    : { texto: 'Modo VS Code', dados: dadosBotao({ acao: 'modoVsCode' }) };
  return [linha1, [troca, { texto: 'Sincronizar', dados: dadosBotao({ acao: 'sincronizar' }) }]];
}

// T29d/T38: o topo do painel com a busca (n = abas que batem): "Busca: «x» (N abas)" | "Nenhuma aba com «x»."
const topoDaBusca = (palavra, n) => (n === 0 ? `Nenhuma aba com «${esc(palavra)}».`
  : `Busca: «${esc(palavra)}» (${n} ${n === 1 ? 'aba' : 'abas'})`);

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
 * T29d (PLANO-TELEGRAM.md, "T29d"): {busca} (a palavra) = so as abas que batem (filtrarPainel, antes dos cortes), o topo
 * "Busca: «x» (N abas)" (nada = "Nenhuma aba com «x».") e o grupo vazio some. Os botoes saem do botoesPainel.
 * T38 (PLANO-TELEGRAM.md, "T38"): d.modo === 'vscode' = o espelho (montarPainelVsCode). No padrao, o grupo das fechadas
 * da T14b se chama "⚪ Paradas há mais de 2 dias (N)" (pedido do dono: "fechado nao bate com fechado de verdade"; e o
 * que ele e); o campo continua `fechadas`.
 */
export function montarPainel(d, { busca = null } = {}) {
  if (ehItem(d) && d.modo === 'vscode') return montarPainelVsCode(d, { busca }); // T38
  const palavra = palavraDaBusca(busca); // T29d
  const filtro = palavra ? filtrarPainel(d, palavra) : null;
  const p = filtro ? filtro.dados : ehItem(d) ? d : {};
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
  const linhaFoco = linhaDoFoco(p.foco); // T33
  const linhaRua = linhaDaRua(p);
  const nada = 'Nada esperando resposta sua.';
  const tEsp = `🔴 Esperando você (${esperando.length})`;
  const tAg = `🔵 Aguardando (${aguardando.length})`; // T24: azul (as outras 4 cores ja sao de outro grupo)
  const tTrab = `🟡 Trabalhando (${trabalhando.length})`;
  const tPar = `🟢 Paradas (${paradas.length})`;
  const tFech = `⚪ Paradas há mais de 2 dias (${fechadas.length})`; // T38: era "⚪ Fechadas"
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
  // T29d: com a busca, o topo e a busca (ou o nada achado) e o grupo vazio some (sem a frase do nada esperando)
  const n = filtro ? filtro.n : null;
  const topo = n === null ? `Abas abertas: ${abertas}` : topoDaBusca(palavra, n);
  const rich = [`<h3>${topo}</h3>`, `<p>${linhaRua}</p>`];
  if (esperando.length) rich.push(`<details open><summary>${tEsp}</summary>${esperando.map(bloco).join('')}</details>`);
  else if (!filtro) rich.push(`<p>${nada}</p>`);
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
  if (linhaFoco) rich.push(`<p>${linhaFoco}</p>`); // T33

  // classico (kE esperando, kA aguardando, kP paradas e kF fechadas mostradas): cada grupo num <blockquote> (esperando
  // aberto)
  const item = (x) => `<b>${x.titulo}</b>${x.marca} · ${x.hora}\n${x.texto}`;
  const nomes = (v) => v.map((n) => `<b>${n.nome}</b>${n.marca}`);
  const classico = (kE, kA, kP, kF) => {
    const partes = [];
    if (esperando.length) {
      const fim = kE < esperando.length ? [mais(esperando.length - kE)] : [];
      partes.push(`<blockquote><b>${tEsp}</b>\n${[...esperando.slice(0, kE).map(item), ...fim].join('\n\n')}</blockquote>`);
    } else if (!filtro) partes.push(nada); // T29d: na busca o grupo vazio some
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
    if (linhaFoco) partes.push(linhaFoco); // T33
    return `<b>${topo}</b>\n${linhaRua}${partes.length ? `\n\n${partes.join('\n')}` : ''}`;
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

// A linha do modo rua e da hora do painel (o padrao e o espelho da T38)
const linhaDaRua = (p) => `Modo rua: ${p.modoRua === true ? 'ligado' : 'desligado'} · atualizado às ${esc(horaBRT(p.hora))}`;

// ---------- T38: o painel igual ao VS Code (PLANO-TELEGRAM.md, "T38") ----------

const MAX_ESPELHO = 300; // T38: itens mostrados no espelho rich, na ordem janela -> grupo -> item (o resto: "(e mais N)")
// T38: as marcas do item do espelho, nesta ordem; marca desconhecida ou repetida nao conta
const MARCAS_ESPELHO = [['fechada', MARCA_FECHADA], ['esperando', ' · esperando você'], ['trabalhando', ' · trabalhando']];
const TITULO_FORA = 'Fora da lista do VS Code';
const naoNeg = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);
// o nome do grupo como veio (com o icone), numa linha; vazio ou nao texto = SEM_GRUPO (sem escapar: o nome da busca)
const textoDoGrupo = (g) => {
  const t = typeof g === 'string' ? g.replace(/\s+/g, ' ').trim() : '';
  return t || SEM_GRUPO;
};

// T38: o filtro da busca no espelho (o filtrarPainel com d.modo === 'vscode'): fica o item cujo titulo ou nome do grupo
// (sem o icone) bate; grupo e janela sem item somem; o total do grupo vira os que bateram. O Fora da lista pelo titulo.
function filtrarEspelho(p, bate) {
  let n = 0;
  const soOsQueBatem = (g, doGrupo) => {
    const itens = listaDe(g.itens).filter((x) => ehItem(x) && (doGrupo || bate(x.titulo)));
    n += itens.length;
    return { ...g, total: itens.length, itens };
  };
  const janelas = listaDe(p.janelas).filter(ehItem).map((j) => ({
    ...j,
    grupos: listaDe(j.grupos).filter(ehItem).map((g) => soOsQueBatem(g, bate(nomeDoGrupo(textoDoGrupo(g.nome))))).filter((g) => g.total > 0),
  })).filter((j) => j.grupos.length > 0);
  const dados = { ...p, janelas };
  if (ehItem(p.fora)) dados.fora = soOsQueBatem(p.fora, false);
  return { dados, n };
}

/**
 * T38 (PLANO-TELEGRAM.md, "T38"; pedido do dono: o painel com os grupos da lista do VS Code) -> {html, classico}. O
 * espelho, sem o foco, as escolhas da central e o "tocou, some" do padrao. d = {modo: 'vscode', hora, modoRua, bot,
 * esperandoN, trabalhandoN, janelas: [{nome, arquivadas, centralFora, grupos: [{nome, total, semGrupo?, itens: [{titulo,
 * sid, marcas: ['fechada'|'esperando'|'trabalhando']}]}]}], fora?: {total, itens}, listaErro?}, ja na ordem da tela.
 * T40 (pedido do dono, 08/11/2026 13:13: «tem que ter uma separação melhor [...] fonte maior [...] pular umas duas
 * linhas»): cada janela abre com a linha divisoria (<hr/>) e o nome em <h1> no rich; 2 linhas em branco antes de cada
 * janela e do Fora no classico. A ordem das janelas e a das pastas do config (Workspace em cima = ele 1o no config).
 * Rich: topo "Igual ao VS Code", "🔴 N esperando · 🟡 M trabalhando", a linha do modo rua; por janela o <h1> e os grupos
 * (nome como veio, escapado, e o total) em acordeao, 1 item por paragrafo (nome com o link da T10 e as marcas na ordem
 * de MARCAS_ESPELHO), "(e mais K)" quando o total passa dos mostrados; o 1o grupo com total > 0 de cada janela aberto;
 * grupo 0 = so o nome e "(0)"; no fim da janela "Arquivadas: N" (com a central fora: "· central fora: C"). Depois das
 * janelas, o "Fora da lista do VS Code" (so com total > 0) e a LISTA_ERRO. Ate MAX_ESPELHO itens no total. Classico: o
 * mesmo com <b>/<u>/<blockquote> (o 1o grupo de cada janela sem expandable); acima dos 4096 visiveis sai o item sem
 * marca do fim e, sem nenhum, o com marca. {busca} = so os itens que batem (filtrarPainel), com o topo da busca do
 * padrao. Entrada torta nao lanca.
 */
export function montarPainelVsCode(d, { busca = null } = {}) {
  const palavra = palavraDaBusca(busca);
  const filtro = palavra ? filtrarPainel({ ...(ehItem(d) ? d : {}), modo: 'vscode' }, palavra) : null;
  const p = filtro ? filtro.dados : ehItem(d) ? d : {};
  const bot = typeof p.bot === 'string' && RE_BOT.test(p.bot) ? p.bot : null;
  const topo = filtro ? topoDaBusca(palavra, filtro.n) : 'Igual ao VS Code';
  const contagem = `🔴 ${naoNeg(p.esperandoN)} esperando · 🟡 ${naoNeg(p.trabalhandoN)} trabalhando`;
  const linhaRua = linhaDaRua(p);
  const marcas = (v) => {
    const tem = new Set(listaDe(v));
    return MARCAS_ESPELHO.filter(([m]) => tem.has(m)).map(([, t]) => t).join('');
  };
  let resta = MAX_ESPELHO;
  // o grupo pronto pra mostrar: {nome (escapado), total (nunca menos que os itens), itens: [{nome, marca}] (ate o teto)}
  const grupo = (g, nome) => {
    const itens = listaDe(g.itens).filter(ehItem);
    const ver = itens.slice(0, resta).map((x) => ({ nome: comLink(bot, x.sid, nomeAba(x.titulo)), marca: marcas(x.marcas) }));
    resta -= ver.length;
    return { nome: esc(cortarCp(nome, MAX_TITULO, '…')), total: Math.max(naoNeg(g.total), itens.length), itens: ver, aberto: false };
  };
  const janelas = listaDe(p.janelas).filter(ehItem).map((j) => {
    const grupos = listaDe(j.grupos).filter(ehItem).map((g) => grupo(g, textoDoGrupo(g.nome)));
    const primeiro = grupos.find((g) => g.total > 0);
    if (primeiro) primeiro.aberto = true;
    const arquivadas = naoNeg(j.arquivadas);
    const central = naoNeg(j.centralFora);
    return {
      nome: esc(String(j.nome ?? '').replace(/\s+/g, ' ').trim()),
      grupos,
      arquivadas: `Arquivadas: ${arquivadas}${central > 0 ? ` · central fora: ${central}` : ''}`,
    };
  });
  const fora = ehItem(p.fora) ? grupo(p.fora, TITULO_FORA) : null;
  const comFora = fora !== null && fora.total > 0;
  const listaErro = p.listaErro === true;
  const mais = (g, k) => (g.total > k ? `(e mais ${g.total - k})` : null);

  const rich = [`<h3>${topo}</h3>`, `<p>${contagem}</p>`, `<p>${linhaRua}</p>`];
  const detalhes = (g) => {
    const resto = mais(g, g.itens.length);
    const itens = g.itens.map((x) => `<p><b>${x.nome}</b>${x.marca}</p>`).join('');
    return `<details${g.aberto ? ' open' : ''}><summary>${g.nome} (${g.total})</summary>${itens}${resto ? `<p>${resto}</p>` : ''}</details>`;
  };
  for (const j of janelas) {
    rich.push(`<hr/><h1>Janela ${j.nome}</h1>`); // T40: a linha divisoria e o nome maior que o topo (<h3>)
    for (const g of j.grupos) rich.push(g.total === 0 ? `<p>${g.nome} (0)</p>` : detalhes(g));
    rich.push(`<p>${j.arquivadas}</p>`);
  }
  if (comFora) rich.push('<hr/>', detalhes(fora)); // T40: separado da ultima janela
  if (listaErro) rich.push(`<p>${LISTA_ERRO}</p>`);

  // classico: `fica` = por grupo, os itens que ainda aparecem (o corte tira do fim: primeiro os sem marca)
  const todos = [...janelas.flatMap((j) => j.grupos), ...(comFora ? [fora] : [])];
  const fila = []; // [{g, i, marcado}] na ordem da tela
  for (const g of todos) {
    g.fica = g.itens.map(() => true);
    g.itens.forEach((x, i) => fila.push({ g, i, marcado: x.marca !== '' }));
  }
  const citacao = (g) => {
    if (g.total === 0) return `<b>${g.nome} (0)</b>`;
    const vistos = g.itens.filter((_, i) => g.fica[i]).map((x) => `<b>${x.nome}</b>${x.marca}`);
    const resto = mais(g, vistos.length);
    return `<blockquote${g.aberto ? '' : ' expandable'}><b>${g.nome} (${g.total})</b>${[...vistos, ...(resto ? [resto] : [])].map((l) => `\n${l}`).join('')}</blockquote>`;
  };
  const classico = () => {
    let s = `<b>${topo}</b>\n${contagem}\n${linhaRua}`;
    // T40: 2 linhas em branco antes de cada janela e do Fora (o classico nao tem titulo maior nem linha divisoria)
    for (const j of janelas) s += `\n\n\n<b><u>Janela ${j.nome}</u></b>${j.grupos.map((g) => `\n${citacao(g)}`).join('')}\n${j.arquivadas}`;
    if (comFora) s += `\n\n\n${citacao(fora)}`;
    if (listaErro) s += `\n\n${LISTA_ERRO}`;
    return s;
  };
  let txt = classico();
  for (const marcado of [false, true]) {
    for (let k = fila.length - 1; k >= 0 && visivel(txt) > LIMITE_CLASSICO; k -= 1) {
      if (fila[k].marcado !== marcado) continue;
      fila[k].g.fica[fila[k].i] = false;
      txt = classico();
    }
  }
  return { html: rich.join(''), classico: txt };
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
 * T29c: aberta sem botao de opcao (sem opcao, ou a da aba trabalhando) = o "Menos informações" (`m:<id>`), que volta
 * pro compacto.
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

/** callback_data do botao: `o:<ID>:<n>` (opcao, n 0-9) | `i:<ID>` (Mais informações) | `m:<ID>` (T29c: Menos informações).
 *  T29d: `p:b` (acao buscar: o Buscar do painel) | `p:l` (acao limparBusca), sem id.
 *  T38: `p:mv` (acao modoVsCode) | `p:mp` (acao modoPadrao) | `p:s` (acao sincronizar), sem id.
 *  Entrada invalida (inclusive a acao 'contexto', que saiu na T7c1, e a 'concluir' (`z:<ID>`), que saiu na T14c) = TypeError. */
export function dadosBotao({ chamadoId, acao, indice } = {}) {
  if (acao === 'buscar') return 'p:b'; // T29d: o "Buscar" do painel (sem id: 1 painel so)
  if (acao === 'limparBusca') return 'p:l'; // T29d: o "Limpar busca"
  if (acao === 'modoVsCode') return 'p:mv'; // T38: o "Modo VS Code" do painel
  if (acao === 'modoPadrao') return 'p:mp'; // T38: o "Modo padrão"
  if (acao === 'sincronizar') return 'p:s'; // T38: o "Sincronizar"
  if (typeof chamadoId !== 'string' || !RE_ID.test(chamadoId)) throw new TypeError('dadosBotao: chamadoId invalido');
  if (acao === 'informacoes') return `i:${chamadoId}`;
  if (acao === 'menos') return `m:${chamadoId}`; // T29c
  if (acao === 'opcao') {
    if (!Number.isInteger(indice) || indice < 0 || indice > 9) throw new TypeError('dadosBotao: indice invalido');
    return `o:${chamadoId}:${indice}`;
  }
  throw new TypeError('dadosBotao: acao invalida');
}

/** Leitura estrita do callback_data: {acao: 'opcao', chamadoId, indice} | {acao: 'informacoes', chamadoId} (de `i:<ID>`
 *  e do legado `c:<ID>`) | {acao: 'menos', chamadoId} (T29c, de `m:<ID>`) | {acao: 'buscar' | 'limparBusca'} (T29d) |
 *  {acao: 'modoVsCode' | 'modoPadrao' | 'sincronizar'} (T38, so `p:mv`, `p:mp` e `p:s` exatos) | null (qualquer outra
 *  coisa; T14c: inclusive o `z:<ID>` do Concluir que saiu). */
export function lerDadosBotao(s) {
  if (typeof s !== 'string') return null;
  if (s === 'p:b') return { acao: 'buscar' }; // T29d
  if (s === 'p:l') return { acao: 'limparBusca' }; // T29d
  if (s === 'p:mv') return { acao: 'modoVsCode' }; // T38
  if (s === 'p:mp') return { acao: 'modoPadrao' }; // T38
  if (s === 'p:s') return { acao: 'sincronizar' }; // T38
  let m = RE_DADOS_OPCAO.exec(s);
  if (m) return { acao: 'opcao', chamadoId: m[1], indice: Number(m[2]) };
  m = RE_DADOS_INFORMACOES.exec(s);
  if (m) return { acao: 'informacoes', chamadoId: m[1] };
  m = RE_DADOS_MENOS.exec(s);
  if (m) return { acao: 'menos', chamadoId: m[1] }; // T29c
  return null;
}

// T39: o callback_data dos botoes da mensagem "Ajustes" (prefixo `a:`, fora do lerDadosBotao). As 8 strings exatas.
const DADOS_AJUSTE = [
  ['rua', true, 'a:r1'], ['rua', false, 'a:r0'],
  ['voz', true, 'a:v1'], ['voz', false, 'a:v0'],
  ['painel', 'vscode', 'a:pv'], ['painel', 'padrao', 'a:pp'],
  ['mensagens', 'apagar', 'a:ml'], ['mensagens', 'manter', 'a:mm'],
];
const LER_AJUSTE = new Map(DADOS_AJUSTE.map(([alvo, valor, s]) => [s, { alvo, valor }]));

/** T39: callback_data do botao de ajuste: o estado ALVO, nunca "alternar" (botao velho tocado 2x nao inverte 2x).
 *  rua/voz: true|false; painel: 'vscode'|'padrao'; mensagens: 'apagar'|'manter'. Qualquer outra entrada = TypeError. */
export function dadosAjuste({ alvo, valor } = {}) {
  const achado = DADOS_AJUSTE.find(([a, v]) => a === alvo && v === valor);
  if (!achado) throw new TypeError('dadosAjuste: alvo ou valor invalido');
  return achado[2];
}

/** T39: leitura estrita do callback_data de ajuste (o inverso exato das 8 strings): {alvo, valor} | null. */
export function lerDadosAjuste(s) {
  if (typeof s !== 'string') return null;
  const r = LER_AJUSTE.get(s);
  return r ? { ...r } : null;
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
