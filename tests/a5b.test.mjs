// Testes da A5b (PLANO-ABERTO.md, "A5b — a transcrição"): o bloco `transcricao` do config.json (ligada, python, idioma
// e os 2 modelos do faster-whisper), os argumentos que o porteiro passa ao bin/transcrever.py, o rodar (o transcritor so
// com `ligada`, 1 linha no log), o audio sem transcritor (a linha nova) e o transcrever.py com argumento ruim.
// Por que existe: a transcricao estava sempre ligada, com o python, a lingua e os modelos chumbados (e um palpite de
// caminho de uma maquina so); a copia aberta serve a quem nao tem Python, fala outra lingua ou tem outra placa. Valor
// trocado aqui = audio que some sem aviso, python errado ou modelo que nao existe na maquina da pessoa.
// Isolamento: pastas temporarias (prefixo "a5b-"); execFile, Telegram e transcritor dublados; o transcrever.py roda so
// com o `python` do PATH (sem ele o teste pula) e com um faster_whisper FALSO na frente (PYTHONPATH): nunca o modelo,
// nunca rede. Ids do Telegram sinteticos. Nada de config.json real nem porteiro rodando: o rodar e conferido pelo fonte.
// Os modulos entram por `import * as`: funcao que ainda nao existe deixa so o teste dela vermelho.
// Rodar: node --test --test-reporter=tap "tests/a5b.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pastaTemp } from './lib/pasta-temp.cjs';
import * as config from '../lib/config.mjs';
import * as porteiro from '../porteiro.mjs';
import { horaBRT } from '../lib/formato.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');
const SCRIPT = path.join(REPO, 'bin', 'transcrever.py');
const T0 = Date.parse('2026-10-15T15:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const CHAT = 700100200; // chat do dono (sintetico)
const BOT = 700900800; // o bot (sintetico)
const PADRAO = { ligada: false, python: 'python', idioma: 'pt', modeloGpu: 'large-v3-turbo', modeloCpu: 'medium' };
// As frases, por extenso de proposito (o teste prende o texto)
const SEM_TRANSCRICAO = (h) => `Recebi o áudio das ${h}, mas a transcrição está desligada neste PC. Escreve a mensagem.`;
const NAO_ENTENDI = (h) => `Não entendi o áudio das ${h}. Manda de novo ou escreve.`;

// ---------- 1. transcricaoDoConfig ----------

test('A5b 1. transcricaoDoConfig: sem o bloco (ou bloco/cfg/opcoes que nao sao objeto) = o padrao desligado com o python do PATH; ligada so com true; os bons aparados (idioma em minuscula); cada ruim cai so no proprio padrao', () => {
  const f = config.transcricaoDoConfig;
  assert.equal(typeof f, 'function');
  for (const cfg of [undefined, null, {}, [], 'x', 7, { transcricao: null }, { transcricao: [] }, { transcricao: 'sim' }]) {
    assert.deepEqual(f(cfg, { env: {} }), PADRAO, JSON.stringify(cfg));
  }
  assert.deepEqual(f({}), PADRAO, 'sem opcoes');
  assert.deepEqual(f({}, null), PADRAO, 'opcoes null');
  assert.deepEqual(f({}, { env: 'x' }), PADRAO, 'env que nao e objeto');
  // ligada: so o true booleano
  assert.equal(f({ transcricao: { ligada: true } }, { env: {} }).ligada, true);
  for (const v of [false, 'true', 1, 'sim', {}, null]) assert.equal(f({ transcricao: { ligada: v } }, { env: {} }).ligada, false, String(v));
  // tudo bom de uma vez
  assert.deepEqual(
    f({ transcricao: { ligada: true, python: ' D:\\Ferramentas\\Py313\\PYTHON.EXE ', idioma: ' EN ', modeloGpu: ' Systran/faster-whisper-large-v3 ', modeloCpu: 'tiny.en' } }, { env: {} }),
    { ligada: true, python: 'D:\\Ferramentas\\Py313\\PYTHON.EXE', idioma: 'en', modeloGpu: 'Systran/faster-whisper-large-v3', modeloCpu: 'tiny.en' },
  );
  // idioma: 2 ou 3 letras
  for (const [v, esperado] of [['es', 'es'], ['yue', 'yue'], [' Pt ', 'pt'], ['pt-BR', 'pt'], ['p', 'pt'], ['port', 'pt'], ['', 'pt'], ['p1', 'pt'],
    ['é', 'pt'], [5, 'pt'], [null, 'pt']]) {
    const r = f({ transcricao: { ligada: true, idioma: v } }, { env: {} });
    assert.deepEqual(r, { ...PADRAO, ligada: true, idioma: esperado }, `idioma ${JSON.stringify(v)}`);
  }
  // modelos: letra ou numero no comeco, depois letra, numero, . _ / -, ate 100, sem ".."
  const cem = `m${'x'.repeat(99)}`;
  for (const [v, ok] of [['small', true], ['large-v3', true], ['org/modelo_v2.1', true], ['9b', true], [cem, true], [`${cem}x`, false],
    ['../modelo', false], ['a..b', false], ['org/../x', false], ['-x', false], ['.oculto', false], ['/abs', false], ['_x', false],
    ['a b', false], ['C:\\m', false], ['a\\b', false], ['a;b', false], ['a"b', false], ['a%b', false], ['', false], ['  ', false], [3, false],
    ['a\nb', false]]) {
    const rGpu = f({ transcricao: { modeloGpu: v } }, { env: {} });
    const rCpu = f({ transcricao: { modeloCpu: v } }, { env: {} });
    assert.deepEqual(rGpu, { ...PADRAO, modeloGpu: ok ? v : 'large-v3-turbo' }, `modeloGpu ${JSON.stringify(v)}`);
    assert.deepEqual(rCpu, { ...PADRAO, modeloCpu: ok ? v : 'medium' }, `modeloCpu ${JSON.stringify(v)}`);
  }
  assert.equal(f({ transcricao: { modeloCpu: ' small ' } }, { env: {} }).modeloCpu, 'small', 'aparado');
});

test('A5b 2. transcricaoDoConfig python: o do config absoluto X:\\...\\*.exe sem aspas/%/;/controle (aparado); senao o SESSOES_WPP_PYTHON aparado; senao "python"; nunca o palpite de pasta do LOCALAPPDATA', () => {
  const f = config.transcricaoDoConfig;
  const py = (python, env = {}) => f({ transcricao: { python } }, { env }).python;
  assert.equal(py('C:\\Py\\python.exe'), 'C:\\Py\\python.exe');
  assert.equal(py('  e:\\x y\\Python.Exe\t'), 'e:\\x y\\Python.Exe', 'aparado, .exe sem caso, espaco no meio vale');
  for (const ruim of ['python.exe', 'python', 'Py\\python.exe', 'C:/Py/python.exe', '\\\\servidor\\py\\python.exe', 'C:\\Py\\python',
    'C:\\Py\\python.exe.txt', '"C:\\Py\\python.exe"', 'C:\\Py\\"python.exe', 'C:\\%PY%\\python.exe', 'C:\\Py;D:\\python.exe',
    'C:\\Py\\py\nthon.exe', 'C:\\Py\\py\u0007thon.exe', 'C:\\Py\\py\u007fthon.exe', '', '   ', 5, true, null, {}]) {
    assert.equal(py(ruim), 'python', `ruim ${JSON.stringify(ruim)}`);
    assert.equal(py(ruim, { SESSOES_WPP_PYTHON: ' D:\\Outro\\python.exe ' }), 'D:\\Outro\\python.exe', `ruim ${JSON.stringify(ruim)} + env`);
  }
  // o do config ganha do ambiente
  assert.equal(py('C:\\Py\\python.exe', { SESSOES_WPP_PYTHON: 'D:\\Outro\\python.exe' }), 'C:\\Py\\python.exe');
  // o do ambiente so aparado (vazio ou nao-texto = o do PATH)
  assert.equal(f({}, { env: { SESSOES_WPP_PYTHON: '  py3  ' } }).python, 'py3');
  for (const v of ['', '   ', undefined]) assert.equal(f({}, { env: { SESSOES_WPP_PYTHON: v } }).python, 'python', JSON.stringify(v));
  assert.equal(f({}, { env: { SESSOES_WPP_PYTHON: 7 } }).python, 'python');
  // sem palpite de pasta: LOCALAPPDATA nao muda nada (nem olha o disco)
  assert.equal(f({}, { env: { LOCALAPPDATA: REPO } }).python, 'python');
  assert.equal(f({ transcricao: { ligada: true } }).python, 'python', 'sem env nas opcoes = so o padrao');
});

// ---------- 2. transcreverReal ----------

test('A5b 3. transcreverReal (execFile dublado, nunca o python): roda transcrever.py <arquivo> <idioma> <modeloGpu> <modeloCpu> com o python dado; o que faltar sai do transcricaoDoConfig({}, {env}); o pythonDoPorteiro saiu', async () => {
  const chamadas = [];
  const exec = (bin, args, opts, cb) => {
    chamadas.push({ bin, args, opts });
    setImmediate(() => cb(null, `${JSON.stringify({ ok: true, texto: 'oi' })}\n`, ''));
  };
  let r = await porteiro.transcreverReal('C:\\a\\b.oga', { env: { A: '1' }, exec, python: 'D:\\Py\\python.exe', idioma: 'en', modeloGpu: 'small', modeloCpu: 'tiny' });
  assert.deepEqual(r, { ok: true, texto: 'oi' });
  assert.equal(chamadas[0].bin, 'D:\\Py\\python.exe');
  assert.deepEqual(chamadas[0].args, [SCRIPT, 'C:\\a\\b.oga', 'en', 'small', 'tiny']);
  assert.ok(fs.existsSync(chamadas[0].args[0]));
  assert.deepEqual([chamadas[0].opts.timeout, chamadas[0].opts.windowsHide, chamadas[0].opts.env.A, chamadas[0].opts.env.HF_HUB_OFFLINE], [180000, true, '1', '1']);
  // nada dado: o padrao do ambiente
  r = await porteiro.transcreverReal('x.oga', { env: { SESSOES_WPP_PYTHON: ' E:\\P\\python.exe ' }, exec });
  assert.equal(chamadas[1].bin, 'E:\\P\\python.exe');
  assert.deepEqual(chamadas[1].args, [SCRIPT, 'x.oga', 'pt', 'large-v3-turbo', 'medium']);
  r = await porteiro.transcreverReal('x.oga', { env: { LOCALAPPDATA: REPO }, exec });
  assert.equal(chamadas[2].bin, 'python', 'sem SESSOES_WPP_PYTHON = o do PATH (sem palpite de pasta)');
  // so parte dada: o resto do padrao
  r = await porteiro.transcreverReal('y.oga', { env: {}, exec, idioma: 'es' });
  assert.deepEqual([chamadas[3].bin, ...chamadas[3].args.slice(1)], ['python', 'y.oga', 'es', 'large-v3-turbo', 'medium']);
  r = await porteiro.transcreverReal('y.oga', { env: {}, exec, modeloCpu: 'base' });
  assert.deepEqual(chamadas[4].args.slice(2), ['pt', 'large-v3-turbo', 'base']);
  assert.equal(chamadas.length, 5);
  assert.equal(porteiro.pythonDoPorteiro, undefined, 'o pythonDoPorteiro saiu');
});

// ---------- 3. o rodar pelo fonte ----------

test('A5b 4. pelo fonte: o rodar tira a transcricao do mesmo cfg, passa o transcrever so com ligada (os 4 valores dela) e loga "transcricao: ligada|desligada" antes do subiu; sem o palpite do Python312', () => {
  const fonte = fs.readFileSync(path.join(REPO, 'porteiro.mjs'), 'utf8').replace(/\r\n/g, '\n'); // checkout com CRLF
  const ini = fonte.indexOf('async function rodar(');
  const depois = fonte.slice(ini + 1).search(/\n(?:async )?function /);
  const r = depois === -1 ? fonte.slice(ini) : fonte.slice(ini, ini + 1 + depois);
  assert.ok(ini > 0 && r.includes('log(`subiu (pid'), 'o corpo do rodar');
  const cfgEm = r.indexOf('const cfg = lerConfig(C.estadoDir);');
  const trEm = r.indexOf('const transcricao = transcricaoDoConfig(cfg, { env });');
  assert.ok(cfgEm > 0 && trEm > cfgEm, 'a transcricao do mesmo cfg');
  assert.equal(r.match(/\btranscricaoDoConfig\(/g)?.length, 1);
  const passa = 'transcrever: transcricao.ligada\n      ? (arquivo) => transcreverReal(arquivo, { env, python: transcricao.python, idioma: transcricao.idioma, modeloGpu: transcricao.modeloGpu, modeloCpu: transcricao.modeloCpu })\n      : null,';
  const passaEm = r.indexOf(passa);
  const pEm = r.indexOf('const p = criarPorteiro({');
  assert.ok(pEm > trEm && passaEm > pEm && passaEm < r.indexOf('\n  });', pEm), 'o transcrever so com ligada, dentro do criarPorteiro');
  assert.equal(r.match(/\btranscreverReal\(/g)?.length, 1, 'nenhum outro transcreverReal no rodar');
  const logEm = r.indexOf("log(`transcricao: ${transcricao.ligada ? 'ligada' : 'desligada'}`);");
  assert.ok(logEm > passaEm && logEm < r.indexOf('log(`subiu (pid'), 'a linha do log antes do subiu');
  assert.ok(!/pythonDoPorteiro|Python312/.test(fonte), 'sem o pythonDoPorteiro e sem o palpite do Python312');
  assert.match(fonte, /import \{[^}]*\btranscricaoDoConfig\b[^}]*\} from '\.\/lib\/config\.mjs';/);
});

// ---------- 4. o audio sem transcritor ----------

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
  tg.enviarVoz = async (pedido) => { gravar('enviarVoz', [pedido]); return { ok: false, erro: 'duble', codigo: 400 }; };
  tg.editar = async (messageId, pedido) => { gravar('editar', [messageId, pedido]); return { ok: true }; };
  tg.editarBotoes = async (messageId, botoes) => { gravar('editarBotoes', [messageId, botoes]); return { ok: true }; };
  tg.apagar = async (messageId) => { gravar('apagar', [messageId]); return { ok: true }; };
  tg.responderToque = async (id, texto) => { gravar('responderToque', [id, texto]); return { ok: true }; };
  // o audio baixado = um arquivo falso no destino pedido + .oga (nenhuma rede)
  tg.baixar = async (fileId, destino) => {
    gravar('baixar', [fileId, destino]);
    const caminho = `${destino}.oga`;
    fs.mkdirSync(path.dirname(caminho), { recursive: true });
    fs.writeFileSync(caminho, `falso ${fileId}`);
    return { ok: true, caminho, bytes: 6 };
  };
  tg.quemSou = async () => { gravar('quemSou', []); return { ok: true, id: BOT, username: 'Teste_ControleBot' }; };
  tg.definirComandos = async (c) => { gravar('definirComandos', [c]); return { ok: true }; };
  return tg;
}

// wpp null (so o Telegram); `transcrever` = o que o rodar passaria (null = desligada)
function montar({ transcrever = null } = {}) {
  const raiz = pastaTemp('a5b-porteiro-');
  const env = {
    SESSOES_WPP_DIR: path.join(raiz, 'estado'),
    CLAUDE_SESSIONS_DIR: path.join(raiz, 'sessions'),
    CLAUDE_PROJECTS_DIR: path.join(raiz, 'projects'),
    SESSOES_WPP_LOG: path.join(raiz, 'porteiro.log'),
  };
  for (const d of [env.SESSOES_WPP_DIR, env.CLAUDE_SESSIONS_DIR, env.CLAUDE_PROJECTS_DIR]) fs.mkdirSync(d, { recursive: true });
  const h = { raiz, env, t: T0, nUpd: 100, nMid: 7000 };
  h.tg = dubleTg(h);
  h.cru = porteiro.criarPorteiro({
    wpp: null,
    mensageiro: { async entregar() { return { status: 'enviado', detalhe: '' }; } },
    ocioso: async () => 0,
    agora: () => h.t,
    env,
    ensaio: false,
    abrirCentral: () => {},
    avisarTelegram: async () => true,
    dormir: async (ms) => { h.t += ms; },
    tg: h.tg,
    identTg: { chatId: CHAT, botId: BOT },
    transcrever,
  });
  h.t += 1000;
  return h;
}
const estado = (h) => JSON.parse(fs.readFileSync(path.join(h.env.SESSOES_WPP_DIR, 'estado.json'), 'utf8'));
function ligarTg(h) { // o historico ja foi pulado (a 1a leitura da vida tem teste proprio)
  const arq = path.join(h.env.SESSOES_WPP_DIR, 'estado.json');
  const e = JSON.parse(fs.readFileSync(arq, 'utf8'));
  e.tg.offset = 0;
  fs.writeFileSync(arq, JSON.stringify(e));
}
function audioTg(h) {
  h.nUpd += 1;
  h.nMid += 1;
  return {
    update_id: h.nUpd,
    message: {
      message_id: h.nMid, date: Math.floor(h.t / 1000), chat: { id: CHAT, type: 'private', first_name: 'Davi' },
      from: { id: CHAT, is_bot: false, first_name: 'Davi' }, voice: { file_id: `V${h.nUpd}`, duration: 4, mime_type: 'audio/ogg' },
    },
  };
}
const arquivoDe = (h, u) => path.join(h.env.SESSOES_WPP_DIR, 'anexos', `tg-u${u.update_id}-a.oga`);
const horaDe = (u) => horaBRT(iso(u.message.date * 1000));
const linhasSistema = (h) => estado(h).tg.sistema.linhas.map((l) => l.texto);
const logs = (h) => {
  try { return fs.readFileSync(h.env.SESSOES_WPP_LOG, 'utf8').split('\n').filter(Boolean); } catch { return []; }
};
const tique = () => new Promise((ok) => setImmediate(ok));

test('A5b 5. audio sem transcritor (transcricao desligada: o rodar passa null): a linha "Recebi o áudio das HH:MM, mas a transcrição está desligada neste PC." na hora (notifica), o item e o arquivo somem, 1 log; a transcricao que falhou segue "Não entendi"', async () => {
  const h = montar({ transcrever: null });
  ligarTg(h);
  const a = audioTg(h);
  h.tg.lotes.push([a]);
  await h.cru.esperarTelegram(15000);
  const arq = arquivoDe(h, a);
  assert.ok(fs.existsSync(arq), 'o audio baixado');
  assert.equal(Object.keys(estado(h).tg.audios).length, 1, 'na fila');
  await h.cru.passoAudioTg();
  const e = estado(h);
  assert.deepEqual(e.tg.audios, {}, 'o item sumiu');
  assert.ok(!fs.existsSync(arq), 'o arquivo sumiu');
  assert.deepEqual(e.filaEntrega, [], 'nada repassado');
  assert.deepEqual(linhasSistema(h), [SEM_TRANSCRICAO(horaDe(a))]);
  assert.equal(e.tg.sistema.notificar, true, 'notifica');
  assert.equal(logs(h).filter((l) => /sem transcritor/.test(l)).length, 1);

  // com transcritor que falha: a linha de antes ("Não entendi"), nunca a da transcricao desligada
  const chamadas = [];
  const h2 = montar({ transcrever: async (arquivo) => { chamadas.push(arquivo); return { ok: false, erro: 'falhou' }; } });
  ligarTg(h2);
  const b = audioTg(h2);
  h2.tg.lotes.push([b]);
  await h2.cru.esperarTelegram(15000);
  await h2.cru.passoAudioTg();
  await tique();
  await tique();
  await h2.cru.passoAudioTg();
  assert.deepEqual(chamadas, [arquivoDe(h2, b)]);
  assert.deepEqual(estado(h2).tg.audios, {});
  assert.deepEqual(linhasSistema(h2), [NAO_ENTENDI(horaDe(b))]);
});

// ---------- 5. o transcrever.py com argumento ruim (python do PATH; faster_whisper falso; nunca o modelo) ----------

const versaoPython = spawnSync('python', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
const temPython = !versaoPython.error && versaoPython.status === 0 && /Python 3\./.test(`${versaoPython.stdout}${versaoPython.stderr}`);

// faster_whisper FALSO na frente do de verdade (PYTHONPATH): grava num arquivo quem foi importado e cada modelo/lingua
// pedido; a GPU sempre falha (o script cai pra CPU) e a CPU devolve "ola"
const FALSO = [
  'import json, os',
  'MARCA = os.environ["A5B_MARCA"]',
  'def _gravar(obj):',
  '    with open(MARCA, "a", encoding="utf-8") as f:',
  '        f.write(json.dumps(obj) + "\\n")',
  '_gravar({"importado": True})',
  'class _Seg:',
  '    text = " ola "',
  'class WhisperModel:',
  '    def __init__(self, modelo, device=None, compute_type=None, local_files_only=None):',
  '        self.device = device',
  '        _gravar({"modelo": modelo, "device": device, "local": local_files_only})',
  '        if device == "cuda":',
  '            raise RuntimeError("sem gpu no teste")',
  '    def transcribe(self, arquivo, language=None, **_):',
  '        _gravar({"language": language})',
  '        return iter([_Seg()]), None',
  '',
].join('\n');

function rodarPy(args) {
  const raiz = pastaTemp('a5b-py-');
  fs.mkdirSync(path.join(raiz, 'falso'));
  fs.writeFileSync(path.join(raiz, 'falso', 'faster_whisper.py'), FALSO);
  const marca = path.join(raiz, 'marca.jsonl');
  const audio = path.join(raiz, 'audio.oga');
  fs.writeFileSync(audio, 'falso');
  const r = spawnSync('python', [SCRIPT, ...args.map((x) => (x === '<audio>' ? audio : x))], {
    encoding: 'utf8', windowsHide: true, timeout: 60000,
    env: { ...process.env, PYTHONPATH: path.join(raiz, 'falso'), A5B_MARCA: marca, PYTHONIOENCODING: 'utf-8' },
  });
  const linhas = String(r.stdout ?? '').split(/\r?\n/).filter(Boolean);
  const marcas = fs.existsSync(marca) ? fs.readFileSync(marca, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { status: r.status, linhas, ultima: linhas.length ? JSON.parse(linhas[linhas.length - 1]) : null, marcas, stderr: r.stderr };
}

test('A5b 6. transcrever.py: argumento fora das regras = {"ok": false, "erro": "<campo> invalido"} antes de olhar o arquivo e antes do import; os bons chegam ao modelo (GPU e CPU) e a lingua ao transcribe; so o arquivo = os padroes', { skip: temPython ? false : 'sem o python do PATH' }, () => {
  // ruins: com arquivo que nao existe (a validacao vem antes do "arquivo nao existe") e com o que existe (antes do import)
  for (const [args, campo] of [
    [['pt-BR'], 'idioma'], [['p'], 'idioma'], [['port'], 'idioma'], [['p1'], 'idioma'], [[''], 'idioma'],
    [['pt', '../x'], 'modelo_gpu'], [['pt', 'a..b'], 'modelo_gpu'], [['pt', '-x'], 'modelo_gpu'], [['pt', 'a b'], 'modelo_gpu'], [['pt', ''], 'modelo_gpu'],
    [['pt', `m${'x'.repeat(100)}`], 'modelo_gpu'],
    [['pt', 'small', 'C:\\m'], 'modelo_cpu'], [['pt', 'small', '/abs'], 'modelo_cpu'], [['pt', 'small', 'x;y'], 'modelo_cpu'],
  ]) {
    for (const arquivo of ['<audio>', path.join(REPO, 'nao-existe-a5b.oga')]) {
      const r = rodarPy([arquivo, ...args]);
      assert.deepEqual(r.linhas.map((l) => JSON.parse(l)), [{ ok: false, erro: `${campo} invalido` }], `${JSON.stringify(args)} ${arquivo}: ${r.stderr}`);
      assert.equal(r.status, 0, JSON.stringify(args));
      assert.deepEqual(r.marcas, [], `${JSON.stringify(args)}: nada importado`);
    }
  }
  // bons: aparados e o idioma em minuscula (as mesmas regras do transcricaoDoConfig), chegam ao modelo falso
  let r = rodarPy(['<audio>', ' EN ', 'org/modelo_v2.1', 'tiny.en']);
  assert.deepEqual(r.ultima && { ok: r.ultima.ok, texto: r.ultima.texto, modelo: r.ultima.modelo, dispositivo: r.ultima.dispositivo },
    { ok: true, texto: 'ola', modelo: 'tiny.en', dispositivo: 'cpu' }, r.stderr);
  assert.deepEqual(r.marcas, [
    { importado: true },
    { modelo: 'org/modelo_v2.1', device: 'cuda', local: true },
    { modelo: 'tiny.en', device: 'cpu', local: true },
    { language: 'en' },
  ]);
  // so o arquivo: os padroes de hoje
  r = rodarPy(['<audio>']);
  assert.equal(r.ultima?.ok, true, r.stderr);
  assert.deepEqual(r.marcas, [
    { importado: true },
    { modelo: 'large-v3-turbo', device: 'cuda', local: true },
    { modelo: 'medium', device: 'cpu', local: true },
    { language: 'pt' },
  ]);
  // so o idioma: os modelos padrao
  r = rodarPy(['<audio>', 'es']);
  assert.deepEqual(r.marcas.slice(1), [
    { modelo: 'large-v3-turbo', device: 'cuda', local: true },
    { modelo: 'medium', device: 'cpu', local: true },
    { language: 'es' },
  ]);
  // sem argumento: o uso de sempre (exit 2)
  r = rodarPy([]);
  assert.equal(r.status, 2);
  assert.equal(r.ultima?.ok, false);
  assert.match(r.ultima.erro, /^uso: transcrever\.py <arquivo>/);
});
