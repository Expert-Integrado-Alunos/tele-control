// Testes da T43 (PLANO-TELEGRAM.md, "T43"; caso real: o dono pediu pelo Telegram um lembrete unico, o lembrete tocou e
// o final daquela vez, que so informava, nunca chegou no Telegram: a vez que comeca pelo toque nao responde fala nenhuma
// e so ia o que pedia o dono). Agora a volta do lembrete unico pedido pelo Telegram sempre chega la, como resposta.
// - T43 1: de onde veio a ultima fala do dono na conversa (Telegram, WhatsApp, teclado).
// - T43 2: o que conta como lembrete unico pedido pelo Telegram (CronCreate recurring false, sem erro, da conversa
//   principal) e o que tira ele da lista (CronDelete, o teto de 50).
// - T43 3: o toque casa com o lembrete (pelo id; faltando o id de um lado, pelo texto), toca 1 vez e vale 30 dias; o
//   final e da vez do toque quando fica entre o toque e a vez seguinte.
// - T43 4: o fluxo: pedido pelo Telegram, o lembrete toca, o final que so informa chega como mensagem nova com
//   notificacao, com o dono no PC ou na rua.
// - T43 5: o que segue como hoje (recorrente, ScheduleWakeup, pedido pelo teclado, conversa sem fala do Telegram,
//   lembrete cancelado, toque de outro lembrete).
// - T43 6: o toque sem id (Claude Code de antes) casa pelo texto; 2 lembretes, 2 voltas, cada um 1 vez.
// - T43 7: a trava segura; a continuacao por hook nao repete; a vez do toque que responde uma fala segue o caminho de
//   hoje (Telegram) ou manda as duas (WhatsApp).
// - T43 8: transcript atrasado: confere de novo em 5 s, 15 s e 45 s; parou mais novo = desiste.
// - T43 9: o que foi lido fica no estado (porteiro religado), so os bytes novos sao lidos, arquivo que encolheu zera.
// - T43 10: a entrada nasce na entrega do Telegram; a faxina (30 dias, 200); a entrada torta e relida do comeco.
// - T43 11: o encerrar da escondida que devolve erro: quem decide e o pid.
// Isolamento: como o tests/porteiro-t7f.test.mjs (pastas temporarias via SESSOES_WPP_DIR, CLAUDE_SESSIONS_DIR,
// CLAUDE_PROJECTS_DIR e SESSOES_WPP_LOG; dubles de tg, wpp e mensageiro; relogio e `dormir` falsos). No T43 11 o
// `processos` e o `pidVivo` sao falsos: nenhum processo de verdade e consultado ou morto.
// Rodar: node --test --test-reporter=tap "tests/porteiro-t43.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pastaTemp } from './lib/pasta-temp.cjs';
import * as porteiro from '../porteiro.mjs';
import { NUMERO_DONO } from './lib/dados-whatsapp.mjs';
import { CENTRAL_TESTE, RAIZES_TESTE } from './lib/dados-central.mjs';
import { montarRecado } from '../mensageiro.mjs';

const { criarPorteiro, toquesVazios, lerToque, toqueDoFinal } = porteiro;
const require = createRequire(import.meta.url);
const lib = require('../hooks/lib/sessoes-wpp.js');

const SEG = 1000;
const MIN = 60 * SEG;
const DIA = 24 * 60 * MIN;
const T0 = Date.parse('2026-09-29T15:00:00Z'); // 12:00 em Brasilia
const iso = (ms) => new Date(ms).toISOString();
const DONO = 700100200;
const BOT = 700900800;
const DAVI = { nome: 'Davi', artigo: 'o' };

// ---------- o transcript como o Claude Code grava ----------

let nUso = 0;
// O pedido (tool_use numa entrada `assistant`) e o resultado dele (tool_result numa entrada `user`; `extra` = os campos
// de fora da mensagem, como o toolUseResult).
function uso(ts, name, input, extra = {}) {
  nUso += 1;
  return {
    type: 'assistant', isSidechain: false, timestamp: iso(ts),
    message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${nUso}`, name, input }] }, ...extra,
  };
}
function res(ts, u, content, bloco = {}, extra = {}) {
  return {
    type: 'user', isSidechain: false, timestamp: iso(ts),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: u.message.content[0].id, content, ...bloco }] }, ...extra,
  };
}
// Os textos reais do resultado (CLI 2.1.322)
const CRON = '39 15 11 11 *';
const UMA_VEZ = (id) => `Scheduled one-shot task ${id} (${CRON}). Next run: Nov 11 3:39pm. Session-only (not written to disk, dies when Claude exits). It will fire once then auto-delete.`;
const RECORRENTE = (id) => `Scheduled recurring job ${id} (Every 5 minutes). Session-only (not written to disk, dies when Claude exits). Auto-expires after 7 days. Use CronDelete to cancel sooner.`;
const CANCELADO = (id) => `Cancelled job ${id}.`;
// O par pedido + resultado de um lembrete unico. `noCampo` = o id no toolUseResult; `noTexto` = o id no texto.
function unico(ts, prompt, id, { noCampo = true, noTexto = true } = {}) {
  const u = uso(ts, 'CronCreate', { cron: CRON, prompt, recurring: false });
  const extra = noCampo ? { toolUseResult: { id, humanSchedule: CRON, recurring: false, durable: false } } : {};
  return [u, res(ts + 200, u, noTexto ? UMA_VEZ(id) : 'Scheduled.', {}, extra)];
}
function recorrente(ts, prompt, id, input = { recurring: true }) {
  const u = uso(ts, 'CronCreate', { cron: '*/5 * * * *', prompt, ...input });
  return [u, res(ts + 200, u, RECORRENTE(id), {}, { toolUseResult: { id, humanSchedule: 'Every 5 minutes', recurring: true, durable: false } })];
}
function cancelar(ts, id) {
  const u = uso(ts, 'CronDelete', { id });
  return [u, res(ts + 200, u, CANCELADO(id))];
}
function acordar(ts, prompt) {
  const u = uso(ts, 'ScheduleWakeup', { delaySeconds: 180, prompt, reason: 'esperando' });
  return [u, res(ts + 200, u, 'ok')];
}

// A entrada que abre uma vez: `type: "user"` com `turnOrigin`.
const abre = (ts, turnOrigin, content, extra = {}) => ({
  type: 'user', isSidechain: false, timestamp: iso(ts), turnOrigin, message: { role: 'user', content }, ...extra,
});
const teclado = (ts, texto = 'continua', turnOrigin = 'human') => abre(ts, turnOrigin, [{ type: 'text', text: texto }], { promptSource: 'sdk', origin: { kind: 'human' } });
const embrulho = (texto, de = 'sessoes-wpp-6f') => `Another Claude session sent a message:\n<cross-session-message from="uds:x" from-name="${de}">\n${texto}\n</cross-session-message>`;
// O recado do porteiro (o montarRecado de verdade), como chega na aba parada
const recado = (ts, pedido, dono = DAVI) => abre(ts, 'peer', embrulho(montarRecado(pedido, dono)), { isMeta: true, promptSource: 'system', origin: { kind: 'peer', from: 'uds:x' } });
const deOutraSessao = (ts, texto) => abre(ts, 'peer', embrulho(texto, 'projetos-7'), { isMeta: true, promptSource: 'system', origin: { kind: 'peer', from: 'uds:y' } });
const avisoDeTarefa = (ts) => abre(ts, 'task_notification', '<task-notification>terminou</task-notification>', { promptSource: 'system', origin: { kind: 'task-notification' } });
// O toque do lembrete: com `taskId` = o Claude Code de 11/11/2026; sem = o de antes
const toque = (ts, prompt, taskId = null) => abre(ts, 'scheduled', prompt, {
  isMeta: true, promptSource: 'system', ...(taskId ? { scheduledTaskId: taskId, scheduledFireId: `fire-${taskId}`, wakeupSource: 'schedule_wakeup' } : {}),
});
const resumo = (ts, turnOrigin = 'human') => abre(ts, turnOrigin, 'This session is being continued from a previous conversation.', { isCompactSummary: true, isVisibleInTranscriptOnly: true });
// A fala que entra no meio da vez
const noMeio = (ts, kind, prompt) => ({
  type: 'attachment', isSidechain: false, timestamp: iso(ts),
  attachment: { type: 'queued_command', commandMode: 'prompt', origin: { kind }, prompt, timestamp: iso(ts) },
});

const PEDIDO_TG = { texto: 'me lembra em 3 min de ligar pro João', hora: '12:00', providerMsgId: 'tg-u101', canal: 'telegram' };
const PEDIDO_WPP = { texto: 'e o resto?', hora: '12:01', providerMsgId: 'PROV9' };

function lidas(entradas) {
  const st = toquesVazios();
  for (const x of entradas) lerToque(st, x);
  return st;
}

// ---------- de onde veio a ultima fala do dono ----------

test('T43 1. lerToque, o canal da ultima fala do dono: recado do porteiro com o rotulo Telegram = sim, com o rotulo WhatsApp = nao; vez aberta pelo teclado (human ou sdk) ou fala do teclado no meio da vez = nao; recado de outra sessao, aviso de tarefa, toque, resumo de compactacao e ajudante nao mudam', () => {
  const T = T0;
  assert.deepEqual(toquesVazios(), { tg: false, usos: [], unicos: [], toques: [] });
  const tg = (entradas) => lidas(entradas).tg;
  assert.equal(tg([]), false);
  assert.equal(tg([recado(T, PEDIDO_TG)]), true, 'recado do Telegram');
  assert.equal(tg([recado(T, { ...PEDIDO_TG, audio: true })]), true, 'audio transcrito');
  assert.equal(tg([recado(T, { ...PEDIDO_TG, reforco: true })]), true, 'o reforco');
  assert.equal(tg([recado(T, { ...PEDIDO_TG, providerMsgId: 'tgok-u102' })]), true, 'o toque no botao do pedido de OK');
  for (const dono of [{ nome: 'Ana', artigo: 'a' }, { nome: 'Sam', artigo: '' }, undefined]) {
    assert.equal(tg([recado(T, PEDIDO_TG, dono)]), true, `dono ${JSON.stringify(dono)}`);
  }
  assert.equal(tg([recado(T, PEDIDO_WPP)]), false, 'recado do WhatsApp');
  assert.equal(tg([recado(T, PEDIDO_TG), recado(T + SEG, PEDIDO_WPP)]), false, 'recado do WhatsApp depois');
  assert.equal(tg([recado(T, PEDIDO_WPP), recado(T + SEG, PEDIDO_TG)]), true, 'recado do Telegram depois');
  assert.equal(tg([recado(T, PEDIDO_TG), teclado(T + SEG)]), false, 'vez aberta pelo teclado');
  assert.equal(tg([recado(T, PEDIDO_TG), teclado(T + SEG, 'x', 'sdk')]), false, 'vez aberta pelo teclado (sdk)');
  assert.equal(tg([recado(T, PEDIDO_TG), abre(T + SEG, 'human', montarRecado(PEDIDO_TG, DAVI))]), false, 'recado colado pelo teclado nao conta');
  // a fala que entra no meio da vez
  assert.equal(tg([recado(T, PEDIDO_TG), noMeio(T + SEG, 'human', [{ type: 'text', text: 'aproveita e agenda' }])]), false, 'teclado no meio da vez');
  assert.equal(tg([teclado(T), noMeio(T + SEG, 'peer', embrulho(montarRecado(PEDIDO_TG, DAVI)))]), true, 'recado do Telegram no meio da vez');
  assert.equal(tg([teclado(T), noMeio(T + SEG, 'peer', [{ type: 'text', text: embrulho(montarRecado(PEDIDO_TG, DAVI)) }])]), true, 'o mesmo, em blocos');
  assert.equal(tg([recado(T, PEDIDO_TG), noMeio(T + SEG, 'peer', embrulho(montarRecado(PEDIDO_WPP, DAVI)))]), false, 'recado do WhatsApp no meio da vez');
  // o que nao muda nada (parte de "sim" e parte de "nao")
  const NAO_MUDAM = {
    'recado de outra sessao': deOutraSessao(T + SEG, 'termina o relatório'),
    'outra sessao citando o rotulo do Telegram no meio da linha': deOutraSessao(T + SEG, `o dono pediu: ${montarRecado(PEDIDO_TG, DAVI)}`),
    'outra sessao citando o rotulo do WhatsApp no meio da linha': deOutraSessao(T + SEG, `o dono pediu: ${montarRecado(PEDIDO_WPP, DAVI)}`),
    'rotulo sem o id': deOutraSessao(T + SEG, 'Telegram do Davi (12:00). Abra a sua resposta'),
    'aviso de tarefa': avisoDeTarefa(T + SEG),
    'aviso de tarefa no meio da vez': noMeio(T + SEG, 'task-notification', '<task-notification>terminou</task-notification>'),
    'toque de lembrete': toque(T + SEG, 'ACORDEI', 'c03d7c0a'),
    'resultado de ferramenta': res(T + SEG, uso(T, 'Bash', { command: 'ls' }), 'ok'),
    'entrada do sistema': { type: 'system', subtype: 'scheduled_task_fire', timestamp: iso(T + SEG), prompt: 'ACORDEI' },
    'anexo que nao e fala': { type: 'attachment', isSidechain: false, timestamp: iso(T + SEG), attachment: { type: 'file', origin: { kind: 'human' } } },
  };
  for (const [rot, x] of Object.entries(NAO_MUDAM)) {
    assert.equal(tg([recado(T, PEDIDO_TG), x]), true, `${rot} (depois do Telegram)`);
    assert.equal(tg([teclado(T), x]), false, `${rot} (depois do teclado)`);
  }
  // o resumo de compactacao traz turnOrigin e nao abre vez; o ajudante (isSidechain) nunca conta
  assert.equal(tg([recado(T, PEDIDO_TG), resumo(T + SEG, 'human')]), true, 'resumo de compactacao');
  assert.equal(tg([teclado(T), resumo(T + SEG, 'peer')]), false);
  assert.equal(tg([recado(T, PEDIDO_TG), { ...teclado(T + SEG), isSidechain: true }]), true, 'teclado de ajudante');
  assert.equal(tg([teclado(T), { ...recado(T + SEG, PEDIDO_TG), isSidechain: true }]), false, 'recado de ajudante');
  assert.equal(tg([teclado(T), { ...noMeio(T + SEG, 'peer', embrulho(montarRecado(PEDIDO_TG, DAVI))), isSidechain: true }]), false);
  // lixo nao derruba
  const st = lidas([recado(T, PEDIDO_TG)]);
  for (const x of [null, 'x', 7, [], {}, { type: 'user' }, { type: 'user', turnOrigin: 'peer', timestamp: iso(T), message: {} },
    { type: 'attachment' }, { type: 'attachment', attachment: null }, { type: 'attachment', attachment: { type: 'queued_command', origin: { kind: 'peer' } } },
    { type: 'assistant', message: { content: 'x' } }, { type: 'assistant', timestamp: iso(T), message: { content: [null, { type: 'text', text: 'CronCreate' }] } }]) lerToque(st, x);
  assert.deepEqual(st, { tg: true, usos: [], unicos: [], toques: [] });
});

// ---------- o que conta como lembrete unico pedido pelo Telegram ----------

test('T43 2. lerToque, o lembrete unico: so o CronCreate com recurring false, pedido com a ultima fala do dono vinda do Telegram, da conversa principal e com resultado sem erro; o id vem do toolUseResult (sem ele, do texto; sem os dois, null) e do texto fica so a marca; o CronDelete do id tira; no maximo 50', () => {
  const T = T0;
  const base = [recado(T, PEDIDO_TG)];
  let st = lidas([...base, ...unico(T + SEG, 'LIGAR PRO JOÃO', 'c03d7c0a')]);
  assert.deepEqual(st.usos, [], 'o pedido com resultado sai da espera');
  assert.equal(st.unicos.length, 1);
  assert.equal(st.unicos[0].id, 'c03d7c0a');
  assert.equal(st.unicos[0].em, T + SEG + 200, 'a hora do resultado');
  assert.match(st.unicos[0].prompt, /^[0-9a-f]{16}$/, 'do texto, so a marca');
  assert.ok(!JSON.stringify(st).includes('LIGAR'), 'o texto do lembrete nao fica guardado');
  assert.deepEqual(st.toques, []);
  // o id: do campo; sem o campo, do texto; sem os dois, null (o resultado em blocos tambem e lido)
  assert.equal(lidas([...base, ...unico(T + SEG, 'X', 'aa11bb22', { noCampo: false })]).unicos[0].id, 'aa11bb22', 'do texto');
  assert.equal(lidas([...base, ...unico(T + SEG, 'X', 'aa11bb22', { noTexto: false })]).unicos[0].id, 'aa11bb22', 'do campo');
  assert.equal(lidas([...base, ...unico(T + SEG, 'X', 'aa11bb22', { noCampo: false, noTexto: false })]).unicos[0].id, null, 'sem id');
  const emBlocos = uso(T + SEG, 'CronCreate', { cron: CRON, prompt: 'X', recurring: false });
  assert.equal(lidas([...base, emBlocos, res(T + 2 * SEG, emBlocos, [{ type: 'text', text: UMA_VEZ('cc33dd44') }])]).unicos[0].id, 'cc33dd44', 'texto em blocos');
  const campoTorto = uso(T + SEG, 'CronCreate', { cron: CRON, prompt: 'X', recurring: false });
  assert.equal(lidas([...base, campoTorto, res(T + 2 * SEG, campoTorto, UMA_VEZ('ee55ff66'), {}, { toolUseResult: { id: 7 } })]).unicos[0].id, 'ee55ff66', 'campo que nao e texto: vale o do texto');
  // sem o resultado ainda: fica esperando; o resultado sem hora legivel vale a hora do pedido
  const [pedido, resultado] = unico(T + SEG, 'X', 'x1');
  st = lidas([...base, pedido]);
  assert.equal(st.usos.length, 1);
  assert.deepEqual(st.unicos, []);
  delete resultado.timestamp;
  lerToque(st, resultado);
  assert.deepEqual(st.usos, []);
  assert.equal(st.unicos[0].em, T + SEG, 'a hora do pedido');
  // o que nao conta
  const comErro = uso(T + SEG, 'CronCreate', { cron: CRON, prompt: 'X', recurring: false });
  const deAjudante = unico(T + SEG, 'X', 'x1').map((x) => ({ ...x, isSidechain: true }));
  const outra = uso(T + SEG, 'Bash', { command: 'echo CronCreate', recurring: false });
  const semHora = unico(T + SEG, 'X', 'x1');
  for (const x of semHora) delete x.timestamp;
  const NAO = {
    recorrente: recorrente(T + SEG, 'X', '1179ed21'),
    'sem o campo recurring (o padrao e recorrente)': recorrente(T + SEG, 'X', '1179ed21', {}),
    'recurring que nao e false': recorrente(T + SEG, 'X', '1179ed21', { recurring: 'false' }),
    ScheduleWakeup: acordar(T + SEG, 'X'),
    'resultado com erro': [comErro, res(T + 2 * SEG, comErro, 'Too many scheduled jobs', { is_error: true })],
    'pedido de ajudante': deAjudante,
    'outra ferramenta': [outra, res(T + 2 * SEG, outra, UMA_VEZ('x1'))],
    'pedido e resultado sem hora': semHora,
    'resultado de um pedido que nao foi visto': [res(T + SEG, { message: { content: [{ id: 'toolu_nunca' }] } }, UMA_VEZ('x1'))],
  };
  for (const [rot, entradas] of Object.entries(NAO)) {
    st = lidas([...base, ...entradas]);
    assert.deepEqual(st.unicos, [], rot);
    assert.deepEqual(st.usos, [], `${rot}: nada esperando`);
  }
  // pedido fora do Telegram: vale a ultima fala do dono ANTES do pedido
  assert.deepEqual(lidas(unico(T, 'X', 'x1')).unicos, [], 'conversa sem fala nenhuma');
  assert.deepEqual(lidas([teclado(T), ...unico(T + SEG, 'X', 'x1')]).unicos, [], 'pedido pelo teclado');
  assert.deepEqual(lidas([...base, teclado(T + SEG), ...unico(T + 2 * SEG, 'X', 'x1')]).unicos, [], 'o teclado depois do Telegram');
  assert.deepEqual(lidas([...base, recado(T + SEG, PEDIDO_WPP), ...unico(T + 2 * SEG, 'X', 'x1')]).unicos, [], 'o WhatsApp depois do Telegram');
  assert.equal(lidas([teclado(T), recado(T + SEG, PEDIDO_TG), ...unico(T + 2 * SEG, 'X', 'x1')]).unicos.length, 1, 'o Telegram depois do teclado');
  assert.equal(lidas([...base, avisoDeTarefa(T + SEG), ...unico(T + 2 * SEG, 'X', 'x1')]).unicos.length, 1, 'aviso de tarefa nao muda');
  const [p2, r2] = unico(T + SEG, 'X', 'x1');
  assert.equal(lidas([...base, p2, teclado(T + 2 * SEG), r2]).unicos.length, 1, 'vale a hora do pedido, nao a do resultado');
  // CronDelete: tira o do id; outro id, com erro ou lembrete sem id = fica
  const dois = [...base, ...unico(T + SEG, 'A', 'id1'), ...unico(T + 2 * SEG, 'B', 'id2')];
  assert.deepEqual(lidas([...dois, ...cancelar(T + 3 * SEG, 'id1')]).unicos.map((j) => j.id), ['id2']);
  assert.deepEqual(lidas([...dois, ...cancelar(T + 3 * SEG, 'id9')]).unicos.map((j) => j.id), ['id1', 'id2'], 'outro id');
  const cancelaErro = uso(T + 3 * SEG, 'CronDelete', { id: 'id1' });
  assert.deepEqual(lidas([...dois, cancelaErro, res(T + 4 * SEG, cancelaErro, 'No such job', { is_error: true })]).unicos.map((j) => j.id), ['id1', 'id2'], 'CronDelete com erro');
  st = lidas([...base, ...unico(T + SEG, 'A', 'x', { noCampo: false, noTexto: false }), ...cancelar(T + 2 * SEG, undefined)]);
  assert.equal(st.unicos.length, 1, 'lembrete sem id nao sai com CronDelete sem id');
  assert.deepEqual(lidas([teclado(T), ...dois.slice(1), teclado(T + 3 * SEG), ...cancelar(T + 4 * SEG, 'id2')]).unicos, [], 'pedido pelo teclado nem entra');
  assert.deepEqual(lidas([...dois, teclado(T + 3 * SEG), ...cancelar(T + 4 * SEG, 'id2')]).unicos.map((j) => j.id), ['id1'], 'o CronDelete pedido pelo teclado tambem tira');
  // o teto: 50 por conversa, os mais novos
  const muitos = [...base];
  for (let i = 0; i < 51; i += 1) muitos.push(...unico(T + (i + 1) * SEG, `L${i}`, `id${i}`));
  st = lidas(muitos);
  assert.equal(st.unicos.length, 50);
  assert.deepEqual([st.unicos[0].id, st.unicos[49].id], ['id1', 'id50'], 'o mais antigo saiu');
  // o teto dos pedidos esperando o resultado: 20, os mais novos
  const esperando = [...base];
  for (let i = 0; i < 21; i += 1) esperando.push(uso(T + (i + 1) * SEG, 'CronDelete', { id: `id${i}` }));
  st = lidas(esperando);
  assert.equal(st.usos.length, 20);
  assert.deepEqual([st.usos[0].apagar, st.usos[19].apagar], ['id1', 'id20'], 'o pedido mais antigo saiu');
});

// ---------- o toque e o final da vez dele ----------

test('T43 3. lerToque + toqueDoFinal: o toque (vez aberta com turnOrigin scheduled) casa com o lembrete pelo id; faltando o id de um lado, pelo texto (espacos juntados, o mais antigo); casou = sai da lista (toca 1 vez); 30 dias sem tocar = sai; a vez seguinte fecha o toque; o final e do toque quando fica entre ele e a vez seguinte', () => {
  const T = T0;
  const P = 'LIGAR  PRO\nJOÃO';
  const base = [recado(T, PEDIDO_TG), ...unico(T + SEG, P, 'c03d7c0a')];
  const F = T + 3 * MIN; // a hora do toque
  // pelo id (o texto nem importa)
  let st = lidas([...base, toque(F, 'outro texto', 'c03d7c0a')]);
  assert.deepEqual(st.toques, [{ ts: F, fim: null }]);
  assert.deepEqual(st.unicos, [], 'tocou: sai da lista');
  // id dos dois lados e diferentes: nao casa, nem com o mesmo texto
  st = lidas([...base, toque(F, P, 'ffffffff')]);
  assert.deepEqual(st.toques, []);
  assert.equal(st.unicos.length, 1, 'o lembrete fica');
  // toque sem id (o Claude Code de antes): pelo texto, espacos juntados
  assert.equal(lidas([...base, toque(F, ' LIGAR PRO JOÃO ')]).toques.length, 1, 'pelo texto');
  assert.equal(lidas([...base, toque(F, [{ type: 'text', text: 'LIGAR PRO JOÃO' }])]).toques.length, 1, 'o texto em blocos');
  assert.deepEqual(lidas([...base, toque(F, 'LIGAR PRO JOAO')]).toques, [], 'outro texto');
  assert.deepEqual(lidas([...base, toque(F, '')]).toques, [], 'toque sem texto');
  // lembrete sem id: pelo texto, mesmo com o toque trazendo id
  const semId = [recado(T, PEDIDO_TG), ...unico(T + SEG, P, 'x', { noCampo: false, noTexto: false })];
  assert.equal(lidas([...semId, toque(F, P, 'c03d7c0a')]).toques.length, 1, 'lembrete sem id, toque com id');
  assert.deepEqual(lidas([...semId, toque(F, 'outro', 'c03d7c0a')]).toques, []);
  // lembrete e toque sem texto nunca casam pelo texto
  const semTexto = uso(T + SEG, 'CronCreate', { cron: CRON, recurring: false });
  assert.deepEqual(lidas([recado(T, PEDIDO_TG), semTexto, res(T + 2 * SEG, semTexto, 'Scheduled.'), toque(F, '')]).toques, []);
  // pelo texto com 2 iguais: o mais antigo; pelo id com 2: o do id
  const iguais = [recado(T, PEDIDO_TG), ...unico(T + SEG, P, 'id1'), ...unico(T + 2 * SEG, P, 'id2')];
  assert.deepEqual(lidas([...iguais, toque(F, P)]).unicos.map((j) => j.id), ['id2'], 'sai o mais antigo');
  assert.deepEqual(lidas([...iguais, toque(F, 'x', 'id2')]).unicos.map((j) => j.id), ['id1'], 'sai o do id');
  // toca 1 vez: o 2o toque do mesmo id nao casa (e fecha o 1o, como qualquer vez)
  assert.deepEqual(lidas([...base, toque(F, 'x', 'c03d7c0a'), toque(F + MIN, 'x', 'c03d7c0a')]).toques, [{ ts: F, fim: F + MIN }]);
  // recorrente, ScheduleWakeup e lembrete pedido pelo teclado: o toque nao casa
  assert.deepEqual(lidas([recado(T, PEDIDO_TG), ...recorrente(T + SEG, P, 'c03d7c0a'), toque(F, P, 'c03d7c0a')]).toques, [], 'recorrente');
  assert.deepEqual(lidas([recado(T, PEDIDO_TG), ...acordar(T + SEG, P), toque(F, P)]).toques, [], 'ScheduleWakeup');
  assert.deepEqual(lidas([teclado(T), ...unico(T + SEG, P, 'c03d7c0a'), toque(F, P, 'c03d7c0a')]).toques, [], 'pedido pelo teclado');
  // toque sem hora legivel ou de ajudante: nao conta e o lembrete fica
  for (const x of [{ ...toque(F, 'x', 'c03d7c0a'), timestamp: 'ontem' }, { ...toque(F, 'x', 'c03d7c0a'), isSidechain: true }, { ...toque(F, 'x', 'c03d7c0a'), isCompactSummary: true }]) {
    st = lidas([...base, x]);
    assert.deepEqual(st.toques, []);
    assert.equal(st.unicos.length, 1);
  }
  // 30 dias (contados do resultado do pedido): no ultimo ms ainda casa; depois, o lembrete sai
  const pedidoEm = T + SEG + 200;
  assert.equal(lidas([...base, toque(pedidoEm + 30 * DIA, 'x', 'c03d7c0a')]).toques.length, 1, '30 dias em ponto');
  st = lidas([...base, toque(pedidoEm + 30 * DIA + 1, 'x', 'c03d7c0a')]);
  assert.deepEqual(st.toques, [], '30 dias e 1 ms');
  assert.deepEqual(st.unicos, [], 'o lembrete velho sai');
  assert.deepEqual(lidas([...base, teclado(pedidoEm + 30 * DIA + 1)]).unicos, [], 'qualquer vez nova tira o velho');
  assert.equal(lidas([...base, teclado(pedidoEm + 30 * DIA)]).unicos.length, 1);
  // a vez seguinte fecha o toque
  for (const x of [teclado(F + MIN), teclado(F + MIN, 'x', 'sdk'), recado(F + MIN, PEDIDO_TG), avisoDeTarefa(F + MIN), deOutraSessao(F + MIN, 'oi'), toque(F + MIN, 'outro')]) {
    assert.deepEqual(lidas([...base, toque(F, 'x', 'c03d7c0a'), x]).toques, [{ ts: F, fim: F + MIN }], x.turnOrigin);
  }
  // nao fecham: resumo de compactacao, fala no meio da vez, ajudante, entrada sem hora legivel, resultado de ferramenta
  for (const x of [resumo(F + MIN), noMeio(F + MIN, 'human', 'x'), { ...teclado(F + MIN), isSidechain: true }, { ...teclado(F + MIN), timestamp: 'ontem' },
    res(F + MIN, uso(F + SEG, 'Bash', { command: 'ls' }), 'ok')]) {
    assert.deepEqual(lidas([...base, toque(F, 'x', 'c03d7c0a'), x]).toques, [{ ts: F, fim: null }]);
  }
  // so a 1a vez seguinte fecha (a hora nao anda pra frente)
  assert.deepEqual(lidas([...base, toque(F, 'x', 'c03d7c0a'), teclado(F + MIN), teclado(F + 2 * MIN)]).toques, [{ ts: F, fim: F + MIN }]);

  // toqueDoFinal: o final (finalTs do parou) e da vez do toque?
  const com = (...depois) => lidas([...base, toque(F, 'x', 'c03d7c0a'), ...depois]);
  st = com();
  assert.deepEqual(toqueDoFinal(st, F + 4 * SEG), { tocou: true, velhos: 0 });
  assert.deepEqual(st.toques, [], 'gasto');
  assert.deepEqual(toqueDoFinal(st, F + 5 * SEG), { tocou: false, velhos: 0 }, 'o parou seguinte nao repete');
  assert.deepEqual(toqueDoFinal(com(), F), { tocou: true, velhos: 0 }, 'final na hora do toque');
  st = com();
  assert.deepEqual(toqueDoFinal(st, F - 1), { tocou: false, velhos: 0 }, 'final de antes do toque (a vez anterior)');
  assert.deepEqual(st.toques, [{ ts: F, fim: null }], 'fica pro proximo parou');
  assert.deepEqual(toqueDoFinal(com(teclado(F + MIN)), F + MIN - 1), { tocou: true, velhos: 0 }, 'a vez seguinte abriu depois do final');
  st = com(teclado(F + MIN));
  assert.deepEqual(toqueDoFinal(st, F + MIN), { tocou: false, velhos: 1 }, 'a vez seguinte ja tinha aberto: o final nao e do toque');
  assert.deepEqual(st.toques, [], 'o toque velho sai');
  for (const fim of [NaN, null, undefined, 'x', Infinity]) {
    st = com();
    assert.deepEqual(toqueDoFinal(st, fim), { tocou: false, velhos: 0 }, `finalTs ${String(fim)}`);
    assert.equal(st.toques.length, 1);
  }
  // 2 toques: um velho e o da vez
  st = lidas([recado(T, PEDIDO_TG), ...unico(T + SEG, 'A', 'id1'), ...unico(T + 2 * SEG, 'B', 'id2'), toque(F, 'A', 'id1'), toque(F + MIN, 'B', 'id2')]);
  assert.deepEqual(toqueDoFinal(st, F + MIN + 4 * SEG), { tocou: true, velhos: 1 });
  assert.deepEqual(st.toques, []);
});

// ---------- harness (do tests/porteiro-t7f.test.mjs; os processos falsos sao do tests/porteiro-t18.test.mjs) ----------

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
    passoGrupo: async () => { await cru.passoGrupo(); await bombear(cru); },
    passoEventos: async () => { await cru.passoEventos(); await bombear(cru); },
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
  tg.de = (metodo) => tg.chamadas.filter((c) => c.metodo === metodo);
  tg.envios = () => tg.de('enviar').map((c) => c.args[0]);
  tg.zerar = () => { tg.chamadas.length = 0; };
  return tg;
}

// `processos: true` (T43 11) = o porteiro com os processos falsos: `h.vivos` (pids vivos pro pidVivo), `h.procs` (pid ->
// o que o processos.info devolve), `h.mortes` (cada matarArvore) e `h.matar` = o que o matarArvore faz: 'ok' (mata e
// devolve true), 'lanca' / 'falso' (o encerrar que da erro) e 'vive' (devolve true e o pid segue vivo); com 'lanca' ou
// 'falso', `h.morreEm` = em qual espera depois do encerrar o pid morre (0 = na hora; null = nunca).
function montar({ processos = false, canalPrincipal } = {}) {
  const raiz = pastaTemp('porteiro-t43-');
  const env = {
    SESSOES_WPP_DIR: path.join(raiz, 'estado'),
    CLAUDE_SESSIONS_DIR: path.join(raiz, 'sessions'),
    CLAUDE_PROJECTS_DIR: path.join(raiz, 'projects'),
    SESSOES_WPP_LOG: path.join(raiz, 'porteiro.log'),
  };
  for (const d of [env.SESSOES_WPP_DIR, env.CLAUDE_SESSIONS_DIR, env.CLAUDE_PROJECTS_DIR]) fs.mkdirSync(d, { recursive: true });
  const h = {
    raiz, env, t: T0, idle: 0, grupo: [], enviados: [], entregas: [], nReg: 0, nMsg: 0, nUpd: 100, nMid: 7000,
    vivos: new Set(), procs: new Map(), mortes: [], matar: 'ok', morreEm: null, esperas: 0,
  };
  let seq = 0;
  h.wpp = {
    async lerGrupo(limit) { return h.grupo.slice(-limit); },
    async enviarGrupo(texto, opts) {
      h.enviados.push({ texto, opts });
      seq += 1;
      return { ok: true, providerMsgId: `P${seq}`, messageId: `U${seq}` };
    },
    async reagir() { return { ok: true }; },
    async editarGrupo() { return { ok: true }; },
  };
  h.mensageiro = {
    async entregar(p) {
      h.entregas.push(p);
      return { status: 'enviado', detalhe: '' };
    },
  };
  h.tg = dubleTg(h);
  h.opcoes = {
    wpp: h.wpp, numeroDono: NUMERO_DONO, mensageiro: h.mensageiro, ocioso: async () => h.idle, agora: () => h.t, env, abrirCentral: () => {},
    rand: randFixo(), central: CENTRAL_TESTE, raizesSessao: RAIZES_TESTE, tg: h.tg, identTg: { chatId: DONO, botId: BOT },
    dormir: async (ms) => {
      h.t += ms;
      if (h.mortes.length) {
        h.esperas += 1;
        if (h.morreEm !== null && h.esperas >= h.morreEm) h.vivos.clear();
      }
    },
  };
  if (canalPrincipal) h.opcoes.canalPrincipal = canalPrincipal;
  if (processos) {
    Object.assign(h.opcoes, {
      ensaio: false,
      pidVivo: (pid) => h.vivos.has(Number(pid)),
      processos: {
        info(pid) { return h.procs.get(pid) ?? null; },
        matarArvore(pid) {
          h.mortes.push(pid);
          if (h.matar === 'ok' || h.morreEm === 0) h.vivos.delete(pid);
          if (h.matar === 'lanca') throw new Error('taskkill saiu com 1');
          return h.matar !== 'falso';
        },
        filhos() { return []; },
      },
    });
  }
  h.cru = criarPorteiro(h.opcoes);
  h.p = comBomba(h.cru);
  h.t += 1000; // as mensagens dos testes nascem depois do cursor inicial
  return h;
}

function sessao(h, { sessionId, name = 'projetos-42' }) {
  h.nReg += 1;
  const reg = { pid: process.pid, sessionId, cwd: 'c:\\projetos', entrypoint: 'claude-vscode', name, nameSource: 'derived', status: 'idle', updatedAt: h.t };
  fs.writeFileSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${100000 + h.nReg}.json`), JSON.stringify(reg));
}
const arqDe = (h, sessionId) => path.join(h.env.CLAUDE_PROJECTS_DIR, 'c--projetos', `${sessionId}.jsonl`);
function transcript(h, sessionId, entradas) {
  fs.mkdirSync(path.dirname(arqDe(h, sessionId)), { recursive: true });
  fs.appendFileSync(arqDe(h, sessionId), entradas.map((x) => `${JSON.stringify(x)}\n`).join(''));
}
function aba(h, sessionId, titulo, name = 'projetos-42') {
  sessao(h, { sessionId, name });
  transcript(h, sessionId, [{ type: 'custom-title', customTitle: titulo, sessionId: 'x' }]);
}
function parou(h, sessionId, o = {}) {
  return {
    v: 1, tipo: 'parou', at: iso(h.t), sessionId, pid: process.pid, nome: 'projetos-42', titulo: null, cwd: 'C:\\projetos',
    entrypoint: 'claude-vscode', final: 'Feito.', finalTs: iso(h.t), marcas: { decisao: false, fica: false, pergunta: false }, ...o,
  };
}
const evento = (h, ev) => lib.anexarEvento(h.env.SESSOES_WPP_DIR, ev);
function msg(h, o = {}) {
  h.nMsg += 1;
  const m = {
    id: `uuid-${h.nMsg}`, provider_msg_id: `PROV${h.nMsg}`, quoted_msg_id: null, sent_by_agent: false, message_type: 'text',
    content: null, transcription: null, direction: 'received', from_me: false, sender_phone: NUMERO_DONO, message_ts: iso(h.t), ...o,
  };
  h.grupo.push(m);
  return m;
}
const estadoArq = (h) => path.join(h.env.SESSOES_WPP_DIR, 'estado.json');
const estado = (h) => JSON.parse(fs.readFileSync(estadoArq(h), 'utf8'));
function mexer(h, fn) {
  const e = estado(h);
  fn(e);
  fs.writeFileSync(estadoArq(h), JSON.stringify(e));
}
const ligarTg = (h) => mexer(h, (e) => { e.tg.offset = 0; });
async function ligarRua(h) {
  h.idle = 30 * MIN;
  await h.p.passoMinuto();
  assert.equal(estado(h).modoRua.ligado, true);
}
const logs = (h) => {
  try { return fs.readFileSync(h.env.SESSOES_WPP_LOG, 'utf8').split('\n').filter(Boolean); } catch { return []; }
};
const comLog = (h, trecho) => logs(h).filter((l) => l.includes(trecho)).length;
function msgTg(h, texto) {
  h.nUpd += 1;
  h.nMid += 1;
  return {
    update_id: h.nUpd,
    message: {
      message_id: h.nMid, date: Math.floor(h.t / 1000), text: texto,
      chat: { id: DONO, type: 'private', first_name: 'Davi' }, from: { id: DONO, is_bot: false, first_name: 'Davi' },
    },
  };
}
const mid = (u) => u.message.message_id;
const chamado = (h, sid) => estado(h).tg.chamados[sid];
// Fala do dono pelo Telegram ate o resultado do mensageiro aplicado
async function falarTg(h, texto) {
  const u = msgTg(h, texto);
  h.tg.lotes.push([u]);
  await h.p.esperarTelegram(15000);
  await bombear(h.cru);
  return u;
}

// ---------- a cena: o dono pede o lembrete pelo Telegram ----------

const S1 = 'S1';
const PROMPT = 'Lembrete do dono: ligar pro João.';
const ID = 'c03d7c0a';
const FALA = 'me lembra em 3 min de ligar pro João';
const VOLTA = 'Lembrete: ligar pro João.';
const LOG_VOLTA = `Telegram: o lembrete pedido pelo Telegram tocou na aba ${S1}; a volta dele vai pro Telegram`;
const linhaTg = (fala) => `> Telegram do Davi (12:00): «${fala}»`;
// A conversa de S1 como o porteiro guarda
const anotado = (h) => estado(h).lembretesTg?.[S1];
// A volta do lembrete virou a versao do chamado dela (antes de ir pra tela)
const voltou = (h) => {
  const v = chamado(h, S1)?.versao;
  return v?.estado === 'resposta' && String(v.final).includes(VOLTA);
};

// Faro viva no VS Code, o Telegram ligado, o dono no PC. O dono pede pelo Telegram ("Faro: ..."); a aba recebe o recado,
// faz `entradas(t)` (o que ela agenda) e responde: a resposta de hoje sai, em cima da fala dele. -> {h, u}
async function cena(entradas = (t) => unico(t, PROMPT, ID), opcoes = {}) {
  const h = montar(opcoes);
  aba(h, S1, 'Faro');
  ligarTg(h);
  const u = await falarTg(h, `Faro: ${FALA}`);
  assert.deepEqual(h.entregas.map((p) => [p.sessionId, p.canal]), [[S1, 'telegram']]);
  const t = h.t;
  transcript(h, S1, [recado(t + SEG, h.entregas[0]), ...entradas(t + 5 * SEG)]);
  h.t = t + 20 * SEG;
  evento(h, parou(h, S1, { final: `${linhaTg(FALA)}\n\nAgendei pra daqui a 3 min.` }));
  await h.p.passoEventos();
  await h.p.esperarTelegram(15000);
  const envios = h.tg.envios();
  assert.equal(envios.length, 1, 'a resposta ao pedido sai como hoje');
  assert.equal(envios[0].responderA, mid(u), 'em cima da fala dele');
  h.tg.zerar();
  return { h, u };
}
// O lembrete toca agora (`x(t)` = a entrada do toque; null = o toque ainda nao chegou no arquivo) e a vez dele termina
// 4 s depois com um final que so informa. -> o parou gravado
function tocar(h, x = (t) => toque(t, PROMPT, ID), o = {}) {
  const t = h.t;
  if (x) transcript(h, S1, [x(t)]);
  h.t = t + 4 * SEG;
  const ev = parou(h, S1, { final: VOLTA, ...o });
  evento(h, ev);
  return ev;
}

// Mac-testes (A): o teste marcado com SO_WINDOWS confere a premissa do Windows (o processo `claude.exe`); fora do win32
// ele pula. O caminho do Mac tem os testes proprios em tests/mac-*.test.mjs.
const SO_WINDOWS = process.platform !== 'win32' && 'premissa do Windows (o Mac tem os tests/mac-*)';

test('T43 4. o lembrete unico pedido pelo Telegram toca: o final da vez dele, que so informa, vai pro Telegram como resposta (mensagem nova, com notificacao, sem citar), com o dono no PC ou na rua; nada no grupo; 1 linha de log; o lembrete sai da lista e a vez seguinte dela segue como hoje', async () => {
  for (const rua of [false, true]) {
    const rot = rua ? 'na rua' : 'no PC';
    const { h } = await cena();
    assert.deepEqual(anotado(h).unicos.map((j) => j.id), [ID], `${rot}: o lembrete pedido pelo Telegram ficou anotado`);
    assert.equal(anotado(h).tg, true, rot);
    assert.equal(anotado(h).bytes, fs.statSync(arqDe(h, S1)).size, `${rot}: leu o transcript ate o fim`);
    if (rua) await ligarRua(h);
    else assert.equal(estado(h).modoRua.ligado, false, 'o dono esta no PC');
    h.tg.zerar();
    h.t += 3 * MIN;
    tocar(h);
    await h.p.passoEventos();
    assert.equal(voltou(h), true, `${rot}: a volta do lembrete vira a resposta do chamado`);
    assert.equal(anotado(h).vistoEm, iso(h.t), `${rot}: o parou lido renova a entrada`);
    assert.equal(chamado(h, S1).versao.citar ?? null, null, `${rot}: sem citar`);
    await h.p.esperarTelegram(15000);
    const envios = h.tg.envios();
    assert.equal(envios.length, 1, `${rot}: 1 mensagem nova`);
    assert.equal(envios[0].silencioso, false, `${rot}: com notificacao`);
    assert.equal(envios[0].responderA ?? null, null, `${rot}: nao sai em cima de mensagem nenhuma`);
    assert.ok(envios[0].html.includes('Faro') && envios[0].html.includes(VOLTA), envios[0].html);
    assert.deepEqual(h.enviados, [], `${rot}: nada no grupo`);
    assert.equal(comLog(h, LOG_VOLTA), 1, rot);
    assert.deepEqual(anotado(h).unicos, [], `${rot}: tocou, sai da lista`);
    assert.deepEqual(anotado(h).toques, [], rot);
    assert.equal(estado(h).parouGuardado[S1].noTelegram, true, `${rot}: esse parou ja foi pro Telegram`);
    // a vez seguinte dela, sem lembrete nenhum: nada novo
    h.tg.zerar();
    h.t += MIN;
    transcript(h, S1, [avisoDeTarefa(h.t)]);
    h.t += 5 * SEG;
    evento(h, parou(h, S1, { final: 'A tarefa de fundo terminou.' }));
    await h.p.passoEventos();
    await h.p.esperarTelegram(15000);
    assert.deepEqual(h.tg.envios(), [], `${rot}: a vez seguinte nao manda nada`);
    assert.equal(comLog(h, LOG_VOLTA), 1, rot);
  }
});

test('T43 5. segue como hoje (nenhuma mensagem nova): lembrete recorrente, CronCreate sem o campo recurring, ScheduleWakeup, lembrete unico pedido pelo teclado (vez do teclado ou fala no meio da vez), lembrete cancelado, toque de outro lembrete e a conversa que nunca recebeu fala do Telegram', async () => {
  const semVolta = async (rot, h, x) => {
    h.tg.zerar();
    h.t += 3 * MIN;
    tocar(h, x);
    await h.p.passoEventos();
    assert.equal(voltou(h), false, rot);
    await h.p.esperarTelegram(15000);
    assert.deepEqual(h.tg.envios(), [], `${rot}: nenhuma mensagem nova`);
    assert.equal(comLog(h, 'a volta dele vai pro Telegram'), 0, rot);
    h.t += 2 * MIN; // nem depois (nenhuma conferencia atrasada manda)
    await h.p.passoEventos();
    await h.p.esperarTelegram(15000);
    assert.deepEqual(h.tg.envios(), [], `${rot}: nem depois`);
  };
  const CASOS = {
    recorrente: [(t) => recorrente(t, PROMPT, ID), (t) => toque(t, PROMPT, ID)],
    'sem o campo recurring': [(t) => recorrente(t, PROMPT, ID, {}), (t) => toque(t, PROMPT, ID)],
    ScheduleWakeup: [(t) => acordar(t, PROMPT), (t) => toque(t, PROMPT)],
    'fala do teclado no meio da vez, antes do pedido': [(t) => [noMeio(t, 'human', [{ type: 'text', text: 'aproveita e agenda' }]), ...unico(t + SEG, PROMPT, ID)], (t) => toque(t, PROMPT, ID)],
    'lembrete cancelado': [(t) => [...unico(t, PROMPT, ID), ...cancelar(t + SEG, ID)], (t) => toque(t, PROMPT, ID)],
    'toque de outro lembrete': [(t) => unico(t, PROMPT, ID), (t) => toque(t, 'outra rotina', 'ffffffff')],
    'toque sem id e com outro texto': [(t) => unico(t, PROMPT, ID), (t) => toque(t, 'outra rotina')],
  };
  for (const [rot, [entradas, x]] of Object.entries(CASOS)) {
    const { h } = await cena(entradas);
    await semVolta(rot, h, x);
  }
  // pedido pelo teclado, numa vez depois da resposta ao Telegram
  let { h } = await cena(() => []);
  h.t += MIN;
  transcript(h, S1, [teclado(h.t, 'me lembra em 3 min'), ...unico(h.t + SEG, PROMPT, ID)]);
  h.t += 10 * SEG;
  evento(h, parou(h, S1, { final: 'Agendei.' }));
  await h.p.passoEventos();
  await h.p.esperarTelegram(15000);
  assert.deepEqual(anotado(h).unicos, [], 'pedido pelo teclado: nao entra na lista');
  await semVolta('pedido pelo teclado', h);
  // a conversa que nunca recebeu fala do Telegram nao e acompanhada (mesmo com um recado no transcript)
  h = montar();
  aba(h, S1, 'Faro');
  ligarTg(h);
  await h.p.passoEventos();
  transcript(h, S1, [recado(h.t, PEDIDO_TG), ...unico(h.t + SEG, PROMPT, ID)]);
  h.t += 10 * SEG;
  evento(h, parou(h, S1, { final: 'Agendei.' }));
  await h.p.passoEventos();
  assert.deepEqual(estado(h).lembretesTg, {}, 'sem entrega do Telegram: sem entrada');
  h.t += 3 * MIN;
  tocar(h);
  await h.p.passoEventos();
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.envios(), [], 'conversa sem fala do Telegram');
  assert.deepEqual(estado(h).lembretesTg, {});
});

test('T43 6. o toque sem scheduledTaskId (Claude Code de antes) casa pelo texto do lembrete; 2 lembretes pedidos pelo Telegram = 2 voltas, cada um 1 vez so', async () => {
  let { h } = await cena();
  h.t += 3 * MIN;
  tocar(h, (t) => toque(t, PROMPT));
  await h.p.passoEventos();
  assert.equal(voltou(h), true, 'toque sem id: pelo texto');
  await h.p.esperarTelegram(15000);
  assert.equal(h.tg.envios().length, 1);
  assert.equal(comLog(h, LOG_VOLTA), 1);

  ({ h } = await cena((t) => [...unico(t, 'Lembrete A', 'id1'), ...unico(t + SEG, 'Lembrete B', 'id2')]));
  assert.deepEqual(anotado(h).unicos.map((j) => j.id), ['id1', 'id2']);
  h.t += 3 * MIN;
  tocar(h, (t) => toque(t, 'Lembrete B', 'id2'));
  await h.p.passoEventos();
  await h.p.esperarTelegram(15000);
  assert.equal(h.tg.envios().length, 1, 'o 2o lembrete tocou primeiro');
  assert.deepEqual(anotado(h).unicos.map((j) => j.id), ['id1']);
  h.t += MIN;
  tocar(h, (t) => toque(t, 'Lembrete A', 'id1'), { final: 'Lembrete A: revisar a proposta.' });
  await h.p.passoEventos();
  await h.p.esperarTelegram(15000);
  assert.equal(h.tg.envios().length, 2, 'o 1o lembrete tambem volta');
  assert.ok(h.tg.envios()[1].html.includes('Lembrete A: revisar a proposta.'), h.tg.envios()[1].html);
  assert.deepEqual(anotado(h).unicos, []);
  h.t += MIN;
  tocar(h, (t) => toque(t, 'Lembrete A', 'id1'), { final: 'De novo?' });
  await h.p.passoEventos();
  await h.p.esperarTelegram(15000);
  assert.equal(h.tg.envios().length, 2, 'o mesmo id de novo: nada (toca 1 vez)');
  assert.equal(comLog(h, LOG_VOLTA), 2);
});

test('T43 7. a trava segura a volta (e o toque fica gasto); a continuacao por hook de Stop nao manda de novo; a vez do toque que responde uma fala do Telegram segue o caminho de hoje (1 mensagem, em cima da fala); a que responde so uma fala do WhatsApp manda a resposta no grupo e a volta no Telegram', async () => {
  // a trava
  let { h } = await cena();
  mexer(h, (e) => { e.trava = true; });
  h.t += 3 * MIN;
  tocar(h);
  await h.p.passoEventos();
  assert.equal(voltou(h), false, 'travado: nada');
  assert.equal(comLog(h, LOG_VOLTA), 0);
  mexer(h, (e) => { e.trava = false; });
  h.t += 2 * MIN;
  await h.p.passoEventos();
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.envios(), [], 'destravado depois: o toque ficou gasto, nada sai');
  assert.deepEqual(anotado(h).toques, []);

  // a continuacao por hook de Stop: o 2o parou da mesma vez
  ({ h } = await cena());
  h.t += 3 * MIN;
  tocar(h);
  await h.p.passoEventos();
  assert.equal(voltou(h), true);
  h.t += 3 * SEG;
  evento(h, parou(h, S1, { final: 'Conferi de novo, tudo certo.', continuacao: true }));
  await h.p.passoEventos();
  await h.p.esperarTelegram(15000);
  assert.equal(h.tg.envios().length, 1, 'a continuacao nao manda de novo');
  assert.ok(h.tg.envios()[0].html.includes(VOLTA));
  assert.equal(comLog(h, LOG_VOLTA), 1);

  // a fala do Telegram entra no meio da vez do toque: a resposta de hoje, em cima da fala, 1 mensagem so
  ({ h } = await cena());
  h.t += 3 * MIN;
  transcript(h, S1, [toque(h.t, PROMPT, ID)]);
  h.t += SEG;
  const u2 = await falarTg(h, 'Faro: e o relatório?');
  assert.equal(h.entregas.length, 2);
  transcript(h, S1, [noMeio(h.t + SEG, 'peer', embrulho(montarRecado(h.entregas[1], DAVI)))]);
  h.t += 10 * SEG;
  evento(h, parou(h, S1, { final: `${linhaTg('e o relatório?')}\n\n${VOLTA} O relatório sai amanhã.` }));
  await h.p.passoEventos();
  await h.p.esperarTelegram(15000);
  let envios = h.tg.envios();
  assert.equal(envios.length, 1, 'a resposta a fala ja leva o final: 1 mensagem so');
  assert.equal(envios[0].responderA, mid(u2), 'em cima da fala dele');
  assert.equal(comLog(h, LOG_VOLTA), 0);
  assert.deepEqual(anotado(h).toques, [], 'o toque fica gasto');
  assert.deepEqual(anotado(h).unicos, []);

  // a fala do WhatsApp entra no meio da vez do toque: a resposta no grupo e a volta no Telegram
  ({ h } = await cena());
  h.t += 3 * MIN;
  transcript(h, S1, [toque(h.t, PROMPT, ID)]);
  h.t += SEG;
  msg(h, { content: 'Faro: e o resto?' });
  await h.p.passoGrupo();
  assert.deepEqual(h.entregas.map((p) => p.canal ?? 'whatsapp'), ['telegram', 'whatsapp']);
  transcript(h, S1, [noMeio(h.t + SEG, 'peer', embrulho(montarRecado(h.entregas[1], DAVI)))]);
  h.t += 10 * SEG;
  const nGrupo = h.enviados.length;
  evento(h, parou(h, S1, { final: `> WhatsApp do Davi (12:03): «e o resto?»\n\n${VOLTA} O resto fica pra amanhã.` }));
  await h.p.passoEventos();
  assert.equal(h.enviados.length, nGrupo + 1, 'a resposta a fala do grupo vai pro grupo');
  assert.equal(voltou(h), true, 'e a volta do lembrete vai pro Telegram');
  await h.p.esperarTelegram(15000);
  envios = h.tg.envios();
  assert.equal(envios.length, 1);
  assert.equal(envios[0].responderA ?? null, null);
  assert.equal(comLog(h, LOG_VOLTA), 1);
});

test('T43 8. transcript atrasado: o parou chega antes do toque estar no arquivo = nada na hora; confere de novo em 5 s, 15 s e 45 s e, achando o toque, a volta sai atrasada (1 linha de log com a tentativa); 3 conferencias sem achar = desiste; parou mais novo ou volta ja enviada = desiste', async () => {
  const LOG_ATRASADA = (n) => `Telegram: o lembrete pedido pelo Telegram tocou na aba ${S1} (transcript atrasado, tentativa ${n}); a volta dele vai pro Telegram`;
  // o toque chega no arquivo logo depois do parou: sai na 1a conferencia, 5 s depois
  let { h } = await cena();
  h.t += 3 * MIN;
  let tq = h.t;
  tocar(h, null);
  await h.p.passoEventos();
  assert.equal(voltou(h), false, 'o toque ainda nao esta no arquivo');
  transcript(h, S1, [toque(tq, PROMPT, ID)]);
  h.t += 5 * SEG - 1;
  await h.p.passoEventos();
  assert.equal(voltou(h), false, '1 ms antes dos 5 s: ainda nao conferiu de novo');
  h.t += 1;
  await h.p.passoEventos();
  assert.equal(voltou(h), true, '5 s: conferiu de novo e achou o toque');
  assert.equal(comLog(h, LOG_ATRASADA(1)), 1);
  assert.equal(estado(h).parouGuardado[S1].noTelegram, true);
  await h.p.esperarTelegram(15000);
  let envios = h.tg.envios();
  assert.equal(envios.length, 1, 'a volta sai atrasada, 1 vez');
  assert.equal(envios[0].silencioso, false);
  assert.ok(envios[0].html.includes(VOLTA), envios[0].html);
  h.t += 2 * MIN;
  await h.p.passoEventos();
  await h.p.esperarTelegram(15000);
  assert.equal(h.tg.envios().length, 1, 'nao repete');
  assert.equal(comLog(h, LOG_VOLTA), 0, 'so a linha da atrasada');

  // o toque so chega 10 s depois: a 1a conferencia (5 s) nao acha, a 2a (15 s depois dela) acha
  ({ h } = await cena());
  h.t += 3 * MIN;
  tq = h.t;
  tocar(h, null);
  await h.p.passoEventos();
  h.t += 5 * SEG;
  await h.p.passoEventos();
  assert.equal(voltou(h), false, '5 s: nada ainda');
  h.t += 5 * SEG;
  transcript(h, S1, [toque(tq, PROMPT, ID)]);
  await h.p.passoEventos();
  assert.equal(voltou(h), false, '10 s: fora de hora de conferir');
  h.t += 10 * SEG - 1;
  await h.p.passoEventos();
  assert.equal(voltou(h), false, '1 ms antes dos 20 s');
  h.t += 1;
  await h.p.passoEventos();
  assert.equal(voltou(h), true, '20 s: a 2a conferencia achou');
  assert.equal(comLog(h, LOG_ATRASADA(2)), 1);

  // a 3a conferencia (45 s depois da 2a) ainda vale; depois dela, desiste
  for (const chegaEm of [64 * SEG, 66 * SEG]) {
    ({ h } = await cena());
    h.t += 3 * MIN;
    tq = h.t;
    tocar(h, null);
    const p0 = h.t;
    await h.p.passoEventos();
    for (const em of [5 * SEG, 20 * SEG]) {
      h.t = p0 + em;
      await h.p.passoEventos();
    }
    for (const em of [chegaEm, 65 * SEG].sort((a, b) => a - b)) {
      h.t = p0 + em;
      if (em === chegaEm) transcript(h, S1, [toque(tq, PROMPT, ID)]);
      await h.p.passoEventos();
    }
    h.t = p0 + 5 * MIN;
    await h.p.passoEventos();
    if (chegaEm < 65 * SEG) {
      assert.equal(voltou(h), true, 'chegou antes da 3a conferencia');
      assert.equal(comLog(h, LOG_ATRASADA(3)), 1);
    } else {
      assert.equal(voltou(h), false, 'chegou depois da 3a conferencia: desistiu');
      assert.equal(comLog(h, 'a volta dele vai pro Telegram'), 0);
      // a vez seguinte acha o toque velho: 1 linha de log, nada no Telegram
      transcript(h, S1, [teclado(h.t)]);
      h.t += 5 * SEG;
      evento(h, parou(h, S1, { final: 'Feito.' }));
      await h.p.passoEventos();
      assert.equal(voltou(h), false);
      assert.equal(comLog(h, `parou ${S1}: 1 toque(s) de lembrete de uma vez que ja tinha acabado; nada no Telegram`), 1);
    }
  }

  // parou mais novo antes da conferencia: desiste (a vez do toque ja nao e a ultima dela)
  ({ h } = await cena());
  h.t += 3 * MIN;
  tq = h.t;
  tocar(h, null);
  await h.p.passoEventos();
  h.t += 2 * SEG;
  transcript(h, S1, [toque(tq, PROMPT, ID), teclado(h.t)]);
  h.t += SEG;
  evento(h, parou(h, S1, { final: 'Outra coisa.' }));
  await h.p.passoEventos();
  h.t += MIN;
  await h.p.passoEventos();
  h.t += 2 * MIN;
  await h.p.passoEventos();
  assert.equal(voltou(h), false, 'parou mais novo: nada');
  assert.equal(comLog(h, 'a volta dele vai pro Telegram'), 0);

  // parou mais novo sem finalTs (o toque chegou e ficou por gastar): a conferencia do parou de antes desiste, nao manda
  // o final do parou novo no lugar
  ({ h } = await cena());
  h.t += 3 * MIN;
  tq = h.t;
  tocar(h, null);
  await h.p.passoEventos();
  h.t += 2 * SEG;
  transcript(h, S1, [toque(tq, PROMPT, ID)]);
  h.t += SEG;
  evento(h, parou(h, S1, { final: 'Outra coisa.', finalTs: null }));
  await h.p.passoEventos();
  assert.deepEqual(anotado(h).toques, [{ ts: tq, fim: null }], 'o toque chegou e ficou por gastar');
  h.t += MIN;
  await h.p.passoEventos();
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.envios(), [], 'parou mais novo sem finalTs: nada');
  assert.equal(comLog(h, 'a volta dele vai pro Telegram'), 0);

  // travado na hora da conferencia: desiste
  ({ h } = await cena());
  h.t += 3 * MIN;
  tq = h.t;
  tocar(h, null);
  await h.p.passoEventos();
  transcript(h, S1, [toque(tq, PROMPT, ID)]);
  mexer(h, (e) => { e.trava = true; });
  h.t += 5 * SEG;
  await h.p.passoEventos();
  mexer(h, (e) => { e.trava = false; });
  h.t += 2 * MIN;
  await h.p.passoEventos();
  assert.equal(voltou(h), false, 'travado na conferencia: desiste');

  // esse parou ja foi pro Telegram por outro caminho (canal principal = Telegram, o padrao do produto; precisava do dono,
  // na rua = aviso): a conferencia nao manda de novo
  const PERGUNTA = { final: `${VOLTA} Ligo eu?`, marcas: { decisao: false, fica: false, pergunta: true } };
  ({ h } = await cena(undefined, { canalPrincipal: 'telegram' }));
  await ligarRua(h);
  h.tg.zerar();
  h.t += 3 * MIN;
  tq = h.t;
  tocar(h, null, PERGUNTA);
  await h.p.passoEventos();
  assert.equal(chamado(h, S1).versao.estado, 'aviso', 'o aviso de hoje');
  assert.equal(estado(h).parouGuardado[S1].noTelegram, true);
  transcript(h, S1, [toque(tq, PROMPT, ID)]);
  h.t += 5 * SEG;
  await h.p.passoEventos();
  await h.p.esperarTelegram(15000);
  assert.equal(h.tg.envios().length, 1, 'so o aviso');
  assert.equal(comLog(h, 'a volta dele vai pro Telegram'), 0);

  // canal principal = WhatsApp: o aviso foi pro grupo (nao pro Telegram); a volta do lembrete ainda chega no Telegram
  ({ h } = await cena());
  await ligarRua(h);
  h.tg.zerar();
  h.t += 3 * MIN;
  tq = h.t;
  const nGrupo = h.enviados.length;
  tocar(h, null, PERGUNTA);
  await h.p.passoEventos();
  assert.equal(h.enviados.length, nGrupo + 1, 'o aviso no grupo');
  assert.equal(voltou(h), false);
  transcript(h, S1, [toque(tq, PROMPT, ID)]);
  h.t += 5 * SEG;
  await h.p.passoEventos();
  assert.equal(voltou(h), true, 'a volta atrasada vai pro Telegram');
  assert.equal(comLog(h, LOG_ATRASADA(1)), 1);
  assert.equal(h.enviados.length, nGrupo + 1, 'nada a mais no grupo');
});

test('T43 9. o que foi lido fica no estado: o porteiro religado entre o pedido e o toque ainda manda a volta; o transcript e lido so nos bytes novos; o arquivo que encolheu zera o que foi lido e e relido do comeco', async () => {
  // religado
  let { h } = await cena();
  h.cru = criarPorteiro(h.opcoes);
  h.p = comBomba(h.cru);
  h.t += 3 * MIN;
  tocar(h);
  await h.p.passoEventos();
  assert.equal(voltou(h), true, 'religado: o lembrete anotado continua valendo');

  // so os bytes novos: o mesmo arquivo, do mesmo tamanho, sem o pedido (se relesse do comeco, perdia o lembrete)
  ({ h } = await cena());
  const arq = arqDe(h, S1);
  const antes = fs.readFileSync(arq, 'utf8');
  fs.writeFileSync(arq, antes.replaceAll('CronCreate', 'CronXreate'));
  assert.equal(fs.statSync(arq).size, Buffer.byteLength(antes));
  await falarTg(h, 'Faro: e aí?'); // outra fala do Telegram entregue: a entrada que ja existe fica como esta
  assert.deepEqual(anotado(h).unicos.map((j) => j.id), [ID]);
  h.t += 3 * MIN;
  tocar(h);
  await h.p.passoEventos();
  assert.equal(voltou(h), true, 'so os bytes novos');
  assert.equal(anotado(h).bytes, fs.statSync(arq).size);

  // encolheu: outro conteudo, menor, so com o toque = zera e rele (o lembrete some, o toque nao casa)
  ({ h } = await cena());
  h.t += 3 * MIN;
  fs.writeFileSync(arqDe(h, S1), `${JSON.stringify(toque(h.t, PROMPT, ID))}\n`);
  h.t += 4 * SEG;
  evento(h, parou(h, S1, { final: VOLTA }));
  await h.p.passoEventos();
  assert.equal(voltou(h), false, 'o arquivo encolheu: o lembrete lido antes nao vale mais');
  assert.deepEqual([anotado(h).tg, anotado(h).unicos, anotado(h).bytes], [false, [], fs.statSync(arqDe(h, S1)).size]);

  // o transcript sumiu (erro de leitura): o que foi lido zera, pra reler do comeco quando ele voltar
  ({ h } = await cena());
  assert.ok(anotado(h).bytes > 0);
  fs.rmSync(arqDe(h, S1));
  h.t += MIN;
  evento(h, parou(h, S1, { final: 'Feito.' }));
  await h.p.passoEventos();
  assert.deepEqual([anotado(h).bytes, anotado(h).tg, anotado(h).unicos], [0, false, []], 'sem o arquivo: zera');

  // a linha quebrada nao derruba a leitura
  h = montar();
  aba(h, S1, 'Faro');
  ligarTg(h);
  await falarTg(h, `Faro: ${FALA}`);
  const t = h.t;
  fs.appendFileSync(arqDe(h, S1), '{"type":"user","turnOrigin":"peer","message":{"content":"Telegram do Davi (12:00, id\n');
  transcript(h, S1, [recado(t + SEG, h.entregas[0]), ...unico(t + 5 * SEG, PROMPT, ID)]);
  h.t = t + 20 * SEG;
  evento(h, parou(h, S1, { final: `${linhaTg(FALA)}\n\nAgendei.` }));
  await h.p.passoEventos();
  assert.deepEqual(anotado(h).unicos.map((j) => j.id), [ID], 'a linha quebrada foi pulada');
});

test('T43 10. o estado: a entrada nasce quando a fala do Telegram e entregue (a do WhatsApp nao cria); a faxina tira a entrada sem parou ha 30 dias, a torta e guarda no maximo 200 (as mais novas); a entrada com campo torto volta vazia e o transcript e relido do comeco', async () => {
  // nasce na entrega do Telegram
  let h = montar();
  aba(h, S1, 'Faro');
  aba(h, 'S2', 'Bento', 'projetos-43');
  ligarTg(h);
  msg(h, { content: 'Bento: roda os testes' });
  await h.p.passoGrupo();
  assert.deepEqual(h.entregas.map((p) => p.sessionId), ['S2']);
  assert.deepEqual(estado(h).lembretesTg, {}, 'fala do WhatsApp: sem entrada');
  const t = h.t;
  await falarTg(h, 'Faro: bom dia');
  const l = estado(h).lembretesTg;
  assert.deepEqual(Object.keys(l), [S1]);
  assert.deepEqual({ ...l[S1], vistoEm: null }, { bytes: 0, tg: false, usos: [], unicos: [], toques: [], vistoEm: null }, 'nasce vazia, nada lido');
  assert.ok(Date.parse(l[S1].vistoEm) >= t, l[S1].vistoEm);

  // o historico de antes de a conversa ser acompanhada (lembrete pedido e tocado antes da 1a entrega): a 1a leitura
  // gasta o toque velho sem log
  {
    const g = montar();
    aba(g, S1, 'Faro');
    ligarTg(g);
    transcript(g, S1, [recado(g.t, PEDIDO_TG), ...unico(g.t + SEG, PROMPT, ID), toque(g.t + MIN, PROMPT, ID), teclado(g.t + 2 * MIN)]);
    g.t += 3 * MIN;
    await falarTg(g, 'Faro: bom dia');
    transcript(g, S1, [recado(g.t + SEG, g.entregas[0])]);
    g.t += 10 * SEG;
    evento(g, parou(g, S1, { final: `${linhaTg('bom dia')}\n\nBom dia.` }));
    await g.p.passoEventos();
    assert.deepEqual([anotado(g).tg, anotado(g).unicos, anotado(g).toques], [true, [], []], 'leu o historico e gastou o toque');
    assert.equal(comLog(g, 'toque(s) de lembrete de uma vez que ja tinha acabado'), 0, 'a 1a leitura nao loga o toque velho');
  }

  // a faxina: 30 dias sem parou sai; a torta sai
  const vazia = (ms) => ({ bytes: 0, tg: false, usos: [], unicos: [], toques: [], vistoEm: iso(ms) });
  mexer(h, (e) => {
    e.lembretesTg = {
      velha: vazia(h.t - 30 * DIA - 1), limite: vazia(h.t - 30 * DIA), nova: vazia(h.t), semHora: { ...vazia(h.t), vistoEm: 'ontem' },
      texto: 'x', nula: null, lista: [], 'chave com espaco': vazia(h.t),
    };
  });
  await h.p.passoMinuto();
  assert.deepEqual(Object.keys(estado(h).lembretesTg).sort(), ['limite', 'nova']);
  // o teto: 200, as vistas por ultimo
  mexer(h, (e) => {
    e.lembretesTg = {};
    for (let i = 0; i < 201; i += 1) e.lembretesTg[`s${i}`] = vazia(h.t - i * MIN);
  });
  await h.p.passoMinuto();
  const chaves = Object.keys(estado(h).lembretesTg);
  assert.equal(chaves.length, 200);
  assert.equal(chaves.includes('s200'), false, 'a mais velha saiu');
  assert.equal(chaves.includes('s199'), true);
  // o campo que nao e objeto volta vazio
  mexer(h, (e) => { e.lembretesTg = 'x'; });
  await h.p.passoMinuto();
  assert.deepEqual(estado(h).lembretesTg, {});

  // a entrada com campo torto e relida do comeco. Controle: a entrada boa, lida ate o fim e sem lembrete, nao manda nada
  const TORTAS = {
    'controle (boa e vazia)': {},
    'bytes negativo': { bytes: -1 },
    'bytes quebrado': { bytes: 1.5 },
    'bytes texto': { bytes: '12' },
    'tg que nao e booleano': { tg: 'sim' },
    'usos que nao e lista': { usos: null },
    'pedido esperando sem id': { usos: [{ prompt: null, em: 1 }] },
    'pedido esperando que nao e objeto': { usos: ['x'] },
    'pedido esperando com marca numero': { usos: [{ id: 'toolu_x', prompt: 5, em: 1 }] },
    'pedido esperando com hora torta': { usos: [{ id: 'toolu_x', prompt: null, em: 'ontem' }] },
    'cancelamento esperando com id numero': { usos: [{ id: 'toolu_x', apagar: 7 }] },
    'unicos que nao e lista': { unicos: {} },
    'lembrete com id numero': { unicos: [{ id: 7, prompt: null, em: 1 }] },
    'lembrete com marca numero': { unicos: [{ id: null, prompt: 5, em: 1 }] },
    'lembrete sem hora': { unicos: [{ id: 'x1', prompt: null, em: 'ontem' }] },
    'toques que nao e lista': { toques: 'y' },
    'toque sem hora': { toques: [{ ts: 'x', fim: null }] },
    'toque com fim torto': { toques: [{ ts: 1, fim: 'x' }] },
  };
  for (const [rot, torto] of Object.entries(TORTAS)) {
    ({ h } = await cena());
    const tam = fs.statSync(arqDe(h, S1)).size;
    mexer(h, (e) => { e.lembretesTg[S1] = { bytes: tam, tg: true, usos: [], unicos: [], toques: [], vistoEm: iso(h.t), ...torto }; });
    h.t += 3 * MIN;
    tocar(h);
    await h.p.passoEventos();
    assert.equal(voltou(h), rot !== 'controle (boa e vazia)', rot);
  }
});

// ---------- o encerrar da escondida que devolve erro ----------

const SE = '5a1f0c2e-1b7d-4c3a-9e2f-0123456789ab'; // a conversa escondida
const ESC = 42001; // pid dela

// A escondida que o porteiro abriu, parada ha 40 min com o dono fora: gravada em e.retomadas, viva, `claude.exe` criado
// na hora do startedAt.
async function escondidaParada(matar, morreEm) {
  const h = montar({ processos: true });
  h.idle = 5 * MIN;
  await h.p.passoMinuto(); // o estado nasce no disco
  const startedAt = h.t - 60 * MIN;
  fs.writeFileSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${ESC}.json`), JSON.stringify({
    pid: ESC, sessionId: SE, cwd: 'C:\\projetos', entrypoint: 'cli', kind: 'interactive', name: 'Projeto Atlas', nameSource: 'user',
    status: 'idle', startedAt, updatedAt: h.t, statusUpdatedAt: h.t - 40 * MIN,
  }));
  h.vivos.add(ESC);
  h.procs.set(ESC, { nome: 'claude.exe', paiPid: 1, criadoEm: startedAt });
  mexer(h, (e) => { e.retomadas = { [SE]: { pid: ESC, desde: iso(h.t - 50 * MIN) } }; });
  h.matar = matar;
  h.morreEm = morreEm;
  return h;
}

test('T43 11. o encerrar da escondida que devolve erro (lanca ou devolve false): quem decide e o pid, conferido por ate ~2 s. A arvore morreu = "fechada" e a entrada sai; o pid segue vivo = "nao fecha (encerrar falhou)" e tenta de novo em 10 min; o encerrar que devolve true com o pid vivo = "pid vivo depois de 2 s"', { skip: SO_WINDOWS }, async () => {
  const FECHADA = `retomada ${SE}: a escondida (pid ${ESC}) fechada: parada ha 40 min`;
  // o encerrar deu erro e a arvore morreu mesmo assim (na hora, na 1a espera, na ultima espera)
  for (const matar of ['lanca', 'falso']) {
    for (const morreEm of [0, 1, 10]) {
      const rot = `${matar}, morre na espera ${morreEm}`;
      const h = await escondidaParada(matar, morreEm);
      const t = h.t;
      await h.p.passoMinuto();
      assert.deepEqual(h.mortes, [ESC], rot);
      assert.equal(comLog(h, FECHADA), 1, rot);
      assert.equal(comLog(h, 'nao fecha'), 0, rot);
      assert.deepEqual(estado(h).retomadas, {}, rot);
      assert.equal(h.t - t, morreEm * 200, `${rot}: parou de esperar quando o pid morreu`);
    }
  }
  // o encerrar deu erro e o pid segue vivo depois das 10 esperas
  for (const matar of ['lanca', 'falso']) {
    const h = await escondidaParada(matar, null);
    const t = h.t;
    await h.p.passoMinuto();
    assert.deepEqual(h.mortes, [ESC], matar);
    assert.equal(comLog(h, `retomada ${SE}: nao fecha (encerrar falhou)`), 1, matar);
    assert.equal(comLog(h, 'fechada'), 0, matar);
    assert.equal(estado(h).retomadas[SE].falhouEm, iso(t), matar);
    assert.equal(h.t - t, 2000, `${matar}: esperou as 10 esperas de 200 ms`);
    // 9 min depois nao tenta; 10 min depois tenta de novo
    h.t = t + 9 * MIN;
    await h.p.passoMinuto();
    assert.deepEqual(h.mortes, [ESC], matar);
    h.matar = 'ok';
    h.t = t + 10 * MIN;
    await h.p.passoMinuto();
    assert.deepEqual(h.mortes, [ESC, ESC], matar);
    assert.deepEqual(estado(h).retomadas, {}, matar);
  }
  // o encerrar devolveu true: morreu = fechada (sem esperar); o pid vivo = o motivo de sempre
  let h = await escondidaParada('ok', null);
  let t = h.t;
  await h.p.passoMinuto();
  assert.equal(comLog(h, FECHADA), 1);
  assert.equal(h.t - t, 0);
  h = await escondidaParada('vive', null);
  t = h.t;
  await h.p.passoMinuto();
  assert.equal(comLog(h, `retomada ${SE}: nao fecha (pid vivo depois de 2 s)`), 1);
  assert.equal(comLog(h, 'encerrar falhou'), 0);
  assert.equal(estado(h).retomadas[SE].falhouEm, iso(t));
});
