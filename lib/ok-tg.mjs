// sessoes-wpp — o pedido de OK pelo botao Sim/Nao no PROPRIO chat do bot do Telegram (T7b1a, Desenho 1b).
// Por que existe: o dono aprova acao irreversivel pelo celular, no mesmo chat das abas (caso real: "eu
// quero poder apertar o botao de sim dentro do mesmo chat"). A prova do Sim continua relida no servidor do Telegram: so
// um callback_query que passa no conferirToque conta (quem tocou, onde, de quem e a mensagem, quando, o texto e o
// teclado montados do arquivo do pedido). Arquivo e estado so negam, nunca concedem.
// Funcoes puras (sem rede); o lerConfigOk so le o config.json. Quem le o Telegram e o espiar do telegram.mjs.
// Contrato: PLANO-T7.md, "T7b1a" com as mudancas de "F5 decidida ... Desenho 1b".
// A1b2 (PLANO-ABERTO.md, "A1"): sem bot nem chat padrao; o bot e o chat do dono vem de quem chama (o identTg do porteiro,
// o tgOk do ok-wpp, lidos do config.json). Sem os dois validos, nenhum toque confere e nenhuma "trava" conta.
import fs from 'node:fs';
import path from 'node:path';
import { horaBRT, limparParaWhatsApp, cabecalho } from './formato.mjs';

// Id do Telegram (bot ou chat) valido: inteiro seguro > 0 (a regra do identidadeTelegram da lib/config.mjs)
const idValido = (x) => Number.isSafeInteger(x) && x > 0;
const FOLGA_S = 5; // relogio do PC x do Telegram: a mensagem pode ter date ate 5 s antes do criadoEm
// O alfabeto do codigo do pedido (o ALFABETO do ok-wpp.mjs, sem I, L, O, 0 e 1). Copiado aqui pra este modulo nao
// importar o ok-wpp (que importa este); o teste 61 confere letra por letra contra o de la.
const ALFABETO_COD = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const RE_COD = new RegExp(`^[${ALFABETO_COD}]{6}$`);
const RE_DADOS = new RegExp(`^k:([${ALFABETO_COD}]{6}):([sni])$`);
const LETRA = Object.freeze({ sim: 's', nao: 'n', info: 'i' });
const ACAO_DA_LETRA = Object.freeze({ s: 'sim', n: 'nao', i: 'info' });

// ---------- rotulo do pedido (saiu do ok-wpp.mjs; o ok-wpp reexporta o MESMO objeto) ----------

const junta = (d) => (d && d.length ? d.join(', ') : '');
export const ROTULO = {
  crm: () => 'CRM',
  mensagem: (d) => (junta(d) ? `mensagem pra ${junta(d)}` : 'mensagem'),
  publicacao: () => 'publicação',
  disparo: (d) => (junta(d) ? `disparo pra ${junta(d)}` : 'disparo em massa'),
  pagamento: () => 'pagamento',
  apagar: () => 'apagar',
  outro: () => 'ação',
};
// Rotulos que ja levam os destinatarios no texto: no completo, o "Pra: A, B." so sai nos outros.
const ROTULO_COM_DEST = new Set(['mensagem', 'disparo']);

/** Rotulo do pedido no grupo e no Telegram ("mensagem pra A, B", "publicação"...). Tipo desconhecido = TypeError. */
export function rotuloDoPedido(tipo, destinatarios) {
  if (typeof tipo !== 'string' || !Object.hasOwn(ROTULO, tipo)) throw new TypeError(`tipo desconhecido: ${tipo}`);
  return ROTULO[tipo](destinatarios);
}

/**
 * O que o Sim libera. 2 horas = a janela do OK na trava de disparo do ambiente do dono (janela_ok_minutos 120); sem o
 * ledger dela no config, o disparo sai sem a janela (disparoSemJanela). A5c: o pedir grava o texto no pedido (`libera`).
 */
export const LIBERA = Object.freeze({
  publicacao: '1 publicação em produção',
  disparo: 'o resto do disparo (depois do piloto) por até 2 horas',
  disparoSemJanela: 'o resto do disparo (depois do piloto)',
  demais: 'esta ação, 1 vez',
});
// Os textos aceitos no `libera` do pedido (outro valor = o de antes, pelo tipo)
const TEXTOS_LIBERA = new Set(Object.values(LIBERA));

// ---------- dados do botao ----------

/** 'k:<COD>:s|n|i' (10 bytes). Codigo fora do alfabeto ou acao fora de sim|nao|info = TypeError. */
export function dadosOk(codigo, acao) {
  if (typeof codigo !== 'string' || !RE_COD.test(codigo)) throw new TypeError('dadosOk: codigo invalido');
  if (typeof acao !== 'string' || !Object.hasOwn(LETRA, acao)) throw new TypeError('dadosOk: acao invalida');
  return `k:${codigo}:${LETRA[acao]}`;
}

/** 'k:<COD>:s|n|i' -> {codigo, acao: 'sim'|'nao'|'info'}; qualquer outra coisa (inclusive com espaco) = null. */
export function lerDadosOk(s) {
  if (typeof s !== 'string') return null;
  const m = RE_DADOS.exec(s);
  return m ? { codigo: m[1], acao: ACAO_DA_LETRA[m[2]] } : null;
}

// ---------- texto da mensagem (texto puro: o enviarTexto manda sem parse_mode) ----------

// 1a linha: o cabecalho do grupo sem os asteriscos (o nome ja sai limpo de asterisco e emoji).
const nomeDoPedido = (titulo) => cabecalho(titulo).replace(/\*/g, '');
// 2a linha em diante: o rotulo e a acao INTEIRA, pela mesma limpeza da mensagem do grupo.
const linhaDoPedido = ({ tipo, destinatarios, acao }) =>
  `Pedido de OK (${rotuloDoPedido(tipo, destinatarios)}): ${limparParaWhatsApp(acao)}`;

function botoesOk(codigo, completo) {
  const simNao = [
    { texto: 'Sim', dados: dadosOk(codigo, 'sim'), estilo: 'success' },
    { texto: 'Não', dados: dadosOk(codigo, 'nao'), estilo: 'danger' },
  ];
  return completo ? [simNao] : [simNao, [{ texto: 'Mais informações', dados: dadosOk(codigo, 'info') }]];
}

/**
 * A mensagem do pedido no chat do bot: {texto, botoes} (botoes no formato do telegram.mjs). Compacto (padrao):
 * `ℹ️ <nome>` / `Pedido de OK (<rotulo>): <acao>` / vazia / `Posso? Vale até HH:MM.`, com [[Sim, Não], [Mais
 * informações]]. Completo: as horas, o "Pra:" (so quando o rotulo nao traz os destinatarios), o que o Sim libera e
 * `Posso?`, com [[Sim, Não]]. Tipo ou codigo invalido = TypeError.
 * A5c: o que o Sim libera e o `libera` do pedido quando e um dos textos do LIBERA; sem ele (pedido antigo) ou com outro
 * valor, o de antes pelo tipo. O conferirToque remonta do mesmo pedido: a mensagem e a conferencia batem.
 */
export function montarOkTg({ codigo, titulo, tipo, destinatarios, acao, criadoEm, expiraEm, libera: doPedido, completo = false } = {}) {
  const inteiro = completo === true;
  const cab = nomeDoPedido(titulo);
  const pedido = linhaDoPedido({ tipo, destinatarios, acao });
  const ate = horaBRT(expiraEm);
  let texto;
  if (inteiro) {
    const linhas = [cab, pedido, '', `Pedido às ${horaBRT(criadoEm)}, vale até ${ate}.`];
    if (!ROTULO_COM_DEST.has(tipo) && junta(destinatarios)) linhas.push(`Pra: ${junta(destinatarios)}.`);
    const libera = tipo === 'publicacao' ? LIBERA.publicacao : tipo === 'disparo' ? LIBERA.disparo : LIBERA.demais;
    const oQueLibera = TEXTOS_LIBERA.has(doPedido) ? doPedido : libera; // A5c: o do pedido; sem ele, pelo tipo
    linhas.push(`O Sim libera ${oQueLibera}; o Não cancela o pedido.`, '', 'Posso?');
    texto = linhas.join('\n');
  } else {
    texto = `${cab}\n${pedido}\n\nPosso? Vale até ${ate}.`;
  }
  return { texto, botoes: botoesOk(codigo, inteiro) };
}

/** A mensagem fechada (sem botoes): cabecalho + linha do pedido + a linha de fecho no lugar da pergunta. */
export function montarOkTgFechado({ titulo, tipo, destinatarios, acao, linha } = {}) {
  return { texto: `${nomeDoPedido(titulo)}\n${linhaDoPedido({ tipo, destinatarios, acao })}\n\n${String(linha ?? '')}` };
}

// ---------- o toque ----------

// O texto que volta do Telegram x o montado do arquivo: NFC, \r\n -> \n e sem espaco no fim da linha.
const normalizarTexto = (s) => String(s).normalize('NFC').replace(/\r\n/g, '\n').replace(/[^\S\n]+$/gm, '');
const rotuloIgual = (a, b) => typeof a === 'string' && a.normalize('NFC') === String(b).normalize('NFC');

// T7i: a mensagem SEM teclado = reply_markup ausente (o Telegram tira o campo da mensagem sem botoes), null ou
// {inline_keyboard: []}. Qualquer outra coisa (objeto sem inline_keyboard, linha vazia, lista) e teclado, e tem de ser o
// exato.
const semTeclado = (markup) => markup == null
  || (typeof markup === 'object' && Array.isArray(markup.inline_keyboard) && markup.inline_keyboard.length === 0);

// Mesmas linhas, mesmos botoes na mesma ordem, cada um com o mesmo rotulo e o mesmo dado; nenhum a mais. style e os
// outros campos nao contam.
function tecladoIgual(markup, esperado) {
  const linhas = markup?.inline_keyboard;
  if (!Array.isArray(linhas) || linhas.length !== esperado.length) return false;
  return esperado.every((linhaEsperada, i) => {
    const linha = linhas[i];
    if (!Array.isArray(linha) || linha.length !== linhaEsperada.length) return false;
    return linhaEsperada.every((b, j) => {
      const k = linha[j];
      return Boolean(k) && typeof k === 'object' && rotuloIgual(k.text, b.texto) && k.callback_data === b.dados;
    });
  });
}

/**
 * O toque (update do getUpdates) vale pra ESTE pedido? {valido: true, acao: 'sim'|'nao'|'info', completo, updateId,
 * toqueId, messageId} | {valido: false, motivo} (motivo fixo: nunca traz a acao). Exige: `botId` e `chatDono` validos
 * (inteiro seguro > 0; sem um deles = 'sem bot ou chat do dono', antes de olhar o toque); quem tocou e o dono (from.id =
 * chatDono, nunca bot); no chat privado dele; a mensagem tocada e do bot `botId`; date dela entre o criadoEm - 5 s e
 * o expiraEm (date 0 = mensagem inacessivel); dados = k:<codigo do pedido>:s|n|i; texto = o compacto ou o completo
 * montados do pedido; teclado = o daquela versao, exato, ou nenhum (T7i: o porteiro tira os botoes depois do toque e o
 * servidor pode devolver a mensagem como esta agora); o botao tocado esta no teclado daquela versao. Nunca lanca.
 * Prazo, status e sessao do pedido sao do verificar; aqui so a prova do toque.
 */
export function conferirToque(update, { pedido, botId, chatDono } = {}) {
  const nao = (motivo) => ({ valido: false, motivo });
  try {
    if (!idValido(botId) || !idValido(chatDono)) return nao('sem bot ou chat do dono');
    const q = update?.callback_query;
    if (!q || typeof q !== 'object') return nao('nao e toque de botao');
    if (!Number.isSafeInteger(update.update_id)) return nao('toque sem update_id');
    const de = q.from;
    if (!de || typeof de !== 'object' || de.id !== chatDono || de.is_bot === true) return nao('quem tocou nao e o dono do chat');
    const msg = q.message;
    if (!msg || typeof msg !== 'object') return nao('toque sem a mensagem');
    if (!Number.isSafeInteger(msg.date) || msg.date <= 0) return nao('mensagem inacessivel');
    if (!msg.chat || msg.chat.id !== chatDono || msg.chat.type !== 'private') return nao('toque fora do chat privado do dono');
    if (!msg.from || msg.from.id !== botId) return nao('a mensagem tocada nao e do bot');
    const dados = lerDadosOk(q.data);
    if (!dados) return nao('dados do botao ilegiveis');
    if (!pedido || typeof pedido !== 'object' || typeof pedido.codigo !== 'string' || !RE_COD.test(pedido.codigo)) {
      return nao('pedido ilegivel');
    }
    if (dados.codigo !== pedido.codigo) return nao('toque de outro pedido');
    const criado = typeof pedido.criadoEm === 'string' ? Date.parse(pedido.criadoEm) : Number.NaN;
    const expira = typeof pedido.expiraEm === 'string' ? Date.parse(pedido.expiraEm) : Number.NaN;
    if (!Number.isFinite(criado) || !Number.isFinite(expira)) return nao('pedido ilegivel');
    if (msg.date < Math.floor(criado / 1000) - FOLGA_S || msg.date > Math.ceil(expira / 1000)) {
      return nao('mensagem fora do prazo do pedido');
    }
    let versoes;
    try {
      versoes = [montarOkTg({ ...pedido, completo: false }), montarOkTg({ ...pedido, completo: true })];
    } catch {
      return nao('pedido ilegivel');
    }
    if (typeof msg.text !== 'string') return nao('mensagem sem texto');
    const lido = normalizarTexto(msg.text);
    const i = versoes.findIndex((v) => normalizarTexto(v.texto) === lido);
    if (i < 0) return nao('texto da mensagem nao confere com o pedido');
    const esperado = versoes[i].botoes;
    if (!semTeclado(msg.reply_markup) && !tecladoIgual(msg.reply_markup, esperado)) {
      return nao('botoes da mensagem nao conferem com o pedido');
    }
    if (!esperado.some((linha) => linha.some((b) => b.dados === q.data))) return nao('botao tocado fora do teclado');
    return { valido: true, acao: dados.acao, completo: i === 1, updateId: update.update_id, toqueId: q.id, messageId: msg.message_id };
  } catch {
    return nao('toque ilegivel');
  }
}

// ---------- "trava" no chat ----------

// Frase inteira normalizada (a mesma regra do normalizarResposta do ok-wpp): minusculas, sem acento, sem pontuacao,
// espacos colapsados.
const frase = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

/**
 * Tem "trava" do dono (texto dele no chat dele, o `chatDono`, frase inteira) depois do destravadoEm? Sem `chatDono`
 * valido = false. Sem destravadoEm, ou hora ilegivel = qualquer uma conta (a regra do "trava" no grupo, ok-wpp d2). O
 * date do Telegram e em segundos: a mensagem so fica de fora quando o segundo INTEIRO dela acabou antes do destravadoEm
 * (na duvida, trava). Nunca lanca.
 */
export function travaNoChat(updates, { destravadoEm, chatDono } = {}) {
  if (!Array.isArray(updates) || !idValido(chatDono)) return false;
  const destravado = typeof destravadoEm === 'string' ? Date.parse(destravadoEm) : Number.NaN;
  return updates.some((u) => {
    const m = u?.message;
    if (!m || typeof m !== 'object') return false;
    if (!m.from || m.from.id !== chatDono || m.from.is_bot === true) return false;
    if (!m.chat || m.chat.id !== chatDono) return false;
    if (typeof m.text !== 'string' || frase(m.text) !== 'trava') return false;
    const fimDoSegundo = Number.isSafeInteger(m.date) ? (m.date + 1) * 1000 : Number.NaN;
    return !(Number.isFinite(destravado) && Number.isFinite(fimDoSegundo) && fimDoSegundo <= destravado);
  });
}

// ---------- ligar ----------

/**
 * O OK pelo botao esta ligado? `telegram.ligado === true && telegram.ok.ligado === true` no `<estadoDir>/config.json`.
 * Ausente, ilegivel ou tipo errado = {ligado: false}. So le. O lerConfigTelegram do porteiro nao muda.
 */
export function lerConfigOk(estadoDir) {
  const desligado = { ligado: false };
  if (typeof estadoDir !== 'string' || !estadoDir) return desligado;
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(estadoDir, 'config.json'), 'utf8'));
  } catch {
    return desligado;
  }
  const t = cfg?.telegram;
  if (!t || typeof t !== 'object' || Array.isArray(t)) return desligado;
  const ok = t.ok;
  if (!ok || typeof ok !== 'object' || Array.isArray(ok)) return desligado;
  return { ligado: t.ligado === true && ok.ligado === true };
}
