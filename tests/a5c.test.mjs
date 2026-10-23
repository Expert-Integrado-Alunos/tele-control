// Testes da A5c (PLANO-ABERTO.md, "A5c — a trava própria e o OK numa máquina nova").
// Por que existe: o OK (pelo WhatsApp ou pelo botão do Telegram) travava os arquivos com uma lib instalada FORA do
// repositório (a trava de arquivo do ambiente do dono); numa máquina sem ela todo verificar caía e o OK não funcionava numa
// instalação nova. Aqui: a trava própria (lib/trava.mjs, mesmo protocolo), as travas de fora pelo config
// (travasDoConfig), o criarOkWpp sem marker e sem ledger, o `libera` gravado no pedido (o "O Sim libera ..." do botão) e
// o JSON do /instalar ligando o OK pelo botão.
// Isolamento: tudo em pasta temporária (tests/lib/pasta-temp.cjs); o processo filho do "máquina nova" roda com a casa
// (USERPROFILE/HOME) numa pasta temporária vazia. Nada de rede.
// Rodar: node --test "tests/a5c.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { comTrava } from '../lib/trava.mjs';
import { travasDoConfig } from '../lib/config.mjs';
import { LIBERA, montarOkTg, conferirToque, dadosOk, lerConfigOk } from '../lib/ok-tg.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const TRAVA = path.join(REPO, 'lib', 'trava.mjs');
const OK_WPP_URL = pathToFileURL(path.join(REPO, 'ok-wpp.mjs')).href;
const OK_TG_URL = pathToFileURL(path.join(REPO, 'lib', 'ok-tg.mjs')).href;
const CHAT = 700100200;
const BOT = 700900800;

const ler = (arq) => fs.readFileSync(arq, 'utf8');
const lock = (arq) => `${arq}.lock`;
const arquivoNovo = (prefixo = 'a5c-trava-') => path.join(pastaTemp(prefixo), 'estado.json');
// pid de um processo que ja terminou (dono morto)
const pidMorto = () => Number(String(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout));
const travaDe = (arq, dono) => {
  fs.mkdirSync(path.dirname(arq), { recursive: true });
  const conteudo = typeof dono === 'string' ? dono : JSON.stringify(dono);
  fs.writeFileSync(lock(arq), conteudo);
  return conteudo;
};
const ocupada = (fnTrava) => {
  try {
    fnTrava();
  } catch (e) {
    return e;
  }
  return null;
};

// ---------- 1. a trava propria (lib/trava.mjs) ----------

// Mac-testes (A): os testes marcados com SO_WINDOWS conferem a premissa do Windows (caminho X:\, .exe, wscript/.vbs,
// cmd.exe, APPDATA/LOCALAPPDATA, pipe \\.\pipe, barra invertida na frase, PowerShell, VS Code/Orca abertos pelo
// porteiro); fora do win32 eles pulam. O caminho do Mac tem os testes proprios em tests/mac-*.test.mjs.
const SO_WINDOWS = process.platform !== 'win32' && 'premissa do Windows (o Mac tem os tests/mac-*)';

test('A5c 1. comTrava pega e solta: <arquivo>.lock criado com {pid, at, token} durante o trecho, devolve o valor do fn e some no fim', () => {
  const arq = arquivoNovo();
  let visto = null;
  const r = comTrava(arq, () => {
    visto = JSON.parse(ler(lock(arq)));
    return 42;
  });
  assert.equal(r, 42);
  assert.deepEqual(Object.keys(visto).sort(), ['at', 'pid', 'token']);
  assert.equal(visto.pid, process.pid);
  assert.ok(Math.abs(Date.now() - visto.at) < 5000, 'at = agora (ms)');
  assert.match(visto.token, new RegExp(`^${process.pid}-[0-9a-f]{16}$`), 'token = <pid>-<8 bytes em hex>');
  assert.equal(fs.existsSync(lock(arq)), false, 'solta no fim');
  // a pasta do arquivo nasce se faltar
  const fundo = path.join(pastaTemp('a5c-trava-'), 'a', 'b', 'c.json');
  assert.equal(comTrava(fundo, () => 'ok'), 'ok');
  assert.equal(fs.existsSync(lock(fundo)), false);
});

test('A5c 2. comTrava: o fn que lanca solta a trava (o erro sobe igual)', () => {
  const arq = arquivoNovo();
  const erro = new Error('quebrou no trecho');
  assert.throws(() => comTrava(arq, () => { throw erro; }), (e) => e === erro);
  assert.equal(fs.existsSync(lock(arq)), false);
  assert.equal(comTrava(arq, () => 'de novo'), 'de novo', 'pega de novo depois');
});

test('A5c 3. comTrava: ocupada por processo vivo e recente = espera esperaMs e lanca TRAVA_OCUPADA, sem rodar o fn e sem mexer na trava do outro', () => {
  const arq = arquivoNovo();
  const alheia = travaDe(arq, { pid: process.pid, at: Date.now(), token: 'outra-conferencia' });
  let rodou = false;
  const t0 = Date.now();
  const e = ocupada(() => comTrava(arq, () => { rodou = true; }, { esperaMs: 200 }));
  const levou = Date.now() - t0;
  assert.ok(e, 'lancou');
  assert.equal(e.code, 'TRAVA_OCUPADA');
  assert.match(e.message, /estado\.json\.lock/);
  assert.equal(rodou, false);
  assert.ok(levou >= 190 && levou < 2500, `esperou o prazo (${levou} ms)`);
  assert.equal(ler(lock(arq)), alheia, 'a trava do outro fica intacta');
});

test('A5c 4. comTrava: espera padrao de 3 s', () => {
  const arq = arquivoNovo();
  travaDe(arq, { pid: process.pid, at: Date.now(), token: 'outra-conferencia' });
  const t0 = Date.now();
  const e = ocupada(() => comTrava(arq, () => {}));
  const levou = Date.now() - t0;
  assert.equal(e?.code, 'TRAVA_OCUPADA');
  assert.ok(levou >= 2900 && levou < 6000, `esperou ~3 s (${levou} ms)`);
});

test('A5c 5. comTrava: dono morto, trava mais velha que velhaMs (padrao 2 min) e ilegivel ha mais de 1 s = abandonada: toma, roda e solta', () => {
  const casos = [
    ['dono morto', (arq) => travaDe(arq, { pid: pidMorto(), at: Date.now(), token: 'morto' }), {}],
    ['velha (121 s, dono vivo, velhaMs padrao)', (arq) => travaDe(arq, { pid: process.pid, at: Date.now() - 121000, token: 'velha' }), {}],
    ['velha pelo velhaMs dado (5 s)', (arq) => travaDe(arq, { pid: process.pid, at: Date.now() - 6000, token: 'velha' }), { velhaMs: 5000 }],
    ['ilegivel antiga (5 s)', (arq) => {
      travaDe(arq, 'lixo{');
      const antes = new Date(Date.now() - 5000);
      fs.utimesSync(lock(arq), antes, antes);
    }, {}],
    ['sem token (JSON sem o campo) antigo', (arq) => {
      travaDe(arq, { pid: process.pid, at: Date.now() });
      const antes = new Date(Date.now() - 5000);
      fs.utimesSync(lock(arq), antes, antes);
    }, {}],
  ];
  for (const [nome, preparar, opcoes] of casos) {
    const arq = arquivoNovo();
    preparar(arq);
    let dentro = null;
    const r = comTrava(arq, () => {
      dentro = JSON.parse(ler(lock(arq)));
      return nome;
    }, { esperaMs: 300, ...opcoes });
    assert.equal(r, nome, nome);
    assert.equal(dentro.pid, process.pid, `${nome}: a trava agora e deste processo`);
    assert.equal(fs.existsSync(lock(arq)), false, `${nome}: solta no fim`);
  }
});

test('A5c 6. comTrava: dono vivo com trava de 119 s (dentro do velhaMs padrao) segue ocupada', () => {
  const arq = arquivoNovo();
  const alheia = travaDe(arq, { pid: process.pid, at: Date.now() - 119000, token: 'quase-velha' });
  const e = ocupada(() => comTrava(arq, () => {}, { esperaMs: 100 }));
  assert.equal(e?.code, 'TRAVA_OCUPADA');
  assert.equal(ler(lock(arq)), alheia);
});

test('A5c 7. comTrava: ilegivel recente espera (quem criou pode estar escrevendo); passado 1 s vira abandonada e e tomada', () => {
  const arq = arquivoNovo();
  travaDe(arq, '');
  const e = ocupada(() => comTrava(arq, () => {}, { esperaMs: 150 }));
  assert.equal(e?.code, 'TRAVA_OCUPADA', 'ilegivel recente = ocupada');
  assert.equal(ler(lock(arq)), '', 'nao apagou');
  const arq2 = arquivoNovo();
  travaDe(arq2, 'meio-escrito');
  const t0 = Date.now();
  assert.equal(comTrava(arq2, () => 'tomada', { esperaMs: 3000 }), 'tomada');
  const levou = Date.now() - t0;
  assert.ok(levou >= 800 && levou < 2900, `esperou ~1 s antes de tomar (${levou} ms)`);
  assert.equal(fs.existsSync(lock(arq2)), false);
});

test('A5c 8. comTrava: solta so a trava com o proprio token (a de outro, posta no lugar durante o trecho, fica)', () => {
  const arq = arquivoNovo();
  let deOutro = null;
  comTrava(arq, () => {
    deOutro = JSON.stringify({ pid: process.pid, at: Date.now(), token: 'de-outro' });
    fs.writeFileSync(lock(arq), deOutro);
  });
  assert.equal(ler(lock(arq)), deOutro, 'a trava de outro token fica');
  fs.unlinkSync(lock(arq));
  // o fn que lanca tambem nao apaga a de outro
  assert.throws(() => comTrava(arq, () => {
    fs.writeFileSync(lock(arq), deOutro);
    throw new Error('x');
  }));
  assert.equal(ler(lock(arq)), deOutro);
});

test('A5c 9. comTrava: process.exit dentro do trecho solta a trava (processo filho)', () => {
  const arq = arquivoNovo('a5c-exit-');
  const visto = `${arq}.visto`;
  const script = [
    "import fs from 'node:fs';",
    `import { comTrava } from ${JSON.stringify(pathToFileURL(TRAVA).href)};`,
    `comTrava(${JSON.stringify(arq)}, () => {`,
    `  fs.writeFileSync(${JSON.stringify(visto)}, fs.readFileSync(${JSON.stringify(lock(arq))}, 'utf8'));`,
    '  process.exit(7);',
    '});',
  ].join('\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 7, r.stderr);
  const dentro = JSON.parse(ler(visto));
  assert.equal(typeof dentro.token, 'string', 'a trava existia dentro do trecho');
  assert.notEqual(dentro.pid, process.pid, 'era do filho');
  assert.equal(fs.existsSync(lock(arq)), false, 'o exit soltou');
  // e o ouvinte do exit sai junto com o trecho (nao acumula no processo)
  const antes = process.listenerCount('exit');
  comTrava(arquivoNovo(), () => assert.equal(process.listenerCount('exit'), antes + 1));
  assert.equal(process.listenerCount('exit'), antes);
});

// ---------- 2. travasDoConfig ----------

test('A5c 10. travasDoConfig: os 3 caminhos aparados, absolutos e normalizados; lib .js ou .cjs, os outros .json; fora disso null (um ruim nao derruba o outro)', { skip: SO_WINDOWS }, () => {
  const nulos = { lib: null, deployMarker: null, disparoLedger: null };
  for (const cfg of [undefined, null, 7, 'x', [], {}, { travas: null }, { travas: [] }, { travas: 'C:\\x.js' }, { travas: {} }]) {
    assert.deepEqual(travasDoConfig(cfg), nulos, JSON.stringify(cfg));
  }
  assert.deepEqual(travasDoConfig({ travas: {
    lib: '  C:/Users/Ana Souza/.claude/hooks/lib/trava.js  ',
    deployMarker: 'D:\\Meus Docs\\trabalho\\Area\\..\\logs\\publicacao-ok.json',
    disparoLedger: 'c:\\logs\\.\\disparo.json',
  } }), {
    lib: 'C:\\Users\\Ana Souza\\.claude\\hooks\\lib\\trava.js',
    deployMarker: 'D:\\Meus Docs\\trabalho\\logs\\publicacao-ok.json',
    disparoLedger: 'c:\\logs\\disparo.json',
  });
  assert.equal(travasDoConfig({ travas: { lib: 'C:\\x\\trava.cjs' } }).lib, 'C:\\x\\trava.cjs');
  // cada campo ruim sozinho; os outros 2 seguem bons
  const bons = { lib: 'C:\\t\\trava.js', deployMarker: 'C:\\t\\pub.json', disparoLedger: 'C:\\t\\disp.json' };
  const ruins = {
    lib: ['C:\\t\\trava.mjs', 'C:\\t\\trava.json', 'C:\\t\\trava', 'C:\\t\\trava.js\\', 'trava.js', '.\\trava.js', '\\\\srv\\t\\trava.js', '/c/t/trava.js', 'C:trava.js', 'C:\\', 42, true, {}],
    deployMarker: ['C:\\t\\pub.js', 'C:\\t\\pub', 'C:\\t\\pub.json\\', 'C:/t/pub.json/', 'pub.json', '\\\\srv\\pub.json', '', '   ', null, ['C:\\t\\pub.json']],
    disparoLedger: ['C:\\t\\disp.cjs', 'C:\\t\\disp.jsonl', 'disp.json', 'C:\\t\\', 5],
  };
  for (const [campo, lista] of Object.entries(ruins)) {
    for (const v of lista) {
      const r = travasDoConfig({ travas: { ...bons, [campo]: v } });
      assert.deepEqual(r, { ...bons, [campo]: null }, `${campo}: ${JSON.stringify(v)}`);
    }
  }
  // caractere ruim (aspas, %, < > | * ? e controle) em qualquer um
  for (const c of ['"', '%', '<', '>', '|', '*', '?', '\u0000', '\u0007', '\u001f', '\u007f', '\n']) {
    for (const campo of Object.keys(bons)) {
      const ext = campo === 'lib' ? '.js' : '.json';
      const r = travasDoConfig({ travas: { ...bons, [campo]: `C:\\t\\a${c}b${ext}` } });
      assert.equal(r[campo], null, `${campo} com ${JSON.stringify(c)}`);
    }
  }
});

// ---------- 3. o criarOkWpp: a trava, o marker e o ledger ----------

// Um pedido pelo Telegram (WhatsApp desligado) e o toque no Sim, ponta a ponta no criarOkWpp. Autocontido (so imports
// dinamicos e dados no argumento) pra rodar tambem num processo filho pelo toString (o "maquina nova").
async function cenario({
  okWpp, okTg, raiz, tipo = 'publicacao', acao = 'subir o Site Novo em produção', completo = false, opcoes = {},
  travaAlheia = false, esperaTravaMs = 3000,
}) {
  const fs = (await import('node:fs')).default;
  const path = (await import('node:path')).default;
  const { criarOkWpp } = await import(okWpp);
  const { montarOkTg, dadosOk } = await import(okTg);
  const T = Date.parse('2026-10-17T15:00:00.000Z');
  const SID = '0a1b2c3d-1111-4222-8333-444455556666';
  const CHAT = 700100200;
  const BOT = 700900800;
  const env = {
    SESSOES_WPP_DIR: path.join(raiz, 'estado'),
    CLAUDE_SESSIONS_DIR: path.join(raiz, 'sessions'),
    CLAUDE_PROJECTS_DIR: path.join(raiz, 'projects'),
    SESSOES_WPP_LOG: path.join(raiz, 'ok-wpp.log'),
    CLAUDE_CODE_SESSION_ID: SID,
  };
  const pastaProj = path.join(env.CLAUDE_PROJECTS_DIR, 'c--projetos');
  for (const d of [env.SESSOES_WPP_DIR, env.CLAUDE_SESSIONS_DIR, pastaProj]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(env.SESSOES_WPP_DIR, 'estado.json'), JSON.stringify({ v: 1, trava: false, tg: { offset: 10 } }));
  fs.writeFileSync(path.join(env.CLAUDE_SESSIONS_DIR, '4242.json'), JSON.stringify({
    pid: 4242, sessionId: SID, cwd: 'C:\\projetos', name: 'projetos-42', nameSource: 'derived', entrypoint: 'claude-vscode', status: 'idle', updatedAt: T,
  }));
  fs.writeFileSync(path.join(pastaProj, `${SID}.jsonl`), `${JSON.stringify({ type: 'custom-title', customTitle: 'Faro', sessionId: SID })}\n`);
  let lista = [];
  const ok = criarOkWpp({
    wpp: null, env, agora: () => T, esperaTravaMs, porteiroVivo: () => true,
    tgOk: { espiar: async () => lista, botId: BOT, chatDono: CHAT }, ...opcoes,
  });
  const pedir = await ok.pedir({ tipo, acao });
  if (pedir.status !== 'pedido') return { pedir };
  const arq = path.join(env.SESSOES_WPP_DIR, 'oks', `${pedir.codigo}.json`);
  const pedido = JSON.parse(fs.readFileSync(arq, 'utf8'));
  const m = montarOkTg({ ...pedido, completo });
  lista = [{
    update_id: 11,
    callback_query: {
      id: 'q-1',
      from: { id: CHAT, is_bot: false, first_name: 'Davi' },
      message: {
        message_id: 77,
        from: { id: BOT, is_bot: true, first_name: 'Bot de Teste' },
        chat: { id: CHAT, type: 'private', first_name: 'Davi' },
        date: Math.floor(Date.parse(pedido.criadoEm) / 1000) + 2,
        text: m.texto,
        reply_markup: { inline_keyboard: m.botoes.map((l) => l.map((b) => ({ text: b.texto, callback_data: b.dados }))) },
      },
      data: dadosOk(pedido.codigo, 'sim'),
    },
  }];
  if (travaAlheia) fs.writeFileSync(`${arq}.lock`, JSON.stringify({ pid: process.pid, at: Date.now(), token: 'outra-conferencia' }));
  const verificar = await ok.verificar(pedir.codigo);
  const depois = JSON.parse(fs.readFileSync(arq, 'utf8'));
  return { pedir, pedido, texto: m.texto, verificar, status: depois.status, arquivo: arq, sid: SID, raiz: fs.readdirSync(raiz).sort() };
}

const rodar = (o) => cenario({ okWpp: OK_WPP_URL, okTg: OK_TG_URL, raiz: pastaTemp('a5c-ok-'), ...o });
// comTrava espiao: anota o arquivo e trava de verdade (a propria)
const espiao = () => {
  const chamadas = [];
  const fn = (arquivo, trecho, o) => {
    chamadas.push(arquivo);
    return comTrava(arquivo, trecho, o);
  };
  return { chamadas, fn };
};

test('A5c 11. criarOkWpp sem markerPath nem disparoPath (o padrao): a publicacao e o disparo aprovados = ok, so o pedido e travado e nada mais e gravado', async () => {
  for (const tipo of ['publicacao', 'disparo', 'crm']) {
    const e = espiao();
    const r = await rodar({ tipo, opcoes: { comTrava: e.fn } });
    assert.equal(r.verificar.status, 'ok', `${tipo}: ${JSON.stringify(r.verificar)}`);
    assert.equal(r.verificar.canal, 'telegram');
    assert.equal(r.status, 'usado', tipo);
    assert.deepEqual(e.chamadas, [r.arquivo], `${tipo}: a trava so no consumo do pedido (sem marker nem ledger)`);
    assert.deepEqual(r.raiz, ['estado', 'ok-wpp.log', 'projects', 'sessions'], `${tipo}: nenhum arquivo de marker ou ledger`);
  }
});

test('A5c 12. criarOkWpp com markerPath e disparoPath: a trava injetada trava o pedido e depois o marker (publicacao) ou o ledger (disparo), como antes', async () => {
  const pasta = pastaTemp('a5c-travas-');
  const markerPath = path.join(pasta, 'logs', 'publicacao-ok.json');
  const disparoPath = path.join(pasta, 'logs', 'disparo-estado.json');
  const e1 = espiao();
  const pub = await rodar({ tipo: 'publicacao', opcoes: { comTrava: e1.fn, markerPath, disparoPath } });
  assert.equal(pub.verificar.status, 'ok');
  assert.deepEqual(e1.chamadas, [pub.arquivo, markerPath]);
  const marker = JSON.parse(ler(markerPath))[pub.sid];
  assert.equal(marker.k, 'telegram');
  assert.equal(marker.usos, 0);
  assert.equal(fs.existsSync(disparoPath), false);
  const e2 = espiao();
  const disp = await rodar({ tipo: 'disparo', acao: 'mandar o convite da Campanha Verão', opcoes: { comTrava: e2.fn, markerPath, disparoPath } });
  assert.equal(disp.verificar.status, 'ok');
  assert.deepEqual(e2.chamadas, [disp.arquivo, disparoPath]);
  const ledger = JSON.parse(ler(disparoPath))[disp.sid];
  assert.equal(ledger.ok.k, 'telegram');
  assert.deepEqual(ledger.envios, []);
  // a trava que lanca (a lib de fora que nao existe) = o OK falha fechado: o pedido segue pendente
  const quebrada = (arquivo) => { throw Object.assign(new Error(`Cannot find module ${arquivo}`), { code: 'MODULE_NOT_FOUND' }); };
  const r = await rodar({ tipo: 'crm', opcoes: { comTrava: quebrada } });
  assert.equal(r.verificar.status, 'invalido');
  assert.equal(r.status, 'pendente');
});

test('A5c 13. criarOkWpp sem comTrava = a trava propria (lib/trava.mjs): pedido travado por outra conferencia viva = invalido e segue pendente', async () => {
  const r = await rodar({ tipo: 'crm', travaAlheia: true, esperaTravaMs: 120 });
  assert.deepEqual(r.verificar, { status: 'invalido', motivo: 'pedido ocupado por outra conferencia (rodar o verificar de novo)' });
  assert.equal(r.status, 'pendente');
});

test('A5c 14. maquina nova (processo filho, casa vazia, sem lib de trava instalada): o OK pelo botao funciona e nada e gravado na casa', () => {
  const home = pastaTemp('a5c-casa-');
  const raiz = pastaTemp('a5c-nova-');
  const env = { ...process.env, USERPROFILE: home, HOME: home };
  delete env.SESSOES_WPP_TRAVA_LIB;
  delete env.SESSOES_WPP_DEPLOY_MARKER;
  delete env.SESSOES_WPP_DISPARO_LEDGER;
  const saidas = [];
  for (const tipo of ['publicacao', 'disparo']) {
    const args = { okWpp: OK_WPP_URL, okTg: OK_TG_URL, raiz: path.join(raiz, tipo), tipo };
    fs.mkdirSync(args.raiz);
    const script = `const cenario = ${cenario.toString()};\n`
      + `cenario(${JSON.stringify(args)}).then((r) => process.stdout.write(JSON.stringify(r)), (e) => process.stdout.write(JSON.stringify({ erro: String(e && e.stack || e) })));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    saidas.push(JSON.parse(r.stdout));
  }
  for (const s of saidas) {
    assert.equal(s.verificar?.status, 'ok', JSON.stringify(s));
    assert.equal(s.status, 'usado');
  }
  assert.deepEqual(fs.readdirSync(home), [], 'nada na casa (nem marker nem ledger de padrao)');
});

// ---------- 4. o main pelo fonte ----------

test('A5c 15. ok-wpp.mjs pelo fonte: sem a lib de fora fixa; o criarOkWpp com a trava propria, null e null; o main pelas travas do config (lib so na hora), as variaveis de teste por cima', () => {
  const f = ler(path.join(REPO, 'ok-wpp.mjs'));
  // o nome da lib de fora montado aqui (o termo inteiro nao pode estar na copia aberta)
  for (const fora of ['TRAVA_LIB', 'SESSOES_WPP_TRAVA_LIB', ['trava', 'arquivo'].join('-'), "'hooks', 'lib'"]) assert.ok(!f.includes(fora), `sem ${fora}`);
  assert.match(f, /^import \{ comTrava as travaPropria \} from '\.\/lib\/trava\.mjs';$/m);
  assert.match(f, /^import \{[^}]*\btravasDoConfig\b[^}]*\} from '\.\/lib\/config\.mjs';$/m);
  const ini = f.indexOf('export function criarOkWpp({');
  const cab = f.slice(ini, f.indexOf('} = {}) {', ini));
  assert.match(cab, /^ {2}comTrava = travaPropria,$/m);
  assert.match(cab, /^ {2}markerPath = null,$/m);
  assert.match(cab, /^ {2}disparoPath = null,$/m);
  assert.ok(!/homedir/.test(cab), 'nenhum caminho padrao na casa');
  const main = f.slice(f.indexOf('\nasync function main('), f.indexOf('\nfunction invalidoUso('));
  const linhas = [
    'const travas = travasDoConfig(cfg);',
    'if (travas.lib) opts.comTrava = (...a) => require(travas.lib).comTrava(...a);',
    'opts.markerPath = process.env.SESSOES_WPP_DEPLOY_MARKER || travas.deployMarker;',
    'opts.disparoPath = process.env.SESSOES_WPP_DISPARO_LEDGER || travas.disparoLedger;',
  ];
  let antes = main.indexOf('const cfg = lerConfig(estadoDir);');
  assert.ok(antes > 0);
  for (const l of linhas) {
    const em = main.indexOf(l);
    assert.ok(em > antes, `na ordem: ${l}`);
    antes = em;
  }
  assert.ok(antes < main.indexOf('const ok = criarOkWpp(opts);'), 'antes do criarOkWpp');
  assert.equal((f.match(/require\(travas\.lib\)/g) || []).length, 1, 'a lib de fora so e carregada na hora de travar');
});

// ---------- 5. o libera do pedido ----------

test('A5c 16. LIBERA ganha o disparoSemJanela; o pedir grava o libera (disparo com ledger = a janela de 2 h; sem = sem janela; publicacao; o resto)', async () => {
  assert.equal(LIBERA.disparoSemJanela, 'o resto do disparo (depois do piloto)');
  assert.equal(LIBERA.disparo, 'o resto do disparo (depois do piloto) por até 2 horas');
  assert.ok(Object.isFrozen(LIBERA));
  const disparoPath = path.join(pastaTemp('a5c-ledger-'), 'disparo.json');
  const markerPath = path.join(pastaTemp('a5c-marker-'), 'publicacao.json');
  const casos = [
    ['disparo', { disparoPath }, LIBERA.disparo],
    ['disparo', {}, LIBERA.disparoSemJanela],
    ['publicacao', { markerPath }, LIBERA.publicacao],
    ['publicacao', {}, LIBERA.publicacao],
    ['crm', { disparoPath, markerPath }, LIBERA.demais],
    ['mensagem', {}, LIBERA.demais],
    ['pagamento', {}, LIBERA.demais],
    ['apagar', {}, LIBERA.demais],
    ['outro', {}, LIBERA.demais],
  ];
  for (const [tipo, opcoes, libera] of casos) {
    const r = await rodar({ tipo, opcoes });
    assert.equal(r.pedido.libera, libera, `${tipo} ${JSON.stringify(Object.keys(opcoes))}`);
  }
});

test('A5c 17. montarOkTg: usa o libera do pedido quando e um dos textos do LIBERA; sem o campo (pedido antigo) ou com outro texto = pelo tipo; o compacto nao muda', () => {
  const p = {
    codigo: 'ABC234', titulo: 'Faro', tipo: 'disparo', acao: 'mandar o convite', destinatarios: null,
    criadoEm: '2026-10-17T15:00:00.700Z', expiraEm: '2026-10-17T15:30:00.700Z',
  };
  const linhaLibera = (x) => montarOkTg({ ...x, completo: true }).texto.split('\n').find((l) => l.startsWith('O Sim libera '));
  assert.equal(linhaLibera(p), `O Sim libera ${LIBERA.disparo}; o Não cancela o pedido.`, 'sem o campo = pelo tipo');
  assert.equal(linhaLibera({ ...p, libera: LIBERA.disparoSemJanela }), 'O Sim libera o resto do disparo (depois do piloto); o Não cancela o pedido.');
  assert.equal(linhaLibera({ ...p, libera: LIBERA.demais }), `O Sim libera ${LIBERA.demais}; o Não cancela o pedido.`, 'qualquer texto do LIBERA');
  for (const outro of ['tudo, pra sempre', '', null, 42, { a: 1 }, 'o resto do disparo (depois do piloto) ']) {
    assert.equal(linhaLibera({ ...p, libera: outro }), `O Sim libera ${LIBERA.disparo}; o Não cancela o pedido.`, JSON.stringify(outro));
  }
  assert.equal(linhaLibera({ ...p, tipo: 'publicacao', libera: 'tudo' }), `O Sim libera ${LIBERA.publicacao}; o Não cancela o pedido.`);
  assert.deepEqual(montarOkTg({ ...p, libera: LIBERA.disparoSemJanela }), montarOkTg(p), 'o compacto nao muda');
});

test('A5c 18. o toque no Sim da versao completa confere com o libera do pedido (e nao com o do tipo); o verificar aprova o disparo sem ledger pelo completo', async () => {
  const r = await rodar({ tipo: 'disparo', acao: 'mandar o convite da Campanha Verão', completo: true });
  assert.equal(r.pedido.libera, LIBERA.disparoSemJanela);
  assert.ok(r.texto.includes(`O Sim libera ${LIBERA.disparoSemJanela}; o Não cancela o pedido.`), r.texto);
  assert.equal(r.verificar.status, 'ok', JSON.stringify(r.verificar));
  // o mesmo toque com o texto montado sem o libera do pedido (o de hoje pelo tipo) nao confere
  const semCampo = { ...r.pedido };
  delete semCampo.libera;
  const m = montarOkTg({ ...semCampo, completo: true });
  const update = {
    update_id: 12,
    callback_query: {
      id: 'q-2',
      from: { id: CHAT, is_bot: false },
      message: {
        message_id: 78, from: { id: BOT, is_bot: true }, chat: { id: CHAT, type: 'private' },
        date: Math.floor(Date.parse(r.pedido.criadoEm) / 1000) + 2, text: m.texto,
        reply_markup: { inline_keyboard: m.botoes.map((l) => l.map((b) => ({ text: b.texto, callback_data: b.dados }))) },
      },
      data: dadosOk(r.pedido.codigo, 'sim'),
    },
  };
  assert.deepEqual(conferirToque(update, { pedido: r.pedido, botId: BOT, chatDono: CHAT }), { valido: false, motivo: 'texto da mensagem nao confere com o pedido' });
  const v = conferirToque(update, { pedido: semCampo, botId: BOT, chatDono: CHAT });
  assert.equal(v.valido, true, 'o pedido antigo (sem o campo) confere pelo tipo');
  assert.equal(v.completo, true);
});

// ---------- 6. a skill /instalar ----------

test('A5c 19. /instalar: o JSON do passo 6 grava telegram.ok.ligado true (e o lerConfigOk liga o OK pelo botao com ele)', () => {
  const texto = ler(path.join(REPO, '.claude', 'skills', 'instalar', 'SKILL.md'));
  const exemplo = /`(\{"apps":.*\})`/.exec(texto);
  assert.ok(exemplo, 'tem o exemplo do config');
  const cfg = JSON.parse(exemplo[1]);
  assert.equal(cfg.telegram.ligado, true);
  assert.deepEqual(cfg.telegram.ok, { ligado: true });
  const pasta = pastaTemp('a5c-skill-');
  fs.writeFileSync(path.join(pasta, 'config.json'), exemplo[1]);
  assert.deepEqual(lerConfigOk(pasta), { ligado: true });
});
