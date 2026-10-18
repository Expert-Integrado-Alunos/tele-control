// Testes de ok-wpp.mjs (D4a, fase 2): node:test, wpp dublado, relogio falso.
// Por que existe: o ok-wpp transforma uma resposta do dono no grupo em autorizacao (CRM, mensagem, publicacao). OK falso
// = acao que ele nao aprovou; OK verdadeiro perdido = sessao parada. Cada caso aqui e um jeito de forjar ou perder o OK.
// Isolamento: SESSOES_WPP_DIR, CLAUDE_SESSIONS_DIR, CLAUDE_PROJECTS_DIR, SESSOES_WPP_LOG e markerPath em pasta temporaria.
// Nada de rede, WhatsApp real ou ~/.claude real.
// Rodar: node --test "tests/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pastaTemp } from './lib/pasta-temp.cjs';
import {
  criarOkWpp,
  ALFABETO,
  AFIRMATIVAS,
  NEGATIVAS,
  normalizarResposta,
  classificarResposta,
  codigoDeSaida,
  montarMensagemPedido,
} from '../ok-wpp.mjs';
import { NUMERO_DONO, NUMERO_ROBO } from './lib/dados-whatsapp.mjs';

const OK_WPP = fileURLToPath(new URL('../ok-wpp.mjs', import.meta.url));
const MIN = 60 * 1000;
const T0 = Date.parse('2026-09-27T19:00:00Z'); // 16:00 em Brasilia; o pedido vale ate 16:30
const SID = '11111111-2222-4333-8444-555555555555';
const OUTRA = '99999999-8888-4777-8666-555555555555';
const PID = 4242;
const RE_CODIGO = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
const iso = (ms) => new Date(ms).toISOString();
// Formato que o read devolve (medido 27/09): "2026-09-27T21:26:33+00:00".
const tsWpp = (ms) => iso(ms).replace(/\.\d{3}Z$/, '+00:00');

function montar({ registro = {}, transcript, entrypoint = 'claude-vscode', semRegistro = false, semEstado = false } = {}) {
  const raiz = pastaTemp('ok-wpp-');
  const env = {
    SESSOES_WPP_DIR: path.join(raiz, 'estado'),
    CLAUDE_SESSIONS_DIR: path.join(raiz, 'sessions'),
    CLAUDE_PROJECTS_DIR: path.join(raiz, 'projects'),
    SESSOES_WPP_LOG: path.join(raiz, 'ok-wpp.log'),
    CLAUDE_CODE_SESSION_ID: SID,
  };
  for (const d of [env.SESSOES_WPP_DIR, env.CLAUDE_SESSIONS_DIR, env.CLAUDE_PROJECTS_DIR]) fs.mkdirSync(d, { recursive: true });
  // estado.json do porteiro (F3.3: ausente/ilegivel = invalido). Padrao = porteiro vivo e destravado.
  const estadoArq = path.join(env.SESSOES_WPP_DIR, 'estado.json');
  if (!semEstado) fs.writeFileSync(estadoArq, JSON.stringify({ v: 1, trava: false }));
  if (!semRegistro) {
    const reg = { pid: PID, sessionId: SID, cwd: 'C:\\projetos', name: 'repos-f3', nameSource: 'derived', entrypoint, status: 'idle', updatedAt: T0, ...registro };
    fs.writeFileSync(path.join(env.CLAUDE_SESSIONS_DIR, `${PID}.json`), JSON.stringify(reg));
  }
  // Segredo ao lado do registro: nunca pode ser aberto.
  fs.writeFileSync(path.join(env.CLAUDE_SESSIONS_DIR, `${PID}.abc123.key`), 'SEGREDO-NAO-LER');
  const linhas = transcript !== undefined ? transcript : [
    { type: 'ai-title', aiTitle: 'Ajuste do Painel' },
    { type: 'custom-title', customTitle: 'Faro', sessionId: SID },
    { type: 'user', message: { content: 'oi' } },
  ];
  if (linhas) {
    const pasta = path.join(env.CLAUDE_PROJECTS_DIR, 'c--projetos');
    fs.mkdirSync(pasta, { recursive: true });
    fs.writeFileSync(path.join(pasta, `${SID}.jsonl`), linhas.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  const h = {
    raiz,
    env,
    t: T0,
    prof: [],
    pes: [],
    membros: [NUMERO_DONO, NUMERO_ROBO],
    membrosErro: false,
    enviados: [],
    reacoes: [],
    leituras: [],
    respostasEnvio: [],
    nMsg: 0,
    markerPath: path.join(raiz, 'logs', 'publicacao-ok.json'),
    disparoPath: path.join(raiz, 'logs', 'disparo-estado.json'),
  };
  let seq = 0;
  h.estadoArq = estadoArq;
  h.aoLer = null; // (instancia) => void: roda dentro do lerGrupo, antes de devolver (corrida com o porteiro)
  h.wpp = {
    async lerGrupo(limit, opts = {}) {
      const instancia = opts.conferencia === true ? 'pessoal' : 'profissional';
      h.leituras.push({ limit, instancia });
      if (h.aoLer) h.aoLer(instancia);
      return (instancia === 'pessoal' ? h.pes : h.prof).slice(-limit);
    },
    async enviarGrupo(texto, opts) {
      h.enviados.push({ texto, opts });
      let r;
      if (h.respostasEnvio.length) r = h.respostasEnvio.shift();
      else {
        seq += 1;
        r = { ok: true, providerMsgId: `3EB0PED${seq}`, messageId: `uuid-ped-${seq}` };
      }
      // A mensagem enviada volta na leitura da profissional, byte a byte (medido pelo principal em 27/09).
      if (r && (r.providerMsgId || r.messageId)) {
        h.prof.push({
          id: r.messageId ?? null,
          provider_msg_id: r.providerMsgId ?? null,
          from_me: true,
          sent_by_agent: true,
          sender_phone: null,
          message_type: 'text',
          content: texto,
          quoted_msg_id: opts?.reply_to ?? null,
          message_ts: tsWpp(h.t),
        });
      }
      return r;
    },
    async reagir(messageId, emoji) {
      h.reacoes.push({ messageId, emoji });
      return { ok: true };
    },
    async membros() {
      if (h.membrosErro) throw new Error('group-metadata: caiu');
      return [...h.membros];
    },
  };
  h.ok = (extra = {}) => criarOkWpp({
    wpp: h.wpp, env: h.env, agora: () => h.t, markerPath: h.markerPath, disparoPath: h.disparoPath,
    numeroDono: NUMERO_DONO, numeroRobo: NUMERO_ROBO, // A2a: os 2 numeros do config
    ...extra,
  });
  h.ledger = () => (fs.existsSync(h.disparoPath) ? JSON.parse(fs.readFileSync(h.disparoPath, 'utf8')) : null);
  h.oksDir = path.join(env.SESSOES_WPP_DIR, 'oks');
  h.arquivo = (cod) => path.join(h.oksDir, `${cod}.json`);
  h.pedido = (cod) => JSON.parse(fs.readFileSync(h.arquivo(cod), 'utf8'));
  h.markers = () => (fs.existsSync(h.markerPath) ? JSON.parse(fs.readFileSync(h.markerPath, 'utf8')) : null);
  h.arquivosOk = () => (fs.existsSync(h.oksDir) ? fs.readdirSync(h.oksDir) : []);
  return h;
}

// Resposta do dono no grupo (profissional) + a copia no pessoal (mesmo provider_msg_id), como o banco grava.
function responder(h, texto, {
  cita,
  ts = h.t,
  de = NUMERO_DONO,
  fromMe = false,
  agente = false,
  tipo = 'chat',
  transcription,
  copia = true,
  copiaAgente = false,
  copiaFromMe = true,
} = {}) {
  h.nMsg += 1;
  const n = h.nMsg;
  const provider = `A5C7RESP${n}`;
  const base = {
    provider_msg_id: provider,
    quoted_msg_id: cita,
    message_type: tipo,
    content: tipo === 'ptt' ? null : texto,
    transcription: tipo === 'ptt' ? (transcription ?? null) : undefined,
    sender_phone: de,
    message_ts: tsWpp(ts),
  };
  const linha = { id: `uuid-resp-${n}`, ...base, sent_by_agent: agente, direction: fromMe ? 'sent' : 'received', from_me: fromMe };
  if (agente === 'ausente') delete linha.sent_by_agent; // read antigo, sem o campo
  h.prof.push(linha);
  if (copia) {
    h.pes.push({ id: `uuid-pes-${n}`, ...base, sent_by_agent: copiaAgente, direction: 'sent', from_me: copiaFromMe });
  }
  return { id: `uuid-resp-${n}`, provider };
}

// Sem o codigo no texto (caso real: "nao sei pra que serve"); o codigo fica so no arquivo do pedido.
const TEXTO_FINAL = (_cod, rotulo, acao) =>
  `ℹ️ *Faro*\nPedido de OK (${rotulo}): ${acao}\n\n*Posso?* Vale até 16:30.`; // F4g: sem "(pc)" e sem o rodape

// ---------- pedir ----------

test('pedir: CRM manda o texto exato, grava o pedido com os 2 ids e devolve codigo/hora', async () => {
  const h = montar();
  const r = await h.ok().pedir({ tipo: 'crm', acao: 'Mover o deal 123 (Ana) pra **Ganho**' });
  assert.equal(r.status, 'pedido');
  assert.match(r.codigo, RE_CODIGO);
  assert.equal(r.hora, '16:30');
  assert.equal(r.expiraEm, iso(T0 + 30 * MIN));
  assert.equal(h.enviados.length, 1);
  assert.equal(h.enviados[0].texto, TEXTO_FINAL(r.codigo, 'CRM', 'Mover o deal 123 (Ana) pra *Ganho*'));
  const p = h.pedido(r.codigo);
  assert.deepEqual(p, {
    v: 1,
    codigo: r.codigo,
    sessionId: SID,
    titulo: 'Faro',
    tipo: 'crm',
    acao: 'Mover o deal 123 (Ana) pra **Ganho**',
    hashAcao: crypto.createHash('sha256').update(JSON.stringify(['crm', 'Mover o deal 123 (Ana) pra **Ganho**', null])).digest('hex'),
    destinatarios: null,
    libera: 'esta ação, 1 vez', // A5c: o que o Sim libera (o botao do Telegram mostra)
    criadoEm: iso(T0),
    expiraEm: iso(T0 + 30 * MIN),
    providerMsgId: '3EB0PED1',
    messageId: 'uuid-ped-1',
    status: 'pendente',
  });
  assert.deepEqual(h.arquivosOk(), [`${r.codigo}.json`]); // sem sobra de tmp
  // F3.1: o texto enviado e o do montarMensagemPedido, com o titulo gravado no pedido
  assert.equal(
    montarMensagemPedido({ titulo: p.titulo, tipo: 'crm', destinatarios: null, acao: p.acao, hora: '16:30' }),
    h.enviados[0].texto,
  );
  // e a mensagem enviada volta na leitura da profissional (dublê do read real)
  assert.equal(h.prof.length, 1);
  assert.equal(h.prof[0].provider_msg_id, '3EB0PED1');
  assert.equal(h.prof[0].content, h.enviados[0].texto);
});

test('montarMensagemPedido: texto exato de hoje, rotulo com destinatarios, markdown limpo; tipo desconhecido = erro', () => {
  assert.equal(
    montarMensagemPedido({ titulo: 'Faro', tipo: 'mensagem', destinatarios: ['Ana', 'Bruno'], acao: 'Mandar **oi**', hora: '16:30' }),
    'ℹ️ *Faro*\nPedido de OK (mensagem pra Ana, Bruno): Mandar *oi*\n\n*Posso?* Vale até 16:30.',
  );
  // F4g: a acao vai INTEIRA (o dono aprova o que le), mesmo com varias linhas; titulo limpo como o das outras mensagens
  assert.equal(
    montarMensagemPedido({ titulo: '🚀 **Site** — v2', tipo: 'mensagem', destinatarios: ['Ana'], acao: 'Oi Ana, tudo bem?\nSegue o link.\n\nAbraço', hora: '16:30' }),
    'ℹ️ *Site - v2*\nPedido de OK (mensagem pra Ana): Oi Ana, tudo bem?\nSegue o link.\n\nAbraço\n\n*Posso?* Vale até 16:30.',
  );
  assert.equal(
    montarMensagemPedido({ titulo: 'X', tipo: 'disparo', destinatarios: null, acao: 'Convite', hora: '09:05' }),
    TEXTO_FINAL(null, 'disparo em massa', 'Convite').replace('Faro', 'X').replace('16:30', '09:05'),
  );
  assert.throws(() => montarMensagemPedido({ titulo: 'X', tipo: 'toString', destinatarios: null, acao: 'a', hora: '1' }), TypeError);
});

test('pedir: rotulos de mensagem (destinatarios juntos) e publicacao', async () => {
  const h = montar();
  const ok = h.ok();
  const m = await ok.pedir({ tipo: 'mensagem', acao: 'Mandar o convite da live', destinatarios: 'Ana Souza; Bruno ;; Carla' });
  assert.equal(m.status, 'pedido');
  assert.equal(h.enviados[0].texto, TEXTO_FINAL(m.codigo, 'mensagem pra Ana Souza, Bruno, Carla', 'Mandar o convite da live'));
  assert.deepEqual(h.pedido(m.codigo).destinatarios, ['Ana Souza', 'Bruno', 'Carla']);
  const p = await ok.pedir({ tipo: 'publicacao', acao: 'Publicar o site v2 em producao' });
  assert.equal(h.enviados[1].texto, TEXTO_FINAL(p.codigo, 'publicação', 'Publicar o site v2 em producao'));
  assert.equal(h.pedido(p.codigo).destinatarios, null);
  assert.notEqual(m.codigo, p.codigo);
});

test('pedir: qualquer acao vale (decisao do dono); tipo desconhecido, acao vazia/longa, sem sessao ou headless = invalido', async () => {
  const casos = [
    [{ tipo: 'dns', acao: 'x' }, /tipo desconhecido/],
    [{ tipo: 'crm', acao: '' }, /1500/],
    [{ tipo: 'crm', acao: 'x'.repeat(1501) }, /1500/],
  ];
  const h = montar();
  for (const [args, re] of casos) {
    const r = await h.ok().pedir(args);
    assert.equal(r.status, 'invalido', JSON.stringify(args).slice(0, 80));
    assert.match(r.motivo, re, JSON.stringify(args).slice(0, 80));
  }
  assert.equal(h.enviados.length, 0);
  // o que antes era "so no PC" agora passa: pagamento, apagar, DNS no texto, 6+ destinatarios, mensagem sem lista, sem tipo
  const validos = [
    [{ tipo: 'pagamento', acao: 'Pagar o Airbnb de R$ 1.234,56 no cartao da empresa' }, 'pagamento'],
    [{ tipo: 'apagar', acao: 'Apagar o lead Joao e o registro DNS teste' }, 'apagar'],
    [{ tipo: 'crm', acao: 'trocar a senha do Pipedrive' }, 'CRM'],
    [{ tipo: 'mensagem', acao: 'Mandar oi', destinatarios: 'A; B; C; D; E; F' }, 'mensagem pra A, B, C, D, E, F'],
    [{ tipo: 'mensagem', acao: 'Mandar oi' }, 'mensagem'],
    [{ tipo: 'disparo', acao: 'Convite da live pros 120 inscritos' }, 'disparo em massa'],
    [{ tipo: 'disparo', acao: 'Convite', destinatarios: 'lista da live' }, 'disparo pra lista da live'],
    [{ acao: 'Reiniciar o container da VPS' }, 'ação'],
    [{ tipo: 'outro', acao: 'Reiniciar o container da VPS' }, 'ação'],
    [{ tipo: 'crm', acao: 'y'.repeat(1500) }, 'CRM'],
  ];
  for (const [args, rotulo] of validos) {
    const r = await h.ok().pedir(args);
    assert.equal(r.status, 'pedido', JSON.stringify(args).slice(0, 80));
    assert.equal(h.enviados.at(-1).texto, TEXTO_FINAL(r.codigo, rotulo, args.acao), rotulo);
  }
  assert.equal(h.enviados.length, validos.length);

  const semSessao = montar();
  delete semSessao.env.CLAUDE_CODE_SESSION_ID;
  assert.deepEqual(await semSessao.ok().pedir({ tipo: 'crm', acao: 'x' }), { status: 'invalido', motivo: 'sem sessao' });
  const headless = montar({ entrypoint: 'sdk-cli' });
  assert.deepEqual(await headless.ok().pedir({ tipo: 'crm', acao: 'x' }), { status: 'invalido', motivo: 'so sessao interativa (aba do VS Code, terminal ou Claude Desktop com canal de recado)' });
  const semReg = montar({ semRegistro: true });
  assert.deepEqual(await semReg.ok().pedir({ tipo: 'crm', acao: 'x' }), { status: 'invalido', motivo: 'so sessao interativa (aba do VS Code, terminal ou Claude Desktop com canal de recado)' });
  // F4i: Claude Desktop sem canal de recado fica fora; com canal (messagingSocketPath) pede OK igual a aba
  const desktop = montar({ entrypoint: 'claude-desktop' });
  assert.deepEqual(await desktop.ok().pedir({ tipo: 'crm', acao: 'x' }), { status: 'invalido', motivo: 'so sessao interativa (aba do VS Code, terminal ou Claude Desktop com canal de recado)' });
  const desktopComCanal = montar({ entrypoint: 'claude-desktop', registro: { name: 'Aba do Desktop', nameSource: undefined, messagingSocketPath: '\\\\.\\pipe\\LOCAL\\cc-msg-eeee' } });
  assert.equal((await desktopComCanal.ok().pedir({ tipo: 'crm', acao: 'x' })).status, 'pedido');
  assert.equal(desktopComCanal.enviados.length, 1);
  // F3.9: sessao interativa do terminal do Windows (a central) pede OK igual a aba
  const terminal = montar({ entrypoint: 'cli' });
  assert.equal((await terminal.ok().pedir({ tipo: 'crm', acao: 'x' })).status, 'pedido');
  for (const x of [semSessao, headless, semReg, desktop]) {
    assert.equal(x.enviados.length, 0);
    assert.deepEqual(x.arquivosOk(), []);
  }
});

test('pedir: envio barrado ou com erro = invalido com o motivo e nada gravado', async () => {
  const h = montar();
  h.respostasEnvio.push({ ok: false, bloqueio: 'voice_gate', violacoes: [] }, { ok: false, erro: 'HTTP 502' });
  const a = await h.ok().pedir({ tipo: 'crm', acao: 'Mover deal' });
  assert.equal(a.status, 'invalido');
  assert.match(a.motivo, /voice_gate/);
  const b = await h.ok().pedir({ tipo: 'crm', acao: 'Mover deal' });
  assert.equal(b.status, 'invalido');
  assert.match(b.motivo, /HTTP 502/);
  assert.deepEqual(h.arquivosOk(), []);
});

test('pedir: titulo = custom-title > name do usuario > ai-title > name do registro', async () => {
  const titulo = async (opts) => {
    const h = montar(opts);
    await h.ok().pedir({ tipo: 'crm', acao: 'x' });
    return h.enviados[0].texto.split('\n')[0];
  };
  assert.equal(await titulo({}), 'ℹ️ *Faro*');
  const semCustom = [{ type: 'ai-title', aiTitle: 'Ajuste antigo' }, { type: 'ai-title', aiTitle: 'Ajuste do Painel' }];
  assert.equal(await titulo({ transcript: semCustom, registro: { name: 'Minha aba', nameSource: 'user' } }), 'ℹ️ *Minha aba*');
  assert.equal(await titulo({ transcript: semCustom }), 'ℹ️ *Ajuste do Painel*');
  assert.equal(await titulo({ transcript: null }), 'ℹ️ *repos-f3*');
});

test('pedir: codigo que colide com pedido existente e sorteado de novo', async () => {
  const h = montar();
  fs.mkdirSync(h.oksDir, { recursive: true });
  fs.writeFileSync(h.arquivo('AAAAAA'), '{"antigo":true}');
  const seqs = [...Array(6).fill(0), ...Array(6).fill(1)]; // AAAAAA (colide) e depois BBBBBB
  const r = await h.ok({ randomInt: () => seqs.shift() }).pedir({ tipo: 'crm', acao: 'x' });
  assert.equal(r.codigo, 'BBBBBB');
  assert.equal(fs.readFileSync(h.arquivo('AAAAAA'), 'utf8'), '{"antigo":true}');
  assert.equal(ALFABETO, 'ABCDEFGHJKMNPQRSTUVWXYZ23456789');
});

test('pedir/verificar: o arquivo .key da pasta de registro nunca e aberto; log sem o texto da acao', async () => {
  const h = montar();
  const abertos = [];
  const orig = { readFileSync: fs.readFileSync, openSync: fs.openSync };
  fs.readFileSync = function (p, ...r) { abertos.push(String(p)); return orig.readFileSync.call(this, p, ...r); };
  fs.openSync = function (p, ...r) { abertos.push(String(p)); return orig.openSync.call(this, p, ...r); };
  try {
    const ok = h.ok();
    const r = await ok.pedir({ tipo: 'crm', acao: 'Mover o deal SEGREDINHO pra Ganho' });
    h.t = T0 + MIN;
    responder(h, 'sim', { cita: '3EB0PED1' });
    h.t = T0 + 2 * MIN;
    assert.equal((await ok.verificar(r.codigo)).status, 'ok');
  } finally {
    Object.assign(fs, orig);
  }
  assert.equal(abertos.some((p) => p.endsWith('.key')), false);
  const log = fs.readFileSync(h.env.SESSOES_WPP_LOG, 'utf8');
  assert.match(log, /pedir pedido [A-Z2-9]{6} sessao=11111111/);
  assert.match(log, /verificar ok [A-Z2-9]{6} sessao=11111111/);
  assert.doesNotMatch(log, /SEGREDINHO/);
});

// ---------- verificar ----------

async function pedidoCom(h, tipo = 'publicacao', acao = 'Publicar o site v2 em producao') {
  const ok = h.ok();
  const r = await ok.pedir({ tipo, acao, destinatarios: tipo === 'mensagem' ? 'Ana' : undefined });
  assert.equal(r.status, 'pedido');
  const p = h.pedido(r.codigo);
  return { ok, cod: r.codigo, prov: p.providerMsgId, uuid: p.messageId };
}

test('verificar: "Sim." do dono citando o pedido + copia no pessoal = ok, usado, ✅ e marker (publicacao)', async () => {
  const h = montar();
  const { ok, cod, prov } = await pedidoCom(h);
  h.t = T0 + MIN;
  const resp = responder(h, 'Sim.', { cita: prov });
  h.t = T0 + 2 * MIN;
  const r = await ok.verificar(cod);
  assert.deepEqual(r, { status: 'ok', codigo: cod, tipo: 'publicacao', acao: 'Publicar o site v2 em producao', destinatarios: null, hora: '16:01' });
  const p = h.pedido(cod);
  assert.equal(p.status, 'usado');
  assert.equal(p.usadoEm, iso(T0 + 2 * MIN));
  assert.deepEqual(p.verificadoPor, { providerMsgId: resp.provider, texto: 'Sim.', hora: '16:01' });
  assert.deepEqual(h.reacoes, [{ messageId: resp.id, emoji: '✅' }]);
  assert.deepEqual(h.markers(), {
    [SID]: { at: T0 + 2 * MIN, k: 'whatsapp', trecho: `${cod}: Publicar o site v2 em producao`, usos: 0 },
  });
  // leu a profissional e depois a pessoal, 50 de cada
  assert.deepEqual(h.leituras, [{ limit: 50, instancia: 'profissional' }, { limit: 50, instancia: 'pessoal' }]);
  // segunda verificacao do mesmo codigo
  const de_novo = await ok.verificar(cod);
  assert.deepEqual(de_novo, { status: 'invalido', motivo: 'ja usado' });
  assert.equal(h.reacoes.length, 1);
});

test('verificar: CRM nao grava marker; citar o messageId (uuid) do pedido tambem vale; mensagem devolve destinatarios', async () => {
  const h = montar();
  const a = await pedidoCom(h, 'crm', 'Mover o deal 123 pra Ganho');
  h.t = T0 + MIN;
  responder(h, 'pode', { cita: a.uuid });
  h.t = T0 + 2 * MIN;
  assert.equal((await a.ok.verificar(a.cod)).status, 'ok');
  assert.equal(h.markers(), null);
  const b = await pedidoCom(h, 'mensagem', 'Mandar o convite');
  h.t = T0 + 3 * MIN;
  responder(h, 'Manda!', { cita: b.prov });
  h.t = T0 + 4 * MIN;
  const r = await b.ok.verificar(b.cod);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.destinatarios, ['Ana']);
  assert.equal(h.markers(), null);
});

test('verificar: outra sessao, expirado, travado, membro estranho, hash adulterado = invalido sem efeito', async () => {
  const casos = [
    ['outra sessao', (h) => h.ok({ env: { ...h.env, CLAUDE_CODE_SESSION_ID: OUTRA } }), () => {}, 'pedido de outra sessao'],
    ['expirado', null, (h) => { h.t = T0 + 31 * MIN; }, 'expirou'],
    ['trava', null, (h) => fs.writeFileSync(path.join(h.env.SESSOES_WPP_DIR, 'estado.json'), JSON.stringify({ trava: true })), 'travado pelo dono'],
    ['membro extra', null, (h) => { h.membros.push('5511900000000'); }, 'membro estranho no grupo: 5511900000000'],
    ['hash', null, (h, cod) => {
      const p = h.pedido(cod);
      p.acao = 'Publicar OUTRA coisa';
      fs.writeFileSync(h.arquivo(cod), JSON.stringify(p));
    }, 'pedido adulterado'],
    // principal (validacao D4a): o hash cobre tipo e destinatarios tambem
    ['tipo editado', null, (h, cod) => {
      const p = h.pedido(cod);
      p.tipo = p.tipo === 'crm' ? 'publicacao' : 'crm';
      fs.writeFileSync(h.arquivo(cod), JSON.stringify(p));
    }, 'pedido adulterado'],
    ['destinatarios editados', null, (h, cod) => {
      const p = h.pedido(cod);
      p.destinatarios = ['Outra Pessoa'];
      fs.writeFileSync(h.arquivo(cod), JSON.stringify(p));
    }, 'pedido adulterado'],
  ];
  for (const [nome, outroOk, preparar, motivo] of casos) {
    const h = montar();
    const { ok, cod, prov } = await pedidoCom(h);
    h.t = T0 + MIN;
    responder(h, 'sim', { cita: prov });
    h.t = T0 + 2 * MIN;
    preparar(h, cod);
    const r = await (outroOk ? outroOk(h) : ok).verificar(cod);
    assert.deepEqual(r, { status: 'invalido', motivo }, nome);
    assert.equal(h.markers(), null, nome);
    assert.deepEqual(h.reacoes, [], nome);
    assert.equal(h.pedido(cod).status, 'pendente', nome);
  }
});

// Caso real: group-metadata do Z-API falhou 1 vez, o verificar devolveu invalido e a aba desistiu de um
// pedido que seguia valendo. Falha da conexao = pendente (nao concede, nao encerra); a conexao volta = o mesmo sim vale.
test('verificar: membros ou leitura do grupo com erro = pendente sem efeito; conexao de volta = ok com o mesmo sim', async () => {
  for (const [nome, quebrar, motivo] of [
    ['membros', (h) => { h.membrosErro = true; }, 'nao consegui conferir os membros agora; tenta de novo'],
    ['membros sem lista', (h) => { h.wpp.membros = async () => null; }, 'nao consegui conferir os membros agora; tenta de novo'],
    ['leitura', (h) => { h.aoLer = (inst) => { if (inst === 'profissional') throw new Error('Z-API 502'); }; }, 'nao consegui ler o grupo agora; tenta de novo'],
  ]) {
    const h = montar();
    const { ok, cod, prov } = await pedidoCom(h);
    h.t = T0 + MIN;
    responder(h, 'sim', { cita: prov });
    h.t = T0 + 2 * MIN;
    const membrosOriginal = h.wpp.membros;
    quebrar(h);
    const r = await ok.verificar(cod);
    assert.deepEqual(r, { status: 'pendente', motivo, ignoradas: [] }, nome);
    assert.equal(h.markers(), null, nome);
    assert.deepEqual(h.reacoes, [], nome);
    assert.equal(h.pedido(cod).status, 'pendente', `${nome}: o pedido segue valendo`);
    h.membrosErro = false;
    h.wpp.membros = membrosOriginal;
    h.aoLer = null;
    h.t = T0 + 3 * MIN;
    assert.equal((await ok.verificar(cod)).status, 'ok', `${nome}: conexao de volta`);
  }
});

test('verificar: membros sem o numero profissional (grupo diferente do esperado) = invalido', async () => {
  const h = montar();
  const { ok, cod, prov } = await pedidoCom(h);
  h.t = T0 + MIN;
  responder(h, 'sim', { cita: prov });
  h.membros = [NUMERO_DONO];
  const r = await ok.verificar(cod);
  assert.equal(r.status, 'invalido');
  assert.equal(h.markers(), null);
});

test('verificar: "não" = recusado gravado; depois "ja recusado"', async () => {
  const h = montar();
  const { ok, cod, prov } = await pedidoCom(h);
  h.t = T0 + MIN;
  responder(h, 'Não!', { cita: prov });
  h.t = T0 + 2 * MIN;
  const r = await ok.verificar(cod);
  assert.equal(r.status, 'recusado');
  assert.equal(h.pedido(cod).status, 'recusado');
  assert.equal(h.markers(), null);
  assert.deepEqual(h.reacoes, []);
  assert.deepEqual(await ok.verificar(cod), { status: 'invalido', motivo: 'ja recusado' });
});

test('verificar: "sim mas espera" e audio sem transcricao sao pulados (pendente); depois "pode" libera', async () => {
  const h = montar();
  const { ok, cod, prov } = await pedidoCom(h);
  h.t = T0 + MIN;
  responder(h, 'sim mas espera', { cita: prov });
  h.t = T0 + 2 * MIN;
  let r = await ok.verificar(cod);
  assert.equal(r.status, 'pendente');
  assert.equal(r.ignoradas.length, 1);
  assert.match(r.motivo, /sim mas espera/);
  responder(h, null, { cita: prov, tipo: 'ptt', transcription: null });
  h.t = T0 + 3 * MIN;
  r = await ok.verificar(cod);
  assert.equal(r.status, 'pendente');
  assert.equal(r.ignoradas.length, 2);
  assert.equal(h.pedido(cod).status, 'pendente');
  const pode = responder(h, 'Pode', { cita: prov });
  h.t = T0 + 4 * MIN;
  r = await ok.verificar(cod);
  assert.equal(r.status, 'ok');
  assert.equal(r.ignoradas.length, 2);
  assert.equal(h.pedido(cod).verificadoPor.providerMsgId, pode.provider);
  assert.deepEqual(h.reacoes, [{ messageId: pode.id, emoji: '✅' }]);
});

test('verificar: audio COM transcricao afirmativa vale (texto = transcription)', async () => {
  const h = montar();
  const { ok, cod, prov } = await pedidoCom(h, 'crm', 'Mover deal');
  h.t = T0 + MIN;
  responder(h, null, { cita: prov, tipo: 'ptt', transcription: 'Pode sim.' });
  const r = await ok.verificar(cod);
  assert.equal(r.status, 'ok');
  assert.equal(h.pedido(cod).verificadoPor.texto, 'Pode sim.');
});

test('verificar: resposta de outro numero, from_me, robo, citando outra, antes do pedido ou sem sent_by_agent = pendente', async () => {
  const casos = [
    ['outro numero', { de: '5511900000000' }],
    ['from_me', { fromMe: true }],
    ['sent_by_agent', { agente: true }],
    ['sent_by_agent ausente', { agente: 'ausente' }],
    ['sent_by_agent nulo', { agente: null }],
    ['citando outra', { cita: '3EB0OUTRA' }],
    ['antes do pedido', { ts: T0 - MIN }],
    ['no mesmo instante do pedido', { ts: T0 }],
  ];
  for (const [nome, extra] of casos) {
    const h = montar();
    const { ok, cod, prov } = await pedidoCom(h);
    h.t = T0 + MIN;
    responder(h, 'sim', { cita: prov, ts: T0 + MIN, ...extra });
    h.t = T0 + 2 * MIN;
    const r = await ok.verificar(cod);
    assert.equal(r.status, 'pendente', nome);
    assert.deepEqual(h.reacoes, [], nome);
    assert.equal(h.markers(), null, nome);
    assert.equal(h.pedido(cod).status, 'pendente', nome);
  }
});

test('verificar: copia no pessoal ausente = pendente; copia enviada por robo = invalido', async () => {
  const a = montar();
  const x = await pedidoCom(a);
  a.t = T0 + MIN;
  responder(a, 'sim', { cita: x.prov, copia: false });
  assert.deepEqual(await x.ok.verificar(x.cod), {
    status: 'pendente', motivo: 'esperando a copia do numero pessoal', ignoradas: [],
  });
  assert.equal(a.markers(), null);
  assert.deepEqual(a.reacoes, []);

  const b = montar();
  const y = await pedidoCom(b);
  b.t = T0 + MIN;
  responder(b, 'sim', { cita: y.prov, copiaAgente: true });
  assert.deepEqual(await y.ok.verificar(y.cod), { status: 'invalido', motivo: 'mensagem enviada por robo' });
  assert.equal(b.pedido(y.cod).status, 'pendente');
  assert.equal(b.markers(), null);

  // mesmo id no pessoal mas from_me false (nao saiu do celular do dono) nao conta como copia
  const c = montar();
  const z = await pedidoCom(c);
  c.t = T0 + MIN;
  responder(c, 'sim', { cita: z.prov, copiaFromMe: false });
  assert.equal((await z.ok.verificar(z.cod)).status, 'pendente');
});

test('verificar: codigo em formato invalido ou inexistente', async () => {
  const h = montar();
  const ok = h.ok();
  assert.equal((await ok.verificar('../../x')).status, 'invalido');
  assert.equal((await ok.verificar('ABCDE1')).status, 'invalido');
  assert.equal((await ok.verificar('ABCDEF')).status, 'invalido');
  assert.equal(h.leituras.length, 0);
});

// ---------- resposta sem citacao (caso real: o dono respondeu "sim" solto, sem citar) ----------

test('sem citacao: vale quando este era o UNICO pedido aberto na hora da resposta', async () => {
  const h = montar();
  const { ok, cod } = await pedidoCom(h, 'crm', 'Mover deal');
  h.t = T0 + 30 * 1000;
  responder(h, 'vou ver isso daqui a pouco', { cita: null }); // conversa solta no grupo: nao e resposta ao pedido
  h.t = T0 + MIN;
  const resp = responder(h, 'sim', { cita: null });
  h.t = T0 + 2 * MIN;
  const r = await ok.verificar(cod);
  assert.equal(r.status, 'ok');
  assert.equal(r.ignoradas, undefined, 'conversa solta nao entra em ignoradas');
  assert.equal(h.pedido(cod).verificadoPor.providerMsgId, resp.provider);
  assert.deepEqual(h.reacoes, [{ messageId: resp.id, emoji: '✅' }]);
});

test('sem citacao: 2 pedidos abertos (de qualquer sessao) = ambiguo, pendente nos dois; citando resolve', async () => {
  const h = montar();
  const a = await pedidoCom(h, 'crm', 'Mover deal A');
  h.t = T0 + 30 * 1000;
  const b = await pedidoCom(h, 'crm', 'Mover deal B');
  // B passa a ser de OUTRA sessao: a regra conta pedidos abertos de todas as abas
  const pb = h.pedido(b.cod);
  pb.sessionId = OUTRA;
  fs.writeFileSync(h.arquivo(b.cod), JSON.stringify(pb));
  h.t = T0 + MIN;
  responder(h, 'sim', { cita: null });
  h.t = T0 + 2 * MIN;
  const r = await a.ok.verificar(a.cod);
  assert.equal(r.status, 'pendente');
  // A4b: o texto inteiro (o "o dono tem que citar" ficava sem teste: so o pedaco "mais de um pedido aberto" era olhado)
  assert.equal(r.motivo, 'resposta sem citacao com mais de um pedido aberto: o dono tem que citar o pedido; sem resposta do dono ainda');
  assert.equal(h.pedido(a.cod).status, 'pendente');
  responder(h, 'sim', { cita: a.prov });
  h.t = T0 + 3 * MIN;
  assert.equal((await a.ok.verificar(a.cod)).status, 'ok');
});

test('sem citacao: "sim" solto dado antes do 2o pedido vale so pro 1o; nao e reaproveitado pelo 2o', async () => {
  const h = montar();
  const a = await pedidoCom(h, 'crm', 'Mover deal A');
  h.t = T0 + MIN;
  responder(h, 'sim', { cita: null });
  h.t = T0 + 2 * MIN;
  const b = await pedidoCom(h, 'crm', 'Mover deal B');
  h.t = T0 + 3 * MIN;
  assert.equal((await b.ok.verificar(b.cod)).status, 'pendente', 'resposta anterior ao pedido B');
  assert.equal((await a.ok.verificar(a.cod)).status, 'ok');
  // depois que A foi decidido, um novo "sim" solto so pode ser do B
  responder(h, 'pode', { cita: null });
  h.t = T0 + 4 * MIN;
  assert.equal((await b.ok.verificar(b.cod)).status, 'ok');
});

test('sem citacao: "sim" solto ja usado por outro pedido nao conta de novo', async () => {
  const h = montar();
  const a = await pedidoCom(h, 'crm', 'Mover deal A');
  h.t = T0 + MIN;
  const resp = responder(h, 'sim', { cita: null });
  h.t = T0 + 2 * MIN;
  assert.equal((await a.ok.verificar(a.cod)).status, 'ok');
  // forja: B criado antes da resposta, mas A ja consumiu aquela mensagem
  const b = await pedidoCom(h, 'crm', 'Mover deal B');
  const pb = h.pedido(b.cod);
  pb.criadoEm = iso(T0 + 30 * 1000);
  pb.hashAcao = crypto.createHash('sha256').update(JSON.stringify([pb.tipo, pb.acao, null])).digest('hex');
  fs.writeFileSync(h.arquivo(b.cod), JSON.stringify(pb));
  const r = await b.ok.verificar(b.cod);
  assert.equal(r.status, 'pendente');
  assert.equal(h.pedido(a.cod).verificadoPor.providerMsgId, resp.provider);
});

// ---------- fase 3 (PLANO.md F3.1-F3.3, repros da revisao GPT-6 de 27/09) ----------

const hashDe = (tipo, acao, dest) => crypto.createHash('sha256').update(JSON.stringify([tipo, acao, dest ?? null])).digest('hex');
let nAgente = 0;
// Mensagem de OUTRA aba/porteiro no grupo (sai pela profissional: from_me true, robo), no formato do read.
function postarAgente(h, texto, ts = h.t) {
  nAgente += 1;
  h.prof.push({
    id: `uuid-ag-${nAgente}`, provider_msg_id: `3EB0AG${nAgente}`, from_me: true, sent_by_agent: true, sender_phone: null,
    message_type: 'text', content: texto, quoted_msg_id: null, message_ts: tsWpp(ts),
  });
}
const semEfeito = (h, cod, nome) => {
  assert.equal(h.pedido(cod).status, 'pendente', nome);
  assert.equal(h.pedido(cod).usadoEm, undefined, nome);
  assert.equal(h.markers(), null, nome);
  assert.equal(h.ledger(), null, nome);
  assert.deepEqual(h.reacoes, [], nome);
};

test('F3.1 furo: arquivo trocado de "ler o deal 123" (crm) pra "apagar o deal 123" (apagar) com hash recalculado = invalido', async () => {
  const h = montar();
  const { ok, cod, prov } = await pedidoCom(h, 'crm', 'ler o deal 123');
  h.t = T0 + MIN;
  responder(h, 'sim', { cita: prov });
  h.t = T0 + 2 * MIN;
  const p = h.pedido(cod);
  Object.assign(p, { tipo: 'apagar', acao: 'apagar o deal 123', hashAcao: hashDe('apagar', 'apagar o deal 123', null) });
  fs.writeFileSync(h.arquivo(cod), JSON.stringify(p));
  // o hash confere (nao e "pedido adulterado"): quem pega e a mensagem que o dono leu
  assert.deepEqual(await ok.verificar(cod), { status: 'invalido', motivo: 'pedido diferente do que o dono viu' });
  semEfeito(h, cod);
});

test('F3.1: so o tipo trocado, pedido sem titulo (formato antigo) ou mensagem editada no grupo = "pedido diferente do que o dono viu"', async () => {
  const casos = [
    ['tipo crm -> apagar', (h, cod) => {
      const p = h.pedido(cod);
      Object.assign(p, { tipo: 'apagar', hashAcao: hashDe('apagar', p.acao, p.destinatarios) });
      fs.writeFileSync(h.arquivo(cod), JSON.stringify(p));
    }],
    ['acao trocada com mesmo tipo', (h, cod) => {
      const p = h.pedido(cod);
      Object.assign(p, { acao: 'ler o deal 124', hashAcao: hashDe('crm', 'ler o deal 124', p.destinatarios) });
      fs.writeFileSync(h.arquivo(cod), JSON.stringify(p));
    }],
    ['sem titulo', (h, cod) => {
      const p = h.pedido(cod);
      delete p.titulo;
      fs.writeFileSync(h.arquivo(cod), JSON.stringify(p));
    }],
    ['titulo trocado', (h, cod) => {
      const p = h.pedido(cod);
      p.titulo = 'Outra aba';
      fs.writeFileSync(h.arquivo(cod), JSON.stringify(p));
    }],
    ['texto do grupo diferente do arquivo', (h) => {
      h.prof[0].content = h.prof[0].content.replace('ler o deal 123', 'ler o deal 999');
    }],
  ];
  for (const [nome, preparar] of casos) {
    const h = montar();
    const { ok, cod, prov } = await pedidoCom(h, 'crm', 'ler o deal 123');
    h.t = T0 + MIN;
    responder(h, 'sim', { cita: prov });
    h.t = T0 + 2 * MIN;
    preparar(h, cod);
    assert.deepEqual(await ok.verificar(cod), { status: 'invalido', motivo: 'pedido diferente do que o dono viu' }, nome);
    semEfeito(h, cod, nome);
  }
  // destinatarios num formato que o pedir nunca grava ([] ou texto) = adulterado, mesmo com o hash recalculado
  for (const dest of [[], 'Ana', [''], [7]]) {
    const h = montar();
    const { ok, cod, prov } = await pedidoCom(h, 'mensagem', 'Mandar o convite');
    h.t = T0 + MIN;
    responder(h, 'sim', { cita: prov });
    const p = h.pedido(cod);
    Object.assign(p, { destinatarios: dest, hashAcao: hashDe(p.tipo, p.acao, dest) });
    fs.writeFileSync(h.arquivo(cod), JSON.stringify(p));
    assert.deepEqual(await ok.verificar(cod), { status: 'invalido', motivo: 'pedido adulterado' }, JSON.stringify(dest));
    semEfeito(h, cod, JSON.stringify(dest));
  }
});

test('F3.1: mensagem do pedido fora da leitura, ou com o id certo mas nao enviada por nos (from_me false) = invalido', async () => {
  const casos = [
    ['ausente', (h, prov) => { h.prof = h.prof.filter((m) => m.provider_msg_id !== prov); }],
    ['from_me false', (h, prov) => { h.prof.find((m) => m.provider_msg_id === prov).from_me = false; }],
    ['id diferente', (h, prov) => {
      const m = h.prof.find((x) => x.provider_msg_id === prov);
      m.provider_msg_id = '3EB0OUTRO';
      m.id = 'uuid-outro';
    }],
  ];
  for (const [nome, preparar] of casos) {
    const h = montar();
    const { ok, cod, prov } = await pedidoCom(h, 'crm', 'ler o deal 123');
    h.t = T0 + MIN;
    responder(h, 'sim', { cita: prov });
    preparar(h, prov);
    assert.deepEqual(await ok.verificar(cod), { status: 'invalido', motivo: 'mensagem do pedido nao encontrada no grupo' }, nome);
    semEfeito(h, cod, nome);
  }
});

test('F3.1 caminho feliz: acao com markdown bate com o texto do grupo; envio so com messageId acha pelo id', async () => {
  const h = montar();
  const { ok, cod, prov } = await pedidoCom(h, 'crm', 'Mover o deal 123 (Ana) pra **Ganho**');
  assert.match(h.prof[0].content, /pra \*Ganho\*\n/);
  h.t = T0 + MIN;
  responder(h, 'sim', { cita: prov });
  const r = await ok.verificar(cod);
  assert.deepEqual(r, { status: 'ok', codigo: cod, tipo: 'crm', acao: 'Mover o deal 123 (Ana) pra **Ganho**', destinatarios: null, hora: '16:01' });

  // provedor sem provider_msg_id: a mensagem do pedido e achada pelo id (e null nao casa com outra mensagem sem provider)
  const g = montar();
  g.respostasEnvio.push({ ok: true, messageId: 'uuid-so-id' });
  const x = await pedidoCom(g, 'crm', 'Mover deal');
  assert.equal(g.pedido(x.cod).providerMsgId, null);
  g.t = T0 + MIN;
  responder(g, 'sim', { cita: 'uuid-so-id' });
  assert.equal((await x.ok.verificar(x.cod)).status, 'ok');
});

test('F3.2: pedido -> mensagem de outra aba -> "sim" solto = pendente (tem que citar); citando, com a mensagem no meio, = ok', async () => {
  const h = montar();
  const { ok, cod, prov } = await pedidoCom(h, 'crm', 'Mover deal');
  h.t = T0 + 20 * 1000;
  postarAgente(h, 'ℹ️ *Outra*\nTerminei a página.\n\n*Publico?*\nA) Sim / B) Não');
  h.t = T0 + MIN;
  responder(h, 'sim', { cita: null });
  h.t = T0 + 2 * MIN;
  const r = await ok.verificar(cod);
  assert.equal(r.status, 'pendente');
  assert.ok(r.motivo.startsWith('resposta sem citacao depois de outra mensagem dos agentes: o dono tem que citar o pedido'), r.motivo);
  semEfeito(h, cod);
  const cita = responder(h, 'sim', { cita: prov });
  h.t = T0 + 3 * MIN;
  assert.equal((await ok.verificar(cod)).status, 'ok');
  assert.equal(h.pedido(cod).verificadoPor.providerMsgId, cita.provider);
});

test('F3.2: mensagem do proprio dono no meio nao atrapalha; mensagem dos agentes ANTES do pedido tambem nao', async () => {
  const h = montar();
  postarAgente(h, 'aviso antigo de outra aba', T0 - MIN);
  const { ok, cod } = await pedidoCom(h, 'crm', 'Mover deal');
  h.t = T0 + 20 * 1000;
  responder(h, 'hmm', { cita: null });
  h.t = T0 + MIN;
  const resp = responder(h, 'sim', { cita: null });
  h.t = T0 + 2 * MIN;
  assert.equal((await ok.verificar(cod)).status, 'ok');
  assert.equal(h.pedido(cod).verificadoPor.providerMsgId, resp.provider);
});

test('F3.2: "sim" solto com hora anterior a da mensagem do pedido no grupo nao e resposta a ele', async () => {
  const h = montar();
  const { ok, cod, prov } = await pedidoCom(h, 'crm', 'Mover deal');
  h.prof.find((m) => m.provider_msg_id === prov).message_ts = tsWpp(T0 + 2 * MIN); // o pedido so entrou no grupo depois
  h.t = T0 + MIN;
  responder(h, 'sim', { cita: null });
  h.t = T0 + 3 * MIN;
  const r = await ok.verificar(cod);
  assert.equal(r.status, 'pendente');
  semEfeito(h, cod);
});

// GPT-6 rodada 2 (27/09 23:47), achado 3: mensagem dos agentes no MESMO segundo da resposta (ou do pedido) nao
// contava como "no meio" (tx > tPedido && tx < t).
test('R2 empate: agente no mesmo segundo da resposta ou do pedido = no meio (tem que citar)', async () => {
  for (const [nome, tAgente] of [['empate com a resposta', T0 + MIN], ['empate com o pedido', T0]]) {
    const h = montar();
    const { ok, cod } = await pedidoCom(h, 'crm', 'Mover deal');
    postarAgente(h, 'ℹ️ *Outra*\n*Publico?*\nA) Sim / B) Não', tAgente);
    h.t = T0 + MIN;
    responder(h, 'sim', { cita: null });
    h.t = T0 + 2 * MIN;
    const r = await ok.verificar(cod);
    assert.equal(r.status, 'pendente', nome);
    assert.ok(r.motivo.startsWith('resposta sem citacao depois de outra mensagem dos agentes'), `${nome}: ${r.motivo}`);
    semEfeito(h, cod, nome);
  }
});

// Achado 1: pedido clonado (outro codigo com os mesmos ids da mensagem do pedido) reaproveitava o mesmo "sim" citado.
test('R2 clone: pedido usado copiado pra outro codigo nao vale de novo, nem com o mesmo sim citado', async () => {
  const h = montar();
  const { ok, cod, prov } = await pedidoCom(h, 'crm', 'Apagar o deal 123');
  h.t = T0 + MIN;
  responder(h, 'sim', { cita: prov });
  h.t = T0 + 2 * MIN;
  assert.equal((await ok.verificar(cod)).status, 'ok');
  const clone = cod === 'ZZZZZZ' ? 'YYYYYY' : 'ZZZZZZ';
  const p = h.pedido(cod);
  delete p.usadoEm;
  delete p.verificadoPor;
  fs.writeFileSync(h.arquivo(clone), JSON.stringify({ ...p, codigo: clone, status: 'pendente' }));
  h.t = T0 + 3 * MIN;
  assert.deepEqual(await ok.verificar(clone), { status: 'invalido', motivo: 'mensagem do pedido ja usada por outro codigo' });
  assert.equal(h.pedido(clone).status, 'pendente');
});

test('R2 resposta usada: o sim citado que ja decidiu um pedido nao decide outro (mesmo citando)', async () => {
  const h = montar();
  const a = await pedidoCom(h, 'crm', 'Mover deal A');
  h.t = T0 + 30 * 1000;
  const b = await pedidoCom(h, 'crm', 'Mover deal B');
  h.t = T0 + MIN;
  const sim = responder(h, 'sim', { cita: a.prov });
  h.t = T0 + 2 * MIN;
  assert.equal((await a.ok.verificar(a.cod)).status, 'ok');
  // a mesma resposta aparecendo como citacao do B (copia forjada do quoted) nao vale: ja foi consumida pelo A
  h.prof.find((m) => m.provider_msg_id === sim.provider).quoted_msg_id = b.prov;
  h.t = T0 + 3 * MIN;
  const r = await b.ok.verificar(b.cod);
  assert.equal(r.status, 'pendente');
  assert.equal(h.pedido(b.cod).status, 'pendente');
  assert.equal(h.pedido(b.cod).usadoEm, undefined);
  assert.equal(h.reacoes.length, 1, 'so a reacao do OK do A');
});

// Achado 11 (medium): a leitura pelo numero PESSOAL que falha ficava invalido (so a profissional tinha virado pendente).
test('R2 leitura pessoal com erro = pendente sem efeito; de volta = ok com o mesmo sim', async () => {
  const h = montar();
  const { ok, cod, prov } = await pedidoCom(h, 'crm', 'Mover deal');
  h.t = T0 + MIN;
  responder(h, 'sim', { cita: prov });
  h.t = T0 + 2 * MIN;
  h.aoLer = (inst) => { if (inst === 'pessoal') throw new Error('Z-API 502'); };
  assert.deepEqual(await ok.verificar(cod), {
    status: 'pendente', motivo: 'nao consegui ler o grupo pelo numero pessoal agora; tenta de novo', ignoradas: [],
  });
  semEfeito(h, cod);
  h.aoLer = null;
  h.t = T0 + 3 * MIN;
  assert.equal((await ok.verificar(cod)).status, 'ok');
});

test('F3.3: estado.json do porteiro ausente, podre ou nao-objeto = invalido (fail-closed), sem ler o WhatsApp', async () => {
  const casos = [
    ['ausente', { semEstado: true }, null],
    ['podre', {}, '{podre'],
    ['null', {}, 'null'],
    ['lista', {}, '[1]'],
  ];
  for (const [nome, opts, conteudo] of casos) {
    const h = montar(opts);
    const { ok, cod, prov } = await pedidoCom(h, 'publicacao');
    h.t = T0 + MIN;
    responder(h, 'sim', { cita: prov });
    if (conteudo !== null) fs.writeFileSync(h.estadoArq, conteudo);
    const antes = h.leituras.length;
    assert.deepEqual(await ok.verificar(cod), { status: 'invalido', motivo: 'estado do porteiro ilegivel' }, nome);
    assert.equal(h.leituras.length, antes, nome);
    semEfeito(h, cod, nome);
  }
});

test('F3.3: trava gravada pelo porteiro durante as leituras (corrida) = invalido logo antes de conceder, sem marker/ledger/reacao', async () => {
  const casos = [
    ['trava na leitura profissional', 'profissional', JSON.stringify({ v: 1, trava: true }), 'travado pelo dono', 'publicacao'],
    ['trava na leitura pessoal', 'pessoal', JSON.stringify({ v: 1, trava: true }), 'travado pelo dono', 'disparo'],
    ['estado podre na leitura pessoal', 'pessoal', '{podre', 'estado do porteiro ilegivel', 'publicacao'],
  ];
  for (const [nome, instancia, conteudo, motivo, tipo] of casos) {
    const h = montar();
    const { ok, cod, prov } = await pedidoCom(h, tipo, 'Publicar o site v2 em producao');
    h.t = T0 + MIN;
    responder(h, 'sim', { cita: prov });
    h.aoLer = (inst) => { if (inst === instancia) fs.writeFileSync(h.estadoArq, conteudo); };
    assert.deepEqual(await ok.verificar(cod), { status: 'invalido', motivo }, nome);
    assert.deepEqual(h.leituras.map((x) => x.instancia), ['profissional', 'pessoal'], nome);
    semEfeito(h, cod, nome);
  }
});

test('F3.3: "trava" do dono no grupo (texto ou audio, antes ou depois do pedido) = invalido com o porteiro morto', async () => {
  const casos = [
    ['"Trava." depois do pedido', (h) => { h.t = T0 + 20 * 1000; responder(h, 'Trava.', { cita: null }); }],
    ['audio "Trava!"', (h) => { h.t = T0 + 20 * 1000; responder(h, null, { cita: null, tipo: 'ptt', transcription: 'Trava!' }); }],
    ['"TRAVA" antes do pedido, sem destravadoEm', (h) => { responder(h, 'TRAVA', { cita: null, ts: T0 - 5 * MIN }); }],
    ['"trava" citando o pedido', (h, prov) => { h.t = T0 + 20 * 1000; responder(h, 'trava', { cita: prov }); }],
  ];
  for (const [nome, preparar] of casos) {
    const h = montar(); // estado.json com trava false: o porteiro nao viu (morto)
    const { ok, cod, prov } = await pedidoCom(h, 'publicacao');
    preparar(h, prov);
    h.t = T0 + MIN;
    responder(h, 'sim', { cita: prov });
    h.t = T0 + 2 * MIN;
    assert.deepEqual(await ok.verificar(cod), { status: 'invalido', motivo: 'travado pelo dono' }, nome);
    semEfeito(h, cod, nome);
  }
});

test('F3.3: "trava" com hora ANTES do destravadoEm nao conta (ok); "trava" de robo ou do numero profissional tambem nao', async () => {
  const casos = [
    ['antes do pedido', T0 - 2 * MIN, (h) => responder(h, 'trava', { cita: null, ts: T0 - 5 * MIN })],
    ['depois do pedido, destravado depois', T0 + 40 * 1000, (h) => { h.t = T0 + 20 * 1000; responder(h, 'Trava.', { cita: null }); }],
    ['eco do agente (from_me)', null, (h) => { h.t = T0 + 20 * 1000; postarAgente(h, 'trava'); }],
    ['sent_by_agent', null, (h) => { h.t = T0 + 20 * 1000; responder(h, 'trava', { cita: null, agente: true }); }],
  ];
  for (const [nome, destravado, preparar] of casos) {
    const h = montar();
    if (destravado !== null) {
      fs.writeFileSync(h.estadoArq, JSON.stringify({ v: 1, trava: false, destravadoEm: iso(destravado) }));
    }
    const { ok, cod, prov } = await pedidoCom(h, 'crm', 'Mover deal');
    preparar(h);
    h.t = T0 + MIN;
    responder(h, 'sim', { cita: prov });
    h.t = T0 + 2 * MIN;
    assert.equal((await ok.verificar(cod)).status, 'ok', nome);
  }
});

// ---------- disparo (ledger da trava de disparo) ----------

test('disparo: OK grava s.ok no ledger da trava de disparo (k whatsapp), preservando os envios; nao grava marker de deploy', async () => {
  const h = montar();
  fs.mkdirSync(path.dirname(h.disparoPath), { recursive: true });
  const envios = [{ to: '5511911111111', hash: 'abc', at: T0 - MIN }];
  fs.writeFileSync(h.disparoPath, JSON.stringify({ [SID]: { envios, ultimo: T0 - MIN }, [OUTRA]: { envios: [], ultimo: T0 } }));
  const { ok, cod, prov } = await pedidoCom(h, 'disparo', 'Convite da live pros 120 inscritos');
  h.t = T0 + MIN;
  responder(h, 'sim', { cita: prov });
  assert.equal((await ok.verificar(cod)).status, 'ok');
  const l = h.ledger();
  assert.deepEqual(l[SID].envios, envios);
  assert.deepEqual(l[SID].ok, { at: T0 + MIN, k: 'whatsapp', trecho: `${cod}: Convite da live pros 120 inscritos`, usos: 0 });
  assert.deepEqual(l[OUTRA], { envios: [], ultimo: T0 });
  assert.equal(h.markers(), null);
});

// ---------- marker ----------

test('marker: preserva as chaves de outras sessoes e poda as de mais de 24 h; JSON podre = recomeca', async () => {
  const h = montar();
  fs.mkdirSync(path.dirname(h.markerPath), { recursive: true });
  const outra = { at: T0 - 60 * MIN, k: 'texto', trecho: 'pode subir', usos: 1 };
  fs.writeFileSync(h.markerPath, JSON.stringify({ [OUTRA]: outra, velha: { at: T0 - 25 * 60 * MIN, k: 'texto', trecho: 'x', usos: 0 } }));
  const { ok, cod, prov } = await pedidoCom(h, 'publicacao', 'P'.repeat(120));
  h.t = T0 + MIN;
  responder(h, 'ok', { cita: prov });
  assert.equal((await ok.verificar(cod)).status, 'ok');
  const m = h.markers();
  assert.deepEqual(Object.keys(m).sort(), [OUTRA, SID].sort());
  assert.deepEqual(m[OUTRA], outra);
  assert.deepEqual(m[SID], { at: T0 + MIN, k: 'whatsapp', trecho: `${cod}: ${'P'.repeat(80)}`, usos: 0 });
  assert.deepEqual(fs.readdirSync(path.dirname(h.markerPath)), ['publicacao-ok.json']); // sem tmp sobrando

  const g = montar();
  fs.mkdirSync(path.dirname(g.markerPath), { recursive: true });
  fs.writeFileSync(g.markerPath, '{podre');
  const y = await pedidoCom(g);
  g.t = T0 + MIN;
  responder(g, 'aprovado', { cita: y.prov });
  assert.equal((await y.ok.verificar(y.cod)).status, 'ok');
  assert.deepEqual(Object.keys(g.markers()), [SID]);
});

// ---------- listas, listar e CLI ----------

// ---------- F3.4: trava de arquivo (A5c: a propria, lib/trava.mjs, o padrao do criarOkWpp; mesmo protocolo da do
// ambiente do dono) ----------

// Trava de OUTRO processo vivo e recente no arquivo (o dono aqui e este processo de teste, que esta vivo).
const travaAlheia = (arq) => {
  fs.mkdirSync(path.dirname(arq), { recursive: true });
  const conteudo = JSON.stringify({ pid: process.pid, at: Date.now(), token: 'outra-conferencia' });
  fs.writeFileSync(`${arq}.lock`, conteudo);
  return conteudo;
};

test('F3.4: pedido travado por outra conferencia = invalido, continua pendente, sem marker/reacao; trava solta = ok', async () => {
  const h = montar();
  const { cod, prov } = await pedidoCom(h);
  h.t = T0 + MIN;
  responder(h, 'sim', { cita: prov });
  h.t = T0 + 2 * MIN;
  const alheia = travaAlheia(h.arquivo(cod));
  const ok = h.ok({ esperaTravaMs: 150 });
  assert.deepEqual(await ok.verificar(cod), { status: 'invalido', motivo: 'pedido ocupado por outra conferencia (rodar o verificar de novo)' });
  assert.equal(h.pedido(cod).status, 'pendente');
  assert.equal(h.markers(), null);
  assert.deepEqual(h.reacoes, []);
  assert.equal(fs.readFileSync(`${h.arquivo(cod)}.lock`, 'utf8'), alheia, 'a trava do outro fica intacta');
  fs.unlinkSync(`${h.arquivo(cod)}.lock`);
  assert.equal((await ok.verificar(cod)).status, 'ok');
  assert.equal(fs.existsSync(`${h.arquivo(cod)}.lock`), false, 'o verificar solta a propria trava');
});

test('F3.4: "não" com o pedido travado = invalido e continua pendente', async () => {
  const h = montar();
  const { cod, prov } = await pedidoCom(h);
  h.t = T0 + MIN;
  responder(h, 'não', { cita: prov });
  h.t = T0 + 2 * MIN;
  travaAlheia(h.arquivo(cod));
  assert.equal((await h.ok({ esperaTravaMs: 150 }).verificar(cod)).status, 'invalido');
  assert.equal(h.pedido(cod).status, 'pendente');
});

test('F3.4: marker da trava de publicacao travado por outro processo = invalido sem gravar o marker (o pedido fica usado: pedir de novo)', async () => {
  const h = montar();
  const { cod, prov } = await pedidoCom(h);
  h.t = T0 + MIN;
  responder(h, 'sim', { cita: prov });
  h.t = T0 + 2 * MIN;
  const alheia = travaAlheia(h.markerPath);
  const r = await h.ok({ esperaTravaMs: 150 }).verificar(cod);
  assert.deepEqual(r, { status: 'invalido', motivo: 'OK conferido, mas nao consegui gravar o marker da trava de publicacao (pedir de novo)' });
  assert.equal(h.markers(), null);
  assert.equal(fs.readFileSync(`${h.markerPath}.lock`, 'utf8'), alheia);
  assert.equal(h.pedido(cod).status, 'usado', 'uso unico vem antes do marker (desenho do D4a)');
});

test('F3.4: ledger da trava de disparo travado = invalido sem gravar s.ok; trava de processo morto e recuperada', async () => {
  const h = montar();
  const { cod, prov } = await pedidoCom(h, 'disparo', 'Mandar o convite da live pros 40 da planilha');
  h.t = T0 + MIN;
  responder(h, 'sim', { cita: prov });
  h.t = T0 + 2 * MIN;
  travaAlheia(h.disparoPath);
  const r = await h.ok({ esperaTravaMs: 150 }).verificar(cod);
  assert.deepEqual(r, { status: 'invalido', motivo: 'OK conferido, mas nao consegui gravar o OK na trava de disparo (pedir de novo)' });
  assert.equal(h.ledger(), null);

  const g = montar();
  const p2 = await pedidoCom(g);
  g.t = T0 + MIN;
  responder(g, 'sim', { cita: p2.prov });
  g.t = T0 + 2 * MIN;
  const morto = Number(String(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout));
  fs.mkdirSync(path.dirname(g.markerPath), { recursive: true });
  fs.writeFileSync(`${g.markerPath}.lock`, JSON.stringify({ pid: morto, at: Date.now(), token: 'morto' }));
  assert.equal((await g.ok({ esperaTravaMs: 150 }).verificar(p2.cod)).status, 'ok');
  assert.ok(g.markers()[SID], 'marker gravado depois de recuperar a trava morta');
  assert.equal(fs.existsSync(`${g.markerPath}.lock`), false);
});

test('normalizar e classificar: listas fechadas, frase inteira, sem acento e sem pontuacao', () => {
  assert.equal(normalizarResposta('  Pode,   SIM!!  '), 'pode sim');
  assert.equal(normalizarResposta('Não.'), 'nao');
  for (const s of AFIRMATIVAS) assert.equal(classificarResposta(s), 'sim', s);
  for (const s of NEGATIVAS) assert.equal(classificarResposta(s), 'nao', s);
  for (const s of ['Sim.', 'S', 'OK!', 'Okay', 'Confirmo.', 'A', 'Vai!', 'Pode ir', 'pode publicar']) {
    assert.equal(classificarResposta(s), 'sim', s);
  }
  for (const s of ['NÃO', 'n', 'Cancela!', 'Espera...', 'B']) assert.equal(classificarResposta(s), 'nao', s);
  for (const s of ['sim mas espera', 'simm', 'claro', 'pode nao', '', null, 'sim sim', 'c']) {
    assert.equal(classificarResposta(s), null, String(s));
  }
  assert.deepEqual(AFIRMATIVAS, ['sim', 's', 'pode', 'pode sim', 'pode ir', 'pode mandar', 'pode seguir', 'pode publicar', 'manda', 'ok', 'okay', 'confirmo', 'confirmado', 'aprovado', 'aprovo', 'autorizo', 'vai', 'a']);
  assert.deepEqual(NEGATIVAS, ['nao', 'n', 'cancela', 'cancelar', 'para', 'espera', 'b']);
});

test('listar: so pendentes nao expirados desta sessao', async () => {
  const h = montar();
  const a = await pedidoCom(h, 'crm', 'Mover deal A');
  const usado = await pedidoCom(h, 'crm', 'Mover deal B');
  h.t = T0 + MIN;
  responder(h, 'sim', { cita: usado.prov });
  assert.equal((await usado.ok.verificar(usado.cod)).status, 'ok');
  // pedido de outra sessao no mesmo diretorio
  fs.writeFileSync(h.arquivo('ZZZZZZ'), JSON.stringify({ ...h.pedido(a.cod), codigo: 'ZZZZZZ', sessionId: OUTRA }));
  let l = h.ok().listar();
  assert.deepEqual(l.map((x) => x.codigo), [a.cod]);
  assert.equal(l[0].tipo, 'crm');
  assert.equal(l[0].hora, '16:30');
  h.t = T0 + 31 * MIN;
  l = h.ok().listar();
  assert.deepEqual(l, []);
});

test('codigoDeSaida: 0 ok/pedido, 2 pendente, 3 recusado, 1 invalido/erro', () => {
  assert.equal(codigoDeSaida('ok'), 0);
  assert.equal(codigoDeSaida('pedido'), 0);
  assert.equal(codigoDeSaida('pendente'), 2);
  assert.equal(codigoDeSaida('recusado'), 3);
  assert.equal(codigoDeSaida('invalido'), 1);
  assert.equal(codigoDeSaida('erro'), 1);
  assert.equal(codigoDeSaida(undefined), 1);
});

test('CLI: listar imprime JSON de 1 linha (exit 0); verificar de codigo inexistente = exit 1 sem tocar no WhatsApp', async () => {
  const h = montar();
  const { cod } = await pedidoCom(h, 'crm', 'Mover deal');
  const env = { ...process.env, ...h.env, SESSOES_WPP_DEPLOY_MARKER: h.markerPath };
  // h.t = T0 (passado): o pedido ja expirou no relogio real, entao listar vem vazio
  const l = spawnSync(process.execPath, [OK_WPP, 'listar'], { env, encoding: 'utf8' });
  assert.equal(l.status, 0, l.stderr);
  assert.equal(l.stdout.trim().split('\n').length, 1);
  assert.deepEqual(JSON.parse(l.stdout), []);
  const p = h.pedido(cod);
  p.expiraEm = iso(Date.now() + 10 * MIN);
  fs.writeFileSync(h.arquivo(cod), JSON.stringify(p));
  const l2 = spawnSync(process.execPath, [OK_WPP, 'listar'], { env, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(l2.stdout).map((x) => x.codigo), [cod]);
  const v = spawnSync(process.execPath, [OK_WPP, 'verificar', 'QQQQQQ'], { env, encoding: 'utf8' });
  assert.equal(v.status, 1);
  assert.equal(JSON.parse(v.stdout).status, 'invalido');
  const u = spawnSync(process.execPath, [OK_WPP, 'xpto'], { env, encoding: 'utf8' });
  assert.equal(u.status, 1);
});

// ---------- T7b1a 64: o ROTULO mora em lib/ok-tg.mjs ----------

test('T7b1a 64: ROTULO movido pra lib/ok-tg.mjs (reexportado, nao duplicado); montarMensagemPedido sai com os mesmos bytes', async () => {
  const okTg = await import('../lib/ok-tg.mjs');
  const okWpp = await import('../ok-wpp.mjs');
  assert.equal(okWpp.ROTULO, okTg.ROTULO, 'o ok-wpp reexporta o MESMO objeto');
  const casos = [
    ['crm', null, 'CRM'], ['crm', ['A'], 'CRM'],
    ['mensagem', null, 'mensagem'], ['mensagem', ['Ana', 'Bruno'], 'mensagem pra Ana, Bruno'],
    ['publicacao', null, 'publicação'],
    ['disparo', null, 'disparo em massa'], ['disparo', ['Lista'], 'disparo pra Lista'],
    ['pagamento', null, 'pagamento'], ['apagar', null, 'apagar'], ['outro', ['A'], 'ação'],
  ];
  for (const [tipo, d, rotulo] of casos) {
    assert.equal(okTg.rotuloDoPedido(tipo, d), rotulo, tipo);
    assert.equal(okTg.ROTULO[tipo](d), rotulo, tipo);
    assert.equal(
      montarMensagemPedido({ titulo: 'Faro', tipo, destinatarios: d, acao: 'Fazer **x**', hora: '16:30' }),
      `ℹ️ *Faro*\nPedido de OK (${rotulo}): Fazer *x*\n\n*Posso?* Vale até 16:30.`,
      tipo,
    );
  }
  for (const ruim of ['toString', 'hasOwnProperty', '', undefined, null]) {
    assert.throws(() => okTg.rotuloDoPedido(ruim, null), TypeError, String(ruim));
  }
  // o texto dos rotulos so existe num lugar: nenhuma copia sobrou no ok-wpp
  const fonte = fs.readFileSync(OK_WPP, 'utf8');
  for (const pedaco of ['disparo em massa', 'mensagem pra ', 'disparo pra ', "'publicação'"]) {
    assert.ok(!fonte.includes(pedaco), `copia do rotulo no ok-wpp: ${pedaco}`);
  }
});
