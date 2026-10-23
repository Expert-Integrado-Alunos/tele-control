// Testes da A5d1 (PLANO-ABERTO.md, "A5d — a central montada", parte pura): as instrucoes da central e da sessao
// escondida viram MODELO (o dono, o repositorio, o nome da central e as pastas de projeto entram por marcador), as regras
// do dono e a linha de procedencia entram no fim, o objeto do --settings sai do modo de permissao (sozinha ou pedir) e o
// negar-permissao.mjs responde o deny do PermissionRequest. A5d2 (a fiacao, testes 16 em diante): os 2 .vbs abrem com a
// pasta montada e o modo, o porteiro chama o gravarCentral a cada abertura (antes do wscript) e o instalador pede o
// Claude Code 2.1.295 e faz a pergunta 9 com o texto do contrato.
// Por que existe: a copia aberta serve a qualquer pessoa; texto com o dono de outra pessoa, caminho chumbado ou marcador
// sobrando vira uma central que manda comando pro lugar errado; ajuste errado vira uma central que pede licenca na tela
// sem ninguem olhando (trava) ou que age sem pedir quando o dono escolheu o modo cuidadoso.
// Isolamento: pastas temporarias pelo tests/lib/pasta-temp.cjs (prefixo "a5d-"); o negar-permissao.mjs roda como
// processo de verdade (so le a entrada e escreve o JSON). O abrir-central.vbs roda pelo cscript so no modo ensaio (e so
// se o ensaio vier antes do 1o sh.Run); o abrir-sessao.vbs roda pelo wscript com um claude FALSO (um .cmd que chama o
// node e grava os argumentos); os abridores do porteiro com spawn e gravarCentral dublados. Nada de rede, config.json
// real nem porteiro rodando.
// Dados: a tabela de dados sinteticos do PLANO-ABERTO.md (o dono Davi, C:\projetos, D:\Meus Docs\trabalho\Area).
// Os modulos entram por `import * as`: funcao que ainda nao existe deixa so o teste dela vermelho.
// Rodar: node --test --test-reporter=tap "tests/a5d.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pastaTemp } from './lib/pasta-temp.cjs';
import * as central from '../lib/central.mjs';
import * as config from '../lib/config.mjs';
import * as porteiro from '../porteiro.mjs';
import * as instalar from '../lib/instalar.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEGAR = path.join(RAIZ, 'central', 'negar-permissao.mjs');
const REPO = 'C:\\projetos\\tele-control';
const REPO_BARRA = 'C:/projetos/tele-control';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const DONO = { nome: 'Davi', artigo: 'o' };
const RAIZES = ['C:\\projetos', 'D:\\Meus Docs\\trabalho\\Area'];
const NOME_CENTRAL = 'Central do Tele Control';
const PASTAS = '`C:\\projetos`, `D:\\Meus Docs\\trabalho\\Area`';
const SEM_PASTA = 'nenhuma pasta de projeto configurada: o porteiro não abre sessão nova';
const PROC = 'Procedência: o Tele Control é um sistema criado por Eric Luciano, educador e mentor de IA aplicada a negócios, '
  + 'da Expert Integrado (expertintegrado.com.br).';
const MSG_NEGAR = 'Negado: esta sessão roda sem ninguém no PC e não pede licença na tela. Não tente de novo nem por outro '
  + 'caminho: diga ao dono, na sua resposta, o que precisava fazer e por quê.';
const REGRAS_TITULO = '## Regras do dono';

const ler = (arq) => fs.readFileSync(path.join(RAIZ, 'central', arq), 'utf8');
const OPCOES = { dono: DONO, repo: REPO, central: NOME_CENTRAL, raizes: RAIZES };

// Modelo pequeno com os 4 marcadores (o {{dono}} numa linha so, como nos modelos de verdade)
const MODELO = [
  '# Teste',
  'Central "{{central}}".',
  '{{dono}}',
  '',
  '1. Rode `node "{{repo}}/porteiro.mjs" encaminhar --msg <id>`.',
  '2. Pastas de projeto ({{pastas}}).',
  '',
].join('\r\n');
const MONTADO = [
  '# Teste',
  `Central "${NOME_CENTRAL}".`,
  'Neste PC, o dono é o Davi.',
  '',
  `1. Rode \`node "${REPO_BARRA}/porteiro.mjs" encaminhar --msg <id>\`.`,
  `2. Pastas de projeto (${PASTAS}).`,
  '',
].join('\n');

// ---------- montarInstrucoes ----------

// Mac-testes (A): os testes marcados com SO_WINDOWS conferem a premissa do Windows (caminho X:\, .exe, wscript/.vbs,
// cmd.exe, APPDATA/LOCALAPPDATA, pipe \\.\pipe, barra invertida na frase, PowerShell, VS Code/Orca abertos pelo
// porteiro); fora do win32 eles pulam. O caminho do Mac tem os testes proprios em tests/mac-*.test.mjs.
const SO_WINDOWS = process.platform !== 'win32' && 'premissa do Windows (o Mac tem os tests/mac-*)';

test('A5d 1. PROCEDENCIA: o texto exato do contrato (marca d\'água)', () => {
  assert.equal(central.PROCEDENCIA, PROC);
});

test('A5d 2. montarInstrucoes: os 4 marcadores ({{dono}} vira a linha "Neste PC, o dono é ...", {{repo}} com /, {{central}}, {{pastas}}); fim de linha LF; sem regras e sem procedencia = so o modelo', () => {
  assert.equal(central.montarInstrucoes(MODELO, OPCOES), MONTADO);
  // o repositorio com / (e sem a barra do fim), venha como vier
  assert.equal(central.montarInstrucoes(MODELO, { ...OPCOES, repo: 'C:/projetos/tele-control/' }), MONTADO);
  // o artigo do dono: "a Ana"; sem artigo = so o nome
  assert.match(central.montarInstrucoes(MODELO, { ...OPCOES, dono: { nome: 'Ana', artigo: 'a' } }), /^Neste PC, o dono é a Ana\.$/m);
  assert.match(central.montarInstrucoes(MODELO, { ...OPCOES, dono: { nome: 'Sam', artigo: '' } }), /^Neste PC, o dono é Sam\.$/m);
  // sem nome configurado = linha nenhuma (a linha inteira sai, sem deixar linha em branco a mais)
  const semDono = MONTADO.replace('Neste PC, o dono é o Davi.\n', '');
  for (const dono of [null, undefined, {}, { nome: '' }, { nome: '   ' }, { nome: 5 }, 'Davi']) {
    assert.equal(central.montarInstrucoes(MODELO, { ...OPCOES, dono }), semDono, JSON.stringify(dono));
  }
  // nenhuma pasta de projeto = a frase do contrato no lugar da lista
  for (const raizes of [[], undefined, null, 'C:\\projetos', [5, '']]) {
    assert.equal(central.montarInstrucoes(MODELO, { ...OPCOES, raizes }), MONTADO.replace(PASTAS, SEM_PASTA), JSON.stringify(raizes));
  }
  assert.equal(central.montarInstrucoes(MODELO, { ...OPCOES, raizes: ['C:\\projetos'] }), MONTADO.replace(PASTAS, '`C:\\projetos`'));
});

test('A5d 3. montarInstrucoes: as regras do dono sob "## Regras do dono" depois do modelo (aparadas); sem regras ou so espaco = sem a secao', () => {
  assert.equal(central.montarInstrucoes(MODELO, { ...OPCOES, regras: '  \r\nSoftware = a pasta de projetos.\r\n\r\n' }),
    `${MONTADO}\n${REGRAS_TITULO}\n\nSoftware = a pasta de projetos.\n`);
  for (const regras of ['', '   \n\t', undefined, null, 42, ['x']]) {
    assert.equal(central.montarInstrucoes(MODELO, { ...OPCOES, regras }), MONTADO, JSON.stringify(regras));
  }
  // o texto das regras e do dono: marcador ali nao e trocado nem vira erro
  assert.ok(central.montarInstrucoes(MODELO, { ...OPCOES, regras: 'use {{repo}} literal' }).endsWith('use {{repo}} literal\n'));
});

test('A5d 4. montarInstrucoes: regras grandes cortadas em 8 KB (bytes UTF-8, sem partir caractere)', () => {
  assert.equal(central.MAX_REGRAS, 8 * 1024);
  const base = `${MONTADO}\n${REGRAS_TITULO}\n\n`;
  assert.equal(central.montarInstrucoes(MODELO, { ...OPCOES, regras: 'a'.repeat(8192) }), `${base}${'a'.repeat(8192)}\n`);
  assert.equal(central.montarInstrucoes(MODELO, { ...OPCOES, regras: 'a'.repeat(9000) }), `${base}${'a'.repeat(8192)}\n`);
  // 'ç' = 2 bytes: 5000 deles = 10000 bytes -> 4096 (8192 bytes)
  assert.equal(central.montarInstrucoes(MODELO, { ...OPCOES, regras: 'ç'.repeat(5000) }), `${base}${'ç'.repeat(4096)}\n`);
  // 1 byte + 'ç'...: o corte nao parte o caractere (8191 bytes)
  assert.equal(central.montarInstrucoes(MODELO, { ...OPCOES, regras: `a${'ç'.repeat(5000)}` }), `${base}a${'ç'.repeat(4095)}\n`);
});

test('A5d 5. montarInstrucoes: a procedencia por ultimo, so com procedencia: true (depois das regras)', () => {
  assert.equal(central.montarInstrucoes(MODELO, { ...OPCOES, procedencia: true }), `${MONTADO}\n${PROC}\n`);
  assert.equal(central.montarInstrucoes(MODELO, { ...OPCOES, regras: 'regra 1', procedencia: true }),
    `${MONTADO}\n${REGRAS_TITULO}\n\nregra 1\n\n${PROC}\n`);
  for (const procedencia of [false, undefined, 'true', 1, null]) {
    assert.equal(central.montarInstrucoes(MODELO, { ...OPCOES, procedencia }), MONTADO, JSON.stringify(procedencia));
  }
});

test('A5d 6. montarInstrucoes: marcador que sobra = erro (desconhecido, ou repo/central sem valor); modelo que nao e texto = erro', () => {
  assert.throws(() => central.montarInstrucoes(`${MODELO}{{outro}}\n`, OPCOES), /marcador/);
  assert.throws(() => central.montarInstrucoes(`${MODELO}{{ dono }}\n`, OPCOES), /marcador/);
  for (const repo of [undefined, null, '', '   ', 5, 'C:\\a"b']) {
    assert.throws(() => central.montarInstrucoes(MODELO, { ...OPCOES, repo }), /marcador/, JSON.stringify(repo));
  }
  for (const nome of [undefined, null, '', '  ', 7]) {
    assert.throws(() => central.montarInstrucoes(MODELO, { ...OPCOES, central: nome }), /marcador/, JSON.stringify(nome));
  }
  for (const modelo of [undefined, null, 5, {}]) {
    assert.throws(() => central.montarInstrucoes(modelo, OPCOES), JSON.stringify(modelo));
  }
  // sem opcoes: o {{repo}} sobra
  assert.throws(() => central.montarInstrucoes(MODELO), /marcador/);
  // modelo sem o marcador nao precisa do valor
  assert.equal(central.montarInstrucoes('so texto\n', {}), 'so texto\n');
});

// ---------- os modelos de verdade ----------

test('A5d 7. os 2 modelos: sem o nome de ninguem, sem o bot, o grupo ou a pasta de uma pessoa; todo comando com "{{repo}}"; a linha {{dono}}; o WhatsApp marcado; montados sem marcador sobrando', () => {
  for (const arq of ['instrucoes.md', 'instrucoes-sessao.md']) {
    const m = ler(arq);
    assert.doesNotMatch(m, /Eric/, arq);
    assert.doesNotMatch(m, /Claude\sPC/, arq);
    assert.doesNotMatch(m, /Notifica\S*\sdos\sAgentes/i, arq);
    assert.doesNotMatch(m, /[A-Z]:[\\/]repos/i, arq);
    assert.doesNotMatch(m, /Meu\sDrive|Workspace/i, arq);
    assert.match(m, /^\{\{dono\}\}\r?$/m, `${arq}: a linha do dono`);
    const comandos = [...m.matchAll(/`node ([^`]*)`/g)].map((x) => x[1]);
    assert.ok(comandos.length >= 1, arq);
    for (const c of comandos) assert.ok(c.startsWith('"{{repo}}/'), `${arq}: ${c}`);
    assert.match(m, /\(com o WhatsApp ligado/, `${arq}: o WhatsApp marcado`);
    const montado = central.montarInstrucoes(m, { ...OPCOES, regras: 'regra 1', procedencia: true });
    assert.doesNotMatch(montado, /\{\{|\}\}/, arq);
    assert.ok(montado.endsWith(`\n${PROC}\n`), arq);
  }
  const c = ler('instrucoes.md');
  assert.match(c, /\{\{central\}\}/);
  assert.match(c, /\{\{pastas\}\}/);
});

test('A5d 8. modelo da central: item 9 com a regra geral das pastas (uma das pastas de projeto, as Regras do dono, na duvida pergunta em 1 linha) e um nome curto generico; item 5 com o Desktop de canal de recado recebendo', () => {
  const c = ler('instrucoes.md');
  const item9 = /^9\. [\s\S]*?(?=\r?\n\r?\n## )/m.exec(c);
  assert.ok(item9, 'item 9 no fim da secao');
  const nove = item9[0].replace(/\s+/g, ' ');
  assert.ok(nove.includes('SEMPRE uma das pastas de projeto ({{pastas}})'), nove);
  assert.ok(nove.includes('Regras do dono'), nove);
  assert.ok(nove.includes('Na dúvida, pergunte ao dono em 1 linha'), nove);
  assert.ok(nove.includes('ex.: "Pesquisa de Preço"'), nove);
  assert.ok(nove.includes('Pasta fora das pastas de projeto'), nove);
  const item5 = /^5\. [\s\S]*?(?=\r?\n6\. )/m.exec(c);
  assert.ok(item5, 'item 5 seguido do 6');
  const cinco = item5[0].replace(/\s+/g, ' ');
  assert.ok(cinco.includes('`claude-desktop` (Claude Desktop) com canal de recado'), cinco);
  assert.ok(cinco.includes('Sessão do Claude Desktop sem canal de recado ou automática (`sdk-cli`) não recebe'), cinco);
  // o WhatsApp marcado: a entrada do grupo e o numero do dono so com o WhatsApp ligado (central e sessao escondida)
  const cc = c.replace(/\s+/g, ' ');
  assert.ok(cc.includes('e, com o WhatsApp ligado, as do grupo do WhatsApp que não citam o aviso'), 'central: a entrada do grupo');
  assert.ok(cc.includes('vindo do número do dono (com o WhatsApp ligado) ou da conta dele no Telegram'), 'central: item 12');
  const ss = ler('instrucoes-sessao.md').replace(/\s+/g, ' ');
  assert.ok(ss.includes('(no chat do bot no Telegram ou, com o WhatsApp ligado, no grupo do WhatsApp)'), 'sessao: a entrada');
  assert.ok(ss.includes('vindo do número do dono (com o WhatsApp ligado) ou da conta dele no Telegram'), 'sessao: item 4');
  // os itens 1 a 19 em ordem, 1 vez cada (o conteudo fica; so sai o que era de uma pessoa; T35: o 19)
  assert.deepEqual([...c.matchAll(/^(\d+)\. /gm)].map((x) => Number(x[1])), Array.from({ length: 19 }, (_, i) => i + 1));
  assert.deepEqual([...ler('instrucoes-sessao.md').matchAll(/^(\d+)\. /gm)].map((x) => Number(x[1])), [1, 2, 3, 4, 5, 6]);
});

test('A5d 9. todo comando dos modelos montados cabe numa regra do permissions.allow do modo pedir (a central nao para pedindo licenca no roteamento)', () => {
  const allow = central.montarAjustes({ modo: 'pedir', repo: REPO, node: NODE }).permissions.allow;
  const cabe = (cmd) => allow.some((r) => {
    const p = /^Bash\((.*)\)$/.exec(r)[1];
    return p.endsWith(' *') ? cmd.startsWith(p.slice(0, -1)) : cmd === p;
  });
  for (const arq of ['instrucoes.md', 'instrucoes-sessao.md']) {
    const montado = central.montarInstrucoes(ler(arq), OPCOES);
    const comandos = [...montado.matchAll(/`(node [^`]*)`/g)].map((x) => x[1]);
    for (const cmd of comandos) assert.ok(cabe(cmd), `${arq}: ${cmd}`);
  }
});

// ---------- montarAjustes ----------

const ALLOW = [
  `Bash(node "${REPO_BARRA}/porteiro.mjs" encaminhar *)`,
  `Bash(node "${REPO_BARRA}/porteiro.mjs" reabrir-sessao *)`,
  `Bash(node "${REPO_BARRA}/porteiro.mjs" abrir-sessao *)`,
  `Bash(node "${REPO_BARRA}/porteiro.mjs" esperando)`,
  `Bash(node "${REPO_BARRA}/porteiro.mjs" aguardar *)`,
  `Bash(node "${REPO_BARRA}/porteiro.mjs" painel)`,
  `Bash(node "${REPO_BARRA}/porteiro.mjs" painel *)`,
  `Bash(node "${REPO_BARRA}/ler-grupo.mjs" *)`,
  `Bash(node "${REPO_BARRA}/abas.mjs" *)`,
  `Bash(node "${REPO_BARRA}/ok-wpp.mjs" pedir *)`,
  `Bash(node "${REPO_BARRA}/ok-wpp.mjs" verificar *)`,
];
const AJUSTES_PEDIR = {
  crossSessionInbound: 'accept',
  permissions: { allow: ALLOW },
  hooks: {
    PermissionRequest: [{
      hooks: [{
        type: 'command', command: NODE, args: [`${REPO}\\central\\negar-permissao.mjs`], timeout: 10, onFailure: 'block',
      }],
    }],
  },
};

test('A5d 10. montarAjustes: sozinha = so o crossSessionInbound; pedir (e qualquer outro modo) = o inbound, o allow com os comandos do roteamento e o hook PermissionRequest sem matcher com onFailure block', { skip: SO_WINDOWS }, () => {
  assert.deepEqual(central.montarAjustes({ modo: 'sozinha', repo: REPO, node: NODE }), { crossSessionInbound: 'accept' });
  assert.deepEqual(central.montarAjustes({ modo: 'sozinha' }), { crossSessionInbound: 'accept' }, 'sozinha nao precisa de repo nem node');
  assert.deepEqual(central.montarAjustes({ modo: 'pedir', repo: REPO, node: NODE }), AJUSTES_PEDIR);
  assert.deepEqual(central.montarAjustes({ modo: 'pedir', repo: 'C:/projetos/tele-control/', node: NODE }), AJUSTES_PEDIR, 'repo com / e a barra do fim');
  for (const modo of [undefined, null, 'Sozinha', 'auto', 'bypassPermissions', true]) {
    assert.deepEqual(central.montarAjustes({ modo, repo: REPO, node: NODE }), AJUSTES_PEDIR, `na duvida, o seguro: ${JSON.stringify(modo)}`);
  }
  const grupo = central.montarAjustes({ modo: 'pedir', repo: REPO, node: NODE }).hooks.PermissionRequest[0];
  assert.ok(!('matcher' in grupo), 'sem matcher = todas as ferramentas');
  // pedir sem como montar o hook ou as regras = erro (a central nao abre sem o seguro)
  for (const o of [{ modo: 'pedir', node: NODE }, { modo: 'pedir', repo: REPO }, { modo: 'pedir', repo: '', node: NODE },
    { modo: 'pedir', repo: 'C:\\a"b', node: NODE }, { modo: 'pedir', repo: REPO, node: '' }, undefined]) {
    assert.throws(() => central.montarAjustes(o), JSON.stringify(o));
  }
});

// ---------- gravarCentral ----------

test('A5d 11. gravarCentral: grava <estado>/central/instrucoes.md (com as regras do dono e a procedencia), instrucoes-sessao.md e ajustes.json; devolve {pasta, modo}; a regra editada vale na proxima; sem sobra de temporario', () => {
  const estado = pastaTemp('a5d-');
  const linhas = [];
  const log = (l) => linhas.push(l);
  fs.writeFileSync(path.join(estado, 'regras-da-central.md'), 'Software = `C:\\projetos`.\r\n');
  const base = { estadoDir: estado, repo: RAIZ, dono: DONO, central: NOME_CENTRAL, raizes: RAIZES, node: NODE, log };
  const r = central.gravarCentral({ ...base, modo: 'sozinha', procedencia: true });
  const pasta = path.join(estado, 'central');
  assert.deepEqual(r, { pasta, modo: 'sozinha' });
  assert.deepEqual(fs.readdirSync(pasta).sort(), ['ajustes.json', 'instrucoes-sessao.md', 'instrucoes.md']);
  const opcoes = { dono: DONO, repo: RAIZ, central: NOME_CENTRAL, raizes: RAIZES, procedencia: true };
  const instr = fs.readFileSync(path.join(pasta, 'instrucoes.md'), 'utf8');
  assert.equal(instr, central.montarInstrucoes(ler('instrucoes.md'), { ...opcoes, regras: 'Software = `C:\\projetos`.\r\n' }));
  assert.ok(instr.includes(`\n${REGRAS_TITULO}\n\nSoftware = \`C:\\projetos\`.\n\n${PROC}\n`));
  // a sessao escondida: o modelo dela com a procedencia (as regras sao da central)
  const ses = fs.readFileSync(path.join(pasta, 'instrucoes-sessao.md'), 'utf8');
  assert.equal(ses, central.montarInstrucoes(ler('instrucoes-sessao.md'), opcoes));
  assert.ok(!ses.includes(REGRAS_TITULO));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(pasta, 'ajustes.json'), 'utf8')), { crossSessionInbound: 'accept' });
  assert.deepEqual(linhas, []);

  // regra editada + modo ausente (= pedir) + sem a procedencia: vale na proxima abertura
  fs.writeFileSync(path.join(estado, 'regras-da-central.md'), 'Tarefa do dia a dia = `D:\\Meus Docs\\trabalho\\Area`.\n');
  assert.deepEqual(central.gravarCentral({ ...base, procedencia: false }), { pasta, modo: 'pedir' });
  const instr2 = fs.readFileSync(path.join(pasta, 'instrucoes.md'), 'utf8');
  assert.ok(instr2.endsWith(`\n${REGRAS_TITULO}\n\nTarefa do dia a dia = \`D:\\Meus Docs\\trabalho\\Area\`.\n`), instr2.slice(-200));
  assert.ok(!instr2.includes(PROC));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(pasta, 'ajustes.json'), 'utf8')),
    central.montarAjustes({ modo: 'pedir', repo: RAIZ, node: NODE }));
  assert.deepEqual(fs.readdirSync(pasta).sort(), ['ajustes.json', 'instrucoes-sessao.md', 'instrucoes.md']);

  // sem o arquivo de regras: sem a secao
  fs.rmSync(path.join(estado, 'regras-da-central.md'));
  assert.deepEqual(central.gravarCentral({ ...base, modo: 'sozinha' }), { pasta, modo: 'sozinha' });
  assert.ok(!fs.readFileSync(path.join(pasta, 'instrucoes.md'), 'utf8').includes(REGRAS_TITULO));
  assert.deepEqual(linhas, []);
});

test('A5d 12. gravarCentral: erro = null e 1 linha de log (pasta de estado ruim, modelo que nao existe, marcador sobrando, pedir sem node)', () => {
  const estado = pastaTemp('a5d-');
  const arquivo = path.join(estado, 'arquivo');
  fs.writeFileSync(arquivo, 'x');
  const sem = pastaTemp('a5d-'); // repositorio sem os modelos
  const base = { estadoDir: estado, repo: RAIZ, dono: DONO, central: NOME_CENTRAL, raizes: RAIZES, node: NODE, modo: 'sozinha' };
  for (const [rotulo, o] of [
    ['estado debaixo de um arquivo', { ...base, estadoDir: path.join(arquivo, 'sub') }],
    ['estado vazio', { ...base, estadoDir: '' }],
    ['sem os modelos', { ...base, repo: sem }],
    ['central sem nome (marcador sobrando)', { ...base, central: '' }],
    ['pedir sem node', { ...base, modo: 'pedir', node: undefined }],
  ]) {
    const linhas = [];
    assert.equal(central.gravarCentral({ ...o, log: (l) => linhas.push(l) }), null, rotulo);
    assert.equal(linhas.length, 1, rotulo);
    assert.equal(typeof linhas[0], 'string', rotulo);
    assert.ok(!linhas[0].includes('\n'), `${rotulo}: 1 linha`);
  }
  // sem log: so null (nunca lanca)
  assert.equal(central.gravarCentral({ ...base, repo: sem }), null);
  assert.equal(central.gravarCentral(), null);
});

// ---------- negar-permissao.mjs ----------

const DENY = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: MSG_NEGAR } } };

test('A5d 13. negar-permissao.mjs (processo de verdade): le a entrada ate o fim e responde o JSON do deny com a message do contrato; exit 0', () => {
  for (const input of [JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm x' } }), '', 'lixo']) {
    const r = spawnSync(process.execPath, [NEGAR], { input, encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 0, `${JSON.stringify(input)}: ${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout), DENY, JSON.stringify(input));
  }
});

test('A5d 14. negar-permissao.mjs: entrada que nao termina = responde o deny no prazo de 2 s, exit 0', async () => {
  const t0 = Date.now();
  const filho = spawn(process.execPath, [NEGAR], { stdio: ['pipe', 'pipe', 'pipe'] });
  let saida = '';
  filho.stdout.setEncoding('utf8');
  filho.stdout.on('data', (d) => { saida += d; });
  filho.stdin.write('{"hook_event_name":"Permission');
  // trava do proprio teste: sem resposta em 10 s = mata (o teste fica vermelho, nunca pendurado)
  const trava = setTimeout(() => filho.kill(), 10000);
  const codigo = await new Promise((resolve) => filho.on('close', resolve));
  clearTimeout(trava);
  const ms = Date.now() - t0;
  filho.stdin.destroy();
  assert.equal(codigo, 0);
  assert.deepEqual(JSON.parse(saida), DENY);
  assert.ok(ms >= 1500, `esperou o prazo (${ms} ms)`);
  assert.ok(ms < 10000, `respondeu no prazo (${ms} ms)`);
});

// ---------- identidadeCentral com o modo ----------

test('A5d 15. identidadeCentral: modoPermissao = sozinha so com central.modoPermissao === "sozinha"; ausente ou outro valor = pedir', { skip: SO_WINDOWS }, () => {
  const { identidadeCentral } = config;
  assert.deepEqual(identidadeCentral({ central: { pasta: 'C:\\projetos', nome: 'Minha Central', modoPermissao: 'sozinha' } }),
    { pasta: 'C:\\projetos', nome: 'Minha Central', modoPermissao: 'sozinha' });
  for (const modo of [undefined, 'pedir', 'Sozinha', ' sozinha', 'sozinha ', 'bypassPermissions', true, 1, null, {}, ['sozinha']]) {
    assert.equal(identidadeCentral({ central: { modoPermissao: modo } }).modoPermissao, 'pedir', JSON.stringify(modo));
  }
  for (const cfg of [null, undefined, {}, { central: null }, { central: 'sozinha' }, { modoPermissao: 'sozinha' }]) {
    assert.equal(identidadeCentral(cfg, { repo: REPO }).modoPermissao, 'pedir', JSON.stringify(cfg));
  }
});

// ---------- A5d2: os 2 .vbs com a pasta montada e o modo ----------

const VBS_CENTRAL = path.join(RAIZ, 'central', 'abrir-central.vbs');
const VBS_SESSAO = path.join(RAIZ, 'central', 'abrir-sessao.vbs');
const CSCRIPT = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cscript.exe');

// A pasta montada de mentira (o que o gravarCentral grava): os arquivos que existem, vazios
function montadaTemp(arquivos) {
  const pasta = path.join(pastaTemp('a5d-montada-'), 'central');
  fs.mkdirSync(pasta);
  for (const a of arquivos) fs.writeFileSync(path.join(pasta, a), '');
  return pasta;
}

// cscript no abrir-central.vbs SO com o ensaio antes do 1o sh.Run (senao abriria a central de verdade) e com o claude
// recebido por argumento; LOCALAPPDATA temporario (nada gravado la)
function rodarCentral(args) {
  const fonte = fs.readFileSync(VBS_CENTRAL, 'utf8');
  const ensaio = fonte.indexOf('If amb("SESSOES_WPP_VBS_ENSAIO") = "1" Then');
  const run = fonte.search(/^sh\.Run /m);
  if (ensaio < 0 || run < ensaio || /%USERPROFILE%|\.local\\bin/i.test(fonte)) {
    throw new Error('abrir-central.vbs sem o ensaio antes do sh.Run: o teste nao roda o .vbs (abriria a central de verdade)');
  }
  const raiz = pastaTemp('a5d-vbs-');
  const vazia = path.join(raiz, 'path-vazio');
  const local = path.join(raiz, 'localappdata');
  fs.mkdirSync(vazia);
  fs.mkdirSync(local);
  const env = {
    SystemRoot: process.env.SystemRoot, windir: process.env.windir, TEMP: raiz, TMP: raiz, PATH: vazia, LOCALAPPDATA: local,
    SESSOES_WPP_VBS_ENSAIO: '1',
  };
  const r = spawnSync(CSCRIPT, ['//nologo', VBS_CENTRAL, ...args], { env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  return { status: r.status, linhas: String(r.stdout || '').split(/\r?\n/).filter(Boolean), stderr: String(r.stderr || ''), local };
}

test('A5d 16. abrir-central.vbs (cscript, ensaio): --permission-mode <modo>, --settings <montada>\\ajustes.json e --append-system-prompt-file <montada>\\instrucoes.md; o esconder-central.ps1 da pasta do .vbs; argumento faltando, vazio ou ruim = 2; montada ou arquivo que nao existe = 3', { skip: process.platform !== 'win32' }, () => {
  const raiz = pastaTemp('a5d-central-');
  const pasta = path.join(raiz, 'minha pasta');
  const claude = path.join(raiz, 'bin', 'claude.exe');
  fs.mkdirSync(pasta);
  fs.mkdirSync(path.dirname(claude));
  fs.writeFileSync(claude, '');
  const montada = montadaTemp(['instrucoes.md', 'ajustes.json']);
  const NOME = 'Minha Central';
  const dir = path.dirname(VBS_CENTRAL);
  for (const modo of ['bypassPermissions', 'auto']) {
    const r = rodarCentral([pasta, NOME, claude, montada, modo]);
    assert.equal(r.status, 0, `${modo}: ${r.stderr}`);
    assert.equal(r.linhas.length, 3, r.linhas.join('\n'));
    assert.equal(r.linhas[1].toLowerCase(), [
      `wt.exe -w new -p "${NOME}" --title "${NOME}" -d "${pasta}" "${claude}" -n "${NOME}" --permission-mode ${modo}`,
      `--settings "${montada}\\ajustes.json" --append-system-prompt-file "${montada}\\instrucoes.md"`,
    ].join(' ').toLowerCase());
    assert.equal(r.linhas[2].toLowerCase(),
      `powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${dir}\\esconder-central.ps1" -Titulos "${NOME}"`.toLowerCase());
    assert.deepEqual(fs.readdirSync(r.local), [], 'ensaio: nada gravado');
  }
  // saida 2: a montada e o modo faltando, vazios ou ruins
  const ok = [pasta, NOME, claude];
  for (const args of [ok, [...ok, montada], [...ok, montada, 'auto', 'x'], [...ok, '', 'auto'], [...ok, montada, ''],
    [...ok, montada, 'default'], [...ok, montada, 'Auto'], [...ok, montada, 'bypass'], [...ok, montada, 'plan'],
    [...ok, 'central', 'auto'], [...ok, `${montada}%x`, 'auto'], [...ok, `${montada};x`, 'auto'], [...ok, `${montada}"x`, 'auto'],
    [...ok, path.parse(montada).root, 'auto']]) {
    const x = rodarCentral(args);
    assert.equal(x.status, 2, JSON.stringify(args));
    assert.deepEqual(x.linhas, [], JSON.stringify(args));
  }
  // saida 3: a montada que nao existe ou sem um dos 2 arquivos
  for (const m of [path.join(raiz, 'nao-existe'), montadaTemp(['ajustes.json']), montadaTemp(['instrucoes.md'])]) {
    const x = rodarCentral([...ok, m, 'auto']);
    assert.equal(x.status, 3, m);
    assert.deepEqual(x.linhas, [], m);
  }
});

// O abrir-sessao.vbs de VERDADE (wscript) com um claude FALSO: o .vbs tem que ler o claude do SESSOES_WPP_CLAUDE (senao
// rodaria o claude de verdade; o teste nem roda)
async function rodarSessao(args, extra, saida) {
  const fonte = fs.readFileSync(VBS_SESSAO, 'utf8');
  if (!/^claude = amb\("SESSOES_WPP_CLAUDE"\)\r?$/m.test(fonte)) throw new Error('abrir-sessao.vbs sem o claude do ambiente: o teste nao roda');
  fs.rmSync(saida, { force: true });
  const env = { ...process.env, ...extra };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const r = spawnSync('wscript.exe', ['//nologo', VBS_SESSAO, ...args], { env, windowsHide: true, timeout: 20000 });
  let lido = null;
  if (r.status === 0) {
    for (let i = 0; i < 100 && lido === null; i++) {
      try { lido = JSON.parse(fs.readFileSync(saida, 'utf8')); } catch { await new Promise((ok) => setTimeout(ok, 100)); }
    }
  } else {
    await new Promise((ok) => setTimeout(ok, 300));
    lido = fs.existsSync(saida) ? 'rodou' : null;
  }
  return { status: r.status, lido };
}

test('A5d 17. abrir-sessao.vbs de verdade (claude falso): SESSOES_WPP_MONTADA e SESSOES_WPP_MODO do ambiente viram --permission-mode <modo>, --settings <montada>\\ajustes.json e --append-system-prompt-file <montada>\\instrucoes-sessao.md; ausente ou ruim = 2 (nunca o bypass por falta); montada ou arquivo que nao existe = 3; os argumentos de hoje iguais', { skip: process.platform !== 'win32' }, async () => {
  const raiz = pastaTemp('a5d vbs sessao ');
  const pasta = path.join(raiz, 'Área de trabalho');
  fs.mkdirSync(pasta, { recursive: true });
  const saida = path.join(raiz, 'saida.json');
  const falsoJs = path.join(raiz, 'claude-falso.cjs');
  fs.writeFileSync(falsoJs, `require('fs').writeFileSync(process.env.SAIDA_FALSO, JSON.stringify({ argv: process.argv.slice(2) }));\n`);
  const falsoCmd = path.join(raiz, 'bin com espaco', 'claude.cmd');
  fs.mkdirSync(path.dirname(falsoCmd), { recursive: true });
  fs.writeFileSync(falsoCmd, `@echo off\r\n"${process.execPath}" "${falsoJs}" %*\r\n`);
  const montada = montadaTemp(['instrucoes-sessao.md', 'ajustes.json']);
  const SID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  const base = { SESSOES_WPP_CLAUDE: falsoCmd, SAIDA_FALSO: saida, SESSOES_WPP_MONTADA: montada, SESSOES_WPP_MODO: 'auto' };
  const fim = (modo) => ['--permission-mode', modo, '--settings', path.join(montada, 'ajustes.json'),
    '--append-system-prompt-file', path.join(montada, 'instrucoes-sessao.md')];
  for (const modo of ['auto', 'bypassPermissions']) {
    const r = await rodarSessao([pasta, 'Projeto Atlas'], { ...base, SESSOES_WPP_MODO: modo }, saida);
    assert.equal(r.status, 0, modo);
    assert.deepEqual(r.lido?.argv, ['-n', 'Projeto Atlas', ...fim(modo)], modo);
  }
  // a retomada (3 argumentos) igual a de hoje
  const r = await rodarSessao([pasta, '', SID], base, saida);
  assert.equal(r.status, 0);
  assert.deepEqual(r.lido?.argv, ['--resume', SID, ...fim('auto')]);
  // saida 2: a variavel faltando, vazia ou ruim (o claude falso nao roda)
  for (const extra of [{ SESSOES_WPP_MONTADA: undefined }, { SESSOES_WPP_MODO: undefined }, { SESSOES_WPP_MONTADA: '' },
    { SESSOES_WPP_MODO: '' }, { SESSOES_WPP_MODO: 'default' }, { SESSOES_WPP_MODO: 'Auto' }, { SESSOES_WPP_MODO: 'bypass' },
    { SESSOES_WPP_MONTADA: 'central' }, { SESSOES_WPP_MONTADA: `${montada}%x` }, { SESSOES_WPP_MONTADA: `${montada};x` },
    { SESSOES_WPP_MONTADA: path.parse(montada).root }]) {
    const x = await rodarSessao([pasta, 'Projeto Atlas'], { ...base, ...extra }, saida);
    assert.equal(x.status, 2, JSON.stringify(extra));
    assert.equal(x.lido, null, `o claude falso nao rodou: ${JSON.stringify(extra)}`);
  }
  // saida 3: a montada que nao existe ou sem um dos 2 arquivos
  for (const m of [path.join(raiz, 'nao-existe'), montadaTemp(['ajustes.json']), montadaTemp(['instrucoes-sessao.md'])]) {
    const x = await rodarSessao([pasta, 'Projeto Atlas'], { ...base, SESSOES_WPP_MONTADA: m }, saida);
    assert.equal(x.status, 3, m);
    assert.equal(x.lido, null, m);
  }
  fs.rmSync(raiz, { recursive: true, force: true });
});

test('A5d 18. settings-central.json saiu (o ajustes.json montado substitui) e os 2 .vbs nao leem mais nada de instrucao nem ajuste da pasta do repositorio', () => {
  assert.equal(fs.existsSync(path.join(RAIZ, 'central', 'settings-central.json')), false);
  for (const vbs of [VBS_CENTRAL, VBS_SESSAO]) {
    const fonte = fs.readFileSync(vbs, 'utf8');
    assert.ok(!fonte.includes('settings-central'), `${path.basename(vbs)} sem settings-central`);
    assert.doesNotMatch(fonte, /central & "\\instrucoes/, `${path.basename(vbs)}: instrucoes da montada`);
    assert.match(fonte, /montada & "\\ajustes\.json"/, `${path.basename(vbs)}: ajustes da montada`);
  }
});

// ---------- A5d2: o porteiro monta a central a cada abertura ----------

const MONTADA = 'D:\\estado\\central';
const ESTADO = 'D:\\estado';
const CLAUDE = 'D:\\bin\\claude.exe';

// spawn falso do wscript: devolve o filho e SO DEPOIS emite 'spawn' (central) ou 'exit' 0 (escondida); anota a ordem
function spawnFalso(evento, ordem) {
  const chamadas = [];
  const fn = (cmd, args, opts) => {
    const filho = new EventEmitter();
    filho.unref = () => {};
    filho.kill = () => true;
    chamadas.push({ cmd, args, opts });
    ordem?.push('spawn');
    setImmediate(() => (evento === 'exit' ? filho.emit('exit', 0, null) : filho.emit('spawn')));
    return filho;
  };
  fn.chamadas = chamadas;
  return fn;
}

// gravarCentral dublado: anota as opcoes e a ordem; devolve `resposta(opcoes)` (padrao: a montada com o modo pedido)
function gravarDuble(ordem, resposta = (o) => ({ pasta: MONTADA, modo: o.modo })) {
  const fn = (o) => {
    fn.chamadas.push(o);
    ordem?.push('gravar');
    return resposta(o);
  };
  fn.chamadas = [];
  return fn;
}

test('A5d 19. abrirCentralReal: gravarCentral ANTES do wscript, a cada abertura, com {estadoDir, repo, dono, central, raizes, modo, node, procedencia, log}; a montada e o modo (pedir = auto, sozinha = bypassPermissions) nos argumentos 4 e 5', { skip: SO_WINDOWS }, async () => {
  const log = () => {};
  const ordem = [];
  const sp = spawnFalso('spawn', ordem);
  const gravar = gravarDuble(ordem);
  const abrir = porteiro.abrirCentralReal(log, {
    spawn: sp, gravarCentral: gravar, central: { pasta: 'E:\\central', nome: 'Minha Central' }, claude: CLAUDE,
    estadoDir: ESTADO, dono: DONO, raizes: RAIZES, env: {},
  });
  assert.equal(gravar.chamadas.length, 0, 'monta na abertura, nao na criacao');
  await abrir();
  assert.deepEqual(ordem, ['gravar', 'spawn']);
  assert.deepEqual(gravar.chamadas[0], {
    estadoDir: ESTADO, repo: RAIZ, dono: DONO, central: 'Minha Central', raizes: RAIZES, modo: 'pedir', node: process.execPath,
    procedencia: true, log,
  });
  assert.deepEqual(sp.chamadas[0].args, ['//nologo', VBS_CENTRAL, 'E:\\central', 'Minha Central', CLAUDE, MONTADA, 'auto']);
  // a proxima abertura monta de novo (a regra do dono editada vale sem religar)
  await abrir();
  assert.deepEqual(ordem, ['gravar', 'spawn', 'gravar', 'spawn']);
  // sozinha = bypassPermissions; o modo que volta do gravarCentral manda (outro valor = auto, o seguro)
  for (const [modoCfg, resposta, esperado] of [
    ['sozinha', (o) => ({ pasta: MONTADA, modo: o.modo }), 'bypassPermissions'],
    ['sozinha', () => ({ pasta: MONTADA, modo: 'pedir' }), 'auto'],
    ['sozinha', () => ({ pasta: MONTADA }), 'auto'],
    ['pedir', () => ({ pasta: MONTADA, modo: 'x' }), 'auto'],
  ]) {
    const sp2 = spawnFalso('spawn');
    const g2 = gravarDuble(null, resposta);
    await porteiro.abrirCentralReal(log, { spawn: sp2, gravarCentral: g2, central: { pasta: 'E:\\central', modoPermissao: modoCfg }, claude: CLAUDE, estadoDir: ESTADO, env: {} })();
    assert.equal(g2.chamadas[0].modo, modoCfg);
    assert.deepEqual(sp2.chamadas[0].args.slice(5), [MONTADA, esperado], `${modoCfg} ${esperado}`);
  }
});

test('A5d 20. abrirCentralReal: gravarCentral null (ou que lanca, ou montada ruim) = rejeita sem o wscript; claude ruim = nem monta; sem a pasta de estado o gravarCentral de verdade devolve null (nunca abre sem a montada)', async () => {
  for (const resposta of [() => null, () => undefined, () => ({}), () => ({ pasta: '' }), () => { throw new Error('x'); },
    () => ({ pasta: 'D:\\a%b\\central', modo: 'pedir' }), () => ({ pasta: 'D:\\a"b', modo: 'pedir' }), () => ({ pasta: 'D:\\a;b', modo: 'pedir' })]) {
    const sp = spawnFalso('spawn');
    const g = gravarDuble(null, resposta);
    await assert.rejects(porteiro.abrirCentralReal(() => {}, { spawn: sp, gravarCentral: g, central: { pasta: 'E:\\central' }, claude: CLAUDE, estadoDir: ESTADO, env: {} })(), String(resposta));
    assert.equal(g.chamadas.length, 1);
    assert.equal(sp.chamadas.length, 0, String(resposta));
  }
  const sp = spawnFalso('spawn');
  const g = gravarDuble();
  await assert.rejects(porteiro.abrirCentralReal(() => {}, { spawn: sp, gravarCentral: g, central: { pasta: 'E:\\central' }, claude: 'D:\\x"\\claude.exe', estadoDir: ESTADO })());
  assert.deepEqual([g.chamadas.length, sp.chamadas.length], [0, 0], 'claude ruim: nem monta nem abre');
  // o gravarCentral de verdade (padrao) sem a pasta de estado: null, 1 linha de log e nada aberto
  const linhas = [];
  const sp3 = spawnFalso('spawn');
  await assert.rejects(porteiro.abrirCentralReal((l) => linhas.push(l), { spawn: sp3, central: { pasta: 'E:\\central' }, claude: CLAUDE })());
  assert.equal(sp3.chamadas.length, 0);
  assert.equal(linhas.length, 1);
  assert.match(linhas[0], /^central: nao montei as instrucoes/);
});

test('A5d 21. abrirCentralReal com o gravarCentral de verdade (pasta temporaria): monta <estado>/central e passa a pasta; EXPERT_NO_PROVENANCE=1 tira a procedencia (so "1"); dono sem nome configurado = null (sem a linha do dono)', { skip: SO_WINDOWS }, async () => {
  const estado = pastaTemp('a5d-');
  const pasta = path.join(estado, 'central');
  const instr = () => fs.readFileSync(path.join(pasta, 'instrucoes.md'), 'utf8');
  const abrir = (env, dono, gravarCentral) => {
    const sp = spawnFalso('spawn');
    const p = porteiro.abrirCentralReal(() => {}, { spawn: sp, gravarCentral, central: { pasta: 'E:\\central', nome: NOME_CENTRAL }, claude: CLAUDE, estadoDir: estado, dono, raizes: RAIZES, env })();
    return p.then(() => sp);
  };
  const sp = await abrir({}, DONO);
  assert.deepEqual(sp.chamadas[0].args.slice(5), [pasta, 'auto']);
  assert.ok(instr().endsWith(`\n${PROC}\n`), 'com a procedencia');
  assert.ok(instr().includes('Neste PC, o dono é o Davi.'));
  for (const [valor, com] of [['1', false], ['0', true], ['', true], ['true', true], [' 1', true]]) {
    await abrir({ EXPERT_NO_PROVENANCE: valor }, DONO);
    assert.equal(instr().includes(PROC), com, JSON.stringify(valor));
  }
  // o dono: o bloco do config passa pelo donoDoConfig; sem nome valido = null (nunca "o dono é o dono")
  for (const [dono, esperado] of [
    [DONO, DONO], [{ nome: '  Davi  ', artigo: ' A ' }, { nome: 'Davi', artigo: 'a' }], [{ nome: 'Davi' }, { nome: 'Davi', artigo: '' }],
    [undefined, null], [null, null], [{}, null], [{ nome: '' }, null], [{ nome: '   ' }, null], [{ nome: 5 }, null], ['Davi', null],
    [{ artigo: 'o', fuso: 'America/Sao_Paulo' }, null],
  ]) {
    const g = gravarDuble();
    await abrir({}, dono, g);
    assert.deepEqual(g.chamadas[0].dono, esperado, JSON.stringify(dono));
  }
  await abrir({}, {});
  assert.ok(!instr().includes('Neste PC, o dono'), 'sem nome = sem a linha do dono');
  assert.ok(!instr().includes('o dono é o dono'));
});

test('A5d 22. abrirSessaoEscondidaReal: gravarCentral ANTES do wscript, a cada abertura, com os mesmos valores da central; a montada e o modo vao no ambiente do wscript (SESSOES_WPP_MONTADA, SESSOES_WPP_MODO); os argumentos de hoje iguais; null = rejeita sem o wscript; nome ruim = nem monta', { skip: SO_WINDOWS }, async () => {
  const log = () => {};
  const PASTA = 'C:\\projetos\\x';
  const ordem = [];
  const sp = spawnFalso('exit', ordem);
  const gravar = gravarDuble(ordem);
  const abrir = porteiro.abrirSessaoEscondidaReal({
    spawn: sp, gravarCentral: gravar, log, central: { pasta: 'E:\\central', nome: 'Minha Central' }, claude: CLAUDE,
    estadoDir: ESTADO, dono: DONO, raizes: RAIZES,
    env: { USERPROFILE: 'C:\\Users\\P', SESSOES_WPP_MONTADA: 'X:\\velha', SESSOES_WPP_MODO: 'bypassPermissions', EXPERT_NO_PROVENANCE: '1' },
  });
  assert.equal(gravar.chamadas.length, 0, 'monta na abertura, nao na criacao');
  await abrir(PASTA, 'Projeto Atlas');
  assert.deepEqual(ordem, ['gravar', 'spawn']);
  assert.deepEqual(gravar.chamadas[0], {
    estadoDir: ESTADO, repo: RAIZ, dono: DONO, central: 'Minha Central', raizes: RAIZES, modo: 'pedir', node: process.execPath,
    procedencia: false, log,
  });
  assert.deepEqual(sp.chamadas[0].args, ['//nologo', VBS_SESSAO, PASTA, 'Projeto Atlas']);
  const env = sp.chamadas[0].opts.env;
  assert.deepEqual([env.SESSOES_WPP_MONTADA, env.SESSOES_WPP_MODO, env.SESSOES_WPP_CLAUDE, env.USERPROFILE], [MONTADA, 'auto', CLAUDE, 'C:\\Users\\P']);
  // a retomada tambem monta (e de novo: a cada abertura)
  const SID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  await abrir(PASTA, null, { retomar: SID });
  assert.deepEqual(ordem, ['gravar', 'spawn', 'gravar', 'spawn']);
  assert.deepEqual(sp.chamadas[1].args, ['//nologo', VBS_SESSAO, PASTA, '', SID]);
  // sozinha = bypassPermissions; sem o claude = sem a variavel dele (como antes), com a montada
  const sp2 = spawnFalso('exit');
  const g2 = gravarDuble();
  await porteiro.abrirSessaoEscondidaReal({ spawn: sp2, gravarCentral: g2, central: { modoPermissao: 'sozinha' }, estadoDir: ESTADO, env: {} })(PASTA, 'Projeto Atlas');
  assert.equal(g2.chamadas[0].modo, 'sozinha');
  assert.equal(g2.chamadas[0].procedencia, true);
  assert.equal(g2.chamadas[0].dono, null);
  assert.deepEqual(g2.chamadas[0].raizes, []);
  assert.equal(sp2.chamadas[0].opts.env.SESSOES_WPP_MODO, 'bypassPermissions');
  assert.equal('SESSOES_WPP_CLAUDE' in sp2.chamadas[0].opts.env, false);
  // null (ou montada ruim) = rejeita sem o wscript
  for (const resposta of [() => null, () => ({ pasta: 'D:\\a%b', modo: 'pedir' }), () => { throw new Error('x'); }]) {
    const sp3 = spawnFalso('exit');
    const g3 = gravarDuble(null, resposta);
    await assert.rejects(porteiro.abrirSessaoEscondidaReal({ spawn: sp3, gravarCentral: g3, estadoDir: ESTADO, env: {} })(PASTA, 'Projeto Atlas'));
    assert.equal(sp3.chamadas.length, 0, String(resposta));
  }
  // nome ou pasta ruim: rejeita sem montar nem abrir
  for (const [p, n] of [[PASTA, 'a"b'], ['', 'Projeto Atlas']]) {
    const sp4 = spawnFalso('exit');
    const g4 = gravarDuble();
    await assert.rejects(porteiro.abrirSessaoEscondidaReal({ spawn: sp4, gravarCentral: g4, estadoDir: ESTADO, env: {} })(p, n));
    assert.deepEqual([g4.chamadas.length, sp4.chamadas.length], [0, 0]);
  }
  // o gravarCentral de verdade sem a pasta de estado: rejeita, 1 linha no log, nada aberto
  const linhas = [];
  const sp5 = spawnFalso('exit');
  await assert.rejects(porteiro.abrirSessaoEscondidaReal({ spawn: sp5, log: (l) => linhas.push(l), env: {} })(PASTA, 'Projeto Atlas'));
  assert.equal(sp5.chamadas.length, 0);
  assert.equal(linhas.length, 1);
});

test('A5d 23. o rodar passa a montagem aos 2 abridores: a pasta de estado, o bloco dono do config (cru: o donoDoConfig devolve o padrao "dono" quando falta o nome), as pastas de projeto, a central e o log', () => {
  const fonte = fs.readFileSync(path.join(RAIZ, 'porteiro.mjs'), 'utf8');
  const ini = fonte.indexOf('async function rodar(');
  const fim = fonte.slice(ini + 1).search(/\n(?:async )?function /);
  const rodar = fim === -1 ? fonte.slice(ini) : fonte.slice(ini, ini + 1 + fim);
  assert.match(rodar, /const montagem = \{ estadoDir: C\.estadoDir, dono: cfg\.dono, raizes: sessoes\.raizes \};/);
  assert.match(rodar, /abrirCentral: abrirCentralReal\(log, \{ central, claude, env, \.\.\.montagem \}\)/);
  assert.match(rodar, /abrirSessaoEscondida: abrirSessaoEscondidaReal\(\{ env, claude, central, log, \.\.\.montagem \}\)/);
  // por que o bloco cru: sem nome, o donoDoConfig devolve o padrao (montaria "Neste PC, o dono é o dono.")
  assert.equal(config.donoDoConfig({}).nome, config.PADRAO_DONO.nome);
  assert.equal(config.nomeDoDonoValido(undefined), null);
});

// ---------- A5d2: o instalador ----------

test('A5d 24. instalador: MINIMO.claude 2.1.295 (o onFailure do hook); a pergunta 9 da skill com o texto do contrato (Cuidadosa / Livre), gravando central.modoPermissao pedir / sozinha', () => {
  assert.equal(instalar.MINIMO.claude, '2.1.295');
  const skill = fs.readFileSync(path.join(RAIZ, '.claude', 'skills', 'instalar', 'SKILL.md'), 'utf8');
  const p9 = /^9\. ([\s\S]*?)\r?\n(?=\d+\. )/m.exec(skill)?.[1].replace(/\s+/g, ' ') ?? '';
  assert.equal(p9, '"Central (a sessão que recebe o que você manda pelo celular)": Cuidadosa (recomendado): faz o que o Claude '
    + 'Code libera sozinho e te conta o que ficou de fora / Livre: age sem pedir licença, como uma aba em modo bypass. Vira '
    + '`central.modoPermissao`: `pedir` ou `sozinha`.');
  assert.ok(!skill.includes('Pede licença antes de agir'), 'o texto do rascunho saiu');
});
