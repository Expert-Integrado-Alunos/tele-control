// Testes da T21b (PLANO-TELEGRAM.md, "T21 — o controle completo numa conversa do Orca", contrato 3; pedido do dono:
// "Mas não dá pra arrumar as coisas que não tem ainda?"). A fala do dono pra uma conversa fechada que veio do Orca
// (e.origens, gravado pela T21a) e com o Orca ABERTO volta numa aba visivel do Orca, no lugar da escondida; o Orca fechado
// ou que falha = a escondida de hoje. A reaberta no Orca firma igual e nunca entra no e.retomadas (nunca e fechada sozinha).
// - T21b 1: origem Orca + Orca aberto = abrirNoOrca(pasta, nome, {retomar}), escondida nao; o item da espera tem orca: true.
// - T21b 2: origem Orca + Orca fechado (false, valor que nao e true, rejeicao) = escondida; abrirNoOrca nao.
// - T21b 3: origem Orca + Orca aberto + abrirNoOrca que rejeita = 1 linha "vai escondida" e a escondida; as duas falhando =
//   a mesma frase de problema de hoje.
// - T21b 4: sem origem Orca (ou outro app, ou sem uma das 2 dependencias) = escondida e o orcaAberto nunca consultado.
// - T21b 5: a reaberta no Orca firma (cli vivo na pasta), a fala vai, e.retomadas fica vazio, e o devolverRetomadas nunca
//   fecha ela (31 min parada com o dono no PC); a escondida de controle, no mesmo cenario, fecha.
// - T21b 6: abrirNoOrcaReal e orcaAbertoReal com spawn/execFile falsos (nenhum orca.exe nem tasklist de verdade roda).
// Isolamento: como o tests/porteiro-t18.test.mjs (pastas temporarias via SESSOES_WPP_DIR, CLAUDE_SESSIONS_DIR,
// CLAUDE_PROJECTS_DIR e SESSOES_WPP_LOG; dubles de tg, wpp, mensageiro, abridores, processos e pidVivo): nenhum processo
// de verdade e consultado, aberto ou morto. Sem rede.
// Rodar: node --test --test-reporter=tap "tests/porteiro-t21b.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { criarPorteiro, abrirNoOrcaReal, orcaAbertoReal } from '../porteiro.mjs';
import { criarCanalTelegram } from '../canal-telegram.mjs';
import { NUMERO_DONO } from './lib/dados-whatsapp.mjs';
import { CENTRAL_TESTE } from './lib/dados-central.mjs';

const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-14T16:00:00Z'); // 13:00 em Brasilia
const iso = (ms) => new Date(ms).toISOString();
const DONO = 700100200;
const BOT = 700900800;
const S1 = '5a1f0c2e-1b7d-4c3a-9e2f-0123456789ab'; // a conversa do Orca, fechada
const TIT = 'Teste Orca';
const FINAL_FIN = '🟢 O material está pronto.\n\n🔴 **DECISÃO:** Mando pro Caio?\nA) Sim / B) Não';
const ESC = 42001; // pid do claude que volta (no Orca ou escondido)

// ---------- harness (do tests/porteiro-t18.test.mjs) ----------

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

// Porteiro com o Telegram, os abridores de mentira e os processos falsos (como no t18). Orca: `h.orcas` (cada
// abrirNoOrca), `h.nOrcaAberto` (cada orcaAberto), `h.orcaAberto` (o que ele devolve; 'lanca' = rejeita), `h.orcaFalha`
// (abrirNoOrca rejeita com essa mensagem) e `h.escondidaFalha` (o escondido rejeita). `orca: false` = sem as 2
// dependencias; `soAbrir: true` = so o abrirNoOrca (sem o orcaAberto).
function montar({ orca = true, soAbrir = false } = {}) {
  const raiz = pastaTemp('porteiro-t21b-');
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
    raiz, env, t: T0, idle: 5 * MIN, entregas: [], escondidas: [], mortas: new Set(), nAux: 0, nUpd: 100,
    nMid: 7000, randAux: randFixo(), pasta: path.join(repos, 'sessoes-wpp'),
    vivos: new Set(), procs: new Map(), mortes: [], arvores: new Map(),
    orcas: [], nOrcaAberto: 0, orcaAberto: true, orcaFalha: null, escondidaFalha: false,
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
      return { status: h.mortas.has(p.sessionId) ? 'nao_achei' : 'enviado', detalhe: '' };
    },
  };
  h.tg = dubleTg(h);
  const processos = {
    info(pid) { return h.procs.get(pid) ?? null; },
    matarArvore(pid) {
      h.mortes.push(pid);
      h.vivos.delete(pid);
      return true;
    },
    filhos(pid) { return h.arvores.get(pid) ?? []; },
  };
  const opcoes = {
    wpp, numeroDono: NUMERO_DONO, mensageiro, ocioso: async () => h.idle, agora: () => h.t, env, abrirCentral: () => {}, rand: randFixo(),
    dormir: async (ms) => { h.t += ms; }, raizesSessao: [repos, workspace], ensaio: false, tg: h.tg,
    identTg: { chatId: DONO, botId: BOT }, central: CENTRAL_TESTE, // A3a: a central como o dono configura
    abrirSessaoEscondida: async (pasta, nome, retomada) => {
      h.escondidas.push([pasta, nome, retomada ?? null]);
      if (h.escondidaFalha) throw new Error('wscript saiu com 1');
    },
    processos, pidVivo: (pid) => h.vivos.has(Number(pid)),
  };
  if (orca) {
    opcoes.abrirNoOrca = async (pasta, nome, retomada) => {
      h.orcas.push([pasta, nome, retomada ?? null]);
      if (h.orcaFalha) throw new Error(h.orcaFalha);
    };
    if (!soAbrir) {
      opcoes.orcaAberto = async () => {
        h.nOrcaAberto += 1;
        if (h.orcaAberto === 'lanca') throw new Error('tasklist caiu');
        return h.orcaAberto;
      };
    }
  }
  h.cru = criarPorteiro(opcoes);
  h.p = comBomba(h.cru);
  h.t += 1000;
  return h;
}

// Registro `cli` como o Claude Code grava (`<pid>.json`), vivo no pidVivo e no processos.info.
function registro(h, { pid = ESC, cwd = h.pasta, status = 'idle', parada = 2 * MIN } = {}) {
  const startedAt = h.t - 20 * MIN;
  const reg = {
    pid, sessionId: S1, cwd, entrypoint: 'cli', kind: 'interactive', name: TIT, nameSource: 'user',
    status, startedAt, updatedAt: h.t, statusUpdatedAt: h.t - parada,
  };
  fs.writeFileSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${pid}.json`), JSON.stringify(reg));
  h.vivos.add(pid);
  h.procs.set(pid, { nome: 'claude.exe', paiPid: 1, criadoEm: startedAt });
  return reg;
}
// A conversa S1 do Orca no disco: o titulo e a 1a mensagem `cli` na pasta do projeto (como o Claude Code grava).
function conversa(h) {
  const dir = path.join(h.env.CLAUDE_PROJECTS_DIR, 'c--projetos-sessoes-wpp');
  fs.mkdirSync(dir, { recursive: true });
  const linhas = [
    { type: 'custom-title', customTitle: TIT, sessionId: S1 },
    { type: 'user', sessionId: S1, entrypoint: 'cli', cwd: h.pasta, timestamp: iso(h.t - 60 * MIN), message: { role: 'user', content: 'oi' } },
  ];
  fs.writeFileSync(path.join(dir, `${S1}.jsonl`), linhas.map((x) => `${JSON.stringify(x)}\n`).join(''));
}
const estado = (h) => JSON.parse(fs.readFileSync(h.estadoArq, 'utf8'));
function mexer(h, fn) {
  const e = JSON.parse(fs.readFileSync(h.estadoArq, 'utf8'));
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
  canal.aviso(e, { sessionId: S1, at: iso(h.t), finalTs: iso(h.t), final: FINAL_FIN, nome: 'orca-1' }, TIT);
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
// A conversa S1 fechada (o mensageiro nao acha a aba), com a origem dada (null = nenhuma), e a fala do dono em cima do
// chamado dela: devolve o id da fala.
async function falaPraFechada(h, origem = { app: 'orca' }) {
  conversa(h);
  const tela = await chamadoNaTela(h);
  mexer(h, (e) => { e.origens = origem ? { [S1]: { ...origem, em: iso(h.t) } } : {}; });
  h.mortas.add(S1);
  const id = await falarTg(h, 'sim, manda', tela);
  h.mortas.delete(S1);
  return id;
}
const firmar = async (h) => {
  await h.p.passoSessoes();
  h.t += 10 * 1000;
  await h.p.passoSessoes();
};

// ---------- reabrir no Orca (contrato 3) ----------

// Mac-testes (A): os testes marcados com SO_WINDOWS conferem a premissa do Windows (caminho X:\, .exe, wscript/.vbs,
// cmd.exe, APPDATA/LOCALAPPDATA, pipe \\.\pipe, barra invertida na frase, PowerShell, VS Code/Orca abertos pelo
// porteiro); fora do win32 eles pulam. O caminho do Mac tem os testes proprios em tests/mac-*.test.mjs.
const SO_WINDOWS = process.platform !== 'win32' && 'premissa do Windows (o Mac tem os tests/mac-*)';

test('T21b 1. fala pra conversa fechada com origem Orca e o Orca aberto: abrirNoOrca(pasta, nome, {retomar: sid}), escondida nao; o item da espera tem orca: true e o log diz "no Orca"', async () => {
  const h = montar();
  await falaPraFechada(h);
  assert.equal(h.nOrcaAberto, 1, 'o Orca e consultado 1 vez');
  assert.equal(h.orcas.length, 1);
  const [pasta, nome, retomada] = h.orcas[0];
  assert.equal(nome, TIT);
  assert.deepEqual(retomada, { retomar: S1 });
  assert.deepEqual(h.escondidas, [], 'a escondida nao e chamada');
  const itens = estado(h).reaberturas;
  assert.equal(itens.length, 1);
  assert.equal(itens[0].orca, true);
  assert.equal(itens[0].de, S1);
  assert.equal(itens[0].para, S1);
  assert.equal(itens[0].pasta, pasta, 'a mesma pasta que foi pro Orca');
  assert.equal(path.resolve(pasta).toLowerCase(), path.resolve(h.pasta).toLowerCase(), 'a pasta da conversa');
  assert.equal(itens[0].pedidos.length, 1, 'a fala espera a aba voltar');
  assert.equal(comLog(h, `reabrir: a aba ${S1} fechou; retomando a mesma conversa no Orca em `), 1);
});

test('T21b 2. origem Orca e o Orca fechado (false, valor que nao e true, ou orcaAberto que rejeita): a escondida e chamada; abrirNoOrca nao; nenhum orca no item', async () => {
  for (const aberto of [false, 1, 'sim', null, 'lanca']) {
    const h = montar();
    h.orcaAberto = aberto;
    await falaPraFechada(h);
    const quem = JSON.stringify(aberto);
    assert.equal(h.nOrcaAberto, 1, quem);
    assert.deepEqual(h.orcas, [], quem);
    assert.equal(h.escondidas.length, 1, quem);
    assert.deepEqual(h.escondidas[0][2], { retomar: S1 }, quem);
    const itens = estado(h).reaberturas;
    assert.equal(itens.length, 1, quem);
    assert.equal(Object.hasOwn(itens[0], 'orca'), false, quem);
    assert.equal(comLog(h, 'no Orca'), 0, quem);
    assert.equal(comLog(h, 'vai escondida'), 0, quem);
    assert.equal(comLog(h, `reabrir: a aba ${S1} fechou; retomando a mesma conversa em `), 1, quem);
  }
});

test('T21b 3. origem Orca, Orca aberto e abrirNoOrca que rejeita: 1 linha "vai escondida" e a escondida; as duas falhando = a mesma frase de problema de hoje (sem Orca)', async () => {
  const h = montar();
  h.orcaFalha = 'orca.exe saiu com 1';
  await falaPraFechada(h);
  assert.equal(h.orcas.length, 1);
  assert.equal(h.escondidas.length, 1);
  assert.deepEqual(h.escondidas[0], [h.orcas[0][0], TIT, { retomar: S1 }], 'a escondida com os mesmos argumentos');
  assert.equal(comLog(h, `reabrir: o Orca nao abriu a aba ${S1} (orca.exe saiu com 1); vai escondida`), 1);
  assert.equal(comLog(h, `reabrir: a aba ${S1} fechou; retomando a mesma conversa em `), 1);
  const itens = estado(h).reaberturas;
  assert.equal(itens.length, 1);
  assert.equal(Object.hasOwn(itens[0], 'orca'), false);

  // as duas falham: o que sai pro dono e igual ao de hoje (sem o Orca), e nenhum item
  const enviosDaFala = async (comOrca) => {
    const x = montar({ orca: comOrca });
    x.orcaFalha = 'orca.exe saiu com 1';
    x.escondidaFalha = true;
    conversa(x);
    const tela = await chamadoNaTela(x);
    if (comOrca) mexer(x, (e) => { e.origens = { [S1]: { app: 'orca', em: iso(x.t) } }; });
    x.mortas.add(S1);
    const marca = x.tg.chamadas.length;
    await falarTg(x, 'sim, manda', tela);
    assert.equal(estado(x).reaberturas.length, 0);
    assert.equal(comLog(x, `reabrir: a retomada da aba ${S1} falhou`), 1);
    const v = estado(x).tg.chamados[S1].versao; // a frase de problema vai no chamado (como no tests/porteiro-t8, T8 6)
    return { frase: [v.estado, v.frase], enviados: x.tg.chamadas.slice(marca).filter((c) => c.metodo === 'enviar').map((c) => c.args[0]) };
  };
  const hoje = await enviosDaFala(false);
  const comOrca = await enviosDaFala(true);
  assert.deepEqual(hoje.frase, ['problema', `Não consegui reabrir a aba ${TIT} no PC.`], 'hoje: a frase de problema no chamado');
  assert.deepEqual(comOrca, hoje);
});

test('T21b 4. sem origem Orca (nenhuma, ou outro app) a escondida e chamada e o orcaAberto NUNCA e consultado; sem as 2 dependencias (ou so com o abrirNoOrca) = a escondida de hoje', async () => {
  for (const origem of [null, { app: 'x' }, { app: 'vscode' }]) {
    const h = montar();
    await falaPraFechada(h, origem);
    const quem = JSON.stringify(origem);
    assert.equal(h.nOrcaAberto, 0, quem);
    assert.deepEqual(h.orcas, [], quem);
    assert.equal(h.escondidas.length, 1, quem);
    assert.equal(Object.hasOwn(estado(h).reaberturas[0], 'orca'), false, quem);
  }
  for (const o of [{ orca: false }, { soAbrir: true }]) {
    const h = montar(o);
    await falaPraFechada(h);
    const quem = JSON.stringify(o);
    assert.deepEqual(h.orcas, [], quem);
    assert.equal(h.nOrcaAberto, 0, quem);
    assert.equal(h.escondidas.length, 1, quem);
    assert.equal(Object.hasOwn(estado(h).reaberturas[0], 'orca'), false, quem);
  }
});

test('T21b 5. a reaberta no Orca firma (cli vivo na pasta, 10 s), a fala e entregue e o e.retomadas nao ganha a entrada; 31 min parada com o dono no PC: o devolverRetomadas nao fecha ela (a escondida de controle fecha)', { skip: SO_WINDOWS }, async () => {
  const cena = async (orcaAberto) => {
    const h = montar();
    h.orcaAberto = orcaAberto;
    const id = await falaPraFechada(h);
    assert.equal(estado(h).reaberturas.length, 1);
    registro(h); // o claude que voltou: `cli`, vivo, na pasta da conversa
    await firmar(h);
    assert.deepEqual(h.entregas.slice(1).map((p) => [p.sessionId, p.nome, p.providerMsgId]), [[S1, TIT, id]]);
    assert.deepEqual(estado(h).reaberturas, []);
    // 31 min parada (statusUpdatedAt depois da entrega) e o dono no PC
    h.t += 32 * MIN;
    registro(h, { parada: 31 * MIN });
    h.idle = 0;
    await h.p.passoMinuto();
    await h.p.passoRetomadas();
    return h;
  };

  const h = await cena(true);
  assert.equal(h.orcas.length, 1);
  assert.deepEqual(h.escondidas, []);
  assert.deepEqual(estado(h).retomadas, {}, 'a do Orca nunca entra no e.retomadas');
  assert.equal(comLog(h, `reabrir: a aba ${S1} voltou (a mesma conversa, no Orca); passando 1 fala(s)`), 1);
  assert.deepEqual(h.mortes, [], 'a aba do Orca nunca e fechada');
  assert.ok(h.vivos.has(ESC));

  // controle: a mesma cena com o Orca fechado (a escondida) grava e fecha
  const c = await cena(false);
  assert.equal(c.escondidas.length, 1);
  assert.equal(comLog(c, `reabrir: a aba ${S1} voltou (a mesma conversa); passando 1 fala(s)`), 1);
  assert.deepEqual(c.mortes, [ESC], 'controle: a escondida fecha');
});

// ---------- as de verdade (spawn/execFile falsos) ----------

// spawn falso: grava cada chamada; cada filho segue o proximo `modo` ({codigo, saida} | 'erro' | 'nada'), no proximo tique.
function spawnOrcaFalso(modos = []) {
  const chamadas = [];
  const fn = (cmd, args, opts) => {
    const filho = new EventEmitter();
    filho.stdout = new EventEmitter();
    filho.morto = false;
    filho.kill = () => { filho.morto = true; };
    chamadas.push({ cmd, args, opts, filho });
    const modo = modos.length ? modos.shift() : { codigo: 0, saida: '{"ok":true,"terminal":{"handle":"t-1"}}\n' };
    setImmediate(() => {
      if (modo === 'nada') return;
      if (modo === 'erro') {
        filho.emit('error', Object.assign(new Error('spawn orca.exe ENOENT'), { code: 'ENOENT' }));
        filho.emit('close', -4058, null);
        return;
      }
      if (modo.saida) {
        const meio = Math.floor(modo.saida.length / 2); // em 2 pedacos: o stdout e juntado
        filho.stdout.emit('data', Buffer.from(modo.saida.slice(0, meio)));
        filho.stdout.emit('data', Buffer.from(modo.saida.slice(meio)));
      }
      filho.emit('close', modo.codigo, null);
    });
    return filho;
  };
  fn.chamadas = chamadas;
  return fn;
}

test('T21b 6. abrirNoOrcaReal e orcaAbertoReal (falsos): caminho e argumentos exatos, env sem ELECTRON_RUN_AS_NODE e as herdadas; nome/uuid/pasta ruins e orca.exe ausente rejeitam sem spawn; saida ruim rejeita; tasklist com "Orca.exe" = true', { skip: SO_WINDOWS }, async () => {
  assert.equal(typeof abrirNoOrcaReal, 'function', 'abrirNoOrcaReal exportada');
  assert.equal(typeof orcaAbertoReal, 'function', 'orcaAbertoReal exportada');
  const env = {
    LOCALAPPDATA: 'C:\\Users\\Ana Souza\\AppData\\Local', PATH: 'x', CLAUDE_CODE_SESSION_ID: 'S', CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', VSCODE_IPC_HOOK_CLI: 'pipe-velho', ELECTRON_RUN_AS_NODE: '1',
    electron_run_as_node: '1',
  };
  const exe = 'C:\\Users\\Ana Souza\\AppData\\Local\\Programs\\orca\\resources\\bin\\orca.exe';
  const vistos = [];
  const existe = (p) => { vistos.push(p); return true; };

  // com nome: letra do disco maiuscula, titulo = o nome, -n entre aspas
  let sp = spawnOrcaFalso();
  await abrirNoOrcaReal({ spawn: sp, env, existe })('c:\\projetos\\sessoes-wpp', TIT, { retomar: S1 });
  assert.deepEqual(vistos, [exe]);
  assert.equal(sp.chamadas.length, 1);
  assert.equal(sp.chamadas[0].cmd, exe);
  assert.deepEqual(sp.chamadas[0].args, ['terminal', 'create', '--worktree', 'path:C:\\projetos\\sessoes-wpp', '--title', TIT,
    '--command', `claude -n "${TIT}" --resume ${S1}`, '--json']);
  const o = sp.chamadas[0].opts;
  assert.equal(o.windowsHide, true);
  assert.equal(o.shell, false);
  assert.equal(o.env.PATH, 'x');
  for (const k of ['ELECTRON_RUN_AS_NODE', 'electron_run_as_node', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'VSCODE_IPC_HOOK_CLI']) {
    assert.equal(Object.hasOwn(o.env, k), false, k);
  }
  // pasta com espaco vai inteira (sem shell, o Node poe as aspas)
  sp = spawnOrcaFalso();
  await abrirNoOrcaReal({ spawn: sp, env, existe })('D:\\Meus Docs\\trabalho\\Area', TIT, { retomar: S1 });
  assert.equal(sp.chamadas[0].args[3], 'path:D:\\Meus Docs\\trabalho\\Area');
  // sem nome: titulo 'Claude', sem -n
  for (const semNome of [null, undefined, '']) {
    sp = spawnOrcaFalso();
    await abrirNoOrcaReal({ spawn: sp, env, existe })('C:\\projetos', semNome, { retomar: S1 });
    assert.deepEqual(sp.chamadas[0].args.slice(4, 8), ['--title', 'Claude', '--command', `claude --resume ${S1}`], String(semNome));
  }

  // nome ruim, uuid ruim, pasta ruim: rejeita sem spawn
  const ruins = [
    ...['a$b', 'a`b', 'a!b', "a'b", 'a\\b', 'a"b', 'a%b', ' Teste', 'Teste ', 'a\nb', 'x'.repeat(61), 7].map((n) => ['C:\\projetos', n, { retomar: S1 }]),
    ...[{ retomar: 'nao-e-uuid' }, null, undefined, 'x', [S1], { retomar: S1, novo: S1 }, { novo: S1 }].map((r) => ['C:\\projetos', TIT, r]),
    ...['', '   ', null, 'C:\\a"b', 'C:\\a%b', 'C:\\a\nb'].map((p) => [p, TIT, { retomar: S1 }]),
  ];
  for (const [p, n, r] of ruins) {
    const sp2 = spawnOrcaFalso();
    await assert.rejects(abrirNoOrcaReal({ spawn: sp2, env, existe })(p, n, r), Error, JSON.stringify([p, n, r]));
    assert.equal(sp2.chamadas.length, 0, JSON.stringify([p, n, r]));
  }

  // orca.exe ausente: sem LOCALAPPDATA (nem consulta o disco), existe false ou que lanca = rejeita sem spawn
  for (const [e2, ex] of [[{ PATH: 'x' }, existe], [{ ...env, LOCALAPPDATA: '' }, existe], [env, () => false], [env, () => { throw new Error('EPERM'); }]]) {
    const sp2 = spawnOrcaFalso();
    const antes = vistos.length;
    await assert.rejects(abrirNoOrcaReal({ spawn: sp2, env: e2, existe: ex })('C:\\projetos', TIT, { retomar: S1 }), /orca\.exe nao encontrado/);
    assert.equal(sp2.chamadas.length, 0);
    if (!e2.LOCALAPPDATA) assert.equal(vistos.length, antes, 'sem LOCALAPPDATA nao consulta o disco');
  }

  // saidas ruins rejeitam; prazo encerra o filho; spawn que lanca rejeita
  for (const [modo, re] of [
    [{ codigo: 0, saida: '{"ok":false}' }, /ok diferente de true/],
    [{ codigo: 0, saida: '{"ok":"true"}' }, /ok diferente de true/],
    [{ codigo: 0, saida: 'Error: Orca is not running' }, /sem JSON legivel/],
    [{ codigo: 0, saida: '' }, /sem JSON legivel/],
    [{ codigo: 0, saida: '[{"ok":true}]' }, /sem JSON legivel/],
    [{ codigo: 1, saida: '{"ok":true}' }, /saiu com 1/],
    ['erro', /ENOENT/],
    ['nada', /nao saiu em/],
  ]) {
    const sp3 = spawnOrcaFalso([modo]);
    await assert.rejects(abrirNoOrcaReal({ spawn: sp3, env, existe, prazoMs: 30 })('C:\\projetos', TIT, { retomar: S1 }), re, JSON.stringify(modo));
    assert.equal(sp3.chamadas.length, 1, JSON.stringify(modo));
    if (modo === 'nada') assert.equal(sp3.chamadas[0].filho.morto, true, 'pendurado: o orca.exe e encerrado');
  }
  await assert.rejects(abrirNoOrcaReal({ spawn: () => { throw new Error('spawn EINVAL'); }, env, existe })('C:\\projetos', TIT, { retomar: S1 }), /EINVAL/);

  // orcaAbertoReal: o tasklist exato; "Orca.exe" no comeco da linha (sem caixa) = true; o resto e erro = false
  const execFalso = (resposta) => {
    const chamadas = [];
    const fn = (cmd, args, opts, cb) => {
      chamadas.push({ cmd, args, opts });
      if (resposta === 'lanca') throw new Error('spawn EINVAL');
      setImmediate(() => (resposta instanceof Error ? cb(resposta, '', '') : cb(null, resposta, '')));
    };
    fn.chamadas = chamadas;
    return fn;
  };
  const ex = execFalso('"Orca.exe","123","Console","1","210.000 K"\r\n"Orca.exe","456","Console","1","90.000 K"\r\n');
  assert.equal(await orcaAbertoReal({ execFile: ex })(), true);
  assert.equal(ex.chamadas.length, 1);
  assert.equal(ex.chamadas[0].cmd, 'tasklist');
  assert.deepEqual(ex.chamadas[0].args, ['/FI', 'IMAGENAME eq Orca.exe', '/NH', '/FO', 'CSV']);
  assert.equal(ex.chamadas[0].opts.windowsHide, true);
  assert.equal(ex.chamadas[0].opts.timeout, 10000);
  for (const [resposta, esperado] of [
    ['"orca.exe","123","Console","1","1 K"\r\n', true],
    ['\r\n"ORCA.EXE","9","Console","1","1 K"', true],
    ['INFO: No tasks are running which match the specified criteria.\r\n', false],
    ['"OrcaHelper.exe","123","Console","1","1 K"\r\n', false],
    ['', false],
    [new Error('tasklist nao saiu'), false],
    ['lanca', false],
  ]) {
    assert.equal(await orcaAbertoReal({ execFile: execFalso(resposta) })(), esperado, String(resposta));
  }
});
