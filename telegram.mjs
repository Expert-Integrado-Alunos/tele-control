// sessoes-wpp — adaptador da Bot API do Telegram preso ao chat privado do dono (o bot do config.json).
// Por que existe: o porteiro (sem IA) precisa ler o chat e mandar, editar e apagar o chamado vivo sem passar por uma
// sessao do Claude. Sem dependencia: fetch do Node, POST JSON em https://api.telegram.org/bot<chave>/<metodo>.
// Destino FIXO: nenhum metodo recebe chat; tudo que envia, edita ou apaga vai pro `chatId` da criacao (A1: o chat do
// config.json). A chave nunca aparece em retorno, erro lancado ou texto de erro (nem a URL com ela): tudo passa pelo
// limpar. Envio, edicao, apagar e resposta de toque saem numa fila propria, 1 por vez, com pelo menos intervaloMs
// entre o inicio de uma e o da seguinte (limite do Telegram por chat); leitura, getMe, download e comandos ficam fora.
// Contrato: PLANO-TELEGRAM.md ("Contratos", T1). Formato do texto: lib/formato-tg.mjs.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname } from 'node:path';

const API = 'https://api.telegram.org';
const PRAZO_MS = 30000;
const PRAZO_DOWNLOAD_MS = 120000;
const PRAZO_VOZ_MS = 60000; // T17a: o sendVoice sobe o arquivo inteiro
const MAX_LEGENDA = 1024; // caption do sendVoice: ate 1024
const MAX_ARQUIVO = 20 * 1024 * 1024; // getFile so serve ate 20 MB
const MAX_DADOS = 64; // callback_data: 1 a 64 bytes
const MAX_TOQUE = 200; // answerCallbackQuery: texto ate 200
const MAX_ERRO = 200;
// T7e2: erro de rede em que o pedido certamente NAO chegou no Telegram (nome nao resolveu, conexao recusada ou que nem
// abriu). Qualquer outro erro de rede (prazo estourado, conexao que caiu no meio, codigo desconhecido ou sem codigo) e
// resposta com corpo ilegivel = incerto: pode ter chegado.
const REDE_CERTA = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
]);

/** Codigo (texto) do erro de rede: o da causa (undici), o do proprio erro ou o do 1o de um AggregateError | null. */
function codigoDeRede(e) {
  const candidatos = [e?.cause?.code, e?.code, e?.cause?.errors?.[0]?.code, e?.errors?.[0]?.code];
  return candidatos.find((x) => typeof x === 'string' && x) ?? null;
}

/** O fetch lancou: o pedido pode ter chegado? TimeoutError (AbortSignal.timeout) = sim; so a lista REDE_CERTA = nao. */
function redeIncerta(e) {
  if (e?.name === 'TimeoutError') return true;
  return !REDE_CERTA.has(codigoDeRede(e));
}

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Corta em n unidades UTF-16 sem partir par substituto. */
function cortar(s, n) {
  const t = String(s);
  if (t.length <= n) return t;
  const c = t.charCodeAt(n - 1);
  return t.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}

/** Texto sem tags, com as 4 entidades do Telegram desfeitas (&amp; por ultimo: "&amp;lt;" volta a ser "&lt;"). */
function semTags(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/** message_id valido (inteiro > 0; aceita string de digitos, que e como volta de chave de objeto) ou null. */
function idMensagem(v) {
  if (Number.isSafeInteger(v) && v > 0) return v;
  if (typeof v === 'string' && /^\d{1,15}$/.test(v) && Number(v) > 0) return Number(v);
  return null;
}

/**
 * Botoes do porteiro ([[{texto, dados, estilo, desativado}]]) -> {markup: {inline_keyboard}} | {erro}.
 * Campo ausente nao vai; disabled:{} so com desativado === true; dados com mais de 64 bytes UTF-8 = erro (sem API).
 */
function teclado(botoes) {
  if (!Array.isArray(botoes) || !botoes.every(Array.isArray)) return { erro: 'botoes: formato invalido' };
  const linhas = [];
  for (const linha of botoes) {
    const saida = [];
    for (const b of linha) {
      if (!b || typeof b !== 'object') return { erro: 'botoes: formato invalido' };
      const k = {};
      if (b.texto != null) k.text = String(b.texto);
      if (b.dados != null) {
        const dados = String(b.dados);
        if (Buffer.byteLength(dados, 'utf8') > MAX_DADOS) return { erro: `botoes: dados com mais de ${MAX_DADOS} bytes` };
        k.callback_data = dados;
      }
      if (b.estilo != null) k.style = String(b.estilo);
      if (b.desativado === true) k.disabled = {};
      saida.push(k);
    }
    linhas.push(saida);
  }
  return { markup: { inline_keyboard: linhas } };
}

// A1 (PLANO-ABERTO.md): `chatId` = o chat do dono (telegram.chatId do config.json), inteiro seguro > 0 em numero; fora
// disso lanca aqui, antes de qualquer chamada (a mensagem nunca leva a chave).
export function criarTelegram({ token, chatId, fetch = globalThis.fetch, dormir = esperar, agora = Date.now, intervaloMs = 1100 } = {}) {
  if (typeof token !== 'string' || !token.trim()) throw new TypeError('criarTelegram: sem a chave do bot');
  if (!Number.isSafeInteger(chatId) || chatId <= 0) throw new TypeError('criarTelegram: chatId tem que ser inteiro positivo (telegram.chatId do config.json)');
  const chaveUrl = encodeURIComponent(token);
  const intervalo = Number.isFinite(intervaloMs) && intervaloMs > 0 ? intervaloMs : 0;

  /** Tira a chave de qualquer texto: a chave literal (e a versao de URL) e todo /bot<algo>/ ou /file/bot<algo>/. */
  function limpar(texto) {
    let s = String(texto ?? '').split(token).join('<chave>');
    if (chaveUrl !== token) s = s.split(chaveUrl).join('<chave>');
    return s.replace(/\/bot[^/\s]+(\/|(?=\s|$))/g, '/bot<chave>$1');
  }

  function textoErro(onde, e) {
    const causa = e?.cause?.message ? ` (${e.cause.message})` : '';
    return cortar(limpar(`${onde}: ${e?.message || e}${causa}`), MAX_ERRO);
  }

  // 1 chamada da API. Nunca lanca: {ok:true, result} | {ok:false, erro, codigo, http, descricao, incerto?, esperarS?}.
  // T7e2: incerto = true quando o pedido pode ter chegado (redeIncerta, ou HTTP com corpo que nao e o JSON do Telegram,
  // 2xx inclusive); nunca em resposta JSON nem nos erros de REDE_CERTA.
  // T17a: corpo FormData (o envio de arquivo, multipart) vai como esta e SEM Content-Type (o fetch poe o boundary).
  async function chamar(metodo, corpo, prazoMs = PRAZO_MS) {
    let r;
    const multipart = corpo instanceof FormData;
    try {
      r = await fetch(`${API}/bot${token}/${metodo}`, {
        method: 'POST',
        signal: AbortSignal.timeout(prazoMs),
        ...(multipart ? { body: corpo } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo ?? {}) }),
      });
    } catch (e) {
      const falha = { ok: false, rede: true, codigo: 0, http: 0, descricao: '', erro: textoErro(metodo, e) };
      if (redeIncerta(e)) falha.incerto = true;
      return falha;
    }
    const http = Number(r?.status) || 0;
    let j = null;
    try {
      j = JSON.parse(await r.text());
    } catch {
      j = null;
    }
    if (j && j.ok === true) return { ok: true, result: j.result };
    const codigo = Number(j?.error_code) || http;
    const descricao = limpar(j ? String(j.description ?? 'sem descricao') : `resposta ilegivel (HTTP ${http})`);
    const falha = { ok: false, codigo, http, descricao, erro: cortar(`${metodo}: ${descricao}`, MAX_ERRO) };
    if (!(j !== null && typeof j === 'object')) falha.incerto = true; // T7e2: corpo ilegivel (pode ter saido)
    if (codigo === 429) {
      const s = Number(j?.parameters?.retry_after);
      falha.esperarS = Number.isFinite(s) && s > 0 ? s : 1;
    }
    return falha;
  }

  // Falha que sai pra fora: {ok:false, erro, codigo, esperarS?}; codigo = error_code da API ou o HTTP (0 = rede). O
  // drenar do canal-telegram usa o codigo pra separar 400 (recusado) de transporte. T7e2: incerto: true so quando o
  // pedido pode ter chegado (o campo nao vai nos outros casos: o formato de antes fica igual).
  const publico = (f) => {
    const p = { ok: false, erro: f.erro, codigo: f.codigo };
    if (f.esperarS != null) p.esperarS = f.esperarS;
    if (f.incerto === true) p.incerto = true;
    return p;
  };
  const sucesso = (r, formato) => ({ ok: true, messageId: r.result?.message_id, formato });

  // Fila do adaptador: 1 por vez, pelo menos `intervalo` ms entre o inicio de uma e o da seguinte.
  let cauda = Promise.resolve();
  let ultimoInicio = null;
  function naFila(nome, fn) {
    const vez = cauda.then(async () => {
      try {
        if (ultimoInicio != null) {
          const falta = ultimoInicio + intervalo - agora();
          if (falta > 0) await dormir(falta);
        }
        ultimoInicio = agora();
        return await fn();
      } catch (e) {
        return { ok: false, erro: textoErro(nome, e) };
      }
    });
    cauda = vez.then(() => undefined, () => undefined);
    return vez;
  }

  /**
   * Mensagem nova no chat do dono. Rich (sendRichMessage, html) -> 400 = classico (sendMessage parse_mode HTML) ->
   * 400 de novo = texto sem tags. Sem html = comeca no classico. 429 = {ok:false, erro, esperarS} sem tentar o
   * formato seguinte. T7e2: resposta incerta (pode ter chegado) volta na hora, sem tentar o formato seguinte (senao o
   * dono ganha 2 mensagens). Nunca lanca: {ok:true, messageId, formato:'rich'|'classico'|'texto'} |
   * {ok:false, erro, codigo, incerto?, esperarS?}.
   */
  // T29d (PLANO-TELEGRAM.md, "T29d"): `respostaForcada` (true ou o texto de exemplo do campo, ate 64) = reply_markup
  // {force_reply: true, input_field_placeholder?}: o campo de digitacao ja abre respondendo a ela. Junto com botoes = erro.
  async function enviar({ html, classico, botoes, silencioso, responderA, respostaForcada } = {}) {
    const t = botoes == null ? {} : teclado(botoes);
    if (t.erro) return { ok: false, erro: `enviar: ${t.erro}` };
    const forcada = respostaForcada != null && respostaForcada !== false;
    if (forcada && botoes != null) return { ok: false, erro: 'enviar: botoes e resposta forcada juntos' };
    if (forcada) {
      t.markup = { force_reply: true };
      if (typeof respostaForcada === 'string' && respostaForcada.trim()) t.markup.input_field_placeholder = cortar(respostaForcada.trim(), 64);
    }
    const temHtml = typeof html === 'string' && html !== '';
    const temClassico = typeof classico === 'string' && classico !== '';
    if (!temHtml && !temClassico) return { ok: false, erro: 'enviar: sem texto' };
    const citar = responderA ? idMensagem(responderA) : null;
    const extras = {
      disable_notification: silencioso === true,
      reply_markup: t.markup,
      reply_parameters: citar ? { message_id: citar, allow_sending_without_reply: true } : undefined,
    };
    return naFila('enviar', async () => {
      if (temHtml) {
        const r = await chamar('sendRichMessage', { chat_id: chatId, rich_message: { html }, ...extras });
        if (r.ok) return sucesso(r, 'rich');
        if (r.incerto === true || r.codigo !== 400 || !temClassico) return publico(r);
      }
      const r2 = await chamar('sendMessage', { chat_id: chatId, text: classico, parse_mode: 'HTML', ...extras });
      if (r2.ok) return sucesso(r2, 'classico');
      if (r2.incerto === true || r2.codigo !== 400) return publico(r2);
      const r3 = await chamar('sendMessage', { chat_id: chatId, text: semTags(classico), ...extras });
      return r3.ok ? sucesso(r3, 'texto') : publico(r3);
    });
  }

  const resultadoEdicao = (r) => (r.ok || /message is not modified/i.test(r.descricao || '') ? { ok: true } : publico(r));

  /**
   * Edita uma mensagem do bot no formato em que ela saiu ('rich' | 'classico' | 'texto'). "message is not modified" = ok.
   * Sem botoes = a mensagem fica sem botoes. Nunca lanca: {ok:true} | {ok:false, erro, esperarS?}.
   */
  async function editar(messageId, { html, classico, botoes, formato } = {}) {
    const id = idMensagem(messageId);
    if (!id) return { ok: false, erro: 'editar: sem message_id' };
    const t = botoes == null ? {} : teclado(botoes);
    if (t.erro) return { ok: false, erro: `editar: ${t.erro}` };
    let corpo;
    if (formato === 'rich') {
      if (typeof html !== 'string' || !html) return { ok: false, erro: 'editar: sem html' };
      corpo = { chat_id: chatId, message_id: id, rich_message: { html }, reply_markup: t.markup };
    } else if (formato === 'classico' || formato === 'texto') {
      if (typeof classico !== 'string' || !classico) return { ok: false, erro: 'editar: sem classico' };
      corpo = formato === 'classico'
        ? { chat_id: chatId, message_id: id, text: classico, parse_mode: 'HTML', reply_markup: t.markup }
        : { chat_id: chatId, message_id: id, text: semTags(classico), reply_markup: t.markup };
    } else {
      return { ok: false, erro: 'editar: formato invalido' };
    }
    return naFila('editar', async () => resultadoEdicao(await chamar('editMessageText', corpo)));
  }

  /**
   * T7b1a: mensagem nova em TEXTO PURO (o pedido de OK): sendMessage sem parse_mode e sem o semTags, entao `<pid>`,
   * `&amp;` e `*` chegam como estao (o verificar compara o texto que volta com o montado do arquivo). Um formato so:
   * nada de cair pra outro no 400. Na fila. Nunca lanca: {ok:true, messageId} | {ok:false, erro, codigo, incerto?, esperarS?}.
   */
  async function enviarTexto({ texto, botoes, silencioso, responderA } = {}) {
    if (typeof texto !== 'string' || texto === '') return { ok: false, erro: 'enviarTexto: sem texto' };
    const t = botoes == null ? {} : teclado(botoes);
    if (t.erro) return { ok: false, erro: `enviarTexto: ${t.erro}` };
    const citar = responderA ? idMensagem(responderA) : null;
    const corpo = {
      chat_id: chatId,
      text: texto,
      disable_notification: silencioso === true,
      reply_markup: t.markup,
      reply_parameters: citar ? { message_id: citar, allow_sending_without_reply: true } : undefined,
    };
    return naFila('enviarTexto', async () => {
      const r = await chamar('sendMessage', corpo);
      return r.ok ? { ok: true, messageId: r.result?.message_id } : publico(r);
    });
  }

  /**
   * T17a: mensagem de VOZ (sendVoice, multipart) no chat do dono: `audio` = Buffer Ogg/Opus (o falar do lib/voz.mjs),
   * campo `voice` com nome resposta.ogg; `legenda` = caption (cortada em 1024); `responderA` = em cima de qual mensagem;
   * `silencioso` = sem notificacao. Sem tentar de novo (contrato T17 item 4). Na mesma fila, prazo de 60 s. Nunca lanca:
   * {ok:true, messageId} | {ok:false, erro, codigo, incerto?, esperarS?} (a chave nunca no erro).
   */
  async function enviarVoz({ audio, legenda, responderA, silencioso } = {}) {
    if (!Buffer.isBuffer(audio) || audio.length === 0) return { ok: false, erro: 'enviarVoz: sem audio' };
    const citar = responderA ? idMensagem(responderA) : null;
    const corpo = new FormData();
    corpo.append('chat_id', String(chatId));
    corpo.append('voice', new Blob([audio], { type: 'audio/ogg' }), 'resposta.ogg');
    if (typeof legenda === 'string' && legenda !== '') corpo.append('caption', cortar(legenda, MAX_LEGENDA));
    corpo.append('disable_notification', String(silencioso === true));
    if (citar) corpo.append('reply_parameters', JSON.stringify({ message_id: citar, allow_sending_without_reply: true }));
    return naFila('enviarVoz', async () => {
      const r = await chamar('sendVoice', corpo, PRAZO_VOZ_MS);
      return r.ok ? { ok: true, messageId: r.result?.message_id } : publico(r);
    });
  }

  /**
   * T7b1a: edita uma mensagem de texto puro (editMessageText sem parse_mode, texto intacto). Sem botoes = a mensagem
   * fica sem botoes. "message is not modified" = ok. Na fila. Nunca lanca: {ok:true} | {ok:false, erro, codigo, esperarS?}.
   */
  async function editarTexto(messageId, { texto, botoes } = {}) {
    const id = idMensagem(messageId);
    if (!id) return { ok: false, erro: 'editarTexto: sem message_id' };
    if (typeof texto !== 'string' || texto === '') return { ok: false, erro: 'editarTexto: sem texto' };
    const t = botoes == null ? {} : teclado(botoes);
    if (t.erro) return { ok: false, erro: `editarTexto: ${t.erro}` };
    const corpo = { chat_id: chatId, message_id: id, text: texto, reply_markup: t.markup };
    return naFila('editarTexto', async () => resultadoEdicao(await chamar('editMessageText', corpo)));
  }

  /** Troca so os botoes (null = tira todos). Nunca lanca: {ok:true} | {ok:false, erro, esperarS?}. */
  async function editarBotoes(messageId, botoes) {
    const id = idMensagem(messageId);
    if (!id) return { ok: false, erro: 'editarBotoes: sem message_id' };
    const t = botoes == null ? { markup: { inline_keyboard: [] } } : teclado(botoes);
    if (t.erro) return { ok: false, erro: `editarBotoes: ${t.erro}` };
    return naFila('editarBotoes', async () =>
      resultadoEdicao(await chamar('editMessageReplyMarkup', { chat_id: chatId, message_id: id, reply_markup: t.markup })));
  }

  /**
   * Apaga uma mensagem do chat (em chat privado: as do bot e as do dono, ate 48 h). Nunca lanca:
   * {ok:true} | {ok:true, jaSumiu:true} ("not found") | {ok:false, velha:true} ("can't be deleted") | {ok:false, erro, esperarS?}.
   */
  async function apagar(messageId) {
    const id = idMensagem(messageId);
    if (!id) return { ok: false, erro: 'apagar: sem message_id' };
    return naFila('apagar', async () => {
      const r = await chamar('deleteMessage', { chat_id: chatId, message_id: id });
      if (r.ok) return { ok: true };
      if (/message to delete not found/i.test(r.descricao)) return { ok: true, jaSumiu: true };
      if (/message can't be deleted/i.test(r.descricao)) return { ok: false, velha: true };
      return publico(r);
    });
  }

  /** Resposta ao toque de botao (texto curto no topo da tela, ate 200). Nunca lanca: {ok:true} | {ok:false, erro, esperarS?}. */
  async function responderToque(callbackQueryId, texto) {
    const qid = callbackQueryId == null ? '' : String(callbackQueryId);
    if (!qid) return { ok: false, erro: 'responderToque: sem id do toque' };
    const corpo = { callback_query_id: qid };
    if (texto != null && String(texto) !== '') corpo.text = cortar(String(texto), MAX_TOQUE);
    return naFila('responderToque', async () => {
      const r = await chamar('answerCallbackQuery', corpo);
      return r.ok ? { ok: true } : publico(r);
    });
  }

  /**
   * Updates novos (getUpdates, so message e callback_query). Fora da fila; prazo do fetch = esperaS + 15 s.
   * LANCA Error com mensagem limpa em qualquer falha: err.conflito = true no 409 (outro leitor); err.esperarS no 429.
   */
  async function lerAtualizacoes({ offset, esperaS } = {}) {
    const espera = Number.isFinite(esperaS) && esperaS > 0 ? esperaS : 0;
    const r = await chamar('getUpdates', { offset, timeout: espera, allowed_updates: ['message', 'callback_query'] }, (espera + 15) * 1000);
    if (r.ok && Array.isArray(r.result)) return r.result;
    const err = new Error(r.ok ? 'getUpdates: resposta sem lista' : r.erro);
    if (!r.ok && (r.http === 409 || r.codigo === 409)) err.conflito = true;
    if (!r.ok && r.esperarS != null) err.esperarS = r.esperarS;
    throw err;
  }

  /**
   * T7b1a (Desenho 1b): espiada curta do verificar a partir do offset que o PORTEIRO gravou (o `e.tg.offset`): getUpdates
   * com esse offset, timeout 0, limit 100, so message e callback_query. Offset ausente, nao inteiro ou menor que 1 = lanca
   * SEM chamar a API: offset negativo esqueceria updates que o porteiro ainda nao leu. Nunca guarda nem avanca offset
   * (2 chamadas com o mesmo offset = 2 pedidos iguais). Fora da fila. LANCA como o lerAtualizacoes: err.conflito no 409
   * (o porteiro lendo ao mesmo tempo), err.esperarS no 429; mensagem sempre sem a chave.
   */
  async function espiar({ offset } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 1) throw new Error('espiar: offset tem que ser inteiro positivo (o do porteiro)');
    const r = await chamar('getUpdates', { offset, timeout: 0, limit: 100, allowed_updates: ['message', 'callback_query'] }, 15000);
    if (r.ok && Array.isArray(r.result)) return r.result;
    const err = new Error(r.ok ? 'getUpdates: resposta sem lista' : r.erro);
    if (!r.ok && (r.http === 409 || r.codigo === 409)) err.conflito = true;
    if (!r.ok && r.esperarS != null) err.esperarS = r.esperarS;
    throw err;
  }

  /**
   * Baixa um arquivo que o dono mandou (getFile + download) pra destinoSemExtensao + extensao do file_path (cria a
   * pasta). Acima de 20 MB recusa sem baixar. Fora da fila. Nunca lanca: {ok:true, caminho, bytes} | {ok:false, erro}.
   */
  async function baixar(fileId, destinoSemExtensao) {
    try {
      if (typeof destinoSemExtensao !== 'string' || !destinoSemExtensao) return { ok: false, erro: 'baixar: sem destino' };
      const r = await chamar('getFile', { file_id: fileId });
      if (!r.ok) return publico(r);
      const f = r.result || {};
      if (Number(f.file_size) > MAX_ARQUIVO) return { ok: false, erro: 'arquivo maior que 20 MB' };
      if (typeof f.file_path !== 'string' || !f.file_path) return { ok: false, erro: 'getFile: sem file_path' };
      let resp;
      try {
        resp = await fetch(`${API}/file/bot${token}/${f.file_path}`, { method: 'GET', signal: AbortSignal.timeout(PRAZO_DOWNLOAD_MS) });
      } catch (e) {
        return { ok: false, erro: textoErro('download', e) };
      }
      if (!resp.ok) return { ok: false, erro: `download: HTTP ${Number(resp.status) || 0}` };
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > MAX_ARQUIVO) return { ok: false, erro: 'arquivo maior que 20 MB' };
      const caminho = destinoSemExtensao + extname(f.file_path);
      mkdirSync(dirname(caminho), { recursive: true });
      writeFileSync(caminho, buf);
      return { ok: true, caminho, bytes: buf.length };
    } catch (e) {
      return { ok: false, erro: textoErro('baixar', e) };
    }
  }

  /** Menu do bot (setMyCommands) so no chat do dono. Fora da fila. Nunca lanca: {ok:true} | {ok:false, erro, esperarS?}. */
  async function definirComandos(comandos) {
    try {
      const lista = (Array.isArray(comandos) ? comandos : []).map((c) => ({
        command: String(c?.command ?? ''),
        description: String(c?.description ?? ''),
      }));
      const r = await chamar('setMyCommands', { commands: lista, scope: { type: 'chat', chat_id: chatId } });
      return r.ok ? { ok: true } : publico(r);
    } catch (e) {
      return { ok: false, erro: textoErro('setMyCommands', e) };
    }
  }

  /** Quem e o bot (getMe). Fora da fila. Nunca lanca: {ok:true, id, username} | {ok:false, erro, esperarS?}. */
  async function quemSou() {
    try {
      const r = await chamar('getMe', {});
      if (!r.ok) return publico(r);
      return { ok: true, id: r.result?.id, username: r.result?.username };
    } catch (e) {
      return { ok: false, erro: textoErro('getMe', e) };
    }
  }

  return {
    enviar, enviarTexto, enviarVoz, editar, editarTexto, editarBotoes, apagar, responderToque, lerAtualizacoes, espiar, baixar,
    definirComandos, quemSou, limpar,
  };
}
