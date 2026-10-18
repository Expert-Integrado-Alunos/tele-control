// Testes do ler-grupo (fase 5a, T3c: PLANO-TELEGRAM.md, "Contratos", T3c).
// Por que existe: a central descobre a dona de uma fala do dono sem citacao lendo as ultimas mensagens. No Telegram a
// leitura vem do estado.json do porteiro (`--telegram`, sem rede e sem o wpp): as falas do dono (e.tg.recebidas) + a
// mensagem na tela do chamado de cada aba, no MESMO formato da leitura do grupo. Sem `--telegram` segue indo pro grupo.
// Isolamento: processo filho com SESSOES_WPP_DIR, USERPROFILE e HOME temporarios (nunca o ~/.claude real nem o
// ~/.claude.json real: sem ele o caminho do grupo lanca antes de qualquer rede). Nenhuma rede.
// Rodar: node --test --test-reporter=tap "tests/ler-grupo.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { lerEstado, linhasTelegram, linha, sessaoDoCabecalho } from '../ler-grupo.mjs';
import { WHATSAPP } from './lib/dados-whatsapp.mjs';

const ARQ = fileURLToPath(new URL('../ler-grupo.mjs', import.meta.url));
const MIN = 60 * 1000;
const T0 = Date.parse('2026-09-29T15:00:00Z'); // 12:00 em Brasilia
const iso = (ms) => new Date(ms).toISOString();

function pasta() {
  const raiz = pastaTemp('ler-grupo-');
  const estadoDir = path.join(raiz, 'estado');
  const home = path.join(raiz, 'home'); // vazia: sem .claude.json
  fs.mkdirSync(estadoDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { raiz, estadoDir, home, arq: path.join(estadoDir, 'estado.json') };
}

// Roda o ler-grupo num processo filho so com o env temporario (+ PATH e SystemRoot, que o node do Windows usa).
function rodar(args, { estado, cru, p = pasta() } = {}) {
  if (estado !== undefined) fs.writeFileSync(p.arq, JSON.stringify(estado, null, 2));
  if (cru !== undefined) fs.writeFileSync(p.arq, cru);
  const env = { SESSOES_WPP_DIR: p.estadoDir, USERPROFILE: p.home, HOME: p.home };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const r = spawnSync(process.execPath, [ARQ, ...args], { env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(r.error, undefined, String(r.error));
  return { status: r.status, out: r.stdout, err: r.stderr };
}
const linhas = (out) => out.split(/\r?\n/).filter(Boolean);

const LONGO = 'palavra '.repeat(40).trim(); // 319 caracteres
const FINAL_S1 = 'Terminei a revisão.\n\n---\n🔴 **DECISÃO:** Publico?   A) Sim / B) Não';

// Estado do porteiro com o tg como o canal-telegram grava (chamados, mensagens, sistema) e o recebidas da T3a/T3c.
function estadoTg() {
  const chamado = (versao, mensagem) => ({ versao: { chamadoId: null, opcoes: [], ...versao }, descer: false, mensagem, apagar: [], mudouEm: iso(T0) });
  return {
    v: 1,
    modoRua: { ligado: false, atualizadoEm: iso(T0) },
    tg: {
      offset: 200,
      vistos: [],
      seq: 9,
      chamados: {
        // na tela desde 11:56 (mensagens[901].at); a versao.hora (11:55) so vale sem a mensagem
        S1: chamado({ id: 3, estado: 'aviso', titulo: 'Faro', hora: iso(T0 - 5 * MIN), final: FINAL_S1 }, { messageId: 901, formato: 'rich', versaoId: 3 }),
        // sem titulo (8 primeiros do sessionId), sem final (so o estado), sem mensagens[903] (hora = versao.hora)
        'abcdef1234-5678-90ab': chamado({ id: 5, estado: 'enviando', titulo: null, hora: iso(T0 + 2 * MIN), final: '' }, { messageId: 903, formato: 'rich', versaoId: 5 }),
        // sem mensagem na tela: fora
        S3: chamado({ id: 6, estado: 'aviso', titulo: 'Sem tela', hora: iso(T0), final: 'x' }, null),
        // hora ilegivel (mensagem sem at, versao.hora ruim): fora
        S4: chamado({ id: 7, estado: 'resposta', titulo: 'Hora ruim', hora: 'ontem', final: 'y' }, { messageId: 904, formato: 'rich', versaoId: 7 }),
      },
      mensagens: {
        901: { sessionId: 'S1', at: iso(T0 - 4 * MIN), formato: 'rich' },
        902: { sessionId: 'sistema', at: iso(T0 - 2 * MIN), formato: 'rich' }, // a do sistema: fora
        904: { sessionId: 'S4', formato: 'rich' },
        905: { sessionId: 'S9', at: iso(T0 + MIN), formato: 'rich' }, // fora de chamado: fora
      },
      saida: [],
      sistema: {
        linhas: [{ hora: iso(T0 - 2 * MIN), texto: 'Modo rua ligado.' }], versaoId: 2, descer: false, notificar: false,
        mensagem: { messageId: 902, formato: 'rich', versaoId: 2 }, apagar: [],
      },
      recebidas: {
        'tg-u101': { at: iso(T0 - 3 * MIN), texto: 'sim,   pode\npublicar', audio: false, anexos: [], respondeA: 901 },
        'tg-u102': { at: iso(T0 - MIN), texto: 'bom dia', audio: false, anexos: [] }, // entrada antiga, sem respondeA
        'tg-u103': { at: iso(T0 + MIN), texto: '', audio: false, anexos: [{ tipo: 'foto', caminho: 'C:/x.jpg' }], respondeA: null },
        'tg-u104': { at: 'ontem', texto: 'fora', audio: false, anexos: [], respondeA: null }, // hora ilegivel: fora
        'tg-u105': { at: iso(T0 + 3 * MIN), texto: LONGO, audio: false, anexos: [], respondeA: null },
        'tg-u106': { at: iso(T0 + 4 * MIN), texto: 'A) Sim', audio: false, anexos: [], respondeA: null }, // toque
      },
      audios: {},
      midiaPendente: [],
      saude: {},
    },
  };
}

const ESPERADO = [
  '11:56  agente  id=901  [Sessão Faro]  aviso: Terminei a revisão. --- 🔴 **DECISÃO:** Publico? A) Sim / B) Não',
  '11:57  dono    id=tg-u101  cita=901  sim, pode publicar',
  '11:59  dono    id=tg-u102  bom dia',
  '12:01  dono    id=tg-u103  (anexo)',
  '12:02  agente  id=903  [Sessão abcdef12]  enviando',
  `12:03  dono    id=tg-u105  ${LONGO.slice(0, 237)}...`,
  '12:04  dono    id=tg-u106  A) Sim',
];

test('T3c 1. --telegram: falas do dono + chamados na tela em ordem de hora, formato exato (cita, Sessão, 240 com ..., espacos colapsados); fora: sem tela, sistema, fora de chamado, hora ilegivel', () => {
  const r = rodar(['--telegram', '15'], { estado: estadoTg() });
  assert.equal(r.status, 0, r.err);
  assert.equal(r.err, '');
  assert.deepEqual(linhas(r.out), ESPERADO);
  assert.equal(linhas(r.out)[5].length, '12:03  dono    id=tg-u105  '.length + 240, 'texto em ate 240 caracteres');
  // a funcao pura e a mesma saida
  assert.deepEqual(linhasTelegram(estadoTg(), 15), ESPERADO);
});

test('T3c 2. --telegram: N limita as ultimas; --telegram antes ou depois do N; padrao 15, teto 50', () => {
  const p = pasta();
  fs.writeFileSync(p.arq, JSON.stringify(estadoTg()));
  assert.deepEqual(linhas(rodar(['--telegram', '2'], { p }).out), ESPERADO.slice(-2));
  assert.deepEqual(linhas(rodar(['2', '--telegram'], { p }).out), ESPERADO.slice(-2));
  assert.deepEqual(linhas(rodar(['--telegram'], { p }).out), ESPERADO);

  const e = estadoTg();
  e.tg.chamados = {};
  e.tg.recebidas = {};
  for (let i = 0; i < 60; i += 1) {
    e.tg.recebidas[`tg-u${300 + i}`] = { at: iso(T0 + i * 1000), texto: `fala ${i}`, audio: false, anexos: [], respondeA: null };
  }
  fs.writeFileSync(p.arq, JSON.stringify(e));
  let out = linhas(rodar(['--telegram'], { p }).out);
  assert.equal(out.length, 15);
  assert.deepEqual([out[0], out.at(-1)], ['12:00  dono    id=tg-u345  fala 45', '12:00  dono    id=tg-u359  fala 59']);
  out = linhas(rodar(['80', '--telegram'], { p }).out);
  assert.equal(out.length, 50);
  assert.equal(out[0], '12:00  dono    id=tg-u310  fala 10');
});

test('T3c 3. --telegram: sem estado.json, sem tg, tg vazio ou lixo = nada e exit 0 calado; JSON ruim = nada, exit 0 e 1 linha no stderr; arquivo que nao se le = exit 1 e 1 linha', () => {
  let r = rodar(['--telegram']);
  assert.deepEqual([r.status, r.out, r.err], [0, '', ''], 'sem estado.json');
  r = rodar(['--telegram'], { estado: { v: 1, modoRua: { ligado: false } } });
  assert.deepEqual([r.status, r.out, r.err], [0, '', ''], 'sem tg');
  r = rodar(['--telegram'], { estado: { tg: { chamados: {}, mensagens: {}, recebidas: {} } } });
  assert.deepEqual([r.status, r.out, r.err], [0, '', ''], 'tg vazio');
  r = rodar(['--telegram'], { estado: { tg: { chamados: 'x', mensagens: null, recebidas: [1, 2] } } });
  assert.deepEqual([r.status, r.out, r.err], [0, '', ''], 'tg com lixo');
  r = rodar(['--telegram'], { estado: { tg: 'lixo' } });
  assert.deepEqual([r.status, r.out, r.err], [0, '', ''], 'tg que nao e objeto');

  r = rodar(['--telegram'], { cru: '{"tg": {"recebidas": ' });
  assert.equal(r.status, 0);
  assert.equal(r.out, '');
  assert.equal(linhas(r.err).length, 1, r.err);

  const p = pasta();
  fs.mkdirSync(p.arq); // estado.json que e pasta: a leitura falha (nao e "ocupado")
  r = rodar(['--telegram'], { p });
  assert.equal(r.status, 1);
  assert.equal(r.out, '');
  assert.equal(linhas(r.err).length, 1, r.err);
});

test('T3c 4. lerEstado: arquivo ocupado (EBUSY/EPERM/EACCES) tenta ate 3x com 200 ms; sem arquivo = null sem esperar; JSON ruim = ruim', async () => {
  const falha = (code) => Object.assign(new Error(code), { code });
  const dormidas = [];
  const dormir = async (ms) => { dormidas.push(ms); };
  for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
    let n = 0;
    dormidas.length = 0;
    let r = await lerEstado('x', { ler: () => { n += 1; if (n < 3) throw falha(code); return '{"tg":{}}'; }, dormir });
    assert.deepEqual(r, { estado: { tg: {} } }, code);
    assert.equal(n, 3, code);
    assert.deepEqual(dormidas, [200, 200], code);

    n = 0;
    dormidas.length = 0;
    r = await lerEstado('x', { ler: () => { n += 1; throw falha(code); }, dormir });
    assert.deepEqual(r, { erro: code }, code);
    assert.equal(n, 3, `${code}: 3 tentativas e para`);
    assert.deepEqual(dormidas, [200, 200]);
  }
  dormidas.length = 0;
  assert.deepEqual(await lerEstado('x', { ler: () => { throw falha('ENOENT'); }, dormir }), { estado: null });
  assert.deepEqual(await lerEstado('x', { ler: () => '{ruim', dormir }), { ruim: true });
  assert.deepEqual(await lerEstado('x', { ler: () => { throw falha('EISDIR'); }, dormir }), { erro: 'EISDIR' });
  assert.deepEqual(dormidas, [], 'sem arquivo, JSON ruim e outro erro nao esperam');
});

test('T3c 5. sem --telegram segue indo pro grupo (wpp): com o home vazio o wppDoClaudeJson lanca antes de qualquer rede = exit != 0 e nenhuma linha; o estado.json nao e lido', () => {
  for (const args of [['15'], []]) {
    const p = pasta();
    // A2a: o grupo so com o bloco `whatsapp` completo no config.json (sem ele = "WhatsApp desligado", A2a 13)
    fs.writeFileSync(path.join(p.estadoDir, 'config.json'), JSON.stringify({ whatsapp: WHATSAPP }));
    const r = rodar(args, { estado: estadoTg(), p });
    assert.notEqual(r.status, 0, `${args}: ${r.out}`);
    assert.equal(r.out, '', 'nenhuma linha de mensagem');
    assert.ok(r.err.includes('.claude.json'), r.err);
  }
});

// Achado da validacao da T3c (sabotagem "corte em 300" verde: o texto longo do T3c 1 tem 319 caracteres)
test('T3c 6. linha: texto de 240 caracteres sai inteiro; 241 = 237 + "..."', () => {
  const base = { hora: '12:00', quem: 'Davi', id: 'tg-u1' };
  const t240 = 'a'.repeat(240);
  assert.equal(linha({ ...base, texto: t240 }), `12:00  Davi    id=tg-u1  ${t240}`);
  assert.equal(linha({ ...base, texto: `${t240}b` }), `12:00  Davi    id=tg-u1  ${'a'.repeat(237)}...`);
});

// F4g (pedido do dono): o cabecalho das mensagens das abas virou "ℹ️ *Nome*"; o grupo ainda tem as de antes.
test('F4g ler-grupo: sessao do cabecalho novo (icone + nome) e do antigo ("*Sessão X (pc)*"); frase do porteiro e texto solto = nenhuma', () => {
  assert.equal(sessaoDoCabecalho('ℹ️ *Faro*\nPronto.\n\n*Publico?*'), 'Faro');
  assert.equal(sessaoDoCabecalho('ℹ *Sem seletor*\nok'), 'Sem seletor');
  assert.equal(sessaoDoCabecalho('*Sessão Faro (pc)*\nParou às 16:00, esperando você.'), 'Faro');
  assert.equal(sessaoDoCabecalho('*Sessao Brain (pc)*\nx'), 'Brain');
  assert.equal(sessaoDoCabecalho('ℹ️ *Controle de sessões*\nTravado.'), undefined, 'frase do porteiro (historico ℹ️)');
  assert.equal(sessaoDoCabecalho('🎛️ *Controle de sessões*\nTravado.'), undefined, 'frase do porteiro (icone novo 🎛️)');
  assert.equal(sessaoDoCabecalho('*Controle de sessões (pc)*\nTravado.'), undefined);
  for (const solto of ['*negrito* do Davi', 'oi', '', null, undefined]) assert.equal(sessaoDoCabecalho(solto), undefined, String(solto));
});
