// sessoes-wpp — formato do aviso (markdown do Claude -> texto do WhatsApp).
// Modulo PURO: sem I/O, sem rede, sem disco, sem process.env. Contrato: PLANO.md
// ("Desenho" item 4 e "Contratos dos eventos"). Quem envia e o porteiro (D3); aqui so se monta o texto.
// A4a (PLANO-ABERTO.md, "A4a — o dono no config e o fuso"): a hora e o dia saem no fuso em uso. O modulo nasce em
// Brasilia (FUSO_PADRAO; os testes seguem deterministicos) e cada ponto de entrada troca pelo do dono com
// definirFuso(donoDoConfig(cfg).fuso) antes de montar texto com hora.

/** A4a: o fuso em que o modulo nasce; o do dono entra pelo definirFuso. */
export const FUSO_PADRAO = 'America/Sao_Paulo';

// "HH:MM" e "dd/mm" num fuso; lanca (RangeError) se o Intl nao aceita o fuso
const fmtHora = (fuso) => new Intl.DateTimeFormat('pt-BR', {
  timeZone: fuso,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23', // meia-noite = 00, nunca 24
});
const fmtDia = (fuso) => new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, day: '2-digit', month: '2-digit' });

let fusoEmUso = FUSO_PADRAO;
let FMT_HORA = fmtHora(FUSO_PADRAO);
let FMT_DIA = fmtDia(FUSO_PADRAO);

/**
 * A4a: troca o fuso do horaBRT e do diaBRT. So texto que o Intl aceita no timeZone, como veio (sem aparar: quem chama
 * passa o fuso ja validado pelo donoDoConfig): refaz os 2 formatos, guarda a forma canonica e devolve true. O resto
 * devolve false e nada muda. Nunca lanca.
 */
export function definirFuso(fuso) {
  if (typeof fuso !== 'string') return false;
  try {
    const hora = fmtHora(fuso);
    const dia = fmtDia(fuso);
    fusoEmUso = hora.resolvedOptions().timeZone;
    FMT_HORA = hora;
    FMT_DIA = dia;
    return true;
  } catch {
    return false;
  }
}

/** A4a: o fuso em uso, na forma canonica do Intl (FUSO_PADRAO ate o 1o definirFuso que deu certo). */
export function fusoAtual() {
  return fusoEmUso;
}

// ISO com hora obrigatoria. Fuso: Z, +HH:MM, +HHMM ou +HH (Postgres). Sem fuso = UTC (contrato: "ISO UTC"),
// para nunca cair no fuso do processo.
const RE_ISO = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

function paraData(iso) {
  if (typeof iso !== 'string') return null;
  const m = RE_ISO.exec(iso.trim());
  if (!m) return null;
  let fuso = (m[3] || 'Z').toUpperCase();
  if (/^[+-]\d{2}$/.test(fuso)) fuso += ':00';
  else if (/^[+-]\d{4}$/.test(fuso)) fuso = `${fuso.slice(0, 3)}:${fuso.slice(3)}`;
  const d = new Date(`${m[1]}T${m[2]}${fuso}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * "HH:MM" no fuso em uso (fusoAtual: Brasilia ate o definirFuso; via Intl, independe do TZ do processo). ISO invalido
 * -> "??:??". O nome segue o de antes (a fase C renomeia).
 */
export function horaBRT(iso) {
  const d = paraData(iso);
  if (!d) return '??:??';
  const partes = FMT_HORA.formatToParts(d);
  const h = partes.find((p) => p.type === 'hour')?.value;
  const min = partes.find((p) => p.type === 'minute')?.value;
  return h && min ? `${h}:${min}` : '??:??';
}

/** T9: "dd/mm" no fuso em uso (o mesmo do horaBRT; via Intl, independe do TZ do processo). ISO invalido -> "??/??". */
export function diaBRT(iso) {
  const d = paraData(iso);
  if (!d) return '??/??';
  const partes = FMT_DIA.formatToParts(d);
  const dia = partes.find((p) => p.type === 'day')?.value;
  const mes = partes.find((p) => p.type === 'month')?.value;
  return dia && mes ? `${dia}/${mes}` : '??/??';
}

// ---------- limparParaWhatsApp ----------

// Um emoji = base pictografica (ou bandeira) + seletores/modificadores/tags, encadeados por ZWJ.
const MOD = String.raw`(?:[️⃣]|\p{Emoji_Modifier}|[\u{E0020}-\u{E007F}])*`;
const BASE = String.raw`(?:\p{Extended_Pictographic}|\p{Regional_Indicator})`;
const UM_EMOJI = String.raw`${BASE}${MOD}(?:‍${BASE}${MOD})*`;
// Captura 1 espaco depois da corrida de emoji (some junto quando o emoji abre a linha ou vem depois de espaco).
const RE_EMOJI = new RegExp(String.raw`(?:${UM_EMOJI})+([ \t]?)`, 'gu');
// Sobras soltas (seletor de variacao, keycap, ZWJ, tom de pele, tags).
const RE_SOBRA_EMOJI = /[️⃣‍]|\p{Emoji_Modifier}|[\u{E0020}-\u{E007F}]/gu;

function trocarEmoji(s) {
  s = s
    .replace(/⚠️?/g, 'Atenção:') // ⚠️
    .replace(/✅️?/g, 'ok:') // ✅
    .replace(/❌️?/g, 'não:'); // ❌
  // 🔴 🟢 🟡 e qualquer outro Extended_Pictographic: somem, com o espaco que vier depois.
  s = s.replace(RE_EMOJI, (_m, espaco, pos, orig) => (pos === 0 || /[ \t\n]/.test(orig[pos - 1]) ? '' : espaco));
  return s.replace(RE_SOBRA_EMOJI, '');
}

const RE_REGUA = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/; // ---, ***, ___ (e variantes com espaco)
const RE_TITULO = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RE_LINHA_TABELA = /^[ \t]*\|(.*)\|[ \t]*$/;

function ehSeparadorDeTabela(l) {
  return l.includes('|') && l.includes('-') && /^[ \t|:-]+$/.test(l);
}

// Regras a), b) e c) numa linha fora de bloco ```. Devolve null quando a linha sai.
function converterLinha(linha) {
  // `codigo` inline fica como esta: guarda antes, devolve no fim.
  const guardados = [];
  let l = linha.replace(/`[^`\n]*`/g, (c) => {
    guardados.push(c);
    return `\u0000${guardados.length - 1}\u0000`;
  });

  // a) enfase e titulo
  l = l
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/~~(.+?)~~/g, '~$1~');
  const titulo = RE_TITULO.exec(l);
  if (titulo) {
    let x = titulo[1];
    const jaNegrito = /^\*(.+)\*$/.exec(x); // "## **Resumo**" nao vira "**Resumo**"
    if (jaNegrito) x = jaNegrito[1];
    l = x ? `*${x}*` : '';
  }

  // b) link
  l = l.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1 ($2)');

  // c) regua e tabela
  if (RE_REGUA.test(l)) return null;
  if (ehSeparadorDeTabela(l)) return null;
  const tabela = RE_LINHA_TABELA.exec(l);
  if (tabela) {
    l = `- ${tabela[1]
      .split('|')
      .map((c) => c.trim())
      .join(' | ')}`;
  }

  return l.replace(/\u0000(\d+)\u0000/g, (_m, i) => guardados[Number(i)]);
}

/**
 * Markdown do Claude -> texto aceito pelo WhatsApp (o servidor recusa emoji).
 * Ordem: a) enfase/titulo; b) link; c) regua/tabela; d) emoji; e) travessao; f) espacos e linhas vazias.
 * Blocos ```, `codigo` inline e citacao `>` ficam como estao (a/b/c nao mexem dentro deles; d/e/f valem no texto todo).
 */
export function limparParaWhatsApp(md) {
  if (md == null) return '';
  const linhas = String(md).replace(/\r\n?/g, '\n').split('\n');
  const saida = [];
  let emBloco = false;
  for (const linha of linhas) {
    if (/^ {0,3}```/.test(linha)) {
      emBloco = !emBloco;
      saida.push(linha);
      continue;
    }
    if (emBloco) {
      saida.push(linha);
      continue;
    }
    const l = converterLinha(linha);
    if (l !== null) saida.push(l);
  }
  let s = saida.join('\n');
  s = trocarEmoji(s); // d)
  s = s.replace(/[—–]/g, '-'); // e) — e –
  s = s
    .replace(/[ \t]+$/gm, '') // f) espaco no fim da linha
    .replace(/\n{3,}/g, '\n\n') // no maximo 1 linha vazia seguida
    .replace(/^\n+|\n+$/g, '');
  return s;
}

// ---------- aviso ----------

/** Evento "parou" espera o dono? (DECISAO, "Fica com voce" ou pergunta no fim). */
export function precisaDoDono(ev) {
  const m = ev && ev.marcas;
  return Boolean(m && (m.decisao || m.fica || m.pergunta));
}

// ---------- cabecalho (F4g, pedido do dono: "use esse icone ... para o nome da sessao") ----------

/** Icone antes do nome de uma ABA (o do exemplo do dono). O voz.mjs tira todo emoji do TTS, entao nao e falado. */
export const ICONE = 'ℹ️';
/** Icone da voz do PROPRIO controle (pedido do dono: "painel de controle"), pra distinguir da aba no grupo/Telegram. */
export const ICONE_CONTROLE = '🎛️';

// nome limpo numa linha so (vai dentro de *...*): sem emoji (nem o proprio icone), sem asterisco, espacos colapsados.
function limparNome(s) {
  return typeof s === 'string' ? limparParaWhatsApp(s).replace(/\*/g, '').replace(/\s+/g, ' ').trim() : '';
}

/** 1a linha de toda mensagem no grupo: icone + nome em negrito ("sem nome" se vazio). ICONE_CONTROLE = voz do controle. */
export function cabecalho(nome, icone = ICONE) {
  return `${icone} *${limparNome(nome) || 'sem nome'}*`;
}

// titulo salvo, senao nome derivado, senao "sem nome".
function cabecalhoDoEvento(ev) {
  return cabecalho(limparNome(ev?.titulo) || limparNome(ev?.nome));
}

// ---------- as 2 linhas (F4g: "no maximo duas linhas, o que aconteceu ... a pergunta do que eu tenho que fazer") ----------

const FATO_MAX = 200;
const PERGUNTA_MAX = 300;
const OPCOES_MAX = 400;
const FRASE_MIN = 20; // frase mais curta que isso ("Pronto.") junta a seguinte da mesma linha

// "**DECISÃO:**", "DECISAO**:", "DECISÃO:", "DECISÃO (ainda aberta):"
const RE_DECISAO = /DECIS[AÃ]O\s*(?:\([^)\n]{0,40}\))?\s*[*_]*\s*:\s*[*_]*\s*/i;
// A linha COMECA com "Fica com você" ("Fica com você:", "Fica com você, no celular:"); no meio da frase nao conta.
const RE_FICA = /^[*_\s]*Fica com voc[eê](?![\p{L}\p{N}])/u;
const RE_OPCAO = /^\(?[A-E]\)\s/; // "A) ..." (sempre maiuscula: "a)" e sublista)
const RE_ITEM = /^(?:[-*•]|\d{1,2}[.)])\s+/;
// A linha que o recado manda a sessao abrir. A4b: "> WhatsApp|Telegram do|da|de <nome> (" de qualquer nome (o do dono no
// config.json: 1 a 40 code points, comeca com letra, nunca parenteses nem « »; sem nome = "do dono").
export const RE_CITACAO_DO_DONO = /^[ \t]*>[ \t]*(?:WhatsApp|Telegram) d[aeo] \p{L}[^\n()«»]{0,39}? \(/u;
const RE_ROTULO_DO_DONO = /(?:WhatsApp|Telegram) d[aeo] \p{L}[^\n()«»]{0,39}? \(/u;
/** A4b: o texto tem o rotulo da linha de citacao ("WhatsApp do Davi (", "Telegram da Ana (") em qualquer ponto? */
export function temLinhaDoDono(t) {
  return typeof t === 'string' && RE_ROTULO_DO_DONO.test(t);
}
// Fim de frase: . ! ? (ou ...) com fechamento opcional, seguido de espaco e de algo que nao e minuscula.
const RE_FIM_FRASE = /[.!?…]+["'”»)\]]*(?=\s+[^\s\p{Ll}])/gu;
const RE_ABREVIATURA = /(?:^|[\s(])(?:Dr|Dra|Sr|Sra|Srta|Prof|Profa|Eng|Av|ex|Ex|obs|Obs|p|pg|pág|n|nº|vs|aprox|etc)\.$/;
// O que esta com o dono, sem ser pergunta ("continua com você", "esperando o seu OK", "sua decisão", "em aberto").
const RE_COM_ELE = new RegExp([
  'seu OK', 'sua (?:decis[aã]o|aprova[cç][aã]o|resposta)', 'decis[aã]o sua',
  '(?:continua|continuam|fica|ficam|est[aá]|est[aã]o|segue|seguem) com voc[eê]', // "conversa com você" nao conta
  'esperando (?:voc[eê]|o seu|a sua)', 'depende de voc[eê]', 'falta (?:s[oó] )?voc[eê]', 'pend[eê]ncia', 'pendente', 'em aberto',
].join('|'), 'i');

// T9: o titulo do bloco "Pendências da sessão" do fim da mensagem (sozinho na linha; negrito, "###" e ":" podem).
const RE_PENDENCIAS = /^Pend[eê]ncias da sess[aã]o\s*:?$/i;

const semNegrito = (s) => s.replace(/\*/g, '').replace(/[ \t]+/g, ' ').trim();
const semMarcador = (s) => s.replace(RE_ITEM, '');

// Corta em palavra com "..." (por code point). Sem espaco antes do teto = corte seco.
function encurtar(s, max) {
  const cps = Array.from(s);
  if (cps.length <= max) return s;
  const corte = cps.slice(0, max - 3).join('');
  const espaco = corte.lastIndexOf(' ');
  return `${(espaco > 0 ? corte.slice(0, espaco) : corte).replace(/[\s,;:.-]+$/, '')}...`;
}

// As frases de uma linha (abreviatura como "Dr." nao corta); sem fim de frase = a linha toda.
function frasesDe(t) {
  const saida = [];
  let inicio = 0;
  RE_FIM_FRASE.lastIndex = 0;
  let m;
  while ((m = RE_FIM_FRASE.exec(t))) {
    const fim = m.index + m[0].length;
    if (RE_ABREVIATURA.test(t.slice(0, fim))) continue;
    saida.push(t.slice(inicio, fim).trim());
    inicio = fim;
  }
  saida.push(t.slice(inicio).trim());
  return saida.filter(Boolean);
}

// 1a frase com pelo menos FRASE_MIN caracteres (frase curta junta a seguinte); sem fim de frase = a linha toda.
function primeiraFrase(t) {
  let junta = '';
  for (const f of frasesDe(t)) {
    junta = junta ? `${junta} ${f}` : f;
    if (junta.length >= FRASE_MIN) break;
  }
  return junta;
}

// Itens juntos com "; " (sem o ponto final, ";" ou "," dos do meio; o ultimo so perde ";" e ",") ate o teto; o que nao
// coube vira "(e mais N)".
function juntarItens(itens, max) {
  const limpos = itens.map((x) => x.trim()).filter(Boolean);
  if (!limpos.length) return '';
  const meio = limpos.map((x, i) => (i < limpos.length - 1 ? x.replace(/[.;,]+$/, '') : x.replace(/[;,]+$/, '')));
  let saida = '';
  for (let i = 0; i < meio.length; i++) {
    const prox = saida ? `${saida}; ${meio[i]}` : meio[i];
    if (Array.from(prox).length > max) {
      if (!saida) return encurtar(meio[i], max);
      return `${saida.replace(/\.+$/, '')}; (e mais ${meio.length - i})`;
    }
    saida = prox;
  }
  return saida;
}

// Linhas do markdown (fora de bloco ```), cada uma com o texto limpo pro WhatsApp e o tipo. `saida.temBloco` = tinha
// bloco ``` (texto pra copiar, que nao vai nas 2 linhas).
function linhasDoFinal(md) {
  const saida = [];
  let emBloco = false;
  for (const bruta of String(md ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (/^ {0,3}```/.test(bruta)) {
      emBloco = !emBloco;
      saida.temBloco = true;
      continue;
    }
    if (emBloco) continue;
    const limpa = limparParaWhatsApp(bruta).trim();
    let tipo = 'texto';
    if (!limpa) tipo = 'vazia';
    else if (/^\s*>/.test(bruta)) tipo = 'citacao';
    else if (/^(?:Escrito pra|Escrito para|Written for)\s*:/i.test(semNegrito(limpa))) tipo = 'meta'; // pra quem e a peca
    else if (RE_PENDENCIAS.test(semNegrito(limpa).replace(/^#{1,6}\s*/, ''))) tipo = 'pendencias'; // T9
    else if (RE_TITULO.test(bruta)) tipo = 'titulo';
    else if (RE_LINHA_TABELA.test(bruta) || ehSeparadorDeTabela(bruta)) tipo = 'tabela';
    else if (RE_DECISAO.test(limpa)) tipo = 'decisao';
    else if (RE_FICA.test(semMarcador(limpa))) tipo = 'fica';
    else if (RE_OPCAO.test(semNegrito(semMarcador(limpa)))) tipo = 'opcao';
    else if (RE_ITEM.test(limpa)) tipo = 'item';
    saida.push({ limpa, tipo });
  }
  return saida;
}

// As opcoes (A) ...) logo depois do indice `i` (linha vazia no meio pode), juntas com " / ".
function opcoesDepois(linhas, i) {
  const opcoes = [];
  for (let j = i + 1; j < linhas.length; j++) {
    if (linhas[j].tipo === 'vazia') continue;
    if (linhas[j].tipo !== 'opcao') break;
    opcoes.push(semNegrito(semMarcador(linhas[j].limpa)));
  }
  return opcoes.join(' / ');
}

const maiuscula = (s) => (s ? s[0].toLocaleUpperCase('pt-BR') + s.slice(1) : s);

// {forte, resto, opcoes, indice} da pergunta: DECISAO > "Fica com voce" > ultima linha com "?" > o bloco "Pendências da
// sessão" (T9) > a frase do que esta com ele. Nenhuma = null. `forte` vai em negrito (sem asterisco dentro); `resto` (so no "Fica com voce": os itens) vem
// depois, fora do negrito. T5a: em partes pra cada canal montar no seu formato (WhatsApp `*forte* resto`, Telegram <b>).
function perguntaDoFinal(linhas) {
  const iDec = linhas.findLastIndex((x) => x.tipo === 'decisao');
  if (iDec >= 0) {
    const resto = linhas[iDec].limpa.slice(linhas[iDec].limpa.search(RE_DECISAO)).replace(RE_DECISAO, '');
    let q = semNegrito(resto);
    let opcoes = '';
    const naLinha = /\s\(?A\)\s/.exec(q);
    if (naLinha) {
      opcoes = q.slice(naLinha.index + 1).trim();
      q = q.slice(0, naLinha.index).trim();
    }
    let iQ = iDec;
    if (!q) {
      iQ = linhas.findIndex((x, j) => j > iDec && x.tipo === 'texto');
      q = iQ >= 0 ? semNegrito(linhas[iQ].limpa) : '';
    }
    if (q) {
      if (!opcoes) opcoes = opcoesDepois(linhas, iQ);
      return { forte: encurtar(maiuscula(q), PERGUNTA_MAX), resto: '', opcoes: encurtar(opcoes, OPCOES_MAX), indice: iQ };
    }
  }
  const iFica = linhas.findIndex((x) => x.tipo === 'fica');
  if (iFica >= 0) {
    // "Fica com você, no celular: X" = cabeca ate os dois pontos (com o "no celular") + X; sem dois pontos = "Fica com você:"
    const l = semNegrito(semMarcador(linhas[iFica].limpa));
    const doisPontos = l.indexOf(':');
    const cabeca = doisPontos >= 0 ? l.slice(0, doisPontos + 1).trim() : 'Fica com você:';
    const mesmaLinha = (doisPontos >= 0 ? l.slice(doisPontos + 1) : l.replace(/^Fica com voc[eê]/u, '')).trim();
    const itens = mesmaLinha ? [primeiraFrase(mesmaLinha)] : [];
    for (let j = iFica + 1; j < linhas.length && linhas[j].tipo === 'item'; j++) {
      itens.push(primeiraFrase(semNegrito(semMarcador(linhas[j].limpa))));
    }
    const juntos = juntarItens(itens, PERGUNTA_MAX);
    if (juntos) return { forte: cabeca, resto: juntos, opcoes: '', indice: iFica };
  }
  let iUlt = linhas.length - 1;
  while (iUlt >= 0 && (linhas[iUlt].tipo === 'vazia' || linhas[iUlt].tipo === 'opcao')) iUlt -= 1;
  if (iUlt >= 0 && linhas[iUlt].tipo === 'texto' && /\?$/.test(semNegrito(linhas[iUlt].limpa))) {
    return {
      forte: encurtar(semNegrito(linhas[iUlt].limpa), PERGUNTA_MAX),
      resto: '',
      opcoes: encurtar(opcoesDepois(linhas, iUlt), OPCOES_MAX),
      indice: iUlt,
    };
  }
  // T9 (05/10/2026: "Depoimentos (20:11): Pendências da sessão"): o bloco "Pendências da sessão" = os itens logo abaixo
  // do titulo (linha vazia logo depois do titulo pode), juntos; o titulo sem item nao vira pergunta.
  const iPend = linhas.findLastIndex((x) => x.tipo === 'pendencias');
  if (iPend >= 0) {
    let j = iPend + 1;
    while (j < linhas.length && linhas[j].tipo === 'vazia') j += 1;
    const itens = [];
    for (; j < linhas.length && (linhas[j].tipo === 'item' || linhas[j].tipo === 'texto'); j++) {
      itens.push(semNegrito(semMarcador(linhas[j].limpa)));
    }
    const juntos = juntarItens(itens, PERGUNTA_MAX);
    if (juntos) return { forte: juntos, resto: '', opcoes: '', indice: iPend + 1 };
  }
  // Sem pergunta, mas com o que esta com ele: a frase da ULTIMA linha assim (uso real 27/09 a 01/10: 36 de 525 avisos
  // sem DECISAO, quase todos com "continua com você", "esperando o seu OK", "sua decisão", "em aberto" no fim).
  for (let j = linhas.length - 1; j >= 0; j--) {
    if (linhas[j].tipo !== 'texto' && linhas[j].tipo !== 'item') continue;
    const frase = frasesDe(semNegrito(semMarcador(linhas[j].limpa))).find((f) => RE_COM_ELE.test(f));
    if (frase) return { forte: comItens(frase, linhas, j, PERGUNTA_MAX), resto: '', opcoes: '', indice: j, fatoNaLinha: true, frase };
  }
  return null;
}

// Frase que termina em ":" leva os itens da lista logo abaixo de `i` ("; ") ate o indice `ate` (fora), no teto.
function comItens(frase, linhas, i, max, ate = linhas.length) {
  if (!frase.endsWith(':')) return encurtar(frase, max);
  const itens = [];
  for (let j = i + 1; j < ate && linhas[j].tipo === 'item'; j++) itens.push(semNegrito(semMarcador(linhas[j].limpa)));
  const juntos = juntarItens(itens, max);
  return encurtar(juntos ? `${frase} ${juntos}` : frase, max);
}

// O que aconteceu: a 1a frase da 1a linha de texto (ou item) antes da pergunta (ou na linha dela, quando a pergunta e
// so uma frase da linha); termina em ":" = leva os itens de baixo, sem chegar na linha da pergunta. A 1a frase que ja
// contem a pergunta da linha = '' (a mesma frase nao sai 2 vezes).
function fatoDoFinal(linhas, pergunta) {
  const fim = !pergunta ? linhas.length : pergunta.fatoNaLinha ? pergunta.indice + 1 : pergunta.indice;
  const i = linhas.findIndex((x, j) => j < fim && (x.tipo === 'texto' || x.tipo === 'item'));
  if (i < 0) return '';
  const frase = primeiraFrase(semNegrito(semMarcador(linhas[i].limpa)));
  if (pergunta?.fatoNaLinha && i === pergunta.indice && frase.includes(pergunta.frase)) return '';
  const ate = pergunta ? pergunta.indice : linhas.length;
  return comItens(frase, linhas, i, FATO_MAX, ate);
}

/**
 * T5a: as 2 linhas de uma mensagem final, em partes (o WhatsApp e o Telegram montam cada um no seu formato, com a mesma
 * regra): {fato, pergunta: {forte, resto, opcoes} | null, temBloco}. Texto ja limpo do markdown (sem asterisco, sem
 * emoji, `codigo` inline fica). temBloco = tinha bloco ``` (o texto pra copiar, que nao entra nas 2 linhas).
 */
export function partesCurtas(final) {
  const linhas = linhasDoFinal(final);
  const p = perguntaDoFinal(linhas);
  return {
    fato: fatoDoFinal(linhas, p),
    pergunta: p ? { forte: p.forte, resto: p.resto, opcoes: p.opcoes } : null,
    temBloco: linhas.temBloco === true,
  };
}

// Mensagem curta: cabecalho / o que aconteceu / linha vazia / pergunta / opcoes. Sem nada = `vazio` (so um bloco ```,
// como o prompt pra copiar = "Deixou um texto pra copiar.").
function montarCurta(ev, vazio) {
  const { fato, pergunta, temBloco } = partesCurtas(ev?.final);
  const partes = [cabecalhoDoEvento(ev)];
  if (fato) partes.push(fato);
  if (pergunta) {
    if (fato) partes.push('');
    partes.push(`*${pergunta.forte}*${pergunta.resto ? ` ${pergunta.resto}` : ''}`);
    if (pergunta.opcoes) partes.push(pergunta.opcoes);
  }
  if (partes.length === 1) partes.push(temBloco ? 'Deixou um texto pra copiar.' : vazio);
  return partes.join('\n');
}

const LIMITE_FINAL = 3500;
const CABECA_FINAL = 1000;
const CAUDA_FINAL = 2300; // a DECISAO fica no fim: a cauda e maior que a cabeca

function cortarFinal(texto) {
  const cps = Array.from(texto); // por code point: nunca parte um par substituto
  if (cps.length <= LIMITE_FINAL) return texto;
  return `${cps.slice(0, CABECA_FINAL).join('')}\n(...)\n${cps.slice(-CAUDA_FINAL).join('')}`;
}

/** Texto do aviso de 1 evento "parou" pro grupo (F4g: so as 2 linhas). */
export function montarAviso(ev) {
  return montarCurta(ev, 'Parou esperando você.');
}

/** F4g: a fala do dono pede detalhe ("detalha", "detalhe", "detalhes")? Entao a resposta vai inteira. */
export function pedeDetalhe(texto) {
  return typeof texto === 'string' && /detalh/i.test(texto);
}

/**
 * Texto da resposta de uma sessao que recebeu repasse do grupo (1o "parou" depois da entrega). F4g: as 2 linhas, como
 * o aviso; `completo: true` (a fala pediu detalhe) = o texto inteiro limpo (corte 1000 + 2300), sem a linha de citacao.
 */
export function montarResposta(ev, { completo = false } = {}) {
  if (completo !== true) return montarCurta(ev, 'Respondeu sem texto.');
  const semCitacao = String(ev?.final ?? '').replace(/\r\n?/g, '\n').split('\n').filter((l) => !RE_CITACAO_DO_DONO.test(l));
  const corpo = cortarFinal(limparParaWhatsApp(semCitacao.join('\n')));
  return `${cabecalhoDoEvento(ev)}\n${corpo || 'Respondeu sem texto.'}`;
}

/**
 * F4.1: texto que substitui (edicao no WhatsApp) o aviso/resposta de uma sessao quando a fala do dono chega nela.
 * `ev` = {titulo, nome} da mensagem editada (mesmo cabecalho do aviso); `hora` = "HH:MM" da fala do dono (a do pedido).
 * Hora fora do formato = "??:??".
 */
export function montarConcluido(ev, hora) {
  const hh = typeof hora === 'string' && /^\d{2}:\d{2}$/.test(hora) ? hora : '??:??';
  return `${cabecalhoDoEvento(ev)}\nConcluído: você respondeu às ${hh}.`;
}

