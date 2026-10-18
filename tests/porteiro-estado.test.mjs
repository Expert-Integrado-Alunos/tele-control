// Testes do estado do porteiro (T7h, 04/10/2026).
// Por que existe: em 03/10/2026 16:25 o PC desligou sem desligamento correto (queda de energia ou travamento). O
// estado.json voltou ilegivel (o rename estava no disco, os dados do tmp nao), o porteiro recomecou do zero as 00:55 e a
// fala do dono no grupo das 19:28 ("Tem alguma sessão pendente pra mim?") nunca foi lida: o cursor novo nasce em "agora".
// Isolamento: pastas temporarias via SESSOES_WPP_DIR, CLAUDE_SESSIONS_DIR, CLAUDE_PROJECTS_DIR e SESSOES_WPP_LOG.
// Rodar: node --test "tests/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pastaTemp } from './lib/pasta-temp.cjs';
import * as porteiroMod from '../porteiro.mjs';
import { NUMERO_DONO } from './lib/dados-whatsapp.mjs';
import { CENTRAL_TESTE, RAIZES_TESTE } from './lib/dados-central.mjs';

const T0 = Date.parse('2026-10-04T04:00:00Z'); // 01:00 em Brasilia

function montar() {
  const raiz = pastaTemp('porteiro-estado-');
  const env = {
    SESSOES_WPP_DIR: path.join(raiz, 'estado'),
    CLAUDE_SESSIONS_DIR: path.join(raiz, 'sessions'),
    CLAUDE_PROJECTS_DIR: path.join(raiz, 'projects'),
    SESSOES_WPP_LOG: path.join(raiz, 'porteiro.log'),
  };
  for (const d of [env.SESSOES_WPP_DIR, env.CLAUDE_SESSIONS_DIR, env.CLAUDE_PROJECTS_DIR]) fs.mkdirSync(d, { recursive: true });
  const wpp = {
    async lerGrupo() { return []; },
    async enviarGrupo() { return { ok: true, providerMsgId: 'P1', messageId: 'U1' }; },
    async reagir() { return { ok: true }; },
    async editarGrupo() { return { ok: true }; },
  };
  const mensageiro = { async entregar() { return { status: 'enviado', detalhe: '' }; } };
  const p = porteiroMod.criarPorteiro({
    wpp, numeroDono: NUMERO_DONO, mensageiro, ocioso: async () => 0, agora: () => T0, env, ensaio: false, abrirCentral: () => {},
    central: CENTRAL_TESTE, raizesSessao: RAIZES_TESTE, // A3a: a central e as pastas como o dono configura
  });
  return { raiz, env, p, estado: path.join(env.SESSOES_WPP_DIR, 'estado.json') };
}

const lerLog = (h) => (fs.existsSync(h.env.SESSOES_WPP_LOG) ? fs.readFileSync(h.env.SESSOES_WPP_LOG, 'utf8') : '');
const guardados = (h) => fs.readdirSync(h.env.SESSOES_WPP_DIR).filter((n) => n.startsWith('estado.json.ilegivel-'));

test('T7h 1. gravarAtomico: os dados vao pro disco (flush) ANTES do rename; o arquivo final fica certo e sem tmp', () => {
  assert.equal(typeof porteiroMod.gravarAtomico, 'function', 'gravarAtomico exportada (o teste olha a ordem das chamadas)');
  const raiz = pastaTemp('porteiro-estado-');
  const arq = path.join(raiz, 'sub', 'estado.json');
  const chamadas = [];
  const io = {
    mkdirSync: (...a) => { chamadas.push(['mkdir']); return fs.mkdirSync(...a); },
    writeFileSync: (f, dados, opcoes) => { chamadas.push(['write', path.basename(f), opcoes]); return fs.writeFileSync(f, dados, opcoes); },
    renameSync: (de, para) => { chamadas.push(['rename', path.basename(para)]); return fs.renameSync(de, para); },
    unlinkSync: (f) => { chamadas.push(['unlink']); return fs.unlinkSync(f); },
  };
  porteiroMod.gravarAtomico(arq, { v: 1, cursor: 'x' }, io);
  const iw = chamadas.findIndex((c) => c[0] === 'write');
  const ir = chamadas.findIndex((c) => c[0] === 'rename');
  assert.ok(iw >= 0 && ir > iw, `escreve e so depois renomeia (${JSON.stringify(chamadas)})`);
  assert.equal(chamadas[iw][2]?.flush, true, 'flush: true (fsync) na escrita do tmp: sem ele a queda de energia zera o arquivo');
  assert.notEqual(chamadas[iw][1], 'estado.json', 'escreve no tmp, nunca direto no arquivo');
  assert.equal(chamadas[ir][1], 'estado.json');
  assert.equal(chamadas.filter((c) => c[0] === 'write').length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(arq, 'utf8')), { v: 1, cursor: 'x' });
  assert.deepEqual(fs.readdirSync(path.dirname(arq)), ['estado.json'], 'nenhum tmp sobrando');
});

test('T7h 2. estado.json ilegivel (bytes zerados da queda): o arquivo ruim fica guardado com outro nome e o porteiro recomeca do zero', async () => {
  const h = montar();
  const ruim = Buffer.alloc(300); // o que o NTFS devolve depois da queda: o tamanho certo e so zeros
  fs.writeFileSync(h.estado, ruim);
  await h.p.passoEventos();
  const g = guardados(h);
  assert.equal(g.length, 1, `o ilegivel fica guardado, 1 arquivo (${fs.readdirSync(h.env.SESSOES_WPP_DIR).join(', ')})`);
  assert.deepEqual(fs.readFileSync(path.join(h.env.SESSOES_WPP_DIR, g[0])), ruim, 'com os bytes de antes, intactos');
  const novo = JSON.parse(fs.readFileSync(h.estado, 'utf8'));
  assert.equal(novo.v, 1, 'estado novo gravado no lugar');
  const log = lerLog(h);
  assert.match(log, /estado ilegivel: recomecando do zero/);
  assert.ok(log.includes(g[0]), `o log diz onde o ilegivel ficou (${log.trim()})`);
});

test('T7h 3. sem estado.json (1a subida): nada e guardado como ilegivel e o log nao fala em ilegivel', async () => {
  const h = montar();
  await h.p.passoEventos();
  assert.deepEqual(guardados(h), []);
  assert.equal(JSON.parse(fs.readFileSync(h.estado, 'utf8')).v, 1);
  assert.doesNotMatch(lerLog(h), /ilegivel/);
});

test('T7h 4. estado.json legivel: segue como esta (nada guardado, cursor de antes mantido)', async () => {
  const h = montar();
  await h.p.passoEventos(); // 1a subida grava o estado
  const antes = JSON.parse(fs.readFileSync(h.estado, 'utf8'));
  antes.cursor = '2026-10-03T18:46:00.000Z'; // o porteiro parou antes da queda: o cursor velho e o que acha a fala perdida
  fs.writeFileSync(h.estado, JSON.stringify(antes));
  await h.p.passoEventos();
  assert.deepEqual(guardados(h), []);
  assert.equal(JSON.parse(fs.readFileSync(h.estado, 'utf8')).cursor, '2026-10-03T18:46:00.000Z');
  assert.doesNotMatch(lerLog(h), /ilegivel/);
});
