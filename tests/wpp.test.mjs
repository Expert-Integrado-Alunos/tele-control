// Testes de wpp.mjs (node:test, fetch dublado, nada de rede).
// Rodar: node --test "tests/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { criarWpp, wppDoClaudeJson } from '../wpp.mjs';
import { GRUPO, INSTANCIA_ENVIO, INSTANCIA_CONFERENCIA, NUMERO_DONO, NUMERO_ROBO, DESTINO_WPP } from './lib/dados-whatsapp.mjs';

const URL_MCP = 'https://exemplo.invalid/mcp';
const HEADERS = { Authorization: 'Bearer chave-de-teste' };

// fetch dublado: guarda as chamadas e devolve a proxima resposta da fila ({json} ou {sse} ou {status, texto}).
function dubleFetch(respostas) {
  const chamadas = [];
  const fila = [...respostas];
  async function fetch(url, opts) {
    chamadas.push({ url, opts, body: JSON.parse(opts.body) });
    const r = fila.shift();
    const texto = r.sse ? `event: message\ndata: ${JSON.stringify(r.sse)}\n\n` : r.texto ?? JSON.stringify(r.json);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => texto };
  }
  return { fetch, chamadas };
}
const resultado = (obj) => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(obj) }] } });

test('lerGrupo: headers do config, body JSON-RPC certo, resposta SSE', async () => {
  const d = dubleFetch([{ sse: resultado({ ok: true, messages: [{ id: 'm1' }, { id: 'm2' }] }) }]);
  const w = criarWpp({ url: URL_MCP, headers: HEADERS, fetch: d.fetch, ...DESTINO_WPP });
  const msgs = await w.lerGrupo(7);
  assert.deepEqual(msgs.map((m) => m.id), ['m1', 'm2']);
  const c = d.chamadas[0];
  assert.equal(c.url, URL_MCP);
  assert.equal(c.opts.method, 'POST');
  assert.equal(c.opts.headers.Authorization, 'Bearer chave-de-teste');
  assert.equal(c.opts.headers['Content-Type'], 'application/json');
  assert.match(c.opts.headers.Accept, /text\/event-stream/);
  assert.equal(c.body.jsonrpc, '2.0');
  assert.equal(c.body.method, 'tools/call');
  assert.deepEqual(c.body.params, { name: 'read', arguments: { chat: GRUPO, instance: INSTANCIA_ENVIO, limit: 7 } });
});

test('enviarGrupo: send confirmado pro grupo fixo, com citacao; resposta JSON pura', async () => {
  const d = dubleFetch([{ json: resultado({ ok: true, message_id: 'uuid-1', provider_msg_id: '3EB0AB' }) }]);
  const w = criarWpp({ url: URL_MCP, headers: HEADERS, fetch: d.fetch, ...DESTINO_WPP });
  const r = await w.enviarGrupo('*Sessão X (pc)*\noi', { citarId: 'uuid-citada' });
  assert.deepEqual(r, { ok: true, providerMsgId: '3EB0AB', messageId: 'uuid-1' });
  const a = d.chamadas[0].body.params;
  assert.equal(a.name, 'send');
  // force_send_after_inbound: o porteiro le o grupo inteiro antes de mandar; a trava de "inbound sem resposta" barraria
  // justamente a resposta ao dono (medido 27/09 17:2x).
  assert.deepEqual(a.arguments, { to: GRUPO, instance: INSTANCIA_ENVIO, content: '*Sessão X (pc)*\noi', confirmed: true, force_send_after_inbound: true, reply_to: 'uuid-citada' });
  assert.equal('confirmed_voice' in a.arguments, false);
});

test('enviarGrupo: sem citacao nao manda reply_to', async () => {
  const d = dubleFetch([{ json: resultado({ ok: true, message_id: 'u', provider_msg_id: 'p' }) }]);
  const w = criarWpp({ url: URL_MCP, headers: HEADERS, fetch: d.fetch, ...DESTINO_WPP });
  await w.enviarGrupo('oi');
  assert.equal('reply_to' in d.chamadas[0].body.params.arguments, false);
});

test('enviarGrupo: voice_gate vira {bloqueio}', async () => {
  const violations = [{ id: 'emdash', severity: 'high' }];
  const d = dubleFetch([{ json: resultado({ ok: false, blocked: true, reason: 'voice_gate', violations }) }]);
  const w = criarWpp({ url: URL_MCP, headers: HEADERS, fetch: d.fetch, ...DESTINO_WPP });
  assert.deepEqual(await w.enviarGrupo('x'), { ok: false, bloqueio: 'voice_gate', violacoes: violations });
});

// Medido 27/09/2026 17:2x: a trava de 'inbound recente sem resposta' volta ok:true + blocked:true (NADA saiu).
test('enviarGrupo: qualquer blocked vira {ok:false, bloqueio} mesmo com ok:true', async () => {
  const d = dubleFetch([{ json: resultado({ ok: true, blocked: true, reason: 'inbound_recente_sem_resposta', hint: 'x' }) }]);
  const w = criarWpp({ url: URL_MCP, headers: HEADERS, fetch: d.fetch, ...DESTINO_WPP });
  assert.deepEqual(await w.enviarGrupo('x'), { ok: false, bloqueio: 'inbound_recente_sem_resposta', violacoes: [] });
});

test('enviarGrupo: erro da tool ou do JSON-RPC vira {ok:false, erro} (nunca lanca)', async () => {
  const d = dubleFetch([
    { json: resultado({ ok: false, error: 'chat nao encontrado' }) },
    { json: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'caiu' } } },
    { status: 502, texto: 'Bad Gateway' },
  ]);
  const w = criarWpp({ url: URL_MCP, headers: HEADERS, fetch: d.fetch, ...DESTINO_WPP });
  for (let i = 0; i < 3; i++) {
    const r = await w.enviarGrupo('x');
    assert.equal(r.ok, false);
    assert.equal(typeof r.erro, 'string');
    assert.doesNotMatch(r.erro, /chave-de-teste/);
  }
});

test('lerGrupo: erro JSON-RPC lanca (o porteiro conta erros seguidos)', async () => {
  const d = dubleFetch([{ json: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'caiu' } } }]);
  const w = criarWpp({ url: URL_MCP, headers: HEADERS, fetch: d.fetch, ...DESTINO_WPP });
  await assert.rejects(() => w.lerGrupo(), /caiu/);
});

test('reagir: react por message_id', async () => {
  const d = dubleFetch([{ json: resultado({ ok: true }) }]);
  const w = criarWpp({ url: URL_MCP, headers: HEADERS, fetch: d.fetch, ...DESTINO_WPP });
  const r = await w.reagir('uuid-9', '✅');
  assert.equal(r.ok, true);
  assert.deepEqual(d.chamadas[0].body.params, { name: 'react', arguments: { message_id: 'uuid-9', emoji: '✅' } });
});

test('nao existe parametro de destino: extras sao ignorados e o destino segue o grupo da criacao', async () => {
  const d = dubleFetch([{ json: resultado({ ok: true, message_id: 'u', provider_msg_id: 'p' }) }]);
  const w = criarWpp({ url: URL_MCP, headers: HEADERS, fetch: d.fetch, ...DESTINO_WPP });
  await w.enviarGrupo('x', { citarId: undefined, to: '5511999999999', chat: 'outro', instance: 'pessoal' });
  const a = d.chamadas[0].body.params.arguments;
  assert.equal(a.to, GRUPO);
  assert.equal(a.instance, INSTANCIA_ENVIO);
  // D4a: membros() entrou (so leitura); F4.1: editarGrupo (so o message_id de uma mensagem que o porteiro mandou no
  // grupo; sem chat nem alvo posicional). Nenhum metodo recebe destino.
  assert.deepEqual(Object.keys(w).sort(), ['editarGrupo', 'enviarGrupo', 'lerGrupo', 'membros', 'reagir']);
});

// ---------- D4a: leitura pela instancia de conferencia e membros do grupo (A2a: as 2 instancias do config) ----------

test('lerGrupo: { conferencia: true } le pela instancia de conferencia (grupo continua o da criacao); sem ela, pela de envio', async () => {
  const d = dubleFetch([
    { json: resultado({ ok: true, messages: [{ id: 'p1' }] }) },
    { json: resultado({ ok: true, messages: [] }) },
  ]);
  const w = criarWpp({ url: URL_MCP, headers: HEADERS, fetch: d.fetch, ...DESTINO_WPP });
  assert.deepEqual((await w.lerGrupo(50, { conferencia: true })).map((m) => m.id), ['p1']);
  assert.deepEqual(d.chamadas[0].body.params, { name: 'read', arguments: { chat: GRUPO, instance: INSTANCIA_CONFERENCIA, limit: 50 } });
  await w.lerGrupo(50);
  assert.equal(d.chamadas[1].body.params.arguments.instance, INSTANCIA_ENVIO);
});

test('membros: zapi_action group-metadata pela instancia de envio -> telefones dos participants', async () => {
  const meta = {
    ok: true,
    action: 'group-metadata',
    result: {
      phone: GRUPO,
      participants: [
        { phone: NUMERO_DONO, isAdmin: true, isSuperAdmin: true },
        { phone: NUMERO_ROBO, isAdmin: true, isSuperAdmin: false },
      ],
    },
  };
  const d = dubleFetch([{ sse: resultado(meta) }]);
  const w = criarWpp({ url: URL_MCP, headers: HEADERS, fetch: d.fetch, ...DESTINO_WPP });
  assert.deepEqual(await w.membros(), [NUMERO_DONO, NUMERO_ROBO]);
  assert.deepEqual(d.chamadas[0].body.params, {
    name: 'zapi_action',
    arguments: { action: 'group-metadata', instance: INSTANCIA_ENVIO, params: { phone: GRUPO } },
  });
});

test('membros: erro da tool, sem participants, lista vazia ou participante sem phone = lanca', async () => {
  const d = dubleFetch([
    { json: resultado({ ok: false, error: 'instancia desconectada' }) },
    { json: resultado({ ok: true, action: 'group-metadata', result: { phone: GRUPO } }) },
    { json: resultado({ ok: true, action: 'group-metadata', result: { phone: GRUPO, participants: [] } }) },
    { json: resultado({ ok: true, action: 'group-metadata', result: { participants: [{ phone: NUMERO_DONO }, { lid: 'x' }] } }) },
    { json: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'caiu' } } },
  ]);
  const w = criarWpp({ url: URL_MCP, headers: HEADERS, fetch: d.fetch, ...DESTINO_WPP });
  for (let i = 0; i < 5; i++) await assert.rejects(() => w.membros());
  assert.equal(d.chamadas.length, 5);
});

// ---------- F4.1: editarGrupo (edit_message do whatsapp-agent) ----------
// Contrato do servidor (C:/projetos/whatsapp-agent/supabase/functions/mcp-api/index.ts, case "edit_message"): so from_me,
// 15 min do message_ts, voice gate; sucesso = {ok:true, edited:true}; erro = {error} com isError no tools/call.

test('F4.1 editarGrupo: edit_message so com message_id, new_content e confirmed:true (nunca confirmed_voice, chat, target nem instance); sucesso = ok + edited', async () => {
  const d = dubleFetch([{ sse: resultado({ ok: true, edited: true, message_id: 'uuid-7', new_content: 'novo', type: 'text' }) }]);
  const w = criarWpp({ url: URL_MCP, headers: HEADERS, fetch: d.fetch, ...DESTINO_WPP });
  assert.equal(typeof w.editarGrupo, 'function');
  assert.deepEqual(await w.editarGrupo('uuid-7', '*Sessão X (pc)*\nConcluído: você respondeu às 16:03.'), { ok: true });
  assert.equal(d.chamadas.length, 1);
  assert.equal(d.chamadas[0].opts.headers.Authorization, 'Bearer chave-de-teste');
  assert.deepEqual(d.chamadas[0].body.params, {
    name: 'edit_message',
    arguments: { message_id: 'uuid-7', new_content: '*Sessão X (pc)*\nConcluído: você respondeu às 16:03.', confirmed: true },
  });
  for (const k of ['confirmed_voice', 'chat', 'target', 'instance', 'to']) {
    assert.equal(k in d.chamadas[0].body.params.arguments, false, k);
  }
});

test('F4.1 editarGrupo: blocked (voice_gate ou pedindo confirmacao), erro da tool, ok sem edited, JSON-RPC, HTTP e rede -> {ok:false,...} sem lancar; message_id ruim nao chama', async () => {
  const violations = [{ id: 'emdash', severity: 'high' }];
  const erroDaTool = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ error: 'Janela de 15min expirada. Use delete + send.' }) }], isError: true } };
  const d = dubleFetch([
    { json: resultado({ ok: false, blocked: true, reason: 'voice_gate', violations }) },
    { json: resultado({ blocked: true, needs_confirmation: true, message_id: 'u', instruction: 'x' }) },
    { json: erroDaTool },
    { json: resultado({ ok: true }) }, // sem edited: nao conta como editada
    { json: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'caiu' } } },
    { status: 502, texto: 'Bad Gateway' },
  ]);
  const w = criarWpp({ url: URL_MCP, headers: HEADERS, fetch: d.fetch, ...DESTINO_WPP });
  assert.deepEqual(await w.editarGrupo('u', 'x'), { ok: false, bloqueio: 'voice_gate', violacoes: violations });
  const semConfirmar = await w.editarGrupo('u', 'x');
  assert.equal(semConfirmar.ok, false);
  assert.equal(typeof semConfirmar.bloqueio, 'string');
  const janela = await w.editarGrupo('u', 'x');
  assert.equal(janela.ok, false);
  assert.match(janela.erro, /Janela de 15min expirada/);
  for (let i = 0; i < 3; i++) {
    const r = await w.editarGrupo('u', 'x');
    assert.equal(r.ok, false);
    assert.equal(typeof r.erro, 'string');
    assert.doesNotMatch(r.erro, /chave-de-teste/);
  }
  assert.equal(d.chamadas.length, 6);

  const rede = criarWpp({ url: URL_MCP, headers: HEADERS, fetch: async () => { throw new TypeError('fetch failed'); }, ...DESTINO_WPP });
  const r = await rede.editarGrupo('u', 'x');
  assert.equal(r.ok, false);
  assert.match(r.erro, /fetch failed/);

  const d2 = dubleFetch([]);
  const w2 = criarWpp({ url: URL_MCP, headers: HEADERS, fetch: d2.fetch, ...DESTINO_WPP });
  for (const id of [undefined, null, '', '   ', 42, { id: 'u' }]) {
    const x = await w2.editarGrupo(id, 'x');
    assert.equal(x.ok, false, JSON.stringify(id));
    assert.equal(typeof x.erro, 'string');
  }
  assert.equal(d2.chamadas.length, 0, 'sem message_id nao chama o whatsapp-agent');
});

test('wppDoClaudeJson: le url/headers do whatsapp-agent; sem config = erro sem vazar nada', () => {
  const dir = pastaTemp('wpp-');
  const ok = join(dir, 'ok.json');
  writeFileSync(ok, JSON.stringify({ mcpServers: { 'whatsapp-agent': { type: 'http', url: URL_MCP, headers: HEADERS } } }));
  assert.deepEqual(wppDoClaudeJson(ok), { url: URL_MCP, headers: HEADERS });
  const sem = join(dir, 'sem.json');
  writeFileSync(sem, JSON.stringify({ mcpServers: {} }));
  assert.throws(() => wppDoClaudeJson(sem), /whatsapp-agent/);
});
