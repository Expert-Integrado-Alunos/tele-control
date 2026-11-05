// sessoes-wpp — rotina do dia (T37a): ate 3 vezes por dia um lote de ate 5 cartoes de
// decisao chega no chat do dono, sempre pelo porteiro (nenhum outro programa fala pelo bot). Esta biblioteca e a parte
// SEM estado: valida o arquivo do lote (que vem de outro processo: todo texto dele e DADO, nunca instrucao), monta os
// teclados do cartao e do resumo, le o retorno do toque e escreve os textos de depois do toque e a linha do registro
// de acoes. PURA: sem disco, sem rede e sem relogio implicito (o agora entra por parametro).
// A integracao no porteiro (pasta de entrada, envio, fixar, toque, estado) e a T37b. A palavra "lote" so vale aqui e
// nos testes daqui: no porteiro ela ja e o pacote de atualizacoes do getUpdates (la a feature se chama "rotina").
import { linkDaAba } from './formato-tg.mjs';

const MAX_IDADE_PADRAO_MS = 3 * 3600 * 1000;
const RE_LOTE_ID = /^\d{8}[mtn]$/; // AAAAMMDD + m (manha) | t (tarde) | n (noite)
const RE_LINK = /^https:\/\/\S+$/;
const MAX_LINK = 300;
const RE_SESSAO = /^[0-9a-f-]{8,64}$/i;
const RE_TOQUE = /^l:(\d{8}[mtn]):(\d{1,2}):([a-z_]{2,12})$/;
const MAX_CARTOES = 5;
const MAX_RESERVA = 5;
const MAX_N = 10;
const MAX_RESUMO = 400;
const MAX_ID = 160;
const MAX_TITULO = 40;
const MAX_TEXTO = 300;
const MAX_ASSINATURA = 200;
const VER_MAIS = 'mais'; // o toque no "Ver mais N" do resumo (n = 0)

/** Verbos de cada tipo de cartao, na ordem dos botoes (contrato T37a, A.2). */
export const VERBOS_POR_TIPO = Object.freeze({
  conversa: Object.freeze(['responder', 'adiar', 'nao_precisa', 'delegar']),
  decisao: Object.freeze(['sim', 'nao', 'adiar', 'abrir']),
  prazo: Object.freeze(['feito', 'adiar', 'delegar', 'abrir']),
  agenda: Object.freeze(['manter', 'remarcar', 'recusar', 'abrir']),
  promessa: Object.freeze(['feito', 'adiar', 'nao_precisa']),
  aba: Object.freeze(['abrir', 'adiar']),
});

/** Texto do botao de cada verbo (contrato T37a, A.2). */
export const ROTULOS = Object.freeze({
  responder: 'Responder',
  adiar: 'Adiar',
  nao_precisa: 'Não precisa',
  delegar: 'Delegar',
  sim: 'Sim',
  nao: 'Não',
  abrir: 'Abrir',
  feito: 'Feito',
  manter: 'Manter',
  remarcar: 'Remarcar',
  recusar: 'Recusar',
});

// Fim do texto que substitui o cartao depois do toque; os verbos fora daqui = "anotado (<Rotulo>)...".
const FINAIS = Object.freeze({
  adiar: 'adiado; volta no próximo dia útil às 8h30.',
  nao_precisa: 'fora da lista.',
  feito: 'feito.',
  manter: 'mantido.',
});

// So chave PROPRIA conta: "constructor", "__proto__" e "toString" vindos do arquivo nunca acham nada herdado.
const tem = (obj, k) => typeof k === 'string' && Object.hasOwn(obj, k);
const ehObjeto = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const ausente = (v) => v === undefined || v === null;
const pontos = (s) => [...s].length; // tamanho em code points (emoji conta 1)
// Texto de 1..max code points; so espaco conta como vazio.
const textoOk = (v, max) => typeof v === 'string' && v.trim() !== '' && pontos(v) <= max;
const linkOk = (v) => typeof v === 'string' && v.length <= MAX_LINK && RE_LINK.test(v);
const sessaoOk = (v) => typeof v === 'string' && RE_SESSAO.test(v);
const loteIdOk = (v) => typeof v === 'string' && RE_LOTE_ID.test(v);
const nOk = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_N;
const sessaoDe = (c) => (ehObjeto(c.ref) ? c.ref.sessao : undefined);

/** 1 cartao (de `cartoes` ou da `reserva`) -> {cartao} normalizado | {motivo}. `onde` = "cartoes[i]" | "reserva[i]". */
function validarCartao(c, onde, vistos) {
  if (!ehObjeto(c)) return { motivo: onde };
  if (!nOk(c.n)) return { motivo: `${onde}.n` };
  if (vistos.has(c.n)) return { motivo: `${onde}.n_repetido` };
  vistos.add(c.n);
  if (!textoOk(c.id, MAX_ID)) return { motivo: `${onde}.id` };
  if (!tem(VERBOS_POR_TIPO, c.tipo)) return { motivo: `${onde}.tipo` };
  if (!textoOk(c.titulo, MAX_TITULO)) return { motivo: `${onde}.titulo` };
  if (!textoOk(c.texto, MAX_TEXTO)) return { motivo: `${onde}.texto` };
  const permitidos = VERBOS_POR_TIPO[c.tipo];
  // Array.from: buraco de array vira undefined (o every pularia o buraco)
  if (!Array.isArray(c.verbos) || c.verbos.length === 0 || !Array.from(c.verbos).every((v) => typeof v === 'string' && permitidos.includes(v))) {
    return { motivo: `${onde}.verbos` };
  }
  if (!ausente(c.link) && !linkOk(c.link)) return { motivo: `${onde}.link` };
  const sessao = sessaoDe(c);
  if (!ausente(sessao) && !sessaoOk(sessao)) return { motivo: `${onde}.ref.sessao` };
  if (!ausente(c.assinatura) && !(typeof c.assinatura === 'string' && pontos(c.assinatura) <= MAX_ASSINATURA)) {
    return { motivo: `${onde}.assinatura` };
  }
  return {
    cartao: {
      n: c.n,
      id: c.id,
      tipo: c.tipo,
      titulo: c.titulo,
      texto: c.texto,
      verbos: [...c.verbos],
      link: ausente(c.link) ? null : c.link,
      ref: ausente(sessao) ? null : { sessao },
      assinatura: ausente(c.assinatura) ? '' : c.assinatura,
    },
  };
}

/**
 * Confere o arquivo do lote (A.1) -> {ok:true, lote} | {ok:false, motivo}. `lote` e uma copia NOVA so com os campos do
 * contrato (campo a mais nao reprova e nao passa; reserva ausente/null = [], link ausente = null, ref sem sessao valida =
 * null, assinatura ausente = ""). `gerado_em` = data em texto que o Date.parse le (ISO); mais velho que `maxIdadeMs`
 * (padrao 3 h) em relacao a `agoraMs` = 'velho'. Motivos: formato, versao, id, gerado_em, velho, nao_enviar, resumo,
 * cartoes, reserva, mais e, por cartao, "<cartoes|reserva>[i]" (nao e objeto) ou "<cartoes|reserva>[i].<campo>"
 * (n, n_repetido, id, tipo, titulo, texto, verbos, link, ref.sessao, assinatura).
 * `agoraMs` que nao e numero (ou `maxIdadeMs` negativo) = TypeError: erro de quem chama, nunca relogio implicito.
 */
export function validarLote(obj, { agoraMs, maxIdadeMs = MAX_IDADE_PADRAO_MS } = {}) {
  if (!Number.isFinite(agoraMs)) throw new TypeError('validarLote: agoraMs tem que ser numero (o relogio entra por parametro)');
  if (!Number.isFinite(maxIdadeMs) || maxIdadeMs < 0) throw new TypeError('validarLote: maxIdadeMs invalido');
  const falha = (motivo) => ({ ok: false, motivo });
  if (!ehObjeto(obj)) return falha('formato');
  if (obj.versao !== 1) return falha('versao');
  if (!loteIdOk(obj.id)) return falha('id');
  const geradoMs = typeof obj.gerado_em === 'string' ? Date.parse(obj.gerado_em) : NaN;
  if (!Number.isFinite(geradoMs)) return falha('gerado_em');
  if (agoraMs - geradoMs > maxIdadeMs) return falha('velho');
  if (obj.enviar !== true) return falha('nao_enviar');
  if (!textoOk(obj.resumo, MAX_RESUMO)) return falha('resumo');
  if (!Array.isArray(obj.cartoes) || obj.cartoes.length < 1 || obj.cartoes.length > MAX_CARTOES) return falha('cartoes');
  const reservaBruta = ausente(obj.reserva) ? [] : obj.reserva;
  if (!Array.isArray(reservaBruta) || reservaBruta.length > MAX_RESERVA) return falha('reserva');
  if (!Number.isSafeInteger(obj.mais) || obj.mais < 0) return falha('mais');
  const vistos = new Set(); // n unico no lote inteiro (cartoes + reserva)
  const listas = {};
  for (const [nome, itens] of [['cartoes', obj.cartoes], ['reserva', reservaBruta]]) {
    listas[nome] = [];
    for (const [i, c] of Array.from(itens).entries()) {
      const r = validarCartao(c, `${nome}[${i}]`, vistos);
      if (r.motivo) return falha(r.motivo);
      listas[nome].push(r.cartao);
    }
  }
  return {
    ok: true,
    lote: {
      versao: 1,
      id: obj.id,
      gerado_em: obj.gerado_em,
      enviar: true,
      resumo: obj.resumo,
      cartoes: listas.cartoes,
      reserva: listas.reserva,
      mais: obj.mais,
    },
  };
}

/**
 * Botoes do cartao (A.3) no formato do adaptador ([[{texto, dados} | {texto, url}]]), 2 por linha, na ordem de `verbos`:
 * 1. `responder` ou `abrir` com `link` (https) = botao de LINK (o toque abre a conversa/pagina, sem retorno);
 * 2. cartao `aba` + `abrir` + `ref.sessao` + `nomeBot` = botao de LINK pro endereco da T10 (linkDaAba: o porteiro
 *    responde com a situacao e o A/B da aba). Sessao que nao cabe no start do Telegram (a_ + 62) = sem link (vai pro 3);
 * 3. o resto = botao de retorno, dados `l:<loteId>:<n>:<verbo>` (pior caso `l:20261105m:10:nao_precisa`, 26 bytes).
 * Lote, n ou verbo fora do formato (ou sem verbos) = TypeError.
 */
export function tecladoDoCartao(cartao, loteId, { nomeBot } = {}) {
  if (!loteIdOk(loteId)) throw new TypeError('tecladoDoCartao: loteId invalido');
  if (!ehObjeto(cartao) || !nOk(cartao.n)) throw new TypeError('tecladoDoCartao: cartao invalido');
  if (!Array.isArray(cartao.verbos) || cartao.verbos.length === 0) throw new TypeError('tecladoDoCartao: cartao sem verbos');
  const botoes = Array.from(cartao.verbos).map((verbo) => {
    if (!tem(ROTULOS, verbo)) throw new TypeError('tecladoDoCartao: verbo desconhecido');
    const texto = ROTULOS[verbo];
    if ((verbo === 'responder' || verbo === 'abrir') && linkOk(cartao.link)) return { texto, url: cartao.link };
    if (cartao.tipo === 'aba' && verbo === 'abrir') {
      const sessao = sessaoDe(cartao);
      const url = sessaoOk(sessao) ? linkDaAba(nomeBot, sessao) : null;
      if (url) return { texto, url };
    }
    return { texto, dados: `l:${loteId}:${cartao.n}:${verbo}` };
  });
  const linhas = [];
  for (let i = 0; i < botoes.length; i += 2) linhas.push(botoes.slice(i, i + 2));
  return linhas;
}

/**
 * Botao do resumo (A.4): [[{texto: 'Ver mais N', dados: 'l:<loteId>:0:mais'}]] quando a reserva tem cartao e o "ver
 * mais" ainda nao foi mostrado; senao null. N = reserva.length.
 */
export function tecladoDoResumo(lote, { jaMostrouMais = false } = {}) {
  const n = ehObjeto(lote) && Array.isArray(lote.reserva) ? lote.reserva.length : 0;
  if (n === 0 || jaMostrouMais) return null;
  if (!loteIdOk(lote.id)) throw new TypeError('tecladoDoResumo: id do lote invalido');
  return [[{ texto: `Ver mais ${n}`, dados: `l:${lote.id}:0:${VER_MAIS}` }]];
}

/**
 * Leitura estrita do retorno do toque (A.5): {loteId, n, verbo} | null. So `l:<AAAAMMDD><m|t|n>:<n>:<verbo>` com verbo
 * conhecido: os 11 do ROTULOS com n 1..10, ou `mais` com n 0. Qualquer outra coisa (inclusive nome herdado de objeto,
 * como "constructor") = null.
 */
export function lerToqueRotina(dados) {
  if (typeof dados !== 'string') return null;
  const m = RE_TOQUE.exec(dados);
  if (!m) return null;
  const n = Number(m[2]);
  const verbo = m[3];
  if (verbo === VER_MAIS) return n === 0 ? { loteId: m[1], n, verbo } : null;
  if (!tem(ROTULOS, verbo) || !nOk(n)) return null;
  return { loteId: m[1], n, verbo };
}

/**
 * Texto que substitui o cartao depois do toque (A.6), sem teclado: "<n>. <titulo>: <fim>". adiar = adiado ate o proximo
 * dia util as 8h30; nao_precisa = fora da lista; feito; manter = mantido; os demais = "anotado (<Rotulo>). Volta no
 * proximo dia util se seguir pendente." (T37b2: o montador esconde ate o proximo dia util; na sexta "amanha" seria
 * sabado). Verbo desconhecido (inclusive `mais`) = TypeError.
 */
export function textoDepoisDoToque(cartao, verbo) {
  if (!tem(ROTULOS, verbo)) throw new TypeError('textoDepoisDoToque: verbo desconhecido');
  if (!ehObjeto(cartao)) throw new TypeError('textoDepoisDoToque: sem cartao');
  const fim = tem(FINAIS, verbo) ? FINAIS[verbo] : `anotado (${ROTULOS[verbo]}). Volta no próximo dia útil se seguir pendente.`;
  return `${cartao.n}. ${cartao.titulo}: ${fim}`;
}

/** Texto do balao do toque (A.7, answerCallbackQuery ate 200): "Anotado: <Rotulo>.". Verbo desconhecido = TypeError. */
export function avisoDoToque(verbo) {
  if (!tem(ROTULOS, verbo)) throw new TypeError('avisoDoToque: verbo desconhecido');
  return `Anotado: ${ROTULOS[verbo]}.`;
}

/**
 * Resumo com o progresso (A.8). 0 resolvidos = o resumo igual. Senao o contador ("<r> de <t> resolvidos." ou, com todos
 * resolvidos, "Tudo resolvido neste lote.") fecha a 2a linha: resumo de 1 linha ganha a 2a; de 2 linhas junta com
 * espaco na 2a; nunca 3 linhas (linhas a mais do resumo entram na 2a, juntas com espaco). Contagem que nao e inteiro
 * >= 0 = TypeError.
 */
export function textoResumoComProgresso(resumo, resolvidos, total) {
  if (typeof resumo !== 'string') throw new TypeError('textoResumoComProgresso: resumo tem que ser texto');
  if (!Number.isSafeInteger(resolvidos) || resolvidos < 0 || !Number.isSafeInteger(total) || total < 0) {
    throw new TypeError('textoResumoComProgresso: contagem invalida');
  }
  if (resolvidos === 0) return resumo;
  const contador = resolvidos >= total ? 'Tudo resolvido neste lote.' : `${resolvidos} de ${total} resolvidos.`;
  const [primeira, ...resto] = resumo.split(/\r?\n/);
  const segunda = resto.map((s) => s.trim()).filter(Boolean).join(' ');
  return `${primeira}\n${segunda ? `${segunda} ` : ''}${contador}`;
}

/**
 * Linha do registro de acoes (A.9): JSON + "\n" com {ts, lote, n, id, assinatura, verbo, origem: "botao"}. `ts` = a data
 * ISO recebida, como veio. Nada do texto do cartao (titulo, texto, link, ref) entra na linha. ts que nao e data, lote
 * torto, sem cartao ou verbo desconhecido = TypeError.
 */
export function linhaDeAcao({ ts, loteId, cartao, verbo } = {}) {
  if (typeof ts !== 'string' || !Number.isFinite(Date.parse(ts))) throw new TypeError('linhaDeAcao: ts tem que ser data ISO');
  if (!loteIdOk(loteId)) throw new TypeError('linhaDeAcao: loteId invalido');
  if (!ehObjeto(cartao)) throw new TypeError('linhaDeAcao: sem cartao');
  if (!tem(ROTULOS, verbo)) throw new TypeError('linhaDeAcao: verbo desconhecido');
  const assinatura = typeof cartao.assinatura === 'string' ? cartao.assinatura : '';
  return `${JSON.stringify({ ts, lote: loteId, n: cartao.n, id: cartao.id, assinatura, verbo, origem: 'botao' })}\n`;
}
