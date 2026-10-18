// Testes da A5a (PLANO-ABERTO.md, "A5a — os botões de funcionamento"): o modo rua, o modelo do mensageiro, a voz, o
// aviso de saude e o nome da maquina pelo config.json (lib/config.mjs), e quem usa cada um (porteiro, mensageiro,
// lib/voz.mjs, lib/voz-microsoft.mjs e lib/registro.mjs).
// Por que existe: os 5 estavam chumbados no codigo (30 min de PC parado, o sonnet, o Antonio com pt-BR, a variavel do
// portao com nome fixo e a maquina "pc"); a copia aberta serve a qualquer pessoa. Valor trocado aqui = o modo rua
// ligando na hora errada, o recado com outro modelo, a voz em outra lingua ou o aviso de saude lendo variavel que a
// pessoa nao configurou.
// Isolamento: pastas temporarias (prefixo "a5a-"); spawn, Microsoft, fetch, registro, Telegram e portao dublados; ids
// sinteticos (tabela "Dados sintéticos" do plano). Nada de rede, registro real, config.json real nem porteiro rodando:
// o rodar do porteiro e conferido pelo fonte.
// Os modulos entram por `import * as`: funcao que ainda nao existe deixa so o teste dela vermelho.
// Rodar: node --test --test-reporter=tap "tests/a5a.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { oggOpus } from './lib/ogg-falso.mjs';
import * as config from '../lib/config.mjs';
import * as porteiro from '../porteiro.mjs';
import * as mensageiro from '../mensageiro.mjs';
import * as voz from '../lib/voz.mjs';
import * as vozMs from '../lib/voz-microsoft.mjs';
import * as registro from '../lib/registro.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');
const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-15T15:00:00Z'); // 12:00 em Brasilia
const CHAT = 700100200; // chat do dono (sintetico)
const BOT = 700900800; // o bot (sintetico)
const VAR = 'SAUDE_TESTE_URL'; // nome de variavel sintetico do portao
const PORTAO = 'https://portao.exemplo.invalid/tg/chave-de-teste';
const PORTAO2 = 'https://outro.exemplo.invalid/tg/outra-chave';
const SEM_VAR = 'aviso no Telegram: sem canal de aviso (sem saude.varUrl no config.json)';
const logsDe = (arq) => {
  try { return fs.readFileSync(arq, 'utf8').split('\n').filter(Boolean); } catch { return []; }
};
// cfg cujo campo `chave` lanca ao ser lido (o leitor nunca lanca); nao enumeravel: o JSON.stringify da mensagem nao le
const bomba = (chave) => Object.defineProperty({}, chave, { enumerable: false, get() { throw new Error('getter'); } });
// os cfgs que nao servem (sem bloco, bloco que nao e objeto, cfg que nao e objeto)
const cfgsTortos = (bloco) => [undefined, null, 42, 'x', [], {}, { [bloco]: null }, { [bloco]: [] }, { [bloco]: 'x' },
  { [bloco]: 7 }, { [bloco]: true }, [{ [bloco]: {} }], bomba(bloco)];

// ---------- 1-5. lib/config.mjs ----------

test('A5a 1. modoRuaDoConfig: automatico false so com modoRua.automatico === false; ociosoMin inteiro de 5 a 240, senao 30; um campo ruim nao derruba o outro; nunca lanca', () => {
  const f = config.modoRuaDoConfig;
  assert.equal(typeof f, 'function', 'modoRuaDoConfig exportada');
  const PADRAO = { automatico: true, ociosoMin: 30 };
  for (const cfg of cfgsTortos('modoRua')) assert.deepEqual(f(cfg), PADRAO, JSON.stringify(cfg));
  assert.deepEqual(f({ modoRua: { automatico: false } }), { automatico: false, ociosoMin: 30 });
  assert.deepEqual(f({ modoRua: { automatico: true, ociosoMin: 10 } }), { automatico: true, ociosoMin: 10 });
  assert.deepEqual(f({ modoRua: { automatico: false, ociosoMin: 240 } }), { automatico: false, ociosoMin: 240 });
  assert.deepEqual(f({ modoRua: { ociosoMin: 5 } }), { automatico: true, ociosoMin: 5 });
  // automatico: so o false de verdade desliga
  for (const a of ['false', 0, null, '', 'nao', [], {}, true, undefined]) {
    assert.equal(f({ modoRua: { automatico: a, ociosoMin: 10 } }).automatico, true, JSON.stringify(a));
    assert.equal(f({ modoRua: { automatico: a, ociosoMin: 10 } }).ociosoMin, 10, `${JSON.stringify(a)}: o ociosoMin segue`);
  }
  // ociosoMin ruim = 30, e o automatico segue
  for (const n of [4, 241, 0, -10, 10.5, '10', NaN, Infinity, null, [10], {}, true]) {
    assert.deepEqual(f({ modoRua: { automatico: false, ociosoMin: n } }), { automatico: false, ociosoMin: 30 }, String(n));
  }
  // campo que lanca = ausente (o outro segue)
  assert.deepEqual(f({ modoRua: Object.assign(bomba('ociosoMin'), { automatico: false }) }), { automatico: false, ociosoMin: 30 });
  assert.deepEqual(f({ modoRua: Object.assign(bomba('automatico'), { ociosoMin: 12 }) }), { automatico: true, ociosoMin: 12 });
});

test('A5a 2. mensageiroDoConfig: o mensageiro.modelo aparado que comeca com letra (apelido ou id, ate 64), senao sonnet; nunca lanca', () => {
  const f = config.mensageiroDoConfig;
  assert.equal(typeof f, 'function', 'mensageiroDoConfig exportada');
  for (const cfg of cfgsTortos('mensageiro')) assert.deepEqual(f(cfg), { modelo: 'sonnet' }, JSON.stringify(cfg));
  const bons = [['opus', 'opus'], ['haiku', 'haiku'], ['  opus  ', 'opus'], ['claude-sonnet-4-5', 'claude-sonnet-4-5'],
    ['claude-opus-4-1-20250805', 'claude-opus-4-1-20250805'], ['sonnet[1m]', 'sonnet[1m]'], ['modelo_v2.1', 'modelo_v2.1'],
    ['a', 'a'], [`A${'b'.repeat(63)}`, `A${'b'.repeat(63)}`]];
  for (const [bruto, esperado] of bons) assert.deepEqual(f({ mensageiro: { modelo: bruto } }), { modelo: esperado }, bruto);
  // cada ruim seria bom se nao fosse o item que ele testa
  const ruins = [['', 'vazio'], ['   ', 'so espaco'], ['-opus', 'comeca com hifen (viraria opcao)'], ['--model', 'opcao'],
    ['1opus', 'comeca com digito'], ['_opus', 'comeca com sublinhado'], ['opus 4', 'espaco no meio'], ['opus;x', 'ponto e virgula'],
    ['opus"', 'aspas'], ['ópus', 'acento'], ['opus/4', 'barra'], [`A${'b'.repeat(64)}`, '65 caracteres'], [7, 'numero'],
    [null, 'null'], [['opus'], 'lista'], [{}, 'objeto']];
  for (const [bruto, quem] of ruins) assert.deepEqual(f({ mensageiro: { modelo: bruto } }), { modelo: 'sonnet' }, quem);
});

test('A5a 3. vozDoConfig: o voz.nome aparado no formato xx-YY-<Nome>Neural (o VOZ_RE), senao pt-BR-AntonioNeural; nunca lanca', () => {
  const f = config.vozDoConfig;
  assert.equal(typeof f, 'function', 'vozDoConfig exportada');
  const PADRAO = { nome: 'pt-BR-AntonioNeural' };
  for (const cfg of cfgsTortos('voz')) assert.deepEqual(f(cfg), PADRAO, JSON.stringify(cfg));
  for (const [bruto, esperado] of [['pt-BR-FranciscaNeural', 'pt-BR-FranciscaNeural'], ['en-US-GuyNeural', 'en-US-GuyNeural'],
    ['  es-ES-AlvaroNeural  ', 'es-ES-AlvaroNeural'], ['pt-BR-AntonioNeural', 'pt-BR-AntonioNeural']]) {
    assert.deepEqual(f({ voz: { nome: bruto } }), { nome: esperado }, bruto);
  }
  const ruins = [['pt-br-FranciscaNeural', 'pais em minuscula'], ['PT-BR-FranciscaNeural', 'lingua em maiuscula'],
    ['pt-BR-Francisca', 'sem Neural'], ['pt-BR-Francisca Neural', 'espaco'], ['pt-BR-FrancíscaNeural', 'acento'],
    ['ptBR-FranciscaNeural', 'sem o hifen'], ['pt-BR-Neural', 'sem nome'], ['pt-BRA-FranciscaNeural', 'pais com 3 letras'],
    ['pt-BR-Francisca2Neural', 'digito'], ['', 'vazio'], [7, 'numero'], [null, 'null'], [['pt-BR-FranciscaNeural'], 'lista']];
  for (const [bruto, quem] of ruins) assert.deepEqual(f({ voz: { nome: bruto } }), PADRAO, quem);
});

test('A5a 4. saudeDoConfig: o saude.varUrl aparado no formato de nome de variavel (RE_VAR_CHAVE), senao null; nunca lanca', () => {
  const f = config.saudeDoConfig;
  assert.equal(typeof f, 'function', 'saudeDoConfig exportada');
  for (const cfg of cfgsTortos('saude')) assert.deepEqual(f(cfg), { varUrl: null }, JSON.stringify(cfg));
  for (const [bruto, esperado] of [[VAR, VAR], [`  ${VAR}  `, VAR], ['_X', '_X'], ['a', 'a'], ['A'.repeat(100), 'A'.repeat(100)]]) {
    assert.deepEqual(f({ saude: { varUrl: bruto } }), { varUrl: esperado }, bruto);
  }
  for (const [bruto, quem] of [['1X', 'comeca com digito'], ['SAUDE-URL', 'hifen'], ['SAUDE URL', 'espaco'], ['SAUDÉ', 'acento'],
    ['', 'vazio'], ['   ', 'so espaco'], ['A'.repeat(101), '101 caracteres'], [7, 'numero'], [null, 'null'], [[VAR], 'lista']]) {
    assert.deepEqual(f({ saude: { varUrl: bruto } }), { varUrl: null }, quem);
  }
});

test('A5a 5. maquinaDoConfig: o maquina.nome aparado, ASCII de 1 a 20 (letra ou digito no comeco; depois tambem . e -), senao pc; nunca lanca', () => {
  const f = config.maquinaDoConfig;
  assert.equal(typeof f, 'function', 'maquinaDoConfig exportada');
  for (const cfg of cfgsTortos('maquina')) assert.deepEqual(f(cfg), { nome: 'pc' }, JSON.stringify(cfg));
  for (const [bruto, esperado] of [['notebook', 'notebook'], ['  vps-1  ', 'vps-1'], ['PC2', 'PC2'], ['casa.sala', 'casa.sala'],
    ['9', '9'], ['A'.repeat(20), 'A'.repeat(20)]]) {
    assert.deepEqual(f({ maquina: { nome: bruto } }), { nome: esperado }, bruto);
  }
  for (const [bruto, quem] of [['-pc', 'comeca com hifen'], ['.pc', 'comeca com ponto'], ['pc_1', 'sublinhado (Markdown)'],
    ['pc*', 'asterisco (Markdown)'], ['pc 1', 'espaco'], ['notebóok', 'nao ASCII'], ['A'.repeat(21), '21 caracteres'],
    ['pc\n1', 'quebra de linha'], ['', 'vazio'], [7, 'numero'], [null, 'null'], [['pc'], 'lista']]) {
    assert.deepEqual(f({ maquina: { nome: bruto } }), { nome: 'pc' }, quem);
  }
});

// ---------- 6. o modo rua no passoMinuto (harness do tests/a2b.test.mjs, reduzido) ----------

const tique = () => new Promise((ok) => setImmediate(ok));
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
  return tg;
}
// `modoRua` vai cru pro criarPorteiro (ausente = sem o campo)
function montar(extra = {}) {
  const raiz = pastaTemp('a5a-porteiro-');
  const env = {
    SESSOES_WPP_DIR: path.join(raiz, 'estado'),
    CLAUDE_SESSIONS_DIR: path.join(raiz, 'sessions'),
    CLAUDE_PROJECTS_DIR: path.join(raiz, 'projects'),
    SESSOES_WPP_LOG: path.join(raiz, 'porteiro.log'),
  };
  for (const d of [env.SESSOES_WPP_DIR, env.CLAUDE_SESSIONS_DIR, env.CLAUDE_PROJECTS_DIR]) fs.mkdirSync(d, { recursive: true });
  const h = { raiz, env, t: T0, idle: 0, nUpd: 0, nMid: 0 };
  h.tg = dubleTg(h);
  h.p = porteiro.criarPorteiro({
    wpp: null,
    mensageiro: { async entregar() { return { status: 'enviado', detalhe: '' }; } },
    ocioso: async () => h.idle,
    agora: () => h.t,
    env,
    ensaio: false,
    abrirCentral: () => {},
    avisarTelegram: async () => true,
    rand: randFixo(),
    dormir: async (ms) => { h.t += ms; },
    tg: h.tg,
    identTg: { chatId: CHAT, botId: BOT },
    ...extra,
  });
  h.t += 1000;
  return h;
}
const estado = (h) => JSON.parse(fs.readFileSync(path.join(h.env.SESSOES_WPP_DIR, 'estado.json'), 'utf8'));
function mexer(h, fn) {
  const arq = path.join(h.env.SESSOES_WPP_DIR, 'estado.json');
  const e = JSON.parse(fs.readFileSync(arq, 'utf8'));
  fn(e);
  fs.writeFileSync(arq, JSON.stringify(e));
}
// um minuto do relogio e o passoMinuto com o PC parado `idleMin` minutos
async function minuto(h, idleMin) {
  h.t += MIN;
  h.idle = idleMin * MIN;
  await h.p.passoMinuto();
  return estado(h).modoRua;
}
function msgTg(h, texto) {
  h.nUpd += 1;
  h.nMid += 1;
  const m = {
    message_id: h.nMid, date: Math.floor(h.t / 1000), text: texto,
    chat: { id: CHAT, type: 'private', first_name: 'Davi' }, from: { id: CHAT, is_bot: false, first_name: 'Davi' },
  };
  return { update_id: h.nUpd, message: m };
}
const logs = (h) => logsDe(h.env.SESSOES_WPP_LOG);

test('A5a 6. modo rua no passoMinuto: ociosoMin 10 = 9 min nao liga e 10 liga; sem modoRua (ou torto) = 30; o dono no PC desliga como antes', async () => {
  const h = montar({ modoRua: { automatico: true, ociosoMin: 10 } });
  assert.equal((await minuto(h, 9)).ligado, false, '9 min: nao liga');
  const m = await minuto(h, 10);
  assert.equal(m.ligado, true, '10 min: liga');
  assert.equal(m.motivo, 'ocioso');
  assert.ok(logs(h).some((l) => l.endsWith('modo rua ligado (PC ocioso)')));
  assert.equal((await minuto(h, 0)).ligado, false, 'o dono no PC desliga (como antes)');
  // sem o campo, e com o campo torto: o padrao de 30 min
  for (const extra of [{}, { modoRua: null }, { modoRua: 'lixo' }, { modoRua: { ociosoMin: 241 } }, { modoRua: { ociosoMin: 4 } }]) {
    const x = montar(extra);
    assert.equal((await minuto(x, 29)).ligado, false, `${JSON.stringify(extra)}: 29 min nao liga`);
    assert.equal((await minuto(x, 30)).ligado, true, `${JSON.stringify(extra)}: 30 min liga`);
  }
});

test('A5a 7. modo rua com automatico false: 60 min de PC parado nao liga; o /rua liga (pelo comando, com a carencia de antes) e o PC parado nao o desliga', async () => {
  const h = montar({ modoRua: { automatico: false, ociosoMin: 10 } });
  for (const n of [10, 30, 60, 240]) assert.equal((await minuto(h, n)).ligado, false, `${n} min: nao liga`);
  mexer(h, (e) => { e.tg.offset = 0; }); // o historico do Telegram ja foi pulado
  h.tg.lotes.push([msgTg(h, '/rua')]);
  await h.p.esperarTelegram(15000);
  let m = estado(h).modoRua;
  assert.equal(m.ligado, true, 'o /rua liga');
  assert.notEqual(m.motivo, 'ocioso');
  assert.ok(Number.isFinite(Date.parse(m.comandoEm)), 'pelo comando (a carencia vale)');
  m = await minuto(h, 60);
  assert.equal(m.ligado, true, 'o PC parado nao desliga');
  // o dono no PC: so depois da carencia de 5 min do comando (como antes)
  h.t = Date.parse(m.comandoEm) + 4 * MIN - 1000;
  h.idle = 0;
  await h.p.passoMinuto();
  assert.equal(estado(h).modoRua.ligado, true, 'dentro da carencia: segue');
  h.t = Date.parse(m.comandoEm) + 5 * MIN;
  await h.p.passoMinuto();
  assert.equal(estado(h).modoRua.ligado, false, 'depois da carencia: o dono no PC desliga');
  await tique();
});

// ---------- 8. o --model do mensageiro ----------

function spawnFalso() {
  const chamadas = [];
  const spawn = (bin, args, opts) => {
    chamadas.push({ bin, args, opts });
    const filho = new EventEmitter();
    filho.stdout = new EventEmitter();
    filho.stderr = new EventEmitter();
    filho.kill = () => true;
    setImmediate(() => {
      filho.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ENVIADO' })));
      filho.emit('close', 0, null);
    });
    return filho;
  };
  return { spawn, chamadas };
}
const PEDIDO = { sessionId: 's1', nome: 'projetos-42', titulo: 'Faro', texto: 'pode seguir', audio: false, hora: '12:00',
  providerMsgId: '3EB0AAAA0000BBBB1111CC', messageId: 'uuid-1', anexos: [] };

test('A5a 8. criarMensageiro({modelo}): o spawn leva --model <modelo> (1 vez so); sem modelo ou fora do formato = sonnet', async () => {
  const casos = [[{ modelo: 'opus' }, 'opus'], [{ modelo: '  claude-opus-4-1  ' }, 'claude-opus-4-1'], [{}, 'sonnet'],
    [{ modelo: '--dangerously-skip-permissions' }, 'sonnet'], [{ modelo: 'opus 4' }, 'sonnet'], [{ modelo: 7 }, 'sonnet'],
    [{ modelo: null }, 'sonnet']];
  for (const [extra, esperado] of casos) {
    const d = spawnFalso();
    const m = mensageiro.criarMensageiro({ claudeBin: 'C:/x/claude.exe', spawn: d.spawn, estadoDir: pastaTemp('a5a-mens-'), ...extra });
    const r = await m.entregar(PEDIDO);
    assert.equal(r.status, 'enviado', JSON.stringify(extra));
    assert.equal(d.chamadas.length, 1);
    const args = d.chamadas[0].args;
    assert.equal(args.filter((a) => a === '--model').length, 1, `${JSON.stringify(extra)}: 1 --model so`);
    assert.equal(args[args.indexOf('--model') + 1], esperado, JSON.stringify(extra));
    assert.equal(args.includes('sonnet') && esperado !== 'sonnet', false, `${JSON.stringify(extra)}: o sonnet chumbado saiu`);
  }
});

// ---------- 9. a voz ----------

test('A5a 9. falar(texto, {voz}): a Microsoft recebe a voz dada (sem ela = o Antonio); o montarSsml tira o xml:lang dos 5 primeiros caracteres da voz', async () => {
  const OGG = oggOpus();
  const chamadas = [];
  const ms = async (texto, o) => { chamadas.push({ texto, o }); return OGG; };
  assert.ok((await voz.falar('Bom dia.', { voz: 'en-US-GuyNeural', falarMicrosoft: ms })).equals(OGG));
  assert.equal(chamadas[0].o.voz, 'en-US-GuyNeural');
  await voz.falar('Bom dia.', { falarMicrosoft: ms });
  assert.equal(chamadas[1].o.voz, 'pt-BR-AntonioNeural', 'sem voz = a de hoje');
  await voz.falar('Bom dia.', { voz: 'pt-BR-FranciscaNeural', falarMicrosoft: ms, prazoMs: 1234 });
  assert.deepEqual([chamadas[2].o.voz, chamadas[2].o.prazoMs], ['pt-BR-FranciscaNeural', 1234]);
  for (const [nome, lang] of [['en-US-GuyNeural', 'en-US'], ['pt-BR-FranciscaNeural', 'pt-BR'], ['es-ES-AlvaroNeural', 'es-ES']]) {
    const s = vozMs.montarSsml(nome, 'oi');
    assert.ok(s.includes(`xml:lang='${lang}'><voice name='${nome}'>`), s);
    assert.equal(s.split('xml:lang=').length, 2, 'um xml:lang so');
  }
});

// ---------- 10-12. o aviso de saude ----------

function fetchConta() {
  const rede = [];
  const f = async (url, init) => { rede.push({ url, headers: init.headers, corpo: JSON.parse(init.body) }); return { ok: true, status: 200 }; };
  f.rede = rede;
  return f;
}
// env que conta cada leitura
function envEspiao(valores = {}) {
  const lidos = [];
  const env = new Proxy({ ...valores }, { get(t, k) { lidos.push(k); return t[k]; }, has(t, k) { lidos.push(k); return k in t; } });
  return { env, lidos };
}

test('A5a 10. criarAvisoTelegram sem varUrl bom: false sem ler o ambiente, o registro nem a rede, e 1 linha "sem canal de aviso (sem saude.varUrl no config.json)"', async () => {
  for (const extra of [{}, { varUrl: undefined }, { varUrl: null }, { varUrl: '' }, { varUrl: '1X' }, { varUrl: 'SAUDE-URL' },
    { varUrl: 7 }, { varUrl: [VAR] }]) {
    const f = fetchConta();
    const { env, lidos } = envEspiao({ [VAR]: PORTAO, PAINEL: PORTAO });
    let regs = 0;
    const linhas = [];
    const avisar = porteiro.criarAvisoTelegram({ env, fetch: f, lerRegistro: async () => { regs += 1; return PORTAO; }, log: (m) => linhas.push(m), chatId: CHAT, ...extra });
    assert.equal(await avisar('x'), false, JSON.stringify(extra));
    assert.equal(await avisar('de novo'), false);
    assert.deepEqual(lidos, [], `${JSON.stringify(extra)}: nenhuma leitura do ambiente`);
    assert.equal(regs, 0, `${JSON.stringify(extra)}: nenhuma leitura do registro`);
    assert.equal(f.rede.length, 0, `${JSON.stringify(extra)}: nenhuma chamada de rede`);
    assert.deepEqual(linhas, [SEM_VAR], `${JSON.stringify(extra)}: 1 linha so`);
  }
});

test('A5a 11. criarAvisoTelegram com varUrl: a URL do ambiente por esse nome; sem ela, a do registro pelo mesmo nome (outro nome no ambiente nao vale)', async () => {
  // pelo ambiente
  let f = fetchConta();
  let nomesReg = [];
  let avisar = porteiro.criarAvisoTelegram({ env: { OUTRA_VAR: PORTAO2, [VAR]: PORTAO }, fetch: f, lerRegistro: async (n) => { nomesReg.push(n); return null; }, log: () => {}, chatId: CHAT, varUrl: 'OUTRA_VAR' });
  assert.equal(await avisar('pelo ambiente'), true);
  assert.equal(f.rede[0].url, `${PORTAO2}/sendMessage`, 'a variavel do varUrl');
  assert.deepEqual(nomesReg, [], 'com o ambiente, o registro nem e lido');
  // so outro nome no ambiente: vai pro registro pelo nome do varUrl
  f = fetchConta();
  nomesReg = [];
  avisar = porteiro.criarAvisoTelegram({ env: { [VAR]: PORTAO }, fetch: f, lerRegistro: async (n) => { nomesReg.push(n); return `${PORTAO2}/`; }, log: () => {}, chatId: CHAT, varUrl: '  OUTRA_VAR ' });
  assert.equal(await avisar('pelo registro'), true);
  assert.deepEqual(nomesReg, ['OUTRA_VAR'], 'o registro pelo mesmo nome (aparado)');
  assert.equal(f.rede[0].url, `${PORTAO2}/sendMessage`);
  // nenhum dos 2: sem canal (a linha de antes)
  f = fetchConta();
  const linhas = [];
  avisar = porteiro.criarAvisoTelegram({ env: { [VAR]: PORTAO }, fetch: f, lerRegistro: async () => null, log: (m) => linhas.push(m), chatId: CHAT, varUrl: 'OUTRA_VAR' });
  assert.equal(await avisar('x'), false);
  assert.equal(f.rede.length, 0);
  assert.equal(linhas.length, 1);
  assert.match(linhas[0], /sem canal de aviso/);
});

test('A5a 12. criarAvisoTelegram: a maquina no cabecalho do texto, no User-Agent (sessoes-wpp/1.0 (<maquina>)) e no X-Maquina; sem maquina ou fora do formato = pc', async () => {
  for (const [maquina, esperado] of [['notebook', 'notebook'], ['  vps-1 ', 'vps-1'], [undefined, 'pc'], ['pc_1', 'pc'], ['', 'pc'],
    ['A'.repeat(21), 'pc'], [7, 'pc']]) {
    const f = fetchConta();
    const avisar = porteiro.criarAvisoTelegram({ env: { [VAR]: PORTAO }, fetch: f, lerRegistro: async () => null, log: () => {}, chatId: CHAT, varUrl: VAR, maquina });
    assert.equal(await avisar('caiu'), true, String(maquina));
    const c = f.rede[0];
    assert.deepEqual(c.corpo, { chat_id: CHAT, text: `*sessoes-wpp (${esperado})*\ncaiu`, parse_mode: 'Markdown' }, String(maquina));
    assert.equal(c.headers['User-Agent'], `sessoes-wpp/1.0 (${esperado})`, String(maquina));
    assert.equal(c.headers['X-Maquina'], esperado, String(maquina));
    assert.equal(c.headers['X-Fonte'], 'sessoes-wpp');
  }
});

test('A5a 13. prepararTelegram: o aviso com o varUrl (saudeDoConfig) e a maquina (maquinaDoConfig) do mesmo config.json; sem eles = null e pc', async () => {
  const dir = pastaTemp('a5a-preparar-');
  const cfg = (obj) => fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(obj));
  const preparar = async () => {
    const avisos = [];
    await porteiro.prepararTelegram({
      estadoDir: dir, env: {}, log: () => {}, chave: async () => null, ligar: async () => null,
      criarAviso: (o) => { avisos.push(o); return async () => true; }, criar: () => { throw new Error('nunca'); },
    });
    assert.equal(avisos.length, 1);
    return avisos[0];
  };
  cfg({ telegram: { chatId: CHAT }, saude: { varUrl: ` ${VAR} ` }, maquina: { nome: 'notebook' } });
  let a = await preparar();
  assert.deepEqual([a.chatId, a.varUrl, a.maquina], [CHAT, VAR, 'notebook']);
  cfg({ telegram: { chatId: CHAT }, saude: { varUrl: '1X' }, maquina: { nome: 'pc_1' } });
  a = await preparar();
  assert.deepEqual([a.varUrl, a.maquina], [null, 'pc'], 'fora do formato');
  fs.rmSync(path.join(dir, 'config.json'));
  a = await preparar();
  assert.deepEqual([a.chatId, a.varUrl, a.maquina], [null, null, 'pc'], 'sem config');
});

// ---------- 14. lib/registro.mjs ----------

test('A5a 14. valorDoReg e lerRegistroReal sem o nome padrao: sem nome bom = null (sem rodar o reg); com nome = o valor dele', async () => {
  const saida = `\r\nHKEY_CURRENT_USER\\Environment\r\n    ${VAR}    REG_SZ    ${PORTAO}\r\n\r\n`;
  assert.equal(registro.valorDoReg(saida, VAR), PORTAO);
  for (const nome of [undefined, null, '', '   ', 7, [VAR]]) assert.equal(registro.valorDoReg(saida, nome), null, JSON.stringify(nome));
  for (const nome of [undefined, null, '', '   ', 7]) {
    // sem rodar o reg: a resposta chega antes do proximo giro do laco (um processo filho nunca responde tao cedo)
    const r = await Promise.race([registro.lerRegistroReal(nome), new Promise((ok) => setImmediate(() => ok('rodou o reg')))]);
    assert.equal(r, null, JSON.stringify(nome));
  }
  const fonte = fs.readFileSync(path.join(REPO, 'lib', 'registro.mjs'), 'utf8');
  assert.equal(/function valorDoReg\(saida, nome =/.test(fonte) || /function lerRegistroReal\(nome =/.test(fonte), false, 'sem nome padrao');
});

// ---------- 15. o rodar pelo fonte ----------

test('A5a 15. pelo fonte: o rodar tira o modo rua, o modelo e a voz do mesmo config, passa o modoRua ao criarPorteiro, o modelo ao criarMensageiro e a voz ao falar, e loga o modo rua logo depois do fuso:', () => {
  const fonte = fs.readFileSync(path.join(REPO, 'porteiro.mjs'), 'utf8');
  // so o corpo do rodar: do "async function rodar(" ate a proxima funcao do topo do arquivo
  const ini = fonte.indexOf('async function rodar(');
  const depois = fonte.slice(ini + 1).search(/\n(?:async )?function /);
  const r = depois === -1 ? fonte.slice(ini) : fonte.slice(ini, ini + 1 + depois);
  assert.ok(ini > 0 && r.includes('log(`subiu (pid'), 'o corpo do rodar');
  assert.equal(r.match(/\blerConfig\(/g)?.length, 1, 'o config lido 1 vez');
  const cfgEm = r.indexOf('const cfg = lerConfig(C.estadoDir);');
  const ruaEm = r.indexOf('const rua = modoRuaDoConfig(cfg);');
  const modeloEm = r.indexOf('const modelo = mensageiroDoConfig(cfg).modelo;');
  const vozEm = r.indexOf('const voz = vozDoConfig(cfg).nome;');
  assert.ok(cfgEm > 0 && ruaEm > cfgEm && modeloEm > cfgEm && vozEm > cfgEm, 'do mesmo cfg');
  const mensEm = r.indexOf('criarMensageiro({ estadoDir: C.estadoDir, claudeBin: claude, dono, modelo })');
  assert.ok(mensEm > modeloEm, 'o modelo no criarMensageiro');
  const portEm = r.indexOf('const p = criarPorteiro({');
  const fimPort = r.indexOf('\n  });', portEm);
  const chamada = r.slice(portEm, fimPort);
  assert.ok(portEm > ruaEm && /\n {4}modoRua: rua,/.test(chamada), 'o modoRua no criarPorteiro');
  assert.ok(chamada.includes('falar: (texto) => falarVoz(texto, { voz }),') && portEm > vozEm, 'a voz no falar');
  const fusoEm = r.indexOf('  log(`fuso: ${fusoAtual()}`);');
  const linhaRua = "  log(rua.automatico ? `modo rua: sozinho com o PC parado ${rua.ociosoMin} min` : 'modo rua: so pelo comando');";
  const logEm = r.indexOf(linhaRua);
  assert.ok(fusoEm > 0 && logEm > fusoEm, 'a linha do modo rua depois do fuso:');
  assert.equal(r.slice(fusoEm, logEm).split('\n').length, 2, 'logo depois do fuso:');
  assert.ok(logEm < r.indexOf('log(`subiu (pid'), 'antes do subiu');
  assert.equal(fonte.includes('OCIOSO_LIGA_MS'), false, 'saiu o OCIOSO_LIGA_MS');
});
