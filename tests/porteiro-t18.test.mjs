// Testes da T18b (PLANO-TELEGRAM.md, "T18", contratos 4 e 5; pedido do dono: "toda interação que eu fizer eu use
// a mesma aba que já existia"; OK do dono ao desenho). A T18a retoma a MESMA conversa escondida; aqui ela volta pro
// VS Code: o porteiro fecha so a escondida que ELE retomou (conferida no registro e no processo), parada e sem fala
// esperando, quando a mesma conversa esta viva no VS Code (ele tocou «Open here anyway») ou depois de 30 min parada; e
// com as duas vivas a fala vai pra do VS Code.
// - T18b 1: o sessoesVivas fica com a do VS Code (nas 2 ordens de arquivo) e a fala vai pelo nome dela.
// - T18b 2: a espera da retomada firma tambem com a do VS Code; a escondida que firma fica gravada (e.retomadas).
// - T18b 3 e 4: fecha no 4a (VS Code viva + parada 1 min) e no 4b (parada 30 min), so o pid dela.
// - T18b 5: nao fecha: ocupada, fala esperando, registro ou processo que nao bate, a central, travado, ensaio.
// - T18b 6: estado torto, encerrar que falha (tenta de novo em 10 min) e pid que nao morre.
// T18c (PLANO-TELEGRAM.md, "T18c"; pedido do dono): a escondida parada ha 1 min fecha tambem com o dono no PC (ocioso
// abaixo de 60 s), pelo passoMinuto e pelo passo rapido (passoRetomadas, a cada volta do laco); comando rodando nela
// (bash/sh/powershell/pwsh na arvore: processos.filhos e o leitor descendentesDe) segura nos 3 motivos. O harness deixa o
// dono FORA do PC (ocioso de 5 min, como os testes da T18b supunham); os da T18c poem h.idle = 0.
// Isolamento: como o tests/porteiro-t8.test.mjs (pastas temporarias via SESSOES_WPP_DIR, CLAUDE_SESSIONS_DIR,
// CLAUDE_PROJECTS_DIR e SESSOES_WPP_LOG; dubles de tg, wpp, mensageiro e abridor) + `processos` e `pidVivo` falsos:
// nenhum processo de verdade e consultado ou morto. Registros com o nome de arquivo do Claude Code (`<pid>.json`).
// Rodar: node --test --test-reporter=tap "tests/porteiro-t18.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { criarPorteiro, descendentesDe } from '../porteiro.mjs';
import { criarCanalTelegram } from '../canal-telegram.mjs';
import { NUMERO_DONO } from './lib/dados-whatsapp.mjs';
import { CENTRAL_TESTE } from './lib/dados-central.mjs';

const MIN = 60 * 1000;
const T0 = Date.parse('2026-09-29T15:00:00Z'); // 12:00 em Brasilia
const iso = (ms) => new Date(ms).toISOString();
const DONO = 700100200;
const BOT = 700900800;
const S1 = '5a1f0c2e-1b7d-4c3a-9e2f-0123456789ab'; // a conversa retomada
const S2 = '6b2e1d3f-2c8e-4d4b-8f3a-1234567890cd'; // a copia de um item antigo da T8
const TIT = 'Projeto Atlas';
const FINAL_FIN = '🟢 O material está pronto.\n\n🔴 **DECISÃO:** Mando pro Caio?\nA) Sim / B) Não';
const ESC = 42001; // pid da escondida que o porteiro retomou
const VSC = 41001; // pid da aba do VS Code com a mesma conversa

// ---------- harness (do tests/porteiro-t8.test.mjs) ----------

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

// Porteiro com o Telegram, o abridor escondido de mentira (`h.escondidas`), o mensageiro que devolve "nao_achei" pras
// sessoes de `h.mortas`, e os processos falsos: `h.vivos` (pids vivos pro pidVivo), `h.procs` (pid -> o que o
// processos.info devolve), `h.mortes` (cada matarArvore), `h.matarFalha` (matarArvore devolve false) e `h.naoMorre` (o
// pid segue vivo depois do matarArvore). `ensaio: true` = o porteiro do ensaio (estado-ensaio.json).
// T18c: `h.idle` = o que o ocioso devolve (padrao 5 min: o dono fora do PC) e `h.nOcioso` conta as leituras; o
// processos.filhos devolve `h.arvores` (pid -> nomes dos descendentes; sem entrada = []), grava cada pid em `h.filhosDe`
// e lanca com `h.filhosFalha`.
function montar({ ensaio = false } = {}) {
  const raiz = pastaTemp('porteiro-t18-');
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
    raiz, env, t: T0, idle: 5 * MIN, nOcioso: 0, entregas: [], escondidas: [], mortas: new Set(), nAux: 0, nUpd: 100,
    nMid: 7000, randAux: randFixo(), pasta: path.join(repos, 'sessoes-wpp'),
    vivos: new Set(), procs: new Map(), mortes: [], infos: [], matarFalha: false, naoMorre: false,
    arvores: new Map(), filhosDe: [], filhosFalha: false,
    estadoArq: path.join(env.SESSOES_WPP_DIR, ensaio ? 'estado-ensaio.json' : 'estado.json'),
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
      return { status: h.mortas.has(p.sessionId) ? 'nao_achei' : 'enviado', detalhe: '' };
    },
  };
  h.tg = dubleTg(h);
  const processos = {
    info(pid) {
      h.infos.push(pid);
      return h.procs.get(pid) ?? null;
    },
    matarArvore(pid) {
      h.mortes.push(pid);
      if (h.matarFalha) return false;
      if (!h.naoMorre) h.vivos.delete(pid);
      return true;
    },
    filhos(pid) {
      h.filhosDe.push(pid);
      if (h.filhosFalha) throw new Error('wmi caiu');
      return h.arvores.get(pid) ?? [];
    },
  };
  const ocioso = async () => {
    h.nOcioso += 1;
    return h.idle;
  };
  h.opcoes = {
    wpp, numeroDono: NUMERO_DONO, mensageiro, ocioso, agora: () => h.t, env, abrirCentral: () => {}, rand: randFixo(),
    dormir: async (ms) => { h.t += ms; }, raizesSessao: [repos, workspace], ensaio, tg: h.tg, identTg: { chatId: DONO, botId: BOT },
    abrirSessaoEscondida: async (pasta, nome, retomada) => { h.escondidas.push([pasta, nome, retomada ?? null]); },
    processos, pidVivo: (pid) => h.vivos.has(Number(pid)),
    central: CENTRAL_TESTE, // A3a: a central como o dono configura
  };
  h.cru = criarPorteiro(h.opcoes);
  h.p = comBomba(h.cru);
  h.t += 1000;
  return h;
}

// Registro como o Claude Code grava (`<pid>.json`); o pid entra nos vivos e no processos.info (claude.exe criado na hora
// do startedAt). Escondida = `cli` na pasta da conversa; aba do VS Code = `claude-vscode`, nome derivado.
function registro(h, { pid, entrypoint = 'cli', name = TIT, cwd = h.pasta, status = 'idle', parada = 2 * MIN, ...resto }) {
  const startedAt = h.t - 20 * MIN;
  const reg = {
    pid, sessionId: S1, cwd, entrypoint, kind: 'interactive', name, nameSource: entrypoint === 'cli' ? 'user' : 'derived',
    status, startedAt, updatedAt: h.t, statusUpdatedAt: h.t - parada, ...resto,
  };
  fs.writeFileSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${pid}.json`), JSON.stringify(reg));
  h.vivos.add(pid);
  h.procs.set(pid, { nome: 'claude.exe', paiPid: 1, criadoEm: startedAt });
  return reg;
}
const escondida = (h, o = {}) => registro(h, { pid: ESC, ...o });
const vscode = (h, o = {}) => registro(h, { pid: VSC, entrypoint: 'claude-vscode', name: 'repos-85', cwd: 'c:\\projetos', ...o });

function transcript(h, sessionId, entradas, pasta) {
  const dir = path.join(h.env.CLAUDE_PROJECTS_DIR, pasta);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${sessionId}.jsonl`), entradas.map((x) => `${JSON.stringify(x)}\n`).join(''));
}
// A conversa S1 no disco: o titulo dado e a 1a mensagem com o entrypoint e a pasta (como o Claude Code grava).
function conversa(h) {
  transcript(h, S1, [
    { type: 'custom-title', customTitle: TIT, sessionId: S1 },
    { type: 'user', sessionId: S1, entrypoint: 'claude-vscode', cwd: h.pasta, timestamp: iso(h.t - 60 * MIN), message: { role: 'user', content: 'começa a aula' } },
  ], 'c--projetos-sessoes-wpp');
}
const estado = (h) => JSON.parse(fs.readFileSync(h.estadoArq, 'utf8'));
function mexer(h, fn) {
  const e = fs.existsSync(h.estadoArq) ? JSON.parse(fs.readFileSync(h.estadoArq, 'utf8')) : {};
  fn(e);
  fs.writeFileSync(h.estadoArq, JSON.stringify(e));
}
const logs = (h) => {
  try { return fs.readFileSync(h.env.SESSOES_WPP_LOG, 'utf8').split('\n').filter(Boolean); } catch { return []; }
};
const comLog = (h, trecho) => logs(h).filter((l) => l.includes(trecho)).length;

// Chamado de S1 ja na tela (o aviso de quando ela estava aberta), montado com um canal auxiliar sobre o disco.
async function chamadoNaTela(h) {
  await h.p.passoMinuto(); // o estado nasce no disco
  const e = estado(h);
  const aux = {
    async enviar() { h.nAux += 1; return { ok: true, messageId: 500 + h.nAux, formato: 'rich' }; },
    async editar() { return { ok: true }; },
    async apagar() { return { ok: true }; },
  };
  const canal = criarCanalTelegram({ tg: aux, agora: () => h.t, rand: h.randAux });
  canal.aviso(e, { sessionId: S1, at: iso(h.t), finalTs: iso(h.t), final: FINAL_FIN, nome: 'projetos-42' }, TIT);
  await canal.drenar(e);
  e.tg.offset = 0;
  fs.writeFileSync(h.estadoArq, JSON.stringify(e));
  return e.tg.chamados[S1].mensagem.messageId;
}
// Fala do dono pelo Telegram em cima do chamado, ate o resultado do mensageiro aplicado.
async function falarTg(h, texto, respondeA) {
  h.nUpd += 1;
  h.nMid += 1;
  const m = {
    message_id: h.nMid, date: Math.floor(h.t / 1000), text: texto, reply_to_message: { message_id: respondeA },
    chat: { id: DONO, type: 'private', first_name: 'Davi' }, from: { id: DONO, is_bot: false, first_name: 'Davi' },
  };
  h.tg.lotes.push([{ update_id: h.nUpd, message: m }]);
  await h.p.esperarTelegram(15000);
  await bombear(h.cru);
  return `tg-u${h.nUpd}`;
}
// A entrada da escondida que o porteiro retomou (como a espera grava quando ela firma).
const gravarRetomada = (h, o = {}) => mexer(h, (e) => { e.retomadas = { [S1]: { pid: ESC, desde: iso(h.t - 10 * MIN), ...o } }; });
// T18c: o ocioso que falha como o ociosoReal ({falha}) e o que lanca (o h.idle vira um getter que lanca: o ocioso do
// harness conta a leitura e lanca ao devolver)
const OCIOSO_FALHA = { falha: { motivo: 'prazo', codigo: null, duracaoMs: 20000 } };
const ociosoLanca = (h) => Object.defineProperty(h, 'idle', { get() { throw new Error('ocioso caiu'); }, configurable: true });

// ---------- contrato 5: as duas vivas ----------

// Mac-testes (A): os testes marcados com SO_WINDOWS conferem a premissa do Windows (caminho X:\, .exe, wscript/.vbs,
// cmd.exe, APPDATA/LOCALAPPDATA, pipe \\.\pipe, barra invertida na frase, PowerShell, VS Code/Orca abertos pelo
// porteiro); fora do win32 eles pulam. O caminho do Mac tem os testes proprios em tests/mac-*.test.mjs.
const SO_WINDOWS = process.platform !== 'win32' && 'premissa do Windows (o Mac tem os tests/mac-*)';

test('T18b 1. o mesmo sessionId vivo na escondida e no VS Code: o sessoesVivas fica com a do VS Code (nas 2 ordens de arquivo) e a fala vai pelo nome dela', async () => {
  for (const [quem, pids] of [['escondida antes no disco', [ESC, 52001]], ['VS Code antes no disco', [ESC, 32001]]]) {
    const h = montar();
    conversa(h);
    const tela = await chamadoNaTela(h);
    escondida(h, { pid: pids[0] });
    vscode(h, { pid: pids[1] });
    const id = await falarTg(h, 'sim, manda', tela);
    assert.deepEqual(h.entregas.map((p) => [p.sessionId, p.nome, p.providerMsgId]), [[S1, 'repos-85', id]], quem);
    assert.deepEqual(h.escondidas, [], quem);
  }
});

test('T18b 2. a espera da retomada firma tambem com a viva do VS Code (qualquer pasta) e a fala vai pra ela; a escondida que firma fica gravada (pid do registro cli), com as duas vivas tambem; cli noutra pasta ou morta nunca; o item antigo da T8 so com a cli', async () => {
  const cena = async () => {
    const h = montar();
    conversa(h);
    const tela = await chamadoNaTela(h);
    h.mortas.add(S1);
    const id = await falarTg(h, 'sim', tela);
    assert.equal(h.escondidas.length, 1);
    assert.equal(estado(h).reaberturas.length, 1);
    h.mortas.delete(S1);
    return { h, id };
  };
  const firmar = async (h) => {
    await h.p.passoSessoes();
    h.t += 10 * 1000;
    await h.p.passoSessoes();
  };

  // so a do VS Code aparece (noutra pasta ou na da conversa): firma, a fala vai pra ela, nada gravado (nenhuma
  // escondida pra fechar)
  let h;
  let id;
  for (const pasta of ['c:\\projetos', 'a da conversa']) {
    ({ h, id } = await cena());
    vscode(h, { cwd: pasta === 'c:\\projetos' ? pasta : h.pasta });
    await firmar(h);
    assert.deepEqual(h.entregas.slice(1).map((p) => [p.sessionId, p.nome, p.providerMsgId]), [[S1, 'repos-85', id]], pasta);
    assert.deepEqual(estado(h).reaberturas, [], pasta);
    assert.deepEqual(estado(h).retomadas, {}, pasta);
  }

  // a escondida aparece: firma e grava o pid dela
  ({ h, id } = await cena());
  escondida(h);
  await firmar(h);
  assert.deepEqual(h.entregas.slice(1).map((p) => [p.sessionId, p.nome, p.providerMsgId]), [[S1, TIT, id]]);
  assert.deepEqual(estado(h).retomadas, { [S1]: { pid: ESC, desde: iso(h.t) } });

  // as duas: a fala vai pra do VS Code e a escondida fica gravada (pra devolver)
  ({ h, id } = await cena());
  escondida(h);
  vscode(h);
  await firmar(h);
  assert.deepEqual(h.entregas.slice(1).map((p) => [p.sessionId, p.nome]), [[S1, 'repos-85']]);
  assert.deepEqual(Object.keys(estado(h).retomadas), [S1]);
  assert.equal(estado(h).retomadas[S1].pid, ESC);

  // a do VS Code firma; a `cli` noutra pasta ou morta nao e gravada (o porteiro nunca fecharia uma que nao abriu)
  for (const quem of ['cli noutra pasta', 'cli morta']) {
    ({ h, id } = await cena());
    if (quem === 'cli morta') {
      escondida(h);
      h.vivos.delete(ESC);
    } else escondida(h, { cwd: path.join(h.raiz, 'Meus Docs', 'trabalho', 'Area') });
    vscode(h);
    await firmar(h);
    assert.deepEqual(h.entregas.slice(1).map((p) => [p.sessionId, p.nome]), [[S1, 'repos-85']], quem);
    assert.deepEqual(estado(h).retomadas, {}, quem);
  }

  // a escondida em outra pasta nao firma nem e gravada
  ({ h, id } = await cena());
  escondida(h, { cwd: path.join(h.raiz, 'Meus Docs', 'trabalho', 'Area') });
  await firmar(h);
  assert.equal(h.entregas.length, 1);
  assert.equal(estado(h).reaberturas.length, 1);
  assert.deepEqual(estado(h).retomadas, {});

  // o item antigo da T8 (a copia: para != de) segue so com a `cli` na pasta: a do VS Code com o id da copia nao firma
  h = montar();
  await h.p.passoMinuto();
  mexer(h, (e) => { e.reaberturas = [{ de: S1, para: S2, nome: TIT, titulo: TIT, pasta: h.pasta, desde: iso(h.t), pedidos: [], candidato: null }]; });
  vscode(h, { sessionId: S2 });
  await firmar(h);
  assert.equal(estado(h).reaberturas.length, 1);
  assert.deepEqual(estado(h).reabertas, {});
});

// ---------- contrato 4: devolver ao VS Code ----------

test('T18b 3 (4a). a mesma conversa viva no VS Code e a escondida parada ha 1 min sem fala esperando: o porteiro fecha a escondida (so o pid dela) e esquece; com 59 s ainda nao', { skip: SO_WINDOWS }, async () => {
  const h = montar();
  escondida(h, { parada: 59 * 1000 });
  vscode(h);
  await h.p.passoMinuto();
  gravarRetomada(h);
  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, [], '59 s: ainda nao');
  assert.deepEqual(Object.keys(estado(h).retomadas), [S1]);
  h.t += 1000;
  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, [ESC], 'so a escondida, nunca a do VS Code');
  assert.deepEqual(estado(h).retomadas, {});
  assert.equal(comLog(h, `retomada ${S1}: a escondida (pid ${ESC}) fechada: a mesma conversa esta no VS Code`), 1);
  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, [ESC], 'esquecida: nao fecha de novo');
});

test('T18b 4 (4b). sem o VS Code, a escondida parada ha 30 min sem fala esperando: fecha; com 29 min nao; a fala entregue depois da ultima mudanca dela segura', { skip: SO_WINDOWS }, async () => {
  let h = montar();
  escondida(h, { parada: 29 * MIN });
  gravarRetomada(h);
  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, []);
  h.t += MIN;
  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, [ESC]);
  assert.deepEqual(estado(h).retomadas, {});
  assert.equal(comLog(h, `retomada ${S1}: a escondida (pid ${ESC}) fechada: parada ha 30 min`), 1);

  // a fala ja entregue (mensageiro "enviado") e ela ainda nao mexeu: espera (o recado ainda nao virou trabalho)
  h = montar();
  escondida(h, { parada: 40 * MIN });
  gravarRetomada(h);
  mexer(h, (e) => { e.entregas = { 'tg-u9': { sessionId: S1, at: iso(h.t - MIN), hora: '11:59', tentativas: 1, conferido: false } }; });
  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, []);
  assert.deepEqual(Object.keys(estado(h).retomadas), [S1]);
});

test('T18b 5. nao fecha: ocupada, fala esperando (fila, nova tentativa, retomada, central), registro que sumiu ou mudou (outro pid, VS Code, morto, sem hora), processo que nao bate (nome, hora), a central (nome ou config), travado e ensaio', { skip: SO_WINDOWS }, async () => {
  const cenas = [
    ['ocupada', (h) => escondida(h, { status: 'busy', parada: 40 * MIN }), true],
    ['fala na fila', (h) => { escondida(h, { parada: 40 * MIN }); mexer(h, (e) => { e.filaEntrega = [{ id: 'q-1', tipo: 'repasse', pedido: { sessionId: S1 } }]; }); }, true],
    ['nova tentativa', (h) => { escondida(h, { parada: 40 * MIN }); mexer(h, (e) => { e.repassar = [{ pedido: { sessionId: S1 } }]; }); }, true],
    ['retomada esperando', (h) => {
      escondida(h, { parada: 40 * MIN });
      mexer(h, (e) => { e.reaberturas = [{ de: S1, para: S1, nome: null, titulo: null, pasta: h.pasta, desde: iso(h.t), pedidos: [], candidato: null }]; });
    }, true],
    ['fala estacionada pra central', (h) => { escondida(h, { parada: 40 * MIN }); mexer(h, (e) => { e.centralPendentes = [{ pedido: { sessionId: S1 }, desde: iso(h.t), porque: 'esperando' }]; }); }, true],
    ['registro com outro pid', (h) => escondida(h, { pid: 42002, parada: 40 * MIN }), false],
    ['o pid agora e de outra conversa', (h) => {
      registro(h, { pid: ESC, sessionId: S2, parada: 40 * MIN });
      escondida(h, { pid: 42002, parada: 40 * MIN });
    }, false],
    ['o pid agora e da aba do VS Code', (h) => vscode(h, { pid: ESC, parada: 40 * MIN }), false],
    ['pid morto', (h) => { escondida(h, { parada: 40 * MIN }); h.vivos.delete(ESC); }, false],
    ['processo que nao e o claude', (h) => { escondida(h, { parada: 40 * MIN }); h.procs.set(ESC, { nome: 'node.exe', paiPid: 1, criadoEm: h.t - 20 * MIN }); }, false],
    ['processo criado em outra hora', (h) => { escondida(h, { parada: 40 * MIN }); h.procs.set(ESC, { nome: 'claude.exe', paiPid: 1, criadoEm: h.t - 5 * MIN }); }, false],
    ['registro sem hora de criacao', (h) => escondida(h, { parada: 40 * MIN, startedAt: undefined }), false],
    ['a central', (h) => escondida(h, { name: 'Central de sessoes de teste', parada: 40 * MIN }), false],
    ['a central do config', (h) => {
      escondida(h, { parada: 40 * MIN });
      fs.writeFileSync(path.join(h.env.SESSOES_WPP_DIR, 'config.json'), JSON.stringify({ centralSessionId: S1 }));
    }, false],
  ];
  for (const [quem, prep, fica] of cenas) {
    const h = montar();
    await h.p.passoMinuto();
    prep(h);
    gravarRetomada(h);
    await h.p.passoMinuto();
    assert.deepEqual(h.mortes, [], quem);
    assert.deepEqual(Object.keys(estado(h).retomadas), fica ? [S1] : [], quem);
    if (!fica) assert.equal(comLog(h, `retomada ${S1}: `), 1, quem);
  }

  // travado: nada fecha (o passo nem roda); destravado, fecha
  let h = montar();
  escondida(h, { parada: 40 * MIN });
  gravarRetomada(h);
  mexer(h, (e) => { e.trava = true; });
  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, []);
  assert.deepEqual(Object.keys(estado(h).retomadas), [S1]);
  mexer(h, (e) => { e.trava = false; });
  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, [ESC]);

  // ensaio: nunca fecha
  h = montar({ ensaio: true });
  escondida(h, { parada: 40 * MIN });
  gravarRetomada(h);
  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, []);
  assert.equal(comLog(h, `retomada ${S1}: ensaio nao fecha`), 1);
});

test('T18b 6. estado torto nao quebra (a faxina tira a torta, no maximo 50); encerrar que falha ou pid que nao morre: fica e so tenta de novo em 10 min', { skip: SO_WINDOWS }, async () => {
  let h = montar();
  await h.p.passoMinuto();
  mexer(h, (e) => { e.retomadas = 'x'; });
  await h.p.passoMinuto();
  assert.deepEqual(estado(h).retomadas, {});
  escondida(h, { parada: 40 * MIN });
  mexer(h, (e) => {
    e.retomadas = { 'nao-e-uuid': { pid: ESC, desde: iso(h.t) }, [S1]: { pid: -3, desde: iso(h.t) }, ['0f1e2d3c-4b5a-4968-8776-655443322110']: null };
  });
  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, []);
  assert.deepEqual(estado(h).retomadas, {});

  // travado (o devolverRetomadas nem roda): a faxina do salvar tira a torta e guarda no maximo 50, as mais novas
  h = montar();
  await h.p.passoMinuto();
  const uuid = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
  mexer(h, (e) => {
    e.trava = true;
    e.retomadas = { 'nao-e-uuid': { pid: ESC, desde: iso(h.t) }, [S1]: { pid: 0, desde: iso(h.t) }, [S2]: { pid: ESC, desde: 'ontem' } };
    for (let i = 0; i < 51; i += 1) e.retomadas[uuid(i)] = { pid: 1000 + i, desde: iso(h.t - i * MIN) };
  });
  await h.p.passoMinuto();
  assert.deepEqual(Object.keys(estado(h).retomadas).sort(), Array.from({ length: 50 }, (_, i) => uuid(i)).sort());
  assert.deepEqual(h.mortes, []);

  // encerrar falhou: fica; 9 min depois nao tenta; 10 min depois tenta de novo e fecha
  h = montar();
  escondida(h, { parada: 40 * MIN });
  gravarRetomada(h);
  h.matarFalha = true;
  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, [ESC]);
  assert.deepEqual(Object.keys(estado(h).retomadas), [S1]);
  assert.equal(comLog(h, `retomada ${S1}: nao fecha (encerrar falhou)`), 1);
  h.matarFalha = false;
  h.t += 9 * MIN;
  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, [ESC]);
  h.t += MIN;
  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, [ESC, ESC]);
  assert.deepEqual(estado(h).retomadas, {});

  // o pid nao morre em ~2 s: fica
  h = montar();
  escondida(h, { parada: 40 * MIN });
  gravarRetomada(h);
  h.naoMorre = true;
  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, [ESC]);
  assert.deepEqual(Object.keys(estado(h).retomadas), [S1]);
  assert.equal(comLog(h, `retomada ${S1}: nao fecha (pid vivo depois de 2 s)`), 1);
});

// ---------- T18c: volta pro PC sem o «Open here anyway» (PLANO-TELEGRAM.md, "T18c") ----------

test('T18c 1. o dono no PC (ocioso abaixo de 60 s) e a escondida parada ha 1 min sem o VS Code: fecha com "o dono esta no PC"; com 59 s nao; ocioso de 60 s ou 5 min nao (so nos 30 min, pela parada); ocioso que falha, lanca ou devolve lixo nao', { skip: SO_WINDOWS }, async () => {
  let h = montar();
  h.idle = 0;
  escondida(h, { parada: 59 * 1000 });
  gravarRetomada(h);
  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, [], '59 s: ainda nao');
  assert.deepEqual(Object.keys(estado(h).retomadas), [S1]);
  h.t += 1000;
  await h.p.passoMinuto();
  assert.deepEqual(h.mortes, [ESC], 'so a escondida');
  assert.deepEqual(estado(h).retomadas, {});
  assert.equal(comLog(h, `retomada ${S1}: a escondida (pid ${ESC}) fechada: o dono esta no PC`), 1);

  // fora do PC (60 s = ATIVO_MS, 5 min) ou ocioso sem um numero bom: o motivo novo nao vale e os 30 min parada seguem
  const fora = [
    ['ocioso de 60 s', (x) => { x.idle = 60 * 1000; }],
    ['ocioso de 5 min', (x) => { x.idle = 5 * MIN; }],
    ['ocioso com falha', (x) => { x.idle = OCIOSO_FALHA; }],
    ['ocioso que lanca', ociosoLanca],
    ['ocioso negativo', (x) => { x.idle = -1; }],
    ['ocioso em texto', (x) => { x.idle = '0'; }],
    ['ocioso nulo', (x) => { x.idle = null; }],
  ];
  for (const [quem, prep] of fora) {
    h = montar();
    prep(h);
    escondida(h, { parada: MIN });
    gravarRetomada(h);
    await h.p.passoMinuto();
    assert.deepEqual(h.mortes, [], quem);
    assert.deepEqual(Object.keys(estado(h).retomadas), [S1], quem);
    h.t += 28 * MIN;
    await h.p.passoMinuto();
    assert.deepEqual(h.mortes, [], `${quem}: 29 min`);
    h.t += MIN;
    await h.p.passoMinuto();
    assert.deepEqual(h.mortes, [ESC], `${quem}: 30 min`);
    assert.equal(comLog(h, `retomada ${S1}: a escondida (pid ${ESC}) fechada: parada ha 30 min`), 1, quem);
    assert.equal(comLog(h, 'o dono esta no PC'), 0, quem);
  }
});

test('T18c 2. a ordem dos motivos: a mesma conversa viva no VS Code e o dono no PC juntos fecham pelo VS Code (o passo rapido nem le o ocioso)', { skip: SO_WINDOWS }, async () => {
  for (const passo of ['passoMinuto', 'passoRetomadas']) {
    const h = montar();
    h.idle = 0;
    escondida(h, { parada: MIN });
    vscode(h);
    gravarRetomada(h);
    await h.p[passo]();
    assert.deepEqual(h.mortes, [ESC], passo);
    assert.deepEqual(estado(h).retomadas, {}, passo);
    assert.equal(comLog(h, `retomada ${S1}: a escondida (pid ${ESC}) fechada: a mesma conversa esta no VS Code`), 1, passo);
    assert.equal(comLog(h, 'o dono esta no PC'), 0, passo);
    if (passo === 'passoRetomadas') assert.equal(h.nOcioso, 0, 'com o VS Code o ocioso nem e lido');
  }
});

test('T18c 3. comando rodando na escondida (bash, sh, powershell ou pwsh na arvore): nao fecha em nenhum dos 3 motivos, espera calada (1 linha, sem os 10 min) e fecha no passo seguinte ao fim do comando', { skip: SO_WINDOWS }, async () => {
  const motivos = [
    ['VS Code', (h) => { escondida(h, { parada: MIN }); vscode(h); }, 'a mesma conversa esta no VS Code'],
    ['dono no PC', (h) => { h.idle = 0; escondida(h, { parada: MIN }); }, 'o dono esta no PC'],
    ['parada 40 min, dono fora', (h) => escondida(h, { parada: 40 * MIN }), 'parada ha 42 min'],
  ];
  const comandos = [[['conhost.exe', 'node.exe', 'BASH.exe'], 'bash.exe'], [['powershell.exe', 'node.exe'], 'powershell.exe']];
  for (const [arvore, nome] of comandos) {
    for (const [quem, prep, fecho] of motivos) {
      const rot = `${quem}, ${nome}`;
      const h = montar();
      prep(h);
      gravarRetomada(h);
      h.arvores.set(ESC, arvore);
      const t1 = h.t;
      await h.p.passoMinuto();
      h.t += MIN;
      await h.p.passoMinuto();
      assert.deepEqual(h.mortes, [], rot);
      assert.deepEqual(Object.keys(estado(h).retomadas), [S1], rot);
      assert.deepEqual(h.filhosDe, [ESC, ESC], rot);
      const x = estado(h).retomadas[S1];
      assert.equal(x?.comandoEm, iso(t1), rot);
      assert.equal(x?.falhouEm, undefined, rot);
      assert.equal(comLog(h, `retomada ${S1}: comando rodando nela (${nome}); espera`), 1, rot);
      // o comando acabou (na arvore so os servidores MCP e o conhost): fecha no passo seguinte, sem esperar 10 min
      h.arvores.set(ESC, ['conhost.exe', 'node.exe']);
      h.t += MIN;
      await h.p.passoMinuto();
      assert.deepEqual(h.mortes, [ESC], rot);
      assert.deepEqual(estado(h).retomadas, {}, rot);
      assert.equal(comLog(h, `retomada ${S1}: a escondida (pid ${ESC}) fechada: ${fecho}`), 1, rot);
    }
  }

  // sh.exe e pwsh.exe (em qualquer caixa) tambem seguram; o comando acabou e o encerrar falhou: a entrada fica sem o
  // comandoEm e com o falhouEm (os 10 min do encerrar)
  for (const nome of ['sh.exe', 'PWSH.EXE']) {
    const h = montar();
    escondida(h, { parada: 40 * MIN });
    gravarRetomada(h);
    h.arvores.set(ESC, ['node.exe', nome]);
    await h.p.passoMinuto();
    assert.deepEqual(h.mortes, [], nome);
    assert.equal(estado(h).retomadas[S1].comandoEm, iso(h.t), nome);
    assert.equal(comLog(h, `retomada ${S1}: comando rodando nela (${nome.toLowerCase()}); espera`), 1, nome);
    h.arvores.set(ESC, ['node.exe']);
    h.matarFalha = true;
    h.t += MIN;
    await h.p.passoMinuto();
    assert.deepEqual(h.mortes, [ESC], nome);
    const x = estado(h).retomadas[S1];
    assert.equal(x.comandoEm, undefined, nome);
    assert.equal(x.falhouEm, iso(h.t), nome);
  }
});

test('T18c 4. a consulta dos comandos que lanca, que falta ou sem dados: nao fecha (1 linha) e so tenta de novo 10 min depois', { skip: SO_WINDOWS }, async () => {
  const cenas = [
    ['lanca', (h) => { h.filhosFalha = true; }, 'consulta dos comandos falhou: wmi caiu', (h) => { h.filhosFalha = false; }],
    ['falta', (h) => { delete h.opcoes.processos.filhos; }, 'sem como conferir os comandos', null],
    ['sem dados', (h) => { h.arvores.set(ESC, 'nada'); }, 'comandos sem dados', (h) => { h.arvores.delete(ESC); }],
  ];
  for (const [quem, prep, porque, consertar] of cenas) {
    const h = montar();
    prep(h);
    escondida(h, { parada: 40 * MIN });
    gravarRetomada(h);
    await h.p.passoMinuto();
    const linha = `retomada ${S1}: nao fecha (${porque})`;
    assert.deepEqual(h.mortes, [], quem);
    assert.deepEqual(Object.keys(estado(h).retomadas), [S1], quem);
    assert.equal(comLog(h, linha), 1, quem);
    const consultas = h.filhosDe.length;
    assert.equal(consultas, quem === 'falta' ? 0 : 1, quem);
    // 9 min depois nem consulta (nem o processo nem os comandos), mesmo com a consulta de volta
    if (consertar) consertar(h);
    h.t += 9 * MIN;
    await h.p.passoMinuto();
    assert.deepEqual(h.infos, [ESC], quem);
    assert.equal(h.filhosDe.length, consultas, quem);
    assert.deepEqual(h.mortes, [], quem);
    // 10 min depois tenta de novo: a consulta que voltou fecha; a que segue faltando nao (e loga de novo)
    h.t += MIN;
    await h.p.passoMinuto();
    assert.deepEqual(h.infos, [ESC, ESC], quem);
    if (consertar) {
      assert.equal(h.filhosDe.length, consultas + 1, quem);
      assert.deepEqual(h.mortes, [ESC], quem);
      assert.deepEqual(estado(h).retomadas, {}, quem);
    } else {
      assert.deepEqual(h.mortes, [], quem);
      assert.equal(comLog(h, linha), 2, quem);
    }
  }
});

test('T18c 5. o passo rapido (passoRetomadas): sem retomada volta na hora (nem le o ocioso nem grava o estado); ocupada nao le o ocioso; parada ha 1 min com o dono no PC fecha (1 leitura do ocioso pra todas); dono fora, ocioso que falha ou lanca, travado e ensaio nao fecham (travado e ensaio nem leem)', { skip: SO_WINDOWS }, async () => {
  // sem retomada: nem le o ocioso nem regrava o estado (o arquivo fica com a hora de antes)
  let h = montar();
  h.idle = 0;
  await h.p.passoMinuto(); // o estado nasce no disco
  const antes = fs.readFileSync(h.estadoArq, 'utf8');
  const velha = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(h.estadoArq, velha, velha);
  const lidas = h.nOcioso;
  h.t += 15 * 1000;
  await h.p.passoRetomadas();
  assert.equal(h.nOcioso, lidas, 'sem retomada: o ocioso nao e lido');
  assert.equal(fs.readFileSync(h.estadoArq, 'utf8'), antes);
  assert.equal(fs.statSync(h.estadoArq).mtimeMs, velha.getTime(), 'sem retomada: o estado nao e regravado');

  // ocupada: nem chega no motivo (o ocioso nao e lido) e nada muda no disco
  h = montar();
  h.idle = 0;
  escondida(h, { status: 'busy', parada: 40 * MIN });
  gravarRetomada(h);
  fs.utimesSync(h.estadoArq, velha, velha);
  await h.p.passoRetomadas();
  assert.equal(h.nOcioso, 0);
  assert.deepEqual(h.mortes, []);
  assert.deepEqual(Object.keys(estado(h).retomadas), [S1]);
  assert.equal(fs.statSync(h.estadoArq).mtimeMs, velha.getTime(), 'ocupada: o estado nao e regravado');

  // parada ha 1 min e o dono no PC: fecha as 2 escondidas com 1 leitura so do ocioso
  const ESC2 = 42003;
  h = montar();
  h.idle = 0;
  escondida(h, { parada: MIN });
  registro(h, { pid: ESC2, sessionId: S2, parada: 2 * MIN });
  mexer(h, (e) => { e.retomadas = { [S1]: { pid: ESC, desde: iso(h.t - 10 * MIN) }, [S2]: { pid: ESC2, desde: iso(h.t - 5 * MIN) } }; });
  await h.p.passoRetomadas();
  assert.deepEqual(h.mortes, [ESC, ESC2]);
  assert.deepEqual(estado(h).retomadas, {});
  assert.equal(h.nOcioso, 1, '1 leitura do ocioso por passo');
  assert.equal(comLog(h, `retomada ${S1}: a escondida (pid ${ESC}) fechada: o dono esta no PC`), 1);
  assert.equal(comLog(h, `retomada ${S2}: a escondida (pid ${ESC2}) fechada: o dono esta no PC`), 1);

  // nao fecham: dono fora, ocioso que falha ou lanca, travado e ensaio (travado e ensaio nem leem o ocioso)
  const cenas = [
    ['dono fora (5 min)', (x) => { x.idle = 5 * MIN; }, 1],
    ['ocioso com falha', (x) => { x.idle = OCIOSO_FALHA; }, 1],
    ['ocioso que lanca', ociosoLanca, 1],
    ['travado', (x) => { x.idle = 0; mexer(x, (e) => { e.trava = true; }); }, 0],
    ['ensaio', (x) => { x.idle = 0; }, 0],
  ];
  for (const [quem, prep, leituras] of cenas) {
    h = montar({ ensaio: quem === 'ensaio' });
    escondida(h, { parada: MIN });
    gravarRetomada(h);
    prep(h);
    await h.p.passoRetomadas();
    assert.deepEqual(h.mortes, [], quem);
    assert.deepEqual(Object.keys(estado(h).retomadas), [S1], quem);
    assert.equal(h.nOcioso, leituras, quem);
    assert.equal(comLog(h, `retomada ${S1}: `), 0, quem);
  }
});

test('T18c 6. descendentesDe (pura): filhos e netos nascidos depois do pai, sem o proprio pid; ciclo nao trava; filho mais velho que o pai (pid reaproveitado) nao entra nem leva os netos; linha torta ignorada; CRLF aceito; pid fora da lista = null (sem dados)', () => {
  const ord = (a) => [...a].sort();
  const arvore = [
    '100|1|1000|claude.exe', // a escondida
    '101|100|1000|conhost.exe', // filho nascido no mesmo ms
    '102|100|2000|node.exe', // filho
    '103|102|3000|bash.exe', // neto
    '104|103|3500|sh.exe', // bisneto
    '105|100|900|powershell.exe', // "filho" mais velho que o pai: aponta pro pid 100 reaproveitado
    '106|105|950|pwsh.exe', // neto que so chega por ele
    '200|1|500|explorer.exe', // fora da arvore
    '201|200|600|cmd.exe',
  ];
  const daEscondida = ['bash.exe', 'conhost.exe', 'node.exe', 'sh.exe'];
  assert.deepEqual(ord(descendentesDe(arvore.join('\n'), 100)), daEscondida);
  assert.deepEqual(ord(descendentesDe(arvore.join('\r\n'), 100)), daEscondida, 'CRLF');
  assert.deepEqual(ord(descendentesDe(`${arvore.join('\r\n')}\r\n`, 100)), daEscondida, 'CRLF com o fim de linha');
  assert.deepEqual(ord(descendentesDe(arvore.join('\n'), 102)), ['bash.exe', 'sh.exe']);
  assert.deepEqual(descendentesDe(arvore.join('\n'), 104), []);
  // pid fora da lista (mesmo com quem diga que e filho dele) = null: a consulta nao achou o proprio processo, que acabou
  // de bater vivo (saida vazia ou cortada do WMI) = sem dados, nunca "sem comando"
  assert.equal(descendentesDe([...arvore, '300|999|5000|bash.exe'].join('\n'), 999), null);
  // ciclo de pais, todos no mesmo ms (a hora nao corta): o 300 (filho do 100) e pai do 301, e o 301 e pai do 300 e do
  // 100; cada um entra 1 vez e o proprio pid nunca
  const ciclo = ['100|301|1000|claude.exe', '300|100|1000|a.exe', '301|300|1000|b.exe', '300|301|1000|a.exe'];
  assert.deepEqual(ord(descendentesDe(ciclo.join('\n'), 100)), ['a.exe', 'b.exe']);
  // linha torta ignorada: sem os 4 campos, numero que nao e numero, nome vazio, vazia
  const torta = [
    'abc', '100|1|1000|claude.exe', '1|2|x|y', '', '   ', '101|100|x|bash.exe', '102|100|2000|', '103|100|2000|node.exe',
    '104|abc|2000|sh.exe', '105|100|2000',
  ];
  assert.deepEqual(descendentesDe(torta.join('\n'), 100), ['node.exe']);
  assert.equal(descendentesDe('', 100), null);
  assert.equal(descendentesDe(undefined, 100), null);
});

test('T18c 7. comando rodando: confere de novo so 1 vez por minuto (o passo rapido de 15 s nem le o ocioso nem consulta os processos) e, com o comando acabado, fecha na conferencia seguinte; a saida do WMI sem a escondida nao fecha', { skip: SO_WINDOWS }, async () => {
  const h = montar();
  h.idle = 0;
  escondida(h, { parada: MIN });
  gravarRetomada(h);
  h.arvores.set(ESC, ['node.exe', 'bash.exe']);
  const t1 = h.t;
  await h.p.passoRetomadas();
  assert.deepEqual(h.filhosDe, [ESC]);
  assert.deepEqual(h.infos, [ESC]);
  assert.equal(h.nOcioso, 1);
  let x = estado(h).retomadas[S1];
  assert.equal(x.comandoEm, iso(t1));
  assert.equal(x.comandoVistoEm, iso(t1));
  // 15, 30 e 45 s depois (o passo rapido): nada e lido nem consultado, mesmo com o comando ja acabado
  h.arvores.set(ESC, ['node.exe']);
  for (let i = 1; i <= 3; i += 1) {
    h.t += 15 * 1000;
    await h.p.passoRetomadas();
    assert.deepEqual(h.filhosDe, [ESC], `${i * 15} s`);
    assert.deepEqual(h.infos, [ESC], `${i * 15} s`);
    assert.equal(h.nOcioso, 1, `${i * 15} s`);
    assert.deepEqual(h.mortes, [], `${i * 15} s`);
  }
  // 1 min depois da ultima conferencia: confere, o comando acabou e fecha
  h.t += 15 * 1000;
  await h.p.passoRetomadas();
  assert.deepEqual(h.filhosDe, [ESC, ESC]);
  assert.deepEqual(h.mortes, [ESC]);
  assert.deepEqual(estado(h).retomadas, {});
  assert.equal(comLog(h, `retomada ${S1}: a escondida (pid ${ESC}) fechada: o dono esta no PC`), 1);

  // comando que segue rodando: a cada conferencia (1 por minuto) o visto anda e o log nao repete
  const h2 = montar();
  escondida(h2, { parada: 40 * MIN });
  gravarRetomada(h2);
  h2.arvores.set(ESC, ['bash.exe']);
  const t2 = h2.t;
  await h2.p.passoMinuto();
  h2.t += MIN;
  await h2.p.passoMinuto();
  x = estado(h2).retomadas[S1];
  assert.equal(x.comandoEm, iso(t2));
  assert.equal(x.comandoVistoEm, iso(h2.t));
  assert.deepEqual(h2.filhosDe, [ESC, ESC]);
  assert.equal(comLog(h2, `retomada ${S1}: comando rodando nela (bash.exe); espera`), 1);
  assert.deepEqual(h2.mortes, []);

  // a saida do WMI sem a propria escondida (vazia ou cortada): o filhos do CLI (descendentesDe da saida) devolve null =
  // "comandos sem dados" (tenta de novo em 10 min), nunca "sem comando" (fecharia matando o que roda)
  const h3 = montar();
  escondida(h3, { parada: 40 * MIN });
  gravarRetomada(h3);
  h3.opcoes.processos.filhos = (pid) => { h3.filhosDe.push(pid); return descendentesDe('', pid); };
  await h3.p.passoMinuto();
  assert.deepEqual(h3.filhosDe, [ESC]);
  assert.deepEqual(h3.mortes, []);
  assert.equal(comLog(h3, `retomada ${S1}: nao fecha (comandos sem dados)`), 1);
  assert.equal(estado(h3).retomadas[S1].falhouEm, iso(h3.t));
});
