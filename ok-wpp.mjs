// sessoes-wpp — ok-wpp (fase 2): o OK do dono pelo grupo do WhatsApp, conferido na FONTE.
//
// Por que existe: da rua, o dono aprova QUALQUER acao (caso real: "todas as permissoes inteiras")
// respondendo "sim" no grupo, 1 pedido por acao. Uma sessao do Claude nao pode ler o proprio chat e se convencer de que ele aprovou; este modulo relê o
// WhatsApp e so libera com todas as provas juntas:
//   - pedido criado pela MESMA sessao interativa (aba do VS Code ou terminal, F3.9), com a acao exata, codigo aleatorio, 30 min, uso unico, hash;
//   - resposta do numero do dono (o numeroDono do config, por igualdade) citando a mensagem do pedido (ou solta, se era
//     o unico pedido aberto na hora), afirmativa por lista fechada, dentro do prazo;
//   - a mesma mensagem vista pela instancia de CONFERENCIA (o celular do dono) como enviada do celular (from_me) e nao
//     por robo (sent_by_agent);
//   - grupo so com o dono e o robo (numeroDono e numeroRobo do config); porteiro nao travado ("trava" no grupo).
// Fase 3 (PLANO.md, F3.1-F3.3): a acao aprovada e o TEXTO da mensagem do pedido no grupo (o que o dono leu), achado pelo
// id na mesma leitura e comparado byte a byte com montarMensagemPedido (arquivo local trocado = invalido); "sim" solto so
// vale sem mensagem dos agentes entre o pedido e ele; estado do porteiro ilegivel nega, a trava e relida logo antes de
// conceder e "trava" do dono no grupo (depois do ultimo destravadoEm) vale mesmo com o porteiro morto.
// Passou em publicacao = grava o marker que a trava de publicacao do ambiente do dono le; em disparo = o OK no ledger da
// trava de disparo (k:"whatsapp", mesmo desenho dela). Contrato: PLANO.md ("Desenho" item 6). A5c: so com os caminhos
// no config.json (travasDoConfig); sem eles nao grava (nao ha trava de fora pra destravar).
// T7b1b (PLANO-T7.md, "T7b1b no Desenho 1b"): com o OK pelo Telegram ligado, o toque do dono no Sim/Nao do pedido no
// PROPRIO chat do bot tambem decide, relido no servidor do Telegram por ESTE processo (espiar a partir do tg.offset
// que o porteiro gravou) e conferido inteiro (conferirToque); arquivo, estado e e.okTg so negam. O Nao vence; o Sim exige
// o porteiro vivo e grava k:"telegram". Sem toque valido, o WhatsApp decide como antes.
// A2b (PLANO-ABERTO.md, "A2b"): WhatsApp desligado no config.json (whatsapp.ligado false) = nada le nem escreve no grupo:
// o pedido sai so pelo Telegram (o porteiro manda), so o toque decide (sem decisao = pendente) e, sem o OK pelo Telegram,
// pedir e verificar = invalido "sem canal de OK".
// A2a (PLANO-ABERTO.md, "A2a — valores"): o grupo, as 2 instancias e os 2 numeros vem do bloco `whatsapp` do config.json
// (identidadeWhatsapp; sem ele completo e com ligado true = desligado, como a A2b). Com o WhatsApp e sem os 2 numeros
// validos = invalido "sem numeroDono ou numeroRobo" antes de ler ou escrever no grupo.
// A5c (PLANO-ABERTO.md, "A5c — a trava própria e o OK numa máquina nova"): a trava de arquivo e a propria
// (lib/trava.mjs, mesmo protocolo da do ambiente do dono); a de fora so com `travas.lib` no config. O pedido grava o
// `libera` (o "O Sim libera ..." do botao do Telegram): o disparo sem o ledger sai sem a janela de 2 horas.
//
// Estado: <estadoDir>/oks/<CODIGO>.json (tmp+rename). Log sem o texto da acao.
// Seguranca: os arquivos <pid>.<sha>.key da pasta de registro sao SEGREDO; so `^\d+\.json$` e aberto (lib.acharRegistro).
//
// CLI: node ok-wpp.mjs pedir [--tipo <crm|mensagem|publicacao|disparo|pagamento|apagar|outro>] --acao "<texto>" [--destinatarios "A; B"]
//      node ok-wpp.mjs verificar <CODIGO>
//      node ok-wpp.mjs listar
// Saida: 1 linha JSON. Exit: 0 ok/pedido, 2 pendente, 3 recusado, 1 invalido/erro.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { horaBRT, limparParaWhatsApp, cabecalho, definirFuso } from './lib/formato.mjs';
import { textoDaMensagem } from './lib/roteamento.mjs'; // T7g: o verificar le o texto como o porteiro (audio = transcricao)
import { ROTULO } from './lib/ok-tg.mjs';
import { conferirToque, lerDadosOk, travaNoChat, lerConfigOk, LIBERA } from './lib/ok-tg.mjs';
import { chaveTelegram } from './lib/registro.mjs';
import { lerConfig, identidadeTelegram, botIdDaChave, identidadeWhatsapp, RE_NUMERO_WPP, donoDoConfig, travasDoConfig } from './lib/config.mjs';
import { criarTelegram } from './telegram.mjs';
import { wppDoConfig } from './wpp.mjs';
// F3.4 + A5c: a trava de arquivo do pedido, do marker e do ledger. A propria, no MESMO protocolo da do ambiente do dono
// (as duas se excluem no mesmo arquivo); a de fora so pelo `travas.lib` do config (o main).
import { comTrava as travaPropria } from './lib/trava.mjs';

const require = createRequire(import.meta.url);
const lib = require('./hooks/lib/sessoes-wpp.js');

const ESTE_ARQUIVO = fileURLToPath(import.meta.url);

export const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** Listas fechadas (frase inteira, ja normalizada). Textos fixos do brief D4a. */
export const AFIRMATIVAS = Object.freeze([
  'sim', 's', 'pode', 'pode sim', 'pode ir', 'pode mandar', 'pode seguir', 'pode publicar', 'manda', 'ok', 'okay',
  'confirmo', 'confirmado', 'aprovado', 'aprovo', 'autorizo', 'vai', 'a',
]);
export const NEGATIVAS = Object.freeze(['nao', 'n', 'cancela', 'cancelar', 'para', 'espera', 'b']);
// T7g v2 (caso real: "estava sendo obrigatorio eu digitar sim ou ok, e eu nao queria que fosse assim";
// decisao v2 do principal, ~11h): a flexibilidade vale SO na resposta que CITA o pedido (texto, audio ou emoji), em MUNDO
// FECHADO: so decide a frase em que toda palavra e de aprovacao; palavra fora do vocabulario = null (o pedido segue
// pendente e a aba pergunta de novo). A resposta SOLTA (e todo o porteiro) segue a regra de sempre: frase inteira em
// AFIRMATIVAS/NEGATIVAS. Sim falso e o erro caro; null e barato. A v1 (regra aberta + solta com vocabulario maior) caiu na
// revisao adversarial ("pode segurar", "manda o link" e "beleza" solto viravam sim). Listas por palavra, ja normalizadas
// (sem acento). R1 a R7 e a tabela: PLANO-T7.md, secao "T7g" (v2).
// Revisao da v2 (03/10/2026 ~12h): sairam "apagar" ("pode apagar isso" = descarta, e virava OK de disparo), "confirma" e
// "confirmar" ("confirma ai" = confere), e as palavras que fazem pergunta ou adiamento sem "?" ("ne", "mesmo", "e", "esta",
// "ta": "pode mandar, ne", "pode mandar mesmo", "e agora", "esta certo", "ta certo isso"); "ja" so fora do par "ja ja".
export const SIM_INICIO = Object.freeze([
  'sim', 's', 'ss', 'pode', 'podem', 'manda', 'mande', 'vai', 'bora', 'ok', 'okay', 'okey', 'yes', 'beleza', 'blz', 'fechado',
  'fechou', 'combinado', 'aprovado', 'aprovo', 'aprova', 'autorizo', 'autorizado', 'autoriza', 'confirmo', 'confirmado',
  'positivo', 'claro', 'certo', 'perfeito', 'otimo', 'show', 'top', 'joia', 'isso', 'segue', 'siga', 'prossiga', 'libera',
  'liberado', 'faz', 'faca', 'publica', 'envia', 'dispara', 'executa', 'roda', 'paga', 'valendo', 'demorou',
]); // v2: sem "apaga" ("apaga isso" = descarta) e sem "confirma"
/** SIM_INICIO menos isso, certo e claro (comuns dentro de frase negativa: "nao e isso", "nao ta certo"). */
export const SIM_VIRA = Object.freeze(SIM_INICIO.filter((p) => !['isso', 'certo', 'claro'].includes(p)));
/** SIM_INICIO + o resto do vocabulario do sim; ver, bala e brasa so logo depois de manda/mande; "ja" nunca no par "ja ja". */
export const VOCAB_SIM = Object.freeze([
  ...SIM_INICIO, 'mandar', 'ir', 'seguir', 'prosseguir', 'fazer', 'publicar', 'enviar', 'disparar', 'executar', 'rodar',
  'pagar', 'liberar', 'aprovar', 'autorizar', 'ver', 'bala', 'brasa', 'la', 'ai', 'agora', 'ja', 'tudo', 'bem', 'bom', 'boa',
  'com', 'certeza', 'por', 'favor', 'pf', 'pfv', 'obrigado', 'obrigada', 'valeu', 'entao', 'tranquilo', 'de',
]);
/** v2: frases inteiras (R3) que tambem dizem sim, so citando o pedido. */
export const FRASES_SIM = Object.freeze([
  'ta', 'ta bom', 'ta bem', 'ta certo', 'ta ok', 'tudo bem', 'tudo certo', 'com certeza', 'tranquilo', 'de boa', 'uhum', 'aham',
  'pode crer', 'vamos', 'vamos la', 'isso mesmo', 'entao ta',
]);
/** R5: palavras que desfazem o "nao" do comeco (aprovacao dita pela negacao: "nao tem problema", "nao esquece de mandar"). */
export const DESFAZ_NAO = Object.freeze([
  'problema', 'problemas', 'erro', 'oponho', 'objecao', 'precisa', 'esquece', 'esqueca', 'esquecer', 'deixa', 'deixe', 'deixar',
]);
export const NAO_INICIO = Object.freeze([
  'nao', 'n', 'nem', 'nunca', 'jamais', 'negativo', 'cancela', 'cancelar', 'cancelado', 'para', 'pare', 'parar', 'espera',
  'espere', 'esperar', 'pera', 'perai', 'calma', 'aguarda', 'aguarde', 'aguardar', 'segura', 'segure', 'recuso', 'recusado',
  'nego',
]);
/** NAO_INICIO menos "para" (no meio da frase e "pra") + adiamento, condicao, restricao, mudanca, duvida e pergunta. */
export const BLOQUEIO = Object.freeze([
  ...NAO_INICIO.filter((p) => p !== 'para'), 'depois', 'antes', 'ainda', 'amanha', 'tarde', 'noite', 'semana', 'mes', 'mas',
  'porem', 'contudo', 'entretanto', 'so', 'somente', 'apenas', 'exceto', 'menos', 'sem', 'se', 'caso', 'talvez', 'acho', 'sei',
  'duvida', 'melhor', 'errado', 'errada', 'erro', 'muda', 'mude', 'mudar', 'troca', 'troque', 'trocar', 'corrige', 'corrija',
  'corrigir', 'ajusta', 'ajuste', 'ajustar', 'tira', 'tire', 'tirar', 'remove', 'remova', 'remover', 'coloca', 'coloque',
  'colocar', 'acrescenta', 'acrescente', 'inclui', 'inclua', 'incluir', 'edita', 'edite', 'editar', 'revisa', 'revise',
  'revisar', 'confere', 'confira', 'conferir', 'que', 'qual', 'quais', 'quando', 'como', 'onde', 'quem', 'porque', 'pq',
  'trava', 'travar', 'outro', 'outra', 'outros', 'outras',
]);
/** Emoji base, sem FE0F e sem tom de pele (a comparacao tira os dois): 👍 👌 ✅ ✔ 🆗 | 👎 ❌ ✋ 🛑. */
export const SIM_EMOJI = Object.freeze(['\u{1F44D}', '\u{1F44C}', '\u{2705}', '\u{2714}', '\u{1F197}']);
export const NAO_EMOJI = Object.freeze(['\u{1F44E}', '\u{274C}', '\u{270B}', '\u{1F6D1}']);

// Escopo (caso real): "quero poder fazer qualquer coisa ... todas as permissoes inteiras". Nao ha
// mais lista "so no PC": o tipo so rotula a mensagem e escolhe a trava automatica que recebe o OK (publicacao ->
// a trava de publicacao; disparo -> a trava de disparo). Cada acao continua precisando do SEU pedido e do SEU sim.
const TIPOS = new Set(['crm', 'mensagem', 'publicacao', 'disparo', 'pagamento', 'apagar', 'outro']);
// O ROTULO de cada tipo mora em lib/ok-tg.mjs desde a T7b1a (o mesmo rotulo no grupo e no Telegram); reexportado aqui,
// o MESMO objeto (o porteiro importa daqui).
export { ROTULO };
const VALIDADE_MS = 30 * 60 * 1000;
const PODA_MARKER_MS = 24 * 60 * 60 * 1000;
const LEITURA = 50;
const MAX_ACAO = 1500;
const TAM_CODIGO = 6;
const RE_CODIGO = new RegExp(`^[${ALFABETO}]{${TAM_CODIGO}}$`);
const RE_ARQ_CODIGO = new RegExp(`^[${ALFABETO}]{${TAM_CODIGO}}\\.json$`);
// T7b1b: o Sim do Telegram so vale com o porteiro vivo (pid do porteiro.lock vivo E estado.json gravado ha no maximo
// 60 s; ate 5 s "no futuro" = relogio, conta como agora) e a espiada tenta 3 vezes no 409 (o porteiro lendo junto).
const PORTEIRO_FRESCO_MS = 60 * 1000;
const FOLGA_RELOGIO_MS = 5 * 1000;
const ESPERAS_409_MS = Object.freeze([500, 1000]);
const esperar = (ms) => new Promise((r) => { setTimeout(r, ms); });
// A2b (PLANO-ABERTO, "A2b"): WhatsApp desligado (wpp null) e sem o OK pelo Telegram = nao ha por onde o dono responder
export const SEM_CANAL = 'sem canal de OK (WhatsApp desligado e OK pelo Telegram desligado)';
// A2a: com o WhatsApp, o "sim", a "trava" e os membros conferem pelos 2 numeros do config; sem eles nada le nem escreve
export const SEM_NUMEROS = 'WhatsApp sem numeroDono ou numeroRobo no config';
const SEM_TOQUE = 'sem toque do dono no Telegram ainda';

const iso = (ms) => new Date(ms).toISOString();
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const curto = (sid) => String(sid || '-').slice(0, 8);
// O hash amarra tipo + acao + destinatarios: editar o tipo (crm -> publicacao) ou a lista depois do OK = adulterado.
const hashDoPedido = (tipo, acao, dest) => sha256(JSON.stringify([tipo, acao, dest ?? null]));

/** minusculas, sem acento, sem pontuacao, espacos colapsados, trim. */
export function normalizarResposta(s) {
  if (s == null) return '';
  return String(s)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const C_SIM_INICIO = new Set(SIM_INICIO);
const C_SIM_VIRA = new Set(SIM_VIRA);
const C_VOCAB_SIM = new Set(VOCAB_SIM);
const C_FRASES_SIM = new Set(FRASES_SIM);
const C_NAO_INICIO = new Set(NAO_INICIO);
const C_BLOQUEIO = new Set(BLOQUEIO);
const C_SIM_EMOJI = new Set(SIM_EMOJI);
const C_NAO_EMOJI = new Set(NAO_EMOJI);
const C_DESFAZ_NAO = new Set(DESFAZ_NAO);
const MAX_PALAVRAS = 20; // R4 (e o teto do "nao", R5)
const NEGA_A_SEGUINTE = new Set(['nao', 'n', 'nem']); // R5: "nao pode" e negacao, nao aprovacao
const SO_DEPOIS_DE_MANDA = new Set(['ver', 'bala', 'brasa']); // R6: "manda ver" e sim; "vai ver" nao
const MANDA = new Set(['manda', 'mande']);
// R1: ? ❓ ❔ ？ ¿ e (revisao da v2) ⁉ ‽ ⁇ ⁈ ؟ ﹖ ︖ (o ⁉ esta no teclado de emoji do WhatsApp)
const RE_PERGUNTA = /[?\u{2753}\u{2754}\u{FF1F}\u{BF}\u{2049}\u{203D}\u{2047}\u{2048}\u{61F}\u{FE56}\u{FE16}]/u;
const RE_LETRA_OU_NUMERO = /[\p{L}\p{N}]/u;
const RE_ENFEITE_DE_EMOJI = /[\s\u{FE0F}\u{1F3FB}-\u{1F3FF}]/gu; // R2: espacos, FE0F e tons de pele
// R2 com letra ou numero (revisao da v2): o que pode aparecer alem do emoji das 2 listas
const RE_TEXTO_COMUM = /^[\p{L}\p{N}\p{M}.,;:!*_~]$/u;
// R5: texto cru (sem acento, minusculo) comecando com "nao" (1 ou mais: "Nao nao, pode") seguido de pontuacao; antes so o
// que nao e letra nem numero (formatacao do WhatsApp) e, entre o "nao" e a pontuacao, so espaco ou formatacao
// ("*Nao*, pode mandar"). Outra pontuacao (reticencias de 1 caractere, travessao, parenteses) ja caiu no R2.
const RE_NAO_PONTUADO = /^[^\p{L}\p{N}]*(?:nao[\s*_~]*)+[,.;:!]/u;

/**
 * 'sim' | 'nao' | null; opcoes = {citada = false}. Sem `citada` (a resposta SOLTA, e todo o porteiro): a regra de sempre,
 * frase inteira, normalizada, em AFIRMATIVAS ou NEGATIVAS. Com `citada: true` (o verificar, quando a resposta cita a
 * mensagem do pedido): T7g v2, mundo fechado (R1 a R7, PLANO-T7.md "T7g"); na duvida, null.
 */
export function classificarResposta(s, opcoes) {
  if (opcoes?.citada === true) return classificarCitada(s);
  const t = normalizarResposta(s);
  if (!t) return null;
  if (AFIRMATIVAS.includes(t)) return 'sim';
  if (NEGATIVAS.includes(t)) return 'nao';
  return null;
}

// T7g v2: a resposta que cita o pedido (R1 a R7).
function classificarCitada(s) {
  const cru = s == null ? '' : String(s);
  // R1: pergunta nunca decide
  if (RE_PERGUNTA.test(cru)) return null;
  // R2: so emoji (sem letra nem numero): todos do grupo do sim = 'sim', todos do nao = 'nao'; o resto (vazio, outro
  // emoji, pontuacao, os 2 grupos) nao decide
  if (!RE_LETRA_OU_NUMERO.test(cru)) {
    const resto = Array.from(cru.replace(RE_ENFEITE_DE_EMOJI, ''));
    if (!resto.length) return null;
    if (resto.every((c) => C_SIM_EMOJI.has(c))) return 'sim';
    if (resto.every((c) => C_NAO_EMOJI.has(c))) return 'nao';
    return null;
  }
  // R2 com letra ou numero: so letra, numero, espaco, a pontuacao comum (, . ; : !), a formatacao (* _ ~) e o emoji das 2
  // listas; qualquer outro simbolo = null (revisao da v2: "Ta bom 🙄", "beleza 🤔" e "beleza :/" viravam sim). Depois o
  // texto decide (R3 em diante); emoji do grupo contrario anula; os 2 grupos juntos = null
  const resto = Array.from(cru.replace(RE_ENFEITE_DE_EMOJI, ''));
  if (resto.some((c) => !RE_TEXTO_COMUM.test(c) && !C_SIM_EMOJI.has(c) && !C_NAO_EMOJI.has(c))) return null;
  const classe = classificarTextoCitado(cru);
  const pontos = Array.from(cru);
  const temSim = pontos.some((c) => C_SIM_EMOJI.has(c));
  const temNao = pontos.some((c) => C_NAO_EMOJI.has(c));
  if (temSim && temNao) return null;
  if ((classe === 'sim' && temNao) || (classe === 'nao' && temSim)) return null;
  return classe;
}

// R5: alguma palavra de SIM_VIRA fora do "logo depois de nao/n/nem" ("nao pode" e negacao, nao aprovacao).
const simLivre = (ws) => ws.some((p, i) => C_SIM_VIRA.has(p) && !(i > 0 && NEGA_A_SEGUINTE.has(ws[i - 1])));

// R3 a R7 sobre o texto (o cru so pra excecao do "nao," do R5, que precisa da pontuacao).
function classificarTextoCitado(cru) {
  // R3: frase inteira nas listas de sempre ou em FRASES_SIM ("a" e "b" so valem assim)
  const t = normalizarResposta(cru);
  if (!t) return null;
  if (AFIRMATIVAS.includes(t) || C_FRASES_SIM.has(t)) return 'sim';
  if (NEGATIVAS.includes(t)) return 'nao';
  // R4: palavras sem o par "sem problema(s)" (enfeite); mais de 20 = null
  const w = [];
  const todas = t.split(' ');
  for (let i = 0; i < todas.length; i += 1) {
    if (todas[i] === 'sem' && (todas[i + 1] === 'problema' || todas[i + 1] === 'problemas')) { i += 1; continue; }
    w.push(todas[i]);
  }
  if (w.length > MAX_PALAVRAS) return null;
  // R5: 'nao' comecando pela negacao, com palavra de SIM_VIRA so logo depois de nao/n/nem ("nao pode")
  if (C_NAO_INICIO.has(w[0])) {
    // revisao da v2: aprovacao dita pela negacao nao recusa (null): palavra de DESFAZ_NAO em qualquer lugar (olhando antes
    // de tirar o "sem problema": "Nao, sem problema"), o "por que" ("nao vejo por que nao", "nao tem por que esperar") e
    // um 2o "nao" no meio da frase, longe de outra negacao ("nao tem como nao aprovar"). O "nao" do fim e enfase e mantem
    // a recusa ("Nao, agora nao", "Nao, claro que nao"); o colado em outra negacao tambem ("Nao, nao pode", "Para, nao manda").
    if (todas.some((p) => C_DESFAZ_NAO.has(p))) return null;
    if (todas.some((p, i) => p === 'por' && todas[i + 1] === 'que')) return null;
    if (todas.some((p, i) => p === 'nao' && i > 0 && i < todas.length - 1 && !C_NAO_INICIO.has(todas[i - 1]))) return null;
    // "Nao, pode mandar": pontuacao depois do "nao" do comeco e, no que vem depois dela, palavra de SIM_VIRA que nao esta
    // logo depois de nao/n/nem ou uma frase inteira de FRASES_SIM ("Nao, tudo certo") = ambiguo. "Nao, nao pode" segue recusa.
    const m = RE_NAO_PONTUADO.exec(cru.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase());
    if (m) {
      const depois = normalizarResposta(m.input.slice(m[0].length));
      if (simLivre(depois ? depois.split(' ') : []) || C_FRASES_SIM.has(depois)) return null;
    }
    if (!simLivre(w)) return 'nao';
  }
  // R6: 'sim' so com TODA palavra no vocabulario (ver, bala e brasa so logo depois de manda/mande; "ja" fora do par "ja ja",
  // que e "daqui a pouco"), ao menos 1 de inicio e nenhuma de bloqueio. A seguranca e o VOCAB_SIM: o BLOQUEIO nao tem
  // palavra dele (o teste prende a intersecao vazia); a checagem fica como 2a trava.
  const doVocabulario = (p, i) => C_VOCAB_SIM.has(p) && (!SO_DEPOIS_DE_MANDA.has(p) || (i > 0 && MANDA.has(w[i - 1])))
    && !(p === 'ja' && (w[i - 1] === 'ja' || w[i + 1] === 'ja'));
  if (w.every(doVocabulario) && w.some((p) => C_SIM_INICIO.has(p)) && !w.some((p) => C_BLOQUEIO.has(p))) return 'sim';
  // R7: o resto nao decide (mundo fechado)
  return null;
}

/**
 * Texto EXATO da mensagem do pedido no grupo (o que o dono le). `pedir` envia isto e `verificar` compara a mensagem lida
 * no WhatsApp com isto, montado a partir do arquivo do pedido: qualquer campo trocado no arquivo muda o texto.
 * destinatarios = lista ou null (como o pedir grava); hora = horaBRT(expiraEm).
 */
export function montarMensagemPedido({ titulo, tipo, destinatarios, acao, hora }) {
  if (!Object.hasOwn(ROTULO, tipo)) throw new TypeError(`tipo desconhecido: ${tipo}`);
  // Sem o codigo no texto (caso real: "nao sei pra que serve"): ele fica so no arquivo e no log.
  // F4g (caso real: "mais curta possivel", "sem rodape"): cabecalho com o icone e a pergunta curta no fim. A
  // acao vai INTEIRA: o dono aprova o que le. Pedido feito antes desta versao deixa de conferir (o texto mudou).
  return (
    `${cabecalho(titulo)}\nPedido de OK (${ROTULO[tipo](destinatarios)}): ${limparParaWhatsApp(acao)}\n\n` +
    `*Posso?* Vale até ${hora}.`
  );
}

export function codigoDeSaida(status) {
  if (status === 'ok' || status === 'pedido') return 0;
  if (status === 'pendente') return 2;
  if (status === 'recusado') return 3;
  return 1;
}

// Hora da mensagem do read ("2026-09-27T21:26:33+00:00"; tolera espaco no lugar do T e fuso "+00"). Ruim = NaN.
function msDe(ts) {
  if (typeof ts !== 'string' || !ts) return Number.NaN;
  let s = ts.trim().replace(' ', 'T');
  if (/[+-]\d{2}$/.test(s)) s += ':00';
  return Date.parse(s);
}

function lerJson(arq) {
  try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return null; }
}

// Escrita atomica: tmp no mesmo diretorio + rename. Erro sobe (quem chama decide). No Windows o rename falha por
// instantes (EPERM/EBUSY/EACCES) quando outro processo esta com o arquivo aberto (o 2o verificar relendo o pedido, um
// hook lendo o marker): tenta de novo, ate 5 vezes, com 25 ms de espera sincrona entre elas (o gravarAtomico do porteiro).
const RENAME_PASSAGEIRO = new Set(['EPERM', 'EBUSY', 'EACCES']);
function gravarAtomico(arq, texto) {
  fs.mkdirSync(path.dirname(arq), { recursive: true });
  const tmp = `${arq}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, texto);
    for (let i = 0; ; i++) {
      try {
        fs.renameSync(tmp, arq);
        return;
      } catch (err) {
        if (i >= 4 || !RENAME_PASSAGEIRO.has(err?.code)) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nada */ }
    throw e;
  }
}

// Formatos que o pedir grava: null ou lista nao vazia de textos nao vazios.
function destinatariosValidos(d) {
  if (d === null) return true;
  return Array.isArray(d) && d.length > 0 && d.every((x) => typeof x === 'string' && x !== '');
}

function listaDestinatarios(d) {
  const partes = Array.isArray(d) ? d : typeof d === 'string' ? d.split(';') : [];
  return partes.map((x) => String(x ?? '').trim()).filter(Boolean);
}

// Processo existe? EPERM = existe (sem permissao de sinal); so ESRCH = morto. O mesmo do pidVivo do porteiro (o ok-wpp
// nao importa o porteiro).
function pidVivo(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

// A2a: a mensagem e do numero do dono (o numeroDono do config) por igualdade, nunca "contem"; sem o numero, de ninguem.
const doNumeroDono = (m, numeroDono) => typeof numeroDono === 'string' && numeroDono !== '' && m.sender_phone === numeroDono;

// F3.3: "trava" do dono no grupo (texto ou audio, frase inteira; do numero dele, do celular, nao robo) depois do ultimo
// destravadoEm (sem destravadoEm = qualquer uma; hora ilegivel = conta). Vale mesmo com o porteiro morto. Uma regra so: o
// d2 (WhatsApp) e o b2 (T7b1b, na leitura do grupo do ramo Telegram) usam esta. A2a: o numero dele = numeroDono.
function travaDoDonoNoGrupo(lidas, destravadoEm, numeroDono) {
  const destravado = msDe(destravadoEm);
  return lidas.some((m) => {
    if (!doNumeroDono(m, numeroDono) || m.from_me !== false || m.sent_by_agent !== false) return false;
    if (![m.content, m.transcription].some((s) => typeof s === 'string' && normalizarResposta(s) === 'trava')) return false;
    const t = msDe(m.message_ts);
    return !(Number.isFinite(destravado) && Number.isFinite(t) && t <= destravado);
  });
}

const ehId = (x) => typeof x === 'string' && x !== '';

// d1) F3.1: as mensagens do pedido nesta leitura do grupo: enviadas por nos (from_me), achadas pelo id que o pedir gravou.
function mensagensDoPedido(lidas, p) {
  return lidas.filter((m) =>
    m.from_me === true &&
    ((ehId(p.providerMsgId) && m.provider_msg_id === p.providerMsgId) || (ehId(p.messageId) && m.id === p.messageId)));
}

// d3) As mensagens do dono no grupo que podem ser resposta a ESTE pedido, na ordem da hora, cada uma com o que vale (F3.2).
// Candidata: do numero do dono (numeroDono), do celular (from_me false), nao robo (sent_by_agent false), citando a mensagem do pedido
// ou solta, no prazo, e nao usada por outro pedido. vale: 'resposta' = citando, ou solta que decide, veio depois da
// mensagem do pedido, com este o UNICO pedido aberto na hora dela e sem mensagem dos agentes entre o pedido e ela;
// 'conversa' = solta que nao decide; 'antes' = solta antes do pedido entrar no grupo; 'ambigua' = solta com outro pedido
// aberto (tem que citar); 'agentes' = solta depois de outra mensagem dos agentes (tem que citar). Uma regra so: o d (a
// 1a 'resposta' que decide) e o b2 da T7b1b (todo "nao" que e 'resposta' vence o Sim do Telegram). doPedido =
// mensagensDoPedido (sem ela na leitura, nenhuma solta e 'resposta'); outros = os outros pedidos da pasta; numeroDono =
// o do config (A2a).
function respostasAoPedido(lidas, { p, criado, expira, doPedido, outros, numeroDono }) {
  const tPedido = doPedido.length ? msDe(doPedido[0].message_ts) : Number.NaN;
  // F3.2: mensagem dos agentes (from_me na profissional: outra aba, porteiro, outro pedido) entre a mensagem do pedido e
  // a resposta solta = o "sim" pode ser pra ela. Hora ilegivel (do pedido ou da mensagem) = conta como no meio.
  // Empate de hora (mesmo segundo do pedido ou da resposta) = ordem desconhecida = no meio (GPT-6 rodada 2, achado 3).
  const agenteNoMeio = (t) => !Number.isFinite(tPedido) || lidas.some((x) => {
    if (x.from_me !== true || doPedido.includes(x)) return false;
    const tx = msDe(x.message_ts);
    return !Number.isFinite(tx) || (tx >= tPedido && tx <= t);
  });
  const citaveis = new Set([p.providerMsgId, p.messageId].filter((x) => typeof x === 'string' && x));
  // Resposta SEM citacao (caso real: "sim" solto): vale se, na hora dela, este era o UNICO pedido
  // aberto (de qualquer aba) e ela nao foi usada por outro pedido. 2+ abertos = ambiguo: tem que citar.
  const consumidas = new Set(outros.map((x) => x?.verificadoPor?.providerMsgId).filter(Boolean));
  const abertoEm = (x, t) => {
    const c0 = msDe(x?.criadoEm);
    const e0 = msDe(x?.expiraEm);
    if (!Number.isFinite(c0) || !Number.isFinite(e0) || !(c0 < t && t <= e0)) return false;
    if (x.status === 'pendente') return true;
    const d = msDe(x.usadoEm || x.decididoEm);
    return !Number.isFinite(d) || d > t; // decidido depois da resposta = estava aberto nela
  };
  const semCitacao = (m) => m.quoted_msg_id == null || m.quoted_msg_id === '';
  return lidas
    .map((m) => ({ m, t: msDe(m?.message_ts) }))
    .filter(({ m, t }) =>
      m &&
      doNumeroDono(m, numeroDono) &&
      m.from_me === false &&
      m.sent_by_agent === false &&
      (citaveis.has(m.quoted_msg_id) || semCitacao(m)) && !consumidas.has(m.provider_msg_id) &&
      Number.isFinite(t) && t > criado && t <= expira)
    .sort((a, b) => a.t - b.t)
    .map(({ m, t }) => {
      // T7g: o texto pela regra do porteiro (audio/ptt = a transcricao; o marcador do content nunca vira resposta); so a
      // resposta que cita o pedido tem a regra flexivel (a solta segue a lista fechada de sempre)
      const { texto } = textoDaMensagem(m);
      const citada = citaveis.has(m.quoted_msg_id);
      const classe = classificarResposta(texto, { citada });
      let vale = 'resposta';
      if (!citada) {
        // solta: so conta se decide, se veio depois da mensagem do pedido, se nenhum outro pedido estava aberto naquela
        // hora e se nenhuma mensagem dos agentes entrou no grupo entre o pedido e ela (F3.2)
        if (!classe) vale = 'conversa'; // conversa solta no grupo nao e resposta ao pedido
        else if (Number.isFinite(tPedido) && t <= tPedido) vale = 'antes'; // antes do pedido entrar no grupo
        else if (outros.some((x) => abertoEm(x, t))) vale = 'ambigua';
        else if (agenteNoMeio(t)) vale = 'agentes';
      }
      return { m, texto, classe, vale };
    });
}

export function criarOkWpp({
  // A2b: null = WhatsApp desligado no config (o main le): o pedido so sai pelo Telegram (o porteiro manda) e so o toque
  // decide; nada le nem escreve no grupo
  wpp,
  env = process.env,
  agora = Date.now,
  // A5c: a trava de arquivo (padrao a propria; o main troca pela do `travas.lib` do config)
  comTrava = travaPropria,
  // A5c: o marker da trava de publicacao e o ledger da trava de disparo do ambiente do dono (o main passa os do
  // travasDoConfig). null = a aprovacao nao grava nele (nao ha trava de fora pra destravar); o disparo pede sem a janela
  markerPath = null,
  disparoPath = null,
  randomInt = crypto.randomInt,
  esperaTravaMs = 3000,
  // T7b1b: {espiar, botId, chatDono} do bot do dono (o main monta com tgOkPreguicoso) ou null = OK pelo Telegram
  // desligado (sem o ramo). A1b2: o toque e a "trava" do chat so conferem com o botId e o chatDono deste tgOk (sem os
  // dois, nenhum toque confere)
  tgOk = null,
  porteiroVivo = null, // () => boolean; null = o padrao (porteiro.lock + idade do estado.json)
  dormir = esperar,
  // A2a: os 2 numeros do bloco `whatsapp` do config (o main passa os do identidadeWhatsapp). Com o wpp, o "sim" e a
  // "trava" contam so do numeroDono e o grupo tem que ter exatamente os 2; faltou ou fora do formato = SEM_NUMEROS
  numeroDono = null,
  numeroRobo = null,
} = {}) {
  const numerosOk = [numeroDono, numeroRobo].every((n) => typeof n === 'string' && RE_NUMERO_WPP.test(n));
  const membrosEsperados = [numeroDono, numeroRobo];
  const c = lib.caminhos(env);
  const oksDir = path.join(c.estadoDir, 'oks');
  const projectsDir = env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
  const arquivoDe = (cod) => path.join(oksDir, `${cod}.json`);
  const log = (msg) => lib.log(c.logFile, `ok-wpp: ${msg}`);
  const invalido = (motivo) => ({ status: 'invalido', motivo });
  const estadoArq = path.join(c.estadoDir, 'estado.json');
  // estado.json do porteiro: objeto ou null (ausente, JSON podre, nao-objeto). Quem chama nega com null (F3.3).
  const lerEstado = () => {
    const e = lerJson(estadoArq);
    return e && typeof e === 'object' && !Array.isArray(e) ? e : null;
  };

  // ---------- titulo da aba ----------

  function acharTranscript(sessionId) {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
    let pastas;
    try { pastas = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { return null; }
    for (const d of pastas) {
      if (!d.isDirectory()) continue;
      const arq = path.join(projectsDir, d.name, `${sessionId}.jsonl`);
      if (fs.existsSync(arq)) return arq;
    }
    return null;
  }

  // custom-title > name com nameSource "user" > ultimo ai-title > name do registro. O transcript e lido INTEIRO (o
  // custom-title pode estar longe do fim), mas so as linhas de titulo sao parseadas.
  function tituloDaAba(sessionId, registro) {
    const entradas = [];
    const arq = acharTranscript(sessionId);
    if (arq) {
      let texto = '';
      try { texto = fs.readFileSync(arq, 'utf8'); } catch { texto = ''; }
      for (const linha of texto.split('\n')) {
        if (!linha.includes('custom-title') && !linha.includes('ai-title')) continue;
        try {
          const x = JSON.parse(linha);
          if (x && (x.type === 'custom-title' || x.type === 'ai-title')) entradas.push(x);
        } catch { /* linha ruim */ }
      }
    }
    const bruto = lib.tituloDe(entradas, registro) || (typeof registro?.name === 'string' ? registro.name : '') || '';
    const limpo = limparParaWhatsApp(bruto).replace(/\*/g, '').replace(/\s+/g, ' ').trim();
    return limpo || 'sem nome';
  }

  function sortearCodigo() {
    for (let i = 0; i < 50; i++) {
      let cod = '';
      for (let j = 0; j < TAM_CODIGO; j++) cod += ALFABETO[randomInt(ALFABETO.length)];
      if (!fs.existsSync(arquivoDe(cod))) return cod;
    }
    return null;
  }

  // ---------- pedir ----------

  async function pedir({ tipo, acao, destinatarios } = {}) {
    const sessionId = env.CLAUDE_CODE_SESSION_ID;
    const r = await pedirSemLog({ sessionId, tipo, acao, destinatarios });
    log(`pedir ${r.status}${r.codigo ? ` ${r.codigo}` : ''} sessao=${curto(sessionId)}${r.status === 'invalido' ? ` (${r.motivo})` : ''}`);
    return r;
  }

  async function pedirSemLog({ sessionId, tipo, acao, destinatarios }) {
    if (!wpp && !tgOk) return invalido(SEM_CANAL); // A2b: antes de tudo
    if (wpp && !numerosOk) return invalido(SEM_NUMEROS); // A2a: antes de ler ou escrever no grupo
    if (!sessionId || typeof sessionId !== 'string') return invalido('sem sessao');
    const registro = lib.acharRegistro(sessionId, c.sessionsDir);
    if (!lib.ehInterativa(registro)) return invalido('so sessao interativa (aba do VS Code, terminal ou Claude Desktop com canal de recado)'); // F3.9, F4i
    if (tipo == null || tipo === '') tipo = 'outro';
    if (!TIPOS.has(tipo)) return invalido(`tipo desconhecido: use ${[...TIPOS].join(', ')}`);
    const lista = listaDestinatarios(destinatarios);
    const dest = lista.length ? lista : null;
    const texto = typeof acao === 'string' ? acao.trim() : '';
    const tam = Array.from(texto).length;
    if (tam < 1 || tam > MAX_ACAO) return invalido(`acao tem que ter de 1 a ${MAX_ACAO} caracteres`);

    const codigo = sortearCodigo();
    if (!codigo) return invalido('nao consegui sortear um codigo livre');
    const criado = agora();
    const expira = criado + VALIDADE_MS;
    const expiraEm = iso(expira);
    const hora = horaBRT(expiraEm);
    const titulo = tituloDaAba(sessionId, registro);
    const msg = montarMensagemPedido({ titulo, tipo, destinatarios: dest, acao: texto, hora });
    // A5c: o que o Sim libera (o botao do Telegram mostra; o conferirToque remonta daqui)
    const libera = tipo === 'publicacao' ? LIBERA.publicacao
      : tipo === 'disparo' ? (disparoPath ? LIBERA.disparo : LIBERA.disparoSemJanela)
        : LIBERA.demais;

    // A2b: sem WhatsApp nada vai pro grupo e o pedido nasce sem os ids dele (a mensagem sai pelo porteiro, no Telegram)
    let env_ = { providerMsgId: null, messageId: null };
    if (wpp) {
      env_ = await wpp.enviarGrupo(msg);
      if (!env_ || env_.ok !== true) {
        const porque = env_?.bloqueio ? `envio barrado: ${env_.bloqueio}` : `envio falhou: ${env_?.erro || 'sem resposta'}`;
        return invalido(porque);
      }
      if (!env_.providerMsgId && !env_.messageId) return invalido('envio sem id da mensagem');
    }

    const pedido = {
      v: 1,
      codigo,
      sessionId,
      titulo, // o verificar remonta a mensagem com ele (F3.1)
      tipo,
      acao: texto,
      hashAcao: hashDoPedido(tipo, texto, dest),
      destinatarios: dest,
      libera,
      criadoEm: iso(criado),
      expiraEm,
      providerMsgId: env_.providerMsgId ?? null,
      messageId: env_.messageId ?? null,
      status: 'pendente',
    };
    try {
      gravarAtomico(arquivoDe(codigo), JSON.stringify(pedido, null, 2));
    } catch (e) {
      return invalido(`nao consegui gravar o pedido: ${String(e?.code || e?.message || e).slice(0, 80)}`);
    }
    // T7b1b: telegram = o pedido tambem vale pelo toque no Telegram (OK ligado no config E a chave: o tgOk existe)
    return { status: 'pedido', codigo, expiraEm, hora, telegram: Boolean(tgOk) };
  }

  // ---------- verificar ----------

  async function verificar(codigo) {
    const cod = typeof codigo === 'string' ? codigo.trim().toUpperCase() : '';
    const sessionId = env.CLAUDE_CODE_SESSION_ID;
    const ignoradasTg = []; // T7b1b: toques do Telegram que nao valeram; vao na frente das ignoradas do resultado
    let r;
    try {
      r = await verificarSemLog(cod, sessionId, ignoradasTg);
    } catch (e) {
      r = invalido(`erro: ${String(e?.message || e).slice(0, 120)}`);
    }
    if (ignoradasTg.length && r.status !== 'invalido') {
      r = { ...r, ignoradas: [...ignoradasTg, ...(Array.isArray(r.ignoradas) ? r.ignoradas : [])] };
    }
    const extra = r.status === 'invalido' ? ` (${r.motivo})`
      : r.status === 'pendente' ? ` (${r.ignoradas?.length || 0} ignoradas${r.motivo ? `; ${r.motivo}` : ''})` : '';
    log(`verificar ${r.status} ${RE_CODIGO.test(cod) ? cod : '?'} sessao=${curto(sessionId)}${extra}`);
    return r;
  }

  function descreverIgnorada(m, texto) {
    return { providerMsgId: m.provider_msg_id ?? null, hora: horaBRT(m.message_ts), texto: texto || null };
  }

  async function verificarSemLog(cod, sessionId, ignoradasTg = []) {
    // A2a: com o WhatsApp e sem os 2 numeros do config, nada le o grupo (nem o ramo do Telegram) e o pedido fica intacto
    if (wpp && !numerosOk) return invalido(SEM_NUMEROS);
    // a) o pedido
    if (!RE_CODIGO.test(cod)) return invalido('codigo invalido');
    const arq = arquivoDe(cod);
    if (!fs.existsSync(arq)) return invalido('pedido nao encontrado');
    const p = lerJson(arq);
    if (!p || typeof p !== 'object') return invalido('pedido ilegivel');
    if (!sessionId || p.sessionId !== sessionId) return invalido('pedido de outra sessao');
    if (p.status === 'usado') return invalido('ja usado');
    if (p.status === 'recusado') return invalido('ja recusado');
    if (p.status !== 'pendente') return invalido('pedido ilegivel');
    const criado = msDe(p.criadoEm);
    const expira = msDe(p.expiraEm);
    if (!Number.isFinite(criado) || !Number.isFinite(expira)) return invalido('pedido ilegivel');
    if (agora() > expira) return invalido('expirou');
    if (typeof p.acao !== 'string' || hashDoPedido(p.tipo, p.acao, p.destinatarios) !== p.hashAcao) return invalido('pedido adulterado');
    if (!TIPOS.has(p.tipo)) return invalido('pedido adulterado');
    // destinatarios so nos formatos que o pedir grava (null ou lista nao vazia de textos): [] daria o mesmo texto que null
    if (!destinatariosValidos(p.destinatarios)) return invalido('pedido adulterado');

    // b) trava do porteiro; estado ausente ou ilegivel nega (F3.3, fail-closed)
    const estado = lerEstado();
    if (!estado) return invalido('estado do porteiro ilegivel');
    if (estado.trava === true) return invalido('travado pelo dono');

    // b2) T7b1b: o toque no Sim/Nao do pedido no chat do bot, relido no servidor do Telegram. So com o tgOk e so aqui:
    // prazo, sessao dona e status ja conferidos (pedido vencido, de outra sessao ou ja decidido nunca espia).
    if (tgOk) {
      const fim = await ramoTelegram({ cod, arq, p, estado, sessionId, criado, expira, ignoradasTg });
      if (fim) return fim;
    }

    // A2b: sem WhatsApp (ou pedido que nasceu sem ele, com o OK pelo Telegram) so o toque decide: sem decisao = pendente
    // com o motivo da ultima ignorada do Telegram (porteiro parado, leitura que falhou, toque que nao confere), nunca o
    // WhatsApp. Sem o OK pelo Telegram tambem = sem canal (o pedido segue pendente no disco).
    if (!wpp || (tgOk && !ehId(p.providerMsgId) && !ehId(p.messageId))) {
      if (!tgOk) return invalido(SEM_CANAL);
      const ultima = ignoradasTg.at(-1);
      return { status: 'pendente', motivo: ultima?.motivo || SEM_TOQUE, ignoradas: [] };
    }

    // c) membros do grupo: exatamente o dono e o robo do config (A2a). Falha da conexao (Z-API fora, resposta sem lista) =
    // "pendente, tenta de novo": nao concede e nao encerra o pedido (27/09 23:18 um group-metadata falho virou invalido e a
    // aba desistiu de um pedido que seguia valendo). Membro estranho ou faltando continua invalido.
    const passageira = (motivo) => ({ status: 'pendente', motivo, ignoradas: [] });
    let membros;
    try { membros = await wpp.membros(); } catch { return passageira('nao consegui conferir os membros agora; tenta de novo'); }
    if (!Array.isArray(membros)) return passageira('nao consegui conferir os membros agora; tenta de novo');
    const estranho = membros.map(String).find((f) => !membrosEsperados.includes(f));
    if (estranho !== undefined) return invalido(`membro estranho no grupo: ${estranho}`);
    if (!membrosEsperados.every((f) => membros.map(String).includes(f))) return invalido('nao consegui conferir os membros');

    // d) resposta do dono citando o pedido, dentro do prazo
    let prof;
    try { prof = await wpp.lerGrupo(LEITURA); } catch { return passageira('nao consegui ler o grupo agora; tenta de novo'); }
    const lidas = (Array.isArray(prof) ? prof : []).filter((m) => m && typeof m === 'object');

    // d1) F3.1: a acao aprovada e o TEXTO da mensagem do pedido no grupo (o que o dono leu). Ela e achada pelo id nesta
    // leitura e tem que ser, byte a byte, a que o arquivo do pedido monta: arquivo trocado (acao/tipo/titulo, mesmo com o
    // hash recalculado) ou mensagem que nao e a nossa = invalido, nada gravado.
    const doPedido = mensagensDoPedido(lidas, p);
    if (!doPedido.length) return invalido('mensagem do pedido nao encontrada no grupo');
    const esperado = typeof p.titulo === 'string'
      ? montarMensagemPedido({ titulo: p.titulo, tipo: p.tipo, destinatarios: p.destinatarios, acao: p.acao, hora: horaBRT(p.expiraEm) })
      : null; // pedido do formato antigo (sem titulo): nao da pra provar o que o dono viu
    if (esperado === null || !doPedido.every((m) => m.content === esperado)) return invalido('pedido diferente do que o dono viu');

    // d2) F3.3: "trava" do dono no grupo vale mesmo com o porteiro morto (estado.json sem trava). Conta toda "trava" desta
    // leitura depois do ultimo destravadoEm (sem destravadoEm = qualquer uma; hora ilegivel = conta).
    if (travaDoDonoNoGrupo(lidas, estado.destravadoEm, numeroDono)) return invalido('travado pelo dono');

    const outros = outrosPedidos(cod);
    // GPT-6 rodada 2, achado 1: pedido clonado (outro codigo com os mesmos ids da mensagem do pedido) reaproveitaria o
    // mesmo "sim" citado. A mensagem do pedido no grupo e a resposta do dono valem pra 1 pedido so.
    const mesmaMensagem = outros.some((x) => x && x.status !== 'pendente' &&
      ((ehId(p.providerMsgId) && x.providerMsgId === p.providerMsgId) || (ehId(p.messageId) && x.messageId === p.messageId)));
    if (mesmaMensagem) return invalido('mensagem do pedido ja usada por outro codigo');
    // d3) a 1a resposta do dono a este pedido que decide, e um "nao" depois dela vence (a regra F3.2 mora no
    // respostasAoPedido, a mesma do b2)
    const ignoradas = [];
    let ambiguas = 0;
    let ambiguasAgentes = 0;
    let decisiva = null;
    for (const r of respostasAoPedido(lidas, { p, criado, expira, doPedido, outros, numeroDono })) {
      if (r.vale === 'ambigua') { ambiguas += 1; continue; }
      if (r.vale === 'agentes') { ambiguasAgentes += 1; continue; }
      if (r.vale !== 'resposta') continue; // conversa solta, ou antes do pedido entrar no grupo
      // T7g (revisao da v2): o Nao vence, como no Telegram (T7b1b (i)): depois de um sim, um "nao" do dono que tambem e
      // resposta a este pedido (citando, ou solto pela F3.2) passa a valer ("beleza" e depois "Nao, espera." = recusado)
      if (decisiva) {
        if (r.classe === 'nao') { decisiva = { m: r.m, texto: r.texto, classe: r.classe }; break; }
        continue;
      }
      if (r.classe) {
        decisiva = { m: r.m, texto: r.texto, classe: r.classe };
        if (r.classe === 'nao') break;
        continue;
      }
      ignoradas.push(descreverIgnorada(r.m, r.texto));
    }
    if (!decisiva) {
      const lista = ignoradas.map((x) => (x.texto ? `"${x.texto.slice(0, 60)}" (${x.hora})` : `audio sem transcricao (${x.hora})`));
      let motivo = lista.length ? `nenhuma resposta decide; ignoradas: ${lista.join(', ')}` : 'sem resposta do dono ainda';
      if (ambiguas) motivo = `resposta sem citacao com mais de um pedido aberto: o dono tem que citar o pedido; ${motivo}`;
      if (ambiguasAgentes) motivo = `resposta sem citacao depois de outra mensagem dos agentes: o dono tem que citar o pedido; ${motivo}`;
      return { status: 'pendente', motivo, ignoradas };
    }
    const hora = horaBRT(decisiva.m.message_ts);
    const verificadoPor = { providerMsgId: decisiva.m.provider_msg_id ?? null, texto: decisiva.texto, hora };
    const extra = ignoradas.length ? { ignoradas } : {};

    // e) negativa: cancela (nao precisa da copia: recusar nunca libera nada)
    if (decisiva.classe === 'nao') {
      let barrado = null;
      try {
        barrado = comTrava(arq, () => {
          const atual = lerJson(arq);
          if (atual?.status !== 'pendente') return atual?.status === 'usado' ? 'ja usado' : 'ja recusado';
          gravarAtomico(arq, JSON.stringify({ ...atual, status: 'recusado', decididoEm: iso(agora()), verificadoPor }, null, 2));
          return null;
        }, { esperaMs: esperaTravaMs });
      } catch (e) {
        if (e?.code !== 'TRAVA_OCUPADA') throw e;
        return invalido('pedido ocupado por outra conferencia (rodar o verificar de novo)');
      }
      if (barrado) return invalido(barrado);
      return { status: 'recusado', motivo: 'o dono respondeu que nao', codigo: cod, hora, ...extra };
    }

    // f) a mesma mensagem vista pela instancia de conferencia (o numero pessoal do dono, A2a): saiu do celular dele, nao
    // de robo
    let pes;
    try { pes = await wpp.lerGrupo(LEITURA, { conferencia: true }); } catch { return passageira('nao consegui ler o grupo pelo numero pessoal agora; tenta de novo'); }
    const copias = (Array.isArray(pes) ? pes : []).filter(
      (m) => m && decisiva.m.provider_msg_id && m.provider_msg_id === decisiva.m.provider_msg_id && m.from_me === true,
    );
    if (copias.some((m) => m.sent_by_agent === true)) return invalido('mensagem enviada por robo');
    if (!copias.some((m) => m.sent_by_agent === false)) {
      return { status: 'pendente', motivo: 'esperando a copia do numero pessoal', ignoradas };
    }

    // g) passou: uso unico primeiro, depois o marker e a reacao
    // F3.4: 2 verificar do mesmo codigo em processos diferentes = so 1 consome (trava exclusiva do arquivo do pedido)
    const agoraMs = agora();
    let barrado = null;
    try {
      barrado = comTrava(arq, () => {
        const atual = lerJson(arq);
        if (atual?.status !== 'pendente') return atual?.status === 'recusado' ? 'ja recusado' : 'ja usado';
        // F3.3: a trava e relida IMEDIATAMENTE antes de conceder (o porteiro pode ter travado durante as leituras acima)
        const estadoAgora = lerEstado();
        if (!estadoAgora) return 'estado do porteiro ilegivel';
        if (estadoAgora.trava === true) return 'travado pelo dono';
        gravarAtomico(arq, JSON.stringify({ ...atual, status: 'usado', usadoEm: iso(agoraMs), verificadoPor }, null, 2));
        return null;
      }, { esperaMs: esperaTravaMs });
    } catch (e) {
      if (e?.code !== 'TRAVA_OCUPADA') throw e;
      return invalido('pedido ocupado por outra conferencia (rodar o verificar de novo)');
    }
    if (barrado) return invalido(barrado);
    if (p.tipo === 'publicacao') {
      try {
        gravarMarker(sessionId, { at: agoraMs, k: 'whatsapp', trecho: `${cod}: ${p.acao.slice(0, 80)}`, usos: 0 }, agoraMs);
      } catch (e) {
        log(`marker falhou ${cod}: ${String(e?.code || e?.message || e).slice(0, 80)}`);
        return invalido('OK conferido, mas nao consegui gravar o marker da trava de publicacao (pedir de novo)');
      }
    }
    if (p.tipo === 'disparo') {
      try {
        gravarOkDisparo(sessionId, { at: agoraMs, k: 'whatsapp', trecho: `${cod}: ${p.acao.slice(0, 80)}`, usos: 0 }, agoraMs);
      } catch (e) {
        log(`ledger do disparo falhou ${cod}: ${String(e?.code || e?.message || e).slice(0, 80)}`);
        return invalido('OK conferido, mas nao consegui gravar o OK na trava de disparo (pedir de novo)');
      }
    }
    if (decisiva.m.id) {
      try { await wpp.reagir(decisiva.m.id, '✅'); } catch { /* reacao nunca derruba o OK */ }
    }
    return {
      status: 'ok', codigo: cod, tipo: p.tipo, acao: p.acao, destinatarios: p.destinatarios ?? null, hora, ...extra,
    };
  }

  // ---------- b2: o toque no Telegram (T7b1b, Desenho 1b) ----------

  // (ii) porteiro vivo = pid do porteiro.lock vivo E estado.json gravado ha no maximo 60 s: e ele que segura o update do
  // toque (offset) e le a "trava" do chat do bot. So nega (o Sim cai pro WhatsApp); nunca prova nada.
  const lockArq = path.join(c.estadoDir, 'porteiro.lock');
  function porteiroVivoPadrao() {
    let pid;
    try { pid = Number.parseInt(fs.readFileSync(lockArq, 'utf8').trim(), 10); } catch { return false; }
    if (!pidVivo(pid)) return false;
    let gravado;
    try { gravado = fs.statSync(estadoArq).mtimeMs; } catch { return false; }
    const idade = agora() - gravado;
    return Number.isFinite(idade) && idade >= -FOLGA_RELOGIO_MS && idade <= PORTEIRO_FRESCO_MS;
  }
  const porteiroEstaVivo = typeof porteiroVivo === 'function' ? porteiroVivo : porteiroVivoPadrao;

  // A2b: o fim da linha de log do ramo do Telegram que nao decidiu (sem WhatsApp o pedido fica pendente)
  const seguiPor = () => (wpp ? 'segui pelo WhatsApp' : 'fica pendente');

  // Espiada do bot a partir do offset do porteiro: ate 3 tentativas no 409 (500 ms e 1 s entre elas); outro
  // erro, ou o 409 nas 3 = 1 linha de log e null (segue pelo WhatsApp).
  async function espiarTelegram(offset) {
    for (let i = 0; ; i++) {
      try {
        const lista = await tgOk.espiar({ offset });
        if (!Array.isArray(lista)) throw new Error('resposta sem lista');
        return lista;
      } catch (e) {
        if (e?.conflito === true && i < ESPERAS_409_MS.length) {
          await dormir(ESPERAS_409_MS[i]);
          continue;
        }
        log(`telegram: leitura falhou (${String(e?.message || e).slice(0, 160)}); ${seguiPor()}`);
        return null;
      }
    }
  }

  // Uso unico sob a trava exclusiva do arquivo do pedido (F3.4): rele o status e, com relerTrava, a trava do porteiro
  // logo antes de gravar (o desenho do g). null = gravou; senao, o motivo do invalido.
  function consumir(arq, campos, padrao, relerTrava) {
    try {
      return comTrava(arq, () => {
        const atual = lerJson(arq);
        if (atual?.status !== 'pendente') {
          return atual?.status === 'usado' ? 'ja usado' : atual?.status === 'recusado' ? 'ja recusado' : padrao;
        }
        if (relerTrava) {
          const estadoAgora = lerEstado();
          if (!estadoAgora) return 'estado do porteiro ilegivel';
          if (estadoAgora.trava === true) return 'travado pelo dono';
        }
        gravarAtomico(arq, JSON.stringify({ ...atual, ...campos }, null, 2));
        return null;
      }, { esperaMs: esperaTravaMs });
    } catch (e) {
      if (e?.code !== 'TRAVA_OCUPADA') throw e;
      return 'pedido ocupado por outra conferencia (rodar o verificar de novo)';
    }
  }

  // (iv) e (v): o toque valido decide. Sim = usado (+ marker/ledger k telegram); Nao = recusado. Os dois relendo status e
  // trava. Sem reacao no grupo; hora = a da conferencia (o callback_query nao tem hora).
  function decidirPeloToque({ cod, arq, p, sessionId, toque }) {
    const sim = toque.acao === 'sim';
    const agoraMs = agora();
    const hora = horaBRT(iso(agoraMs));
    const verificadoPor = {
      canal: 'telegram', updateId: toque.updateId, messageId: toque.messageId, texto: sim ? 'Sim' : 'Não', conferidoEm: iso(agoraMs),
    };
    const campos = sim
      ? { status: 'usado', usadoEm: iso(agoraMs), verificadoPor }
      : { status: 'recusado', decididoEm: iso(agoraMs), verificadoPor };
    const barrado = consumir(arq, campos, sim ? 'ja usado' : 'ja recusado', true);
    if (barrado) return invalido(barrado);
    if (!sim) return { status: 'recusado', motivo: 'o dono tocou em Nao no Telegram', codigo: cod, hora };
    const trecho = `${cod} pelo Telegram: ${p.acao.slice(0, 80)}`;
    if (p.tipo === 'publicacao') {
      try {
        gravarMarker(sessionId, { at: agoraMs, k: 'telegram', trecho, usos: 0 }, agoraMs);
      } catch (e) {
        log(`marker falhou ${cod}: ${String(e?.code || e?.message || e).slice(0, 80)}`);
        return invalido('OK conferido, mas nao consegui gravar o marker da trava de publicacao (pedir de novo)');
      }
    }
    if (p.tipo === 'disparo') {
      try {
        gravarOkDisparo(sessionId, { at: agoraMs, k: 'telegram', trecho, usos: 0 }, agoraMs);
      } catch (e) {
        log(`ledger do disparo falhou ${cod}: ${String(e?.code || e?.message || e).slice(0, 80)}`);
        return invalido('OK conferido, mas nao consegui gravar o OK na trava de disparo (pedir de novo)');
      }
    }
    return { status: 'ok', canal: 'telegram', codigo: cod, tipo: p.tipo, acao: p.acao, destinatarios: p.destinatarios ?? null, hora };
  }

  // b2) Resultado final (ok, recusado, invalido) ou null = segue pro WhatsApp, como antes. Conta SO o callback_query que
  // este processo leu no servidor do Telegram e que passa no conferirToque; toque deste codigo que nao confere (ou Sim
  // com o porteiro parado) vai pras ignoradasTg. Arquivo, estado e e.okTg nunca concedem. A leitura que nao aconteceu
  // (sem o offset do porteiro, ou o espiar falhou) tambem deixa rastro nas ignoradasTg: o toque pode existir e nao foi lido.
  async function ramoTelegram({ cod, arq, p, estado, sessionId, criado, expira, ignoradasTg }) {
    const naoLeu = () => ({ canal: 'telegram', updateId: null, motivo: 'nao consegui ler o Telegram agora; tenta de novo' });
    const offset = estado.tg?.offset; // o do porteiro, que segura o update do toque (nunca um offset proprio)
    if (!Number.isSafeInteger(offset) || offset < 1) {
      log(`telegram: sem o offset do porteiro no estado.json; ${seguiPor()}`);
      ignoradasTg.push(naoLeu());
      return null;
    }
    const lista = await espiarTelegram(offset);
    if (!lista) {
      ignoradasTg.push(naoLeu());
      return null;
    }
    // (iii) "trava" do dono no chat dele (o chatDono do tgOk) depois do destravadoEm, lida nesta espiada, vale mesmo sem
    // o porteiro ter visto
    if (travaNoChat(lista, { destravadoEm: estado.destravadoEm, chatDono: tgOk.chatDono })) return invalido('travado pelo dono');
    const validos = [];
    for (const u of lista) {
      const dados = lerDadosOk(u?.callback_query?.data);
      if (!dados || dados.codigo !== cod) continue; // de outro pedido (ou nao e botao de OK)
      const t = conferirToque(u, { pedido: p, botId: tgOk.botId, chatDono: tgOk.chatDono }); // A1b2: os do proprio tgOk
      if (!t.valido) {
        ignoradasTg.push({ canal: 'telegram', updateId: Number.isSafeInteger(u.update_id) ? u.update_id : null, motivo: `toque do Telegram nao confere: ${t.motivo}` });
      } else if (t.acao === 'sim' || t.acao === 'nao') {
        validos.push(t); // Mais informacoes valido nao decide
      }
    }
    // (i) o Nao vence, com ou sem Sim, e nao precisa do porteiro (recusar nunca libera nada)
    const nao = validos.find((t) => t.acao === 'nao');
    if (nao) return decidirPeloToque({ cod, arq, p, sessionId, toque: nao });
    const sim = validos.find((t) => t.acao === 'sim');
    if (!sim) return null;
    // (ii) o Sim so com o porteiro vivo; parado = o WhatsApp de hoje decide
    if (!porteiroEstaVivo()) {
      ignoradasTg.push({ canal: 'telegram', updateId: sim.updateId, motivo: 'porteiro parado: o toque do Telegram so vale com o porteiro vivo' });
      return null;
    }
    // (i) e d2 no grupo, leitura em melhor esforco (falhou = segue): "trava" do dono = invalido; o "nao" dele que o d
    // atribuiria a este pedido (citando, ou solto pela regra F3.2 do respostasAoPedido) vence o Sim = recusado (o mais antigo)
    let lidas = null;
    if (wpp) { // A2b: sem WhatsApp nao ha grupo pra ler
      try {
        const r = await wpp.lerGrupo(LEITURA);
        lidas = (Array.isArray(r) ? r : []).filter((m) => m && typeof m === 'object');
      } catch { lidas = null; }
    }
    if (lidas) {
      if (travaDoDonoNoGrupo(lidas, estado.destravadoEm, numeroDono)) return invalido('travado pelo dono');
      const naoNoGrupo = respostasAoPedido(lidas, { p, criado, expira, doPedido: mensagensDoPedido(lidas, p), outros: outrosPedidos(cod), numeroDono })
        .find((x) => x.vale === 'resposta' && x.classe === 'nao');
      if (naoNoGrupo) {
        // como o e de hoje: recusar nao precisa da copia do pessoal
        const hora = horaBRT(naoNoGrupo.m.message_ts);
        const verificadoPor = { providerMsgId: naoNoGrupo.m.provider_msg_id ?? null, texto: naoNoGrupo.texto, hora };
        const barrado = consumir(arq, { status: 'recusado', decididoEm: iso(agora()), verificadoPor }, 'ja recusado', false);
        if (barrado) return invalido(barrado);
        return { status: 'recusado', motivo: 'o dono respondeu que nao', codigo: cod, hora };
      }
    }
    return decidirPeloToque({ cod, arq, p, sessionId, toque: sim });
  }

  // Mesmo desenho da trava de publicacao do ambiente do dono: {sid: {at, k, trecho, usos}}, poda > 24 h, tmp+rename.
  // Trava ocupada = lanca (TRAVA_OCUPADA) e quem chama devolve invalido: nunca grava sem a trava (F3.4).
  function gravarMarker(sessionId, marker, agoraMs) {
    if (!markerPath) return; // A5c: sem a trava de publicacao de fora, nada a destravar
    comTrava(markerPath, () => {
      let markers = lerJson(markerPath);
      if (!markers || typeof markers !== 'object' || Array.isArray(markers)) markers = {};
      for (const k of Object.keys(markers)) {
        if (!markers[k] || agoraMs - Number(markers[k].at || 0) > PODA_MARKER_MS) delete markers[k];
      }
      markers[sessionId] = marker;
      gravarAtomico(markerPath, JSON.stringify(markers));
    }, { esperaMs: esperaTravaMs });
  }

  // Mesmo desenho da trava de disparo do ambiente do dono (registrarOk): ledger[sid].ok = {at, k, trecho, usos}; envios preservados.
  function gravarOkDisparo(sessionId, ok, agoraMs) {
    if (!disparoPath) return; // A5c: sem a trava de disparo de fora, nada a destravar
    comTrava(disparoPath, () => {
      let ledger = lerJson(disparoPath);
      if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) ledger = {};
      const s = ledger[sessionId] && typeof ledger[sessionId] === 'object' ? ledger[sessionId] : { envios: [] };
      s.ok = ok;
      s.ultimo = agoraMs;
      ledger[sessionId] = s;
      gravarAtomico(disparoPath, JSON.stringify(ledger));
    }, { esperaMs: esperaTravaMs });
  }

  // Os OUTROS pedidos da pasta (todas as abas), pra regra da resposta sem citacao.
  function outrosPedidos(cod) {
    let nomes;
    try { nomes = fs.readdirSync(oksDir); } catch { return []; }
    const out = [];
    for (const nome of nomes) {
      if (!RE_ARQ_CODIGO.test(nome) || nome === `${cod}.json`) continue;
      const x = lerJson(path.join(oksDir, nome));
      if (x && typeof x === 'object') out.push(x);
    }
    return out;
  }

  // ---------- listar ----------

  function listar() {
    const sessionId = env.CLAUDE_CODE_SESSION_ID;
    if (!sessionId) return [];
    let nomes;
    try { nomes = fs.readdirSync(oksDir); } catch { return []; }
    const agoraMs = agora();
    const out = [];
    for (const nome of nomes.sort()) {
      if (!RE_ARQ_CODIGO.test(nome)) continue;
      const p = lerJson(path.join(oksDir, nome));
      if (!p || p.sessionId !== sessionId || p.status !== 'pendente') continue;
      const expira = msDe(p.expiraEm);
      if (!Number.isFinite(expira) || agoraMs > expira) continue;
      out.push({ codigo: p.codigo, tipo: p.tipo, acao: p.acao, destinatarios: p.destinatarios ?? null, expiraEm: p.expiraEm, hora: horaBRT(p.expiraEm) });
    }
    return out;
  }

  return { pedir, verificar, listar };
}

// ---------- CLI ----------

// wpp real so na 1a chamada (listar e codigo invalido nunca leem o ~/.claude.json). A2a: pelo config (wppDoConfig: a
// entrada do whatsapp.mcp, o grupo e as instancias do bloco `whatsapp`).
function wppPreguicoso(ident) {
  let real = null;
  const w = () => (real ??= wppDoConfig(ident));
  return {
    lerGrupo: (...a) => w().lerGrupo(...a),
    enviarGrupo: (...a) => w().enviarGrupo(...a),
    reagir: (...a) => w().reagir(...a),
    membros: (...a) => w().membros(...a),
  };
}

/**
 * T7b1b: o tgOk do verificar (e o `telegram` do pedir). So existe com `telegram.ok.ligado` no config.json (lerConfigOk)
 * E a chave do bot (chaveTelegram: ambiente, senao registro); o cliente do Telegram so nasce na 1a espiada (como o
 * wppPreguicoso). Sem config ou sem chave = null: o ramo do Telegram nao existe.
 * `lerRegistro` e `criar` injetaveis (teste: dubles; nunca a chave nem a rede de verdade).
 * A1: sem telegram.chatId valido no config.json = null sem ler a chave; o cliente nasce com {token, chatId}. A1b1: a
 * chave pela variavel do telegram.varChave (identidadeTelegram: sem ela, ou fora do formato, a padrao). A1b2: devolve
 * {espiar, botId, chatDono}: chatDono = o telegram.chatId; botId = o telegram.botId, senao o id da propria chave
 * (botIdDaChave), senao null (o criarOkWpp confere o toque com os dois; sem o botId, nenhum toque confere).
 */
export async function tgOkPreguicoso({ estadoDir, env = process.env, lerRegistro, criar = criarTelegram } = {}) {
  if (!lerConfigOk(estadoDir).ligado) return null;
  const { chatId, botId, varChave } = identidadeTelegram(lerConfig(estadoDir)); // A1: o chat do dono, antes de ler a chave
  if (chatId === null) return null;
  const token = await chaveTelegram({ env, lerRegistro, varChave });
  if (!token) return null;
  let real = null;
  return {
    espiar: (...a) => (real ??= criar({ token, chatId })).espiar(...a),
    botId: botId ?? botIdDaChave(token),
    chatDono: chatId,
  };
}

function opcao(args, nome) {
  const i = args.indexOf(`--${nome}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

async function main(args) {
  const cmd = args[0];
  // A2b + A2a: WhatsApp desligado (ou incompleto) no config = wpp null (o wppPreguicoso nunca nasce: nada le o
  // ~/.claude.json); ligado = o grupo, as instancias e os 2 numeros do bloco `whatsapp`. A4a: o mesmo cfg da o fuso das
  // horas (o do dono, senao o do Windows), antes de qualquer hora montada
  const estadoDir = lib.caminhos(process.env).estadoDir;
  const cfg = lerConfig(estadoDir);
  definirFuso(donoDoConfig(cfg).fuso);
  const ident = identidadeWhatsapp(cfg);
  const opts = ident.ligado
    ? { wpp: wppPreguicoso(ident), numeroDono: ident.numeroDono, numeroRobo: ident.numeroRobo }
    : { wpp: null };
  // A5c: as travas de fora pelo mesmo cfg. A lib so carrega na hora de travar (nao existe = lanca la dentro e o OK falha
  // fechado); sem ela, a trava propria. O marker e o ledger pelos caminhos do config; as 2 variaveis (so pra teste) por cima
  const travas = travasDoConfig(cfg);
  if (travas.lib) opts.comTrava = (...a) => require(travas.lib).comTrava(...a);
  opts.markerPath = process.env.SESSOES_WPP_DEPLOY_MARKER || travas.deployMarker;
  opts.disparoPath = process.env.SESSOES_WPP_DISPARO_LEDGER || travas.disparoLedger;
  // T7b1b: o OK pelo Telegram so no pedir e no verificar (o listar nunca le config nem chave)
  if (cmd === 'pedir' || cmd === 'verificar') opts.tgOk = await tgOkPreguicoso({ estadoDir });
  const ok = criarOkWpp(opts);
  let r;
  if (cmd === 'pedir') {
    r = await ok.pedir({ tipo: opcao(args, 'tipo'), acao: opcao(args, 'acao'), destinatarios: opcao(args, 'destinatarios') });
  } else if (cmd === 'verificar') {
    r = await ok.verificar(args[1]);
  } else if (cmd === 'listar') {
    console.log(JSON.stringify(ok.listar()));
    return 0;
  } else {
    r = invalidoUso();
  }
  console.log(JSON.stringify(r));
  return codigoDeSaida(r.status);
}

function invalidoUso() {
  return { status: 'invalido', motivo: 'uso: ok-wpp.mjs pedir [--tipo <crm|mensagem|publicacao|disparo|pagamento|apagar|outro>] --acao "<texto>" [--destinatarios "A; B"] | verificar <CODIGO> | listar' };
}

function ehPrincipal() {
  if (!process.argv[1]) return false;
  const a = path.resolve(process.argv[1]);
  return process.platform === 'win32' ? a.toLowerCase() === ESTE_ARQUIVO.toLowerCase() : a === ESTE_ARQUIVO;
}

if (ehPrincipal()) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => {
      console.log(JSON.stringify({ status: 'invalido', motivo: `erro: ${String(err?.message || err).slice(0, 200)}` }));
      process.exitCode = 1;
    },
  );
}
