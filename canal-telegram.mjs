// sessoes-wpp — canal Telegram: o "chamado vivo". Guarda o estado do Telegram dentro do estado do porteiro (e.tg) e a
// fila que poe na tela do dono 1 mensagem por aba, sempre embaixo (pedido do dono: "quando eu responder, a gente
// apaga aquela mensagem la de cima e desce ela... ou editar, ou deletar").
//
// Modelo (PLANO-TELEGRAM.md, "Contratos", T2): cada aba tem 1 chamado = a VERSAO que o dono deve ver + a MENSAGEM que
// esta na tela. As funcoes de evento (aviso, resposta, falaRecebida, entregue, problema, encerrar, calar, abrir, sistema) so
// trocam a versao e poem a aba na fila, sem chamar a API; o drenar reconcilia a tela com a versao na hora de sair. Assim versao
// velha nunca vai pra API, o anterior a apagar e o que esta na tela na hora do envio, e 2 eventos antes de 1 drenar
// saem como 1 mensagem so. O chamado nunca some sem substituto: a antiga so entra no apagar depois que a nova saiu.
// T7f (F8): no Telegram so sai o resultado. Enviando e entregue ficam so no estado (o chamado que
// ele respondeu so perde os botoes); a resposta da central que so repassou encerra o chamado dela calado (calar).
//
// Nada aqui le disco, rede ou process.env: quem fala com o Telegram e o `tg` injetado (criarTelegram do telegram.mjs).
// Nenhuma funcao lanca pra fora, exceto entrada de programacao invalida (TypeError). Log (1 linha): so sessionId,
// estado, messageId, contagem e o erro que o adaptador devolveu; nunca texto do dono, fala, final, frase, titulo nem
// html/classico. O unico texto que o dono le sai do montarChamado/montarSistema (lib/formato-tg.mjs).
import {
  montarChamado, montarChamadoComOk, montarSistema, montarPainel, montarSituacao, lerFinal, lerDadosBotao, novoIdChamado, ICONE_SISTEMA,
  TITULO_SISTEMA, botoesPainel, filtrarPainel, palavraDaBusca, PERGUNTA_BUSCA, EXEMPLO_BUSCA,
} from './lib/formato-tg.mjs';
import { partesCurtas } from './lib/formato.mjs'; // T29b: a pergunta em negrito (a mesma regra do aviso)

const SISTEMA = 'sistema'; // "sessionId" da mensagem viva do sistema (na fila e em mensagens)
const PAINEL = 'painel'; // T9: "sessionId" do painel das abas (na fila e em mensagens)
const BUSCA_TTL_MS = 15 * 60 * 1000; // T29d: a busca sem uso (e a pergunta sem resposta) sai depois disso
const TITULO_PAINEL = 'Painel das abas';
const SITUACAO = 'situacao'; // T10: "sessionId" da situacao de uma aba (o toque no nome dela no painel)
const TITULO_SITUACAO = 'Situação da aba';
const NAO_E_ABA = new Set([SISTEMA, PAINEL, SITUACAO]);
const MIN_MS = 60 * 1000;
const H_MS = 60 * MIN_MS;
const FILA_TTL_MS = 2 * H_MS; // item na fila ha 2 h = perdida (igual ao SAIDA_TTL_MS do porteiro)
const CHAMADO_TTL_MS = 24 * H_MS; // chamado sem mudanca ha 24 h e fora da fila sai (podar)
const MENSAGEM_TTL_MS = 7 * 24 * H_MS; // mensagem do bot guardada ate 7 dias (podar)
const MAX_LINHAS = 10; // linhas guardadas da mensagem do sistema (o montarSistema mostra as 3 ultimas)
// Teto do final guardado na versao = o mesmo corte do formato-tg (o <details> leva ate 12000 code points)
const LIMITE_FINAL = 12000;
const CABECA_FINAL = 4000;
const CAUDA_FINAL = 8000; // a DECISAO fica no fim: a cauda e maior que a cabeca
const MIOLO = '\n(...)\n';
const MAX_ERRO_LOG = 160;
const LOG_A_CADA = 20; // falha de transporte: log na 1a e a cada 20 (igual ao drenar do WhatsApp)
const MAX_PASSOS = 200; // rede de seguranca: 1 drenar para em 200 acoes (~4 min a 1,1 s cada); o resto sai no proximo
// T7e2: envio incerto (pode ter chegado). Recuo em memoria antes do reenvio: 30 s, 1, 2 e 4 min (teto); zera na 1a
// chamada ok. Os ids que apareceram no chat entre o maior id conhecido antes do envio e a mensagem do reenvio vao pra
// sonda (so ligada com `sondar`); mais de 20 ou sem base (desde < 1) = nao sonda nenhum.
const RECUO_MS = [30 * 1000, MIN_MS, 2 * MIN_MS, 4 * MIN_MS];
const MAX_SONDA = 20;
const MAX_IDS_DO_DONO = 300; // anel das mensagens do dono (nunca vao pra sonda)
// T29b: a mensagem que nao espera nada dele sai na interacao dele se esta na tela ha 60 s ou mais; com 48 h a API nao apaga
const VISTA_MS = 60 * 1000;
const APAGA_ATE_MS = 48 * H_MS;

// T7f (F8): 'calado' = o chamado da aba que so repassou a fala (a central) encerrando sem mensagem: so apaga o que era dele
const CALADO = 'calado';
// T26b1: 'ok' = o chamado que so existe pra mostrar o pedido de OK (a aba nao tinha chamado): so o cabecalho + o bloco
const ESTADOS = new Set(['aviso', 'resposta', 'enviando', 'entregue', 'contexto', 'problema', 'encerrado', CALADO, 'ok']);
// T7k: ids de fala (o `esperar` do calar, o `esperando` relido do disco e o `liberar` da resposta) = texto nao vazio, sem
// repetir; o resto ignorado
const idsDeFala = (lista) => (Array.isArray(lista) ? [...new Set(lista.filter((x) => typeof x === 'string' && x !== ''))] : []);
const NOVA_COM_NOTIFICACAO = new Set(['aviso', 'resposta', 'problema', 'ok']);
// T26b1 (PLANO-TELEGRAM.md, "T26b1"): aviso/resposta que chega ate 60 s depois do OK aparecer (aberto, sem toque, na
// tela) entra na MESMA mensagem por edicao; depois disso, mensagem nova
const OK_JUNTA_MS = 60 * 1000;
// T26b2: o codigo do pedido de OK (o ALFABETO_COD do lib/ok-tg.mjs, sem I, L, O, 0 e 1; copiado pra o canal nao ler
// o ok-tg) e o intervalo minimo entre 2 voltas do okSemTela na mesma aba
const RE_COD_OK = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
const OK_VOLTA_MS = 60 * 1000;
const NOVA_SILENCIOSA = new Set(['enviando', 'contexto']);
// T7f (F8, pedido do dono: "eu só quero direto o resultado que eu pedi"): a fala dele nao poe nada novo na tela;
// enviando e entregue ficam so no estado (o chamado que ele respondeu, na tela com botoes, so perde os botoes)
const SO_NO_ESTADO = new Set(['enviando', 'entregue']);
const COM_BOTOES = new Set(['aviso', 'resposta']); // os unicos com chamadoId e opcoes
const FORMATOS = new Set(['rich', 'classico', 'texto']);

// ---------- utilitarios ----------

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const tem = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const msDeIso = (v) => (typeof v === 'string' && v ? Date.parse(v) : NaN);

/** ISO de um instante em ms; instante invalido = null (nunca lanca). */
function isoDe(ms) {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** message_id valido: inteiro != 0 (o ensaio usa negativos) ou string de digitos (chave de objeto) -> numero | null. */
function idMensagem(v) {
  if (Number.isSafeInteger(v) && v !== 0) return v;
  if (typeof v === 'string' && /^-?\d{1,15}$/.test(v) && Number(v) !== 0) return Number(v);
  return null;
}

const formatoDe = (f) => (FORMATOS.has(f) ? f : 'rich');

function tirar(lista, x) {
  const i = lista.indexOf(x);
  if (i >= 0) lista.splice(i, 1);
}

function cortarFinal(texto) {
  const cps = Array.from(texto);
  if (cps.length <= LIMITE_FINAL) return texto;
  return `${cps.slice(0, CABECA_FINAL).join('')}${MIOLO}${cps.slice(-CAUDA_FINAL).join('')}`;
}

// Erro do adaptador em 1 linha curta (o telegram.mjs ja tira a chave do bot).
const erroCurto = (r) => String(r?.erro ?? 'sem detalhe').replace(/\s+/g, ' ').trim().slice(0, MAX_ERRO_LOG);
const nomeErro = (err) => String(err?.name || 'erro').slice(0, 40);
// 429 do Telegram: o adaptador devolve codigo 429 e esperarS
const ehPausa = (r) => r?.ok !== true && (r?.codigo === 429 || r?.esperarS != null);

// ---------- estado (e.tg) ----------

const saudeNova = () => ({
  leituraOkEm: null,
  leituraFalhaDesde: null,
  envioOkEm: null,
  envioFalhaDesde: null,
  envioUltimaFalhaEm: null,
  quebrado: false,
  causaLeitura: null,
  causaEnvio: null,
  avisoEm: null,
  voltouPendente: null,
});

// T7d1a (F1): citar = a mensagem do dono que a proxima mensagem nova do sistema responde (reply) | null
const sistemaNovo = () => ({ linhas: [], versaoId: 0, descer: false, notificar: false, citar: null, mensagem: null, apagar: [] });
// T9: o painel das abas (foto do momento): dados = o que o porteiro mandou montar | null; citar = a mensagem do dono
const painelNovo = () => ({ dados: null, versaoId: 0, descer: false, citar: null, mensagem: null, apagar: [] });
// T10: a situacao de 1 aba (o toque no nome dela no painel): o mesmo jeito do painel + aba = o sessionId dela | null.
// T10c: chamadoId = o id dos botoes dela (novo a cada situacao) | null; completo = aberta pelo "Mais informações";
// apagarJa (so quando tem) = a mensagem tocada, que sai sem substituta.
const situacaoNova = () => ({
  aba: null, dados: null, chamadoId: null, completo: false, versaoId: 0, descer: false, citar: null, mensagem: null, apagar: [],
});
const RE_ID_CHAMADO = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/; // o mesmo formato do novoIdChamado
// sessionId de aba legivel (texto nao vazio, fora dos nomes reservados)
const ehAba = (sid) => typeof sid === 'string' && sid !== '' && !NAO_E_ABA.has(sid) && sid !== '__proto__';

/** Estado do Telegram novo (e.tg). Quem cria e completa o e.tg e este modulo; o porteiro so guarda. */
export function tgNovo() {
  return {
    offset: null,
    vistos: [],
    seq: 0,
    chamados: {},
    mensagens: {},
    saida: [],
    sistema: sistemaNovo(),
    painel: painelNovo(),
    situacao: situacaoNova(),
    recebidas: {},
    audios: {},
    midiaPendente: [],
    idsDoDono: [], // T7e2: message_id das mensagens do dono que o porteiro leu (anel de 300; nunca vao pra sonda)
    saude: saudeNova(),
  };
}

// T7e2: idsDoDono do disco -> so ids validos (> 0), sem repetir (fica a 1a vez), os 300 ultimos.
function completarIdsDoDono(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const vistos = new Set();
  for (const x of v) {
    if (!(Number.isSafeInteger(x) && x > 0) || vistos.has(x)) continue;
    vistos.add(x);
    out.push(x);
  }
  return out.length > MAX_IDS_DO_DONO ? out.slice(-MAX_IDS_DO_DONO) : out;
}

// T23a: o `limpar` do disco -> so {messageId, voz: true} | {messageId, dono: true} com id valido, sem repetir id (fica a
// 1a vez); entrada torta (sem objeto, id invalido, nenhuma ou as duas marcas) sai.
function completarLimpar(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const a of v) {
    if (!ehObjeto(a) || (a.voz === true) === (a.dono === true)) continue;
    const id = idMensagem(a.messageId);
    if (id == null || out.some((b) => b.messageId === id)) continue;
    out.push(a.voz === true ? { messageId: id, voz: true } : { messageId: id, dono: true });
  }
  return out;
}

function completarSistema(v) {
  const s = sistemaNovo();
  if (!ehObjeto(v)) return s;
  if (Array.isArray(v.linhas)) s.linhas = v.linhas;
  if (Number.isSafeInteger(v.versaoId) && v.versaoId >= 0) s.versaoId = v.versaoId;
  s.descer = v.descer === true;
  s.notificar = v.notificar === true;
  s.citar = idMensagem(v.citar);
  if (s.citar != null && v.citarFica === true) s.citarFica = true; // T30: so existe com o citar
  if (Number.isSafeInteger(v.semTela)) s.semTela = v.semTela; // T29b: a versao cuja mensagem saiu do chat (em dia sem tela)
  if (ehObjeto(v.mensagem)) s.mensagem = v.mensagem;
  if (Array.isArray(v.apagar)) s.apagar = v.apagar;
  const limpar = completarLimpar(v.limpar); // T23a: so existe com item
  if (limpar.length) s.limpar = limpar;
  return s;
}

// T9: o painel campo a campo (campo torto = o padrao).
function completarPainel(v) {
  const p = painelNovo();
  if (!ehObjeto(v)) return p;
  if (ehObjeto(v.dados)) p.dados = v.dados;
  if (Number.isSafeInteger(v.versaoId) && v.versaoId >= 0) p.versaoId = v.versaoId;
  p.descer = v.descer === true;
  p.citar = idMensagem(v.citar);
  if (ehObjeto(v.mensagem)) p.mensagem = v.mensagem;
  if (Array.isArray(v.apagar)) p.apagar = v.apagar;
  const limpar = completarLimpar(v.limpar); // T23a: so existe com item (a situacao herda daqui)
  if (limpar.length) p.limpar = limpar;
  // T29d: a busca ({palavra, em}), a pergunta ({messageId | null, em}) e as perguntas a apagar; torto = sem
  if (ehObjeto(v.busca) && palavraDaBusca(v.busca.palavra) && typeof v.busca.em === 'string') p.busca = { palavra: palavraDaBusca(v.busca.palavra), em: v.busca.em };
  if (ehObjeto(v.pergunta) && typeof v.pergunta.em === 'string') p.pergunta = { messageId: idMensagem(v.pergunta.messageId), em: v.pergunta.em };
  const perguntas = Array.isArray(v.apagarPergunta) ? v.apagarPergunta.map(idMensagem).filter((x) => x != null) : [];
  if (perguntas.length) p.apagarPergunta = perguntas;
  return p;
}

// T10: a situacao campo a campo (campo torto = o padrao; aba que nao e sessionId de aba = null).
function completarSituacao(v) {
  const s = situacaoNova();
  if (!ehObjeto(v)) return s;
  const { busca, pergunta, apagarPergunta, ...doPainel } = completarPainel(v); // T29d: a busca e so do painel
  const out = { ...s, ...doPainel, aba: ehAba(v.aba) ? v.aba : null };
  if (typeof v.chamadoId === 'string' && RE_ID_CHAMADO.test(v.chamadoId)) out.chamadoId = v.chamadoId; // T10c
  out.completo = v.completo === true;
  const ja = Array.isArray(v.apagarJa) ? v.apagarJa.map(idMensagem).filter((x) => x != null) : [];
  if (ja.length) out.apagarJa = ja;
  const toque = Array.isArray(v.apagarToque) ? v.apagarToque.filter((x) => Number.isSafeInteger(x) && x > 0) : []; // T12
  if (toque.length) out.apagarToque = toque;
  // T26d (regra 3): a situacao substituida que ficou como mensagem da aba perde os botoes no proximo drenar
  const semBotoes = Array.isArray(v.tirarBotoes) ? v.tirarBotoes.map(idMensagem).filter((x) => x != null) : [];
  if (semBotoes.length) out.tirarBotoes = semBotoes;
  return out;
}

// T26d: o encerrar guardado com o OK aberto (motivo 'pc' | 'whatsapp'; hora texto ou null) | false (torto)
const encerrarDepoisValido = (v) => ehObjeto(v) && (v.motivo === 'pc' || v.motivo === 'whatsapp') && (v.hora === null || typeof v.hora === 'string');

// Saude: hora (ISO) ou null em cada campo; quebrado so true de verdade.
function completarSaude(v) {
  const s = saudeNova();
  if (!ehObjeto(v)) return s;
  for (const k of Object.keys(s)) if (k !== 'quebrado' && typeof v[k] === 'string') s[k] = v[k];
  s.quebrado = v.quebrado === true;
  return s;
}

// Maior id ja usado no estado (versoes, telas e ids negativos do ensaio). O seq nunca fica abaixo dele: senao uma versao
// nova podia ganhar o id da versao que ja esta na tela e o drenar acharia a tela em dia.
function maiorId(t) {
  let maior = 0;
  const ver = (n) => {
    if (Number.isSafeInteger(n) && Math.abs(n) > maior) maior = Math.abs(n);
  };
  const verTela = (m) => {
    if (!ehObjeto(m)) return;
    ver(m.versaoId);
    if (m.messageId < 0) ver(m.messageId);
  };
  for (const c of Object.values(t.chamados)) {
    if (!ehObjeto(c)) continue;
    if (ehObjeto(c.versao)) ver(c.versao.id);
    verTela(c.mensagem);
    if (ehObjeto(c.ok)) { // T26b2: as versoes que o OK guarda
      ver(c.ok.versaoId);
      if (ehObjeto(c.ok.antes)) ver(c.ok.antes.versaoId);
      if (ehObjeto(c.ok.tela)) ver(c.ok.tela.id);
    }
  }
  ver(t.sistema.versaoId);
  verTela(t.sistema.mensagem);
  ver(t.painel.versaoId);
  verTela(t.painel.mensagem);
  ver(t.situacao.versaoId);
  verTela(t.situacao.mensagem);
  for (const k of Object.keys(t.mensagens)) if (Number(k) < 0) ver(Number(k));
  return maior;
}

// T26b2: o c.ok lido do disco. Torto (cod fora do alfabeto, bloco sem os 2 textos, campo do contrato com tipo errado) =
// false (o chamado perde o c.ok). Os internos tortos saem sozinhos: versaoId (inteiro seguro), antes ({versaoId,
// descer}) e tela (a versao que a tela do OK mostrava; so no 'manter').
function completarOk(ok) {
  const textoOuNulo = (v) => v === null || typeof v === 'string';
  const parte = (b) => ehObjeto(b) && typeof b.texto === 'string' && b.texto !== '' && (b.botoes == null || Array.isArray(b.botoes));
  if (!ehObjeto(ok) || typeof ok.cod !== 'string' || !RE_COD_OK.test(ok.cod)) return false;
  if (!ehObjeto(ok.bloco) || !parte(ok.bloco.compacto) || !parte(ok.bloco.completo)) return false;
  if (typeof ok.completo !== 'boolean' || typeof ok.notificar !== 'boolean' || typeof ok.em !== 'string') return false;
  if (!textoOuNulo(ok.fechado) || !textoOuNulo(ok.naTelaEm)) return false;
  if (!(ok.toque === null || (ehObjeto(ok.toque) && (ok.toque.acao === 'sim' || ok.toque.acao === 'nao') && typeof ok.toque.em === 'string'))) return false;
  if (ok.versaoId !== undefined && !Number.isSafeInteger(ok.versaoId)) delete ok.versaoId;
  if (ok.antes !== undefined && !(ehObjeto(ok.antes) && Number.isSafeInteger(ok.antes.versaoId) && typeof ok.antes.descer === 'boolean')) delete ok.antes;
  if (ok.tela !== undefined && !(ehObjeto(ok.tela) && ESTADOS.has(ok.tela.estado) && Number.isSafeInteger(ok.tela.id))) delete ok.tela;
  // T28: o fechado de vencido (a linha em negrito, o botao e a 2a linha); torto sai sozinho
  if (ok.forte !== undefined && typeof ok.forte !== 'string') delete ok.forte;
  if (ok.botoesFechado !== undefined && !Array.isArray(ok.botoesFechado)) delete ok.botoesFechado;
  if (ok.depois !== undefined && typeof ok.depois !== 'string') delete ok.depois;
  return true;
}

/**
 * Completa o e.tg lido do disco. Campo faltando ou do tipo errado = valor do tgNovo() (mesmo jeito do completarEstado
 * do porteiro); sistema, painel (T9), situacao (T10) e saude campo a campo; bruto que nao e objeto = tgNovo(); campo desconhecido sai.
 */
export function completarTg(bruto) {
  const base = tgNovo();
  if (!ehObjeto(bruto)) return base;
  const t = { ...base };
  for (const k of Object.keys(base)) {
    const v = bruto[k];
    if (v === undefined) continue;
    const b = base[k];
    if (Array.isArray(b) ? Array.isArray(v) : ehObjeto(b) ? ehObjeto(v) : true) t[k] = v;
  }
  if (!(t.offset === null || Number.isSafeInteger(t.offset))) t.offset = null;
  if (!(Number.isSafeInteger(t.seq) && t.seq >= 0)) t.seq = 0;
  t.sistema = completarSistema(bruto.sistema);
  t.painel = completarPainel(bruto.painel);
  t.situacao = completarSituacao(bruto.situacao);
  t.saude = completarSaude(bruto.saude);
  t.idsDoDono = completarIdsDoDono(bruto.idsDoDono);
  for (const c of Object.values(t.chamados)) {
    if (!ehObjeto(c)) continue;
    if (c.limpar !== undefined) { // T23a: o limpar de cada chamado so com entrada boa; vazio some
      const limpar = completarLimpar(c.limpar);
      if (limpar.length) c.limpar = limpar;
      else delete c.limpar;
    }
    if (c.ok !== undefined && !completarOk(c.ok)) delete c.ok; // T26b2: o OK torto sai (o resto do chamado fica)
    if (ehObjeto(c.mensagem) && c.mensagem.ok !== undefined && typeof c.mensagem.ok !== 'string') delete c.mensagem.ok;
    if (c.naSituacao !== undefined && !Number.isSafeInteger(c.naSituacao)) delete c.naSituacao; // T26d (regra 1)
    if (c.encerrarDepois !== undefined && !encerrarDepoisValido(c.encerrarDepois)) delete c.encerrarDepois; // T26d
  }
  t.seq = Math.max(t.seq, maiorId(t));
  return t;
}

// ---------- canal ----------

/**
 * Canal do Telegram sobre o estado do porteiro (todas as funcoes operam em e.tg).
 * tg = o objeto do criarTelegram (enviar, editar e apagar; editarBotoes so na sonda, opcional); ensaio = nenhuma
 * chamada ao tg, cada acao vira registrarEnsaio(...) e da certo (messageId negativo); rand vai pro novoIdChamado.
 * T7e2: `sondar` (padrao false = DESLIGADA ate a medida do principal) = depois de um envio incerto, o reenvio ok poe os
 * ids desconhecidos no apagar como {sondar: true} e cada um so e apagado se o editarBotoes(id, null) provar que e do
 * bot. Desligada: o reenvio so loga os ids, e {sondar: true} que volte do disco sai da lista sem chamar a API.
 * A1 (PLANO-ABERTO.md): `chatId` = o chat do dono (telegram.chatId do config.json); no normalizarUpdate so passam
 * mensagem e toque dele. Ausente ou invalido (nao inteiro seguro > 0) = todo update recusado, sem lancar.
 * T22b: `ehCentral(sessionId, titulo)` (opcional; o porteiro passa) = true no chamado da central, que sai com o titulo da
 * mensagem do sistema ("🎛️ Controle de Sessões"), no movido tambem. Sem ele, ou se lancar, nenhum chamado e da central.
 * T23a (PLANO-TELEGRAM.md, "T23"): `resolvidas` = 'apagar' (o padrao) | 'manter'; outro valor = TypeError. No 'apagar', a
 * conversa resolvida (o robo apagou a ultima mensagem dele, que nao e voz, em cima da fala X do dono, X no anel) leva
 * junto as vozes em cima de X e o X (lista `limpar` do alvo). No 'manter' nao ha essa limpeza.
 * T23b: no 'manter' nada da conversa e apagado: onde o robo apagaria uma mensagem dele (a tela tocada, a antiga depois
 * da versao nova, o calado e as sobras) ela so perde os botoes e fica no chat (`fica: true` no registro; nunca "movido").
 * Iguais nos 2 modos: o /start do toque no painel (apagado), a duplicata provada pela sonda (apagada) e as edicoes.
 */
export function criarCanalTelegram({ tg, chatId, log, agora = Date.now, ensaio = false, registrarEnsaio, rand, sondar = false, ehCentral, resolvidas = 'apagar' } = {}) {
  const emEnsaio = Boolean(ensaio);
  const sondaLigada = sondar === true;
  const chatDono = Number.isSafeInteger(chatId) && chatId > 0 ? chatId : null; // A1: null = todo update recusado
  if (emEnsaio) {
    if (typeof registrarEnsaio !== 'function') throw new TypeError('criarCanalTelegram: ensaio sem registrarEnsaio');
  } else if (!tg || typeof tg.enviar !== 'function' || typeof tg.editar !== 'function' || typeof tg.apagar !== 'function') {
    throw new TypeError('criarCanalTelegram: sem o adaptador do Telegram (tg)');
  }
  if (typeof agora !== 'function') throw new TypeError('criarCanalTelegram: agora invalido');
  if (log != null && typeof log !== 'function') throw new TypeError('criarCanalTelegram: log invalido');
  if (rand != null && typeof rand.getRandomValues !== 'function') throw new TypeError('criarCanalTelegram: rand invalido');
  if (ehCentral != null && typeof ehCentral !== 'function') throw new TypeError('criarCanalTelegram: ehCentral invalido');
  if (resolvidas !== 'apagar' && resolvidas !== 'manter') throw new TypeError('criarCanalTelegram: resolvidas invalido');
  // T29a: os 2 mudam na hora pelo definirResolvidas (o /modo do menu do bot)
  let limpaResolvidas = resolvidas === 'apagar'; // T23a
  let mantemResolvidas = resolvidas === 'manter'; // T23b: a mensagem do robo so perde os botoes (nada e apagado)

  let pausaAte = 0; // 429: nada sai antes disso (em memoria, como a pausa do rate_limit do WhatsApp)
  let drenando = false; // 1 drenar por vez: o que chegar durante outro volta na hora (o que roda esvazia a fila toda)
  // T7e2 (so em memoria): recuo depois de envio incerto (nada sai antes de recuoAte; recuoN = incertos seguidos), o
  // aoMudar do drenar em curso e se o passo atual teve chamada ok (o drenar chama o aoMudar depois do passo)
  let recuoAte = 0;
  let recuoN = 0;
  let aoMudarAtual = null;
  let okNoPasso = false;
  // T7b2a (so em memoria): os message_id de fora do canal no drenar em curso (as mensagens de pedido de OK que o porteiro
  // manda pelo mesmo bot): contam como conhecidos e nunca sao sondados nem apagados
  let idsDeForaAtual = new Set();
  // T7b2a (revisao, item 4; so em memoria): as janelas {desde, ate} de pedido de OK com envio incerto no drenar em curso
  // (a mensagem do pedido pode ter chegado sem o id): id desconhecido em (desde, ate), ou acima do desde com ate null, e de
  // fora (nunca vai pra sonda nem e apagado por ela)
  let janelasDeForaAtual = [];
  // T26b2 (so em memoria): sessionId -> ms da ultima volta do okSemTela (no maximo 1 por minuto por aba)
  const voltasDoOk = new Map();

  const agoraIso = () => isoDe(agora());

  function logar(msg) {
    if (!log) return;
    try {
      log(`telegram ${msg}`);
    } catch {
      /* log nunca derruba o canal */
    }
  }

  function tgDe(e) {
    const t = ehObjeto(e) ? e.tg : null;
    if (
      !ehObjeto(t) || !ehObjeto(t.chamados) || !ehObjeto(t.mensagens) || !Array.isArray(t.saida) || !ehObjeto(t.saude)
      || !ehObjeto(t.sistema) || !Array.isArray(t.sistema.linhas) || !Array.isArray(t.sistema.apagar)
      || !Number.isSafeInteger(t.seq)
    ) {
      throw new TypeError('canal-telegram: e.tg ausente ou incompleto (use tgNovo/completarTg)');
    }
    // T9: estado de antes do painel (ou painel torto) completa na hora, sem lancar
    if (!ehObjeto(t.painel) || !Array.isArray(t.painel.apagar) || !Number.isSafeInteger(t.painel.versaoId)) {
      t.painel = completarPainel(t.painel);
    }
    // T10: idem a situacao
    if (!ehObjeto(t.situacao) || !Array.isArray(t.situacao.apagar) || !Number.isSafeInteger(t.situacao.versaoId)) {
      t.situacao = completarSituacao(t.situacao);
    }
    return t;
  }

  function sessao(sid, onde) {
    if (typeof sid !== 'string' || !sid || NAO_E_ABA.has(sid) || sid === '__proto__') throw new TypeError(`${onde}: sessionId invalido`);
    return sid;
  }

  // Chamado legivel da aba (versao com id e estado conhecidos) ou null. Conserta no lugar o que o drenar precisa.
  function chamadoDe(t, sid) {
    if (!tem(t.chamados, sid)) return null;
    const c = t.chamados[sid];
    if (!ehObjeto(c) || !ehObjeto(c.versao) || !ESTADOS.has(c.versao.estado) || !Number.isSafeInteger(c.versao.id)) return null;
    if (!Array.isArray(c.apagar)) c.apagar = [];
    if (c.mensagem !== null && !(ehObjeto(c.mensagem) && idMensagem(c.mensagem.messageId) != null)) c.mensagem = null;
    if (typeof c.descer !== 'boolean') c.descer = c.descer === true;
    if (c.esperando !== undefined) { // T7k: lista de texto nao vazio (sem repetir); outra coisa some
      const falas = idsDeFala(c.esperando);
      if (falas.length) c.esperando = falas;
      else delete c.esperando;
    }
    return c;
  }

  function enfileirar(t, sid) {
    if (!t.saida.some((i) => ehObjeto(i) && i.sessionId === sid)) t.saida.push({ sessionId: sid, entrouEm: agoraIso(), falhas: 0 });
  }

  function versaoNova(t, estado, v) {
    const versao = {
      id: ++t.seq,
      estado,
      titulo: v.titulo ?? null,
      hora: v.hora ?? null,
      horaEntrega: v.horaEntrega ?? null,
      final: typeof v.final === 'string' ? v.final : '',
      fala: v.fala ?? null,
      audio: v.audio === true,
      frase: v.frase ?? null,
      motivo: v.motivo ?? null,
      opcoes: Array.isArray(v.opcoes) ? v.opcoes : [],
      chamadoId: v.chamadoId ?? null,
      nome: typeof v.nome === 'string' && v.nome ? v.nome : null, // T5b: o name do registro da aba (achar a aberta com ele)
      completo: v.completo === true, // T5a: resposta a uma fala que pediu detalhe = inteira e aberta
      citar: idMensagem(v.citar), // T7d1a (F1): mensagem do dono que esta versao responde (sai em reply) | null
    };
    // T7k: as falas repassadas que esta resposta responde (so existe com item; some quando a versao fica na tela: soltar)
    const liberar = idsDeFala(v.liberar);
    if (liberar.length) versao.liberar = liberar;
    return versao;
  }

  // T3b (item 4): mensagens do bot dessa aba que ficaram no chat sem chamado (chamado podado com 24 h, ou tirado no
  // encerrar): as de `mensagens` com o mesmo sessionId e sem `movido`, no formato de cada uma. O chamado novo apaga
  // (ou move, com 48 h) depois que a mensagem nova dele sair. T17b: a resposta em voz (`voz: true`) nunca entra (fica no
  // chat como o audio dele).
  // T23b: o registro com `fica: true` (ficou no chat sem os botoes, no 'manter') tambem nunca entra, nos 2 modos.
  function sobrasDaAba(t, sid) {
    const out = [];
    for (const [k, m] of Object.entries(t.mensagens)) {
      const id = idMensagem(k);
      if (id == null || !ehObjeto(m) || m.sessionId !== sid || m.movido === true || m.voz === true) continue;
      if (m.fica === true) continue; // T23b
      out.push({ messageId: id, doBot: true, formato: formatoDe(m.formato) });
    }
    return out;
  }

  // Troca a versao da aba (cria o chamado se nao tem) e poe a aba na fila. Versao que pede mensagem nova liga o descer
  // (so desliga quando uma mensagem nova da aba sai, ou no encerrar de versao que nunca chegou na tela). T7f (F8):
  // enviando e entregue nao pedem mensagem nova.
  function trocar(t, sid, versao) {
    let c = chamadoDe(t, sid);
    if (!c) {
      const sobras = sobrasDaAba(t, sid);
      c = { versao: null, descer: false, mensagem: null, apagar: sobras, mudouEm: null };
      t.chamados[sid] = c;
      if (sobras.length) logar(`${sid}: chamado novo; ${sobras.length} mensagem(ns) antiga(s) da aba no chat vao pro apagar`);
    }
    const desce = !SO_NO_ESTADO.has(versao.estado) && (NOVA_COM_NOTIFICACAO.has(versao.estado) || NOVA_SILENCIOSA.has(versao.estado));
    // T26b2 (so no 'manter'): a versao que a tela do OK mostra fica guardada quando a nova vai descer (o fecho edita a
    // tela antiga com a parte dela e o bloco fechado: passoDoAlvo)
    if (mantemResolvidas && desce && c.versao && c.descer !== true && ehObjeto(c.ok) && okNaTelaDe(c)) c.ok.tela = c.versao;
    c.versao = versao;
    delete c.esperando; // T7k: versao nova (ex.: fala nova pra central) = o calado deixa de esperar
    if (desce) c.descer = true;
    if (desce) cancelarSituacaoPendente(t, sid); // T26d (regra 2): a situacao da aba ainda na fila nao sai
    c.mudouEm = agoraIso();
    enfileirar(t, sid);
    return c;
  }

  // ---------- T26d: a situacao conta como a mensagem da aba (PLANO-TELEGRAM.md, "T26d") ----------
  // Regra 1: a situacao da aba X saiu e o chamado de X tem tela (sem mensagem nova pendente, sem OK aberto, fora do
  // calado): a tela vai pro comeco do apagar com `manterConversa` (no 'manter' so perde os botoes) e o chamado fica "em
  // dia" sem tela naquela versao (`c.naSituacao` = o id da versao; o drenar nao o manda de novo). Regra 2: a mensagem
  // nova do chamado de X tira a situacao de X (e a da fila e cancelada no evento). Regra 3: a situacao de X substituida
  // pela de Y, com X sem chamado com tela, perde os botoes e vira mensagem da aba X (`exSituacao`), que sai depois da
  // proxima mensagem nova de X (chamado ou situacao).

  // O chamado de `sid` cuja tela sai pela situacao (regra 1) | null
  function chamadoQueSaiPelaSituacao(t, sid) {
    if (!ehAba(sid)) return null;
    const c = chamadoDe(t, sid);
    if (!c || c.mensagem === null || c.descer === true || okAberto(c) || c.versao.estado === CALADO) return null;
    return c;
  }

  // O chamado esta em dia sem tela porque a situacao da aba e a mensagem dela (regra 1)
  const emDiaPelaSituacao = (c) => c.mensagem === null && c.descer !== true && Number.isSafeInteger(c.naSituacao) && c.naSituacao === c.versao.id;

  function esvaziarSituacao(s) {
    s.aba = null;
    s.dados = null;
    s.completo = false;
    s.descer = false;
    s.citar = null;
  }

  // Regra 1, depois que a situacao da aba `sid` saiu
  function telaSaiPelaSituacao(t, sid) {
    const c = chamadoQueSaiPelaSituacao(t, sid);
    if (!c) return;
    const id = c.mensagem.messageId;
    if (ehObjeto(c.ok)) { // o OK fechado sai com a tela
      delete c.ok;
      if (c.versao.estado === 'ok') { // o chamado so existia pro OK: sai como o calado
        okSaiComoCalado(t, sid, c);
        logar(`${sid}: a situacao saiu; a tela ${id} do OK fechado vai pro apagar e o chamado sai`);
        return;
      }
    }
    semTirarBotoes(c, id);
    c.apagar.unshift({ messageId: id, doBot: true, formato: formatoDe(c.mensagem.formato), manterConversa: true });
    c.mensagem = null;
    c.naSituacao = c.versao.id;
    c.mudouEm = agoraIso();
    enfileirar(t, sid);
    logar(`${sid} ${c.versao.estado}: a situacao saiu; a tela ${id} vai pro apagar (o chamado fica em dia sem tela)`);
  }

  // Regra 3: a situacao `antiga` (na tela) foi substituida pela da aba `nova` (null = cancelada). A aba dela sem chamado
  // com tela = ela fica no chat: perde os botoes (tirarBotoes da situacao) e o registro passa pra aba (`exSituacao`; no
  // 'manter', `fica: true`) -> true. Senao false (ela sai como hoje).
  function situacaoViraDaAba(t, s, antiga, nova) {
    const id = idMensagem(antiga.messageId);
    const reg = id == null ? null : t.mensagens[id];
    if (!ehObjeto(reg) || reg.sessionId !== SITUACAO || !ehAba(reg.aba) || reg.aba === nova) return false;
    const c = chamadoDe(t, reg.aba);
    if (c && c.mensagem !== null) return false;
    const aba = reg.aba;
    const novo = { ...reg, sessionId: aba, exSituacao: true };
    delete novo.aba;
    if (mantemResolvidas) novo.fica = true;
    t.mensagens[id] = novo;
    marcarTirarBotoes(s, id);
    logar(`${aba}: a situacao ${id} foi substituida; fica no chat sem os botoes como mensagem da aba`);
    return true;
  }

  // Regra 2 (no evento): a situacao da aba `sid` ainda na fila (nao saiu) e cancelada; a que estava na tela sai como se
  // a nova tivesse saido (regra 3 ou o apagar).
  function cancelarSituacaoPendente(t, sid) {
    const s = t.situacao;
    if (s.aba !== sid || s.descer !== true || !ehObjeto(s.dados)) return;
    const antiga = ehObjeto(s.mensagem) && idMensagem(s.mensagem.messageId) != null ? s.mensagem : null;
    if (antiga && !situacaoViraDaAba(t, s, antiga, null)) s.apagar.unshift({ messageId: antiga.messageId, doBot: true, formato: formatoDe(antiga.formato) });
    s.mensagem = null;
    esvaziarSituacao(s);
    enfileirar(t, SITUACAO);
    logar(`${sid}: mensagem nova do chamado; a situacao da aba na fila foi cancelada`);
  }

  // Regra 2 (no envio): a mensagem nova do chamado de `sid` saiu: a situacao de `sid` na tela vai pro apagar (no
  // 'manter' so perde os botoes); sem outra situacao na fila, a situacao fica vazia.
  function situacaoSaiPelaAba(t, sid) {
    const s = t.situacao;
    const id = ehObjeto(s.mensagem) ? idMensagem(s.mensagem.messageId) : null;
    if (id == null) return;
    const reg = t.mensagens[id];
    const aba = ehObjeto(reg) && reg.sessionId === SITUACAO ? reg.aba : s.aba;
    if (aba !== sid) return;
    s.apagar.unshift({ messageId: id, doBot: true, formato: formatoDe(s.mensagem.formato) });
    s.mensagem = null;
    if (s.descer !== true) esvaziarSituacao(s);
    enfileirar(t, SITUACAO);
    logar(`${sid}: a mensagem nova do chamado saiu; a situacao ${id} vai pro apagar`);
  }

  // Regra 3: as mensagens da aba `sid` que eram situacao (`exSituacao`, sem `fica`) vao pro fim do apagar de `d` (a
  // mensagem nova `novoId` da aba saiu), sem repetir.
  function exSituacaoProApagar(t, d, sid, novoId) {
    for (const [k, m] of Object.entries(t.mensagens)) {
      const id = idMensagem(k);
      if (id == null || id === novoId || !ehObjeto(m) || m.sessionId !== sid || m.exSituacao !== true || m.fica === true) continue;
      if (d.apagar.some((a) => ehObjeto(a) && idMensagem(a.messageId) === id)) continue;
      d.apagar.push({ messageId: id, doBot: true, formato: formatoDe(m.formato) });
    }
  }

  // A versao atual e a que esta na tela (e nao ha mensagem nova pendente).
  const naTela = (c) => c.mensagem !== null && c.mensagem.versaoId === c.versao.id && !c.descer;

  // T7f (F8): a mensagem na tela do chamado tem botoes? So aviso/resposta tem. A tela da versao atual = os botoes que ela
  // monta; a tela de uma versao anterior (edicao ou mensagem nova que ainda nao saiu) pode ter (ja sem botoes, o Telegram
  // responde "not modified" e o adaptador devolve ok).
  // T26b2: a tela que mostra um OK (aberto ou fechado) nunca conta: os botoes dela sao os do OK (ou nenhum).
  function telaComBotoes(c) {
    if (c.mensagem === null || !COM_BOTOES.has(c.versao.estado)) return false;
    if (c.mensagem.ok != null) return false;
    if (c.mensagem.versaoId !== c.versao.id) return true;
    try {
      return montarChamado(c.versao).botoes != null;
    } catch {
      return false;
    }
  }

  // T7f (F8): a mensagem `id` do bot perde os botoes no proximo drenar do chamado `c` (c.tirarBotoes so existe com item).
  function marcarTirarBotoes(c, id) {
    const n = idMensagem(id);
    if (n == null) return;
    if (!Array.isArray(c.tirarBotoes)) c.tirarBotoes = [];
    if (!c.tirarBotoes.includes(n)) c.tirarBotoes.push(n);
  }

  // ---------- T26b1: o OK dentro do chamado (PLANO-TELEGRAM.md, "T26b1") ----------
  // c.ok = {cod, bloco, completo, toque: null | {acao, em}, fechado: null | texto, notificar, em, naTelaEm} + o que o
  // canal usa por dentro: `versaoId` (a versao da ultima mudanca do OK) e `antes` ({versaoId, descer} de antes do
  // okAbriu, pra desfazer quando o OK fecha sem nunca ter chegado na tela). A tela (c.mensagem) ganha `ok: <cod>` quando
  // saiu mostrando aquele pedido (aberto ou fechado) e perde quando sai sem ele.

  const okAberto = (c) => ehObjeto(c.ok) && typeof c.ok.fechado !== 'string';
  // a tela atual do chamado mostra o OK de agora (aberto ou fechado)
  const okNaTelaDe = (c) => ehObjeto(c.ok) && c.mensagem !== null && c.mensagem.ok === c.ok.cod;
  // T28: o fechado de vencido (a linha do fecho em negrito: `forte`) que a tela mostra
  const okVencidoNaTela = (c) => ehObjeto(c.ok) && typeof c.ok.fechado === 'string' && typeof c.ok.forte === 'string' && okNaTelaDe(c);

  // A junção: OK aberto, sem toque, na tela (sem mensagem nova pendente) e ate OK_JUNTA_MS depois do naTelaEm
  function okJunta(c) {
    if (!okAberto(c) || c.ok.toque || c.descer === true || !okNaTelaDe(c)) return false;
    const ms = msDeIso(c.ok.naTelaEm);
    return Number.isFinite(ms) && agora() - ms <= OK_JUNTA_MS;
  }

  // O chamado (e a aba) que tem o pedido `cod` no c.ok | null
  function chamadoDoOk(t, cod) {
    if (typeof cod !== 'string' || !cod) return null;
    for (const sid of Object.keys(t.chamados)) {
      const c = chamadoDe(t, sid);
      if (c && ehObjeto(c.ok) && c.ok.cod === cod) return { sid, c };
    }
    return null;
  }

  // A versao mudou por causa do OK: copia com id novo (o drenar reconcilia a tela por versaoId: edicao, ou mensagem nova
  // com `descer`) e a aba entra na fila (no comeco com `frente`).
  function okMudou(t, sid, c, { descer = false, frente = false } = {}) {
    c.versao = { ...c.versao, id: ++t.seq };
    if (ehObjeto(c.ok)) c.ok.versaoId = c.versao.id;
    if (descer) c.descer = true;
    c.mudouEm = agoraIso();
    if (!frente) {
      enfileirar(t, sid);
      return;
    }
    const i = t.saida.findIndex((x) => ehObjeto(x) && x.sessionId === sid);
    const item = i >= 0 ? t.saida.splice(i, 1)[0] : { sessionId: sid, entrouEm: agoraIso(), falhas: 0 };
    t.saida.unshift(item);
  }

  // T7j: a mensagem `id` do bot (a tela que o dono tocou numa opcao) e apagada no proximo drenar do chamado `c`, antes de
  // tudo (c.apagarJa: lista de message_id, sem repetir; so existe com item).
  function marcarApagarJa(c, id) {
    const n = idMensagem(id);
    if (n == null) return;
    if (!Array.isArray(c.apagarJa)) c.apagarJa = [];
    if (!c.apagarJa.includes(n)) c.apagarJa.push(n);
  }

  // ---------- T29b: o que nao espera nada dele (PLANO-TELEGRAM.md, "T29b") ----------
  // Cada mensagem do robo guarda no registro (t.mensagens) a hora em que ficou na tela pela ultima vez sem ser por toque
  // dele: o `at` do envio ou o `vistaEm` da ultima edicao vinda da aba/porteiro. O "Mais informações" (abrir,
  // abrirSituacao) e o "Menos informações" (T29c: recolher, recolherSituacao) marcam `porToque` = a versao que ele abriu
  // ou recolheu: a edicao dessa versao nao renova a hora.

  function marcarPorToque(t, id, versaoId) {
    const reg = t.mensagens[idMensagem(id)];
    if (ehObjeto(reg)) reg.porToque = versaoId;
  }

  // O texto da aba espera algo dele: pergunta em negrito (a regra do aviso, partesCurtas) ou opcao
  function esperaAlgo(final) {
    const f = typeof final === 'string' ? final : '';
    try {
      return partesCurtas(f).pergunta != null || lerFinal(f).opcoes.length > 0;
    } catch {
      return true; // ilegivel = fica
    }
  }
  const situacaoSemNada = (dados) => ehObjeto(dados) && !esperaAlgo(dados.final);

  // A tela do chamado (em dia) nao espera nada dele: sem OK aberto, sem o botao do OK vencido, fora do calado e da fala
  // em voo; aviso/resposta sem opcao nem pergunta; o resto (problema, encerrado, ok fechado) nunca espera
  function chamadoSemNada(c) {
    if (okAberto(c)) return false;
    if (ehObjeto(c.ok) && Array.isArray(c.ok.botoesFechado) && c.ok.botoesFechado.length) return false; // T28
    const v = c.versao;
    if (v.estado === CALADO || SO_NO_ESTADO.has(v.estado)) return false;
    if (COM_BOTOES.has(v.estado)) return !(Array.isArray(v.opcoes) && v.opcoes.length) && !esperaAlgo(v.final);
    return true;
  }

  // O id ja esta no apagar de algum dono (vai sair por outro caminho)
  function naAlgumApagar(t, id) {
    const donos = [...Object.values(t.chamados), t.sistema, t.painel, t.situacao];
    return donos.some((d) => ehObjeto(d) && Array.isArray(d.apagar) && d.apagar.some((a) => ehObjeto(a) && idMensagem(a.messageId) === id));
  }

  /**
   * T29b (item 3): a interacao dele (o porteiro chama depois de tratar cada update dele). So no modo limpo (lido na hora):
   * cada mensagem do robo na tela que nao espera nada dele (o chamado em dia sem opcao, pergunta, OK aberto nem o botao
   * do OK vencido; a linha do sistema; a situacao sem pergunta, inclusive a que ficou como mensagem da aba) com 60 s ou
   * mais na tela e menos de 48 h vai pro apagar (`vista`: 1 log quando sai). A do toque (`tocada`) fica nesse passo. O
   * painel nunca. O chamado sai com a tela (calado); a do sistema fica em dia sem tela ate a proxima linha; a situacao
   * nao volta.
   * -> quantas foram pro apagar. Nunca lanca (exceto e.tg ausente = TypeError).
   */
  function vistasSemNada(e, { tocada = null } = {}) {
    const t = tgDe(e);
    if (!limpaResolvidas) return 0;
    const agoraMs = agora();
    const tocadaId = idMensagem(tocada);
    const podeSair = (id) => {
      if (id == null || id === tocadaId) return false;
      const reg = t.mensagens[id];
      if (!ehObjeto(reg) || reg.voz === true || reg.movido === true || reg.fica === true) return false;
      const at = msDeIso(reg.at);
      const vista = Number.isFinite(msDeIso(reg.vistaEm)) ? msDeIso(reg.vistaEm) : at;
      return Number.isFinite(at) && agoraMs - at < APAGA_ATE_MS && Number.isFinite(vista) && agoraMs - vista >= VISTA_MS;
    };
    let n = 0;
    for (const sid of Object.keys(t.chamados)) {
      const c = chamadoDe(t, sid);
      if (!c || !naTela(c) || !chamadoSemNada(c)) continue;
      const id = idMensagem(c.mensagem.messageId);
      if (!podeSair(id)) continue;
      delete c.ok; // o OK fechado (sem botao) sai com a tela
      okSaiComoCalado(t, sid, c, { vista: true });
      n += 1;
    }
    const s = t.sistema;
    if (ehObjeto(s.mensagem) && s.mensagem.versaoId === s.versaoId && s.descer !== true && podeSair(idMensagem(s.mensagem.messageId))) {
      s.apagar.unshift({ messageId: s.mensagem.messageId, doBot: true, formato: formatoDe(s.mensagem.formato), vista: true });
      s.mensagem = null;
      s.semTela = s.versaoId; // em dia sem tela: so volta com linha nova (T15: a mensagem mostra so a ultima linha)
      enfileirar(t, SISTEMA);
      n += 1;
    }
    const si = t.situacao;
    if (ehAba(si.aba) && ehObjeto(si.mensagem) && si.mensagem.versaoId === si.versaoId && si.descer !== true
      && situacaoSemNada(si.dados) && podeSair(idMensagem(si.mensagem.messageId))) {
      const id = si.mensagem.messageId;
      semTirarBotoes(si, id);
      si.apagar.unshift({ messageId: id, doBot: true, formato: formatoDe(si.mensagem.formato), vista: true });
      si.mensagem = null;
      esvaziarSituacao(si);
      enfileirar(t, SITUACAO);
      n += 1;
    }
    for (const [k, m] of Object.entries(t.mensagens)) { // a situacao que ficou como mensagem da aba (T26d, regra 3)
      const id = idMensagem(k);
      if (!ehObjeto(m) || m.exSituacao !== true || m.semNada !== true || !podeSair(id) || naAlgumApagar(t, id)) continue;
      const c = chamadoDe(t, m.sessionId);
      if (c && c.mensagem !== null && idMensagem(c.mensagem.messageId) === id) continue;
      semTirarBotoes(si, id);
      si.apagar.push({ messageId: id, doBot: true, formato: formatoDe(m.formato), vista: true });
      enfileirar(t, SITUACAO);
      n += 1;
    }
    return n;
  }

  // ---------- entrada (update do Telegram) ----------

  function horaDaMensagem(date) {
    const h = Number.isFinite(date) ? isoDe(date * 1000) : null;
    return h ?? agoraIso(); // sem date legivel = hora que chegou aqui
  }

  function midiasDe(m) {
    const out = [];
    if (Array.isArray(m.photo)) {
      const fotos = m.photo.filter((p) => ehObjeto(p) && p.file_id);
      let maior = null;
      for (const p of fotos) if (Number.isFinite(p.file_size) && (!maior || p.file_size > maior.file_size)) maior = p;
      const f = maior ?? fotos[fotos.length - 1];
      if (f) out.push({ tipo: 'foto', fileId: f.file_id, nome: null, bytes: f.file_size ?? null });
    }
    if (ehObjeto(m.document)) out.push({ tipo: 'documento', fileId: m.document.file_id, nome: m.document.file_name ?? null, bytes: m.document.file_size ?? null });
    if (ehObjeto(m.video)) out.push({ tipo: 'video', fileId: m.video.file_id, nome: m.video.file_name ?? null, bytes: m.video.file_size ?? null });
    return out;
  }

  /**
   * Update do getUpdates -> {tipo:'mensagem', ...} | {tipo:'toque', ...} | null. So o chat privado do dono com ele de
   * remetente (nao bot); toque so do dono e na mensagem desse chat. Recusado = null + log sem conteudo.
   */
  function normalizarUpdate(u) {
    const updateId = ehObjeto(u) ? u.update_id : undefined;
    const recusa = (motivo) => {
      logar(`update ${Number.isSafeInteger(updateId) ? updateId : '?'} ignorado: ${motivo}`);
      return null;
    };
    if (!ehObjeto(u)) return recusa('update invalido');
    if (ehObjeto(u.message)) {
      const m = u.message;
      if (m.chat?.type !== 'private') return recusa('mensagem fora do chat privado');
      if (chatDono === null || m.chat?.id !== chatDono) return recusa('mensagem de outro chat');
      if (m.from?.id !== chatDono) return recusa('mensagem de outro remetente');
      if (m.from?.is_bot === true) return recusa('mensagem de bot');
      const som = ehObjeto(m.voice) ? m.voice : ehObjeto(m.audio) ? m.audio : null;
      return {
        tipo: 'mensagem',
        updateId,
        messageId: m.message_id,
        texto: typeof m.text === 'string' ? m.text : typeof m.caption === 'string' ? m.caption : '',
        audio: som ? { fileId: som.file_id, segundos: som.duration ?? null, mime: som.mime_type ?? null } : null,
        midias: midiasDe(m),
        respondeA: m.reply_to_message?.message_id ?? null,
        encaminhada: Boolean(m.forward_origin),
        hora: horaDaMensagem(m.date),
      };
    }
    if (ehObjeto(u.callback_query)) {
      const q = u.callback_query;
      if (chatDono === null || q.from?.id !== chatDono || q.from?.is_bot === true) return recusa('toque de outro remetente');
      if (q.message?.chat?.id !== chatDono) return recusa('toque fora do chat do dono');
      return { tipo: 'toque', updateId, toqueId: q.id, messageId: q.message.message_id, dados: q.data, hora: agoraIso() };
    }
    return recusa('tipo de update fora do canal');
  }

  /** T5b: o que o chamado de uma aba guarda dela (copia): {nome, titulo, final} | null (sem chamado legivel). */
  function chamadoDaAba(e, sessionId) {
    const t = tgDe(e);
    if (typeof sessionId !== 'string' || !sessionId || NAO_E_ABA.has(sessionId)) return null;
    const c = chamadoDe(t, sessionId);
    if (!c) return null;
    const v = c.versao;
    return {
      nome: typeof v.nome === 'string' && v.nome ? v.nome : null,
      titulo: typeof v.titulo === 'string' ? v.titulo : null,
      final: typeof v.final === 'string' ? v.final : '',
    };
  }

  /**
   * Aba dona de uma mensagem do bot (resposta em cima do chamado) | null (a do sistema, o painel ou desconhecida).
   * T10: a situacao de uma aba = a aba dela (resposta em cima da situacao vai pra aba).
   */
  function sessaoDaMensagem(e, messageId) {
    const t = tgDe(e);
    const id = idMensagem(messageId);
    if (id == null || !tem(t.mensagens, String(id))) return null;
    const m = t.mensagens[id];
    const sid = ehObjeto(m) ? m.sessionId : null;
    if (sid === SITUACAO) return ehAba(m.aba) ? m.aba : null;
    return typeof sid === 'string' && sid && !NAO_E_ABA.has(sid) ? sid : null;
  }

  /** T10: o messageId do chamado da aba que esta na tela | null (sem chamado, ainda fora da tela ou nome reservado). */
  function telaDaAba(e, sessionId) {
    const t = tgDe(e);
    if (!ehAba(sessionId)) return null;
    const c = chamadoDe(t, sessionId);
    return c && c.mensagem ? idMensagem(c.mensagem.messageId) : null;
  }

  /**
   * T7e2: o porteiro leu uma mensagem do dono (o tratarLoteTg chama pra toda mensagem dele): o id entra no anel
   * t.idsDoDono (300, sem repetir) e nunca vai pra sonda de um envio incerto (F1). Id invalido = nada. Nunca lanca
   * (exceto e.tg ausente = TypeError).
   */
  function mensagemDoDono(e, messageId) {
    const t = tgDe(e);
    const id = idMensagem(messageId);
    if (id == null || id < 1) return;
    if (!Array.isArray(t.idsDoDono)) t.idsDoDono = [];
    if (t.idsDoDono.includes(id)) return;
    t.idsDoDono.push(id);
    if (t.idsDoDono.length > MAX_IDS_DO_DONO) t.idsDoDono.splice(0, t.idsDoDono.length - MAX_IDS_DO_DONO);
  }

  /**
   * Toque num botao -> {sessionId, acao:'opcao', opcao:{letra, texto}} | {sessionId, acao:'informacoes'} | {obsoleto:true}.
   * Vale so se os dados sao do chamadoId da versao ATUAL da aba, a versao esta em aviso/resposta e o toque veio da
   * mensagem que esta na tela. T7c2: `i:<ID>` ("Mais informações") e o legado `c:<ID>` ("Mais contexto" de antes, que
   * ainda pode estar no chat) = informacoes (o lerDadosBotao ja le os dois assim).
   * T14c: o `z:<ID>` do "Concluir" (T14, que saiu) nao e lido (lerDadosBotao = null) = obsoleto.
   * T29c: `m:<ID>` ("Menos informações") = {sessionId, acao:'menos'} (+ situacao: true) so com a tela aberta e sem botao
   * de resposta (chamadoRecolhivel / situacaoRecolhivel); ja compacta, com opcao ou com o OK na mensagem = obsoleto.
   */
  function lerToque(e, dados, messageId) {
    const t = tgDe(e);
    const d = lerDadosBotao(dados);
    const id = idMensagem(messageId);
    if (!d || id == null || typeof d.chamadoId !== 'string') return { obsoleto: true }; // T29d: o p:b/p:l e do porteiro
    // T10c: os botoes da situacao (id proprio): vale so da mensagem dela na tela; a opcao sai do final guardado nela
    const s = t.situacao;
    if (s.chamadoId != null && s.chamadoId === d.chamadoId) {
      if (!ehAba(s.aba) || !ehObjeto(s.dados) || !ehObjeto(s.mensagem) || idMensagem(s.mensagem.messageId) !== id) return { obsoleto: true };
      if (d.acao === 'informacoes') return { sessionId: s.aba, acao: 'informacoes', situacao: true };
      if (d.acao === 'menos') return situacaoRecolhivel(s) ? { sessionId: s.aba, acao: 'menos', situacao: true } : { obsoleto: true }; // T29c
      if (s.dados.trabalhando === true) return { obsoleto: true }; // T16: a da aba trabalhando nao tem os botoes das opcoes
      const o = lerFinal(typeof s.dados.final === 'string' ? s.dados.final : '').opcoes[d.indice];
      if (!ehObjeto(o)) return { obsoleto: true };
      return { sessionId: s.aba, acao: 'opcao', opcao: { letra: o.letra, texto: o.texto }, situacao: true };
    }
    for (const sid of Object.keys(t.chamados)) {
      const c = chamadoDe(t, sid);
      if (!c || c.versao.chamadoId !== d.chamadoId) continue;
      if (!COM_BOTOES.has(c.versao.estado) || c.mensagem === null || idMensagem(c.mensagem.messageId) !== id) return { obsoleto: true };
      if (d.acao === 'informacoes') return { sessionId: sid, acao: 'informacoes' };
      if (d.acao === 'menos') return chamadoRecolhivel(c) ? { sessionId: sid, acao: 'menos' } : { obsoleto: true }; // T29c
      const o = Array.isArray(c.versao.opcoes) ? c.versao.opcoes[d.indice] : undefined;
      if (!ehObjeto(o)) return { obsoleto: true };
      return { sessionId: sid, acao: 'opcao', opcao: { letra: o.letra, texto: o.texto } };
    }
    return { obsoleto: true };
  }

  // ---------- eventos (so mudam e.tg e poem na fila; nao chamam a API) ----------

  function avisoOuResposta(estado, e, ev, titulo, completo, citar, liberar) {
    const t = tgDe(e);
    if (!ehObjeto(ev)) throw new TypeError(`${estado}: evento invalido`);
    const sid = sessao(ev.sessionId, estado);
    const final = typeof ev.final === 'string' ? cortarFinal(ev.final) : '';
    const opcoes = lerFinal(final).opcoes.map(({ letra, texto }) => ({ letra, texto }));
    const velho = chamadoDe(t, sid);
    if (velho && velho.encerrarDepois !== undefined) { // T26d: a aba voltou a parar: o encerrar guardado nao vale mais
      delete velho.encerrarDepois;
      logar(`${sid} ${estado}: o encerrar guardado sai (mensagem nova da aba)`);
    }
    const juntar = velho !== null && okJunta(velho); // T26b1: decidido antes da troca (o trocar liga o descer)
    const c = trocar(t, sid, versaoNova(t, estado, {
      titulo, hora: ev.finalTs || ev.at || null, final, opcoes, chamadoId: novoIdChamado(rand), nome: ev.nome, completo, citar, liberar,
    }));
    if (juntar) {
      c.descer = false; // edicao da mesma mensagem, sem nova notificacao
      delete c.ok.tela; // T26b2: a tela vai mostrar esta versao (nada desce)
      logar(`${sid} ${estado}: entra na mensagem ${c.mensagem.messageId} do OK ${c.ok.cod} (edicao)`);
    }
  }

  /**
   * A aba parou esperando o dono (ev = o "parou" {sessionId, nome, at, finalTs, final}). T7d1a (F1): sempre sem citar
   * (aviso nao responde fala nenhuma: nunca sai em cima de uma mensagem velha dele).
   */
  function aviso(e, ev, titulo) {
    avisoOuResposta('aviso', e, ev, titulo, false, null);
  }

  /**
   * A aba respondeu o que o dono mandou. T5a: `completo: true` = a fala dele pediu detalhe (a resposta vai inteira).
   * T7d1a (F1): `citar` = a mensagem dele que a resposta responde (sai em cima dela); sem citar = sem reply (nao herda).
   * T7k: `liberar` = as falas repassadas (o id de origem, sem os -E<n>) que esta resposta responde: fica na versao e,
   * quando ela fica na tela, solta o calado que esperava por elas (soltar).
   */
  function resposta(e, ev, titulo, { completo = false, citar = null, liberar = [] } = {}) {
    avisoOuResposta('resposta', e, ev, titulo, completo === true, citar, liberar);
  }

  /**
   * O dono falou com a aba (botao, resposta em cima do chamado, audio ou "Nome: texto"): enviando. T7d1a (F1):
   * a mensagem dele (texto, audio, foto, documento) fica no chat e o chamado sai em cima dela
   * (`versao.citar = messageIdDono`; toque = sem messageIdDono = null).
   * T5b: `herdarDe` = a aba do chamado em que ele respondeu, que fechou (a fala foi pra aberta com o mesmo nome): o
   * chamado dela sai e as mensagens do bot dela no chat vao pro apagar deste, como a tela antiga de um chamado que desce.
   * T7c2: o campo `contexto` saiu (o toque em "Mais informações" e o `abrir`, sem ida ate a aba); ninguem mais cria o
   * estado 'contexto', que continua no ESTADOS so pra versao gravada antes (desenho, entregue e encerrar de hoje).
   * T7f (F8): o enviando fica so no estado (nenhuma mensagem nova); o chamado da aba que estava na tela com botoes perde
   * os botoes no drenar (edicao, sem notificar) e fica la ate o resultado descer; sem chamado na tela, nada.
   * T7j (pedido do dono: "quando eu toco ... ele já tem que concluir e some a mensagem"): `toque === true` (so o
   * booleano; o toque numa opcao) = a tela com botoes vai pro `apagarJa` (apagada no drenar, antes de tudo) e
   * `c.mensagem = null` (a resposta desce como mensagem nova, nunca edicao da apagada); nada no tirarBotoes. Sem toque
   * (texto, audio, foto, documento, a fala passada de novo pra central) = o T7f.
   */
  function falaRecebida(e, { sessionId, titulo, nome, fala, audio, hora, messageIdDono, herdarDe, toque } = {}) {
    const t = tgDe(e);
    const sid = sessao(sessionId, 'falaRecebida');
    const velho = chamadoDe(t, sid);
    const ant = velho?.versao ?? null;
    const comBotoes = velho && telaComBotoes(velho) ? velho.mensagem.messageId : null;
    const tocou = toque === true;
    const c = trocar(t, sid, versaoNova(t, 'enviando', {
      titulo: titulo ?? ant?.titulo ?? null,
      hora: hora ?? agoraIso(),
      final: ant?.final,
      fala: String(fala ?? ''),
      audio,
      nome: nome ?? ant?.nome,
      citar: messageIdDono,
    }));
    if (comBotoes != null && tocou) { // T7j
      marcarApagarJa(c, comBotoes);
      c.mensagem = null;
    } else if (comBotoes != null) {
      marcarTirarBotoes(c, comBotoes); // T7f (F8)
    }
    if (typeof herdarDe === 'string' && herdarDe !== sid && !NAO_E_ABA.has(herdarDe)) herdar(t, herdarDe, sid, c, tocou);
  }

  // T5b: o chamado da aba `de` (que fechou) sai; a tela dele e o apagar dele vao pro apagar de `c` (o chamado de `para`).
  // T7d1a (F1): mensagem do dono no apagar dele (estado de antes) vem junto e sai da lista sem apagar (apagarPrimeira).
  // T7f (F8): a tela dele com botoes (o chamado que o dono respondeu) perde os botoes e fica no chat ate o resultado descer.
  // T7j: com toque, a tela dele com botoes vai pro apagarJa de `c` (fora das sobras e do tirarBotoes); o resto do apagar
  // dele segue pras sobras, esperando a mensagem nova.
  function herdar(t, de, para, c, toque = false) {
    const velho = chamadoDe(t, de);
    if (!velho) return;
    const tocada = toque === true && telaComBotoes(velho);
    if (tocada) marcarApagarJa(c, velho.mensagem.messageId);
    else if (telaComBotoes(velho)) marcarTirarBotoes(c, velho.mensagem.messageId);
    const sobras = velho.mensagem && !tocada ? [{ messageId: velho.mensagem.messageId, doBot: true, formato: formatoDe(velho.mensagem.formato) }] : [];
    sobras.push(...velho.apagar.filter((a) => ehObjeto(a) && idMensagem(a.messageId) != null));
    for (const a of sobras) if (!c.apagar.some((b) => ehObjeto(b) && b.messageId === a.messageId)) c.apagar.push(a);
    for (const a of completarLimpar(velho.limpar)) { // T23a: o limpar dele vem junto, no fim (sem repetir id)
      if (!Array.isArray(c.limpar)) c.limpar = [];
      if (!c.limpar.some((b) => ehObjeto(b) && idMensagem(b.messageId) === a.messageId)) c.limpar.push(a);
    }
    // T26b2: o c.ok dele sai junto (o pedido so confere naquela sessao); a nova nao herda OK (a tela dele ja esta nas sobras)
    if (ehObjeto(velho.ok)) logar(`${de}: o OK ${velho.ok.cod} sai com o chamado (a aba fechou)`);
    delete t.chamados[de];
    const item = t.saida.find((i) => ehObjeto(i) && i.sessionId === de);
    if (item) tirar(t.saida, item);
    logar(`${de}: a aba fechou; o chamado passou pra ${para} (${sobras.length} mensagem(ns) dele no apagar)`);
  }

  /**
   * T8 (PLANO-TELEGRAM.md, "T8"): a aba `de` fechou e voltou como a copia `para` (reaberta pelo celular, com a conversa
   * inteira). O que era dela no chat passa pra copia: o chamado (inteiro, sem mudar nada; a copia ja tem chamado = o da
   * antiga sai pelo herdar), o item dela na fila do canal (vira da copia; a copia ja tem item = o da antiga sai), as
   * mensagens do bot dela (resposta e toque em cima delas vao pra copia) e a situacao (T10). -> true se mudou algo; a
   * mesma aba, nome reservado ou id torto = false e nada muda.
   */
  function trocarAba(e, de, para) {
    const t = tgDe(e);
    if (!ehAba(de) || !ehAba(para) || de === para) return false;
    let chamado = 'nenhum';
    const velho = chamadoDe(t, de);
    if (velho) {
      const cPara = chamadoDe(t, para);
      if (cPara) {
        herdar(t, de, para, cPara);
        chamado = 'herdado';
      } else {
        t.chamados[para] = velho;
        delete t.chamados[de];
        chamado = 'movido';
      }
    }
    const item = t.saida.find((i) => ehObjeto(i) && i.sessionId === de);
    if (item) {
      if (t.saida.some((i) => ehObjeto(i) && i.sessionId === para)) tirar(t.saida, item);
      else item.sessionId = para;
    }
    let n = 0;
    for (const m of Object.values(t.mensagens)) {
      if (!ehObjeto(m)) continue;
      if (m.sessionId === de) {
        m.sessionId = para;
        n += 1;
      } else if (m.sessionId === SITUACAO && m.aba === de) {
        m.aba = para;
        n += 1;
      }
    }
    const situacao = t.situacao.aba === de;
    if (situacao) t.situacao.aba = para;
    if (chamado === 'nenhum' && !item && !n && !situacao) return false;
    logar(`${de}: a aba voltou como ${para} (reaberta); chamado ${chamado}, ${n} mensagem(ns) do bot${situacao ? ' e a situacao' : ''} passaram`);
    return true;
  }

  /**
   * A fala chegou na aba. So vale com a versao em enviando/contexto (senao a resposta ja chegou: nada). Herda o citar.
   * T7f (F8): fica so no estado (nada na tela).
   */
  function entregue(e, sessionId, hora) {
    const t = tgDe(e);
    const sid = sessao(sessionId, 'entregue');
    const c = chamadoDe(t, sid);
    if (!c || !NOVA_SILENCIOSA.has(c.versao.estado)) return;
    const ant = c.versao;
    trocar(t, sid, versaoNova(t, 'entregue', {
      titulo: ant.titulo,
      hora: ant.hora,
      horaEntrega: hora ?? agoraIso(),
      final: ant.final,
      fala: ant.fala,
      audio: ant.audio,
      nome: ant.nome,
      citar: ant.citar,
    }));
  }

  /**
   * Algo deu errado com a fala do dono (frase do porteiro); mantem a fala que ele tentou. T7d1a (F1): `citar` = a
   * mensagem dele que o problema responde; sem citar = herda o da versao anterior.
   */
  function problema(e, sessionId, frase, { titulo, fala, audio, hora, citar } = {}) {
    const t = tgDe(e);
    const sid = sessao(sessionId, 'problema');
    if (typeof frase !== 'string') throw new TypeError('problema: frase invalida');
    const ant = chamadoDe(t, sid)?.versao ?? null;
    trocar(t, sid, versaoNova(t, 'problema', {
      titulo: titulo ?? ant?.titulo ?? null,
      hora: hora ?? ant?.hora ?? agoraIso(),
      final: ant?.final,
      fala: fala ?? ant?.fala ?? null,
      audio: audio ?? ant?.audio,
      frase,
      nome: ant?.nome,
      citar: citar ?? ant?.citar,
    }));
  }

  /**
   * A aba seguiu sem a resposta do dono por aqui (motivo 'pc' | 'whatsapp'). So com a versao em aviso/resposta: o
   * chamado perde os botoes e mostra o final. Versao que ainda nao chegou na tela: sem mensagem na tela = o chamado sai
   * sem mandar nada; com outra mensagem na tela = descer desliga (a tela vira o encerrado por edicao).
   */
  function encerrar(e, sessionId, hora, motivo) {
    const t = tgDe(e);
    const sid = sessao(sessionId, 'encerrar');
    if (motivo !== 'pc' && motivo !== 'whatsapp') throw new TypeError('encerrar: motivo invalido');
    const c = chamadoDe(t, sid);
    if (c && okAberto(c)) { // T26b2: o pedido de OK aberto segura o chamado. T26d: o encerrar fica guardado ate o OK fechar
      c.encerrarDepois = { hora: typeof hora === 'string' ? hora : agoraIso(), motivo };
      logar(`${sid} ${c.versao.estado}: encerrar com o OK ${c.ok.cod} aberto; fica guardado ate o OK fechar`);
      return;
    }
    encerrarChamado(t, sid, hora, motivo);
  }

  // O encerrar de sempre (o do evento e o guardado que o okFechou aplica, T26d)
  // T29e (PLANO-TELEGRAM.md, "T29e"; caso real 18/10 22:30: a resposta da central saiu da tela 44 s depois, antes de ele
  // ler, porque ela parou de novo pra um recado): no modo limpo o encerrado tambem e a edicao de hoje; ele nao espera
  // nada, entao sai pela regra da interacao dele (vistasSemNada: 60 s na tela). Nunca sai so porque a aba parou de novo.
  function encerrarChamado(t, sid, hora, motivo) {
    const c = chamadoDe(t, sid);
    if (!c || !COM_BOTOES.has(c.versao.estado)) return;
    const ant = c.versao;
    const pelaSituacao = emDiaPelaSituacao(c); // T26d (regra 2): a situacao e a tela dele: o encerrado e mensagem nova
    const foraDaTela = !naTela(c) && !pelaSituacao;
    // T27 (PLANO-TELEGRAM.md, "T27", contrato 3; caso real 18/10: a resposta a fala dele virou edicao calada da mensagem
    // antiga): a resposta que ainda nao saiu (a mensagem nova dela pendente: `descer`) nunca e engolida pelo "pc"; ela sai
    // como mensagem nova, com notificacao. Nada muda no chamado (nem o OK fechado nem o encerrar guardado). A que ja saiu
    // e so espera uma edicao (o OK mudou, "Mais informações"), a que esta na situacao e a de tela torta encerram como sempre
    const respostaNaoSaiu = ant.estado === 'resposta' && c.descer === true;
    if (motivo === 'pc' && respostaNaoSaiu) {
      logar(`${sid} resposta: encerrar (pc) antes de sair ignorado; a resposta sai`);
      return;
    }
    delete c.encerrarDepois;
    // T26b2: o OK fechado sai; o resto e o de hoje. T28 (contrato 3): o fechado de vencido (`forte`) fica na tela do
    // encerrado (a linha dele e o bloco com o botao "Tentar novamente")
    if (ehObjeto(c.ok) && !okVencidoNaTela(c)) delete c.ok;
    if (pelaSituacao) cancelarSituacaoPendente(t, sid);
    if (foraDaTela) {
      if (c.mensagem === null) {
        delete t.chamados[sid];
        const item = t.saida.find((i) => ehObjeto(i) && i.sessionId === sid);
        if (item) tirar(t.saida, item);
        logar(`${sid} ${ant.estado} encerrado antes de sair: chamado removido sem mensagem`);
        return;
      }
      c.descer = false;
    }
    trocar(t, sid, versaoNova(t, 'encerrado', { titulo: ant.titulo, hora: hora ?? agoraIso(), final: ant.final, motivo, nome: ant.nome }));
  }

  /**
   * T7f (F8): a aba (a central) respondeu so repassando a fala do dono e sem precisar dele: o chamado encerra calado, sem
   * mensagem nova. A mensagem dele na tela (do bot) vai pro comeco do apagar, junto com o resto do apagar dele; o drenar
   * apaga em ordem e o chamado sai quando o apagar esvazia (nada pra apagar = sai agora). Sem chamado legivel = nada.
   * T7k (pedido do dono: "só tem que apagar o pedido depois que chegar a resposta"): `esperar` = as falas que
   * ela repassou (texto nao vazio, sem repetir; o resto ignorado). Com tela e `esperar` com item = a tela e o apagar ficam
   * como estao (nada vai pro apagar) e `c.esperando` guarda as falas; a tela sai quando a resposta da aba de destino a
   * elas fica na tela (soltar). Sem tela ou sem `esperar` = como antes.
   */
  function calar(e, sessionId, { esperar = [] } = {}) {
    const t = tgDe(e);
    const sid = sessao(sessionId, 'calar');
    const c = chamadoDe(t, sid);
    if (!c) return;
    if (okAberto(c)) { // T26b2: o pedido de OK aberto segura o chamado (o porteiro fecha o OK antes)
      logar(`${sid} ${c.versao.estado}: calar com o OK ${c.ok.cod} aberto; nada muda`);
      return;
    }
    if (ehObjeto(c.ok)) delete c.ok; // T26b2: o OK fechado sai; o resto e o de hoje
    const ant = c.versao;
    const falas = idsDeFala(esperar);
    if (c.mensagem !== null && falas.length) { // T7k
      c.versao = versaoNova(t, CALADO, { titulo: ant.titulo, hora: agoraIso(), final: ant.final, nome: ant.nome });
      c.esperando = [...falas];
      c.mudouEm = agoraIso();
      enfileirar(t, sid);
      logar(`${sid} ${ant.estado}: encerrado calado; a tela ${c.mensagem.messageId} fica ate a resposta de ${falas.length} fala(s) repassada(s)`);
      return;
    }
    if (c.mensagem !== null) c.apagar.unshift({ messageId: c.mensagem.messageId, doBot: true, formato: formatoDe(c.mensagem.formato) });
    delete c.tirarBotoes;
    // T23a (revisao): com o `limpar` pendente (um 429 no meio da limpeza) o calado fica ate a lista esvaziar
    if (!c.apagar.length && !(Array.isArray(c.limpar) && c.limpar.length)) {
      delete t.chamados[sid];
      const item = t.saida.find((i) => ehObjeto(i) && i.sessionId === sid);
      if (item) tirar(t.saida, item);
      logar(`${sid} ${ant.estado}: encerrado calado, sem mensagem na tela`);
      return;
    }
    c.mensagem = null;
    c.descer = false;
    c.versao = versaoNova(t, CALADO, { titulo: ant.titulo, hora: agoraIso(), final: ant.final, nome: ant.nome });
    c.mudouEm = agoraIso();
    enfileirar(t, sid);
    logar(`${sid} ${ant.estado}: encerrado calado; ${c.apagar.length} mensagem(ns) vao pro apagar`);
  }

  // ---------- T26b1: eventos do OK (PLANO-TELEGRAM.md, "T26b1"; so mudam e.tg e poem na fila) ----------

  // A mensagem `id` sai do tirarBotoes do chamado (a lista vazia some)
  function semTirarBotoes(c, id) {
    if (!Array.isArray(c.tirarBotoes)) return;
    c.tirarBotoes = c.tirarBotoes.filter((x) => idMensagem(x) !== idMensagem(id));
    if (!c.tirarBotoes.length) delete c.tirarBotoes;
  }

  // O chamado da versao 'ok' (sem o c.ok) sai como o calado: a tela vai pro comeco do apagar e o chamado sai quando o
  // apagar esvazia (nada pra apagar = sai agora). T29b: o encerrado no limpo e a tela vista e sem nada (`vista`: a marca
  // da entrada do apagar, que da o log) tambem.
  function okSaiComoCalado(t, sid, c, { vista = false } = {}) {
    const ant = c.versao;
    if (c.mensagem !== null) {
      const a = { messageId: c.mensagem.messageId, doBot: true, formato: formatoDe(c.mensagem.formato) };
      if (vista) a.vista = true;
      c.apagar.unshift(a);
    }
    delete c.tirarBotoes;
    if (!c.apagar.length && !(Array.isArray(c.limpar) && c.limpar.length)) {
      delete t.chamados[sid];
      const item = t.saida.find((i) => ehObjeto(i) && i.sessionId === sid);
      if (item) tirar(t.saida, item);
      return;
    }
    c.mensagem = null;
    c.descer = false;
    c.versao = versaoNova(t, CALADO, { titulo: ant.titulo, hora: agoraIso(), final: ant.final, nome: ant.nome });
    c.mudouEm = agoraIso();
    enfileirar(t, sid);
  }

  // T26b2 (consertos 1 e 2): a tela do chamado mostra um OK que nao esta mais aberto no c.ok (o substituido, ou o que
  // fechou com a mensagem dele em voo). Versao 'ok' sem c.ok = sai como o calado (a tela vai pro apagar); calado, e
  // enviando/entregue sem c.ok = a tela vai pro comeco do apagar (manterConversa nos 2 ultimos: a fala dele em voo); o
  // resto = versao nova (copia com ++seq), o `descer` dado e a aba na fila: o drenar edita a tela (sem o bloco, ou com o
  // bloco fechado se o c.ok daquele pedido ainda existe fechado).
  function telaDoOkSemDono(t, sid, c, descer) {
    const estado = c.versao.estado;
    if (estado === 'ok' && !ehObjeto(c.ok)) {
      okSaiComoCalado(t, sid, c);
      return;
    }
    if (estado === CALADO || (SO_NO_ESTADO.has(estado) && !ehObjeto(c.ok))) {
      const id = c.mensagem.messageId;
      const a = { messageId: id, doBot: true, formato: formatoDe(c.mensagem.formato) };
      if (estado !== CALADO) a.manterConversa = true;
      semTirarBotoes(c, id);
      c.apagar.unshift(a);
      c.mensagem = null;
      if (estado !== CALADO) c.descer = false;
      c.mudouEm = agoraIso();
      enfileirar(t, sid);
      return;
    }
    if (ehObjeto(c.ok)) {
      okMudou(t, sid, c);
    } else {
      c.versao = { ...c.versao, id: ++t.seq };
      c.mudouEm = agoraIso();
      enfileirar(t, sid);
    }
    c.descer = descer === true;
  }

  // T26b2 (conserto 2): a mensagem `tela` saiu (nova ou edicao) com o OK `cod` e, com ela em voo, o pedido fechou ou
  // saiu do chamado: a tela nunca fica com o bloco aberto sem dono. O mesmo OK aberto (o normal) ou outro OK aberto no
  // lugar (ele desce com a mensagem nova dele) = nada. O chamado que saiu com o OK (versao 'ok' que fechou antes de a
  // 1a mensagem voltar) volta pra tirar a tela; se a aba ja tem outro chamado, a tela vai pro comeco do apagar dele.
  function okDepoisDoEnvio(t, alvo, d, cod, tela, descer) {
    if (okAberto(d)) return;
    const sid = alvo.sid;
    if (t.chamados[sid] !== d) {
      const outro = chamadoDe(t, sid);
      if (outro) {
        const a = { messageId: tela.messageId, doBot: true, formato: formatoDe(tela.formato) };
        if (SO_NO_ESTADO.has(outro.versao.estado)) a.manterConversa = true;
        outro.apagar.unshift(a);
        outro.mudouEm = agoraIso();
        enfileirar(t, sid);
        logar(`${sid}: a mensagem ${tela.messageId} saiu com o OK ${cod}, que fechou no envio; vai pro apagar do chamado novo`);
        return;
      }
      t.chamados[sid] = d;
    }
    telaDoOkSemDono(t, sid, d, descer);
    logar(`${sid} ${d.versao.estado}: a mensagem ${tela.messageId} saiu com o OK ${cod}, que fechou no envio; a tela sai do OK aberto`);
  }

  // T26b2: trancada = o OK aberto, com toque, na tela (o porteiro confere o toque naquela mensagem: nada a apaga nem a
  // reescreve ate o fecho ou o okToque(null))
  const trancada = (c) => okAberto(c) && Boolean(c.ok.toque) && okNaTelaDe(c);

  /**
   * T26b2: o porteiro passa a cada volta. Chamado com o OK aberto fora da tela (ou com a mensagem nova pendente) e sem
   * item na fila (a trava e o 400 tiram o item) volta pro COMECO da fila, no maximo 1 vez por minuto por aba (sem o
   * limite voltaria a cada passo). A tela trancada nao volta (a mensagem nova dela espera o fecho). -> quantos voltaram.
   */
  function okSemTela(e) {
    const t = tgDe(e);
    const agoraMs = agora();
    for (const [sid, ms] of voltasDoOk) if (!(agoraMs - ms < OK_VOLTA_MS)) voltasDoOk.delete(sid);
    let n = 0;
    for (const sid of Object.keys(t.chamados)) {
      const c = chamadoDe(t, sid);
      if (!c || !okAberto(c) || trancada(c)) continue;
      if (okNaTelaDe(c) && c.descer !== true) continue;
      if (t.saida.some((i) => ehObjeto(i) && i.sessionId === sid) || voltasDoOk.has(sid)) continue;
      voltasDoOk.set(sid, agoraMs);
      t.saida.unshift({ sessionId: sid, entrouEm: agoraIso(), falhas: 0 });
      n += 1;
      logar(`${sid} ${c.versao.estado}: o OK ${c.ok.cod} esta fora da tela; volta pro comeco da fila`);
    }
    return n;
  }

  /**
   * O porteiro abriu um pedido de OK da aba: o pedido entra no chamado (c.ok) e sai na mensagem da aba, embaixo da parte
   * dela (montarChamadoComOk). `bloco` = {compacto: {texto, botoes}, completo: {texto, botoes}} (montarBlocoOk do
   * lib/ok-tg). -> {aceito: true, substituido: <cod> | null} | {aceito: false, motivo: 'trancada'}.
   * Sem chamado (ou com o calado) = chamado novo na versao 'ok' (as sobras da aba vao pro apagar, como no trocar). Mesmo
   * cod ja no chamado = aceito, nada muda. OK aberto com toque e na tela = recusa (a T26b2 trata a trancada). Outro OK
   * aberto sem toque = substituido. A aba vai pro COMECO da fila e o OK sai em mensagem nova com notificacao.
   */
  function okAbriu(e, sessionId, { cod, bloco, titulo, nome } = {}) {
    const t = tgDe(e);
    const sid = sessao(sessionId, 'okAbriu');
    if (typeof cod !== 'string' || !cod) throw new TypeError('okAbriu: cod invalido');
    const parte = (b) => ehObjeto(b) && typeof b.texto === 'string' && b.texto !== '';
    if (!ehObjeto(bloco) || !parte(bloco.compacto) || !parte(bloco.completo)) throw new TypeError('okAbriu: bloco invalido');
    let c = chamadoDe(t, sid);
    if (c && ehObjeto(c.ok) && c.ok.cod === cod) return { aceito: true, substituido: null };
    if (c && okAberto(c) && c.ok.toque && okNaTelaDe(c)) {
      logar(`${sid}: OK ${cod} recusado (o OK ${c.ok.cod} esta tocado na tela)`);
      return { aceito: false, motivo: 'trancada' };
    }
    const substituido = c && okAberto(c) ? c.ok.cod : null;
    let antes = null;
    if (!c || c.versao.estado === CALADO) {
      const tit = typeof titulo === 'string' && titulo ? titulo : (c?.versao.titulo ?? null);
      c = trocar(t, sid, versaoNova(t, 'ok', { titulo: tit, hora: agoraIso(), nome }));
    } else {
      antes = { versaoId: c.versao.id, descer: c.descer === true };
    }
    c.ok = { cod, bloco, completo: false, toque: null, fechado: null, notificar: true, em: agoraIso(), naTelaEm: null };
    if (antes) c.ok.antes = antes;
    cancelarSituacaoPendente(t, sid); // T26d (regra 2): o OK e mensagem nova da aba
    okMudou(t, sid, c, { descer: true, frente: true });
    logar(`${sid} ${c.versao.estado}: OK ${cod} entra no chamado${substituido ? ` (no lugar do OK ${substituido})` : ''}`);
    return { aceito: true, substituido };
  }

  /** "Mais informações" do OK: aberto, sem toque e compacto = o bloco completo (e a parte aberta), por edicao -> true. */
  function okInfo(e, cod) {
    const t = tgDe(e);
    const a = chamadoDoOk(t, cod);
    if (!a || !okAberto(a.c) || a.c.ok.toque || a.c.ok.completo === true) return false;
    a.c.ok.completo = true;
    okMudou(t, a.sid, a.c);
    logar(`${a.sid}: OK ${cod} aberto inteiro`);
    return true;
  }

  /**
   * O toque no Sim/Não do OK aberto (`acao` 'sim' | 'nao'): anota e a tela perde SO o teclado (tirarBotoes; o texto nao
   * e editado). `null` = desanota (a trava zerou) e a tela volta com os botoes por edicao. Sem o pedido aberto = false.
   */
  function okToque(e, cod, acao) {
    const t = tgDe(e);
    if (acao !== 'sim' && acao !== 'nao' && acao !== null) throw new TypeError('okToque: acao invalida');
    const a = chamadoDoOk(t, cod);
    if (!a || !okAberto(a.c)) return false;
    const { sid, c } = a;
    if (acao !== null) {
      c.ok.toque = { acao, em: agoraIso() };
      if (okNaTelaDe(c)) {
        marcarTirarBotoes(c, c.mensagem.messageId);
        c.mudouEm = agoraIso();
        enfileirar(t, sid);
      }
      logar(`${sid}: OK ${cod} tocado (${acao})`);
      return true;
    }
    if (!c.ok.toque) return true;
    c.ok.toque = null;
    if (c.mensagem !== null) semTirarBotoes(c, c.mensagem.messageId);
    okMudou(t, sid, c);
    logar(`${sid}: OK ${cod} sem o toque; os botoes voltam`);
    return true;
  }

  /**
   * O pedido `cod` fechou (o chamado que tem o cod; outro, nenhum ou ja fechado = false). Nunca chegou na tela = o c.ok
   * sai sem mensagem (versao 'ok' sem tela = o chamado sai). `some` (no modo 'apagar'): o c.ok sai; aviso/resposta (e os
   * outros estados que tem tela) = edicao sem o bloco, com os botoes do chamado; versao 'ok' = a tela vai pro apagar e o
   * chamado sai como o calado; enviando/entregue = a tela vai pro comeco do apagar com `manterConversa: true` (a fala
   * dele em voo nao e conversa resolvida) e o chamado fica. Senao (e no modo 'manter') = `c.ok.fechado = texto` e
   * edicao (o bloco fechado, sem botoes).
   */
  function okFechou(e, cod, opcoes = {}) {
    const t = tgDe(e);
    const a = chamadoDoOk(t, cod);
    const guardado = a && okAberto(a.c) && encerrarDepoisValido(a.c.encerrarDepois) ? a.c.encerrarDepois : null;
    const r = okFechouSo(t, cod, opcoes);
    // T26d (conserto da T26b2): o encerrar que chegou com o OK aberto vale agora (o de sempre, que tira o OK fechado)
    if (r === true && guardado) {
      delete a.c.encerrarDepois;
      logar(`${a.sid}: o OK ${cod} fechou; o encerrar guardado vale agora`);
      encerrarChamado(t, a.sid, guardado.hora, guardado.motivo);
    }
    return r;
  }

  function okFechouSo(t, cod, { texto, some = false, forte, botoes } = {}) {
    const fecho = some !== true || mantemResolvidas;
    if (fecho && typeof texto !== 'string') throw new TypeError('okFechou: texto invalido');
    const a = chamadoDoOk(t, cod);
    if (!a || !okAberto(a.c)) return false;
    const { sid, c } = a;
    if (c.ok.naTelaEm == null && !okNaTelaDe(c)) { // nunca chegou na tela
      const antes = c.ok.antes;
      const soOk = c.versao.id === c.ok.versaoId; // nada mudou na versao desde a ultima mudanca do OK
      delete c.ok;
      if (c.versao.estado === 'ok' && c.mensagem === null) { // o chamado so existia pro OK: sai (as sobras ficam no chat)
        delete t.chamados[sid];
        const item = t.saida.find((i) => ehObjeto(i) && i.sessionId === sid);
        if (item) tirar(t.saida, item);
      } else if (c.versao.estado === 'ok') {
        okSaiComoCalado(t, sid, c);
      } else if (c.mensagem !== null && c.mensagem.ok != null) {
        // T26b2 (conserto 1): a tela ainda mostra o OK que este substituiu: o versaoId NAO volta (a tela seria dada como
        // em dia com o bloco e os botoes do antigo); so o descer volta e o drenar tira o bloco
        telaDoOkSemDono(t, sid, c, soOk && ehObjeto(antes) ? antes.descer === true : c.descer === true);
      } else if (soOk && ehObjeto(antes) && Number.isSafeInteger(antes.versaoId)) {
        c.versao = { ...c.versao, id: antes.versaoId }; // desfaz: a tela volta a estar em dia
        c.descer = antes.descer === true;
      }
      logar(`${sid}: OK ${cod} fechou sem chegar na tela; sai sem mensagem`);
      return true;
    }
    if (fecho) {
      c.ok.fechado = texto;
      // T28: o fechado de vencido = a linha do fecho em negrito (`forte`) e o botao "Tentar novamente" (`botoes`)
      if (typeof forte === 'string' && forte !== '') c.ok.forte = forte;
      if (Array.isArray(botoes) && botoes.length) c.ok.botoesFechado = botoes;
      okMudou(t, sid, c);
      logar(`${sid}: OK ${cod} fechado na tela`);
      return true;
    }
    delete c.ok;
    const estado = c.versao.estado;
    if (estado === 'ok') {
      okSaiComoCalado(t, sid, c);
    } else if (SO_NO_ESTADO.has(estado)) {
      if (c.mensagem !== null) {
        const id = c.mensagem.messageId;
        semTirarBotoes(c, id);
        c.apagar.unshift({ messageId: id, doBot: true, formato: formatoDe(c.mensagem.formato), manterConversa: true });
      }
      c.mensagem = null;
      c.descer = false;
      c.mudouEm = agoraIso();
      enfileirar(t, sid);
    } else {
      okMudou(t, sid, c); // edicao sem o bloco (o montarChamado de sempre)
    }
    logar(`${sid} ${estado}: OK ${cod} some da tela`);
    return true;
  }

  /**
   * T28 (PLANO-TELEGRAM.md, "T28", contratos 2 e 4): o toque em "Tentar novamente" do fechado de vencido `cod` (ou o
   * problema na entrega do recado dele): o botao sai e a 2a linha (`linha`: "Pedi de novo à aba às HH:MM." ou "Não
   * consegui pedir de novo à aba: ...") entra embaixo da linha do fecho, por edicao (a 2a chamada troca a linha; o botao
   * nao volta). So o fechado de vencido (`forte`) do chamado que tem o cod; senao false.
   */
  function okDeNovo(e, cod, linha) {
    const t = tgDe(e);
    if (typeof linha !== 'string' || !linha) throw new TypeError('okDeNovo: linha invalida');
    const a = chamadoDoOk(t, cod);
    if (!a || typeof a.c.ok.fechado !== 'string' || typeof a.c.ok.forte !== 'string') return false;
    delete a.c.ok.botoesFechado;
    a.c.ok.depois = linha;
    okMudou(t, a.sid, a.c);
    logar(`${a.sid}: OK ${cod} vencido: o botao sai e a 2a linha entra`);
    return true;
  }

  /** O cod do OK ABERTO mostrado na mensagem `messageId` (a tela atual do chamado) | null. */
  function okNaMensagem(e, messageId) {
    const t = tgDe(e);
    const id = idMensagem(messageId);
    if (id == null) return null;
    for (const sid of Object.keys(t.chamados)) {
      const c = chamadoDe(t, sid);
      if (c && okAberto(c) && okNaTelaDe(c) && idMensagem(c.mensagem.messageId) === id) return c.ok.cod;
    }
    return null;
  }

  /**
   * T7c2 (F4): o dono tocou em "Mais informações" = a mensagem do chamado vira o texto completo,
   * sem ida ate a aba. So com a versao em aviso/resposta, ainda compacta (`completo !== true`) e com final: versao nova
   * (++seq) com os mesmos campos e `completo: true`. Nao passa pelo `trocar`: e edicao da mensagem que esta na tela (o
   * descer fica como estava, sem notificacao), e o chamadoId nao muda (os botoes das opcoes continuam valendo). Atualiza
   * o mudouEm e poe a aba na fila. Devolve true; senao (outro estado, sem chamado, sem final ou ja aberto) false.
   */
  function abrir(e, sessionId) {
    const t = tgDe(e);
    const sid = sessao(sessionId, 'abrir');
    const c = chamadoDe(t, sid);
    if (!c) return false;
    const v = c.versao;
    if (!COM_BOTOES.has(v.estado) || v.completo === true || typeof v.final !== 'string' || !v.final.trim()) return false;
    c.versao = versaoNova(t, v.estado, {
      chamadoId: v.chamadoId, opcoes: v.opcoes, final: v.final, citar: v.citar, titulo: v.titulo, hora: v.hora, nome: v.nome,
      completo: true,
    });
    if (c.mensagem !== null) marcarPorToque(t, c.mensagem.messageId, c.versao.id); // T29b
    c.mudouEm = agoraIso();
    enfileirar(t, sid);
    logar(`${sid} ${v.estado}: aberto (texto completo)`);
    return true;
  }

  // ---------- T29c: "Menos informações" (PLANO-TELEGRAM.md, "T29c") ----------
  // O aberto sem botao de resposta na tela tem o "Menos informações": aviso/resposta aberto, com final, sem opcao e sem o
  // OK dentro da mensagem (o OK tem Sim/Nao e o bloco dele: fica de fora).
  function chamadoRecolhivel(c) {
    const v = c.versao;
    if (!COM_BOTOES.has(v.estado) || v.completo !== true || typeof v.final !== 'string' || !v.final.trim()) return false;
    return !(Array.isArray(v.opcoes) && v.opcoes.length) && !ehObjeto(c.ok);
  }
  // A situacao aberta, com texto e sem botao de opcao (sem opcao no texto, ou a da aba trabalhando: opcoes em texto, T16)
  function situacaoRecolhivel(s) {
    if (s.completo !== true || !ehObjeto(s.dados) || typeof s.dados.final !== 'string' || !s.dados.final.trim()) return false;
    return s.dados.trabalhando === true || lerFinal(s.dados.final).opcoes.length === 0;
  }

  /**
   * T29c: o dono tocou em "Menos informações" = a mensagem do chamado volta pro compacto, sem ida ate a aba. So com o
   * aberto sem botao de resposta (chamadoRecolhivel): versao nova (++seq) com os mesmos campos e `completo: false`, pelo
   * mesmo caminho do abrir (edicao da mensagem na tela, sem notificar; o chamadoId nao muda e o "Mais informações" volta).
   * Marca o toque (T29b: a edicao nao renova a hora). Devolve true; senao (sem chamado, ja compacto, com opcao, com o OK
   * na mensagem, outro estado) false e nada muda.
   */
  function recolher(e, sessionId) {
    const t = tgDe(e);
    const sid = sessao(sessionId, 'recolher');
    const c = chamadoDe(t, sid);
    if (!c || !chamadoRecolhivel(c)) return false;
    const v = c.versao;
    c.versao = versaoNova(t, v.estado, {
      chamadoId: v.chamadoId, opcoes: v.opcoes, final: v.final, citar: v.citar, titulo: v.titulo, hora: v.hora, nome: v.nome,
      completo: false,
    });
    if (c.mensagem !== null) marcarPorToque(t, c.mensagem.messageId, c.versao.id); // T29b
    c.mudouEm = agoraIso();
    enfileirar(t, sid);
    logar(`${sid} ${v.estado}: recolhido (compacto)`);
    return true;
  }

  /**
   * Linha nova na mensagem viva do sistema (TITULO_SISTEMA; guarda 10, mostra 3). notificar = mensagem nova com
   * notificacao (fica ligado ate uma nova sair); citar (T7d1a, F1) = mensagem nova em cima da mensagem do dono (reply),
   * em silencio salvo notificar, e ela fica no chat; senao edicao em silencio. A anterior sai depois que a nova sair.
   * O citar fica ate a mensagem nova sair (linha sem citar no meio nao apaga ele). `apagarDoDono` saiu (F1): TypeError.
   * T30 (PLANO-TELEGRAM.md, "T30", decisao 2): `falaFica: true` (com citar) = a fala citada nao chegou a aba nenhuma (a
   * recusa): a mensagem que sair com este citar leva `falaFica` no registro e, quando ela sair do chat, a fala dele fica
   * (nao entra no `limpar` da conversa resolvida). Sem ele = a T23 de hoje.
   */
  function sistema(e, texto, opcoes = {}) {
    const t = tgDe(e);
    if (typeof texto !== 'string') throw new TypeError('sistema: texto invalido');
    const { notificar = false, citar = null, falaFica = false } = opcoes;
    if (tem(opcoes, 'apagarDoDono')) throw new TypeError('sistema: apagarDoDono saiu (F1: a mensagem do dono fica no chat); use citar');
    const s = t.sistema;
    s.linhas.push({ hora: agoraIso(), texto });
    if (s.linhas.length > MAX_LINHAS) s.linhas.splice(0, s.linhas.length - MAX_LINHAS);
    s.versaoId = ++t.seq;
    const id = idMensagem(citar);
    if (notificar === true) s.notificar = true;
    if (id != null) s.citar = id;
    if (id != null && falaFica === true) s.citarFica = true; // T30
    else if (id != null) delete s.citarFica;
    if (notificar === true || id != null) s.descer = true;
    enfileirar(t, SISTEMA);
  }

  /**
   * T9: o painel das abas (status + pendencias; PLANO-TELEGRAM.md, T9). Cada pedido = mensagem nova em silencio, em cima
   * da mensagem do dono (citar), fora da do sistema; a do painel anterior sai depois que a nova sair. `dados` (objeto
   * simples; senao TypeError) vai copiado pro estado e o montarPainel monta na hora do envio. 2 pedidos antes do drenar =
   * 1 mensagem so (a versao nova, com o citar novo).
   */
  function painel(e, dados, { citar = null } = {}) {
    const t = tgDe(e);
    if (!ehObjeto(dados)) throw new TypeError('painel: dados invalidos');
    const p = t.painel;
    p.dados = JSON.parse(JSON.stringify(dados));
    p.versaoId = ++t.seq;
    p.citar = idMensagem(citar);
    p.descer = true;
    delete p.busca; // T29d: um painel novo pedido volta ao inteiro
    enfileirar(t, PAINEL);
  }

  // ---------- T29d: a busca no painel (PLANO-TELEGRAM.md, "T29d") ----------
  // O painel tem o "Buscar"; o toque manda a pergunta (PERGUNTA_BUSCA, resposta forcada) e a palavra dele (a resposta a
  // ela ou o "/buscar <palavra>"; quem reconhece e o porteiro) edita o painel na tela so com as abas que batem
  // (filtrarPainel). A pergunta nao e mensagem de aba (fora do t.mensagens: resposta em cima dela nao vai pra aba) e sai
  // do chat nos 2 modos (apagarPergunta, no passo do painel). A palavra nunca vai pro log.

  // A pergunta que esta (ou ia) na tela vai pro apagar dela; a pergunta sai do estado.
  function perguntaSai(t) {
    const p = t.painel;
    if (!ehObjeto(p.pergunta)) return false;
    const id = idMensagem(p.pergunta.messageId);
    delete p.pergunta;
    if (id != null) p.apagarPergunta = [...(Array.isArray(p.apagarPergunta) ? p.apagarPergunta : []), id];
    enfileirar(t, PAINEL);
    return true;
  }

  /** T29d (decisao 1): o toque no "Buscar" = a pergunta nova (a anterior sai). Vale com ou sem painel na tela. */
  function pedirBusca(e) {
    const t = tgDe(e);
    perguntaSai(t);
    t.painel.pergunta = { messageId: null, em: agoraIso() };
    enfileirar(t, PAINEL);
    logar(`${PAINEL}: pergunta da busca pedida`);
  }

  /** T29d: o message_id da pergunta na tela (a que a resposta dele cita) | null (sem pergunta, nao saiu ou vencida). */
  function perguntaDaBusca(e) {
    const q = tgDe(e).painel.pergunta;
    if (!ehObjeto(q)) return null;
    const em = msDeIso(q.em);
    if (!Number.isFinite(em) || agora() - em >= BUSCA_TTL_MS) return null;
    return idMensagem(q.messageId);
  }

  /**
   * T29d (decisao 2): a busca por `palavra` (texto com letra; senao TypeError). A pergunta sai. Painel na tela (ou pedido)
   * = edicao dele (sem notificar); sem painel e com `dados` (objeto) = o painel sai filtrado como mensagem nova (sem
   * citar); sem painel e sem dados = null e nada muda. Devolve o numero de abas que batem. Log sem a palavra.
   */
  function buscar(e, palavra, { dados = null } = {}) {
    const t = tgDe(e);
    const q = palavraDaBusca(palavra);
    if (!q) throw new TypeError('buscar: palavra invalida');
    const p = t.painel;
    perguntaSai(t);
    if (painelNaTela(e) === null) {
      if (!ehObjeto(dados)) return null;
      p.dados = JSON.parse(JSON.stringify(dados));
      p.citar = null;
      p.descer = true;
    }
    p.busca = { palavra: q, em: agoraIso() };
    p.versaoId = ++t.seq;
    enfileirar(t, PAINEL);
    const n = filtrarPainel(p.dados, q).n;
    logar(`${PAINEL}: busca com ${n} abas`);
    return n;
  }

  /** T29d: o "Limpar busca" = o painel inteiro de novo (edicao). Sem busca = false e nada muda. */
  function limparBusca(e) {
    const t = tgDe(e);
    const p = t.painel;
    if (!ehObjeto(p.busca)) return false;
    delete p.busca;
    if (painelNaTela(e) !== null) {
      p.versaoId = ++t.seq;
      enfileirar(t, PAINEL);
    }
    logar(`${PAINEL}: busca limpa`);
    return true;
  }

  /** T29d (decisao 4): 15 min sem uso = a busca volta ao inteiro; a pergunta sem resposta em 15 min sai (nada muda). */
  function vencerBusca(e) {
    const t = tgDe(e);
    const p = t.painel;
    const vencida = (x) => {
      const em = msDeIso(x?.em);
      return !Number.isFinite(em) || agora() - em >= BUSCA_TTL_MS;
    };
    if (ehObjeto(p.busca) && vencida(p.busca)) limparBusca(e);
    if (ehObjeto(p.pergunta) && vencida(p.pergunta)) {
      perguntaSai(t);
      logar(`${PAINEL}: pergunta da busca sem resposta em 15 min; sai`);
    }
  }

  /**
   * T12 (PLANO-TELEGRAM.md, T12, contrato 3): os dados do painel que esta na tela (ou ja pedido e ainda nao enviado), em
   * copia | null (sem painel).
   */
  function painelNaTela(e) {
    const p = tgDe(e).painel;
    const naTela = ehObjeto(p.mensagem) && idMensagem(p.mensagem.messageId) != null;
    if (!ehObjeto(p.dados) || (!naTela && p.descer !== true)) return null;
    return JSON.parse(JSON.stringify(p.dados));
  }

  /**
   * T12 (contrato 2 e 3): o painel na tela com os dados novos, por edicao da mesma mensagem (sem notificar; o citar e o
   * descer ficam como estao: o painel pedido e ainda nao enviado so troca os dados). false = sem painel (nada na fila).
   * Edicao recusada = o painel sai do estado (editarTela). `dados` (objeto simples; senao TypeError) vai copiado.
   */
  function atualizarPainel(e, dados) {
    const t = tgDe(e);
    if (!ehObjeto(dados)) throw new TypeError('atualizarPainel: dados invalidos');
    if (painelNaTela(e) === null) return false;
    const p = t.painel;
    p.dados = JSON.parse(JSON.stringify(dados));
    p.versaoId = ++t.seq;
    enfileirar(t, PAINEL);
    return true;
  }

  /**
   * T12 (contrato 1): o "/start a_<aba>" que o toque no nome da aba no painel manda (mensagem do dono) sai do chat: vai
   * pra lista `apagarToque` da situacao (sem repetir) e e apagado no drenar antes de tudo. Recusado ou com mais de 48 h =
   * fica no chat (1 log); mensagem de pedido de OK nunca. false = id invalido (nada na fila).
   */
  function apagarToque(e, messageId) {
    const t = tgDe(e);
    if (!(Number.isSafeInteger(messageId) && messageId > 0)) return false; // so o id inteiro de uma mensagem dele
    const n = messageId;
    const s = t.situacao;
    if (!Array.isArray(s.apagarToque)) s.apagarToque = [];
    if (!s.apagarToque.includes(n)) s.apagarToque.push(n);
    enfileirar(t, SITUACAO);
    return true;
  }

  /**
   * T10: a situacao de 1 aba (o toque no nome dela no painel; PLANO-TELEGRAM.md, T10, contrato 2). Mesmo jeito do painel:
   * mensagem nova em silencio, em cima do citar (o ultimo chamado da aba na tela, ou o "/start" dele), a anterior sai depois
   * que a nova sair; o painel fica. `dados` ({titulo, situacao, final}; objeto simples, senao TypeError) vai copiado pro
   * estado (o final no corte do chamado) e o montarSituacao monta na hora do envio. Resposta em cima dela vai pra aba.
   * T16: `dados.trabalhando === true` (a aba trabalhando) = sem os botoes das opcoes, e o `o:` dela e toque velho.
   */
  function situacao(e, sessionId, dados, { citar = null } = {}) {
    const t = tgDe(e);
    const sid = sessao(sessionId, 'situacao');
    if (!ehObjeto(dados)) throw new TypeError('situacao: dados invalidos');
    const s = t.situacao;
    const copia = JSON.parse(JSON.stringify(dados));
    if (typeof copia.final === 'string') copia.final = cortarFinal(copia.final);
    s.aba = sid;
    s.dados = copia;
    s.chamadoId = novoIdChamado(rand); // T10c: os botoes do aviso, com id proprio
    s.completo = false;
    s.versaoId = ++t.seq;
    s.citar = idMensagem(citar);
    s.descer = true;
    enfileirar(t, SITUACAO);
  }

  /**
   * T10c: "Mais informações" na situacao = a mensagem dela vira o texto completo ali mesmo (edicao, sem notificar), com
   * os botoes das opcoes. false = sem situacao na tela, ja aberta ou sem texto pra abrir.
   */
  function abrirSituacao(e) {
    const t = tgDe(e);
    const s = t.situacao;
    if (!ehAba(s.aba) || !ehObjeto(s.dados) || s.completo === true || !ehObjeto(s.mensagem)) return false;
    if (typeof s.dados.final !== 'string' || !s.dados.final.trim()) return false;
    s.completo = true;
    s.versaoId = ++t.seq;
    s.descer = false;
    marcarPorToque(t, s.mensagem.messageId, s.versaoId); // T29b
    enfileirar(t, SITUACAO);
    logar(`${SITUACAO}: aberta (texto completo)`);
    return true;
  }

  /**
   * T29c: "Menos informações" na situacao = a mensagem dela volta pro compacto ali mesmo (edicao, sem notificar), com o
   * "Mais informações" de volta; o id dos botoes fica. false = sem situacao na tela, ja compacta ou com botao de opcao.
   */
  function recolherSituacao(e) {
    const t = tgDe(e);
    const s = t.situacao;
    if (!ehAba(s.aba) || !ehObjeto(s.mensagem) || !situacaoRecolhivel(s)) return false;
    s.completo = false;
    s.versaoId = ++t.seq;
    s.descer = false;
    marcarPorToque(t, s.mensagem.messageId, s.versaoId); // T29b
    enfileirar(t, SITUACAO);
    logar(`${SITUACAO}: recolhida (compacto)`);
    return true;
  }

  /**
   * T10c: o dono tocou numa opcao da situacao (como no chamado, T7j): a mensagem dela sai (apagar) e nao volta. false = sem
   * situacao na tela.
   */
  function situacaoTocada(e) {
    const t = tgDe(e);
    const s = t.situacao;
    if (!ehObjeto(s.mensagem) || idMensagem(s.mensagem.messageId) == null) return false;
    marcarApagarJa(s, s.mensagem.messageId);
    s.mensagem = null;
    s.dados = null;
    s.completo = false;
    s.descer = false;
    enfileirar(t, SITUACAO);
    logar(`${SITUACAO}: tocada (a mensagem sai)`);
    return true;
  }

  // ---------- saida (drenar) ----------

  function marcarEnvio(t, ok, agoraMs) {
    const s = t.saude;
    const h = isoDe(agoraMs);
    if (ok) {
      s.envioOkEm = h;
      s.envioFalhaDesde = null;
      s.envioUltimaFalhaEm = null;
      return;
    }
    if (!Number.isFinite(msDeIso(s.envioFalhaDesde))) s.envioFalhaDesde = h;
    s.envioUltimaFalhaEm = h;
  }

  // 1 acao na API (ou no ensaio). Nunca lanca; chamada ok marca a saude do envio.
  async function chamar(t, metodo, { sessionId, estado, messageId, pedido }, resumo) {
    resumo.chamadas += 1;
    let r;
    if (emEnsaio) {
      let registro;
      if (metodo === 'enviar') {
        r = { ok: true, messageId: -(++t.seq), formato: 'rich' };
        registro = { acao: 'tg.enviar', sessionId, estado, silencioso: pedido.silencioso, html: pedido.html, classico: pedido.classico, botoes: pedido.botoes };
        if (pedido.responderA != null) registro.responderA = pedido.responderA; // T7d1a: so quando existe
        if (pedido.respostaForcada != null) registro.respostaForcada = pedido.respostaForcada; // T29d: so quando existe
      } else if (metodo === 'editar') {
        r = { ok: true };
        registro = { acao: 'tg.editar', sessionId, messageId, estado, html: pedido.html, classico: pedido.classico, botoes: pedido.botoes };
      } else if (metodo === 'sondar') { // T7e2
        r = { ok: true };
        registro = { acao: 'tg.sondar', messageId };
      } else if (metodo === 'tirarBotoes') { // T7f (F8)
        r = { ok: true };
        registro = { acao: 'tg.editarBotoes', sessionId, messageId, botoes: null };
      } else {
        r = { ok: true };
        registro = { acao: 'tg.apagar', messageId };
      }
      try {
        registrarEnsaio(registro);
      } catch (err) {
        logar(`ensaio: registrarEnsaio falhou (${nomeErro(err)})`);
      }
    } else {
      try {
        if (metodo === 'enviar') r = await tg.enviar(pedido);
        else if (metodo === 'editar') r = await tg.editar(messageId, pedido);
        else if (metodo === 'sondar') r = await tg.editarBotoes(messageId, null); // T7e2: a sonda (tira os botoes)
        else if (metodo === 'tirarBotoes') r = await tg.editarBotoes(messageId, null); // T7f (F8): so os botoes saem
        else r = await tg.apagar(messageId);
      } catch (err) {
        r = { ok: false, erro: `${metodo}: ${err?.message || err}` };
      }
      if (!ehObjeto(r)) r = { ok: false, erro: `${metodo}: sem resposta do adaptador` };
    }
    if (r.ok === true) {
      marcarEnvio(t, true, agora());
      recuoAte = 0; // T7e2: a 1a chamada ok (de qualquer tipo) zera o recuo
      recuoN = 0;
      okNoPasso = true;
    }
    return r;
  }

  // T7e2: o aoMudar do drenar em curso (o porteiro grava o estado). Erro nele = 1 linha de log e o drenar segue.
  async function avisarMudanca() {
    if (!aoMudarAtual) return;
    try {
      const r = aoMudarAtual();
      if (r && typeof r.then === 'function') await r;
    } catch (err) {
      logar(`aoMudar falhou (${nomeErro(err)})`);
    }
  }

  // T7e2: todo message_id que o estado conhece (mensagens do bot, telas, apagar, citar e as do dono). So > 0 (o ensaio
  // usa negativos).
  function idsConhecidos(t) {
    const ids = new Set();
    const ver = (v) => {
      const n = idMensagem(v);
      if (n != null && n > 0) ids.add(n);
    };
    for (const k of Object.keys(t.mensagens)) ver(k);
    const verDono = (d) => {
      if (!ehObjeto(d)) return;
      if (ehObjeto(d.mensagem)) ver(d.mensagem.messageId);
      if (Array.isArray(d.apagar)) for (const a of d.apagar) if (ehObjeto(a)) ver(a.messageId);
      if (Array.isArray(d.apagarToque)) for (const id of d.apagarToque) ver(id); // T12: o /start do toque (do dono)
      if (ehObjeto(d.versao)) ver(d.versao.citar);
      ver(d.citar);
    };
    for (const c of Object.values(t.chamados)) verDono(c);
    verDono(t.sistema);
    verDono(t.painel);
    if (ehObjeto(t.painel.pergunta)) ver(t.painel.pergunta.messageId); // T29d: a pergunta da busca (do bot)
    if (Array.isArray(t.painel.apagarPergunta)) for (const id of t.painel.apagarPergunta) ver(id);
    verDono(t.situacao);
    if (Array.isArray(t.idsDoDono)) for (const id of t.idsDoDono) ver(id);
    for (const id of idsDeForaAtual) ids.add(id); // T7b2a: as mensagens de pedido de OK (nunca vao pra sonda)
    return ids;
  }

  // T7b2a: os ids de fora que o drenar recebeu (lista ou Set) -> Set so com ids validos (> 0).
  function conjuntoDeIds(v) {
    const lista = Array.isArray(v) ? v : v instanceof Set ? [...v] : [];
    const ids = new Set();
    for (const x of lista) {
      const n = idMensagem(x);
      if (n != null && n > 0) ids.add(n);
    }
    return ids;
  }

  // T7b2a (revisao, item 4): as janelas que o drenar recebeu -> [{desde, ate}] so com desde inteiro >= 0 e ate inteiro >
  // desde ou null (aberta); o resto e ignorado.
  function listaDeJanelas(v) {
    const lista = [];
    for (const j of Array.isArray(v) ? v : []) {
      if (!ehObjeto(j) || !Number.isSafeInteger(j.desde) || j.desde < 0) continue;
      if (j.ate == null) lista.push({ desde: j.desde, ate: null });
      else if (Number.isSafeInteger(j.ate) && j.ate > j.desde) lista.push({ desde: j.desde, ate: j.ate });
    }
    return lista;
  }
  const naJanelaDeFora = (id) => janelasDeForaAtual.some((j) => id > j.desde && (j.ate === null || id < j.ate));

  const maiorIdConhecido = (t) => {
    let maior = 0;
    for (const id of idsConhecidos(t)) if (id > maior) maior = id;
    return maior;
  };
  const desdeDe = (x) => (ehObjeto(x) && Number.isSafeInteger(x.desde) && x.desde >= 0 ? x.desde : null);

  // T22b (pedido do dono pelo Telegram: «A gente pode colocar os dois iguais»): o chamado da central sai com o
  // titulo da mensagem do sistema. ehCentral ausente, que lanca ou que nao devolve true = uma aba como as outras.
  function daCentral(sid, v) {
    if (typeof ehCentral !== 'function') return false;
    try {
      return ehCentral(sid, typeof v.titulo === 'string' ? v.titulo : null) === true;
    } catch {
      return false;
    }
  }

  // O que o drenar reconcilia: o chamado de uma aba ou a mensagem do sistema (mesmo passo a passo).
  function alvoAba(sid, c) {
    const v = c.versao;
    const central = daCentral(sid, v); // T22b
    return {
      sid,
      quem: `${sid} ${v.estado}`,
      dono: c,
      versaoId: v.id,
      estado: v.estado,
      // notificar vem do estado da versao ATUAL na hora do envio; T26b1: ou do OK que ainda nao apareceu (c.ok.notificar)
      silencioso: !NOVA_COM_NOTIFICACAO.has(v.estado) && !(ehObjeto(c.ok) && c.ok.notificar === true),
      citar: idMensagem(v.citar), // T7d1a (F1): mensagem nova sai em cima da fala do dono que a versao responde
      comOk: true, // T26b1: alvo que pode ter o c.ok (so o chamado de aba)
      montar: () => {
        const base = central ? { ...v, titulo: TITULO_SISTEMA, icone: ICONE_SISTEMA } : v;
        if (!ehObjeto(c.ok)) return montarChamado(base);
        // T26b1: sem html (sai sempre no classico). T26b2: okAberto = a mensagem leva o bloco aberto (o conserto 2)
        return { ...montarChamadoComOk(base, c.ok), okCod: c.ok.cod, okAberto: okAberto(c) };
      },
      // T26b2 (conserto 3, 'manter'): a tela antiga com a parte que ela mostrava (c.ok.tela; sem ela, so o cabecalho) e o
      // bloco fechado
      montarFechado: () => {
        const tela = ehObjeto(c.ok.tela) ? c.ok.tela : { ...v, estado: 'ok' };
        return montarChamadoComOk(central ? { ...tela, titulo: TITULO_SISTEMA, icone: ICONE_SISTEMA } : tela, c.ok);
      },
      versao: v, // T7k: o soltar le o liberar da versao que foi pra tela
      tituloMovido: central ? TITULO_SISTEMA : v.titulo,
      iconeMovido: central ? ICONE_SISTEMA : undefined, // T22b: o movido da central com o titulo do sistema
      versaoAtual: () => c.versao?.id,
      aoSair: () => {},
    };
  }

  function alvoSistema(t) {
    const s = t.sistema;
    if (s.mensagem !== null && !(ehObjeto(s.mensagem) && idMensagem(s.mensagem.messageId) != null)) s.mensagem = null;
    if (!Number.isSafeInteger(s.versaoId)) s.versaoId = ++t.seq;
    return {
      sid: SISTEMA,
      quem: SISTEMA,
      dono: s,
      versaoId: s.versaoId,
      estado: SISTEMA,
      silencioso: s.notificar !== true,
      citar: idMensagem(s.citar), // T7d1a (F1)
      falaFica: idMensagem(s.citar) != null && s.citarFica === true, // T30: a fala citada nao chegou a aba nenhuma
      montar: () => ({ ...montarSistema(s.linhas), botoes: null }),
      tituloMovido: TITULO_SISTEMA,
      iconeMovido: ICONE_SISTEMA, // o movido da do sistema com o titulo dela ("🎛️ Controle de Sessões")
      versaoAtual: () => s.versaoId,
      aoSair: () => {
        s.notificar = false;
        s.citar = null; // o reply ja saiu: a proxima linha sem citar nao cita de novo
        delete s.citarFica; // T30
      },
    };
  }

  // T9: o painel no mesmo passo a passo do sistema; sempre mensagem nova (descer), em silencio.
  function alvoPainel(t) {
    const p = t.painel;
    if (p.mensagem !== null && !(ehObjeto(p.mensagem) && idMensagem(p.mensagem.messageId) != null)) p.mensagem = null;
    return {
      sid: PAINEL,
      quem: PAINEL,
      dono: p,
      versaoId: p.versaoId,
      estado: PAINEL,
      silencioso: true,
      citar: idMensagem(p.citar),
      montar: () => ({ ...montarPainel(p.dados, { busca: p.busca?.palavra }), botoes: botoesPainel(p.busca?.palavra) }), // T29d
      tituloMovido: TITULO_PAINEL,
      versaoAtual: () => p.versaoId,
      aoSair: () => {
        p.citar = null;
      },
    };
  }

  // T10: a situacao no mesmo passo a passo do painel; a mensagem guarda a aba (resposta em cima dela vai pra aba).
  function alvoSituacao(t) {
    const s = t.situacao;
    if (s.mensagem !== null && !(ehObjeto(s.mensagem) && idMensagem(s.mensagem.messageId) != null)) s.mensagem = null;
    return {
      sid: SITUACAO,
      quem: SITUACAO,
      dono: s,
      versaoId: s.versaoId,
      estado: SITUACAO,
      silencioso: true,
      // T26d (regra 1): a tela do chamado da aba vai sair depois dela: sem citar (apontaria pra mensagem que some)
      citar: chamadoQueSaiPelaSituacao(t, s.aba) ? null : idMensagem(s.citar),
      aba: s.aba,
      montar: () => montarSituacao({ ...s.dados, chamadoId: s.chamadoId, completo: s.completo === true }), // T10c: com os botoes
      tituloMovido: TITULO_SITUACAO,
      versaoAtual: () => s.versaoId,
      aoSair: () => {
        s.citar = null;
      },
    };
  }

  // Resultado que nao deu certo e nao foi tratado antes: 429 = pausa (item fica, falhas nao conta); 400 (so o do enviar
  // chega aqui) = recusado (item sai); o resto = transporte (item fica no comeco, falhas + 1, marca a saude).
  function falhou(t, item, alvo, r, metodo) {
    const agoraMs = agora();
    if (ehPausa(r)) {
      const s = Number(r.esperarS);
      const esperaS = Number.isFinite(s) && s > 0 ? s : 1;
      pausaAte = agoraMs + esperaS * 1000;
      logar(`${alvo.quem}: limite do Telegram (429 no ${metodo}); pausa de ${esperaS} s, fica na fila`);
      return 'para';
    }
    if (r?.codigo === 400) {
      tirar(t.saida, item);
      logar(`${alvo.quem}: mensagem recusada pelo Telegram (${erroCurto(r)}); sai da fila`);
      return 'segue';
    }
    marcarEnvio(t, false, agoraMs);
    item.falhas = (Number(item.falhas) || 0) + 1;
    if (item.falhas === 1 || item.falhas % LOG_A_CADA === 0) {
      logar(`${alvo.quem}: ${metodo} falhou (${item.falhas}x): ${erroCurto(r)}; fica na fila`);
    }
    return 'para';
  }

  // T7e2: o item fica incerto (o envio pode ter chegado) com o desde mais antigo; 1 linha de log.
  function ficarIncerto(item, alvo, desde, motivo) {
    const antes = desdeDe(item.incerto);
    item.incerto = { desde: antes == null ? desde : Math.min(antes, desde) };
    logar(`${alvo.quem}: envio incerto (${motivo}): pode ter chegado; confere antes de apagar (ids depois de ${item.incerto.desde})`);
  }

  // T7e2: o reenvio saiu com o id n depois de envio incerto (desde): os ids entre os 2 que o estado nao conhece (nem do
  // bot, nem de tela, nem do dono) podem ser a mensagem que chegou sem resposta. Sonda ligada = vao pro comeco do
  // apagar do dono como {sondar: true} (em ordem); desligada, desde < 1 ou mais de 20 = so log.
  function depoisDoIncerto(t, d, alvo, desde, n) {
    const conhecidos = idsConhecidos(t);
    // T7b2a (revisao, item 4): o id desconhecido na janela de um pedido de OK incerto pode ser a mensagem do pedido: conta
    // como conhecido aqui (fica no chat, nunca vai pra sonda), com 1 linha de log
    const naJanela = [];
    if (desde >= 1 && janelasDeForaAtual.length) {
      for (let i = desde + 1; i < n; i += 1) if (!conhecidos.has(i) && naJanelaDeFora(i)) naJanela.push(i);
    }
    for (const i of naJanela) conhecidos.add(i);
    if (naJanela.length) {
      logar(`${alvo.quem}: ${naJanela.length} id(s) entre ${desde} e ${n} na janela de um pedido de OK (envio incerto do pedido): ficam no chat sem sondar`);
    }
    let dentro = 0;
    for (const c of conhecidos) if (c > desde && c < n) dentro += 1;
    const k = Math.max(0, n - desde - 1 - dentro);
    const lista = [];
    if (desde >= 1 && k <= MAX_SONDA) for (let i = desde + 1; i < n; i += 1) if (!conhecidos.has(i)) lista.push(i);
    if (!sondaLigada) {
      const ids = lista.length ? `: ${lista.join(', ')}` : '';
      logar(`${alvo.quem}: mensagem ${n} enviada depois de envio incerto; ${k} id(s) desconhecido(s) entre ${desde} e ${n} ficam no chat (sonda desligada)${ids}`);
      return;
    }
    if (desde < 1 || k > MAX_SONDA) {
      logar(`${alvo.quem}: ${k} ids desconhecidos entre ${desde} e ${n}: nao sondo nenhum (mais de 20 ou sem base)`);
      return;
    }
    d.apagar.unshift(...lista.map((id) => ({ messageId: id, sondar: true })));
    logar(`${alvo.quem}: mensagem ${n} enviada depois de envio incerto; ${k} id(s) desconhecido(s) entre ${desde} e ${n} vao pra sonda`);
  }

  // T7k: a versao do `alvo` com `liberar` ficou na tela (mensagem nova enviada ou edicao ok): cada fala sai do
  // `esperando` de todo chamado calado, 1 vez (o liberar some da versao). Esperando vazio = a tela do calado vai pro
  // comeco do apagar e a aba entra na fila (o passoSemTela apaga em ordem e o chamado sai, como o calado de antes).
  function soltar(t, alvo) {
    const v = alvo.versao;
    if (!ehObjeto(v) || v.liberar === undefined) return;
    const falas = idsDeFala(v.liberar);
    delete v.liberar;
    if (!falas.length) return;
    for (const sid of Object.keys(t.chamados)) {
      const c = chamadoDe(t, sid);
      if (!c || c.versao.estado !== CALADO || !Array.isArray(c.esperando)) continue;
      const resto = c.esperando.filter((x) => !falas.includes(x));
      if (resto.length === c.esperando.length) continue;
      if (resto.length) {
        c.esperando = resto;
        continue;
      }
      delete c.esperando;
      if (c.mensagem !== null) {
        const id = c.mensagem.messageId;
        c.apagar.unshift({ messageId: id, doBot: true, formato: formatoDe(c.mensagem.formato) });
        c.mensagem = null;
        logar(`${sid}: a resposta de ${alvo.sid} chegou; a tela ${id} vai pro apagar`);
      }
      c.mudouEm = agoraIso();
      enfileirar(t, sid);
    }
  }

  async function enviarNova(t, item, alvo, m, resumo) {
    const d = alvo.dono;
    const pedido = { html: m.html, classico: m.classico, botoes: m.botoes ?? null, silencioso: alvo.silencioso };
    if (alvo.citar != null) pedido.responderA = alvo.citar; // T7d1a (F1): o citar do alvo (a chave velha do estado antigo e ignorada)
    // T7e2: marca `envio` que voltou do disco = o porteiro parou no meio de um envio (pode ter chegado) = incerto
    const marcaVelha = desdeDe(item.envio);
    if (marcaVelha != null) ficarIncerto(item, alvo, marcaVelha, 'o porteiro parou no meio do envio');
    // T7e2: antes do pedido, a marca (maior id conhecido, ou o desde do incerto em aberto) vai pro disco (aoMudar)
    const desde = desdeDe(item.incerto) ?? maiorIdConhecido(t);
    item.envio = { desde };
    await avisarMudanca();
    const r = await chamar(t, 'enviar', { sessionId: alvo.sid, estado: alvo.estado, pedido }, resumo);
    delete item.envio;
    if (r.ok !== true) {
      if (r.incerto === true) { // T7e2: pode ter chegado: nada de reenviar as cegas (recuo) e o reenvio confere o chat
        ficarIncerto(item, alvo, desde, erroCurto(r));
        const agoraMs = agora();
        recuoN += 1;
        recuoAte = agoraMs + RECUO_MS[Math.min(recuoN, RECUO_MS.length) - 1];
        marcarEnvio(t, false, agoraMs);
        item.falhas = (Number(item.falhas) || 0) + 1;
        return 'para';
      }
      return falhou(t, item, alvo, r, 'enviar');
    }
    const id = idMensagem(r.messageId);
    if (id == null) {
      tirar(t.saida, item);
      logar(`${alvo.quem}: enviada sem message_id; sai da fila`);
      return 'segue';
    }
    const formato = formatoDe(r.formato);
    const antiga = d.mensagem;
    // so agora (a nova saiu) a que estava na tela vai pro COMECO do apagar. T26d (regra 3): a situacao substituida de
    // uma aba sem chamado com tela fica (sem os botoes) como mensagem da aba
    const viraDaAba = antiga !== null && alvo.sid === SITUACAO && situacaoViraDaAba(t, d, antiga, alvo.aba);
    if (antiga !== null && !viraDaAba) d.apagar.unshift({ messageId: antiga.messageId, doBot: true, formato: formatoDe(antiga.formato) });
    d.mensagem = { messageId: id, formato, versaoId: alvo.versaoId };
    if (m.okCod != null) { // T26b1: a tela mostra o OK; o 1o envio dele desliga o notificar e marca o naTelaEm
      d.mensagem.ok = m.okCod;
      if (ehObjeto(d.ok) && d.ok.cod === m.okCod) {
        d.ok.notificar = false;
        if (!d.ok.naTelaEm) d.ok.naTelaEm = agoraIso();
      }
    }
    soltar(t, alvo); // T7k
    // T7f (F8): a tela antiga e as herdadas ja estao no apagar: nao precisam perder os botoes. T26d: o tirarBotoes da
    // situacao e o da regra 3 (as substituidas que ficam): fica
    if (alvo.sid !== SITUACAO) delete d.tirarBotoes;
    t.mensagens[id] = { sessionId: alvo.sid, at: agoraIso(), formato };
    if (alvo.sid === SITUACAO) t.mensagens[id].aba = alvo.aba; // T10
    // T29b: a situacao sem pergunta leva a marca (vale tambem quando ela fica como mensagem da aba, T26d regra 3)
    if (alvo.sid === SITUACAO && situacaoSemNada(d.dados)) t.mensagens[id].semNada = true;
    const citou = idMensagem(pedido.responderA); // T23a: a fala do dono em cima da qual ela saiu (a conversa dela)
    if (citou != null) t.mensagens[id].citar = citou;
    if (citou != null && alvo.falaFica === true) t.mensagens[id].falaFica = true; // T30: a recusa (a fala fica no chat)
    if (alvo.sid === SITUACAO) { // T26d: regra 1 (a tela do chamado da aba sai depois) e regra 3 (as ex-situacoes dela)
      telaSaiPelaSituacao(t, alvo.aba);
      exSituacaoProApagar(t, d, alvo.aba, id);
    } else if (alvo.comOk === true) { // T26d: regra 2 (a situacao da aba sai depois) e regra 3
      delete d.naSituacao;
      situacaoSaiPelaAba(t, alvo.sid);
      exSituacaoProApagar(t, d, alvo.sid, id);
    }
    if (alvo.versaoAtual() === alvo.versaoId) {
      d.descer = false;
      alvo.aoSair();
    }
    logar(`${alvo.quem}: mensagem ${id} enviada (${formato}${alvo.silencioso ? ', silenciosa' : ', com notificacao'})`);
    // T26b2 (conserto 2): o OK fechou com ela em voo = a tela e editada (descer desliga: a mensagem nova ja saiu) ou sai
    if (m.okCod != null && m.okAberto === true) okDepoisDoEnvio(t, alvo, d, m.okCod, d.mensagem, false);
    const incerto = desdeDe(item.incerto);
    if (incerto != null) {
      delete item.incerto;
      depoisDoIncerto(t, d, alvo, incerto, id);
    }
    return 'segue';
  }

  async function editarTela(t, item, alvo, m, resumo) {
    const d = alvo.dono;
    const tela = d.mensagem;
    const pedido = { html: m.html, classico: m.classico, botoes: m.botoes ?? null, formato: formatoDe(tela.formato) };
    const r = await chamar(t, 'editar', { sessionId: alvo.sid, estado: alvo.estado, messageId: tela.messageId, pedido }, resumo);
    if (r.ok === true) {
      tela.versaoId = alvo.versaoId;
      if (m.okCod != null || tela.ok != null) { // T26b1: a edicao poe os botoes certos: a tela sai do tirarBotoes
        semTirarBotoes(d, tela.messageId);
        if (m.okCod != null) tela.ok = m.okCod;
        else delete tela.ok;
      }
      const reg = t.mensagens[idMensagem(tela.messageId)]; // T29b: a edicao vinda da aba/porteiro renova a hora na tela
      if (ehObjeto(reg) && reg.porToque !== alvo.versaoId) reg.vistaEm = agoraIso();
      soltar(t, alvo); // T7k
      logar(`${alvo.quem}: mensagem ${tela.messageId} editada`);
      // T26b2 (conserto 2): o OK fechou com a edicao em voo (o descer fica como esta)
      if (m.okCod != null && m.okAberto === true && d.mensagem === tela) okDepoisDoEnvio(t, alvo, d, m.okCod, tela, d.descer === true);
      return 'segue';
    }
    if (r.codigo === 400 && !ehPausa(r) && alvo.sid === PAINEL) {
      // T12 (contrato 3): so o painel vivo edita o painel; recusada (o dono apagou a mensagem) = o painel sai do estado e
      // nao volta como mensagem nova (so no /painel)
      d.mensagem = null;
      d.dados = null;
      tirar(t.saida, item);
      logar(`${alvo.quem}: edicao da mensagem ${tela.messageId} recusada (${erroCurto(r)}); o painel sai (volta no /painel)`);
      return 'segue';
    }
    if (r.codigo === 400 && !ehPausa(r)) {
      d.descer = true; // edicao recusada = mensagem nova na hora (a antiga vai pro apagar)
      logar(`${alvo.quem}: edicao da mensagem ${tela.messageId} recusada (${erroCurto(r)}); vai como mensagem nova`);
      return 'segue';
    }
    return falhou(t, item, alvo, r, 'editar');
  }

  // Mensagem do bot com mais de 48 h (nao da pra apagar): vira 1 linha "chamado movido pra baixo" no formato dela.
  async function moverVelha(t, item, alvo, a, id, resumo) {
    const d = alvo.dono;
    const m = montarChamado({ estado: 'movido', titulo: alvo.tituloMovido, icone: alvo.iconeMovido });
    const pedido = { html: m.html, classico: m.classico, botoes: null, formato: formatoDe(a.formato) };
    const r = await chamar(t, 'editar', { sessionId: alvo.sid, estado: 'movido', messageId: id, pedido }, resumo);
    if (r.ok === true) {
      if (ehObjeto(t.mensagens[id])) t.mensagens[id].movido = true;
      tirar(d.apagar, a);
      logar(`${alvo.sid}: mensagem ${id} com mais de 48 h editada pra "movido"`);
      return 'segue';
    }
    if (r.codigo === 400 && !ehPausa(r)) {
      tirar(d.apagar, a);
      logar(`${alvo.sid}: mensagem ${id} com mais de 48 h: edicao pra "movido" recusada (${erroCurto(r)}); sai da lista`);
      return 'segue';
    }
    return falhou(t, item, alvo, r, 'editar');
  }

  // T7e2: a sonda de 1 id desconhecido ({sondar: true}, o 1o do apagar). Desligada = sai da lista sem chamar a API;
  // adaptador sem editarBotoes = sai sem apagar. Senao editarBotoes(id, null): ok (ou "message is not modified") = do
  // bot, vira {doBot: true} no mesmo lugar e e apagada no passo seguinte; 400 = nao e do bot ou sumiu (sai, fica no
  // chat); 429 e transporte = fica (falhou).
  async function sondarPrimeira(t, item, alvo, a, id, resumo) {
    const d = alvo.dono;
    if (!sondaLigada) {
      tirar(d.apagar, a);
      logar(`${alvo.sid}: id ${id} fica no chat (sonda desligada); sai da lista sem apagar`);
      return 'segue';
    }
    if (!emEnsaio && typeof tg.editarBotoes !== 'function') {
      tirar(d.apagar, a);
      logar(`${alvo.sid}: id ${id} nao e do bot ou sumiu (sonda: adaptador sem editarBotoes); fica no chat`);
      return 'segue';
    }
    const r = await chamar(t, 'sondar', { sessionId: alvo.sid, messageId: id }, resumo);
    if (r.ok === true || /message is not modified/i.test(String(r?.erro ?? ''))) {
      const i = d.apagar.indexOf(a);
      if (i >= 0) d.apagar[i] = { messageId: id, doBot: true };
      if (i >= 0 && mantemResolvidas) d.apagar[i].duplicata = true; // T23b: a duplicata provada sai tambem no 'manter'
      logar(`${alvo.sid}: id ${id} e do bot (sonda): vai pro apagar`);
      return 'segue';
    }
    if (r.codigo === 400 && !ehPausa(r)) {
      tirar(d.apagar, a);
      logar(`${alvo.sid}: id ${id} nao e do bot ou sumiu (sonda: ${erroCurto(r)}); fica no chat`);
      return 'segue';
    }
    return falhou(t, item, alvo, r, 'sondar');
  }

  // T23a (modo 'apagar'): a mensagem `id` do robo saiu do chat (apagada, ou ja tinha sumido). O registro dela e lido antes
  // de sair do t.mensagens: com `citar` X, X no anel (idsDoDono) e nenhum outro registro sem `voz` com `citar` X (a ultima
  // mensagem do robo em cima de X saiu) = a conversa de X se resolveu: as vozes com `citar` X e depois o X entram no
  // COMECO do `limpar` do dono `d` (o mesmo alvo), nessa ordem, sem repetir id que ja esteja na lista. Senao, nada.
  function conversaResolvida(t, d, id, entrada) {
    if (!limpaResolvidas) return;
    if (ehObjeto(entrada) && entrada.manterConversa === true) return; // T26b2: a tela do OK com a fala dele em voo
    const registro = t.mensagens[id];
    if (ehObjeto(registro) && registro.falaFica === true) return; // T30: a fala recusada (nao chegou a aba nenhuma) fica
    const x = ehObjeto(registro) ? idMensagem(registro.citar) : null;
    if (x == null || !Array.isArray(t.idsDoDono) || !t.idsDoDono.includes(x)) return;
    const vozes = [];
    for (const [k, m] of Object.entries(t.mensagens)) {
      const n = idMensagem(k);
      if (n == null || n === id || !ehObjeto(m) || idMensagem(m.citar) !== x) continue;
      if (m.voz !== true) return; // outra mensagem do robo ainda em cima de X
      vozes.push(n);
    }
    const lista = Array.isArray(d.limpar) ? d.limpar : [];
    const ja = new Set(lista.map((a) => (ehObjeto(a) ? idMensagem(a.messageId) : null)));
    const novos = [...vozes.map((n) => ({ messageId: n, voz: true })), { messageId: x, dono: true }].filter((a) => !ja.has(a.messageId));
    if (novos.length) d.limpar = [...novos, ...lista];
  }

  async function apagarPrimeira(t, item, alvo, resumo) {
    const d = alvo.dono;
    const a = d.apagar[0];
    const id = ehObjeto(a) ? idMensagem(a.messageId) : null;
    if (id == null) {
      tirar(d.apagar, a);
      return 'segue';
    }
    // T7b2a: mensagem de pedido de OK (de fora do canal) nunca e sondada nem apagada: sai da lista sem chamar a API
    if (idsDeForaAtual.has(id)) {
      tirar(d.apagar, a);
      logar(`${alvo.sid}: mensagem ${id} e de um pedido de OK; sai da lista sem sondar nem apagar`);
      return 'segue';
    }
    // T7b2a (revisao, item 4): id de envio incerto ({sondar}) na janela de um pedido de OK incerto pode ser a mensagem do
    // pedido (a sonda acharia "do bot" e apagaria): sai da lista sem chamar a API. {doBot} (do canal) segue o de sempre.
    if (a.sondar === true && naJanelaDeFora(id)) {
      tirar(d.apagar, a);
      logar(`${alvo.sid}: id ${id} esta na janela de um pedido de OK; sai da lista sem sondar nem apagar`);
      return 'segue';
    }
    // T7e2 (F1): id de envio incerto ({sondar: true}) nunca e apagado direto: so depois da prova da sonda
    if (a.sondar === true) return sondarPrimeira(t, item, alvo, a, id, resumo);
    // T7d1a (F1): so mensagem do bot e apagada. A do dono (o estado.json de antes e o herdar) sai da lista sem chamar a API.
    if (a.doBot !== true) {
      tirar(d.apagar, a);
      logar(`${alvo.sid}: mensagem ${id} do dono fica no chat (F1); sai da lista sem apagar`);
      return 'segue';
    }
    // T23b ('manter'): a do robo fica no chat e so perde os botoes; a duplicata provada pela sonda e apagada como antes
    if (mantemResolvidas && a.duplicata !== true) return ficarSemBotoes(t, item, alvo, id, resumo, () => tirar(d.apagar, a));
    const r = await chamar(t, 'apagar', { sessionId: alvo.sid, messageId: id }, resumo);
    if (r.ok === true) { // apagada, ou ja tinha sumido
      tirar(d.apagar, a);
      conversaResolvida(t, d, id, a); // T23a: a versao nova, o calado e as sobras (o registro e lido antes de sair)
      delete t.mensagens[id];
      if (a.vista === true) logar(`${alvo.sid}: mensagem ${id} apagada (vista e sem nada pra você)`); // T29b
      return 'segue';
    }
    if (r.velha === true && a.vista === true) { // T29b: a vista com 48 h fica no chat como esta (nunca vira "movido")
      tirar(d.apagar, a);
      logar(`${alvo.sid}: mensagem ${id} fica no chat (mais de 48 h)`);
      return 'segue';
    }
    if (r.velha === true) {
      if (a.doBot === true) return moverVelha(t, item, alvo, a, id, resumo);
      tirar(d.apagar, a); // a do dono com mais de 48 h fica no chat
      return 'segue';
    }
    if (r.codigo === 400 && !ehPausa(r)) {
      tirar(d.apagar, a);
      logar(`${alvo.sid}: apagar ${id} recusado (${erroCurto(r)}); sai da lista`);
      return 'segue';
    }
    return falhou(t, item, alvo, r, 'apagar');
  }

  // T7f (F8): tira os botoes da 1a mensagem de `tirarBotoes` (editMessageReplyMarkup: o texto fica e nao notifica). Ok
  // (inclusive "not modified": ja estava sem botoes) = sai da lista; adaptador sem editarBotoes ou 400 = sai com 1 linha
  // de log; 429 e transporte = fica (falhou). A lista vazia some do chamado.
  async function tirarBotoesPrimeira(t, item, alvo, resumo) {
    const d = alvo.dono;
    const id = idMensagem(d.tirarBotoes[0]);
    const sair = (msg) => {
      d.tirarBotoes.shift();
      if (!d.tirarBotoes.length) delete d.tirarBotoes;
      if (msg) logar(`${alvo.sid}: ${msg}`);
      return 'segue';
    };
    if (id == null) return sair(null);
    if (!emEnsaio && typeof tg.editarBotoes !== 'function') return sair(`mensagem ${id} fica com os botoes (adaptador sem editarBotoes)`);
    const r = await chamar(t, 'tirarBotoes', { sessionId: alvo.sid, messageId: id }, resumo);
    if (r.ok === true) return sair(`mensagem ${id} sem os botoes (a fala dele foi pra aba)`);
    if (r.codigo === 400 && !ehPausa(r)) return sair(`tirar os botoes da mensagem ${id} recusado (${erroCurto(r)}); sai da lista`);
    return falhou(t, item, alvo, r, 'editarBotoes');
  }

  // T23b (modo 'manter', PLANO-TELEGRAM.md "T23"): no lugar de apagar a mensagem `id` do robo (a tela tocada numa opcao,
  // a antiga depois da versao nova, o calado e as sobras), ela so perde os botoes (a acao do tirarBotoesPrimeira) e fica
  // no chat; nunca vira "movido" (a de 48 h tambem so perde os botoes). Ok (inclusive "not modified"), 400 e adaptador
  // sem editarBotoes = sai da lista (`tirarDaLista`), o registro (so se existe) ganha `fica: true` (o sobrasDaAba pula)
  // e 1 log; 429 e transporte = fica na lista (falhou) e tenta de novo. Nada vai pro `limpar`.
  async function ficarSemBotoes(t, item, alvo, id, resumo, tirarDaLista) {
    const ficou = (msg) => {
      tirarDaLista();
      if (ehObjeto(t.mensagens[id])) t.mensagens[id].fica = true;
      logar(`${alvo.sid}: ${msg}`);
      return 'segue';
    };
    if (!emEnsaio && typeof tg.editarBotoes !== 'function') return ficou(`mensagem ${id} fica no chat com os botoes (adaptador sem editarBotoes)`);
    const r = await chamar(t, 'tirarBotoes', { messageId: id, sessionId: alvo.sid }, resumo); // editarBotoes(id, null)
    const semBotoes = r.ok === true || /message is not modified/i.test(String(r?.erro ?? '')); // "not modified" = ja estava
    if (semBotoes) return ficou(`mensagem ${id} fica no chat sem os botoes (modo manter)`);
    if (r.codigo !== 400 || ehPausa(r)) return falhou(t, item, alvo, r, 'editarBotoes'); // 429 e transporte: tenta de novo
    return ficou(`tirar os botoes da mensagem ${id} recusado (${erroCurto(r)}); fica no chat`);
  }

  // T7j: apaga a 1a mensagem de `apagarJa` (a tela que o dono tocou numa opcao). Id invalido = sai. Id de pedido de OK
  // (idsDeFora) = sai sem chamar a API (1 log). Ok (inclusive jaSumiu) = sai e deixa de ser mensagem do bot no chat;
  // velha (48 h) ou 400 = vai pro tirarBotoes (perde os botoes, o caminho de hoje) e sai, 1 log; 429 e transporte = fica
  // (falhou). A lista vazia some do chamado.
  // T23b ('manter'): nada e apagado; a tela tocada so perde os botoes (ficarSemBotoes) e a resposta desce como nova.
  async function apagarJaPrimeira(t, item, alvo, resumo) {
    const d = alvo.dono;
    const id = idMensagem(d.apagarJa[0]);
    const sair = (msg) => {
      d.apagarJa.shift();
      if (!d.apagarJa.length) delete d.apagarJa;
      if (msg) logar(`${alvo.sid}: ${msg}`);
      return 'segue';
    };
    if (id == null) return sair(null);
    if (idsDeForaAtual.has(id)) return sair(`mensagem ${id} e de um pedido de OK; sai do apagarJa sem apagar`);
    if (mantemResolvidas) return ficarSemBotoes(t, item, alvo, id, resumo, () => sair(null)); // T23b: a tela tocada fica, sem os botoes
    const r = await chamar(t, 'apagar', { sessionId: alvo.sid, messageId: id }, resumo);
    if (r.ok === true) {
      conversaResolvida(t, d, id); // T23a: o toque numa opcao (o registro e lido antes de sair)
      delete t.mensagens[id];
      return sair(`mensagem ${id} apagada (o dono tocou numa opcao)`);
    }
    if (r.velha === true || (r.codigo === 400 && !ehPausa(r))) {
      marcarTirarBotoes(d, id);
      return sair(`apagar ${id} recusado (${r.velha === true ? 'mais de 48 h' : erroCurto(r)}); fica sem os botoes`);
    }
    return falhou(t, item, alvo, r, 'apagar');
  }

  // T29d: a pergunta da busca no passo do painel, antes de tudo dele: primeiro o apagar dela (nos 2 modos; ok, 48 h ou
  // 400 = sai da lista; 429 e transporte = fica), depois o envio da pedida (resposta forcada, em silencio). Envio ok = a
  // pergunta na tela; 400 ou incerto = a pergunta sai sem repetir (1 log). null = nada a fazer aqui.
  async function passoDaPergunta(t, item, resumo, agoraMs) {
    const p = t.painel;
    const apagar = Array.isArray(p.apagarPergunta) && p.apagarPergunta.length > 0;
    const enviar = ehObjeto(p.pergunta) && p.pergunta.messageId == null;
    if (!apagar && !enviar) return null;
    if (agoraMs < pausaAte || agoraMs < recuoAte) return 'para';
    const alvo = { sid: PAINEL, quem: PAINEL };
    if (apagar) {
      const id = idMensagem(p.apagarPergunta[0]);
      const sair = (msg) => {
        p.apagarPergunta.shift();
        if (!p.apagarPergunta.length) delete p.apagarPergunta;
        if (msg) logar(`${PAINEL}: ${msg}`);
        return 'segue';
      };
      if (id == null) return sair(null);
      const r = await chamar(t, 'apagar', { sessionId: PAINEL, messageId: id }, resumo);
      if (r.ok === true) return sair(`pergunta da busca ${id} apagada`);
      if (r.velha === true || (r.codigo === 400 && !ehPausa(r))) return sair(`apagar a pergunta da busca ${id} recusado (${r.velha === true ? 'mais de 48 h' : erroCurto(r)}); fica no chat`);
      return falhou(t, item, alvo, r, 'apagar');
    }
    const pedido = { classico: PERGUNTA_BUSCA, respostaForcada: EXEMPLO_BUSCA, silencioso: true };
    const r = await chamar(t, 'enviar', { sessionId: PAINEL, estado: 'busca', pedido }, resumo);
    const id = r.ok === true ? idMensagem(r.messageId) : null;
    if (id != null) {
      p.pergunta.messageId = id;
      logar(`${PAINEL}: pergunta da busca enviada (mensagem ${id})`);
      return 'segue';
    }
    if (r.ok === true || r.incerto === true || (r.codigo === 400 && !ehPausa(r))) {
      delete p.pergunta;
      logar(`${PAINEL}: a pergunta da busca nao saiu (${r.ok === true ? 'sem message_id' : erroCurto(r)}); sai sem repetir`);
      return 'segue';
    }
    return falhou(t, item, alvo, r, 'enviar');
  }

  // T12 (contrato 1): apaga a 1a mensagem de `apagarToque` (o "/start" do toque no nome da aba no painel: mensagem do
  // dono). Id invalido = sai. Id de pedido de OK (idsDeFora) = sai sem chamar a API (1 log). Ok (inclusive ja sumiu) = sai;
  // velha (48 h) ou 400 = fica no chat e sai da lista (1 log); 429 e transporte = fica (falhou). A lista vazia some.
  async function apagarToquePrimeira(t, item, alvo, resumo) {
    const d = alvo.dono;
    const id = idMensagem(d.apagarToque[0]);
    const sair = (msg) => {
      d.apagarToque.shift();
      if (!d.apagarToque.length) delete d.apagarToque;
      if (msg) logar(`${alvo.sid}: ${msg}`);
      return 'segue';
    };
    if (id == null || id < 0) return sair(null);
    if (idsDeForaAtual.has(id)) return sair(`mensagem ${id} e de um pedido de OK; sai do apagarToque sem apagar`);
    const r = await chamar(t, 'apagar', { sessionId: alvo.sid, messageId: id }, resumo);
    if (r.ok === true) return sair(`mensagem ${id} do dono apagada (o /start do toque no painel)`);
    if (r.velha === true || (r.codigo === 400 && !ehPausa(r))) {
      return sair(`apagar ${id} recusado (${r.velha === true ? 'mais de 48 h' : erroCurto(r)}); o /start fica no chat`);
    }
    return falhou(t, item, alvo, r, 'apagar');
  }

  // T23a: apaga a 1a mensagem do `limpar` (a conversa resolvida: a voz do robo ou a fala do dono). Entrada torta (id
  // invalido) = sai. Modo 'manter' (lista que voltou do disco) = sai sem chamar a API (1 log). Id de pedido de OK
  // (idsDeFora) = sai sem chamar a API (1 log). Ok (inclusive ja sumiu) = sai (a voz sai do t.mensagens); velha (48 h) =
  // fica no chat e sai (nunca vira "movido"); 400 = fica no chat e sai (1 log); 429 e transporte = fica (falhou). A lista
  // vazia some do alvo.
  async function limparPrimeira(t, item, alvo, resumo) {
    const d = alvo.dono;
    const a = d.limpar[0];
    const id = ehObjeto(a) && (a.voz === true) !== (a.dono === true) ? idMensagem(a.messageId) : null;
    const tirarDoLimpar = (msg) => {
      d.limpar.shift();
      if (!d.limpar.length) delete d.limpar;
      if (msg) logar(`${alvo.sid}: ${msg}`);
      return 'segue';
    };
    if (id == null) return tirarDoLimpar(null);
    const qual = a.voz === true ? `voz ${id}` : `mensagem ${id} do dono`;
    if (!limpaResolvidas) return tirarDoLimpar(`${qual} fica no chat (modo manter)`);
    if (idsDeForaAtual.has(id)) return tirarDoLimpar(`mensagem ${id} e de um pedido de OK; sai do limpar sem apagar`);
    const r = await chamar(t, 'apagar', { sessionId: alvo.sid, messageId: id }, resumo);
    if (r.ok === true) {
      if (a.voz === true) delete t.mensagens[id];
      return tirarDoLimpar(`${qual} apagada (conversa resolvida)`);
    }
    if (r.velha === true) return tirarDoLimpar(`${qual} fica no chat (mais de 48 h)`);
    if (r.codigo === 400 && !ehPausa(r)) return tirarDoLimpar(`apagar ${id} recusado (${erroCurto(r)}); fica no chat`);
    return falhou(t, item, alvo, r, 'apagar');
  }

  // T7f (F8): enviando/entregue nao poem nada na tela: so tiram os botoes do chamado que o dono respondeu (o apagar espera
  // a proxima mensagem nova, como antes); o calado apaga em ordem o que era dele e o chamado sai.
  // T7k: o calado que espera a resposta da aba de destino (esperando com item) sai da fila sem chamar a API (nada apagado).
  // Revisao da T7k1: com `tirarBotoes` com item (a fala dele chegou e o drenar ainda nao tinha rodado) a tela que espera
  // perde os botoes antes (edicao; nada apagado); `tirarBotoes` vazio = o item sai da fila sem chamar a API.
  async function passoSemTela(t, item, alvo, resumo) {
    const d = alvo.dono;
    if (alvo.estado === CALADO) {
      if (Array.isArray(d.esperando) && d.esperando.length) {
        if (Array.isArray(d.tirarBotoes) && d.tirarBotoes.length) return tirarBotoesPrimeira(t, item, alvo, resumo);
        tirar(t.saida, item);
        return 'segue';
      }
      if (d.apagar.length) return apagarPrimeira(t, item, alvo, resumo);
      tirar(t.saida, item);
      if (t.chamados[alvo.sid] === d) delete t.chamados[alvo.sid];
      logar(`${alvo.sid}: chamado calado saiu`);
      return 'segue';
    }
    if (Array.isArray(d.tirarBotoes) && d.tirarBotoes.length) return tirarBotoesPrimeira(t, item, alvo, resumo);
    // T26b1: a tela do OK que sumiu com a fala dele em voo (okFechou some) sai agora; o resto do apagar espera como antes
    if (d.apagar.length && ehObjeto(d.apagar[0]) && d.apagar[0].manterConversa === true) return apagarPrimeira(t, item, alvo, resumo);
    tirar(t.saida, item);
    return 'segue';
  }

  // T26b2: a tela trancada (o OK aberto, tocado, na tela) nunca e apagada nem reescrita: o passo so tira os botoes e
  // apaga o que esta no apagar (que nunca e ela: se aparecer, sai da lista sem apagar); o resto espera e o item sai da
  // fila (1 log quando ha mensagem esperando). O okFechou e o okToque(null) poem a aba de volta na fila.
  async function passoTrancado(t, item, alvo, resumo, emDia) {
    const d = alvo.dono;
    const tela = idMensagem(d.mensagem.messageId);
    if (Array.isArray(d.tirarBotoes) && d.tirarBotoes.length) return tirarBotoesPrimeira(t, item, alvo, resumo);
    if (d.apagar.length) {
      const a = d.apagar[0];
      if (ehObjeto(a) && idMensagem(a.messageId) === tela) {
        tirar(d.apagar, a);
        logar(`${alvo.sid}: a mensagem ${tela} e a tela trancada do OK ${d.ok.cod}; sai do apagar sem apagar`);
        return 'segue';
      }
      return apagarPrimeira(t, item, alvo, resumo);
    }
    tirar(t.saida, item);
    if (!emDia && (d.descer === true || d.mensagem.versaoId !== alvo.versaoId)) {
      logar(`${alvo.quem}: a tela ${tela} esta trancada (OK ${d.ok.cod} tocado); a mensagem nova espera o fecho`);
    }
    return 'segue';
  }

  // T26b2 (conserto 3, modo 'manter'): o OK fechou com a mensagem nova pendente e a tela antiga ainda o mostra aberto:
  // ela e EDITADA pro bloco fechado (com a parte que mostrava, sem botoes) e fica no chat (`fica: true`; nada de
  // tirar-botoes depois); a mensagem nova sai no proximo passo. Montagem torta ou 400 = o caminho da T26b1 (o c.ok sai e
  // a tela antiga so perde os botoes); 429 e transporte = fica (falhou).
  async function fecharTelaAntiga(t, item, alvo, resumo) {
    const d = alvo.dono;
    const tela = d.mensagem;
    const cod = d.ok.cod;
    let m = null;
    try {
      m = alvo.montarFechado();
    } catch {
      m = null;
    }
    if (m) {
      const pedido = { html: undefined, classico: m.classico, botoes: null, formato: formatoDe(tela.formato) };
      const r = await chamar(t, 'editar', { sessionId: alvo.sid, estado: alvo.estado, messageId: tela.messageId, pedido }, resumo);
      if (r.ok === true) {
        semTirarBotoes(d, tela.messageId);
        if (ehObjeto(t.mensagens[tela.messageId])) t.mensagens[tela.messageId].fica = true;
        d.mensagem = null;
        logar(`${alvo.sid}: mensagem ${tela.messageId} fica no chat com o OK ${cod} fechado (modo manter)`);
        return 'segue';
      }
      if (r.codigo !== 400 || ehPausa(r)) return falhou(t, item, alvo, r, 'editar');
    }
    delete d.ok;
    if (alvo.estado === 'ok') okSaiComoCalado(t, alvo.sid, d);
    logar(`${alvo.sid}: a mensagem ${tela.messageId} nao virou o OK ${cod} fechado; segue sem o bloco`);
    return 'segue';
  }

  // (1) tela: sem mensagem ou descer = mensagem nova; versao diferente da tela = edicao no formato dela.
  // (2) so com a tela em dia: o apagar em ordem. Tudo em dia = o item sai da fila. No maximo 1 acao por passo.
  // T7f (F8): enviando, entregue e calado = passoSemTela (nenhuma mensagem nova nem edicao do texto).
  // T7j: o apagarJa com item vem antes de tudo, nos dois caminhos (antes do apagar do calado, do tirarBotoes, da mensagem
  // nova e da edicao).
  async function passoDoAlvo(t, item, alvo, resumo) {
    const d = alvo.dono;
    if (Array.isArray(d.apagarToque) && d.apagarToque.length) return apagarToquePrimeira(t, item, alvo, resumo); // T12
    if (Array.isArray(d.apagarJa) && d.apagarJa.length) return apagarJaPrimeira(t, item, alvo, resumo);
    if (Array.isArray(d.limpar) && d.limpar.length) return limparPrimeira(t, item, alvo, resumo); // T23a: antes da tela e do calado
    // T26b1: chamado com o c.ok nunca vai pro passoSemTela (enviando/entregue com OK sai na tela); nesses estados a tela
    // esta em dia quando mostra a ultima mudanca do OK (a versao nova da fala dele nao muda o que aparece)
    const comOk = alvo.comOk === true && ehObjeto(d.ok) && alvo.estado !== CALADO;
    if (!comOk && (alvo.estado === CALADO || SO_NO_ESTADO.has(alvo.estado))) return passoSemTela(t, item, alvo, resumo);
    const emDiaComOk = comOk && SO_NO_ESTADO.has(alvo.estado) && d.mensagem !== null && d.descer !== true
      && d.mensagem.ok === d.ok.cod && Number.isSafeInteger(d.ok.versaoId) && d.mensagem.versaoId >= d.ok.versaoId;
    if (comOk && trancada(d)) return passoTrancado(t, item, alvo, resumo, emDiaComOk); // T26b2
    // T26d (regra 1): a situacao da aba e a mensagem dela: o chamado esta em dia sem tela (so o apagar)
    const emDiaSemTela = (alvo.comOk === true && !comOk && d.mensagem === null && d.descer !== true && d.naSituacao === alvo.versaoId)
      || (alvo.sid === SISTEMA && d.mensagem === null && d.descer !== true && d.semTela === alvo.versaoId); // T29b: a do sistema saiu
    if (!emDiaComOk && !emDiaSemTela && (d.mensagem === null || d.descer === true || d.mensagem.versaoId !== alvo.versaoId)) {
      const nova = d.mensagem === null || d.descer === true;
      if (comOk && nova && typeof d.ok.fechado === 'string') { // a mensagem nova nao leva o bloco fechado
        // T26b2 (conserto 3, 'manter'): a tela antiga que ainda mostra este OK aberto vira o bloco fechado antes
        if (mantemResolvidas && okNaTelaDe(d) && Number.isSafeInteger(d.ok.versaoId) && d.mensagem.versaoId < d.ok.versaoId) {
          return fecharTelaAntiga(t, item, alvo, resumo);
        }
        delete d.ok;
        if (SO_NO_ESTADO.has(alvo.estado)) return passoSemTela(t, item, alvo, resumo);
        if (alvo.estado === 'ok') {
          okSaiComoCalado(t, alvo.sid, d);
          return 'segue';
        }
      }
      let m;
      try {
        m = alvo.montar();
      } catch (err) {
        tirar(t.saida, item);
        logar(`${alvo.quem}: versao ilegivel (${nomeErro(err)}); sai da fila`);
        return 'segue';
      }
      if (d.mensagem === null || d.descer === true) return enviarNova(t, item, alvo, m, resumo);
      if (m.okCod != null && m.html === undefined && formatoDe(d.mensagem.formato) === 'rich') {
        d.descer = true; // T26b1: nunca edicao sem html de uma tela rich: mensagem nova (a antiga vai pro apagar)
        return 'segue';
      }
      return editarTela(t, item, alvo, m, resumo);
    }
    // T26b1: o toque. T26d: a situacao substituida que fica como mensagem da aba (regra 3)
    if ((comOk || alvo.sid === SITUACAO) && Array.isArray(d.tirarBotoes) && d.tirarBotoes.length) return tirarBotoesPrimeira(t, item, alvo, resumo);
    if (d.apagar.length) return apagarPrimeira(t, item, alvo, resumo);
    tirar(t.saida, item);
    return 'segue';
  }

  // Item da frente da fila: teto de 2 h, aba sem chamado, travado e aviso com o dono no PC saem sem mandar nada; 429
  // em curso = para; senao 1 passo do alvo. Devolve 'segue' | 'para'.
  async function passoDaFila(t, travado, modoRua, resumo) {
    const item = t.saida[0];
    if (!ehObjeto(item) || typeof item.sessionId !== 'string' || !item.sessionId) {
      t.saida.shift();
      return 'segue';
    }
    const sid = item.sessionId;
    const agoraMs = agora();
    const entrou = msDeIso(item.entrouEm);
    if (!Number.isFinite(entrou)) {
      item.entrouEm = isoDe(agoraMs); // item sem hora legivel: o teto conta daqui
    } else if (agoraMs - entrou >= FILA_TTL_MS) {
      tirar(t.saida, item);
      logar(`${sid} perdida: 2 h na fila sem conseguir enviar (${Number(item.falhas) || 0} falha(s))`);
      return 'segue';
    }
    let alvo;
    if (sid === SISTEMA) {
      alvo = alvoSistema(t);
    } else if (sid === PAINEL) {
      const pergunta = await passoDaPergunta(t, item, resumo, agoraMs); // T29d
      if (pergunta !== null) return pergunta;
      // T12: painel que saiu do estado (edicao recusada) nunca volta como mensagem nova: so o apagar dele, se tiver
      if (!ehObjeto(t.painel.dados)) {
        const limparP = Array.isArray(t.painel.limpar) && t.painel.limpar.length > 0; // T23a: a limpeza antes do apagar
        if (!limparP && !(Array.isArray(t.painel.apagar) && t.painel.apagar.length)) {
          tirar(t.saida, item);
          logar(`${PAINEL} saiu da fila (nenhum painel)`);
          return 'segue';
        }
        alvo = alvoPainel(t);
        if (agoraMs < pausaAte || agoraMs < recuoAte) return 'para';
        if (limparP) return limparPrimeira(t, item, alvo, resumo);
        return apagarPrimeira(t, item, alvo, resumo);
      }
      alvo = alvoPainel(t);
    } else if (sid === SITUACAO) {
      const s = t.situacao;
      if (!ehAba(s.aba) || !ehObjeto(s.dados)) { // T10: situacao torta (do disco) nao sai. T10c: a tocada so apaga, nunca volta
        const toque = Array.isArray(s.apagarToque) && s.apagarToque.length > 0; // T12: o /start do toque
        const ja = Array.isArray(s.apagarJa) && s.apagarJa.length > 0;
        const limparS = Array.isArray(s.limpar) && s.limpar.length > 0; // T23a: depois do toque e do apagarJa
        const semBotoes = Array.isArray(s.tirarBotoes) && s.tirarBotoes.length > 0; // T26d (regra 3): antes do apagar
        if (!toque && !ja && !limparS && !semBotoes && !(Array.isArray(s.apagar) && s.apagar.length)) {
          tirar(t.saida, item);
          logar(`${SITUACAO} saiu da fila (nenhuma situacao na tela)`);
          return 'segue';
        }
        alvo = alvoSituacao(t);
        if (agoraMs < pausaAte || agoraMs < recuoAte) return 'para';
        if (toque) return apagarToquePrimeira(t, item, alvo, resumo);
        if (ja) return apagarJaPrimeira(t, item, alvo, resumo);
        if (limparS) return limparPrimeira(t, item, alvo, resumo);
        if (semBotoes) return tirarBotoesPrimeira(t, item, alvo, resumo);
        return apagarPrimeira(t, item, alvo, resumo);
      }
      alvo = alvoSituacao(t);
    } else {
      const c = chamadoDe(t, sid);
      if (!c) {
        tirar(t.saida, item);
        logar(`${sid} saiu da fila: sem chamado`);
        return 'segue';
      }
      if (travado) {
        tirar(t.saida, item);
        logar(`${sid} ${c.versao.estado} saiu da fila sem enviar (travado)`);
        return 'segue';
      }
      // T7c2: so o aviso NOVO (sem mensagem na tela ou descendo); a edicao de um aviso na tela (o abrir) sai
      // T26b1: com o OK aberto no chamado o aviso sai junto (o OK nunca fica sem tela por causa do aviso)
      // T26d: o aviso em dia sem tela (a situacao e a mensagem dele) nao e aviso novo: o apagar dele segue
      if (!modoRua && c.versao.estado === 'aviso' && (c.mensagem === null || c.descer === true) && !okAberto(c) && !emDiaPelaSituacao(c)) {
        tirar(t.saida, item);
        logar(`${sid} aviso saiu da fila sem enviar (dono no PC)`);
        return 'segue';
      }
      alvo = alvoAba(sid, c);
    }
    if (agoraMs < pausaAte || agoraMs < recuoAte) return 'para'; // 429 em curso ou recuo do envio incerto (T7e2)
    return passoDoAlvo(t, item, alvo, resumo);
  }

  /**
   * Esvazia a fila em ordem, 1 item por vez, reconciliando a tela de cada aba (e a do sistema) com a versao atual.
   * travado = item de aba sai sem mandar (o do sistema sai normal); !modoRua = aviso novo (sem mensagem na tela ou
   * descendo) sai sem mandar ("dono no PC"; T7c2: a edicao do abrir sai). Para no 429 (pausa em memoria) e na falha de transporte (o item fica no comeco).
   * T7e2: `aoMudar` (o porteiro: () => salvar(e)) e chamado depois da marca `envio` (antes do pedido) e depois de cada
   * passo com chamada ok, ja com o estado mudado; erro nele = 1 linha de log e o drenar segue. O recuo do envio
   * incerto para o drenar como o 429.
   * T7b2a: `idsDeFora` (lista de message_id; o porteiro passa as mensagens de pedido de OK, principal e outras) = ids que
   * o canal nao manda mas que estao no chat: contam como conhecidos (nunca entram na sonda do envio incerto) e, se
   * aparecerem no apagar (do disco), saem da lista sem chamar a API.
   * T7b2a (revisao, item 4): `janelasDeFora` ([{desde, ate}], ate null = aberta; o porteiro passa as de pedido de OK com
   * envio incerto) = id desconhecido dentro de uma janela nunca entra na sonda do envio incerto e, se aparecer no apagar
   * como {sondar} (do disco), sai da lista sem chamar a API.
   * Nunca lanca (exceto e.tg ausente ou aoMudar que nao e funcao = TypeError).
   * Devolve {chamadas, pendentes, pausaAte: ISO | null}.
   */
  async function drenar(e, { travado = false, modoRua = true, aoMudar = null, idsDeFora = null, janelasDeFora = null } = {}) {
    if (aoMudar != null && typeof aoMudar !== 'function') throw new TypeError('drenar: aoMudar invalido');
    const t = tgDe(e);
    const resumo = { chamadas: 0, pendentes: 0, pausaAte: null };
    if (!drenando) {
      drenando = true;
      aoMudarAtual = aoMudar;
      idsDeForaAtual = conjuntoDeIds(idsDeFora);
      janelasDeForaAtual = listaDeJanelas(janelasDeFora);
      try {
        for (let n = 0; t.saida.length; n += 1) {
          if (n >= MAX_PASSOS) {
            logar(`drenar parou em ${MAX_PASSOS} passos com ${t.saida.length} item(ns) na fila`);
            break;
          }
          let passo;
          okNoPasso = false;
          try {
            passo = await passoDaFila(t, Boolean(travado), Boolean(modoRua), resumo);
          } catch (err) {
            // estado estranho (ou bug) num item nao trava a fila pra sempre: o item sai com 1 linha de log
            const item = t.saida[0];
            tirar(t.saida, item);
            logar(`${ehObjeto(item) ? item.sessionId : '?'}: erro no drenar (${nomeErro(err)}); sai da fila`);
            passo = 'segue';
          }
          if (okNoPasso) await avisarMudanca();
          if (passo === 'para') break;
        }
      } finally {
        drenando = false;
        aoMudarAtual = null;
        okNoPasso = false;
        idsDeForaAtual = new Set();
        janelasDeForaAtual = [];
      }
    }
    resumo.pendentes = t.saida.length;
    resumo.pausaAte = pausaAte > agora() ? isoDe(pausaAte) : null;
    return resumo;
  }

  /**
   * Faxina: chamado sem mudanca ha 24 h e fora da fila sai; mensagens do bot com 7 dias saem; o sistema fica nas 10
   * ultimas linhas. agoraMs invalido = agora().
   */
  function podar(e, agoraMs) {
    const t = tgDe(e);
    const agoraReal = Number.isFinite(agoraMs) ? agoraMs : agora();
    const naFila = new Set(t.saida.filter(ehObjeto).map((i) => i.sessionId));
    for (const sid of Object.keys(t.chamados)) {
      if (naFila.has(sid)) continue;
      const c = t.chamados[sid];
      const mudou = ehObjeto(c) ? msDeIso(c.mudouEm) : NaN;
      if (!Number.isFinite(mudou) || agoraReal - mudou >= CHAMADO_TTL_MS) delete t.chamados[sid];
    }
    for (const id of Object.keys(t.mensagens)) {
      const m = t.mensagens[id];
      const at = ehObjeto(m) ? msDeIso(m.at) : NaN;
      if (!Number.isFinite(at) || agoraReal - at >= MENSAGEM_TTL_MS) delete t.mensagens[id];
    }
    if (t.sistema.linhas.length > MAX_LINHAS) t.sistema.linhas.splice(0, t.sistema.linhas.length - MAX_LINHAS);
  }

  /**
   * T7b2a (revisao, item 4): o maior message_id (> 0) que o estado conhece (mensagens do bot, telas, apagar, citar e as do
   * dono; a mesma conta da marca `envio`) | 0. O porteiro abre a janela de um pedido de OK incerto a partir dele. Nunca
   * lanca (exceto e.tg ausente = TypeError).
   */
  function maiorIdDoChat(e) {
    return maiorIdConhecido(tgDe(e));
  }

  /**
   * T17b (PLANO-TELEGRAM.md, "T17", item 5): a resposta em voz da aba saiu (o porteiro manda; o canal so guarda). Vira
   * mensagem do bot da aba com `voz: true`: resposta em cima dela vai pra aba (sessaoDaMensagem), nunca vai pro apagar
   * (sobrasDaAba pula), o trocarAba leva e a faxina de 7 dias vale igual. Id invalido ou aba invalida = nada. Nunca lanca
   * (exceto e.tg ausente = TypeError).
   * T23a: `citar` (opcional) = a fala do dono em cima da qual a voz saiu (id valido; outro valor = sem citar). No modo
   * 'apagar', a voz sai junto quando a conversa dessa fala se resolve.
   */
  function vozEnviada(e, sessionId, messageId, { citar } = {}) {
    const t = tgDe(e);
    const id = idMensagem(messageId);
    if (id == null || !ehAba(sessionId)) return;
    t.mensagens[id] = { sessionId, at: agoraIso(), formato: 'texto', voz: true };
    const x = idMensagem(citar);
    if (x != null) t.mensagens[id].citar = x;
  }

  // T29a (PLANO-TELEGRAM.md, "T29a"): o modo das resolvidas troca na hora (o /modo do menu do bot), valendo daqui pra
  // frente. Fora de 'apagar'/'manter' = TypeError e nada muda. Pro 'manter': a limpeza pendente (o `limpar` de cada aba, do
  // sistema, do painel e da situacao) e descartada sem chamar a API; com o drenar em curso a lista so esvazia no lugar (o
  // passo que esta no meio dela segue sem lancar). Pro 'apagar': o que ficou no chat no manter (`fica`) continua la.
  function definirResolvidas(e, modo) {
    if (modo !== 'apagar' && modo !== 'manter') throw new TypeError('canal-telegram: resolvidas invalido');
    const t = tgDe(e);
    limpaResolvidas = modo === 'apagar';
    mantemResolvidas = modo === 'manter';
    if (!mantemResolvidas) return;
    for (const d of [...Object.values(t.chamados), t.sistema, t.painel, t.situacao]) {
      if (!ehObjeto(d) || d.limpar === undefined) continue;
      if (drenando && Array.isArray(d.limpar)) d.limpar.length = 0;
      else delete d.limpar;
    }
  }

  /** T17b: a aba tem item na fila do canal (a resposta em texto ainda nao saiu)? A voz so sai com a aba fora da fila. */
  function naFila(e, sessionId) {
    const t = tgDe(e);
    return t.saida.some((i) => ehObjeto(i) && i.sessionId === sessionId);
  }

  return {
    normalizarUpdate,
    sessaoDaMensagem,
    telaDaAba,
    mensagemDoDono,
    chamadoDaAba,
    lerToque,
    aviso,
    resposta,
    falaRecebida,
    trocarAba,
    entregue,
    problema,
    encerrar,
    calar,
    abrir,
    recolher,
    sistema,
    painel,
    painelNaTela,
    atualizarPainel,
    pedirBusca, // T29d
    perguntaDaBusca,
    buscar,
    limparBusca,
    vencerBusca,
    apagarToque,
    situacao,
    abrirSituacao,
    recolherSituacao,
    situacaoTocada,
    drenar,
    podar,
    maiorIdDoChat,
    vozEnviada,
    naFila,
    okAbriu, // T26b1
    okInfo,
    okToque,
    okFechou,
    okDeNovo, // T28
    okNaMensagem,
    okSemTela, // T26b2
    definirResolvidas, // T29a
    vistasSemNada, // T29b
  };
}
