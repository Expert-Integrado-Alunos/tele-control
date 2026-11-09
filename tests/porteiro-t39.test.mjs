// Testes da T39 no porteiro (PLANO-TELEGRAM.md, "T39"; pedido do dono 08/11/2026 ~01h, pelo chat: «quando clico no modo
// tem que ter o botão de escolher, hoje não tem», «mesma coisa do rua e voltei, tem que ter um botão toggle pra mudar» e
// «a ordem é painel > central > rua/pc > modo > voz»): o menu do bot na ordem do dono (o "voltei" sai do menu); o /rua, o
// /modo e o /voz abrem a mensagem de ajustes com o estado e o botao que leva o estado ALVO; o toque troca na hora, o balao
// confirma com a frase de hoje e a propria mensagem muda pro estado novo; botao velho = "Já está assim."; a mensagem na
// tela se atualiza sozinha (o modo rua que liga com o PC parado); o "to na rua"/"voltei" escritos e o "/voltei" seguem
// direto, com a linha do sistema. Gravacao que falha = nada muda.
// Isolamento: pastas temporarias (prefixo "t39-") via SESSOES_WPP_DIR, CLAUDE_SESSIONS_DIR, CLAUDE_PROJECTS_DIR e
// SESSOES_WPP_LOG; nunca o ~/.claude real nem o config.json real. Nenhuma rede: o `tg` e um duble. Relogio e `dormir`
// falsos. Harness copiado do tests/porteiro-t29a.test.mjs (sem importar de outro teste).
// Rodar: node --test --test-reporter=tap "tests/porteiro-t39.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { criarPorteiro, COMANDOS_TG, ligarTelegram } from '../porteiro.mjs';
import { NUMERO_DONO } from './lib/dados-whatsapp.mjs';
import { CENTRAL_TESTE, RAIZES_TESTE } from './lib/dados-central.mjs';

const MIN = 60 * 1000;
const T0 = Date.parse('2026-11-08T04:00:00Z'); // 01:00 em Brasilia
const DONO = 700100200;
const BOT = 700900800;
// Textos do contrato da T39 (por extenso de proposito: o teste prende o texto)
const MENU_5 = [
  { command: 'painel', description: 'Painel das abas' },
  { command: 'central', description: 'Reabrir a central (atende o que não é de uma aba)' },
  { command: 'rua', description: 'Modo rua: ligar ou desligar' },
  { command: 'modo', description: 'Modo do painel e das mensagens' },
  { command: 'voz', description: 'Resposta por voz: ligar ou desligar' },
];
const RUA_LIGADO = 'Modo rua ligado.';
const RUA_DESLIGADO = 'Modo rua desligado.';
const VOZ_DESLIGADA = 'Resposta por voz desligada.';
const MODO_MANTER = 'Modo manter tudo: nada sai do chat; o resolvido só perde os botões.';
const PAINEL_VSCODE = 'Painel no modo VS Code.';
const JA_ESTA = 'Já está assim.';
const FALHA = 'Não consegui gravar o ajuste; nada mudou.';
const BOTAO_LIGAR_RUA = [[{ texto: 'Ligar modo rua', dados: 'a:r1' }]];
const BOTAO_DESLIGAR_RUA = [[{ texto: 'Desligar modo rua', dados: 'a:r0' }]];
// config.json como o instalador grava (2 espacos e a quebra de linha no fim)
const FORMATO = (cfg) => `${JSON.stringify(cfg, null, 2)}\n`;

// ---------- harness (copia do tests/porteiro-t29a.test.mjs, so o que este arquivo usa) ----------

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

// Duble do criarTelegram: os message_id saem de UM contador (h.nMid), o do dono e o do bot intercalados.
function dubleTg(h) {
  const tg = { chamadas: [], lotes: [] };
  const gravar = (metodo, args, id) => { tg.chamadas.push({ metodo, args, id }); };
  const novoId = () => { h.nMid += 1; return h.nMid; };
  tg.lerAtualizacoes = async (args) => {
    gravar('lerAtualizacoes', [{ ...args }]);
    if (tg.chamadas.length > 20000) throw new Error('duble: leitura demais (laco sem fim?)');
    const lote = tg.lotes.shift();
    if (lote === undefined) {
      h.t += (Number(args?.esperaS) || 0) * 1000;
      return [];
    }
    return lote;
  };
  const criar = (metodo, extra = {}) => async (pedido) => {
    const id = novoId();
    gravar(metodo, [pedido], id);
    return { ok: true, messageId: id, ...extra };
  };
  tg.enviar = criar('enviar', { formato: 'rich' });
  tg.enviarVoz = criar('enviarVoz');
  tg.enviarTexto = criar('enviarTexto');
  tg.editar = async (messageId, pedido) => { gravar('editar', [messageId, pedido]); return { ok: true }; };
  tg.editarTexto = async (messageId, pedido) => { gravar('editarTexto', [messageId, pedido]); return { ok: true }; };
  tg.editarBotoes = async (messageId, botoes) => { gravar('editarBotoes', [messageId, botoes]); return { ok: true }; };
  tg.apagar = async (messageId) => { gravar('apagar', [messageId]); return { ok: true }; };
  tg.responderToque = async (id, texto) => { gravar('responderToque', [id, texto]); return { ok: true }; };
  tg.quemSou = async () => { gravar('quemSou', []); return { ok: true, id: BOT, username: 'Teste_ControleBot' }; };
  tg.definirComandos = async (c) => { gravar('definirComandos', [c]); return { ok: true }; };
  tg.de = (metodo) => tg.chamadas.filter((c) => c.metodo === metodo);
  tg.zerar = () => { tg.chamadas.length = 0; };
  return tg;
}

// `config` = o config.json da pasta de estado: objeto (gravado no FORMATO do instalador) ou null (sem arquivo).
function montar({ config = { telegram: { ligado: true } } } = {}) {
  const raiz = pastaTemp('t39-');
  const env = {
    SESSOES_WPP_DIR: path.join(raiz, 'estado'),
    CLAUDE_SESSIONS_DIR: path.join(raiz, 'sessions'),
    CLAUDE_PROJECTS_DIR: path.join(raiz, 'projects'),
    SESSOES_WPP_LOG: path.join(raiz, 'porteiro.log'),
  };
  for (const d of [env.SESSOES_WPP_DIR, env.CLAUDE_SESSIONS_DIR, env.CLAUDE_PROJECTS_DIR]) fs.mkdirSync(d, { recursive: true });
  const arqCfg = path.join(env.SESSOES_WPP_DIR, 'config.json');
  if (config !== null) fs.writeFileSync(arqCfg, FORMATO(config));
  const h = { raiz, env, arqCfg, t: T0, idle: 0, grupo: [], enviados: [], entregas: [], nUpd: 100, nMid: 7000 };
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
      h.entregas.push(p);
      return { status: 'enviado', detalhe: '' };
    },
  };
  h.tg = dubleTg(h);
  h.opcoes = {
    wpp: h.wpp, numeroDono: NUMERO_DONO, mensageiro: h.mensageiro, ocioso: async () => h.idle, agora: () => h.t, env, ensaio: false,
    abrirCentral: () => {}, rand: randFixo(), dormir: async (ms) => { h.t += ms; },
    tg: h.tg, identTg: { chatId: DONO, botId: BOT }, central: CENTRAL_TESTE, raizesSessao: RAIZES_TESTE, canalPrincipal: 'telegram',
  };
  h.cru = criarPorteiro(h.opcoes);
  h.p = comBomba(h.cru);
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
const ligarTg = (h) => mexer(h, (e) => { e.tg.offset = 0; }); // historico ja pulado
const logs = (h) => {
  try { return fs.readFileSync(h.env.SESSOES_WPP_LOG, 'utf8').split('\n').filter(Boolean); } catch { return []; }
};
async function ligarRua(h) {
  h.idle = 30 * MIN;
  await h.p.passoMinuto();
  assert.equal(estado(h).modoRua.ligado, true);
}
const cfg = (h) => JSON.parse(fs.readFileSync(h.arqCfg, 'utf8'));
const ruaLigada = (h) => estado(h).modoRua?.ligado === true;

function msgTg(h, texto) {
  h.nUpd += 1;
  h.nMid += 1;
  const m = {
    message_id: h.nMid, date: Math.floor(h.t / 1000), text: texto,
    chat: { id: DONO, type: 'private', first_name: 'Davi' }, from: { id: DONO, is_bot: false, first_name: 'Davi' },
  };
  return { update_id: h.nUpd, message: m };
}
const mid = (u) => u.message.message_id;
function toqueTg(h, dados, messageId) {
  h.nUpd += 1;
  return {
    update_id: h.nUpd,
    callback_query: { id: `q${h.nUpd}`, from: { id: DONO, is_bot: false }, message: { message_id: messageId, chat: { id: DONO, type: 'private' } }, data: dados },
  };
}
async function lerTg(h, updates) {
  h.tg.lotes.push(updates);
  await h.p.esperarTelegram(15000);
}

// O comando digitado (ou tocado no menu: chega igual, "/rua") ate o que ele gera sair.
async function comando(h, texto) {
  const u = msgTg(h, texto);
  h.tg.zerar();
  await lerTg(h, [u]);
  return u;
}
// A linha do sistema com `frase`, em cima do comando `u`
const linha = (h, frase, u) => h.tg.de('enviar').some((c) => String(c.args[0].html).includes(frase) && c.args[0].responderA === mid(u));
const linhas = (h) => JSON.stringify(h.tg.de('enviar').map((c) => [c.args[0].responderA, c.args[0].html, c.args[0].botoes ?? null]));
const metodos = (h) => JSON.stringify(h.tg.chamadas.filter((c) => c.metodo !== 'lerAtualizacoes').map((c) => [c.metodo, c.id ?? c.args[0]]));

// ---------- ajudantes da T39 ----------

// O comando do menu -> a mensagem de ajustes (1 so) em cima dele: {u, id, pedido}
async function abrir(h, texto) {
  const u = await comando(h, texto);
  const env = h.tg.de('enviar').filter((c) => c.args[0].responderA === mid(u));
  assert.equal(env.length, 1, `1 mensagem em cima do comando: ${linhas(h)}`);
  return { u, id: env[0].id, pedido: env[0].args[0] };
}
// O toque num botao da mensagem `id` (zera as chamadas antes)
async function tocar(h, dados, id) {
  h.tg.zerar();
  await lerTg(h, [toqueTg(h, dados, id)]);
}
const baloes = (h) => h.tg.de('responderToque').map((c) => c.args[1]);
const edicoes = (h, id) => h.tg.de('editar').filter((c) => c.args[0] === id).map((c) => c.args[1]);
const temAjustes = (h) => h.tg.de('enviar').some((c) => JSON.stringify(c.args[0].botoes ?? null).includes('"a:'));
const contem = (p, ...textos) => textos.every((t) => String(p?.html).includes(t));

// ---------------------------------------------------------------------------------------------------------------

test('T39 1. menu: os 5 itens na ordem do dono (painel, central, rua, modo, voz; o voltei fora) e a subida manda a lista nova (setMyCommands pelo definirComandos)', async () => {
  assert.deepEqual(COMANDOS_TG, MENU_5);
  const menus = [];
  const tg = {
    quemSou: async () => ({ ok: true, id: BOT, username: 'Teste_ControleBot' }),
    definirComandos: async (c) => { menus.push(c); return { ok: true }; },
  };
  const r = await ligarTelegram({ config: { ligado: true }, token: `${BOT}:falso`, ident: { chatId: DONO, botId: BOT }, criarTelegram: () => tg });
  assert.equal(r, tg, 'ligado');
  assert.deepEqual(menus, [MENU_5], 'a lista nova vai pro Telegram na subida');
});

test('T39 2. /rua: a mensagem de ajustes em cima do comando (desligado, botao Ligar); o toque liga com o balao e a MESMA mensagem vira ligado com o Desligar; o toque no Desligar desliga', async () => {
  const h = montar();
  ligarTg(h);
  const a = await abrir(h, '/rua');
  assert.ok(contem(a.pedido, 'Modo rua: desligado.'), linhas(h));
  assert.deepEqual(a.pedido.botoes, BOTAO_LIGAR_RUA);
  assert.equal(ruaLigada(h), false, 'abrir nao liga');
  assert.ok(logs(h).some((l) => l.endsWith('Telegram: /rua: ajustes na tela')), logs(h).join('\n'));
  await tocar(h, 'a:r1', a.id);
  assert.equal(ruaLigada(h), true, 'o toque liga');
  assert.deepEqual(baloes(h), [RUA_LIGADO]);
  const ed1 = edicoes(h, a.id);
  assert.equal(ed1.length, 1, metodos(h));
  assert.ok(contem(ed1[0], 'Modo rua: ligado.'), JSON.stringify(ed1));
  assert.deepEqual(ed1[0].botoes, BOTAO_DESLIGAR_RUA);
  assert.equal(h.tg.de('enviar').length, 0, `nenhuma mensagem nova: ${linhas(h)}`);
  await tocar(h, 'a:r0', a.id);
  assert.equal(ruaLigada(h), false, 'o toque no Desligar desliga');
  assert.deepEqual(baloes(h), [RUA_DESLIGADO]);
  const ed2 = edicoes(h, a.id);
  assert.equal(ed2.length, 1, metodos(h));
  assert.ok(contem(ed2[0], 'Modo rua: desligado.'), JSON.stringify(ed2));
  assert.deepEqual(ed2[0].botoes, BOTAO_LIGAR_RUA);
});

test('T39 3. botao velho: o 2o toque no Ligar com o modo ja ligado = "Já está assim." e nada muda; o modo rua que liga sozinho (PC parado) edita a mensagem na tela na volta seguinte', async () => {
  const h = montar();
  ligarTg(h);
  const a = await abrir(h, '/rua');
  await tocar(h, 'a:r1', a.id);
  const rua = estado(h).modoRua;
  assert.equal(rua.ligado, true);
  await tocar(h, 'a:r1', a.id);
  assert.deepEqual(baloes(h), [JA_ESTA]);
  assert.deepEqual(estado(h).modoRua, rua, 'o estado nao muda');
  assert.equal(edicoes(h, a.id).length, 0, `a mensagem ja mostra o estado de hoje: ${metodos(h)}`);

  const k = montar();
  ligarTg(k);
  const b = await abrir(k, '/rua');
  assert.ok(contem(b.pedido, 'Modo rua: desligado.'));
  await ligarRua(k);
  k.tg.zerar();
  await k.p.esperarTelegram(15000);
  const ed = edicoes(k, b.id);
  assert.equal(ed.length, 1, metodos(k));
  assert.ok(contem(ed[0], 'Modo rua: ligado.'), JSON.stringify(ed));
  assert.deepEqual(ed[0].botoes, BOTAO_DESLIGAR_RUA);
  k.tg.zerar();
  await k.p.esperarTelegram(15000);
  assert.equal(edicoes(k, b.id).length, 0, 'igual ao estado = sem edicao');
});

test('T39 4. /modo: as 2 linhas e os 2 botoes; "manter tudo" grava telegram.resolvidas; "modo VS Code" grava painel.modo e edita o painel na tela; sem painel na tela nao sai painel novo', async () => {
  const h = montar();
  ligarTg(h);
  const pu = await comando(h, '/painel');
  const painel = h.tg.de('enviar').find((c) => c.args[0].responderA === mid(pu));
  assert.ok(painel, `o painel na tela: ${linhas(h)}`);
  const a = await abrir(h, '/modo');
  assert.ok(contem(a.pedido, 'Painel: modo padrão.', 'Mensagens: modo limpo.'), linhas(h));
  assert.deepEqual(a.pedido.botoes, [
    [{ texto: 'Painel: usar modo VS Code', dados: 'a:pv' }],
    [{ texto: 'Mensagens: usar manter tudo', dados: 'a:mm' }],
  ]);
  await tocar(h, 'a:mm', a.id);
  assert.deepEqual(cfg(h), { telegram: { ligado: true, resolvidas: 'manter' } });
  assert.deepEqual(baloes(h), [MODO_MANTER]);
  const ed1 = edicoes(h, a.id);
  assert.equal(ed1.length, 1, metodos(h));
  assert.ok(contem(ed1[0], 'Painel: modo padrão.', 'Mensagens: manter tudo.'), JSON.stringify(ed1));
  assert.deepEqual(ed1[0].botoes[1], [{ texto: 'Mensagens: usar modo limpo', dados: 'a:ml' }]);
  await tocar(h, 'a:pv', a.id);
  assert.deepEqual(cfg(h), { telegram: { ligado: true, resolvidas: 'manter' }, painel: { modo: 'vscode' } });
  assert.deepEqual(baloes(h), [PAINEL_VSCODE]);
  const ep = edicoes(h, painel.id);
  assert.ok(ep.length >= 1 && JSON.stringify(ep.at(-1).botoes).includes('"Modo padrão"'), `o painel editado no lugar: ${metodos(h)}`);
  const ed2 = edicoes(h, a.id);
  assert.equal(ed2.length, 1, metodos(h));
  assert.ok(contem(ed2[0], 'Painel: modo VS Code.', 'Mensagens: manter tudo.'), JSON.stringify(ed2));
  assert.equal(h.tg.de('enviar').length, 0, `nenhuma mensagem nova: ${linhas(h)}`);

  const k = montar();
  ligarTg(k);
  const b = await abrir(k, '/modo');
  await tocar(k, 'a:pv', b.id);
  assert.deepEqual(cfg(k), { telegram: { ligado: true }, painel: { modo: 'vscode' } });
  assert.deepEqual(baloes(k), [PAINEL_VSCODE]);
  assert.equal(k.tg.de('enviar').length, 0, `sem painel na tela, nenhum painel novo: ${linhas(k)}`);
  assert.deepEqual(k.tg.de('editar').map((c) => c.args[0]), [b.id], 'so a mensagem de ajustes muda');
});

test('T39 5. /voz: o Desligar grava voz.ligada false e a mensagem passa a "Resposta por voz: desligada."', async () => {
  const h = montar();
  ligarTg(h);
  const a = await abrir(h, '/voz');
  assert.ok(contem(a.pedido, 'Resposta por voz: ligada.'), linhas(h));
  assert.deepEqual(a.pedido.botoes, [[{ texto: 'Desligar voz', dados: 'a:v0' }]]);
  await tocar(h, 'a:v0', a.id);
  assert.deepEqual(cfg(h), { telegram: { ligado: true }, voz: { ligada: false } });
  assert.deepEqual(baloes(h), [VOZ_DESLIGADA]);
  const ed = edicoes(h, a.id);
  assert.equal(ed.length, 1, metodos(h));
  assert.ok(contem(ed[0], 'Resposta por voz: desligada.'), JSON.stringify(ed));
  assert.deepEqual(ed[0].botoes, [[{ texto: 'Ligar voz', dados: 'a:v1' }]]);
  assert.ok(logs(h).some((l) => l.endsWith('Telegram: voz pelo botão: desligada (config.json gravado)')), logs(h).join('\n'));
});

test('T39 6. gravacao que falha (config.json ausente): o balao "Não consegui gravar o ajuste; nada mudou.", a memoria igual e a mensagem igual', async () => {
  const h = montar();
  ligarTg(h);
  const a = await abrir(h, '/voz');
  fs.rmSync(h.arqCfg);
  await tocar(h, 'a:v0', a.id);
  assert.deepEqual(baloes(h), [FALHA]);
  assert.equal(edicoes(h, a.id).length, 0, metodos(h));
  const m = await abrir(h, '/modo');
  await tocar(h, 'a:mm', m.id);
  assert.deepEqual(baloes(h), [FALHA]);
  await tocar(h, 'a:pv', m.id);
  assert.deepEqual(baloes(h), [FALHA]);
  assert.equal(edicoes(h, m.id).length, 0, metodos(h));
  assert.equal(fs.existsSync(h.arqCfg), false, 'nada gravado');
  const v = await abrir(h, '/voz');
  assert.ok(contem(v.pedido, 'Resposta por voz: ligada.'), `a voz segue ligada: ${linhas(h)}`);
  const m2 = await abrir(h, '/modo');
  assert.ok(contem(m2.pedido, 'Painel: modo padrão.', 'Mensagens: modo limpo.'), `o modo segue igual: ${linhas(h)}`);
});

test('T39 7. texto escrito segue direto: "to na rua" liga e "voltei" desliga, com a linha do sistema; nenhuma mensagem de ajustes', async () => {
  const h = montar();
  ligarTg(h);
  const u1 = await comando(h, 'to na rua');
  assert.equal(ruaLigada(h), true);
  assert.ok(linha(h, RUA_LIGADO, u1), linhas(h));
  assert.equal(temAjustes(h), false, linhas(h));
  const u2 = await comando(h, 'voltei');
  assert.equal(ruaLigada(h), false);
  assert.ok(linha(h, RUA_DESLIGADO, u2), linhas(h));
  assert.equal(temAjustes(h), false, linhas(h));
});

test('T39 8. "/voltei" digitado (fora do menu) desliga direto, com a linha do sistema "Modo rua desligado."', async () => {
  const h = montar();
  ligarTg(h);
  await ligarRua(h);
  const u = await comando(h, '/voltei');
  assert.equal(ruaLigada(h), false);
  assert.ok(linha(h, RUA_DESLIGADO, u), linhas(h));
  assert.equal(temAjustes(h), false, linhas(h));
});

test('T39 9. botao velho no mesmo lote em que o estado mudou por outro caminho ("to na rua" escrito e depois o Ligar): "Já está assim." e a mensagem ja sai com o estado de hoje, sem esperar a volta seguinte', async () => {
  const h = montar();
  ligarTg(h);
  const a = await abrir(h, '/rua');
  assert.ok(contem(a.pedido, 'Modo rua: desligado.'), linhas(h));
  h.tg.zerar();
  await lerTg(h, [msgTg(h, 'to na rua'), toqueTg(h, 'a:r1', a.id)]);
  assert.equal(ruaLigada(h), true);
  assert.deepEqual(baloes(h), [JA_ESTA]);
  const ed = edicoes(h, a.id);
  assert.equal(ed.length, 1, metodos(h));
  assert.ok(contem(ed[0], 'Modo rua: ligado.'), JSON.stringify(ed));
  assert.deepEqual(ed[0].botoes, BOTAO_DESLIGAR_RUA);
});
