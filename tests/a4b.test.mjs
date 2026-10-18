// Testes da A4b (PLANO-ABERTO.md, "A4b — os textos"): o recado do mensageiro com o nome do dono do config.json
// (frasesDoDono: "do Davi", "da Ana", "de Sam"; sem nome bom = "do dono"), sem o nome do grupo e do bot; o prompt do
// mensageiro; o porteiro passando o dono; e quem reconhece a linha de citacao aceitando qualquer nome (lib/formato.mjs
// e lib/formato-tg.mjs; a conferencia da entrega no porteiro fica no tests/porteiro-telegram.test.mjs, "A4b").
// Por que existe: a copia aberta serve a qualquer pessoa, e o recado tinha fixos o nome do dono, o do grupo e o do
// bot. Valor trocado aqui = o recado com o nome errado, ou a linha de citacao de outro nome
// sem ser reconhecida (reforco a toa, a linha aparecendo no Telegram e na voz).
// Os textos neutros (os motivos do ok-wpp e do ok-tg, o rotulo do ler-grupo, os logs e o hook) ficam nos testes de cada
// arquivo, que passaram pro texto neutro.
// Isolamento: pastas temporarias (prefixo "a4b-"), spawn dublado; nada de claude real, rede nem porteiro rodando (o
// rodar do porteiro e conferido pelo fonte).
// Os modulos entram por `import * as`: funcao que ainda nao existe deixa so o teste dela vermelho.
// Rodar: node --test --test-reporter=tap "tests/a4b.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { pastaTemp } from './lib/pasta-temp.cjs';
import * as config from '../lib/config.mjs';
import * as formato from '../lib/formato.mjs';
import * as formatoTg from '../lib/formato-tg.mjs';
import * as mensageiro from '../mensageiro.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');

const DONO = Object.freeze({ nome: 'Davi', artigo: 'o' });
const ANA = Object.freeze({ nome: 'Ana', artigo: 'a' });
const SAM = Object.freeze({ nome: 'Sam', artigo: '' });
const F_DONO = { de: 'do Davi', ele: 'ele', Ele: 'Ele', dele: 'dele' };
const F_ANA = { de: 'da Ana', ele: 'ela', Ele: 'Ela', dele: 'dela' };
const F_SAM = { de: 'de Sam', ele: 'Sam', Ele: 'Sam', dele: 'de Sam' };
const F_PADRAO = { de: 'do dono', ele: 'ele', Ele: 'Ele', dele: 'dele' };
// [o dono passado (undefined = nenhum), as frases dele]
const DONOS = [[DONO, F_DONO], [ANA, F_ANA], [SAM, F_SAM], [undefined, F_PADRAO]];
const rotulo = (d) => (d === undefined ? 'sem dono' : JSON.stringify(d));
// Os textos de antes (o nome do grupo, o do bot e o do dono de origem), que as assercoes negativas provam que nao voltam:
// montados por pedacos porque o termo inteiro nao pode estar na copia aberta.
const GRUPO_ANTES = ['Notificações', ' dos Agentes'].join('');
const BOT_ANTES = ['Claude', ' PC'].join('');
const NOME_ANTES = ['Er', 'ic'].join('');

// ---------- os textos esperados, por extenso de proposito (o teste prende o texto) ----------

const FALA = 'sim, pode publicar';
const CITADA = 'Publico o site agora?';
const ID_WPP = '3EB0AAAA0000BBBB1111CC';
const PEDIDO_WPP = {
  sessionId: 's-faro', nome: 'projetos-f3', titulo: 'Faro', texto: FALA, audio: false, hora: '15:05',
  providerMsgId: ID_WPP, messageId: 'uuid-1', anexos: [{ tipo: 'image', messageId: 'uuid-img' }], citada: CITADA, nota: 'NOTA X',
};
const ARQ = 'C:\\pc\\anexos\\tg-u5001-1.png';
const PEDIDO_TG = {
  ...PEDIDO_WPP, providerMsgId: 'tg-u5001', messageId: 7001, canal: 'telegram', nota: undefined,
  anexos: [{ tipo: 'foto', caminho: ARQ, nome: 'print.png' }],
};
const NOTA_OK = 'Resposta ao seu pedido de OK ABC234. Antes de agir, rode: node C:/projetos/sessoes-wpp/ok-wpp.mjs verificar ABC234 (so age com status ok).';
const TOQUE = {
  sessionId: 's-faro', nome: 'projetos-f3', titulo: 'Faro', texto: 'Sim', audio: false, hora: '15:05',
  providerMsgId: 'tgok-u77', messageId: null, anexos: [], canal: 'telegram', nota: NOTA_OK, ok: 'ABC234',
};

const fimWpp = (D, id = ID_WPP) => `Veio do número ${D.de} no grupo do WhatsApp, conferido pelo porteiro (id ${id}). A sua próxima resposta volta pro grupo sozinha, mas lá só chegam a 1ª frase depois da linha de citação e a pergunta (o resto, só se ${D.ele} pedir detalhe). Então: 1 frase do que aconteceu e, se precisar ${D.dele}, o bloco 🔴 **DECISÃO:** com as opções A) / B).`;
const fimTg = (D, id = 'tg-u5001') => `Veio do Telegram ${D.de}, conferido pelo porteiro (id ${id}). A sua próxima resposta volta pro Telegram sozinha, mas lá só aparecem a 1ª frase depois da linha de citação e a pergunta (o texto inteiro, só quando ${D.ele} toca em Mais informações ou pede detalhe). Então: 1 frase do que aconteceu e, se precisar de uma escolha ${D.dele}, o bloco 🔴 **DECISÃO:** com as opções A) / B): elas viram botões.`;
const fimOk = (D, id, reforco) => `Veio do toque ${D.de} no botão Sim ou Não do pedido de OK (Telegram), conferido pelo porteiro (id ${id}).${reforco ? '' : ' Rode o verificar da nota antes de agir.'} A sua próxima resposta volta pro Telegram sozinha: 1 frase do que aconteceu e, se precisar de uma escolha ${D.dele}, o bloco 🔴 **DECISÃO:** com as opções A) / B).`;

const recadoWpp = (D) => [
  `WhatsApp ${D.de} (15:05, id ${ID_WPP}). Abra a sua resposta com esta linha, literal:`,
  `> WhatsApp ${D.de} (15:05): «${FALA}»`,
  '',
  FALA,
  '',
  `${D.Ele} respondeu citando esta mensagem do grupo, de uma aba com o seu nome que fechou antes de você abrir (você não viu a conversa dela): «${CITADA}»`,
  '',
  'NOTA X',
  '',
  'Anexos no grupo do WhatsApp (baixe com download_attachment do whatsapp-agent):',
  '- image, message_id uuid-img',
  '',
  fimWpp(D),
].join('\n');
const reforcoWpp = (D) => [
  `WhatsApp ${D.de} (15:05, id ${ID_WPP}). A sua resposta a esta mensagem saiu sem a linha de citação.`,
  'Não repita nenhuma ação que você já fez por causa dela. Só reescreva a resposta, abrindo com esta linha, literal:',
  `> WhatsApp ${D.de} (15:05): «${FALA}»`,
  '',
  fimWpp(D),
].join('\n');
const recadoTg = (D) => [
  `Telegram ${D.de} (15:05, id tg-u5001). Abra a sua resposta com esta linha, literal:`,
  `> Telegram ${D.de} (15:05): «${FALA}»`,
  '',
  FALA,
  '',
  `${D.Ele} respondeu em cima desta mensagem do Telegram, de uma aba com o seu nome que fechou antes de você abrir (você não viu a conversa dela): «${CITADA}»`,
  '',
  'Anexos (arquivos no PC; abra com a ferramenta Read):',
  `- foto "print.png": ${ARQ}`,
  '',
  fimTg(D),
].join('\n');
const recadoOk = (D) => [
  `Telegram ${D.de} (15:05, id tgok-u77). Abra a sua resposta com esta linha, literal:`,
  `> Telegram ${D.de} (15:05): «Sim»`,
  '',
  'Sim',
  '',
  NOTA_OK,
  '',
  fimOk(D, 'tgok-u77', false),
].join('\n');
const reforcoOk = (D) => [
  `Telegram ${D.de} (15:05, id tgok-u77). A sua resposta a esta mensagem saiu sem a linha de citação.`,
  'Não repita nenhuma ação que você já fez por causa dela. Só reescreva a resposta, abrindo com esta linha, literal:',
  `> Telegram ${D.de} (15:05): «Sim»`,
  '',
  fimOk(D, 'tgok-u77', true),
].join('\n');

const montar = (p, d) => (d === undefined ? mensageiro.montarRecado(p) : mensageiro.montarRecado(p, d));

// ---------- 1. frasesDoDono ----------

test('A4b 1. frasesDoDono: "do Davi"/ele/Ele/dele (o), "da Ana"/ela/Ela/dela (a) e "de Sam"/Sam/Sam/"de Sam" (sem artigo); o artigo aparado e em minuscula, outro valor = sem artigo; o nome normalizado; sem nome bom = o PADRAO_DONO ("do dono", nunca "da dono"); nunca lanca', () => {
  const f = config.frasesDoDono;
  assert.equal(typeof f, 'function', 'frasesDoDono exportada');
  assert.deepEqual(f(DONO), F_DONO);
  assert.deepEqual(f(ANA), F_ANA);
  assert.deepEqual(f(SAM), F_SAM);
  assert.deepEqual(f({ nome: 'Sam' }), F_SAM, 'sem artigo');
  for (const a of [' A ', 'A', 'a\t']) assert.deepEqual(f({ nome: 'Ana', artigo: a }), F_ANA, JSON.stringify(a));
  for (const a of [' O', 'O ']) assert.deepEqual(f({ nome: 'Davi', artigo: a }), F_DONO, JSON.stringify(a));
  for (const a of ['os', 'as', 'x', 'de', '', null, 7, true, {}, ['o']]) {
    assert.deepEqual(f({ nome: 'Sam', artigo: a }), F_SAM, JSON.stringify(a));
  }
  // o nome normalizado (o mesmo do donoDoConfig)
  assert.deepEqual(f({ nome: '  Ana   Paula ', artigo: 'a' }), { de: 'da Ana Paula', ele: 'ela', Ele: 'Ela', dele: 'dela' });
  assert.deepEqual(f({ nome: 'Ana  Paula' }), { de: 'de Ana Paula', ele: 'Ana Paula', Ele: 'Ana Paula', dele: 'de Ana Paula' });
  // a saida do donoDoConfig (com o fuso) e o PADRAO_DONO valem igual
  assert.deepEqual(f(config.donoDoConfig({ dono: { nome: 'Ana', artigo: 'a' } }, { fusoMaquina: 'Asia/Tokyo' })), F_ANA);
  assert.deepEqual(f(config.donoDoConfig({}, { fusoMaquina: 'Asia/Tokyo' })), F_PADRAO);
  assert.deepEqual(f(config.PADRAO_DONO), F_PADRAO);
  // sem nome bom: o padrao inteiro, nome e artigo juntos (cada caso seria bom se nao fosse o defeito dele)
  const ruins = [undefined, null, 'Davi', 7, [], [ANA], {}, { artigo: 'a' }, { nome: '', artigo: 'a' },
    { nome: '1Ana', artigo: 'a' }, { nome: `A${'b'.repeat(40)}`, artigo: 'a' }, { nome: 'Ana (teste)', artigo: 'a' },
    { nome: null, artigo: 'a' }];
  for (const d of ruins) assert.deepEqual(f(d), F_PADRAO, JSON.stringify(d) ?? String(d));
  assert.deepEqual(f({ nome: `A${'b'.repeat(39)}`, artigo: 'a' }).de, `da A${'b'.repeat(39)}`, '40 vale');
  const bomba = { get nome() { throw new Error('getter'); }, artigo: 'a' };
  assert.deepEqual(f(bomba), F_PADRAO, 'getter que lanca');
});

// ---------- 2-4. o recado ----------

test('A4b 2. recado do WhatsApp com o dono: o rotulo "WhatsApp <de>" na 1a linha e na citacao, a citada com "<Ele> respondeu", os anexos "no grupo do WhatsApp" e o fim com "do número <de>", "se <ele> pedir detalhe" e "se precisar <dele>"; o reforco igual; sem dono = "do dono"; sem o nome do grupo', () => {
  for (const [d, D] of DONOS) {
    assert.equal(montar(PEDIDO_WPP, d), recadoWpp(D), rotulo(d));
    assert.equal(montar({ ...PEDIDO_WPP, reforco: true }, d), reforcoWpp(D), `${rotulo(d)}: reforco`);
    assert.ok(!montar(PEDIDO_WPP, d).includes(GRUPO_ANTES), `${rotulo(d)}: sem o nome do grupo`);
  }
  // o mesmo recado com o artigo torto ou o nome com espacos a mais (o frasesDoDono)
  assert.equal(montar(PEDIDO_WPP, { nome: ' Ana ', artigo: ' A' }), recadoWpp(F_ANA));
  assert.equal(montar(PEDIDO_WPP, { nome: 'Sam', artigo: 'os' }), recadoWpp(F_SAM));
  // dono ruim = o padrao (nunca "da dono")
  for (const d of [null, {}, { nome: '', artigo: 'a' }, 'Ana']) assert.equal(montar(PEDIDO_WPP, d), recadoWpp(F_PADRAO), JSON.stringify(d));
});

test('A4b 3. recado do Telegram com o dono: "Telegram <de>", a citada com "<Ele> respondeu em cima", o fim com "Veio do Telegram <de>," sem o nome do bot entre parenteses, "quando <ele> toca" e "uma escolha <dele>"; o reforco termina igual', () => {
  for (const [d, D] of DONOS) {
    const r = montar(PEDIDO_TG, d);
    assert.equal(r, recadoTg(D), rotulo(d));
    assert.ok(!r.includes(BOT_ANTES), `${rotulo(d)}: sem o nome do bot`);
    assert.ok(montar({ ...PEDIDO_TG, reforco: true }, d).endsWith(`\n\n${fimTg(D)}`), `${rotulo(d)}: reforco`);
  }
});

test('A4b 4. recado do toque no pedido de OK com o dono: "Veio do toque <de> ... (Telegram)" sem o nome do chat do bot, "uma escolha <dele>"; o reforco sem a frase do verificar', () => {
  for (const [d, D] of DONOS) {
    assert.equal(montar(TOQUE, d), recadoOk(D), rotulo(d));
    assert.equal(montar({ ...TOQUE, reforco: true }, d), reforcoOk(D), `${rotulo(d)}: reforco`);
    assert.ok(!montar(TOQUE, d).includes(BOT_ANTES), `${rotulo(d)}: sem o nome do bot`);
  }
});

// ---------- 5-6. o prompt e o mensageiro ----------

test('A4b 5. o prompt do mensageiro abre com "Você é o mensageiro do porteiro do Tele Control (WhatsApp e Telegram)." e nao leva nome de dono', () => {
  const p = mensageiro.montarPrompt('projetos-f3', 'RECADO X');
  assert.equal(p.split('\n')[0], 'Você é o mensageiro do porteiro do Tele Control (WhatsApp e Telegram). Faça só isto, nada mais:');
  assert.ok(!p.includes(NOME_ANTES) && !p.includes('dono'), p);
});

// spawn dublado: cada chamada responde ENVIADO e guarda os argumentos
function spawnFalso() {
  const chamadas = [];
  function spawn(bin, args, opts) {
    chamadas.push({ bin, args, opts });
    const filho = new EventEmitter();
    filho.stdout = new EventEmitter();
    filho.stderr = new EventEmitter();
    filho.kill = () => true;
    setTimeout(() => {
      filho.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ENVIADO' })));
      filho.emit('close', 0, null);
    }, 5);
    return filho;
  }
  return { spawn, chamadas };
}

test('A4b 6. criarMensageiro({dono}): o recado que vai no prompt do claude -p (dublado) sai com o nome desse dono; sem dono, ou com dono ruim, sai com "do dono"', async () => {
  const casos = [[ANA, F_ANA], [SAM, F_SAM], [DONO, F_DONO], [undefined, F_PADRAO], [{ nome: '', artigo: 'a' }, F_PADRAO], [null, F_PADRAO]];
  for (const [d, D] of casos) {
    const s = spawnFalso();
    const opcoes = { claudeBin: 'C:/x/claude.exe', spawn: s.spawn, estadoDir: pastaTemp('a4b-mens-'), dormir: async () => {} };
    if (d !== undefined) opcoes.dono = d;
    const m = mensageiro.criarMensageiro(opcoes);
    const r = await m.entregar(PEDIDO_WPP);
    assert.equal(r.status, 'enviado', rotulo(d));
    const prompt = s.chamadas[0].args[1];
    assert.equal(prompt, mensageiro.montarPrompt(PEDIDO_WPP.nome, recadoWpp(D)), rotulo(d));
  }
});

// ---------- 7. o porteiro passa o dono (pelo fonte: o rodar nao tem teste) ----------

test('A4b 7. pelo fonte: o rodar do porteiro cria o mensageiro com o dono do mesmo donoDoConfig(cfg) da A4a', () => {
  const fonte = fs.readFileSync(path.join(REPO, 'porteiro.mjs'), 'utf8');
  // so o corpo do rodar: do "async function rodar(" ate a proxima funcao do topo do arquivo
  const ini = fonte.indexOf('async function rodar(');
  const depois = fonte.slice(ini + 1).search(/\n(?:async )?function /);
  const r = depois === -1 ? fonte.slice(ini) : fonte.slice(ini, ini + 1 + depois);
  assert.ok(ini > 0 && r.includes('log(`subiu (pid'), 'o corpo do rodar');
  const donoEm = r.indexOf('const dono = donoDoConfig(cfg);');
  const mensEm = r.indexOf('criarMensageiro({ estadoDir: C.estadoDir, claudeBin: claude, dono'); // A5a: depois vem o modelo
  assert.ok(donoEm > 0 && mensEm > donoEm, 'o mensageiro com o dono do config');
  assert.equal(r.split('criarMensageiro(').length, 2, '1 mensageiro so');
  assert.equal(r.split('const dono = ').length, 2, '1 dono so');
});

// ---------- 8-10. quem reconhece a linha de citacao ----------

const LINHAS_DO_DONO = [
  '> WhatsApp do Davi (15:05): «sim»',
  '> Telegram do Davi (15:05): «sim»',
  '> Telegram da Ana (15:05): «sim»',
  '> WhatsApp de Sam (15:05): «sim»',
  '> Telegram da Ana Paula (15:05): «sim»',
  '> WhatsApp do dono (15:05): «sim»',
  '  >  Telegram do Davi (15:05): «sim»',
  '>Telegram do Davi (15:05): «sim»',
  '> Telegram da Íris (15:05): «sim»',
  "> WhatsApp do D'Ávila (15:05): «sim»",
  '> Telegram do joao_2 (15:05): «sim»',
  `> Telegram do A${'b'.repeat(39)} (15:05): «sim»`,
];
// cada uma seria a linha se nao fosse o defeito dela
const NAO_SAO = [
  '> Telegram (15:05): «sim»',
  '> Telegram do  (15:05): «sim»',
  '> Telegram do 2Davi (15:05): «sim»',
  '> Telegram dos Davi (15:05): «sim»',
  '> Email do Davi (15:05): «sim»',
  '> Telegram do Davi(15:05): «sim»',
  `> Telegram do A${'b'.repeat(40)} (15:05): «sim»`,
];

test('A4b 8. RE_CITACAO_DO_DONO (a linha que o recado manda abrir, de qualquer nome) e temLinhaDoDono (o rotulo em qualquer ponto do texto): Davi, Ana, Sam, "Ana Paula", o padrao, acento, apostrofo, digito e 40 caracteres; nao: sem nome, nome vazio ou com digito na frente, "dos", outro canal, sem o espaco antes do "(" e 41 caracteres', () => {
  const re = formato.RE_CITACAO_DO_DONO;
  const tem = formato.temLinhaDoDono;
  assert.ok(re instanceof RegExp, 'RE_CITACAO_DO_DONO exportada');
  assert.equal(typeof tem, 'function', 'temLinhaDoDono exportada');
  for (const l of LINHAS_DO_DONO) {
    assert.ok(re.test(l), `linha: ${l}`);
    assert.ok(tem(l), `tem: ${l}`);
    assert.ok(tem(`Feito.\n${l}\nMais nada.`), `tem no meio: ${l}`);
  }
  for (const l of NAO_SAO) {
    assert.ok(!re.test(l), `nao e a linha: ${l}`);
    assert.ok(!tem(l), `nao tem: ${l}`);
  }
  // o rotulo sem o ">" ou no meio da linha: so o temLinhaDoDono (a logica do includes de antes)
  for (const t of ['Telegram da Ana (15:05): «sim»', 'Respondi a WhatsApp de Sam (15:05) agora']) {
    assert.ok(!re.test(t), `re: ${t}`);
    assert.ok(tem(t), `tem: ${t}`);
  }
  for (const v of [null, undefined, 7, {}, '', 'Telegram do Davi', 'WhatsApp da Ana']) assert.equal(tem(v), false, String(v));
});

test('A4b 9. montarResposta completa (lib/formato.mjs) tira a linha de citacao de qualquer nome', () => {
  const ev = {
    titulo: 'Faro', nome: 'projetos-f3',
    final: '> WhatsApp da Ana (07:50): «detalha»\nFeito: 12 testes verdes.\n> Telegram de Sam (07:51): «e o site?»\nO site esta no ar.',
  };
  const r = formato.montarResposta(ev, { completo: true });
  assert.ok(!r.includes('da Ana') && !r.includes('de Sam') && !r.includes('detalha'), r);
  assert.ok(r.includes('Feito: 12 testes verdes.') && r.includes('O site esta no ar.'), r);
});

test('A4b 10. lib/formato-tg.mjs: o lerFinal tira do contexto a 1a linha de citacao de qualquer nome (as linhas do 8 que comecam com ">"; as que nao sao ficam); o semLinhaDoDono (a resposta completa e a voz) tira a de qualquer nome e deixa o que nao e a linha', () => {
  const tg = formatoTg.lerFinal(
    '> Telegram da Ana (12:50): «pode seguir»\n\nFeito o ajuste no porteiro.\n\n🔴 **DECISÃO:** Sigo pro T2? A) Sim (recomendado) / B) Não',
  );
  assert.equal(tg.contexto, 'Feito o ajuste no porteiro.');
  assert.equal(tg.pergunta, 'Sigo pro T2?');
  const wpp = formatoTg.lerFinal('> WhatsApp de Sam (09:10): «ok»\nFeito.\n\nFica com você: logar no painel');
  assert.equal(wpp.contexto, 'Feito.');
  assert.deepEqual(wpp.fica, ['logar no painel']);
  // a regra do nome e a mesma do RE_CITACAO_DO_DONO (o lerFinal so olha a linha que comeca com ">")
  for (const l of LINHAS_DO_DONO.filter((x) => x.startsWith('>'))) assert.equal(formatoTg.lerFinal(`${l}\n\nFeito.`).contexto, 'Feito.', l);
  for (const l of NAO_SAO) assert.notEqual(formatoTg.lerFinal(`${l}\n\nFeito.`).contexto, 'Feito.', l);
  const sem = formatoTg.semLinhaDoDono;
  assert.equal(sem('> Telegram da Ana (12:50): «oi»\n\nFeito.'), 'Feito.');
  assert.equal(sem('  > WhatsApp de Sam (12:50): «oi»\nFeito.\n> Telegram do dono (12:51): «e?»'), 'Feito.');
  assert.equal(sem('> Telegram dos Davi (12:50): «oi»\nFeito.'), '> Telegram dos Davi (12:50): «oi»\nFeito.');
});
