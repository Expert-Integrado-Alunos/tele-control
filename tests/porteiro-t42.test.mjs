// Testes da T42 (PLANO-TELEGRAM.md, "T42"; caso real: a sessao escondida que agenda um lembrete pra si mesma fica
// `idle` no registro enquanto espera, o devolverRetomadas lia isso como parada e fechava ela antes do lembrete tocar; o
// agendamento so vive no processo e morria junto, calado). Antes de fechar, o porteiro le no transcript da conversa os
// pedidos de lembrete (CronCreate, CronDelete, ScheduleWakeup) e espera o prazo do que ainda nao tocou.
// - T42 1: a proxima vez de um cron (a mesma gramatica e a mesma conta do Claude Code), em hora local.
// - T42 2: o que conta como lembrete por tocar (so o pedido com resultado sem erro, da conversa principal, feito depois
//   do corte) e ate quando (one-shot, recorrente, CronDelete, ScheduleWakeup).
// - T42 3: one-shot com o dono no PC: nao fecha ate o prazo, espera sem consultar o ocioso nem o processo, fecha depois.
// - T42 4: o lembrete segura tambem os outros 2 motivos (30 min parada; a mesma conversa viva no VS Code).
// - T42 5: o recorrente segura ate o CronDelete.
// - T42 6: o que nao segura: pedido com erro, de ajudante, da vida anterior do processo, conversa sem transcript.
// - T42 7: o ScheduleWakeup segura ate o atraso pedido; o `stop` solta.
// - T42 8: linha quebrada nao derruba a leitura; so os bytes novos sao lidos; arquivo que encolheu e relido do comeco.
// - T42 9: o transcript que some = nenhum lembrete conhecido; o que foi lido e esquecido (o que volta e lido do comeco).
// Isolamento: como o tests/porteiro-t41.test.mjs (pastas temporarias via SESSOES_WPP_DIR, CLAUDE_SESSIONS_DIR,
// CLAUDE_PROJECTS_DIR e SESSOES_WPP_LOG; dubles de tg, wpp, mensageiro e abridor; `processos` e `pidVivo` falsos: nenhum
// processo de verdade e consultado ou morto).
// Rodar: node --test --test-reporter=tap "tests/porteiro-t42.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { criarPorteiro, proximoDoCron, lembretesVazios, lerLembrete, lembreteAte } from '../porteiro.mjs';
import { NUMERO_DONO } from './lib/dados-whatsapp.mjs';
import { CENTRAL_TESTE } from './lib/dados-central.mjs';

const require = createRequire(import.meta.url);
const lib = require('../hooks/lib/sessoes-wpp.js');

const SEG = 1000;
const MIN = 60 * SEG;
const DIA = 24 * 60 * MIN;
const FOLGA = 3 * MIN; // depois da hora do lembrete
const TETO = 7 * DIA; // o recorrente expira sozinho
const ATRASO = 30 * MIN; // o atraso maximo do recorrente
const T0 = Date.parse('2026-09-29T15:00:00Z'); // 12:00 em Brasilia
const iso = (ms) => new Date(ms).toISOString();
const DONO = 700100200;
const BOT = 700900800;
const NOME = 'Revisão Porteiro';
const FALA = 'abre uma sessão pra revisar o porteiro';
const CENTRAL = 'Central de sessões de teste';
const N1 = '7c3f2e1d-3d9f-4e5c-8a4b-2345678901ef'; // a sessao nova
const NOVA = 43001; // pid da sessao nova escondida
const VSC = 41001; // pid da aba do VS Code
const PID_CENTRAL = 31001;
const PROJ = 'c--projetos';

// ---------- o transcript como o Claude Code grava ----------

let nUso = 0;
// O pedido (tool_use numa entrada `assistant`) e o resultado dele (tool_result numa entrada `user`).
function uso(ts, name, input, extra = {}) {
  nUso += 1;
  return {
    type: 'assistant', isSidechain: false, timestamp: iso(ts),
    message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${nUso}`, name, input }] }, ...extra,
  };
}
function res(ts, u, content, bloco = {}) {
  return {
    type: 'user', isSidechain: false, timestamp: iso(ts),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: u.message.content[0].id, content, ...bloco }] },
  };
}
// Os textos reais do resultado (CLI 2.1.322)
const UMA_VEZ = (cron, id = 'fb8538b1') => `Scheduled one-shot task ${id} (${cron}). Next run: Nov 11 3:39pm. Session-only (not written to disk, dies when Claude exits). It will fire once then auto-delete.`;
const RECORRENTE = (id) => `Scheduled recurring job ${id} (Every 5 minutes). Session-only (not written to disk, dies when Claude exits). Auto-expires after 7 days. Use CronDelete to cancel sooner.`;
const CANCELADO = (id) => `Cancelled job ${id}.`;
// O cron de 5 campos que bate so no minuto de `ms`, em hora local (o que o modelo escreve pra "daqui a N minutos")
function cronDe(ms) {
  const d = new Date(ms);
  return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
}
// O par pedido + resultado de um one-shot pro minuto `alvo`, pedido em `ts`
function umaVez(ts, alvo, id) {
  const u = uso(ts, 'CronCreate', { cron: cronDe(alvo), prompt: 'ACORDEI', recurring: false });
  return [u, res(ts + 200, u, UMA_VEZ(cronDe(alvo), id))];
}
function recorrente(ts, id, input = { recurring: true }) {
  const u = uso(ts, 'CronCreate', { cron: '*/5 * * * *', prompt: 'CONFERE', ...input });
  return [u, res(ts + 200, u, RECORRENTE(id))];
}
function cancelar(ts, id) {
  const u = uso(ts, 'CronDelete', { id });
  return [u, res(ts + 200, u, CANCELADO(id))];
}
function acordar(ts, input, texto = 'ok') {
  const u = uso(ts, 'ScheduleWakeup', input);
  return [u, res(ts + 200, u, texto)];
}
// O primeiro minuto cheio pelo menos `ms` depois de `de`
const minutoDepois = (de, ms) => Math.ceil((de + ms) / MIN) * MIN;

// ---------- a proxima vez do cron ----------

const L = (...a) => new Date(...a).getTime(); // hora local (o teste nao depende do fuso da maquina)
const QUA = L(2026, 10, 11, 15, 36, 14); // quarta, 11/11/2026 15:36:14

test('T42 1. proximoDoCron: o primeiro minuto que bate DEPOIS do minuto do pedido, em hora local, em ate 7 dias; `*`, `*/n`, `a`, `a-b`, `a-b/n` e listas; dia da semana 0 a 7; dia do mes e dia da semana restritos = um OU o outro; outra forma = null', () => {
  assert.equal(proximoDoCron('39 15 11 11 *', QUA), L(2026, 10, 11, 15, 39), 'o one-shot do caso real');
  assert.equal(proximoDoCron('  39   15 11  11 * ', QUA), L(2026, 10, 11, 15, 39), 'espacos a mais');
  assert.equal(proximoDoCron('37 15 11 11 *', QUA), L(2026, 10, 11, 15, 37), 'o minuto seguinte');
  assert.equal(proximoDoCron('36 15 11 11 *', QUA), null, 'o minuto do pedido ja passou: so no ano que vem');
  assert.equal(proximoDoCron('* * * * *', QUA), L(2026, 10, 11, 15, 37));
  assert.equal(proximoDoCron('*/5 * * * *', QUA), L(2026, 10, 11, 15, 40));
  assert.equal(proximoDoCron('5,45 15 * * *', QUA), L(2026, 10, 11, 15, 45), 'lista');
  assert.equal(proximoDoCron('10-50/20 16 * * *', QUA), L(2026, 10, 11, 16, 10), 'faixa com passo');
  assert.equal(proximoDoCron('30 */6 * * *', QUA), L(2026, 10, 11, 18, 30), 'hora com passo');
  assert.equal(proximoDoCron('0 0 * * *', QUA), L(2026, 10, 12, 0, 0), 'a virada do dia');
  // dia da semana
  assert.equal(proximoDoCron('0 9 * * 1-5', L(2026, 10, 13, 10, 0)), L(2026, 10, 16, 9, 0), 'sexta 10h -> segunda 9h');
  assert.equal(proximoDoCron('0 9 * * 7', QUA), L(2026, 10, 15, 9, 0), '7 = domingo');
  assert.equal(proximoDoCron('0 9 * * 0', QUA), L(2026, 10, 15, 9, 0), '0 = domingo');
  assert.equal(proximoDoCron('0 9 * * 5-7', QUA), L(2026, 10, 13, 9, 0), 'sexta a domingo');
  assert.equal(proximoDoCron('0 9 * * 0-7', QUA), L(2026, 10, 12, 9, 0), 'todos os dias');
  // dia do mes e dia da semana
  assert.equal(proximoDoCron('0 9 14 * *', QUA), L(2026, 10, 14, 9, 0), 'so o dia do mes');
  assert.equal(proximoDoCron('0 9 14 * 1', QUA), L(2026, 10, 14, 9, 0), 'os dois restritos: o dia 14 (sabado) vale');
  assert.equal(proximoDoCron('0 9 14 * 1', L(2026, 10, 14, 10, 0)), L(2026, 10, 16, 9, 0), 'os dois restritos: a segunda vale');
  assert.equal(proximoDoCron('0 9 1-31 * 1', QUA), L(2026, 10, 16, 9, 0), 'dia do mes inteiro = so o dia da semana');
  assert.equal(proximoDoCron('0 9 14 * 0-6', QUA), L(2026, 10, 14, 9, 0), 'dia da semana inteiro = so o dia do mes');
  // o teto de 7 dias
  assert.equal(proximoDoCron('0 9 18 11 *', QUA), L(2026, 10, 18, 9, 0), '6 dias e 17 h: dentro');
  assert.equal(proximoDoCron('36 15 18 11 *', QUA), L(2026, 10, 18, 15, 36), '7 dias menos 14 s: dentro');
  assert.equal(proximoDoCron('37 15 18 11 *', QUA), null, '7 dias e 46 s: fora');
  assert.equal(proximoDoCron('0 9 * 12 *', QUA), null, 'so em dezembro: fora');
  // o que o Claude Code recusa
  const TORTOS = ['', 'x', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * 32 * *', '* * * 0 *',
    '* * * 13 *', '* * * * 8', '5/15 * * * *', '* * * * MON', '*/0 * * * *', '5-3 * * * *', '1,,2 * * * *', '-1 * * * *',
    '1.5 * * * *', '1-5-9 * * * *', '* * 1-32 * *', '* * * * 6-8', '0 9 0-31 * *', '0 9 5-3 * 1'];
  for (const c of TORTOS) assert.equal(proximoDoCron(c, QUA), null, `cron torto: ${JSON.stringify(c)}`);
  for (const c of [null, undefined, 5, {}, ['* * * * *']]) assert.equal(proximoDoCron(c, QUA), null);
  for (const de of [NaN, null, '2026-11-11', Infinity]) assert.equal(proximoDoCron('* * * * *', de), null);
});

// ---------- o que conta como lembrete por tocar ----------

function lidas(entradas) {
  const st = lembretesVazios();
  for (const x of entradas) lerLembrete(st, x);
  return st;
}

test('T42 2. lerLembrete + lembreteAte: so o pedido com resultado sem erro, da conversa principal e feito depois do corte; one-shot = a proxima vez + 3 min (cron que nao le ou longe demais = 7 dias); recorrente = 7 dias + 30 min ate o CronDelete do id; ScheduleWakeup = o atraso (60 a 3600 s) + 3 min, o ultimo vale, `stop` cancela', () => {
  const T = QUA;
  const R = T + 200; // a hora do resultado
  const alvo = L(2026, 10, 11, 15, 39);
  // one-shot
  let st = lidas(umaVez(T, alvo));
  assert.equal(lembreteAte(st, 0, T + SEG), alvo + FOLGA);
  assert.equal(lembreteAte(st, 0, alvo + FOLGA - 1), alvo + FOLGA, 'ate o ultimo ms do prazo');
  assert.equal(lembreteAte(st, 0, alvo + FOLGA), null, 'o prazo passou');
  // o corte (a hora em que o processo nasceu): vale a hora do PEDIDO
  assert.equal(lembreteAte(st, T, T + SEG), alvo + FOLGA, 'pedido na hora do corte: conta');
  assert.equal(lembreteAte(st, T + 1, T + SEG), null, 'pedido antes do corte: da vida anterior');
  // sem resultado, com erro, de ajudante
  assert.equal(lembreteAte(lidas(umaVez(T, alvo).slice(0, 1)), 0, T + SEG), null, 'pedido sem resultado');
  const comErro = uso(T, 'CronCreate', { cron: cronDe(alvo), prompt: 'x', recurring: false });
  assert.equal(lembreteAte(lidas([comErro, res(R, comErro, 'Invalid cron expression', { is_error: true })]), 0, T + SEG), null, 'resultado com erro');
  const ajudante = uso(T, 'CronCreate', { cron: cronDe(alvo), prompt: 'x', recurring: false }, { isSidechain: true });
  assert.equal(lembreteAte(lidas([ajudante, res(R, ajudante, UMA_VEZ(cronDe(alvo)))]), 0, T + SEG), null, 'pedido de ajudante');
  const outra = uso(T, 'Bash', { command: 'echo CronCreate' });
  assert.equal(lembreteAte(lidas([outra, res(R, outra, 'CronCreate')]), 0, T + SEG), null, 'outra ferramenta');
  // cron que o porteiro nao le, ou longe demais: os 7 dias (contados do resultado)
  for (const cron of ['@daily', '36 15 11 11 *', '0 9 * 12 *']) {
    const u = uso(T, 'CronCreate', { cron, prompt: 'x', recurring: false });
    assert.equal(lembreteAte(lidas([u, res(R, u, UMA_VEZ(cron))]), 0, T + SEG), R + TETO + FOLGA, cron);
  }
  // resultado sem hora legivel: vale a hora do pedido; pedido sem hora legivel: nao conta
  const semHora = uso(T, 'CronCreate', { cron: '@daily', prompt: 'x', recurring: false });
  const resSemHora = res(R, semHora, UMA_VEZ('@daily'));
  delete resSemHora.timestamp;
  assert.equal(lembreteAte(lidas([semHora, resSemHora]), 0, T + SEG), T + TETO + FOLGA);
  const pedidoSemHora = uso(T, 'CronCreate', { cron: '*/5 * * * *', prompt: 'x' });
  delete pedidoSemHora.timestamp;
  assert.equal(lembreteAte(lidas([pedidoSemHora, res(R, pedidoSemHora, RECORRENTE('1179ed21'))]), 0, T + SEG), null, 'pedido sem hora');
  // recorrente (o padrao, com ou sem o campo): 7 dias + 30 min; sai so com o CronDelete do id dele, sem erro
  for (const input of [{ recurring: true }, {}]) {
    st = lidas(recorrente(T, '1179ed21', input));
    assert.equal(lembreteAte(st, 0, T + SEG), R + TETO + ATRASO);
    assert.equal(lembreteAte(st, 0, R + TETO + ATRASO), null, 'expirou');
  }
  st = lidas([...recorrente(T, '1179ed21'), ...cancelar(T + MIN, 'a7409e38')]);
  assert.equal(lembreteAte(st, 0, T + 2 * MIN), R + TETO + ATRASO, 'CronDelete de outro id');
  const cancelaErro = uso(T + MIN, 'CronDelete', { id: '1179ed21' });
  st = lidas([...recorrente(T, '1179ed21'), cancelaErro, res(T + MIN + 200, cancelaErro, 'No such job', { is_error: true })]);
  assert.equal(lembreteAte(st, 0, T + 2 * MIN), R + TETO + ATRASO, 'CronDelete com erro');
  st = lidas([...recorrente(T, '1179ed21'), ...cancelar(T + MIN, '1179ed21')]);
  assert.equal(lembreteAte(st, 0, T + 2 * MIN), null, 'CronDelete do id');
  // o texto do resultado em blocos; 2 lembretes: vale o prazo mais distante que ainda nao passou
  const emBlocos = uso(T, 'CronCreate', { cron: '*/5 * * * *', prompt: 'x' });
  st = lidas([emBlocos, res(R, emBlocos, [{ type: 'text', text: RECORRENTE('aa11bb22') }]), ...umaVez(T + SEG, alvo)]);
  assert.equal(lembreteAte(st, 0, T + 2 * SEG), R + TETO + ATRASO);
  for (const x of cancelar(T + MIN, 'aa11bb22')) lerLembrete(st, x);
  assert.equal(lembreteAte(st, 0, T + 2 * MIN), alvo + FOLGA, 'sobrou o one-shot');
  assert.equal(lembreteAte(st, 0, alvo + FOLGA), null);
  // ScheduleWakeup
  for (const [delaySeconds, vale] of [[600, 600], [30, 60], [99999, 3600], [undefined, 3600], ['x', 3600]]) {
    st = lidas(acordar(T, { delaySeconds, prompt: 'x', reason: 'y' }));
    assert.equal(lembreteAte(st, 0, T + SEG), R + vale * SEG + FOLGA, `delaySeconds ${delaySeconds}`);
  }
  st = lidas([...acordar(T, { delaySeconds: 3000, prompt: 'x' }), ...acordar(T + MIN, { delaySeconds: 120, prompt: 'x' })]);
  assert.equal(lembreteAte(st, 0, T + 2 * MIN), R + MIN + 120 * SEG + FOLGA, 'o ultimo vale');
  assert.equal(lembreteAte(st, T + 1, T + 2 * MIN), R + MIN + 120 * SEG + FOLGA, 'o corte olha o ultimo pedido');
  assert.equal(lembreteAte(st, T + MIN + 1, T + 2 * MIN), null);
  st = lidas([...acordar(T, { delaySeconds: 3000, prompt: 'x' }), ...acordar(T + MIN, { stop: true })]);
  assert.equal(lembreteAte(st, 0, T + 2 * MIN), null, 'stop');
  const acordaErro = uso(T + MIN, 'ScheduleWakeup', { stop: true });
  st = lidas([...acordar(T, { delaySeconds: 3000, prompt: 'x' }), acordaErro, res(T + MIN + 200, acordaErro, 'erro', { is_error: true })]);
  assert.equal(lembreteAte(st, 0, T + 2 * MIN), R + 3000 * SEG + FOLGA, 'stop com erro nao cancela');
  // entrada que nao e pedido nem resultado: ignorada
  st = lembretesVazios();
  for (const x of [null, 'x', 7, {}, { type: 'user', message: { content: 'ACORDEI' } }, { type: 'assistant', message: {} },
    { type: 'assistant', timestamp: iso(T), message: { content: [null, { type: 'text', text: 'CronCreate' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_nunca', content: 'x' }] } }]) lerLembrete(st, x);
  assert.equal(lembreteAte(st, 0, T), null);
});

// ---------- harness (do tests/porteiro-t41.test.mjs) ----------

const tique = () => new Promise((ok) => setImmediate(ok));
async function bombear(p) {
  for (let i = 0; i < 100; i++) {
    const r = await p.passoEntrega();
    if (!r.emVoo && !r.fila) return;
    await tique();
  }
  throw new Error('bombear: a fila de entrega nao esvaziou');
}
function comBomba(cru) {
  return {
    ...cru,
    passoEventos: async () => { await cru.passoEventos(); await bombear(cru); },
    passoSessoes: async () => { await cru.passoSessoes(); await bombear(cru); },
  };
}
function randFixo() {
  let n = 0;
  return {
    getRandomValues(b) {
      for (let i = 0; i < b.length; i += 1) b[i] = (n * b.length + i) % 256;
      n += 1;
      return b;
    },
  };
}
function dubleTg(h) {
  const tg = { chamadas: [], lotes: [], enviadas: 0 };
  const gravar = (metodo, args) => { tg.chamadas.push({ metodo, args }); };
  tg.lerAtualizacoes = async (args) => {
    gravar('lerAtualizacoes', { ...args });
    if (tg.chamadas.length > 5000) throw new Error('duble: leitura demais (laco sem fim?)');
    const lote = tg.lotes.shift();
    if (lote === undefined) {
      h.t += (Number(args?.esperaS) || 0) * 1000;
      return [];
    }
    return lote;
  };
  tg.enviar = async (pedido) => {
    gravar('enviar', [pedido]);
    tg.enviadas += 1;
    return { ok: true, messageId: 900 + tg.enviadas, formato: 'rich' };
  };
  tg.editar = async (messageId, pedido) => { gravar('editar', [messageId, pedido]); return { ok: true }; };
  tg.editarBotoes = async (messageId, botoes) => { gravar('editarBotoes', [messageId, botoes]); return { ok: true }; };
  tg.apagar = async (messageId) => { gravar('apagar', [messageId]); return { ok: true }; };
  tg.responderToque = async (id, texto) => { gravar('responderToque', [id, texto]); return { ok: true }; };
  tg.baixar = async () => ({ ok: false, erro: 'sem rede no teste' });
  tg.quemSou = async () => { gravar('quemSou', []); return { ok: true, id: BOT, username: 'Teste_ControleBot' }; };
  tg.definirComandos = async (c) => { gravar('definirComandos', [c]); return { ok: true }; };
  return tg;
}

// Porteiro com o Telegram, o abridor escondido de mentira e os processos falsos: `h.vivos` (pids vivos pro pidVivo),
// `h.procs` (pid -> o que o processos.info devolve), `h.filhos` (o que o processos.filhos devolve) e `h.mortes` (cada
// matarArvore). `h.idle` = o que o ocioso devolve (padrao 5 min: o dono fora do PC). Contadores: `h.ociosos` (cada
// leitura do ocioso) e `h.infos` (cada processos.info).
function montar() {
  const raiz = pastaTemp('porteiro-t42-');
  const env = {
    SESSOES_WPP_DIR: path.join(raiz, 'estado'),
    CLAUDE_SESSIONS_DIR: path.join(raiz, 'sessions'),
    CLAUDE_PROJECTS_DIR: path.join(raiz, 'projects'),
    SESSOES_WPP_LOG: path.join(raiz, 'porteiro.log'),
  };
  for (const d of [env.SESSOES_WPP_DIR, env.CLAUDE_SESSIONS_DIR, env.CLAUDE_PROJECTS_DIR]) fs.mkdirSync(d, { recursive: true });
  const repos = path.join(raiz, 'repos');
  const workspace = path.join(raiz, 'Meus Docs', 'trabalho', 'Area');
  for (const d of [path.join(repos, 'sessoes-wpp'), workspace]) fs.mkdirSync(d, { recursive: true });
  const h = {
    raiz, env, t: T0, idle: 5 * MIN, entregas: [], escondidas: [], nUpd: 100, nMid: 7000,
    pasta: path.join(repos, 'sessoes-wpp'), vivos: new Set(), procs: new Map(), filhos: [], mortes: [], ociosos: 0, infos: 0,
    estadoArq: path.join(env.SESSOES_WPP_DIR, 'estado.json'),
  };
  const wpp = {
    async lerGrupo() { return []; },
    async enviarGrupo() { return { ok: true, providerMsgId: 'P1', messageId: 'U1' }; },
    async reagir() { return { ok: true }; },
    async editarGrupo() { return { ok: true }; },
  };
  const mensageiro = {
    async entregar(p) {
      h.entregas.push(p);
      return { status: 'enviado', detalhe: '' };
    },
  };
  h.tg = dubleTg(h);
  const processos = {
    info(pid) {
      h.infos += 1;
      return h.procs.get(pid) ?? null;
    },
    matarArvore(pid) {
      h.mortes.push(pid);
      h.vivos.delete(pid);
      return true;
    },
    filhos() { return h.filhos; },
  };
  h.cru = criarPorteiro({
    wpp, numeroDono: NUMERO_DONO, mensageiro, agora: () => h.t, env, abrirCentral: () => {},
    ocioso: async () => {
      h.ociosos += 1;
      return h.idle;
    },
    rand: randFixo(), dormir: async (ms) => { h.t += ms; }, raizesSessao: [repos, workspace], ensaio: false, tg: h.tg,
    identTg: { chatId: DONO, botId: BOT }, processos, pidVivo: (pid) => h.vivos.has(Number(pid)), central: CENTRAL_TESTE,
    abrirSessaoEscondida: async (pasta, nome, retomada) => { h.escondidas.push([pasta, nome, retomada ?? null]); },
  });
  h.p = comBomba(h.cru);
  h.t += 1000; // as mensagens dos testes nascem depois do cursor inicial
  return h;
}

// Registro como o Claude Code grava (`<pid>.json`); o pid entra nos vivos e no processos.info (claude.exe criado na hora
// do startedAt). O status vale desde agora (statusUpdatedAt).
function registro(h, { pid, sessionId, entrypoint, name, cwd, status = 'idle', startedAt = h.t }) {
  const reg = {
    pid, sessionId, cwd, entrypoint, kind: 'interactive', name, nameSource: entrypoint === 'cli' ? 'user' : 'derived',
    status, startedAt, updatedAt: h.t, statusUpdatedAt: h.t,
  };
  fs.writeFileSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${pid}.json`), JSON.stringify(reg));
  h.vivos.add(pid);
  h.procs.set(pid, { nome: 'claude.exe', paiPid: 1, criadoEm: startedAt });
  return reg;
}
const nova = (h, o = {}) => registro(h, { pid: NOVA, sessionId: N1, entrypoint: 'cli', name: NOME, cwd: h.pasta, ...o });
const arqDe = (h, sessionId, pasta = PROJ) => path.join(h.env.CLAUDE_PROJECTS_DIR, pasta, `${sessionId}.jsonl`);
function transcript(h, sessionId, entradas, pasta = PROJ) {
  fs.mkdirSync(path.join(h.env.CLAUDE_PROJECTS_DIR, pasta), { recursive: true });
  fs.appendFileSync(arqDe(h, sessionId, pasta), entradas.map((x) => `${JSON.stringify(x)}\n`).join(''));
}
const estado = (h) => JSON.parse(fs.readFileSync(h.estadoArq, 'utf8'));
function mexer(h, fn) {
  const e = estado(h);
  fn(e);
  fs.writeFileSync(h.estadoArq, JSON.stringify(e));
}
const logs = (h) => {
  try { return fs.readFileSync(h.env.SESSOES_WPP_LOG, 'utf8').split('\n').filter(Boolean); } catch { return []; }
};
const comLog = (h, trecho) => logs(h).filter((l) => l.includes(trecho)).length;
const espera = (h, ate) => comLog(h, `retomada ${N1}: lembrete agendado nela ate ${iso(ate)}; espera`);
const fechada = (h, motivo) => comLog(h, `retomada ${N1}: a escondida (pid ${NOVA}) fechada: ${motivo}`);

// A central viva, o Telegram ligado, a fala do dono entregue na central, o `abrir-sessao` tratado, a sessao nova
// escondida firme (gravada em e.retomadas, T41) com a fala entregue; ela trabalhou 2 min e parou AGORA.
// -> {h, startedAt (a hora em que o processo dela nasceu), parou}
async function cenaParou() {
  const h = montar();
  registro(h, { pid: PID_CENTRAL, sessionId: 'SC', entrypoint: 'claude-vscode', name: 'projetos-99', cwd: 'c:\\projetos' });
  transcript(h, 'SC', [{ type: 'custom-title', customTitle: CENTRAL, sessionId: 'x' }]);
  mexer(h, (e) => { e.tg.offset = 0; });
  h.nUpd += 1;
  h.nMid += 1;
  h.tg.lotes.push([{
    update_id: h.nUpd,
    message: {
      message_id: h.nMid, date: Math.floor(h.t / 1000), text: FALA,
      chat: { id: DONO, type: 'private', first_name: 'Davi' }, from: { id: DONO, is_bot: false, first_name: 'Davi' },
    },
  }]);
  await h.p.esperarTelegram(15000);
  await bombear(h.cru);
  const A = `tg-u${h.nUpd}`;
  h.t += 10 * SEG;
  lib.anexarEvento(h.env.SESSOES_WPP_DIR, { v: 1, tipo: 'abrir-sessao', at: iso(h.t), nome: NOME, pasta: h.pasta, providerMsgId: A, por: 'SC' });
  await h.p.passoEventos();
  h.t += 3 * SEG;
  nova(h);
  await h.p.passoSessoes();
  h.t += 10 * SEG;
  await h.p.passoSessoes();
  assert.deepEqual(Object.keys(estado(h).retomadas), [N1], 'a sessao nova firmou e ficou gravada (T41)');
  const startedAt = h.t - 10 * SEG;
  h.t += 5 * SEG;
  nova(h, { status: 'busy', startedAt }); // pegou o recado e esta trabalhando
  h.t += 2 * MIN;
  nova(h, { status: 'idle', startedAt }); // terminou agora
  return { h, startedAt, parou: h.t };
}
// Uma vez inteira da sessao (o lembrete tocou, ou o dono falou com ela): trabalha `ms` e para.
function vez(h, startedAt, ms = 20 * SEG) {
  nova(h, { status: 'busy', startedAt });
  h.t += ms;
  nova(h, { status: 'idle', startedAt });
}

// Mac-testes (A): os testes marcados com SO_WINDOWS conferem a premissa do Windows (o processo `claude.exe`); fora do
// win32 eles pulam. O caminho do Mac tem os testes proprios em tests/mac-*.test.mjs.
const SO_WINDOWS = process.platform !== 'win32' && 'premissa do Windows (o Mac tem os tests/mac-*)';

// ---------- a escondida com lembrete espera o lembrete ----------

test('T42 3. one-shot agendado nela, com o dono no PC: parada ha 1 min nao fecha (1 linha de log, o prazo na entrada); enquanto espera nao consulta o ocioso nem o processo; o lembrete toca e ela segue ate o prazo (a hora do cron + 3 min); no prazo fecha pelas regras de sempre (comando rodando ainda segura) e os campos do lembrete saem', { skip: SO_WINDOWS }, async () => {
  const { h, startedAt, parou } = await cenaParou();
  const alvo = minutoDepois(parou, 2 * MIN);
  const prazo = alvo + FOLGA;
  transcript(h, N1, umaVez(parou - 5 * SEG, alvo));
  h.idle = 0; // o dono no PC
  h.t = parou + MIN;
  const [o0, i0] = [h.ociosos, h.infos];
  await h.p.passoRetomadas();
  assert.deepEqual(h.mortes, [], 'tem lembrete por tocar: nao fecha');
  assert.equal(espera(h, prazo), 1);
  assert.deepEqual(estado(h).retomadas[N1], { pid: NOVA, desde: estado(h).retomadas[N1].desde, lembreteAte: iso(prazo), lembreteDe: parou });
  assert.deepEqual([h.ociosos - o0, h.infos - i0], [1, 0], 'leu o ocioso 1 vez (o motivo) e nem chegou no processo');
  // esperando: nem o ocioso nem o processo; o log nao repete
  for (let i = 0; i < 3; i++) {
    h.t += 15 * SEG;
    await h.p.passoRetomadas();
  }
  assert.deepEqual([h.ociosos - o0, h.infos - i0], [1, 0], 'esperando: nem o ocioso nem o processo');
  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, []);
  assert.equal(h.infos - i0, 0);
  assert.equal(espera(h, prazo), 1);
  // o lembrete toca: ela trabalha 20 s e para; o prazo ainda nao passou
  h.t = alvo;
  transcript(h, N1, [{ type: 'user', isSidechain: false, isMeta: true, promptSource: 'system', turnOrigin: 'scheduled', timestamp: iso(alvo), message: { role: 'user', content: 'ACORDEI' } }]);
  vez(h, startedAt);
  const parou2 = h.t;
  h.t += MIN;
  await h.p.passoRetomadas();
  assert.deepEqual(h.mortes, [], 'parada ha 1 min depois do toque, antes do prazo: espera');
  assert.equal(estado(h).retomadas[N1].lembreteDe, parou2, 'conferiu de novo (ela mexeu)');
  assert.equal(espera(h, prazo), 1, 'o mesmo prazo nao loga de novo');
  h.t = prazo - 1;
  await h.p.passoRetomadas();
  assert.deepEqual(h.mortes, [], '1 ms antes do prazo');
  // no prazo: as guardas de sempre (comando rodando nela segura; os campos do lembrete saem)
  h.filhos = ['bash.exe'];
  h.t = prazo;
  await h.p.passoRetomadas();
  assert.deepEqual(h.mortes, []);
  assert.deepEqual(Object.keys(estado(h).retomadas[N1]).sort(), ['comandoEm', 'comandoVistoEm', 'desde', 'pid']);
  h.filhos = [];
  h.t += MIN;
  await h.p.passoRetomadas();
  assert.deepEqual(h.mortes, [NOVA]);
  assert.equal(fechada(h, 'o dono esta no PC'), 1);
  assert.deepEqual(estado(h).retomadas, {});
});

test('T42 4. o lembrete segura os outros 2 motivos: 30 min parada com o dono fora (fecha no prazo, mesmo sem ela mexer) e a mesma conversa viva no VS Code', { skip: SO_WINDOWS }, async () => {
  // 30 min parada, o dono fora do PC: o one-shot e pra daqui a ~40 min
  let { h, parou } = await cenaParou();
  let alvo = minutoDepois(parou, 40 * MIN);
  let prazo = alvo + FOLGA;
  transcript(h, N1, umaVez(parou - 5 * SEG, alvo));
  h.t = parou + 30 * MIN;
  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, [], '30 min parada, com lembrete: espera');
  assert.equal(espera(h, prazo), 1);
  h.t = prazo - 1;
  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, []);
  h.t = prazo;
  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, [NOVA], 'a conta e so de tempo: passou o prazo, fecha');
  assert.equal(fechada(h, `parada ha ${Math.round((prazo - parou) / MIN)} min`), 1);

  // o dono abriu a conversa no VS Code: o lembrete vive na escondida e morreria com ela
  ({ h, parou } = await cenaParou());
  alvo = minutoDepois(parou, 2 * MIN);
  prazo = alvo + FOLGA;
  transcript(h, N1, umaVez(parou - 5 * SEG, alvo));
  registro(h, { pid: VSC, sessionId: N1, entrypoint: 'claude-vscode', name: 'projetos-77', cwd: 'c:\\projetos', startedAt: h.t });
  h.t = parou + MIN;
  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, [], 'a mesma conversa no VS Code, com lembrete: espera');
  assert.equal(espera(h, prazo), 1);
  h.t = prazo;
  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, [NOVA]);
  assert.equal(fechada(h, 'a mesma conversa esta no VS Code'), 1);
});

test('T42 5. o recorrente segura ate o CronDelete: 3 dias parada com o dono no PC nao fecha; ela cancela (CronDelete do id) e fecha 1 min depois de parar', { skip: SO_WINDOWS }, async () => {
  const { h, startedAt, parou } = await cenaParou();
  const pedido = parou - 5 * SEG;
  transcript(h, N1, recorrente(pedido, '1179ed21'));
  const prazo = pedido + 200 + TETO + ATRASO;
  h.idle = 0;
  h.t = parou + MIN;
  await h.p.passoRetomadas();
  assert.deepEqual(h.mortes, []);
  assert.equal(espera(h, prazo), 1);
  h.t += 3 * DIA;
  await h.p.passoRetomadas();
  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, [], '3 dias depois: o recorrente segue valendo');
  // o dono manda parar: ela cancela o de outro id (nao solta) e depois o dela
  transcript(h, N1, cancelar(h.t, 'a7409e38'));
  vez(h, startedAt);
  h.t += MIN;
  await h.p.passoRetomadas();
  assert.deepEqual(h.mortes, [], 'cancelou outro id');
  transcript(h, N1, cancelar(h.t, '1179ed21'));
  vez(h, startedAt);
  h.t += 59 * SEG;
  await h.p.passoRetomadas();
  assert.deepEqual(h.mortes, [], '59 s parada: ainda nao');
  h.t += SEG;
  await h.p.passoRetomadas();
  assert.deepEqual(h.mortes, [NOVA]);
  assert.equal(fechada(h, 'o dono esta no PC'), 1);
  assert.equal(espera(h, prazo), 1, 'esperando, 1 linha so');
});

test('T42 6. nao segura (fecha parada ha 1 min com o dono no PC, como na T41): pedido com erro, pedido de ajudante, pedido da vida anterior do processo e conversa sem transcript', { skip: SO_WINDOWS }, async () => {
  const CASOS = {
    'pedido com erro': ({ parou }) => {
      const u = uso(parou - 5 * SEG, 'CronCreate', { cron: '*/5 * * * *', prompt: 'x' });
      return [u, res(parou - 4 * SEG, u, 'Too many scheduled jobs', { is_error: true })];
    },
    'pedido de ajudante': ({ parou }) => {
      const u = uso(parou - 5 * SEG, 'CronCreate', { cron: '*/5 * * * *', prompt: 'x' }, { isSidechain: true });
      return [u, res(parou - 4 * SEG, u, RECORRENTE('1179ed21'))];
    },
    'pedido da vida anterior': ({ startedAt }) => recorrente(startedAt - 1, '1179ed21'),
    'sem transcript': () => null,
  };
  for (const [caso, entradas] of Object.entries(CASOS)) {
    const c = await cenaParou();
    const { h, parou } = c;
    const linhas = entradas(c);
    if (linhas) transcript(h, N1, linhas);
    h.idle = 0;
    h.t = parou + 59 * SEG;
    await h.p.passoRetomadas();
    assert.deepEqual(h.mortes, [], `${caso}: 59 s`);
    h.t += SEG;
    await h.p.passoRetomadas();
    assert.deepEqual(h.mortes, [NOVA], caso);
    assert.equal(comLog(h, 'lembrete agendado'), 0, caso);
    assert.equal(fechada(h, 'o dono esta no PC'), 1, caso);
  }
});

test('T42 7. o ScheduleWakeup segura ate o atraso pedido + 3 min; a vez seguinte troca o prazo (1 linha de log nova); o `stop` solta', { skip: SO_WINDOWS }, async () => {
  const { h, startedAt, parou } = await cenaParou();
  const pedido = parou - 5 * SEG;
  transcript(h, N1, acordar(pedido, { delaySeconds: 600, prompt: 'CONFERE', reason: 'esperando o build' }));
  const prazo = pedido + 200 + 600 * SEG + FOLGA;
  h.idle = 0;
  h.t = parou + MIN;
  await h.p.passoRetomadas();
  assert.deepEqual(h.mortes, []);
  assert.equal(espera(h, prazo), 1);
  // acordou, trabalhou e marcou de novo: prazo novo, linha nova
  h.t = pedido + 600 * SEG;
  const pedido2 = h.t + 10 * SEG;
  transcript(h, N1, acordar(pedido2, { delaySeconds: 1200, prompt: 'CONFERE', reason: 'ainda esperando' }));
  vez(h, startedAt);
  const prazo2 = pedido2 + 200 + 1200 * SEG + FOLGA;
  h.t += MIN;
  await h.p.passoRetomadas();
  assert.deepEqual(h.mortes, []);
  assert.deepEqual([espera(h, prazo), espera(h, prazo2)], [1, 1]);
  assert.equal(estado(h).retomadas[N1].lembreteAte, iso(prazo2));
  // acordou e encerrou o laco
  h.t = pedido2 + 1200 * SEG;
  transcript(h, N1, acordar(h.t + 10 * SEG, { stop: true }));
  vez(h, startedAt);
  h.t += MIN;
  await h.p.passoRetomadas();
  assert.deepEqual(h.mortes, [NOVA]);
  assert.equal(fechada(h, 'o dono esta no PC'), 1);
});

test('T42 8. a linha quebrada nao derruba a leitura; o transcript e lido so nos bytes novos (o que ja foi lido nao e relido, mesmo com ela mexendo) e o arquivo que encolheu e relido do comeco', { skip: SO_WINDOWS }, async () => {
  const { h, startedAt, parou } = await cenaParou();
  const pedido = parou - 5 * SEG;
  // uma linha cortada no meio (JSON invalido) antes do pedido
  fs.mkdirSync(path.dirname(arqDe(h, N1)), { recursive: true });
  fs.appendFileSync(arqDe(h, N1), '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"CronCreate"\n');
  transcript(h, N1, recorrente(pedido, '1179ed21'));
  const prazo = pedido + 200 + TETO + ATRASO;
  h.idle = 0;
  h.t = parou + MIN;
  await h.p.passoRetomadas();
  assert.equal(espera(h, prazo), 1);
  // o mesmo arquivo, do mesmo tamanho, sem o pedido: se relesse do comeco, perdia o lembrete
  const arq = arqDe(h, N1);
  const antes = fs.readFileSync(arq, 'utf8');
  fs.writeFileSync(arq, antes.replaceAll('CronCreate', 'CronXreate'));
  assert.equal(fs.statSync(arq).size, Buffer.byteLength(antes));
  vez(h, startedAt);
  h.t += MIN;
  await h.p.passoRetomadas();
  assert.deepEqual(h.mortes, [], 'so os bytes novos: o lembrete lido continua valendo');
  // o arquivo encolhe (outro conteudo, menor): relido do comeco, sem pedido nenhum
  fs.writeFileSync(arq, `${JSON.stringify({ type: 'user', timestamp: iso(h.t), message: { role: 'user', content: 'oi' } })}\n`);
  vez(h, startedAt);
  h.t += MIN;
  await h.p.passoRetomadas();
  assert.deepEqual(h.mortes, [NOVA], 'o arquivo encolheu: relido do comeco, nenhum lembrete');
});

test('T42 9. o transcript que some depois de lido: nenhum lembrete conhecido (segue pras guardas de sempre) e o que foi lido e esquecido (o arquivo que volta, maior, e lido do comeco)', { skip: SO_WINDOWS }, async () => {
  const { h, startedAt, parou } = await cenaParou();
  const pedido = parou - 5 * SEG;
  transcript(h, N1, recorrente(pedido, '1179ed21'));
  const arq = arqDe(h, N1);
  const lido = fs.statSync(arq).size;
  h.idle = 0;
  h.t = parou + MIN;
  await h.p.passoRetomadas();
  assert.equal(espera(h, pedido + 200 + TETO + ATRASO), 1);
  // some: sem lembrete conhecido, vai pras guardas de sempre (o comando rodando nela segura; sem ele, fecharia)
  fs.unlinkSync(arq);
  h.filhos = ['bash.exe'];
  vez(h, startedAt);
  h.t += MIN;
  await h.p.passoRetomadas();
  assert.deepEqual(h.mortes, []);
  assert.deepEqual(Object.keys(estado(h).retomadas[N1]).sort(), ['comandoEm', 'comandoVistoEm', 'desde', 'pid'], 'sem os campos do lembrete');
  // volta maior, com um one-shot novo ANTES do ponto ate onde o antigo tinha sido lido: lido do comeco, vale so o novo
  const alvo = minutoDepois(h.t, 5 * MIN);
  transcript(h, N1, umaVez(h.t, alvo));
  transcript(h, N1, Array.from({ length: 20 }, () => ({ type: 'user', timestamp: iso(h.t), message: { role: 'user', content: 'x'.repeat(200) } })));
  assert.ok(fs.statSync(arq).size > lido);
  h.filhos = [];
  vez(h, startedAt);
  h.t += MIN;
  await h.p.passoRetomadas();
  assert.deepEqual(h.mortes, []);
  assert.equal(estado(h).retomadas[N1].lembreteAte, iso(alvo + FOLGA), 'so o lembrete do arquivo novo');
  h.t = alvo + FOLGA;
  await h.p.passoRetomadas();
  assert.deepEqual(h.mortes, [NOVA]);
});
