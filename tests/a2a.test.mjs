// Testes da A2a (PLANO-ABERTO.md, "A2a — valores"): o WhatsApp pelos valores do config.json.
// Por que existe: o grupo, as 2 instancias (envio e conferencia) e os 2 numeros (dono e robo) saem do codigo e passam a
// vir do bloco `whatsapp` do config.json, pra copia aberta servir a qualquer pessoa com o grupo dela; sem o bloco
// completo e o `ligado: true` o WhatsApp fica desligado (o padrao do produto e o Telegram). Valor trocado aqui = mensagem
// pro lugar errado ou OK de quem nao e o dono; por isso cada caminho tem teste.
// Isolamento: pastas temporarias (prefixo "a2a-"); wpp ou fetch dublados; nas linhas de comando, HOME temporaria com um
// ~/.claude.json de teste e o fetch trocado por um duble que grava as chamadas num arquivo (nada sai da maquina). Dados
// do WhatsApp sinteticos (tests/lib/dados-whatsapp.mjs). Nada de rede, chave real, config.json real nem porteiro rodando.
// Os modulos entram por `import * as`: funcao que ainda nao existe deixa so o teste dela vermelho.
// Rodar: node --test --test-reporter=tap "tests/a2a.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pastaTemp } from './lib/pasta-temp.cjs';
import * as config from '../lib/config.mjs';
import * as wppMod from '../wpp.mjs';
import * as porteiro from '../porteiro.mjs';
import * as okWpp from '../ok-wpp.mjs';
import {
  GRUPO, INSTANCIA_ENVIO, INSTANCIA_CONFERENCIA, NUMERO_DONO, NUMERO_ROBO, WHATSAPP, DESTINO_WPP,
} from './lib/dados-whatsapp.mjs';
import { CENTRAL_TESTE, RAIZES_TESTE } from './lib/dados-central.mjs';

const OK_WPP = fileURLToPath(new URL('../ok-wpp.mjs', import.meta.url));
const LER_GRUPO = fileURLToPath(new URL('../ler-grupo.mjs', import.meta.url));
const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-14T18:00:00Z'); // 15:00 em Brasilia
const iso = (ms) => new Date(ms).toISOString();
const CAMPOS = ['grupo', 'instanciaEnvio', 'instanciaConferencia', 'numeroDono', 'numeroRobo'];
const OUTRO_NUMERO = '5500900000003'; // um terceiro (sintetico)
const URL_A = 'https://a.invalid/mcp';
const URL_B = 'https://b.invalid/mcp';
const CHAVE_FALSA = `AA${'b'.repeat(33)}`; // montada na hora: nunca uma chave de verdade
const SEM_NUMEROS = 'WhatsApp sem numeroDono ou numeroRobo no config';
const IDENT_DESLIGADA = {
  ligado: false, motivo: 'desligado no config', mcp: 'whatsapp-agent',
  grupo: null, instanciaEnvio: null, instanciaConferencia: null, numeroDono: null, numeroRobo: null,
};

const logsDe = (arq) => {
  try { return fs.readFileSync(arq, 'utf8').split('\n').filter(Boolean); } catch { return []; }
};

// ---------- 1-3. config ----------

test('A2a 1. identidadeWhatsapp: ligado so com whatsapp.ligado === true e os 5 campos no formato; o motivo diz o que falta (so o nome do campo); mcp ruim = whatsapp-agent; cfg ruim = desligado', () => {
  const { identidadeWhatsapp } = config;
  assert.deepEqual(identidadeWhatsapp({ whatsapp: WHATSAPP }), {
    ligado: true, motivo: null, mcp: 'whatsapp-agent', grupo: GRUPO, instanciaEnvio: INSTANCIA_ENVIO,
    instanciaConferencia: INSTANCIA_CONFERENCIA, numeroDono: NUMERO_DONO, numeroRobo: NUMERO_ROBO,
  });
  // os limites de cada formato valem
  const limites = {
    grupo: `${'1'.repeat(10)}-group`, instanciaEnvio: 'a', instanciaConferencia: `A_z.0-${'x'.repeat(58)}`,
    numeroDono: '1'.repeat(10), numeroRobo: '9'.repeat(15),
  };
  const lim = identidadeWhatsapp({ whatsapp: { ...WHATSAPP, ...limites } });
  assert.equal(lim.ligado, true, JSON.stringify(lim));
  for (const c of CAMPOS) assert.equal(lim[c], limites[c], c);
  assert.equal(identidadeWhatsapp({ whatsapp: { ...WHATSAPP, grupo: `${'1'.repeat(30)}-group` } }).ligado, true, '30 digitos');
  // mcp: o do config, senao whatsapp-agent (nunca desliga)
  assert.equal(identidadeWhatsapp({ whatsapp: { ...WHATSAPP, mcp: 'wpp_2.b-c' } }).mcp, 'wpp_2.b-c');
  for (const mcp of [undefined, null, '', 'a b', 'x'.repeat(65), 7, 'ação', ['whatsapp-agent']]) {
    const r = identidadeWhatsapp({ whatsapp: { ...WHATSAPP, mcp } });
    assert.deepEqual([r.mcp, r.ligado], ['whatsapp-agent', true], JSON.stringify(mcp));
  }
  // cada campo fora do formato (ou ausente): desligado, o motivo nomeia so ele, null so nele, os outros seguem
  const ruins = {
    grupo: [undefined, null, '', '123456789-group', `${'1'.repeat(31)}-group`, NUMERO_DONO, ` ${GRUPO}`, `${GRUPO}\n`,
      '120300000000000001@g.us', 'abc-group', 120300000000000001],
    instanciaEnvio: [undefined, null, '', 'a b', 'x'.repeat(65), 'ação', 'a/b', 5, true],
    instanciaConferencia: [undefined, null, '', 'a b', 'x'.repeat(65), 'ação', 'a\\b', {}],
    numeroDono: [undefined, null, '', '123456789', '1234567890123456', `+${NUMERO_DONO}`, '55 00 900000001',
      `${NUMERO_DONO}\n`, 5500900000001, '55009000000a1'],
    numeroRobo: [undefined, null, '', '123456789', '1234567890123456', `+${NUMERO_ROBO}`, 5500900000002],
  };
  for (const [campo, valores] of Object.entries(ruins)) {
    for (const v of valores) {
      const w = { ...WHATSAPP, [campo]: v };
      if (v === undefined) delete w[campo];
      const r = identidadeWhatsapp({ whatsapp: w });
      const nome = `${campo} = ${JSON.stringify(v)}`;
      assert.deepEqual([r.ligado, r.motivo, r[campo]], [false, `falta ou fora do formato: ${campo}`, null], nome);
      for (const outro of CAMPOS.filter((c) => c !== campo)) assert.equal(r[outro], WHATSAPP[outro], `${nome}: ${outro} segue`);
    }
  }
  // varios: todos no motivo, na ordem fixa; o motivo nunca cita valor
  assert.equal(identidadeWhatsapp({ whatsapp: { ligado: true } }).motivo, `falta ou fora do formato: ${CAMPOS.join(', ')}`);
  const dois = identidadeWhatsapp({ whatsapp: { ...WHATSAPP, numeroRobo: '5500 9', grupo: '99-group' } });
  assert.equal(dois.motivo, 'falta ou fora do formato: grupo, numeroRobo');
  for (const v of [NUMERO_DONO, '5500 9', '99-group', INSTANCIA_ENVIO]) assert.ok(!dois.motivo.includes(v), v);
  // sem o true: desligado no config (os campos seguem lidos); o desligado vence o campo ruim
  for (const ligado of [false, undefined, null, 'true', 1, 'sim']) {
    const w = { ...WHATSAPP, ligado };
    if (ligado === undefined) delete w.ligado;
    const r = identidadeWhatsapp({ whatsapp: w });
    assert.deepEqual([r.ligado, r.motivo, r.grupo, r.numeroDono], [false, 'desligado no config', GRUPO, NUMERO_DONO], JSON.stringify(ligado));
  }
  assert.equal(identidadeWhatsapp({ whatsapp: { ligado: false, grupo: 'x' } }).motivo, 'desligado no config');
  // cfg ruim: tudo desligado e null
  for (const cfg of [{}, null, undefined, 42, 'x', [], [{ whatsapp: WHATSAPP }], { whatsapp: null }, { whatsapp: [] },
    { whatsapp: [WHATSAPP] }, { whatsapp: true }, { whatsapp: 'ligado' }, { telegram: { ligado: true } }]) {
    assert.deepEqual(identidadeWhatsapp(cfg), IDENT_DESLIGADA, JSON.stringify(cfg));
  }
});

test('A2a 2. whatsappLigado = identidadeWhatsapp(cfg).ligado: sem o bloco (o padrao do produto) = desligado; ligado true sem os campos = desligado; o bloco completo = ligado', () => {
  const { whatsappLigado, identidadeWhatsapp } = config;
  assert.equal(whatsappLigado({ whatsapp: WHATSAPP }), true);
  for (const cfg of [{}, null, { telegram: { ligado: true } }, { whatsapp: {} }, { whatsapp: { ligado: true } },
    { whatsapp: { ...WHATSAPP, ligado: false } }, { whatsapp: { ...WHATSAPP, numeroDono: 'x' } }, { whatsapp: { ...WHATSAPP, ligado: 'true' } }]) {
    assert.equal(whatsappLigado(cfg), false, JSON.stringify(cfg));
    assert.equal(identidadeWhatsapp(cfg).ligado, false, JSON.stringify(cfg));
  }
});

test('A2a 3. lerConfigTelegram: canalPrincipal sem valor = telegram (o padrao do produto); o do config vale; config ausente ou ruim = telegram e desligado', () => {
  const dir = pastaTemp('a2a-cfgtg-');
  const gravar = (cfg) => fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));
  assert.deepEqual(porteiro.lerConfigTelegram(dir), { canalPrincipal: 'telegram', ligado: false }, 'sem config.json');
  assert.deepEqual(porteiro.lerConfigTelegram(undefined), { canalPrincipal: 'telegram', ligado: false }, 'sem pasta');
  gravar({ telegram: { ligado: true } });
  assert.deepEqual(porteiro.lerConfigTelegram(dir), { canalPrincipal: 'telegram', ligado: true }, 'sem canalPrincipal');
  gravar({ canalPrincipal: 'whatsapp', telegram: { ligado: true } });
  assert.deepEqual(porteiro.lerConfigTelegram(dir), { canalPrincipal: 'whatsapp', ligado: true });
  gravar({ canalPrincipal: 'sms', telegram: { ligado: true } });
  assert.deepEqual(porteiro.lerConfigTelegram(dir), { canalPrincipal: 'telegram', ligado: false }, 'tipo errado = o padrao');
});

// ---------- 4-6. wpp.mjs ----------

function claudeJson(dir, servidores) {
  const arq = path.join(dir, '.claude.json');
  fs.writeFileSync(arq, JSON.stringify({ mcpServers: servidores }));
  return arq;
}

// fetch dublado: grava {url, headers, name, args} e devolve `resposta(name, args)` no formato do MCP.
function dubleFetch(resposta) {
  const chamadas = [];
  async function fetch(url, opts) {
    const corpo = JSON.parse(opts.body);
    chamadas.push({ url, headers: opts.headers, name: corpo.params.name, args: corpo.params.arguments });
    const out = resposta(corpo.params.name, corpo.params.arguments);
    const texto = JSON.stringify({ jsonrpc: '2.0', id: corpo.id, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } });
    return { ok: true, status: 200, text: async () => texto };
  }
  return { fetch, chamadas };
}
const respostaPadrao = (name) => {
  if (name === 'read') return { ok: true, messages: [] };
  if (name === 'zapi_action') return { ok: true, result: { participants: [{ phone: NUMERO_DONO }, { phone: NUMERO_ROBO }] } };
  return { ok: true, provider_msg_id: 'P1', message_id: 'U1' };
};

test('A2a 4. wppDoClaudeJson le a entrada pedida (padrao whatsapp-agent); sem ela = lanca sem citar url nem chave', () => {
  const dir = pastaTemp('a2a-claudejson-');
  const arq = claudeJson(dir, {
    'whatsapp-agent': { url: URL_A, headers: { Authorization: `Bearer ${CHAVE_FALSA}` } },
    'wpp-teste': { url: URL_B },
  });
  assert.deepEqual(wppMod.wppDoClaudeJson(arq), { url: URL_A, headers: { Authorization: `Bearer ${CHAVE_FALSA}` } });
  assert.deepEqual(wppMod.wppDoClaudeJson(arq, 'wpp-teste'), { url: URL_B, headers: {} });
  assert.throws(() => wppMod.wppDoClaudeJson(arq, 'outro-mcp'), (e) => {
    assert.match(e.message, /outro-mcp sem url/);
    for (const x of [URL_A, URL_B, CHAVE_FALSA]) assert.ok(!e.message.includes(x), x);
    return true;
  });
});

test('A2a 5. criarWpp: o grupo e as 2 instancias vem de quem cria; faltou ou fora do formato = lanca na criacao, sem chamada e sem citar valor; envio, leitura e membros pela de envio; so { conferencia: true } le pela de conferencia', async () => {
  const d = dubleFetch(respostaPadrao);
  const base = { url: URL_A, headers: { Authorization: `Bearer ${CHAVE_FALSA}` }, fetch: d.fetch };
  const ruins = [['grupo', undefined], ['grupo', ''], ['grupo', NUMERO_DONO], ['grupo', `${GRUPO} `], ['instanciaEnvio', undefined],
    ['instanciaEnvio', 'a b'], ['instanciaConferencia', undefined], ['instanciaConferencia', ''], ['instanciaConferencia', 7]];
  for (const [campo, v] of ruins) {
    const destino = { ...DESTINO_WPP, [campo]: v };
    if (v === undefined) delete destino[campo];
    assert.throws(() => wppMod.criarWpp({ ...base, ...destino }), (e) => {
      for (const x of [URL_A, CHAVE_FALSA, GRUPO, NUMERO_DONO, INSTANCIA_ENVIO, INSTANCIA_CONFERENCIA]) {
        assert.ok(!e.message.includes(x), `${campo}: a mensagem cita ${x}`);
      }
      return true;
    }, `${campo} = ${JSON.stringify(v)}`);
  }
  assert.throws(() => wppMod.criarWpp(base), 'sem nenhum dos 3');
  assert.equal(d.chamadas.length, 0, 'nenhuma chamada');

  const w = wppMod.criarWpp({ ...base, ...DESTINO_WPP });
  assert.deepEqual(await w.enviarGrupo('oi', { citarId: 'Q1' }), { ok: true, providerMsgId: 'P1', messageId: 'U1' });
  await w.enviarGrupo('x', { to: NUMERO_DONO, instance: INSTANCIA_CONFERENCIA, chat: 'outro' }); // nunca muda o destino
  await w.lerGrupo(7);
  await w.lerGrupo(9, { conferencia: true });
  for (const opts of [{ conferencia: 'sim' }, { conferencia: 1 }, { instancia: INSTANCIA_CONFERENCIA }, { instancia: 'pessoal' }, {}]) {
    await w.lerGrupo(3, opts);
  }
  assert.deepEqual(await w.membros(), [NUMERO_DONO, NUMERO_ROBO]);
  assert.deepEqual(d.chamadas.map((c) => [c.name, c.args]), [
    ['send', { to: GRUPO, instance: INSTANCIA_ENVIO, content: 'oi', confirmed: true, force_send_after_inbound: true, reply_to: 'Q1' }],
    ['send', { to: GRUPO, instance: INSTANCIA_ENVIO, content: 'x', confirmed: true, force_send_after_inbound: true }],
    ['read', { chat: GRUPO, instance: INSTANCIA_ENVIO, limit: 7 }],
    ['read', { chat: GRUPO, instance: INSTANCIA_CONFERENCIA, limit: 9 }],
    ...Array.from({ length: 5 }, () => ['read', { chat: GRUPO, instance: INSTANCIA_ENVIO, limit: 3 }]),
    ['zapi_action', { action: 'group-metadata', instance: INSTANCIA_ENVIO, params: { phone: GRUPO } }],
  ]);
  assert.ok(d.chamadas.every((c) => c.url === URL_A));
  // o modulo nao traz mais o grupo, a instancia nem o numero do dono fixos
  for (const nome of ['GRUPO', 'INSTANCIA', 'NUMERO_DONO']) assert.equal(wppMod[nome], undefined, nome);
});

test('A2a 6. wppDoConfig: o cliente pelo config (a entrada do ~/.claude.json pelo whatsapp.mcp; o grupo e as instancias do config); WhatsApp desligado ou incompleto = lanca sem ler o ~/.claude.json', async () => {
  const dir = pastaTemp('a2a-wppcfg-');
  const arq = claudeJson(dir, { 'wpp-teste': { url: URL_B, headers: { Authorization: `Bearer ${CHAVE_FALSA}` } } });
  const d = dubleFetch(respostaPadrao);
  const ident = config.identidadeWhatsapp({ whatsapp: { ...WHATSAPP, mcp: 'wpp-teste' } });
  const w = wppMod.wppDoConfig(ident, { caminho: arq, fetch: d.fetch });
  await w.lerGrupo(5);
  await w.lerGrupo(5, { conferencia: true });
  await w.enviarGrupo('oi');
  assert.deepEqual(d.chamadas.map((c) => [c.url, c.name, c.args.chat ?? c.args.to, c.args.instance]), [
    [URL_B, 'read', GRUPO, INSTANCIA_ENVIO],
    [URL_B, 'read', GRUPO, INSTANCIA_CONFERENCIA],
    [URL_B, 'send', GRUPO, INSTANCIA_ENVIO],
  ]);
  assert.equal(d.chamadas[0].headers.Authorization, `Bearer ${CHAVE_FALSA}`, 'os headers da entrada');
  // desligado ou incompleto: lanca antes de ler o arquivo (um caminho que nem existe)
  const naoExiste = path.join(dir, 'nao-existe.json');
  for (const cfg of [{}, { whatsapp: { ...WHATSAPP, ligado: false } }, { whatsapp: { ...WHATSAPP, numeroRobo: 'x' } }]) {
    assert.throws(() => wppMod.wppDoConfig(config.identidadeWhatsapp(cfg), { caminho: naoExiste, fetch: d.fetch }), /^Error: WhatsApp desligado/, JSON.stringify(cfg));
  }
  assert.throws(() => wppMod.wppDoConfig(null, { caminho: naoExiste }), /^Error: WhatsApp desligado/);
  // ligado e sem a entrada do mcp: lanca (o porteiro loga "sem whatsapp-agent")
  assert.throws(() => wppMod.wppDoConfig(config.identidadeWhatsapp({ whatsapp: WHATSAPP }), { caminho: arq, fetch: d.fetch }), /whatsapp-agent sem url/);
  assert.equal(d.chamadas.length, 3, 'nenhuma chamada a mais');
});

// ---------- 7. ok-wpp com os numeros do config (harness do tests/ok-wpp.test.mjs, reduzido) ----------

const SID = '11111111-2222-4333-8444-555555555555';
const PID = 4242;
const ACAO = 'Publicar o site v2 em producao';

function montarOk() {
  const raiz = pastaTemp('a2a-ok-');
  const env = {
    SESSOES_WPP_DIR: path.join(raiz, 'estado'),
    CLAUDE_SESSIONS_DIR: path.join(raiz, 'sessions'),
    CLAUDE_PROJECTS_DIR: path.join(raiz, 'projects'),
    SESSOES_WPP_LOG: path.join(raiz, 'ok-wpp.log'),
    CLAUDE_CODE_SESSION_ID: SID,
  };
  for (const d of [env.SESSOES_WPP_DIR, env.CLAUDE_SESSIONS_DIR, env.CLAUDE_PROJECTS_DIR]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(env.SESSOES_WPP_DIR, 'estado.json'), JSON.stringify({ v: 1, trava: false }));
  const reg = { pid: PID, sessionId: SID, cwd: 'C:\\projetos', name: 'projetos-f3', nameSource: 'derived', entrypoint: 'claude-vscode', status: 'idle', updatedAt: T0 };
  fs.writeFileSync(path.join(env.CLAUDE_SESSIONS_DIR, `${PID}.json`), JSON.stringify(reg));
  const pasta = path.join(env.CLAUDE_PROJECTS_DIR, 'c--projetos');
  fs.mkdirSync(pasta, { recursive: true });
  fs.writeFileSync(path.join(pasta, `${SID}.jsonl`), `${JSON.stringify({ type: 'custom-title', customTitle: 'Faro', sessionId: SID })}\n`);
  const h = {
    raiz, env, t: T0, envio: [], conferencia: [], membros: [NUMERO_DONO, NUMERO_ROBO], leituras: [], chamadas: [], nMsg: 0,
    markerPath: path.join(raiz, 'logs', 'publicacao-ok.json'),
    disparoPath: path.join(raiz, 'logs', 'disparo-estado.json'),
  };
  let seq = 0;
  h.wpp = {
    async lerGrupo(limit, opts = {}) {
      h.chamadas.push('lerGrupo');
      h.leituras.push({ limit, conferencia: opts.conferencia === true });
      return (opts.conferencia === true ? h.conferencia : h.envio).slice(-limit);
    },
    async enviarGrupo(texto) {
      h.chamadas.push('enviarGrupo');
      seq += 1;
      const r = { ok: true, providerMsgId: `PED${seq}`, messageId: `uuid-ped-${seq}` };
      h.envio.push({ id: r.messageId, provider_msg_id: r.providerMsgId, from_me: true, sent_by_agent: true, sender_phone: null, message_type: 'text', content: texto, quoted_msg_id: null, message_ts: iso(h.t) });
      return r;
    },
    async reagir() { h.chamadas.push('reagir'); return { ok: true }; },
    async membros() { h.chamadas.push('membros'); return [...h.membros]; },
  };
  h.ok = (extra = {}) => okWpp.criarOkWpp({
    wpp: h.wpp, env, agora: () => h.t, markerPath: h.markerPath, disparoPath: h.disparoPath,
    numeroDono: NUMERO_DONO, numeroRobo: NUMERO_ROBO, ...extra,
  });
  h.pedido = (cod) => JSON.parse(fs.readFileSync(path.join(env.SESSOES_WPP_DIR, 'oks', `${cod}.json`), 'utf8'));
  h.oks = () => (fs.existsSync(path.join(env.SESSOES_WPP_DIR, 'oks')) ? fs.readdirSync(path.join(env.SESSOES_WPP_DIR, 'oks')) : []);
  return h;
}

// Uma mensagem no grupo (vista pela de envio) e a copia dela vista pela de conferencia (o celular do dono).
function noGrupo(h, texto, { cita = null, de = NUMERO_DONO, copia = true } = {}) {
  h.nMsg += 1;
  const base = { provider_msg_id: `RESP${h.nMsg}`, quoted_msg_id: cita, message_type: 'chat', content: texto, sender_phone: de, message_ts: iso(h.t) };
  h.envio.push({ id: `uuid-resp-${h.nMsg}`, ...base, from_me: false, sent_by_agent: false, direction: 'received' });
  if (copia) h.conferencia.push({ id: `uuid-conf-${h.nMsg}`, ...base, from_me: true, sent_by_agent: false, direction: 'sent' });
}

async function pedido(h, extra) {
  const r = await h.ok(extra).pedir({ tipo: 'publicacao', acao: ACAO });
  assert.equal(r.status, 'pedido', JSON.stringify(r));
  h.t += MIN;
  return r.codigo;
}

test('A2a 7. ok-wpp: so o "sim" do numeroDono decide (igual, nunca "contem"); a copia vem da leitura { conferencia: true }; membros = exatamente o dono e o robo do config; a "trava" conta so do dono', async () => {
  // o sim do dono: a leitura do grupo e depois a da conferencia
  const a = montarOk();
  const cA = await pedido(a);
  noGrupo(a, 'sim', { cita: 'PED1' });
  const rA = await a.ok().verificar(cA);
  assert.equal(rA.status, 'ok', JSON.stringify(rA));
  assert.deepEqual(a.leituras, [{ limit: 50, conferencia: false }, { limit: 50, conferencia: true }]);
  assert.equal(a.pedido(cA).status, 'usado');
  // o sim de outro numero (um terceiro, o robo, um numero que contem o do dono, um pedaco do numero do dono) nao decide
  for (const de of [OUTRO_NUMERO, NUMERO_ROBO, `55${NUMERO_DONO}`, NUMERO_DONO.slice(2)]) {
    const b = montarOk();
    const cB = await pedido(b);
    noGrupo(b, 'sim', { cita: 'PED1', de });
    const rB = await b.ok().verificar(cB);
    assert.equal(rB.status, 'pendente', `${de}: ${JSON.stringify(rB)}`);
    assert.equal(b.pedido(cB).status, 'pendente', de);
  }
  // membros: os 2 do config passam; um terceiro = estranho; faltando um = nao confere; o robo do config diferente do grupo = estranho
  for (const [nome, membros, extra, motivo] of [
    ['terceiro no grupo', [NUMERO_DONO, NUMERO_ROBO, OUTRO_NUMERO], {}, `membro estranho no grupo: ${OUTRO_NUMERO}`],
    ['so o dono', [NUMERO_DONO], {}, 'nao consegui conferir os membros'],
    ['o robo do config e outro', [NUMERO_DONO, NUMERO_ROBO], { numeroRobo: OUTRO_NUMERO }, `membro estranho no grupo: ${NUMERO_ROBO}`],
  ]) {
    const m = montarOk();
    const cM = await pedido(m);
    noGrupo(m, 'sim', { cita: 'PED1' });
    m.membros = membros;
    assert.deepEqual(await m.ok(extra).verificar(cM), { status: 'invalido', motivo }, nome);
  }
  // a "trava" do dono no grupo nega; a de outro numero nao
  const t = montarOk();
  const cT = await pedido(t);
  noGrupo(t, 'trava', { de: OUTRO_NUMERO });
  noGrupo(t, 'sim', { cita: 'PED1' });
  assert.equal((await t.ok().verificar(cT)).status, 'ok', 'trava de outro numero nao vale');
  const u = montarOk();
  const cU = await pedido(u);
  noGrupo(u, 'trava');
  noGrupo(u, 'sim', { cita: 'PED1' });
  assert.deepEqual(await u.ok().verificar(cU), { status: 'invalido', motivo: 'travado pelo dono' });
  // a copia so vale vista pela de conferencia: sem ela = esperando (nunca le a copia pela de envio)
  const s = montarOk();
  const cS = await pedido(s);
  noGrupo(s, 'sim', { cita: 'PED1', copia: false });
  assert.equal((await s.ok().verificar(cS)).motivo, 'esperando a copia do numero pessoal');
  // o modulo nao traz mais os numeros fixos
  for (const nome of ['NUMERO_PROFISSIONAL', 'MEMBROS_ESPERADOS']) assert.equal(okWpp[nome], undefined, nome);
});

test('A2a 8. ok-wpp: com o WhatsApp e sem os 2 numeros validos = invalido antes de ler ou escrever no grupo (pedir e verificar); sem WhatsApp os numeros nao importam', async () => {
  const h = montarOk();
  const cod = await pedido(h);
  noGrupo(h, 'sim', { cita: 'PED1' });
  for (const extra of [{ numeroDono: undefined }, { numeroRobo: undefined }, { numeroDono: null, numeroRobo: null }, { numeroDono: '123' },
    { numeroRobo: `+${NUMERO_ROBO}` }, { numeroDono: 5500900000001 }]) {
    const nome = JSON.stringify(extra);
    h.chamadas = [];
    assert.deepEqual(await h.ok(extra).verificar(cod), { status: 'invalido', motivo: SEM_NUMEROS }, nome);
    assert.deepEqual(await h.ok(extra).pedir({ tipo: 'crm', acao: 'Mover o deal' }), { status: 'invalido', motivo: SEM_NUMEROS }, nome);
    assert.deepEqual(h.chamadas, [], `${nome}: nada lido nem enviado`);
  }
  assert.equal(h.pedido(cod).status, 'pendente', 'o pedido segue valendo');
  assert.equal(h.oks().length, 1, 'nenhum pedido novo');
  // sem WhatsApp (wpp null, o OK so pelo Telegram): os numeros nem sao pedidos
  const t = montarOk();
  const tgOk = { async espiar() { return []; }, botId: 7, chatDono: 42 };
  const r = await t.ok({ wpp: null, numeroDono: undefined, numeroRobo: undefined, tgOk }).pedir({ tipo: 'crm', acao: 'Mover o deal' });
  assert.equal(r.status, 'pedido', JSON.stringify(r));
});

// ---------- 9-11. porteiro ----------

function montarPorteiro({ numeroDono } = {}) {
  const raiz = pastaTemp('a2a-porteiro-');
  const env = {
    SESSOES_WPP_DIR: path.join(raiz, 'estado'),
    CLAUDE_SESSIONS_DIR: path.join(raiz, 'sessions'),
    CLAUDE_PROJECTS_DIR: path.join(raiz, 'projects'),
    SESSOES_WPP_LOG: path.join(raiz, 'porteiro.log'),
  };
  for (const d of [env.SESSOES_WPP_DIR, env.CLAUDE_SESSIONS_DIR, env.CLAUDE_PROJECTS_DIR]) fs.mkdirSync(d, { recursive: true });
  const h = { raiz, env, t: T0, grupo: [], enviados: [], nMsg: 0 };
  h.wpp = {
    async lerGrupo(limit) { return h.grupo.slice(-limit); },
    async enviarGrupo(texto) { h.enviados.push(texto); return { ok: true, providerMsgId: `P${h.enviados.length}`, messageId: `U${h.enviados.length}` }; },
    async reagir() { return { ok: true }; },
    async editarGrupo() { return { ok: true }; },
    async membros() { return [NUMERO_DONO, NUMERO_ROBO]; },
  };
  const opcoes = {
    wpp: h.wpp, mensageiro: { async entregar() { return { status: 'enviado', detalhe: '' }; } }, ocioso: async () => 0,
    agora: () => h.t, env, ensaio: false, abrirCentral: () => {}, dormir: async (ms) => { h.t += ms; },
    central: CENTRAL_TESTE, raizesSessao: RAIZES_TESTE, // A3a: a central e as pastas como o dono configura
  };
  if (numeroDono !== undefined) opcoes.numeroDono = numeroDono;
  h.p = porteiro.criarPorteiro(opcoes);
  h.t += 1000; // as mensagens nascem depois do cursor inicial
  return h;
}
const estadoPorteiro = (h) => JSON.parse(fs.readFileSync(path.join(h.env.SESSOES_WPP_DIR, 'estado.json'), 'utf8'));

test('A2a 9. porteiro: so a mensagem do numeroDono (igual, nunca "contem") vale como do dono no grupo; sem numeroDono (ou fora do formato) nenhuma vale', async () => {
  for (const [nome, numeroDono, de, travado] of [
    ['do dono', NUMERO_DONO, NUMERO_DONO, true],
    ['de outro numero', NUMERO_DONO, OUTRO_NUMERO, false],
    ['do robo', NUMERO_DONO, NUMERO_ROBO, false],
    ['de um numero que contem o do dono', NUMERO_DONO, `55${NUMERO_DONO}`, false],
    ['o dono e um pedaco do numero de quem escreveu', NUMERO_DONO.slice(2), NUMERO_DONO, false],
    ['sem numeroDono', undefined, NUMERO_DONO, false],
    ['numeroDono null', null, NUMERO_DONO, false],
    ['numeroDono fora do formato', '123', '123', false],
  ]) {
    const h = montarPorteiro({ numeroDono });
    h.nMsg += 1;
    h.grupo.push({
      id: `uuid-${h.nMsg}`, provider_msg_id: `PROV${h.nMsg}`, quoted_msg_id: null, sent_by_agent: false, message_type: 'text',
      content: 'trava', transcription: null, direction: 'received', from_me: false, sender_phone: de, message_ts: iso(h.t),
    });
    await h.p.passoGrupo();
    assert.equal(estadoPorteiro(h).trava === true, travado, nome);
  }
});

async function subir({ cfg = null, criarW, tg = { nome: 'tg' } }) {
  const estadoDir = pastaTemp('a2a-canais-');
  if (cfg) fs.writeFileSync(path.join(estadoDir, 'config.json'), JSON.stringify(cfg));
  const logs = [];
  const chamadas = { criarW: [], prepararTg: 0 };
  const r = await porteiro.prepararCanais({
    estadoDir, env: {}, log: (m) => logs.push(m), ensaio: true,
    criarW: (ident) => { chamadas.criarW.push(ident); return criarW(ident); },
    prepararTg: async () => {
      chamadas.prepararTg += 1;
      return { avisarTelegram: 'AV', configTg: { canalPrincipal: 'telegram', ligado: tg !== null }, tg, identTg: { chatId: 1, botId: 2 } };
    },
  });
  return { r, logs, chamadas };
}

test('A2a 10. prepararCanais: o bloco completo = criarW com a identidade do config e o numeroDono no retorno; sem o bloco = desligado (o padrao novo); ligado true incompleto = 1 log so com o nome dos campos e segue so com o Telegram; sem Telegram = sai', async () => {
  const W = { nome: 'wpp' };
  const T = { nome: 'tg' };
  const resto = { avisarTelegram: 'AV', configTg: { canalPrincipal: 'telegram', ligado: true }, tg: T, identTg: { chatId: 1, botId: 2 } };
  const cfg = { whatsapp: { ...WHATSAPP, mcp: 'wpp-teste' } };
  const a = await subir({ cfg, criarW: () => W, tg: T });
  assert.deepEqual(a.r, { wpp: W, numeroDono: NUMERO_DONO, ...resto });
  assert.deepEqual(a.chamadas.criarW, [config.identidadeWhatsapp(cfg)]);
  assert.deepEqual(a.logs, []);
  const so = await subir({ cfg, criarW: () => W, tg: null });
  assert.deepEqual([so.r.wpp, so.r.numeroDono, so.r.tg, so.logs], [W, NUMERO_DONO, null, []], 'so o WhatsApp');
  // sem o bloco: desligado, como o whatsapp.ligado false da A2b
  for (const [nome, c] of [['sem config', null], ['sem o bloco', { telegram: { ligado: true } }], ['ligado false', { whatsapp: { ...WHATSAPP, ligado: false } }]]) {
    const d = await subir({ cfg: c, criarW: () => { throw new Error('nao era pra criar'); }, tg: T });
    assert.deepEqual(d.r, { wpp: null, numeroDono: null, ...resto }, nome);
    assert.deepEqual(d.chamadas.criarW, [], nome);
    assert.deepEqual(d.logs, ['WhatsApp desligado no config: so o Telegram'], nome);
  }
  // ligado true incompleto: 1 log com o nome dos campos (nunca o valor) e so o Telegram
  const inc = { whatsapp: { ...WHATSAPP, grupo: '99-group', numeroRobo: undefined } };
  const i = await subir({ cfg: inc, criarW: () => { throw new Error('nao era pra criar'); }, tg: T });
  assert.deepEqual(i.r, { wpp: null, numeroDono: null, ...resto });
  assert.deepEqual(i.chamadas.criarW, []);
  assert.deepEqual(i.logs, ['WhatsApp desligado: falta ou fora do formato: grupo, numeroRobo']);
  for (const v of ['99-group', NUMERO_DONO, INSTANCIA_ENVIO, INSTANCIA_CONFERENCIA]) assert.ok(!i.logs.join('\n').includes(v), v);
  const iSemTg = await subir({ cfg: inc, criarW: () => W, tg: null });
  assert.equal(iSemTg.r, null);
  assert.deepEqual(iSemTg.logs, ['WhatsApp desligado: falta ou fora do formato: grupo, numeroRobo', 'sem canal ligado: WhatsApp desligado no config e Telegram desligado']);
  // ligado e o criarW lanca: sai antes do Telegram (como antes)
  const z = await subir({ cfg, criarW: () => { throw new Error('wpp-teste sem url no ~/.claude.json'); }, tg: T });
  assert.equal(z.r, null);
  assert.deepEqual(z.logs, ['sem whatsapp-agent: wpp-teste sem url no ~/.claude.json']);
  assert.equal(z.chamadas.prepararTg, 0, 'o Telegram nem e montado');
});

test('A2a 11. o rodar repassa o numeroDono do prepararCanais ao criarPorteiro (contrato no fonte: o rodar nao tem teste)', () => {
  const fonte = fs.readFileSync(new URL('../porteiro.mjs', import.meta.url), 'utf8');
  const rodar = fonte.slice(fonte.indexOf('async function rodar('));
  assert.match(rodar, /const \{[^}]*\bnumeroDono\b[^}]*\} = canais;/);
  const inicio = rodar.indexOf('criarPorteiro({');
  const chamada = rodar.slice(inicio, rodar.indexOf('});', inicio));
  assert.match(chamada, /^\s*(?:wpp, )?numeroDono,/m);
});

// ---------- 12-13. linhas de comando (HOME temporaria com ~/.claude.json de teste; fetch dublado) ----------

// O fetch das linhas de comando: grava cada chamada em A2A_REDE (jsonl) e responde pelo estado em A2A_ESTADO
// ({envio, membros, enviadas, leituras: {<instancia>: [mensagens]}}): o send volta no read da de envio, byte a byte.
const DUBLE_REDE = `
import fs from 'node:fs';
globalThis.fetch = async (url, opts) => {
  const corpo = JSON.parse(opts.body);
  const { name, arguments: args } = corpo.params;
  fs.appendFileSync(process.env.A2A_REDE, JSON.stringify({ url: String(url), name, args }) + '\\n');
  const est = JSON.parse(fs.readFileSync(process.env.A2A_ESTADO, 'utf8'));
  let out;
  if (name === 'send') {
    const n = est.enviadas.length + 1;
    est.enviadas.push({ provider: 'PED' + n, id: 'uuid-ped' + n, content: args.content, ts: Date.now() });
    fs.writeFileSync(process.env.A2A_ESTADO, JSON.stringify(est));
    out = { ok: true, provider_msg_id: 'PED' + n, message_id: 'uuid-ped' + n };
  } else if (name === 'zapi_action') {
    out = { ok: true, result: { participants: est.membros.map((phone) => ({ phone })) } };
  } else if (name === 'read') {
    const t0 = est.enviadas.length ? est.enviadas[est.enviadas.length - 1].ts : Date.now();
    const doGrupo = args.instance !== est.envio ? [] : est.enviadas.map((m) => ({
      id: m.id, provider_msg_id: m.provider, from_me: true, sent_by_agent: true, sender_phone: null, message_type: 'text',
      content: m.content, quoted_msg_id: null, message_ts: new Date(m.ts).toISOString(),
    }));
    const extra = (est.leituras[args.instance] || []).map((x) => ({ ...x, message_ts: new Date(t0 + 2000).toISOString() }));
    out = { ok: true, messages: [...doGrupo, ...extra] };
  } else {
    out = { ok: false, error: 'duble sem ' + name };
  }
  const texto = JSON.stringify({ jsonrpc: '2.0', id: corpo.id, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } });
  return { ok: true, status: 200, text: async () => texto };
};
`;

function linhaDeComando({ cfg, leituras = {} }) {
  const raiz = pastaTemp('a2a-cli-');
  const dirs = { estado: path.join(raiz, 'estado'), sessions: path.join(raiz, 'sessions'), projects: path.join(raiz, 'projects'), home: path.join(raiz, 'home') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(dirs.estado, 'config.json'), JSON.stringify(cfg));
  fs.writeFileSync(path.join(dirs.estado, 'estado.json'), JSON.stringify({ v: 1, trava: false }));
  const reg = { pid: PID, sessionId: SID, cwd: 'C:\\projetos', name: 'projetos-f3', nameSource: 'derived', entrypoint: 'claude-vscode', status: 'idle', updatedAt: Date.now() };
  fs.writeFileSync(path.join(dirs.sessions, `${PID}.json`), JSON.stringify(reg));
  fs.mkdirSync(path.join(dirs.projects, 'c--projetos'));
  fs.writeFileSync(path.join(dirs.projects, 'c--projetos', `${SID}.jsonl`), `${JSON.stringify({ type: 'custom-title', customTitle: 'Faro', sessionId: SID })}\n`);
  // so a entrada `wpp-teste` (a do whatsapp.mcp): ler a whatsapp-agent seria erro
  claudeJson(dirs.home, { 'wpp-teste': { url: URL_B, headers: { Authorization: `Bearer ${CHAVE_FALSA}` } } });
  const duble = path.join(raiz, 'duble-rede.mjs');
  fs.writeFileSync(duble, DUBLE_REDE);
  const h = { raiz, rede: path.join(raiz, 'rede.jsonl'), estadoRede: path.join(raiz, 'estado-rede.json'), oks: path.join(dirs.estado, 'oks') };
  fs.writeFileSync(h.estadoRede, JSON.stringify({ envio: INSTANCIA_ENVIO, membros: [NUMERO_DONO, NUMERO_ROBO], enviadas: [], leituras }));
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SESSOES_WPP_.*|CLAUDE_CODE_SESSION_ID|CLAUDE_SESSIONS_DIR|CLAUDE_PROJECTS_DIR)$/i.test(k)));
  const env = {
    ...base, SESSOES_WPP_DIR: dirs.estado, SESSOES_WPP_LOG: path.join(raiz, 'sessoes-wpp.log'), CLAUDE_SESSIONS_DIR: dirs.sessions,
    CLAUDE_PROJECTS_DIR: dirs.projects, CLAUDE_CODE_SESSION_ID: SID, USERPROFILE: dirs.home, HOME: dirs.home,
    A2A_REDE: h.rede, A2A_ESTADO: h.estadoRede,
  };
  h.rodar = (arquivo, args) => {
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(duble).href, arquivo, ...args], { env, encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.equal(r.error, undefined, String(r.error));
    assert.ok(!`${r.stdout}${r.stderr}`.includes(CHAVE_FALSA), 'a chave nunca sai');
    return r;
  };
  h.chamadas = () => logsDe(h.rede).map((l) => JSON.parse(l));
  h.mexer = (fn) => {
    const e = JSON.parse(fs.readFileSync(h.estadoRede, 'utf8'));
    fn(e);
    fs.writeFileSync(h.estadoRede, JSON.stringify(e));
  };
  return h;
}

test('A2a 12. CLI ok-wpp com o bloco completo: o pedido sai pro grupo do config pela de envio (entrada do whatsapp.mcp); o verificar confere os membros do config, le o grupo pela de envio, aceita so o sim do numeroDono e procura a copia pela de conferencia', () => {
  const h = linhaDeComando({ cfg: { whatsapp: { ...WHATSAPP, mcp: 'wpp-teste' } } });
  const p = h.rodar(OK_WPP, ['pedir', '--tipo', 'publicacao', '--acao', ACAO]);
  assert.equal(p.status, 0, `${p.stdout} ${p.stderr}`);
  const r = JSON.parse(p.stdout);
  assert.equal(r.status, 'pedido');
  const envio = h.chamadas();
  assert.equal(envio.length, 1, JSON.stringify(envio));
  assert.deepEqual([envio[0].url, envio[0].name, envio[0].args.to, envio[0].args.instance], [URL_B, 'send', GRUPO, INSTANCIA_ENVIO]);
  // sem resposta ainda: membros e leitura pela de envio, nada pela de conferencia
  const v1 = h.rodar(OK_WPP, ['verificar', r.codigo]);
  assert.equal(v1.status, 2, `${v1.stdout} ${v1.stderr}`);
  assert.deepEqual(JSON.parse(v1.stdout), { status: 'pendente', motivo: 'sem resposta do dono ainda', ignoradas: [] });
  assert.deepEqual(h.chamadas().slice(1).map((c) => [c.url, c.name, c.args]), [
    [URL_B, 'zapi_action', { action: 'group-metadata', instance: INSTANCIA_ENVIO, params: { phone: GRUPO } }],
    [URL_B, 'read', { chat: GRUPO, instance: INSTANCIA_ENVIO, limit: 50 }],
  ]);
  // o sim de outro numero nao decide; o do dono decide e o verificar procura a copia pela de conferencia (sem ela = esperando)
  const resposta = (n, de) => ({ id: `uuid-r${n}`, provider_msg_id: `R${n}`, quoted_msg_id: 'PED1', message_type: 'chat', content: 'sim', sender_phone: de, from_me: false, sent_by_agent: false, direction: 'received' });
  h.mexer((e) => { e.leituras[INSTANCIA_ENVIO] = [resposta(1, OUTRO_NUMERO)]; });
  const v2 = h.rodar(OK_WPP, ['verificar', r.codigo]);
  assert.deepEqual(JSON.parse(v2.stdout), { status: 'pendente', motivo: 'sem resposta do dono ainda', ignoradas: [] });
  h.mexer((e) => { e.leituras[INSTANCIA_ENVIO] = [resposta(2, NUMERO_DONO)]; });
  const antes = h.chamadas().length;
  const v3 = h.rodar(OK_WPP, ['verificar', r.codigo]);
  assert.equal(v3.status, 2, `${v3.stdout} ${v3.stderr}`);
  assert.deepEqual(JSON.parse(v3.stdout), { status: 'pendente', motivo: 'esperando a copia do numero pessoal', ignoradas: [] });
  assert.deepEqual(h.chamadas().slice(antes).map((c) => [c.name, c.args.instance]), [
    ['zapi_action', INSTANCIA_ENVIO], ['read', INSTANCIA_ENVIO], ['read', INSTANCIA_CONFERENCIA],
  ]);
  assert.ok(h.chamadas().every((c) => c.url === URL_B), 'so a entrada do whatsapp.mcp');
});

test('A2a 13. CLI ler-grupo: com o bloco completo le o grupo do config pela de envio e o rotulo do dono vem do numeroDono (igual); sem o bloco = "WhatsApp desligado"; ligado incompleto = "WhatsApp desligado" com o nome dos campos; nada lido nos dois', () => {
  const msg = (id, o) => ({ id: `uuid-${id}`, provider_msg_id: id, quoted_msg_id: null, message_type: 'chat', sent_by_agent: false, from_me: false, direction: 'received', ...o });
  const leituras = {
    [INSTANCIA_ENVIO]: [
      msg('D1', { content: 'oi do dono', sender_phone: NUMERO_DONO }),
      msg('O1', { content: 'oi de quem contem o numero', sender_phone: `55${NUMERO_DONO}` }),
      msg('A1', { content: 'oi do agente', sender_phone: NUMERO_ROBO, from_me: true, sent_by_agent: true }),
    ],
  };
  const h = linhaDeComando({ cfg: { whatsapp: { ...WHATSAPP, mcp: 'wpp-teste' } }, leituras });
  const r = h.rodar(LER_GRUPO, ['5']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(h.chamadas().map((c) => [c.url, c.name, c.args]), [[URL_B, 'read', { chat: GRUPO, instance: INSTANCIA_ENVIO, limit: 5 }]]);
  const linhas = r.stdout.split('\n').filter(Boolean);
  const quem = (id) => linhas.find((l) => l.includes(`id=${id}`))?.split(/\s{2,}/)[1];
  assert.deepEqual([quem('D1'), quem('O1'), quem('A1')], ['dono', 'outro', 'agente'], r.stdout);
  for (const [cfg, saida] of [
    [{ telegram: { ligado: false } }, 'WhatsApp desligado\n'],
    [{ whatsapp: { ...WHATSAPP, mcp: 'wpp-teste', instanciaConferencia: '' } }, 'WhatsApp desligado: falta ou fora do formato: instanciaConferencia\n'],
  ]) {
    const x = linhaDeComando({ cfg, leituras });
    const s = x.rodar(LER_GRUPO, ['5']);
    assert.equal(s.status, 0, s.stderr);
    assert.equal(s.stdout, saida);
    assert.deepEqual(x.chamadas(), [], 'nada lido');
  }
});
