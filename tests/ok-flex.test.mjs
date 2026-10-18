// T7g v2 (PLANO-T7.md, secao "T7g", decisao v2). Pedido do dono, num caso real:
// "estava sendo obrigatorio eu digitar sim ou ok, e eu nao queria que fosse assim, eu queria que a gente tivesse
// mais flexibilidade". O OK e a trava das acoes irreversiveis das abas: sim falso e o erro caro; null (nao decide) e barato.
// Por que existe: a flexibilidade vale SO na resposta que CITA o pedido (texto, audio ou emoji), em MUNDO FECHADO (so
// decide a frase em que toda palavra e de aprovacao; palavra fora do vocabulario = null); a resposta SOLTA segue
// EXATAMENTE a regra de hoje (frase inteira nas listas fechadas), conferida aqui contra a funcao de hoje reimplementada.
// A v1 (regra aberta R7 + solta com vocabulario maior) caiu na revisao adversarial: "pode segurar", "Pode dar problema.",
// "manda o link" viravam sim citando, e "beleza" ou o polegar soltos viravam OK (C:/tmp/t7-c-t7g-rev-*.mjs).
// A revisao da v2 (03/10/2026 ~12h, C:/tmp/t7g-v2-rev-*.mjs) achou sim falso citando: "pode apagar isso" (descarta),
// "Pode mandar, ne", "Ok, ja ja", "pode mandar mesmo", "confirma ai", texto com emoji de ironia ou duvida ("Ta bom 🙄")
// e "beleza⁉"; e recusa falsa: "Nao tem problema", "Nao vejo por que nao", "Nao, tudo certo". Tudo isso virou null aqui.
// Testes 99 a 101; o 102 (porteiro) mora em tests/porteiro-ok-flex.test.mjs.
// Andaime do verificar copiado de tests/ok-wpp.test.mjs (montar/responder/pedidoCom): pastas temporarias, wpp dublado,
// relogio falso. Nada de rede, WhatsApp real ou ~/.claude/sessoes-wpp real.
// Rodar: node --test --test-reporter=tap "tests/ok-flex.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pastaTemp } from './lib/pasta-temp.cjs';
import * as okMod from '../ok-wpp.mjs'; // as listas novas por namespace: faltando, so o teste delas fica vermelho
import { criarOkWpp, AFIRMATIVAS, NEGATIVAS, classificarResposta, normalizarResposta } from '../ok-wpp.mjs';
import { NUMERO_DONO, NUMERO_ROBO } from './lib/dados-whatsapp.mjs';

const MIN = 60 * 1000;
const T0 = Date.parse('2026-09-27T19:00:00Z'); // 16:00 em Brasilia; o pedido vale ate 16:30
const SID = '11111111-2222-4333-8444-555555555555';
const PID = 4242;
const iso = (ms) => new Date(ms).toISOString();
const tsWpp = (ms) => iso(ms).replace(/\.\d{3}Z$/, '+00:00'); // formato do read (medido 27/09)

// ---------- a regra de HOJE (base ee26e4a), reimplementada aqui de proposito ----------
// A solta (e todo o porteiro) e ela: frase inteira, minuscula, sem acento e sem pontuacao, numa das 2 listas fechadas.
const HOJE_AFIRMATIVAS = [
  'sim', 's', 'pode', 'pode sim', 'pode ir', 'pode mandar', 'pode seguir', 'pode publicar', 'manda', 'ok', 'okay', 'confirmo',
  'confirmado', 'aprovado', 'aprovo', 'autorizo', 'vai', 'a',
];
const HOJE_NEGATIVAS = ['nao', 'n', 'cancela', 'cancelar', 'para', 'espera', 'b'];
function classificarHoje(s) {
  if (s == null) return null;
  const t = String(s)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  if (HOJE_AFIRMATIVAS.includes(t)) return 'sim';
  if (HOJE_NEGATIVAS.includes(t)) return 'nao';
  return null;
}

const VINTE_E_CINCO_SIM = Array(25).fill('sim').join(' ');
const nomeDe = (f) => (f === null ? 'null' : f === VINTE_E_CINCO_SIM ? '"sim" 25 vezes' : JSON.stringify(f));

// [frase, citada esperada] -> divergencias (lista vazia = tudo certo). A solta de cada frase (sem a opcao, com {} e com
// citada: false; o porteiro chama sem a opcao) = a regra de hoje.
function divergencias(linhas) {
  const erros = [];
  for (const [frase, citada] of linhas) {
    const hoje = classificarHoje(frase);
    const r = [
      ['sem opcao', classificarResposta(frase), hoje],
      ['{}', classificarResposta(frase, {}), hoje],
      ['citada: false', classificarResposta(frase, { citada: false }), hoje],
      ['citada: true', classificarResposta(frase, { citada: true }), citada],
    ];
    for (const [k, obtido, esperado] of r) {
      if (obtido !== esperado) erros.push(`${nomeDe(frase)} ${k}: ${obtido} (esperado ${esperado})`);
    }
  }
  return erros;
}

// ---------- a tabela da secao T7g v2 (normativa: cada frase vira assercao) ----------

const POLEGAR = '\u{1F44D}';
const POLEGAR_TOM_MEDIO = '\u{1F44D}\u{1F3FD}';
const TABELA_SIM = [
  'sim', 'Sim, pode mandar.', 'pode mandar', 'manda ver', 'manda bala', 'beleza', 'blz, pode ir', 'Ok, pode seguir com isso.',
  'fechado', 'show, manda', 'claro', 'sim sim', 'aprovado, pode publicar', 'pode sim, por favor', 'Pode mandar, sem problema.',
  'vai lá', 'bora', 'pode fazer', 'a', 'tá bom', 'tudo certo', 'com certeza', 'uhum', 'isso mesmo', 'então tá',
  POLEGAR, POLEGAR_TOM_MEDIO + POLEGAR_TOM_MEDIO, '\u{2705}', '\u{2705}\u{2705}', `ok ${POLEGAR}`,
];
const TABELA_NAO = [
  'não', 'Não, espera.', 'não pode', 'não pode mandar ainda', 'não quero isso', 'espera aí', 'cancela', 'para tudo',
  'nem pensar', 'b', '\u{1F44E}', '\u{274C}', 'não sei o que fazer com isso', 'Não, agora não',
];
const TABELA_NULL = [
  'Sim, pode publicar o site novo.', 'pode mandar pro João e pra Maria', 'pode mandar o relatório pro João',
  'Sim. Pode publicar em produção.', `${POLEGAR} pode mandar o relatório pro João`, 'pode mandar amanhã',
  'pode, mas muda o título antes', 'pode mandar só pro João', 'sim, se estiver tudo certo', 'pode?', 'posso mandar?',
  'beleza\u{2753}', 'pode mandar\u{FF1F}', 'acho que pode', 'pode mandar às 15h', 'simm', 'c', 'obrigado', 'trava',
  'sim mas espera', 'pode nao', 'ok, mas depois', 'Não, pode mandar.', `${POLEGAR} não`, '\u{1F44E} pode mandar',
  `${POLEGAR}\u{1F64F}`, '', null, VINTE_E_CINCO_SIM, 'pode segurar', 'pode adiar', 'Pode dar problema.', 'Isso eu faço.',
  'ok, deixa eu ver', 'manda o link', 'faz um teste comigo', 'pode mandar pra todo mundo tirando o João',
  'o João pediu pra segurar, ok', 'espera, pode mandar', 'cancela esse, manda o outro', 'acho melhor esperar',
  'o joao disse nao', 'apaga isso', 'vai ver',
  // revisao da v2: sim falso (descarte, pergunta sem "?", adiamento, conferir, ironia ou duvida no emoji, sinal de
  // pergunta fora do "?") e recusa falsa (aprovacao dita pela negacao; outra pontuacao depois do "nao")
  'pode apagar', 'pode apagar isso', 'Pode mandar, né', 'Ok, já já.', 'pode mandar mesmo', 'ok, e agora', 'tá certo isso',
  'confirma aí', 'beleza\u{2049}\u{FE0F}', 'Tá bom \u{1F644}', 'beleza :/', 'pode mandar sem foto', 'Não tem problema.',
  'Não vejo por que não', 'Não, tudo certo', 'Não\u{2026} pode mandar',
];
const TABELA = [
  ...TABELA_SIM.map((f) => [f, 'sim']),
  ...TABELA_NAO.map((f) => [f, 'nao']),
  ...TABELA_NULL.map((f) => [f, null]),
];

test('T7g 99. a tabela inteira na citada; a solta de cada linha = a regra de hoje', () => {
  // a tabela da secao, frase a frase (30 sim, 14 nao, 60 null)
  assert.deepEqual([TABELA_SIM.length, TABELA_NAO.length, TABELA_NULL.length], [30, 14, 60]);
  assert.deepEqual(divergencias(TABELA), []);
});

// ---------- as listas (exportadas e congeladas, sem acento como a normalizarResposta deixa) ----------

const SIM_INICIO = [
  'sim', 's', 'ss', 'pode', 'podem', 'manda', 'mande', 'vai', 'bora', 'ok', 'okay', 'okey', 'yes', 'beleza', 'blz', 'fechado',
  'fechou', 'combinado', 'aprovado', 'aprovo', 'aprova', 'autorizo', 'autorizado', 'autoriza', 'confirmo', 'confirmado',
  'positivo', 'claro', 'certo', 'perfeito', 'otimo', 'show', 'top', 'joia', 'isso', 'segue', 'siga', 'prossiga', 'libera',
  'liberado', 'faz', 'faca', 'publica', 'envia', 'dispara', 'executa', 'roda', 'paga', 'valendo', 'demorou',
]; // v2: sem "apaga" ("apaga isso" = descarta); revisao da v2: sem "confirma" ("confirma ai" = confere)
const NAO_INICIO = [
  'nao', 'n', 'nem', 'nunca', 'jamais', 'negativo', 'cancela', 'cancelar', 'cancelado', 'para', 'pare', 'parar', 'espera',
  'espere', 'esperar', 'pera', 'perai', 'calma', 'aguarda', 'aguarde', 'aguardar', 'segura', 'segure', 'recuso', 'recusado',
  'nego',
];
const LISTAS = {
  SIM_INICIO,
  // SIM_INICIO menos isso, certo e claro (comuns dentro de frase negativa: "nao e isso", "nao ta certo")
  SIM_VIRA: SIM_INICIO.filter((x) => !['isso', 'certo', 'claro'].includes(x)),
  // revisao da v2: sairam "apagar" ("pode apagar isso" = descarta), "confirmar" e as que fazem pergunta ou adiamento sem
  // "?" ("ne", "mesmo", "e", "esta", "ta"); "ja" fica, mas nunca no par "ja ja" (daqui a pouco)
  VOCAB_SIM: [
    ...SIM_INICIO, 'mandar', 'ir', 'seguir', 'prosseguir', 'fazer', 'publicar', 'enviar', 'disparar', 'executar', 'rodar',
    'pagar', 'liberar', 'aprovar', 'autorizar', 'ver', 'bala', 'brasa', 'la', 'ai', 'agora', 'ja', 'tudo', 'bem', 'bom', 'boa',
    'com', 'certeza', 'por', 'favor', 'pf', 'pfv', 'obrigado', 'obrigada', 'valeu', 'entao', 'tranquilo', 'de',
  ],
  // v2, nova: frase inteira (revisao da v2: + "isso mesmo" e "entao ta", que o "mesmo" e o "ta" fora do vocabulario tiraram)
  FRASES_SIM: [
    'ta', 'ta bom', 'ta bem', 'ta certo', 'ta ok', 'tudo bem', 'tudo certo', 'com certeza', 'tranquilo', 'de boa', 'uhum', 'aham',
    'pode crer', 'vamos', 'vamos la', 'isso mesmo', 'entao ta',
  ],
  // revisao da v2, nova (R5): desfazem o "nao" do comeco (aprovacao dita pela negacao)
  DESFAZ_NAO: [
    'problema', 'problemas', 'erro', 'oponho', 'objecao', 'precisa', 'esquece', 'esqueca', 'esquecer', 'deixa', 'deixe', 'deixar',
  ],
  NAO_INICIO,
  // NAO_INICIO menos "para" (no meio da frase e "pra")
  BLOQUEIO: [
    ...NAO_INICIO.filter((x) => x !== 'para'), 'depois', 'antes', 'ainda', 'amanha', 'tarde', 'noite', 'semana', 'mes', 'mas',
    'porem', 'contudo', 'entretanto', 'so', 'somente', 'apenas', 'exceto', 'menos', 'sem', 'se', 'caso', 'talvez', 'acho',
    'sei', 'duvida', 'melhor', 'errado', 'errada', 'erro', 'muda', 'mude', 'mudar', 'troca', 'troque', 'trocar', 'corrige',
    'corrija', 'corrigir', 'ajusta', 'ajuste', 'ajustar', 'tira', 'tire', 'tirar', 'remove', 'remova', 'remover', 'coloca',
    'coloque', 'colocar', 'acrescenta', 'acrescente', 'inclui', 'inclua', 'incluir', 'edita', 'edite', 'editar', 'revisa',
    'revise', 'revisar', 'confere', 'confira', 'conferir', 'que', 'qual', 'quais', 'quando', 'como', 'onde', 'quem', 'porque',
    'pq', 'trava', 'travar', 'outro', 'outra', 'outros', 'outras',
  ],
};
// Emoji base, sem FE0F e sem tom de pele (a comparacao tira os dois): 👍 👌 ✅ ✔ 🆗 | 👎 ❌ ✋ 🛑.
const EMOJIS = {
  SIM_EMOJI: ['\u{1F44D}', '\u{1F44C}', '\u{2705}', '\u{2714}', '\u{1F197}'],
  NAO_EMOJI: ['\u{1F44E}', '\u{274C}', '\u{270B}', '\u{1F6D1}'],
};

test('T7g 99. listas novas exportadas, congeladas e presas (as de emoji tambem); AFIRMATIVAS e NEGATIVAS iguais as de hoje', () => {
  for (const [nome, esperada] of Object.entries({ ...LISTAS, ...EMOJIS })) {
    const lista = okMod[nome];
    assert.ok(Array.isArray(lista), `${nome} exportada`);
    assert.ok(Object.isFrozen(lista), `${nome} congelada`);
    assert.deepEqual([...lista], esperada, nome);
  }
  for (const [nome, lista] of Object.entries(LISTAS)) {
    const forma = nome === 'FRASES_SIM' ? /^[a-z]+( [a-z]+)*$/ : /^[a-z]+$/;
    for (const p of lista) assert.ok(forma.test(p) && normalizarResposta(p) === p, `${nome}: "${p}" sem acento, ja normalizada`);
  }
  // revisao da v2: a seguranca do R6 e o VOCAB_SIM (mundo fechado); o BLOQUEIO nao tem palavra dele (o "nenhuma de
  // bloqueio" e a 2a trava), e o "nao" nunca e palavra de sim
  assert.deepEqual(okMod.BLOQUEIO.filter((p) => okMod.VOCAB_SIM.includes(p)), []);
  assert.deepEqual(okMod.NAO_INICIO.filter((p) => okMod.VOCAB_SIM.includes(p)), []);
  // as listas de hoje nao mudam (frase inteira; "a" e "b" so valem assim)
  assert.deepEqual([...AFIRMATIVAS], HOJE_AFIRMATIVAS);
  assert.deepEqual([...NEGATIVAS], HOJE_NEGATIVAS);
  assert.ok(Object.isFrozen(AFIRMATIVAS) && Object.isFrozen(NEGATIVAS));
});

// ---------- R1 a R6 por extenso (o que a secao escreve fora da tabela) ----------

const TONS = ['\u{1F3FB}', '\u{1F3FC}', '\u{1F3FD}', '\u{1F3FE}', '\u{1F3FF}'];
const REGRAS = [
  // R1: ?, ❓, ❔, ？ ou ¿ no texto cru = null (antes de tudo, inclusive do emoji)
  ...[
    'pode mandar?', 'pode mandar\u{2753}', 'pode mandar\u{2754}', 'pode mandar\u{FF1F}', '\u{BF}pode mandar', 'sim?',
    'beleza\u{2754}', `${POLEGAR}\u{2753}`, '\u{2753}', `${POLEGAR}?`,
    // revisao da v2: ⁉ (o do teclado de emoji do WhatsApp, com e sem FE0F), ‽, ⁇, ⁈, ؟, ﹖ e ︖
    'pode mandar\u{2049}\u{FE0F}', 'manda ver\u{2049}', 'pode publicar\u{203D}', 'pode mandar\u{2047}', 'show\u{2048}',
    'pode mandar\u{61F}', 'blz\u{FE56}', 'tá bom\u{FE16}', '\u{2049}\u{FE0F}',
  ].map((f) => [f, null]),
  // R2 so emoji (sem letra nem numero): repetidos, espacos, FE0F e tons valem
  ...[
    '\u{1F44D}', '\u{1F44C}', '\u{2705}', '\u{2714}\u{FE0F}', '\u{2714}', '\u{1F197}', '\u{1F44D} \u{1F44D}', '\u{1F44D}\u{FE0F}',
    '\u{2705} \u{2705} \u{2705}', ...TONS.map((t) => `\u{1F44D}${t}`), `\u{1F44C}${TONS[4]}`,
  ].map((f) => [f, 'sim']),
  ...[
    '\u{1F44E}', '\u{274C}', '\u{270B}', '\u{1F6D1}', '\u{1F44E}\u{1F44E}', '\u{274C} \u{274C}', ...TONS.map((t) => `\u{1F44E}${t}`),
    `\u{270B}${TONS[0]}`,
  ].map((f) => [f, 'nao']),
  // R2: emoji fora das 2 listas (sozinho ou junto), os 2 grupos juntos, so pontuacao ou espaco = null
  ...[
    '\u{1F64F}', '\u{1F44D}\u{1F44E}', '\u{274C}\u{2705}', '\u{1F600}', '\u{1F440}', '\u{1F937}', '\u{1F914}', '\u{1F602}',
    '\u{2764}\u{FE0F}', '\u{1F525}', '\u{1F44F}', '\u{1F4AA}', '\u{1F64C}', '\u{270C}\u{FE0F}', '\u{1F91D}', '\u{1F609}',
    '\u{2705}\u{1F525}', '...', ' ',
  ].map((f) => [f, null]),
  // R2 com letra ou numero: o texto decide; emoji do grupo contrario anula; os 2 grupos juntos = null
  ['pode mandar \u{2705}', 'sim'],
  [`beleza ${POLEGAR_TOM_MEDIO}`, 'sim'],
  ['não \u{274C}', 'nao'],
  ['pode mandar \u{274C}', null],
  [`ok ${POLEGAR}\u{1F44E}`, null],
  [`não ${POLEGAR}`, null],
  ['Pode mandar \u{2714}\u{FE0F}', 'sim'], ['*Sim*', 'sim'], ['Sim!!!', 'sim'], ['ok, pode mandar; valeu', 'sim'],
  // revisao da v2: com letra ou numero, so letra, numero, espaco, , . ; : !, * _ ~ e o emoji das 2 listas; qualquer outro
  // simbolo (emoji de ironia, duvida ou recusa fora da lista, emoticon, reticencias de 1 caractere, travessao, hifen,
  // parenteses, aspas, ZWJ) = null
  ...[
    'Tá bom \u{1F644}', 'Ótimo \u{1F644}', 'beleza \u{1F612}', 'beleza \u{1F914}', 'Beleza \u{1F621}', 'perfeito \u{1F926}',
    'ok \u{1F926}\u{200D}\u{2642}\u{FE0F}', 'fechado \u{1F645}', 'pode mandar \u{1F6AB}', 'pode mandar \u{26D4}',
    'pode mandar \u{274E}', 'pode mandar \u{26A0}\u{FE0F}', 'pode mandar \u{1F91A}', 'Sim \u{1F64F}', 'beleza :/', 'tá bom :|',
    'ok :(', 'pode mandar :/', 'Beleza\u{2026}', 'pode mandar - valeu', 'pode mandar (valeu)', 'pode "mandar"',
  ].map((f) => [f, null]),
  // R3: FRASES_SIM com acento e pontuacao como o dono escreve; so a frase inteira (fora dela, o mundo fechado)
  ['Tá bom!', 'sim'], ['Vamos lá.', 'sim'], ['De boa', 'sim'], ['Aham', 'sim'], ['Pode crer!', 'sim'], ['tudo bem', 'sim'],
  ['Isso mesmo!', 'sim'], ['Então tá.', 'sim'],
  ['vamos mandar', null], ['uhum pode', null], ['de boa mesmo', null], ['pode crer que sim', null], ['isso mesmo não', null],
  ['então tá bom', null], ['Tá bom, tá bom.', null],
  // R4: o par "sem problema(s)" e enfeite; "sem" fora do par fica fora do vocabulario (revisao da v2: "sem" + palavra sem
  // artigo, a restricao que nao pode virar sim)
  ['pode mandar, sem problemas', 'sim'], ['pode mandar sem o anexo', null], ['sem problema', null],
  ['pode mandar sem foto', null], ['pode publicar sem revisar', null], ['manda sem anexo', null], ['pode sem', null],
  // R4: mais de 20 palavras = null (20 ainda decide), no sim e no nao
  [Array(20).fill('sim').join(' '), 'sim'], [Array(21).fill('sim').join(' '), null],
  [Array(20).fill('não').join(' '), 'nao'], [Array(21).fill('não').join(' '), null],
  // R5: "não"/"nao" + pontuacao + palavra de SIM_VIRA depois = null (ambiguo); com acento decomposto e negrito tambem
  ...['Não; pode mandar', 'nao: pode', 'Não! Pode mandar.', 'Não. Pode publicar', 'Na\u{303}o, pode mandar.', '*Não*, pode mandar']
    .map((f) => [f, null]),
  // R5: palavra de SIM_VIRA so vale logo depois de nao/n/nem; isso, certo e claro nao sao SIM_VIRA
  ['nem pode', 'nao'], ['n pode', 'nao'], ['não pode mandar isso ainda', 'nao'], ['não é isso', 'nao'], ['não tá certo', 'nao'],
  ['Não, claro que não', 'nao'], ['calma, pode mandar', null],
  // R5 (revisao da v2): depois da pontuacao, o que vem decide: palavra de SIM_VIRA livre ou frase de FRASES_SIM = null;
  // "nao" repetido no comeco tambem ("Nao nao, pode"); o SIM_VIRA logo depois de outro "nao" segue negacao
  ['Não não, pode mandar', null], ['Não, tudo certo', null], ['Não, tudo bem', null], ['Não... pode mandar', null],
  ['Não, pode.', null], ['*Não* pode mandar', 'nao'], ['Não, não pode', 'nao'], ['nao, nao', 'nao'], ['não não', 'nao'],
  ['Não, claro', 'nao'],
  // R5 (revisao da v2): outra pontuacao depois do "nao" ja caiu no R2 (null), nunca recusa
  ...['Não\u{2026} pode mandar', 'Não \u{2014} pode mandar', 'Não \u{2013} pode mandar', 'Não - pode mandar', 'Não (pode mandar)',
    'Não\u{201D}, pode mandar'].map((f) => [f, null]),
  // R5 (revisao da v2): aprovacao dita pela negacao = null: palavra de DESFAZ_NAO (antes de tirar o "sem problema"), o
  // "por que" e um 2o "nao" no meio da frase longe de outra negacao. "Nao precisa" sozinho (recusa) cai junto: null e o
  // erro barato
  ...[
    'Não tem problema', 'Não tem problema.', 'Não há problema', 'Não vejo problema', 'Não há problema nenhum', 'Não tem erro',
    'Não me oponho', 'Nenhuma objeção', 'Não precisa esperar', 'Nem precisa perguntar', 'Não esquece de mandar',
    'Não esqueça de publicar', 'Não deixa de mandar', 'Não, sem problema.', 'Não, sem problemas', 'nao sem problema',
    'Não precisa', 'Não vejo por que não', 'Não tem por que esperar', 'Não tem como não aprovar',
    'Não vejo motivo pra não mandar', 'Não. Ainda não sei',
  ].map((f) => [f, null]),
  // R5 (revisao da v2): o "nao" do fim e enfase, e o colado em outra negacao tambem: segue recusa
  ['Não, agora não', 'nao'], ['Não, ainda não', 'nao'], ['Nem pensar, não', 'nao'], ['Para, não manda', 'nao'],
  ['Cancela, não quero mais', 'nao'],
  // R6: ver, bala e brasa so logo depois de manda/mande
  ['mande ver', 'sim'], ['mande brasa', 'sim'], ['manda brasa', 'sim'], ['pode ver', null], ['ver', null], ['bala', null],
  ['brasa', null], ['manda ver bala', null], ['ok, ver', null],
  // R6: "apaga" sozinho ficou fora (descarta); revisao da v2: "apagar" tambem ("pode apagar isso" = descarta)
  ['apaga', null], ['Pode apagar.', null], ['pode apagar tudo', null], ['Ok, pode apagar.', null], ['apagar', null],
  // R6 (revisao da v2): pergunta, ironia ou adiamento sem "?" ("ne", "mesmo", "e", "esta", "ta" fora de FRASES_SIM) e
  // conferir ("confirma", "confirmar") nao decidem; "confirmo" e "confirmado" seguem sim
  ...[
    'pode mandar né', 'Pode mandar, né', 'beleza né', 'Ótimo, né', 'ok né', 'tá certo né', 'pode mandar mesmo', 'vai mesmo',
    'ok e agora', 'Certo, e então', 'beleza e aí', 'é isso', 'e pode mandar', 'esta certo', 'tá certo isso', 'confirma',
    'confirma aí', 'Confirma tudo', 'pode confirmar',
  ].map((f) => [f, null]),
  ['confirmo', 'sim'], ['Confirmado, pode mandar.', 'sim'],
  // R6 (revisao da v2): "ja" vale ("ja pode mandar"), mas nunca no par "ja ja" (daqui a pouco)
  ['já pode mandar', 'sim'], ['pode mandar já', 'sim'], ['Ok, já já.', null], ['beleza, já já', null], ['pode mandar já já', null],
  ['faz já já', null],
];

test('T7g 99. regras por extenso: pergunta (R1), emoji (R2), FRASES_SIM (R3), 20 palavras (R4), "nao" (R5), ver/bala/brasa (R6)', () => {
  assert.deepEqual(divergencias(REGRAS), []);
  // cada emoji das listas decide sozinho (citada); solto, nenhum decide (a regra de hoje)
  for (const e of EMOJIS.SIM_EMOJI) assert.equal(classificarResposta(e, { citada: true }), 'sim', `SIM_EMOJI ${e}`);
  for (const e of EMOJIS.NAO_EMOJI) assert.equal(classificarResposta(e, { citada: true }), 'nao', `NAO_EMOJI ${e}`);
  for (const e of [...EMOJIS.SIM_EMOJI, ...EMOJIS.NAO_EMOJI]) assert.equal(classificarResposta(e), null, `solto ${e}`);
});

test('T7g 99. cada palavra das listas decide como a regra manda (citada); a solta de todas = a regra de hoje', () => {
  const casos = [];
  const SO_DEPOIS_DE_MANDA = ['ver', 'bala', 'brasa'];
  for (const p of LISTAS.SIM_INICIO) casos.push([p, 'sim']); // R6: 1 palavra de inicio basta
  for (const p of LISTAS.VOCAB_SIM) {
    // R6: toda palavra no vocabulario, ao menos 1 de inicio
    if (SO_DEPOIS_DE_MANDA.includes(p)) casos.push([`manda ${p}`, 'sim'], [`mande ${p}`, 'sim'], [`pode ${p}`, null]);
    else casos.push([`pode ${p}`, 'sim'], [`${p}, pode mandar`, 'sim']);
    // sem palavra de inicio nao decide (as de FRASES_SIM decidem pela frase inteira)
    if (!LISTAS.SIM_INICIO.includes(p) && !LISTAS.FRASES_SIM.includes(p)) casos.push([p, null]);
  }
  for (const f of LISTAS.FRASES_SIM) casos.push([f, 'sim']); // R3: frase inteira
  for (const p of LISTAS.NAO_INICIO) casos.push([p, 'nao']); // R5: a negacao sozinha
  for (const p of LISTAS.DESFAZ_NAO) casos.push([`não ${p}`, null], [`nem ${p}`, null], [`não, ${p}`, null]); // R5: desfaz
  for (const p of LISTAS.SIM_VIRA) {
    casos.push([`não ${p}`, 'nao']); // R5: logo depois do "nao" e negacao ("nao pode")
    casos.push([`espera, ${p}`, null]); // R5: fora dela, ambiguo; e "espera" fica fora do vocabulario do sim
  }
  for (const p of LISTAS.BLOQUEIO) casos.push([`pode ${p}`, null], [`ok ${p}`, null]); // R6: nenhuma de bloqueio
  for (const p of ['nunca', 'jamais', 'aguarde', 'segura', 'calma']) casos.push([`${p}, pode mandar`, null]); // R5: SIM_VIRA solto
  assert.ok(casos.length > 400, `casos: ${casos.length}`);
  assert.deepEqual(divergencias(casos), []);
});

// ---------- andaime do verificar (copiado de tests/ok-wpp.test.mjs) ----------

function montar() {
  const raiz = pastaTemp('ok-flex-');
  const env = {
    SESSOES_WPP_DIR: path.join(raiz, 'estado'),
    CLAUDE_SESSIONS_DIR: path.join(raiz, 'sessions'),
    CLAUDE_PROJECTS_DIR: path.join(raiz, 'projects'),
    SESSOES_WPP_LOG: path.join(raiz, 'ok-wpp.log'),
    CLAUDE_CODE_SESSION_ID: SID,
  };
  for (const d of [env.SESSOES_WPP_DIR, env.CLAUDE_SESSIONS_DIR, env.CLAUDE_PROJECTS_DIR]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(env.SESSOES_WPP_DIR, 'estado.json'), JSON.stringify({ v: 1, trava: false })); // porteiro vivo, destravado
  const reg = { pid: PID, sessionId: SID, cwd: 'C:\\projetos', name: 'projetos-f3', nameSource: 'derived', entrypoint: 'claude-vscode', status: 'idle', updatedAt: T0 };
  fs.writeFileSync(path.join(env.CLAUDE_SESSIONS_DIR, `${PID}.json`), JSON.stringify(reg));
  const pasta = path.join(env.CLAUDE_PROJECTS_DIR, 'c--projetos');
  fs.mkdirSync(pasta, { recursive: true });
  fs.writeFileSync(path.join(pasta, `${SID}.jsonl`), `${JSON.stringify({ type: 'custom-title', customTitle: 'Faro', sessionId: SID })}\n`);
  const h = {
    raiz, env, t: T0, prof: [], pes: [], enviados: [], reacoes: [], nMsg: 0,
    markerPath: path.join(raiz, 'logs', 'publicacao-ok.json'),
    disparoPath: path.join(raiz, 'logs', 'disparo-estado.json'),
  };
  let seq = 0;
  h.wpp = {
    async lerGrupo(limit, opts = {}) {
      return (opts.conferencia === true ? h.pes : h.prof).slice(-limit);
    },
    async enviarGrupo(texto, opts) {
      h.enviados.push({ texto, opts });
      seq += 1;
      const r = { ok: true, providerMsgId: `3EB0PED${seq}`, messageId: `uuid-ped-${seq}` };
      // a mensagem enviada volta na leitura da profissional, byte a byte
      h.prof.push({
        id: r.messageId, provider_msg_id: r.providerMsgId, from_me: true, sent_by_agent: true, sender_phone: null,
        message_type: 'text', content: texto, quoted_msg_id: opts?.reply_to ?? null, message_ts: tsWpp(h.t),
      });
      return r;
    },
    async reagir(messageId, emoji) {
      h.reacoes.push({ messageId, emoji });
      return { ok: true };
    },
    async membros() {
      return [NUMERO_DONO, NUMERO_ROBO];
    },
  };
  h.ok = () => criarOkWpp({
    wpp: h.wpp, env: h.env, agora: () => h.t, markerPath: h.markerPath, disparoPath: h.disparoPath,
    numeroDono: NUMERO_DONO, numeroRobo: NUMERO_ROBO, // A2a: os 2 numeros do config
  });
  h.pedido = (cod) => JSON.parse(fs.readFileSync(path.join(env.SESSOES_WPP_DIR, 'oks', `${cod}.json`), 'utf8'));
  h.markers = () => (fs.existsSync(h.markerPath) ? JSON.parse(fs.readFileSync(h.markerPath, 'utf8')) : null);
  return h;
}

// Resposta do dono no grupo (profissional) + a copia no pessoal (mesmo provider_msg_id, from_me), como o banco grava.
// Audio (tipo 'ptt' ou 'audio'): `texto` vai no content (o read pode trazer um marcador, ex. "[audio]") e a fala na
// `transcription`.
function responder(h, texto, { cita = null, tipo = 'chat', transcription = null } = {}) {
  h.nMsg += 1;
  const n = h.nMsg;
  const provider = `A5C7RESP${n}`;
  const base = {
    provider_msg_id: provider, quoted_msg_id: cita, message_type: tipo, content: texto, transcription,
    sender_phone: NUMERO_DONO, message_ts: tsWpp(h.t),
  };
  h.prof.push({ id: `uuid-resp-${n}`, ...base, sent_by_agent: false, direction: 'received', from_me: false });
  h.pes.push({ id: `uuid-pes-${n}`, ...base, sent_by_agent: false, direction: 'sent', from_me: true });
  return { id: `uuid-resp-${n}`, provider };
}

// 1 pedido aberto (publicacao); a mensagem dele e a ultima dos agentes no grupo.
async function pedidoCom(h) {
  const ok = h.ok();
  const r = await ok.pedir({ tipo: 'publicacao', acao: 'Publicar o site v2 em producao' });
  assert.equal(r.status, 'pedido');
  const p = h.pedido(r.codigo);
  return { ok, cod: r.codigo, prov: p.providerMsgId };
}

// Responde (citando o pedido, ou solto) 1 min depois do pedido e confere 1 min depois da resposta.
async function cenario(texto, { cita = true, tipo, transcription } = {}) {
  const h = montar();
  const { ok, cod, prov } = await pedidoCom(h);
  h.t = T0 + MIN;
  const resp = responder(h, texto, { cita: cita ? prov : null, tipo, transcription });
  h.t = T0 + 2 * MIN;
  const r = await ok.verificar(cod);
  return { h, cod, resp, r };
}

const MARKER = (cod) => ({ [SID]: { at: T0 + 2 * MIN, k: 'whatsapp', trecho: `${cod}: Publicar o site v2 em producao`, usos: 0 } });
const RESULTADO_OK = (cod) => ({ status: 'ok', codigo: cod, tipo: 'publicacao', acao: 'Publicar o site v2 em producao', destinatarios: null, hora: '16:01' });
const SEM_RESPOSTA = { status: 'pendente', motivo: 'sem resposta do dono ainda', ignoradas: [] };
const IGNORADA = (resp, texto) => ({
  status: 'pendente',
  motivo: `nenhuma resposta decide; ignoradas: ${texto === null ? 'audio sem transcricao' : `"${texto}"`} (16:01)`,
  ignoradas: [{ providerMsgId: resp.provider, hora: '16:01', texto }],
});

// OK concedido como hoje: uso unico, reacao no "sim" e o marker da trava de publicacao.
function concedido({ h, cod, resp, r }, texto, nome) {
  assert.deepEqual(r, RESULTADO_OK(cod), nome);
  const p = h.pedido(cod);
  assert.equal(p.status, 'usado', nome);
  assert.deepEqual(p.verificadoPor, { providerMsgId: resp.provider, texto, hora: '16:01' }, nome);
  assert.deepEqual(h.reacoes, [{ messageId: resp.id, emoji: '\u{2705}' }], nome);
  assert.deepEqual(h.markers(), MARKER(cod), nome);
}

function semEfeito({ h, cod }, nome) {
  assert.equal(h.pedido(cod).status, 'pendente', nome);
  assert.equal(h.markers(), null, nome);
  assert.deepEqual(h.reacoes, [], nome);
}

function recusado({ h, cod, resp, r }, texto, nome) {
  assert.deepEqual(r, { status: 'recusado', motivo: 'o dono respondeu que nao', codigo: cod, hora: '16:01' }, nome);
  const p = h.pedido(cod);
  assert.equal(p.status, 'recusado', nome);
  assert.deepEqual(p.verificadoPor, { providerMsgId: resp.provider, texto, hora: '16:01' }, nome);
  assert.equal(h.markers(), null, nome);
  assert.deepEqual(h.reacoes, [], nome);
}

// ---------- 100: o verificar passa `citada` ----------

test('T7g 100. verificar: citando decide pela regra da citada (mundo fechado); "beleza" solto segue pendente', async () => {
  // citando: "Sim, pode publicar." = ok, marker como hoje
  concedido(await cenario('Sim, pode publicar.'), 'Sim, pode publicar.', 'citando');

  // citando, com palavra fora do vocabulario: pendente, ela nas ignoradas, nada gravado
  const objeto = await cenario('Sim, pode publicar o site novo.');
  assert.deepEqual(objeto.r, IGNORADA(objeto.resp, 'Sim, pode publicar o site novo.'), 'com objeto');
  semEfeito(objeto, 'com objeto');

  // solto (1 pedido aberto, o pedido como ultima mensagem dos agentes): "beleza" nao decide (a regra de hoje)
  const beleza = await cenario('beleza', { cita: false });
  assert.deepEqual(beleza.r, SEM_RESPOSTA, 'beleza solto');
  semEfeito(beleza, 'beleza solto');
  // controle: na mesma posicao, a frase da lista de hoje decide solta
  concedido(await cenario('pode mandar', { cita: false }), 'pode mandar', 'pode mandar solto');

  // "pode mandar amanha" citando = pendente com ela nas ignoradas
  const amanha = await cenario('pode mandar amanhã');
  assert.deepEqual(amanha.r, IGNORADA(amanha.resp, 'pode mandar amanhã'), 'amanha');
  semEfeito(amanha, 'amanha');

  // "Nao, espera." citando = recusado
  recusado(await cenario('Não, espera.'), 'Não, espera.', 'nao espera');

  // "Nao, pode mandar." citando = pendente (ambiguo), nas ignoradas
  const ambigua = await cenario('Não, pode mandar.');
  assert.deepEqual(ambigua.r, IGNORADA(ambigua.resp, 'Não, pode mandar.'), 'nao, pode mandar');
  semEfeito(ambigua, 'nao, pode mandar');
});

// ---------- 100b: o Nao vence (revisao da v2) ----------

// Varias respostas do dono (citando o pedido, ou soltas), 10 s uma da outra a partir das 16:01; mensagem dos agentes
// (outra aba) antes de uma delas com `agenteAntes`. Confere 1 min depois da primeira.
async function cenarioVarias(respostas) {
  const h = montar();
  const { ok, cod, prov } = await pedidoCom(h);
  const resps = [];
  for (const [k, { texto, cita = true, agenteAntes = false }] of respostas.entries()) {
    h.t = T0 + MIN + k * 10 * 1000;
    if (agenteAntes) {
      h.prof.push({
        id: `uuid-ag-${k}`, provider_msg_id: `3EB0AG${k}`, from_me: true, sent_by_agent: true, sender_phone: null,
        message_type: 'text', content: 'ℹ️ *Outra aba*\nTerminei.', quoted_msg_id: null, message_ts: tsWpp(h.t - 5000),
      });
    }
    resps.push(responder(h, texto, { cita: cita ? prov : null }));
  }
  h.t = T0 + 2 * MIN;
  const r = await ok.verificar(cod);
  return { h, cod, resps, r };
}

test('T7g 100b. o Nao vence no WhatsApp: "beleza" e depois "Nao, espera." citando = recusado (como o Nao do Telegram); o "nao" solto que vale pro pedido tambem; o que nao e resposta ao pedido nao vence', async () => {
  // a revisao da v2 achou: "beleza" (sim citando) e, 10 s depois, "Nao, espera." citando, antes da aba conferir = ok
  const vence = await cenarioVarias([{ texto: 'beleza' }, { texto: 'Não, espera.' }]);
  recusado({ ...vence, resp: vence.resps[1] }, 'Não, espera.', 'beleza e depois nao');
  // com conversa no meio (que nao decide), o "nao" depois ainda vence
  const meio = await cenarioVarias([{ texto: 'beleza' }, { texto: 'obrigado' }, { texto: 'Não, espera.' }]);
  recusado({ ...meio, resp: meio.resps[2] }, 'Não, espera.', 'beleza, conversa e depois nao');
  // o "nao" primeiro segue valendo (o sim depois nao desfaz a recusa)
  const primeiro = await cenarioVarias([{ texto: 'Não, espera.' }, { texto: 'pode mandar' }]);
  recusado({ ...primeiro, resp: primeiro.resps[0] }, 'Não, espera.', 'nao e depois sim');
  // "nao" SOLTO depois do sim citando, com este o unico pedido aberto e nenhuma mensagem dos agentes no meio (F3.2)
  const solto = await cenarioVarias([{ texto: 'Sim, pode mandar.' }, { texto: 'não', cita: false }]);
  recusado({ ...solto, resp: solto.resps[1] }, 'não', 'sim e depois nao solto');
  // "nao" solto depois de uma mensagem dos agentes (pode ser pra outra aba) nao e resposta a este pedido: o sim vale
  const outraAba = await cenarioVarias([{ texto: 'Sim, pode mandar.' }, { texto: 'não', cita: false, agenteAntes: true }]);
  concedido({ ...outraAba, resp: outraAba.resps[0] }, 'Sim, pode mandar.', 'nao solto depois dos agentes');
  // o que vem depois do sim e nao decide (ou decide sim) nao muda nada
  const conversa = await cenarioVarias([{ texto: 'pode mandar' }, { texto: 'obrigado' }, { texto: 'sim' }]);
  concedido({ ...conversa, resp: conversa.resps[0] }, 'pode mandar', 'sim e depois conversa');
});

// ---------- 101: audio e emoji ----------

test('T7g 101. audio e emoji: a fala transcrita citando = ok (o marcador do content nao conta); polegar citando = ok, solto = pendente; polegar pra baixo citando = recusado', async () => {
  // audio (ptt) com o marcador no content e a fala na transcription: o verificar le pelo textoDaMensagem
  const ptt = await cenario('[audio]', { tipo: 'ptt', transcription: 'Sim, pode mandar.' });
  concedido(ptt, 'Sim, pode mandar.', 'ptt citando');
  const audio = await cenario('[audio]', { tipo: 'audio', transcription: 'Pode mandar, sem problema.' });
  concedido(audio, 'Pode mandar, sem problema.', 'audio citando');
  // audio ainda sem transcricao: o marcador nunca vira texto ("audio sem transcricao" nas ignoradas)
  const vazio = await cenario('[audio]', { tipo: 'ptt', transcription: null });
  assert.deepEqual(vazio.r, IGNORADA(vazio.resp, null), 'ptt sem transcricao');
  semEfeito(vazio, 'ptt sem transcricao');
  // revisao da v2: o audio SOLTO tambem e lido pelo textoDaMensagem (1 pedido aberto, o pedido como ultima mensagem dos
  // agentes); o que decide e a regra de hoje: "Sim." falado = ok, "Nao." falado = recusado, "beleza" falado = pendente
  concedido(await cenario('[audio]', { cita: false, tipo: 'ptt', transcription: 'Sim.' }), 'Sim.', 'ptt solto sim');
  concedido(await cenario('[audio]', { cita: false, tipo: 'audio', transcription: 'Pode mandar.' }), 'Pode mandar.', 'audio solto');
  recusado(await cenario('[audio]', { cita: false, tipo: 'ptt', transcription: 'Não.' }), 'Não.', 'ptt solto nao');
  const belezaFalado = await cenario('[audio]', { cita: false, tipo: 'ptt', transcription: 'beleza' });
  assert.deepEqual(belezaFalado.r, SEM_RESPOSTA, 'beleza falado solto');
  semEfeito(belezaFalado, 'beleza falado solto');

  concedido(await cenario(POLEGAR), POLEGAR, 'polegar citando');
  // solto: 1 pedido aberto, o pedido como ultima mensagem dos agentes; o polegar nao decide solto (a regra de hoje)
  const solto = await cenario(POLEGAR, { cita: false });
  assert.deepEqual(solto.r, SEM_RESPOSTA, 'polegar solto');
  semEfeito(solto, 'polegar solto');

  recusado(await cenario('\u{1F44E}'), '\u{1F44E}', 'polegar pra baixo citando');
});
