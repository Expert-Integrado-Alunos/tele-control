// Testes da T44 (PLANO-TELEGRAM.md, "T44"; caso real, 13/11/2026: duas abas com o mesmo nome interno, a copia de uma
// conversa ou o nome automatico que o Claude Code repete, e o porteiro recusava a fala pedindo pra renomear uma delas).
// Agora o nome repetido nao barra a entrega: o mensageiro devolve as linhas do nome, o porteiro manda uma conferencia de
// endereco pra uma linha, ve em qual conversa ela caiu e entrega a fala na linha certa (`nome [ref]`).
// - T44 1: o par de mesmo nome, a conferencia cai na OUTRA aba: a fala vai pra linha que sobrou; a resposta sai como hoje.
// - T44 2: a conferencia cai na propria aba; a linha parada e a preferida; a linha ocupada (recado no meio da vez) vale.
// - T44 3: o endereco fica guardado: a 2a fala ja sai dirigida, sem conferencia; a aba que reiniciou sai pela linha que
//   sobrou; as duas reiniciadas = confere de novo.
// - T44 4: a lista e as sessoes vivas nao batem (a janela recarregando): espera 90 s e tenta 1 vez; continua = recusa.
//   Sem as linhas = a recusa de sempre, na hora.
// - T44 5: 60 s sem a conferencia aparecer = recusa com os titulos das abas; o endereco que chega atrasado e aprendido.
// - T44 6: o fim da vez que a conferencia abriu e calado (nada no Telegram, o chamado e a pergunta da aba intactos); o da
//   aba ocupada e o da vez seguinte seguem como hoje; transcript atrasado = o parou espera e depois e calado ou solto.
// - T44 7: 3 abas = 2 conferencias; a central e a aba que nao recebe recado nunca sao conferidas; a faxina do estado.
// - T44 8: nome unico = nada muda; estado de antes sem as chaves.
// - T44 9: a linha do endereco saiu da lista: esquece o endereco; pelo nome so se nenhuma outra aba viva tem o nome.
// - T44 10: a 2a fala pro mesmo nome com a conferencia no ar espera o resultado dela (1 conferencia so).
// - T44 11: o porteiro religado com a conferencia em voo: ela nunca vira nova tentativa de fala; o prazo decide.
// - T44 12: a trava no meio: nenhuma frase, nenhuma entrega.
// - T44 13: pelo fonte, o `rodar` passa ao mensageiro a pasta dos registros (de onde saem as linhas do duplicado).
// - T44 14: a linha conferida saiu da lista: a conferencia vence e a fala volta pelo nome; os limites de voltas.
// - T44 15: 2 nomes repetidos ao mesmo tempo; a conferencia que venceu nao junta fala; a frente da fila; a 2a tentativa.
// - T44 16: o endereco e do processo (pid e inicio); o pedido com outro nome; nenhuma sessao viva na leitura.
// - T44 17: a lista que nao bate de outros jeitos (ref repetido; menos linhas que abas).
// - T44 18: os tetos do estado (200 enderecos, 20 conferencias).
// - T44 19: o parou com a conferencia em voo; o parou de antes dela; a conferencia que nunca saiu.
// - T44 20: o resultado da conferencia nunca e resultado de fala (o erro do claude -p dela nao vira nova tentativa).
// - T44 21: as abas do nome mudaram com a conferencia no ar (outra abriu; a da fala reiniciou): a lista velha nao vale.
// - T44 22: so o 1o final da aba depois da conferencia e o da vez dela: a resposta a fala que chega com o registro da
//   vez ainda fora do arquivo (transcript atrasado) nao e calada; a continuacao por hook do final calado segue calada.
// Isolamento: como o tests/porteiro-t43.test.mjs (pastas temporarias via SESSOES_WPP_DIR, CLAUDE_SESSIONS_DIR,
// CLAUDE_PROJECTS_DIR e SESSOES_WPP_LOG; dubles de tg, wpp e mensageiro; relogio e `dormir` falsos; `pidVivo` falso:
// nenhum processo de verdade e consultado). O mensageiro falso faz o que o `claude -p` faz com a lista de sessoes
// (`h.lista`): pelo nome conta as linhas; com `ref` entrega so naquela linha; a conferencia grava o recado no transcript
// da dona da linha.
// Rodar: node --test --test-reporter=tap "tests/porteiro-t44.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { criarPorteiro, FRASES } from '../porteiro.mjs';
import { NUMERO_DONO } from './lib/dados-whatsapp.mjs';
import { CENTRAL_TESTE, RAIZES_TESTE } from './lib/dados-central.mjs';
import { montarConferencia, montarRecado } from '../mensageiro.mjs';

const require = createRequire(import.meta.url);
const lib = require('../hooks/lib/sessoes-wpp.js');
const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');

const SEG = 1000;
const MIN = 60 * SEG;
const T0 = Date.parse('2026-09-29T15:00:00Z'); // 12:00 em Brasilia
const iso = (ms) => new Date(ms).toISOString();
const DONO = 700100200;
const BOT = 700900800;
const DAVI = { nome: 'Davi', artigo: 'o' };
const NOME = 'projetos-42'; // o nome interno que as abas repetem
const [S1, S2, S3] = ['S1', 'S2', 'S3'];
const [RA, RB, RC, RD, RE] = ['a1a1a1', 'b2b2b2', 'c3c3c3', 'd4d4d4', 'e5e5e5'];
// As marcas que a T44 poe no pedido (o resto do pedido nunca muda)
const MARCAS = ['ref', 'conferencia', 'nomesVez', 'nomesEsperou', 'conferidas', 'refCaiu'];
const marcas = (p) => Object.fromEntries(MARCAS.filter((k) => Object.hasOwn(p, k)).map((k) => [k, p[k]]));
const semMarcas = (p) => Object.fromEntries(Object.entries(p).filter(([k]) => !MARCAS.includes(k)));
const CAB = FRASES.travado.split('\n')[0];
const semCab = (frase) => frase.split('\n').slice(1).join('\n');
const PERGUNTA = { final: 'Posso apagar a pasta?', marcas: { decisao: false, fica: false, pergunta: true } };

// ---------- o transcript como o Claude Code grava ----------

const abre = (ts, turnOrigin, content, extra = {}) => ({
  type: 'user', isSidechain: false, timestamp: iso(ts), turnOrigin, message: { role: 'user', content }, ...extra,
});
const teclado = (ts, texto = 'continua') => abre(ts, 'human', [{ type: 'text', text: texto }], { promptSource: 'sdk', origin: { kind: 'human' } });
const embrulho = (texto, de = 'sessoes-wpp-6f') => `Another Claude session sent a message:\n<cross-session-message from="uds:x" from-name="${de}">\n${texto}\n</cross-session-message>`;
// O recado de outra sessao como chega na aba PARADA (abre uma vez so dele) e na OCUPADA (entra no meio da vez)
const naVez = (ts, texto) => abre(ts, 'peer', embrulho(texto), { isMeta: true, promptSource: 'system', origin: { kind: 'peer', from: 'uds:x' } });
const noMeio = (ts, texto) => ({
  type: 'attachment', isSidechain: false, timestamp: iso(ts),
  attachment: { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'peer' }, prompt: embrulho(texto), timestamp: iso(ts) },
});

// ---------- harness (do tests/porteiro-t43.test.mjs) ----------

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

const arqDe = (h, sessionId) => path.join(h.env.CLAUDE_PROJECTS_DIR, 'c--projetos', `${sessionId}.jsonl`);
function transcript(h, sessionId, entradas) {
  fs.mkdirSync(path.dirname(arqDe(h, sessionId)), { recursive: true });
  fs.appendFileSync(arqDe(h, sessionId), entradas.map((x) => `${JSON.stringify(x)}\n`).join(''));
}

// A conferencia chega na conversa da dona da linha: parada = abre uma vez; ocupada = entra no meio da vez. `surda` = nunca
// aparece (aba travada); `atrasada` = o registro so chega no arquivo depois (`chegarAtrasadas`), com a hora em que chegou.
function chegar(h, l, cod) {
  if (l.surda) return;
  const texto = montarConferencia(cod, DAVI);
  const entrada = l.estado === 'busy' ? noMeio(h.t, texto) : naVez(h.t, texto);
  if (l.atrasada) h.atrasadas.push({ sid: l.sessionId, entrada });
  else transcript(h, l.sessionId, [entrada]);
}
function chegarAtrasadas(h) {
  for (const a of h.atrasadas.splice(0)) transcript(h, a.sid, [a.entrada]);
}

// O `claude -p` do mensageiro sobre a lista de sessoes (`h.lista`, na ordem da lista): com `ref` procura a linha
// `nome [ref]` (nao existe = nao achei); pelo nome conta as linhas (0 = nao achei, 1 = enviado, 2+ = duplicado, com as
// linhas). `h.respostas` = resultados combinados, na ordem (null = o da lista).
function rodada(h, p) {
  const combinado = h.respostas.shift();
  if (combinado) return combinado;
  const doNome = h.lista.filter((l) => l.nome === p.nome);
  if (p.ref !== undefined) {
    const l = doNome.find((x) => x.ref === p.ref);
    if (!l) return { status: 'nao_achei', detalhe: '' };
    if (p.conferencia !== undefined) chegar(h, l, p.conferencia);
    return { status: 'enviado', detalhe: '' };
  }
  if (!doNome.length) return { status: 'nao_achei', detalhe: '' };
  if (doNome.length > 1) {
    return { status: 'duplicado', detalhe: '', linhas: doNome.map((l) => ({ ref: l.ref, tipo: 'interactive', estado: l.estado })) };
  }
  return { status: 'enviado', detalhe: '' };
}

function montar({ canalPrincipal } = {}) {
  const raiz = pastaTemp('porteiro-t44-');
  const env = {
    SESSOES_WPP_DIR: path.join(raiz, 'estado'),
    CLAUDE_SESSIONS_DIR: path.join(raiz, 'sessions'),
    CLAUDE_PROJECTS_DIR: path.join(raiz, 'projects'),
    SESSOES_WPP_LOG: path.join(raiz, 'porteiro.log'),
  };
  for (const d of [env.SESSOES_WPP_DIR, env.CLAUDE_SESSIONS_DIR, env.CLAUDE_PROJECTS_DIR]) fs.mkdirSync(d, { recursive: true });
  const h = {
    raiz, env, t: T0, idle: 0, grupo: [], enviados: [], entregas: [], respostas: [], lista: [], atrasadas: [], vivos: new Set(),
    nPid: 0, nUpd: 100, nMid: 7000, pendurar: false,
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
      h.entregas.push(structuredClone(p));
      if (h.pendurar && p.conferencia !== undefined) return new Promise(() => {}); // o `claude -p` que nunca volta
      const r = rodada(h, p);
      // T44 22: o `claude -p` da fala dirigida ja entregou o recado e demora a voltar (`h.soltar()` solta)
      if (h.segurar && p.ref !== undefined && p.conferencia === undefined) await new Promise((ok) => { h.soltar = ok; });
      return r;
    },
  };
  h.tg = dubleTg(h);
  h.opcoes = {
    wpp: h.wpp, numeroDono: NUMERO_DONO, mensageiro: h.mensageiro, ocioso: async () => h.idle, agora: () => h.t, env, abrirCentral: () => {},
    rand: randFixo(), central: CENTRAL_TESTE, raizesSessao: RAIZES_TESTE, tg: h.tg, identTg: { chatId: DONO, botId: BOT },
    dormir: async (ms) => { h.t += ms; }, pidVivo: (pid) => h.vivos.has(Number(pid)),
  };
  if (canalPrincipal) h.opcoes.canalPrincipal = canalPrincipal;
  h.cru = criarPorteiro(h.opcoes);
  h.p = comBomba(h.cru);
  h.t += 1000; // as mensagens dos testes nascem depois do cursor inicial
  return h;
}

// Uma aba viva no VS Code: o registro do processo (pid e procStart proprios), o titulo no transcript e a linha dela na
// lista de sessoes (`ref`; a ordem da lista = a ordem em que as abas abrem).
function abrir(h, sid, titulo, { nome = NOME, ref, estado = 'idle', surda = false, atrasada = false } = {}) {
  h.nPid += 1;
  const pid = 41000 + h.nPid;
  const reg = {
    pid, procStart: String(134353489160000000n + BigInt(h.nPid)), sessionId: sid, cwd: 'c:\\projetos', entrypoint: 'claude-vscode',
    name: nome, nameSource: 'derived', status: estado, updatedAt: h.t,
  };
  fs.writeFileSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${pid}.json`), JSON.stringify(reg));
  h.vivos.add(pid);
  if (!fs.existsSync(arqDe(h, sid))) transcript(h, sid, [{ type: 'custom-title', customTitle: titulo, sessionId: 'x' }]);
  h.lista.push({ nome, ref, sessionId: sid, estado, surda, atrasada, pid });
}
// A aba fecha: o registro, o processo e a linha dela saem
function fechar(h, sid) {
  for (const l of h.lista.filter((x) => x.sessionId === sid && x.pid)) {
    fs.rmSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${l.pid}.json`), { force: true });
    h.vivos.delete(l.pid);
  }
  h.lista = h.lista.filter((x) => x.sessionId !== sid);
}
// A aba reinicia: a mesma conversa, processo novo e linha nova na lista
function reiniciar(h, sid, titulo, o) {
  fechar(h, sid);
  abrir(h, sid, titulo, o);
}
function parou(h, sessionId, o = {}) {
  return {
    v: 1, tipo: 'parou', at: iso(h.t), sessionId, pid: 41000, nome: NOME, titulo: null, cwd: 'C:\\projetos',
    entrypoint: 'claude-vscode', final: 'Feito.', finalTs: iso(h.t), marcas: { decisao: false, fica: false, pergunta: false }, ...o,
  };
}
const evento = (h, ev) => lib.anexarEvento(h.env.SESSOES_WPP_DIR, ev);
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
// Os enderecos guardados: conversa -> ref da linha
const refs = (h) => Object.fromEntries(Object.entries(estado(h).enderecos).map(([k, x]) => [k, x.ref]));
const conferencias = (h) => h.entregas.filter((p) => p.conferencia !== undefined);
const sondagem = (h, cod) => estado(h).sondagens[cod];
// O que o porteiro guarda da aba: a pergunta que espera o dono, o parou guardado e o chamado dela no Telegram
// O registro do processo vivo da aba (o <pid>.json)
const registroDe = (h, sid) => JSON.parse(fs.readFileSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${h.lista.find((l) => l.sessionId === sid).pid}.json`), 'utf8'));
const fotoDe = (h, sid) => {
  const e = estado(h);
  return { ultimo: e.ultimosParou[sid] ?? null, guardado: e.parouGuardado[sid] ?? null, chamado: e.tg.chamados[sid] ?? null };
};

// O par de mesmo nome com os 2 enderecos ja conhecidos: Lume (S2) e a 1a linha da lista, a conferencia cai nela e a
// Faro (S1) sai pela linha que sobrou. -> {h, cod (o da conferencia)}
async function parResolvido() {
  const h = montar();
  abrir(h, S2, 'Lume', { ref: RB });
  abrir(h, S1, 'Faro', { ref: RA });
  ligarTg(h);
  await falarTg(h, 'Faro: manda ver');
  const cod = h.entregas[1].conferencia;
  h.t += 5 * SEG;
  await h.p.passoEventos();
  assert.deepEqual(refs(h), { [S1]: RA, [S2]: RB });
  assert.equal(h.entregas.length, 3);
  h.entregas.length = 0;
  return { h, cod };
}

// ---------- o par de mesmo nome ----------

test('T44 1. duas abas com o mesmo nome interno: a 1a rodada vai pelo nome e volta duplicado com as linhas; o porteiro manda a conferencia de endereco pra 1a linha parada (nenhuma frase: a fala espera), ve que ela caiu na OUTRA aba, guarda os 2 enderecos e entrega a MESMA fala na linha que sobrou; a resposta da aba sai como hoje', async () => {
  const h = montar();
  abrir(h, S2, 'Lume', { ref: RB });
  abrir(h, S1, 'Faro', { ref: RA });
  ligarTg(h);
  const u = await falarTg(h, 'Faro: manda ver');
  assert.equal(h.entregas.length, 2, 'pelo nome e a conferencia');
  assert.deepEqual(marcas(h.entregas[0]), {}, 'a 1a rodada vai pelo nome, como hoje');
  assert.deepEqual([h.entregas[0].sessionId, h.entregas[0].nome, h.entregas[0].texto], [S1, NOME, 'manda ver']);
  const cod = h.entregas[1].conferencia;
  assert.match(cod, /^cf-[0-9a-f]{10}$/);
  assert.deepEqual(h.entregas[1], { sessionId: S1, nome: NOME, ref: RB, conferencia: cod }, 'a conferencia nao leva nada do dono');
  let e = estado(h);
  assert.deepEqual(Object.keys(e.sondagens), [cod]);
  assert.deepEqual([e.sondagens[cod].estado, e.sondagens[cod].nome, e.sondagens[cod].ref], ['aberta', NOME, RB]);
  assert.ok(Number.isFinite(Date.parse(e.sondagens[cod].enviadaEm)), 'o prazo conta do enviado');
  assert.deepEqual(Object.keys(e.sondagens[cod].abas).sort(), [S1, S2]);
  assert.deepEqual(e.filaEntrega, []);
  assert.equal(e.repassar.length, 1, 'a fala espera a conferencia');
  assert.equal(e.repassar[0].sondagem, cod);
  assert.deepEqual(semMarcas(e.repassar[0].pedido), semMarcas(h.entregas[0]));
  assert.deepEqual(e.enderecos, {});
  assert.equal(chamado(h, S1).versao.estado, 'enviando', 'nenhuma frase');
  assert.deepEqual(h.tg.envios(), []);
  assert.deepEqual(h.enviados, [], 'nada no grupo');
  assert.ok(fs.readFileSync(arqDe(h, S2), 'utf8').includes(`id ${cod}`), 'a conferencia caiu na conversa da outra aba');
  assert.ok(!fs.readFileSync(arqDe(h, S1), 'utf8').includes(cod));
  assert.equal(comLog(h, `entregar ${S1}: duplicado`), 1);
  assert.equal(comLog(h, `entregar ${S1} (conferencia ${cod} na linha [${RB}]): enviado`), 1);
  assert.equal(comLog(h, `nome repetido ${NOME}: conferencia de endereco ${cod} pra linha [${RB}]`), 1);
  assert.equal(comLog(h, 'sem providerMsgId'), 0, 'o enviado da conferencia nao e a entrega de uma fala');

  h.t += 5 * SEG;
  await h.p.passoEventos();
  e = estado(h);
  assert.deepEqual(refs(h), { [S1]: RA, [S2]: RB }, 'o da conferencia e o da linha que sobrou');
  assert.deepEqual([e.sondagens[cod].estado, e.sondagens[cod].sessao], ['achada', S2]);
  assert.deepEqual(e.repassar, []);
  assert.equal(h.entregas.length, 3);
  assert.equal(h.entregas[2].ref, RA, 'a fala vai pela linha da aba dela');
  assert.equal(h.entregas[2].conferencia, undefined);
  assert.deepEqual(semMarcas(h.entregas[2]), semMarcas(h.entregas[0]), 'a MESMA fala');
  assert.equal(conferencias(h).length, 1, '1 conferencia so');
  assert.equal(chamado(h, S1).versao.estado, 'entregue');
  assert.equal(comLog(h, `conferencia ${cod}: caiu na aba ${S2}; endereco [${RB}] guardado`), 1);
  assert.equal(comLog(h, `nome repetido ${NOME}: a fala pra aba ${S1} vai pela linha [${RA}]`), 1);
  assert.equal(comLog(h, `entregar ${S1} [${RA}]: enviado`), 1);
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.envios(), [], 'nada no Telegram ate a resposta');

  // a aba recebe o recado e responde: a resposta sai como hoje, em cima da fala dele
  const t = h.t;
  transcript(h, S1, [naVez(t + SEG, montarRecado(h.entregas[2], DAVI))]);
  h.t = t + 20 * SEG;
  evento(h, parou(h, S1, { final: '> Telegram do Davi (12:00): «manda ver»\n\nFeito.' }));
  await h.p.passoEventos();
  await h.p.esperarTelegram(15000);
  const envios = h.tg.envios();
  assert.equal(envios.length, 1, 'a resposta da aba');
  assert.equal(envios[0].responderA, mid(u), 'em cima da fala dele');
  assert.ok(envios[0].html.includes('Feito.'), envios[0].html);
  assert.deepEqual(h.enviados, []);
});

test('T44 2. a conferencia cai na PROPRIA aba da fala: o endereco dela fica guardado e a fala vai pra mesma linha (a outra fica sem endereco: nao precisou); entre as linhas livres a parada e a preferida; so linha ocupada = a conferencia entra no meio da vez dela (queued_command) e vale igual', async () => {
  let h = montar();
  abrir(h, S1, 'Faro', { ref: RA });
  abrir(h, S2, 'Lume', { ref: RB });
  ligarTg(h);
  await falarTg(h, 'Faro: manda ver');
  assert.equal(h.entregas[1].ref, RA, 'a 1a linha livre parada');
  h.t += 5 * SEG;
  await h.p.passoEventos();
  assert.deepEqual(refs(h), { [S1]: RA }, 'so o endereco conferido');
  assert.deepEqual(h.entregas.slice(2).map((p) => [p.sessionId, p.ref]), [[S1, RA]]);
  assert.equal(comLog(h, `nome repetido ${NOME}: a fala pra aba ${S1} vai pela linha [${RA}] (endereco guardado)`), 1);

  // a 1a linha esta ocupada e a 2a parada: a conferencia vai pra parada (abre uma vez curta, nao entra no trabalho)
  h = montar();
  abrir(h, S1, 'Faro', { ref: RA, estado: 'busy' });
  abrir(h, S2, 'Lume', { ref: RB });
  ligarTg(h);
  await falarTg(h, 'Faro: manda ver');
  assert.equal(h.entregas[1].ref, RB, 'a parada');
  h.t += 5 * SEG;
  await h.p.passoEventos();
  assert.deepEqual(refs(h), { [S1]: RA, [S2]: RB });
  assert.deepEqual(h.entregas.slice(2).map((p) => [p.sessionId, p.ref]), [[S1, RA]]);

  // as duas ocupadas: vai pra 1a e o recado entra no meio da vez (o outro formato do registro)
  h = montar();
  abrir(h, S2, 'Lume', { ref: RB, estado: 'busy' });
  abrir(h, S1, 'Faro', { ref: RA, estado: 'busy' });
  ligarTg(h);
  await falarTg(h, 'Faro: manda ver');
  const cod = h.entregas[1].conferencia;
  assert.equal(h.entregas[1].ref, RB);
  assert.ok(fs.readFileSync(arqDe(h, S2), 'utf8').includes('queued_command'));
  h.t += 5 * SEG;
  await h.p.passoEventos();
  assert.deepEqual(refs(h), { [S1]: RA, [S2]: RB });
  assert.equal(sondagem(h, cod).abas[S2].conf.meio, true);
  assert.deepEqual(h.entregas.slice(2).map((p) => [p.sessionId, p.ref]), [[S1, RA]]);
});

test('T44 3. o endereco fica guardado enquanto o processo da aba vive: a 2a fala (pra uma ou pra outra) ja sai dirigida, sem rodada pelo nome e sem conferencia; a aba que reiniciou (processo e linha novos) perde o endereco e sai pela linha que sobrou, sem conferencia; as duas reiniciadas = os enderecos velhos saem e a conferencia roda de novo', async () => {
  const { h } = await parResolvido();
  await falarTg(h, 'Faro: e agora?');
  assert.deepEqual(h.entregas.map((p) => [p.sessionId, p.texto, marcas(p)]), [[S1, 'e agora?', { ref: RA }]], 'ja sai dirigida');
  await falarTg(h, 'Lume: e você?');
  assert.deepEqual(h.entregas.slice(1).map((p) => [p.sessionId, p.texto, marcas(p)]), [[S2, 'e você?', { ref: RB }]]);
  assert.equal(conferencias(h).length, 0);
  assert.equal(chamado(h, S2).versao.estado, 'entregue');

  // a Lume reiniciou: a linha dela na lista e outra
  h.entregas.length = 0;
  reiniciar(h, S2, 'Lume', { ref: RC });
  await falarTg(h, 'Lume: voltou?');
  assert.deepEqual(h.entregas.map((p) => [p.sessionId, marcas(p)]), [[S2, {}], [S2, { ref: RC, nomesVez: 1 }]], 'pelo nome, e a linha que sobrou');
  assert.equal(conferencias(h).length, 0, 'a Faro segue com o endereco dela: nao precisa conferir');
  assert.deepEqual(refs(h), { [S1]: RA, [S2]: RC });
  assert.equal(comLog(h, `nome repetido ${NOME}: a fala pra aba ${S2} vai pela linha [${RC}] (a linha que sobrou)`), 1);

  // as duas reiniciaram: nenhum endereco vale
  h.entregas.length = 0;
  reiniciar(h, S1, 'Faro', { ref: RD });
  reiniciar(h, S2, 'Lume', { ref: RE });
  await falarTg(h, 'Lume: de novo');
  assert.deepEqual(h.entregas.map((p) => [marcas(p).ref ?? null, p.conferencia !== undefined]), [[null, false], [RD, true]], 'confere de novo, na 1a linha');
  assert.deepEqual(refs(h), {}, 'os enderecos dos processos que morreram sairam');
  h.t += 5 * SEG;
  await h.p.passoEventos();
  assert.deepEqual(refs(h), { [S1]: RD, [S2]: RE });
  assert.deepEqual([h.entregas.at(-1).sessionId, h.entregas.at(-1).ref], [S2, RE]);
});

// ---------- o que nao da pra resolver ----------

test('T44 4. a lista e as sessoes vivas nao batem (a janela recarregando: 2 linhas da MESMA aba): nenhuma frase e nenhuma conferencia; a fala espera 90 s e vai pelo nome 1 vez (ainda 1a tentativa: o erro dela tenta de novo); a lista continua torta = a recusa; sem as linhas do nome = a recusa de sempre, na hora', async () => {
  const VELHA = { nome: NOME, ref: RD, sessionId: S1, estado: 'idle' }; // a linha do processo velho da mesma aba
  let h = montar();
  abrir(h, S1, 'Faro', { ref: RA });
  h.lista.push(VELHA);
  ligarTg(h);
  await falarTg(h, 'Faro: manda ver');
  assert.equal(h.entregas.length, 1);
  assert.equal(conferencias(h).length, 0, 'nunca confere com a lista torta');
  assert.equal(chamado(h, S1).versao.estado, 'enviando', 'nenhuma frase');
  let e = estado(h);
  assert.deepEqual(e.sondagens, {});
  assert.equal(e.repassar.length, 1);
  assert.deepEqual(marcas(e.repassar[0].pedido), { nomesVez: 1, nomesEsperou: true });
  assert.equal(e.repassar[0].segunda, false);
  assert.equal(Date.parse(e.repassar[0].naoAntesDe) - h.t, 90 * SEG);
  assert.equal(comLog(h, `nome repetido ${NOME}: a lista (2 linha(s)) e as sessoes vivas (1) nao batem`), 1);
  h.t += 89 * SEG;
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 1, 'antes dos 90 s: espera');
  // o processo velho morreu: a linha dele saiu da lista
  h.lista = h.lista.filter((l) => l !== VELHA);
  h.respostas.push({ status: 'erro', detalhe: 'estourou o tempo' });
  h.t += 2 * SEG;
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 2, 'tenta 1 vez');
  assert.deepEqual(marcas(h.entregas[1]), { nomesVez: 1, nomesEsperou: true }, 'pelo nome');
  assert.equal(chamado(h, S1).versao.estado, 'enviando', 'o erro da 1a tentativa nao vira frase');
  assert.equal(estado(h).repassar.length, 1, 'tenta de novo, como toda 1a tentativa');
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 3);
  assert.equal(chamado(h, S1).versao.estado, 'entregue');

  // a lista continua torta depois dos 90 s: a recusa (so 1 titulo: a frase de sempre)
  h = montar();
  abrir(h, S1, 'Faro', { ref: RA });
  h.lista.push(VELHA);
  ligarTg(h);
  await falarTg(h, 'Faro: manda ver');
  h.t += 91 * SEG;
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 2);
  assert.equal(conferencias(h).length, 0);
  assert.equal(chamado(h, S1).versao.estado, 'problema');
  assert.equal(chamado(h, S1).versao.frase, semCab(FRASES.duplicado(NOME)));
  assert.deepEqual(estado(h).repassar, []);
  h.t += 10 * MIN;
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 2, 'nunca mais tenta sozinho');

  // 2 abas vivas e 3 linhas: a mesma espera; continua = a recusa com os titulos das abas
  h = montar();
  abrir(h, S1, 'Faro', { ref: RA });
  abrir(h, S2, 'Lume', { ref: RB });
  h.lista.push(VELHA);
  ligarTg(h);
  await falarTg(h, 'Faro: manda ver');
  assert.equal(conferencias(h).length, 0);
  assert.equal(chamado(h, S1).versao.estado, 'enviando');
  h.t += 91 * SEG;
  await h.p.passoGrupo();
  assert.equal(conferencias(h).length, 0);
  assert.equal(chamado(h, S1).versao.frase, semCab(FRASES.duplicadoSemEndereco(['Faro', 'Lume'])));

  // o mensageiro nao leu as linhas (sem o registro da rodada): a recusa de sempre, na hora
  // (nenhuma linha, 1 so, ou linhas com o ref fora do formato: nunca viram endereco)
  for (const r of [{ status: 'duplicado', detalhe: '' }, { status: 'duplicado', detalhe: '', linhas: [] }, { status: 'duplicado', detalhe: '', linhas: [{ ref: 'torta' }, null] },
    { status: 'duplicado', detalhe: '', linhas: [{ ref: RA, estado: 'idle' }] }, { status: 'duplicado', detalhe: '', linhas: [{ ref: 'torta' }, { ref: 'XYZ123' }, { ref: 7 }] }]) {
    h = montar();
    abrir(h, S1, 'Faro', { ref: RA });
    abrir(h, S2, 'Lume', { ref: RB });
    ligarTg(h);
    h.respostas.push(r);
    await falarTg(h, 'Faro: manda ver');
    assert.equal(h.entregas.length, 1, JSON.stringify(r));
    assert.equal(chamado(h, S1).versao.estado, 'problema');
    assert.equal(chamado(h, S1).versao.frase, semCab(FRASES.duplicado(NOME)));
    assert.deepEqual([estado(h).repassar, estado(h).sondagens], [[], {}]);
  }
});

test('T44 5. a conferencia nao aparece em conversa nenhuma (aba travada): dentro de 60 s do enviado a fala espera; estourou = a recusa com os titulos das abas, como aparecem no VS Code, e a fala sai da espera; a conferencia que aparece depois (ate 2 h) ensina o endereco calada e a proxima fala ja sai dirigida', async () => {
  assert.equal(FRASES.duplicadoSemEndereco(['Faro', 'Lume']), `${CAB}\nTem duas abas com o mesmo nome interno (Faro e Lume) e não consegui confirmar qual é qual. Dá um nome novo pra uma delas no PC (Rename) e manda de novo.`);
  assert.equal(FRASES.duplicadoSemEndereco(['Faro', 'Faro']), `${CAB}\nTem duas abas chamadas Faro e não consegui confirmar qual é qual. Dá um nome novo pra uma delas no PC (Rename) e manda de novo.`);
  assert.equal(FRASES.duplicadoSemEndereco(['Faro', 'Lume', 'Trio']), `${CAB}\nTem três abas com o mesmo nome interno (Faro, Lume e Trio) e não consegui confirmar qual é qual. Dá um nome novo pra uma delas no PC (Rename) e manda de novo.`);
  assert.ok(FRASES.duplicadoSemEndereco(['A', 'B', 'C', 'D']).includes('Tem 4 abas com o mesmo nome interno (A, B, C e D)'));

  const h = montar();
  abrir(h, S1, 'Faro', { ref: RA, surda: true });
  abrir(h, S2, 'Lume', { ref: RB, surda: true });
  ligarTg(h);
  await falarTg(h, 'Faro: manda ver');
  const cod = h.entregas[1].conferencia;
  assert.equal(h.entregas[1].ref, RA);
  h.t += 59 * SEG;
  await h.p.passoEventos();
  assert.equal(chamado(h, S1).versao.estado, 'enviando', 'dentro do prazo: espera');
  assert.equal(sondagem(h, cod).estado, 'aberta');
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 2, 'a fala que espera a conferencia nao volta sozinha pelo nome');
  h.t += 2 * SEG;
  await h.p.passoEventos();
  assert.equal(chamado(h, S1).versao.estado, 'problema');
  assert.equal(chamado(h, S1).versao.frase, 'Tem duas abas com o mesmo nome interno (Faro e Lume) e não consegui confirmar qual é qual. Dá um nome novo pra uma delas no PC (Rename) e manda de novo.');
  assert.equal(chamado(h, S1).versao.fala, 'manda ver');
  assert.equal(sondagem(h, cod).estado, 'vencida');
  assert.deepEqual(estado(h).repassar, [], 'a fala saiu da espera');
  assert.equal(h.entregas.length, 2, 'nada foi entregue');
  assert.deepEqual(refs(h), {});
  assert.equal(comLog(h, `conferencia ${cod}: 60 s sem aparecer em conversa nenhuma; recusando 1 fala(s)`), 1);
  await h.p.esperarTelegram(15000);
  assert.equal(h.tg.envios().length, 1, 'a recusa notifica');
  assert.deepEqual(h.enviados, []);
  h.t += 10 * MIN;
  await h.p.passoEventos();
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 2, 'a fala recusada nunca volta sozinha');

  // 12 min depois a aba destrava e a conferencia aparece na conversa dela: o endereco e aprendido, calado
  h.tg.zerar();
  h.t += 2 * MIN;
  transcript(h, S1, [naVez(h.t, montarConferencia(cod, DAVI))]);
  h.t += SEG;
  await h.p.passoEventos();
  assert.deepEqual(refs(h), { [S1]: RA });
  assert.deepEqual([sondagem(h, cod).estado, sondagem(h, cod).sessao], ['achada', S1]);
  assert.equal(comLog(h, `conferencia ${cod}: caiu na aba ${S1}; endereco [${RA}] guardado (atrasada)`), 1);
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.envios(), []);
  assert.equal(h.entregas.length, 2);
  await falarTg(h, 'Faro: de novo');
  assert.deepEqual(h.entregas.slice(2).map((p) => [p.sessionId, marcas(p)]), [[S1, { ref: RA }]], 'a proxima ja sai dirigida');
  await falarTg(h, 'Lume: e você?');
  assert.deepEqual(h.entregas.slice(3).map((p) => [p.sessionId, marcas(p)]), [[S2, {}], [S2, { ref: RB, nomesVez: 1 }]], 'e a outra, pela linha que sobrou');
  assert.equal(conferencias(h).length, 1);
});

// ---------- o silencio da conferencia ----------

test('T44 6. o fim da vez que a conferencia abriu e calado: nada no Telegram, nada no grupo, o chamado, a pergunta e o parou guardado da aba ficam como estavam, 1 linha de log; a vez seguinte dela segue como hoje; na aba OCUPADA a conferencia entra no meio da vez e o parou e do trabalho de verdade (segue); o parou repetido da vez calada nao volta', async () => {
  const h = montar({ canalPrincipal: 'telegram' }); // o padrao do produto: o aviso da aba vai pro Telegram
  abrir(h, S2, 'Lume', { ref: RB });
  abrir(h, S1, 'Faro', { ref: RA });
  ligarTg(h);
  await ligarRua(h);
  // a Lume terminou com uma pergunta pra ele: o chamado dela esta de pe no Telegram
  evento(h, parou(h, S2, PERGUNTA));
  await h.p.passoEventos();
  await h.p.esperarTelegram(15000);
  const antes = fotoDe(h, S2);
  assert.equal(antes.ultimo.precisa, true);
  assert.ok(antes.chamado, 'o chamado dela existe');
  h.tg.zerar();
  h.t += MIN;
  await falarTg(h, 'Faro: manda ver');
  const cod = h.entregas[1].conferencia;
  assert.equal(h.entregas[1].ref, RB, 'a conferencia vai pra linha da Lume');
  // a Lume responde "ok" a conferencia: o fim dessa vez nao e trabalho dela
  h.t += 4 * SEG;
  // o ajudante (isSidechain) que roda no meio da vez nao e outra vez da aba
  transcript(h, S2, [{ ...teclado(h.t - SEG, 'sub'), isSidechain: true }]);
  const ok = parou(h, S2, { final: 'ok' });
  evento(h, ok);
  await h.p.passoEventos();
  assert.deepEqual(fotoDe(h, S2), antes, 'a pergunta, o parou guardado e o chamado dela ficam como estavam');
  assert.equal(comLog(h, `parou ${S2}: fim da vez da conferencia de endereco ${cod}; nada no Telegram`), 1);
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.envios(), [], 'nada no Telegram');
  assert.deepEqual(h.tg.de('editar'), []);
  assert.deepEqual(h.tg.de('editarBotoes'), []);
  assert.deepEqual(h.tg.de('apagar'), []);
  assert.deepEqual(h.enviados, []);
  assert.equal(h.entregas.at(-1).ref, RA, 'e a fala foi pra linha certa');
  // o mesmo parou gravado de novo (o gancho repete): nada
  evento(h, ok);
  await h.p.passoEventos();
  assert.deepEqual(fotoDe(h, S2), antes);
  // a vez seguinte dela (ele respondeu no teclado) segue como hoje
  h.t += MIN;
  transcript(h, S2, [teclado(h.t, 'pode')]);
  h.t += 10 * SEG;
  evento(h, parou(h, S2, { final: 'Apaguei.' }));
  await h.p.passoEventos();
  assert.equal(estado(h).ultimosParou[S2].precisa, false, 'o parou de verdade troca a pergunta');
  assert.equal(estado(h).parouGuardado[S2].ev.final, 'Apaguei.');
  assert.equal(comLog(h, 'fim da vez da conferencia de endereco'), 1);

  // aba ocupada: a conferencia entra no meio da vez; o fim dessa vez e do trabalho dela
  const j = montar();
  abrir(j, S2, 'Lume', { ref: RB, estado: 'busy' });
  abrir(j, S1, 'Faro', { ref: RA, estado: 'busy' });
  ligarTg(j);
  await falarTg(j, 'Faro: manda ver');
  j.t += 30 * SEG;
  evento(j, parou(j, S2, { final: 'Terminei o relatório.' }));
  await j.p.passoEventos();
  assert.equal(estado(j).parouGuardado[S2].ev.final, 'Terminei o relatório.', 'segue como hoje');
  assert.equal(comLog(j, 'fim da vez da conferencia de endereco'), 0);

  // a conferencia abriu a vez e uma fala de verdade entrou no meio dela: o fim da vez nao e mais so da conferencia
  const k = montar();
  abrir(k, S2, 'Lume', { ref: RB });
  abrir(k, S1, 'Faro', { ref: RA });
  ligarTg(k);
  await falarTg(k, 'Faro: manda ver');
  k.t += 2 * SEG;
  transcript(k, S2, [noMeio(k.t, 'termina o relatório')]);
  k.t += 20 * SEG;
  evento(k, parou(k, S2, { final: 'Relatório pronto.' }));
  await k.p.passoEventos();
  assert.equal(estado(k).parouGuardado[S2].ev.final, 'Relatório pronto.');
  assert.equal(comLog(k, 'fim da vez da conferencia de endereco'), 0);
  // e o parou de ANTES da conferencia (gravado depois) tambem segue
  const m = montar();
  abrir(m, S2, 'Lume', { ref: RB });
  abrir(m, S1, 'Faro', { ref: RA });
  ligarTg(m);
  const antigo = parou(m, S2, { final: 'Terminei antes.' });
  m.t += 5 * SEG;
  await falarTg(m, 'Faro: manda ver');
  evento(m, antigo);
  await m.p.passoEventos();
  assert.equal(estado(m).parouGuardado[S2].ev.final, 'Terminei antes.');
  assert.equal(comLog(m, 'fim da vez da conferencia de endereco'), 0);
  // o "ok" da conferencia nao virou parou (o gancho de Stop falhou): o 1o final que chega ja e o da vez seguinte, com o
  // registro dela gravado depois de a conferencia ter sido achada; a conversa segue lida e ele segue como hoje
  const n = montar();
  abrir(n, S2, 'Lume', { ref: RB });
  abrir(n, S1, 'Faro', { ref: RA });
  ligarTg(n);
  await falarTg(n, 'Faro: manda ver');
  n.t += 5 * SEG;
  await n.p.passoEventos();
  assert.equal(comLog(n, `caiu na aba ${S2}`), 1, 'a conferencia ja foi achada, sem parou nenhum da aba');
  n.t += MIN;
  transcript(n, S2, [teclado(n.t, 'pode')]);
  n.t += 10 * SEG;
  evento(n, parou(n, S2, { final: 'Apaguei.' }));
  await n.p.passoEventos();
  assert.equal(estado(n).parouGuardado[S2]?.ev.final, 'Apaguei.', 'o 1o final que chega e de outra vez: nao e calado');
  assert.equal(comLog(n, 'fim da vez da conferencia de endereco'), 0);
});

test('T44 6b. transcript atrasado: o parou das abas do nome que chega com a conferencia no ar e sem ela em conversa nenhuma ESPERA (nada muda); a conferencia aparece = o fim da vez dela e calado e o parou da outra aba e solto e segue como hoje; o prazo estoura sem ela aparecer = os parous que esperavam sao soltos', async () => {
  const h = montar();
  abrir(h, S2, 'Lume', { ref: RB, atrasada: true });
  abrir(h, S1, 'Faro', { ref: RA });
  ligarTg(h);
  await falarTg(h, 'Faro: manda ver');
  const cod = h.entregas[1].conferencia;
  assert.ok(!fs.readFileSync(arqDe(h, S2), 'utf8').includes(cod), 'o registro ainda nao chegou no arquivo');
  h.t += 4 * SEG;
  const ok = parou(h, S2, { final: 'ok' });
  evento(h, ok);
  h.t += SEG;
  const outro = parou(h, S1, { final: 'Terminei o que eu fazia.' });
  evento(h, outro);
  await h.p.passoEventos();
  let e = estado(h);
  assert.deepEqual([e.ultimosParou[S2] ?? null, e.ultimosParou[S1] ?? null], [null, null], 'os dois esperam');
  assert.deepEqual(e.sondagens[cod].espera.map((x) => [x.sessionId, x.final]), [[S2, 'ok'], [S1, 'Terminei o que eu fazia.']]);
  assert.equal(comLog(h, `espera a conferencia de endereco ${cod} aparecer`), 2);
  // o mesmo parou de novo enquanto espera: nao entra 2 vezes
  evento(h, ok);
  await h.p.passoEventos();
  assert.equal(sondagem(h, cod).espera.length, 2);
  // o registro chega (com a hora em que a aba recebeu)
  chegarAtrasadas(h);
  h.t += 5 * SEG;
  await h.p.passoEventos();
  e = estado(h);
  assert.equal(e.ultimosParou[S2] ?? null, null, 'o fim da vez da conferencia segue calado');
  assert.equal(e.ultimosParou[S1].finalTs, outro.finalTs, 'o da outra aba foi solto');
  assert.equal(e.parouGuardado[S1].ev.final, 'Terminei o que eu fazia.');
  assert.deepEqual(e.sondagens[cod].espera, []);
  assert.equal(comLog(h, `parou ${S2}: fim da vez da conferencia de endereco ${cod}`), 1);
  assert.equal(h.entregas.at(-1).ref, RA, 'a fala foi entregue');
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.envios(), []);

  // a conferencia nunca aparece: no prazo os parous sao soltos (e a fala e recusada)
  const j = montar();
  abrir(j, S2, 'Lume', { ref: RB, surda: true });
  abrir(j, S1, 'Faro', { ref: RA, surda: true });
  ligarTg(j);
  await falarTg(j, 'Faro: manda ver');
  const cod2 = j.entregas[1].conferencia;
  j.t += 10 * SEG;
  evento(j, parou(j, S2, { final: 'Terminei o meu.' }));
  await j.p.passoEventos();
  assert.equal(estado(j).ultimosParou[S2] ?? null, null);
  assert.equal(sondagem(j, cod2).espera.length, 1);
  j.t += 51 * SEG;
  await j.p.passoEventos();
  assert.equal(estado(j).parouGuardado[S2].ev.final, 'Terminei o meu.', 'solto no prazo');
  assert.deepEqual(sondagem(j, cod2).espera, []);
  assert.equal(chamado(j, S1).versao.estado, 'problema');
  // depois do prazo o parou das abas do nome nao espera mais
  j.t += 30 * SEG;
  evento(j, parou(j, S1, { final: 'Outro fim.' }));
  await j.p.passoEventos();
  assert.equal(estado(j).parouGuardado[S1].ev.final, 'Outro fim.');
});

// ---------- 3 abas, quem nunca e conferido, a faxina ----------

test('T44 7. 3 abas com o mesmo nome = 2 conferencias no pior caso (a 3a sai pela linha que sobrou); a central e a aba que nao recebe recado nunca sao conferidas (a recusa com os titulos, na hora); a faxina: a conferencia achada sai em 10 min, a vencida em 2 h, entrada torta sai e o endereco da aba que fechou sai', async () => {
  let h = montar();
  abrir(h, S3, 'Trio', { ref: RC });
  abrir(h, S2, 'Lume', { ref: RB });
  abrir(h, S1, 'Faro', { ref: RA });
  ligarTg(h);
  await falarTg(h, 'Faro: manda ver');
  assert.deepEqual(conferencias(h).map((p) => p.ref), [RC]);
  h.t += 5 * SEG;
  await h.p.passoEventos();
  assert.deepEqual(refs(h), { [S3]: RC });
  assert.deepEqual(conferencias(h).map((p) => p.ref), [RC, RB], 'faltam 2 abas e 2 linhas: outra conferencia');
  assert.equal(estado(h).repassar.length, 1, 'a fala segue esperando');
  assert.equal(estado(h).repassar[0].pedido.conferidas, 2);
  h.t += 5 * SEG;
  await h.p.passoEventos();
  assert.deepEqual(refs(h), { [S1]: RA, [S2]: RB, [S3]: RC });
  assert.equal(conferencias(h).length, 2, 'nunca a 3a');
  assert.deepEqual([h.entregas.at(-1).sessionId, h.entregas.at(-1).ref, h.entregas.at(-1).texto], [S1, RA, 'manda ver']);
  assert.equal(h.entregas.filter((p) => p.texto === 'manda ver').length, 2, 'pelo nome e a dirigida');
  assert.equal(chamado(h, S1).versao.estado, 'entregue');

  // a central com o mesmo nome interno: nunca recebe conferencia
  h = montar();
  abrir(h, S2, CENTRAL_TESTE.nome, { ref: RB });
  abrir(h, S1, 'Faro', { ref: RA });
  ligarTg(h);
  await falarTg(h, 'Faro: manda ver');
  assert.equal(h.entregas.length, 1);
  assert.equal(conferencias(h).length, 0);
  assert.equal(chamado(h, S1).versao.estado, 'problema');
  assert.equal(chamado(h, S1).versao.frase, semCab(FRASES.duplicadoSemEndereco([CENTRAL_TESTE.nome, 'Faro'])));
  assert.deepEqual([estado(h).repassar, estado(h).sondagens], [[], {}]);
  assert.equal(comLog(h, `nome repetido ${NOME}: a aba ${S2} nao recebe conferencia`), 1);

  // a aba marcada sem recado: tambem nao
  h = montar();
  abrir(h, S2, 'Lume', { ref: RB });
  abrir(h, S1, 'Faro', { ref: RA });
  ligarTg(h);
  mexer(h, (e) => { e.centralSemRecado = { sessionId: S2, desde: iso(h.t) }; });
  await falarTg(h, 'Faro: manda ver');
  assert.equal(conferencias(h).length, 0);
  assert.equal(chamado(h, S1).versao.frase, semCab(FRASES.duplicadoSemEndereco(['Lume', 'Faro'])));

  // a faxina
  const r = await parResolvido();
  h = r.h;
  const boa = structuredClone(sondagem(h, r.cod));
  mexer(h, (e) => {
    e.sondagens['cf-00000000aa'] = { ...boa, estado: 'vencida', sessao: null, achadaEm: null, criadaEm: iso(h.t) };
    e.sondagens['cf-00000000bb'] = { estado: 'aberta' }; // torta
    e.sondagens.lixo = 7;
    const vencida = { ...boa, estado: 'vencida', sessao: null, achadaEm: null, criadaEm: iso(h.t) };
    e.sondagens['fora-do-formato'] = { ...vencida }; // o codigo fora do formato
    e.sondagens['cf-00000000cc'] = { ...vencida, ref: 'zz' }; // o ref da linha torto
    e.sondagens['cf-00000000dd'] = { ...vencida, estado: 'fechada' }; // estado que nao existe
    e.sondagens['cf-00000000ee'] = { ...vencida, linhas: [{ ref: 'zz' }] }; // linha torta
    e.sondagens['cf-00000000ff'] = { ...vencida, abas: { [S1]: { bytes: -1, conf: null, depois: null } } }; // aba torta
    e.enderecos['a b'] = { pid: 1, procStart: null, ref: RC, em: iso(h.t) }; // chave fora do formato
    e.enderecos.S8 = { pid: 1, procStart: null, ref: 'zz', em: iso(h.t) }; // ref torto
    e.enderecos.S9 = { pid: 1, procStart: null, ref: RC }; // sem hora
  });
  await h.p.passoEventos();
  assert.deepEqual(Object.keys(estado(h).sondagens).sort(), ['cf-00000000aa', r.cod].sort(), 'as tortas sairam');
  assert.deepEqual(refs(h), { [S1]: RA, [S2]: RB });
  h.t += 9 * MIN;
  await h.p.passoEventos();
  assert.ok(sondagem(h, r.cod), 'a achada fica 10 min (cala o fim da vez dela)');
  h.t += 2 * MIN;
  await h.p.passoEventos();
  assert.deepEqual(Object.keys(estado(h).sondagens), ['cf-00000000aa'], 'a achada saiu; a vencida fica (a conferencia ainda pode aparecer)');
  h.t += 110 * MIN;
  await h.p.passoEventos();
  assert.deepEqual(estado(h).sondagens, {}, 'a vencida sai em 2 h');
  assert.deepEqual(refs(h), { [S1]: RA, [S2]: RB }, 'o endereco fica enquanto o processo vive');
  // a Lume fechou: na proxima entrega o endereco dela sai; a Faro segue dirigida
  fechar(h, S2);
  await falarTg(h, 'Faro: e agora?');
  assert.deepEqual(h.entregas.map((p) => [p.sessionId, marcas(p)]), [[S1, { ref: RA }]]);
  assert.deepEqual(refs(h), { [S1]: RA });
  h.t += 31 * 24 * 60 * MIN;
  await h.p.passoEventos();
  assert.deepEqual(refs(h), {}, 'e em 30 dias sai de qualquer jeito');
});

test('T44 8. nome unico = nada muda: a fala vai pelo nome, o pedido sem marca nenhuma da T44 e nada no estado; o estado de antes (sem as chaves, ou com elas tortas) = vazio', async () => {
  const h = montar();
  abrir(h, S1, 'Faro', { ref: RA });
  abrir(h, S2, 'Lume', { ref: RB, nome: 'projetos-7' });
  ligarTg(h);
  await falarTg(h, 'Faro: manda ver');
  assert.equal(h.entregas.length, 1);
  assert.deepEqual(marcas(h.entregas[0]), {});
  assert.equal(chamado(h, S1).versao.estado, 'entregue');
  await h.p.passoEventos();
  let e = estado(h);
  assert.deepEqual([e.enderecos, e.sondagens], [{}, {}]);
  assert.equal(comLog(h, 'nome repetido'), 0);
  assert.equal(comLog(h, 'conferencia'), 0);
  for (const torto of [(x) => { delete x.enderecos; delete x.sondagens; }, (x) => { x.enderecos = []; x.sondagens = 'x'; }, (x) => { x.enderecos = null; x.sondagens = 7; }]) {
    mexer(h, torto);
    await h.p.passoEventos();
    e = estado(h);
    assert.deepEqual([e.enderecos, e.sondagens], [{}, {}]);
    await falarTg(h, 'Faro: de novo');
    assert.deepEqual(marcas(h.entregas.at(-1)), {});
  }
});

// ---------- a linha do endereco saiu da lista ----------

test('T44 9. a entrega dirigida nao acha a linha (nao achei): o endereco e esquecido; com outra aba viva de mesmo nome NUNCA tenta pelo nome (cairia na aba errada): o "Não achei" de sempre, e a proxima fala resolve pela lista nova; sem outra aba com o nome = 1 tentativa pelo nome; a 2a queda do ref da mesma fala = o "Não achei" de sempre', async () => {
  let { h } = await parResolvido();
  h.lista.find((l) => l.sessionId === S1).ref = RD; // a linha dela mudou
  await falarTg(h, 'Faro: e agora?');
  assert.deepEqual(h.entregas.map(marcas), [{ ref: RA }], 'nenhuma tentativa pelo nome');
  assert.equal(chamado(h, S1).versao.estado, 'problema');
  assert.equal(chamado(h, S1).versao.frase, semCab(FRASES.naoAchei('Faro')));
  assert.deepEqual(refs(h), { [S2]: RB }, 'o endereco que falhou saiu');
  assert.equal(comLog(h, `a linha [${RA}] da aba ${S1} saiu da lista`), 1);
  h.entregas.length = 0;
  await falarTg(h, 'Faro: de novo');
  assert.deepEqual(h.entregas.map(marcas), [{}, { ref: RD, nomesVez: 1 }], 'a lista nova resolve pela linha que sobrou');
  assert.deepEqual(refs(h), { [S1]: RD, [S2]: RB });

  // a outra aba fechou (o nome ficou unico) e a linha da Faro mudou: 1 tentativa pelo nome
  ({ h } = await parResolvido());
  fechar(h, S2);
  h.lista.find((l) => l.sessionId === S1).ref = RD;
  await falarTg(h, 'Faro: e agora?');
  assert.deepEqual(h.entregas.map(marcas), [{ ref: RA }, { refCaiu: true }]);
  assert.equal(chamado(h, S1).versao.estado, 'entregue');
  assert.deepEqual(refs(h), {});
  const base = semMarcas(h.entregas[0]);

  // a fala cujo ref ja caiu 1 vez e cai de novo (o endereco guardado vale pelo processo, mas a linha nao existe): nenhuma
  // outra tentativa
  h.entregas.length = 0;
  const reg = registroDe(h, S1);
  mexer(h, (e) => {
    e.enderecos[S1] = { pid: reg.pid, procStart: reg.procStart, ref: RA, em: iso(h.t) };
    e.filaEntrega.push({ id: 'q-teste', tipo: 'repasse', pedido: { ...base, providerMsgId: 'tg-u777', refCaiu: true } });
  });
  await bombear(h.cru);
  assert.deepEqual(h.entregas.map(marcas), [{ ref: RA, refCaiu: true }]);
  assert.deepEqual(estado(h).filaEntrega, []);
  assert.deepEqual(estado(h).repassar, []);
  assert.deepEqual(refs(h), {}, 'o endereco saiu de novo');
  assert.equal(comLog(h, `problema da fala pra aba ${S1} vai pro chamado dela`), 1);

  // o ref que veio no pedido sem endereco guardado (a copia de um pedido, a aba que reiniciou) nunca vale: sai pelo nome
  h.entregas.length = 0;
  h.lista.find((l) => l.sessionId === S1).ref = RA;
  mexer(h, (e) => { e.filaEntrega.push({ id: 'q-teste2', tipo: 'repasse', pedido: { ...base, providerMsgId: 'tg-u778', ref: RC } }); });
  await bombear(h.cru);
  assert.deepEqual(h.entregas.map(marcas), [{}]);
  assert.equal(estado(h).entregas['tg-u778'].sessionId, S1);
});

// ---------- mais de uma fala, religar, trava ----------

test('T44 10. a 2a fala pro mesmo nome com a conferencia no ar: nenhuma conferencia nova; as duas esperam o resultado e saem dirigidas na ordem em que chegaram', async () => {
  const h = montar();
  abrir(h, S2, 'Lume', { ref: RB, atrasada: true });
  abrir(h, S1, 'Faro', { ref: RA });
  ligarTg(h);
  await falarTg(h, 'Faro: primeira');
  await falarTg(h, 'Lume: segunda');
  assert.equal(conferencias(h).length, 1, '1 conferencia so');
  const cod = conferencias(h)[0].conferencia;
  let e = estado(h);
  assert.deepEqual(e.repassar.map((x) => [x.pedido.sessionId, x.pedido.texto, x.sondagem]), [[S1, 'primeira', cod], [S2, 'segunda', cod]]);
  assert.deepEqual(Object.keys(e.sondagens), [cod]);
  chegarAtrasadas(h);
  h.t += 5 * SEG;
  await h.p.passoEventos();
  e = estado(h);
  assert.deepEqual(e.repassar, []);
  assert.deepEqual(h.entregas.slice(-2).map((p) => [p.sessionId, p.texto, p.ref]), [[S1, 'primeira', RA], [S2, 'segunda', RB]]);
  assert.equal(conferencias(h).length, 1);
  assert.deepEqual([chamado(h, S1).versao.estado, chamado(h, S2).versao.estado], ['entregue', 'entregue']);
});

test('T44 11. o porteiro religado com a conferencia em voo: o item sai da fila sem virar nova tentativa de fala (a conferencia nunca e mandada como recado do dono) e o prazo dela conta dali; a conferencia que o claude -p orfao entregou e achada e a fala sai dirigida', async () => {
  const h = montar();
  abrir(h, S2, 'Lume', { ref: RB });
  abrir(h, S1, 'Faro', { ref: RA });
  ligarTg(h);
  h.pendurar = true;
  h.tg.lotes.push([msgTg(h, 'Faro: manda ver')]);
  await h.cru.esperarTelegram(15000);
  await h.cru.passoEntrega(); // pelo nome, em voo
  await tique();
  await h.cru.passoEntrega(); // duplicado aplicado; a conferencia sai e fica em voo
  await tique();
  let e = estado(h);
  const cod = Object.keys(e.sondagens)[0];
  assert.deepEqual(e.filaEntrega.map((q) => [q.tipo, q.codigo, typeof q.emVooDesde]), [['sondagem', cod, 'string']]);
  assert.equal(e.sondagens[cod].enviadaEm, null);
  await h.cru.passoEventos();
  assert.equal(sondagem(h, cod).estado, 'aberta', 'em voo: o prazo nem comecou e ela ainda esta na fila');
  // o porteiro morre e sobe de novo
  h.pendurar = false;
  h.t += 10 * SEG;
  h.cru = criarPorteiro(h.opcoes);
  h.p = comBomba(h.cru);
  await h.cru.passoEntrega();
  e = estado(h);
  assert.deepEqual(e.filaEntrega, []);
  assert.deepEqual(e.repassar.map((x) => [x.sondagem, x.pedido.conferencia ?? null, x.pedido.texto]), [[cod, null, 'manda ver']], 'so a fala que espera');
  assert.ok(Number.isFinite(Date.parse(e.sondagens[cod].enviadaEm)), 'o prazo conta');
  assert.equal(conferencias(h).length, 1, 'a conferencia nao sai de novo');
  // o claude -p orfao tinha entregado
  transcript(h, S2, [naVez(h.t, montarConferencia(cod, DAVI))]);
  h.t += 5 * SEG;
  await h.p.passoEventos();
  assert.deepEqual(refs(h), { [S1]: RA, [S2]: RB });
  assert.deepEqual([h.entregas.at(-1).sessionId, h.entregas.at(-1).ref, h.entregas.at(-1).texto], [S1, RA, 'manda ver']);
  assert.equal(conferencias(h).length, 1);
});

test('T44 12. a trava com a conferencia no ar: a fala que esperava sai com o resto da fila; nenhuma frase e nenhuma entrega depois, nem quando o prazo estoura ou a conferencia aparece', async () => {
  const h = montar();
  abrir(h, S2, 'Lume', { ref: RB, atrasada: true });
  abrir(h, S1, 'Faro', { ref: RA });
  ligarTg(h);
  await falarTg(h, 'Faro: manda ver');
  const cod = h.entregas[1].conferencia;
  await falarTg(h, 'trava');
  let e = estado(h);
  assert.equal(e.trava, true);
  assert.deepEqual([e.repassar, e.filaEntrega], [[], []]);
  await h.p.esperarTelegram(15000);
  h.tg.zerar();
  chegarAtrasadas(h);
  h.t += 5 * SEG;
  await h.p.passoEventos();
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 2, 'nada e entregue travado');
  assert.deepEqual(refs(h), { [S2]: RB }, 'o endereco e aprendido mesmo assim');
  h.t += 2 * MIN;
  await h.p.passoEventos();
  await h.p.esperarTelegram(15000);
  assert.deepEqual(h.tg.envios(), [], 'nenhuma frase');
  assert.equal(h.entregas.length, 2);
  assert.equal(sondagem(h, cod).estado, 'achada');
});

// ---------- o `rodar`, a linha que some, a fila, o processo, os tetos ----------

test('T44 13. pelo fonte: o rodar do porteiro cria o mensageiro com a mesma pasta dos registros que ele le (de onde saem as linhas do duplicado)', () => {
  const fonte = fs.readFileSync(path.join(REPO, 'porteiro.mjs'), 'utf8');
  // so o corpo do rodar: do "async function rodar(" ate a proxima funcao do topo do arquivo
  const ini = fonte.indexOf('async function rodar(');
  const depois = fonte.slice(ini + 1).search(/\n(?:async )?function /);
  const r = depois === -1 ? fonte.slice(ini) : fonte.slice(ini, ini + 1 + depois);
  assert.ok(ini > 0 && r.includes('log(`subiu (pid'), 'o corpo do rodar');
  assert.ok(r.includes('criarMensageiro({ estadoDir: C.estadoDir, claudeBin: claude, dono, modelo, projectsDir: C.projectsDir })'), 'a pasta dos registros no criarMensageiro');
  assert.equal(r.split('criarMensageiro(').length, 2, '1 mensageiro so');
});

test('T44 14. a linha conferida saiu da lista (o mensageiro devolve nao achei ou duplicado pra conferencia): a conferencia vence e a fala volta pelo nome, na hora; a lista nova resolve; nunca resolve = com 2 abas a fala para depois de 2 conferencias, com 3 abas depois de 3 voltas pelo nome, sempre com a recusa dos titulos', async () => {
  const NA = { status: 'nao_achei', detalhe: '' };
  for (const ruim of [NA, { status: 'duplicado', detalhe: '', linhas: [] }]) {
    const h = montar();
    abrir(h, S2, 'Lume', { ref: RB });
    abrir(h, S1, 'Faro', { ref: RA });
    ligarTg(h);
    h.respostas.push(null, ruim); // pelo nome = o da lista; a 1a conferencia = a linha nao existe mais
    await falarTg(h, 'Faro: manda ver');
    assert.deepEqual(h.entregas.map((p) => [marcas(p).ref ?? null, p.conferencia !== undefined]), [[null, false], [RB, true], [null, false], [RB, true]], ruim.status);
    const [c1, c2] = conferencias(h).map((p) => p.conferencia);
    assert.notEqual(c1, c2);
    assert.deepEqual([sondagem(h, c1).estado, sondagem(h, c2).estado], ['vencida', 'aberta']);
    assert.equal(comLog(h, `conferencia ${c1}: a linha [${RB}] saiu da lista (${ruim.status}); 1 fala(s) voltam pelo nome`), 1);
    assert.equal(chamado(h, S1).versao.estado, 'enviando', 'nenhuma frase');
    h.t += 5 * SEG;
    await h.p.passoEventos();
    assert.deepEqual(refs(h), { [S1]: RA, [S2]: RB });
    assert.deepEqual([h.entregas.at(-1).sessionId, h.entregas.at(-1).texto, marcas(h.entregas.at(-1))], [S1, 'manda ver', { ref: RA, nomesVez: 2, conferidas: 2 }]);
    assert.equal(chamado(h, S1).versao.estado, 'entregue');
  }

  // a linha conferida nunca existe: com 2 abas a fala espera no maximo 2 conferencias
  let h = montar();
  abrir(h, S2, 'Lume', { ref: RB });
  abrir(h, S1, 'Faro', { ref: RA });
  ligarTg(h);
  h.respostas.push(null, NA, null, NA);
  await falarTg(h, 'Faro: manda ver');
  assert.equal(conferencias(h).length, 2);
  assert.equal(h.entregas.length, 5, '3 voltas pelo nome e 2 conferencias');
  assert.equal(chamado(h, S1).versao.estado, 'problema');
  assert.equal(chamado(h, S1).versao.frase, semCab(FRASES.duplicadoSemEndereco(['Lume', 'Faro'])));
  assert.deepEqual([estado(h).repassar, estado(h).filaEntrega], [[], []]);
  assert.equal(comLog(h, `nome repetido ${NOME}: a fala pra aba ${S1} ja esperou 2 conferencia(s); recusando`), 1);

  // com 3 abas: 3 conferencias, e a 4a volta pelo nome e a recusa
  h = montar();
  abrir(h, S3, 'Trio', { ref: RC });
  abrir(h, S2, 'Lume', { ref: RB });
  abrir(h, S1, 'Faro', { ref: RA });
  ligarTg(h);
  h.respostas.push(null, NA, null, NA, null, NA);
  await falarTg(h, 'Faro: manda ver');
  assert.equal(conferencias(h).length, 3);
  assert.equal(h.entregas.length, 7);
  assert.equal(chamado(h, S1).versao.frase, semCab(FRASES.duplicadoSemEndereco(['Trio', 'Lume', 'Faro'])));
  assert.deepEqual([estado(h).repassar, estado(h).filaEntrega], [[], []]);
  assert.equal(comLog(h, `nome repetido ${NOME}: a fala pra aba ${S1} ja voltou 3 vezes pelo nome; recusando`), 1);
});

test('T44 15. dois nomes repetidos ao mesmo tempo = uma conferencia por nome; a conferencia que venceu nao junta fala nova (abre outra); a fala resolvida volta pra FRENTE da fila (a ordem das falas da aba nao muda) e continua sendo 2a tentativa se ja era', async () => {
  const OUTRO = 'outro-9';
  let h = montar();
  abrir(h, S2, 'Lume', { ref: RB, atrasada: true });
  abrir(h, S1, 'Faro', { ref: RA });
  abrir(h, 'S4', 'Vela', { nome: OUTRO, ref: RC, atrasada: true });
  abrir(h, 'S5', 'Remo', { nome: OUTRO, ref: RD });
  ligarTg(h);
  await falarTg(h, 'Faro: um');
  await falarTg(h, 'Remo: dois');
  assert.deepEqual(conferencias(h).map((p) => [p.nome, p.ref]), [[NOME, RB], [OUTRO, RC]], 'cada nome com a conferencia dele');
  const cods = conferencias(h).map((p) => p.conferencia);
  assert.deepEqual(estado(h).repassar.map((x) => [x.pedido.texto, x.sondagem]), [['um', cods[0]], ['dois', cods[1]]]);
  chegarAtrasadas(h);
  h.t += 5 * SEG;
  await h.p.passoEventos();
  assert.deepEqual(refs(h), { [S1]: RA, [S2]: RB, S4: RC, S5: RD });
  assert.deepEqual(h.entregas.slice(-2).map((p) => [p.sessionId, p.texto, p.ref]), [[S1, 'um', RA], ['S5', 'dois', RD]]);

  // a conferencia que venceu nao junta a fala nova: abre outra
  h = montar();
  abrir(h, S1, 'Faro', { ref: RA, surda: true });
  abrir(h, S2, 'Lume', { ref: RB, surda: true });
  ligarTg(h);
  await falarTg(h, 'Faro: manda ver');
  const c1 = h.entregas[1].conferencia;
  h.t += 61 * SEG;
  await h.p.passoEventos();
  assert.equal(sondagem(h, c1).estado, 'vencida');
  await falarTg(h, 'Faro: outra');
  assert.equal(conferencias(h).length, 2);
  const c2 = conferencias(h)[1].conferencia;
  assert.notEqual(c2, c1);
  assert.deepEqual(estado(h).repassar.map((x) => [x.pedido.texto, x.sondagem]), [['outra', c2]]);

  // a fala resolvida volta pra frente: a fala seguinte pra mesma aba, que ja estava na fila, sai depois dela
  h = montar();
  abrir(h, S2, 'Lume', { ref: RB, atrasada: true });
  abrir(h, S1, 'Faro', { ref: RA });
  ligarTg(h);
  await falarTg(h, 'Faro: primeira');
  const base = semMarcas(h.entregas[0]);
  chegarAtrasadas(h);
  h.t += 5 * SEG;
  mexer(h, (x) => { x.filaEntrega.push({ id: 'q-depois', tipo: 'repasse', pedido: { ...base, texto: 'depois', providerMsgId: 'tg-u900' } }); });
  await h.p.passoEventos();
  assert.deepEqual(h.entregas.slice(2).map((p) => [p.texto, p.ref]), [['primeira', RA], ['depois', RA]]);

  // a fala que ja era 2a tentativa continua sendo depois de resolvida: o erro dela vira a frase (nunca a 3a tentativa)
  h = montar();
  abrir(h, S2, 'Lume', { ref: RB });
  abrir(h, S1, 'Faro', { ref: RA });
  ligarTg(h);
  h.respostas.push({ status: 'erro', detalhe: 'estourou o tempo' });
  await falarTg(h, 'Faro: manda ver');
  assert.equal(estado(h).repassar.length, 1, 'a 1a tentativa deu erro: tenta de novo');
  await h.p.passoGrupo(); // a 2a tentativa: pelo nome, duplicado, a conferencia
  assert.equal(conferencias(h).length, 1);
  assert.equal(estado(h).repassar[0].segunda, true);
  h.respostas.push({ status: 'erro', detalhe: 'estourou o tempo' });
  h.t += 5 * SEG;
  await h.p.passoEventos();
  assert.deepEqual(marcas(h.entregas.at(-1)), { ref: RA, nomesVez: 1, conferidas: 1 }, 'saiu dirigida');
  assert.equal(chamado(h, S1).versao.estado, 'problema', 'o erro da 2a tentativa vira a frase');
  assert.deepEqual(estado(h).repassar, []);
});

// O processo da aba troca sem a conversa mudar (outro pid, ou o mesmo pid com outro inicio: o Windows reusa pid), e a
// linha dela na lista passa a ser outra
function trocarProcesso(h, sid, { pid, procStart, ref }) {
  const l = h.lista.find((x) => x.sessionId === sid);
  const arq = path.join(h.env.CLAUDE_SESSIONS_DIR, `${l.pid}.json`);
  const reg = JSON.parse(fs.readFileSync(arq, 'utf8'));
  fs.rmSync(arq);
  h.vivos.delete(l.pid);
  Object.assign(reg, { pid: pid ?? reg.pid, procStart: procStart ?? reg.procStart });
  fs.writeFileSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${reg.pid}.json`), JSON.stringify(reg));
  h.vivos.add(reg.pid);
  Object.assign(l, { pid: reg.pid, ref });
}

test('T44 16. o endereco e do PROCESSO da aba: o mesmo pid com outro inicio (pid reusado) ou outro pid com o mesmo inicio = o endereco velho sai; o pedido que ficou com outro nome nao leva o endereco; sem sessao viva nenhuma na leitura (a pasta dos registros nao leu) os enderecos ficam', async () => {
  for (const troca of [{ procStart: '134353489169999999' }, { pid: 45001 }]) {
    const { h } = await parResolvido();
    trocarProcesso(h, S2, { ...troca, ref: RC });
    await falarTg(h, 'Lume: voltou?');
    assert.deepEqual(h.entregas.map((p) => [p.sessionId, marcas(p)]), [[S2, {}], [S2, { ref: RC, nomesVez: 1 }]], JSON.stringify(troca));
    assert.deepEqual(refs(h), { [S1]: RA, [S2]: RC });
    assert.equal(chamado(h, S2).versao.estado, 'entregue');
  }

  // o pedido que ficou com o nome velho da aba (ela mudou de nome com a fala na fila): nao leva o endereco
  const { h } = await parResolvido();
  await falarTg(h, 'Faro: e agora?');
  const base = semMarcas(h.entregas[0]);
  h.entregas.length = 0;
  mexer(h, (e) => { e.filaEntrega.push({ id: 'q-nome', tipo: 'repasse', pedido: { ...base, nome: 'nome-velho', providerMsgId: 'tg-u901' } }); });
  await bombear(h.cru);
  assert.deepEqual(h.entregas.map((p) => [p.nome, marcas(p)]), [['nome-velho', {}]]);
  assert.deepEqual(refs(h), { [S1]: RA, [S2]: RB }, 'o endereco da aba segue valendo');

  // a pasta dos registros nao leu (nenhuma sessao viva na leitura): os enderecos ficam e a fala espera a lista bater
  h.entregas.length = 0;
  const fora = path.join(h.raiz, 'sessions-fora');
  fs.renameSync(h.env.CLAUDE_SESSIONS_DIR, fora);
  mexer(h, (e) => { e.filaEntrega.push({ id: 'q-vazio', tipo: 'repasse', pedido: { ...base, providerMsgId: 'tg-u902' } }); });
  await bombear(h.cru);
  fs.renameSync(fora, h.env.CLAUDE_SESSIONS_DIR);
  assert.deepEqual(h.entregas.map(marcas), [{}], 'sem a aba viva na leitura o pedido sai pelo nome');
  assert.deepEqual(refs(h), { [S1]: RA, [S2]: RB }, 'nenhum endereco saiu');
  assert.deepEqual(estado(h).repassar.map((x) => marcas(x.pedido)), [{ nomesVez: 1, nomesEsperou: true }]);
  h.t += 91 * SEG;
  await h.p.passoGrupo();
  assert.deepEqual(marcas(h.entregas.at(-1)), { ref: RA, nomesVez: 1, nomesEsperou: true }, 'e depois sai dirigida, pelo endereco que ficou');
});

test('T44 17. a lista que nao bate de outros jeitos: 2 linhas com o MESMO ref, ou menos linhas que abas vivas com o nome = a mesma espera de 90 s, nunca a conferencia', async () => {
  let h = montar();
  abrir(h, S1, 'Faro', { ref: RA });
  abrir(h, S2, 'Lume', { ref: RB });
  ligarTg(h);
  h.respostas.push({ status: 'duplicado', detalhe: '', linhas: [{ ref: RA, estado: 'idle' }, { ref: RA, estado: 'idle' }] });
  await falarTg(h, 'Faro: manda ver');
  assert.equal(conferencias(h).length, 0);
  assert.deepEqual(estado(h).repassar.map((x) => marcas(x.pedido)), [{ nomesVez: 1, nomesEsperou: true }]);
  assert.equal(chamado(h, S1).versao.estado, 'enviando');

  h = montar();
  abrir(h, S1, 'Faro', { ref: RA });
  abrir(h, S2, 'Lume', { ref: RB });
  abrir(h, S3, 'Trio', { ref: RC });
  h.lista = h.lista.filter((l) => l.sessionId !== S3); // a 3a aba ainda nao apareceu na lista
  ligarTg(h);
  await falarTg(h, 'Faro: manda ver');
  assert.equal(conferencias(h).length, 0);
  assert.deepEqual(estado(h).repassar.map((x) => marcas(x.pedido)), [{ nomesVez: 1, nomesEsperou: true }]);
  assert.equal(comLog(h, `nome repetido ${NOME}: a lista (2 linha(s)) e as sessoes vivas (3) nao batem`), 1);
});

test('T44 18. os tetos do estado: no maximo 200 enderecos e 20 conferencias, os mais novos', async () => {
  const { h, cod } = await parResolvido();
  const boa = structuredClone(sondagem(h, cod));
  mexer(h, (e) => {
    e.enderecos = {};
    e.sondagens = {};
    for (let i = 0; i < 205; i += 1) e.enderecos[`S${1000 + i}`] = { pid: 1, procStart: null, ref: RC, em: iso(h.t - (205 - i) * SEG) };
    for (let i = 0; i < 25; i += 1) {
      e.sondagens[`cf-00000001${String(i).padStart(2, '0')}`] = { ...boa, estado: 'vencida', sessao: null, achadaEm: null, criadaEm: iso(h.t - (25 - i) * SEG) };
    }
  });
  await h.p.passoEventos();
  const e = estado(h);
  assert.deepEqual(Object.keys(e.enderecos).sort(), Array.from({ length: 200 }, (_, i) => `S${1005 + i}`), 'os 200 mais novos');
  assert.deepEqual(Object.keys(e.sondagens).sort(), Array.from({ length: 20 }, (_, i) => `cf-00000001${String(i + 5).padStart(2, '0')}`), 'as 20 mais novas');
});

test('T44 19. o parou e a conferencia que ainda nao apareceu: com ela EM VOO (o claude -p do mensageiro ainda nao voltou) o parou das abas do nome ja espera, e o de antes dela segue na hora; o registro chega = o fim da vez dela e calado; a conferencia que saiu da fila sem nunca ser enviada vence na hora, com a recusa', async () => {
  const h = montar();
  abrir(h, S2, 'Lume', { ref: RB });
  abrir(h, S1, 'Faro', { ref: RA });
  ligarTg(h);
  const antigo = parou(h, S1, { final: 'Terminei antes.' });
  h.t += 5 * SEG;
  h.pendurar = true;
  h.tg.lotes.push([msgTg(h, 'Faro: manda ver')]);
  await h.cru.esperarTelegram(15000);
  await h.cru.passoEntrega(); // pelo nome, em voo
  await tique();
  await h.cru.passoEntrega(); // duplicado aplicado; a conferencia sai e fica em voo
  await tique();
  const cod = Object.keys(estado(h).sondagens)[0];
  assert.equal(estado(h).sondagens[cod].enviadaEm, null);
  // a Lume ja recebeu e respondeu "ok": o claude -p ainda nao voltou e o registro dela ainda nao chegou no arquivo
  const chegou = h.t;
  h.t += 4 * SEG;
  evento(h, parou(h, S2, { final: 'ok' }));
  evento(h, antigo);
  await h.cru.passoEventos();
  let e = estado(h);
  assert.deepEqual(e.sondagens[cod].espera.map((x) => [x.sessionId, x.final]), [[S2, 'ok']], 'o da vez da conferencia espera; o de antes dela nao');
  assert.equal(e.parouGuardado[S1].ev.final, 'Terminei antes.');
  assert.equal(e.ultimosParou[S2] ?? null, null);
  // o registro chega: o fim da vez da conferencia e calado
  transcript(h, S2, [naVez(chegou, montarConferencia(cod, DAVI))]);
  h.t += SEG;
  await h.cru.passoEventos();
  e = estado(h);
  assert.equal(e.ultimosParou[S2] ?? null, null);
  assert.deepEqual(e.sondagens[cod].espera, []);
  assert.equal(comLog(h, `parou ${S2}: fim da vez da conferencia de endereco ${cod}`), 1);
  assert.deepEqual(refs(h), { [S1]: RA, [S2]: RB });

  // a conferencia que saiu da fila sem nunca ser enviada (o porteiro caiu e a fila se perdeu): vence na hora, com a recusa
  const j = montar();
  abrir(j, S2, 'Lume', { ref: RB });
  abrir(j, S1, 'Faro', { ref: RA });
  ligarTg(j);
  j.pendurar = true;
  j.tg.lotes.push([msgTg(j, 'Faro: manda ver')]);
  await j.cru.esperarTelegram(15000);
  await j.cru.passoEntrega();
  await tique();
  await j.cru.passoEntrega();
  await tique();
  const cod2 = Object.keys(estado(j).sondagens)[0];
  mexer(j, (x) => { x.filaEntrega = []; });
  j.pendurar = false;
  j.cru = criarPorteiro(j.opcoes);
  j.p = comBomba(j.cru);
  await j.p.passoEventos();
  assert.equal(sondagem(j, cod2).estado, 'vencida');
  assert.equal(chamado(j, S1).versao.estado, 'problema');
  assert.equal(chamado(j, S1).versao.frase, semCab(FRASES.duplicadoSemEndereco(['Lume', 'Faro'])));
  assert.deepEqual(estado(j).repassar, []);
  assert.equal(comLog(j, `conferencia ${cod2}: saiu da fila sem ser enviada; recusando 1 fala(s)`), 1);
});

test('T44 20. o resultado da conferencia nunca e resultado de fala: o claude -p dela deu erro (estourou o tempo depois de mandar) = nada volta pra fila como nova tentativa, o prazo conta dali e a conversa onde ela caiu decide', async () => {
  const h = montar();
  abrir(h, S2, 'Lume', { ref: RB });
  abrir(h, S1, 'Faro', { ref: RA });
  ligarTg(h);
  h.respostas.push(null, { status: 'erro', detalhe: 'estourou o tempo' }); // pelo nome = o da lista; a conferencia = erro
  await falarTg(h, 'Faro: manda ver');
  assert.equal(h.entregas.length, 2, 'pelo nome e a conferencia');
  const cod = h.entregas[1].conferencia;
  let e = estado(h);
  assert.equal(e.sondagens[cod].estado, 'aberta');
  assert.ok(Number.isFinite(Date.parse(e.sondagens[cod].enviadaEm)), 'o prazo conta do resultado, mesmo com erro');
  assert.deepEqual(e.repassar.map((x) => [x.pedido.texto ?? null, x.sondagem ?? null]), [['manda ver', cod]], 'so a fala que espera: a conferencia nao vira tentativa');
  assert.deepEqual(e.filaEntrega, []);
  assert.equal(chamado(h, S1).versao.estado, 'enviando', 'nenhuma frase');
  await h.p.passoGrupo();
  assert.equal(h.entregas.length, 2, 'a conferencia nao sai de novo');
  // o recado saiu mesmo assim (o claude -p estourou depois de mandar): a conversa onde ele caiu decide
  transcript(h, S2, [naVez(h.t, montarConferencia(cod, DAVI))]);
  h.t += 5 * SEG;
  await h.p.passoEventos();
  e = estado(h);
  assert.deepEqual(refs(h), { [S1]: RA, [S2]: RB });
  assert.deepEqual(e.repassar, []);
  assert.equal(h.entregas.length, 3);
  assert.deepEqual([h.entregas[2].sessionId, h.entregas[2].texto, marcas(h.entregas[2])], [S1, 'manda ver', { ref: RA, nomesVez: 1, conferidas: 1 }]);
  assert.equal(chamado(h, S1).versao.estado, 'entregue');
});

test('T44 21. as abas do nome mudaram com a conferencia no ar: a lista de quando ela saiu nao vale mais; a conferencia ainda ensina o endereco da aba em que caiu e a fala volta pelo nome, pra lista nova (outra aba abriu = outra conferencia; a aba da fala reiniciou = a linha nova dela, a que sobrou)', async () => {
  // outra aba com o mesmo nome abriu
  let h = montar();
  abrir(h, S2, 'Lume', { ref: RB, atrasada: true });
  abrir(h, S1, 'Faro', { ref: RA });
  ligarTg(h);
  await falarTg(h, 'Faro: manda ver');
  assert.deepEqual(conferencias(h).map((p) => p.ref), [RB]);
  abrir(h, S3, 'Trio', { ref: RC });
  chegarAtrasadas(h);
  h.t += 5 * SEG;
  await h.p.passoEventos();
  assert.equal(comLog(h, `nome repetido ${NOME}: as abas do nome mudaram desde a conferencia; 1 fala(s) voltam pelo nome`), 1);
  assert.deepEqual(h.entregas.map((p) => [marcas(p).ref ?? null, p.conferencia !== undefined]), [[null, false], [RB, true], [null, false], [RA, true]], 'pelo nome de novo, e a conferencia da lista nova');
  assert.deepEqual(refs(h), { [S2]: RB }, 'o endereco da aba em que a 1a conferencia caiu ficou');
  h.t += 5 * SEG;
  await h.p.passoEventos();
  assert.deepEqual(refs(h), { [S1]: RA, [S2]: RB });
  assert.deepEqual([h.entregas.at(-1).sessionId, h.entregas.at(-1).texto, marcas(h.entregas.at(-1))], [S1, 'manda ver', { ref: RA, nomesVez: 2, conferidas: 2 }]);
  assert.equal(h.entregas.length, 5);
  assert.equal(chamado(h, S1).versao.estado, 'entregue');

  // a aba da fala reiniciou (a mesma conversa, outro processo e outra linha): as mesmas 2 abas, mas nao o mesmo processo
  h = montar();
  abrir(h, S2, 'Lume', { ref: RB, atrasada: true });
  abrir(h, S1, 'Faro', { ref: RA });
  ligarTg(h);
  await falarTg(h, 'Faro: manda ver');
  reiniciar(h, S1, 'Faro', { ref: RC });
  chegarAtrasadas(h);
  h.t += 5 * SEG;
  await h.p.passoEventos();
  assert.equal(comLog(h, `nome repetido ${NOME}: as abas do nome mudaram desde a conferencia; 1 fala(s) voltam pelo nome`), 1);
  assert.deepEqual(h.entregas.map((p) => [marcas(p).ref ?? null, p.conferencia !== undefined]), [[null, false], [RB, true], [null, false], [RC, false]], 'nunca a linha velha [a1a1a1]');
  assert.deepEqual(refs(h), { [S1]: RC, [S2]: RB });
  assert.deepEqual([h.entregas.at(-1).sessionId, h.entregas.at(-1).texto, marcas(h.entregas.at(-1))], [S1, 'manda ver', { ref: RC, nomesVez: 2, conferidas: 1 }]);
  assert.equal(chamado(h, S1).versao.estado, 'entregue');
});

test('T44 22. so o 1o final da aba depois da conferencia e o da vez dela: a conferencia caiu na PROPRIA aba da fala e o "ok" dela e calado (a continuacao por hook desse final tambem); a resposta a fala chega com o registro da vez dela ainda FORA do arquivo (transcript atrasado) e NAO e calada: fica guardada e, quando o claude -p da fala volta, sai em cima da fala dele; depois que um final passou, nem a continuacao por hook e calada; o final de ANTES da conferencia gravado depois nao conta como final de depois dela', async () => {
  const h = montar();
  abrir(h, S1, 'Faro', { ref: RA });
  abrir(h, S2, 'Lume', { ref: RB });
  ligarTg(h);
  const antigo = parou(h, S1, { final: 'Terminei antes.' });
  h.t += 5 * SEG;
  const u = await falarTg(h, 'Faro: manda ver');
  const cod = h.entregas[1].conferencia;
  assert.equal(h.entregas[1].ref, RA, 'a conferencia vai pra linha da propria aba da fala');
  // a Faro responde "ok" a conferencia: calado. A fala vai sair dirigida e o claude -p dela demora a voltar
  h.segurar = true;
  h.t += 4 * SEG;
  evento(h, parou(h, S1, { final: 'ok' }));
  await h.cru.passoEventos();
  assert.equal(comLog(h, `parou ${S1}: fim da vez da conferencia de endereco ${cod}`), 1);
  // o final de ANTES da conferencia gravado depois (a releitura da T7k): segue como hoje e nao conta como final de depois dela
  evento(h, antigo);
  await h.cru.passoEventos();
  assert.equal(estado(h).parouGuardado[S1].ev.final, 'Terminei antes.');
  // outro gancho de Stop segurou a aba na vez da conferencia: a continuacao do mesmo final segue calada
  h.t += SEG;
  evento(h, parou(h, S1, { final: 'ok.', continuacao: true }));
  await h.cru.passoEventos();
  assert.equal(comLog(h, 'fim da vez da conferencia de endereco'), 2, 'a continuacao do final calado');
  assert.equal(estado(h).parouGuardado[S1].ev.final, 'Terminei antes.', 'nenhum final de depois dela passou ainda');
  await h.cru.passoEntrega(); // a fala dirigida sai e fica em voo
  await tique();
  assert.deepEqual(h.entregas.slice(2).map((p) => [p.sessionId, p.ref]), [[S1, RA]]);
  // a fala chegou na aba e ela respondeu em 3 s: o registro dessa vez ainda nao esta no arquivo quando o parou chega
  const chegada = h.t + SEG;
  h.t += 4 * SEG;
  const final = '> Telegram do Davi (12:00): «manda ver»\n\nFeito.';
  evento(h, parou(h, S1, { final }));
  await h.cru.passoEventos();
  assert.equal(comLog(h, 'fim da vez da conferencia de endereco'), 2, 'a resposta a fala nao e calada');
  assert.equal(estado(h).parouGuardado[S1].ev.final, final, 'fica guardada');
  // um final dela ja passou: a continuacao por hook (agora da vez da fala) tambem nao e calada, com o registro ainda fora
  h.t += 2 * SEG;
  const completo = `${final} E conferi.`;
  evento(h, parou(h, S1, { final: completo, continuacao: true }));
  await h.cru.passoEventos();
  assert.equal(comLog(h, 'fim da vez da conferencia de endereco'), 2, 'nem a continuacao, depois que um final passou');
  assert.equal(estado(h).parouGuardado[S1].ev.final, completo);
  // o registro chega no arquivo e o claude -p da fala volta: a resposta sai em cima da fala dele
  transcript(h, S1, [naVez(chegada, montarRecado(h.entregas.at(-1), DAVI))]);
  h.t += SEG;
  h.segurar = false;
  h.soltar();
  await tique();
  await bombear(h.cru);
  await h.p.esperarTelegram(15000);
  const respostas = h.tg.envios().filter((x) => x.responderA === mid(u));
  assert.equal(respostas.length, 1, JSON.stringify(h.tg.envios()));
  assert.ok(respostas[0].html.includes('E conferi.'), respostas[0].html);
});
