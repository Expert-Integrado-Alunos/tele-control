// Instalador da versao aberta (PLANO-ABERTO.md, "Instalador (contrato técnico, 14/10/2026 tarde)"): as funcoes do
// lib/instalar.mjs e a linha de comando do instalar.mjs, so com pasta temporaria (tests/lib/pasta-temp.cjs), fetch falso
// e processos falsos. Nada de rede, registro real, janela, settings.json real nem pasta Inicializar real.
// Dados 100% ficticios (Fulano, bot_de_teste): estes testes vao pra copia aberta.
// Rodar: node --test --test-reporter=tap "tests/instalar.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  compararVersao, versaoDe, juntarConfig, HOOKS, caminhoHook, juntarHooks, tirarHooks, MARCA_INICIO, MARCA_FIM,
  BLOCO_CLAUDE_MD, porBloco, tirarBloco, MARCA_VBS, vbsDeInicio, ehVbsNosso, chatsDoGetUpdates, ultimoUpdateId,
  chamarTelegram, conferirChave, lerChats, marcarLidas, checar, pastasSugeridas,
} from '../lib/instalar.mjs';
import { executar, TEXTO_TESTE, CREDITO, esperarSubidaReal, PASSOS, OPCOES } from '../instalar.mjs';

const require = createRequire(import.meta.url);
const { pastaTemp } = require('./lib/pasta-temp.cjs');

const REPO = 'C:\\Users\\Fulano de Tal\\tele-control';
// Chave falsa montada na hora: no formato do Telegram, mas sem nunca existir como texto no arquivo (a trava de segredo
// do PC e o publicador procuram esse formato).
const SEGREDO_FALSO = 'AA' + 'b'.repeat(33);
const TOKEN = ['123456789', SEGREDO_FALSO].join(':');

// ---------- versao ----------
// Mac-testes (A): os testes marcados com SO_WINDOWS conferem a premissa do Windows (caminho X:\, .exe, wscript/.vbs,
// cmd.exe, APPDATA/LOCALAPPDATA, pipe \\.\pipe, barra invertida na frase, PowerShell, VS Code/Orca abertos pelo
// porteiro); fora do win32 eles pulam. O caminho do Mac tem os testes proprios em tests/mac-*.test.mjs.
const SO_WINDOWS = process.platform !== 'win32' && 'premissa do Windows (o Mac tem os tests/mac-*)';

test('versaoDe tira o x.y.z do texto; sem numero = null', () => {
  assert.equal(versaoDe('2.1.299 (Claude Code)'), '2.1.299');
  assert.equal(versaoDe('v22.13.1'), '22.13.1');
  assert.equal(versaoDe('Python 3.12.10'), '3.12.10');
  assert.equal(versaoDe('sem versao'), null);
  assert.equal(versaoDe(undefined), null);
});

test('compararVersao: -1, 0, 1 por grupo numerico; texto ruim = null', () => {
  assert.equal(compararVersao('22.0.0', '22.0.0'), 0);
  assert.equal(compararVersao('22.10.0', '22.9.5'), 1);
  assert.equal(compararVersao('2.1.280', '2.1.299'), -1);
  assert.equal(compararVersao('v24.1.0', '22.0.0'), 1);
  assert.equal(compararVersao('abc', '1.0.0'), null);
});

// ---------- config ----------
test('juntarConfig acrescenta so o que falta, em qualquer nivel, sem mexer no original', () => {
  const atual = { canalPrincipal: 'telegram', telegram: { ligado: true, chatId: 42 } };
  const copia = structuredClone(atual);
  const r = juntarConfig(atual, { telegram: { chatId: 42, nomeBot: 'Meu Bot' }, dono: { nome: 'Fulano' } });
  assert.deepEqual(r.config, { canalPrincipal: 'telegram', telegram: { ligado: true, chatId: 42, nomeBot: 'Meu Bot' }, dono: { nome: 'Fulano' } });
  assert.deepEqual(r.acrescentadas.sort(), ['dono', 'telegram.nomeBot']);
  assert.deepEqual(r.conflitos, []);
  assert.deepEqual(atual, copia);
});

test('juntarConfig: valor diferente vira conflito e nao muda; com trocar, muda e volta em trocadas', () => {
  const atual = { telegram: { chatId: 42 }, sessoes: { raizes: ['C:\\a'] } };
  const r = juntarConfig(atual, { telegram: { chatId: 7 }, sessoes: { raizes: ['C:\\b'] } });
  assert.equal(r.config.telegram.chatId, 42);
  assert.deepEqual(r.config.sessoes.raizes, ['C:\\a']);
  assert.deepEqual(r.conflitos.map((c) => c.caminho).sort(), ['sessoes.raizes', 'telegram.chatId']);
  const t = juntarConfig(atual, { telegram: { chatId: 7 } }, { trocar: true });
  assert.equal(t.config.telegram.chatId, 7);
  assert.deepEqual(t.trocadas, ['telegram.chatId']);
  assert.deepEqual(t.conflitos, []);
});

test('juntarConfig: lista igual nao e conflito; objeto contra valor e conflito no nivel de cima', () => {
  const r = juntarConfig({ a: [1, 2], b: 3 }, { a: [1, 2], b: { c: 1 } });
  assert.deepEqual(r.conflitos.map((c) => c.caminho), ['b']);
  assert.deepEqual(r.acrescentadas, []);
});

test('juntarConfig recusa dados que nao sao objeto', () => {
  assert.throws(() => juntarConfig({}, [1]), TypeError);
  assert.throws(() => juntarConfig({}, null), TypeError);
});

// ---------- hooks ----------
test('caminhoHook usa barra normal e o caminho com espaco inteiro', () => {
  assert.equal(caminhoHook(REPO, 'sessao-parou.js'), 'C:/Users/Fulano de Tal/tele-control/hooks/sessao-parou.js');
});

test('juntarHooks em settings vazio cria as 3 entradas no formato do Claude Code', () => {
  const r = juntarHooks({}, REPO);
  assert.deepEqual(r.acrescentados.sort(), ['PreToolUse', 'SessionStart', 'Stop']);
  assert.deepEqual(r.jaTinha, []);
  assert.deepEqual(r.settings.hooks.SessionStart, [{ matcher: 'startup|resume|clear', hooks: [{ type: 'command', command: 'node', args: ['C:/Users/Fulano de Tal/tele-control/hooks/porteiro-supervisor.js'], timeout: 5 }] }]);
  assert.deepEqual(r.settings.hooks.Stop, [{ hooks: [{ type: 'command', command: 'node', args: ['C:/Users/Fulano de Tal/tele-control/hooks/sessao-parou.js'], timeout: 5 }] }]);
  assert.deepEqual(r.settings.hooks.PreToolUse[0].matcher, 'AskUserQuestion');
  assert.equal(HOOKS.length, 3);
});

test('juntarHooks preserva o que existe, nao duplica e e idempotente', () => {
  const settings = { model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node', args: ['C:/outro/hooks/meu.js'] }] }] } };
  const copia = structuredClone(settings);
  const r1 = juntarHooks(settings, REPO);
  assert.equal(r1.settings.model, 'x');
  assert.equal(r1.settings.hooks.Stop.length, 2);
  assert.deepEqual(settings, copia);
  const r2 = juntarHooks(r1.settings, REPO);
  assert.deepEqual(r2.acrescentados, []);
  assert.deepEqual(r2.jaTinha.sort(), ['PreToolUse', 'SessionStart', 'Stop']);
  assert.deepEqual(r2.settings, r1.settings);
});

test('juntarHooks: arquivo com o mesmo nome ligado por outro caminho conta como ja tinha (comando ou args)', () => {
  const settings = { hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'node', args: ['C:/Users/Fulano/.claude/hooks/sessao-parou.js'] }] }],
    SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'node "D:\\x\\hooks\\porteiro-supervisor.js"' }] }],
  } };
  const r = juntarHooks(settings, REPO);
  assert.deepEqual(r.jaTinha.sort(), ['SessionStart', 'Stop']);
  assert.deepEqual(r.acrescentados, ['PreToolUse']);
  assert.equal(r.settings.hooks.Stop.length, 1);
});

test('tirarHooks tira so as entradas com o caminho do repo e limpa evento vazio', () => {
  const comOutro = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node', args: ['C:/outro/hooks/meu.js'] }] }] } };
  const { settings } = juntarHooks(comOutro, REPO);
  const r = tirarHooks(settings, REPO);
  assert.deepEqual(r.tirados.sort(), ['PreToolUse', 'SessionStart', 'Stop']);
  assert.deepEqual(r.settings, comOutro);
  const vazio = tirarHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node', args: ['C:/Users/Fulano/.claude/hooks/sessao-parou.js'] }] }] } }, REPO);
  assert.deepEqual(vazio.tirados, [], 'o mesmo nome por outro caminho nao e nosso');
});

test('juntarHooks e tirarHooks recusam settings que nao e objeto ou hooks torto', () => {
  assert.throws(() => juntarHooks([], REPO), TypeError);
  assert.throws(() => juntarHooks({ hooks: [] }, REPO), TypeError);
  assert.throws(() => juntarHooks({ hooks: { Stop: {} } }, REPO), TypeError);
  assert.throws(() => tirarHooks(null, REPO), TypeError);
});

// ---------- CLAUDE.md ----------
test('porBloco poe o bloco marcado no fim; de novo troca so o miolo', () => {
  const t1 = porBloco('# Minhas regras\n- uma\n');
  assert.ok(t1.startsWith('# Minhas regras\n- uma\n\n' + MARCA_INICIO + '\n'));
  assert.ok(t1.trimEnd().endsWith(MARCA_FIM));
  assert.ok(t1.includes(BLOCO_CLAUDE_MD.trim()));
  const t2 = porBloco(t1.replace('- uma', '- uma\n- duas'), 'miolo novo');
  assert.equal(t2.split(MARCA_INICIO).length, 2, 'um bloco so');
  assert.ok(t2.includes('- duas'));
  assert.ok(t2.includes(MARCA_INICIO + '\nmiolo novo\n' + MARCA_FIM));
  assert.equal(porBloco(''), MARCA_INICIO + '\n' + BLOCO_CLAUDE_MD.trim() + '\n' + MARCA_FIM + '\n');
});

test('o bloco do CLAUDE.md fala das 3 marcas que o sessao-parou reconhece', () => {
  assert.match(BLOCO_CLAUDE_MD, /DECISÃO/);
  assert.match(BLOCO_CLAUDE_MD, /Fica com você/);
  assert.match(BLOCO_CLAUDE_MD, /\?/);
});

test('tirarBloco tira o bloco e a linha em branco antes; sem bloco nao mexe', () => {
  const original = '# Minhas regras\n- uma\n';
  const r = tirarBloco(porBloco(original));
  assert.equal(r.tirou, true);
  assert.equal(r.texto, original);
  assert.deepEqual(tirarBloco(original), { texto: original, tirou: false });
});

// ---------- .vbs de inicio ----------
test('vbsDeInicio chama o .vbs do repo com o caminho entre aspas e a marca na 1a linha', () => {
  const v = vbsDeInicio(REPO);
  assert.ok(v.startsWith(MARCA_VBS));
  assert.ok(v.includes('wscript.exe //nologo ""C:\\Users\\Fulano de Tal\\tele-control\\sessoes-wpp-porteiro.vbs""'));
  assert.ok(v.includes('\r\n'), 'VBScript com CRLF');
  assert.equal(ehVbsNosso(v), true);
  assert.equal(ehVbsNosso("' outro script\r\nMsgBox 1"), false);
  assert.throws(() => vbsDeInicio('C:\\pasta"com aspas'), /aspas/);
});

// ---------- Telegram ----------
const upd = (id, chat, from, texto = '/start', data = 1000 + id) => ({ update_id: id, message: { message_id: id, date: data, chat, from, text: texto } });
const pessoa = (id, nome, usuario) => ({ id, is_bot: false, first_name: nome, username: usuario });

test('chatsDoGetUpdates: conversa privada de gente, sem grupo e sem bot, a mais recente primeiro, sem repetir', () => {
  const lista = [
    upd(1, { id: 11, type: 'private', first_name: 'Fulano' }, pessoa(11, 'Fulano', 'fulano_teste')),
    upd(2, { id: -100, type: 'group', title: 'Grupo' }, pessoa(11, 'Fulano', 'fulano_teste')),
    upd(3, { id: 22, type: 'private', first_name: 'Ciclano' }, pessoa(22, 'Ciclano')),
    upd(4, { id: 33, type: 'private', first_name: 'Robo' }, { id: 33, is_bot: true, first_name: 'Robo' }),
    upd(5, { id: 11, type: 'private', first_name: 'Fulano' }, pessoa(11, 'Fulano', 'fulano_teste'), 'oi'),
    { update_id: 6, callback_query: { id: 'x' } },
  ];
  assert.deepEqual(chatsDoGetUpdates(lista), [
    { id: 11, nome: 'Fulano', usuario: 'fulano_teste' },
    { id: 22, nome: 'Ciclano', usuario: null },
  ]);
  assert.equal(ultimoUpdateId(lista), 6);
  assert.equal(ultimoUpdateId([]), null);
  assert.deepEqual(chatsDoGetUpdates(null), []);
});

function fetchFalso(respostas) {
  const chamadas = [];
  const f = async (url, opcoes) => {
    chamadas.push({ url, corpo: opcoes?.body ? JSON.parse(opcoes.body) : null });
    const metodo = String(url).split('/').pop();
    const r = respostas[metodo];
    if (r instanceof Error) throw r;
    if (!r) throw new Error('metodo sem resposta no teste: ' + metodo);
    return { status: r.status ?? 200, json: async () => r.corpo };
  };
  f.chamadas = chamadas;
  return f;
}

test('chamarTelegram nunca lanca e nunca devolve a chave, nem em erro de rede', async () => {
  const erro = new Error(`falhou https://api.telegram.org/bot${TOKEN}/getMe`);
  const r = await chamarTelegram({ fetch: fetchFalso({ getMe: erro }), token: TOKEN, metodo: 'getMe' });
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes(SEGREDO_FALSO), 'o segredo nao aparece');
  const r2 = await chamarTelegram({ fetch: fetchFalso({ getMe: { status: 401, corpo: { ok: false, description: 'Unauthorized' } } }), token: TOKEN, metodo: 'getMe' });
  assert.deepEqual(r2, { ok: false, status: 401, descricao: 'Unauthorized' });
});

test('conferirChave: getMe ok devolve o bot sem a chave; 401 = chave recusada; formato ruim nem chama', async () => {
  const f = fetchFalso({ getMe: { corpo: { ok: true, result: { id: 123456789, is_bot: true, first_name: 'Meu Bot', username: 'bot_de_teste' } } } });
  assert.deepEqual(await conferirChave({ fetch: f, token: TOKEN }), { ok: true, bot: { id: 123456789, usuario: 'bot_de_teste', nome: 'Meu Bot' } });
  const r401 = await conferirChave({ fetch: fetchFalso({ getMe: { status: 401, corpo: { ok: false, description: 'Unauthorized' } } }), token: TOKEN });
  assert.deepEqual(r401, { ok: false, erro: 'chave recusada pelo Telegram' });
  const f2 = fetchFalso({});
  assert.equal((await conferirChave({ fetch: f2, token: 'nao-e-chave' })).ok, false);
  assert.equal(f2.chamadas.length, 0);
});

test('lerChats: 409 = outro programa lendo o bot; ok devolve os chats e o ultimo update', async () => {
  const r409 = await lerChats({ fetch: fetchFalso({ getUpdates: { status: 409, corpo: { ok: false, description: 'Conflict' } } }), token: TOKEN });
  assert.equal(r409.ok, false);
  assert.match(r409.erro, /outro programa/);
  const f = fetchFalso({ getUpdates: { corpo: { ok: true, result: [upd(9, { id: 11, type: 'private', first_name: 'Fulano' }, pessoa(11, 'Fulano'))] } } });
  const r = await lerChats({ fetch: f, token: TOKEN });
  assert.deepEqual(r, { ok: true, chats: [{ id: 11, nome: 'Fulano', usuario: null }], ultimo: 9 });
  assert.equal(f.chamadas[0].corpo.timeout, 0);
  await marcarLidas({ fetch: f, token: TOKEN, offset: 10 });
  for (const c of f.chamadas) {
    assert.equal(Object.hasOwn(c.corpo, 'allowed_updates'), false, 'o Telegram guardaria a escolha e o porteiro perderia os botoes');
  }
});

// ---------- checar ----------
function rodarFalso(mapa) {
  return (cmd, args) => {
    const chave = [cmd, ...args].join(' ');
    if (!(chave in mapa)) return { status: null, error: new Error('ENOENT') };
    return { status: 0, stdout: mapa[chave] };
  };
}

test('checar: tudo presente = ok, com versoes; Python so com audio', () => {
  const r = checar({
    plataforma: 'win32', release: '10.0.22631', versaoNode: 'v24.1.0',
    rodar: rodarFalso({ 'claude --version': '2.1.299 (Claude Code)\n' }),
    existe: () => true, env: { LOCALAPPDATA: 'C:\\L', SystemRoot: 'C:\\W', USERPROFILE: 'C:\\U' }, audio: false,
  });
  assert.equal(r.ok, true);
  assert.equal(r.itens.windows.versao, 'Windows 11 (22631)');
  assert.equal(r.itens.node.versao, '24.1.0');
  assert.equal(r.itens.claude.versao, '2.1.299');
  assert.equal(r.itens.python, undefined);
});

test('checar: Node velho, Claude Code ausente e fora do Windows viram falta com o que fazer', () => {
  const r = checar({
    plataforma: 'linux', release: '6.1', versaoNode: 'v20.11.0', rodar: rodarFalso({}), existe: () => false,
    env: {}, audio: true,
  });
  assert.equal(r.ok, false);
  for (const k of ['windows', 'node', 'claude', 'terminal', 'powershell', 'python']) {
    assert.equal(r.itens[k].ok, false, k);
    assert.ok(r.itens[k].falta, `${k} diz o que falta`);
  }
});

test('checar acha o claude.exe na pasta padrao quando nao esta no PATH', () => {
  const exe = 'C:\\U\\.local\\bin\\claude.exe';
  const r = checar({
    plataforma: 'win32', release: '10.0.19045', versaoNode: 'v22.12.0',
    rodar: rodarFalso({ [`${exe} --version`]: '2.1.299 (Claude Code)' }), // A5d2: acima do minimo novo (2.1.295)
    existe: () => true, env: { LOCALAPPDATA: 'C:\\L', SystemRoot: 'C:\\W', USERPROFILE: 'C:\\U' }, audio: false,
  });
  assert.equal(r.itens.claude.ok, true);
  assert.equal(r.itens.claude.onde, exe);
  assert.equal(r.itens.windows.versao, 'Windows 10 (19045)');
});

// ---------- pastas sugeridas ----------
test('pastasSugeridas: a pasta que junta mais conversas, sem a casa nem a raiz do disco, sem repetir subpasta', () => {
  const casa = 'C:\\Users\\Fulano';
  const cwds = [
    'C:\\Users\\Fulano\\projetos\\app1', 'C:\\Users\\Fulano\\projetos\\app1', 'C:\\Users\\Fulano\\projetos\\app2',
    'C:\\Users\\Fulano\\projetos', 'D:\\trabalho\\cliente', 'D:\\trabalho\\cliente', 'C:\\Users\\Fulano',
  ];
  assert.deepEqual(pastasSugeridas(cwds, { casa }), [
    { pasta: 'C:\\Users\\Fulano\\projetos', conversas: 4 },
    { pasta: 'D:\\trabalho\\cliente', conversas: 2 },
  ]);
  assert.deepEqual(pastasSugeridas([], { casa }), []);
  assert.deepEqual(pastasSugeridas(['E:\\a', 'E:\\b'], { casa }), [
    { pasta: 'E:\\a', conversas: 1 },
    { pasta: 'E:\\b', conversas: 1 },
  ], 'a raiz do disco nunca e sugerida, nem juntando mais conversas');
});

test('pastasSugeridas: pesa pelas conversas de cada pasta; tira temporaria, de programa e a que nao existe mais', () => {
  const casa = 'C:\\Users\\Fulano';
  const itens = [
    { cwd: 'C:\\tmp', conversas: 50 },
    { cwd: 'C:\\Users\\Fulano\\AppData\\Local\\Temp\\x', conversas: 40 },
    { cwd: 'C:\\Users\\Fulano\\OneDrive\\antigo', conversas: 30 },
    { cwd: 'C:\\Program Files\\algo', conversas: 20 },
    { cwd: 'c:\\projetos\\app1', conversas: 5 },
    { cwd: 'C:\\projetos\\app2', conversas: 4 },
    { cwd: 'D:\\Meus Docs\\Area', conversas: 3 },
    { cwd: 'C:\\projetos\\parada', conversas: 0 },
  ];
  const existe = (p) => !p.toLowerCase().includes('onedrive');
  assert.deepEqual(pastasSugeridas(itens, { casa, existe }), [
    { pasta: 'C:\\projetos', conversas: 9 },
    { pasta: 'D:\\Meus Docs\\Area', conversas: 3 },
  ]);
  const quebra = () => { throw new Error('disco fora'); };
  assert.deepEqual(pastasSugeridas(itens, { casa, existe: quebra }), []);
});

// ---------- a skill /instalar ----------
test('a skill /instalar so roda pelo /instalar e so chama passos e opcoes que existem', () => {
  const texto = fs.readFileSync(path.join(import.meta.dirname, '..', '.claude', 'skills', 'instalar', 'SKILL.md'), 'utf8');
  const topo = /^---\r?\n([\s\S]*?)\r?\n---/.exec(texto);
  assert.ok(topo, 'tem o cabecalho');
  assert.match(topo[1], /^name: instalar$/m);
  assert.match(topo[1], /^disable-model-invocation: true$/m, 'so roda quando a pessoa digita /instalar');
  assert.match(topo[1], /^allowed-tools: .*Bash\(node instalar\.mjs:\*\)/m);
  const chamadas = [...texto.matchAll(/node instalar\.mjs ([a-z-]+)([^`\n]*)/g)];
  assert.ok(chamadas.length >= 10);
  for (const [, passo, resto] of chamadas) {
    assert.ok(PASSOS.includes(passo), `passo que existe: ${passo}`);
    for (const op of resto.match(/--[a-z-]+/g) ?? []) assert.ok(OPCOES.includes(op), `opcao que existe: ${op}`);
  }
  for (const passo of PASSOS) assert.ok(texto.includes(`node instalar.mjs ${passo}`), `a skill fala do passo ${passo}`);
  const exemplo = /`(\{"apps":.*\})`/.exec(texto);
  assert.ok(exemplo, 'tem o exemplo do config');
  const cfg = JSON.parse(exemplo[1]);
  assert.equal(cfg.telegram.ligado, true);
  assert.equal(cfg.whatsapp.ligado, false, 'v1: WhatsApp desligado explicito (o padrao do porteiro e ligado)');
  assert.ok(!/\d{5,16}:[A-Za-z0-9_-]{20,}/.test(texto), 'nenhuma chave de bot no texto');
});

test('a skill /instalar (T9): o exemplo do config sobrevive ao Git Bash (a barra invertida dupla vira uma) e grava a pasta', { skip: SO_WINDOWS }, async () => {
  const texto = fs.readFileSync(path.join(import.meta.dirname, '..', '.claude', 'skills', 'instalar', 'SKILL.md'), 'utf8');
  const exemplo = /`(\{"apps":.*\})`/.exec(texto);
  assert.ok(exemplo, 'tem o exemplo do config');
  const peloGitBash = exemplo[1].replace(/\\\\/g, '\\');
  const a = ambienteDeTeste();
  const r = await executar(['config', '--dados', peloGitBash], { env: a.env, existePasta: () => true });
  assert.equal(r.codigo, 0, JSON.stringify(r.saida));
  const cfg = JSON.parse(fs.readFileSync(path.join(a.estado, 'config.json'), 'utf8'));
  assert.deepEqual(cfg.sessoes.raizes, ['C:\\projetos']);
  assert.match(texto, /barra normal/, 'a skill avisa da barra normal');
});

// ---------- linha de comando ----------
function ambienteDeTeste() {
  const base = pastaTemp('instalar-');
  const estado = path.join(base, 'estado');
  const claudeDir = path.join(base, 'claude');
  const inicio = path.join(base, 'inicio');
  for (const p of [estado, claudeDir, inicio]) fs.mkdirSync(p, { recursive: true });
  return { base, estado, claudeDir, inicio, env: { SESSOES_WPP_DIR: estado, SESSOES_WPP_CLAUDE_DIR: claudeDir, SESSOES_WPP_STARTUP_DIR: inicio } };
}

test('linha de comando: passo desconhecido = codigo 2 com a lista de passos; opcao desconhecida ou sem valor tambem', async () => {
  const a = ambienteDeTeste();
  const r = await executar(['voar'], { env: a.env });
  assert.equal(r.codigo, 2);
  assert.equal(r.saida.ok, false);
  assert.match(r.saida.erro, /checar/);
  const op = await executar(['hooks', '--voar'], { env: a.env, repo: REPO });
  assert.equal(op.codigo, 2);
  assert.match(op.saida.erro, /--voar/);
  assert.ok(!fs.existsSync(path.join(a.claudeDir, 'settings.json')), 'uso errado nao mexe em nada');
  assert.equal((await executar(['config', '--dados'], { env: a.env })).codigo, 2);
});

test('linha de comando config: junta, guarda copia antes e registra no feito.json', async () => {
  const a = ambienteDeTeste();
  fs.writeFileSync(path.join(a.estado, 'config.json'), JSON.stringify({ telegram: { chatId: 42 } }));
  const r = await executar(['config', '--dados', JSON.stringify({ telegram: { chatId: 7, nomeBot: 'Meu Bot' } })], { env: a.env });
  assert.equal(r.codigo, 0);
  assert.deepEqual(r.saida.acrescentadas, ['telegram.nomeBot']);
  assert.deepEqual(r.saida.conflitos.map((c) => c.caminho), ['telegram.chatId']);
  const cfg = JSON.parse(fs.readFileSync(path.join(a.estado, 'config.json'), 'utf8'));
  assert.deepEqual(cfg, { telegram: { chatId: 42, nomeBot: 'Meu Bot' } });
  const copias = fs.readdirSync(path.join(a.estado, 'instalacao', 'copias'));
  assert.equal(copias.length, 1);
  assert.match(copias[0], /config\.json$/);
  const feito = JSON.parse(fs.readFileSync(path.join(a.estado, 'instalacao', 'feito.json'), 'utf8'));
  assert.ok(feito.config);
});

test('linha de comando config: config.json ilegivel nao e tocado', async () => {
  const a = ambienteDeTeste();
  fs.writeFileSync(path.join(a.estado, 'config.json'), '{ quebrado');
  const r = await executar(['config', '--dados', '{"a":1}'], { env: a.env });
  assert.equal(r.codigo, 1);
  assert.equal(fs.readFileSync(path.join(a.estado, 'config.json'), 'utf8'), '{ quebrado');
});

test('linha de comando config (T9): pasta de projeto pela regra do porteiro; a que o Git Bash quebrou nao entra calada', { skip: SO_WINDOWS }, async () => {
  // O Git Bash troca a barra invertida dupla por uma so: '{"...":["D:\\rede"]}' digitado chega como abaixo (\r = CR)
  const quebrada = '{"sessoes":{"raizes":["D:\\rede"]}}';
  const a = ambienteDeTeste();
  const r = await executar(['config', '--dados', quebrada], { env: a.env, existePasta: () => true });
  assert.equal(r.codigo, 2, JSON.stringify(r.saida));
  assert.match(r.saida.erro, /barra normal/);
  assert.match(r.saida.erro, /"C:\/projetos"/);
  assert.ok(!fs.existsSync(path.join(a.estado, 'config.json')), 'nada gravado');
  for (const ruim of ['["projetos"]', '["C:/"]', '"C:/projetos"', '[7]']) {
    const b = ambienteDeTeste();
    const r2 = await executar(['config', '--dados', `{"sessoes":{"raizes":${ruim}}}`], { env: b.env, existePasta: () => true });
    assert.equal(r2.codigo, 2, ruim);
    assert.ok(!fs.existsSync(path.join(b.estado, 'config.json')), `${ruim}: nada gravado`);
  }
  const c = ambienteDeTeste();
  const sumiu = await executar(['config', '--dados', '{"sessoes":{"raizes":["C:/projetos"]}}'], { env: c.env, existePasta: () => false });
  assert.equal(sumiu.codigo, 2);
  assert.match(sumiu.saida.erro, /C:\\projetos não existe/);
  assert.ok(!fs.existsSync(path.join(c.estado, 'config.json')), 'pasta que nao existe: nada gravado');
  const d = ambienteDeTeste();
  const vistas = [];
  const existePasta = (p) => { vistas.push(p); return true; };
  const boa = await executar(['config', '--dados', '{"sessoes":{"raizes":["c:/projetos/","C:\\\\Projetos","D:/b/../obras"],"soNaRaiz":false}}'], { env: d.env, existePasta });
  assert.equal(boa.codigo, 0, JSON.stringify(boa.saida));
  assert.deepEqual(vistas, ['C:\\projetos', 'C:\\Projetos', 'D:\\obras'], 'confere cada uma ja normalizada');
  const cfg = JSON.parse(fs.readFileSync(path.join(d.estado, 'config.json'), 'utf8'));
  assert.deepEqual(cfg.sessoes, { raizes: ['C:\\projetos', 'D:\\obras'], soNaRaiz: false }, 'normalizada, sem repetir (sem caso), o resto do bloco fica');
});

test('linha de comando hooks: junta no settings.json com copia antes; --tirar volta ao que era', async () => {
  const a = ambienteDeTeste();
  const arq = path.join(a.claudeDir, 'settings.json');
  const original = { model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node', args: ['C:/outro/hooks/meu.js'] }] }] } };
  fs.writeFileSync(arq, JSON.stringify(original, null, 2));
  const r = await executar(['hooks'], { env: a.env, repo: REPO });
  assert.equal(r.codigo, 0);
  assert.deepEqual(r.saida.acrescentados.sort(), ['PreToolUse', 'SessionStart', 'Stop']);
  assert.equal(JSON.parse(fs.readFileSync(arq, 'utf8')).hooks.Stop.length, 2);
  const t = await executar(['hooks', '--tirar'], { env: a.env, repo: REPO });
  assert.equal(t.codigo, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(arq, 'utf8')), original);
});

test('linha de comando hooks: sem settings.json cria; settings ilegivel nao e tocado', async () => {
  const a = ambienteDeTeste();
  const r = await executar(['hooks'], { env: a.env, repo: REPO });
  assert.equal(r.codigo, 0);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(a.claudeDir, 'settings.json'), 'utf8')).hooks).length, 3);
  const b = ambienteDeTeste();
  fs.writeFileSync(path.join(b.claudeDir, 'settings.json'), '{ ruim');
  const r2 = await executar(['hooks'], { env: b.env, repo: REPO });
  assert.equal(r2.codigo, 1);
  assert.equal(fs.readFileSync(path.join(b.claudeDir, 'settings.json'), 'utf8'), '{ ruim');
});

test('linha de comando claude-md: cria, troca o miolo e tira', async () => {
  const a = ambienteDeTeste();
  const arq = path.join(a.claudeDir, 'CLAUDE.md');
  fs.writeFileSync(arq, '# Regras\n');
  assert.equal((await executar(['claude-md'], { env: a.env })).codigo, 0);
  assert.equal((await executar(['claude-md'], { env: a.env })).codigo, 0);
  assert.equal(fs.readFileSync(arq, 'utf8').split(MARCA_INICIO).length, 2);
  assert.equal((await executar(['claude-md', '--tirar'], { env: a.env })).codigo, 0);
  assert.equal(fs.readFileSync(arq, 'utf8'), '# Regras\n');
});

test('linha de comando inicializar: grava o .vbs marcado; --tirar so apaga o nosso', async () => {
  const a = ambienteDeTeste();
  const r = await executar(['inicializar'], { env: a.env, repo: REPO });
  assert.equal(r.codigo, 0);
  const arq = path.join(a.inicio, 'tele-control.vbs');
  const bytes = fs.readFileSync(arq);
  assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xfe], 'UTF-16 com BOM (caminho com acento)');
  assert.equal(ehVbsNosso(bytes), true);
  fs.writeFileSync(arq, "' de outra pessoa\r\n");
  const t = await executar(['inicializar', '--tirar'], { env: a.env, repo: REPO });
  assert.equal(t.codigo, 1);
  assert.ok(fs.existsSync(arq), 'o que nao e nosso fica');
});

test('linha de comando telegram-chave: janela + registro + getMe; a chave nunca sai na saida', async () => {
  const a = ambienteDeTeste();
  let abriu = 0;
  const f = fetchFalso({ getMe: { corpo: { ok: true, result: { id: 123456789, is_bot: true, first_name: 'Meu Bot', username: 'bot_de_teste' } } } });
  const deps = {
    // Uma chave velha no ambiente do processo (nasceu antes da janela gravar a nova) nao passa na frente do registro
    env: { ...a.env, SESSOES_WPP_TELEGRAM_TOKEN: ['987654321', SEGREDO_FALSO].join(':') },
    abrirJanelaChave: async ({ varChave }) => { abriu++; assert.equal(varChave, 'SESSOES_WPP_TELEGRAM_TOKEN'); return { codigo: 0 }; },
    lerRegistro: async () => TOKEN,
    fetch: f,
  };
  fs.writeFileSync(path.join(a.estado, 'config.json'), JSON.stringify({ telegram: { botId: 555, nomeBot: 'Bot Antigo', chatId: 11 } }));
  const r = await executar(['telegram-chave'], deps);
  assert.equal(r.codigo, 0);
  assert.equal(abriu, 1);
  assert.ok(f.chamadas[0].url.includes('/bot123456789:'), 'a chave que vale e a do registro (a nova)');
  assert.deepEqual(r.saida.bot, { id: 123456789, usuario: 'bot_de_teste', nome: 'Meu Bot' });
  assert.ok(!JSON.stringify(r.saida).includes(SEGREDO_FALSO));
  const cfg = JSON.parse(fs.readFileSync(path.join(a.estado, 'config.json'), 'utf8'));
  assert.deepEqual(cfg.telegram, { botId: 123456789, nomeBot: 'Meu Bot', chatId: 11, varChave: 'SESSOES_WPP_TELEGRAM_TOKEN' },
    'chave nova = bot novo no config (com troca); o resto fica');
  assert.ok(!fs.readFileSync(path.join(a.estado, 'config.json'), 'utf8').includes(SEGREDO_FALSO), 'a chave nunca vai pro config');
  const c = await executar(['telegram-chave'], { ...deps, abrirJanelaChave: async () => ({ codigo: 1 }), lerRegistro: async () => null });
  assert.equal(c.codigo, 1);
  assert.equal(c.saida.erro, 'cancelado');
  const s = await executar(['telegram-chave', '--so-conferir'], { ...deps, abrirJanelaChave: async () => { throw new Error('nao devia abrir'); } });
  assert.equal(s.codigo, 0);
});

test('linha de comando pastas: le so o cwd das conversas antigas e sugere as raizes', async () => {
  const a = ambienteDeTeste();
  const projetos = path.join(a.claudeDir, 'projects');
  const conversa = (pasta, nome, cwd, entrypoint) => {
    fs.mkdirSync(path.join(projetos, pasta), { recursive: true });
    const linhas = [{ type: 'summary', summary: 'x' }, { type: 'user', cwd, entrypoint, message: { content: 'segredo nao lido "cwd": "C:\\\\falso"' } }];
    fs.writeFileSync(path.join(projetos, pasta, nome), linhas.map((l) => JSON.stringify(l)).join('\n') + '\n');
  };
  conversa('C--trab-app1', 'a.jsonl', 'c:\\trab\\app1', 'claude-vscode');
  conversa('C--trab-app1', 'b.jsonl', 'c:\\trab\\app1', 'claude-vscode');
  conversa('C--trab-app2', 'c.jsonl', 'C:\\trab\\app2', 'cli');
  conversa('C--rotina', 'e.jsonl', 'C:\\rotina', 'sdk-cli');
  conversa('C--rotina', 'f.jsonl', 'C:\\rotina', 'sdk-cli');
  conversa('C--velho', 'd.jsonl', 'C:\\velho\\coisa');
  const tresMesesAtras = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  fs.utimesSync(path.join(projetos, 'C--velho', 'd.jsonl'), tresMesesAtras, tresMesesAtras);
  fs.writeFileSync(path.join(projetos, 'solto.txt'), 'nao e pasta');
  const vistas = [];
  const existePasta = (p) => { vistas.push(p); return true; };
  const r = await executar(['pastas'], { env: { ...a.env, USERPROFILE: 'C:\\Users\\Fulano' }, existePasta });
  assert.equal(r.codigo, 0);
  assert.deepEqual(r.saida.pastas, [{ pasta: 'C:\\trab', conversas: 3 }]);
  assert.equal(r.saida.conversas, 3, 'a conversa de 90 dias atras e as de rotina (sdk-cli) ficam de fora');
  assert.ok(vistas.includes('C:\\trab'), 'confere se a pasta existe antes de sugerir');
  const sumiu = await executar(['pastas'], { env: { ...a.env, USERPROFILE: 'C:\\Users\\Fulano' }, existePasta: () => false });
  assert.deepEqual(sumiu.saida.pastas, []);
  const vazio = ambienteDeTeste();
  const v = await executar(['pastas'], { env: vazio.env });
  assert.deepEqual(v.saida.pastas, []);
});

test('linha de comando telegram-chat: lista; --confirmar grava o chatId e marca as lidas', async () => {
  const a = ambienteDeTeste();
  const lista = [upd(9, { id: 11, type: 'private', first_name: 'Fulano' }, pessoa(11, 'Fulano'))];
  const f = fetchFalso({ getUpdates: { corpo: { ok: true, result: lista } } });
  const deps = { env: a.env, lerRegistro: async () => TOKEN, fetch: f };
  const r = await executar(['telegram-chat'], deps);
  assert.equal(r.codigo, 0);
  assert.deepEqual(r.saida.chats, [{ id: 11, nome: 'Fulano', usuario: null }]);
  const c = await executar(['telegram-chat', '--confirmar', '11'], deps);
  assert.equal(c.codigo, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(a.estado, 'config.json'), 'utf8')).telegram.chatId, 11);
  assert.equal(f.chamadas.at(-1).corpo.offset, 10);
  const x = await executar(['telegram-chat', '--confirmar', '99'], deps);
  assert.equal(x.codigo, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(a.estado, 'config.json'), 'utf8')).telegram.chatId, 11,
    'chat que nao falou com o bot nao e gravado');
});

test('linha de comando checar: o que falta vira codigo 1 com o que fazer', async () => {
  const r = await executar(['checar'], {
    env: { LOCALAPPDATA: 'C:\\L', SystemRoot: 'C:\\W', USERPROFILE: 'C:\\U', USERNAME: 'Fulano' },
    plataforma: 'win32', release: '10.0.22631', versaoNode: 'v18.0.0', rodar: rodarFalso({}), existe: () => false,
  });
  assert.equal(r.codigo, 1);
  assert.match(r.saida.erro, /falta coisa no PC/);
  assert.equal(r.saida.itens.node.ok, false);
  assert.equal(r.saida.itens.claude.ok, false);
  assert.equal(r.saida.nomeDoWindows, 'Fulano', 'a sugestao de nome sai mesmo com falta');
});

function ambienteDeLigar() {
  const a = ambienteDeTeste();
  const log = path.join(a.base, 'porteiro.log');
  fs.writeFileSync(log, 'linha velha\n');
  return { ...a, log, env: { ...a.env, SESSOES_WPP_LOG: log } };
}

test('linha de comando ligar: para o que estava ligado, sobe pelo .vbs, espera a subida e manda o teste', async () => {
  const a = ambienteDeLigar();
  fs.writeFileSync(path.join(a.estado, 'config.json'), JSON.stringify({ telegram: { ligado: true, chatId: 11 } }));
  fs.writeFileSync(path.join(a.estado, 'desligado'), 'x');
  const ordem = [];
  const f = fetchFalso({ sendMessage: { corpo: { ok: true, result: {} } } });
  const deps = {
    env: a.env, repo: REPO, lerRegistro: async () => TOKEN, fetch: f,
    pararPorteiro: () => { ordem.push('parar'); return 'parado'; },
    rodarVbs: (vbs) => { ordem.push('vbs'); assert.equal(vbs, path.join(REPO, 'sessoes-wpp-porteiro.vbs')); },
    esperarSubida: async (arq, desde) => {
      ordem.push('esperar');
      assert.equal(arq, a.log);
      assert.equal(desde, 'linha velha\n'.length, 'so as linhas novas do log contam');
      return { ok: true };
    },
  };
  const r = await executar(['ligar'], deps);
  assert.equal(r.codigo, 0);
  assert.deepEqual(ordem, ['parar', 'vbs', 'esperar']);
  assert.equal(r.saida.porteiro, 'religado');
  assert.ok(!fs.existsSync(path.join(a.estado, 'desligado')), 'ligar tira o arquivo desligado');
  assert.deepEqual(f.chamadas[0].corpo, { chat_id: 11, text: TEXTO_TESTE });
  assert.ok(!JSON.stringify(r.saida).includes(SEGREDO_FALSO));
  const novo = await executar(['ligar'], { ...deps, pararPorteiro: () => 'nenhum ligado' });
  assert.equal(novo.saida.porteiro, 'ligado');
});

test('linha de comando ligar: sem Telegram ligado, sem chat ou sem chave nem mexe no porteiro; falhas dizem o motivo', async () => {
  const a = ambienteDeLigar();
  const cfg = path.join(a.estado, 'config.json');
  const nada = () => { throw new Error('nao devia mexer no porteiro'); };
  const base = { env: a.env, repo: REPO, lerRegistro: async () => TOKEN, pararPorteiro: nada, rodarVbs: nada, fetch: fetchFalso({}) };
  fs.writeFileSync(cfg, JSON.stringify({ telegram: { chatId: 11 } }));
  assert.match((await executar(['ligar'], base)).saida.erro, /não está ligado/);
  fs.writeFileSync(cfg, JSON.stringify({ telegram: { ligado: true } }));
  assert.match((await executar(['ligar'], base)).saida.erro, /falta a conversa/);
  fs.writeFileSync(cfg, JSON.stringify({ telegram: { ligado: true, chatId: 11 } }));
  assert.match((await executar(['ligar'], { ...base, lerRegistro: async () => null })).saida.erro, /falta a chave/);
  const travado = await executar(['ligar'], { ...base, pararPorteiro: () => 'não consegui parar' });
  assert.equal(travado.codigo, 1);
  assert.match(travado.saida.erro, /não parou/);
  const subir = { ...base, pararPorteiro: () => 'nenhum ligado', rodarVbs: () => {} };
  const naoSubiu = await executar(['ligar'], { ...subir, esperarSubida: async () => ({ ok: false, erro: 'o Tele Control não subiu em 90 s' }) });
  assert.equal(naoSubiu.codigo, 1);
  assert.match(naoSubiu.saida.erro, /não subiu/);
  const semTeste = await executar(['ligar'], {
    ...subir, esperarSubida: async () => ({ ok: true }),
    fetch: fetchFalso({ sendMessage: { status: 403, corpo: { ok: false, description: 'Forbidden: bot was blocked by the user' } } }),
  });
  assert.equal(semTeste.codigo, 1);
  assert.equal(semTeste.saida.porteiro, 'ligado');
  assert.match(semTeste.saida.erro, /mensagem de teste não saiu/);
});

test('esperarSubidaReal: so as linhas novas contam; subida + Telegram = ok; falha conhecida volta na hora; prazo', async () => {
  const base = pastaTemp('instalar-log-');
  const log = path.join(base, 'p.log');
  const velho = 'x porteiro: subiu (pid 1)\nx porteiro: Telegram: ligado (bot Velho)\n';
  fs.writeFileSync(log, velho);
  const desde = Buffer.byteLength(velho);
  const espera = esperarSubidaReal(log, desde, 3000);
  setTimeout(() => fs.appendFileSync(log, 'x porteiro: Telegram: ligado (bot Novo)\nx porteiro: subiu (pid 2)\n'), 300);
  assert.deepEqual(await espera, { ok: true }, 'a ordem das 2 linhas nao importa');
  fs.writeFileSync(log, velho);
  const so = await esperarSubidaReal(log, desde, 400);
  assert.equal(so.ok, false, 'as linhas de antes nao valem');
  assert.match(so.erro, /não subiu/);
  for (const [linha, motivo] of [
    ['Telegram: a chave nao e do bot Meu Bot; fica desligado', /não é do bot/],
    ['Telegram: getMe falhou (Unauthorized); fica desligado', /não aceitou a chave/],
    ['sem canal ligado: WhatsApp desligado no config e Telegram desligado', /nenhum canal/],
  ]) {
    fs.writeFileSync(log, velho + `x porteiro: ${linha}\n`);
    const r = await esperarSubidaReal(log, desde, 5000);
    assert.equal(r.ok, false);
    assert.match(r.erro, motivo);
  }
  const semLog = await esperarSubidaReal(path.join(base, 'nao-existe.log'), 0, 200);
  assert.equal(semLog.ok, false);
});

test('linha de comando cartao: o que ficou ligado, a dica de cada app, como desligar e o credito', async () => {
  const a = ambienteDeTeste();
  const vazio = await executar(['cartao'], { env: a.env });
  assert.equal(vazio.codigo, 0);
  assert.deepEqual(vazio.saida.ligado, []);
  assert.deepEqual(vazio.saida.dicas, []);
  fs.mkdirSync(path.join(a.estado, 'instalacao'), { recursive: true });
  fs.writeFileSync(path.join(a.estado, 'instalacao', 'feito.json'), JSON.stringify({ ligar: {}, hooks: {}, 'claude-md': {}, inicializar: {} }));
  fs.writeFileSync(path.join(a.estado, 'config.json'), JSON.stringify({ apps: ['orca', 'vscode'] }));
  const r = await executar(['cartao'], { env: a.env });
  assert.equal(r.saida.ligado.length, 4);
  assert.equal(r.saida.dicas.length, 2);
  assert.match(r.saida.dicas[0], /^Orca: .*desligue/);
  assert.match(r.saida.comoDesligar.join(' '), /desinstalar/);
  // pausar = o arquivo "desligado" (nao volta sozinho) E o parar do porteiro que roda; voltar = o ligar (que tira o arquivo)
  assert.match(r.saida.comoDesligar[0], /"desligado".*porteiro\.mjs" parar\..*instalar\.mjs ligar/);
  assert.equal(r.saida.credito, CREDITO);
  assert.match(CREDITO, /Eric Luciano.*Expert Integrado/);
});

test('linha de comando desinstalar: desliga, para e desfaz hooks, inicializar e CLAUDE.md; --tudo tira config e chave', async () => {
  const a = ambienteDeTeste();
  const settings = path.join(a.claudeDir, 'settings.json');
  const claudeMd = path.join(a.claudeDir, 'CLAUDE.md');
  const config = path.join(a.estado, 'config.json');
  fs.writeFileSync(settings, JSON.stringify({ model: 'x' }, null, 2));
  fs.writeFileSync(claudeMd, '# Regras\n');
  fs.writeFileSync(config, JSON.stringify({ telegram: { chatId: 11 } }));
  const base = { env: a.env, repo: REPO };
  for (const p of ['hooks', 'inicializar', 'claude-md']) assert.equal((await executar([p], base)).codigo, 0);
  let parou = 0;
  const apagadas = [];
  const deps = { ...base, pararPorteiro: () => { parou++; return 'parado'; }, apagarVariavel: (n) => { apagadas.push(n); return true; } };
  const r = await executar(['desinstalar'], deps);
  assert.equal(r.codigo, 0);
  assert.equal(parou, 1);
  assert.ok(fs.existsSync(path.join(a.estado, 'desligado')), 'o arquivo desligado segura o guardiao e o supervisor');
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), { model: 'x' });
  assert.ok(!fs.existsSync(path.join(a.inicio, 'tele-control.vbs')));
  assert.equal(fs.readFileSync(claudeMd, 'utf8'), '# Regras\n');
  assert.ok(fs.existsSync(config), 'sem --tudo o config fica');
  assert.deepEqual(apagadas, []);
  const t = await executar(['desinstalar', '--tudo'], deps);
  assert.equal(t.codigo, 0);
  assert.ok(!fs.existsSync(config));
  assert.equal(t.saida.config, 'tirado (cópia guardada)');
  assert.deepEqual(apagadas, ['SESSOES_WPP_TELEGRAM_TOKEN']);
  const copias = fs.readdirSync(path.join(a.estado, 'instalacao', 'copias'));
  assert.ok(copias.some((n) => n.endsWith('config.json')), 'a copia do config fica guardada');
});
