// Testes do pedido de PERMISSAO DO APP no ok-wpp (06/11/2026; caso real: a aba do Desktop ficou 6 h parada num "Permitir
// uma vez" com o dono na rua e nada chegou no Telegram). O hook PermissionRequest pede com `--tipo permissao`: so pelo
// Telegram (nunca no grupo do WhatsApp), validade curta (--validade-min), e cancela quando a tela respondeu antes
// (na-tela) ou ninguem respondeu (sem-resposta). O Sim continua valendo SO pelo toque conferido no servidor do Telegram.
// Isolamento: pastas temporarias (prefixo "perm-ok-"); wpp, espiar, porteiroVivo e dormir dublados. Nada de rede.
// Rodar: node --test --test-reporter=tap "tests/ok-wpp-permissao.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pastaTemp } from './lib/pasta-temp.cjs';
import * as okWpp from '../ok-wpp.mjs';
import { montarOkTg } from '../lib/ok-tg.mjs';
import { NUMERO_DONO, NUMERO_ROBO } from './lib/dados-whatsapp.mjs';

process.env.TZ ??= 'America/Sao_Paulo';

const { criarOkWpp, codigoDeSaida, SO_TELEGRAM, MOTIVOS_CANCELAR } = okWpp;
const OK_WPP = fileURLToPath(new URL('../ok-wpp.mjs', import.meta.url));
const MIN = 60 * 1000;
const T0 = Date.parse('2026-11-06T10:00:00Z');
const SID = '11111111-2222-4333-8444-555555555555';
const OUTRA = '99999999-8888-4777-8666-555555555555';
const PID = 4242;
const BOT = 700900800;
const DONO = 700100200;
const OFFSET = 500;
const ACAO = 'A aba quer abrir uma sessão nova: Demo do cartão';
const iso = (ms) => new Date(ms).toISOString();
const segs = (t) => Math.floor(Date.parse(t) / 1000);

function montar() {
  const raiz = pastaTemp('perm-ok-');
  const env = {
    SESSOES_WPP_DIR: path.join(raiz, 'estado'),
    CLAUDE_SESSIONS_DIR: path.join(raiz, 'sessions'),
    CLAUDE_PROJECTS_DIR: path.join(raiz, 'projects'),
    SESSOES_WPP_LOG: path.join(raiz, 'ok-wpp.log'),
    CLAUDE_CODE_SESSION_ID: SID,
  };
  for (const d of [env.SESSOES_WPP_DIR, env.CLAUDE_SESSIONS_DIR, env.CLAUDE_PROJECTS_DIR]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(env.SESSOES_WPP_DIR, 'estado.json'), JSON.stringify({ v: 1, trava: false, tg: { offset: OFFSET } }));
  const reg = { pid: PID, sessionId: SID, cwd: '/projetos', name: 'projetos', nameSource: 'derived', entrypoint: 'claude-desktop', messagingSocketPath: '/tmp/s.sock', status: 'idle', updatedAt: T0 };
  fs.writeFileSync(path.join(env.CLAUDE_SESSIONS_DIR, `${PID}.json`), JSON.stringify(reg));
  const h = { raiz, env, t: T0, enviados: [], leituras: [], tg: [], vivo: true };
  h.wpp = {
    async lerGrupo(limit) { h.leituras.push(limit); return []; },
    async enviarGrupo(texto) { h.enviados.push(texto); return { ok: true, providerMsgId: 'P1', messageId: 'U1' }; },
    async reagir() { return { ok: true }; },
    async membros() { return [NUMERO_DONO, NUMERO_ROBO]; },
  };
  h.tgOk = { async espiar() { return JSON.parse(JSON.stringify(h.tg)); }, botId: BOT, chatDono: DONO };
  h.ok = (extra = {}) => criarOkWpp({
    wpp: h.wpp, env: h.env, agora: () => h.t, tgOk: h.tgOk, porteiroVivo: () => h.vivo, dormir: async () => {},
    numeroDono: NUMERO_DONO, numeroRobo: NUMERO_ROBO, ...extra,
  });
  h.arquivo = (cod) => path.join(env.SESSOES_WPP_DIR, 'oks', `${cod}.json`);
  h.pedido = (cod) => JSON.parse(fs.readFileSync(h.arquivo(cod), 'utf8'));
  return h;
}

function toque(h, cod, acao = 'sim', updateId = 501) {
  const p = h.pedido(cod);
  const r = montarOkTg({ ...p, completo: false });
  return {
    update_id: updateId,
    callback_query: {
      id: `cbq-${updateId}`, from: { id: DONO, is_bot: false, first_name: 'Davi' }, chat_instance: '-1',
      data: `k:${cod}:${acao === 'sim' ? 's' : 'n'}`,
      message: {
        message_id: 77, from: { id: BOT, is_bot: true, first_name: 'Bot' }, chat: { id: DONO, type: 'private', first_name: 'Davi' },
        date: segs(p.criadoEm) + 2, text: r.texto,
        reply_markup: { inline_keyboard: r.botoes.map((l) => l.map((b) => ({ text: b.texto, callback_data: b.dados, ...(b.estilo ? { style: b.estilo } : {}) }))) },
      },
    },
  };
}

test('1. pedir permissao: so Telegram (nada no grupo), sem os ids do grupo, validade do --validade-min, libera 1 vez', async () => {
  const h = montar();
  const r = await h.ok().pedir({ tipo: 'permissao', acao: ACAO, validadeMin: '9' });
  assert.equal(r.status, 'pedido');
  assert.equal(r.telegram, true);
  assert.deepEqual(h.enviados, [], 'nada no grupo do WhatsApp');
  const p = h.pedido(r.codigo);
  assert.equal(p.tipo, 'permissao');
  assert.equal(p.providerMsgId, null);
  assert.equal(p.messageId, null);
  assert.equal(Date.parse(p.expiraEm) - Date.parse(p.criadoEm), 9 * MIN);
  assert.equal(p.libera, 'esta ação, 1 vez');
});

test('2. pedir permissao sem o OK pelo Telegram = invalido (nunca cai pro grupo)', async () => {
  const h = montar();
  const r = await h.ok({ tgOk: null }).pedir({ tipo: 'permissao', acao: ACAO });
  assert.equal(r.status, 'invalido');
  assert.equal(r.motivo, SO_TELEGRAM);
  assert.deepEqual(h.enviados, []);
});

test('3. --validade-min: so no pedido de permissao, inteiro de 1 a 30; sem ele = 30 min', async () => {
  const h = montar();
  for (const v of ['0', '31', '2.5', 'dez', '-1']) {
    const r = await h.ok().pedir({ tipo: 'permissao', acao: ACAO, validadeMin: v });
    assert.equal(r.status, 'invalido', v);
  }
  const outro = await h.ok().pedir({ tipo: 'crm', acao: 'Mover o deal', validadeMin: '5' });
  assert.equal(outro.status, 'invalido');
  assert.match(outro.motivo, /so no pedido de permissao/);
  const padrao = await h.ok().pedir({ tipo: 'permissao', acao: ACAO });
  const p = h.pedido(padrao.codigo);
  assert.equal(Date.parse(p.expiraEm) - Date.parse(p.criadoEm), 30 * MIN);
});

test('4. o toque Sim conferido no Telegram libera (usado); sem toque = pendente; o grupo nunca decide', async () => {
  const h = montar();
  const ok = h.ok();
  const { codigo } = await ok.pedir({ tipo: 'permissao', acao: ACAO, validadeMin: '10' });
  h.t += MIN;
  const antes = await ok.verificar(codigo);
  assert.equal(antes.status, 'pendente');
  h.tg = [toque(h, codigo, 'sim')];
  const r = await ok.verificar(codigo);
  assert.equal(r.status, 'ok');
  assert.equal(r.canal, 'telegram');
  assert.equal(h.pedido(codigo).status, 'usado');
  assert.equal(codigoDeSaida(r.status), 0);
});

test('5. o toque Nao recusa (exit 3)', async () => {
  const h = montar();
  const ok = h.ok();
  const { codigo } = await ok.pedir({ tipo: 'permissao', acao: ACAO, validadeMin: '10' });
  h.tg = [toque(h, codigo, 'nao')];
  const r = await ok.verificar(codigo);
  assert.equal(r.status, 'recusado');
  assert.equal(codigoDeSaida(r.status), 3);
});

test('6. cancelar: mesma sessao, pendente e permissao -> cancelado com o motivo; depois o verificar e o 2o cancelar nao valem', async () => {
  for (const motivo of MOTIVOS_CANCELAR) {
    const h = montar();
    const ok = h.ok();
    const { codigo } = await ok.pedir({ tipo: 'permissao', acao: ACAO, validadeMin: '10' });
    h.t += 30 * 1000;
    const r = await ok.cancelar(codigo, motivo);
    assert.equal(r.status, 'cancelado', motivo);
    assert.equal(r.motivoCancelamento, motivo);
    assert.equal(codigoDeSaida(r.status), 0);
    const p = h.pedido(codigo);
    assert.equal(p.status, 'cancelado');
    assert.equal(p.motivoCancelamento, motivo);
    assert.equal(p.canceladoEm, iso(h.t));
    h.tg = [toque(h, codigo, 'sim')];
    const v = await ok.verificar(codigo);
    assert.equal(v.status, 'invalido');
    assert.equal(v.motivo, 'ja cancelado');
    assert.equal((await ok.cancelar(codigo, motivo)).motivo, 'ja cancelado');
  }
});

test('7. cancelar sem motivo = sem-resposta; motivo desconhecido, outra sessao, outro tipo e pedido decidido = invalido', async () => {
  const h = montar();
  const ok = h.ok();
  const a = await ok.pedir({ tipo: 'permissao', acao: ACAO, validadeMin: '10' });
  assert.equal((await ok.cancelar(a.codigo)).motivoCancelamento, 'sem-resposta');
  const b = await ok.pedir({ tipo: 'permissao', acao: ACAO, validadeMin: '10' });
  assert.match((await ok.cancelar(b.codigo, 'qualquer')).motivo, /motivo desconhecido/);
  const outra = h.ok({ env: { ...h.env, CLAUDE_CODE_SESSION_ID: OUTRA } });
  assert.equal((await outra.cancelar(b.codigo, 'na-tela')).motivo, 'pedido de outra sessao');
  const pub = await ok.pedir({ tipo: 'publicacao', acao: 'Publicar o site' });
  assert.equal((await ok.cancelar(pub.codigo, 'na-tela')).motivo, 'so pedido de permissao do app se cancela');
  assert.equal(h.pedido(pub.codigo).status, 'pendente');
  h.tg = [toque(h, b.codigo, 'sim')];
  assert.equal((await ok.verificar(b.codigo)).status, 'ok');
  assert.equal((await ok.cancelar(b.codigo, 'na-tela')).motivo, 'ja usado');
  assert.equal((await ok.cancelar('XXXXXX', 'na-tela')).status, 'invalido');
});

test('8. CLI: cancelar pelo processo (exit 0, 1 linha JSON) e o uso cita permissao e cancelar', async () => {
  const h = montar();
  const { codigo } = await h.ok().pedir({ tipo: 'permissao', acao: ACAO, validadeMin: '10' });
  const r = spawnSync(process.execPath, [OK_WPP, 'cancelar', codigo, '--motivo', 'na-tela'], { env: { ...process.env, ...h.env }, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stdout);
  const j = JSON.parse(r.stdout.trim());
  assert.equal(j.status, 'cancelado');
  assert.equal(h.pedido(codigo).motivoCancelamento, 'na-tela');
  const uso = spawnSync(process.execPath, [OK_WPP, 'xyz'], { env: { ...process.env, ...h.env }, encoding: 'utf8', timeout: 20000 });
  assert.equal(uso.status, 1);
  assert.match(uso.stdout, /permissao/);
  assert.match(uso.stdout, /cancelar <CODIGO>/);
});
