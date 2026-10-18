// Testes de porteiro.mjs (D3a): node:test, dubles de wpp/mensageiro/ocioso, relogio falso.
// Por que existe: o porteiro decide sozinho o que vai pro grupo do dono e o que entra nas abas dele; aviso a mais e
// spam, aviso a menos e sessao parada esperando horas, repasse errado e fala do dono na aba errada.
// Isolamento: pastas temporarias via SESSOES_WPP_DIR, CLAUDE_SESSIONS_DIR, CLAUDE_PROJECTS_DIR e SESSOES_WPP_LOG.
// Nada de rede nem ~/.claude real. O pid "vivo" dos registros fixture e process.pid.
// Rodar: node --test "tests/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { criarPorteiro, destravar, pidVivo, criarAvisoTelegram as criarAvisoReal, valorDoReg, AVISO_TIMEOUT_MS } from '../porteiro.mjs';
import * as porteiroMod from '../porteiro.mjs'; // R2 4: abrirCentralReal (no codigo da base nao era exportada)
import { montarAviso, montarResposta, horaBRT } from '../lib/formato.mjs';
import * as formatoMod from '../lib/formato.mjs'; // F4.1: montarConcluido (no codigo da base nao existe)
import { criarWpp } from '../wpp.mjs';
import { NUMERO_DONO, NUMERO_ROBO, DESTINO_WPP } from './lib/dados-whatsapp.mjs';
import { CENTRAL_TESTE, RAIZES_TESTE } from './lib/dados-central.mjs';
import { montarRecado } from '../mensageiro.mjs';

const require = createRequire(import.meta.url);
const lib = require('../hooks/lib/sessoes-wpp.js');
const PORTEIRO = fileURLToPath(new URL('../porteiro.mjs', import.meta.url));

const MIN = 60 * 1000;
const T0 = Date.parse('2026-09-27T19:00:00Z'); // 16:00 em Brasilia
const iso = (ms) => new Date(ms).toISOString();
const CAB = '🎛️ *Controle de sessões*'; // F4g + pedido do dono: 🎛️ (voz do controle), sem (pc)

const tique = () => new Promise((ok) => setImmediate(ok));
// F3.7 (D5d1): passoGrupo/passoEventos so ENFILEIRAM a entrega; quem chama o mensageiro e o passoEntrega (no CLI, a cada
// volta do laco). O harness roda o passoEntrega depois de cada passoGrupo/passoEventos ate a fila esvaziar (`h.p`): o
// duble resolve na hora, entao a ordem dos testes anteriores ao D5d1 e a mesma de quando o mensageiro rodava dentro do
// passo. `h.cru` = o porteiro sem a bomba (os testes F3.7 controlam o passoEntrega na mao).
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

// `avisarTelegram` (F3.11): duble do aviso de saude do canal; sem ele o porteiro fica sem canal de aviso (como antes).
// `respostasEdicao` (F4.1): o que o duble do wpp.editarGrupo devolve, na ordem (acabou = {ok:true}); `h.edicoes` = chamadas.
// A3a: `central` e `raizes` = a central e as 2 pastas como o dono configura (tests/lib/dados-central.mjs); `central: null`
// = o padrao do produto (Central do Tele Control, na pasta do repositorio).
function montar({ ensaio = false, env: envExtra = {}, respostasEnvio = [], respostasEntrega = [], respostasEdicao = [], avisarTelegram, central = CENTRAL_TESTE, raizes = RAIZES_TESTE } = {}) {
  const raiz = pastaTemp('porteiro-');
  const env = {
    SESSOES_WPP_DIR: path.join(raiz, 'estado'),
    CLAUDE_SESSIONS_DIR: path.join(raiz, 'sessions'),
    CLAUDE_PROJECTS_DIR: path.join(raiz, 'projects'),
    SESSOES_WPP_LOG: path.join(raiz, 'porteiro.log'),
    ...envExtra,
  };
  for (const d of [env.SESSOES_WPP_DIR, env.CLAUDE_SESSIONS_DIR, env.CLAUDE_PROJECTS_DIR]) fs.mkdirSync(d, { recursive: true });
  const h = { raiz, env, t: T0, idle: 0, grupo: [], enviados: [], reacoes: [], entregas: [], leituras: 0, nReg: 0, nMsg: 0, aberturas: 0, abrirFalha: null };
  // F3.7: `limites` = o que cada leitura pediu; `segurar` = o duble do mensageiro so devolve quando o teste chamar a
  // funcao guardada em `presas` (o claude -p rodando).
  Object.assign(h, { limites: [], segurar: false, presas: [] });
  // D5c (F3.9/F3.10): duble do abrir-central.vbs; o real NUNCA roda em teste. `abrirFalha` = lanca (erro no spawn).
  h.abrirCentral = () => {
    h.aberturas += 1;
    if (h.abrirFalha) throw new Error(h.abrirFalha);
  };
  const fila = [...respostasEnvio];
  let seq = 0;
  h.wpp = {
    async lerGrupo(limit) {
      h.leituras += 1;
      h.limites.push(limit);
      return h.grupo.slice(-limit);
    },
    async enviarGrupo(texto, opts) {
      h.enviados.push({ texto, opts });
      if (fila.length) return fila.shift();
      seq += 1;
      return { ok: true, providerMsgId: `P${seq}`, messageId: `U${seq}` };
    },
    async reagir(messageId, emoji) {
      h.reacoes.push({ messageId, emoji });
      return { ok: true };
    },
  };
  h.edicoes = [];
  const filaEdicao = [...respostasEdicao];
  h.wpp.editarGrupo = async (messageId, texto) => {
    h.edicoes.push({ messageId, texto });
    return filaEdicao.length ? filaEdicao.shift() : { ok: true };
  };
  const filaEntrega = [...respostasEntrega];
  h.mensageiro = {
    // contrato do mensageiro real (D3b): {status:'enviado'|'nao_achei'|'duplicado'|'erro', detalhe}
    async entregar(p) {
      h.entregas.push(p);
      const r = filaEntrega.length ? filaEntrega.shift() : { status: 'enviado', detalhe: '' };
      if (!h.segurar) return r;
      return new Promise((ok) => { h.presas.push(() => ok(r)); });
    },
  };
  h.central = central;
  h.raizes = raizes;
  const opcoes = { wpp: h.wpp, numeroDono: NUMERO_DONO, mensageiro: h.mensageiro, ocioso: async () => h.idle, agora: () => h.t, env, abrirCentral: h.abrirCentral, central, raizesSessao: raizes };
  if (ensaio !== 'pelo-env') opcoes.ensaio = ensaio; // 'pelo-env' = nao passa o parametro (vale SESSOES_WPP_ENSAIO)
  if (avisarTelegram) {
    h.avisarTelegram = avisarTelegram;
    opcoes.avisarTelegram = avisarTelegram;
  }
  h.cru = criarPorteiro(opcoes);
  h.p = comBomba(h.cru);
  h.t += 1000; // mensagens dos testes nascem depois do cursor inicial
  return h;
}

function sessao(h, { sessionId, name = 'projetos-42', nameSource = 'derived', status = 'idle', pid = process.pid, entrypoint = 'claude-vscode', socket = null }) {
  h.nReg += 1;
  const reg = { pid, sessionId, cwd: 'c:\\projetos', entrypoint, name, nameSource, status, updatedAt: h.t };
  if (socket !== null) reg.messagingSocketPath = socket; // F4i: canal de recado (o Desktop so entra com ele)
  fs.writeFileSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${100000 + h.nReg}.json`), JSON.stringify(reg));
}

function transcript(h, sessionId, entradas, pasta = 'c--projetos') {
  const dir = path.join(h.env.CLAUDE_PROJECTS_DIR, pasta);
  fs.mkdirSync(dir, { recursive: true });
  const arq = path.join(dir, `${sessionId}.jsonl`);
  fs.appendFileSync(arq, entradas.map((x) => `${JSON.stringify(x)}\n`).join(''));
  return arq;
}
const custom = (t) => ({ type: 'custom-title', customTitle: t, sessionId: 'x' });
const aiTitle = (t) => ({ type: 'ai-title', aiTitle: t, sessionId: 'x' });

const SEM = { decisao: false, fica: false, pergunta: false };
const DECISAO = { decisao: true, fica: false, pergunta: false };
function parou(h, sessionId, o = {}) {
  return {
    v: 1, tipo: 'parou', at: iso(h.t), sessionId, pid: process.pid, nome: o.nome ?? 'projetos-42', titulo: o.titulo ?? null,
    cwd: 'C:\\projetos', entrypoint: 'claude-vscode', final: o.final ?? 'Feito.', finalTs: o.finalTs ?? iso(h.t), marcas: o.marcas ?? SEM,
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

const estado = (h, nome = 'estado.json') => JSON.parse(fs.readFileSync(path.join(h.env.SESSOES_WPP_DIR, nome), 'utf8'));
async function ligarRua(h) {
  h.idle = 30 * MIN;
  await h.p.passoMinuto();
  assert.equal(estado(h).modoRua.ligado, true);
}

// ---------------------------------------------------------------------------------------------------------------

test('1. parou com DECISAO + modo rua -> 1 aviso com o texto do montarAviso; avisos[] com os 2 ids; repetido -> 0', async () => {
  const h = montar();
  sessao(h, { sessionId: 'S1' });
  transcript(h, 'S1', [custom('Faro')]);
  await ligarRua(h);
  const ev = parou(h, 'S1', { final: 'Pronto.\n\n---\n🔴 **DECISAO:** publico agora?', marcas: { decisao: true, fica: false, pergunta: true } });
  evento(h, ev);
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 1);
  assert.equal(h.enviados[0].texto, montarAviso({ ...ev, titulo: 'Faro' }));
  assert.equal(h.enviados[0].texto, 'ℹ️ *Faro*\nPronto.\n\n*Publico agora?*', 'F4g: as 2 linhas, sem hora e sem rodape');
  const e = estado(h);
  for (const id of ['P1', 'U1']) {
    assert.equal(e.avisos[id].sessionId, 'S1');
    assert.equal(e.avisos[id].titulo, 'Faro');
    assert.equal(e.avisos[id].nome, 'projetos-42');
  }
  evento(h, ev); // mesmo sessionId + finalTs
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 1);
});

// Pedido do dono: "quanto menos mensagem, melhor"; o grupo so recebe o que pede ele. O resumo de 30 min das abas
// que terminaram sem precisar dele ("Terminaram sem precisar de voce") foi removido.
test('2. modo rua desligado -> 0 envios; nao-precisa + modo rua -> nenhuma mensagem, nem depois de 30 min', async () => {
  const h = montar();
  sessao(h, { sessionId: 'S1' });
  sessao(h, { sessionId: 'S2', name: 'repos-f3' });
  transcript(h, 'S1', [custom('Site')]);
  transcript(h, 'S2', [custom('Brain')]);
  evento(h, parou(h, 'S1', { marcas: DECISAO }));
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 0, 'dono no PC: nada vai pro grupo');

  await ligarRua(h);
  h.t += MIN;
  const a = parou(h, 'S1');
  h.t += MIN;
  const b = parou(h, 'S2', { nome: 'repos-f3' });
  h.t += MIN;
  const c = parou(h, 'S1');
  for (const ev of [a, b, c]) evento(h, ev);
  await h.p.passoMinuto();
  await h.p.passoEventos();
  const inicio = h.t;
  assert.equal(h.enviados.length, 0);

  for (const passou of [30, 31, 90]) {
    h.t = inicio + passou * MIN;
    await h.p.passoMinuto();
    await h.p.passoEventos();
    assert.equal(h.enviados.length, 0, `${passou} min depois: terminou sem precisar do dono = nenhuma mensagem`);
  }
  assert.equal(estado(h).resumoPendente.length, 0, 'nao acumula fila de resumo');
  assert.ok(!h.enviados.some((m) => /Terminaram sem precisar/.test(m.texto)));
});

test('2b. resumo herdado do porteiro antigo (na fila de saida ou pendente no estado) e descartado, nunca sai', async () => {
  const h = montar();
  sessao(h, { sessionId: 'S1' });
  transcript(h, 'S1', [custom('Site')]);
  await ligarRua(h);
  const arq = path.join(h.env.SESSOES_WPP_DIR, 'estado.json');
  const e = estado(h);
  e.saida.push({ tipo: 'resumo', texto: '*Terminaram sem precisar de você*\n- Site (15:50)', falhas: 0, entrouEm: iso(h.t) });
  e.resumoPendente = [{ tipo: 'parou', sessionId: 'S1', nome: 'projetos-42', titulo: 'Site', at: iso(h.t - 40 * MIN), finalTs: iso(h.t - 40 * MIN), marcas: null }];
  e.resumoDesde = iso(h.t - 40 * MIN);
  fs.writeFileSync(arq, JSON.stringify(e));
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 0, 'o resumo herdado nao sai');
  const depois = estado(h);
  assert.equal(depois.saida.length, 0, 'saiu da fila sem enviar');
  assert.equal(depois.resumoPendente.length, 0);
  assert.equal(depois.resumoDesde, null);
});

test('3. outro numero, from_me, sent_by_agent ou antes do cursor -> ignorada', async () => {
  const h = montar();
  msg(h, { content: 'status', sender_phone: '5511900000000' });
  msg(h, { content: 'status', from_me: true });
  msg(h, { content: 'status', sent_by_agent: true });
  msg(h, { content: 'status', from_me: true, sent_by_agent: true });
  msg(h, { content: 'status', message_ts: iso(T0 - MIN) });
  await h.p.passoGrupo();
  assert.equal(h.enviados.length, 0);

  msg(h, { content: 'status' });
  await h.p.passoGrupo();
  assert.equal(h.enviados.length, 1, 'a do dono conta');
  await h.p.passoGrupo();
  assert.equal(h.enviados.length, 1, 'provider_msg_id visto nao conta de novo');
});

test('4. modo rua: "Tô na rua"/"voltei" pelo grupo, ocioso 30 min / 10 s, carencia de 5 min, atualizadoEm a cada minuto', async () => {
  const h = montar();
  h.idle = 5000;
  await h.p.passoMinuto();
  let e = estado(h);
  assert.equal(e.modoRua.ligado, false);
  assert.equal(e.modoRua.atualizadoEm, iso(h.t));

  const rua = msg(h, { message_type: 'ptt', transcription: 'Tô na rua' });
  await h.p.passoGrupo();
  e = estado(h);
  assert.equal(e.modoRua.ligado, true);
  assert.equal(e.modoRua.motivo, 'dono');
  assert.deepEqual(h.reacoes, [{ messageId: rua.id, emoji: '✅' }]);

  h.t += MIN;
  h.idle = 10 * 1000;
  await h.p.passoMinuto();
  e = estado(h);
  assert.equal(e.modoRua.ligado, true, 'motivo dono: idle baixo antes de 5 min nao desliga');
  assert.equal(e.modoRua.atualizadoEm, iso(h.t), 'atualizadoEm renovado');

  const voltei = msg(h, { content: 'voltei' });
  await h.p.passoGrupo();
  e = estado(h);
  assert.equal(e.modoRua.ligado, false);
  assert.deepEqual(h.reacoes[1], { messageId: voltei.id, emoji: '✅' });

  h.t += MIN;
  h.idle = 30 * MIN;
  await h.p.passoMinuto();
  e = estado(h);
  assert.equal(e.modoRua.ligado, true);
  assert.equal(e.modoRua.motivo, 'ocioso');
  assert.equal(e.modoRua.atualizadoEm, iso(h.t));

  h.t += MIN;
  h.idle = 10 * 1000;
  await h.p.passoMinuto();
  assert.equal(estado(h).modoRua.ligado, false, 'ocioso desliga com idle < 60 s');

  msg(h, { content: 'to na rua' });
  await h.p.passoGrupo();
  assert.equal(estado(h).modoRua.motivo, 'dono');
  h.t += 6 * MIN;
  await h.p.passoMinuto();
  assert.equal(estado(h).modoRua.ligado, false, 'motivo dono desliga com idle < 60 s passados 5 min');

  h.idle = null; // ocioso falhou: nao muda nada, mas o minuto ainda e gravado
  h.t += MIN;
  await h.p.passoMinuto();
  e = estado(h);
  assert.equal(e.modoRua.ligado, false);
  assert.equal(e.modoRua.atualizadoEm, iso(h.t));
});

test('5. citacao de aviso -> mensageiro.entregar com sessionId, nome do registro, titulo, hora BRT, texto e ids', async () => {
  const h = montar();
  sessao(h, { sessionId: 'S1', name: 'projetos-42' });
  transcript(h, 'S1', [custom('Faro')]);
  await ligarRua(h);
  evento(h, parou(h, 'S1', { marcas: DECISAO }));
  await h.p.passoEventos();
  h.t += 2 * MIN;
  const m = msg(h, { content: 'pode publicar', quoted_msg_id: 'P1' });
  await h.p.passoGrupo();
  assert.deepEqual(h.entregas, [{
    sessionId: 'S1', nome: 'projetos-42', titulo: 'Faro', texto: 'pode publicar', audio: false, hora: '16:02',
    providerMsgId: m.provider_msg_id, messageId: m.id, anexos: [],
  }]);
  assert.equal(horaBRT(m.message_ts), '16:02');

  const n = msg(h, { content: 'Faro: roda os testes' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 2);
  assert.equal(h.entregas[1].sessionId, 'S1');
  assert.equal(h.entregas[1].texto, 'roda os testes');
  assert.equal(h.entregas[1].messageId, n.id);
});

test('6. sem central viva -> frase padrao; ambiguo -> frase com os titulos; central por titulo e por config.json', async () => {
  const h = montar();
  sessao(h, { sessionId: 'S1' });
  sessao(h, { sessionId: 'S2', name: 'repos-cf' });
  transcript(h, 'S1', [custom('Site Novo')]);
  transcript(h, 'S2', [custom('Site Velho')]);
  msg(h, { content: 'bom dia' });
  await h.p.passoGrupo();
  assert.equal(h.enviados[0].texto,
    `${CAB}\nNão sei pra qual sessão é. Responde citando o aviso dela, ou começa com o nome da sessão e dois pontos. "status" lista as sessões.`);

  msg(h, { content: 'site: publica' });
  await h.p.passoGrupo();
  assert.equal(h.enviados[1].texto,
    `${CAB}\nTem mais de uma sessão com esse nome: Site Novo, Site Velho. Manda de novo com o nome completo.`);
  assert.equal(h.entregas.length, 0);

  sessao(h, { sessionId: 'S3', name: 'repos-99' });
  transcript(h, 'S3', [custom('Central de sessões de teste')]);
  msg(h, { content: 'bom dia de novo' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 1);
  assert.equal(h.entregas[0].sessionId, 'S3');
  assert.equal(h.entregas[0].nome, 'repos-99');
  assert.equal(h.entregas[0].texto, 'bom dia de novo');

  fs.writeFileSync(path.join(h.env.SESSOES_WPP_DIR, 'config.json'), JSON.stringify({ centralSessionId: 'S1' }));
  msg(h, { content: 'e agora' });
  await h.p.passoGrupo();
  assert.equal(h.entregas[1].sessionId, 'S1', 'config.centralSessionId vence o titulo');
});

test('7. trava -> sem aviso nem repasse, so a frase (1 por 10 min); destravar pelo PC volta', async () => {
  const h = montar();
  sessao(h, { sessionId: 'S1' });
  transcript(h, 'S1', [custom('Faro')]);
  await ligarRua(h);
  evento(h, parou(h, 'S1', { marcas: DECISAO }));
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 1);

  const TRAVADO = `${CAB}\nTravado. Não repasso nada nem mando aviso até você destravar no PC.`;
  const tr = msg(h, { content: 'trava' });
  await h.p.passoGrupo();
  assert.deepEqual(h.reacoes, [{ messageId: tr.id, emoji: '✅' }]);
  assert.equal(h.enviados[1].texto, TRAVADO);
  assert.equal(estado(h).trava, true);

  h.t += MIN;
  await h.p.passoMinuto();
  evento(h, parou(h, 'S1', { marcas: DECISAO }));
  await h.p.passoEventos();
  msg(h, { content: 'pode', quoted_msg_id: 'P1' });
  await h.p.passoGrupo();
  assert.equal(h.enviados.length, 2, 'nem aviso nem frase repetida antes de 10 min');
  assert.equal(h.entregas.length, 0);

  h.t += 11 * MIN;
  await h.p.passoMinuto();
  msg(h, { content: 'status' });
  await h.p.passoGrupo();
  assert.equal(h.enviados.length, 3);
  assert.equal(h.enviados[2].texto, TRAVADO, 'qualquer mensagem recebe so a frase');

  assert.equal(destravar({ env: h.env }).ok, true);
  h.t += MIN;
  await h.p.passoMinuto();
  msg(h, { content: 'agora vai', quoted_msg_id: 'P1' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 1);
  assert.equal(h.entregas[0].sessionId, 'S1');
  evento(h, parou(h, 'S1', { marcas: DECISAO }));
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 4, 'aviso volta depois de destravar');
  assert.equal(estado(h).trava, false);
});

test('8. ensaio -> 0 chamadas em enviarGrupo/reagir/entregar; ensaio.jsonl com as acoes; estado.json nao criado', async () => {
  const h = montar({ ensaio: true });
  sessao(h, { sessionId: 'S1' });
  transcript(h, 'S1', [custom('Faro')]);
  h.idle = 30 * MIN;
  await h.p.passoMinuto();
  evento(h, parou(h, 'S1', { marcas: DECISAO }));
  await h.p.passoEventos();
  const e = estado(h, 'estado-ensaio.json');
  const idAviso = Object.keys(e.avisos).find((k) => k.endsWith('-p'));
  assert.ok(idAviso, 'aviso de ensaio grava ids ficticios');
  h.t += MIN;
  msg(h, { content: 'status' });
  msg(h, { content: 'pode', quoted_msg_id: idAviso });
  msg(h, { content: 'voltei' });
  await h.p.passoGrupo();

  assert.equal(h.enviados.length, 0);
  assert.equal(h.reacoes.length, 0);
  assert.equal(h.entregas.length, 0);
  assert.ok(h.leituras > 0, 'le o grupo de verdade');
  const acoes = fs.readFileSync(path.join(h.env.SESSOES_WPP_DIR, 'ensaio.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(acoes.map((a) => a.acao), ['enviarGrupo', 'enviarGrupo', 'entregar', 'reagir']);
  assert.ok(acoes.every((a) => typeof a.at === 'string'));
  assert.match(acoes[0].texto, /^ℹ️ \*Faro\*/);
  assert.equal(acoes[2].sessionId, 'S1');
  assert.equal(acoes[2].texto, 'pode');
  assert.equal(fs.existsSync(path.join(h.env.SESSOES_WPP_DIR, 'estado.json')), false);
  assert.equal(estado(h, 'estado-ensaio.json').modoRua.ligado, false, '"voltei" mexe so no estado de ensaio');
});

test('8b. ensaio tambem liga por env SESSOES_WPP_ENSAIO=1', async () => {
  const h = montar({ ensaio: 'pelo-env', env: { SESSOES_WPP_ENSAIO: '1' } });
  msg(h, { content: 'status' });
  await h.p.passoGrupo();
  assert.equal(h.enviados.length, 0);
  assert.equal(fs.existsSync(path.join(h.env.SESSOES_WPP_DIR, 'estado.json')), false);
  assert.ok(fs.existsSync(path.join(h.env.SESSOES_WPP_DIR, 'ensaio.jsonl')));
});

test('9. voice_gate no aviso -> aviso curto no lugar, avisos[] com os ids dele, log sem o texto', async () => {
  const h = montar({
    respostasEnvio: [
      { ok: false, bloqueio: 'voice_gate', violacoes: [{ id: 'travessao', trecho: 'segredo do texto' }] },
      { ok: true, providerMsgId: 'P9', messageId: 'U9' },
    ],
  });
  sessao(h, { sessionId: 'S1' });
  transcript(h, 'S1', [custom('Faro')]);
  await ligarRua(h);
  evento(h, parou(h, 'S1', { final: 'texto que o filtro barrou. DECISAO: sim?', marcas: DECISAO }));
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 2);
  assert.equal(h.enviados[1].texto, 'ℹ️ *Faro*\nO texto dela não passou no filtro do WhatsApp; está na aba do PC.');
  const e = estado(h);
  assert.equal(e.avisos.P9.sessionId, 'S1');
  assert.equal(e.avisos.U9.sessionId, 'S1');
  const log = fs.readFileSync(h.env.SESSOES_WPP_LOG, 'utf8');
  assert.match(log, /travessao/);
  assert.doesNotMatch(log, /filtro barrou|segredo do texto/);
});

test('10. imagem sem legenda + audio 1 min depois -> 1 entregar com o anexo e o texto da transcricao', async () => {
  const h = montar();
  sessao(h, { sessionId: 'C1', name: 'projetos-42' });
  transcript(h, 'C1', [custom('Central de sessões de teste')]);
  const img = msg(h, { message_type: 'image', content: null });
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 0, 'midia sem texto espera o que vem depois');
  h.t += MIN;
  const aud = msg(h, { message_type: 'ptt', content: 'anexo essa foto', transcription: 'anexo essa foto' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 1);
  assert.deepEqual(h.entregas[0], {
    sessionId: 'C1', nome: 'projetos-42', titulo: 'Central de sessões de teste', texto: 'anexo essa foto', audio: true,
    hora: horaBRT(aud.message_ts), providerMsgId: aud.provider_msg_id, messageId: aud.id, anexos: [{ messageId: img.id, tipo: 'image' }],
  });
  h.t += 5 * MIN;
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 1, 'anexo ja entregue nao vence de novo');
});

test('10b. midia sozinha vai pra central em 3 min; imagem com legenda leva ela mesma como anexo', async () => {
  const h = montar();
  sessao(h, { sessionId: 'C1' });
  transcript(h, 'C1', [custom('Central de sessões de teste')]);
  const doc = msg(h, { message_type: 'document', content: '' });
  await h.p.passoGrupo();
  h.t += 2 * MIN;
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 0);
  h.t += MIN;
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 1);
  assert.equal(h.entregas[0].sessionId, 'C1');
  assert.equal(h.entregas[0].texto, '(mandou document sem texto)');
  assert.deepEqual(h.entregas[0].anexos, [{ messageId: doc.id, tipo: 'document' }]);

  const foto = msg(h, { message_type: 'image', content: 'olha esse print' });
  await h.p.passoGrupo();
  assert.equal(h.entregas[1].texto, 'olha esse print');
  assert.deepEqual(h.entregas[1].anexos, [{ messageId: foto.id, tipo: 'image' }]);
});

test('10c. audio com transcricao vazia: espera 3 ciclos; chegou a transcricao -> entrega; nunca chegou -> frase', async () => {
  const h = montar();
  sessao(h, { sessionId: 'C1' });
  transcript(h, 'C1', [custom('Central de sessões de teste')]);
  const a1 = msg(h, { message_type: 'ptt', transcription: '' });
  await h.p.passoGrupo();
  a1.transcription = 'transcreveu no segundo ciclo';
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 1);
  assert.equal(h.entregas[0].texto, 'transcreveu no segundo ciclo');
  assert.equal(h.entregas[0].audio, true);

  h.t += MIN;
  msg(h, { message_type: 'ptt', transcription: null });
  for (let i = 0; i < 3; i++) await h.p.passoGrupo();
  assert.equal(h.enviados.length, 0, 'ainda tentando');
  await h.p.passoGrupo();
  assert.equal(h.enviados.length, 1);
  assert.equal(h.enviados[0].texto, `${CAB}\nNão consegui transcrever o seu áudio das 16:01. Manda de novo ou em texto.`);
  await h.p.passoGrupo();
  assert.equal(h.enviados.length, 1, 'marcado como visto');
  assert.equal(h.entregas.length, 1);
});

test('11. titulo: custom-title no inicio de transcript de ~5 MB, leitura incremental; ai-title no aviso sem custom-title', async () => {
  const h = montar();
  sessao(h, { sessionId: 'S1', name: 'projetos-42' });
  const arq = transcript(h, 'S1', [custom('Faro')]);
  const conversa = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(1000) } })}\n`;
  fs.appendFileSync(arq, conversa.repeat(5000));
  assert.ok(fs.statSync(arq).size > 5 * 1000 * 1000);
  const status = (titulo) => `${CAB}\n- ${titulo} (parada)\nModo rua: desligado`;

  msg(h, { content: 'status' });
  await h.p.passoGrupo();
  assert.equal(h.enviados[0].texto, status('Faro'));

  // Prova de que so o novo e lido: troca o custom-title JA LIDO (mesmo tamanho; so uma releitura inteira veria)
  // e anexa um ai-title novo (perde pro custom-title em cache).
  const fd = fs.openSync(arq, 'r+');
  const pos = fs.readFileSync(arq).indexOf('Faro');
  fs.writeSync(fd, Buffer.from('Trocado'), 0, 7, pos);
  fs.closeSync(fd);
  transcript(h, 'S1', [aiTitle('Titulo automatico')]);
  msg(h, { content: 'status' });
  await h.p.passoGrupo();
  assert.equal(h.enviados[1].texto, status('Faro'));

  // linha cortada no fim fica pro proximo passo; quando completa, vale
  const nova = JSON.stringify(custom('Nome Novo'));
  fs.appendFileSync(arq, nova.slice(0, 20));
  msg(h, { content: 'status' });
  await h.p.passoGrupo();
  assert.equal(h.enviados[2].texto, status('Faro'));
  fs.appendFileSync(arq, `${nova.slice(20)}\n`);
  msg(h, { content: 'status' });
  await h.p.passoGrupo();
  assert.equal(h.enviados[3].texto, status('Nome Novo'));

  // sessao sem custom-title: o aviso usa o ai-title (ultimo)
  sessao(h, { sessionId: 'S2', name: 'repos-cf' });
  transcript(h, 'S2', [aiTitle('Titulo velho'), { type: 'user', message: { content: 'oi' } }, aiTitle('Arrumar o porteiro')], 'c--outro');
  h.t += 61 * 1000; // D3b: 4 "status" ja sairam neste minuto (teto 4 por 60 s); o aviso sai na janela seguinte
  await ligarRua(h);
  evento(h, parou(h, 'S2', { nome: 'repos-cf', titulo: null, marcas: DECISAO }));
  await h.p.passoEventos();
  assert.match(h.enviados[4].texto, /^ℹ️ \*Arrumar o porteiro\*\n/);
});

test('status: trabalhando / esperando você desde HH:MM / parada; so sessao interativa com pid vivo (sdk-cli fora); .key nunca lido', async () => {
  const h = montar();
  const morto = spawnSync(process.execPath, ['-e', '']).pid;
  assert.equal(pidVivo(process.pid), true);
  assert.equal(pidVivo(morto), false);
  // EPERM = o processo EXISTE (sem permissao de sinal): no Windows o pid 4 (System) sempre responde EPERM.
  if (process.platform === 'win32') assert.equal(pidVivo(4), true);
  assert.equal(pidVivo(0), false, 'pid 0 nunca (seria o grupo do proprio processo)');
  sessao(h, { sessionId: 'A', status: 'busy' });
  sessao(h, { sessionId: 'B', status: 'idle' });
  sessao(h, { sessionId: 'C', status: 'idle' });
  sessao(h, { sessionId: 'D', entrypoint: 'sdk-cli' });
  sessao(h, { sessionId: 'E', pid: morto });
  const falso = { pid: process.pid, sessionId: 'K', entrypoint: 'claude-vscode', name: 'segredo', status: 'busy' };
  fs.writeFileSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${process.pid}.abc123.key`), JSON.stringify(falso));
  transcript(h, 'A', [custom('Alfa')]);
  transcript(h, 'B', [custom('Beta')]);
  transcript(h, 'C', [custom('Gama')]);
  evento(h, parou(h, 'B', { marcas: DECISAO }));
  evento(h, parou(h, 'C'));
  await h.p.passoEventos(); // modo rua desligado: nao avisa, mas guarda o ultimo parou
  await ligarRua(h);
  h.t += MIN;
  msg(h, { content: 'Status.' });
  await h.p.passoGrupo();
  assert.equal(h.enviados.length, 1);
  assert.equal(h.enviados[0].texto,
    `${CAB}\n- Alfa (trabalhando)\n- Beta (esperando você desde 16:00)\n- Gama (parada)\nModo rua: ligado`);
});

test('eventos: linha ruim pula, pergunta-barrada so loga, arquivo menor que o offset recomeca do 0', async () => {
  const h = montar();
  sessao(h, { sessionId: 'S1' });
  transcript(h, 'S1', [custom('Faro')]);
  await ligarRua(h);
  const arq = path.join(h.env.SESSOES_WPP_DIR, 'eventos.jsonl');
  fs.appendFileSync(arq, 'isto nao e json\n');
  evento(h, { v: 1, tipo: 'pergunta-barrada', at: iso(h.t), sessionId: 'S1', perguntas: [{ pergunta: 'x?', opcoes: ['A', 'B'] }] });
  evento(h, parou(h, 'S1', { marcas: DECISAO }));
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 1);

  fs.writeFileSync(arq, ''); // rotacionado
  h.t += MIN;
  await h.p.passoMinuto();
  evento(h, parou(h, 'S1', { marcas: DECISAO }));
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 2, 'arquivo menor: recomeca do 0 e pega o evento novo');
  assert.match(fs.readFileSync(h.env.SESSOES_WPP_LOG, 'utf8'), /pergunta-barrada S1/);
});

test('eventos anteriores a 1a subida nao viram aviso (nunca processa historico)', async () => {
  const raiz = pastaTemp('porteiro-hist-');
  const dir = path.join(raiz, 'estado');
  lib.anexarEvento(dir, parou({ t: T0 }, 'S1', { marcas: DECISAO }));
  const env = { SESSOES_WPP_DIR: dir, CLAUDE_SESSIONS_DIR: path.join(raiz, 's'), CLAUDE_PROJECTS_DIR: path.join(raiz, 'p'), SESSOES_WPP_LOG: path.join(raiz, 'l.log') };
  const enviados = [];
  let t = T0;
  const p = criarPorteiro({
    wpp: { lerGrupo: async () => [], enviarGrupo: async (x) => (enviados.push(x), { ok: true, providerMsgId: 'a', messageId: 'b' }), reagir: async () => ({ ok: true }) },
    numeroDono: NUMERO_DONO,
    mensageiro: { entregar: async () => ({ ok: true }) },
    ocioso: async () => 30 * MIN,
    agora: () => t,
    env,
  });
  await p.passoMinuto();
  t += 1000;
  await p.passoEventos();
  assert.equal(enviados.length, 0);
});

test('CLI: "estado" roda sem erro numa pasta vazia e depois de o porteiro subir', () => {
  const raiz = pastaTemp('porteiro-cli-');
  const env = { ...process.env, SESSOES_WPP_DIR: path.join(raiz, 'estado'), SESSOES_WPP_LOG: path.join(raiz, 'l.log') };
  let r = spawnSync(process.execPath, [PORTEIRO, 'estado'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).estado, null);

  criarPorteiro({ wpp: {}, mensageiro: {}, ocioso: async () => null, env });
  r = spawnSync(process.execPath, [PORTEIRO, 'estado'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.equal(typeof s.estado.cursor, 'string');
  assert.equal(s.porteiro, null);
  assert.equal(s.modoRuaEfetivo, false);

  r = spawnSync(process.execPath, [PORTEIRO, 'destravar'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /destravado/);
});

// Adicionados na integracao (principal, 27/09): sabotagens "modo rua velho vale" e "liga com 1 min" passavam verdes.
test('4b. modo rua ligado mas VELHO (porteiro sem passoMinuto ha 6 min) -> parou com DECISAO nao vira aviso', async () => {
  const h = montar();
  sessao(h, { sessionId: 'S1' });
  await ligarRua(h);
  h.t += 6 * MIN; // nenhum passoMinuto: atualizadoEm envelhece
  evento(h, parou(h, 'S1', { final: 'DECISAO: sim?', marcas: DECISAO }));
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 0);
});

// Pedido do dono: "pode ser 30 minutos sem interação" (era 15).
test('4c. ocioso abaixo de 30 min (5, 15, 29 min) nao liga o modo rua; 30 min liga', async () => {
  const h = montar();
  for (const idle of [5 * MIN, 15 * MIN, 29 * MIN]) {
    h.idle = idle;
    await h.p.passoMinuto();
    assert.equal(estado(h).modoRua.ligado, false, `idle ${idle / MIN} min`);
  }
  h.idle = 30 * MIN;
  await h.p.passoMinuto();
  assert.equal(estado(h).modoRua.ligado, true);
  assert.equal(estado(h).modoRua.motivo, 'ocioso');
});

// Pedido do dono: "posso so mandar um audio falando o, to na rua ai se precisar de alguma coisa me avisa, e ai ja vai
// ligar". So o aviso = liga + ✅, nada vai pra central (nao gera resposta); com pedido junto = liga E o pedido segue.
test('4d. "tô na rua" livre: audio so com o aviso liga o modo rua (dono) + ✅, nada entregue; com pedido junto liga e entrega na central', async () => {
  const h = montar();
  sessao(h, { sessionId: 'C1', name: 'projetos-42' });
  transcript(h, 'C1', [custom('Central de sessões de teste')]);
  h.idle = 5000;
  await h.p.passoMinuto();
  assert.equal(estado(h).modoRua.ligado, false);

  const aud = msg(h, { message_type: 'ptt', content: null, transcription: 'Ó, tô na rua, aí se precisar de alguma coisa, me avisa.' });
  await h.p.passoGrupo();
  let e = estado(h);
  assert.equal(e.modoRua.ligado, true);
  assert.equal(e.modoRua.motivo, 'dono');
  assert.deepEqual(h.reacoes, [{ messageId: aud.id, emoji: '✅' }]);
  assert.equal(h.entregas.length, 0, 'so o aviso de rua nao vai pra central');
  assert.equal(h.enviados.length, 0, 'e nao gera mensagem no grupo');

  // volta pro PC: desliga pelo uso passados 5 min
  h.t += 6 * MIN;
  h.idle = 10 * 1000;
  await h.p.passoMinuto();
  assert.equal(estado(h).modoRua.ligado, false);

  const ped = msg(h, { content: 'tô na rua, me manda o resumo do deal da PSP' });
  await h.p.passoGrupo();
  e = estado(h);
  assert.equal(e.modoRua.ligado, true, 'pedido com "tô na rua" tambem liga');
  assert.equal(e.modoRua.motivo, 'dono');
  assert.equal(h.entregas.length, 1, 'o pedido nao e engolido');
  assert.equal(h.entregas[0].sessionId, 'C1');
  assert.equal(h.entregas[0].texto, 'tô na rua, me manda o resumo do deal da PSP');
  assert.equal(h.entregas[0].messageId, ped.id);

  // mensagem comum nao mexe no modo rua
  h.t += 6 * MIN;
  await h.p.passoMinuto();
  assert.equal(estado(h).modoRua.ligado, false);
  msg(h, { content: 'me manda o resumo do deal da PSP' });
  await h.p.passoGrupo();
  assert.equal(estado(h).modoRua.ligado, false);
});

// ---------------------------------------------------------------------------------------------------------------
// D3b: retorno do mensageiro, conferencia da fala na aba, resposta volta pro grupo, fila de saida.

// Textos fixos do brief D3b (escritos aqui por extenso de proposito: o teste prende o texto).
const F = {
  naoAchei: (t) => `${CAB}\nNão achei a sessão ${t} aberta no PC. "status" lista as que estão abertas.`,
  duplicado: (n) => `${CAB}\nTem duas abas com o nome interno ${n}. Dá um nome pra uma delas no PC (Rename) e manda de novo.`,
  naoEntregue: (hora, t) =>
    `${CAB}\nNão consegui entregar a sua mensagem das ${hora} pra ${t}. Tento de novo quando você mandar outra, ou abre a aba no PC.`,
  naoMostrou: (t, hora) =>
    `${CAB}\nA sessão ${t} recebeu a sua mensagem das ${hora}, mas não mostrou na tela. Confere a aba quando chegar no PC.`,
  naFila: (t, hora) =>
    `${CAB}\nA sessão ${t} ainda não pegou a sua mensagem das ${hora} (deve estar com uma pergunta aberta na tela). Fica na fila dela.`,
};

// Recado como chega no transcript de destino (medido 27/09): user + isMeta + origin.kind "peer" + timestamp ISO (F3.5:
// e por ele que o porteiro sabe se o recado entrou antes da fala final do turno). `ts` omitido = linha sem timestamp.
function peer(pedido, blocos = false, ts = undefined) {
  const texto = `Another Claude session sent a message (from repos-99):\n<cross-session-message from="repos-99">\n${montarRecado(pedido)}\n</cross-session-message>`;
  return {
    type: 'user', isMeta: true, origin: { kind: 'peer', from: 'repos-99' }, ...(ts === undefined ? {} : { timestamp: ts }),
    message: { role: 'user', content: blocos ? [{ type: 'text', text: texto }] : texto },
  };
}
const falaDaAba = (texto, ts = undefined) => ({
  type: 'assistant', ...(ts === undefined ? {} : { timestamp: ts }), message: { role: 'assistant', content: [{ type: 'text', text: texto }] },
});
const ferramentaDaAba = () => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } });
const linha = (hora, fala) => `> WhatsApp do Davi (${hora}): «${fala}»`;

function abaFaro(h, extra = []) {
  sessao(h, { sessionId: 'S1', name: 'projetos-42' });
  transcript(h, 'S1', [custom('Faro'), ...extra]);
}

test('D3b 1. enviado -> reage ✅ e grava entregas; peer + resposta COM a linha -> conferido, 0 mensagens', async () => {
  const h = montar();
  abaFaro(h, [falaDaAba('resposta antiga, de antes do recado')]);
  const m = msg(h, { content: 'Faro: roda os testes' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 1);
  const pedido = h.entregas[0];
  assert.deepEqual(h.reacoes, [{ messageId: m.id, emoji: '✅' }]);
  assert.deepEqual(estado(h).entregas, {
    [m.provider_msg_id]: {
      sessionId: 'S1', titulo: 'Faro', hora: '16:00', at: iso(h.t), pedido, tentativas: 1, conferido: false, avisadoFila: false,
    },
  });

  h.t += MIN;
  await h.p.passoEventos();
  assert.equal(estado(h).entregas[m.provider_msg_id].conferido, false, 'sem peer ainda: espera');

  transcript(h, 'S1', [peer(pedido), ferramentaDaAba(), falaDaAba(`${linha('16:00', 'roda os testes')}\nRodando.`)]);
  await h.p.passoEventos();
  assert.equal(estado(h).entregas[m.provider_msg_id].conferido, true);
  assert.equal(h.enviados.length, 0);
  assert.equal(h.entregas.length, 1, 'nada reentregue');
});

// F3.6 (27/09): a reentrega e o mesmo pedido com `reforco: true` (o mensageiro monta o recado curto, sem a ordem).
test('D3b 2. resposta SEM a linha -> 1 reentrega com reforco (sem repetir a ordem); de novo sem -> "não mostrou na tela" 1 vez', async () => {
  const h = montar();
  abaFaro(h);
  const m = msg(h, { content: 'Faro: roda os testes' });
  await h.p.passoGrupo();
  const pedido = h.entregas[0];
  transcript(h, 'S1', [peer(pedido, false, iso(h.t + 1000)), falaDaAba('Rodando os testes.')]);
  h.t += MIN;
  await h.p.passoEventos();
  assert.equal(h.entregas.length, 1, 'fala sem a linha no meio do turno nao reprova sozinha (aba ocupada narra antes)');
  // o fim do turno sem a linha reprova: reentrega com reforco; a resposta vai pro grupo mesmo assim (F3.5)
  evento(h, parou(h, 'S1', { final: 'Rodei os testes.' }));
  await h.p.passoEventos();
  assert.equal(h.entregas.length, 2);
  assert.deepEqual(h.entregas[1], { ...pedido, reforco: true });
  assert.equal(estado(h).entregas[m.provider_msg_id].tentativas, 2);
  assert.equal(h.enviados.length, 1);
  assert.match(h.enviados[0].texto, /Rodei os testes\./);
  assert.equal(h.reacoes.length, 1, 'a reentrega nao reage de novo');

  await h.p.passoEventos();
  assert.equal(h.entregas.length, 2, 'espera o 2o recado chegar na aba');
  assert.equal(h.enviados.length, 1);

  transcript(h, 'S1', [peer(h.entregas[1], false, iso(h.t + 1000)), falaDaAba('Rodando de novo.')]);
  h.t += MIN;
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 1, 'sem o fim do turno ainda nao avisa');
  evento(h, parou(h, 'S1', { final: 'Rodei de novo.' }));
  await h.p.passoEventos();
  assert.deepEqual(h.enviados.slice(1).map((x) => x.texto), [F.naoMostrou('Faro', '16:00')]);
  h.t += MIN;
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 2);
  assert.equal(h.entregas.length, 2);
});

// Aba OCUPADA (medido 27/09/2026 20:41 na aba central): o recado entra no meio do turno como anexo queued_command, nao
// como linha user. Antes: a varredura nao achava o recado, o porteiro avisava "ainda não pegou" 10 min depois (falso) e,
// com a F3.5, a resposta nem ia pro grupo.
const recadoNoMeio = (pedido, ts) => ({
  type: 'attachment', timestamp: ts,
  attachment: {
    type: 'queued_command', commandMode: 'prompt', timestamp: ts, isMeta: true,
    prompt: `<cross-session-message from="uds:x" from-name="sessoes-wpp-5b" from-mode="prompting">\n${montarRecado(pedido)}\n</cross-session-message>`,
    origin: { kind: 'peer', from: 'uds:x', msg_id: 'm1', name: 'sessoes-wpp-5b', fromMode: 'prompting', body: montarRecado(pedido) },
  },
});

test('F3.5/F3.6 aba ocupada: recado como anexo queued_command + fala do meio sem a linha + final COM a linha = resposta no grupo, conferido, sem reforco nem "ainda não pegou"', async () => {
  const h = montar();
  abaFaro(h, [ferramentaDaAba()]);
  const m = msg(h, { content: 'Faro: roda os testes' });
  await h.p.passoGrupo();
  const pedido = h.entregas[0];
  transcript(h, 'S1', [
    { type: 'queue-operation', operation: 'enqueue', timestamp: iso(h.t + 1000), content: 'x' },
    recadoNoMeio(pedido, iso(h.t + 1000)),
    { type: 'queue-operation', operation: 'remove', timestamp: iso(h.t + 2000), reason: 'absorbed_mid_turn' },
    ferramentaDaAba(), falaDaAba('Conferi o escopo, sigo com a validacao.'), ferramentaDaAba(),
  ]);
  h.t += 2 * MIN;
  await h.p.passoEventos();
  assert.equal(h.entregas.length, 1, 'fala do meio sem a linha nao dispara reforco');
  const final = `${linha('16:00', 'roda os testes')}\n\nRodei: 12 verdes.`;
  const resp = parou(h, 'S1', { final });
  evento(h, resp);
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 1);
  assert.equal(h.enviados[0].texto, montarResposta({ ...resp, titulo: 'Faro' }));
  const x = estado(h).entregas[m.provider_msg_id];
  assert.equal(x.respondida, true);
  assert.equal(x.conferido, true);
  h.t += 15 * MIN;
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 1, 'nada de "ainda não pegou"');
  assert.equal(h.entregas.length, 1, 'nada de reforco');
});

// Caso real (2 abas, falas longas de audio): o `claude -p` do mensageiro juntou as 2 primeiras
// linhas do recado (sumiu a 1a, com o id, e o "> " da 2a). Sem id na ultima linha o porteiro nao achava o recado:
// "ainda não pegou" falso em 10 min e a resposta da aba nao voltava pro grupo.
test('recado com a 1a linha apagada pelo mensageiro: o id da ultima linha acha o recado (resposta no grupo, sem "ainda não pegou")', async () => {
  const h = montar();
  abaFaro(h, [falaDaAba('resposta antiga, de antes do recado')]);
  const m = msg(h, { content: 'Faro: roda os testes' });
  await h.p.passoGrupo();
  const pedido = h.entregas[0];
  const alterado = montarRecado(pedido).split('\n').slice(1).join('\n').replace(/^> /, '');
  assert.ok(!alterado.startsWith('WhatsApp do dono (16:00, id'), 'a 1a linha (com o id) sumiu, como no uso real');
  const texto = `Another Claude session sent a message:\n<cross-session-message from="uds:x" from-name="sessoes-wpp-c6">\n${alterado}\n</cross-session-message>`;
  transcript(h, 'S1', [{
    type: 'user', isMeta: true, timestamp: iso(h.t + 1000),
    origin: { kind: 'peer', from: 'uds:x', msg_id: 'm1', name: 'sessoes-wpp-c6', fromMode: 'prompting', body: alterado },
    message: { role: 'user', content: texto },
  }]);
  h.t += 2 * MIN;
  const final = `${linha('16:00', 'roda os testes')}\n\nRodei: 12 verdes.`;
  const resp = parou(h, 'S1', { final });
  evento(h, resp);
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 1);
  assert.equal(h.enviados[0].texto, montarResposta({ ...resp, titulo: 'Faro' }));
  const x = estado(h).entregas[m.provider_msg_id];
  assert.equal(x.respondida, true);
  assert.equal(x.conferido, true);
  h.t += 15 * MIN;
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 1, 'nada de "ainda não pegou"');
  assert.equal(h.entregas.length, 1, 'nada de reforco');
});

test('F3.6 aba ocupada: recado como anexo e final SEM a linha = resposta no grupo e 1 reforco', async () => {
  const h = montar();
  abaFaro(h);
  msg(h, { content: 'Faro: roda os testes' });
  await h.p.passoGrupo();
  const pedido = h.entregas[0];
  transcript(h, 'S1', [recadoNoMeio(pedido, iso(h.t + 1000)), falaDaAba('Rodando.')]);
  h.t += MIN;
  evento(h, parou(h, 'S1', { final: 'Rodei: 12 verdes.' }));
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 1);
  assert.deepEqual(h.entregas[1], { ...pedido, reforco: true });
});

test('D3b 3. nenhum peer em 10 min -> "ainda não pegou" 1 vez so; peer depois com a linha -> conferido calado', async () => {
  const h = montar();
  abaFaro(h);
  const m = msg(h, { content: 'Faro: publica o site' });
  await h.p.passoGrupo();
  const inicio = h.t;
  h.t = inicio + 10 * MIN - 1000;
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 0, 'antes de 10 min nada');
  h.t = inicio + 10 * MIN;
  await h.p.passoEventos();
  assert.deepEqual(h.enviados.map((x) => x.texto), [F.naFila('Faro', '16:00')]);
  h.t += MIN;
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 1, '1 vez so');
  assert.equal(estado(h).entregas[m.provider_msg_id].avisadoFila, true);

  transcript(h, 'S1', [peer(h.entregas[0]), falaDaAba(`${linha('16:00', 'publica o site')}\nPublicando.`)]);
  await h.p.passoEventos();
  assert.equal(estado(h).entregas[m.provider_msg_id].conferido, true);
  assert.equal(h.enviados.length, 1);
});

test('D3b 4. entrega + parou seguinte com modo rua DESLIGADO -> montarResposta no grupo e avisos[]; o parou depois -> nada', async () => {
  const h = montar();
  abaFaro(h);
  msg(h, { content: 'Faro: roda os testes' });
  await h.p.passoGrupo();
  // Stop gravado antes da entrega (chega atrasado no arquivo): nao e a resposta
  evento(h, { ...parou(h, 'S1', { final: 'de antes do recado' }), at: iso(h.t - 1000), finalTs: iso(h.t - 1000) });
  transcript(h, 'S1', [peer(h.entregas[0], false, iso(h.t))]); // F3.5: o recado entra na aba antes da fala final
  h.t += MIN;
  const resp = parou(h, 'S1', { final: `${linha('16:00', 'roda os testes')}\n\n**Rodei**: 12 verdes.` });
  evento(h, resp);
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 1);
  assert.equal(h.enviados[0].texto, montarResposta({ ...resp, titulo: 'Faro' }));
  assert.equal(h.enviados[0].texto, 'ℹ️ *Faro*\nRodei: 12 verdes.', 'F4g: sem hora, sem a linha de citacao e sem rodape');
  const e = estado(h);
  assert.equal(e.modoRua.ligado, false);
  for (const id of ['P1', 'U1']) {
    assert.equal(e.avisos[id].sessionId, 'S1');
    assert.equal(e.avisos[id].titulo, 'Faro');
    assert.equal(e.avisos[id].nome, 'projetos-42');
  }

  h.t += MIN;
  evento(h, parou(h, 'S1', { final: 'outra coisa' }));
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 1, 'depois da resposta volta a regra normal (dono no PC: nada)');

  msg(h, { content: 'valeu, publica', quoted_msg_id: 'P1' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.at(-1).sessionId, 'S1', 'citar a resposta repassa pra mesma aba');
  assert.equal(h.entregas.at(-1).texto, 'valeu, publica');
});

// F4g (pedido do dono: "no maximo duas linhas"): a resposta sai em 2 linhas; fala com "detalh" = o texto inteiro.
const RESPOSTA_LONGA = (fala) => [
  linha('16:00', fala), '🟢 Publiquei a função X no ar. Conferi o endereço.', '', '- **Login:** igual.', '- **Deploy:** 2 min.',
  '', '---', '🔴 **DECISÃO:** Aviso o time?', 'A) Sim (recomendado) / B) Não',
].join('\n');
async function respostaDaFala(fala) {
  const h = montar();
  abaFaro(h);
  msg(h, { content: `Faro: ${fala}` });
  await h.p.passoGrupo();
  transcript(h, 'S1', [peer(h.entregas[0], false, iso(h.t))]);
  h.t += MIN;
  const resp = parou(h, 'S1', { final: RESPOSTA_LONGA(fala), marcas: { decisao: true, fica: false, pergunta: false } });
  evento(h, resp);
  await h.p.passoEventos();
  return { h, resp };
}

test('F4g 14. resposta a fala comum = as 2 linhas (o que aconteceu + a pergunta com as opcoes), sem hora, citacao nem rodape', async () => {
  const { h, resp } = await respostaDaFala('publica a funcao X');
  assert.deepEqual(h.enviados.map((x) => x.texto), [montarResposta({ ...resp, titulo: 'Faro' })]);
  assert.equal(h.enviados[0].texto, 'ℹ️ *Faro*\nPubliquei a função X no ar.\n\n*Aviso o time?*\nA) Sim (recomendado) / B) Não');
});

test('F4g 15. fala com "detalh" (detalha, detalhes) = a resposta inteira, com o cabecalho novo, sem a linha de citacao e sem rodape', async () => {
  for (const fala of ['detalha o que mudou', 'me manda os Detalhes']) {
    const { h, resp } = await respostaDaFala(fala);
    assert.deepEqual(h.enviados.map((x) => x.texto), [montarResposta({ ...resp, titulo: 'Faro' }, { completo: true })], fala);
    const t = h.enviados[0].texto;
    assert.ok(t.startsWith('ℹ️ *Faro*\nPubliquei a função X no ar. Conferi o endereço.\n'), t);
    assert.ok(t.includes('- *Login:* igual.') && t.includes('*DECISÃO:* Aviso o time?'), t);
    assert.ok(!t.includes('WhatsApp do Davi') && !t.includes('Responde citando'), t);
  }
});

test('F4g 16. parou guardado (a resposta passou antes de a entrega ser registrada) tambem respeita o "detalh" da fala', async () => {
  for (const [fala, completo] of [['detalha o plano', true], ['roda os testes', false]]) {
    const h = montar();
    h.segurar = true;
    abaFaro(h);
    msg(h, { content: `Faro: ${fala}` });
    await h.cru.passoGrupo();
    await semEsperar(h.cru.passoEntrega(), 'passoEntrega');
    h.t += 5 * 1000;
    transcript(h, 'S1', [peer(h.entregas[0], false, iso(h.t))]);
    h.t += 20 * 1000;
    const fim = RESPOSTA_LONGA(fala);
    transcript(h, 'S1', [falaDaAba(fim, iso(h.t))]);
    const r = parou(h, 'S1', { final: fim });
    evento(h, r);
    await semEsperar(h.cru.passoEventos(), 'passoEventos');
    assert.equal(h.enviados.length, 0, 'sem entrega registrada ainda');
    h.segurar = false;
    const novo = porteiroNovo(h);
    h.t += 3 * MIN;
    await novo.passoGrupo();
    await bombear(novo);
    assert.deepEqual(h.enviados.map((x) => x.texto), [montarResposta({ ...r, titulo: 'Faro' }, { completo })], fala);
  }
});

test('D3b 4b. modo rua LIGADO: resposta sai na hora (nao vai pro resumo) e com DECISAO nao duplica o aviso', async () => {
  const h = montar();
  abaFaro(h);
  sessao(h, { sessionId: 'S2', name: 'repos-f3' });
  transcript(h, 'S2', [custom('Brain')]);
  await ligarRua(h);
  msg(h, { content: 'Faro: roda os testes' });
  msg(h, { content: 'Brain: salva a nota' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 2);
  transcript(h, 'S1', [peer(h.entregas[0], false, iso(h.t))]); // F3.5: os recados entram nas abas antes da fala final
  transcript(h, 'S2', [peer(h.entregas[1], false, iso(h.t))]);
  h.t += MIN;
  await h.p.passoMinuto();
  const r1 = parou(h, 'S1');
  const r2 = parou(h, 'S2', { nome: 'repos-f3', final: 'Salvei. DECISAO: linko na nota antiga?', marcas: DECISAO });
  evento(h, r1);
  evento(h, r2);
  await h.p.passoEventos();
  assert.deepEqual(h.enviados.map((x) => x.texto), [
    montarResposta({ ...r1, titulo: 'Faro' }),
    montarResposta({ ...r2, titulo: 'Brain' }),
  ]);
  assert.equal(estado(h).resumoPendente.length, 0);

  h.t += MIN;
  await h.p.passoMinuto();
  const a = parou(h, 'S2', { nome: 'repos-f3', final: 'DECISAO: sigo?', marcas: DECISAO });
  evento(h, a);
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 3);
  assert.equal(h.enviados[2].texto, montarAviso({ ...a, titulo: 'Brain' }), 'depois da resposta: aviso normal');
});

test('D3b 5. nao_achei / duplicado / erro 2x -> frases fixas; erro e depois enviado -> reage e grava', async () => {
  const h = montar({
    respostasEntrega: [
      { status: 'nao_achei', detalhe: '' },
      { status: 'duplicado', detalhe: '' },
      { status: 'erro', detalhe: 'exit 1' },
      { status: 'erro', detalhe: 'timeout 120 s' },
      { status: 'erro', detalhe: 'exit 1' },
      { status: 'enviado', detalhe: '' },
    ],
  });
  abaFaro(h);
  msg(h, { content: 'Faro: a' });
  await h.p.passoGrupo();
  assert.deepEqual(h.enviados.map((x) => x.texto), [F.naoAchei('Faro')]);
  msg(h, { content: 'Faro: b' });
  await h.p.passoGrupo();
  assert.equal(h.enviados[1].texto, F.duplicado('projetos-42'));

  msg(h, { content: 'Faro: c' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 3);
  assert.equal(h.enviados.length, 2, '1o erro: tenta de novo no proximo passoGrupo, calado');
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 4);
  assert.deepEqual(h.entregas[3], h.entregas[2]);
  assert.equal(h.enviados[2].texto, F.naoEntregue('16:00', 'Faro'));
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 4, 'so 1 nova tentativa');
  assert.equal(h.enviados.length, 3);
  assert.deepEqual(h.reacoes, []);
  assert.deepEqual(estado(h).entregas, {});

  h.t += MIN;
  const d = msg(h, { content: 'Faro: d' });
  await h.p.passoGrupo();
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 6);
  assert.deepEqual(h.reacoes, [{ messageId: d.id, emoji: '✅' }]);
  assert.equal(estado(h).entregas[d.provider_msg_id].sessionId, 'S1');
  assert.equal(h.enviados.length, 3);
});

test('D3b 7. peer com content em string e em blocos: os dois acham o providerMsgId; outro id e fala digitada nao contam', async () => {
  const h = montar();
  abaFaro(h);
  sessao(h, { sessionId: 'S2', name: 'repos-f3' });
  transcript(h, 'S2', [custom('Brain')]);
  const m1 = msg(h, { content: 'Faro: um' });
  const m2 = msg(h, { content: 'Brain: dois' });
  await h.p.passoGrupo();
  const [p1, p2] = h.entregas;
  assert.equal(p2.providerMsgId, m2.provider_msg_id);
  // id que COMECA igual (PROV1 x PROV10) e fala comum com o id: nenhum dos dois e o recado
  transcript(h, 'S1', [
    peer({ ...p1, providerMsgId: `${m1.provider_msg_id}0` }), falaDaAba('sem a linha, de outro recado'),
    peer(p1), falaDaAba(`${linha('16:00', 'um')}\nFeito.`),
  ]);
  transcript(h, 'S2', [
    { type: 'user', message: { role: 'user', content: `copiei o id ${m2.provider_msg_id} aqui` } }, falaDaAba('sem a linha'),
    peer(p2, true), falaDaAba(`${linha('16:00', 'dois')}\nSalvo.`),
  ]);
  h.t += MIN;
  await h.p.passoEventos();
  const e = estado(h);
  assert.equal(e.entregas[m1.provider_msg_id].conferido, true, 'content string');
  assert.equal(e.entregas[m2.provider_msg_id].conferido, true, 'content em blocos');
  assert.equal(h.entregas.length, 2, 'nada reentregue');
  assert.equal(h.enviados.length, 0);
});

test('D3b 8. fila de saida: 6 avisos no mesmo minuto -> 4 saem, 2 ficam e saem no passo seguinte com +61 s', async () => {
  const h = montar();
  const letras = ['A', 'B', 'C', 'D', 'E', 'F'];
  letras.forEach((l, i) => {
    sessao(h, { sessionId: `S${i + 1}`, name: `repos-${i}` });
    transcript(h, `S${i + 1}`, [custom(`Sessao ${l}`)]);
  });
  await ligarRua(h);
  letras.forEach((_l, i) => evento(h, parou(h, `S${i + 1}`, { nome: `repos-${i}`, marcas: DECISAO })));
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 4);
  let e = estado(h);
  assert.deepEqual(e.saida.map((x) => x.aviso.sessionId), ['S5', 'S6'], 'ordem de chegada');
  assert.equal(e.avisos.P4.sessionId, 'S4');

  h.t += 30 * 1000;
  await h.p.passoGrupo();
  assert.equal(h.enviados.length, 4, 'ainda dentro da janela de 60 s');
  h.t += 31 * 1000;
  await h.p.passoMinuto();
  await h.p.passoGrupo();
  assert.equal(h.enviados.length, 6);
  assert.match(h.enviados[4].texto, /^ℹ️ \*Sessao E\*/);
  assert.match(h.enviados[5].texto, /^ℹ️ \*Sessao F\*/);
  e = estado(h);
  assert.equal(e.saida.length, 0);
  assert.equal(e.avisos.P5.sessionId, 'S5');
  assert.equal(e.avisos.U6.sessionId, 'S6');

  // status e frase passam pela mesma fila: 4 na janela, o 5o espera
  h.t += 61 * 1000;
  for (let i = 0; i < 5; i++) msg(h, { content: 'status' });
  await h.p.passoGrupo();
  assert.equal(h.enviados.length, 10);
  assert.deepEqual(estado(h).saida.map((x) => x.tipo), ['status']);
  h.t += 61 * 1000;
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 11);
  assert.match(h.enviados[10].texto, /^🎛️ \*Controle de sessões\*\n- /);
});

test('D3b 8b. rate_limit do whatsapp-agent -> volta pro INICIO da fila sem contar falha e sai depois', async () => {
  const h = montar({
    respostasEnvio: [
      { ok: false, erro: 'rate_limit' },
      { ok: false, erro: 'rate_limit' },
    ],
  });
  abaFaro(h);
  await ligarRua(h);
  evento(h, parou(h, 'S1', { marcas: DECISAO }));
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 1);
  let e = estado(h);
  assert.equal(e.saida.length, 1);
  assert.equal(e.saida[0].falhas, 0, 'rate_limit nao conta como falha');

  msg(h, { content: 'status' });
  await h.p.passoGrupo();
  assert.equal(h.enviados.length, 1, 'logo depois do rate_limit nao insiste no mesmo passo');
  assert.deepEqual(estado(h).saida.map((x) => x.tipo), ['aviso', 'status'], 'o aviso segue no inicio');

  h.t += 16 * 1000;
  await h.p.passoGrupo();
  assert.equal(h.enviados.length, 2, 'tentou de novo; rate_limit outra vez');
  e = estado(h);
  assert.deepEqual(e.saida.map((x) => x.tipo), ['aviso', 'status']);
  assert.equal(e.saida[0].falhas, 0);

  h.t += 61 * 1000;
  await h.p.passoMinuto();
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 4);
  assert.equal(h.enviados[2].texto, h.enviados[0].texto, 'o mesmo aviso');
  assert.match(h.enviados[3].texto, /^🎛️ \*Controle de sessões\*\n- Faro/);
  e = estado(h);
  assert.equal(e.saida.length, 0);
  assert.equal(e.avisos.P1.sessionId, 'S1');
});

// Principal (validacao do D3b, 27/09): sabotagem "entrega sem TTL" passava verde.
test('D3b 9. entrega com mais de 2 h sai do estado: sem "ainda não pegou" e o parou depois nao vira resposta', async () => {
  const h = montar();
  abaFaro(h);
  const m = msg(h, { content: 'Faro: roda os testes' });
  await h.p.passoGrupo();
  assert.ok(estado(h).entregas[m.provider_msg_id], 'entrega gravada');
  h.t += 2 * 60 * MIN + MIN;
  evento(h, parou(h, 'S1', { final: 'Feito, bem depois.' }));
  await h.p.passoEventos();
  assert.deepEqual(estado(h).entregas, {});
  assert.equal(h.enviados.length, 0, 'nem "ainda não pegou" nem resposta fora do prazo');
});

// ---------------------------------------------------------------------------------------------------------------
// Fase 3 (27/09): F3.5 resposta casada por mensagem; F3.6 reentrega sem repetir a ordem e erro do mensageiro conferido.

test('F3.5 a. 2 mensagens pra mesma aba: parou1 responde so M1 (1 no grupo); parou2 responde M2 (2a, com a resposta 2)', async () => {
  const h = montar();
  abaFaro(h);
  const m1 = msg(h, { content: 'Faro: pergunta 1' });
  h.t += 10 * 1000;
  const m2 = msg(h, { content: 'Faro: pergunta 2' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 2);
  const [p1, p2] = h.entregas;

  h.t += 20 * 1000;
  transcript(h, 'S1', [peer(p1, false, iso(h.t))]);
  h.t += 30 * 1000;
  const fim1 = `${linha('16:00', 'pergunta 1')}\nresposta 1`;
  transcript(h, 'S1', [falaDaAba(fim1, iso(h.t))]);
  const r1 = parou(h, 'S1', { final: fim1 });
  evento(h, r1);
  await h.p.passoEventos();
  assert.deepEqual(h.enviados.map((x) => x.texto), [montarResposta({ ...r1, titulo: 'Faro' })]);
  let e = estado(h);
  assert.equal(e.entregas[m1.provider_msg_id].respondida, true);
  assert.ok(!e.entregas[m2.provider_msg_id].respondida, 'o recado de M2 ainda nao estava na aba: espera o proximo parou');

  h.t += 20 * 1000;
  transcript(h, 'S1', [peer(p2, false, iso(h.t))]);
  h.t += 30 * 1000;
  const fim2 = `${linha('16:00', 'pergunta 2')}\nresposta 2`;
  transcript(h, 'S1', [falaDaAba(fim2, iso(h.t))]);
  const r2 = parou(h, 'S1', { final: fim2 });
  evento(h, r2);
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 2);
  assert.equal(h.enviados[1].texto, montarResposta({ ...r2, titulo: 'Faro' }));
  assert.ok(h.enviados[1].texto.includes('resposta 2'));
  e = estado(h);
  assert.equal(e.entregas[m2.provider_msg_id].respondida, true);
  assert.equal(e.entregas[m1.provider_msg_id].conferido, true);
  assert.equal(e.entregas[m2.provider_msg_id].conferido, true);
  assert.equal(h.entregas.length, 2, 'nada reentregue');
});

test('F3.5 b. parou com finalTs ANTES do recado entrar na aba -> nao responde; o parou seguinte responde', async () => {
  const h = montar();
  abaFaro(h);
  const m = msg(h, { content: 'Faro: roda os testes' });
  await h.p.passoGrupo();
  const pedido = h.entregas[0];
  h.t += 30 * 1000;
  // a aba fechou um turno de OUTRA coisa (fala final 16:00:31) e so depois o recado entrou (16:00:41); o Stop chega depois
  const outro = parou(h, 'S1', { final: 'Terminei o que estava fazendo.' });
  transcript(h, 'S1', [falaDaAba('Terminei o que estava fazendo.', iso(h.t))]);
  h.t += 10 * 1000;
  transcript(h, 'S1', [peer(pedido, false, iso(h.t))]);
  evento(h, { ...outro, at: iso(h.t + 500) });
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 0, 'turno que nao viu o recado nao vira resposta');
  assert.ok(!estado(h).entregas[m.provider_msg_id].respondida);
  evento(h, { ...outro, at: iso(h.t + 600), finalTs: iso(h.t) }); // fala final no MESMO ms do recado: nao e "antes"
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 0, 'estritamente antes');

  h.t += 30 * 1000;
  const fim = `${linha('16:00', 'roda os testes')}\n12 verdes.`;
  transcript(h, 'S1', [falaDaAba(fim, iso(h.t))]);
  const resp = parou(h, 'S1', { final: fim });
  evento(h, resp);
  await h.p.passoEventos();
  assert.deepEqual(h.enviados.map((x) => x.texto), [montarResposta({ ...resp, titulo: 'Faro' })]);
  assert.equal(estado(h).entregas[m.provider_msg_id].respondida, true);
});

test('F3.5 c. M1 e M2 com os 2 recados antes do mesmo final -> 1 mensagem so no grupo e as 2 respondidas', async () => {
  const h = montar();
  abaFaro(h);
  const m1 = msg(h, { content: 'Faro: um' });
  h.t += 5000;
  const m2 = msg(h, { content: 'Faro: dois' });
  await h.p.passoGrupo();
  const [p1, p2] = h.entregas;
  h.t += 10 * 1000;
  transcript(h, 'S1', [peer(p1, false, iso(h.t))]);
  h.t += 1000;
  transcript(h, 'S1', [peer(p2, true, iso(h.t))]);
  h.t += 30 * 1000;
  const fim = `${linha('16:00', 'um')}\n${linha('16:00', 'dois')}\nFiz os dois.`;
  transcript(h, 'S1', [falaDaAba(fim, iso(h.t))]);
  const r = parou(h, 'S1', { final: fim });
  evento(h, r);
  await h.p.passoEventos();
  assert.deepEqual(h.enviados.map((x) => x.texto), [montarResposta({ ...r, titulo: 'Faro' })]);
  const e = estado(h);
  assert.equal(e.entregas[m1.provider_msg_id].respondida, true);
  assert.equal(e.entregas[m2.provider_msg_id].respondida, true);

  h.t += MIN;
  evento(h, parou(h, 'S1', { final: 'outra coisa' }));
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 1, 'as 2 ja respondidas: o parou seguinte segue a regra normal (dono no PC: nada)');
});

test('F3.5 d. recado no transcript SEM timestamp legivel -> nao responde e loga 1 linha', async () => {
  const h = montar();
  abaFaro(h);
  const m = msg(h, { content: 'Faro: roda os testes' });
  await h.p.passoGrupo();
  h.t += 30 * 1000;
  transcript(h, 'S1', [peer(h.entregas[0])]); // sem o campo timestamp
  h.t += 30 * 1000;
  evento(h, parou(h, 'S1', { final: `${linha('16:00', 'roda os testes')}\nFeito.` }));
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 0);
  assert.ok(!estado(h).entregas[m.provider_msg_id].respondida);
  const log = fs.readFileSync(h.env.SESSOES_WPP_LOG, 'utf8');
  assert.equal(log.split('\n').filter((l) => /sem timestamp legivel/.test(l)).length, 1);
  assert.doesNotMatch(log, /roda os testes/, 'log sem o texto');

  const h2 = montar();
  abaFaro(h2);
  msg(h2, { content: 'Faro: roda os testes' });
  await h2.p.passoGrupo();
  h2.t += 30 * 1000;
  transcript(h2, 'S1', [peer(h2.entregas[0], false, 'ontem')]); // timestamp que nao e data
  h2.t += 30 * 1000;
  evento(h2, parou(h2, 'S1'));
  await h2.p.passoEventos();
  assert.equal(h2.enviados.length, 0);
  assert.match(fs.readFileSync(h2.env.SESSOES_WPP_LOG, 'utf8'), /sem timestamp legivel/);
});

test('F3.5 d2. parou com finalTs ilegivel (null, texto) -> nao responde e loga; o parou legivel depois responde', async () => {
  const h = montar();
  abaFaro(h);
  const m = msg(h, { content: 'Faro: roda os testes' });
  await h.p.passoGrupo();
  h.t += 30 * 1000;
  transcript(h, 'S1', [peer(h.entregas[0], false, iso(h.t))]);
  for (const finalTs of [null, 'agora']) {
    h.t += 30 * 1000;
    evento(h, { ...parou(h, 'S1', { final: 'Feito.' }), finalTs });
    await h.p.passoEventos();
  }
  assert.equal(h.enviados.length, 0);
  assert.ok(!estado(h).entregas[m.provider_msg_id].respondida);
  const log = fs.readFileSync(h.env.SESSOES_WPP_LOG, 'utf8');
  assert.equal(log.split('\n').filter((l) => /finalTs ilegivel/.test(l)).length, 2);

  h.t += 30 * 1000;
  const r = parou(h, 'S1', { final: 'Feito de verdade.' });
  evento(h, r);
  await h.p.passoEventos();
  assert.deepEqual(h.enviados.map((x) => x.texto), [montarResposta({ ...r, titulo: 'Faro' })]);
});

test('F3.6 f. erro do mensageiro mas o recado JA esta na aba -> sem 2a chamada; entrega registrada; conferencia segue', async () => {
  const h = montar({ respostasEntrega: [{ status: 'erro', detalhe: 'timeout 120 s' }] });
  abaFaro(h);
  const inicio = h.t;
  const m = msg(h, { content: 'Faro: roda os testes' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 1);
  assert.deepEqual(estado(h).entregas, {}, '1o erro: ainda nao registra');
  const pedido = h.entregas[0];
  // o claude -p estourou o tempo DEPOIS de mandar: o recado chegou na aba
  h.t += 30 * 1000;
  transcript(h, 'S1', [peer(pedido, false, iso(h.t))]);
  h.t += 15 * 1000;
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 1, 'nao reenvia');
  assert.deepEqual(h.reacoes, [{ messageId: m.id, emoji: '✅' }]);
  assert.deepEqual(estado(h).entregas, {
    [m.provider_msg_id]: {
      sessionId: 'S1', titulo: 'Faro', hora: '16:00', at: iso(inicio), pedido, tentativas: 1, conferido: false, avisadoFila: false,
    },
  });
  assert.deepEqual(estado(h).repassar, []);
  assert.equal(h.enviados.length, 0, 'sem "não consegui entregar"');
  assert.match(fs.readFileSync(h.env.SESSOES_WPP_LOG, 'utf8'), /recado ja estava na aba/);

  h.t += 30 * 1000;
  const fim = `${linha('16:00', 'roda os testes')}\n12 verdes.`;
  transcript(h, 'S1', [falaDaAba(fim, iso(h.t))]);
  const r = parou(h, 'S1', { final: fim });
  evento(h, r);
  await h.p.passoEventos();
  assert.equal(estado(h).entregas[m.provider_msg_id].conferido, true);
  assert.deepEqual(h.enviados.map((x) => x.texto), [montarResposta({ ...r, titulo: 'Faro' })]);
  assert.equal(h.entregas.length, 1);
});

test('F3.6 g. erro do mensageiro e o recado NAO esta na aba (so outro id parecido) -> reenvia como hoje', async () => {
  const h = montar({ respostasEntrega: [{ status: 'erro', detalhe: 'exit 1' }] });
  abaFaro(h, [falaDaAba('resposta antiga', iso(h.t - MIN))]);
  const m = msg(h, { content: 'Faro: roda os testes' });
  await h.p.passoGrupo();
  const pedido = h.entregas[0];
  transcript(h, 'S1', [peer({ ...pedido, providerMsgId: `${m.provider_msg_id}0` }, false, iso(h.t))]);
  h.t += 15 * 1000;
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 2, 'reenviou');
  assert.deepEqual(h.entregas[1], pedido);
  assert.equal(estado(h).entregas[m.provider_msg_id].sessionId, 'S1');
  assert.equal(estado(h).entregas[m.provider_msg_id].at, iso(h.t));
  assert.deepEqual(h.reacoes, [{ messageId: m.id, emoji: '✅' }]);
  assert.doesNotMatch(fs.readFileSync(h.env.SESSOES_WPP_LOG, 'utf8'), /recado ja estava na aba/);
});

// ---------------------------------------------------------------------------------------------------------------
// Fase 2 (27/09): resposta a PEDIDO DE OK (ok-wpp) vai pra aba do pedido com a ordem de rodar o verificar.
function pedidoOk(h, { codigo, sessionId, providerMsgId, messageId, criado = h.t - MIN, status = 'pendente' }) {
  const dir = path.join(h.env.SESSOES_WPP_DIR, 'oks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${codigo}.json`), JSON.stringify({
    v: 1, codigo, sessionId, tipo: 'crm', acao: 'x', hashAcao: 'h', destinatarios: null,
    criadoEm: iso(criado), expiraEm: iso(criado + 30 * MIN), providerMsgId, messageId, status,
  }));
}
// A3a: o caminho do ok-wpp.mjs sai da pasta do repositorio (barras normais; entre aspas so com espaco). No PC do dono =
// C:/projetos/sessoes-wpp/ok-wpp.mjs, como antes.
const OK_WPP_NA_NOTA = ((p) => (p.includes(' ') ? `"${p}"` : p))(fileURLToPath(new URL('../ok-wpp.mjs', import.meta.url)).replace(/\\/g, '/'));
const NOTA = (cod) => `Resposta ao seu pedido de OK ${cod}. Antes de agir, rode: node ${OK_WPP_NA_NOTA} verificar ${cod} (so age com status ok).`;

// Mensagem dos agentes no grupo (from_me na instancia profissional): pedido de OK, aviso, resposta, frase do porteiro.
function doAgente(h, o = {}) {
  return msg(h, {
    from_me: true, sent_by_agent: true, direction: 'sent', sender_phone: NUMERO_ROBO,
    content: 'ℹ️ *Brain*\nPronto.\n\n*Publico agora?*', ...o,
  });
}
// A mensagem do pedido de OK como o ok-wpp pedir deixa no grupo (F3.2: o porteiro precisa dela no lote pra ter a hora).
const pedidoNoGrupo = (h, providerMsgId, messageId, ts) => doAgente(h, {
  provider_msg_id: providerMsgId, id: messageId, content: 'ℹ️ *Faro*\nPedido de OK (CRM): x\n\n*Posso?* Vale até 16:30.', message_ts: ts,
});

test('OK 1. citando o pedido (provider ou uuid) -> aba do pedido, texto literal e a nota do verificar', async () => {
  const h = montar();
  sessao(h, { sessionId: 'S1', name: 'projetos-42' });
  transcript(h, 'S1', [custom('Faro')]);
  sessao(h, { sessionId: 'SC', name: 'repos-99' });
  transcript(h, 'SC', [custom('Central de sessões de teste')]);
  pedidoOk(h, { codigo: 'ABC234', sessionId: 'S1', providerMsgId: '3EB0PED', messageId: 'uuid-ped' });
  const m = msg(h, { content: 'Sim', quoted_msg_id: '3EB0PED' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 1);
  assert.equal(h.entregas[0].sessionId, 'S1');
  assert.equal(h.entregas[0].texto, 'Sim');
  assert.equal(h.entregas[0].nota, NOTA('ABC234'));
  assert.equal(h.entregas[0].providerMsgId, m.provider_msg_id);
  msg(h, { content: 'pode', quoted_msg_id: 'uuid-ped' });
  await h.p.passoGrupo();
  assert.equal(h.entregas[1].sessionId, 'S1');
});

test('OK 2. "sim" solto com 1 pedido aberto -> aba do pedido; com 2 abertos ou conversa solta -> central', async () => {
  const h = montar();
  sessao(h, { sessionId: 'S1', name: 'projetos-42' });
  transcript(h, 'S1', [custom('Faro')]);
  sessao(h, { sessionId: 'S2', name: 'repos-f3' });
  transcript(h, 'S2', [custom('Brain')]);
  sessao(h, { sessionId: 'SC', name: 'repos-99' });
  transcript(h, 'SC', [custom('Central de sessões de teste')]);
  pedidoOk(h, { codigo: 'ABC234', sessionId: 'S1', providerMsgId: '3EB0A', messageId: 'uuid-a' });
  pedidoOk(h, { codigo: 'ZZZ999', sessionId: 'S2', providerMsgId: '3EB0Z', messageId: 'uuid-z', status: 'usado' });
  pedidoNoGrupo(h, '3EB0A', 'uuid-a', iso(h.t - MIN + 2000)); // F3.2: sem a mensagem do pedido no lote, o solto nao vale
  msg(h, { content: 'sim' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.at(-1).sessionId, 'S1');
  assert.equal(h.entregas.at(-1).nota, NOTA('ABC234'));

  msg(h, { content: 'bom dia' }); // conversa solta: nao e resposta a pedido
  await h.p.passoGrupo();
  assert.equal(h.entregas.at(-1).sessionId, 'SC');
  assert.equal(h.entregas.at(-1).nota, undefined);

  pedidoOk(h, { codigo: 'BCD345', sessionId: 'S2', providerMsgId: '3EB0B', messageId: 'uuid-b' });
  msg(h, { content: 'sim' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.at(-1).sessionId, 'SC', '2 pedidos abertos: solta vai pra central');

  msg(h, { content: 'sim', quoted_msg_id: '3EB0B' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.at(-1).sessionId, 'S2');
  assert.equal(h.entregas.at(-1).nota, NOTA('BCD345'));
});

test('OK 3. pedido vencido ou de antes do "sim" nao atrai a resposta solta', async () => {
  const h = montar();
  sessao(h, { sessionId: 'S1', name: 'projetos-42' });
  transcript(h, 'S1', [custom('Faro')]);
  sessao(h, { sessionId: 'SC', name: 'repos-99' });
  transcript(h, 'SC', [custom('Central de sessões de teste')]);
  pedidoOk(h, { codigo: 'ABC234', sessionId: 'S1', providerMsgId: '3EB0A', messageId: 'uuid-a', criado: h.t - 31 * MIN });
  msg(h, { content: 'sim' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.at(-1).sessionId, 'SC');
  pedidoOk(h, { codigo: 'BCD345', sessionId: 'S1', providerMsgId: '3EB0B', messageId: 'uuid-b', criado: h.t + MIN });
  msg(h, { content: 'sim' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.at(-1).sessionId, 'SC', 'pedido criado depois da mensagem');
});

// ---------------------------------------------------------------------------------------------------------------
// Fase 3 (27/09, PLANO.md): F3.2 "sim" solto so vale sem mensagem dos agentes entre o pedido e ele; F3.3 "trava" vence
// tudo; F3.8 offset dos eventos anda evento a evento.

// Frase nova do F3.2 (escrita por extenso de proposito: o teste prende o texto).
const QUAL = (palavra, hora) => `${CAB}\nEsse "${palavra}" das ${hora} é pra qual pedido? Responde citando a mensagem do pedido.`;
const TRAVADO_F = `${CAB}\nTravado. Não repasso nada nem mando aviso até você destravar no PC.`;

function abasOk(h) {
  sessao(h, { sessionId: 'S1', name: 'projetos-42' });
  transcript(h, 'S1', [custom('Faro')]);
  sessao(h, { sessionId: 'S2', name: 'repos-f3' });
  transcript(h, 'S2', [custom('Brain')]);
  sessao(h, { sessionId: 'SC', name: 'repos-99' });
  transcript(h, 'SC', [custom('Central de sessões de teste')]);
}

test('F3.2 a. pedido aberto -> aviso de outra aba no grupo -> "sim" solto = 0 repasses, 1 frase pedindo a citacao, vista; "não" idem; citando o pedido = aba do pedido', async () => {
  const h = montar();
  abasOk(h);
  pedidoOk(h, { codigo: 'ABC234', sessionId: 'S1', providerMsgId: '3EB0A', messageId: 'uuid-a' });
  pedidoNoGrupo(h, '3EB0A', 'uuid-a', iso(h.t - MIN + 2000));
  doAgente(h, { message_ts: iso(h.t - 10 * 1000) }); // aviso da aba Brain DEPOIS do pedido
  const sim = msg(h, { content: 'sim' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 0, 'nao repassa pra aba do pedido nem pra central');
  assert.deepEqual(h.enviados.map((x) => x.texto), [QUAL('sim', '16:00')]);
  assert.ok(estado(h).vistos.includes(sim.provider_msg_id), 'mensagem marcada como vista');
  await h.p.passoGrupo();
  assert.equal(h.enviados.length, 1, 'ciclo seguinte nao repete a frase');
  assert.equal(h.entregas.length, 0);

  h.t += MIN;
  msg(h, { content: 'Não' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 0);
  assert.equal(h.enviados.at(-1).texto, QUAL('não', '16:01'));

  const citando = msg(h, { content: 'sim', quoted_msg_id: '3EB0A' }); // citando o pedido: o que esta no meio nao importa
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 1);
  assert.equal(h.entregas[0].sessionId, 'S1');
  assert.equal(h.entregas[0].nota, NOTA('ABC234'));
  assert.equal(h.entregas[0].providerMsgId, citando.provider_msg_id);
  assert.equal(h.enviados.length, 2);
});

// GPT-6 rodada 2 (27/09 23:47), achado 3: agente no MESMO segundo do "sim" (ou do pedido) nao contava como no meio.
test('R2 empate: aviso de outra aba no mesmo segundo do "sim" ou do pedido = frase pedindo a citacao, sem repasse', async () => {
  for (const [nome, quando] of [['empate com o sim', (h) => h.t], ['empate com o pedido', (h) => h.t - MIN + 2000]]) {
    const h = montar();
    abasOk(h);
    pedidoOk(h, { codigo: 'ABC234', sessionId: 'S1', providerMsgId: '3EB0A', messageId: 'uuid-a' });
    pedidoNoGrupo(h, '3EB0A', 'uuid-a', iso(h.t - MIN + 2000));
    doAgente(h, { message_ts: iso(quando(h)) });
    msg(h, { content: 'sim' });
    await h.p.passoGrupo();
    assert.equal(h.entregas.length, 0, nome);
    assert.deepEqual(h.enviados.map((x) => x.texto), [QUAL('sim', '16:00')], nome);
  }
});

// Achado 4: a trava tem que estar no disco antes do await da reacao (o ok-wpp so ve o disco).
test('R2 trava no disco antes da reacao', async () => {
  const h = montar();
  let travadoNoDisco = null;
  const reagirOriginal = h.wpp.reagir;
  h.wpp.reagir = async (...a) => {
    travadoNoDisco = estado(h).trava === true;
    return reagirOriginal(...a);
  };
  msg(h, { content: 'trava' });
  await h.p.passoGrupo();
  assert.equal(travadoNoDisco, true);
});

test('F3.2 b. pedido -> "sim" solto sem agente no meio = aba do pedido (como hoje); mensagem do PROPRIO dono no meio nao atrapalha', async () => {
  const h = montar();
  abasOk(h);
  pedidoOk(h, { codigo: 'ABC234', sessionId: 'S1', providerMsgId: '3EB0A', messageId: 'uuid-a' });
  doAgente(h, { message_ts: iso(h.t - MIN - 1000) }); // aviso ANTES do pedido: nao conta
  pedidoNoGrupo(h, '3EB0A', 'uuid-a', iso(h.t - MIN + 2000));
  msg(h, { content: 'deixa eu ver uma coisa' }); // do dono, entre o pedido e o sim: vai pra central
  h.t += 1000;
  const sim = msg(h, { content: 'Sim' });
  await h.p.passoGrupo();
  assert.equal(h.enviados.length, 0, 'nenhuma frase');
  assert.deepEqual(h.entregas.map((x) => x.sessionId), ['SC', 'S1']);
  assert.equal(h.entregas[1].texto, 'Sim');
  assert.equal(h.entregas[1].nota, NOTA('ABC234'));
  assert.equal(h.entregas[1].providerMsgId, sim.provider_msg_id);

  // o pedido achado so pelo uuid (sem provider no lote) tambem vale
  const h2 = montar();
  abasOk(h2);
  pedidoOk(h2, { codigo: 'BCD345', sessionId: 'S2', providerMsgId: '3EB0B', messageId: 'uuid-b' });
  pedidoNoGrupo(h2, 'OUTRO-PROV', 'uuid-b', iso(h2.t - MIN + 2000));
  msg(h2, { content: 'pode' });
  await h2.p.passoGrupo();
  assert.deepEqual(h2.entregas.map((x) => [x.sessionId, x.nota]), [['S2', NOTA('BCD345')]]);
  assert.equal(h2.enviados.length, 0);
});

test('F3.2 c. mensagem do pedido fora do lote, hora ilegivel, agente com hora ilegivel, pedido que nao e dos agentes ou depois do sim = frase, sem repasse', async () => {
  const casos = {
    'pedido fora do lote lido': () => {},
    'hora do pedido ilegivel': (h) => pedidoNoGrupo(h, '3EB0A', 'uuid-a', 'ontem'),
    'hora do pedido ausente': (h) => pedidoNoGrupo(h, '3EB0A', 'uuid-a', null),
    'agente com hora ilegivel': (h) => {
      pedidoNoGrupo(h, '3EB0A', 'uuid-a', iso(h.t - MIN + 2000));
      doAgente(h, { message_ts: 'sem hora' });
    },
    'id do pedido em mensagem que nao e dos agentes': (h) => msg(h, {
      provider_msg_id: '3EB0A', id: 'uuid-a', from_me: false, sender_phone: '5511900000000', content: 'x', message_ts: iso(h.t - MIN + 2000),
    }),
    'mensagem do pedido depois do sim': (h) => pedidoNoGrupo(h, '3EB0A', 'uuid-a', iso(h.t + 5000)),
  };
  for (const [nome, preparar] of Object.entries(casos)) {
    const h = montar();
    abasOk(h);
    pedidoOk(h, { codigo: 'ABC234', sessionId: 'S1', providerMsgId: '3EB0A', messageId: 'uuid-a' });
    preparar(h);
    const sim = msg(h, { content: 'sim' });
    await h.p.passoGrupo();
    assert.equal(h.entregas.length, 0, nome);
    assert.deepEqual(h.enviados.map((x) => x.texto), [QUAL('sim', '16:00')], nome);
    assert.ok(estado(h).vistos.includes(sim.provider_msg_id), nome);
  }
});

test('F3.3 a. "trava" citando um aviso = trava ligada, 0 repasse; "trava o deploy" citando o aviso segue repasse', async () => {
  const h = montar();
  sessao(h, { sessionId: 'S1' });
  transcript(h, 'S1', [custom('Faro')]);
  await ligarRua(h);
  evento(h, parou(h, 'S1', { marcas: DECISAO }));
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 1); // aviso P1/U1
  msg(h, { content: 'trava o deploy', quoted_msg_id: 'P1' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 1, 'frase com mais coisa nao e o comando');
  assert.equal(estado(h).trava, false);

  const tr = msg(h, { content: 'trava', quoted_msg_id: 'P1' });
  await h.p.passoGrupo();
  assert.equal(estado(h).trava, true);
  assert.equal(h.entregas.length, 1, '0 repasse novo');
  assert.deepEqual(h.reacoes.at(-1), { messageId: tr.id, emoji: '✅' });
  assert.equal(h.enviados.at(-1).texto, TRAVADO_F);
});

test('F3.3 b. "Trava." citando um PEDIDO de OK e audio "Trava!" citando aviso = trava, 0 repasse', async () => {
  const h = montar();
  abasOk(h);
  pedidoOk(h, { codigo: 'ABC234', sessionId: 'S1', providerMsgId: '3EB0A', messageId: 'uuid-a' });
  pedidoNoGrupo(h, '3EB0A', 'uuid-a', iso(h.t - MIN + 2000));
  const tr = msg(h, { content: 'Trava.', quoted_msg_id: '3EB0A' });
  await h.p.passoGrupo();
  assert.equal(estado(h).trava, true);
  assert.equal(h.entregas.length, 0);
  assert.deepEqual(h.reacoes, [{ messageId: tr.id, emoji: '✅' }]);
  assert.deepEqual(h.enviados.map((x) => x.texto), [TRAVADO_F]);

  const h2 = montar();
  sessao(h2, { sessionId: 'S1' });
  transcript(h2, 'S1', [custom('Faro')]);
  await ligarRua(h2);
  evento(h2, parou(h2, 'S1', { marcas: DECISAO }));
  await h2.p.passoEventos();
  const au = msg(h2, { message_type: 'ptt', content: null, transcription: 'Trava!', quoted_msg_id: 'P1' });
  await h2.p.passoGrupo();
  assert.equal(estado(h2).trava, true);
  assert.equal(h2.entregas.length, 0);
  assert.deepEqual(h2.reacoes, [{ messageId: au.id, emoji: '✅' }]);
  assert.equal(h2.enviados.at(-1).texto, TRAVADO_F);
});

// F3.8
function tresAbas(h) {
  for (const [sid, nome, tit] of [['S1', 'repos-a', 'Alfa'], ['S2', 'repos-b', 'Beta'], ['S3', 'repos-c', 'Gama']]) {
    sessao(h, { sessionId: sid, name: nome });
    transcript(h, sid, [custom(tit)]);
  }
}
const tituloDoAviso = (texto) => /^ℹ️ \*(.+?)\*/.exec(texto)?.[1] ?? null; // F4g: icone + nome em negrito
const arqEventos = (h) => path.join(h.env.SESSOES_WPP_DIR, 'eventos.jsonl');
// byte logo depois de cada \n do arquivo, a partir de `desde`
function finsDeLinha(arq, desde) {
  const b = fs.readFileSync(arq);
  const out = [];
  for (let i = desde; i < b.length; i++) if (b[i] === 0x0a) out.push(i + 1);
  return out;
}
const porteiroNovo = (h) => criarPorteiro({
  wpp: h.wpp, numeroDono: NUMERO_DONO, mensageiro: h.mensageiro, ocioso: async () => h.idle, agora: () => h.t, env: h.env, abrirCentral: h.abrirCentral,
  avisarTelegram: h.avisarTelegram, central: h.central, raizesSessao: h.raizes,
});

test('F3.8 a. passo morre no meio do lote (2o envio lanca depois do 1o aviso): porteiro novo manda o 2 e o 3, e o 1 nao sai de novo', async () => {
  const h = montar();
  tresAbas(h);
  await ligarRua(h);
  for (const [sid, nome] of [['S1', 'repos-a'], ['S2', 'repos-b'], ['S3', 'repos-c']]) {
    evento(h, parou(h, sid, { nome, final: `Decisão da ${sid}?`, marcas: DECISAO }));
  }
  const real = h.wpp.enviarGrupo;
  let n = 0;
  h.wpp.enviarGrupo = async (texto, opts) => {
    n += 1;
    if (n === 2) throw new Error('processo morreu no meio do lote');
    return real(texto, opts);
  };
  await assert.rejects(h.p.passoEventos(), /morreu no meio do lote/);
  assert.deepEqual(h.enviados.map((x) => tituloDoAviso(x.texto)), ['Alfa']);

  h.wpp.enviarGrupo = real;
  const novo = porteiroNovo(h);
  await novo.passoEventos();
  assert.deepEqual(h.enviados.map((x) => tituloDoAviso(x.texto)), ['Alfa', 'Beta', 'Gama']);
  await novo.passoEventos();
  assert.equal(h.enviados.length, 3, 'nada em dobro');
  const e = estado(h);
  assert.equal(e.offsetEventos, fs.statSync(arqEventos(h)).size);
  assert.deepEqual([...new Set(Object.values(e.avisos).map((a) => a.sessionId))].sort(), ['S1', 'S2', 'S3']);
});

test('F3.8 b. offset salvo a cada evento (inclusive o pulado), em bytes (acento, \\r\\n), e = fim do lote no fim', async () => {
  const h = montar();
  tresAbas(h);
  await ligarRua(h);
  const arq = arqEventos(h);
  evento(h, { v: 1, tipo: 'pergunta-barrada', at: iso(h.t), sessionId: 'S1', perguntas: [] });
  await h.p.passoEventos();
  const inicio = fs.statSync(arq).size;
  assert.equal(estado(h).offsetEventos, inicio);
  // lote: parou S1 (acento) | pergunta-barrada (pulada) | parou S2 com \r\n | parou S3 | linha em branco
  fs.appendFileSync(arq, `${JSON.stringify(parou(h, 'S1', { nome: 'repos-a', final: 'Decisão? ação', marcas: DECISAO }))}\n`);
  fs.appendFileSync(arq, `${JSON.stringify({ v: 1, tipo: 'pergunta-barrada', at: iso(h.t), sessionId: 'S2', perguntas: [] })}\n`);
  fs.appendFileSync(arq, `${JSON.stringify(parou(h, 'S2', { nome: 'repos-b', final: 'Decisão da Beta?', marcas: DECISAO }))}\r\n`);
  fs.appendFileSync(arq, `${JSON.stringify(parou(h, 'S3', { nome: 'repos-c', final: 'Decisão da Gama?', marcas: DECISAO }))}\n`);
  fs.appendFileSync(arq, '   \n');
  const fins = finsDeLinha(arq, inicio);
  assert.equal(fins.length, 5);
  const noDisco = [];
  const real = h.wpp.enviarGrupo;
  h.wpp.enviarGrupo = async (texto, opts) => {
    noDisco.push(estado(h).offsetEventos); // o que um porteiro novo leria se este morresse agora
    return real(texto, opts);
  };
  await h.p.passoEventos();
  assert.deepEqual(h.enviados.map((x) => tituloDoAviso(x.texto)), ['Alfa', 'Beta', 'Gama']);
  assert.deepEqual(noDisco, [inicio, fins[1], fins[2]]);
  assert.equal(estado(h).offsetEventos, fs.statSync(arq).size, 'fim do lote = r.ate (inclui a linha em branco)');
  assert.equal(fins[4], fs.statSync(arq).size);
});

test('F3.8 c. envio falhou (sem lancar) no 2o e 3o avisos: a fila sai salva junto com o offset; porteiro novo manda da fila, sem dobrar', async () => {
  const h = montar();
  tresAbas(h);
  await ligarRua(h);
  for (const [sid, nome] of [['S1', 'repos-a'], ['S2', 'repos-b'], ['S3', 'repos-c']]) {
    evento(h, parou(h, sid, { nome, final: `Decisão da ${sid}?`, marcas: DECISAO }));
  }
  const real = h.wpp.enviarGrupo;
  let n = 0;
  h.wpp.enviarGrupo = async (texto, opts) => {
    n += 1;
    if (n >= 2) return { ok: false, erro: 'rede caiu' };
    return real(texto, opts);
  };
  await h.p.passoEventos();
  let e = estado(h);
  assert.equal(e.offsetEventos, fs.statSync(arqEventos(h)).size);
  assert.deepEqual(e.saida.map((x) => tituloDoAviso(x.texto)), ['Beta', 'Gama']);

  h.wpp.enviarGrupo = real;
  const novo = porteiroNovo(h);
  await novo.passoEventos();
  await novo.passoEventos();
  assert.deepEqual(h.enviados.map((x) => tituloDoAviso(x.texto)), ['Alfa', 'Beta', 'Gama']);
  e = estado(h);
  assert.equal(e.saida.length, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// D5c (fase 3, 27/09, PLANO.md F3.9/F3.10): central no terminal do Windows (entrypoint "cli"); "encaminhar" da central pra
// aba dona pelo porteiro (a resposta da aba volta pro grupo; caso real, fala sem citar da Loja Online);
// "abre central" no grupo e abrir sozinho.

// A central do teste (tests/lib/dados-central.mjs; o montar passa ela no `central`), como o abrir-central.vbs grava (-n,
// nameSource "user")
const CENTRAL_NOME = CENTRAL_TESTE.nome;
// Frases novas do D5c (escritas por extenso de proposito: o teste prende o texto).
const NAO_ACHEI_MSG = (x) => `${CAB}\nNão achei a mensagem pra passar pra ${x}.`;
const NAO_ACHEI_ABA = (x) => `${CAB}\nNão achei a aba ${x} aberta no PC.`;
const EH_A_CENTRAL = `${CAB}\nNão passei a mensagem: o destino era a própria central.`;
const AMBIGUO = (ts) => `${CAB}\nTem mais de uma sessão com esse nome: ${ts.join(', ')}. Manda de novo com o nome completo.`;
const CENTRAL_ABERTA = `${CAB}\nA central já está aberta.`;
const ABRINDO_CENTRAL = `${CAB}\nAbrindo a central no PC.`;
const CENTRAL_FALHOU = `${CAB}\nNão consegui abrir a central no PC.`;
// Frases novas do D6 (R2, 2a rodada do GPT-6): encaminhar repetido pro mesmo destino; central pedida que nao apareceu.
const JA_PASSADA = (x) => `${CAB}\nEssa mensagem já foi passada pra ${x}.`;
const CENTRAL_NAO_ABRIU = `${CAB}\nA central não abriu no PC. Tenta "abre central" de novo ou abre no PC.`;

function centralCli(h, sessionId = 'SC') {
  sessao(h, { sessionId, name: CENTRAL_NOME, nameSource: 'user', entrypoint: 'cli' });
  transcript(h, sessionId, [aiTitle('Conversa pelo WhatsApp')]); // o nome dado pelo -n vence o ai-title
}
// Aba fechada: o registro some da pasta.
function fecharSessao(h, sessionId) {
  for (const nome of fs.readdirSync(h.env.CLAUDE_SESSIONS_DIR)) {
    if (!/^\d+\.json$/.test(nome)) continue;
    const arq = path.join(h.env.CLAUDE_SESSIONS_DIR, nome);
    if (JSON.parse(fs.readFileSync(arq, 'utf8')).sessionId === sessionId) fs.unlinkSync(arq);
  }
}
const encaminhar = (h, o = {}) => evento(h, { v: 1, tipo: 'encaminhar', at: iso(h.t), para: 'Faro', providerMsgId: null, por: 'SC', ...o });
const linhasDoLog = (h, re) =>
  (fs.existsSync(h.env.SESSOES_WPP_LOG) ? fs.readFileSync(h.env.SESSOES_WPP_LOG, 'utf8') : '').split('\n').filter((l) => re.test(l));

// Fala sem citar vai pra central (entrega A); a dona e a aba Faro.
async function cenaEnc(h) {
  abaFaro(h);
  centralCli(h);
  const m = msg(h, { content: 'publica o site de novo' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 1);
  return { m, pedidoC: h.entregas[0] };
}

test('F3.9 sessao do terminal (cli) entra nas vivas e no status; sdk-cli e claude-desktop sem canal de recado nao; a central do terminal e achada pelo nome dado', async () => {
  const h = montar();
  abaFaro(h);
  centralCli(h);
  // um `claude -p` (o mensageiro, sdk-cli) nunca entra, nem com o titulo da central; o Claude Desktop sem canal de
  // recado (sem messagingSocketPath) tambem nao (F4i: com canal ele entra, no teste abaixo)
  sessao(h, { sessionId: 'M1', name: 'mensageiro', entrypoint: 'sdk-cli' });
  transcript(h, 'M1', [custom('Central de sessões de teste')]);
  sessao(h, { sessionId: 'D1', name: 'desktop', entrypoint: 'claude-desktop' });
  transcript(h, 'D1', [custom('Desktop')]);
  msg(h, { content: 'status' });
  await h.p.passoGrupo();
  assert.deepEqual(h.enviados.map((x) => x.texto), [`${CAB}\n- Faro (parada)\n- ${CENTRAL_NOME} (parada)\nModo rua: desligado`]);

  const m = msg(h, { content: 'bom dia' });
  await h.p.passoGrupo();
  assert.deepEqual(h.entregas, [{
    sessionId: 'SC', nome: CENTRAL_NOME, titulo: CENTRAL_NOME, texto: 'bom dia', audio: false, hora: '16:00',
    providerMsgId: m.provider_msg_id, messageId: m.id, anexos: [],
  }]);
  msg(h, { content: 'central: tudo certo?' }); // "Nome: texto" tambem acha a sessao do terminal
  await h.p.passoGrupo();
  assert.equal(h.entregas[1].sessionId, 'SC');
  assert.equal(h.entregas[1].texto, 'tudo certo?');
});

test('F4i aba do Claude Desktop COM canal de recado entra no status e no "Nome: texto"; o Desktop nunca vira a central, nem com o titulo dela', async () => {
  const h = montar();
  abaFaro(h);
  centralCli(h);
  // o Desktop grava o titulo dele no name (sem nameSource) e no custom-title do transcript
  sessao(h, { sessionId: 'DK', name: 'Teste Desktop', nameSource: undefined, entrypoint: 'claude-desktop', socket: '\\\\.\\pipe\\LOCAL\\cc-msg-ffff' });
  transcript(h, 'DK', [custom('Teste Desktop')], 'C--tmp-teste');
  msg(h, { content: 'status' });
  await h.p.passoGrupo();
  assert.deepEqual(h.enviados.map((x) => x.texto), [`${CAB}\n- Faro (parada)\n- ${CENTRAL_NOME} (parada)\n- Teste Desktop (parada)\nModo rua: desligado`]);
  msg(h, { content: 'Teste Desktop: me responde ok' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 1);
  assert.equal(h.entregas[0].sessionId, 'DK');
  assert.equal(h.entregas[0].nome, 'Teste Desktop');
  assert.equal(h.entregas[0].titulo, 'Teste Desktop');
  assert.equal(h.entregas[0].texto, 'me responde ok');

  // sem a central do terminal: um Desktop com o titulo da central NAO e a central (a fala solta nao vai pra ele)
  const h2 = montar();
  sessao(h2, { sessionId: 'DX', name: 'Central de sessões de teste', nameSource: undefined, entrypoint: 'claude-desktop', socket: '\\\\.\\pipe\\LOCAL\\cc-msg-gggg' });
  transcript(h2, 'DX', [custom('Central de sessões de teste')]);
  msg(h2, { content: 'bom dia' });
  await h2.p.passoGrupo();
  assert.deepEqual(h2.entregas.filter((x) => x.sessionId === 'DX'), [], 'a fala solta nunca vai pro Desktop com o titulo da central');
});

test('ENC feliz: fala entregue a central (A) -> central encaminha pra Faro -> entrega A-E1; resposta da Faro e da central no grupo, 1 vez cada', async () => {
  const h = montar();
  const { m, pedidoC } = await cenaEnc(h);
  const A = m.provider_msg_id;
  assert.equal(pedidoC.sessionId, 'SC');
  assert.equal(pedidoC.providerMsgId, A);
  assert.deepEqual(h.reacoes, [{ messageId: m.id, emoji: '✅' }]);
  h.t += 10 * 1000;
  transcript(h, 'SC', [peer(pedidoC, false, iso(h.t))]);
  h.t += 10 * 1000;
  encaminhar(h, { providerMsgId: A });
  const leituras = h.leituras;
  await h.p.passoEventos();
  assert.equal(h.leituras, leituras + 1, '1 leitura do grupo');
  assert.equal(h.entregas.length, 2);
  assert.deepEqual(h.entregas[1], {
    sessionId: 'S1', nome: 'projetos-42', titulo: 'Faro', texto: 'publica o site de novo', audio: false, hora: '16:00',
    providerMsgId: `${A}-E1`, messageId: m.id, anexos: [], encaminhado: true,
  });
  assert.match(montarRecado(h.entregas[1]), new RegExp(`^WhatsApp do dono \\(16:00, id ${A}-E1\\)`));
  assert.equal(h.reacoes.length, 1, 'sem reacao nova (a mensagem ja foi reagida)');
  assert.equal(h.enviados.length, 0);
  let e = estado(h);
  assert.equal(e.entregas[A].sessionId, 'SC', 'a entrega da central fica intacta');
  assert.equal(e.entregas[`${A}-E1`].sessionId, 'S1');

  // a Faro recebe o recado (id A-E1) e responde com a linha; a central fecha o turno dela
  h.t += 10 * 1000;
  transcript(h, 'S1', [peer(h.entregas[1], false, iso(h.t))]);
  h.t += 20 * 1000;
  const fimS = `${linha('16:00', 'publica o site de novo')}\nPubliquei.`;
  transcript(h, 'S1', [falaDaAba(fimS, iso(h.t))]);
  const rS = parou(h, 'S1', { final: fimS });
  evento(h, rS);
  h.t += 5 * 1000;
  const fimC = `${linha('16:00', 'publica o site de novo')}\nPassei pra Faro.`;
  transcript(h, 'SC', [falaDaAba(fimC, iso(h.t))]);
  const rC = parou(h, 'SC', { nome: CENTRAL_NOME, final: fimC });
  evento(h, rC);
  await h.p.passoEventos();
  assert.deepEqual(h.enviados.map((x) => x.texto), [
    montarResposta({ ...rS, titulo: 'Faro' }),
    montarResposta({ ...rC, titulo: CENTRAL_NOME }),
  ]);
  e = estado(h);
  assert.equal(e.entregas[A].respondida, true);
  assert.equal(e.entregas[`${A}-E1`].respondida, true);
  assert.equal(e.entregas[`${A}-E1`].conferido, true);
  h.t += 15 * MIN;
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 2, 'nada mais no grupo');
  assert.equal(h.entregas.length, 2, 'nada reentregue');

  // D6 (R2, achado 6b): a mesma fala encaminhada de novo pra MESMA aba (retry da central) nao sai de novo; 1 frase.
  // Outro destino continua gerando o id sintetico seguinte (R2 1, F3.7 7).
  encaminhar(h, { providerMsgId: A });
  await h.p.passoEventos();
  assert.equal(h.entregas.length, 2, 'retry pro mesmo destino nao vira 2a ordem');
  assert.deepEqual(h.enviados.slice(2).map((x) => x.texto), [JA_PASSADA('Faro')]);
});

test('ENC por que nao e a central viva (outra aba, sem por, central fechada) -> nada entregue, nada no grupo, grupo nem lido, 1 linha no log', async () => {
  const casos = {
    'outra aba': { por: 'S1' },
    'sem por': { por: null },
    'central fechada': { por: 'SC', antes: (h) => fecharSessao(h, 'SC') },
  };
  for (const [nome, c] of Object.entries(casos)) {
    const h = montar();
    const { m } = await cenaEnc(h);
    if (c.antes) c.antes(h);
    const leituras = h.leituras;
    h.t += 10 * 1000;
    encaminhar(h, { providerMsgId: m.provider_msg_id, por: c.por });
    await h.p.passoEventos();
    assert.equal(h.entregas.length, 1, nome);
    assert.equal(h.enviados.length, 0, nome);
    assert.equal(h.leituras, leituras, `${nome}: nao le o WhatsApp`);
    assert.equal(linhasDoLog(h, /encaminhar ignorado/).length, 1, nome);
    await h.p.passoEventos();
    assert.equal(linhasDoLog(h, /encaminhar ignorado/).length, 1, `${nome}: evento tratado 1 vez so`);
    assert.equal(h.entregas.length, 1, nome);
  }
});

test('ENC mensagem que nao e do dono, fora da leitura, com mais de 2 h, hora ilegivel ou audio sem transcricao -> frase, nada entregue', async () => {
  const casos = {
    'outro numero': (h) => msg(h, { content: 'publica', sender_phone: '5511900000000' }).provider_msg_id,
    'dos agentes (from_me)': (h) => msg(h, { content: 'publica', from_me: true, sent_by_agent: true, sender_phone: NUMERO_ROBO }).provider_msg_id,
    'numero do dono mas sent_by_agent': (h) => msg(h, { content: 'publica', sent_by_agent: true }).provider_msg_id,
    'id fora da leitura': (h) => {
      msg(h, { content: 'publica' });
      return 'PROV-NAO-EXISTE';
    },
    'mais de 2 h': (h) => {
      const id = msg(h, { content: 'publica' }).provider_msg_id;
      h.t += 2 * 60 * MIN + 1000;
      return id;
    },
    'hora ilegivel': (h) => msg(h, { content: 'publica', message_ts: 'ontem' }).provider_msg_id,
    'audio sem transcricao': (h) => msg(h, { message_type: 'ptt', transcription: '' }).provider_msg_id,
  };
  for (const [nome, preparar] of Object.entries(casos)) {
    const h = montar();
    abaFaro(h);
    centralCli(h);
    const id = preparar(h);
    encaminhar(h, { providerMsgId: id });
    await h.p.passoEventos();
    assert.equal(h.entregas.length, 0, nome);
    assert.deepEqual(h.enviados.map((x) => x.texto), [NAO_ACHEI_MSG('Faro')], nome);
  }
  // controle: a mesma fala do dono com 1h59 entrega
  const h = montar();
  abaFaro(h);
  centralCli(h);
  const m = msg(h, { content: 'publica' });
  h.t += 119 * MIN;
  encaminhar(h, { providerMsgId: m.provider_msg_id });
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 0);
  assert.deepEqual(h.entregas.map((x) => [x.sessionId, x.providerMsgId, x.texto]), [['S1', `${m.provider_msg_id}-E1`, 'publica']]);
});

// Uso real: print sem texto que a central passou pra aba do Fornecedor (pelo sessionId) virou "Não achei a
// mensagem pra passar pra <sessionId>..." — midia era barrada como "sem texto" e a frase mostrava o id cru.
test('ENC midia: imagem sem texto e com legenda vao como anexo; frase com sessionId mostra o titulo da aba', async () => {
  const h = montar();
  abaFaro(h);
  centralCli(h);
  const semTexto = msg(h, { message_type: 'image', content: null });
  encaminhar(h, { providerMsgId: semTexto.provider_msg_id, para: 'S1' });
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 0);
  assert.deepEqual(h.entregas.map((x) => [x.sessionId, x.texto, x.anexos]), [
    ['S1', '(mandou image sem texto)', [{ messageId: semTexto.id, tipo: 'image' }]],
  ]);
  h.t += 10 * 1000;
  const legenda = msg(h, { message_type: 'image', content: 'olha esse print' });
  encaminhar(h, { providerMsgId: legenda.provider_msg_id, para: 'S1' });
  await h.p.passoEventos();
  assert.deepEqual(h.entregas.at(-1).texto, 'olha esse print');
  assert.deepEqual(h.entregas.at(-1).anexos, [{ messageId: legenda.id, tipo: 'image' }]);

  encaminhar(h, { providerMsgId: 'PROV-NAO-EXISTE', para: 'S1' });
  await h.p.passoEventos();
  assert.deepEqual(h.enviados.map((x) => x.texto), [NAO_ACHEI_MSG('Faro')], 'titulo, nao o sessionId');
});

test('ENC destino: aba fechada ou inexistente, nome vazio, ambiguo, a propria central (nome, prefixo, sessionId) -> frase certa, nada entregue; sessionId exato entrega', async () => {
  const h = montar();
  abaFaro(h);
  for (const [sid, nome, tit] of [['S2', 'repos-a', 'Site Novo'], ['S3', 'repos-b', 'Site Velho']]) {
    sessao(h, { sessionId: sid, name: nome });
    transcript(h, sid, [custom(tit)]);
  }
  sessao(h, { sessionId: 'PO', name: 'repos-po' });
  transcript(h, 'PO', [custom('Loja Online')]);
  fecharSessao(h, 'PO'); // fechou no reinicio do PC (caso real 27/09 20:40)
  centralCli(h);
  const m = msg(h, { content: 'e a reserva?' });
  const casos = [
    ['Loja Online', NAO_ACHEI_ABA('Loja Online')],
    ['Nenhuma Assim', NAO_ACHEI_ABA('Nenhuma Assim')],
    ['?', NAO_ACHEI_ABA('?')],
    ['site', AMBIGUO(['Site Novo', 'Site Velho'])],
    [CENTRAL_NOME, EH_A_CENTRAL],
    ['central', EH_A_CENTRAL],
    ['SC', EH_A_CENTRAL],
  ];
  for (const [para, frase] of casos) {
    h.t += 61 * 1000; // 1 frase por janela de 60 s
    encaminhar(h, { providerMsgId: m.provider_msg_id, para });
    await h.p.passoEventos();
    assert.equal(h.enviados.at(-1)?.texto, frase, para);
    assert.equal(h.entregas.length, 0, para);
  }
  assert.equal(h.enviados.length, casos.length);
  encaminhar(h, { providerMsgId: m.provider_msg_id, para: 'S2' });
  await h.p.passoEventos();
  assert.deepEqual(h.entregas.map((x) => [x.sessionId, x.titulo, x.providerMsgId]), [['S2', 'Site Novo', `${m.provider_msg_id}-E1`]]);
  assert.equal(h.enviados.length, casos.length);
});

test('ENC CLI: encaminhar sem --para/--msg (ou vazio) = exit 1 com JSON de erro e nada gravado; certo = 1 evento com os campos, exit 0', () => {
  const raiz = pastaTemp('porteiro-enc-');
  const dir = path.join(raiz, 'estado');
  const base = { ...process.env, SESSOES_WPP_DIR: dir, SESSOES_WPP_LOG: path.join(raiz, 'l.log') };
  delete base.CLAUDE_CODE_SESSION_ID;
  const rodarCli = (args, env = base) => spawnSync(process.execPath, [PORTEIRO, 'encaminhar', ...args], { env, encoding: 'utf8' });
  const arq = path.join(dir, 'eventos.jsonl');
  const ruins = [
    [], ['--para', 'Faro'], ['--msg', 'PROV1'], ['--para', '', '--msg', 'PROV1'], ['--para', '  ', '--msg', 'PROV1'],
    ['--para', 'Faro', '--msg', ''], ['--para', '--msg', 'PROV1'], ['--para', 'Faro', '--msg'],
  ];
  for (const args of ruins) {
    const r = rodarCli(args);
    const nome = JSON.stringify(args);
    assert.equal(r.status, 1, nome);
    const j = JSON.parse(r.stdout.trim());
    assert.equal(j.ok, false, nome);
    assert.equal(typeof j.erro, 'string', nome);
    assert.equal(fs.existsSync(arq) ? fs.readFileSync(arq, 'utf8') : '', '', `${nome}: nada gravado`);
  }
  const antes = Date.now();
  let r = rodarCli(['--para', 'Loja Online', '--msg', '3EB0ABC'], { ...base, CLAUDE_CODE_SESSION_ID: 'sessao-central' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), ['{"ok":true}']);
  let evs = fs.readFileSync(arq, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(evs.length, 1);
  const { at, ...resto } = evs[0];
  assert.deepEqual(resto, { v: 1, tipo: 'encaminhar', para: 'Loja Online', providerMsgId: '3EB0ABC', por: 'sessao-central' });
  assert.ok(Date.parse(at) >= antes - 1000 && Date.parse(at) <= Date.now() + 1000, 'at = agora, ISO');
  // fora de uma sessao do Claude: por = null (o porteiro ignora)
  r = rodarCli(['--para', 'Faro', '--msg', '3EB0DEF']);
  assert.equal(r.status, 0, r.stderr);
  evs = fs.readFileSync(arq, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(evs.length, 2);
  assert.equal(evs[1].por, null);
  assert.equal(evs[1].para, 'Faro');
});

test('CENTRAL "abre central": viva -> "já está aberta", 0 aberturas; sem central -> 1 abertura + "Abrindo"; de novo antes de 2 min nao abre outra; erro -> frase de erro; travado -> frase de travado; ensaio nao abre', async () => {
  let h = montar();
  abaFaro(h);
  centralCli(h);
  msg(h, { content: 'Abre central' });
  await h.p.passoGrupo();
  assert.deepEqual(h.enviados.map((x) => x.texto), [CENTRAL_ABERTA]);
  assert.equal(h.aberturas, 0);
  assert.equal(h.entregas.length, 0, 'comando: nao vai pra central');

  h = montar();
  abaFaro(h);
  msg(h, { content: 'abrir central!' });
  await h.p.passoGrupo();
  assert.equal(h.aberturas, 1);
  assert.deepEqual(h.enviados.map((x) => x.texto), [ABRINDO_CENTRAL]);
  assert.equal(h.entregas.length, 0);
  assert.equal(estado(h).centralAbertaEm, iso(h.t));
  h.t += MIN; // a central ainda subindo (o registro nao apareceu)
  msg(h, { content: 'abre central' });
  await h.p.passoGrupo();
  assert.equal(h.aberturas, 1, 'nao abre 2a janela');
  assert.equal(h.enviados.at(-1).texto, ABRINDO_CENTRAL);
  h.t += MIN; // 2 min depois da abertura e ainda sem central
  msg(h, { content: 'abre central' });
  await h.p.passoGrupo();
  assert.equal(h.aberturas, 2);
  assert.equal(h.enviados.length, 3);

  h = montar();
  h.abrirFalha = 'wscript sumiu';
  msg(h, { content: 'abre central' });
  await h.p.passoGrupo();
  assert.equal(h.aberturas, 1);
  assert.deepEqual(h.enviados.map((x) => x.texto), [CENTRAL_FALHOU]);
  assert.equal(linhasDoLog(h, /abrir a central falhou/).length, 1);

  h = montar();
  msg(h, { content: 'trava' });
  await h.p.passoGrupo();
  h.t += 11 * MIN; // a frase de travado sai no maximo 1 vez a cada 10 min
  msg(h, { content: 'abre central' });
  await h.p.passoGrupo();
  assert.equal(h.aberturas, 0);
  assert.deepEqual(h.enviados.map((x) => x.texto), [TRAVADO_F, TRAVADO_F]);

  h = montar({ ensaio: true });
  msg(h, { content: 'abre central' });
  await h.p.passoGrupo();
  assert.equal(h.aberturas, 0, 'ensaio nunca abre');
  const acoes = fs.readFileSync(path.join(h.env.SESSOES_WPP_DIR, 'ensaio.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(acoes.map((a) => a.acao), ['abrirCentral', 'enviarGrupo']);
});

test('CENTRAL sozinho limite: 3 aberturas sem a central aparecer -> para (1 linha no log); "abre a central" religa; central viva zera a conta', async () => {
  const h = montar();
  abaFaro(h);
  const t0 = h.t;
  for (let i = 0; i < 6; i++) {
    h.t = t0 + i * 10 * MIN;
    await h.p.passoMinuto();
  }
  assert.equal(h.aberturas, 3, 'janela que nao vira central nao empilha a noite inteira');
  assert.equal(linhasDoLog(h, /parei de abrir sozinho/).length, 1);
  assert.equal(h.enviados.length, 0);

  msg(h, { content: 'Abre a central.' });
  await h.p.passoGrupo();
  assert.equal(h.aberturas, 4, 'o comando abre mesmo depois do limite');
  assert.equal(h.enviados.at(-1).texto, ABRINDO_CENTRAL);
  h.t += 10 * MIN;
  await h.p.passoMinuto();
  assert.equal(h.aberturas, 5, 'o comando religou o abrir sozinho');

  centralCli(h);
  h.t += 10 * MIN;
  await h.p.passoMinuto();
  assert.equal(estado(h).centralSozinho, 0, 'central viva zera a conta');
  assert.equal(h.aberturas, 5);
});

test('CENTRAL sozinho: sem central, passoMinuto em 0, 5, 10 e 12 min -> 2 aberturas (0 e 10), guardado no estado; central viva, ensaio ou travado -> 0', async () => {
  const h = montar();
  abaFaro(h);
  const t0 = h.t;
  await h.p.passoMinuto();
  assert.equal(h.aberturas, 1);
  assert.equal(estado(h).centralAbertaEm, iso(t0));
  h.t = t0 + 5 * MIN;
  await h.p.passoMinuto();
  assert.equal(h.aberturas, 1);
  h.t = t0 + 10 * MIN - 1000;
  await porteiroNovo(h).passoMinuto(); // porteiro religado le o centralAbertaEm do estado
  assert.equal(h.aberturas, 1);
  h.t = t0 + 10 * MIN;
  await h.p.passoMinuto();
  assert.equal(h.aberturas, 2);
  h.t = t0 + 12 * MIN;
  await h.p.passoMinuto();
  assert.equal(h.aberturas, 2);
  assert.equal(h.enviados.length, 0, 'abrir sozinho nao manda nada pro grupo');
  assert.equal(linhasDoLog(h, /abrindo a central/).length, 2);

  const viva = montar();
  centralCli(viva);
  for (let i = 0; i < 3; i++) {
    await viva.p.passoMinuto();
    viva.t += 10 * MIN;
  }
  assert.equal(viva.aberturas, 0);

  const ens = montar({ ensaio: true });
  for (let i = 0; i < 2; i++) {
    await ens.p.passoMinuto();
    ens.t += 10 * MIN;
  }
  assert.equal(ens.aberturas, 0);
  assert.equal(fs.existsSync(path.join(ens.env.SESSOES_WPP_DIR, 'ensaio.jsonl')), false, 'nem registra no ensaio');

  const tr = montar();
  msg(tr, { content: 'trava' });
  await tr.p.passoGrupo();
  for (let i = 0; i < 2; i++) {
    await tr.p.passoMinuto();
    tr.t += 10 * MIN;
  }
  assert.equal(tr.aberturas, 0, 'travado: nao abre sozinho');
});

// ---------------------------------------------------------------------------------------------------------------
// D5d1 (fase 3, 27/09, PLANO.md F3.7): leitura de 50 sem buraco calado; entrega fora do laco de leitura (fila propria,
// 1 em voo, resultado aplicado so no passoEntrega); porteiro que morre com entrega em voo; resposta da aba que passou
// antes de a entrega ser registrada (observacao do D5b1).

// Frase nova do F3.7 (escrita por extenso de proposito: o teste prende o texto).
const BURACO = (de, ate) => `${CAB}\nPosso ter perdido mensagens suas entre ${de} e ${ate}. Se mandou algo nesse intervalo, manda de novo.`;
const arqEstado = (h) => path.join(h.env.SESSOES_WPP_DIR, 'estado.json');
// Passo que NAO pode esperar o mensageiro: se ficar preso no duble segurado, falha em 2 s (e nao estoura o teste todo).
function semEsperar(promessa, nome) {
  let relogio;
  const limite = new Promise((_ok, nao) => { relogio = setTimeout(() => nao(new Error(`${nome} esperou o mensageiro`)), 2000); });
  return Promise.race([promessa, limite]).finally(() => clearTimeout(relogio));
}

test('F3.7 1. a leitura do grupo pede 50 mensagens', async () => {
  const h = montar();
  await h.p.passoGrupo();
  assert.deepEqual(h.limites, [50]);
});

test('F3.7 2. buraco: 50 mensagens todas depois do cursor -> 1 frase com as 2 horas; de novo (e com a janela mexida) -> 0; buraco novo -> 1; lote de 49 -> 0', async () => {
  const h = montar();
  h.t += 5 * MIN; // cursor da 1a subida = 16:00; as 50 chegam de 16:05 em diante (dos agentes: nenhuma e do dono)
  const inicio1 = h.t;
  for (let i = 0; i < 50; i++) {
    doAgente(h);
    h.t += 1000;
  }
  await h.p.passoGrupo();
  assert.deepEqual(h.enviados.map((x) => x.texto), [BURACO('16:00', '16:05')]);
  assert.deepEqual(estado(h).buraco, { de: iso(T0), ate: iso(inicio1), avisadoEm: iso(h.t) });
  await h.p.passoGrupo();
  assert.equal(h.enviados.length, 1, 'o mesmo buraco nao avisa de novo');
  doAgente(h, { content: BURACO('16:00', '16:05') }); // a propria frase entra no grupo e empurra a janela 1 mensagem
  await h.p.passoGrupo();
  assert.equal(h.enviados.length, 1, 'janela que ainda encosta no que ja foi lido nao e buraco novo');

  h.t += 10 * MIN; // porteiro sem ler 10 min e mais 50 no grupo: buraco novo, a partir da mais nova ja lida (16:05)
  const inicio2 = h.t;
  for (let i = 0; i < 50; i++) {
    doAgente(h);
    h.t += 1000;
  }
  await h.p.passoGrupo();
  assert.equal(h.enviados.length, 2);
  assert.equal(h.enviados[1].texto, BURACO('16:05', horaBRT(iso(inicio2))));
  assert.equal(horaBRT(iso(inicio2)), '16:15');
  const log = fs.readFileSync(h.env.SESSOES_WPP_LOG, 'utf8');
  assert.equal(log.split('\n').filter((l) => /aviso de buraco/.test(l)).length, 2);

  const h2 = montar();
  h2.t += 5 * MIN;
  for (let i = 0; i < 49; i++) {
    doAgente(h2);
    h2.t += 1000;
  }
  await h2.p.passoGrupo();
  assert.equal(h2.enviados.length, 0, 'lote nao cheio nunca avisa');
  assert.equal(estado(h2).buraco, null);

  // passo que morre no meio do lote (o buraco ja foi salvo com a 1a do dono; a leitura nao chegou ao fim): nao repete
  const h3 = montar();
  h3.t += 5 * MIN;
  for (let i = 0; i < 48; i++) {
    doAgente(h3);
    h3.t += 1000;
  }
  msg(h3, { content: 'status' });
  h3.t += 1000;
  msg(h3, { content: 'to na rua' });
  const reagirReal = h3.wpp.reagir;
  h3.wpp.reagir = async () => { throw new Error('whatsapp caiu no meio do lote'); };
  await assert.rejects(h3.p.passoGrupo(), /caiu no meio do lote/);
  h3.wpp.reagir = reagirReal;
  await h3.p.passoGrupo();
  assert.equal(h3.enviados.filter((x) => x.texto === BURACO('16:00', '16:05')).length, 1, 'o mesmo buraco, 1 vez');
  assert.equal(estado(h3).modoRua.motivo, 'dono', 'o resto do lote segue normal');
});

test('F3.7 3. entrega fora do laco: M1 em voo nao segura a leitura; M2 e lida e enfileirada; M1 so e aplicada no passoEntrega e so entao M2 sai', async () => {
  const h = montar();
  h.segurar = true;
  abaFaro(h);
  const t1 = h.t;
  const m1 = msg(h, { content: 'Faro: um' });
  await semEsperar(h.cru.passoGrupo(), 'passoGrupo');
  assert.equal(h.entregas.length, 0, 'o passoGrupo nao chama o mensageiro');
  assert.deepEqual(estado(h).filaEntrega.map((q) => q.pedido.providerMsgId), [m1.provider_msg_id]);
  assert.deepEqual(await semEsperar(h.cru.passoEntrega(), 'passoEntrega'), { emVoo: true, fila: 1 }, 'dispara e volta');
  assert.equal(h.entregas.length, 1);
  assert.equal(estado(h).filaEntrega[0].emVooDesde, iso(t1), 'marcado em voo no disco antes do mensageiro');

  h.t += 15 * 1000;
  const m2 = msg(h, { content: 'Faro: dois' });
  await semEsperar(h.cru.passoGrupo(), 'passoGrupo'); // M1 ainda no mensageiro
  let e = estado(h);
  assert.ok(e.vistos.includes(m2.provider_msg_id), 'M2 lida');
  assert.deepEqual(e.filaEntrega.map((q) => q.pedido.providerMsgId), [m1.provider_msg_id, m2.provider_msg_id], 'M2 enfileirada');
  await semEsperar(h.cru.passoEntrega(), 'passoEntrega');
  assert.equal(h.entregas.length, 1, '1 em voo por vez');

  h.presas.shift()(); // M1 volta "enviado"
  await tique();
  assert.deepEqual(h.reacoes, [], 'resultado so no passoEntrega');
  await semEsperar(h.cru.passoEntrega(), 'passoEntrega');
  assert.deepEqual(h.reacoes, [{ messageId: m1.id, emoji: '✅' }]);
  e = estado(h);
  assert.equal(e.entregas[m1.provider_msg_id].at, iso(t1));
  assert.equal(e.entregas[m1.provider_msg_id].sessionId, 'S1');
  assert.equal(h.entregas.length, 2, 'so entao M2 sai');
  assert.equal(h.entregas[1].providerMsgId, m2.provider_msg_id);
  assert.deepEqual(e.filaEntrega.map((q) => q.pedido.providerMsgId), [m2.provider_msg_id]);

  h.presas.shift()();
  await tique();
  assert.deepEqual(await h.cru.passoEntrega(), { emVoo: false, fila: 0 });
  assert.equal(estado(h).entregas[m2.provider_msg_id].sessionId, 'S1');
  assert.deepEqual(h.reacoes.map((x) => x.messageId), [m1.id, m2.id]);
});

test('F3.7 3b. trava com M1 em voo e M2 na fila: a fila some; o resultado de M1 e descartado; destravar nao entrega nada velho', async () => {
  const h = montar();
  h.segurar = true;
  abaFaro(h);
  const m1 = msg(h, { content: 'Faro: um' });
  await semEsperar(h.cru.passoGrupo(), 'passoGrupo');
  await semEsperar(h.cru.passoEntrega(), 'passoEntrega');
  h.t += 15 * 1000;
  msg(h, { content: 'Faro: dois' });
  await semEsperar(h.cru.passoGrupo(), 'passoGrupo');
  assert.equal(estado(h).filaEntrega.length, 2);
  h.t += 15 * 1000;
  const tr = msg(h, { content: 'trava' });
  await semEsperar(h.cru.passoGrupo(), 'passoGrupo');
  assert.deepEqual(estado(h).filaEntrega, [], 'trava limpa a fila de entrega');

  h.presas.shift()(); // M1 volta "enviado" depois da trava
  await tique();
  await semEsperar(h.cru.passoEntrega(), 'passoEntrega');
  assert.deepEqual(h.reacoes.map((x) => x.messageId), [tr.id], 'so a reacao da trava; M1 sem ✅');
  assert.equal(estado(h).entregas[m1.provider_msg_id], undefined, 'M1 nao vira entrega');

  assert.equal(destravar({ env: h.env }).ok, true);
  h.t += 15 * 1000;
  await semEsperar(h.cru.passoGrupo(), 'passoGrupo');
  await semEsperar(h.cru.passoEntrega(), 'passoEntrega');
  assert.equal(h.entregas.length, 1, 'nada velho sai depois de destravar');
});

test('F3.7 4. porteiro novo sobre estado com item em voo: recado ja na aba = registra sem reenviar; nao esta = reenvia; os 2 so depois de 3 min (claude -p orfao)', async () => {
  const h = montar();
  h.segurar = true;
  abaFaro(h);
  const t1 = h.t;
  const m = msg(h, { content: 'Faro: roda os testes' });
  await h.cru.passoGrupo();
  await semEsperar(h.cru.passoEntrega(), 'passoEntrega');
  const pedido = h.entregas[0];
  // o porteiro morre aqui; o claude -p dele seguiu e entregou o recado
  transcript(h, 'S1', [peer(pedido, false, iso(h.t + 2000))]);
  h.segurar = false;
  const novo = porteiroNovo(h);
  let e = estado(h);
  assert.deepEqual(e.filaEntrega, [], 'o item em voo saiu da fila');
  assert.equal(e.repassar.length, 1, 'virou nova tentativa depois de erro');
  h.t += MIN;
  await novo.passoGrupo();
  await bombear(novo);
  assert.equal(h.entregas.length, 1, 'antes de 3 min: nem confere, nem reenvia');
  assert.deepEqual(estado(h).entregas, {});
  h.t += 2 * MIN;
  await novo.passoGrupo();
  await bombear(novo);
  assert.equal(h.entregas.length, 1, 'recado ja na aba: nao reenvia');
  e = estado(h);
  assert.deepEqual(e.entregas[m.provider_msg_id].pedido, pedido);
  assert.equal(e.entregas[m.provider_msg_id].at, iso(t1), 'hora da 1a tentativa');
  assert.deepEqual(h.reacoes, [{ messageId: m.id, emoji: '✅' }]);
  assert.deepEqual([e.repassar, e.filaEntrega], [[], []]);
  assert.match(fs.readFileSync(h.env.SESSOES_WPP_LOG, 'utf8'), /em voo quando o porteiro parou/);

  const h2 = montar();
  h2.segurar = true;
  abaFaro(h2);
  const m2 = msg(h2, { content: 'Faro: roda os testes' });
  await h2.cru.passoGrupo();
  await semEsperar(h2.cru.passoEntrega(), 'passoEntrega');
  h2.segurar = false; // o porteiro morre e o recado NAO chegou na aba
  const novo2 = porteiroNovo(h2);
  h2.t += 3 * MIN;
  await novo2.passoGrupo();
  await bombear(novo2);
  assert.equal(h2.entregas.length, 2, 'recado nao esta na aba: reenvia');
  assert.deepEqual(h2.entregas[1], h2.entregas[0]);
  assert.equal(estado(h2).entregas[m2.provider_msg_id].at, iso(h2.t));
  assert.deepEqual(h2.reacoes, [{ messageId: m2.id, emoji: '✅' }]);
});

test('F3.7 5. o resultado do mensageiro so e aplicado pelo passoEntrega: resolvida a promessa, estado.json e reacoes nao mudam, nem com passoGrupo/passoEventos no meio', async () => {
  const h = montar();
  h.segurar = true;
  abaFaro(h);
  const m = msg(h, { content: 'Faro: roda os testes' });
  await h.cru.passoGrupo();
  await semEsperar(h.cru.passoEntrega(), 'passoEntrega');
  const antes = fs.readFileSync(arqEstado(h), 'utf8');
  h.presas.shift()(); // o mensageiro devolve "enviado"
  for (let i = 0; i < 5; i++) await tique();
  assert.equal(fs.readFileSync(arqEstado(h), 'utf8'), antes, 'a callback da promessa nao grava');
  assert.deepEqual(h.reacoes, []);
  h.t += 15 * 1000;
  await h.cru.passoGrupo();
  await h.cru.passoEventos();
  let e = estado(h);
  assert.deepEqual(e.entregas, {}, 'passoGrupo/passoEventos nao aplicam');
  assert.equal(e.filaEntrega.length, 1);
  assert.deepEqual(h.reacoes, []);
  await h.cru.passoEntrega();
  e = estado(h);
  assert.deepEqual(e.filaEntrega, []);
  assert.equal(e.entregas[m.provider_msg_id].sessionId, 'S1');
  assert.deepEqual(h.reacoes, [{ messageId: m.id, emoji: '✅' }]);
});

test('F3.7 6. erro do mensageiro e a aba responde antes da nova tentativa: ela acha o recado, registra e manda a resposta pro grupo 1 vez; parou de antes do recado nao serve', async () => {
  const h = montar({ respostasEntrega: [{ status: 'erro', detalhe: 'timeout 120 s' }] });
  abaFaro(h);
  const inicio = h.t;
  const m = msg(h, { content: 'Faro: roda os testes' });
  await h.p.passoGrupo(); // erro: nova tentativa no proximo passoGrupo
  const pedido = h.entregas[0];
  h.t += 10 * 1000;
  transcript(h, 'S1', [peer(pedido, false, iso(h.t))]); // o claude -p estourou o tempo DEPOIS de mandar
  h.t += 20 * 1000;
  const fim = `${linha('16:00', 'roda os testes')}\n12 verdes.`;
  transcript(h, 'S1', [falaDaAba(fim, iso(h.t))]);
  const r = parou(h, 'S1', { final: fim });
  evento(h, r);
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 0, 'sem entrega registrada ainda: o parou passa sem resposta');
  h.t += 5 * 1000;
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 1, 'nao reenvia');
  assert.deepEqual(h.enviados.map((x) => x.texto), [montarResposta({ ...r, titulo: 'Faro' })]);
  let x = estado(h).entregas[m.provider_msg_id];
  assert.equal(x.at, iso(inicio));
  assert.equal(x.respondida, true);
  h.t += MIN;
  await h.p.passoEventos();
  assert.equal(estado(h).entregas[m.provider_msg_id].conferido, true, 'a linha veio na resposta: conferido, sem reforco');
  evento(h, parou(h, 'S1', { final: 'outra coisa' }));
  await h.p.passoEventos();
  await h.p.passoGrupo();
  assert.equal(h.enviados.length, 1, '1 vez so');
  assert.equal(h.entregas.length, 1);

  const h2 = montar({ respostasEntrega: [{ status: 'erro', detalhe: 'timeout 120 s' }] });
  abaFaro(h2);
  const m2 = msg(h2, { content: 'Faro: roda os testes' });
  await h2.p.passoGrupo();
  const p2 = h2.entregas[0];
  h2.t += 10 * 1000;
  const velho = parou(h2, 'S1', { final: 'Terminei outra coisa.' }); // fala final ANTES do recado entrar
  h2.t += 10 * 1000;
  transcript(h2, 'S1', [peer(p2, false, iso(h2.t))]);
  evento(h2, { ...velho, at: iso(h2.t + 500) });
  await h2.p.passoEventos();
  h2.t += 5 * 1000;
  await h2.p.passoGrupo();
  assert.equal(h2.entregas.length, 1, 'nao reenvia');
  assert.equal(h2.enviados.length, 0, 'parou de antes do recado nao e a resposta');
  x = estado(h2).entregas[m2.provider_msg_id];
  assert.ok(x && !x.respondida);
  h2.t += 30 * 1000;
  const fim2 = `${linha('16:00', 'roda os testes')}\nFeito.`;
  transcript(h2, 'S1', [falaDaAba(fim2, iso(h2.t))]);
  const r2 = parou(h2, 'S1', { final: fim2 });
  evento(h2, r2);
  await h2.p.passoEventos();
  assert.deepEqual(h2.enviados.map((y) => y.texto), [montarResposta({ ...r2, titulo: 'Faro' })], 'espera o proximo, como hoje');
});

// Mesmo buraco da observacao do D5b1, aberto pelo proprio F3.7: com o mensageiro fora do laco, o passoEventos roda
// enquanto o claude -p ainda nao devolveu "enviado" e o parou da resposta pode passar antes de a entrega existir.
test('F3.7 6b. a aba responde com o mensageiro ainda em voo: aplicado o "enviado", a resposta vai pro grupo 1 vez; se o parou ja saiu como aviso, nao repete', async () => {
  const h = montar();
  h.segurar = true;
  abaFaro(h);
  const m = msg(h, { content: 'Faro: roda os testes' });
  await h.cru.passoGrupo();
  await semEsperar(h.cru.passoEntrega(), 'passoEntrega');
  h.t += 5 * 1000;
  transcript(h, 'S1', [peer(h.entregas[0], false, iso(h.t))]);
  h.t += 20 * 1000;
  const fim = `${linha('16:00', 'roda os testes')}\nFeito.`;
  transcript(h, 'S1', [falaDaAba(fim, iso(h.t))]);
  const r = parou(h, 'S1', { final: fim });
  evento(h, r);
  await semEsperar(h.cru.passoEventos(), 'passoEventos'); // o laco segue lendo eventos com o claude -p rodando
  assert.equal(h.enviados.length, 0);
  h.presas.shift()();
  await tique();
  await h.cru.passoEntrega();
  assert.deepEqual(h.enviados.map((x) => x.texto), [montarResposta({ ...r, titulo: 'Faro' })]);
  assert.equal(estado(h).entregas[m.provider_msg_id].respondida, true);
  assert.deepEqual(h.reacoes, [{ messageId: m.id, emoji: '✅' }]);
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 1);

  const h2 = montar();
  h2.segurar = true;
  abaFaro(h2);
  await ligarRua(h2);
  const m2 = msg(h2, { content: 'Faro: publica?' });
  await h2.cru.passoGrupo();
  await semEsperar(h2.cru.passoEntrega(), 'passoEntrega');
  h2.t += 5 * 1000;
  transcript(h2, 'S1', [peer(h2.entregas[0], false, iso(h2.t))]);
  h2.t += 20 * 1000;
  const a = parou(h2, 'S1', { final: `${linha('16:00', 'publica?')}\nPronto. DECISAO: publico agora?`, marcas: DECISAO });
  evento(h2, a);
  await h2.cru.passoEventos();
  assert.deepEqual(h2.enviados.map((x) => x.texto), [montarAviso({ ...a, titulo: 'Faro' })], 'modo rua: sai como aviso, com a mensagem final');
  h2.presas.shift()();
  await tique();
  await h2.cru.passoEntrega();
  assert.equal(h2.enviados.length, 1, 'a mensagem final ja foi no aviso: nao repete como resposta');
  assert.equal(estado(h2).entregas[m2.provider_msg_id].respondida, true);
});

// D6 (R2, achado 6b): contrato mudou. Antes: 2 encaminhar da mesma fala pro mesmo destino = -E1 e -E2 (a aba recebia a
// ordem 2 vezes). Agora: mesmo destino = 1 entrega + "já foi passada"; destino diferente = -E1 e -E2.
test('F3.7 7. encaminhar passa pela fila: 2 encaminhar seguidos da mesma fala pro MESMO destino com o 1o ainda na fila -> 1 na fila (pedido inteiro) + 1 frase; em voo tambem conta; destino diferente -> -E1 e -E2; sem ✅ novo', async () => {
  const h = montar();
  const { m } = await cenaEnc(h);
  sessao(h, { sessionId: 'S2', name: 'repos-f3' });
  transcript(h, 'S2', [custom('Brain')]);
  const A = m.provider_msg_id;
  assert.equal(h.reacoes.length, 1);
  h.segurar = true;
  h.t += 10 * 1000;
  encaminhar(h, { providerMsgId: A });
  h.t += 1000;
  encaminhar(h, { providerMsgId: A });
  await semEsperar(h.cru.passoEventos(), 'passoEventos');
  assert.equal(h.entregas.length, 1, 'o passoEventos nao chama o mensageiro');
  const fila = estado(h).filaEntrega;
  assert.deepEqual(fila.map((q) => q.pedido.providerMsgId), [`${A}-E1`], 'o 2o pro mesmo destino nao entra na fila');
  assert.deepEqual(fila[0].pedido, {
    sessionId: 'S1', nome: 'projetos-42', titulo: 'Faro', texto: 'publica o site de novo', audio: false, hora: '16:00',
    providerMsgId: `${A}-E1`, messageId: m.id, anexos: [], encaminhado: true,
  });
  assert.deepEqual(h.enviados.map((x) => x.texto), [JA_PASSADA('Faro')]);
  await semEsperar(h.cru.passoEntrega(), 'passoEntrega'); // E1 em voo
  h.t += 1000;
  encaminhar(h, { providerMsgId: A });
  await h.cru.passoEventos();
  assert.deepEqual(estado(h).filaEntrega.map((q) => q.pedido.providerMsgId), [`${A}-E1`], 'em voo tambem conta');
  assert.deepEqual(h.enviados.map((x) => x.texto), [JA_PASSADA('Faro'), JA_PASSADA('Faro')]);
  h.t += 1000;
  encaminhar(h, { providerMsgId: A, para: 'Brain' });
  await h.cru.passoEventos();
  assert.equal(estado(h).filaEntrega.at(-1).pedido.providerMsgId, `${A}-E2`, 'destino diferente = entrega nova');
  h.segurar = false;
  h.presas.shift()();
  await bombear(h.cru);
  assert.deepEqual(h.entregas.slice(1).map((x) => [x.providerMsgId, x.sessionId]), [[`${A}-E1`, 'S1'], [`${A}-E2`, 'S2']]);
  assert.equal(h.reacoes.length, 1, 'sem ✅ novo');
  assert.equal(h.enviados.length, 2);
  const e = estado(h);
  assert.equal(e.entregas[`${A}-E1`].sessionId, 'S1');
  assert.equal(e.entregas[`${A}-E2`].sessionId, 'S2');
  assert.equal(e.entregas[A].sessionId, 'SC', 'a entrega da central fica intacta');
});

// ---------------------------------------------------------------------------------------------------------------
// D5d2 (fase 3, 27/09, PLANO.md F3.11): saude do canal. 10 min sem conseguir ler (ou mandar, com item esperando) no
// WhatsApp = aviso no Telegram pelo portao de saude (1 na queda, no maximo 1 a cada 60 min, 1 na volta); com o
// canal quebrado o passoMinuto para de renovar o modoRua.atualizadoEm (os hooks veem o modo rua velho e os botoes voltam).
// O portao NUNCA e chamado de verdade: fetch e `reg query` sao dubles, e a URL e ficticia.

const PORTAO = 'https://painel.exemplo.invalid/tg/chave-de-teste';
// A1: o chat do aviso vem do config.json (chatId); os testes de antes usam o chat de antes (o teste A1 9 usa o real)
// A5a: a variavel do portao vem do config.json (saude.varUrl); aqui o nome sintetico SAUDE_TESTE_URL. Sem maquina = pc
const VAR_PORTAO = 'SAUDE_TESTE_URL';
const criarAvisoTelegram = (o = {}) => criarAvisoReal({ chatId: 700100200, varUrl: VAR_PORTAO, ...o });
const CAB_TG = '*sessoes-wpp (pc)*';
// Textos do aviso (escritos por extenso de proposito: o teste prende o texto).
const TG = {
  leitura: (h) => `O porteiro do WhatsApp não consegue ler o grupo desde ${h}. Pelo WhatsApp nada chega nas abas; no PC tudo segue normal.`,
  leituraContinua: (h) => `O porteiro do WhatsApp continua sem conseguir ler o grupo (desde ${h}). Pelo WhatsApp nada chega nas abas; no PC tudo segue normal.`,
  envio: (h) => `O porteiro do WhatsApp não consegue mandar mensagem no grupo desde ${h}. Os avisos e as respostas das abas não chegam no seu WhatsApp; no PC tudo segue normal.`,
  voltou: (h) => `O porteiro do WhatsApp voltou a funcionar às ${h}.`,
};
const HEADERS_TG = {
  'Content-Type': 'application/json',
  'User-Agent': 'sessoes-wpp/1.0 (pc)',
  'X-Fonte': 'sessoes-wpp',
  'X-Maquina': 'pc',
  'X-Severidade': 'warn',
};

// Porteiro com o aviso real (criarAvisoTelegram) sobre um fetch duble. `h.tg.chamadas` = cada POST (url, init, corpo);
// `h.tg.falhar` = 'lanca' (rede caiu) | 'http' (portao devolveu 502) | null.
function montarSaude(o = {}) {
  const tg = { chamadas: [], falhar: null, log: [], reg: 0 };
  const fetchTg = async (url, init) => {
    tg.chamadas.push({ url, init, corpo: JSON.parse(init.body) });
    if (tg.falhar === 'lanca') throw new Error('portao fora do ar');
    if (tg.falhar === 'http') return { ok: false, status: 502 };
    return { ok: true, status: 200 };
  };
  const avisarTelegram = o.avisarTelegram ?? criarAvisoTelegram({
    env: o.envTg ?? { [VAR_PORTAO]: PORTAO },
    fetch: fetchTg,
    lerRegistro: async () => { tg.reg += 1; return o.regTg ?? null; },
    log: (m) => tg.log.push(m),
  });
  const h = montar({ ...o, avisarTelegram });
  h.tg = tg;
  return h;
}
const textosTg = (h) => h.tg.chamadas.map((c) => c.corpo.text);
const lerQuebrado = (h) => { h.wpp.lerGrupo = async () => { throw new Error('read: HTTP 502'); }; };

test('F3.11 1. leitura falhando: 9 min -> 0 avisos; 10 min -> 1 (texto, URL e headers do portao); 30 -> 1; 70 -> 2; voltou -> 1 "voltou"; depois nada; nada no grupo', async () => {
  const h = montarSaude();
  const t0 = h.t;
  const real = h.wpp.lerGrupo;
  lerQuebrado(h);
  await assert.rejects(h.p.passoGrupo(), /HTTP 502/);
  assert.equal(estado(h).saude.leituraFalhaDesde, iso(t0), 'a 1a falha marca o desde');
  const marcos = {};
  for (let m = 1; m <= 70; m++) {
    h.t = t0 + m * MIN;
    await assert.rejects(h.p.passoGrupo(), /HTTP 502/);
    await h.p.passoMinuto();
    marcos[m] = h.tg.chamadas.length;
  }
  assert.equal(estado(h).saude.leituraFalhaDesde, iso(t0), 'falha seguida nao mexe no desde');
  assert.equal(marcos[9], 0, '9 min: ainda nao');
  assert.equal(marcos[10], 1, '10 min: 1 aviso');
  assert.equal(marcos[30], 1, '30 min: ainda 1');
  assert.equal(marcos[69], 1);
  assert.equal(marcos[70], 2, '70 min: 60 min depois do 1o, o 2o');
  const c = h.tg.chamadas[0];
  assert.equal(c.url, `${PORTAO}/sendMessage`);
  assert.equal(c.init.method, 'POST');
  assert.deepEqual(c.init.headers, HEADERS_TG);
  assert.deepEqual(c.corpo, { chat_id: 700100200, text: `${CAB_TG}\n${TG.leitura('16:00')}`, parse_mode: 'Markdown' });
  assert.ok(c.init.signal, 'com prazo (15 s)');
  assert.equal(h.tg.chamadas[1].corpo.text, `${CAB_TG}\n${TG.leituraContinua('16:00')}`);
  assert.equal(estado(h).saude.quebrado, true);

  h.wpp.lerGrupo = real;
  h.t = t0 + 71 * MIN;
  await h.p.passoGrupo();
  assert.equal(estado(h).saude.leituraFalhaDesde, null, 'leitura ok zera a falha');
  assert.equal(estado(h).saude.leituraOkEm, iso(h.t));
  await h.p.passoMinuto();
  assert.deepEqual(textosTg(h).slice(2), [`${CAB_TG}\n${TG.voltou('17:11')}`]);
  for (let m = 72; m <= 140; m++) {
    h.t = t0 + m * MIN;
    await h.p.passoGrupo();
    await h.p.passoMinuto();
  }
  assert.equal(h.tg.chamadas.length, 3, 'depois da volta, nada');
  assert.equal(estado(h).saude.quebrado, false);
  assert.equal(h.enviados.length, 0, 'nada vai pro grupo do WhatsApp sobre isso');
  assert.equal(h.tg.log.some((l) => l.includes('chave-de-teste')), false, 'log sem a chave do portao');
});

test('F3.11 2. envio falhando (erro de transporte) 10 min com item na fila -> 1 aviso de envio; rate_limit e voice_gate por 15 min -> 0 avisos', async () => {
  const h = montarSaude();
  const t0 = h.t;
  h.wpp.enviarGrupo = async (texto, opts) => {
    h.enviados.push({ texto, opts });
    return { ok: false, erro: 'send: HTTP 503' };
  };
  msg(h, { content: 'status' });
  await h.p.passoGrupo();
  let e = estado(h);
  assert.equal(e.saida.length, 1, 'a resposta do status espera na fila');
  assert.equal(e.saude.envioFalhaDesde, iso(t0));
  h.t = t0 + 9 * MIN;
  await h.p.passoMinuto();
  assert.equal(h.tg.chamadas.length, 0);
  h.t = t0 + 10 * MIN;
  await h.p.passoMinuto();
  assert.deepEqual(textosTg(h), [`${CAB_TG}\n${TG.envio('16:00')}`]);
  assert.equal(h.enviados.length, 1, 'o aviso nao passa pelo grupo');

  // rate_limit e voice_gate: o canal respondeu e recusou o texto. Nao e falha de canal.
  const h2 = montarSaude();
  const t2 = h2.t;
  let n = 0;
  h2.wpp.enviarGrupo = async (texto, opts) => {
    h2.enviados.push({ texto, opts });
    n += 1;
    return n % 2 ? { ok: false, erro: 'rate_limit' } : { ok: false, bloqueio: 'voice_gate', violacoes: [{ id: 'travessao' }] };
  };
  for (let m = 0; m <= 15; m++) {
    h2.t = t2 + m * MIN;
    msg(h2, { content: 'status' });
    await h2.p.passoGrupo();
    await h2.p.passoMinuto();
  }
  e = estado(h2);
  assert.ok(n >= 15, 'tentou mandar o tempo todo');
  assert.ok(e.saida.length > 0, 'com item esperando (o rate_limit segura o 1o da fila)');
  assert.equal(h2.tg.chamadas.length, 0);
  assert.equal(e.saude.envioFalhaDesde, null);
  assert.equal(e.saude.quebrado, false);
  assert.equal(e.modoRua.atualizadoEm, iso(h2.t), 'canal ok: o minuto segue renovando');
});

// D6 (R2, achado 10): contrato mudou. Antes: a fila desistia do item em ~1 min (4 tentativas) e esvaziava. Agora o item
// fica na fila ate sair (ou 2 h: R2 2, onde tambem esta o "fila vazia nao e voltou").
test('F3.11 2b. envio falhando sem parar: o item segue na fila (nao desiste), o 2o espera atras dele, e 10 min depois da 1a falha entra em quebrado; sem "voltou" enquanto falha; "to na rua" nao renova; envio ok -> os 3 saem, 1 vez cada, e "voltou"', async () => {
  const h = montarSaude();
  const t0 = h.t;
  const real = h.wpp.enviarGrupo;
  h.wpp.enviarGrupo = async (texto, opts) => {
    h.enviados.push({ texto, opts });
    return { ok: false, erro: 'send: fetch failed' };
  };
  const insistir = async () => {
    for (let i = 0; i < 4; i++) {
      h.t += 15 * 1000;
      await h.p.passoGrupo();
    }
  };
  msg(h, { content: 'status' });
  await h.p.passoGrupo();
  await insistir();
  assert.deepEqual(estado(h).saida.map((x) => x.falhas), [5], 'nao desistiu depois de 4 tentativas');
  h.t = t0 + 5 * MIN;
  await h.p.passoMinuto();
  const renovadoEm = estado(h).modoRua.atualizadoEm;
  assert.equal(renovadoEm, iso(h.t));

  h.t = t0 + 10 * MIN + 30 * 1000;
  msg(h, { content: 'status' });
  await h.p.passoGrupo();
  await insistir();
  assert.equal(estado(h).saida.length, 2, 'o 2o espera atras do 1o');
  h.t = t0 + 12 * MIN;
  await h.p.passoMinuto();
  assert.deepEqual(textosTg(h), [`${CAB_TG}\n${TG.envio('16:00')}`], 'item esperando e falhando 10 min depois da 1a falha');
  for (let m = 13; m <= 18; m++) {
    h.t = t0 + m * MIN;
    await h.p.passoMinuto();
  }
  assert.equal(h.tg.chamadas.length, 1, 'sem "voltou" enquanto o envio falha');
  assert.equal(estado(h).modoRua.atualizadoEm, renovadoEm, 'quebrado: o minuto nao renova');

  h.t = t0 + 19 * MIN;
  msg(h, { content: 'to na rua' });
  await h.p.passoGrupo();
  let e = estado(h);
  assert.equal(e.modoRua.ligado, true);
  assert.equal(e.modoRua.atualizadoEm, renovadoEm, '"to na rua" com o canal quebrado tambem nao renova');
  assert.equal(lib.lerModoRua(h.env.SESSOES_WPP_DIR, h.t).efetivo, false, 'botoes seguem nas abas');

  const antes = h.enviados.length;
  h.wpp.enviarGrupo = real;
  h.t = t0 + 20 * MIN;
  msg(h, { content: 'status' });
  await h.p.passoGrupo();
  e = estado(h);
  assert.equal(e.saida.length, 0);
  assert.equal(h.enviados.length - antes, 3, 'os 2 que esperavam e o novo, 1 vez cada');
  assert.equal(e.saude.envioFalhaDesde, null, 'envio ok zera a falha');
  assert.equal(e.saude.envioOkEm, iso(h.t));
  await h.p.passoMinuto();
  assert.deepEqual(textosTg(h).slice(1), [`${CAB_TG}\n${TG.voltou('16:20')}`]);
  assert.equal(lib.lerModoRua(h.env.SESSOES_WPP_DIR, h.t).efetivo, true, 'canal de volta: modo rua fresco de novo');
});

test('F3.11 3. canal quebrado: o passoMinuto para de renovar atualizadoEm e em 5 min o hook (lib.lerModoRua) ve o modo rua velho; canal de volta: renova e o hook ve fresco', async () => {
  const h = montarSaude();
  await ligarRua(h);
  const t0 = h.t;
  const real = h.wpp.lerGrupo;
  lerQuebrado(h);
  await assert.rejects(h.p.passoGrupo());
  for (let m = 1; m <= 9; m++) {
    h.t = t0 + m * MIN;
    await assert.rejects(h.p.passoGrupo());
    await h.p.passoMinuto();
    assert.equal(estado(h).modoRua.atualizadoEm, iso(h.t), `${m} min: canal ainda nao quebrado, renova`);
  }
  const ultimo = t0 + 9 * MIN;
  for (let m = 10; m <= 15; m++) {
    h.t = t0 + m * MIN;
    await assert.rejects(h.p.passoGrupo());
    await h.p.passoMinuto();
    assert.equal(estado(h).modoRua.atualizadoEm, iso(ultimo), `${m} min: quebrado, nao renova`);
  }
  const dir = h.env.SESSOES_WPP_DIR;
  assert.deepEqual(lib.lerModoRua(dir, ultimo + 5 * MIN), { ligado: true, fresco: true, efetivo: true });
  assert.deepEqual(lib.lerModoRua(dir, t0 + 15 * MIN), { ligado: true, fresco: false, efetivo: false }, 'botoes voltam nas abas');

  h.wpp.lerGrupo = real;
  h.t = t0 + 16 * MIN;
  await h.p.passoGrupo();
  await h.p.passoMinuto();
  assert.equal(estado(h).modoRua.atualizadoEm, iso(h.t));
  assert.deepEqual(lib.lerModoRua(dir, h.t), { ligado: true, fresco: true, efetivo: true });
  assert.deepEqual(textosTg(h), [`${CAB_TG}\n${TG.leitura('16:00')}`, `${CAB_TG}\n${TG.voltou('16:16')}`]);
});

test('F3.11 4. sem a URL do portao (env e registro ausentes, ou fora de https + /tg/) -> 0 chamadas de rede, 1 linha "sem canal de aviso" no log; registro com URL boa -> usa ela', async () => {
  const rede = [];
  const linhas = [];
  let leuReg = 0;
  const fetchConta = async (url, init) => {
    rede.push({ url, init });
    return { ok: true, status: 200 };
  };
  const semNada = criarAvisoTelegram({ env: {}, fetch: fetchConta, lerRegistro: async () => { leuReg += 1; return null; }, log: (m) => linhas.push(m) });
  assert.equal(await semNada('qualquer'), false, 'sem canal nao conta como avisado');
  assert.equal(await semNada('de novo'), false);
  assert.equal(rede.length, 0);
  assert.equal(leuReg, 2, 'sem env, le o registro (processo nascido antes do setx)');
  assert.equal(linhas.length, 1);
  assert.match(linhas[0], /sem canal de aviso/);

  for (const ruim of ['http://painel.exemplo.invalid/tg/x', 'https://painel.exemplo.invalid/outra/x', '   ']) {
    const l = [];
    const f = criarAvisoTelegram({ env: { [VAR_PORTAO]: ruim }, fetch: fetchConta, lerRegistro: async () => ruim, log: (m) => l.push(m) });
    assert.equal(await f('x'), false, `recusa ${JSON.stringify(ruim)}`);
    assert.equal(l.filter((x) => /sem canal de aviso/.test(x)).length, 1);
  }
  assert.equal(rede.length, 0);

  const doReg = criarAvisoTelegram({ env: {}, fetch: fetchConta, lerRegistro: async () => `${PORTAO}/`, log: () => {} });
  assert.equal(await doReg('pelo registro'), true);
  assert.equal(rede.length, 1);
  assert.equal(rede[0].url, `${PORTAO}/sendMessage`, 'barra do fim sai');

  const saidaReg = '\r\nHKEY_CURRENT_USER\\Environment\r\n    SAUDE_TESTE_URL    REG_SZ    https://painel.exemplo.invalid/tg/abc\r\n\r\n';
  assert.equal(valorDoReg(saidaReg, VAR_PORTAO), 'https://painel.exemplo.invalid/tg/abc');
  assert.equal(valorDoReg(saidaReg), null, 'A5a: sem nome = null');
  assert.equal(valorDoReg('ERRO: O sistema nao conseguiu localizar a chave', VAR_PORTAO), null);

  // pelo porteiro: canal quebrado 30 min, sem canal de aviso = tenta todo minuto, 0 rede e 1 linha so
  const h = montarSaude({ envTg: {} });
  lerQuebrado(h);
  const t0 = h.t;
  for (let m = 0; m <= 30; m++) {
    h.t = t0 + m * MIN;
    await assert.rejects(h.p.passoGrupo());
    await h.p.passoMinuto();
  }
  assert.equal(h.tg.chamadas.length, 0);
  assert.equal(h.tg.reg, 21, 'tentou de 10 a 30 min (nenhum contou como avisado)');
  assert.equal(h.tg.log.length, 1);
  assert.match(h.tg.log[0], /sem canal de aviso/);
  assert.equal(estado(h).saude.avisoEm, null);
});

test('F3.11 5. ensaio: leitura falhando 70 min -> 0 avisos (nem o aviso nem a rede); so o registro no ensaio.jsonl', async () => {
  let chamou = 0;
  const h = montarSaude({ ensaio: true });
  const h2 =montarSaude({ ensaio: true, avisarTelegram: async () => { chamou += 1; return true; } });
  for (const x of [h, h2]) {
    lerQuebrado(x);
    const t0 = x.t;
    for (let m = 0; m <= 70; m++) {
      x.t = t0 + m * MIN;
      await assert.rejects(x.p.passoGrupo());
      await x.p.passoMinuto();
    }
    assert.equal(x.tg.chamadas.length, 0);
    assert.equal(x.enviados.length, 0);
    assert.equal(fs.existsSync(arqEstado(x)), false, 'ensaio nao cria o estado.json real');
    const reg = fs.readFileSync(path.join(x.env.SESSOES_WPP_DIR, 'ensaio.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(reg.filter((r) => r.acao === 'avisarTelegram').map((r) => r.texto), [TG.leitura('16:00'), TG.leituraContinua('16:00')]);
  }
  assert.equal(chamou, 0, 'ensaio nunca chama o aviso');
});

test('F3.11 6. portao falhou (fetch lanca, HTTP 502, pendurado alem do prazo, aviso injetado que lanca) -> nao conta como avisado; o proximo passo tenta de novo; deu certo -> para', async () => {
  assert.equal(AVISO_TIMEOUT_MS, 15000);
  const h = montarSaude();
  lerQuebrado(h);
  const t0 = h.t;
  await assert.rejects(h.p.passoGrupo());
  const minuto = async (m) => {
    h.t = t0 + m * MIN;
    await assert.rejects(h.p.passoGrupo());
    await h.p.passoMinuto();
  };
  h.tg.falhar = 'lanca';
  await minuto(10);
  assert.equal(h.tg.chamadas.length, 1);
  assert.equal(estado(h).saude.avisoEm, null, 'rede caiu: nao avisado');
  h.tg.falhar = 'http';
  await minuto(11);
  assert.equal(h.tg.chamadas.length, 2, 'tentou de novo no passo seguinte');
  assert.equal(estado(h).saude.avisoEm, null, 'HTTP 502: nao avisado');
  h.tg.falhar = null;
  await minuto(12);
  assert.equal(h.tg.chamadas.length, 3);
  assert.equal(estado(h).saude.avisoEm, iso(h.t));
  await minuto(13);
  assert.equal(h.tg.chamadas.length, 3, 'avisado: espera os 60 min');
  assert.deepEqual([...new Set(textosTg(h))], [`${CAB_TG}\n${TG.leitura('16:00')}`], 'a nova tentativa e o aviso da queda');
  assert.equal(h.tg.log.filter((l) => /falhou/.test(l)).length, 2);
  assert.equal(h.tg.log.some((l) => l.includes('chave-de-teste')), false);

  // portao pendurado: o prazo corta, nao conta, e o log nao leva a URL (a chave vai no caminho)
  const linhas = [];
  const pendurado = criarAvisoTelegram({
    env: { [VAR_PORTAO]: PORTAO },
    lerRegistro: async () => null,
    timeoutMs: 30,
    log: (m) => linhas.push(m),
    fetch: (url, init) => new Promise((_ok, nao) => {
      init.signal.addEventListener('abort', () => nao(Object.assign(new Error(`aborted ${url}/sendMessage`), { name: 'AbortError' })));
    }),
  });
  assert.equal(await pendurado('x'), false);
  assert.equal(linhas.length, 1);
  assert.match(linhas[0], /falhou/);
  assert.equal(linhas[0].includes('chave-de-teste'), false);

  // aviso injetado que lanca: o passoMinuto nao cai, nao conta, tenta no passo seguinte
  let tentativas = 0;
  const h2 = montarSaude({ avisarTelegram: async () => { tentativas += 1; if (tentativas === 1) throw new Error('portao explodiu'); return true; } });
  lerQuebrado(h2);
  const t2 = h2.t;
  await assert.rejects(h2.p.passoGrupo());
  h2.t = t2 + 10 * MIN;
  await h2.p.passoMinuto();
  assert.equal(estado(h2).saude.avisoEm, null);
  h2.t = t2 + 11 * MIN;
  await h2.p.passoMinuto();
  assert.equal(tentativas, 2);
  assert.equal(estado(h2).saude.avisoEm, iso(h2.t));
});

test('F3.11 7. travado: canal quebrado nao avisa; destravado e ainda quebrado -> avisa; porteiro religado nao herda o relogio de falha, mas herda a queda avisada e manda o "voltou"', async () => {
  const h = montarSaude();
  const t0 = h.t;
  msg(h, { content: 'trava' });
  await h.p.passoGrupo();
  assert.equal(estado(h).trava, true);
  lerQuebrado(h);
  for (let m = 1; m <= 20; m++) {
    h.t = t0 + m * MIN;
    await assert.rejects(h.p.passoGrupo());
    await h.p.passoMinuto();
  }
  assert.equal(h.tg.chamadas.length, 0, 'travado: nada sai do porteiro');
  destravar({ env: h.env, agora: () => h.t });
  h.t = t0 + 21 * MIN;
  await h.p.passoMinuto();
  assert.deepEqual(textosTg(h), [`${CAB_TG}\n${TG.leitura('16:01')}`]);

  const h2 = montarSaude();
  const real = h2.wpp.lerGrupo;
  lerQuebrado(h2);
  const t2 = h2.t;
  await assert.rejects(h2.p.passoGrupo());
  h2.t = t2 + 9 * MIN;
  let p = porteiroNovo(h2); // religado: ninguem tentou ler enquanto ele estava parado
  assert.equal(estado(h2).saude.leituraFalhaDesde, null);
  h2.t = t2 + 11 * MIN;
  await p.passoMinuto();
  assert.equal(h2.tg.chamadas.length, 0, 'sem o relogio de antes de subir');
  await assert.rejects(p.passoGrupo());
  h2.t = t2 + 20 * MIN;
  await p.passoMinuto();
  assert.equal(h2.tg.chamadas.length, 0);
  h2.t = t2 + 21 * MIN;
  await p.passoMinuto();
  assert.deepEqual(textosTg(h2), [`${CAB_TG}\n${TG.leitura('16:11')}`]);
  h2.t = t2 + 22 * MIN;
  p = porteiroNovo(h2);
  assert.equal(estado(h2).saude.quebrado, true, 'a queda avisada sobrevive ao religar');
  h2.t = t2 + 22 * MIN + 30 * 1000;
  await assert.rejects(p.passoGrupo());
  h2.t = t2 + 23 * MIN;
  await p.passoMinuto();
  assert.equal(h2.tg.chamadas.length, 1, 'religado e ainda sem ler: nada de "voltou" (relogio zerado nao e conserto)');
  assert.equal(estado(h2).saude.quebrado, true);
  h2.wpp.lerGrupo = real;
  h2.t = t2 + 24 * MIN;
  await p.passoGrupo();
  await p.passoMinuto();
  assert.deepEqual(textosTg(h2).slice(1), [`${CAB_TG}\n${TG.voltou('16:24')}`]);
});

// ---------------------------------------------------------------------------------------------------------------
// D6 (27/09 23:47): 2a rodada do GPT-6 (parecer C:/tmp/advisor-gpt-parecer-20260927-233430-a89d.md, triagem
// C:/tmp/advisor-gpt-triagem-20260927-233430.md, itens 6b, 10, 9, 13 e 8). Cada teste reproduz o achado; no codigo da
// base (52f7e21) os 5 falhavam. Nada real: processo, spawn, kill e Telegram sao dubles.

// Porteiro novo sobre o mesmo estado com opcoes a mais (abrirCentral real com spawn falso, processos, ensaio).
const porteiroCom = (h, extra = {}) => criarPorteiro({
  wpp: h.wpp, numeroDono: NUMERO_DONO, mensageiro: h.mensageiro, ocioso: async () => h.idle, agora: () => h.t, env: h.env, abrirCentral: h.abrirCentral,
  avisarTelegram: h.avisarTelegram, central: h.central, raizesSessao: h.raizes, ...extra,
});

test('R2 1. encaminhar repetido da mesma fala pro MESMO destino (entregue, ou esperando nova tentativa) = 0 entrega nova + 1 frase; pelo sessionId tambem; outro destino = -E1 e -E2', async () => {
  const h = montar();
  const { m } = await cenaEnc(h);
  const A = m.provider_msg_id;
  sessao(h, { sessionId: 'S2', name: 'repos-f3' });
  transcript(h, 'S2', [custom('Brain')]);
  h.t += 10 * 1000;
  encaminhar(h, { providerMsgId: A });
  await h.p.passoEventos();
  assert.deepEqual(h.entregas.slice(1).map((x) => [x.providerMsgId, x.sessionId]), [[`${A}-E1`, 'S1']]);
  assert.equal(h.enviados.length, 0);
  // a central repete (retry, outra hora): pelo titulo e pelo sessionId
  h.t += 30 * 1000;
  encaminhar(h, { providerMsgId: A });
  h.t += 1000;
  encaminhar(h, { providerMsgId: A, para: 'S1' });
  await h.p.passoEventos();
  assert.equal(h.entregas.length, 2, 'retry pro mesmo destino nao vira 2a ordem');
  assert.deepEqual(h.enviados.map((x) => x.texto), [JA_PASSADA('Faro'), JA_PASSADA('Faro')]);
  assert.equal(linhasDoLog(h, /ja foi passada/).length, 2);
  assert.deepEqual(Object.keys(estado(h).entregas).sort(), [A, `${A}-E1`]);
  // outro destino: entrega nova, id seguinte
  h.t += 1000;
  encaminhar(h, { providerMsgId: A, para: 'Brain' });
  await h.p.passoEventos();
  assert.deepEqual(h.entregas.slice(1).map((x) => [x.providerMsgId, x.sessionId]), [[`${A}-E1`, 'S1'], [`${A}-E2`, 'S2']]);
  assert.equal(h.enviados.length, 2);
  assert.equal(h.reacoes.length, 1, 'sem ✅ novo');

  // erro do mensageiro: a entrega espera a nova tentativa (e.repassar); o retry da central nao sai, a nova tentativa sai 1 vez
  const h2 = montar({ respostasEntrega: [{ status: 'enviado', detalhe: '' }, { status: 'erro', detalhe: 'timeout 120 s' }] });
  const { m: m2 } = await cenaEnc(h2);
  const B = m2.provider_msg_id;
  h2.t += 10 * 1000;
  encaminhar(h2, { providerMsgId: B });
  await h2.p.passoEventos();
  assert.equal(estado(h2).repassar.length, 1, 'erro: esperando a nova tentativa');
  h2.t += 1000;
  encaminhar(h2, { providerMsgId: B });
  await h2.p.passoEventos();
  assert.deepEqual(h2.enviados.map((x) => x.texto), [JA_PASSADA('Faro')]);
  h2.t += 5 * 1000;
  await h2.p.passoGrupo();
  assert.deepEqual(h2.entregas.slice(1).map((x) => x.providerMsgId), [`${B}-E1`, `${B}-E1`], 'so a nova tentativa do porteiro (mesmo id), nenhum -E2');
});

test('R2 2. erro de transporte no envio nao descarta a mensagem: 6 falhas e ela segue na fila; 10 min -> Telegram (envio); o envio volta -> sai 1 vez e "voltou"; 2 h na fila -> some com log "perdida" e fila vazia nao e "voltou"', async () => {
  const h = montarSaude();
  const t0 = h.t;
  const real = h.wpp.enviarGrupo;
  h.wpp.enviarGrupo = async (texto, opts) => {
    h.enviados.push({ texto, opts });
    return { ok: false, erro: 'send: fetch failed' };
  };
  msg(h, { content: 'status' });
  await h.p.passoGrupo();
  for (let i = 1; i <= 5; i++) {
    h.t = t0 + i * 15 * 1000;
    await h.p.passoGrupo();
  }
  assert.equal(h.enviados.length, 6, '6 tentativas');
  assert.deepEqual(estado(h).saida.map((x) => [x.tipo, x.falhas]), [['status', 6]], 'segue na fila, com as falhas contadas');
  h.t = t0 + 9 * MIN;
  await h.p.passoGrupo();
  await h.p.passoMinuto();
  assert.equal(h.tg.chamadas.length, 0, '9 min: ainda nao');
  h.t = t0 + 10 * MIN;
  await h.p.passoGrupo();
  await h.p.passoMinuto();
  assert.deepEqual(textosTg(h), [`${CAB_TG}\n${TG.envio('16:00')}`], 'item esperando 10 min: a F3.11 avisa');
  assert.equal(estado(h).saude.quebrado, true);

  let saiu = 0;
  h.wpp.enviarGrupo = async (texto, opts) => { saiu += 1; return real(texto, opts); };
  h.t = t0 + 11 * MIN;
  await h.p.passoGrupo();
  assert.equal(saiu, 1);
  assert.match(h.enviados.at(-1).texto, /^🎛️ \*Controle de sessões\*\n/, 'a resposta do status');
  assert.equal(estado(h).saida.length, 0);
  await h.p.passoMinuto();
  assert.deepEqual(textosTg(h).slice(1), [`${CAB_TG}\n${TG.voltou('16:11')}`]);
  h.t += MIN;
  await h.p.passoGrupo();
  assert.equal(saiu, 1, 'saiu 1 vez so');

  // o envio nunca volta: 2 h na fila = descarta e loga; a fila vazia depois disso nao e "voltou"
  const h2 = montarSaude();
  const t2 = h2.t;
  h2.wpp.enviarGrupo = async (texto, opts) => {
    h2.enviados.push({ texto, opts });
    return { ok: false, erro: 'send: HTTP 503' };
  };
  msg(h2, { content: 'status' });
  await h2.p.passoGrupo();
  const naFila = {};
  for (let m = 1; m <= 125; m++) {
    h2.t = t2 + m * MIN;
    await h2.p.passoGrupo();
    await h2.p.passoMinuto();
    naFila[m] = estado(h2).saida.length;
  }
  assert.equal(naFila[119], 1, 'ate 2 h segue esperando');
  assert.equal(naFila[120], 0, '2 h na fila: some');
  assert.equal(linhasDoLog(h2, /perdida: 2 h na fila/).length, 1);
  const continua = 'O porteiro do WhatsApp continua sem conseguir mandar mensagem no grupo (desde 16:00). Os avisos e as respostas das abas não chegam no seu WhatsApp; no PC tudo segue normal.';
  assert.deepEqual(textosTg(h2), [`${CAB_TG}\n${TG.envio('16:00')}`, `${CAB_TG}\n${continua}`], 'fila vazia depois da perda nao e "voltou"');
  assert.equal(estado(h2).saude.quebrado, true);
});

test('R2 3. porteiro reiniciado entre o parou da aba e o resultado do mensageiro: a resposta vai pro grupo 1 vez depois do reinicio (parou guardado no estado, final com teto de 12 mil, podado em 2 h)', async () => {
  // cena: claude -p em voo; o recado entra na aba e ela responde; o passoEventos consome o parou; o porteiro morre
  const cena = async (fim) => {
    const h = montar();
    h.segurar = true;
    abaFaro(h);
    const m = msg(h, { content: 'Faro: roda os testes' });
    await h.cru.passoGrupo();
    await semEsperar(h.cru.passoEntrega(), 'passoEntrega');
    h.t += 5 * 1000;
    transcript(h, 'S1', [peer(h.entregas[0], false, iso(h.t))]);
    h.t += 20 * 1000;
    transcript(h, 'S1', [falaDaAba(fim, iso(h.t))]);
    const r = parou(h, 'S1', { final: fim });
    evento(h, r);
    await semEsperar(h.cru.passoEventos(), 'passoEventos');
    assert.equal(h.enviados.length, 0, 'sem entrega registrada ainda: o parou passa sem resposta');
    h.segurar = false;
    return { h, m, r };
  };
  const fim = `${linha('16:00', 'roda os testes')}\n12 verdes.`;
  const { h, m, r } = await cena(fim);
  let g = estado(h).parouGuardado?.S1;
  assert.equal(g?.ev?.final, fim, 'o parou guardado vai pro estado');
  assert.equal(g?.noGrupo, false);
  const novo = porteiroNovo(h); // o "enviado" do claude -p nunca foi aplicado
  h.t += 3 * MIN;
  await novo.passoGrupo();
  await bombear(novo);
  assert.equal(h.entregas.length, 1, 'recado ja na aba: nao reenvia');
  assert.deepEqual(h.enviados.map((x) => x.texto), [montarResposta({ ...r, titulo: 'Faro' })]);
  assert.equal(estado(h).entregas[m.provider_msg_id].respondida, true);
  assert.equal(estado(h).parouGuardado.S1.noGrupo, true);
  for (const p of [novo, porteiroNovo(h)]) {
    h.t += MIN;
    await p.passoEventos();
    await p.passoGrupo();
    await bombear(p);
  }
  assert.equal(h.enviados.length, 1, '1 vez so, mesmo com outro reinicio');

  // final longo (o hook ja corta em 6 mil; o teto aqui e defesa): guardado com cabeca e cauda, a resposta sai igual
  const longo = `${linha('16:00', 'roda os testes')}\n${'a'.repeat(20000)}\nFIM-DA-RESPOSTA`;
  const c2 = await cena(longo);
  g = estado(c2.h).parouGuardado.S1;
  assert.ok(Array.from(g.ev.final).length <= 12010, `teto de 12 mil (${g.ev.final.length})`);
  assert.ok(g.ev.final.startsWith(linha('16:00', 'roda os testes')), 'a linha de citacao (inicio) fica');
  assert.ok(g.ev.final.endsWith('FIM-DA-RESPOSTA'), 'o fim (DECISAO) fica');
  const novo2 = porteiroNovo(c2.h);
  c2.h.t += 3 * MIN;
  await novo2.passoGrupo();
  await bombear(novo2);
  assert.deepEqual(c2.h.enviados.map((x) => x.texto), [montarResposta({ ...c2.r, titulo: 'Faro' })]);

  // podado com o TTL das entregas (2 h)
  c2.h.t += 2 * 60 * MIN;
  await novo2.passoMinuto();
  assert.equal(estado(c2.h).parouGuardado.S1, undefined, 'mais de 2 h: sai do estado');
});

// spawn falso do wscript: devolve o filho e SO DEPOIS emite 'spawn' ou 'error' (como o Node faz de verdade).
function spawnFalso(modo) {
  const chamadas = [];
  const fn = (cmd, args, opts) => {
    const filho = new EventEmitter();
    filho.unref = () => {};
    chamadas.push({ cmd, args, opts });
    setImmediate(() => {
      if (modo === 'erro') filho.emit('error', Object.assign(new Error('spawn wscript.exe ENOENT'), { code: 'ENOENT' }));
      else filho.emit('spawn');
    });
    return filho;
  };
  fn.chamadas = chamadas;
  return fn;
}
// A5d2: o gravarCentral dublado nos abridores (a pasta montada e o modo; o de verdade esta no tests/a5d.test.mjs)
const MONTAR = (o) => ({ pasta: 'D:\\estado\\central', modo: o.modo });

test('R2 4. central: erro assincrono do spawn do wscript -> "Não consegui abrir" (e o "abre central" seguinte tenta de novo); aberta pelo "abre central" e sem aparecer viva em 3 min -> 1 frase; apareceu ou travou -> nada', async () => {
  assert.equal(typeof porteiroMod.abrirCentralReal, 'function', 'abrirCentralReal testavel (spawn injetado)');
  const h = montar();
  const sp = spawnFalso('erro');
  const p = comBomba(porteiroCom(h, { abrirCentral: porteiroMod.abrirCentralReal(() => {}, { gravarCentral: MONTAR, spawn: sp }) }));
  msg(h, { content: 'abre central' });
  await p.passoGrupo();
  assert.equal(sp.chamadas.length, 1);
  assert.equal(sp.chamadas[0].cmd, 'wscript.exe');
  assert.equal(sp.chamadas[0].args[0], '//nologo'); // A3a: //nologo <vbs> <pasta> <nome> <claude>
  assert.match(sp.chamadas[0].args[1], /central[\\/]abrir-central\.vbs$/);
  assert.equal(sp.chamadas[0].opts.detached, true);
  assert.deepEqual(h.enviados.map((x) => x.texto), [CENTRAL_FALHOU]);
  assert.equal(linhasDoLog(h, /abrir a central falhou \(comando\)/).length, 1);
  h.t += 30 * 1000;
  msg(h, { content: 'abre central' });
  await p.passoGrupo();
  assert.equal(sp.chamadas.length, 2, 'falhou: o "abre central" seguinte tenta de novo na hora');
  assert.deepEqual(h.enviados.map((x) => x.texto), [CENTRAL_FALHOU, CENTRAL_FALHOU]);
  for (let i = 1; i <= 5; i++) {
    h.t += MIN;
    await p.passoMinuto();
  }
  assert.equal(h.enviados.length, 2, 'abertura que falhou nao espera a central');

  // abriu (spawn ok) e a central nao aparece: 1 frase aos 3 min, mesmo com 2 "abre central" na mesma abertura
  const h2 = montar();
  abaFaro(h2);
  const sp2 = spawnFalso('ok');
  const p2 = comBomba(porteiroCom(h2, { abrirCentral: porteiroMod.abrirCentralReal(() => {}, { gravarCentral: MONTAR, spawn: sp2 }) }));
  const t2 = h2.t;
  msg(h2, { content: 'abre central' });
  await p2.passoGrupo();
  h2.t = t2 + MIN;
  msg(h2, { content: 'abre central' }); // a janela ainda subindo: nao abre outra
  await p2.passoGrupo();
  assert.deepEqual(h2.enviados.map((x) => x.texto), [ABRINDO_CENTRAL, ABRINDO_CENTRAL]);
  assert.equal(sp2.chamadas.length, 1);
  h2.t = t2 + 3 * MIN - 1000;
  await p2.passoMinuto();
  assert.equal(h2.enviados.length, 2, 'antes de 3 min: espera');
  h2.t = t2 + 3 * MIN;
  await p2.passoMinuto();
  assert.deepEqual(h2.enviados.slice(2).map((x) => x.texto), [CENTRAL_NAO_ABRIU]);
  for (let m = 4; m <= 9; m++) {
    h2.t = t2 + m * MIN;
    await p2.passoMinuto();
  }
  assert.equal(h2.enviados.length, 3, '1 vez por abertura');
  assert.equal(linhasDoLog(h2, /nao apareceu em 3 min/).length, 1);

  // a central aparece antes dos 3 min: nada
  const h3 = montar();
  const p3 = comBomba(porteiroCom(h3, { abrirCentral: porteiroMod.abrirCentralReal(() => {}, { gravarCentral: MONTAR, spawn: spawnFalso('ok') }) }));
  msg(h3, { content: 'abre central' });
  await p3.passoGrupo();
  h3.t += 2 * MIN;
  centralCli(h3);
  await p3.passoMinuto();
  h3.t += 5 * MIN;
  await p3.passoMinuto();
  assert.deepEqual(h3.enviados.map((x) => x.texto), [ABRINDO_CENTRAL]);

  // travou no meio da espera: nada sai
  const h4 = montar();
  const p4 = comBomba(porteiroCom(h4, { abrirCentral: porteiroMod.abrirCentralReal(() => {}, { gravarCentral: MONTAR, spawn: spawnFalso('ok') }) }));
  msg(h4, { content: 'abre central' });
  await p4.passoGrupo();
  h4.t += MIN;
  msg(h4, { content: 'trava' });
  await p4.passoGrupo();
  h4.t += 5 * MIN;
  await p4.passoMinuto();
  assert.deepEqual(h4.enviados.map((x) => x.texto), [ABRINDO_CENTRAL, TRAVADO_F]);
});

test('R2 5. claude -p orfao do mensageiro: pid registrado vivo, de claude, filho do porteiro morto e da hora do registro = arvore encerrada ao subir, ANTES da recuperacao; outro programa, outro pai, outra hora, consulta falhou, dono vivo, sem como conferir ou ensaio = nao mata', async () => {
  const MORTO = 2147483640; // pid que nao existe: o porteiro dono ja morreu
  const arqFilho = (h) => path.join(h.env.SESSOES_WPP_DIR, 'mensageiro-filho.json');
  // estado com 1 entrega em voo (o porteiro morreu com o claude -p rodando) + registro do filho
  const cena = async (porteiroPid = MORTO) => {
    const h = montar();
    h.segurar = true;
    abaFaro(h);
    msg(h, { content: 'Faro: roda os testes' });
    await h.cru.passoGrupo();
    await semEsperar(h.cru.passoEntrega(), 'passoEntrega');
    h.segurar = false;
    const at = Date.now();
    fs.writeFileSync(arqFilho(h), JSON.stringify({ pid: process.pid, porteiroPid, at: new Date(at).toISOString() }));
    return { h, at };
  };
  const dubleProcessos = (info) => {
    const d = { mortos: [], consultas: [] };
    d.info = (pid) => {
      d.consultas.push(pid);
      if (info instanceof Error) throw info;
      return info;
    };
    d.matarArvore = (pid) => { d.mortos.push(pid); return true; };
    return d;
  };

  // o filho de verdade: encerrado ao subir, antes de virar nova tentativa; a recuperacao segue (espera 3 min e confere)
  let { h, at } = await cena();
  let d = dubleProcessos({ nome: 'claude.exe', paiPid: MORTO, criadoEm: at - 50 });
  porteiroCom(h, { processos: d });
  assert.deepEqual(d.mortos, [process.pid]);
  const log = fs.readFileSync(h.env.SESSOES_WPP_LOG, 'utf8');
  const iMorto = log.indexOf('orfao do mensageiro');
  assert.ok(iMorto !== -1 && iMorto < log.indexOf('em voo quando o porteiro parou'), 'encerra antes da recuperacao do item em voo');
  assert.equal(fs.existsSync(arqFilho(h)), false, 'registro apagado');
  assert.equal(estado(h).repassar.length, 1, 'a recuperacao segue como antes');

  // nao da pra ter certeza de que e o filho: nao mata, recuperacao como antes
  const casos = {
    'outro programa no pid': (t) => ({ nome: 'chrome.exe', paiPid: MORTO, criadoEm: t }),
    'claude de outro pai': (t) => ({ nome: 'claude.exe', paiPid: 4242, criadoEm: t }),
    'claude nascido 10 min antes do registro (pid reusado)': (t) => ({ nome: 'claude.exe', paiPid: MORTO, criadoEm: t - 10 * MIN }),
    'consulta sem resposta': () => null,
    'consulta que lanca': () => new Error('powershell caiu'),
  };
  for (const [nome, info] of Object.entries(casos)) {
    ({ h, at } = await cena());
    d = dubleProcessos(info(at));
    porteiroCom(h, { processos: d });
    assert.deepEqual(d.mortos, [], nome);
    assert.deepEqual(d.consultas, [process.pid], `${nome}: consultou o pid registrado`);
    assert.equal(estado(h).repassar.length, 1, `${nome}: recuperacao como antes`);
  }
  // dono vivo (o registro e de um porteiro que ainda roda), sem como conferir, ensaio: nem consulta
  ({ h } = await cena(process.pid));
  d = dubleProcessos({ nome: 'claude.exe', paiPid: process.pid, criadoEm: Date.now() });
  porteiroCom(h, { processos: d });
  assert.deepEqual([d.mortos, d.consultas], [[], []], 'dono vivo: nao e orfao');
  ({ h, at } = await cena());
  porteiroCom(h); // sem `processos`: nunca mata
  assert.equal(estado(h).repassar.length, 1);
  assert.ok(fs.existsSync(arqFilho(h)), 'sem conferir: o registro fica');
  d = dubleProcessos({ nome: 'claude.exe', paiPid: MORTO, criadoEm: at });
  porteiroCom(h, { processos: d, ensaio: true });
  assert.deepEqual([d.mortos, d.consultas], [[], []], 'ensaio nunca mata');

  // leitura da consulta real (formato medido no PC 28/09: "node.exe|275956|1790564363213\r\n"; pid inexistente = "")
  const ler = porteiroMod.lerInfoProcesso;
  assert.deepEqual(ler('claude.exe|275956|1790564363213\r\n'), { nome: 'claude.exe', paiPid: 275956, criadoEm: 1790564363213 });
  for (const ruim of ['', '\r\n', 'claude.exe|x|1', 'claude.exe|1', 'a|1|2\r\nb|3|4', 'Get-CimInstance : erro']) {
    assert.equal(ler(ruim), null, JSON.stringify(ruim));
  }
});

// ---------------------------------------------------------------------------------------------------------------
// F4.1 (fase 4, pedido do dono pelo grupo; PLANO.md "Fase 4", brief D7): a fala do dono chegou na aba X
// (mensageiro "enviado", ou o recado ja estava na aba) = cada aviso/resposta da aba X ainda aberto no grupo, enviado ha
// menos de 14 min, e EDITADO (whatsapp-agent edit_message) pra "ℹ️ *<título>*\nConcluído: você respondeu às HH:MM." (F4g)
// No codigo da base (557af9c) todos falhavam. Nada real: o edit_message e duble (ou o wpp.mjs com fetch dublado).

// Texto escrito por extenso de proposito: o teste prende o que o dono ve.
const CONCLUIDO = (titulo, hora) => `ℹ️ *${titulo}*\nConcluído: você respondeu às ${hora}.`;
const FRASE_SEM_CENTRAL = `${CAB}\nNão sei pra qual sessão é. Responde citando o aviso dela, ou começa com o nome da sessão e dois pontos. "status" lista as sessões.`;

// Aba Faro com 1 aviso no grupo (P1/U1), modo rua ligado. Devolve a hora do envio (16:00:01).
async function cenaAviso(h) {
  abaFaro(h);
  await ligarRua(h);
  evento(h, parou(h, 'S1', { marcas: DECISAO, final: 'Publico agora?' }));
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 1, 'o aviso');
  return h.t;
}

// Aviso em t0 + 3 status em t0+10s (janela de 4 por minuto cheia) + o dono cita o aviso em t0+15s (a edicao espera na
// fila) + "bom dia" sem central em t0+20s (a frase fica atras da edicao).
async function cenaEdicaoNaFila(h) {
  const t0 = await cenaAviso(h);
  h.t = t0 + 10 * 1000;
  for (let i = 0; i < 3; i++) msg(h, { content: 'status' });
  await h.p.passoGrupo();
  assert.equal(h.enviados.length, 4, 'aviso + 3 status: janela cheia');
  h.t = t0 + 15 * 1000;
  msg(h, { content: 'pode', quoted_msg_id: 'P1' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 1);
  h.t = t0 + 20 * 1000;
  msg(h, { content: 'bom dia' });
  await h.p.passoGrupo();
  assert.deepEqual(estado(h).saida.map((x) => x.tipo), ['editar', 'frase'], 'edicao esperando a janela, frase atras');
  assert.deepEqual(h.edicoes, []);
  return t0;
}

test('F4.1 1. aviso em T, o dono cita em T+3 min, enviado -> 1 edit_message com o message_id do aviso, confirmed:true e o texto do concluido; as 2 chaves concluidas', async () => {
  const h = montar();
  // o editarGrupo de verdade (wpp.mjs) com fetch dublado: o teste ve o JSON-RPC que sairia pro whatsapp-agent
  const rpc = [];
  const w = criarWpp({
    url: 'https://exemplo.invalid/mcp',
    fetch: async (_url, opts) => {
      rpc.push(JSON.parse(opts.body));
      const out = { ok: true, edited: true, message_id: 'U1' };
      return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } }) };
    },
    ...DESTINO_WPP, // A2a: o grupo e as instancias de quem cria
  });
  h.wpp.editarGrupo = w.editarGrupo;
  const t0 = await cenaAviso(h);
  let e = estado(h);
  for (const id of ['P1', 'U1']) {
    assert.equal(e.avisos[id].messageId, 'U1', `${id}: guarda o uuid do send`);
    assert.equal(e.avisos[id].tipo, 'aviso');
    assert.ok(!e.avisos[id].concluido);
  }
  h.t = t0 + 3 * MIN;
  const m = msg(h, { content: 'pode publicar', quoted_msg_id: 'P1' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 1);
  assert.equal(h.entregas[0].sessionId, 'S1');
  assert.deepEqual(h.reacoes, [{ messageId: m.id, emoji: '✅' }]);
  assert.equal(rpc.length, 1, '1 edicao');
  assert.deepEqual(rpc[0].params, {
    name: 'edit_message',
    arguments: { message_id: 'U1', new_content: 'ℹ️ *Faro*\nConcluído: você respondeu às 16:03.', confirmed: true },
  });
  assert.equal(h.enviados.length, 1, 'editar nao manda mensagem nova');
  e = estado(h);
  for (const id of ['P1', 'U1']) assert.equal(e.avisos[id].concluido, true, id);
  assert.deepEqual(e.saida, []);
  assert.equal(linhasDoLog(h, /concluid/).length >= 1, true, 'loga a edicao');
});

test('F4.1 2. fala entregue em T+14:30 -> nenhuma edicao e log; edicao que so sai da fila depois de T+14 -> descartada com log', async () => {
  const h = montar();
  const t0 = await cenaAviso(h);
  h.t = t0 + 14 * MIN + 30 * 1000;
  msg(h, { content: 'pode', quoted_msg_id: 'P1' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 1, 'a fala vai pra aba igual');
  assert.deepEqual(h.edicoes, []);
  assert.ok(!estado(h).avisos.U1.concluido);
  assert.equal(linhasDoLog(h, /passou do prazo de edicao/).length, 1);

  // fala em T+13:30 com a janela de 4 por minuto cheia: a edicao espera; na volta, T+14:01 = passou do prazo
  const h2 = montar();
  const t2 = await cenaAviso(h2);
  h2.t = t2 + 13 * MIN;
  for (let i = 0; i < 4; i++) msg(h2, { content: 'status' });
  await h2.p.passoGrupo();
  assert.equal(h2.enviados.length, 5);
  h2.t = t2 + 13 * MIN + 30 * 1000;
  msg(h2, { content: 'pode', quoted_msg_id: 'P1' });
  await h2.p.passoGrupo();
  assert.equal(h2.entregas.length, 1);
  assert.deepEqual(h2.edicoes, []);
  assert.deepEqual(estado(h2).saida.map((x) => x.tipo), ['editar'], 'esperando a janela');
  h2.t = t2 + 14 * MIN + 1000;
  await h2.p.passoGrupo();
  assert.deepEqual(h2.edicoes, [], 'passou do prazo: nao chama o edit_message');
  assert.deepEqual(estado(h2).saida, []);
  assert.ok(!estado(h2).avisos.U1.concluido);
  assert.equal(linhasDoLog(h2, /passou do prazo de edicao/).length, 1);
});

test('F4.1 3. 2a fala pra mesma aba depois da edicao -> nenhuma 2a edicao; 2 falas com a edicao ainda na fila -> 1 edicao so', async () => {
  const h = montar();
  const t0 = await cenaAviso(h);
  h.t = t0 + 3 * MIN;
  msg(h, { content: 'pode', quoted_msg_id: 'P1' });
  await h.p.passoGrupo();
  assert.deepEqual(h.edicoes, [{ messageId: 'U1', texto: CONCLUIDO('Faro', '16:03') }]);
  h.t += 2 * MIN;
  msg(h, { content: 'e publica tambem', quoted_msg_id: 'P1' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 2);
  assert.equal(h.edicoes.length, 1, 'ja concluida: nao edita de novo');

  const h2 = montar();
  const t2 = await cenaAviso(h2);
  h2.t = t2 + MIN;
  for (let i = 0; i < 4; i++) msg(h2, { content: 'status' });
  await h2.p.passoGrupo();
  h2.t += 5 * 1000;
  msg(h2, { content: 'pode', quoted_msg_id: 'P1' });
  await h2.p.passoGrupo();
  h2.t += 5 * 1000;
  msg(h2, { content: 'Faro: e publica' });
  await h2.p.passoGrupo();
  assert.equal(h2.entregas.length, 2);
  assert.deepEqual(h2.edicoes, []);
  assert.equal(estado(h2).saida.filter((x) => x.tipo === 'editar').length, 1, '1 item so pra mesma mensagem');
  h2.t += MIN;
  await h2.p.passoGrupo();
  assert.deepEqual(h2.edicoes, [{ messageId: 'U1', texto: CONCLUIDO('Faro', '16:01') }], 'a hora e a da 1a fala');
  h2.t += MIN;
  await h2.p.passoGrupo();
  assert.equal(h2.edicoes.length, 1);
});

test('F4.1 4. aviso e resposta da aba X no prazo -> as 2 editadas; o aviso da aba Y fica intocado', async () => {
  const h = montar();
  abaFaro(h);
  sessao(h, { sessionId: 'S2', name: 'repos-f3' });
  transcript(h, 'S2', [custom('Brain')]);
  await ligarRua(h);
  msg(h, { content: 'Faro: roda os testes' }); // 16:00, nada da aba no grupo ainda
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 1);
  assert.deepEqual(h.edicoes, []);
  transcript(h, 'S1', [peer(h.entregas[0], false, iso(h.t + 1000))]);
  h.t += MIN;
  evento(h, parou(h, 'S1', { final: `${linha('16:00', 'roda os testes')}\nRodei: 12 verdes.` })); // resposta X: P1/U1
  evento(h, parou(h, 'S2', { nome: 'repos-f3', marcas: DECISAO })); // aviso Y: P2/U2
  await h.p.passoEventos();
  h.t += MIN;
  await h.p.passoMinuto();
  evento(h, parou(h, 'S1', { marcas: DECISAO, final: 'Publico?' })); // aviso X: P3/U3
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 3);
  const e0 = estado(h);
  assert.deepEqual([e0.avisos.U1.tipo, e0.avisos.U1.sessionId], ['resposta', 'S1']);
  assert.deepEqual([e0.avisos.U2.tipo, e0.avisos.U2.sessionId], ['aviso', 'S2']);
  assert.deepEqual([e0.avisos.U3.tipo, e0.avisos.U3.sessionId], ['aviso', 'S1']);
  h.t += MIN;
  msg(h, { content: 'pode', quoted_msg_id: 'P3' }); // 16:03
  await h.p.passoGrupo();
  assert.deepEqual(h.edicoes.map((x) => x.messageId).sort(), ['U1', 'U3']);
  for (const x of h.edicoes) assert.equal(x.texto, CONCLUIDO('Faro', '16:03'));
  const e = estado(h);
  for (const id of ['P1', 'U1', 'P3', 'U3']) assert.equal(e.avisos[id].concluido, true, id);
  for (const id of ['P2', 'U2']) assert.ok(!e.avisos[id].concluido, `${id}: aba Y intocada`);
});

test('F4.1 5. nao_achei, duplicado, erro e reforco -> nenhuma edicao; nova tentativa com o recado ja na aba (registrarJaNaAba) -> edita', async () => {
  for (const status of ['nao_achei', 'duplicado']) {
    const h = montar({ respostasEntrega: [{ status, detalhe: '' }] });
    const t0 = await cenaAviso(h);
    h.t = t0 + 2 * MIN;
    msg(h, { content: 'pode', quoted_msg_id: 'P1' });
    await h.p.passoGrupo();
    assert.equal(h.entregas.length, 1, status);
    assert.equal(h.enviados.length, 2, `${status}: so a frase`);
    assert.deepEqual(h.edicoes, [], status);
    assert.ok(!estado(h).avisos.U1.concluido, status);
  }

  // erro na 1a: nada; a nova tentativa acha o recado ja na aba -> registra sem reenviar e edita
  const h = montar({ respostasEntrega: [{ status: 'erro', detalhe: 'timeout 120 s' }] });
  const t0 = await cenaAviso(h);
  h.t = t0 + 2 * MIN;
  msg(h, { content: 'pode', quoted_msg_id: 'P1' });
  await h.p.passoGrupo();
  assert.deepEqual(h.edicoes, [], 'erro: a fala ainda nao chegou na aba');
  transcript(h, 'S1', [peer(h.entregas[0], false, iso(h.t + 1000))]);
  h.t += 15 * 1000;
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 1, 'nao reenvia');
  assert.equal(linhasDoLog(h, /recado ja estava na aba/).length, 1);
  assert.deepEqual(h.edicoes, [{ messageId: 'U1', texto: CONCLUIDO('Faro', '16:02') }]);
  assert.equal(estado(h).avisos.U1.concluido, true);

  // reforco entregue: nao conta (a resposta que acabou de ir pro grupo fica)
  const h3 = montar();
  abaFaro(h3);
  msg(h3, { content: 'Faro: roda os testes' });
  await h3.p.passoGrupo();
  transcript(h3, 'S1', [peer(h3.entregas[0], false, iso(h3.t + 1000)), falaDaAba('Rodando os testes.')]);
  h3.t += MIN;
  evento(h3, parou(h3, 'S1', { final: 'Rodei os testes.' }));
  await h3.p.passoEventos();
  assert.equal(h3.entregas.length, 2);
  assert.equal(h3.entregas[1].reforco, true);
  assert.equal(h3.enviados.length, 1, 'a resposta foi pro grupo');
  assert.equal(estado(h3).avisos.U1.tipo, 'resposta');
  assert.deepEqual(h3.edicoes, [], 'o reforco entregue nao edita a resposta');
});

test('F4.1 6. edicao com erro e com blocked -> descartada sem nova tentativa; a frase de tras sai no mesmo passo; saude sem falha de envio', async () => {
  const falhas = [
    ['erro', { ok: false, erro: 'edit_message: HTTP 502' }],
    ['blocked', { ok: false, bloqueio: 'voice_gate', violacoes: [{ id: 'x' }] }],
  ];
  for (const [nome, falha] of falhas) {
    // com a frase atras: a falha nao segura a fila
    const h = montar({ respostasEdicao: [falha] });
    const t0 = await cenaEdicaoNaFila(h);
    const antes = h.enviados.length;
    h.t = t0 + 75 * 1000; // a janela esvaziou
    await h.p.passoEventos();
    assert.equal(h.edicoes.length, 1, nome);
    assert.equal(h.enviados.length, antes + 1, `${nome}: a frase saiu no mesmo passo`);
    assert.equal(h.enviados.at(-1).texto, FRASE_SEM_CENTRAL);
    let e = estado(h);
    assert.deepEqual(e.saida, [], nome);
    assert.ok(!e.avisos.U1.concluido, nome);
    for (let i = 0; i < 3; i++) {
      h.t += MIN;
      await h.p.passoEventos();
      await h.p.passoGrupo();
    }
    assert.equal(h.edicoes.length, 1, `${nome}: sem nova tentativa`);
    assert.equal(linhasDoLog(h, /editar S1 .*sem nova tentativa/).length, 1, nome);

    // sozinha na fila: nada de envio bom depois pra mascarar; a edicao nao mexe na saude do canal (F3.11)
    const h2 = montar({ respostasEdicao: [falha] });
    const t2 = await cenaAviso(h2);
    h2.t = t2 + 2 * MIN;
    msg(h2, { content: 'pode', quoted_msg_id: 'P1' });
    await h2.p.passoGrupo();
    assert.equal(h2.edicoes.length, 1, nome);
    e = estado(h2);
    assert.deepEqual(e.saida, [], nome);
    assert.equal(e.saude.envioFalhaDesde, null, `${nome}: nao conta como falha de envio`);
    assert.equal(e.saude.envioUltimaFalhaEm, null, nome);
    assert.ok(!e.avisos.U1.concluido, nome);
  }
});

test('F4.1 7. porteiro religado entre o aviso e a fala -> edita igual (messageId, tipo e concluido sobrevivem; as 2 chaves marcadas); edicao na fila sai no porteiro novo', async () => {
  const h = montar();
  const t0 = await cenaAviso(h);
  const p2 = comBomba(porteiroCom(h));
  h.t = t0 + 4 * MIN;
  msg(h, { content: 'pode', quoted_msg_id: 'P1' });
  await p2.passoGrupo();
  assert.equal(h.entregas.length, 1);
  assert.deepEqual(h.edicoes, [{ messageId: 'U1', texto: CONCLUIDO('Faro', '16:04') }]);
  let e = estado(h);
  for (const id of ['P1', 'U1']) {
    assert.equal(e.avisos[id].concluido, true, `${id}: as 2 copias do disco marcadas`);
    assert.equal(e.avisos[id].messageId, 'U1');
    assert.equal(e.avisos[id].tipo, 'aviso');
  }
  const p3 = comBomba(porteiroCom(h));
  h.t += MIN;
  msg(h, { content: 'e mais isso', quoted_msg_id: 'P1' });
  await p3.passoGrupo();
  assert.equal(h.entregas.at(-1).sessionId, 'S1');
  assert.equal(h.edicoes.length, 1, 'o concluido veio do disco: nao edita de novo');
  e = estado(h);
  assert.equal(e.avisos.U1.concluido, true);

  // a edicao esperava a janela quando o porteiro parou: o porteiro novo manda (a janela de 60 s e so em memoria)
  const h2 = montar();
  const t2 = await cenaEdicaoNaFila(h2);
  const q = comBomba(porteiroCom(h2));
  h2.t = t2 + 30 * 1000;
  await q.passoEventos();
  assert.deepEqual(h2.edicoes, [{ messageId: 'U1', texto: CONCLUIDO('Faro', '16:00') }]);
  assert.equal(estado(h2).avisos.P1.concluido, true);
  assert.equal(estado(h2).avisos.U1.concluido, true);
});

test('F4.1 8. travado nao edita (fala em voo quando o dono trava; edicao esperando na fila; estado travado no disco); ensaio registra e nao chama', async () => {
  // (a) a fala estava no mensageiro quando o dono travou: o resultado e descartado, nada editado
  const h = montar();
  const t0 = await cenaAviso(h);
  h.t = t0 + 2 * MIN;
  h.segurar = true;
  msg(h, { content: 'pode', quoted_msg_id: 'P1' });
  await h.cru.passoGrupo();
  await h.cru.passoEntrega();
  assert.equal(h.presas.length, 1, 'mensageiro rodando');
  h.t += 5 * 1000;
  msg(h, { content: 'trava' });
  await h.cru.passoGrupo();
  assert.equal(estado(h).trava, true);
  h.presas[0]();
  await tique();
  await h.cru.passoEntrega();
  assert.deepEqual(h.edicoes, []);
  assert.ok(!estado(h).avisos.U1.concluido);

  // (b) edicao esperando a janela e "trava": sai da fila sem editar
  const h2 = montar();
  const t2 = await cenaEdicaoNaFila(h2);
  h2.t = t2 + 25 * 1000;
  msg(h2, { content: 'trava' });
  await h2.p.passoGrupo();
  h2.t = t2 + 2 * MIN;
  await h2.p.passoEventos();
  await h2.p.passoGrupo();
  assert.deepEqual(h2.edicoes, []);

  // (c) estado travado no disco com a edicao na fila (porteiro religado): descartada com log
  const h3 = montar();
  const t3 = await cenaEdicaoNaFila(h3);
  const arq = path.join(h3.env.SESSOES_WPP_DIR, 'estado.json');
  fs.writeFileSync(arq, JSON.stringify({ ...JSON.parse(fs.readFileSync(arq, 'utf8')), trava: true }));
  h3.t = t3 + 2 * MIN;
  await h3.p.passoEventos();
  assert.deepEqual(h3.edicoes, []);
  assert.equal(estado(h3).saida.filter((x) => x.tipo === 'editar').length, 0);
  assert.equal(linhasDoLog(h3, /editar S1 saiu da fila sem enviar/).length, 1);

  // (d) ensaio: nova tentativa com o recado ja na aba (fila de entrega posta no estado de ensaio) -> registra
  // {acao:'editar', messageId, texto} no ensaio.jsonl e nunca chama o wpp
  const h4 = montar({ ensaio: true });
  abaFaro(h4);
  h4.idle = 30 * MIN;
  await h4.p.passoMinuto();
  evento(h4, parou(h4, 'S1', { marcas: DECISAO }));
  await h4.p.passoEventos();
  const arqE = path.join(h4.env.SESSOES_WPP_DIR, 'estado-ensaio.json');
  const e4 = JSON.parse(fs.readFileSync(arqE, 'utf8'));
  const idP = Object.keys(e4.avisos).find((k) => k.endsWith('-p'));
  const uuid = e4.avisos[idP]?.messageId;
  assert.match(String(uuid), /^ensaio-.*-u$/, 'o aviso de ensaio guarda o uuid ficticio');
  h4.t += 2 * MIN;
  const pedido = {
    sessionId: 'S1', nome: 'projetos-42', titulo: 'Faro', texto: 'pode', audio: false, hora: '16:02',
    providerMsgId: 'PROVX', messageId: 'uuid-x', anexos: [],
  };
  transcript(h4, 'S1', [peer(pedido, false, iso(h4.t))]);
  fs.writeFileSync(arqE, JSON.stringify({ ...e4, filaEntrega: [{ id: 'q-1', tipo: 'repasse', pedido, segunda: true, primeiraEm: iso(h4.t) }] }));
  await h4.cru.passoEntrega();
  assert.deepEqual(h4.edicoes, [], 'ensaio nunca chama o wpp');
  assert.equal(h4.enviados.length, 0);
  const acoes = fs.readFileSync(path.join(h4.env.SESSOES_WPP_DIR, 'ensaio.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(
    acoes.filter((a) => a.acao === 'editar').map(({ acao, messageId, texto }) => ({ acao, messageId, texto })),
    [{ acao: 'editar', messageId: uuid, texto: CONCLUIDO('Faro', '16:02') }],
  );
  assert.equal(fs.existsSync(path.join(h4.env.SESSOES_WPP_DIR, 'estado.json')), false, 'ensaio nao cria o estado real');
});

test('F4.1 9. fala sem citar vai pra central (o aviso da Faro fica); a central encaminha pra Faro -> edita o aviso da Faro com a hora da fala', async () => {
  const h = montar();
  abaFaro(h);
  centralCli(h);
  await ligarRua(h);
  const t0 = h.t;
  evento(h, parou(h, 'S1', { marcas: DECISAO }));
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 1, 'aviso da Faro: P1/U1');
  h.t = t0 + 2 * MIN;
  const m = msg(h, { content: 'publica o site de novo' });
  await h.p.passoGrupo();
  assert.equal(h.entregas[0].sessionId, 'SC');
  assert.deepEqual(h.edicoes, [], 'a fala chegou na central, nao na Faro');
  transcript(h, 'SC', [peer(h.entregas[0], false, iso(h.t + 1000))]);
  h.t += MIN;
  encaminhar(h, { providerMsgId: m.provider_msg_id });
  await h.p.passoEventos();
  assert.equal(h.entregas.length, 2);
  assert.equal(h.entregas[1].sessionId, 'S1');
  assert.equal(h.entregas[1].encaminhado, true);
  assert.deepEqual(h.edicoes, [{ messageId: 'U1', texto: CONCLUIDO('Faro', '16:02') }]);
  assert.equal(estado(h).avisos.P1.concluido, true);
});

test('F4.1 10. citar a mensagem ja editada (depois da janela e com o porteiro religado) -> vai pra aba dela', async () => {
  const h = montar();
  const t0 = await cenaAviso(h);
  h.t = t0 + 3 * MIN;
  msg(h, { content: 'pode', quoted_msg_id: 'P1' });
  await h.p.passoGrupo();
  assert.equal(h.edicoes.length, 1);
  const p2 = comBomba(porteiroCom(h));
  h.t = t0 + 40 * MIN;
  const n = msg(h, { content: 'e aquilo outro?', quoted_msg_id: 'P1' });
  await p2.passoGrupo();
  assert.equal(h.entregas.length, 2);
  assert.equal(h.entregas[1].sessionId, 'S1');
  assert.equal(h.entregas[1].texto, 'e aquilo outro?');
  assert.equal(h.entregas[1].messageId, n.id);
  assert.equal(h.edicoes.length, 1);
});

// A fala "chega" na aba quando sai pro mensageiro: o que a aba mandou pro grupo depois disso pode ser a resposta a ela
// (a aba responde com o claude -p ainda rodando; F3.7 6b). Editar isso diria "você respondeu" a uma mensagem que o dono
// nem leu e apagaria a resposta.
test('F4.1 11. aba responde com o mensageiro em voo (aviso, ou resposta do parou guardado) -> so a mensagem de ANTES da fala e editada; a resposta fica', async () => {
  // (a) modo rua: a resposta sai como aviso enquanto o mensageiro roda
  const h = montar();
  const t0 = await cenaAviso(h); // A0 = P1/U1, 16:00
  h.t = t0 + 2 * MIN;
  h.segurar = true;
  msg(h, { content: 'Faro: publica?' }); // 16:02
  await h.cru.passoGrupo();
  await h.cru.passoEntrega();
  assert.equal(h.presas.length, 1, 'mensageiro rodando');
  h.t += 5 * 1000;
  transcript(h, 'S1', [peer(h.entregas[0], false, iso(h.t))]);
  h.t += 20 * 1000;
  evento(h, parou(h, 'S1', { final: `${linha('16:02', 'publica?')}\nPronto. DECISAO: publico agora?`, marcas: DECISAO }));
  await h.cru.passoEventos();
  assert.equal(h.enviados.length, 2, 'a resposta saiu como aviso: P2/U2');
  h.presas.shift()();
  await tique();
  await h.cru.passoEntrega();
  assert.deepEqual(h.edicoes, [{ messageId: 'U1', texto: CONCLUIDO('Faro', '16:02') }]);
  let e = estado(h);
  assert.equal(e.avisos.U1.concluido, true);
  assert.ok(!e.avisos.U2.concluido, 'a resposta a esta fala fica inteira');

  // (b) dono no PC: a resposta de antes (R1) e editada; a desta fala (parou guardado, sai no "enviado") fica
  const h2 = montar();
  abaFaro(h2);
  msg(h2, { content: 'Faro: roda os testes' }); // 16:00
  await h2.p.passoGrupo();
  transcript(h2, 'S1', [peer(h2.entregas[0], false, iso(h2.t + 1000))]);
  h2.t += MIN;
  evento(h2, parou(h2, 'S1', { final: `${linha('16:00', 'roda os testes')}\n12 verdes.` }));
  await h2.p.passoEventos();
  assert.equal(h2.enviados.length, 1, 'R1 = P1/U1');
  h2.t += MIN;
  h2.segurar = true;
  msg(h2, { content: 'Faro: publica' }); // 16:02
  await h2.cru.passoGrupo();
  await h2.cru.passoEntrega();
  h2.t += 5 * 1000;
  transcript(h2, 'S1', [peer(h2.entregas[1], false, iso(h2.t))]);
  h2.t += 20 * 1000;
  evento(h2, parou(h2, 'S1', { final: `${linha('16:02', 'publica')}\nPublicado.` }));
  await h2.cru.passoEventos();
  assert.equal(h2.enviados.length, 1, 'a entrega ainda nao existe: o parou fica guardado');
  h2.presas.shift()();
  await tique();
  await h2.cru.passoEntrega();
  assert.equal(h2.enviados.length, 2, 'R2 = P2/U2, a resposta desta fala');
  assert.match(h2.enviados[1].texto, /Publicado\./);
  assert.deepEqual(h2.edicoes, [{ messageId: 'U1', texto: CONCLUIDO('Faro', '16:02') }]);
  e = estado(h2);
  assert.equal(e.avisos.U1.concluido, true);
  assert.equal(e.avisos.U2.tipo, 'resposta');
  assert.ok(!e.avisos.U2.concluido, 'a resposta desta fala fica inteira');
});

test('F4.1 d. texto do concluido: titulo, senao nome, senao "sem nome"; limpo numa linha; mesmo cabecalho do aviso; hora ruim = ??:??', () => {
  const f = formatoMod.montarConcluido;
  assert.equal(typeof f, 'function');
  assert.equal(f({ titulo: 'Faro', nome: 'projetos-42' }, '16:03'), 'ℹ️ *Faro*\nConcluído: você respondeu às 16:03.');
  assert.equal(f({ titulo: null, nome: 'projetos-42' }, '09:05'), 'ℹ️ *projetos-42*\nConcluído: você respondeu às 09:05.');
  assert.equal(f({}, '16:03'), 'ℹ️ *sem nome*\nConcluído: você respondeu às 16:03.');
  assert.equal(f({ titulo: '**Site** 🔴 novo — v2' }, '16:03'), 'ℹ️ *Site novo - v2*\nConcluído: você respondeu às 16:03.');
  for (const ruim of ['ontem', '', null, undefined, '1:3', '16:03 ']) {
    assert.equal(f({ titulo: 'X' }, ruim), 'ℹ️ *X*\nConcluído: você respondeu às ??:??.', JSON.stringify(ruim));
  }
  const ev = { titulo: 'Faro', nome: 'projetos-42', final: 'x', finalTs: iso(T0) };
  assert.equal(f(ev, '16:00').split('\n')[0], montarAviso(ev).split('\n')[0]);
  assert.equal(f(ev, '16:00').split('\n')[0], montarResposta(ev).split('\n')[0]);
});

// Incidente real: a central (bypass) SEGURA recado de sessao em outro modo ("Held peer message ... permission mode
// class doesn't match") mesmo com crossSessionInbound=accept no settings do usuario; o mensageiro (claude -p) nao e
// bypass. Remedio da doc oficial pra sessao sem gente: `--settings` com crossSessionInbound=accept na abertura.
// A5d2: o arquivo e o ajustes.json da pasta montada (o gravarCentral grava o montarAjustes), nos 2 modos.
test('central abre com --settings que aceita recado de outra sessao (crossSessionInbound accept)', async () => {
  const dir = fileURLToPath(new URL('../central/', import.meta.url));
  const vbs = fs.readFileSync(path.join(dir, 'abrir-central.vbs'), 'utf8');
  assert.match(vbs, /^ajustes = montada & "\\ajustes\.json"\r?$/m, 'caminho do arquivo de ajustes da central');
  const cmd = /^cmd = (.+)$/m.exec(vbs)?.[1] ?? '';
  assert.ok(cmd.includes('--settings """ & ajustes & """'), 'a linha do wt passa --settings com o arquivo entre aspas');
  const { montarAjustes } = await import('../lib/central.mjs');
  for (const modo of ['sozinha', 'pedir']) {
    assert.equal(montarAjustes({ modo, repo: 'C:\\projetos\\tele-control', node: 'node.exe' }).crossSessionInbound, 'accept', modo);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// F4b (30/09/2026, PLANO.md "Fase 4b"; decisao A do dono = nome gravado no arquivo da sessao): sessao nova pelo WhatsApp.
// A central grava `abrir-sessao --nome --pasta --msg`; o porteiro confere (central viva, fala do dono, pasta dentro das
// raizes), abre o VS Code (duble: o `code` de verdade NUNCA roda em teste), acha a aba nova (o MESMO sessionId vivo em 2
// checagens com 10 s ou mais entre elas: medido 30/09 15:1x, o 1o registro de uma janela nova some em segundos), entrega
// a fala como encaminhada e, depois do "enviado", acrescenta o nome no transcript da aba (linha custom-title).

const SESSAO_ABERTA = (n, p) => `${CAB}\nAbri a sessão ${n} em ${p} e passei o seu pedido.`;
// A3a: os nomes das pastas de projeto vem do config (o ultimo nome de cada uma), nao mais fixos no codigo
const SESSAO_PASTA_RECUSADA = (n) => `${CAB}\nNão abri a sessão ${n}: a pasta não existe ou fica fora de repos e Area.`;
const SESSAO_FALHOU_ABRIR = (n) => `${CAB}\nNão consegui abrir o VS Code pra sessão ${n}.`;
const SESSAO_NAO_ABRIU = (n) => `${CAB}\nNão consegui abrir a sessão ${n}: o VS Code não mostrou a aba nova em 3 min.`;
const SESSAO_JA_ABERTA = (n, p) => `${CAB}\nNão abri a sessão ${n}: ${p} já está aberta numa janela do VS Code. Abre a aba nova nela no PC.`;
const NOME_NAO_PEGOU = ' O nome não pegou; renomeie no PC.';
const NOME_SESSAO = 'Revisão Porteiro';
const FALA_SESSAO = 'abre uma sessão pra revisar o porteiro';
const SESSAO_VSCODE = '20260930T085209'; // F4c: sessao viva dos logs do VS Code (a medida em 30/09)
const LINKS_VISTOS = []; // F4c 14: todo windowId que os dubles do abrirLinkVsCode receberam, em todos os testes

// Raizes de mentira dentro da pasta temporaria (`repos` e `...\Area`, como as de verdade) + o duble do
// abrirSessaoVsCode (`h.abrirSessaoFalha` = rejeita; `semAbrir` = porteiro sem a opcao). h.p ganha o passoSessoes (com a
// bomba da fila de entrega, como os outros passos).
// F4c: dubles das janelas do VS Code (`h.janelas` = o que os logs mostram {sessao, ids, comClaude}, null = sem logs;
// `semJanelas` = porteiro sem a opcao; `h.janelasFalha` = lanca) e do link com windowId (`h.links` = chamadas;
// `h.linkFalha` = rejeita; `h.aoLink(n)` = roda na chamada; `semLink` = sem a opcao). Abrir o VS Code poe a janela nova
// nos logs, ainda sem o Claude: `h.janelaAoAbrir` = 'nova' (maior + 1), um numero, ou null (a pasta ja tinha janela).
// A3a: `raizes({repos, workspace, raiz})` -> as pastas de projeto do porteiro (padrao: as 2 de mentira).
function montarSessao({ semAbrir = false, semJanelas = false, semLink = false, soRaiz = false, raizes = ({ repos, workspace }) => [repos, workspace], ...o } = {}) {
  const h = montar(o);
  const repos = path.join(h.raiz, 'repos');
  const workspace = path.join(h.raiz, 'Meus Docs', 'trabalho', 'Area');
  for (const d of [
    path.join(repos, 'sessoes-wpp'), path.join(repos, 'site', 'node_modules', 'pacote'), path.join(repos, 'site', '.git'),
    path.join(workspace, 'Comercial'), path.join(h.raiz, 'fora'), `${repos}x`,
  ]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(path.join(repos, 'LEIA.txt'), 'arquivo, nao pasta');
  Object.assign(h, { repos, workspace, pasta: path.join(repos, 'sessoes-wpp'), aberturasSessao: [], abrirSessaoFalha: null });
  Object.assign(h, {
    janelas: { sessao: SESSAO_VSCODE, ids: [1], comClaude: [1] }, janelaAoAbrir: 'nova', janelasFalha: false,
    links: [], linkFalha: null, aoLink: null,
  });
  h.raizes = raizes({ repos, workspace, raiz: h.raiz });
  const extra = { raizesSessao: h.raizes, ensaio: o.ensaio ?? false };
  if (soRaiz) extra.sessaoSoNaRaiz = true;
  if (!semAbrir) {
    extra.abrirSessaoVsCode = async (pasta) => {
      h.aberturasSessao.push(pasta);
      if (h.abrirSessaoFalha) throw new Error(h.abrirSessaoFalha);
      if (h.janelas && h.janelaAoAbrir !== null) {
        h.janelas.ids.push(h.janelaAoAbrir === 'nova' ? Math.max(0, ...h.janelas.ids) + 1 : h.janelaAoAbrir);
      }
    };
  }
  if (!semJanelas) {
    extra.janelasVsCode = () => {
      if (h.janelasFalha) throw new Error('logs ilegiveis');
      return h.janelas ? structuredClone(h.janelas) : null;
    };
  }
  if (!semLink) {
    extra.abrirLinkVsCode = async (n) => {
      LINKS_VISTOS.push(n);
      h.links.push(n);
      if (h.aoLink) h.aoLink(n);
      if (h.linkFalha) throw new Error(h.linkFalha);
    };
  }
  const cru = porteiroCom(h, extra);
  h.cru = cru;
  h.p = { ...comBomba(cru), passoSessoes: async () => { await cru.passoSessoes(); await bombear(cru); } };
  return h;
}

// Registro de aba do VS Code como a extensao grava (cwd com a letra do drive minuscula, startedAt em ms). Devolve o
// arquivo: apagar = o registro sumiu.
function abaNova(h, { sessionId, cwd = h.pasta, startedAt = h.t, name = `aba-${sessionId.toLowerCase()}`, entrypoint = 'claude-vscode' }) {
  h.nReg += 1;
  const arq = path.join(h.env.CLAUDE_SESSIONS_DIR, `${100000 + h.nReg}.json`);
  const c = cwd.slice(0, 1).toLowerCase() + cwd.slice(1);
  fs.writeFileSync(arq, JSON.stringify({
    pid: process.pid, sessionId, cwd: c, entrypoint, name, nameSource: 'derived', status: 'idle', startedAt, updatedAt: h.t,
  }));
  return arq;
}
const abrirSessaoEv = (h, o = {}) =>
  evento(h, { v: 1, tipo: 'abrir-sessao', at: iso(h.t), nome: NOME_SESSAO, pasta: h.pasta, providerMsgId: null, por: 'SC', ...o });
const linhaNome = (nome, sid) => `${JSON.stringify({ type: 'custom-title', customTitle: nome, sessionId: sid })}\n`;
function travar(h) {
  const arq = path.join(h.env.SESSOES_WPP_DIR, 'estado.json');
  fs.writeFileSync(arq, JSON.stringify({ ...JSON.parse(fs.readFileSync(arq, 'utf8')), trava: true }));
}

// Caminho real ate o "enviado": fala do dono -> central (entrega A) -> central grava abrir-sessao -> VS Code (duble) ->
// aba nova N1 vista em 2 checagens com 10 s -> pedido na aba (o duble do mensageiro devolve "enviado" na hora).
async function cenaSessao(h, { pasta = h.pasta } = {}) {
  centralCli(h);
  const m = msg(h, { content: FALA_SESSAO });
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 1, 'a fala foi pra central');
  h.t += 10 * 1000;
  abrirSessaoEv(h, { providerMsgId: m.provider_msg_id, pasta });
  await h.p.passoEventos();
  assert.deepEqual(h.aberturasSessao, [pasta]);
  h.t += 3000;
  abaNova(h, { sessionId: 'N1', cwd: pasta });
  await h.p.passoSessoes();
  h.t += 10 * 1000;
  await h.p.passoSessoes();
  assert.equal(h.entregas.length, 2, 'fala na aba nova');
  return { m, pedido: h.entregas[1] };
}

test('F4b 1. feliz: central viva manda abrir-sessao -> VS Code 1x na pasta; registro 1 some e nasce o 2; so o 2 vale (2 checagens >= 10 s); pedido com a fala literal e encaminhado; enviado -> 1 linha custom-title acrescentada e frase com a pasta curta', async () => {
  const h = montarSessao();
  centralCli(h);
  const m = msg(h, { content: FALA_SESSAO });
  const A = m.provider_msg_id;
  await h.p.passoGrupo();
  assert.deepEqual(h.entregas.map((x) => [x.sessionId, x.providerMsgId]), [['SC', A]], 'a fala entrou na central');
  h.t += 10 * 1000;
  abrirSessaoEv(h, { providerMsgId: A });
  const leituras = h.leituras;
  await h.p.passoEventos();
  assert.equal(h.leituras, leituras + 1, '1 leitura do grupo pra achar a fala');
  assert.deepEqual(h.aberturasSessao, [h.pasta]);
  assert.deepEqual(h.enviados, [], 'nenhuma frase ainda');
  assert.equal(h.entregas.length, 1);
  let e = estado(h);
  assert.deepEqual(e.sessoesNovas, [{
    id: A, nome: NOME_SESSAO, pasta: h.pasta, desde: iso(h.t), antes: [],
    janelasAntes: { sessao: SESSAO_VSCODE, ids: [1] }, janela: null, linkEm: null, // F4c
    fala: { texto: FALA_SESSAO, audio: false, hora: '16:00', messageId: m.id, anexos: [] },
    candidato: null,
  }]);

  // a janela nova: o 1o registro some em segundos e nasce outro, com sessionId diferente (medido 30/09 15:1x)
  h.t += 2000;
  const r1 = abaNova(h, { sessionId: 'N1' });
  await h.p.passoSessoes();
  assert.deepEqual(estado(h).sessoesNovas[0].candidato, { sessionId: 'N1', vistoEm: iso(h.t) });
  h.t += 4000;
  fs.unlinkSync(r1);
  abaNova(h, { sessionId: 'N2' });
  await h.p.passoSessoes();
  assert.deepEqual(estado(h).sessoesNovas[0].candidato, { sessionId: 'N2', vistoEm: iso(h.t) });
  h.t += 9000;
  await h.p.passoSessoes();
  assert.equal(h.entregas.length, 1, '9 s: ainda nao vale');

  // 10 s com o mesmo sessionId vivo = vale. O mensageiro fica preso: o recado entra na aba antes do "enviado".
  h.segurar = true;
  h.t += 1000;
  await h.cru.passoSessoes();
  await h.cru.passoEntrega();
  assert.equal(h.entregas.length, 2);
  assert.deepEqual(h.entregas[1], {
    sessionId: 'N2', nome: 'aba-n2', titulo: NOME_SESSAO, texto: FALA_SESSAO, audio: false, hora: '16:00',
    providerMsgId: `${A}-E1`, messageId: m.id, anexos: [], encaminhado: true, nomear: NOME_SESSAO, pasta: h.pasta,
  });
  assert.match(montarRecado(h.entregas[1]), new RegExp(`^WhatsApp do dono \\(16:00, id ${A}-E1\\)`));
  assert.deepEqual(estado(h).sessoesNovas, [], 'o item saiu');
  const arq = transcript(h, 'N2', [peer(h.entregas[1], false, iso(h.t)), aiTitle('Revisar o porteiro')], 'c--projetos-sessoes-wpp');
  const antesTxt = fs.readFileSync(arq, 'utf8');
  h.segurar = false;
  h.presas.shift()();
  await tique();
  await h.cru.passoEntrega();
  assert.equal(fs.readFileSync(arq, 'utf8'), `${antesTxt}${linhaNome(NOME_SESSAO, 'N2')}`, 'so 1 linha no fim; as antigas intactas');
  assert.deepEqual(h.enviados.map((x) => x.texto), [SESSAO_ABERTA(NOME_SESSAO, 'repos\\sessoes-wpp')]);
  assert.equal(h.reacoes.length, 1, 'sem ✅ novo (a fala ja foi reagida quando entrou na central)');
  assert.equal(linhasDoLog(h, /sessao N2 nomeada Revisão Porteiro/).length, 1);
  e = estado(h);
  assert.equal(e.entregas[`${A}-E1`].sessionId, 'N2');
  assert.equal(e.entregas[A].sessionId, 'SC', 'a entrega da central fica intacta');
  assert.deepEqual(e.nomesPendentes, []);

  h.t += 3 * MIN;
  await h.p.passoSessoes();
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 1, 'nada mais no grupo');
  assert.equal(h.entregas.length, 2, 'nada reentregue');
  assert.equal(fs.readFileSync(arq, 'utf8').split(linhaNome(NOME_SESSAO, 'N2')).length, 2, 'nome gravado 1 vez so');
});

test('F4b 2. "enviado" sem transcript: grava na volta em que o arquivo aparece; 2 min sem ele -> a mesma frase com o sufixo e nada gravado', async () => {
  const h = montarSessao();
  const { pedido } = await cenaSessao(h);
  assert.deepEqual(h.enviados, [], 'sem transcript: nada ainda');
  assert.equal(estado(h).nomesPendentes.length, 1);
  h.t += 30 * 1000;
  await h.p.passoSessoes();
  assert.deepEqual(h.enviados, []);
  const arq = transcript(h, 'N1', [peer(pedido, false, iso(h.t))], 'c--projetos-sessoes-wpp');
  const antesTxt = fs.readFileSync(arq, 'utf8');
  h.t += 15 * 1000;
  await h.p.passoSessoes();
  assert.equal(fs.readFileSync(arq, 'utf8'), `${antesTxt}${linhaNome(NOME_SESSAO, 'N1')}`);
  assert.deepEqual(h.enviados.map((x) => x.texto), [SESSAO_ABERTA(NOME_SESSAO, 'repos\\sessoes-wpp')]);
  assert.deepEqual(estado(h).nomesPendentes, []);

  const h2 = montarSessao();
  const c2 = await cenaSessao(h2);
  const enviadoEm = h2.t;
  h2.t = enviadoEm + 2 * MIN - 1000;
  await h2.p.passoSessoes();
  assert.deepEqual(h2.enviados, [], 'antes de 2 min: espera');
  h2.t = enviadoEm + 2 * MIN;
  await h2.p.passoSessoes();
  assert.deepEqual(h2.enviados.map((x) => x.texto), [`${SESSAO_ABERTA(NOME_SESSAO, 'repos\\sessoes-wpp')}${NOME_NAO_PEGOU}`]);
  assert.deepEqual(estado(h2).nomesPendentes, []);
  assert.equal(linhasDoLog(h2, /sessao N1 sem transcript em 2 min/).length, 1);
  const arq2 = transcript(h2, 'N1', [peer(c2.pedido, false, iso(h2.t))], 'c--projetos-sessoes-wpp');
  h2.t += MIN;
  await h2.p.passoSessoes();
  assert.ok(!fs.readFileSync(arq2, 'utf8').includes('custom-title'), 'nada gravado depois do prazo');
  assert.equal(h2.enviados.length, 1);
});

test('F4b 2b. transcript com a ultima linha cortada (a aba escrevendo): nao cola no meio dela; grava na volta seguinte, com a linha completa', async () => {
  const h = montarSessao();
  const { pedido } = await cenaSessao(h);
  const arq = transcript(h, 'N1', [peer(pedido, false, iso(h.t))], 'c--projetos-sessoes-wpp');
  fs.appendFileSync(arq, '{"type":"assistant","mess');
  h.t += 15 * 1000;
  await h.p.passoSessoes();
  assert.ok(!fs.readFileSync(arq, 'utf8').includes('custom-title'), 'linha cortada no fim: espera');
  assert.deepEqual(h.enviados, []);
  fs.appendFileSync(arq, 'age":{"role":"assistant","content":[]}}\n');
  const antesTxt = fs.readFileSync(arq, 'utf8');
  h.t += 15 * 1000;
  await h.p.passoSessoes();
  assert.equal(fs.readFileSync(arq, 'utf8'), `${antesTxt}${linhaNome(NOME_SESSAO, 'N1')}`);
  assert.deepEqual(h.enviados.map((x) => x.texto), [SESSAO_ABERTA(NOME_SESSAO, 'repos\\sessoes-wpp')]);
});

test('F4b 3. abrir-sessao que nao veio da central viva (outra aba, sem por, sem central) ou com campo ruim -> log, VS Code nao abre, grupo nem lido, nenhuma frase', async () => {
  const casos = {
    'outra aba': [{ por: 'S1' }, /abrir-sessao ignorado: nao veio da central viva/],
    'sem por': [{ por: null }, /abrir-sessao ignorado: nao veio da central viva/],
    'sem central': [{ por: 'SC' }, /abrir-sessao ignorado: nao veio da central viva/, (h) => fecharSessao(h, 'SC')],
    'nome com quebra de linha': [{ nome: 'Linha 1\nLinha 2' }, /abrir-sessao ignorado: sem nome valido/],
    'nome com 61 caracteres': [{ nome: 'x'.repeat(61) }, /abrir-sessao ignorado: sem nome valido/],
    'sem pasta': [{ pasta: '' }, /abrir-sessao ignorado: sem nome valido/],
    'sem id': [{ providerMsgId: null }, /abrir-sessao ignorado: sem nome valido/],
  };
  for (const [nome, [o, re, antes]] of Object.entries(casos)) {
    const h = montarSessao();
    abaFaro(h);
    centralCli(h);
    const m = msg(h, { content: FALA_SESSAO });
    if (antes) antes(h);
    const leituras = h.leituras;
    abrirSessaoEv(h, { providerMsgId: m.provider_msg_id, ...o });
    await h.p.passoEventos();
    h.t += 90 * 1000;
    await h.p.passoSessoes();
    assert.deepEqual(h.aberturasSessao, [], nome);
    assert.deepEqual(h.enviados, [], nome);
    assert.equal(h.entregas.length, 0, nome);
    assert.equal(h.leituras, leituras, `${nome}: nao le o WhatsApp`);
    assert.equal(linhasDoLog(h, re).length, 1, nome);
    assert.deepEqual(estado(h).sessoesNovas, [], nome);
  }
});

test('F4b 4. pasta que nao existe, fora das raizes, com .. saindo da raiz, dentro de node_modules/.git, relativa, arquivo ou prefixo da raiz -> frase de pasta recusada, nada abre; maiuscula, barra / e .. que fica dentro valem', async () => {
  const h = montarSessao();
  centralCli(h);
  const m = msg(h, { content: FALA_SESSAO });
  const ruins = [
    path.join(h.repos, 'nao-existe'),
    path.join(h.raiz, 'fora'),
    `${h.repos}\\sessoes-wpp\\..\\..\\fora`,
    path.join(h.repos, 'site', 'node_modules', 'pacote'),
    path.join(h.repos, 'site', '.git'),
    'repos\\sessoes-wpp',
    path.join(h.repos, 'LEIA.txt'),
    `${h.repos}x`,
  ];
  for (const pasta of ruins) {
    h.t += 61 * 1000; // 1 frase por janela de 60 s
    abrirSessaoEv(h, { providerMsgId: m.provider_msg_id, pasta });
    await h.p.passoEventos();
    assert.equal(h.enviados.at(-1)?.texto, SESSAO_PASTA_RECUSADA(NOME_SESSAO), pasta);
    assert.deepEqual(h.aberturasSessao, [], pasta);
  }
  assert.equal(h.enviados.length, ruins.length);
  assert.deepEqual(estado(h).sessoesNovas, []);
  // sem diferenca de maiuscula/minuscula e de barra; o `..` que fica dentro da raiz vale; o VS Code recebe a pasta resolvida
  h.t += 61 * 1000;
  abrirSessaoEv(h, { providerMsgId: m.provider_msg_id, pasta: `${h.repos.toUpperCase().replaceAll('\\', '/')}/site/../sessoes-wpp/` });
  await h.p.passoEventos();
  assert.equal(h.aberturasSessao.length, 1);
  assert.equal(h.aberturasSessao[0].toLowerCase(), h.pasta.toLowerCase());
  assert.ok(!h.aberturasSessao[0].includes('/') && !h.aberturasSessao[0].includes('..'), h.aberturasSessao[0]);
  assert.equal(h.enviados.length, ruins.length, 'aceita = nenhuma frase');
});

test('F4b 4b. pasta curta na frase: repos\\<resto>, Area\\<resto>; a propria raiz = repos / Area', async () => {
  const casos = [
    [(h) => h.repos, 'repos'],
    [(h) => path.join(h.workspace, 'Comercial'), 'Area\\Comercial'],
    [(h) => h.workspace, 'Area'],
  ];
  for (const [pastaDe, curta] of casos) {
    const h = montarSessao();
    const pasta = pastaDe(h);
    await cenaSessao(h, { pasta });
    // o transcript da aba nova so nasce com a 1a mensagem (antes dele ela nem seria a nova): grava na volta seguinte
    transcript(h, 'N1', [aiTitle('Conversa nova')], 'c--x');
    await h.p.passoSessoes();
    assert.deepEqual(h.enviados.map((x) => x.texto), [SESSAO_ABERTA(NOME_SESSAO, curta)], curta);
  }
});

test('F4b 5. abrirSessaoVsCode rejeita (ou o porteiro nao tem) -> frase de falha, nenhum item esperando; a central pode pedir de novo', async () => {
  const h = montarSessao();
  centralCli(h);
  h.abrirSessaoFalha = 'code.cmd saiu com 1';
  const m = msg(h, { content: FALA_SESSAO });
  abrirSessaoEv(h, { providerMsgId: m.provider_msg_id });
  await h.p.passoEventos();
  assert.deepEqual(h.aberturasSessao, [h.pasta]);
  assert.deepEqual(h.enviados.map((x) => x.texto), [SESSAO_FALHOU_ABRIR(NOME_SESSAO)]);
  assert.deepEqual(estado(h).sessoesNovas, []);
  assert.equal(linhasDoLog(h, /abrir-sessao falhou/).length, 1);
  h.abrirSessaoFalha = null;
  h.t += 61 * 1000;
  abrirSessaoEv(h, { providerMsgId: m.provider_msg_id });
  await h.p.passoEventos();
  assert.equal(h.aberturasSessao.length, 2, 'nada ficou pendurado: o pedido seguinte abre');
  assert.equal(estado(h).sessoesNovas.length, 1);

  const h2 = montarSessao({ semAbrir: true });
  centralCli(h2);
  const m2 = msg(h2, { content: FALA_SESSAO });
  abrirSessaoEv(h2, { providerMsgId: m2.provider_msg_id });
  await h2.p.passoEventos();
  assert.deepEqual(h2.enviados.map((x) => x.texto), [SESSAO_FALHOU_ABRIR(NOME_SESSAO)]);
  assert.equal(linhasDoLog(h2, /sem abrirSessaoVsCode/).length, 1);
  assert.deepEqual(estado(h2).sessoesNovas, []);
});

test('F4b 6. 180 s sem aba nova valida -> frase "não mostrou a aba nova", o item sai; a aba que aparece tarde nao recebe nada', async () => {
  const h = montarSessao();
  centralCli(h);
  const m = msg(h, { content: FALA_SESSAO });
  abrirSessaoEv(h, { providerMsgId: m.provider_msg_id });
  await h.p.passoEventos();
  const t0 = h.t;
  for (const s of [15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165]) {
    h.t = t0 + s * 1000;
    await h.p.passoSessoes();
  }
  h.t = t0 + 170 * 1000;
  abaNova(h, { sessionId: 'N1' }); // tarde: nao da tempo das 2 checagens com 10 s
  h.t = t0 + 179 * 1000;
  await h.p.passoSessoes();
  assert.deepEqual(h.enviados, [], '179 s: espera');
  h.t = t0 + 180 * 1000;
  await h.p.passoSessoes();
  assert.deepEqual(h.enviados.map((x) => x.texto), [SESSAO_NAO_ABRIU(NOME_SESSAO)]);
  assert.deepEqual(estado(h).sessoesNovas, []);
  h.t += 30 * 1000;
  await h.p.passoSessoes();
  assert.equal(h.entregas.length, 0);
  assert.equal(h.enviados.length, 1);
});

test('F4b 7. aba que ja existia na pasta (antes) nunca vira a nova, nem com startedAt mais novo; terminal (cli), outra pasta e registro sem nome tambem nao; a nova de verdade vale', async () => {
  const h = montarSessao();
  centralCli(h);
  abaNova(h, { sessionId: 'VELHA', startedAt: h.t + 60 * MIN });
  const m = msg(h, { content: FALA_SESSAO });
  abrirSessaoEv(h, { providerMsgId: m.provider_msg_id });
  await h.p.passoEventos();
  assert.deepEqual(estado(h).sessoesNovas[0].antes, ['VELHA']);
  abaNova(h, { sessionId: 'TERM', entrypoint: 'cli' });
  abaNova(h, { sessionId: 'OUTRA', cwd: path.join(h.workspace, 'Comercial') });
  abaNova(h, { sessionId: 'SEMNOME', name: null });
  for (let i = 0; i < 4; i++) {
    h.t += 15 * 1000;
    await h.p.passoSessoes();
  }
  assert.equal(h.entregas.length, 0);
  assert.equal(estado(h).sessoesNovas[0].candidato, null);
  abaNova(h, { sessionId: 'N1' });
  h.t += 1000;
  await h.p.passoSessoes();
  h.t += 10 * 1000;
  await h.p.passoSessoes();
  assert.deepEqual(h.entregas.map((x) => x.sessionId), ['N1']);
});

test('F4b 8. fala que nao se acha (id fora da leitura, de outro numero, com mais de 2 h) -> "Não achei a mensagem", nada abre', async () => {
  const casos = {
    'id fora da leitura': (h) => {
      msg(h, { content: FALA_SESSAO });
      return 'PROV-NAO-EXISTE';
    },
    'outro numero': (h) => msg(h, { content: FALA_SESSAO, sender_phone: '5511900000000' }).provider_msg_id,
    'mais de 2 h': (h) => {
      const id = msg(h, { content: FALA_SESSAO }).provider_msg_id;
      h.t += 2 * 60 * MIN + 1000;
      return id;
    },
  };
  for (const [nome, preparar] of Object.entries(casos)) {
    const h = montarSessao();
    centralCli(h);
    const id = preparar(h);
    abrirSessaoEv(h, { providerMsgId: id });
    await h.p.passoEventos();
    assert.deepEqual(h.enviados.map((x) => x.texto), [NAO_ACHEI_MSG(NOME_SESSAO)], nome);
    assert.deepEqual(h.aberturasSessao, [], nome);
    assert.deepEqual(estado(h).sessoesNovas, [], nome);
  }
});

test('F4b 9. mesma linha de evento 2x = tratada 1 vez; o mesmo pedido de novo com a 1a esperando nao abre outra; ja passada = frase; travado ignora; travado com a aba esperando nao entrega ate destravar e, travado ate os 180 s, sai calado', async () => {
  const h = montarSessao();
  centralCli(h);
  const m = msg(h, { content: FALA_SESSAO });
  // a mesma linha lida 2x (eventos.jsonl relido): a 2a nao tenta abrir de novo, nem com a 1a tendo falhado
  h.abrirSessaoFalha = 'code.cmd saiu com 1';
  const ev = { v: 1, tipo: 'abrir-sessao', at: iso(h.t), nome: NOME_SESSAO, pasta: h.pasta, providerMsgId: m.provider_msg_id, por: 'SC' };
  evento(h, ev);
  evento(h, ev);
  await h.p.passoEventos();
  assert.equal(h.aberturasSessao.length, 1, 'mesma linha: tratada 1 vez');
  assert.deepEqual(h.enviados.map((x) => x.texto), [SESSAO_FALHOU_ABRIR(NOME_SESSAO)]);
  h.abrirSessaoFalha = null;
  h.t += 61 * 1000;
  abrirSessaoEv(h, { providerMsgId: m.provider_msg_id });
  await h.p.passoEventos();
  assert.equal(h.aberturasSessao.length, 2);
  // a central repete o pedido (outro `at`) com a aba ainda esperando: nao abre outra janela e nao manda frase
  h.t += 5000;
  abrirSessaoEv(h, { providerMsgId: m.provider_msg_id });
  await h.p.passoEventos();
  assert.equal(h.aberturasSessao.length, 2);
  assert.equal(h.enviados.length, 1);
  // aba achada e fala entregue: o pedido seguinte da mesma fala = "já foi passada"
  abaNova(h, { sessionId: 'N1' });
  await h.p.passoSessoes();
  h.t += 10 * 1000;
  await h.p.passoSessoes();
  assert.deepEqual(h.entregas.map((x) => x.sessionId), ['N1']);
  h.t += 61 * 1000;
  abrirSessaoEv(h, { providerMsgId: m.provider_msg_id });
  await h.p.passoEventos();
  assert.equal(h.aberturasSessao.length, 2);
  assert.deepEqual(h.enviados.slice(1).map((x) => x.texto), [JA_PASSADA(NOME_SESSAO)]);
  assert.equal(h.entregas.length, 1);

  // travado: o evento e ignorado (log), nada abre, nenhuma frase; destravar depois nao ressuscita o evento
  const h2 = montarSessao();
  centralCli(h2);
  const m2 = msg(h2, { content: FALA_SESSAO });
  travar(h2);
  abrirSessaoEv(h2, { providerMsgId: m2.provider_msg_id });
  await h2.p.passoEventos();
  assert.deepEqual(h2.aberturasSessao, []);
  assert.deepEqual(h2.enviados, []);
  assert.equal(linhasDoLog(h2, /abrir-sessao ignorado: travado/).length, 1);
  assert.equal(destravar({ env: h2.env }).ok, true);
  await h2.p.passoEventos();
  assert.deepEqual(h2.aberturasSessao, []);

  // travou com a aba esperando: nao entrega; destravou antes dos 180 s = entrega
  const h3 = montarSessao();
  centralCli(h3);
  const m3 = msg(h3, { content: FALA_SESSAO });
  abrirSessaoEv(h3, { providerMsgId: m3.provider_msg_id });
  await h3.p.passoEventos();
  const t3 = h3.t;
  abaNova(h3, { sessionId: 'N1' });
  travar(h3);
  for (const s of [10, 25, 40]) {
    h3.t = t3 + s * 1000;
    await h3.p.passoSessoes();
  }
  assert.equal(h3.entregas.length, 0, 'travado: a aba espera');
  assert.equal(estado(h3).sessoesNovas.length, 1);
  assert.equal(destravar({ env: h3.env }).ok, true);
  h3.t = t3 + 55 * 1000;
  await h3.p.passoSessoes();
  assert.deepEqual(h3.entregas.map((x) => x.sessionId), ['N1']);

  // travado ate os 180 s: o item sai calado (nada sai do porteiro travado)
  const h4 = montarSessao();
  centralCli(h4);
  const m4 = msg(h4, { content: FALA_SESSAO });
  abrirSessaoEv(h4, { providerMsgId: m4.provider_msg_id });
  await h4.p.passoEventos();
  const t4 = h4.t;
  abaNova(h4, { sessionId: 'N1' });
  travar(h4);
  for (const s of [15, 30, 60, 90, 120, 150, 180]) {
    h4.t = t4 + s * 1000;
    await h4.p.passoSessoes();
  }
  assert.equal(h4.entregas.length, 0);
  assert.deepEqual(h4.enviados, []);
  assert.deepEqual(estado(h4).sessoesNovas, []);
  assert.equal(linhasDoLog(h4, /travado ate o fim da espera/).length, 1);
});

test('F4b 10. ensaio: registra abrirSessao {nome, pasta}, nao chama o VS Code e nao guarda item', async () => {
  const h = montarSessao({ ensaio: true });
  centralCli(h);
  const m = msg(h, { content: FALA_SESSAO });
  abrirSessaoEv(h, { providerMsgId: m.provider_msg_id });
  await h.p.passoEventos();
  assert.deepEqual(h.aberturasSessao, []);
  const acoes = fs.readFileSync(path.join(h.env.SESSOES_WPP_DIR, 'ensaio.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(acoes.map(({ at, ...resto }) => resto), [{ acao: 'abrirSessao', nome: NOME_SESSAO, pasta: h.pasta }]);
  assert.deepEqual(estado(h, 'estado-ensaio.json').sessoesNovas, []);
  assert.equal(fs.existsSync(path.join(h.env.SESSOES_WPP_DIR, 'estado.json')), false);
  abaNova(h, { sessionId: 'N1' });
  for (let i = 0; i < 3; i++) {
    h.t += 15 * 1000;
    await h.p.passoSessoes();
  }
  assert.equal(h.entregas.length, 0);
  assert.equal(h.enviados.length, 0);
});

test('F4b 11. CLI abrir-sessao: sem --nome/--pasta/--msg, vazio, nome com quebra de linha ou 61+ caracteres = exit 1 e nada gravado; certo = 1 evento com os campos e o por, exit 0', () => {
  const raiz = pastaTemp('porteiro-abs-');
  const dir = path.join(raiz, 'estado');
  const base = { ...process.env, SESSOES_WPP_DIR: dir, SESSOES_WPP_LOG: path.join(raiz, 'l.log') };
  delete base.CLAUDE_CODE_SESSION_ID;
  delete base.SESSOES_WPP_ENSAIO;
  const rodarCli = (args, env = base) => spawnSync(process.execPath, [PORTEIRO, 'abrir-sessao', ...args], { env, encoding: 'utf8' });
  const arq = path.join(dir, 'eventos.jsonl');
  const P = 'C:\\projetos\\sessoes-wpp';
  const ruins = [
    [], ['--pasta', P, '--msg', 'PROV1'], ['--nome', 'Site', '--msg', 'PROV1'], ['--nome', 'Site', '--pasta', P],
    ['--nome', '', '--pasta', P, '--msg', 'PROV1'], ['--nome', '   ', '--pasta', P, '--msg', 'PROV1'],
    ['--nome', 'Site', '--pasta', '', '--msg', 'PROV1'], ['--nome', 'Site', '--pasta', P, '--msg', ''],
    ['--nome', '--pasta', P, '--msg', 'PROV1'], ['--nome', 'Site', '--pasta', P, '--msg'],
    ['--nome', 'Linha 1\nLinha 2', '--pasta', P, '--msg', 'PROV1'],
    ['--nome', 'x'.repeat(61), '--pasta', P, '--msg', 'PROV1'],
  ];
  for (const args of ruins) {
    const r = rodarCli(args);
    const nome = JSON.stringify(args);
    assert.equal(r.status, 1, nome);
    const j = JSON.parse(r.stdout.trim());
    assert.equal(j.ok, false, nome);
    assert.equal(typeof j.erro, 'string', nome);
    assert.equal(fs.existsSync(arq) ? fs.readFileSync(arq, 'utf8') : '', '', `${nome}: nada gravado`);
  }
  // 60 caracteres (com acento), espaco nas pontas sai; pasta com espaco chega inteira
  const nome60 = `${'é'.repeat(59)}x`;
  const pastaWs = 'D:\\Meus Docs\\trabalho\\Area\\Comercial';
  const antes = Date.now();
  let r = rodarCli(['--nome', `  ${nome60}  `, '--pasta', pastaWs, '--msg', '3EB0ABC'], { ...base, CLAUDE_CODE_SESSION_ID: 'sessao-central' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), ['{"ok":true}']);
  let evs = fs.readFileSync(arq, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(evs.length, 1);
  const { at, ...resto } = evs[0];
  assert.deepEqual(resto, { v: 1, tipo: 'abrir-sessao', nome: nome60, pasta: pastaWs, providerMsgId: '3EB0ABC', por: 'sessao-central' });
  assert.ok(Date.parse(at) >= antes - 1000 && Date.parse(at) <= Date.now() + 1000, 'at = agora, ISO');
  // fora de uma sessao do Claude: por = null (o porteiro ignora)
  r = rodarCli(['--nome', 'Pesquisa de Preço', '--pasta', P, '--msg', '3EB0DEF']);
  assert.equal(r.status, 0, r.stderr);
  evs = fs.readFileSync(arq, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(evs.length, 2);
  assert.equal(evs[1].por, null);
  assert.equal(evs[1].nome, 'Pesquisa de Preço');
});

// spawn falso do cmd.exe: grava a chamada; depois emite 'exit' (codigo 0, ou o numero do modo), 'error' ('erro') ou nada
// ('nada' = pendurado). `modos[i]` vale pra i-esima chamada (faltou = 'ok').
function spawnCmdFalso(modos = []) {
  const chamadas = [];
  const fn = (cmd, args, opts) => {
    const filho = new EventEmitter();
    filho.kill = () => { filho.morto = true; };
    const modo = modos[chamadas.length] ?? 'ok';
    chamadas.push({ cmd, args, opts, filho });
    setImmediate(() => {
      if (modo === 'erro') filho.emit('error', Object.assign(new Error('spawn cmd.exe ENOENT'), { code: 'ENOENT' }));
      else if (modo === 'ok') filho.emit('exit', 0, null);
      else if (typeof modo === 'number') filho.emit('exit', modo, null);
    });
    return filho;
  };
  fn.chamadas = chamadas;
  return fn;
}

test('F4b 12. abrirSessaoReal (spawn falso): 1 cmd.exe so, com a pasta (F4c: sem pausa e sem --open-url; o link sai pelo abrirLinkReal com windowId), pasta com espaco inteira entre aspas, sem janela, sem a identidade da sessao no ambiente; erro, saida != 0 e prazo rejeitam; SESSOES_WPP_CODE troca o caminho', async () => {
  assert.equal(typeof porteiroMod.abrirSessaoReal, 'function', 'abrirSessaoReal testavel (spawn injetado)');
  const real = porteiroMod.abrirSessaoReal;
  const pasta = 'D:\\Meus Docs\\trabalho\\Area\\Comercial';
  const env = {
    LOCALAPPDATA: 'C:\\Users\\Ana Souza\\AppData\\Local', PATH: 'x', CLAUDE_CODE_SESSION_ID: 'S', CLAUDECODE: '1',
    CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', VSCODE_IPC_HOOK_CLI: 'pipe-velho',
  };
  const code = 'C:\\Users\\Ana Souza\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd';
  const esperas = [];
  const sp = spawnCmdFalso();
  await real({ spawn: sp, env, esperar: async (ms) => { esperas.push([ms, sp.chamadas.length]); } })(pasta);
  assert.deepEqual(sp.chamadas.map((c) => c.cmd), ['cmd.exe']);
  assert.deepEqual(sp.chamadas[0].args, ['/d', '/s', '/c', `""${code}" "${pasta}""`], 'a pasta com espaco e 1 argumento so, entre aspas');
  assert.deepEqual(esperas, [], 'sem a pausa de 2,5 s');
  for (const c of sp.chamadas) {
    assert.equal(c.opts.windowsHide, true);
    assert.equal(c.opts.windowsVerbatimArguments, true);
    assert.equal(c.opts.env.PATH, 'x');
    for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'VSCODE_IPC_HOOK_CLI']) {
      assert.equal(Object.hasOwn(c.opts.env, k), false, k);
    }
  }
  assert.equal(env.CLAUDE_CODE_SESSION_ID, 'S', 'o ambiente recebido nao muda');
  const sp2 = spawnCmdFalso();
  await real({ spawn: sp2, env: { ...env, SESSOES_WPP_CODE: 'D:\\VS Code\\bin\\code.cmd' }, esperar: async () => {} })('C:\\projetos\\x');
  assert.equal(sp2.chamadas[0].args[3], '""D:\\VS Code\\bin\\code.cmd" "C:\\projetos\\x""');
  // erro do spawn, saida != 0, pendurada alem do prazo (mata) -> rejeita
  for (const [modo, re] of [['erro', /ENOENT/], [1, /saiu com 1/], ['nada', /nao saiu em/]]) {
    const sp3 = spawnCmdFalso([modo]);
    await assert.rejects(real({ spawn: sp3, env, esperar: async () => {}, prazoMs: 30 })(pasta), re, String(modo));
    assert.equal(sp3.chamadas.length, 1, String(modo));
    if (modo === 'nada') assert.equal(sp3.chamadas[0].filho.morto, true, 'pendurado: o cmd e encerrado');
  }
  const sp4 = spawnCmdFalso(['ok', 2]);
  await real({ spawn: sp4, env, esperar: async () => {} })(pasta);
  assert.equal(sp4.chamadas.length, 1, 'F4c: nenhuma 2a chamada');
  await assert.rejects(real({ spawn: () => { throw new Error('spawn EINVAL'); }, env, esperar: async () => {} })(pasta), /EINVAL/);
  // pasta que o cmd nao passa inteira (%, aspas, quebra de linha) ou vazia: rejeita sem rodar nada
  for (const ruim of ['C:\\projetos\\50%off', 'C:\\projetos\\a"b', 'C:\\projetos\\a\nb', '']) {
    const sp5 = spawnCmdFalso();
    await assert.rejects(real({ spawn: sp5, env, esperar: async () => {} })(ruim), /pasta/, JSON.stringify(ruim));
    assert.equal(sp5.chamadas.length, 0, JSON.stringify(ruim));
  }
});

// Prova do aspas do cmd.exe DE VERDADE (so Windows), com um code.cmd FALSO numa pasta com espaco que so anota os
// argumentos: nunca abre o VS Code.
test('F4b 12b. abrirSessaoReal com cmd.exe de verdade e code.cmd falso: caminho do code e pasta com espaco chegam inteiros; 1 chamada so (F4c: sem --open-url)', { skip: process.platform !== 'win32' }, async () => {
  const raiz = pastaTemp('porteiro code ');
  const saida = path.join(raiz, 'args.txt');
  const falso = path.join(raiz, 'bin com espaco', 'code.cmd');
  fs.mkdirSync(path.dirname(falso), { recursive: true });
  fs.writeFileSync(falso, `@echo off\r\n>>"${saida}" echo [%1][%2][%3]\r\n`);
  const pasta = path.join(raiz, 'Meus Docs', 'Workspace (teste) & cia');
  fs.mkdirSync(pasta, { recursive: true });
  const env = { ...process.env, SESSOES_WPP_CODE: falso };
  await porteiroMod.abrirSessaoReal({ env, esperar: async () => {} })(pasta);
  const linhas = fs.readFileSync(saida, 'utf8').trim().split(/\r?\n/);
  assert.deepEqual(linhas, [`["${pasta}"][][]`]);
});

test('F4b 13. depois do nome gravado, o titulo da aba e o nome novo: a resposta da aba sai com ele no cabecalho e o "status" lista ele', async () => {
  const h = montarSessao();
  const { pedido } = await cenaSessao(h);
  const arq = transcript(h, 'N1', [peer(pedido, false, iso(h.t)), aiTitle('Revisar porteiro do WhatsApp')], 'c--projetos-sessoes-wpp');
  h.t += 15 * 1000;
  await h.p.passoSessoes();
  assert.ok(fs.readFileSync(arq, 'utf8').endsWith(linhaNome(NOME_SESSAO, 'N1')));
  assert.deepEqual(h.enviados.map((x) => x.texto), [SESSAO_ABERTA(NOME_SESSAO, 'repos\\sessoes-wpp')]);
  h.t += 20 * 1000;
  const fim = `${linha('16:00', FALA_SESSAO)}\nComecei a revisão.`;
  transcript(h, 'N1', [falaDaAba(fim, iso(h.t)), aiTitle('Outro titulo automatico')], 'c--projetos-sessoes-wpp');
  const ev = parou(h, 'N1', { final: fim, nome: 'aba-n1' });
  evento(h, ev);
  await h.p.passoEventos();
  assert.equal(h.enviados.at(-1).texto, montarResposta({ ...ev, titulo: NOME_SESSAO }));
  assert.match(h.enviados.at(-1).texto, /^ℹ️ \*Revisão Porteiro\*/);
  h.t += 61 * 1000;
  msg(h, { content: 'status' });
  await h.p.passoGrupo();
  assert.match(h.enviados.at(-1).texto, /\n- Revisão Porteiro \(/);
});

test('F4b 14. erro do mensageiro com o recado ja na aba nova: a nova tentativa registra sem reenviar e nomeia do mesmo jeito', async () => {
  const h = montarSessao({ respostasEntrega: [{ status: 'enviado', detalhe: '' }, { status: 'erro', detalhe: 'timeout 90 s' }] });
  const { pedido } = await cenaSessao(h);
  assert.deepEqual(h.enviados, []);
  assert.deepEqual(estado(h).nomesPendentes, [], 'erro: ainda nao nomeia');
  const arq = transcript(h, 'N1', [peer(pedido, false, iso(h.t))], 'c--projetos-sessoes-wpp');
  const antesTxt = fs.readFileSync(arq, 'utf8');
  h.t += 15 * 1000;
  await h.p.passoGrupo(); // a nova tentativa confere a aba antes de reenviar
  assert.equal(h.entregas.length, 2, 'nao reenviou');
  assert.equal(fs.readFileSync(arq, 'utf8'), `${antesTxt}${linhaNome(NOME_SESSAO, 'N1')}`);
  assert.deepEqual(h.enviados.map((x) => x.texto), [SESSAO_ABERTA(NOME_SESSAO, 'repos\\sessoes-wpp')]);
});

// Revisao do principal (30/09): a janela que abre pode religar uma conversa antiga da pasta; ela ja tem transcript e a
// aba nova de verdade nao (o transcript so nasce com a 1a mensagem). Com 2 candidatas vivas vale a de startedAt mais nova.
test('F4b 15. conversa antiga religada (transcript ja existe) nunca vira a nova, nem sendo a mais nova e ficando 20 s; entre 2 abas novas vale a mais nova', async () => {
  const h = montarSessao();
  centralCli(h);
  const m = msg(h, { content: FALA_SESSAO });
  abrirSessaoEv(h, { providerMsgId: m.provider_msg_id });
  await h.p.passoEventos();
  transcript(h, 'ANTIGA', [aiTitle('Conversa de ontem')], 'c--projetos-sessoes-wpp');
  abaNova(h, { sessionId: 'ANTIGA', startedAt: h.t + 60 * MIN });
  for (let i = 0; i < 2; i++) {
    h.t += 10 * 1000;
    await h.p.passoSessoes();
  }
  assert.equal(h.entregas.length, 0, 'a conversa antiga nao recebe a fala');
  assert.equal(estado(h).sessoesNovas[0].candidato, null);
  abaNova(h, { sessionId: 'N1', startedAt: h.t });
  abaNova(h, { sessionId: 'N2', startedAt: h.t + 1000 });
  h.t += 1000;
  await h.p.passoSessoes();
  h.t += 10 * 1000;
  await h.p.passoSessoes();
  assert.deepEqual(h.entregas.map((x) => x.sessionId), ['N2']);
});

test('F4b 16. 2 pedidos na mesma pasta: a aba que o 1o tomou nunca serve o 2o nas voltas seguintes; a proxima aba nova vai pro 2o', async () => {
  const h = montarSessao();
  centralCli(h);
  const a = msg(h, { content: FALA_SESSAO });
  const b = msg(h, { content: 'e outra sessao pro site' });
  abrirSessaoEv(h, { providerMsgId: a.provider_msg_id });
  abrirSessaoEv(h, { providerMsgId: b.provider_msg_id, nome: 'Revisão Site' });
  await h.p.passoEventos();
  assert.equal(estado(h).sessoesNovas.length, 2);
  abaNova(h, { sessionId: 'N1' });
  h.t += 1000;
  await h.p.passoSessoes();
  h.t += 10 * 1000;
  await h.p.passoSessoes();
  assert.deepEqual(h.entregas.map((x) => [x.sessionId, x.providerMsgId]), [['N1', `${a.provider_msg_id}-E1`]]);
  for (let i = 0; i < 3; i++) {
    h.t += 15 * 1000;
    await h.p.passoSessoes();
  }
  assert.equal(h.entregas.length, 1, 'N1 ja foi do 1o pedido');
  abaNova(h, { sessionId: 'N2' });
  h.t += 1000;
  await h.p.passoSessoes();
  h.t += 10 * 1000;
  await h.p.passoSessoes();
  assert.deepEqual(h.entregas.map((x) => [x.sessionId, x.providerMsgId]),
    [['N1', `${a.provider_msg_id}-E1`], ['N2', `${b.provider_msg_id}-E1`]]);
});

// ---------------------------------------------------------------------------------------------------------------
// F4c (30/09/2026, PLANO.md "Fase 4c"): conserto do 1o uso real da sessao nova (18:55). O link da aba nova so sai com o
// windowId da janela nova do VS Code (a window<n> que nasceu nos logs depois do `code <pasta>`) e so depois que o Claude
// subiu nela (sem a janela conectada o VS Code manda o link pra janela ATIVA); a sessao que o painel abre sozinho vale;
// nenhuma janela nova em 20 s = a pasta ja estava aberta (frase, sem link); prazo 180 s. Dubles em montarSessao.

// Fala do dono -> central viva -> abrir-sessao (foto das janelas, VS Code duble). Devolve a fala e a hora da abertura.
async function pedirSessao(h, { pasta = h.pasta } = {}) {
  centralCli(h);
  const m = msg(h, { content: FALA_SESSAO });
  abrirSessaoEv(h, { providerMsgId: m.provider_msg_id, pasta });
  await h.p.passoEventos();
  assert.deepEqual(h.aberturasSessao, [pasta], 'VS Code aberto 1x na pasta');
  return { m, A: m.provider_msg_id, t0: h.t };
}
// passoSessoes em cada segundo da lista, contado de t0
async function voltas(h, t0, segundos) {
  for (const s of segundos) {
    h.t = t0 + s * 1000;
    await h.p.passoSessoes();
  }
}
const itemSessao = (h) => estado(h).sessoesNovas[0];

test('F4c 1. janela nova (o 18:55): foto antes {S, [1,2]}; a window4 nasce sem o Claude = janela 4 e nenhum link; o Claude sobe nela = 1 link com windowId 4 (linkEm no disco antes); aba nova na pasta estavel = fala + nome', async () => {
  const h = montarSessao();
  h.janelas = { sessao: SESSAO_VSCODE, ids: [1, 2], comClaude: [1, 2] };
  h.janelaAoAbrir = 4;
  const { A, t0 } = await pedirSessao(h);
  let x = itemSessao(h);
  assert.deepEqual(x.janelasAntes, { sessao: SESSAO_VSCODE, ids: [1, 2] }, 'foto tirada antes de abrir');
  assert.equal(x.janela, null);
  assert.equal(x.linkEm, null);
  await voltas(h, t0, [1]);
  x = itemSessao(h);
  assert.equal(x.janela, 4);
  assert.equal(linhasDoLog(h, /abrir-sessao: janela 4 do VS Code na pasta /).length, 1);
  await voltas(h, t0, [15]);
  assert.deepEqual(h.links, [], 'sem o Claude na janela 4: nenhum link (cairia na janela ativa)');
  // o Claude subiu na janela 4 (medido 30/09: 25 s depois dela)
  h.janelas.comClaude.push(4);
  let noDisco = 'nao chamado';
  h.aoLink = () => { noDisco = itemSessao(h)?.linkEm ?? null; };
  await voltas(h, t0, [26]);
  assert.deepEqual(h.links, [4]);
  assert.equal(noDisco, iso(t0 + 26 * 1000), 'linkEm gravado no disco antes do link sair');
  assert.equal(itemSessao(h).linkEm, iso(t0 + 26 * 1000));
  await voltas(h, t0, [41, 56]);
  assert.deepEqual(h.links, [4], '1 link so');
  // a aba nova (a do link) na pasta: 2 checagens com 10 s
  abaNova(h, { sessionId: 'N1' });
  await voltas(h, t0, [60, 70]);
  assert.deepEqual(h.entregas.map((y) => [y.sessionId, y.providerMsgId, y.nomear]), [['N1', `${A}-E1`, NOME_SESSAO]]);
  assert.deepEqual(estado(h).sessoesNovas, []);
  transcript(h, 'N1', [peer(h.entregas[0], false, iso(h.t))], 'c--projetos-sessoes-wpp');
  await voltas(h, t0, [85]);
  assert.deepEqual(h.enviados.map((y) => y.texto), [SESSAO_ABERTA(NOME_SESSAO, 'repos\\sessoes-wpp')]);
  assert.deepEqual(h.links, [4]);
});

test('F4c 2. a aba que nasce em OUTRA pasta (a janela ativa, cwd da raiz Area) nunca recebe a fala; a de verdade na pasta pedida recebe', async () => {
  const h = montarSessao();
  const pasta = path.join(h.workspace, 'Comercial');
  h.janelaAoAbrir = 4;
  const { t0 } = await pedirSessao(h, { pasta });
  abaNova(h, { sessionId: 'ERRADA', cwd: h.workspace });
  h.janelas.comClaude.push(4);
  await voltas(h, t0, [1, 12, 24, 36]);
  assert.deepEqual(h.links, [4], 'o link mira a janela 4');
  assert.equal(h.entregas.length, 0, 'a aba da janela ativa nunca recebe');
  abaNova(h, { sessionId: 'N1', cwd: pasta });
  await voltas(h, t0, [40, 50]);
  assert.deepEqual(h.entregas.map((y) => y.sessionId), ['N1']);
  await voltas(h, t0, [65, 80]);
  assert.deepEqual(h.entregas.map((y) => y.sessionId), ['N1']);
});

test('F4c 3. painel sozinho: a sessao que a janela nova abre na pasta antes do Claude aparecer nos logs vale; depois nenhum link sai', async () => {
  const h = montarSessao();
  const { t0 } = await pedirSessao(h);
  await voltas(h, t0, [1, 15, 30, 45, 60, 75]);
  assert.equal(itemSessao(h).janela, 2);
  assert.deepEqual(h.links, []);
  abaNova(h, { sessionId: 'PAINEL' }); // o proprio painel da janela nova abriu sessao na pasta (medido: ~96 s)
  await voltas(h, t0, [96, 106]);
  assert.deepEqual(h.entregas.map((y) => y.sessionId), ['PAINEL']);
  assert.deepEqual(estado(h).sessoesNovas, []);
  h.janelas.comClaude.push(2);
  await voltas(h, t0, [120, 135]);
  assert.deepEqual(h.links, [], 'a aba ja foi achada: o link nao sai mais');
  assert.equal(h.entregas.length, 1);
});

test('F4c 4. pasta ja aberta: nenhuma janela nova em 20 s e nenhuma candidata = frase "já está aberta" com a pasta curta, o item sai, nenhum link; com candidata aos 20 s continua esperando', async () => {
  const h = montarSessao();
  h.janelaAoAbrir = null; // o VS Code so trouxe pra frente a janela que ja tinha a pasta
  const { t0 } = await pedirSessao(h);
  await voltas(h, t0, [1, 15, 19]);
  assert.deepEqual(h.enviados, [], '19 s: espera');
  assert.equal(itemSessao(h).janela, null);
  await voltas(h, t0, [20]);
  assert.deepEqual(h.enviados.map((y) => y.texto), [SESSAO_JA_ABERTA(NOME_SESSAO, 'repos\\sessoes-wpp')]);
  assert.deepEqual(estado(h).sessoesNovas, []);
  assert.deepEqual(h.links, []);
  abaNova(h, { sessionId: 'N1' });
  await voltas(h, t0, [30, 45]);
  assert.equal(h.entregas.length, 0, 'o item ja saiu: a aba que o dono abrir no PC nao recebe nada');
  assert.equal(h.enviados.length, 1);

  const h2 = montarSessao();
  h2.janelaAoAbrir = null;
  const t2 = (await pedirSessao(h2, { pasta: path.join(h2.workspace, 'Comercial') })).t0;
  await voltas(h2, t2, [20]);
  assert.deepEqual(h2.enviados.map((y) => y.texto), [SESSAO_JA_ABERTA(NOME_SESSAO, 'Area\\Comercial')]);

  // candidata viva aos 20 s: nao desiste; entrega quando firma
  const h3 = montarSessao();
  h3.janelaAoAbrir = null;
  const t3 = (await pedirSessao(h3)).t0;
  abaNova(h3, { sessionId: 'N1' });
  await voltas(h3, t3, [12, 20]);
  assert.deepEqual(h3.enviados, []);
  assert.equal(estado(h3).sessoesNovas.length, 1);
  await voltas(h3, t3, [22]);
  assert.deepEqual(h3.entregas.map((y) => y.sessionId), ['N1']);
  assert.deepEqual(h3.links, []);
});

test('F4c 5. sem janelas (logs null, logs que lancam, porteiro sem a opcao) = foto null e nenhum link; 20 s sem candidata = frase "já está aberta"', async () => {
  const casos = {
    'logs null': (h) => { h.janelas = null; },
    'logs lancam': (h) => { h.janelasFalha = true; },
    'sem a opcao': null,
  };
  for (const [nome, preparar] of Object.entries(casos)) {
    const h = preparar ? montarSessao() : montarSessao({ semJanelas: true });
    if (preparar) preparar(h);
    const { t0 } = await pedirSessao(h);
    assert.equal(itemSessao(h).janelasAntes, null, nome);
    await voltas(h, t0, [1, 10, 19]);
    assert.deepEqual(h.enviados, [], nome);
    await voltas(h, t0, [20]);
    assert.deepEqual(h.enviados.map((y) => y.texto), [SESSAO_JA_ABERTA(NOME_SESSAO, 'repos\\sessoes-wpp')], nome);
    assert.deepEqual(estado(h).sessoesNovas, [], nome);
    assert.deepEqual(h.links, [], nome);
  }
});

test('F4c 6. a sessao dos logs trocou (VS Code reiniciou): todos os ids da sessao nova contam como novos; vale o maior', async () => {
  const h = montarSessao();
  h.janelas = { sessao: SESSAO_VSCODE, ids: [1, 2, 3, 5], comClaude: [1] };
  h.janelaAoAbrir = null;
  const { t0 } = await pedirSessao(h);
  assert.deepEqual(itemSessao(h).janelasAntes, { sessao: SESSAO_VSCODE, ids: [1, 2, 3, 5] });
  h.janelas = { sessao: '20260930T190010', ids: [1, 2], comClaude: [] };
  await voltas(h, t0, [1]);
  assert.equal(itemSessao(h).janela, 2);
  assert.deepEqual(h.links, []);
  h.janelas.comClaude = [1, 2];
  await voltas(h, t0, [15]);
  assert.deepEqual(h.links, [2]);
});

test('F4c 7. link que falha: log, nao tenta de novo; o painel ainda entrega; sem nada ate 180 s = "não mostrou a aba nova em 3 min"', async () => {
  const h = montarSessao();
  h.linkFalha = 'code.cmd saiu com 1';
  const { t0 } = await pedirSessao(h);
  h.janelas.comClaude.push(2);
  await voltas(h, t0, [1]);
  assert.deepEqual(h.links, [2]);
  assert.equal(linhasDoLog(h, /abrir-sessao: link pra janela 2 falhou/).length, 1);
  await voltas(h, t0, [15, 30, 45]);
  assert.deepEqual(h.links, [2], 'nao tenta de novo');
  abaNova(h, { sessionId: 'PAINEL' });
  await voltas(h, t0, [50, 60]);
  assert.deepEqual(h.entregas.map((y) => y.sessionId), ['PAINEL']);

  const h2 = montarSessao();
  h2.linkFalha = 'code.cmd nao saiu em 20 s';
  const t2 = (await pedirSessao(h2)).t0;
  h2.janelas.comClaude.push(2);
  await voltas(h2, t2, [1, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 179]);
  assert.deepEqual(h2.enviados, []);
  await voltas(h2, t2, [180]);
  assert.deepEqual(h2.enviados.map((y) => y.texto), [SESSAO_NAO_ABRIU(NOME_SESSAO)]);
  assert.deepEqual(h2.links, [2]);
  assert.deepEqual(estado(h2).sessoesNovas, []);
});

test('F4c 8. travado: a janela e achada mas o link nao sai enquanto travado; destravou dentro do prazo = sai', async () => {
  const h = montarSessao();
  const { t0 } = await pedirSessao(h);
  h.janelas.comClaude.push(2);
  travar(h);
  await voltas(h, t0, [1, 15, 30]);
  assert.deepEqual(h.links, []);
  assert.equal(itemSessao(h).janela, 2);
  assert.equal(itemSessao(h).linkEm, null);
  assert.equal(destravar({ env: h.env }).ok, true);
  await voltas(h, t0, [45]);
  assert.deepEqual(h.links, [2]);
});

test('F4c 9. prazo: 179 s sem aba = ainda espera; 180 s = frase "em 3 min", o item sai', async () => {
  const h = montarSessao();
  const { t0 } = await pedirSessao(h);
  await voltas(h, t0, [1, 30, 60, 90, 120, 150, 179]);
  assert.deepEqual(h.enviados, []);
  assert.equal(estado(h).sessoesNovas.length, 1, '90 s ja nao e o prazo');
  await voltas(h, t0, [180]);
  assert.deepEqual(h.enviados.map((y) => y.texto), [SESSAO_NAO_ABRIU(NOME_SESSAO)]);
  assert.match(h.enviados[0].texto, /em 3 min\.$/);
  assert.deepEqual(estado(h).sessoesNovas, []);
  assert.equal(linhasDoLog(h, /nenhuma aba nova valida .* em 3 min/).length, 1);
});

test('F4c 10. item gravado pela versao anterior (sem janelasAntes/janela/linkEm) nao quebra e segue a espera: sem foto, todos os ids contam; sem janelas, 20 s = "já está aberta"', async () => {
  const velho = (h) => {
    const arq = path.join(h.env.SESSOES_WPP_DIR, 'estado.json');
    const e = JSON.parse(fs.readFileSync(arq, 'utf8'));
    for (const y of e.sessoesNovas) {
      delete y.janelasAntes;
      delete y.janela;
      delete y.linkEm;
    }
    fs.writeFileSync(arq, JSON.stringify(e));
  };
  const h = montarSessao();
  h.janelas = { sessao: SESSAO_VSCODE, ids: [1, 2], comClaude: [1, 2] };
  h.janelaAoAbrir = 4;
  const { A, t0 } = await pedirSessao(h);
  velho(h);
  await voltas(h, t0, [1]);
  const x = itemSessao(h);
  assert.equal(x.janelasAntes, null);
  assert.equal(x.janela, 4, 'sem foto: todos os ids contam, vale o maior');
  assert.deepEqual(h.links, []);
  h.janelas.comClaude.push(4);
  await voltas(h, t0, [15]);
  assert.deepEqual(h.links, [4]);
  abaNova(h, { sessionId: 'N1' });
  await voltas(h, t0, [20, 30]);
  assert.deepEqual(h.entregas.map((y) => [y.sessionId, y.providerMsgId]), [['N1', `${A}-E1`]]);

  const h2 = montarSessao({ semJanelas: true });
  const t2 = (await pedirSessao(h2)).t0;
  velho(h2);
  await voltas(h2, t2, [5, 19]);
  assert.deepEqual(h2.enviados, []);
  assert.equal(estado(h2).sessoesNovas.length, 1);
  await voltas(h2, t2, [20]);
  assert.deepEqual(h2.enviados.map((y) => y.texto), [SESSAO_JA_ABERTA(NOME_SESSAO, 'repos\\sessoes-wpp')]);
});

test('F4c 11. abrirSessaoReal (spawn falso) so abre a pasta: 1 chamada, sem --open-url, sem link, sem pausa', async () => {
  const sp = spawnCmdFalso();
  const esperas = [];
  await porteiroMod.abrirSessaoReal({ spawn: sp, env: { PATH: 'x' }, esperar: async (ms) => { esperas.push(ms); } })('C:\\projetos\\sessoes-wpp');
  assert.equal(sp.chamadas.length, 1);
  const linha = sp.chamadas[0].args.join(' ');
  assert.ok(linha.endsWith(' "C:\\projetos\\sessoes-wpp""'), linha);
  assert.ok(!linha.includes('--open-url') && !linha.includes('vscode://'), linha);
  assert.deepEqual(esperas, []);
});

test('F4c 12. abrirLinkReal (spawn falso): 1 cmd.exe com --open-url "vscode://anthropic.claude-code/open?windowId=7", sem janela, sem as herdadas; windowId invalido rejeita sem chamar; erro, saida != 0 e prazo rejeitam', async () => {
  assert.equal(typeof porteiroMod.abrirLinkReal, 'function', 'abrirLinkReal exportada');
  const real = porteiroMod.abrirLinkReal;
  const env = {
    LOCALAPPDATA: 'C:\\Users\\Ana Souza\\AppData\\Local', PATH: 'x', CLAUDE_CODE_SESSION_ID: 'S', CLAUDECODE: '1',
    CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', VSCODE_IPC_HOOK_CLI: 'pipe-velho',
    ELECTRON_RUN_AS_NODE: '1',
  };
  const code = 'C:\\Users\\Ana Souza\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd';
  const sp = spawnCmdFalso();
  await real({ spawn: sp, env })(7);
  assert.equal(sp.chamadas.length, 1);
  assert.equal(sp.chamadas[0].cmd, 'cmd.exe');
  assert.deepEqual(sp.chamadas[0].args, ['/d', '/s', '/c', `""${code}" --open-url "vscode://anthropic.claude-code/open?windowId=7""`]);
  const o = sp.chamadas[0].opts;
  assert.equal(o.windowsHide, true);
  assert.equal(o.windowsVerbatimArguments, true);
  assert.equal(o.env.PATH, 'x');
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'VSCODE_IPC_HOOK_CLI', 'ELECTRON_RUN_AS_NODE']) {
    assert.equal(Object.hasOwn(o.env, k), false, k);
  }
  for (const ruim of [0, -1, '7', NaN, 1.5, null, undefined, Infinity, 2 ** 53, [7]]) {
    const sp2 = spawnCmdFalso();
    await assert.rejects(real({ spawn: sp2, env })(ruim), /windowId/, String(ruim));
    assert.equal(sp2.chamadas.length, 0, String(ruim));
  }
  for (const [modo, re] of [['erro', /ENOENT/], [1, /saiu com 1/], ['nada', /nao saiu em/]]) {
    const sp3 = spawnCmdFalso([modo]);
    await assert.rejects(real({ spawn: sp3, env, prazoMs: 30 })(3), re, String(modo));
    assert.equal(sp3.chamadas.length, 1, String(modo));
    if (modo === 'nada') assert.equal(sp3.chamadas[0].filho.morto, true, 'pendurado: o cmd e encerrado');
  }
  await assert.rejects(real({ spawn: () => { throw new Error('spawn EINVAL'); }, env })(3), /EINVAL/);
  const sp4 = spawnCmdFalso();
  await real({ spawn: sp4, env: { ...env, SESSOES_WPP_CODE: 'D:\\VS Code\\bin\\code.cmd' } })(12);
  assert.equal(sp4.chamadas[0].args[3], '""D:\\VS Code\\bin\\code.cmd" --open-url "vscode://anthropic.claude-code/open?windowId=12""');
});

// Prova do cmd.exe DE VERDADE (so Windows) com code.cmd FALSO numa pasta com espaco que so anota os argumentos: o `?` e
// o `=` do link chegam inteiros, num argumento so. Nunca abre o VS Code.
test('F4c 12b. abrirLinkReal com cmd.exe de verdade e code.cmd falso: o link com windowId chega inteiro, 1 argumento so', { skip: process.platform !== 'win32' }, async () => {
  const raiz = pastaTemp('porteiro link ');
  const saida = path.join(raiz, 'args.txt');
  const falso = path.join(raiz, 'bin com espaco', 'code.cmd');
  fs.mkdirSync(path.dirname(falso), { recursive: true });
  fs.writeFileSync(falso, `@echo off\r\n>>"${saida}" echo [%1][%2][%3]\r\n`);
  await porteiroMod.abrirLinkReal({ env: { ...process.env, SESSOES_WPP_CODE: falso } })(7);
  const linhas = fs.readFileSync(saida, 'utf8').trim().split(/\r?\n/);
  assert.deepEqual(linhas, ['[--open-url]["vscode://anthropic.claude-code/open?windowId=7"][]']);
});

test('F4c 13. janelasVsCodeReal (pasta temporaria): sessao viva = a de nome mais novo COM main.log; ids = window<n> em ordem de numero; comClaude = as com a pasta exthost\\Anthropic.claude-code; sem raiz ou sem sessao viva = null; SESSOES_WPP_VSCODE_LOGS vence o APPDATA', () => {
  assert.equal(typeof porteiroMod.janelasVsCodeReal, 'function', 'janelasVsCodeReal exportada');
  const real = porteiroMod.janelasVsCodeReal;
  const raiz = pastaTemp('porteiro-vscode-logs-');
  const viva = path.join(raiz, SESSAO_VSCODE);
  // o `code <pasta>` cria uma sessao VAZIA, de nome mais novo (sem main.log): nao e a viva
  fs.mkdirSync(path.join(raiz, '20260930T185502', 'window9', 'exthost', 'Anthropic.claude-code'), { recursive: true });
  // sessao de ontem, com main.log: mais velha que a viva
  fs.mkdirSync(path.join(raiz, '20260929T080000', 'window20'), { recursive: true });
  fs.writeFileSync(path.join(raiz, '20260929T080000', 'main.log'), '');
  fs.mkdirSync(path.join(viva, 'window1', 'exthost', 'vscode.git'), { recursive: true });
  fs.mkdirSync(path.join(viva, 'window3', 'exthost', 'Anthropic.claude-code'), { recursive: true });
  fs.mkdirSync(path.join(viva, 'window12', 'exthost'), { recursive: true });
  fs.writeFileSync(path.join(viva, 'window12', 'exthost', 'Anthropic.claude-code'), 'arquivo, nao pasta');
  fs.writeFileSync(path.join(viva, 'window7'), 'arquivo, nao pasta');
  fs.mkdirSync(path.join(viva, 'windowX'));
  fs.mkdirSync(path.join(viva, 'window0'));
  fs.writeFileSync(path.join(viva, 'main.log'), 'o porteiro nunca le o conteudo');
  assert.deepEqual(real({ env: { SESSOES_WPP_VSCODE_LOGS: raiz } }), { sessao: SESSAO_VSCODE, ids: [1, 3, 12], comClaude: [3] });
  assert.equal(real({ env: { SESSOES_WPP_VSCODE_LOGS: path.join(raiz, 'nao-existe') } }), null, 'raiz inexistente');
  assert.equal(real({ env: {} }), null, 'sem APPDATA e sem a variavel');
  const semViva = pastaTemp('porteiro-vscode-logs-');
  fs.mkdirSync(path.join(semViva, '20260930T000000', 'window1'), { recursive: true });
  assert.equal(real({ env: { SESSOES_WPP_VSCODE_LOGS: semViva } }), null, 'nenhuma sessao com main.log');
  // sem a variavel: <APPDATA>\Code\logs
  const appdata = pastaTemp('porteiro-appdata-');
  const s2 = path.join(appdata, 'Code', 'logs', '20260930T100000');
  fs.mkdirSync(path.join(s2, 'window2'), { recursive: true });
  fs.writeFileSync(path.join(s2, 'main.log'), '');
  assert.deepEqual(real({ env: { APPDATA: appdata } }), { sessao: '20260930T100000', ids: [2], comClaude: [] });
  assert.equal(real({ env: { APPDATA: appdata, SESSOES_WPP_VSCODE_LOGS: raiz } }).sessao, SESSAO_VSCODE, 'a variavel vence');
});

test('F4c 14. nenhum caminho manda o link puro: todo windowId que os dubles receberam nos testes acima e inteiro > 0; no codigo o link so sai com ?windowId= e o rodar liga as 2 opcoes reais', () => {
  assert.ok(LINKS_VISTOS.length >= 5, `links vistos: ${LINKS_VISTOS.length}`);
  for (const n of LINKS_VISTOS) assert.ok(Number.isSafeInteger(n) && n > 0, `windowId ${String(n)}`);
  const codigo = fs.readFileSync(PORTEIRO, 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l));
  const literais = codigo.filter((l) => l.includes('vscode://anthropic.claude-code/open'));
  assert.equal(literais.length, 1, literais.join('\n'));
  assert.match(literais[0], /^export const LINK_ABA_NOVA = 'vscode:\/\/anthropic\.claude-code\/open';/);
  const usos = codigo.filter((l) => l.includes('LINK_ABA_NOVA') && !l.startsWith('export const LINK_ABA_NOVA'));
  assert.ok(usos.length >= 1, 'o link e montado em algum lugar');
  for (const l of usos) assert.match(l, /\$\{LINK_ABA_NOVA\}\?windowId=\$\{/, l);
  const src = codigo.join('\n');
  assert.match(src, /janelasVsCode: \(\) => janelasVsCodeReal\(\{ env \}\)/);
  assert.match(src, /abrirLinkVsCode: abrirLinkReal\(\{\}\)/);
});

test('F4c 15. o Claude sobe na janela na mesma volta em que o prazo vence (180 s): frase "não mostrou" e nenhum link (nunca deixa aba solta depois de desistir)', async () => {
  const h = montarSessao();
  const { t0 } = await pedirSessao(h);
  await voltas(h, t0, [1, 60, 120, 179]);
  assert.equal(itemSessao(h).janela, 2);
  h.janelas.comClaude.push(2);
  await voltas(h, t0, [180]);
  assert.deepEqual(h.enviados.map((y) => y.texto), [SESSAO_NAO_ABRIU(NOME_SESSAO)]);
  assert.deepEqual(h.links, []);
  assert.deepEqual(estado(h).sessoesNovas, []);
});

// ---------------------------------------------------------------------------------------------------------------
// F4c complemento (revisao do principal 30/09/2026 19:5x, PLANO.md "Fase 4c" item 1 COMPLEMENTO): a janela que JA tem a
// pasta tambem e mirada (o pedido real "na pasta Area" = a raiz, que o dono deixa sempre aberta). Medido no VS
// Code 1.139.1: o claude.exe de uma aba e filho DIRETO do extension host da janela, e window<n>\exthost\exthost.log grava
// "Extension host with pid <pid> started" (de novo a cada reinicio; so a ultima vale). Aba viva na pasta antes de abrir
// -> pai do processo dela (`processos.info`) -> a janela desse extension host (`janelaDoExthost`) -> link com esse
// windowId. 1 tentativa por item (a consulta do processo leva 1-2 s). Nada real: processo e logs sao dubles ou pasta
// temporaria; o powershell nunca roda.

// montarSessao + dubles de `processos.info` (`h.paiDe` = pid -> paiPid; `h.infoFalha` = lanca; `h.infos` = chamadas) e
// de `janelaDoExthost` (`h.janelaDe` = paiPid -> o que devolve; `h.exthostFalha` = lanca; `h.exthosts` = chamadas).
// `semProcessos`/`semExthost` = porteiro sem a opcao; `processos` = outro objeto no lugar do duble. Os dubles de abrir,
// janelas e link sao os do montarSessao, refeitos aqui (o helper antigo fica intacto). Padrao daqui: a pasta ja tem
// janela (`janelaAoAbrir` null: o VS Code so traz ela pra frente).
function montarJaAberta({ semProcessos = false, semExthost = false, processos, ...o } = {}) {
  const h = montarSessao(o);
  Object.assign(h, {
    janelaAoAbrir: null, paiDe: new Map(), infoFalha: null, infos: [], janelaDe: new Map(), exthostFalha: null, exthosts: [],
  });
  const extra = {
    raizesSessao: h.raizes,
    ensaio: o.ensaio ?? false,
    abrirSessaoVsCode: async (pasta) => {
      h.aberturasSessao.push(pasta);
      if (h.abrirSessaoFalha) throw new Error(h.abrirSessaoFalha);
      if (h.janelas && h.janelaAoAbrir !== null) {
        h.janelas.ids.push(h.janelaAoAbrir === 'nova' ? Math.max(0, ...h.janelas.ids) + 1 : h.janelaAoAbrir);
      }
    },
    janelasVsCode: () => {
      if (h.janelasFalha) throw new Error('logs ilegiveis');
      return h.janelas ? structuredClone(h.janelas) : null;
    },
    abrirLinkVsCode: async (n) => {
      LINKS_VISTOS.push(n);
      h.links.push(n);
      if (h.aoLink) h.aoLink(n);
      if (h.linkFalha) throw new Error(h.linkFalha);
    },
  };
  if (processos !== undefined) {
    extra.processos = processos;
  } else if (!semProcessos) {
    extra.processos = {
      info(pid) {
        h.infos.push(pid);
        if (h.infoFalha) throw new Error(h.infoFalha);
        return h.paiDe.has(pid) ? { nome: 'claude.exe', paiPid: h.paiDe.get(pid), criadoEm: T0 } : null;
      },
    };
  }
  if (!semExthost) {
    extra.janelaDoExthost = (paiPid) => {
      h.exthosts.push(paiPid);
      if (h.exthostFalha) throw new Error(h.exthostFalha);
      return h.janelaDe.has(paiPid) ? h.janelaDe.get(paiPid) : null;
    };
  }
  const cru = porteiroCom(h, extra);
  h.cru = cru;
  h.p = { ...comBomba(cru), passoSessoes: async () => { await cru.passoSessoes(); await bombear(cru); } };
  return h;
}

// Aba que ja estava viva na pasta antes do pedido (entra nas `antes`), com o pid do registro escolhido (tem que estar
// vivo: process.pid ou process.ppid; o abaNova grava sempre o process.pid). startedAt padrao: 30 min antes.
function abaVelha(h, { pid = process.pid, ...o }) {
  const arq = abaNova(h, { startedAt: h.t - 30 * MIN, ...o });
  fs.writeFileSync(arq, JSON.stringify({ ...JSON.parse(fs.readFileSync(arq, 'utf8')), pid }));
  return arq;
}

// o item do estado com `mudar(item)` aplicado (estado gravado por outra versao do porteiro)
function mexerNoItem(h, mudar) {
  const arq = path.join(h.env.SESSOES_WPP_DIR, 'estado.json');
  const e = JSON.parse(fs.readFileSync(arq, 'utf8'));
  for (const y of e.sessoesNovas) mudar(y);
  fs.writeFileSync(arq, JSON.stringify(e));
}

test('F4c 16. janela ja aberta (o pedido "na pasta Area" = a raiz): aba viva na pasta antes (pid P) -> pai 222 -> janela 2 do exthost.log; o Claude ja esta nela = 1 link com windowId 2 na 1a volta e nenhuma frase aos 20 s; a aba nova na pasta recebe a fala e o nome', async () => {
  const h = montarJaAberta();
  const pasta = h.workspace;
  h.janelas = { sessao: SESSAO_VSCODE, ids: [1, 2, 3], comClaude: [1, 2, 3] };
  abaVelha(h, { sessionId: 'VELHA', cwd: pasta });
  h.paiDe.set(process.pid, 222);
  h.janelaDe.set(222, 2);
  const { A, t0 } = await pedirSessao(h, { pasta });
  assert.deepEqual(itemSessao(h).antes, ['VELHA']);
  assert.deepEqual(h.infos, [], 'nada consultado ao abrir');
  let noDisco = 'nao chamado';
  h.aoLink = () => { noDisco = itemSessao(h)?.linkEm ?? null; };
  await voltas(h, t0, [1]);
  assert.deepEqual(h.infos, [process.pid], 'o processo da aba que ja estava na pasta');
  assert.deepEqual(h.exthosts, [222], 'o pai dela = o extension host da janela');
  const x = itemSessao(h);
  assert.equal(x.janela, 2);
  assert.equal(x.janelaVelha, true);
  assert.equal(linhasDoLog(h, /abrir-sessao: janela 2 ja aberta com a pasta /).length, 1);
  assert.deepEqual(h.links, [2]);
  assert.equal(noDisco, iso(t0 + 1000), 'linkEm gravado no disco antes do link sair');
  await voltas(h, t0, [10, 19, 20, 25]);
  assert.deepEqual(h.enviados, [], 'a janela ja aberta foi achada: nenhuma frase aos 20 s');
  assert.deepEqual(h.links, [2], '1 link so');
  assert.deepEqual(h.infos, [process.pid], '1 tentativa so');
  assert.equal(estado(h).sessoesNovas.length, 1, 'segue esperando a aba nova');
  // a aba nova (a do link) na pasta: 2 checagens com 10 s
  abaNova(h, { sessionId: 'N1', cwd: pasta });
  await voltas(h, t0, [30, 40]);
  assert.deepEqual(h.entregas.map((y) => [y.sessionId, y.providerMsgId, y.nomear]), [['N1', `${A}-E1`, NOME_SESSAO]]);
  assert.deepEqual(estado(h).sessoesNovas, []);
  transcript(h, 'N1', [peer(h.entregas[0], false, iso(h.t))], 'c--Meus-Docs-trabalho-Area');
  await voltas(h, t0, [55]);
  assert.deepEqual(h.enviados.map((y) => y.texto), [SESSAO_ABERTA(NOME_SESSAO, 'Area')]);
  assert.deepEqual(h.links, [2]);
});

test('F4c 17. a janela da aba que ja estava na pasta nao e achada (janelaDoExthost null ou torto) = frase "já está aberta" aos 20 s, sem link; 1 tentativa so', async () => {
  for (const devolve of [null, undefined, 0, -1, '2', 2.5, NaN, 2 ** 53, [2]]) {
    const nome = `devolve ${String(devolve)}`;
    const h = montarJaAberta();
    abaVelha(h, { sessionId: 'VELHA' });
    h.paiDe.set(process.pid, 222);
    if (devolve !== null) h.janelaDe.set(222, devolve);
    const { t0 } = await pedirSessao(h);
    await voltas(h, t0, [1, 10, 19]);
    assert.deepEqual(h.infos, [process.pid], nome);
    assert.deepEqual(h.exthosts, [222], nome);
    assert.equal(itemSessao(h).janela, null, nome);
    assert.equal(itemSessao(h).janelaVelha, true, nome);
    assert.deepEqual(h.enviados, [], nome);
    await voltas(h, t0, [20]);
    assert.deepEqual(h.enviados.map((y) => y.texto), [SESSAO_JA_ABERTA(NOME_SESSAO, 'repos\\sessoes-wpp')], nome);
    assert.deepEqual(estado(h).sessoesNovas, [], nome);
    assert.deepEqual(h.links, [], nome);
    assert.deepEqual(h.infos, [process.pid], nome);
  }
});

test('F4c 18. consulta do processo que lanca (ou sem dados) e janelaDoExthost que lanca = pula a aba; 1 tentativa so em 3 voltas; 20 s = frase "já está aberta", sem link', async () => {
  const casos = {
    'info lanca': (h) => { h.infoFalha = 'powershell caiu'; },
    'info sem dados': () => {},
    'exthost lanca': (h) => {
      h.paiDe.set(process.pid, 222);
      h.exthostFalha = 'log ilegivel';
    },
  };
  for (const [nome, preparar] of Object.entries(casos)) {
    const h = montarJaAberta();
    abaVelha(h, { sessionId: 'VELHA' });
    preparar(h);
    const { t0 } = await pedirSessao(h);
    await voltas(h, t0, [1, 10, 19]);
    assert.deepEqual(h.infos, [process.pid], `${nome}: 1 consulta em 3 voltas`);
    assert.deepEqual(h.exthosts, nome === 'exthost lanca' ? [222] : [], nome);
    assert.equal(itemSessao(h).janela, null, nome);
    assert.deepEqual(h.enviados, [], nome);
    await voltas(h, t0, [20]);
    assert.deepEqual(h.enviados.map((y) => y.texto), [SESSAO_JA_ABERTA(NOME_SESSAO, 'repos\\sessoes-wpp')], nome);
    assert.deepEqual(h.links, [], nome);
    assert.equal(h.infos.length, 1, nome);
  }
});

test('F4c 19. janela nova com aba viva na pasta antes: vale a janela nova (o maior id novo); o processo nunca e consultado', async () => {
  const h = montarJaAberta();
  h.janelaAoAbrir = 'nova';
  abaVelha(h, { sessionId: 'VELHA' });
  h.paiDe.set(process.pid, 222);
  h.janelaDe.set(222, 1);
  const { t0 } = await pedirSessao(h);
  assert.deepEqual(itemSessao(h).antes, ['VELHA']);
  await voltas(h, t0, [1]);
  assert.equal(itemSessao(h).janela, 2);
  assert.deepEqual(h.links, [], 'sem o Claude na janela 2 ainda');
  h.janelas.comClaude.push(2);
  await voltas(h, t0, [15, 30]);
  assert.deepEqual(h.links, [2]);
  assert.deepEqual(h.infos, []);
  assert.deepEqual(h.exthosts, []);
  assert.equal(linhasDoLog(h, /ja aberta com a pasta/).length, 0);
});

test('F4c 20. candidata viva (ainda nao firme) quando a janela ganha o Claude: nenhum link naquela volta; a candidata firma e recebe, e o link nunca sai (janela nova e janela ja aberta)', async () => {
  // janela nova: o painel abre sessao sozinho na pasta antes do Claude aparecer nos logs da janela
  const h = montarSessao();
  const { t0 } = await pedirSessao(h);
  await voltas(h, t0, [1]);
  assert.equal(itemSessao(h).janela, 2);
  abaNova(h, { sessionId: 'PAINEL' });
  await voltas(h, t0, [20]);
  h.janelas.comClaude.push(2);
  await voltas(h, t0, [25]);
  assert.deepEqual(h.links, [], 'candidata viva: o link abriria uma 2a aba');
  await voltas(h, t0, [30]);
  assert.deepEqual(h.entregas.map((y) => y.sessionId), ['PAINEL']);
  await voltas(h, t0, [45]);
  assert.deepEqual(h.links, []);

  // janela ja aberta: a aba nova ja apareceu antes da 1a volta (o dono abriu no PC)
  const h2 = montarJaAberta();
  h2.janelas = { sessao: SESSAO_VSCODE, ids: [1, 2], comClaude: [1, 2] };
  abaVelha(h2, { sessionId: 'VELHA' });
  h2.paiDe.set(process.pid, 222);
  h2.janelaDe.set(222, 2);
  const t2 = (await pedirSessao(h2)).t0;
  abaNova(h2, { sessionId: 'N1' });
  await voltas(h2, t2, [1]);
  assert.equal(itemSessao(h2).janela, 2, 'a janela ja aberta foi achada');
  assert.deepEqual(h2.links, [], 'candidata viva: nenhum link');
  await voltas(h2, t2, [11]);
  assert.deepEqual(h2.entregas.map((y) => y.sessionId), ['N1']);
  await voltas(h2, t2, [25]);
  assert.deepEqual(h2.links, []);
  assert.deepEqual(h2.enviados, [], 'nenhuma frase de pasta ja aberta');
});

test('F4c 21. janelaDoExthostReal (pasta temporaria): a janela cuja ULTIMA linha "Extension host with pid <n> started" do exthost.log tem o pid; mais de uma = a de id mais alto; sessao sem main.log, window torta, sem log, raiz inexistente e paiPid invalido = null; o rodar liga a real', () => {
  assert.equal(typeof porteiroMod.janelaDoExthostReal, 'function', 'janelaDoExthostReal exportada');
  const real = porteiroMod.janelaDoExthostReal;
  const raiz = pastaTemp('porteiro-exthost-');
  const started = (pid) => `2026-09-30 08:52:15.123 [info] Extension host with pid ${pid} started`;
  const gravar = (sessao, janela, linhas) => {
    const d = path.join(raiz, sessao, janela, 'exthost');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'exthost.log'), `${linhas.join('\r\n')}\r\n`);
  };
  const viva = SESSAO_VSCODE;
  fs.mkdirSync(path.join(raiz, viva), { recursive: true });
  fs.writeFileSync(path.join(raiz, viva, 'main.log'), 'o porteiro nunca le o conteudo');
  // window2: o extension host reiniciou (47456 e depois 46064, medido 30/09): so o ultimo vale
  gravar(viva, 'window2', [
    started(47456), '2026-09-30 08:52:16.000 [info] Eager extensions activated',
    '2026-09-30 12:00:00.000 [info] Extension host terminating: renderer closed the MessagePort', started(46064),
    '2026-09-30 12:00:05.000 [info] Eager extensions activated',
  ]);
  gravar(viva, 'window5', [started(46064), 'outra linha', started(50000)]);
  gravar(viva, 'window3', [started(60000)]);
  gravar(viva, 'window11', [started(60000)]); // pid reaproveitado de janela ja fechada: vale o id mais alto
  gravar(viva, 'window0', [started(70000)]);
  gravar(viva, 'windowX', [started(70001)]);
  fs.mkdirSync(path.join(raiz, viva, 'window8', 'exthost'), { recursive: true }); // sem exthost.log
  fs.writeFileSync(path.join(raiz, viva, 'window7'), 'arquivo, nao pasta');
  // o `code <pasta>` cria uma sessao VAZIA, de nome mais novo (sem main.log): ignorada, como no janelasVsCodeReal
  gravar('20260930T185502', 'window9', [started(46064), started(80000)]);
  const f = real({ env: { SESSOES_WPP_VSCODE_LOGS: raiz } });
  assert.equal(typeof f, 'function');
  assert.equal(f(46064), 2);
  assert.equal(f(50000), 5);
  assert.equal(f(47456), null, 'so a ultima linha "started" de cada janela vale');
  assert.equal(f(60000), 11, 'mais de uma janela: a de id mais alto');
  assert.equal(f(80000), null, 'sessao sem main.log fica fora');
  assert.equal(f(70000), null, 'window0 fica fora');
  assert.equal(f(70001), null, 'windowX fica fora');
  assert.equal(f(12345), null, 'nenhuma janela');
  for (const ruim of [0, -1, '46064', NaN, 1.5, null, undefined, Infinity, [46064]]) assert.equal(f(ruim), null, String(ruim));
  // le o disco a cada chamada: o extension host da window5 reiniciou depois
  gravar(viva, 'window5', [started(50000), started(90000)]);
  assert.equal(f(90000), 5);
  assert.equal(f(50000), null);
  assert.equal(real({ env: { SESSOES_WPP_VSCODE_LOGS: path.join(raiz, 'nao-existe') } })(46064), null, 'raiz inexistente');
  assert.equal(real({ env: {} })(46064), null, 'sem APPDATA e sem a variavel');
  const semViva = pastaTemp('porteiro-exthost-');
  fs.mkdirSync(path.join(semViva, '20260930T000000', 'window1', 'exthost'), { recursive: true });
  fs.writeFileSync(path.join(semViva, '20260930T000000', 'window1', 'exthost', 'exthost.log'), `${started(46064)}\r\n`);
  assert.equal(real({ env: { SESSOES_WPP_VSCODE_LOGS: semViva } })(46064), null, 'nenhuma sessao com main.log');
  // sem a variavel: <APPDATA>\Code\logs; a variavel vence
  const appdata = pastaTemp('porteiro-appdata-');
  const s2 = path.join(appdata, 'Code', 'logs', '20260930T100000');
  fs.mkdirSync(path.join(s2, 'window4', 'exthost'), { recursive: true });
  fs.writeFileSync(path.join(s2, 'main.log'), '');
  fs.writeFileSync(path.join(s2, 'window4', 'exthost', 'exthost.log'), `${started(1234)}\r\n`);
  assert.equal(real({ env: { APPDATA: appdata } })(1234), 4);
  assert.equal(real({ env: { APPDATA: appdata, SESSOES_WPP_VSCODE_LOGS: raiz } })(1234), null, 'a variavel vence');
  // o rodar liga a real (linha de codigo, fora de comentario)
  const codigo = fs.readFileSync(PORTEIRO, 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n');
  assert.match(codigo, /janelaDoExthost: janelaDoExthostReal\(\{ env \}\)/);
});

test('F4c 22. sem como achar a janela ja aberta (porteiro sem processos, processos sem info, sem janelaDoExthost) ou sem aba viva na pasta antes = o de antes: 20 s = frase "já está aberta", sem link, nada lanca', async () => {
  const casos = {
    'sem processos': () => montarJaAberta({ semProcessos: true }),
    'processos sem info': () => montarJaAberta({ processos: {} }),
    'sem janelaDoExthost': () => montarJaAberta({ semExthost: true }),
    'sem aba viva antes': () => montarJaAberta(),
  };
  for (const [nome, criar] of Object.entries(casos)) {
    const h = criar();
    if (nome !== 'sem aba viva antes') abaVelha(h, { sessionId: 'VELHA' });
    h.paiDe.set(process.pid, 222);
    h.janelaDe.set(222, 1);
    const { t0 } = await pedirSessao(h);
    await voltas(h, t0, [1, 10, 19]);
    assert.deepEqual(h.enviados, [], nome);
    assert.equal(itemSessao(h).janela, null, nome);
    await voltas(h, t0, [20]);
    assert.deepEqual(h.enviados.map((y) => y.texto), [SESSAO_JA_ABERTA(NOME_SESSAO, 'repos\\sessoes-wpp')], nome);
    assert.deepEqual(estado(h).sessoesNovas, [], nome);
    assert.deepEqual(h.links, [], nome);
    assert.deepEqual(h.infos, [], nome);
    assert.deepEqual(h.exthosts, [], nome);
  }
});

test('F4c 23. item gravado antes do campo janelaVelha (ausente ou torto) segue e tenta 1 vez: achou = link; ja tentado (true) = nao consulta de novo e 20 s = frase', async () => {
  for (const campo of ['ausente', 'true', 1, null]) {
    const nome = `janelaVelha ${String(campo)}`;
    const h = montarJaAberta();
    h.janelas = { sessao: SESSAO_VSCODE, ids: [1, 2], comClaude: [1, 2] };
    abaVelha(h, { sessionId: 'VELHA' });
    h.paiDe.set(process.pid, 222);
    h.janelaDe.set(222, 2);
    const { t0 } = await pedirSessao(h);
    mexerNoItem(h, (y) => {
      if (campo === 'ausente') delete y.janelaVelha;
      else y.janelaVelha = campo;
    });
    await voltas(h, t0, [1, 10]);
    assert.deepEqual(h.infos, [process.pid], nome);
    assert.equal(itemSessao(h).janelaVelha, true, nome);
    assert.deepEqual(h.links, [2], nome);
  }
  // o porteiro anterior ja tentou (e caiu antes de achar): nao consulta de novo
  const h = montarJaAberta();
  abaVelha(h, { sessionId: 'VELHA' });
  h.paiDe.set(process.pid, 222);
  h.janelaDe.set(222, 1);
  const { t0 } = await pedirSessao(h);
  mexerNoItem(h, (y) => { y.janelaVelha = true; });
  await voltas(h, t0, [1, 10, 20]);
  assert.deepEqual(h.infos, []);
  assert.deepEqual(h.enviados.map((y) => y.texto), [SESSAO_JA_ABERTA(NOME_SESSAO, 'repos\\sessoes-wpp')]);
  assert.deepEqual(h.links, []);
});

test('F4c 24. ate 3 abas de antes, da mais nova pra mais velha, so as vivas do VS Code (terminal e aba fechada ficam fora); a 1a janela valida vale e para de consultar', async () => {
  assert.ok(process.ppid !== process.pid && pidVivo(process.ppid), 'o pai do processo do teste esta vivo');
  const h = montarJaAberta();
  h.janelas = { sessao: SESSAO_VSCODE, ids: [1, 2, 3], comClaude: [1, 2, 3] };
  // gravadas da mais velha pra mais nova: a ordem dos arquivos nao e a ordem que vale
  abaVelha(h, { sessionId: 'VELHA', pid: process.ppid, startedAt: h.t - 5 * MIN });
  abaVelha(h, { sessionId: 'MEIO', pid: process.ppid, startedAt: h.t - 4 * MIN });
  abaVelha(h, { sessionId: 'NOVA', startedAt: h.t - 3 * MIN });
  abaVelha(h, { sessionId: 'FECHADA', startedAt: h.t - 2 * MIN });
  abaVelha(h, { sessionId: 'TERM', entrypoint: 'cli', startedAt: h.t - 1 * MIN });
  h.paiDe.set(process.pid, 111); // NOVA: janela nao achada
  h.paiDe.set(process.ppid, 333); // MEIO (e VELHA): janela 3
  h.janelaDe.set(333, 3);
  const { t0 } = await pedirSessao(h);
  assert.deepEqual([...itemSessao(h).antes].sort(), ['FECHADA', 'MEIO', 'NOVA', 'TERM', 'VELHA']);
  fecharSessao(h, 'FECHADA');
  await voltas(h, t0, [1]);
  assert.deepEqual(h.infos, [process.pid, process.ppid], 'NOVA e depois MEIO; a VELHA nem e consultada');
  assert.deepEqual(h.exthosts, [111, 333]);
  assert.equal(itemSessao(h).janela, 3);
  assert.deepEqual(h.links, [3]);
  assert.equal(linhasDoLog(h, /abrir-sessao: janela 3 ja aberta com a pasta /).length, 1);

  // ate 3: 4 abas do VS Code sem janela achada = 3 consultas, e 20 s = frase
  const h2 = montarJaAberta();
  for (let i = 1; i <= 4; i++) abaVelha(h2, { sessionId: `V${i}`, startedAt: h2.t - i * MIN });
  h2.paiDe.set(process.pid, 111);
  const t2 = (await pedirSessao(h2)).t0;
  await voltas(h2, t2, [1, 10]);
  assert.equal(h2.infos.length, 3);
  assert.deepEqual(h2.exthosts, [111, 111, 111]);
  await voltas(h2, t2, [20]);
  assert.deepEqual(h2.enviados.map((y) => y.texto), [SESSAO_JA_ABERTA(NOME_SESSAO, 'repos\\sessoes-wpp')]);
  assert.equal(h2.infos.length, 3);
  assert.deepEqual(h2.links, []);
});

// Revisao do principal (30/09): sabotagem `if (n) return n;` passava verde (janela torta da 1a aba parava a busca).
test('F4c 25. janela torta ("2") da aba mais nova nao para a busca: a proxima aba com janela valida (3) vale e o link sai com 3', async () => {
  assert.ok(process.ppid !== process.pid && pidVivo(process.ppid), 'o pai do processo do teste esta vivo');
  const h = montarJaAberta();
  h.janelas = { sessao: SESSAO_VSCODE, ids: [1, 2, 3], comClaude: [1, 2, 3] };
  abaVelha(h, { sessionId: 'MEIO', pid: process.ppid, startedAt: h.t - 4 * MIN });
  abaVelha(h, { sessionId: 'NOVA', startedAt: h.t - 3 * MIN });
  h.paiDe.set(process.pid, 111); // NOVA: a janela vem torta
  h.janelaDe.set(111, '2');
  h.paiDe.set(process.ppid, 333); // MEIO: janela 3
  h.janelaDe.set(333, 3);
  const { t0 } = await pedirSessao(h);
  await voltas(h, t0, [1]);
  assert.deepEqual(h.exthosts, [111, 333], 'a torta nao para a busca');
  assert.equal(itemSessao(h).janela, 3);
  assert.deepEqual(h.links, [3]);
});

// Pedido do dono: "eu sempre uso ou a Area ou a pasta de projetos ... são as únicas duas abas que ficam no VS Code
// para não abrir uma janela nova à parte". Com `sessaoSoNaRaiz` (o `rodar` liga), a sessao nova nasce SEMPRE numa das 2
// raizes: subpasta pedida vira a raiz dela (a fala do dono, literal, leva a pasta que ele citou pra aba).
test('F4d 1. so na raiz: subpasta da Area e do repos vira a raiz (VS Code aberto na raiz, item e frase com a raiz); raiz fica igual; pasta recusada continua recusada; sem a opcao, a subpasta vale como antes', async () => {
  const casos = [
    [(h) => path.join(h.workspace, 'Comercial'), (h) => h.workspace, 'Area'],
    [(h) => path.join(h.repos, 'sessoes-wpp'), (h) => h.repos, 'repos'],
    [(h) => h.workspace, (h) => h.workspace, 'Area'],
  ];
  for (const [pedida, raiz, curta] of casos) {
    const h = montarSessao({ soRaiz: true });
    centralCli(h);
    const m = msg(h, { content: FALA_SESSAO });
    abrirSessaoEv(h, { providerMsgId: m.provider_msg_id, pasta: pedida(h) });
    await h.p.passoEventos();
    assert.deepEqual(h.aberturasSessao, [raiz(h)], curta);
    assert.equal(itemSessao(h).pasta, raiz(h), curta);
    if (pedida(h) !== raiz(h)) assert.equal(linhasDoLog(h, /abrir-sessao: pasta pedida .* -> raiz /).length, 1, curta);
    const t0 = h.t;
    await voltas(h, t0, [1]);
    abaNova(h, { sessionId: 'N1', cwd: raiz(h) });
    await voltas(h, t0, [30, 41]);
    assert.deepEqual(h.entregas.map((y) => y.sessionId), ['N1'], curta);
    transcript(h, 'N1', [peer(h.entregas[0], false, iso(h.t))], 'c--x');
    await voltas(h, t0, [55]);
    assert.deepEqual(h.enviados.map((y) => y.texto), [SESSAO_ABERTA(NOME_SESSAO, curta)], curta);
  }
  const r = montarSessao({ soRaiz: true });
  centralCli(r);
  const mr = msg(r, { content: FALA_SESSAO });
  abrirSessaoEv(r, { providerMsgId: mr.provider_msg_id, pasta: path.join(r.repos, 'site', 'node_modules', 'pacote') });
  await r.p.passoEventos();
  assert.deepEqual(r.aberturasSessao, []);
  assert.deepEqual(r.enviados.map((y) => y.texto), [SESSAO_PASTA_RECUSADA(NOME_SESSAO)]);
  const s = montarSessao();
  centralCli(s);
  const ms = msg(s, { content: FALA_SESSAO });
  abrirSessaoEv(s, { providerMsgId: ms.provider_msg_id, pasta: path.join(s.workspace, 'Comercial') });
  await s.p.passoEventos();
  assert.deepEqual(s.aberturasSessao, [path.join(s.workspace, 'Comercial')], 'sem a opcao: a subpasta');
  // o rodar passa a opcao do config (A3a: sessoes.soNaRaiz; o config do dono liga) (linha de codigo, fora de comentario)
  const codigo = fs.readFileSync(PORTEIRO, 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n');
  assert.match(codigo, /sessaoSoNaRaiz: sessoes\.soNaRaiz,/);
});

// ---------- F4f (PLANO.md "Fase 4f"): sessao nova ESCONDIDA (claude -n num console escondido, sem VS Code) ----------
// Pedido do dono: «mas eu quero por api, e nao pelo teclado. Pq eventualmente o pc esta bloqueado. Tem que ser sem
// interacao no mouse». Com `abrirSessaoEscondida` no porteiro, a sessao nova e um claude interativo aberto por programa:
// registro `cli` com o nome do `-n`, na pasta. Nada de janela, link nem foto do VS Code.
const SESSAO_ESC_FALHOU = (n) => `${CAB}\nNão consegui abrir a sessão ${n} no PC.`;
const SESSAO_ESC_NAO_ABRIU = (n) => `${CAB}\nNão consegui abrir a sessão ${n} no PC: ela não apareceu em 3 min.`;

function montarEscondida({ falha = null, soRaiz = false, ...o } = {}) {
  const h = montarSessao({ semAbrir: true, semJanelas: true, semLink: true, ...o });
  Object.assign(h, { escondidas: [], escFalha: falha, vsCode: [] });
  const extra = {
    raizesSessao: h.raizes, ensaio: o.ensaio ?? false,
    abrirSessaoEscondida: async (pasta, nome) => {
      h.escondidas.push([pasta, nome]);
      if (h.escFalha) throw new Error(h.escFalha);
    },
    // o modo escondido nunca chama o VS Code: cada chamada fica anotada
    abrirSessaoVsCode: async (pasta) => { h.vsCode.push(['abrir', pasta]); },
    janelasVsCode: () => { h.vsCode.push(['janelas']); return null; },
    abrirLinkVsCode: async (n) => { h.vsCode.push(['link', n]); },
  };
  if (soRaiz) extra.sessaoSoNaRaiz = true;
  const cru = porteiroCom(h, extra);
  h.cru = cru;
  h.p = { ...comBomba(cru), passoSessoes: async () => { await cru.passoSessoes(); await bombear(cru); } };
  return h;
}
// Registro como o `claude -n` grava (cli, nome dado, nameSource user; cwd como veio).
function sessaoEscondida(h, { sessionId, name = NOME_SESSAO, cwd = h.pasta, entrypoint = 'cli', startedAt = h.t } = {}) {
  h.nReg += 1;
  const arq = path.join(h.env.CLAUDE_SESSIONS_DIR, `${100000 + h.nReg}.json`);
  fs.writeFileSync(arq, JSON.stringify({
    pid: process.pid, sessionId, cwd, entrypoint, kind: 'interactive', name, nameSource: 'user', status: 'idle', startedAt, updatedAt: h.t,
  }));
  return arq;
}
// Fala do dono -> central -> abrir-sessao (modo escondido). Devolve a mensagem.
async function pedirEscondida(h, o = {}) {
  centralCli(h);
  const m = msg(h, { content: FALA_SESSAO });
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 1, 'a fala foi pra central');
  h.t += 10 * 1000;
  abrirSessaoEv(h, { providerMsgId: m.provider_msg_id, ...o });
  await h.p.passoEventos();
  return m;
}

test('F4f 1. feliz (escondida): abrir-sessao -> 1 abrirSessaoEscondida(pasta, nome) e nada do VS Code; registro cli com o nome firma em 10 s; fala encaminhada; transcript -> custom-title + frase com a pasta curta', async () => {
  const h = montarEscondida();
  const m = await pedirEscondida(h);
  const A = m.provider_msg_id;
  assert.deepEqual(h.escondidas, [[h.pasta, NOME_SESSAO]]);
  assert.deepEqual(h.vsCode, [], 'nem code, nem foto de janela, nem link');
  assert.deepEqual(h.enviados, [], 'nenhuma frase ainda');
  const e = estado(h);
  assert.equal(e.sessoesNovas.length, 1);
  assert.equal(e.sessoesNovas[0].escondida, true);
  assert.equal(e.sessoesNovas[0].desde, iso(h.t));
  assert.deepEqual(e.sessoesNovas[0].antes, []);
  assert.deepEqual(e.sessoesNovas[0].fala, { texto: FALA_SESSAO, audio: false, hora: '16:00', messageId: m.id, anexos: [] });

  h.t += 3000;
  sessaoEscondida(h, { sessionId: 'E1' });
  await h.p.passoSessoes();
  assert.equal(h.entregas.length, 1, '1a vez vista: ainda nao vale');
  h.t += 10 * 1000;
  await h.p.passoSessoes();
  assert.equal(h.entregas.length, 2);
  assert.deepEqual(h.entregas[1], {
    sessionId: 'E1', nome: NOME_SESSAO, titulo: NOME_SESSAO, texto: FALA_SESSAO, audio: false, hora: '16:00',
    providerMsgId: `${A}-E1`, messageId: m.id, anexos: [], encaminhado: true, nomear: NOME_SESSAO, pasta: h.pasta,
  });
  assert.deepEqual(estado(h).sessoesNovas, [], 'o item saiu');
  // o transcript nasce com o recado; o nome entra na volta seguinte
  const arq = transcript(h, 'E1', [peer(h.entregas[1], false, iso(h.t))], 'c--projetos-sessoes-wpp');
  const antesTxt = fs.readFileSync(arq, 'utf8');
  h.t += 3000;
  await h.p.passoSessoes();
  assert.equal(fs.readFileSync(arq, 'utf8'), `${antesTxt}${linhaNome(NOME_SESSAO, 'E1')}`);
  assert.deepEqual(h.enviados.map((x) => x.texto), [SESSAO_ABERTA(NOME_SESSAO, 'repos\\sessoes-wpp')]);
  assert.deepEqual(h.vsCode, [], 'o VS Code nunca entrou');
  assert.equal(linhasDoLog(h, /sessao escondida/).length >= 1, true);
});

test('F4f 2. so vale cli + o nome pedido: cli com outro nome e aba do VS Code com o nome certo nunca recebem; 180 s -> frase "não apareceu em 3 min" 1 vez', async () => {
  const h = montarEscondida();
  await pedirEscondida(h);
  h.t += 2000;
  sessaoEscondida(h, { sessionId: 'X1', name: 'Outra Sessão' });
  sessaoEscondida(h, { sessionId: 'X2', entrypoint: 'claude-vscode' });
  sessaoEscondida(h, { sessionId: 'X3', name: NOME_SESSAO, cwd: path.join(h.repos, 'outra') });
  for (let i = 0; i < 17; i++) {
    h.t += 10 * 1000;
    await h.p.passoSessoes();
  }
  assert.equal(h.entregas.length, 1, 'nenhuma recebeu');
  assert.deepEqual(h.enviados, [], 'antes dos 180 s nada');
  h.t += 20 * 1000;
  await h.p.passoSessoes();
  assert.deepEqual(h.enviados.map((x) => x.texto), [SESSAO_ESC_NAO_ABRIU(NOME_SESSAO)]);
  assert.deepEqual(estado(h).sessoesNovas, []);
  h.t += 60 * 1000;
  await h.p.passoSessoes();
  assert.equal(h.enviados.length, 1, 'a frase sai 1 vez so');
  assert.deepEqual(h.vsCode, []);
});

test('F4f 3. registro certo mas ja com transcript (conversa antiga) nunca recebe; o novo sem transcript, sim', async () => {
  const h = montarEscondida();
  await pedirEscondida(h);
  h.t += 2000;
  sessaoEscondida(h, { sessionId: 'V1', startedAt: h.t + 5000 });
  transcript(h, 'V1', [aiTitle('Conversa antiga')], 'c--projetos-sessoes-wpp');
  await h.p.passoSessoes();
  h.t += 10 * 1000;
  await h.p.passoSessoes();
  assert.equal(h.entregas.length, 1, 'com transcript nao vale');
  sessaoEscondida(h, { sessionId: 'N1' });
  await h.p.passoSessoes();
  h.t += 10 * 1000;
  await h.p.passoSessoes();
  assert.equal(h.entregas.length, 2);
  assert.equal(h.entregas[1].sessionId, 'N1');
});

test('F4f 4. sessao com o nome certo que ja estava viva na pasta antes do pedido (antes) nunca vira a nova', async () => {
  const h = montarEscondida();
  sessaoEscondida(h, { sessionId: 'Velha' });
  await pedirEscondida(h);
  assert.deepEqual(estado(h).sessoesNovas[0].antes, ['Velha']);
  for (let i = 0; i < 3; i++) {
    h.t += 10 * 1000;
    await h.p.passoSessoes();
  }
  assert.equal(h.entregas.length, 1, 'a velha nunca recebe');
  sessaoEscondida(h, { sessionId: 'Nova' });
  await h.p.passoSessoes();
  h.t += 10 * 1000;
  await h.p.passoSessoes();
  assert.equal(h.entregas.length, 2);
  assert.equal(h.entregas[1].sessionId, 'Nova');
});

test('F4f 5. abridor rejeita -> frase "Não consegui abrir a sessão X no PC.", nenhum item esperando; pedido de novo abre', async () => {
  const h = montarEscondida({ falha: 'wscript sumiu' });
  const m = await pedirEscondida(h);
  assert.deepEqual(h.escondidas, [[h.pasta, NOME_SESSAO]]);
  assert.deepEqual(h.enviados.map((x) => x.texto), [SESSAO_ESC_FALHOU(NOME_SESSAO)]);
  assert.deepEqual(estado(h).sessoesNovas, []);
  h.escFalha = null;
  h.t += 5000;
  abrirSessaoEv(h, { providerMsgId: m.provider_msg_id, at: iso(h.t) });
  await h.p.passoEventos();
  assert.equal(h.escondidas.length, 2, 'a central pode pedir de novo');
  assert.equal(estado(h).sessoesNovas.length, 1);
  assert.deepEqual(h.vsCode, []);
});

test('F4f 6. guardas no modo escondido: travado, ensaio, fora da central e pasta recusada nunca abrem; F4d: subpasta vira a raiz', async () => {
  // travado
  let h = montarEscondida();
  centralCli(h);
  let m = msg(h, { content: FALA_SESSAO });
  await h.p.passoGrupo();
  travar(h);
  abrirSessaoEv(h, { providerMsgId: m.provider_msg_id });
  await h.p.passoEventos();
  assert.deepEqual(h.escondidas, [], 'travado');
  // nao veio da central viva
  h = montarEscondida();
  centralCli(h);
  m = msg(h, { content: FALA_SESSAO });
  await h.p.passoGrupo();
  abrirSessaoEv(h, { providerMsgId: m.provider_msg_id, por: 'OUTRA' });
  await h.p.passoEventos();
  assert.deepEqual(h.escondidas, [], 'fora da central');
  // pasta recusada
  h = montarEscondida();
  await pedirEscondida(h, { pasta: path.join(h.raiz, 'fora') });
  assert.deepEqual(h.escondidas, [], 'pasta fora das raizes');
  assert.deepEqual(h.enviados.map((x) => x.texto), [SESSAO_PASTA_RECUSADA(NOME_SESSAO)]);
  // ensaio
  h = montarEscondida({ ensaio: true });
  centralCli(h);
  m = msg(h, { content: FALA_SESSAO });
  abrirSessaoEv(h, { providerMsgId: m.provider_msg_id });
  await h.p.passoEventos();
  assert.deepEqual(h.escondidas, [], 'ensaio nunca abre');
  const acoes = fs.readFileSync(path.join(h.env.SESSOES_WPP_DIR, 'ensaio.jsonl'), 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
  assert.deepEqual(acoes.map(({ at, ...resto }) => resto), [{ acao: 'abrirSessao', nome: NOME_SESSAO, pasta: h.pasta }], 'o ensaio chegou na guarda dele');
  // F4d: subpasta da Area vira a raiz no modo escondido tambem
  h = montarEscondida({ soRaiz: true });
  await pedirEscondida(h, { pasta: path.join(h.workspace, 'Comercial') });
  assert.deepEqual(h.escondidas, [[h.workspace, NOME_SESSAO]]);
  assert.deepEqual(h.vsCode, []);
});

test('F4f 7. nome com acento: registro gravado em outra forma Unicode (NFD) vale', async () => {
  const h = montarEscondida();
  await pedirEscondida(h);
  assert.notEqual(NOME_SESSAO.normalize('NFD'), NOME_SESSAO, 'o nome do teste tem acento');
  h.t += 2000;
  sessaoEscondida(h, { sessionId: 'D1', name: NOME_SESSAO.normalize('NFD') });
  await h.p.passoSessoes();
  h.t += 10 * 1000;
  await h.p.passoSessoes();
  assert.equal(h.entregas.length, 2);
  assert.equal(h.entregas[1].sessionId, 'D1');
});

test('F4f 8. item de estado velho (sem `escondida`) com o modo escondido ligado segue a logica do VS Code de hoje, sem lancar', async () => {
  const h = montarEscondida();
  centralCli(h);
  const m = msg(h, { content: FALA_SESSAO });
  await h.p.passoGrupo();
  const arq = path.join(h.env.SESSOES_WPP_DIR, 'estado.json');
  const e = JSON.parse(fs.readFileSync(arq, 'utf8'));
  e.sessoesNovas = [{
    id: m.provider_msg_id, nome: NOME_SESSAO, pasta: h.pasta, desde: iso(h.t), antes: [], janelasAntes: null, janela: null,
    linkEm: null, fala: { texto: FALA_SESSAO, audio: false, hora: '16:00', messageId: m.id, anexos: [] }, candidato: null,
  }];
  fs.writeFileSync(arq, JSON.stringify(e));
  h.t += 25 * 1000;
  await h.p.passoSessoes();
  assert.deepEqual(h.enviados.map((x) => x.texto), [SESSAO_JA_ABERTA(NOME_SESSAO, 'repos\\sessoes-wpp')], 'a regra de 20 s de hoje');
  assert.deepEqual(h.escondidas, []);
});

test('F4f 9. abrirSessaoEscondidaReal (spawn falso): 1 wscript.exe com //nologo, o vbs da pasta central, a pasta e o nome (1 argumento cada), sem janela, sem as herdadas; nome com aspas, %, quebra ou vazio e pasta ruim rejeitam sem chamar; erro, saida != 0 e prazo rejeitam', async () => {
  assert.equal(typeof porteiroMod.abrirSessaoEscondidaReal, 'function', 'abrirSessaoEscondidaReal exportada');
  const real = (o) => porteiroMod.abrirSessaoEscondidaReal({ gravarCentral: MONTAR, ...o }); // A5d2: a montada dublada
  const vbs = path.join(path.dirname(PORTEIRO), 'central', 'abrir-sessao.vbs');
  const env = {
    PATH: 'x', CLAUDE_CODE_SESSION_ID: 'S', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode',
    SESSOES_WPP_MENSAGEIRO: '1',
  };
  const pasta = 'D:\\Meus Docs\\trabalho\\Area';
  const sp = spawnCmdFalso();
  await real({ spawn: sp, env })(pasta, 'Edição de Vídeos');
  assert.equal(sp.chamadas.length, 1);
  assert.equal(sp.chamadas[0].cmd, 'wscript.exe');
  assert.deepEqual(sp.chamadas[0].args, ['//nologo', vbs, pasta, 'Edição de Vídeos']);
  const o = sp.chamadas[0].opts;
  assert.equal(o.windowsHide, true);
  assert.notEqual(o.windowsVerbatimArguments, true, 'sem cmd.exe no meio: o Node poe as aspas');
  assert.equal(o.env.PATH, 'x');
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'SESSOES_WPP_MENSAGEIRO']) {
    assert.equal(Object.hasOwn(o.env, k), false, k);
  }
  for (const [p, n] of [[pasta, 'com "aspas"'], [pasta, '100%'], [pasta, ''], [pasta, 'a\nb'], ['', 'Nome'], ['C:\\projetos\\50%', 'Nome'], [null, 'Nome']]) {
    const sp2 = spawnCmdFalso();
    await assert.rejects(real({ spawn: sp2, env })(p, n), String(n));
    assert.equal(sp2.chamadas.length, 0, `${p} / ${n}`);
  }
  await assert.rejects(real({ spawn: spawnCmdFalso(['erro']), env })(pasta, 'Nome'));
  await assert.rejects(real({ spawn: spawnCmdFalso([3]), env })(pasta, 'Nome'));
  const sp3 = spawnCmdFalso(['nada']);
  await assert.rejects(real({ spawn: sp3, env, prazoMs: 30 })(pasta, 'Nome'));
  assert.equal(sp3.chamadas[0].filho.morto, true, 'prazo mata o wscript');
});

// Prova do abrir-sessao.vbs de VERDADE (so Windows): wscript real com um claude FALSO (um .cmd que chama o node e grava
// a pasta atual, os argumentos e 2 variaveis). Nunca abre o claude de verdade. Pasta com espaco e acento; nome com acento.
test('F4f 10. abrir-sessao.vbs de verdade com claude falso: pasta atual = a pasta, -n com o nome (acento inteiro), o modo, --settings e --append-system-prompt-file da pasta montada (A5d2: SESSOES_WPP_MONTADA e SESSOES_WPP_MODO), SESSOES_WPP_ESCONDIDA=1, sem a identidade da sessao', { skip: process.platform !== 'win32' }, async () => {
  const raiz = pastaTemp('porteiro vbs ');
  const pasta = path.join(raiz, 'Meus Docs', 'Área de trabalho');
  fs.mkdirSync(pasta, { recursive: true });
  const saida = path.join(raiz, 'saida.json');
  const falsoJs = path.join(raiz, 'claude-falso.cjs');
  fs.writeFileSync(falsoJs, `require('fs').writeFileSync(process.env.SAIDA_FALSO, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), esc: process.env.SESSOES_WPP_ESCONDIDA ?? null, sid: process.env.CLAUDE_CODE_SESSION_ID ?? null }));\n`);
  const falsoCmd = path.join(raiz, 'bin com espaco', 'claude.cmd');
  fs.mkdirSync(path.dirname(falsoCmd), { recursive: true });
  fs.writeFileSync(falsoCmd, `@echo off\r\n"${process.execPath}" "${falsoJs}" %*\r\n`);
  const vbs = path.join(path.dirname(PORTEIRO), 'central', 'abrir-sessao.vbs');
  // A5d2: a pasta montada (o que o gravarCentral grava) e o modo vem do ambiente
  const central = path.join(raiz, 'estado', 'central');
  fs.mkdirSync(central, { recursive: true });
  for (const a of ['instrucoes-sessao.md', 'ajustes.json']) fs.writeFileSync(path.join(central, a), '');
  const montada = { SESSOES_WPP_MONTADA: central, SESSOES_WPP_MODO: 'bypassPermissions' };
  const nome = 'Edição de Vídeos';
  const r = spawnSync('wscript.exe', ['//nologo', vbs, pasta, nome], {
    env: { ...process.env, ...montada, SESSOES_WPP_CLAUDE: falsoCmd, SAIDA_FALSO: saida, CLAUDE_CODE_SESSION_ID: 'SESSAO-DE-FORA' },
    windowsHide: true, timeout: 20000,
  });
  assert.equal(r.status, 0, String(r.stderr));
  for (let i = 0; i < 100 && !fs.existsSync(saida); i++) await new Promise((ok) => setTimeout(ok, 100));
  assert.ok(fs.existsSync(saida), 'o claude falso rodou');
  let lido = null;
  for (let i = 0; i < 20 && lido === null; i++) {
    try { lido = JSON.parse(fs.readFileSync(saida, 'utf8')); } catch { await new Promise((ok) => setTimeout(ok, 100)); }
  }
  assert.equal(fs.realpathSync.native(lido.cwd).toLowerCase(), fs.realpathSync.native(pasta).toLowerCase());
  assert.deepEqual(lido.argv, [
    '-n', nome, '--permission-mode', 'bypassPermissions', '--settings', path.join(central, 'ajustes.json'),
    '--append-system-prompt-file', path.join(central, 'instrucoes-sessao.md'),
  ]);
  assert.equal(lido.esc, '1');
  assert.equal(lido.sid, null, 'a identidade da sessao de fora nao passa');
  // faltou argumento = sai com 2 sem rodar nada
  const r2 = spawnSync('wscript.exe', ['//nologo', vbs, pasta], { env: { ...process.env, ...montada, SESSOES_WPP_CLAUDE: falsoCmd }, windowsHide: true, timeout: 20000 });
  assert.equal(r2.status, 2);
  // nome com % = sai com 2 sem rodar nada (o Shell.Run expandiria como variavel)
  fs.rmSync(saida, { force: true });
  const r3 = spawnSync('wscript.exe', ['//nologo', vbs, pasta, '100% Vídeos'], {
    env: { ...process.env, ...montada, SESSOES_WPP_CLAUDE: falsoCmd, SAIDA_FALSO: saida }, windowsHide: true, timeout: 20000,
  });
  assert.equal(r3.status, 2);
  await new Promise((ok) => setTimeout(ok, 500));
  assert.equal(fs.existsSync(saida), false, 'o claude falso nao rodou');
  fs.rmSync(raiz, { recursive: true, force: true });
});

test('F4f 11. o rodar liga o modo escondido (abrirSessaoEscondida: abrirSessaoEscondidaReal) e o instrucoes-sessao.md existe sem pedir botao', () => {
  const codigo = fs.readFileSync(PORTEIRO, 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n');
  assert.match(codigo, /abrirSessaoEscondida: abrirSessaoEscondidaReal\(/);
  const instr = fs.readFileSync(path.join(path.dirname(PORTEIRO), 'central', 'instrucoes-sessao.md'), 'utf8');
  assert.match(instr, /AskUserQuestion/);
  assert.match(instr, /DECISÃO/);
  assert.match(instr, /ok-wpp\.mjs/);
});

test('F4g 17. as instrucoes da central e da sessao escondida dizem que so a 1a frase e a pergunta chegam no grupo (o resto, com detalhe)', () => {
  for (const arq of ['instrucoes.md', 'instrucoes-sessao.md']) {
    const instr = fs.readFileSync(path.join(path.dirname(PORTEIRO), 'central', arq), 'utf8');
    assert.match(instr, /só chegam a 1ª frase/, arq);
    assert.match(instr, /se ele pedir detalhe/, arq);
    assert.doesNotMatch(instr, /sem emoji/, `${arq}: o bloco 🔴 DECISÃO e o formato`);
  }
});

test('T5c 1. as instrucoes da central ensinam o Telegram: id tg-u, ler-grupo --telegram, encaminhar, sessao nova tambem pelo Telegram (T6), OK tambem quando a conversa veio do Telegram (T7b3)', () => {
  const instr = fs.readFileSync(path.join(path.dirname(PORTEIRO), 'central', 'instrucoes.md'), 'utf8');
  // A5d: o modelo (o recado traz o nome do dono depois do "Veio do Telegram"; o comando com o {{repo}} entre aspas)
  assert.match(instr, /O recado do porteiro diz "Veio do Telegram"/);
  assert.match(instr, /`tg-u/);
  assert.match(instr, /node "\{\{repo\}\}\/ler-grupo\.mjs" 15 --telegram/);
  assert.match(instr, /volta sozinha pro Telegram/);
  assert.match(instr, /^16\. Sessão nova pelo Telegram: a regra do item 9/m); // T6 (antes: "ainda não abre")
  assert.doesNotMatch(instr, /não rode o `abrir-sessao`|sessão nova se pede no WhatsApp/); // T6
  assert.match(instr, /OK de ação \(item 10\) vale igual quando a conversa veio do Telegram/); // T7b3 (antes: "continua só no WhatsApp")
  assert.doesNotMatch(instr, /continua só no WhatsApp/); // T7b3
  assert.match(instr, /\/status`, `\/rua`, `\/voltei` e `\/central`/);
});

test('T7a2 38. item 11 das instrucoes da central: nunca muda o proprio controle, acha a aba pelo abas.mjs --controle, as 2 linhas literais; itens 1 a 18 em ordem, 1 vez cada', () => {
  const instr = fs.readFileSync(path.join(path.dirname(PORTEIRO), 'central', 'instrucoes.md'), 'utf8');
  const corrido = instr.replace(/\s+/g, ' ');
  // A5d: o modelo ("o dono" e o {{repo}} entre aspas nos comandos)
  assert.ok(corrido.includes('node "{{repo}}/abas.mjs" --controle'));
  assert.ok(corrido.includes('mesmo quando o dono pede direto'));
  assert.ok(corrido.includes('"Mudança no próprio controle eu não faço daqui, e a aba que desenvolve o controle não está aberta no PC."'));
  assert.ok(corrido.includes('"Fica com você: abrir essa aba no PC e me mandar o pedido de novo."'));
  // o item 11 inteiro, literal do plano (PLANO-T7.md, T7a2, "Textos novos"), no lugar do antigo
  const ITEM_11 = '11. Trabalho de outra aba fica na aba dela (1 aba = 1 projeto). Você roteia e responde sobre o sistema, mas '
    + 'nunca muda o próprio controle: em pedido de mudança no porteiro, no mensageiro, nos hooks, no Telegram, no OK de '
    + 'ação, nestas instruções ou em qualquer arquivo de `{{repo}}` (mesmo quando o dono pede direto pra '
    + 'você), você não edita, não commita, não para nem religa o porteiro e não mexe à mão no `config.json` nem no estado '
    + '(os comandos dos itens 6, 9 e 10 seguem valendo). Ache na hora a aba que desenvolve o controle (o nome dela muda; '
    + 'nunca guarde): `node "{{repo}}/abas.mjs" --controle` lista as abas abertas que mexeram em arquivo do '
    + 'controle nas últimas 24 h, a mais recente primeiro. 1 ou mais = encaminhe o pedido pra primeira (item 6, com o '
    + 'sessionId da lista no `--para`) e diga o nome dela na frase. Nenhuma = responda estas 2 linhas, literais: '
    + '"Mudança no próprio controle eu não faço daqui, e a aba que desenvolve o controle não está aberta no PC." e, '
    + 'embaixo, "Fica com você: abrir essa aba no PC e me mandar o pedido de novo."';
  const item = /^11\. [\s\S]*?(?=\r?\n12\. )/m.exec(instr);
  assert.ok(item, 'item 11 seguido do 12');
  assert.equal(item[0].replace(/\s+/g, ' ').trim(), ITEM_11);
  const numeros = [...instr.matchAll(/^(\d+)\. /gm)].map((x) => Number(x[1]));
  assert.deepEqual(numeros, Array.from({ length: 18 }, (_, i) => i + 1), 'itens 1 a 18 em ordem, 1 vez cada (T24: o 18)');
});

test('T24 1. item 18 das instrucoes da central: tirar do Esperando e trazer de volta pelo porteiro (esperando + aguardar), nome em 2 abas = perguntar, a frase de 1 linha', () => {
  const instr = fs.readFileSync(path.join(path.dirname(PORTEIRO), 'central', 'instrucoes.md'), 'utf8');
  const item = /^18\. [\s\S]*$/m.exec(instr);
  assert.ok(item, 'item 18 no fim');
  const corrido = item[0].replace(/\s+/g, ' ');
  // A5d: o modelo (o {{repo}} entre aspas; "do dono")
  assert.ok(corrido.includes('`node "{{repo}}/porteiro.mjs" esperando`'), corrido);
  assert.ok(corrido.includes('`node "{{repo}}/porteiro.mjs" aguardar --sessao "<sessionId>[,<sessionId>...]" --msg <id da mensagem do dono>`'), corrido);
  assert.ok(corrido.includes('`--voltar`'), corrido);
  assert.ok(corrido.includes('pergunte qual'), corrido);
  assert.ok(corrido.includes('"pedi pro porteiro mover X e Y pra Aguardando"'), corrido);
  assert.ok(corrido.includes('"pedi pro porteiro voltar X pro Esperando"'), corrido);
  assert.ok(corrido.includes('Pedido de OK não vai pra Aguardando'), corrido);
  assert.ok(!/abas\.mjs/.test(corrido), 'quem move e o porteiro (o abas.mjs so le)');
});

test('F4f 12. travado com a sessao escondida esperando: nao entrega; destravou antes dos 180 s = entrega; travado ate os 180 s = sai calado', async () => {
  // travou com a sessao esperando: nao entrega; destravou antes dos 180 s = entrega
  let h = montarEscondida();
  await pedirEscondida(h);
  h.t += 2000;
  sessaoEscondida(h, { sessionId: 'T1' });
  await h.p.passoSessoes();
  travar(h);
  for (let i = 0; i < 3; i++) {
    h.t += 10 * 1000;
    await h.p.passoSessoes();
  }
  assert.equal(h.entregas.length, 1, 'travado: a sessao espera');
  assert.equal(estado(h).sessoesNovas.length, 1);
  assert.equal(destravar({ env: h.env }).ok, true);
  h.t += 10 * 1000;
  await h.p.passoSessoes();
  assert.deepEqual(h.entregas.slice(1).map((x) => x.sessionId), ['T1']);
  assert.deepEqual(h.enviados, []);

  // travado ate os 180 s: o item sai calado (nada sai do porteiro travado)
  h = montarEscondida();
  await pedirEscondida(h);
  h.t += 2000;
  sessaoEscondida(h, { sessionId: 'T2' });
  await h.p.passoSessoes();
  travar(h);
  for (let i = 0; i < 18; i++) {
    h.t += 10 * 1000;
    await h.p.passoSessoes();
  }
  assert.equal(h.entregas.length, 1);
  assert.deepEqual(h.enviados, []);
  assert.deepEqual(estado(h).sessoesNovas, []);
  assert.equal(linhasDoLog(h, /travado ate o fim da espera da sessao escondida/).length, 1);
  assert.deepEqual(h.vsCode, []);
});

// F4h (01/10/2026 08:33): a central fechou pra pegar as instrucoes novas e o porteiro a reabriu com o MESMO nome; a
// pergunta dela das 08:31 ficou no grupo apontando pro sessionId velho. O mensageiro entrega pelo nome (chegaria na nova),
// mas a conferencia e a resposta seguem o sessionId (alarme falso e resposta perdida) e a nova nao conhece a pergunta.
const FINAL_FIN = '🟢 A aba fechou no reinício.\n\n🔴 **DECISÃO:** abro uma sessão nova?\nA) Sim / B) Não';
async function cenaFechou(h) {
  sessao(h, { sessionId: 'S1', name: 'Financeiro', nameSource: 'user' });
  transcript(h, 'S1', [custom('Financeiro')]);
  await ligarRua(h);
  evento(h, parou(h, 'S1', { nome: 'Financeiro', titulo: 'Financeiro', final: FINAL_FIN, marcas: DECISAO }));
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 1);
  fecharSessao(h, 'S1');
  h.t += 2 * MIN;
}

test('F4h 1. citou a mensagem de uma aba que fechou e ha 1 aberta com o mesmo nome: vai pra ela, com a mensagem citada; conferencia e resposta pela nova', async () => {
  const h = montar();
  await cenaFechou(h);
  const aviso = h.enviados[0].texto;
  assert.equal(estado(h).avisos.P1.texto, aviso, 'o aviso guarda o texto enviado');
  sessao(h, { sessionId: 'S2', name: 'Financeiro', nameSource: 'user' });
  transcript(h, 'S2', [aiTitle('Conversa nova')]);
  const m = msg(h, { content: 'A', quoted_msg_id: 'P1' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 1);
  const pedido = h.entregas[0];
  assert.deepEqual(pedido, {
    sessionId: 'S2', nome: 'Financeiro', titulo: 'Financeiro', texto: 'A', audio: false, hora: '16:02',
    providerMsgId: m.provider_msg_id, messageId: m.id, anexos: [], citada: aviso,
  });
  assert.equal(linhasDoLog(h, /citou a aba S1, que fechou: vai pra S2, aberta com o mesmo nome/).length, 1);
  assert.match(montarRecado(pedido), /\nEle respondeu citando esta mensagem do grupo, de uma aba com o seu nome que fechou antes de você abrir \(você não viu a conversa dela\): «ℹ️ \*Financeiro\* A aba fechou no reinício\. \*Abro uma sessão nova\?\* A\) Sim \/ B\) Não»/);
  // a nova pega o recado e responde com a linha: conferido nela, e a resposta vai pro grupo
  transcript(h, 'S2', [peer(pedido, false, iso(h.t))]);
  h.t += MIN;
  const fim = `${linha('16:02', 'A')}\nAbri a sessão nova.`;
  transcript(h, 'S2', [falaDaAba(fim, iso(h.t))]);
  evento(h, parou(h, 'S2', { nome: 'Financeiro', titulo: 'Financeiro', final: fim }));
  await h.p.passoEventos();
  assert.equal(estado(h).entregas[m.provider_msg_id].conferido, true);
  assert.deepEqual(h.enviados.slice(1).map((x) => x.texto), ['ℹ️ *Financeiro*\nAbri a sessão nova.']);
});

test('F4h 2. aba que fechou sem nenhuma (ou com 2) aberta com o mesmo nome: como antes (sessionId velho, sem a mensagem citada)', async () => {
  let h = montar();
  await cenaFechou(h);
  msg(h, { content: 'A', quoted_msg_id: 'P1' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 1);
  assert.equal(h.entregas[0].sessionId, 'S1');
  assert.equal(h.entregas[0].nome, 'Financeiro');
  assert.equal('citada' in h.entregas[0], false);

  h = montar();
  await cenaFechou(h);
  sessao(h, { sessionId: 'S2', name: 'Financeiro', nameSource: 'user' });
  sessao(h, { sessionId: 'S3', name: 'Financeiro', nameSource: 'user' });
  msg(h, { content: 'A', quoted_msg_id: 'P1' });
  await h.p.passoGrupo();
  assert.equal(h.entregas[0].sessionId, 'S1', '2 com o nome: o mensageiro responde DUPLICADO, como antes');
  assert.equal('citada' in h.entregas[0], false);

  // nome so parecido nao conta (o mensageiro so entrega com o nome exato)
  h = montar();
  await cenaFechou(h);
  sessao(h, { sessionId: 'S2', name: 'financeiro', nameSource: 'user' });
  msg(h, { content: 'A', quoted_msg_id: 'P1' });
  await h.p.passoGrupo();
  assert.equal(h.entregas[0].sessionId, 'S1');
});

test('F4h 3. aviso de antes de guardar o texto: a mensagem citada vem da leitura do grupo; sem ela, vai sem', async () => {
  const h = montar();
  await cenaFechou(h);
  const e = estado(h);
  for (const a of Object.values(e.avisos)) delete a.texto; // como os avisos gravados antes da F4h
  fs.writeFileSync(path.join(h.env.SESSOES_WPP_DIR, 'estado.json'), JSON.stringify(e));
  sessao(h, { sessionId: 'S2', name: 'Financeiro', nameSource: 'user' });
  doAgente(h, { provider_msg_id: 'P1', id: 'U1', content: 'ℹ️ *Financeiro*\nA aba fechou.\n\n*Abro?*' });
  msg(h, { content: 'A', quoted_msg_id: 'P1' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 1);
  assert.equal(h.entregas[0].sessionId, 'S2');
  assert.equal(h.entregas[0].citada, 'ℹ️ *Financeiro*\nA aba fechou.\n\n*Abro?*');

  // fora da leitura e sem texto guardado: vai pra nova, sem a mensagem citada
  const h2 = montar();
  await cenaFechou(h2);
  const e2 = estado(h2);
  for (const a of Object.values(e2.avisos)) delete a.texto;
  fs.writeFileSync(path.join(h2.env.SESSOES_WPP_DIR, 'estado.json'), JSON.stringify(e2));
  sessao(h2, { sessionId: 'S2', name: 'Financeiro', nameSource: 'user' });
  msg(h2, { content: 'A', quoted_msg_id: 'P1' });
  await h2.p.passoGrupo();
  assert.equal(h2.entregas[0].sessionId, 'S2');
  assert.equal('citada' in h2.entregas[0], false);
});

// ---------- T7a1a: central sem canal de recado (PLANO-T7.md, "T7a1"; testes 26, 28, 29 e 35) ----------
// Duble `listarPipes` (Set de nomes em minusculas; `h.pipesNull` = a listagem falhou) e fixtures centralSemCanal /
// centralComCanal: registro do abrir-central.vbs (entrypoint cli, name do -n, nameSource user) com messagingSocketPath,
// procStart (FILETIME) e startedAt. Nada lista o \\.\pipe\ de verdade.
const NOME_DO_N = CENTRAL_TESTE.nome; // o -n do central/abrir-central.vbs (A3a: o nome da central do config)
const filetimeDe = (ms) => String((BigInt(ms) + 11644473600000n) * 10000n);

function montarPipes(o = {}) {
  const h = montar(o);
  h.pipes = new Set();
  h.pipesNull = false;
  h.listagens = 0;
  h.listarPipes = () => {
    h.listagens += 1;
    return h.pipesNull ? null : new Set(h.pipes);
  };
  h.cru = criarPorteiro({
    wpp: h.wpp, numeroDono: NUMERO_DONO, mensageiro: h.mensageiro, ocioso: async () => h.idle, agora: () => h.t, env: h.env, abrirCentral: h.abrirCentral,
    ensaio: false, listarPipes: h.listarPipes, central: h.central, raizesSessao: h.raizes,
  });
  h.p = comBomba(h.cru);
  return h;
}

// Registro com o canal de recado: `pipe` = nome do pipe (comCanal = entra na lista do duble); `pipe: null` = sem o campo.
// T7a1b: `pid` (padrao process.pid), `cwd` e `semProcStart` (registro sem o procStart: a idade vem do startedAt).
function regPipe(h, { sessionId, pipe, comCanal = true, name = 'projetos-42', nameSource = 'derived', entrypoint = 'claude-vscode', idadeMs = 10 * MIN, status = 'idle', pid = process.pid, cwd = 'C:\\projetos', semProcStart = false }) {
  h.nReg += 1;
  const inicio = h.t - idadeMs;
  const reg = { pid, sessionId, cwd, entrypoint, name, nameSource, status, updatedAt: h.t, startedAt: inicio, procStart: filetimeDe(inicio) };
  if (semProcStart) delete reg.procStart;
  if (pipe) reg.messagingSocketPath = `\\\\.\\pipe\\${pipe}`;
  fs.writeFileSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${100000 + h.nReg}.json`), JSON.stringify(reg));
  if (pipe && comCanal && h.pipes) h.pipes.add(pipe.toLowerCase());
  return reg;
}
function abaComPipe(h, sessionId, titulo, o = {}) {
  regPipe(h, { sessionId, pipe: `claude-${sessionId.toLowerCase()}`, ...o });
  transcript(h, sessionId, [custom(titulo)]);
}
const centralSemCanal = (h, o = {}) => regPipe(h, {
  sessionId: 'CS', pipe: 'claude-cs', comCanal: false, name: NOME_DO_N, nameSource: 'user', entrypoint: 'cli', ...o,
});
const centralComCanal = (h, o = {}) => regPipe(h, {
  sessionId: 'CC', pipe: 'claude-cc', comCanal: true, name: NOME_DO_N, nameSource: 'user', entrypoint: 'cli', ...o,
});
// passoCentral + a bomba do passoEntrega (o que ele soltou sai pro mensageiro)
async function soltarCentral(h) {
  assert.equal(typeof h.cru.passoCentral, 'function', 'T7a1a: o porteiro tem o passoCentral');
  const r = await h.cru.passoCentral();
  await bombear(h.cru);
  return r;
}
const logT7 = (h, re) =>
  (fs.existsSync(h.env.SESSOES_WPP_LOG) ? fs.readFileSync(h.env.SESSOES_WPP_LOG, 'utf8') : '').split('\n').filter((l) => re.test(l));
const NAO_ABRIU_T7 = `${CAB}\nA central não abriu no PC. Tenta "abre central" de novo ou abre no PC.`;
const SEM_CENTRAL_T7 = `${CAB}\nNão sei pra qual sessão é. Responde citando o aviso dela, ou começa com o nome da sessão e dois pontos. "status" lista as sessões.`;

test('T7a1a 26. temCanalDeRecado e procStartMs (unidade); ninguem com o campo = roteamento igual a hoje; sem listarPipes = como hoje', async () => {
  const { temCanalDeRecado, procStartMs } = porteiroMod;
  assert.equal(typeof temCanalDeRecado, 'function', 'temCanalDeRecado exportada');
  assert.equal(typeof procStartMs, 'function', 'procStartMs exportada');
  const pipes = new Set(['claude-abc']);
  assert.equal(temCanalDeRecado({ pid: 1 }, pipes), false, 'sem messagingSocketPath = false');
  assert.equal(temCanalDeRecado({ messagingSocketPath: '\\\\.\\pipe\\claude-abc' }, pipes), true, 'na lista = true');
  assert.equal(temCanalDeRecado({ messagingSocketPath: '\\\\.\\pipe\\Claude-ABC' }, pipes), true, 'o resto em minusculas');
  assert.equal(temCanalDeRecado({ messagingSocketPath: '\\\\.\\pipe\\claude-xyz' }, pipes), false, 'fora da lista = false');
  assert.equal(temCanalDeRecado({ messagingSocketPath: '\\\\.\\pipe\\claude-abc' }, null), null, 'pipes null = null');
  assert.equal(temCanalDeRecado({ messagingSocketPath: '/tmp/claude-abc.sock' }, pipes), null, 'outro formato = null');
  assert.equal(temCanalDeRecado({ messagingSocketPath: 42 }, pipes), null, 'campo torto = null');
  assert.equal(procStartMs('134353489160112846'), 1790875316011);
  assert.equal(procStartMs(filetimeDe(T0)), T0);
  for (const x of [null, undefined, '', 'abc', '12x', 1.5, {}]) assert.equal(procStartMs(x), null, `procStartMs(${String(x)})`);

  // campo conhecido: nenhum registro vivo com messagingSocketPath (lista de pipes vazia) = a fala vai pra central de hoje
  const h = montarPipes();
  sessao(h, { sessionId: 'S1' });
  transcript(h, 'S1', [custom('Faro')]);
  sessao(h, { sessionId: 'SC', name: 'repos-99' });
  transcript(h, 'SC', [custom('Central de sessões de teste')]);
  msg(h, { content: 'bom dia' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 1);
  assert.equal(h.entregas[0].sessionId, 'SC', 'ninguem com o campo = canal null em todas = recebe');
  assert.equal(h.enviados.length, 0);
  assert.equal(estado(h).centralPendentes.length, 0);

  // sem listarPipes (null) = como hoje: a central com o campo apontando pra pipe que nao existe recebe
  const h2 = montar();
  centralSemCanal(h2);
  msg(h2, { content: 'oi' });
  await h2.p.passoGrupo();
  assert.equal(h2.entregas.length, 1);
  assert.equal(h2.entregas[0].sessionId, 'CS', 'sem listarPipes nada muda');
  await h2.p.passoMinuto();
  assert.equal(h2.aberturas, 0);

  // a listagem falhou (null) = canal null = recebe, como hoje
  const h3 = montarPipes();
  h3.pipesNull = true;
  centralSemCanal(h3);
  msg(h3, { content: 'oi' });
  await h3.p.passoGrupo();
  assert.equal(h3.entregas.length, 1);
  assert.equal(h3.entregas[0].sessionId, 'CS', 'listagem ilegivel = nao sabe = como hoje');
  assert.ok(h3.listagens >= 1, 'o duble foi consultado');
});

test('T7a1a 28. central sem canal ha 30 s + fala -> estaciona (0 claude -p, 0 frase, 0 aberturas); ganha o canal em 1 min -> sai 1 vez pra ela; 3 min sem canal -> centralNaoAbriu 1 vez; travado esvazia', async () => {
  const h = montarPipes();
  abaComPipe(h, 'S1', 'Faro');
  centralSemCanal(h, { idadeMs: 30 * 1000 });
  const f = msg(h, { content: 'bom dia' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 0, 'nenhum claude -p pra central que nao recebe');
  assert.equal(h.enviados.length, 0, 'nenhuma frase');
  assert.deepEqual(h.reacoes, []);
  let e = estado(h);
  assert.equal(e.centralPendentes.length, 1, '1 pendente');
  const x = e.centralPendentes[0];
  assert.equal(x.porque, 'esperando');
  assert.equal(x.desde, iso(h.t));
  assert.equal(x.pedido.sessionId, 'CS');
  assert.equal(x.pedido.texto, 'bom dia');
  assert.equal(x.pedido.providerMsgId, f.provider_msg_id);
  assert.equal(e.filaEntrega.length, 0);
  assert.equal(logT7(h, /fala pra central estacionada \(esperando\): espera a central que recebe/).length, 1);
  await h.p.passoMinuto();
  assert.equal(h.aberturas, 0, 'central viva sem canal: o abrir sozinho nao abre outra');
  let r = await soltarCentral(h);
  assert.deepEqual(r, { pendentes: 1, soltas: 0, expiradas: 0 });
  assert.equal(h.entregas.length, 0);

  h.t += MIN;
  h.pipes.add('claude-cs'); // ganhou o canal
  r = await soltarCentral(h);
  assert.deepEqual(r, { pendentes: 0, soltas: 1, expiradas: 0 });
  assert.equal(h.entregas.length, 1, 'a fala sai 1 vez');
  assert.equal(h.entregas[0].sessionId, 'CS');
  assert.equal(h.entregas[0].texto, 'bom dia');
  assert.equal(h.entregas[0].providerMsgId, f.provider_msg_id, 'o mesmo providerMsgId');
  assert.deepEqual(h.reacoes, [{ messageId: f.id, emoji: '✅' }]);
  assert.equal(h.enviados.length, 0, 'sem frase');
  r = await soltarCentral(h);
  assert.deepEqual(r, { pendentes: 0, soltas: 0, expiradas: 0 });
  await h.p.passoMinuto();
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 1, '1 vez so');
  assert.equal(h.aberturas, 0, '0 aberturas');
  assert.equal(estado(h).centralPendentes.length, 0);

  // 3 min sem central que recebe = centralNaoAbriu 1 vez pelo grupo, a fala sai da lista, nada entregue nem aberto
  const h2 = montarPipes();
  abaComPipe(h2, 'S1', 'Faro');
  centralSemCanal(h2, { idadeMs: 30 * 1000 });
  msg(h2, { content: 'oi' });
  await h2.p.passoGrupo();
  h2.t += 2 * MIN;
  await h2.p.passoMinuto();
  r = await soltarCentral(h2);
  assert.deepEqual(r, { pendentes: 1, soltas: 0, expiradas: 0 }, '2 min: ainda espera');
  assert.equal(h2.enviados.length, 0);
  h2.t += MIN;
  r = await soltarCentral(h2);
  assert.deepEqual(r, { pendentes: 0, soltas: 0, expiradas: 1 });
  assert.deepEqual(h2.enviados.map((m) => m.texto), [NAO_ABRIU_T7], 'a frase que ja existe, 1 vez');
  assert.equal(logT7(h2, /fala pra central sem central que recebe em 3 min: avisando/).length, 1);
  h2.t += MIN;
  r = await soltarCentral(h2);
  await h2.p.passoMinuto();
  assert.deepEqual(r, { pendentes: 0, soltas: 0, expiradas: 0 });
  assert.equal(h2.enviados.length, 1, 'nenhuma 2a frase');
  assert.equal(h2.entregas.length, 0);
  assert.equal(h2.aberturas, 0, 'nada abre outra central (nem mata: T7a1b)');
  assert.equal(estado(h2).centralPendentes.length, 0);

  // travado: a trava zera os pendentes; pendente no estado de um porteiro travado = esvazia sem entregar
  const h3 = montarPipes();
  abaComPipe(h3, 'S1', 'Faro');
  centralSemCanal(h3, { idadeMs: 30 * 1000 });
  msg(h3, { content: 'oi' });
  await h3.p.passoGrupo();
  assert.equal(estado(h3).centralPendentes.length, 1);
  h3.t += 1000;
  msg(h3, { content: 'trava' });
  await h3.p.passoGrupo();
  e = estado(h3);
  assert.equal(e.trava, true);
  assert.deepEqual(e.centralPendentes, [], 'o travar zera os pendentes');
  for (const k of ['centralReabrindo', 'centralSemRecado', 'fraseReabertaDe']) assert.equal(e[k], null, `travar zera ${k}`);
  const arq = path.join(h3.env.SESSOES_WPP_DIR, 'estado.json');
  e.centralPendentes = [{ pedido: { sessionId: 'CS', texto: 'oi', providerMsgId: 'PROVX', messageId: 'uuid-x' }, desde: iso(h3.t), porque: 'esperando' }];
  fs.writeFileSync(arq, JSON.stringify(e));
  h3.pipes.add('claude-cs');
  const antes = h3.enviados.length;
  r = await soltarCentral(h3);
  assert.deepEqual(r, { pendentes: 0, soltas: 0, expiradas: 0 }, 'travado esvazia');
  assert.equal(h3.entregas.length, 0);
  assert.equal(h3.enviados.length, antes);
  assert.deepEqual(estado(h3).centralPendentes, []);
});

test('T7a1a 29. 2 centrais pelo nome (a de nome de arquivo menor sem canal) -> a fala vai pra que tem canal; o "por" da sem canal nao vale; -n > nome de arquivo; ai-title igual nao vira central', async () => {
  const h = montarPipes();
  centralSemCanal(h); // 100001.json: a 1a pelo nome do arquivo
  centralComCanal(h); // 100002.json
  abaComPipe(h, 'S1', 'Faro');
  const f = msg(h, { content: 'bom dia' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 1);
  assert.equal(h.entregas[0].sessionId, 'CC', 'a que recebe');
  assert.equal(h.enviados.length, 0);
  assert.equal(estado(h).centralPendentes.length, 0, 'tem central que recebe: nada estaciona');
  await h.p.passoMinuto();
  assert.equal(h.aberturas, 0);
  // encaminhar: o `por` so vale da central que recebe
  h.t += 1000;
  evento(h, { v: 1, tipo: 'encaminhar', at: iso(h.t), para: 'S1', providerMsgId: f.provider_msg_id, por: 'CS' });
  await h.p.passoEventos();
  assert.equal(h.entregas.length, 1, 'por da central sem canal: ignorado');
  assert.equal(logT7(h, /encaminhar ignorado: nao veio da central viva \(por CS, central CC\)/).length, 1);
  h.t += 1000;
  evento(h, { v: 1, tipo: 'encaminhar', at: iso(h.t), para: 'S1', providerMsgId: f.provider_msg_id, por: 'CC' });
  await h.p.passoEventos();
  assert.equal(h.entregas.length, 2, 'por da que recebe: vale');
  assert.equal(h.entregas[1].sessionId, 'S1');
  assert.equal(h.entregas[1].encaminhado, true);

  // as 2 com canal: a cli com o name do -n e nameSource user vence a 1a pelo nome do arquivo (aba renomeada)
  const h2 = montarPipes();
  abaComPipe(h2, 'SV', 'Central de sessões de teste'); // 100001.json, claude-vscode com custom-title
  centralComCanal(h2); // 100002.json
  msg(h2, { content: 'oi' });
  await h2.p.passoGrupo();
  assert.equal(h2.entregas.length, 1);
  assert.equal(h2.entregas[0].sessionId, 'CC', 'a do -n');

  // aba claude-vscode so com o ai-title igual ao da central: nao e central
  const h3 = montarPipes();
  abaComPipe(h3, 'S1', 'Faro');
  regPipe(h3, { sessionId: 'AI', pipe: 'claude-ai', name: 'repos-77' });
  transcript(h3, 'AI', [aiTitle('Central de sessões de teste')]);
  msg(h3, { content: 'oi' });
  await h3.p.passoGrupo();
  assert.equal(h3.entregas.length, 0, 'ai-title nunca vale como central');
  assert.deepEqual(h3.enviados.map((m) => m.texto), [SEM_CENTRAL_T7]);
});

test('T7a1a 35. F7: o roteiro inteiro com e sem listarPipes (todas com canal) -> grupo, reacoes e entregas identicos; "status" byte a byte', async () => {
  const roteiro = async (h) => {
    abaComPipe(h, 'S1', 'Faro');
    centralComCanal(h);
    await h.p.passoMinuto();
    await ligarRua(h);
    // aviso de uma aba + citacao
    evento(h, parou(h, 'S1', { final: 'Pronto.\n\n---\n🔴 **DECISAO:** publico agora?', marcas: { decisao: true, fica: false, pergunta: true } }));
    await h.p.passoEventos();
    h.t += 5000;
    msg(h, { content: 'publica', quoted_msg_id: 'P1' });
    await h.p.passoGrupo();
    h.t += 5000;
    msg(h, { content: 'Faro: e o changelog' });
    await h.p.passoGrupo();
    h.t += 5000;
    const solta = msg(h, { content: 'bom dia' });
    await h.p.passoGrupo();
    for (const c of ['status', 'pendências', 'abre central']) {
      h.t += 5000;
      msg(h, { content: c });
      await h.p.passoGrupo();
    }
    h.t += 5000;
    evento(h, { v: 1, tipo: 'encaminhar', at: iso(h.t), para: 'S1', providerMsgId: solta.provider_msg_id, por: 'CC' });
    await h.p.passoEventos();
    h.t += 5000;
    msg(h, { message_type: 'image', content: null });
    await h.p.passoGrupo();
    h.t += 3 * MIN + 1000;
    await h.p.passoGrupo();
    await h.p.passoMinuto();
    if (typeof h.cru.passoCentral === 'function') await soltarCentral(h);
    return h;
  };
  const sem = await roteiro(montar());
  const com = await roteiro(montarPipes());
  assert.ok(com.listagens >= 1, 'com listarPipes: os pipes foram consultados');
  const passou = (h, sid, re) => h.entregas.some((p) => p.sessionId === sid && re.test(p.texto));
  for (const h of [sem, com]) {
    assert.ok(passou(h, 'S1', /^publica$/) && passou(h, 'S1', /changelog/), 'citacao e Nome: pra aba');
    assert.ok(passou(h, 'CC', /^bom dia$/) && passou(h, 'CC', /mandou image sem texto/), 'fala solta e midia pra central');
    assert.ok(h.entregas.some((p) => p.sessionId === 'S1' && p.encaminhado === true), 'encaminhar');
  }
  assert.deepEqual(com.enviados, sem.enviados, 'grupo identico');
  assert.deepEqual(com.reacoes, sem.reacoes, 'reacoes identicas');
  assert.deepEqual(com.entregas, sem.entregas, 'entregas identicas');
  assert.equal(com.aberturas, sem.aberturas);
  assert.equal(com.aberturas, 0);
  const status = (h) => h.enviados.find((m) => /^🎛️ \*Controle de sessões\*\n- /.test(m.texto))?.texto;
  assert.ok(status(sem), 'o status saiu');
  assert.equal(status(com), status(sem), '"status" byte a byte');
  assert.equal(estado(com).centralPendentes.length, 0);
});

// ---------- T7a1b: fechar a central travada com as guardas e abrir outra (PLANO-T7.md, "T7a1"; testes 27 e 32) ----------
// Dubles: `processos` ({info, matarArvore}, SINCRONOS, contando chamadas; o real NUNCA roda em teste), `pidVivo` (vivo =
// process.pid ou um pid de h.vivos), `dormir` sem espera de verdade (conta as esperas da conferencia da morte) e o
// `listarPipes` da T7a1a. A central travada tem pid proprio (PID_CS): morre sozinha no duble, sem levar as outras abas.
const PID_CS = 424242;
// A3a: `o.central` = a central do porteiro (padrao: a do teste; null = a do produto).
function montarT7b(o = {}) {
  const h = montar({ ensaio: o.ensaio === true, ...(o.central !== undefined ? { central: o.central } : {}) });
  h.pipes = new Set();
  h.pipesNull = false;
  h.listagens = 0;
  h.ganhaNaListagem = null; // n = a n-esima listagem ja traz o pipe da travada (ganhou o canal no meio)
  h.listarPipes = () => {
    h.listagens += 1;
    if (h.ganhaNaListagem === h.listagens) h.pipes.add('claude-cs');
    if (typeof h.aoListar === 'function') h.aoListar(h.listagens); // mexer no disco no meio do passoMinuto
    return h.pipesNull ? null : new Set(h.pipes);
  };
  h.vivos = new Set();
  h.infos = new Map(); // pid -> {nome, paiPid, criadoEm} | 'lanca'
  h.infoChamadas = [];
  h.mortes = [];
  h.matarDevolve = true;
  h.morreAoMatar = true;
  h.esperas = 0;
  h.pidVivo = (pid) => Number(pid) === process.pid || h.vivos.has(Number(pid));
  h.processos = {
    info(pid) {
      h.infoChamadas.push(pid);
      const i = h.infos.get(pid);
      if (i === 'lanca') throw new Error('consulta falhou');
      return i ?? null;
    },
    matarArvore(pid) {
      h.mortes.push(pid);
      if (h.matarDevolve === true && h.morreAoMatar) h.vivos.delete(pid);
      return h.matarDevolve;
    },
  };
  h.cru = criarPorteiro({
    wpp: h.wpp, numeroDono: NUMERO_DONO, mensageiro: h.mensageiro, ocioso: async () => h.idle, agora: () => h.t, env: h.env, abrirCentral: h.abrirCentral,
    ensaio: o.ensaio === true, listarPipes: h.listarPipes, pidVivo: h.pidVivo, dormir: async () => { h.esperas += 1; },
    ...(o.semProcessos ? {} : { processos: h.processos }), central: h.central, raizesSessao: h.raizes,
  });
  h.p = comBomba(h.cru);
  return h;
}
// A central travada: registro do abrir-central.vbs (cli, name do -n, nameSource user, cwd C:\projetos) sem canal ha 3 min,
// pid PID_CS vivo e o `info` batendo (claude.exe, criacao = procStart). `o` muda o registro; `info` muda a resposta do
// duble (`difMs` desloca a criacao).
function travada(h, o = {}, info = {}) {
  const { pid = PID_CS, idadeMs = 3 * MIN, ...resto } = o;
  const reg = centralSemCanal(h, { pid, idadeMs, ...resto });
  const { difMs = 0, ...outro } = info;
  h.vivos.add(pid);
  h.infos.set(pid, { nome: 'claude.exe', paiPid: 4321, criadoEm: h.t - idadeMs + difMs, ...outro });
  return reg;
}
const naoMataT7 = (h, motivo) => logT7(h, new RegExp(`central sem canal de recado \\(pid ${PID_CS}\\): nao mata \\(${motivo}`));
const fechouT7 = (h) => logT7(h, new RegExp(`central sem canal de recado \\(pid ${PID_CS}\\): fechada; abrindo outra`));
const tituloCentral = (h, sid) => transcript(h, sid, [custom('Central de sessões de teste')]);

test('T7a1b 27. central sem canal ha 3 min + outra aba com canal + fala solta (PC em uso) -> estaciona; fechada e aberta outra; a nova recebe a fala 1 vez com o sessionId novo; nenhuma frase; "status" byte a byte', async () => {
  const h = montarT7b();
  abaComPipe(h, 'S1', 'Faro');
  travada(h);
  const arquivos = fs.readdirSync(h.env.CLAUDE_SESSIONS_DIR).sort();
  h.idle = 0; // PC em uso
  const f = msg(h, { content: 'bom dia' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 0, 'nenhuma entrega pra central travada');
  assert.equal(h.enviados.length, 0, 'nenhuma frase');
  assert.deepEqual(h.reacoes, []);
  assert.equal(estado(h).centralPendentes.length, 1, '1 pendente');
  assert.deepEqual(h.mortes, [], 'o passoGrupo nunca mata');
  assert.equal(h.aberturas, 0);

  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, [PID_CS], 'a travada e fechada');
  assert.deepEqual(h.infoChamadas, [PID_CS], 'o processo conferido antes de matar');
  assert.equal(h.aberturas, 1, 'e uma nova e aberta');
  assert.equal(fechouT7(h).length, 1);
  let e = estado(h);
  assert.deepEqual(e.centralReabrindo, { desde: iso(h.t), de: 'CS' });
  assert.equal(e.centralSozinho, 1, 'a reabertura conta no teto');
  assert.equal(e.centralPendentes.length, 1, 'a fala segue esperando a nova');
  assert.deepEqual(fs.readdirSync(h.env.CLAUDE_SESSIONS_DIR).sort(), arquivos, 'nada apagado em sessions');
  assert.equal(h.entregas.length, 0);
  assert.equal(h.enviados.length, 0);

  // a nova ainda nao subiu: a fala espera calada; fala nova nesse meio estaciona (3o degrau do alvoCentral)
  let r = await soltarCentral(h);
  assert.deepEqual(r, { pendentes: 1, soltas: 0, expiradas: 0 });
  h.t += 5000;
  const f2 = msg(h, { content: 'e o resto' });
  await h.p.passoGrupo();
  assert.equal(h.enviados.length, 0, 'reabrindo: sem semCentral');
  assert.equal(estado(h).centralPendentes.length, 2);
  h.t += MIN;
  await h.p.passoMinuto();
  assert.equal(h.aberturas, 1, 'subindo: nao abre outra');
  assert.equal(h.mortes.length, 1);

  // a nova sobe com canal: as 2 falas saem 1 vez cada pra ela, com o sessionId novo (o pedido troca o destino)
  h.t += 30 * 1000;
  centralComCanal(h, { sessionId: 'CN', pipe: 'claude-cn', idadeMs: 40 * 1000 });
  r = await soltarCentral(h);
  assert.deepEqual(r, { pendentes: 0, soltas: 2, expiradas: 0 });
  assert.deepEqual(h.entregas.map((p) => [p.sessionId, p.texto, p.providerMsgId]),
    [['CN', 'bom dia', f.provider_msg_id], ['CN', 'e o resto', f2.provider_msg_id]], 'a nova recebe, sessionId novo');
  assert.equal(logT7(h, /fala pra central passada de novo pra CN \(era CS\)/).length, 2);
  assert.deepEqual(h.reacoes, [{ messageId: f.id, emoji: '✅' }, { messageId: f2.id, emoji: '✅' }]);
  assert.equal(h.enviados.length, 0, 'nenhuma frase no grupo');
  r = await soltarCentral(h);
  assert.deepEqual(r, { pendentes: 0, soltas: 0, expiradas: 0 });
  h.t += MIN;
  await h.p.passoMinuto();
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 2, '1 vez so');
  assert.equal(h.mortes.length, 1);
  assert.equal(h.aberturas, 1);
  assert.equal(estado(h).centralSozinho, 0, 'a nova recebe: o teto zera');

  // "status" byte a byte: igual ao de quem so tem a aba e a central nova (a fechada nao aparece)
  h.t += 5000;
  msg(h, { content: 'status' });
  await h.p.passoGrupo();
  const b = montar();
  b.t = h.t;
  abaComPipe(b, 'S1', 'Faro');
  centralComCanal(b, { sessionId: 'CN', pipe: 'claude-cn' });
  msg(b, { content: 'status' });
  await b.p.passoGrupo();
  assert.equal(h.enviados.length, 1);
  assert.equal(b.enviados.length, 1);
  assert.equal(h.enviados[0].texto, b.enviados[0].texto, '"status" byte a byte');

  // fala que ja esperava antes de a central travar: a reabertura segura o centralNaoAbriu enquanto vale (3 min)
  const h2 = montarT7b();
  abaComPipe(h2, 'S1', 'Faro');
  travada(h2, { idadeMs: 30 * 1000 });
  msg(h2, { content: 'oi' });
  await h2.p.passoGrupo();
  await h2.p.passoMinuto();
  assert.deepEqual(h2.mortes, [], 'ainda subindo: nao mata');
  h2.t += 2 * MIN; // central com 2,5 min (travada), a fala com 2 min
  await h2.p.passoMinuto();
  assert.deepEqual(h2.mortes, [PID_CS]);
  assert.equal(h2.aberturas, 1);
  h2.t += 2 * MIN; // a fala com 4 min, a reabertura com 2 min
  r = await soltarCentral(h2);
  assert.deepEqual(r, { pendentes: 1, soltas: 0, expiradas: 0 }, 'reabrindo: nao avisa');
  assert.equal(h2.enviados.length, 0);
  h2.t += MIN + 1000; // a reabertura passou de 3 min sem a nova: a frase que ja existe, 1 vez
  r = await soltarCentral(h2);
  assert.deepEqual(r, { pendentes: 0, soltas: 0, expiradas: 1 });
  assert.deepEqual(h2.enviados.map((m) => m.texto), [NAO_ABRIU_T7]);
});

// Cenario das guardas: S1 com canal + a central travada (`reg`/`info` mudam a fixture) + 1 fala estacionada (PC em uso,
// `fala: false` = sem fala) e o passoMinuto. `antes(h)` roda antes da fala; `antesDoMinuto(h)` logo antes do passoMinuto.
async function guardaT7(o = {}) {
  const h = montarT7b(o);
  abaComPipe(h, 'S1', 'Faro');
  travada(h, o.reg, o.info);
  if (o.antes) o.antes(h);
  h.idle = o.idle ?? 0;
  if (o.fala !== false) {
    msg(h, { content: 'bom dia' });
    await h.p.passoGrupo();
  }
  if (o.antesDoMinuto) o.antesDoMinuto(h);
  await h.p.passoMinuto();
  return h;
}
function mudarEstado(h, fn) {
  const arq = path.join(h.env.SESSOES_WPP_DIR, 'estado.json');
  const e = JSON.parse(fs.readFileSync(arq, 'utf8'));
  fn(e);
  fs.writeFileSync(arq, JSON.stringify(e));
}

test('T7a1b 32. guardas do fechar a central travada: cada uma com 0 matarArvore (busy, PC em uso sem fala, ensaio, travado, sem processos, aba do VS Code, name/nameSource/cwd, pid reusado, info que lanca, matar false, pid vivo depois de 2 s, ganhou o canal, teto de 3)', async () => {
  // controle: o cenario base fecha e abre (cada guarda abaixo muda 1 coisa)
  let h = await guardaT7();
  assert.deepEqual(h.mortes, [PID_CS], 'controle: fecha');
  assert.equal(h.aberturas, 1, 'controle: abre');
  assert.equal(h.esperas, 0, 'morreu na hora: nenhuma espera');

  // busy (sem forcar) = espera
  h = await guardaT7({ reg: { status: 'busy' } });
  assert.deepEqual(h.mortes, [], 'busy');
  assert.equal(h.aberturas, 0);
  assert.equal(naoMataT7(h, 'ocupada').length, 1);
  assert.equal(estado(h).centralPendentes.length, 1, 'a fala segue esperando');

  // PC em uso sem fala: a checagem periodica nao fecha (nem consulta o processo)
  h = await guardaT7({ fala: false, reg: { idadeMs: 15 * MIN } });
  assert.deepEqual(h.mortes, [], 'PC em uso sem fala');
  assert.deepEqual(h.infoChamadas, []);
  assert.equal(h.aberturas, 0);
  // sem fala, PC parado ha 1 min e sem canal ha 10 min = fecha; ha 3 min = ainda nao (portao de 10 min sem fala)
  h = await guardaT7({ fala: false, reg: { idadeMs: 15 * MIN }, idle: MIN });
  assert.deepEqual(h.mortes, [PID_CS], 'sem fala, PC parado: fecha');
  assert.equal(h.aberturas, 1);
  h = await guardaT7({ fala: false, idle: 5 * MIN });
  assert.deepEqual(h.mortes, [], 'sem fala, 3 min sem canal: espera os 10 min');
  assert.equal(h.aberturas, 0);

  // ensaio nunca mata (nem abre)
  h = await guardaT7({ ensaio: true, fala: false, reg: { idadeMs: 15 * MIN }, idle: 5 * MIN });
  assert.deepEqual(h.mortes, [], 'ensaio');
  assert.equal(h.aberturas, 0);
  assert.equal(naoMataT7(h, 'ensaio').length, 1);

  // travado: nada mata nem abre
  h = montarT7b();
  abaComPipe(h, 'S1', 'Faro');
  travada(h, { idadeMs: 15 * MIN });
  h.idle = 5 * MIN;
  msg(h, { content: 'trava' });
  await h.p.passoGrupo();
  assert.equal(estado(h).trava, true);
  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, [], 'travado');
  assert.deepEqual(h.infoChamadas, []);
  assert.equal(h.aberturas, 0);

  // sem `processos`: nao mata nem abre
  h = await guardaT7({ semProcessos: true });
  assert.deepEqual(h.mortes, [], 'sem processos');
  assert.equal(h.aberturas, 0);
  assert.equal(naoMataT7(h, 'sem como conferir o processo').length, 1);

  // identidade do registro: aba do VS Code com o custom-title da central; name, nameSource ou cwd diferentes
  const identidade = {
    'aba do VS Code (claude-vscode) com o custom-title da central': {
      reg: { entrypoint: 'claude-vscode', name: 'projetos-42', nameSource: 'derived' }, antes: (x) => tituloCentral(x, 'CS'),
    },
    'name diferente do -n (mesmo titulo normalizado)': { reg: { name: 'Central de sessões de teste' } },
    'nameSource diferente': { reg: { nameSource: 'derived' }, antes: (x) => tituloCentral(x, 'CS') },
    'cwd fora da pasta da central (C:\\projetos)': { reg: { cwd: 'C:\\projetos\\sessoes-wpp' } },
    'aba do VS Code com o name exato do -n (nameSource user, cwd C:\\projetos)': { reg: { entrypoint: 'claude-vscode' } },
  };
  for (const [nome, o] of Object.entries(identidade)) {
    h = await guardaT7(o);
    assert.equal(estado(h).centralPendentes.length, 1, `${nome}: e a central (a fala estacionou)`);
    assert.deepEqual(h.mortes, [], nome);
    assert.deepEqual(h.infoChamadas, [], `${nome}: nem consulta o processo`);
    assert.equal(h.aberturas, 0, `${nome}: nao abre`);
    assert.equal(naoMataT7(h, 'registro').length, 1, `${nome}: log`);
    h.t += MIN;
    await h.p.passoMinuto();
    assert.deepEqual(h.mortes, [], `${nome}: 1 min depois tambem nao`);
    assert.equal(naoMataT7(h, 'registro').length, 1, `${nome}: cache de 10 min (sem log de novo)`);
  }

  // pid reusado (info de outro processo, ou criacao diferente): nao mata, abre outra e some das vivas
  const reusado = {
    'outro processo': { info: { nome: 'node.exe' } },
    'criacao 1,5 s longe do procStart': { info: { difMs: 1500 } },
    'sem procStart: criacao 3 min longe do startedAt': { reg: { semProcStart: true }, info: { difMs: 3 * MIN } },
  };
  for (const [nome, o] of Object.entries(reusado)) {
    h = await guardaT7(o);
    assert.deepEqual(h.mortes, [], nome);
    assert.equal(h.aberturas, 1, `${nome}: abre outra`);
    assert.equal(naoMataT7(h, 'pid reusado').length, 1, `${nome}: log`);
    assert.deepEqual(estado(h).centralReabrindo, { desde: iso(h.t), de: 'CS' });
    h.t += 5000;
    msg(h, { content: 'status' });
    await h.p.passoGrupo();
    const st = h.enviados.at(-1).texto;
    assert.match(st, /Faro/);
    assert.doesNotMatch(st, /- Central de sessoes de teste/, `${nome}: some das vivas`);
    h.t += MIN;
    await h.p.passoMinuto();
    assert.equal(h.infoChamadas.length, 1, `${nome}: o cache nao consulta de novo`);
    assert.equal(h.mortes.length, 0);
    assert.equal(h.aberturas, 1, `${nome}: nao abre de novo (a nova esta subindo)`);
  }
  // sem procStart, criacao dentro de 2 min do startedAt = e ela (fecha)
  h = await guardaT7({ reg: { semProcStart: true }, info: { difMs: 90 * 1000 } });
  assert.deepEqual(h.mortes, [PID_CS], 'sem procStart, startedAt +- 2 min: fecha');
  assert.equal(h.aberturas, 1);

  // info que lanca: nao mata, nao abre
  h = await guardaT7({ antes: (x) => x.infos.set(PID_CS, 'lanca') });
  assert.deepEqual(h.mortes, [], 'info que lanca');
  assert.equal(h.aberturas, 0);
  assert.equal(naoMataT7(h, 'consulta do processo falhou').length, 1);

  // matarArvore false = nao abre
  h = await guardaT7({ antes: (x) => { x.matarDevolve = false; } });
  assert.deepEqual(h.mortes, [PID_CS], 'tentou');
  assert.equal(h.aberturas, 0, 'matar false: nao abre');
  assert.equal(naoMataT7(h, 'encerrar falhou').length, 1);

  // pid vivo depois de 2 s = nao abre
  h = await guardaT7({ antes: (x) => { x.morreAoMatar = false; } });
  assert.deepEqual(h.mortes, [PID_CS], 'tentou');
  assert.ok(h.esperas > 0, 'esperou a morte');
  assert.equal(h.aberturas, 0, 'pid vivo: nao abre');
  assert.equal(naoMataT7(h, 'pid vivo depois de 2 s').length, 1);

  // ganhou o canal no meio (a 2a listagem do passoMinuto ja traz o pipe): nao mata; a fala sai pra ela
  h = await guardaT7({ antesDoMinuto: (x) => { x.ganhaNaListagem = x.listagens + 2; } });
  assert.deepEqual(h.mortes, [], 'ganhou o canal');
  assert.deepEqual(h.infoChamadas, []);
  assert.equal(h.aberturas, 0);
  assert.equal(naoMataT7(h, 'ganhou o canal').length, 1);
  const r = await soltarCentral(h);
  assert.deepEqual(r, { pendentes: 0, soltas: 1, expiradas: 0 });
  assert.equal(h.entregas.length, 1);
  assert.equal(h.entregas[0].sessionId, 'CS');

  // o registro muda entre a foto das vivas e o fechar (ficou ocupada logo depois da 1a listagem do passoMinuto): o fechar
  // rele do disco e espera, nunca decide pela foto velha
  h = await guardaT7({
    antesDoMinuto: (x) => {
      const n = x.listagens + 1;
      x.aoListar = (k) => {
        if (k !== n) return;
        const dir = x.env.CLAUDE_SESSIONS_DIR;
        for (const nome of fs.readdirSync(dir)) {
          const a = path.join(dir, nome);
          const reg = JSON.parse(fs.readFileSync(a, 'utf8'));
          if (reg.sessionId === 'CS') fs.writeFileSync(a, JSON.stringify({ ...reg, status: 'busy' }));
        }
      };
    },
  });
  assert.deepEqual(h.mortes, [], 'ficou ocupada no meio: o fechar rele o registro');
  assert.equal(h.aberturas, 0);
  assert.equal(naoMataT7(h, 'ocupada').length, 1);

  // teto de 3 (compartilhado com o abrir sozinho): 3 seguidas = nao mata nem abre; 2 = fecha, abre e conta a 3a
  h = await guardaT7({ antesDoMinuto: (x) => mudarEstado(x, (e) => { e.centralSozinho = 3; }) });
  assert.deepEqual(h.mortes, [], 'teto de 3');
  assert.deepEqual(h.infoChamadas, []);
  assert.equal(h.aberturas, 0);
  h = await guardaT7({ antesDoMinuto: (x) => mudarEstado(x, (e) => { e.centralSozinho = 2; }) });
  assert.deepEqual(h.mortes, [PID_CS]);
  assert.equal(h.aberturas, 1);
  assert.equal(estado(h).centralSozinho, 3, 'a reabertura conta');
});

// ---------- T7a1c: NAO_ACHEI reativo, "abre central" com a travada e as pontas (PLANO-T7.md, "T7a1"; testes 30, 33 e 34) ----------
// Dubles da T7a1b (montarT7b: listarPipes, processos, pidVivo) + `naoAcheiPara`: o mensageiro devolve nao_achei pras abas
// da lista (a central parecia boa: tem o canal de recado, mas o recado nao chegou nela).
function naoAcheiPara(h, sids) {
  const orig = h.mensageiro.entregar;
  h.naoAchei = new Set(sids);
  h.mensageiro.entregar = async (p) => {
    if (!h.naoAchei.has(p.sessionId)) return orig(p);
    h.entregas.push(p);
    return { status: 'nao_achei', detalhe: '' };
  };
}
// O mesmo porteiro de novo sobre o mesmo estado e os mesmos dubles (o porteiro religado).
function religarT7b(h) {
  h.cru = criarPorteiro({
    wpp: h.wpp, numeroDono: NUMERO_DONO, mensageiro: h.mensageiro, ocioso: async () => h.idle, agora: () => h.t, env: h.env, abrirCentral: h.abrirCentral,
    ensaio: false, listarPipes: h.listarPipes, pidVivo: h.pidVivo, dormir: async () => { h.esperas += 1; }, processos: h.processos,
    central: h.central, raizesSessao: h.raizes,
  });
  h.p = comBomba(h.cru);
}
const NAO_ACHEI_CONTROLE = /Não achei a sessão Controle/i;
const semNaoAcheiControle = (h, rotulo) => {
  for (const m of h.enviados) assert.doesNotMatch(m.texto, NAO_ACHEI_CONTROLE, `${rotulo}: nenhum naoAchei da central no grupo`);
};
// A central que parece boa (registro do abrir-central.vbs COM o canal), pid PID_CS vivo e o info batendo.
const centralQueNaoRecebe = (h, o = {}) => travada(h, { comCanal: true, idadeMs: 10 * MIN, ...o });
const CENTRAL_FALHOU_T7 = `${CAB}\nNão consegui abrir a central no PC.`;

test('T7a1c 30. reativo no WhatsApp: nao_achei da central -> nenhum naoAchei; 1 kill + 1 abertura; a MESMA fala vai 1 vez pra nova com deNovo; reacao e resposta no grupo, sem frase nova; a nova tambem nao_achei -> centralNaoAbriu 1 vez e nenhuma 3a entrega', async () => {
  const h = montarT7b();
  abaComPipe(h, 'S1', 'Faro');
  centralQueNaoRecebe(h);
  naoAcheiPara(h, ['CS']);
  h.idle = 0; // PC em uso
  const f = msg(h, { content: 'bom dia' });
  const f2 = msg(h, { content: 'e o resto' });
  await h.p.passoGrupo();
  assert.deepEqual(h.entregas.map((p) => [p.sessionId, p.texto]), [['CS', 'bom dia']], '1 entrega; a 2a fala nao vai pra ela');
  assert.equal(h.enviados.length, 0, 'nenhum naoAchei, nenhuma frase');
  assert.deepEqual(h.reacoes, []);
  let e = estado(h);
  assert.deepEqual(e.centralSemRecado, { sessionId: 'CS', desde: iso(h.t) }, 'a central marcada sem recado');
  assert.deepEqual(e.centralPendentes.map((x) => [x.pedido.sessionId, x.pedido.texto, x.pedido.providerMsgId, x.porque]),
    [['CS', 'bom dia', f.provider_msg_id, 'nao_achei'], ['CS', 'e o resto', f2.provider_msg_id, 'esperando']],
    'estaciona e leva o outro item da mesma aba');
  assert.equal(e.centralPendentes[0].pedido.deNovo, true);
  assert.equal(e.centralPendentes[0].pedido.centralVelha, 'CS');
  assert.equal(e.centralPendentes[1].pedido.deNovo, undefined, 'o que nao foi tentado nao e "de novo"');
  assert.deepEqual(e.filaEntrega, []);
  assert.equal(logT7(h, /fala pra central estacionada \(nao_achei\): espera a central que recebe/).length, 1);
  assert.deepEqual(h.mortes, [], 'o passoGrupo nunca mata');
  assert.equal(h.aberturas, 0);

  // passoMinuto: a marcada com fala esperando = travada: fecha com as guardas e abre outra
  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, [PID_CS], '1 kill');
  assert.equal(h.aberturas, 1, '1 abertura');
  assert.equal(fechouT7(h).length, 1);
  assert.deepEqual(estado(h).centralReabrindo, { desde: iso(h.t), de: 'CS' });
  assert.equal(h.enviados.length, 0);

  // a nova sobe com canal: a MESMA fala vai 1 vez pra ela, com deNovo; a outra tambem; reacao em cada uma
  h.t += 30 * 1000;
  centralComCanal(h, { sessionId: 'CN', pipe: 'claude-cn', idadeMs: 20 * 1000 });
  let r = await soltarCentral(h);
  assert.deepEqual(r, { pendentes: 0, soltas: 2, expiradas: 0 });
  assert.deepEqual(h.entregas.slice(1).map((p) => [p.sessionId, p.texto, p.providerMsgId]),
    [['CN', 'bom dia', f.provider_msg_id], ['CN', 'e o resto', f2.provider_msg_id]], 'a mesma fala, sessionId novo');
  assert.equal(h.entregas[1].deNovo, true, 'com deNovo');
  assert.equal(h.entregas[1].centralVelha, 'CS');
  assert.equal(logT7(h, /fala pra central passada de novo pra CN \(era CS\)/).length, 2);
  assert.deepEqual(h.reacoes, [{ messageId: f.id, emoji: '✅' }, { messageId: f2.id, emoji: '✅' }], 'a reacao de confirmacao');
  assert.equal(h.enviados.length, 0, 'nenhuma frase nova no grupo');

  // a resposta da nova vai pro grupo (e so ela)
  transcript(h, 'CN', [peer(h.entregas[1], false, iso(h.t + 1000)), peer(h.entregas[2], false, iso(h.t + 2000))]);
  h.t += MIN;
  const resp = parou(h, 'CN', { nome: NOME_DO_N, final: `${linha('16:00', 'bom dia')}\n${linha('16:00', 'e o resto')}\n\nBom dia! Tudo certo.` });
  evento(h, resp);
  await h.p.passoEventos();
  assert.equal(h.enviados.length, 1, 'so a resposta');
  assert.match(h.enviados[0].texto, /Bom dia! Tudo certo\./);
  for (let i = 0; i < 3; i++) {
    h.t += MIN;
    await h.p.passoMinuto();
    await soltarCentral(h);
    await h.p.passoGrupo();
  }
  assert.equal(h.entregas.length, 3, '1 vez so pra nova');
  assert.equal(h.mortes.length, 1);
  assert.equal(h.aberturas, 1);
  assert.equal(h.enviados.length, 1);
  semNaoAcheiControle(h, 'reativo');

  // a nova tambem devolve nao_achei (deNovo): centralNaoAbriu 1 vez pelo grupo, nenhuma 3a entrega, nada estaciona de novo
  const k = montarT7b();
  abaComPipe(k, 'S1', 'Faro');
  centralQueNaoRecebe(k);
  naoAcheiPara(k, ['CS', 'CN']);
  k.idle = 0;
  msg(k, { content: 'bom dia' });
  await k.p.passoGrupo();
  await k.p.passoMinuto();
  assert.deepEqual(k.mortes, [PID_CS]);
  k.t += 30 * 1000;
  centralComCanal(k, { sessionId: 'CN', pipe: 'claude-cn', idadeMs: 20 * 1000 });
  r = await soltarCentral(k);
  assert.deepEqual(r, { pendentes: 0, soltas: 1, expiradas: 0 });
  assert.deepEqual(k.entregas.map((p) => p.sessionId), ['CS', 'CN'], '2 entregas');
  assert.deepEqual(k.enviados.map((m) => m.texto), [NAO_ABRIU_T7], 'centralNaoAbriu 1 vez (a frase que ja existe)');
  assert.deepEqual(k.reacoes, []);
  assert.deepEqual(estado(k).centralPendentes, [], 'nada estacionado de novo');
  for (let i = 0; i < 4; i++) {
    k.t += MIN;
    await k.p.passoMinuto();
    await soltarCentral(k);
    await k.p.passoGrupo();
  }
  assert.equal(k.entregas.length, 2, 'nenhuma 3a entrega');
  assert.equal(k.enviados.length, 1, 'a frase 1 vez so');
  assert.equal(k.mortes.length, 1);
  assert.equal(k.aberturas, 1);
  semNaoAcheiControle(k, 'NAO_ACHEI 2x');
});

test('T7a1c 33. "abre central" com a travada ocupada -> mata, zera o teto, "Abrindo" e a vigia so termina com a que recebe; subindo sem canal -> "Abrindo" sem abrir outra; com canal -> "ja esta aberta"', async () => {
  // a travada ocupada e o teto cheio: o "abre central" mata mesmo ocupada, zera o teto e abre outra
  const h = montarT7b();
  abaComPipe(h, 'S1', 'Faro');
  travada(h, { status: 'busy' });
  await h.p.passoMinuto(); // PC em uso, sem fala: o passoMinuto nao mexe
  assert.deepEqual(h.mortes, []);
  mudarEstado(h, (e) => { e.centralSozinho = 3; });
  msg(h, { content: 'abre central' });
  await h.p.passoGrupo();
  assert.deepEqual(h.mortes, [PID_CS], 'mata mesmo ocupada');
  assert.equal(h.aberturas, 1, 'abre outra');
  assert.deepEqual(h.enviados.map((m) => m.texto), [ABRINDO_CENTRAL]);
  let e = estado(h);
  assert.equal(e.centralSozinho, 1, 'o teto zera (a reabertura conta 1)');
  assert.deepEqual(e.centralReabrindo, { desde: iso(h.t), de: 'CS' });
  assert.equal(e.centralEsperada?.desde, iso(h.t), 'a vigia espera a nova');
  // a nova sobe SEM canal e fica assim (viva, travada depois de 2 min): a vigia nao termina com ela
  h.t += 30 * 1000;
  centralSemCanal(h, { sessionId: 'CN', pipe: 'claude-cn', idadeMs: 20 * 1000 });
  await h.p.passoMinuto();
  assert.ok(estado(h).centralEsperada, 'a sem canal nao encerra a espera');
  h.t += 2 * MIN; // 2,5 min da abertura
  await h.p.passoMinuto();
  assert.ok(estado(h).centralEsperada, 'ainda no prazo');
  assert.equal(h.enviados.length, 1);
  h.t += MIN; // 3,5 min: nenhuma central que recebe = centralNaoAbriu 1 vez
  await h.p.passoMinuto();
  assert.deepEqual(h.enviados.map((m) => m.texto), [ABRINDO_CENTRAL, NAO_ABRIU_T7]);
  assert.equal(estado(h).centralEsperada, null);
  h.t += MIN;
  await h.p.passoMinuto();
  assert.equal(h.enviados.length, 2, '1 vez so');
  assert.equal(h.aberturas, 1, 'nada abre outra (PC em uso, sem fala)');
  assert.equal(h.mortes.length, 1);

  // a sem canal que ganha o canal = fim da espera, calado
  const h2 = montarT7b();
  abaComPipe(h2, 'S1', 'Faro');
  travada(h2, { status: 'busy' });
  msg(h2, { content: 'abre central' });
  await h2.p.passoGrupo();
  assert.deepEqual(h2.mortes, [PID_CS]);
  h2.t += 30 * 1000;
  centralSemCanal(h2, { sessionId: 'CN', pipe: 'claude-cn', idadeMs: 20 * 1000 });
  await h2.p.passoMinuto();
  assert.ok(estado(h2).centralEsperada, 'sem canal: espera');
  h2.t += MIN;
  h2.pipes.add('claude-cn'); // ganhou o canal
  await h2.p.passoMinuto();
  assert.equal(estado(h2).centralEsperada, null, 'a que recebe encerra a espera');
  h2.t += 3 * MIN;
  await h2.p.passoMinuto();
  assert.deepEqual(h2.enviados.map((m) => m.texto), [ABRINDO_CENTRAL], 'calado');
  assert.equal(h2.aberturas, 1);

  // a travada que nao morre (matar false): nao abre, "nao consegui abrir"
  const h5 = montarT7b();
  abaComPipe(h5, 'S1', 'Faro');
  travada(h5, { status: 'busy' });
  h5.matarDevolve = false;
  msg(h5, { content: 'abre central' });
  await h5.p.passoGrupo();
  assert.deepEqual(h5.mortes, [PID_CS], 'tentou');
  assert.equal(h5.aberturas, 0, 'nunca 2 centrais');
  assert.deepEqual(h5.enviados.map((m) => m.texto), [CENTRAL_FALHOU_T7]);
  assert.equal(estado(h5).centralEsperada, null);

  // subindo sem canal (30 s): "Abrindo" sem abrir outra e sem matar
  const h3 = montarT7b();
  abaComPipe(h3, 'S1', 'Faro');
  travada(h3, { idadeMs: 30 * 1000 });
  msg(h3, { content: 'abre central' });
  await h3.p.passoGrupo();
  assert.deepEqual(h3.enviados.map((m) => m.texto), [ABRINDO_CENTRAL]);
  assert.equal(h3.aberturas, 0, 'sem abrir outra');
  assert.deepEqual(h3.mortes, []);
  assert.deepEqual(h3.infoChamadas, []);

  // com canal: "ja esta aberta"; com a travada viva junto, a que recebe vale
  const h4 = montarT7b();
  abaComPipe(h4, 'S1', 'Faro');
  travada(h4, { status: 'busy' });
  centralComCanal(h4, { sessionId: 'CN', pipe: 'claude-cn' });
  msg(h4, { content: 'abre central' });
  await h4.p.passoGrupo();
  assert.deepEqual(h4.enviados.map((m) => m.texto), [CENTRAL_ABERTA]);
  assert.equal(h4.aberturas, 0);
  assert.deepEqual(h4.mortes, []);
});

test('T7a1c 34. pontas: nenhum naoAchei da central; encaminhar e abrir-sessao com o por da travada ignorados; porteiro religado com fala estacionada solta igual; "trava" esvazia; F4h nao conta a travada no mesmoNome', async () => {
  // encaminhar e abrir-sessao com o `por` da travada (so ela viva): ignorados
  const h = montarT7b();
  abaComPipe(h, 'S1', 'Faro');
  travada(h);
  const f = msg(h, { content: 'Faro: oi' });
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 1);
  h.t += 1000;
  evento(h, { v: 1, tipo: 'encaminhar', at: iso(h.t), para: 'S1', providerMsgId: f.provider_msg_id, por: 'CS' });
  await h.p.passoEventos();
  assert.equal(h.entregas.length, 1, 'encaminhar com o por da travada: ignorado');
  assert.equal(logT7(h, /encaminhar ignorado: nao veio da central viva \(por CS, central nenhuma\)/).length, 1);
  h.t += 1000;
  evento(h, { v: 1, tipo: 'abrir-sessao', at: iso(h.t), nome: 'teste-t7', pasta: 'C:\\projetos\\teste-t7', providerMsgId: null, por: 'CS' });
  await h.p.passoEventos();
  assert.equal(logT7(h, /abrir-sessao ignorado: nao veio da central viva \(por CS, central nenhuma\)/).length, 1);
  assert.equal(h.enviados.length, 0);

  // porteiro religado com a fala estacionada (nao_achei): solta igual ao que nao foi religado
  const rodar = async (religar) => {
    const x = montarT7b();
    abaComPipe(x, 'S1', 'Faro');
    centralQueNaoRecebe(x);
    naoAcheiPara(x, ['CS']);
    msg(x, { content: 'bom dia' });
    await x.p.passoGrupo();
    assert.equal(estado(x).centralPendentes.length, 1);
    if (religar) religarT7b(x);
    await x.p.passoMinuto();
    x.t += 30 * 1000;
    centralComCanal(x, { sessionId: 'CN', pipe: 'claude-cn', idadeMs: 20 * 1000 });
    await soltarCentral(x);
    return x;
  };
  const sem = await rodar(false);
  const com = await rodar(true);
  assert.deepEqual(com.entregas.map((p) => [p.sessionId, p.texto, p.providerMsgId, p.deNovo === true]),
    [['CS', 'bom dia', 'PROV1', false], ['CN', 'bom dia', 'PROV1', true]], 'religado: a mesma fala, 1 vez pra nova');
  assert.deepEqual(com.entregas, sem.entregas);
  assert.deepEqual(com.reacoes, sem.reacoes);
  assert.deepEqual(com.enviados, sem.enviados);
  assert.deepEqual(com.mortes, sem.mortes);
  assert.equal(com.aberturas, sem.aberturas);
  semNaoAcheiControle(com, 'religado');

  // "trava" com a fala estacionada pelo nao_achei: esvazia os pendentes e as marcas; nada mata, abre nem entrega
  const t = montarT7b();
  abaComPipe(t, 'S1', 'Faro');
  centralQueNaoRecebe(t);
  naoAcheiPara(t, ['CS']);
  msg(t, { content: 'bom dia' });
  await t.p.passoGrupo();
  assert.equal(estado(t).centralPendentes.length, 1);
  assert.equal(estado(t).centralSemRecado.sessionId, 'CS');
  t.t += 1000;
  msg(t, { content: 'trava' });
  await t.p.passoGrupo();
  let e = estado(t);
  assert.equal(e.trava, true);
  assert.deepEqual(e.centralPendentes, []);
  for (const k of ['centralReabrindo', 'centralSemRecado', 'fraseReabertaDe']) assert.equal(e[k], null, `trava zera ${k}`);
  await t.p.passoMinuto();
  t.pipes.add('claude-cn');
  centralComCanal(t, { sessionId: 'CN', pipe: 'claude-cn' });
  await soltarCentral(t);
  assert.deepEqual(t.mortes, []);
  assert.equal(t.aberturas, 0);
  assert.equal(t.entregas.length, 1);
  semNaoAcheiControle(t, 'trava');

  // F4h: citou o aviso da central que fechou; abertas com o mesmo nome = a travada (sem canal) e a nova: a fala vai pra
  // nova (a travada nao conta), com a mensagem citada
  const g = montarT7b();
  abaComPipe(g, 'S1', 'Faro');
  centralComCanal(g, { sessionId: 'CV', pipe: 'claude-cv', pid: process.pid });
  const arqCV = path.join(g.env.CLAUDE_SESSIONS_DIR, `${100000 + g.nReg}.json`);
  await ligarRua(g);
  evento(g, parou(g, 'CV', { nome: NOME_DO_N, final: 'Pronto.\n\n---\n🔴 **DECISAO:** publico agora?', marcas: { decisao: true, fica: false, pergunta: true } }));
  await g.p.passoEventos();
  assert.equal(g.enviados.length, 1, 'o aviso da central');
  const avisoId = 'P1';
  fs.rmSync(arqCV); // a central fechou
  travada(g);
  centralComCanal(g, { sessionId: 'CN', pipe: 'claude-cn', pid: process.pid });
  g.t += 5000;
  msg(g, { content: 'publica', quoted_msg_id: avisoId });
  await g.p.passoGrupo();
  assert.equal(g.entregas.length, 1);
  assert.equal(g.entregas[0].sessionId, 'CN', 'a travada nao conta no mesmoNome');
  assert.ok(g.entregas[0].citada, 'com a mensagem citada');
  assert.equal(logT7(g, /citou a aba CV, que fechou: vai pra CN, aberta com o mesmo nome/).length, 1);
  semNaoAcheiControle(g, 'F4h');
});

test('T7a1c 33b. "abre central" com a travada: fechou, mas a nova nao abriu (wscript falhou) -> "nao consegui abrir" e sem vigia; aba comum so com o ai-title da central e nao_achei -> naoAchei com o titulo dela, como antes, e nada estaciona', async () => {
  // a travada fechou, mas o abrir falhou: nunca "Abrindo" (o dono esperaria uma central que nao vem)
  const h = montarT7b();
  abaComPipe(h, 'S1', 'Faro');
  travada(h, { status: 'busy' });
  h.abrirFalha = 'wscript sumiu';
  msg(h, { content: 'abre central' });
  await h.p.passoGrupo();
  assert.deepEqual(h.mortes, [PID_CS], 'fechou a travada');
  assert.deepEqual(h.enviados.map((m) => m.texto), [CENTRAL_FALHOU_T7]);
  assert.equal(estado(h).centralEsperada, null, 'sem vigia');

  // aba comum (claude-vscode) so com o ai-title igual ao da central: a fala dela nunca e "da central" (nem pelo titulo
  // resolvido do pedido): nao_achei = a frase de sempre, nada marcado nem estacionado
  const a = montarT7b();
  abaComPipe(a, 'S1', 'Faro');
  regPipe(a, { sessionId: 'AI', pipe: 'claude-ai', name: 'repos-77' });
  transcript(a, 'AI', [aiTitle('Central de sessões de teste')]);
  naoAcheiPara(a, ['AI']);
  msg(a, { content: 'Central de sessões de teste: oi' });
  await a.p.passoGrupo();
  assert.deepEqual(a.entregas.map((p) => p.sessionId), ['AI']);
  assert.deepEqual(a.enviados.map((m) => m.texto), [F.naoAchei('Central de sessões de teste')]);
  const e = estado(a);
  assert.deepEqual(e.centralPendentes, []);
  assert.equal(e.centralSemRecado, null);
});

// ---------- T7e1: ocioso com motivo (PLANO-T7.md, "### T7e1") ----------
// O powershell real nunca roda aqui: `exec` e o duble do execFile (bin, args, opts, cb) e `agora` e um relogio falso.
function execOciosoT7e1(roteiro, chamadas) {
  return (bin, args, opts, cb) => {
    chamadas.push({ bin, args, opts });
    if (roteiro.lanca) throw Object.assign(new Error(roteiro.lanca), roteiro.codigoLanca ? { code: roteiro.codigoLanca } : {});
    setImmediate(() => cb(roteiro.err ?? null, roteiro.stdout ?? '', roteiro.stderr ?? ''));
  };
}
const relogioT7e1 = (...ts) => {
  const fila = [...ts];
  return () => (fila.length > 1 ? fila.shift() : fila[0]);
};

test('T7e1 51. ociosoReal (execFile dublado, nunca o powershell): argumentos e prazo de 20 s de hoje; killed = prazo; code numerico = saida com so a 1a linha do stderr (ate 160); ENOENT = abrir; status=ok idle_ms = numero; lixo = formato; nunca lanca', async () => {
  assert.equal(typeof porteiroMod.ociosoReal, 'function', 'ociosoReal exportado');
  const chamadas = [];
  const rodar = (roteiro, ...ts) =>
    porteiroMod.ociosoReal({ exec: execOciosoT7e1(roteiro, chamadas), agora: relogioT7e1(...(ts.length ? ts : [5000])) });

  // sucesso: o numero, com os argumentos e o prazo do powershell de hoje
  assert.equal(await rodar({ stdout: 'status=ok idle_ms=1234 esperou_ms=3\r\n' }), 1234);
  const c0 = chamadas[0];
  assert.equal(c0.bin, 'powershell');
  assert.deepEqual(c0.args.slice(0, 4), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File']);
  assert.equal(path.basename(c0.args[4]), 'ocioso.ps1');
  assert.equal(path.basename(path.dirname(c0.args[4])), 'bin');
  assert.deepEqual(c0.args.slice(5), ['-MinMs', '0', '-TimeoutMs', '0']);
  assert.equal(c0.args.length, 9);
  assert.equal(c0.opts.timeout, 20000);
  assert.equal(c0.opts.windowsHide, true);

  // prazo (o execFile matou o powershell)
  const morto = Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null });
  assert.deepEqual(await rodar({ err: morto }, 1000, 21012), { falha: { motivo: 'prazo', codigo: null, stderr: '', duracaoMs: 20012 } });

  // saida com codigo (3221225794 = 0xC0000142): so a 1a linha do stderr
  const dll = Object.assign(new Error('Command failed'), { killed: false, code: 3221225794 });
  assert.deepEqual(
    await rodar({ err: dll, stderr: 'A inicializacao da DLL falhou\r\nsegunda linha\r\n' }, 100, 912),
    { falha: { motivo: 'saida', codigo: 3221225794, stderr: 'A inicializacao da DLL falhou', duracaoMs: 812 } },
  );
  // stderr longo: ate 160 caracteres
  const longo = await rodar({ err: Object.assign(new Error('Command failed'), { code: 1 }), stderr: `${'e'.repeat(300)}\nresto` });
  assert.equal(longo.falha.motivo, 'saida');
  assert.equal(longo.falha.codigo, 1);
  assert.equal(longo.falha.stderr, 'e'.repeat(160));

  // abrir (codigo em texto)
  const enoent = Object.assign(new Error('spawn powershell ENOENT'), { code: 'ENOENT', errno: -4058 });
  assert.deepEqual(await rodar({ err: enoent }, 0, 7), { falha: { motivo: 'abrir', codigo: 'ENOENT', stderr: '', duracaoMs: 7 } });

  // formato: sem status=ok ou sem idle_ms
  for (const lixo of ['', 'nada disso\r\n', 'status=timeout idle_ms=5 esperou_ms=0', 'status=ok esperou_ms=3', 'idle_ms=99']) {
    assert.deepEqual(
      await rodar({ stdout: lixo }, 10, 30),
      { falha: { motivo: 'formato', codigo: null, stderr: '', duracaoMs: 20 } },
      `lixo ${JSON.stringify(lixo)}`,
    );
  }

  // nunca lanca: exec que lanca na hora (spawn sincrono)
  const r = await rodar({ lanca: 'spawn EPERM', codigoLanca: 'EPERM' }, 0, 3);
  assert.equal(r.falha.motivo, 'abrir');
  assert.equal(r.falha.codigo, 'EPERM');
  assert.equal(chamadas.length, 11, 'nenhum caso rodou o powershell real (todas pelo duble)');
});

test('T7e1 52. passoMinuto: 31 falhas e depois 0 -> 1 log de inicio (motivo, codigo, ms), 1 "continua" (30) e 1 "voltou" (31); duble null ou que lanca -> "(sem detalhe)"; modo rua igual a hoje', async () => {
  const RE = /porteiro: ocioso (indisponivel|continua indisponivel|voltou)/;
  const linhas = (h) => logT7(h, RE).map((l) => l.replace(/^\S+ porteiro: /, ''));
  const falha = (motivo, codigo, duracaoMs) => ({ falha: { motivo, codigo, stderr: 'linha', duracaoMs } });
  const INICIO = 'ocioso indisponivel (saida 3221225794, 812 ms): modo rua segue como esta';
  const CONTINUA = 'ocioso continua indisponivel: 30 falhas desde 16:01 (ultima: prazo)';
  const VOLTOU = 'ocioso voltou: 31 falha(s) desde 16:01';

  const h = montar();
  await ligarRua(h); // 16:00: modo rua ligado pelo ocioso (30 min parado)
  const antes = estado(h).modoRua;
  for (let i = 1; i <= 31; i++) {
    h.t += MIN; // 1a falha as 16:01 (Brasilia)
    h.idle = i === 30 ? falha('prazo', null, 20004) : falha('saida', 3221225794, 812);
    await h.p.passoMinuto();
    const m = estado(h).modoRua;
    assert.deepEqual({ ...m, atualizadoEm: null }, { ...antes, atualizadoEm: null }, `falha ${i}: o modo rua nao muda`);
    assert.equal(m.atualizadoEm, iso(h.t), `falha ${i}: o minuto ainda e gravado`);
    if (i === 1 || i === 29) assert.deepEqual(linhas(h), [INICIO], `falha ${i}: so o log de inicio`);
    if (i === 30 || i === 31) assert.deepEqual(linhas(h), [INICIO, CONTINUA], `falha ${i}: inicio + continua`);
  }
  h.t += MIN;
  h.idle = 0; // voltou com o dono no PC: desliga o modo rua do ocioso, como hoje
  await h.p.passoMinuto();
  assert.deepEqual(linhas(h), [INICIO, CONTINUA, VOLTOU]);
  assert.equal(estado(h).modoRua.ligado, false);
  assert.equal(logT7(h, /modo rua desligado \(dono no PC\)$/).length, 1);
  h.t += MIN;
  await h.p.passoMinuto();
  assert.equal(linhas(h).length, 3, 'sucesso seguido nao loga nada do ocioso');

  // nova falha depois da volta: novo inicio; modo rua desligado continua desligado
  h.t += MIN; // 16:34
  h.idle = falha('abrir', 'ENOENT', 7);
  await h.p.passoMinuto();
  assert.equal(estado(h).modoRua.ligado, false, 'falha nao liga o modo rua');
  h.t += MIN;
  h.idle = 5000;
  await h.p.passoMinuto();
  assert.deepEqual(linhas(h).slice(3), [
    'ocioso indisponivel (abrir ENOENT, 7 ms): modo rua segue como esta',
    'ocioso voltou: 1 falha(s) desde 16:34',
  ]);

  // duble que devolve null: sem detalhe
  const h2 = montar();
  h2.idle = null;
  await h2.p.passoMinuto();
  h2.t += MIN;
  await h2.p.passoMinuto();
  assert.deepEqual(linhas(h2), ['ocioso indisponivel (sem detalhe): modo rua segue como esta']);
  assert.equal(estado(h2).modoRua.ligado, false);

  // duble que lanca: sem detalhe, o passo nao cai
  const h3 = montar();
  Object.defineProperty(h3, 'idle', { get() { throw new Error('powershell sumiu'); }, configurable: true });
  await h3.p.passoMinuto();
  assert.deepEqual(linhas(h3), ['ocioso indisponivel (sem detalhe): modo rua segue como esta']);
  assert.equal(estado(h3).modoRua.atualizadoEm, iso(h3.t));
});

// ---------------------------------------------------------------------------------------------------------------
// A1. o aviso de saude com o chat do config.json (PLANO-ABERTO.md, "A1 — Telegram pela configuração", teste 9)

test('A1 9. criarAvisoTelegram({chatId: 42}) manda chat_id 42; sem chatId (ou invalido) = false, fetch nunca chamado, 1 linha de log', async () => {
  const rede = [];
  const fetchConta = async (url, init) => {
    rede.push({ url, corpo: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };
  const com = criarAvisoReal({ env: { [VAR_PORTAO]: PORTAO }, fetch: fetchConta, lerRegistro: async () => null, log: () => {}, chatId: 42, varUrl: VAR_PORTAO });
  assert.equal(await com('teste'), true);
  assert.equal(rede.length, 1);
  assert.equal(rede[0].url, `${PORTAO}/sendMessage`);
  assert.deepEqual(rede[0].corpo, { chat_id: 42, text: `${CAB_TG}\nteste`, parse_mode: 'Markdown' });

  for (const extra of [{}, { chatId: undefined }, { chatId: null }, { chatId: 0 }, { chatId: -1 }, { chatId: 1.5 }, { chatId: '42' }]) {
    const linhas = [];
    const sem = criarAvisoReal({
      env: { [VAR_PORTAO]: PORTAO }, fetch: fetchConta, lerRegistro: async () => PORTAO, log: (m) => linhas.push(m), varUrl: VAR_PORTAO, ...extra,
    });
    assert.equal(await sem('x'), false, JSON.stringify(extra));
    assert.equal(await sem('de novo'), false, `${JSON.stringify(extra)}: de novo`);
    assert.deepEqual(linhas, ['aviso no Telegram: sem telegram.chatId no config.json'], `${JSON.stringify(extra)}: 1 linha so`);
  }
  assert.equal(rede.length, 1, 'sem chatId: nenhuma chamada de rede');
});

// ---------------------------------------------------------------------------------------------------------------
// A3a (PLANO-ABERTO.md, "A3a — pastas de projeto, central e o claude"): a central e as pastas de projeto pelo config.
// O porteiro recebe `central` ({pasta, nome}; CLI: identidadeCentral do config) e `raizesSessao` (CLI: sessoesDoConfig);
// sem `central` = o padrao do produto (Central do Tele Control); sem pasta de projeto = nao abre sessao nova.

test('A3a P1. sem `central` (o padrao do produto): a "Central do Tele Control" do terminal recebe a fala solta; a aba com o nome da central do dono e uma aba qualquer', async () => {
  const h = montar({ central: null });
  abaFaro(h);
  sessao(h, { sessionId: 'SE', name: CENTRAL_NOME, nameSource: 'user', entrypoint: 'cli' });
  transcript(h, 'SE', [custom('Central de sessões de teste')]);
  sessao(h, { sessionId: 'SP', name: 'Central do Tele Control', nameSource: 'user', entrypoint: 'cli' });
  transcript(h, 'SP', [aiTitle('Conversa pelo Telegram')]);
  const m = msg(h, { content: 'bom dia' });
  await h.p.passoGrupo();
  assert.deepEqual(h.entregas.map((x) => [x.sessionId, x.texto, x.providerMsgId]), [['SP', 'bom dia', m.provider_msg_id]]);
  // sem a do padrao viva: a do nome antigo nao vira central (a fala solta nao vai pra ela)
  const h2 = montar({ central: null });
  sessao(h2, { sessionId: 'SE', name: CENTRAL_NOME, nameSource: 'user', entrypoint: 'cli' });
  msg(h2, { content: 'bom dia' });
  await h2.p.passoGrupo();
  assert.deepEqual(h2.entregas, [], 'o nome antigo nao e a central');
});

test('A3a P2. a central do config: o nome dado igual ao do config (sem caso e sem acento) recebe a fala solta; o padrao e o nome antigo nao', async () => {
  const MINHA = { pasta: 'D:\\minha-central', nome: 'Minha Central' };
  const h = montar({ central: MINHA });
  abaFaro(h);
  sessao(h, { sessionId: 'SP', name: 'Central do Tele Control', nameSource: 'user', entrypoint: 'cli' });
  sessao(h, { sessionId: 'SE', name: CENTRAL_NOME, nameSource: 'user', entrypoint: 'cli' });
  sessao(h, { sessionId: 'SM', name: 'repos-77', nameSource: 'derived', entrypoint: 'cli' });
  transcript(h, 'SM', [custom('MÍNHA CENTRAL')]);
  msg(h, { content: 'bom dia' });
  await h.p.passoGrupo();
  assert.deepEqual(h.entregas.map((x) => x.sessionId), ['SM']);
  // o -n exato da central do config (cli, nameSource user) tambem
  const h2 = montar({ central: MINHA });
  sessao(h2, { sessionId: 'SN', name: 'Minha Central', nameSource: 'user', entrypoint: 'cli' });
  msg(h2, { content: 'bom dia' });
  await h2.p.passoGrupo();
  assert.deepEqual(h2.entregas.map((x) => x.sessionId), ['SN']);
});

test('A3a P3. fechar a central travada pela pasta e pelo nome do config: com os dois fecha e abre outra (pasta sem caso e com a barra do fim); o cwd na pasta de antes ou o nome de antes nao mata', async () => {
  const MINHA = { pasta: 'D:\\minha-central', nome: 'Minha Central' };
  let h = await guardaT7({ central: MINHA, reg: { name: MINHA.nome, cwd: MINHA.pasta } });
  assert.deepEqual(h.mortes, [PID_CS], 'a do config: fecha');
  assert.equal(h.aberturas, 1, 'a do config: abre outra');
  h = await guardaT7({ central: MINHA, reg: { name: MINHA.nome, cwd: 'd:\\MINHA-CENTRAL\\' } });
  assert.deepEqual(h.mortes, [PID_CS], 'sem caso e com a barra do fim: fecha');
  h = await guardaT7({ central: MINHA, reg: { name: MINHA.nome, cwd: 'C:\\projetos' } });
  assert.deepEqual(h.mortes, [], 'cwd na pasta de antes');
  assert.equal(h.aberturas, 0);
  assert.equal(naoMataT7(h, 'registro: cwd fora da pasta da central').length, 1);
  h = await guardaT7({ central: MINHA, reg: { name: MINHA.nome, cwd: 'D:\\minha-central\\sub' } });
  assert.deepEqual(h.mortes, [], 'subpasta da pasta da central');
  // a do nome de antes nem e a central: a fala solta nao estaciona nela, nada e fechado e, sem central, abre sozinho
  h = await guardaT7({ central: MINHA, reg: { cwd: MINHA.pasta } });
  assert.deepEqual(h.mortes, [], 'o nome de antes');
  assert.equal(estado(h).centralPendentes?.length ?? 0, 0, 'a fala nao estacionou nela');
  assert.equal(linhasDoLog(h, /abrindo a central \(sozinho\)/).length, 1, 'sem central: abre sozinho');
  // sem `central` (o padrao): a central do produto na pasta do repositorio
  const REPO_DO_TESTE = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');
  h = await guardaT7({ central: null, reg: { name: 'Central do Tele Control', cwd: REPO_DO_TESTE } });
  assert.deepEqual(h.mortes, [PID_CS], 'o padrao: fecha');
});

test('A3a P4. sessao nova pelas pastas do config: sem pasta de projeto nao abre ("nenhuma pasta de projeto configurada"); com 3, abre na 3a e a recusa cita as 3', async () => {
  const h = montarSessao({ raizes: () => [] });
  centralCli(h);
  const m = msg(h, { content: FALA_SESSAO });
  abrirSessaoEv(h, { providerMsgId: m.provider_msg_id });
  await h.p.passoEventos();
  assert.deepEqual(h.aberturasSessao, []);
  assert.deepEqual(h.enviados.map((x) => x.texto), [`${CAB}\nNão abri a sessão ${NOME_SESSAO}: nenhuma pasta de projeto configurada.`]);
  const tres = (x) => {
    fs.mkdirSync(path.join(x.raiz, 'projetos', 'app'), { recursive: true });
    return [x.repos, x.workspace, path.join(x.raiz, 'projetos')];
  };
  const h3 = montarSessao({ raizes: tres });
  centralCli(h3);
  const m3 = msg(h3, { content: FALA_SESSAO });
  abrirSessaoEv(h3, { providerMsgId: m3.provider_msg_id, pasta: path.join(h3.raiz, 'projetos', 'app') });
  await h3.p.passoEventos();
  assert.deepEqual(h3.aberturasSessao, [path.join(h3.raiz, 'projetos', 'app')], 'a 3a pasta vale');
  const h4 = montarSessao({ raizes: tres });
  centralCli(h4);
  const m4 = msg(h4, { content: FALA_SESSAO });
  abrirSessaoEv(h4, { providerMsgId: m4.provider_msg_id, pasta: path.join(h4.raiz, 'fora') });
  await h4.p.passoEventos();
  assert.deepEqual(h4.aberturasSessao, []);
  assert.deepEqual(h4.enviados.map((x) => x.texto),
    [`${CAB}\nNão abri a sessão ${NOME_SESSAO}: a pasta não existe ou fica fora de repos, Area e projetos.`]);
});
