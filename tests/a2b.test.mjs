// Testes da A2b (PLANO-ABERTO.md, "A2b — WhatsApp desligado"): o WhatsApp desligavel numa maquina pelo config.json
// (`whatsapp.ligado: false`), pre-requisito do notebook do dono (outro bot, outro chat, sem o grupo do PC).
// Por que existe: com o WhatsApp desligado nada pode ler nem escrever no grupo (nem tentar: a saude do grupo nao pode
// quebrar e o modo rua tem que seguir renovando pelo Telegram), e o portao do OK passa a ser so o toque no Telegram sem
// abrir brecha (sem canal = invalido; pendente nunca concede). A2a (PLANO-ABERTO.md, "A2a — valores"): sem o bloco
// `whatsapp` completo com ligado true o WhatsApp tambem fica desligado (o padrao do produto virou o Telegram); os casos
// "ligado" daqui usam o bloco completo de tests/lib/dados-whatsapp.mjs.
// Isolamento: pastas temporarias (prefixo "a2b-"); wpp ausente (null) ou espiao; tg, espiar, porteiroVivo, portao do
// aviso e dormir dublados; nas linhas de comando, HOME temporaria (sem ~/.claude.json), chave falsa e fetch bloqueado.
// Ids do Telegram sinteticos. Nada de rede, chave real, config.json real nem porteiro rodando.
// Os modulos entram por `import * as`: funcao que ainda nao existe deixa so o teste dela vermelho.
// Rodar: node --test --test-reporter=tap "tests/a2b.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { pastaTemp } from './lib/pasta-temp.cjs';
import * as config from '../lib/config.mjs';
import * as porteiro from '../porteiro.mjs';
import * as okWpp from '../ok-wpp.mjs';
import { montarOkTg } from '../lib/ok-tg.mjs';
import { horaBRT } from '../lib/formato.mjs';
import { NUMERO_DONO, NUMERO_ROBO, WHATSAPP } from './lib/dados-whatsapp.mjs';
import { CENTRAL_TESTE, RAIZES_TESTE } from './lib/dados-central.mjs';
// Mac-testes (C, ambiente): as horas esperadas aqui sao as de Brasilia (o fuso do PC); maquina noutro fuso (o Mac do
// dono veio com o relogio em New York) quebrava a conta. Sem TZ = Brasilia, pra este processo e pros filhos.
process.env.TZ ??= 'America/Sao_Paulo';

const require = createRequire(import.meta.url);
const lib = require('../hooks/lib/sessoes-wpp.js');

const OK_WPP = fileURLToPath(new URL('../ok-wpp.mjs', import.meta.url));
const LER_GRUPO = fileURLToPath(new URL('../ler-grupo.mjs', import.meta.url));
const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-08T15:00:00Z'); // 12:00 em Brasilia
const iso = (ms) => new Date(ms).toISOString();
const segs = (isoTxt) => Math.floor(Date.parse(isoTxt) / 1000);
const CHAT = 4242001; // chat do dono (sintetico)
const BOT = 7777001; // o bot (sintetico)
const DESLIGADO = { whatsapp: { ligado: false } };
const SEM_CANAL = 'sem canal de OK (WhatsApp desligado e OK pelo Telegram desligado)';
const SEM_TOQUE = 'sem toque do dono no Telegram ainda';
const PARADO = 'porteiro parado: o toque do Telegram so vale com o porteiro vivo';
const IGN_LEITURA = { canal: 'telegram', updateId: null, motivo: 'nao consegui ler o Telegram agora; tenta de novo' };

const logsDe = (arq) => {
  try { return fs.readFileSync(arq, 'utf8').split('\n').filter(Boolean); } catch { return []; }
};
const semHora = (l) => l.replace(/^\S+ /, '');

// ---------- 1. config ----------

test('A2b 1 (A2a). whatsappLigado: false com whatsapp.ligado === false e tambem sem o bloco, com outro valor e com cfg ruim (o padrao virou o Telegram); true so com o bloco completo e ligado true', () => {
  const { whatsappLigado } = config;
  assert.equal(whatsappLigado({ whatsapp: { ligado: false } }), false);
  assert.equal(whatsappLigado({ whatsapp: { ligado: false, mcp: 'x' }, telegram: { ligado: true } }), false, 'com outros campos');
  assert.equal(whatsappLigado({ whatsapp: { ...WHATSAPP, ligado: false } }), false, 'o bloco completo com ligado false');
  for (const cfg of [
    {}, null, undefined, 42, 'x', [], [{ whatsapp: { ligado: false } }], { whatsapp: null }, { whatsapp: [] }, { whatsapp: false },
    { whatsapp: 'desligado' }, { whatsapp: {} }, { whatsapp: { ligado: true } }, { whatsapp: { ligado: 'false' } },
    { whatsapp: { ligado: 0 } }, { whatsapp: { ligado: null } }, { whatsapp: [{ ligado: false }] }, { telegram: { ligado: true } },
  ]) {
    assert.equal(whatsappLigado(cfg), false, JSON.stringify(cfg));
  }
  assert.equal(whatsappLigado({ whatsapp: WHATSAPP }), true, 'o bloco completo');
});

// ---------- 2. prepararCanais (a subida do porteiro) ----------

function pastaCfg(cfg) {
  const dir = pastaTemp('a2b-cfg-');
  if (cfg) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));
  return dir;
}

async function subir({ cfg = null, criarW, tg = { nome: 'tg' } }) {
  const estadoDir = pastaCfg(cfg);
  const logs = [];
  const chamadas = { criarW: 0, prepararTg: [] };
  const log = (m) => logs.push(m);
  const env = { SESSOES_WPP_X: '1' };
  const r = await porteiro.prepararCanais({
    estadoDir, env, log, ensaio: true,
    criarW: () => { chamadas.criarW += 1; return criarW(); },
    prepararTg: async (o) => {
      chamadas.prepararTg.push(o);
      return { avisarTelegram: 'AV', configTg: { canalPrincipal: 'whatsapp', ligado: tg !== null }, tg, identTg: { chatId: CHAT, botId: BOT } };
    },
  });
  return { r, logs, chamadas, estadoDir, env, log };
}

test('A2b 2. prepararCanais: ligado = o wpp e o Telegram de hoje; ligado sem o whatsapp-agent = sai antes do Telegram; desligado = wpp null sem criar o wpp (1 log); desligado e sem Telegram = sai (1 log)', async () => {
  const W = { nome: 'wpp' };
  const T = { nome: 'tg' };
  // A2a: ligado = o bloco completo (o retorno traz o numeroDono dele); sem o bloco = desligado (os casos de baixo)
  for (const [nome, cfg] of [['o bloco completo', { whatsapp: WHATSAPP }], ['o bloco completo e o telegram', { whatsapp: WHATSAPP, telegram: { ligado: true } }]]) {
    const x = await subir({ cfg, criarW: () => W, tg: T });
    assert.deepEqual(x.r, { wpp: W, numeroDono: NUMERO_DONO, avisarTelegram: 'AV', configTg: { canalPrincipal: 'whatsapp', ligado: true }, tg: T, identTg: { chatId: CHAT, botId: BOT } }, nome);
    assert.equal(x.chamadas.criarW, 1, nome);
    assert.equal(x.chamadas.prepararTg.length, 1, nome);
    const o = x.chamadas.prepararTg[0];
    assert.deepEqual([o.estadoDir, o.env, o.log, o.ensaio], [x.estadoDir, x.env, x.log, true], `${nome}: o prepararTelegram de antes`);
    assert.deepEqual(x.logs, [], `${nome}: nenhum log novo`);
    // so o WhatsApp (Telegram desligado) = sobe como hoje
    const y = await subir({ cfg, criarW: () => W, tg: null });
    assert.equal(y.r.wpp, W, `${nome}: so o WhatsApp`);
    assert.equal(y.r.tg, null, nome);
    assert.deepEqual(y.logs, [], nome);
  }
  // ligado e sem a entrada do whatsapp-agent: sai como hoje, antes de ler a chave do Telegram
  const z = await subir({ cfg: { whatsapp: WHATSAPP }, criarW: () => { throw new Error('sem a entrada whatsapp-agent'); }, tg: T });
  assert.equal(z.r, null);
  assert.deepEqual(z.logs, ['sem whatsapp-agent: sem a entrada whatsapp-agent']);
  assert.equal(z.chamadas.prepararTg.length, 0, 'o Telegram nem e montado');
  // desligado: nunca cria o wpp
  const d = await subir({ cfg: DESLIGADO, criarW: () => { throw new Error('nao era pra criar'); }, tg: T });
  assert.deepEqual(d.r, { wpp: null, numeroDono: null, avisarTelegram: 'AV', configTg: { canalPrincipal: 'whatsapp', ligado: true }, tg: T, identTg: { chatId: CHAT, botId: BOT } });
  assert.equal(d.chamadas.criarW, 0);
  assert.deepEqual(d.logs, ['WhatsApp desligado no config: so o Telegram']);
  // desligado e sem Telegram: nenhum canal = sai
  const n = await subir({ cfg: DESLIGADO, criarW: () => W, tg: null });
  assert.equal(n.r, null);
  assert.equal(n.chamadas.criarW, 0);
  assert.deepEqual(n.logs, ['sem canal ligado: WhatsApp desligado no config e Telegram desligado']);
});

// ---------- 3. porteiro com wpp null (harness do tests/porteiro-telegram.test.mjs, reduzido) ----------

const tique = () => new Promise((ok) => setImmediate(ok));
async function bombear(p) {
  for (let i = 0; i < 100; i++) {
    const r = await p.passoEntrega();
    if (!r.emVoo && !r.fila) return;
    await tique();
  }
  throw new Error('bombear: a fila de entrega nao esvaziou');
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
  tg.enviar = async (pedido) => { gravar('enviar', [pedido]); tg.enviadas += 1; return { ok: true, messageId: 900 + tg.enviadas, formato: 'rich' }; };
  tg.editar = async (messageId, pedido) => { gravar('editar', [messageId, pedido]); return { ok: true }; };
  tg.editarBotoes = async (messageId, botoes) => { gravar('editarBotoes', [messageId, botoes]); return { ok: true }; };
  tg.apagar = async (messageId) => { gravar('apagar', [messageId]); return { ok: true }; };
  tg.responderToque = async (id, texto) => { gravar('responderToque', [id, texto]); return { ok: true }; };
  tg.baixar = async (fileId) => { gravar('baixar', [fileId]); return { ok: false, erro: 'duble' }; };
  tg.quemSou = async () => { gravar('quemSou', []); return { ok: true, id: BOT, username: 'bot_sintetico' }; };
  tg.definirComandos = async (c) => { gravar('definirComandos', [c]); return { ok: true }; };
  tg.de = (metodo) => tg.chamadas.filter((c) => c.metodo === metodo);
  return tg;
}

// wpp: null (o desligado) por padrao. `ensaio` = o estado no estado-ensaio.json.
function montar({ ensaio = false } = {}) {
  const raiz = pastaTemp('a2b-porteiro-');
  const env = {
    SESSOES_WPP_DIR: path.join(raiz, 'estado'),
    CLAUDE_SESSIONS_DIR: path.join(raiz, 'sessions'),
    CLAUDE_PROJECTS_DIR: path.join(raiz, 'projects'),
    SESSOES_WPP_LOG: path.join(raiz, 'porteiro.log'),
  };
  for (const d of [env.SESSOES_WPP_DIR, env.CLAUDE_SESSIONS_DIR, env.CLAUDE_PROJECTS_DIR]) fs.mkdirSync(d, { recursive: true });
  const h = { raiz, env, t: T0, idle: 0, entregas: [], portao: [], aberturas: 0, nReg: 0, nomeEstado: ensaio ? 'estado-ensaio.json' : 'estado.json' };
  h.tg = dubleTg(h);
  h.cru = porteiro.criarPorteiro({
    wpp: null,
    mensageiro: { async entregar(p) { h.entregas.push(p); return { status: 'enviado', detalhe: '' }; } },
    ocioso: async () => h.idle,
    agora: () => h.t,
    env,
    ensaio,
    abrirCentral: () => { h.aberturas += 1; },
    avisarTelegram: async (texto) => { h.portao.push(texto); return true; },
    rand: randFixo(),
    dormir: async (ms) => { h.t += ms; },
    tg: h.tg,
    identTg: { chatId: CHAT, botId: BOT },
    central: CENTRAL_TESTE, // A3a: a central e as pastas como o dono configura
    raizesSessao: RAIZES_TESTE,
  });
  h.p = {
    ...h.cru,
    passoGrupo: async () => { await h.cru.passoGrupo(); await bombear(h.cru); },
    passoEventos: async () => { await h.cru.passoEventos(); await bombear(h.cru); },
  };
  h.t += 1000;
  return h;
}
function sessao(h, { sessionId, name = 'projetos-42' }) {
  h.nReg += 1;
  const reg = { pid: process.pid, sessionId, cwd: 'c:\\projetos', entrypoint: 'claude-vscode', name, nameSource: 'derived', status: 'idle', updatedAt: h.t };
  fs.writeFileSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${100000 + h.nReg}.json`), JSON.stringify(reg));
}
function aba(h, sessionId, titulo, name = 'projetos-42') {
  sessao(h, { sessionId, name });
  const dir = path.join(h.env.CLAUDE_PROJECTS_DIR, 'c--projetos');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${sessionId}.jsonl`), `${JSON.stringify({ type: 'custom-title', customTitle: titulo, sessionId: 'x' })}\n`);
}
const CENTRAL = 'Central de sessões de teste';
const FINAL = 'Terminei a revisão.\n\n---\n🔴 **DECISÃO:** Publico? A) Sim, tudo hoje (recomendado) / B) Só as correções';
function parou(h, sessionId, o = {}) {
  return {
    v: 1, tipo: 'parou', at: iso(h.t), sessionId, pid: process.pid, nome: 'projetos-42', titulo: null, cwd: 'C:\\projetos',
    entrypoint: 'claude-vscode', final: o.final ?? 'Feito.', finalTs: iso(h.t), marcas: o.marcas ?? { decisao: false, fica: false, pergunta: false },
  };
}
const evento = (h, ev) => lib.anexarEvento(h.env.SESSOES_WPP_DIR, ev);
const estado = (h) => JSON.parse(fs.readFileSync(path.join(h.env.SESSOES_WPP_DIR, h.nomeEstado), 'utf8'));
function mexer(h, fn) {
  const arq = path.join(h.env.SESSOES_WPP_DIR, h.nomeEstado);
  const e = JSON.parse(fs.readFileSync(arq, 'utf8'));
  fn(e);
  fs.writeFileSync(arq, JSON.stringify(e));
}
const ligarTg = (h) => mexer(h, (e) => { e.tg.offset = 0; }); // o historico ja foi pulado
async function ligarRua(h) {
  h.idle = 30 * MIN;
  await h.p.passoMinuto();
  assert.equal(estado(h).modoRua.ligado, true);
}
const logs = (h) => logsDe(h.env.SESSOES_WPP_LOG);
const ensaiado = (h) => logsDe(path.join(h.env.SESSOES_WPP_DIR, 'ensaio.jsonl')).map((l) => JSON.parse(l).acao);

test('A2b 3. porteiro com wpp null: o principal e o Telegram mesmo com o canalPrincipal padrao (whatsapp): o aviso vira chamado no Telegram e nada vai pra fila do grupo', async () => {
  const h = montar(); // sem canalPrincipal = 'whatsapp'
  aba(h, 'S1', 'Faro');
  ligarTg(h);
  await ligarRua(h);
  evento(h, parou(h, 'S1', { final: FINAL, marcas: { decisao: true, fica: false, pergunta: false } }));
  await h.p.passoEventos();
  const e = estado(h);
  assert.equal(e.tg.chamados.S1.versao.estado, 'aviso');
  assert.equal(e.parouGuardado.S1.noTelegram, true);
  assert.equal(e.parouGuardado.S1.noGrupo, false);
  assert.deepEqual(e.saida, []);
  await h.p.esperarTelegram(15000);
  assert.equal(h.tg.de('enviar').length, 1, 'o aviso saiu pelo Telegram');
});

test('A2b 4. wpp null: o passoGrupo nao le o grupo; 30 min de passos = a saude do grupo intacta (sem leitura, sem falha, sem aviso) e o modo rua renova; a saude velha "quebrada" do disco nao avisa', async () => {
  const h = montar();
  ligarTg(h);
  await ligarRua(h);
  const antes = estado(h).saude;
  const t0 = h.t;
  for (let m = 1; m <= 30; m++) {
    h.t = t0 + m * MIN;
    await h.p.passoGrupo();
    await h.p.passoMinuto();
  }
  const s = estado(h).saude;
  assert.equal(s.leituraOkEm, antes.leituraOkEm, 'nenhuma leitura ok');
  assert.equal(s.leituraFalhaDesde, null, 'nenhuma leitura falha');
  assert.equal(s.envioFalhaDesde, null);
  assert.equal(s.quebrado, false);
  assert.deepEqual(h.portao, [], 'nenhum aviso de saude');
  assert.equal(estado(h).modoRua.atualizadoEm, iso(t0 + 30 * MIN), 'o modo rua renova (o principal e o Telegram)');
  assert.ok(!logs(h).some((l) => /canal do WhatsApp/.test(l)), 'nem quebrou nem voltou');
  // saude do disco de quando o WhatsApp era ligado (quebrada, nao avisada): nada sai
  mexer(h, (e) => { Object.assign(e.saude, { quebrado: true, causaLeitura: iso(t0), leituraFalhaDesde: iso(t0), avisoEm: null }); });
  for (let m = 31; m <= 100; m++) {
    h.t = t0 + m * MIN;
    await h.p.passoMinuto();
  }
  assert.deepEqual(h.portao, [], 'nem a queda velha nem o "continua"');
  assert.equal(estado(h).modoRua.atualizadoEm, iso(t0 + 100 * MIN), 'o modo rua segue renovando');
});

test('A2b 5. wpp null: a fila do grupo que sobrou no disco sai no 1o drenar com 1 log, sem enviar; frase nova pro grupo (central pedida pelo grupo que nao abriu) nao entra na fila (1 log); no ensaio, nada registrado pro grupo', async () => {
  for (const ensaio of [false, true]) {
    const h = montar({ ensaio });
    ligarTg(h);
    mexer(h, (e) => {
      e.saida = [
        { tipo: 'frase', texto: 'velha', falhas: 0, entrouEm: iso(h.t) },
        { tipo: 'editar', texto: 'Concluído', messageId: 'U1', sessionId: 'S1', prazo: iso(h.t + 10 * MIN), falhas: 0, entrouEm: iso(h.t) },
      ];
    });
    await h.p.passoGrupo();
    assert.deepEqual(estado(h).saida, [], `ensaio ${ensaio}`);
    assert.deepEqual(logs(h).map(semHora).filter((l) => /fila do grupo/.test(l)),
      [`porteiro${ensaio ? ' (ensaio)' : ''}: WhatsApp desligado: 2 item(ns) da fila do grupo descartado(s)`], `ensaio ${ensaio}`);
    mexer(h, (e) => { e.centralEsperada = { desde: iso(h.t - 4 * MIN) }; });
    await h.p.passoMinuto();
    assert.deepEqual(estado(h).saida, [], `ensaio ${ensaio}`);
    assert.ok(logs(h).some((l) => l.endsWith('WhatsApp desligado: frase nao vai pro grupo')), `ensaio ${ensaio}`);
    assert.ok(!ensaiado(h).some((a) => ['enviarGrupo', 'reagir', 'editar'].includes(a)), `ensaio ${ensaio}: ${ensaiado(h)}`);
  }
});

test('A2b 6. wpp null: a central encaminhando uma fala do grupo (id do WhatsApp) = "WhatsApp desligado": nao le, nao entrega, a frase nao vai pro grupo e a saude fica intacta', async () => {
  const h = montar();
  aba(h, 'S1', 'Faro');
  aba(h, 'SC', CENTRAL, 'repos-99');
  ligarTg(h);
  evento(h, { v: 1, tipo: 'encaminhar', at: iso(h.t), para: 'Faro', providerMsgId: 'PROV9', por: 'SC' });
  await h.p.passoEventos();
  assert.deepEqual(h.entregas, []);
  assert.ok(logs(h).some((l) => l.endsWith('encaminhar da central: WhatsApp desligado; nao entrega')), logs(h).join('\n'));
  assert.ok(logs(h).some((l) => l.endsWith('WhatsApp desligado: frase nao vai pro grupo')));
  assert.equal(estado(h).saude.leituraFalhaDesde, null);
  assert.deepEqual(estado(h).saida, []);
});

// ---------- 4. ok-wpp sem WhatsApp (harness do tests/ok-wpp-tg.test.mjs, com ids sinteticos) ----------

const SID = '11111111-2222-4333-8444-555555555555';
const PID = 4242;
const OFFSET = 500;
const ACAO = 'Publicar o site v2 em producao';

function montarOk({ estado: est = { v: 1, trava: false, tg: { offset: OFFSET } }, wpp = null } = {}) {
  const raiz = pastaTemp('a2b-ok-');
  const env = {
    SESSOES_WPP_DIR: path.join(raiz, 'estado'),
    CLAUDE_SESSIONS_DIR: path.join(raiz, 'sessions'),
    CLAUDE_PROJECTS_DIR: path.join(raiz, 'projects'),
    SESSOES_WPP_LOG: path.join(raiz, 'ok-wpp.log'),
    CLAUDE_CODE_SESSION_ID: SID,
  };
  for (const d of [env.SESSOES_WPP_DIR, env.CLAUDE_SESSIONS_DIR, env.CLAUDE_PROJECTS_DIR]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(env.SESSOES_WPP_DIR, 'estado.json'), JSON.stringify(est));
  const reg = { pid: PID, sessionId: SID, cwd: 'C:\\projetos', name: 'projetos-f3', nameSource: 'derived', entrypoint: 'claude-vscode', status: 'idle', updatedAt: T0 };
  fs.writeFileSync(path.join(env.CLAUDE_SESSIONS_DIR, `${PID}.json`), JSON.stringify(reg));
  const pasta = path.join(env.CLAUDE_PROJECTS_DIR, 'c--projetos');
  fs.mkdirSync(pasta, { recursive: true });
  fs.writeFileSync(path.join(pasta, `${SID}.jsonl`), `${JSON.stringify({ type: 'custom-title', customTitle: 'Faro', sessionId: SID })}\n`);
  const h = {
    raiz, env, t: T0, tg: [], espiadas: [], espiarErros: [], dormidas: [], vivo: true,
    markerPath: path.join(raiz, 'logs', 'publicacao-ok.json'),
    disparoPath: path.join(raiz, 'logs', 'disparo-estado.json'),
  };
  h.tgOk = {
    async espiar(arg) {
      h.espiadas.push(arg);
      if (h.espiarErros.length) throw h.espiarErros.shift();
      return JSON.parse(JSON.stringify(h.tg));
    },
    botId: BOT,
    chatDono: CHAT,
  };
  h.ok = (extra = {}) => okWpp.criarOkWpp({
    wpp, env, agora: () => h.t, markerPath: h.markerPath, disparoPath: h.disparoPath, tgOk: h.tgOk,
    porteiroVivo: () => h.vivo, dormir: async (ms) => { h.dormidas.push(ms); },
    numeroDono: NUMERO_DONO, numeroRobo: NUMERO_ROBO, // A2a: os numeros do config (so contam com o wpp, A2b 9)
    ...extra,
  });
  h.oksDir = path.join(env.SESSOES_WPP_DIR, 'oks');
  h.pedido = (cod) => JSON.parse(fs.readFileSync(path.join(h.oksDir, `${cod}.json`), 'utf8'));
  h.markers = () => (fs.existsSync(h.markerPath) ? JSON.parse(fs.readFileSync(h.markerPath, 'utf8')) : null);
  h.logTg = () => logsDe(env.SESSOES_WPP_LOG).filter((l) => l.includes('ok-wpp: telegram:')).map(semHora);
  return h;
}

// O wpp que registra toda chamada (o WhatsApp ligado; o pedido sem os ids nunca acha a mensagem no grupo).
function espiaoWpp() {
  const w = { chamadas: [] };
  for (const nome of ['lerGrupo', 'enviarGrupo', 'reagir', 'membros']) {
    w[nome] = async (...a) => { w.chamadas.push(nome); return nome === 'membros' ? [] : nome === 'lerGrupo' ? [] : { ok: true, providerMsgId: 'P1', messageId: 'U1' }; };
  }
  return w;
}

async function pedidoSemWpp(h, tipo = 'publicacao') {
  const r = await h.ok().pedir({ tipo, acao: ACAO });
  assert.equal(r.status, 'pedido', JSON.stringify(r));
  return r.codigo;
}

// Toque como o getUpdates devolve, montado do ARQUIVO do pedido (o texto e o teclado que o porteiro manda).
function toque(h, cod, acao = 'sim', updateId = 501) {
  const p = h.pedido(cod);
  const r = montarOkTg({ ...p, completo: false });
  return {
    update_id: updateId,
    callback_query: {
      id: `cbq-${updateId}`,
      from: { id: CHAT, is_bot: false, first_name: 'Dono' },
      chat_instance: '-123456',
      data: `k:${p.codigo}:${{ sim: 's', nao: 'n' }[acao]}`,
      message: {
        message_id: 77,
        from: { id: BOT, is_bot: true, first_name: 'Bot', username: 'bot_sintetico' },
        chat: { id: CHAT, type: 'private', first_name: 'Dono' },
        date: segs(p.criadoEm) + 2,
        text: r.texto,
        reply_markup: { inline_keyboard: r.botoes.map((l) => l.map((b) => ({ text: b.texto, callback_data: b.dados, ...(b.estilo ? { style: b.estilo } : {}) }))) },
      },
    },
  };
}

test('A2b 7. ok-wpp pedir com wpp null: com o OK pelo Telegram = nada pro grupo, o pedido nasce sem os ids do WhatsApp e telegram true; sem ele = invalido sem canal, antes de tudo e sem gravar nada', async () => {
  const h = montarOk();
  const r = await h.ok().pedir({ tipo: 'publicacao', acao: ACAO });
  assert.deepEqual(r, { status: 'pedido', codigo: r.codigo, expiraEm: iso(T0 + 30 * MIN), hora: horaBRT(iso(T0 + 30 * MIN)), telegram: true });
  const p = h.pedido(r.codigo);
  assert.deepEqual(Object.keys(p), ['v', 'codigo', 'sessionId', 'titulo', 'tipo', 'acao', 'hashAcao', 'destinatarios', 'libera', 'criadoEm', 'expiraEm', 'providerMsgId', 'messageId', 'status']); // A5c: libera
  assert.deepEqual([p.providerMsgId, p.messageId, p.status, p.titulo, p.sessionId], [null, null, 'pendente', 'Faro', SID]);

  const s = montarOk();
  assert.deepEqual(await s.ok({ tgOk: null }).pedir({ tipo: 'crm', acao: 'Mover o deal' }), { status: 'invalido', motivo: SEM_CANAL });
  // antes de tudo: nem a sessao nem a acao sao conferidas
  assert.deepEqual(await s.ok({ tgOk: null, env: { ...s.env, CLAUDE_CODE_SESSION_ID: '' } }).pedir({ acao: '' }), { status: 'invalido', motivo: SEM_CANAL });
  assert.ok(!fs.existsSync(s.oksDir) || fs.readdirSync(s.oksDir).length === 0, 'nada gravado');
});

test('A2b 8. ok-wpp verificar com wpp null: so o toque no Telegram decide (Sim com o porteiro vivo = ok k telegram; Nao = recusado); sem decisao = pendente com o motivo; sem o OK pelo Telegram = invalido sem canal', async () => {
  // Sim + porteiro vivo = ok, marker k telegram
  const a = montarOk();
  const cA = await pedidoSemWpp(a);
  a.t = T0 + MIN;
  a.tg = [toque(a, cA, 'sim')];
  assert.deepEqual(await a.ok().verificar(cA), { status: 'ok', canal: 'telegram', codigo: cA, tipo: 'publicacao', acao: ACAO, destinatarios: null, hora: horaBRT(iso(T0 + MIN)) });
  assert.equal(a.pedido(cA).status, 'usado');
  assert.equal(a.markers()[SID].k, 'telegram');
  // Nao = recusado
  const b = montarOk();
  const cB = await pedidoSemWpp(b);
  b.tg = [toque(b, cB, 'nao')];
  const rB = await b.ok().verificar(cB);
  assert.deepEqual([rB.status, rB.motivo], ['recusado', 'o dono tocou em Nao no Telegram']);
  assert.equal(b.pedido(cB).status, 'recusado');
  // sem toque = pendente
  const c = montarOk();
  const cC = await pedidoSemWpp(c);
  assert.deepEqual(await c.ok().verificar(cC), { status: 'pendente', motivo: SEM_TOQUE, ignoradas: [] });
  // Sim com o porteiro parado = pendente com o motivo (nunca "cai pro WhatsApp")
  const d = montarOk();
  const cD = await pedidoSemWpp(d);
  d.vivo = false;
  d.tg = [toque(d, cD, 'sim', 502)];
  assert.deepEqual(await d.ok().verificar(cD), { status: 'pendente', motivo: PARADO, ignoradas: [{ canal: 'telegram', updateId: 502, motivo: PARADO }] });
  // leitura que falhou e estado sem o offset do porteiro = pendente; o log diz "fica pendente"
  const e = montarOk();
  const cE = await pedidoSemWpp(e);
  e.espiarErros = [new Error('fetch failed')];
  assert.deepEqual(await e.ok().verificar(cE), { status: 'pendente', motivo: IGN_LEITURA.motivo, ignoradas: [IGN_LEITURA] });
  assert.deepEqual(e.logTg(), ['ok-wpp: telegram: leitura falhou (fetch failed); fica pendente']);
  const f = montarOk({ estado: { v: 1, trava: false } });
  const cF = await pedidoSemWpp(f);
  assert.deepEqual(await f.ok().verificar(cF), { status: 'pendente', motivo: IGN_LEITURA.motivo, ignoradas: [IGN_LEITURA] });
  assert.deepEqual(f.logTg(), ['ok-wpp: telegram: sem o offset do porteiro no estado.json; fica pendente']);
  for (const [x, cod] of [[c, cC], [d, cD], [e, cE], [f, cF]]) {
    assert.equal(x.pedido(cod).status, 'pendente');
    assert.equal(x.markers(), null);
  }
  // sem o OK pelo Telegram (o config mudou depois do pedido) = invalido sem canal; o pedido segue pendente
  const g = montarOk();
  const cG = await pedidoSemWpp(g);
  g.tg = [toque(g, cG, 'sim')];
  assert.deepEqual(await g.ok({ tgOk: null }).verificar(cG), { status: 'invalido', motivo: SEM_CANAL });
  assert.equal(g.pedido(cG).status, 'pendente');
  assert.equal(g.markers(), null);
});

test('A2b 9. ok-wpp: pedido que nasceu sem os ids do WhatsApp e o WhatsApp ligado depois: com o OK pelo Telegram, sem toque = pendente sem membros nem leitura do grupo; o Sim decide', async () => {
  const h = montarOk();
  const cod = await pedidoSemWpp(h);
  const w = espiaoWpp();
  assert.deepEqual(await h.ok({ wpp: w }).verificar(cod), { status: 'pendente', motivo: SEM_TOQUE, ignoradas: [] });
  assert.deepEqual(w.chamadas, [], 'sem membros, sem leitura, sem reacao');
  h.tg = [toque(h, cod, 'sim')];
  const r = await h.ok({ wpp: w }).verificar(cod);
  assert.deepEqual([r.status, r.canal], ['ok', 'telegram']);
  assert.ok(!w.chamadas.includes('membros') && !w.chamadas.includes('reagir'), String(w.chamadas));
});

// ---------- 5. linhas de comando (HOME temporaria sem ~/.claude.json, fetch bloqueado) ----------

const SEM_REDE = "data:text/javascript,globalThis.fetch=async()=>{process.stderr.write('REDE-TENTADA\\n');throw new Error('sem rede no teste')}";
const VAR_FALSA = 'CHAVE_FALSA_A2B';
function envFilho(extra) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TELEGRAM_\w*_TOKEN|SESSOES_WPP_TELEGRAM_TOKEN|SESSOES_WPP_.*|CLAUDE_CODE_SESSION_ID)$/i.test(k)));
  return { ...base, ...extra };
}

test('A2b 10. CLI ok-wpp pedir com o WhatsApp desligado: com o OK pelo Telegram = pedido sem tocar no WhatsApp (sem ~/.claude.json, sem rede); sem ele = invalido sem canal, exit 1, nada gravado', async () => {
  const CHAVE = 'chave-falsa-a2b';
  for (const [nome, cfg, esperado] of [
    ['OK pelo Telegram ligado', { ...DESLIGADO, telegram: { ligado: true, chatId: CHAT, ok: { ligado: true }, varChave: VAR_FALSA } }, 'pedido'],
    ['so o desligado', DESLIGADO, 'invalido'],
  ]) {
    const h = montarOk();
    h.t = Date.now();
    fs.writeFileSync(path.join(h.env.SESSOES_WPP_DIR, 'config.json'), JSON.stringify(cfg));
    const home = path.join(h.raiz, 'home');
    fs.mkdirSync(home);
    const env = envFilho({ ...h.env, USERPROFILE: home, HOME: home, [VAR_FALSA]: CHAVE });
    const v = spawnSync(process.execPath, ['--import', SEM_REDE, OK_WPP, 'pedir', '--tipo', 'crm', '--acao', 'Mover o deal 123 pra Ganho'], { env, encoding: 'utf8' });
    const r = JSON.parse(v.stdout);
    assert.doesNotMatch(v.stderr, /REDE-TENTADA/, nome);
    assert.ok(!`${v.stdout}${v.stderr}`.includes(CHAVE), `${nome}: a chave nunca sai`);
    if (esperado === 'pedido') {
      assert.equal(v.status, 0, `${nome}: ${v.stdout} ${v.stderr}`);
      assert.deepEqual(r, { status: 'pedido', codigo: r.codigo, expiraEm: r.expiraEm, hora: horaBRT(r.expiraEm), telegram: true }, nome);
      const p = h.pedido(r.codigo);
      assert.deepEqual([p.providerMsgId, p.messageId, p.status], [null, null, 'pendente'], nome);
    } else {
      assert.equal(v.status, 1, nome);
      assert.deepEqual(r, { status: 'invalido', motivo: SEM_CANAL }, nome);
      assert.ok(!fs.existsSync(h.oksDir) || fs.readdirSync(h.oksDir).length === 0, `${nome}: nada gravado`);
    }
  }
});

test('A2b 11 (A2a). CLI ler-grupo com o WhatsApp desligado: 1 linha "WhatsApp desligado", sai 0, sem ler o ~/.claude.json; sem o config tambem (o padrao); so o bloco completo vai pro grupo (sem ~/.claude.json = erro); --telegram igual a antes', () => {
  const rodar = (cfg, args = []) => {
    const raiz = pastaTemp('a2b-ler-');
    const estadoDir = path.join(raiz, 'estado');
    const home = path.join(raiz, 'home');
    fs.mkdirSync(estadoDir, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    if (cfg) fs.writeFileSync(path.join(estadoDir, 'config.json'), JSON.stringify(cfg));
    const env = { SESSOES_WPP_DIR: estadoDir, USERPROFILE: home, HOME: home };
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    if (process.env.TZ) env.TZ = process.env.TZ; // Mac-testes: o fuso de Brasilia do topo
    const r = spawnSync(process.execPath, ['--import', SEM_REDE, LER_GRUPO, ...args], { env, encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.equal(r.error, undefined, String(r.error));
    return r;
  };
  const d = rodar(DESLIGADO, ['20']);
  assert.equal(d.status, 0, d.stderr);
  assert.equal(d.stdout, 'WhatsApp desligado\n');
  assert.equal(d.stderr, '');
  const semCfg = rodar(null);
  assert.equal(semCfg.status, 0, semCfg.stderr);
  assert.equal(semCfg.stdout, 'WhatsApp desligado\n', 'A2a: sem o config = desligado (o padrao)');
  const grupo = rodar({ whatsapp: WHATSAPP });
  assert.notEqual(grupo.status, 0, 'o bloco completo: tenta o grupo (sem ~/.claude.json = erro, como antes)');
  const tg = rodar(DESLIGADO, ['--telegram']);
  assert.equal(tg.status, 0, tg.stderr);
  assert.equal(tg.stdout, '', 'sem estado.json = nada, como antes');
});
