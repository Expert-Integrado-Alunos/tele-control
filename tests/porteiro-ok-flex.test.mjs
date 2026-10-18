// T7g 102 v2 (PLANO-T7.md, secao "T7g", decisao v2): no grupo, o porteiro segue
// EXATAMENTE como hoje (F7). A resposta SOLTA ao pedido de OK so vai pra aba do pedido quando decide pela regra de hoje
// (frase inteira nas listas fechadas: "manda" vai; "manda ver", "beleza" e o polegar nao), e a conversa solta com mensagem
// dos agentes depois do pedido nunca vira a pergunta "e pra qual pedido?" no grupo. Por que existe: a v1 dava a solta o
// vocabulario maior e engolia a conversa do dono com a central enquanto havia pedido aberto (revisao adversarial).
// Andaime dos testes do grupo copiado de tests/porteiro.test.mjs (montar/sessao/transcript/msg/pedidoOk/doAgente):
// pastas temporarias, wpp e mensageiro dublados, relogio falso. Nada de rede nem ~/.claude real.
// Rodar: node --test --test-reporter=tap "tests/porteiro-ok-flex.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { criarPorteiro } from '../porteiro.mjs';
import { fileURLToPath } from 'node:url';
import { NUMERO_DONO, NUMERO_ROBO } from './lib/dados-whatsapp.mjs';
import { CENTRAL_TESTE, RAIZES_TESTE } from './lib/dados-central.mjs';

const MIN = 60 * 1000;
const T0 = Date.parse('2026-09-27T19:00:00Z'); // 16:00 em Brasilia
const iso = (ms) => new Date(ms).toISOString();
const tique = () => new Promise((ok) => setImmediate(ok));

// passoGrupo so ENFILEIRA a entrega; o passoEntrega chama o mensageiro (duble que resolve na hora).
async function bombear(p) {
  for (let i = 0; i < 100; i++) {
    const r = await p.passoEntrega();
    if (!r.emVoo && !r.fila) return;
    await tique();
  }
  throw new Error('bombear: a fila de entrega nao esvaziou');
}

function montar() {
  const raiz = pastaTemp('porteiro-ok-flex-');
  const env = {
    SESSOES_WPP_DIR: path.join(raiz, 'estado'),
    CLAUDE_SESSIONS_DIR: path.join(raiz, 'sessions'),
    CLAUDE_PROJECTS_DIR: path.join(raiz, 'projects'),
    SESSOES_WPP_LOG: path.join(raiz, 'porteiro.log'),
  };
  for (const d of [env.SESSOES_WPP_DIR, env.CLAUDE_SESSIONS_DIR, env.CLAUDE_PROJECTS_DIR]) fs.mkdirSync(d, { recursive: true });
  const h = { raiz, env, t: T0, idle: 0, grupo: [], enviados: [], reacoes: [], entregas: [], nReg: 0, nMsg: 0, aberturas: 0 };
  let seq = 0;
  h.wpp = {
    async lerGrupo(limit) {
      return h.grupo.slice(-limit);
    },
    async enviarGrupo(texto, opts) {
      h.enviados.push({ texto, opts });
      seq += 1;
      return { ok: true, providerMsgId: `P${seq}`, messageId: `U${seq}` };
    },
    async reagir(messageId, emoji) {
      h.reacoes.push({ messageId, emoji });
      return { ok: true };
    },
    async editarGrupo() {
      return { ok: true };
    },
  };
  h.mensageiro = {
    async entregar(p) {
      h.entregas.push(p);
      return { status: 'enviado', detalhe: '' };
    },
  };
  const cru = criarPorteiro({
    wpp: h.wpp, numeroDono: NUMERO_DONO, mensageiro: h.mensageiro, ocioso: async () => h.idle, agora: () => h.t, env, ensaio: false,
    abrirCentral: () => { h.aberturas += 1; }, // o abrir-central.vbs real NUNCA roda em teste
    central: CENTRAL_TESTE, raizesSessao: RAIZES_TESTE, // A3a: a central e as pastas como o dono configura
  });
  h.p = { passoGrupo: async () => { await cru.passoGrupo(); await bombear(cru); } };
  h.t += 1000; // mensagens dos testes nascem depois do cursor inicial
  return h;
}

function sessao(h, { sessionId, name }) {
  h.nReg += 1;
  const reg = { pid: process.pid, sessionId, cwd: 'c:\\projetos', entrypoint: 'claude-vscode', name, nameSource: 'derived', status: 'idle', updatedAt: h.t };
  fs.writeFileSync(path.join(h.env.CLAUDE_SESSIONS_DIR, `${100000 + h.nReg}.json`), JSON.stringify(reg));
}

function transcript(h, sessionId, titulo) {
  const dir = path.join(h.env.CLAUDE_PROJECTS_DIR, 'c--projetos');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${sessionId}.jsonl`), `${JSON.stringify({ type: 'custom-title', customTitle: titulo, sessionId: 'x' })}\n`);
}

function msg(h, o = {}) {
  h.nMsg += 1;
  const m = {
    id: `uuid-${h.nMsg}`, provider_msg_id: `PROV${h.nMsg}`, quoted_msg_id: null, sent_by_agent: false, message_type: 'text',
    content: null, transcription: null, direction: 'received', from_me: false, sender_phone: NUMERO_DONO, message_ts: iso(h.t), ...o,
  };
  h.grupo.push(m);
  return m;
}

// Pedido de OK (ok-wpp, pasta oks/) pendente, criado 1 min antes.
function pedidoOk(h, { codigo, sessionId, providerMsgId, messageId, criado = h.t - MIN }) {
  const dir = path.join(h.env.SESSOES_WPP_DIR, 'oks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${codigo}.json`), JSON.stringify({
    v: 1, codigo, sessionId, tipo: 'crm', acao: 'x', hashAcao: 'h', destinatarios: null,
    criadoEm: iso(criado), expiraEm: iso(criado + 30 * MIN), providerMsgId, messageId, status: 'pendente',
  }));
}
// A3a: o caminho do ok-wpp.mjs sai da pasta do repositorio (barras normais; entre aspas so com espaco). No PC do dono =
// C:/projetos/sessoes-wpp/ok-wpp.mjs, como antes.
const OK_WPP_NA_NOTA = ((p) => (p.includes(' ') ? `"${p}"` : p))(fileURLToPath(new URL('../ok-wpp.mjs', import.meta.url)).replace(/\\/g, '/'));
const NOTA = (cod) => `Resposta ao seu pedido de OK ${cod}. Antes de agir, rode: node ${OK_WPP_NA_NOTA} verificar ${cod} (so age com status ok).`;
// Frase do F3.2 (por extenso de proposito, como em tests/porteiro.test.mjs): so o controle do agente no meio a usa.
const CAB = '🎛️ *Controle de sessões*';
const QUAL = (palavra, hora) => `${CAB}\nEsse "${palavra}" das ${hora} é pra qual pedido? Responde citando a mensagem do pedido.`;

// Mensagem dos agentes no grupo (from_me na profissional), como em tests/porteiro.test.mjs.
const doAgente = (h, o = {}) => msg(h, {
  from_me: true, sent_by_agent: true, direction: 'sent', sender_phone: NUMERO_ROBO,
  content: 'ℹ️ *Brain*\nPronto.\n\n*Publico agora?*', ...o,
});
// A mensagem do pedido no grupo, como o ok-wpp pedir deixa (from_me na profissional).
const pedidoNoGrupo = (h, providerMsgId, messageId, ts) => doAgente(h, {
  provider_msg_id: providerMsgId, id: messageId, content: 'ℹ️ *Faro*\nPedido de OK (CRM): x\n\n*Posso?* Vale até 16:30.', message_ts: ts,
});

// Aba do pedido (Faro), outra aba (Brain) e a central; 1 pedido aberto da Faro, a mensagem dele no grupo e, com
// `agenteDepois`, um aviso da aba Brain depois dele; o dono manda `texto` solto (sem citar) e o porteiro roda 1 ciclo.
async function soltoCom1PedidoAberto(texto, { agenteDepois = false } = {}) {
  const h = montar();
  sessao(h, { sessionId: 'S1', name: 'projetos-42' });
  transcript(h, 'S1', 'Faro');
  sessao(h, { sessionId: 'S2', name: 'repos-f3' });
  transcript(h, 'S2', 'Brain');
  sessao(h, { sessionId: 'SC', name: 'repos-99' });
  transcript(h, 'SC', 'Central de sessões de teste');
  pedidoOk(h, { codigo: 'ABC234', sessionId: 'S1', providerMsgId: '3EB0A', messageId: 'uuid-a' });
  pedidoNoGrupo(h, '3EB0A', 'uuid-a', iso(h.t - MIN + 2000));
  if (agenteDepois) doAgente(h, { message_ts: iso(h.t - 10 * 1000) });
  const m = msg(h, { content: texto });
  await h.p.passoGrupo();
  return { h, m };
}

const destinos = (h) => h.entregas.map((x) => [x.sessionId, x.texto, x.nota]);

test('T7g 102. porteiro igual a hoje: "manda" solto vai pra aba do pedido; "manda ver" e "beleza" soltos = roteamento normal; com agente no meio, "beleza" e o polegar = roteamento normal, nenhuma frase no grupo', async () => {
  // "manda" (lista de hoje) solto, 1 pedido aberto, o pedido como ultima mensagem dos agentes = aba do pedido
  const manda = await soltoCom1PedidoAberto('manda');
  assert.deepEqual(destinos(manda.h), [['S1', 'manda', NOTA('ABC234')]], 'manda');
  assert.equal(manda.h.entregas[0].providerMsgId, manda.m.provider_msg_id);
  assert.deepEqual(manda.h.enviados, [], 'manda: nenhuma frase no grupo');

  // fora da lista de hoje, na mesma posicao: roteamento normal (central), sem a nota do OK
  for (const texto of ['manda ver', 'beleza']) {
    const { h } = await soltoCom1PedidoAberto(texto);
    assert.deepEqual(destinos(h), [['SC', texto, undefined]], texto);
    assert.deepEqual(h.enviados, [], `${texto}: nenhuma frase no grupo`);
  }

  // controle do agente no meio: o "sim" de hoje vira a pergunta da citacao (F3.2), sem repasse
  const sim = await soltoCom1PedidoAberto('sim', { agenteDepois: true });
  assert.deepEqual(destinos(sim.h), [], 'sim com agente no meio: sem repasse');
  assert.deepEqual(sim.h.enviados.map((x) => x.texto), [QUAL('sim', '16:00')], 'sim com agente no meio: a pergunta');

  // com mensagem dos agentes depois do pedido, conversa solta segue o roteamento normal e nada novo sai no grupo
  for (const texto of ['beleza', '\u{1F44D}']) {
    const { h } = await soltoCom1PedidoAberto(texto, { agenteDepois: true });
    assert.deepEqual(destinos(h), [['SC', texto, undefined]], `${texto} com agente no meio`);
    assert.deepEqual(h.enviados, [], `${texto} com agente no meio: nenhuma frase no grupo`);
  }
});
