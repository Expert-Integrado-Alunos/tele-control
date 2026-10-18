// Testes da A4a (PLANO-ABERTO.md, "A4a — o dono no config e o fuso"): o bloco `dono` do config.json (nome, artigo e
// fuso), o fuso dos textos com hora (lib/formato.mjs) nos 5 pontos de entrada (o rodar e o esperando do porteiro, o
// ok-wpp, o ler-grupo e o abas) e o `dono` no passo config do instalador.
// Por que existe: o nome do dono de origem e o fuso de Brasilia estavam chumbados no codigo; a copia aberta serve a qualquer
// pessoa, em qualquer fuso. Valor trocado aqui = hora de outro fuso no Telegram, na central e no pedido de OK, ou o nome
// errado no recado (a A4b usa o dono daqui).
// Isolamento: pastas temporarias (prefixo "a4a-"); as linhas de comando rodam em processo filho com SESSOES_WPP_DIR
// temporario e o fuso da "maquina" pelo TZ do ambiente do filho (o Node do Windows respeita o TZ do processo). Nada de
// rede, config.json real nem porteiro rodando: o rodar do porteiro e conferido pelo fonte.
// Os modulos entram por `import * as`: funcao que ainda nao existe deixa so o teste dela vermelho.
// Rodar: node --test --test-reporter=tap "tests/a4a.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pastaTemp } from './lib/pasta-temp.cjs';
import * as config from '../lib/config.mjs';
import * as formato from '../lib/formato.mjs';
import * as abas from '../abas.mjs';
import * as instalar from '../instalar.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');
const MIN = 60 * 1000;
const H = 60 * MIN;
// 14/10/2026 20:00 UTC = 17:00 do dia 14 em Brasilia (UTC-3), 05:00 do dia 15 em Toquio (UTC+9) e 01:30 do dia 15 em
// Colombo (UTC+5:30); os 3 sem horario de verao
const T = Date.parse('2026-10-14T20:00:00Z');
const SP = -180;
const TOQUIO = 540;
const COLOMBO = 330;
const iso = (ms) => new Date(ms).toISOString();
// "dd/mm" e "HH:MM" de um instante num deslocamento fixo do UTC (conta propria: sem o codigo testado)
function noDesloc(ms, minutos) {
  const d = new Date(ms + minutos * MIN).toISOString();
  return { dia: `${d.slice(8, 10)}/${d.slice(5, 7)}`, hora: d.slice(11, 16) };
}
// Um minuto cheio + 30 s (a hora mostrada nao depende de arredondar segundo)
const meioMinuto = (ms) => Math.floor(ms / MIN) * MIN + 30 * 1000;

// Troca o fuso do lib/formato.mjs so dentro de fn (o de antes volta no fim, passe ou falhe)
function comFuso(fuso, fn) {
  const antes = formato.fusoAtual();
  try {
    return fn(formato.definirFuso(fuso));
  } finally {
    formato.definirFuso(antes);
  }
}

// Pasta de estado temporaria + o ambiente minimo do processo filho, com o TZ da "maquina" e o config.json (se vier)
function ambiente(tz, cfg) {
  const raiz = pastaTemp('a4a-cli-');
  const estado = path.join(raiz, 'estado');
  const home = path.join(raiz, 'home');
  for (const p of [estado, home]) fs.mkdirSync(p, { recursive: true });
  if (cfg !== undefined) fs.writeFileSync(path.join(estado, 'config.json'), JSON.stringify(cfg));
  const env = { SESSOES_WPP_DIR: estado, USERPROFILE: home, HOME: home, SESSOES_WPP_LOG: path.join(raiz, 'log.txt'), TZ: tz };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return { raiz, estado, env };
}
function rodar(arq, args, env) {
  const r = spawnSync(process.execPath, [path.join(REPO, arq), ...args], { env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(r.error, undefined, String(r.error));
  return r;
}

// O instalar.mjs com a pasta de estado, a do Claude e a do Inicializar temporarias
function ambienteDoInstalador() {
  const base = pastaTemp('a4a-instalar-');
  const estado = path.join(base, 'estado');
  const claudeDir = path.join(base, 'claude');
  const inicio = path.join(base, 'inicio');
  for (const p of [estado, claudeDir, inicio]) fs.mkdirSync(p, { recursive: true });
  return { estado, env: { SESSOES_WPP_DIR: estado, SESSOES_WPP_CLAUDE_DIR: claudeDir, SESSOES_WPP_STARTUP_DIR: inicio } };
}
const cfgGravado = (a) => JSON.parse(fs.readFileSync(path.join(a.estado, 'config.json'), 'utf8'));

// ---------- 1-4. config ----------

test('A4a 1. PADRAO_DONO ("dono" com artigo "o", congelado) e nomeDoDonoValido: NFC, aparado e espacos seguidos viram 1; de 1 a 40 code points; comeca com letra; depois letra, marca, digito, espaco ou .\'’_-; o resto = null', () => {
  assert.deepEqual({ ...config.PADRAO_DONO }, { nome: 'dono', artigo: 'o' });
  assert.ok(Object.isFrozen(config.PADRAO_DONO), 'PADRAO_DONO congelado');
  const v = config.nomeDoDonoValido;
  assert.equal(typeof v, 'function', 'nomeDoDonoValido exportada');
  const bons = [
    ['Davi', 'Davi'], ['Ana Paula', 'Ana Paula'], ['  Ana   Paula  ', 'Ana Paula'], ['José', 'José'],
    ['Jose\u0301', 'José'], ["D'Ávila", "D'Ávila"], ['D’Ávila', 'D’Ávila'], ['Jean-Luc', 'Jean-Luc'], ['Dr. Sam', 'Dr. Sam'],
    ['joao_silva', 'joao_silva'], ['Dan3', 'Dan3'], ['Łukasz', 'Łukasz'], ['Δημήτρης', 'Δημήτρης'], ['山田', '山田'],
    ['अनिल', 'अनिल'], ['a', 'a'], ['A'.repeat(40), 'A'.repeat(40)], ['𠀀'.repeat(40), '𠀀'.repeat(40)],
    [`${'A'.repeat(20)}   ${'B'.repeat(19)}`, `${'A'.repeat(20)} ${'B'.repeat(19)}`],
  ];
  for (const [bruto, esperado] of bons) assert.equal(v(bruto), esperado, JSON.stringify(bruto));
  // cada ruim seria bom se nao fosse o item que ele testa
  const ruins = [
    ['', 'vazio'], ['   ', 'so espaco'], ['A'.repeat(41), '41 code points'], ['𠀀'.repeat(41), '41 fora do BMP'],
    ['3Dan', 'comeca com digito'], ['.Ana', 'comeca com ponto'], ["'Ana", 'comeca com apostrofo'], ['-Ana', 'comeca com hifen'],
    ['_Ana', 'comeca com sublinhado'], ['\u0301Ana', 'comeca com marca'], ['Ana (PC)', 'parenteses'], ['Ana)', 'fecha parentese'],
    ['Ana«', '«'], ['Ana»', '»'], ['Ana\nPaula', 'quebra de linha'], ['Ana\tPaula', 'tab'], ['Ana\u00a0Paula', 'espaco duro'],
    ['Ana\u200bPaula', 'espaco de largura zero'], ['Ana 😀', 'emoji'], ['Ana<b>', '<'], ['Ana"', 'aspas'], ['Ana@x', 'arroba'],
    ['Ana/Paula', 'barra'], ['Ana:', 'dois pontos'], ['Ana,', 'virgula'], ['Ana²', 'digito que nao e decimal'],
    [7, 'numero'], [null, 'null'], [undefined, 'ausente'], [['Ana'], 'lista'], [{ nome: 'Ana' }, 'objeto'], [true, 'booleano'],
  ];
  for (const [bruto, quem] of ruins) assert.equal(v(bruto), null, quem);
});

test('A4a 2. fusoValido: o texto aparado que o Intl aceita no timeZone, na forma canonica; o resto = null; nunca lanca', () => {
  const f = config.fusoValido;
  assert.equal(typeof f, 'function', 'fusoValido exportada');
  for (const [bruto, esperado] of [['America/Sao_Paulo', 'America/Sao_Paulo'], ['america/sao_paulo', 'America/Sao_Paulo'],
    ['  Asia/Tokyo  ', 'Asia/Tokyo'], ['UTC', 'UTC'], ['Europe/Lisbon', 'Europe/Lisbon'], ['asia/colombo', 'Asia/Colombo']]) {
    assert.equal(f(bruto), esperado, JSON.stringify(bruto));
  }
  for (const ruim of ['', '   ', 'Marte/Base', 'America/Sao Paulo', 'America/Sao_Paulo\u0000', 7, null, undefined, [], {}, ['UTC'], true]) {
    assert.equal(f(ruim), null, JSON.stringify(ruim));
  }
});

test('A4a 3. donoDoConfig(cfg, {fusoMaquina}): nome bom e o artigo dele (o ou a; senao sem artigo), nome ruim = o PADRAO_DONO inteiro; fuso do config, senao o da maquina, senao Brasilia; nunca lanca', () => {
  const d = (cfg, fusoMaquina = 'Asia/Tokyo') => config.donoDoConfig(cfg, { fusoMaquina });
  assert.equal(typeof config.donoDoConfig, 'function', 'donoDoConfig exportada');
  assert.deepEqual(d({ dono: { nome: 'Davi', artigo: 'o', fuso: 'America/Sao_Paulo' } }), { nome: 'Davi', artigo: 'o', fuso: 'America/Sao_Paulo' });
  assert.deepEqual(d({ dono: { nome: ' Ana  Paula ', artigo: ' A ' } }), { nome: 'Ana Paula', artigo: 'a', fuso: 'Asia/Tokyo' });
  assert.deepEqual(d({ dono: { nome: 'Sam' } }), { nome: 'Sam', artigo: '', fuso: 'Asia/Tokyo' }, 'sem artigo = "de Sam"');
  assert.equal(d({ dono: { nome: 'Sam', artigo: 'O ' } }).artigo, 'o', 'aparado e em minuscula');
  for (const artigo of ['os', 'as', 'do', 'da', 'e', '', 7, null, ['o'], {}]) {
    assert.equal(d({ dono: { nome: 'Sam', artigo } }).artigo, '', JSON.stringify(artigo));
  }
  // nome ruim: o padrao inteiro, nome e artigo juntos ("do dono", nunca "da dono"); o fuso segue valendo
  assert.deepEqual(d({ dono: { nome: '(Ana)', artigo: 'a', fuso: 'Asia/Colombo' } }), { nome: 'dono', artigo: 'o', fuso: 'Asia/Colombo' });
  assert.deepEqual(d({ dono: { artigo: 'a' } }), { nome: 'dono', artigo: 'o', fuso: 'Asia/Tokyo' });
  // fuso: o do config (canonico) > o da maquina (canonico) > Brasilia
  assert.equal(d({ dono: { fuso: 'asia/colombo' } }).fuso, 'Asia/Colombo');
  assert.equal(d({ dono: { fuso: 'Marte/Base' } }).fuso, 'Asia/Tokyo', 'ruim = a maquina');
  assert.equal(d({}, 'europe/lisbon').fuso, 'Europe/Lisbon');
  for (const ruim of ['Etc/Unknown', '', null, 7]) assert.equal(d({ dono: { fuso: 'Marte/Base' } }, ruim).fuso, 'America/Sao_Paulo', JSON.stringify(ruim));
  // cfg torto = o padrao e o fuso da maquina; nunca lanca
  const bomba = { get dono() { throw new Error('getter'); } };
  for (const cfg of [null, undefined, 42, 'x', [], { dono: null }, { dono: 'Davi' }, { dono: ['Davi'] }, bomba]) {
    assert.deepEqual(d(cfg), { nome: 'dono', artigo: 'o', fuso: 'Asia/Tokyo' }, String(cfg));
  }
  // opcoes tortas = o fuso da maquina de verdade (este processo)
  const daqui = Intl.DateTimeFormat().resolvedOptions().timeZone;
  for (const op of [undefined, null, 7, { fusoMaquina: undefined }]) assert.equal(config.donoDoConfig({}, op).fuso, daqui, JSON.stringify(op));
});

test('A4a 4. donoDoConfig sem fusoMaquina = o fuso do processo (o do Windows; aqui o TZ do filho), e o do config na frente; fusoMaquina null = Brasilia; o lib/formato.mjs nasce em Brasilia em qualquer fuso; PADRAO_TG.nomeBot = "sem nome"', () => {
  const url = pathToFileURL(path.join(REPO, 'lib', 'config.mjs')).href;
  const urlFormato = pathToFileURL(path.join(REPO, 'lib', 'formato.mjs')).href;
  // fora de Brasilia (o TZ do filho) da pra ver o que neste PC (Brasilia) coincide: opcoes null = a maquina, fusoMaquina
  // null = Brasilia (a maquina nao entra) e o modulo do formato nascendo em Brasilia (nunca no fuso da maquina)
  const codigo = `import { donoDoConfig } from ${JSON.stringify(url)};\nimport { fusoAtual } from ${JSON.stringify(urlFormato)};\n`
    + "console.log([donoDoConfig({}).fuso, donoDoConfig({ dono: { fuso: 'Asia/Colombo' } }).fuso, donoDoConfig({ dono: { fuso: 'Marte/Base' } }).fuso,"
    + " donoDoConfig({ dono: { fuso: 'Marte/Base' } }, { fusoMaquina: null }).fuso, donoDoConfig({}, null).fuso, fusoAtual()].join(' '));";
  for (const tz of ['Asia/Tokyo', 'Europe/Lisbon']) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', codigo], { env: { ...process.env, TZ: tz }, encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), `${tz} Asia/Colombo ${tz} America/Sao_Paulo ${tz} America/Sao_Paulo`);
  }
  assert.equal(config.PADRAO_TG.nomeBot, 'sem nome');
  assert.equal(config.identidadeTelegram({}).nomeBot, 'sem nome');
  assert.equal(config.identidadeTelegram({ telegram: { nomeBot: 'Bot de Teste' } }).nomeBot, 'Bot de Teste', 'o do config segue valendo');
});

// ---------- 5-6. o fuso dos textos ----------

test('A4a 5. lib/formato.mjs: nasce em Brasilia (FUSO_PADRAO); definirFuso troca a hora e o dia de horaBRT e diaBRT e devolve true; fuso que o Intl nao aceita devolve false e nada muda', () => {
  assert.equal(formato.FUSO_PADRAO, 'America/Sao_Paulo');
  assert.equal(formato.fusoAtual(), 'America/Sao_Paulo', 'o modulo nasce em Brasilia');
  const t = iso(T);
  assert.deepEqual([formato.horaBRT(t), formato.diaBRT(t)], ['17:00', '14/10']);
  comFuso('Asia/Tokyo', (ok) => {
    assert.equal(ok, true);
    assert.equal(formato.fusoAtual(), 'Asia/Tokyo');
    assert.deepEqual([formato.horaBRT(t), formato.diaBRT(t)], ['05:00', '15/10']);
    assert.equal(formato.horaBRT(iso(T - 5 * H)), '00:00', 'meia-noite = 00, nunca 24');
  });
  assert.equal(formato.fusoAtual(), 'America/Sao_Paulo', 'devolvido');
  comFuso('asia/colombo', (ok) => {
    assert.equal(ok, true);
    assert.equal(formato.fusoAtual(), 'Asia/Colombo', 'guarda a forma canonica');
    assert.deepEqual([formato.horaBRT(t), formato.diaBRT(t)], ['01:30', '15/10']);
  });
  for (const ruim of ['Marte/Base', '', '  Asia/Colombo', null, undefined, 7, {}, ['Asia/Colombo']]) {
    comFuso('Asia/Tokyo', () => {
      assert.equal(formato.definirFuso(ruim), false, JSON.stringify(ruim));
      assert.equal(formato.fusoAtual(), 'Asia/Tokyo', JSON.stringify(ruim));
      assert.deepEqual([formato.horaBRT(t), formato.diaBRT(t)], ['05:00', '15/10'], JSON.stringify(ruim));
    });
  }
  assert.deepEqual([formato.horaBRT('x'), formato.diaBRT('x')], ['??:??', '??/??'], 'o invalido segue igual');
});

test('A4a 6. abas.mjs: a "ultima mensagem" das Fechadas no fuso em uso (dia e hora do lib/formato.mjs); hora que nao e numero valido = "??/?? às ??:??", sem lancar', () => {
  const linha = (ultimaEm) => abas.textoFechadas([{ sessionId: 'A', titulo: 'Aba A', cwd: 'c:\\projetos\\x', entrypoint: 'cli', ultimaEm }]);
  assert.match(linha(T), /última mensagem 14\/10 às 17:00\)$/);
  comFuso('Asia/Tokyo', () => assert.match(linha(T), /última mensagem 15\/10 às 05:00\)$/));
  comFuso('Asia/Colombo', () => assert.match(linha(T), /última mensagem 15\/10 às 01:30\)$/));
  for (const ruim of [Number.NaN, undefined, null, '2026-10-14T20:00:00Z', Infinity, 8.64e15 + 1]) {
    assert.match(linha(ruim), /última mensagem \?\?\/\?\? às \?\?:\?\?\)$/, String(ruim));
  }
});

// ---------- 7-11. os pontos de entrada ----------

test('A4a 7. ler-grupo.mjs --telegram: a hora no fuso do config; sem config ou com o fuso ruim = o da maquina (TZ do processo)', () => {
  const estadoTg = { v: 1, tg: { recebidas: { 'tg-u1': { at: iso(T), texto: 'oi' } } } };
  const horas = (tz, cfg) => {
    const a = ambiente(tz, cfg);
    fs.writeFileSync(path.join(a.estado, 'estado.json'), JSON.stringify(estadoTg));
    const r = rodar('ler-grupo.mjs', ['5', '--telegram'], a.env);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim().split(/\r?\n/).map((l) => l.slice(0, 5));
  };
  assert.deepEqual(horas('Asia/Tokyo'), ['05:00'], 'sem config = a maquina');
  assert.deepEqual(horas('Asia/Tokyo', { dono: { fuso: 'Asia/Colombo' } }), ['01:30'], 'o do config');
  assert.deepEqual(horas('Asia/Tokyo', { dono: { fuso: 'Marte/Base' } }), ['05:00'], 'fuso ruim = a maquina');
  assert.deepEqual(horas('Asia/Colombo', { dono: { nome: 'Ana' } }), ['01:30'], 'config sem fuso = a maquina');
});

test('A4a 8. abas.mjs --fechadas: a "ultima mensagem" no fuso do config, senao no da maquina', () => {
  const caso = (tz, cfg) => {
    const a = ambiente(tz, cfg);
    const sessions = path.join(a.raiz, 'sessions');
    const projects = path.join(a.raiz, 'projects');
    fs.mkdirSync(sessions, { recursive: true });
    fs.mkdirSync(path.join(projects, 'c--projetos'), { recursive: true });
    const ultima = meioMinuto(Date.now() - 2 * H);
    const arq = path.join(projects, 'c--projetos', 'A4A1.jsonl');
    fs.writeFileSync(arq, [
      { type: 'custom-title', customTitle: 'Aba do fuso', sessionId: 'A4A1' },
      { type: 'user', sessionId: 'A4A1', entrypoint: 'cli', cwd: 'c:\\projetos', timestamp: iso(ultima - MIN), message: { role: 'user', content: 'oi' } },
    ].map((l) => `${JSON.stringify(l)}\n`).join(''));
    fs.utimesSync(arq, new Date(ultima), new Date(ultima));
    const r = rodar('abas.mjs', ['--fechadas'], { ...a.env, CLAUDE_SESSIONS_DIR: sessions, CLAUDE_PROJECTS_DIR: projects });
    assert.equal(r.status, 0, r.stderr);
    return { saida: r.stdout.trim(), ultima };
  };
  const confere = ({ saida, ultima }, desloc, quem) => {
    const q = noDesloc(ultima, desloc);
    assert.ok(saida.endsWith(`última mensagem ${q.dia} às ${q.hora})`), `${quem}: ${saida}`);
  };
  confere(caso('Asia/Tokyo'), TOQUIO, 'sem config = a maquina');
  confere(caso('Asia/Tokyo', { dono: { fuso: 'Asia/Colombo' } }), COLOMBO, 'o do config');
  confere(caso('Asia/Colombo', { dono: { fuso: 'America/Sao_Paulo' } }), SP, 'Brasilia pelo config');
});

test('A4a 9. ok-wpp.mjs listar: a hora do prazo no fuso do config, senao no da maquina', () => {
  const caso = (tz, cfg) => {
    const a = ambiente(tz, cfg);
    const oks = path.join(a.estado, 'oks');
    fs.mkdirSync(oks, { recursive: true });
    const expira = meioMinuto(Date.now() + 20 * MIN);
    fs.writeFileSync(path.join(oks, 'KWMRTZ.json'), JSON.stringify({
      codigo: 'KWMRTZ', sessionId: 'sessao-a4a', status: 'pendente', tipo: 'crm', acao: 'Mover o deal', destinatarios: null, expiraEm: iso(expira),
    }));
    const r = rodar('ok-wpp.mjs', ['listar'], { ...a.env, CLAUDE_CODE_SESSION_ID: 'sessao-a4a' });
    assert.equal(r.status, 0, r.stderr);
    const l = JSON.parse(r.stdout);
    assert.equal(l.length, 1, r.stdout);
    return { hora: l[0].hora, expira };
  };
  let c = caso('Asia/Tokyo');
  assert.equal(c.hora, noDesloc(c.expira, TOQUIO).hora, 'sem config = a maquina');
  c = caso('Asia/Tokyo', { dono: { fuso: 'Asia/Colombo' } });
  assert.equal(c.hora, noDesloc(c.expira, COLOMBO).hora, 'o do config');
  c = caso('Asia/Colombo', { dono: { fuso: 'Marte/Base' } });
  assert.equal(c.hora, noDesloc(c.expira, COLOMBO).hora, 'fuso ruim = a maquina');
});

test('A4a 10. porteiro.mjs esperando (T24, o processo que a central roda): a "pergunta das" no fuso do config, senao no da maquina', () => {
  const SID = '0a4a0000-0000-4000-8000-000000000001';
  const caso = (tz, cfg) => {
    const a = ambiente(tz, cfg);
    // 3 dias atras: "DD/MM HH:MM" em qualquer fuso (nunca o dia de hoje), dentro dos 30 dias da pergunta
    const fim = meioMinuto(Date.now() - 72 * H);
    fs.writeFileSync(path.join(a.estado, 'estado.json'), JSON.stringify({
      ultimosParou: { [SID]: { finalTs: iso(fim), precisa: true, at: iso(fim), titulo: 'Aba do fuso', nome: null } },
    }));
    const r = rodar('porteiro.mjs', ['esperando'], a.env);
    assert.equal(r.status, 0, r.stderr);
    return { saida: r.stdout.trim().replace(/\r\n/g, '\n'), fim };
  };
  const confere = ({ saida, fim }, desloc, quem) => {
    const q = noDesloc(fim, desloc);
    assert.equal(saida, `Esperando você:\n- Aba do fuso (sessionId ${SID}, pergunta das ${q.dia} ${q.hora})`, quem);
  };
  confere(caso('Asia/Tokyo'), TOQUIO, 'sem config = a maquina');
  confere(caso('Asia/Tokyo', { dono: { fuso: 'Asia/Colombo' } }), COLOMBO, 'o do config');
  confere(caso('Asia/Colombo', { dono: { fuso: 'Marte/Base' } }), COLOMBO, 'fuso ruim = a maquina');
});

test('A4a 11. pelo fonte: o rodar do porteiro tira o dono do mesmo config e chama o definirFuso logo depois do lerConfig, com 1 linha "fuso:" depois da "apps:" e antes do subiu; abas, ler-grupo e ok-wpp chamam o definirFuso no comeco do main', () => {
  const ler = (arq) => fs.readFileSync(path.join(REPO, arq), 'utf8');
  const fonte = ler('porteiro.mjs');
  // so o corpo do rodar: do "async function rodar(" ate a proxima funcao do topo do arquivo
  const ini = fonte.indexOf('async function rodar(');
  const depois = fonte.slice(ini + 1).search(/\n(?:async )?function /);
  const r = depois === -1 ? fonte.slice(ini) : fonte.slice(ini, ini + 1 + depois);
  assert.ok(ini > 0 && r.includes('log(`subiu (pid'), 'o corpo do rodar');
  assert.equal(r.match(/\blerConfig\(/g)?.length, 1, 'o config lido 1 vez');
  const cfgEm = r.indexOf('const cfg = lerConfig(C.estadoDir);');
  const donoEm = r.indexOf('const dono = donoDoConfig(cfg);');
  const fusoEm = r.indexOf('definirFuso(dono.fuso);');
  assert.ok(cfgEm > 0 && donoEm > cfgEm && fusoEm > donoEm, 'o dono do mesmo cfg e o definirFuso dele');
  assert.ok(fusoEm < r.indexOf('const sessoes = sessoesDoConfig(cfg);'), 'logo depois do lerConfig');
  const logEm = r.indexOf('log(`fuso: ${fusoAtual()}`);');
  assert.ok(logEm > r.indexOf('log(`apps: '), 'depois da linha apps:');
  assert.ok(logEm > 0 && logEm < r.indexOf('log(`subiu (pid'), 'antes do subiu');
  // os outros 3: o definirFuso do config antes do primeiro ramo do main
  for (const [arq, antesDe] of [['abas.mjs', "if (args.includes('--fechadas'))"], ['ler-grupo.mjs', 'if (telegram) return lerDoTelegram(n);'],
    ['ok-wpp.mjs', 'const ok = criarOkWpp(opts);']]) {
    const f = ler(arq);
    const main = f.slice(f.search(/\nasync function main\(|\nfunction main\(/));
    const em = main.search(/definirFuso\(donoDoConfig\(cfg\)\.fuso\);/);
    assert.ok(em > 0 && em < main.indexOf(antesDe), `${arq}: o definirFuso antes de ${antesDe}`);
  }
});

// ---------- 12-13. o instalador ----------

test('A4a 12. instalar.mjs config: o dono vai normalizado (o nome, o artigo em minuscula, o fuso canonico); dono que nao e objeto, sem nome bom, com artigo fora de o/a/"" ou fuso que o Intl nao aceita = erro de uso e nada gravado', async () => {
  const a = ambienteDoInstalador();
  const r = await instalar.executar(['config', '--dados', JSON.stringify({ dono: { nome: '  Ana   Paula ', artigo: ' A ', fuso: 'asia/tokyo' } })], { env: a.env });
  assert.equal(r.codigo, 0, JSON.stringify(r.saida));
  assert.deepEqual(cfgGravado(a), { dono: { nome: 'Ana Paula', artigo: 'a', fuso: 'Asia/Tokyo' } });
  for (const [dono, gravado] of [
    [{ nome: 'Jose\u0301' }, { nome: 'José' }],
    [{ nome: 'Sam', artigo: '' }, { nome: 'Sam', artigo: '' }],
    [{ nome: 'Davi', artigo: 'o', fuso: 'America/Sao_Paulo' }, { nome: 'Davi', artigo: 'o', fuso: 'America/Sao_Paulo' }],
  ]) {
    const b = ambienteDoInstalador();
    const r2 = await instalar.executar(['config', '--dados', JSON.stringify({ dono })], { env: b.env });
    assert.equal(r2.codigo, 0, JSON.stringify(r2.saida));
    assert.deepEqual(cfgGravado(b), { dono: gravado }, JSON.stringify(dono));
  }
  for (const [dono, re] of [
    ['Ana', /^dono tem que ser um objeto/], [['Ana'], /^dono tem que ser um objeto/], [null, /^dono tem que ser um objeto/],
    [{}, /^dono\.nome tem que/], [{ nome: '' }, /^dono\.nome tem que/], [{ nome: '(Ana)' }, /^dono\.nome tem que/],
    [{ nome: 'A'.repeat(41) }, /^dono\.nome tem que/], [{ nome: 7 }, /^dono\.nome tem que/], [{ artigo: 'a' }, /^dono\.nome tem que/],
    [{ nome: 'Ana', artigo: 'as' }, /^dono\.artigo tem que/], [{ nome: 'Ana', artigo: 7 }, /^dono\.artigo tem que/],
    [{ nome: 'Ana', artigo: null }, /^dono\.artigo tem que/],
    [{ nome: 'Ana', fuso: 'Marte/Base' }, /^dono\.fuso tem que/], [{ nome: 'Ana', fuso: '' }, /^dono\.fuso tem que/],
    [{ nome: 'Ana', fuso: 7 }, /^dono\.fuso tem que/],
  ]) {
    const b = ambienteDoInstalador();
    const r2 = await instalar.executar(['config', '--dados', JSON.stringify({ apps: ['vscode'], dono })], { env: b.env });
    assert.equal(r2.codigo, 2, JSON.stringify(dono));
    assert.match(String(r2.saida.erro), re, JSON.stringify(dono));
    assert.equal(fs.existsSync(path.join(b.estado, 'config.json')), false, `nada gravado: ${JSON.stringify(dono)}`);
  }
});

test('A4a 13. a skill /instalar: a pergunta 3b (o artigo: do, da ou de <nome>) vira dono.artigo; o exemplo do config passa no passo config de verdade', async () => {
  const texto = fs.readFileSync(path.join(REPO, '.claude', 'skills', 'instalar', 'SKILL.md'), 'utf8');
  assert.match(texto, /^3b\. /m, 'a pergunta 3b');
  assert.match(texto, /dono\.artigo/);
  for (const forma of ['"do <nome>"', '"da <nome>"', '"de <nome>"']) assert.ok(texto.includes(forma), forma);
  const exemplo = /`(\{"apps":.*\})`/.exec(texto);
  assert.ok(exemplo, 'tem o exemplo do config');
  const a = ambienteDoInstalador();
  // T9: a pasta do exemplo tem que existir no PC pro config aceitar; aqui o disco e de mentira
  const r = await instalar.executar(['config', '--dados', exemplo[1]], { env: a.env, existePasta: () => true });
  assert.equal(r.codigo, 0, JSON.stringify(r.saida));
  assert.deepEqual(cfgGravado(a).dono, JSON.parse(exemplo[1]).dono);
});
