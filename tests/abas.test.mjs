// Testes de abas.mjs (T7a2, PLANO-T7.md, "T7a2: F6, a central nao mexe no controle").
// Por que existe: a central nao muda o proprio controle; pedido de mudanca vai pra aba que desenvolve o controle, achada
// na hora pelo `abas.mjs --controle` (as abas abertas que editaram arquivo de C:\projetos\sessoes-wpp nas ultimas 24 h).
// Achar a aba errada (ou a propria central) = pedido do dono na aba errada; nao achar = "a aba nao esta aberta" falso.
// Isolamento: pastas temporarias via CLAUDE_SESSIONS_DIR e CLAUDE_PROJECTS_DIR; nada do ~/.claude real, nenhum
// processo, nenhuma rede. O pid "vivo" dos registros fixture e process.pid (pidVivo injetado).
// Rodar: node --test --test-reporter=tap "tests/abas.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { ultimaEdicaoNoControle, listarAbas, textoAbas, listarFechadas, textoFechadas } from '../abas.mjs';
import { horaBRT } from '../lib/formato.mjs';
import { CENTRAL_TESTE } from './lib/dados-central.mjs';

const require = createRequire(import.meta.url);
const lib = require('../hooks/lib/sessoes-wpp.js');

const MIN = 60 * 1000;
const MB = 1024 * 1024;
const T0 = Date.parse('2026-10-01T19:00:00Z'); // 16:00 em Brasilia
const iso = (ms) => new Date(ms).toISOString();
// A3a: a raiz do controle padrao e a pasta do proprio repositorio (tests/a3a.test.mjs, A3a 7); os testes daqui foram
// escritos com a do dono e passam ela explicita. REPO_ABAS = a pasta do abas.mjs (a raiz padrao da linha de comando).
const RAIZ_DONO = 'c:\\projetos\\sessoes-wpp\\';
const REPO_ABAS = path.dirname(fileURLToPath(new URL('../abas.mjs', import.meta.url)));

// 1 linha do transcript com 1 tool_use (a forma que o Claude Code grava: type assistant, message.content[]).
function usoDe(ms, ferramenta, input) {
  return {
    type: 'assistant',
    timestamp: iso(ms),
    message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${ms}`, name: ferramenta, input }] },
  };
}
const edicao = (ms, ferramenta = 'Edit', alvo = 'C:\\projetos\\sessoes-wpp\\porteiro.mjs') =>
  usoDe(ms, ferramenta, ferramenta === 'NotebookEdit' ? { notebook_path: alvo } : { file_path: alvo, old_string: 'a', new_string: 'b' });

test('T7a2 36. ultimaEdicaoNoControle: conta Edit/Write/MultiEdit/NotebookEdit dentro de c:\\projetos\\sessoes-wpp\\ (barra final); nao conta sessoes-wpp-outro, scratchpad, Read, Bash, Grep nem edicao de mais de 24 h', () => {
  const desdeMs = T0 - 24 * 60 * MIN;
  const u = (ents) => ultimaEdicaoNoControle(ents, { raiz: RAIZ_DONO, desdeMs }); // A3a: a raiz do dono, explicita

  // contam (a raiz do dono), cada uma sozinha
  const porteiro = edicao(T0 - 180 * MIN, 'Edit', 'C:/projetos/sessoes-wpp/porteiro.mjs');
  const maiusculas = edicao(T0 - 150 * MIN, 'Write', 'c:\\PROJETOS\\sessoes-wpp\\x');
  const multi = edicao(T0 - 120 * MIN, 'MultiEdit', 'C:\\projetos\\sessoes-wpp\\lib\\formato.mjs');
  const notebook = edicao(T0 - 90 * MIN, 'NotebookEdit', 'C:\\projetos\\sessoes-wpp\\n.ipynb');
  const worktree = edicao(T0 - 60 * MIN, 'Edit', 'c:\\projetos\\sessoes-wpp\\.claude\\worktrees\\agent-x\\abas.mjs'); // e codigo do controle
  assert.equal(u([porteiro]), T0 - 180 * MIN, 'Edit em C:/projetos/sessoes-wpp/porteiro.mjs');
  assert.equal(u([maiusculas]), T0 - 150 * MIN, 'Write em c:\\PROJETOS\\sessoes-wpp\\x');
  assert.equal(u([multi]), T0 - 120 * MIN, 'MultiEdit');
  assert.equal(u([notebook]), T0 - 90 * MIN, 'NotebookEdit (notebook_path)');
  assert.equal(u([worktree]), T0 - 60 * MIN, 'worktree do controle');

  // nao contam, cada uma sozinha (mais recentes que todas as que contam)
  const outro = edicao(T0 - 1 * MIN, 'Edit', 'C:\\projetos\\sessoes-wpp-outro\\x');
  const raizSemBarra = edicao(T0 - 1 * MIN, 'Write', 'C:\\projetos\\sessoes-wppx');
  const leitura = usoDe(T0 - 2 * MIN, 'Read', { file_path: 'C:\\projetos\\sessoes-wpp\\porteiro.mjs' });
  // Bash e Grep com o caminho do controle no input (ate num campo file_path): so as 4 ferramentas de edicao contam
  const bash = usoDe(T0 - 3 * MIN, 'Bash', { command: 'echo oi > C:/projetos/sessoes-wpp/x.txt', file_path: 'C:/projetos/sessoes-wpp/x.txt' });
  const grep = usoDe(T0 - 4 * MIN, 'Grep', { pattern: 'x', path: 'C:\\projetos\\sessoes-wpp\\', file_path: 'C:\\projetos\\sessoes-wpp\\x' });
  const scratchpad = edicao(T0 - 5 * MIN, 'Write', 'C:\\Users\\ANASOU~1\\AppData\\Local\\Temp\\claude\\c--projetos\\abc\\scratchpad\\x.mjs');
  const velha = edicao(T0 - 25 * 60 * MIN, 'Edit', 'C:\\projetos\\sessoes-wpp\\porteiro.mjs');
  assert.equal(u([outro]), null, 'C:\\projetos\\sessoes-wpp-outro\\x nao e o controle');
  assert.equal(u([raizSemBarra]), null, 'C:\\projetos\\sessoes-wppx nao e o controle');
  assert.equal(u([leitura]), null, 'Read nao conta');
  assert.equal(u([bash]), null, 'Bash nao conta');
  assert.equal(u([grep]), null, 'Grep nao conta');
  assert.equal(u([scratchpad]), null, 'scratchpad nao conta');
  assert.equal(u([velha]), null, 'edicao de mais de 24 h nao conta');
  assert.equal(u([]), null);

  // juntas: vale a mais recente das que contam (nenhuma das que nao contam ganha, mesmo sendo mais nova)
  const todas = [porteiro, outro, maiusculas, leitura, multi, bash, notebook, grep, worktree, scratchpad, velha, raizSemBarra];
  assert.equal(u(todas), T0 - 60 * MIN);

  // raiz informada: a mesma regra (barra final), em outra pasta
  assert.equal(ultimaEdicaoNoControle([edicao(T0 - 7 * MIN, 'Edit', 'D:/outro/a.txt')], { raiz: 'D:\\outro\\', desdeMs }), T0 - 7 * MIN);
  assert.equal(ultimaEdicaoNoControle([edicao(T0 - 7 * MIN, 'Edit', 'D:/outro-2/a.txt')], { raiz: 'D:\\outro\\', desdeMs }), null);
});

test('T7a2 37. listarAbas: exclui a propria sessao, sdk-cli, claude-desktop sem canal de recado e pid morto (F4i: o Desktop com canal entra); .key nunca e aberto; a mais recente primeiro; edicao so achada no degrau de 16 MB e achada; textoAbas literal', () => {
  const raiz = pastaTemp('abas-');
  const sessions = path.join(raiz, 'sessions');
  const projects = path.join(raiz, 'projects');
  const proj = path.join(projects, 'C--projetos');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  const env = { CLAUDE_SESSIONS_DIR: sessions, CLAUDE_PROJECTS_DIR: projects, CLAUDE_CODE_SESSION_ID: 'EU' };
  const MORTO = 4999999;
  const vivo = (pid) => Number(pid) === process.pid;
  const arquivoDe = (sessionId) => path.join(proj, `${sessionId}.jsonl`);

  let n = 100;
  function aba(sessionId, { entrypoint = 'claude-vscode', pid = process.pid, status = 'idle', updatedAt = T0 - MIN, linhas = [], cauda = '', socket = null } = {}) {
    const reg = { pid, sessionId, cwd: 'C:\\projetos', startedAt: T0 - 60 * MIN, updatedAt, entrypoint, status };
    if (socket !== null) reg.messagingSocketPath = socket;
    fs.writeFileSync(path.join(sessions, `${n++}.json`), JSON.stringify(reg));
    fs.writeFileSync(arquivoDe(sessionId), linhas.map((l) => `${JSON.stringify(l)}\n`).join('') + cauda);
  }
  const titulo = (sessionId, t) => ({ type: 'custom-title', customTitle: t, sessionId });
  const tituloAuto = (sessionId, t) => ({ type: 'ai-title', aiTitle: t, sessionId });

  aba('EU', { linhas: [titulo('EU', 'Central de sessões de teste'), edicao(T0 - 1 * MIN)] }); // a propria (a mais nova)
  aba('A', { status: 'busy', linhas: [titulo('A', 'Aba A'), edicao(T0 - 120 * MIN)] });
  aba('B', { entrypoint: 'cli', linhas: [tituloAuto('B', 'Auto B'), edicao(T0 - 30 * MIN, 'Write', 'c:\\PROJETOS\\sessoes-wpp\\x')] });
  aba('S', { entrypoint: 'sdk-cli', linhas: [titulo('S', 'Aba S'), edicao(T0 - 2 * MIN)] });
  aba('D', { entrypoint: 'claude-desktop', linhas: [titulo('D', 'Aba D'), edicao(T0 - 3 * MIN)] });
  // F4i: Desktop COM canal de recado entra (so leu o controle: fica fora do --controle, entra na lista toda)
  aba('DC', { entrypoint: 'claude-desktop', socket: '\\\\.\\pipe\\LOCAL\\cc-msg-dddd', linhas: [titulo('DC', 'Aba DC'), usoDe(T0 - 6 * MIN, 'Read', { file_path: 'C:\\projetos\\sessoes-wpp\\porteiro.mjs' })] });
  aba('M', { pid: MORTO, linhas: [titulo('M', 'Aba M'), edicao(T0 - 4 * MIN)] });
  aba('N', { linhas: [titulo('N', 'Aba N'), usoDe(T0 - 5 * MIN, 'Read', { file_path: 'C:\\projetos\\sessoes-wpp\\porteiro.mjs' })] });
  // G: a edicao fica a ~5,5 MB do fim (fora do degrau de 4 MB, dentro do de 16 MB); o titulo esta no comeco do arquivo
  const enchimento = JSON.stringify({
    type: 'assistant',
    timestamp: iso(T0 - 9 * MIN),
    message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'C:\\projetos\\sessoes-wpp\\porteiro.mjs' } }, { type: 'text', text: 'x'.repeat(1000) }] },
  });
  aba('G', { linhas: [titulo('G', 'Aba G'), edicao(T0 - 10 * MIN, 'MultiEdit')], cauda: `${enchimento}\n`.repeat(4600) });
  assert.ok(fs.statSync(arquivoDe('G')).size > 5 * MB && fs.statSync(arquivoDe('G')).size < 16 * MB);
  // .key na pasta (segredo): conteudo de registro valido de uma aba viva que mexeu no controle por ultimo; se fosse
  // aberto, K apareceria na lista
  fs.writeFileSync(path.join(sessions, '99.0123456789abcdef.key'), JSON.stringify({ pid: process.pid, sessionId: 'K', entrypoint: 'claude-vscode', status: 'idle', updatedAt: T0 }));
  fs.writeFileSync(arquivoDe('K'), `${JSON.stringify(titulo('K', 'Aba K'))}\n${JSON.stringify(edicao(T0 - 30 * 1000))}\n`);

  // espioes: nenhum .key aberto ou lido; os degraus da cauda de cada transcript
  const abertos = [];
  const degraus = new Map();
  const lerCauda = (arq, bytes) => {
    const k = path.basename(arq);
    degraus.set(k, [...(degraus.get(k) || []), bytes]);
    return lib.lerCauda(arq, bytes);
  };
  const { openSync, readFileSync } = fs;
  fs.openSync = (p, ...r) => { abertos.push(String(p)); return openSync(p, ...r); };
  fs.readFileSync = (p, ...r) => { abertos.push(String(p)); return readFileSync(p, ...r); };
  let lista;
  let semControle;
  let semEu;
  try {
    lista = listarAbas({ env, agora: T0, controle: true, lerCauda, pidVivo: vivo, raiz: RAIZ_DONO });
    semControle = listarAbas({ env, agora: T0, controle: false, lerCauda, pidVivo: vivo, raiz: RAIZ_DONO });
    semEu = listarAbas({ env: { CLAUDE_SESSIONS_DIR: sessions, CLAUDE_PROJECTS_DIR: projects }, agora: T0, controle: true, lerCauda, pidVivo: vivo, raiz: RAIZ_DONO });
  } finally {
    fs.openSync = openSync;
    fs.readFileSync = readFileSync;
  }
  assert.deepEqual(abertos.filter((p) => /\.key$/i.test(p)), [], '.key nunca e aberto');
  assert.ok(abertos.some((p) => /100\.json$/.test(p)), 'o espiao viu os registros');

  // --controle: G (15:50, so no degrau de 16 MB), B (15:30), A (14:00); sem EU, S, D, DC, M, N e K
  assert.deepEqual(lista.map((x) => x.sessionId), ['G', 'B', 'A']);
  assert.deepEqual(lista[0], { sessionId: 'G', nome: null, titulo: 'Aba G', status: 'idle', entrypoint: 'claude-vscode', controleEm: T0 - 10 * MIN });
  assert.equal(lista[1].entrypoint, 'cli');
  assert.equal(lista[1].titulo, 'Auto B');
  assert.equal(lista[2].status, 'busy');
  assert.deepEqual(degraus.get('G.jsonl').slice(0, 2), [4 * MB, 16 * MB], 'degraus de 4 e 16 MB');
  assert.equal(
    textoAbas(lista, { controle: true }),
    [
      '- Aba G (sessionId G, parada, mexeu no controle às 15:50)',
      '- Auto B (sessionId B, parada, mexeu no controle às 15:30)',
      '- Aba A (sessionId A, trabalhando, mexeu no controle às 14:00)',
    ].join('\n'),
  );

  // sem --controle: todas as interativas vivas, sem a propria
  assert.deepEqual(semControle.map((x) => x.sessionId).sort(), ['A', 'B', 'DC', 'G', 'N']);
  const dc = semControle.find((x) => x.sessionId === 'DC');
  assert.equal(dc.entrypoint, 'claude-desktop');
  assert.equal(dc.titulo, 'Aba DC');

  // sem CLAUDE_CODE_SESSION_ID no env: a propria volta (e a mais recente)
  assert.equal(semEu[0].sessionId, 'EU');

  // nada
  assert.equal(textoAbas([], { controle: true }), 'nenhuma aba mexeu no controle nas últimas 24 h');
  assert.equal(textoAbas([], { controle: false }), 'nenhuma aba aberta');
  assert.deepEqual(listarAbas({ env: { CLAUDE_SESSIONS_DIR: path.join(raiz, 'nao-existe'), CLAUDE_PROJECTS_DIR: projects }, agora: T0, controle: true, pidVivo: vivo }), []);

  fs.rmSync(raiz, { recursive: true, force: true });
});

test('T7a2 37b. CLI: exit 0; --controle lista a aba que mexeu no controle e sem --controle todas; erro = a linha fixa, sem stack', () => {
  const ARQ = fileURLToPath(new URL('../abas.mjs', import.meta.url));
  const raiz = pastaTemp('abas-cli-');
  const sessions = path.join(raiz, 'sessions');
  const projects = path.join(raiz, 'projects');
  const proj = path.join(projects, 'C--projetos');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  const agora = Date.now();
  // o pid "vivo" do registro e o deste processo de teste (a CLI roda filha dele, com o pidVivo real)
  fs.writeFileSync(path.join(sessions, '100.json'), JSON.stringify({
    pid: process.pid, sessionId: 'A', cwd: 'C:\\projetos', startedAt: agora - 60 * MIN, updatedAt: agora - MIN, entrypoint: 'claude-vscode', status: 'busy',
  }));
  // A3a: a linha de comando usa a raiz padrao (a pasta do repositorio): a edicao e num arquivo dela
  const doControle = path.join(REPO_ABAS, 'porteiro.mjs');
  fs.writeFileSync(path.join(proj, 'A.jsonl'), `${JSON.stringify({ type: 'custom-title', customTitle: 'Aba A', sessionId: 'A' })}\n${JSON.stringify(edicao(agora - 2 * MIN, 'Edit', doControle))}\n`);
  // V: aberta, mas a ultima edicao no controle foi ha 25 h (fora da janela de 24 h do --controle)
  fs.writeFileSync(path.join(sessions, '101.json'), JSON.stringify({
    pid: process.pid, sessionId: 'V', cwd: 'C:\\projetos', startedAt: agora - 30 * 60 * MIN, updatedAt: agora - 10 * MIN, entrypoint: 'claude-vscode', status: 'idle',
  }));
  fs.writeFileSync(path.join(proj, 'V.jsonl'), `${JSON.stringify({ type: 'custom-title', customTitle: 'Aba V', sessionId: 'V' })}\n${JSON.stringify(edicao(agora - 25 * 60 * MIN, 'Edit', doControle))}\n`);
  // A3a: a pasta de estado temporaria (nunca o config.json real)
  const estado = path.join(raiz, 'estado');
  const rodar = (args, env) => spawnSync(process.execPath, [ARQ, ...args], {
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'EU', SESSOES_WPP_DIR: estado, ...env }, encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  const env = { CLAUDE_SESSIONS_DIR: sessions, CLAUDE_PROJECTS_DIR: projects };
  const hora = horaBRT(new Date(agora - 2 * MIN).toISOString());

  let r = rodar(['--controle'], env);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), `- Aba A (sessionId A, trabalhando, mexeu no controle às ${hora})`);
  r = rodar([], env);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '- Aba A (sessionId A, trabalhando)\n- Aba V (sessionId V, parada)');

  // pasta de sessoes que e um arquivo: a linha fixa, exit 0, nenhum stack
  const arquivo = path.join(raiz, 'nao-e-pasta');
  fs.writeFileSync(arquivo, 'x');
  r = rodar(['--controle'], { CLAUDE_SESSIONS_DIR: arquivo, CLAUDE_PROJECTS_DIR: projects });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'não consegui listar as abas agora');
  assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /\bat |Error|ENOTDIR/);

  fs.rmSync(raiz, { recursive: true, force: true });
});

// ---------- T8: as abas fechadas que da pra reabrir pelo celular (PLANO-TELEGRAM.md, "T8"; `abas.mjs --fechadas`) ----------

// Conversa no disco como o Claude Code grava: o titulo (custom-title e/ou ai-title) e 1 linha com o entrypoint e o cwd.
// A hora da ultima mensagem e a do arquivo (mtime).
function conversaFechada(projects, dir, sid, { titulo = null, auto = null, entrypoint = 'claude-vscode', cwd = 'c:\\projetos', ultima, sem = false } = {}) {
  fs.mkdirSync(path.join(projects, dir), { recursive: true });
  const linhas = [];
  if (titulo) linhas.push({ type: 'custom-title', customTitle: titulo, sessionId: sid });
  if (!sem) linhas.push({ type: 'user', sessionId: sid, entrypoint, cwd, timestamp: iso(ultima - MIN), message: { role: 'user', content: 'oi' } });
  if (auto) linhas.push({ type: 'ai-title', aiTitle: auto, sessionId: sid });
  const arq = path.join(projects, dir, `${sid}.jsonl`);
  fs.writeFileSync(arq, linhas.map((l) => `${JSON.stringify(l)}\n`).join(''));
  fs.utimesSync(arq, new Date(ultima), new Date(ultima));
  return arq;
}

test('T8 2. listarFechadas: so conversa fechada de aba do VS Code ou do terminal dos ultimos 14 dias (titulo, pasta, hora da ultima mensagem), a mais recente primeiro; fora: viva, Desktop, automatica, a central, velha, sem pasta e .key; busca sem acento por todas as palavras; textoFechadas literal', () => {
  const raiz = pastaTemp('abas-fechadas-');
  const sessions = path.join(raiz, 'sessions');
  const projects = path.join(raiz, 'projects');
  fs.mkdirSync(sessions, { recursive: true });
  const env = { CLAUDE_SESSIONS_DIR: sessions, CLAUDE_PROJECTS_DIR: projects };
  const vivo = (pid) => Number(pid) === process.pid;
  const WS = 'd:\\Meus Docs\\trabalho\\Area';
  conversaFechada(projects, 'd--Meus-Docs-trabalho-Area', 'A', { titulo: 'Campanha Verão planejamento', cwd: WS, ultima: T0 - 30 * MIN });
  conversaFechada(projects, 'c--projetos-sessoes-wpp', 'B', { auto: 'Revisão do porteiro', entrypoint: 'cli', cwd: 'C:\\projetos\\sessoes-wpp', ultima: T0 - 120 * MIN });
  conversaFechada(projects, 'c--projetos', 'N', { ultima: T0 - 180 * MIN });
  conversaFechada(projects, 'c--projetos', 'V', { titulo: 'Aba viva', ultima: T0 - 10 * MIN });
  fs.writeFileSync(path.join(sessions, '100.json'), JSON.stringify({ pid: process.pid, sessionId: 'V', cwd: 'c:\\projetos', entrypoint: 'claude-vscode', status: 'idle' }));
  conversaFechada(projects, 'c--projetos', 'D', { titulo: 'Aba do Desktop', entrypoint: 'claude-desktop', ultima: T0 - 11 * MIN });
  conversaFechada(projects, 'c--projetos', 'S', { titulo: 'Mensageiro', entrypoint: 'sdk-cli', ultima: T0 - 12 * MIN });
  conversaFechada(projects, 'c--projetos', 'C', { titulo: 'Central de sessões de teste', entrypoint: 'cli', ultima: T0 - 13 * MIN });
  conversaFechada(projects, 'c--projetos', 'O', { titulo: 'Aula velha', ultima: T0 - 15 * 24 * 60 * MIN });
  conversaFechada(projects, 'c--projetos', 'X', { titulo: 'Sem pasta', sem: true, ultima: T0 - 14 * MIN });
  // .key na pasta (segredo): registro valido que daria a N como viva; se fosse aberto, a N sairia da lista
  fs.writeFileSync(path.join(sessions, '99.0123456789abcdef.key'), JSON.stringify({ pid: process.pid, sessionId: 'N', entrypoint: 'claude-vscode' }));
  // transcript de subagente (pasta dentro da pasta do projeto) nao e aba
  fs.mkdirSync(path.join(projects, 'c--projetos', 'A', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(projects, 'c--projetos', 'A', 'subagents', 'agent-1.jsonl'), `${JSON.stringify({ type: 'user', entrypoint: 'cli', cwd: 'c:\\projetos' })}\n`);

  // A3a: a central sai pelo nome (aqui a do teste, como o dono configura; o padrao e o do produto: A3a 8)
  const lista = listarFechadas({ env, agora: T0, pidVivo: vivo, nomeCentral: CENTRAL_TESTE.nome });
  assert.deepEqual(lista.map((x) => x.sessionId), ['A', 'B', 'N']);
  assert.deepEqual(lista[0], { sessionId: 'A', titulo: 'Campanha Verão planejamento', cwd: WS, entrypoint: 'claude-vscode', ultimaEm: T0 - 30 * MIN });
  assert.equal(lista[1].titulo, 'Revisão do porteiro');
  assert.equal(lista[2].titulo, null);
  assert.equal(
    textoFechadas(lista),
    [
      '- Campanha Verão planejamento (sessionId A, Area, última mensagem 01/10 às 15:30)',
      '- Revisão do porteiro (sessionId B, sessoes-wpp, última mensagem 01/10 às 14:00)',
      '- (sem título) (sessionId N, projetos, última mensagem 01/10 às 13:00)',
    ].join('\n'),
  );
  // busca: todas as palavras, sem acento e sem caso, no titulo
  assert.deepEqual(listarFechadas({ env, agora: T0, pidVivo: vivo, nomeCentral: CENTRAL_TESTE.nome, busca: 'CAMPANHA verao' }).map((x) => x.sessionId), ['A']);
  assert.deepEqual(listarFechadas({ env, agora: T0, pidVivo: vivo, nomeCentral: CENTRAL_TESTE.nome, busca: 'revisao porteiro' }).map((x) => x.sessionId), ['B']);
  assert.deepEqual(listarFechadas({ env, agora: T0, pidVivo: vivo, nomeCentral: CENTRAL_TESTE.nome, busca: 'campanha porteiro' }), []);
  assert.equal(textoFechadas([]), 'nenhuma aba fechada nos últimos 14 dias');
  assert.equal(textoFechadas([], { busca: 'aula xyz' }), 'nenhuma aba fechada nos últimos 14 dias com "aula xyz"');
  // no maximo 20, as mais recentes
  for (let i = 0; i < 25; i++) conversaFechada(projects, 'c--projetos', `M${i}`, { titulo: `Aba ${i}`, ultima: T0 - (200 + i) * MIN });
  const muitas = listarFechadas({ env, agora: T0, pidVivo: vivo, nomeCentral: CENTRAL_TESTE.nome });
  assert.equal(muitas.length, 20);
  assert.deepEqual(muitas.slice(0, 4).map((x) => x.sessionId), ['A', 'B', 'N', 'M0']);
  // pasta de projetos que nao existe = []
  assert.deepEqual(listarFechadas({ env: { CLAUDE_SESSIONS_DIR: sessions, CLAUDE_PROJECTS_DIR: path.join(raiz, 'nada') }, agora: T0, pidVivo: vivo }), []);
  fs.rmSync(raiz, { recursive: true, force: true });
});

test('T8 3. lib.cabecaDaConversa: o entrypoint e o cwd da 1a linha que tem cada um, lendo o comeco (linha gigante antes); sem os campos = null; arquivo que nao existe = null', () => {
  const raiz = pastaTemp('abas-cabeca-');
  const arq = path.join(raiz, 'a.jsonl');
  const gigante = JSON.stringify({ type: 'attachment', texto: 'x'.repeat(3 * MB) });
  fs.writeFileSync(arq, [
    JSON.stringify({ type: 'custom-title', customTitle: 'T' }),
    gigante,
    JSON.stringify({ type: 'user', cwd: 'c:\\projetos\\x' }),
    JSON.stringify({ type: 'user', entrypoint: 'cli', cwd: 'c:\\outra' }),
    JSON.stringify({ type: 'user', entrypoint: 'claude-vscode', cwd: 'c:\\terceira' }),
  ].map((l) => `${l}\n`).join(''));
  assert.deepEqual(lib.cabecaDaConversa(arq), { entrypoint: 'cli', cwd: 'c:\\projetos\\x' });
  const sem = path.join(raiz, 'b.jsonl');
  fs.writeFileSync(sem, `${JSON.stringify({ type: 'custom-title', customTitle: 'T' })}\nisso nao e json\n`);
  assert.deepEqual(lib.cabecaDaConversa(sem), { entrypoint: null, cwd: null });
  assert.equal(lib.cabecaDaConversa(path.join(raiz, 'nao-existe.jsonl')), null);
  fs.rmSync(raiz, { recursive: true, force: true });
});

test('T8 4. CLI --fechadas [palavras]: a lista (a busca junta as palavras), exit 0; erro = a linha fixa, sem stack', () => {
  const ARQ = fileURLToPath(new URL('../abas.mjs', import.meta.url));
  const raiz = pastaTemp('abas-fechadas-cli-');
  const sessions = path.join(raiz, 'sessions');
  const projects = path.join(raiz, 'projects');
  fs.mkdirSync(sessions, { recursive: true });
  const agora = Date.now();
  conversaFechada(projects, 'c--projetos', 'A', { titulo: 'Campanha Verão planejamento', ultima: agora - 30 * MIN });
  conversaFechada(projects, 'c--projetos', 'B', { titulo: 'Financeiro', ultima: agora - 60 * MIN });
  // A3a: a linha de comando le o nome da central do config.json da pasta de estado: a temporaria (sem config = o padrao)
  const estado = path.join(raiz, 'estado');
  const rodar = (args, env) => spawnSync(process.execPath, [ARQ, ...args], { env: { ...process.env, SESSOES_WPP_DIR: estado, ...env }, encoding: 'utf8', timeout: 30000, windowsHide: true });
  const env = { CLAUDE_SESSIONS_DIR: sessions, CLAUDE_PROJECTS_DIR: projects };
  const quando = (ms) => {
    const d = new Date(ms - 3 * 60 * MIN).toISOString();
    return `${d.slice(8, 10)}/${d.slice(5, 7)} às ${d.slice(11, 16)}`;
  };
  let r = rodar(['--fechadas', 'campanha', 'verao'], env);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), `- Campanha Verão planejamento (sessionId A, projetos, última mensagem ${quando(agora - 30 * MIN)})`);
  r = rodar(['--fechadas'], env);
  assert.equal(r.stdout.trim().split('\n').length, 2);
  r = rodar(['--fechadas', 'xyz'], env);
  assert.equal(r.stdout.trim(), 'nenhuma aba fechada nos últimos 14 dias com "xyz"');
  const arquivo = path.join(raiz, 'nao-e-pasta');
  fs.writeFileSync(arquivo, 'x');
  r = rodar(['--fechadas'], { CLAUDE_SESSIONS_DIR: arquivo, CLAUDE_PROJECTS_DIR: arquivo });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'não consegui listar as abas agora');
  assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /\bat |Error|ENOTDIR/);
  fs.rmSync(raiz, { recursive: true, force: true });
});
