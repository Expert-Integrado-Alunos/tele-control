// Testes do M3 do porte pro Mac (PLANO-MAC.md, "Mapa", linha 2, e "Plano B", linha M3): no Mac a central e a sessao
// escondida (nova e retomada) sobem numa sessao tmux destacada, no servidor tmux so do Tele Control
// (`tmux -L tele-control`); VS Code e Orca nao abrem pelo porteiro no Mac.
// Isolamento: a plataforma e trocada pra darwin no `before` e desfeita no `after` (cada arquivo de teste roda num
// processo proprio: a troca nao vaza); o teste 6 volta pra win32 dentro do arquivo e prova que a troca desfaz. Nada roda
// tmux de verdade nem olha o disco: `spawn`, `existe` e `gravarCentral` sao dubles; dado sintetico.
// Rodar: node --test --test-reporter=tap "tests/mac-m3.test.mjs"
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { plataforma, trocarPlataformaParaTeste } from '../lib/plataforma.mjs';
import {
  nomeTmux, argsTmux, TMUX_SOCKET, abrirCentralReal, abrirSessaoEscondidaReal, abrirSessaoReal, abrirLinkReal,
  abrirNoOrcaReal, orcaAbertoReal,
} from '../porteiro.mjs';

const ORIGINAL = process.platform === 'darwin' ? 'darwin' : 'win32';
let desfazer = null;

before(() => {
  desfazer = trocarPlataformaParaTeste('darwin');
});

after(() => {
  desfazer?.();
  assert.equal(plataforma(), ORIGINAL, 'o after devolve a plataforma do processo');
});

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CENTRAL = '/Users/dono/central';
const PASTA = '/Users/dono/projetos/atlas';
const ESTADO = '/Users/dono/estado';
const MONTADA = '/Users/dono/estado/central';
const CLAUDE = '/Users/dono/.local/bin/claude';
const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const AGORA = 1700000000000;
const NO_MAC = /no Mac a sessao abre escondida \(tmux\); VS Code\/Orca nao abrem pelo porteiro/;

// spawn falso: anota (cmd, args, opts) e a ordem; no proximo tick o filho emite 'spawn' e 'exit' com `codigo` (como um
// processo de verdade) ou so o 'error' pedido
function spawnFalso({ codigo = 0, erro = null, ordem = null } = {}) {
  const chamadas = [];
  const fn = (cmd, args, opts) => {
    const filho = new EventEmitter();
    filho.unref = () => {};
    filho.kill = () => true;
    chamadas.push({ cmd, args, opts });
    ordem?.push('spawn');
    setImmediate(() => {
      if (erro) {
        filho.emit('error', erro);
        return;
      }
      filho.emit('spawn');
      filho.emit('exit', codigo, null);
    });
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

// existe dublado: o tipo de cada caminho pelo mapa (fora dele = null); anota as consultas
const NO_DISCO = Object.freeze({
  [CENTRAL]: 'pasta', [PASTA]: 'pasta', [CLAUDE]: 'arquivo', [MONTADA]: 'pasta',
  [`${MONTADA}/instrucoes.md`]: 'arquivo', [`${MONTADA}/instrucoes-sessao.md`]: 'arquivo', [`${MONTADA}/ajustes.json`]: 'arquivo',
});
function existeDuble(mapa = NO_DISCO) {
  const fn = (p) => {
    fn.chamadas.push(p);
    return mapa[p] ?? null;
  };
  fn.chamadas = [];
  return fn;
}
const sem = (chave) => Object.fromEntries(Object.entries(NO_DISCO).filter(([k]) => k !== chave));

test('M3 1. nomeTmux: minusculo, sem acento, sequencia fora de [a-z0-9] vira 1 -, sem - nas pontas, corte em 40, vazio = sessao (nunca . nem :); argsTmux: ordem exata, -e repetido, -- antes do comando, argumento com espaco segue 1 so', () => {
  assert.equal(TMUX_SOCKET, 'tele-control');
  assert.equal(nomeTmux('Sessão Ação'), 'sessao-acao');
  assert.equal(nomeTmux('  Projeto   Atlas  '), 'projeto-atlas');
  assert.equal(nomeTmux('v1.2: deploy'), 'v1-2-deploy');
  assert.equal(nomeTmux('a.b:c'), 'a-b-c');
  assert.equal(nomeTmux('-Ática-'), 'atica');
  assert.equal(nomeTmux('Central do Tele Control'), 'central-do-tele-control');
  assert.equal(nomeTmux(''), 'sessao');
  assert.equal(nomeTmux('   '), 'sessao');
  assert.equal(nomeTmux('.:!'), 'sessao');
  assert.equal(nomeTmux(null), 'sessao');
  assert.equal(nomeTmux('a'.repeat(50)), 'a'.repeat(40));
  // o corte que cai num - nao deixa o - no fim
  assert.equal(nomeTmux(`${'x'.repeat(39)} yz`), 'x'.repeat(39));
  for (const n of ['Sessão Ação', 'v1.2: deploy', 'a.b:c', `${'É'.repeat(30)}.${'b'.repeat(30)}`, 'çãõ ü:ñ', '..']) {
    const t = nomeTmux(n);
    assert.match(t, /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, `${n} -> ${t}`);
    assert.ok(!t.includes('.') && !t.includes(':'));
  }

  assert.deepEqual(
    argsTmux({ sessao: 'projeto-atlas-x', pasta: PASTA, comando: [CLAUDE, '-n', 'Projeto Atlas', '--settings', '/Users/dono/a b/ajustes.json'], extraEnv: { A: '1', B: 'x y' } }),
    ['-L', 'tele-control', 'new-session', '-d', '-s', 'projeto-atlas-x', '-c', PASTA, '-e', 'A=1', '-e', 'B=x y', '--',
      CLAUDE, '-n', 'Projeto Atlas', '--settings', '/Users/dono/a b/ajustes.json'],
  );
  // sem extraEnv = sem -e; o -- fica logo antes do comando
  assert.deepEqual(
    argsTmux({ sessao: 's', pasta: PASTA, comando: ['claude'] }),
    ['-L', 'tele-control', 'new-session', '-d', '-s', 's', '-c', PASTA, '--', 'claude'],
  );
});

test('M3 2. abrirCentralReal darwin: gravarCentral antes do spawn; 1 tmux com os args exatos (caminhos path.posix da montada); env sem as herdadas; resolve no exit 0', async () => {
  const ordem = [];
  const sp = spawnFalso({ ordem });
  const gravar = gravarDuble(ordem);
  const existe = existeDuble();
  const env = { HOME: '/Users/dono', PATH: '/usr/bin:/bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: UUID };
  const abrir = abrirCentralReal(() => {}, {
    spawn: sp, gravarCentral: gravar, existe, central: { pasta: CENTRAL, nome: 'Central Dono' }, claude: CLAUDE,
    estadoDir: ESTADO, env,
  });
  assert.equal(await abrir(), undefined);
  assert.deepEqual(ordem, ['gravar', 'spawn']);
  assert.equal(gravar.chamadas[0].central, 'Central Dono');
  assert.equal(sp.chamadas.length, 1);
  const { cmd, args, opts } = sp.chamadas[0];
  assert.equal(cmd, 'tmux');
  assert.deepEqual(args, [
    '-L', 'tele-control', 'new-session', '-d', '-s', 'central-dono', '-c', CENTRAL, '--',
    CLAUDE, '-n', 'Central Dono', '--permission-mode', 'auto',
    '--settings', path.posix.join(MONTADA, 'ajustes.json'), '--append-system-prompt-file', path.posix.join(MONTADA, 'instrucoes.md'),
  ]);
  assert.deepEqual(opts, { stdio: 'ignore', env: { HOME: '/Users/dono', PATH: '/usr/bin:/bin' } });
  assert.ok(existe.chamadas.includes(CENTRAL) && existe.chamadas.includes(CLAUDE) && existe.chamadas.includes(`${MONTADA}/instrucoes.md`));

  // sozinha = bypassPermissions; claude so com o nome (sem caminho) = o PATH do tmux acha, sem conferir no disco
  const sp2 = spawnFalso();
  const existe2 = existeDuble();
  await abrirCentralReal(() => {}, {
    spawn: sp2, gravarCentral: gravarDuble(), existe: existe2, central: { pasta: CENTRAL, modoPermissao: 'sozinha' },
    claude: 'claude', estadoDir: ESTADO, env: {},
  })();
  const a2 = sp2.chamadas[0].args;
  assert.deepEqual(a2.slice(0, 9), ['-L', 'tele-control', 'new-session', '-d', '-s', 'central-do-tele-control', '-c', CENTRAL, '--']);
  assert.deepEqual(a2.slice(9, 14), ['claude', '-n', 'Central do Tele Control', '--permission-mode', 'bypassPermissions']);
  assert.ok(!existe2.chamadas.includes('claude'));
});

test('M3 3. abrirCentralReal darwin: pasta que nao existe, montada sem instrucoes.md, caminho C:\\ ou claude que nao existe = rejeita SEM spawn; exit 1 (duplicate session) e error = rejeita', async () => {
  const base = { central: { pasta: CENTRAL }, claude: CLAUDE, estadoDir: ESTADO, env: {} };
  const casos = [
    ['pasta da central', { existe: existeDuble(sem(CENTRAL)) }, /nao existe/],
    ['montada sem instrucoes.md', { existe: existeDuble(sem(`${MONTADA}/instrucoes.md`)) }, /instrucoes\.md.*nao existe/],
    ['montada sem ajustes.json', { existe: existeDuble(sem(`${MONTADA}/ajustes.json`)) }, /ajustes\.json.*nao existe/],
    ['claude que nao existe', { existe: existeDuble(sem(CLAUDE)) }, /nao existe/],
    ['montada C:\\', { existe: existeDuble(), gravarCentral: gravarDuble(null, (o) => ({ pasta: 'C:\\projetos\\central', modo: o.modo })) }, /absoluto do Mac/],
    ['claude C:\\', { existe: existeDuble(), claude: 'C:\\projetos\\claude.exe' }, /absoluto do Mac/],
    ['claude relativo', { existe: existeDuble(), claude: 'bin/claude' }, /absoluto do Mac/],
    // pasta C:\ no config: no Mac nao vale (a do repositorio entra no lugar; no PC nem ela) = rejeita do mesmo jeito
    ['pasta C:\\', { existe: existeDuble(), central: { pasta: 'C:\\projetos' } }, /./],
  ];
  for (const [rotulo, extra, erro] of casos) {
    const sp = spawnFalso();
    await assert.rejects(
      abrirCentralReal(() => {}, { ...base, gravarCentral: gravarDuble(), ...extra, spawn: sp })(),
      erro,
      rotulo,
    );
    assert.equal(sp.chamadas.length, 0, `${rotulo}: sem spawn`);
  }
  // o tmux saiu com 1 (ex.: "duplicate session") = rejeita; o log conta
  const linhas = [];
  const sp1 = spawnFalso({ codigo: 1 });
  await assert.rejects(abrirCentralReal((l) => linhas.push(l), { ...base, gravarCentral: gravarDuble(), existe: existeDuble(), spawn: sp1 })(), /tmux saiu com 1/);
  // Mac-testes: depois da recusa, 1 consulta do list-sessions (aqui ela tambem sai com 1 = sem como saber = a recusa)
  assert.equal(sp1.chamadas.length, 2);
  assert.deepEqual(sp1.chamadas[1].args.slice(0, 3), ['-L', 'tele-control', 'list-sessions']);
  assert.ok(linhas.some((l) => /central falhou \(tmux\)/.test(l)));
  // 'error' (tmux fora do PATH) = rejeita com ele
  const enoent = Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' });
  const spE = spawnFalso({ erro: enoent });
  await assert.rejects(abrirCentralReal(() => {}, { ...base, gravarCentral: gravarDuble(), existe: existeDuble(), spawn: spE })(), /ENOENT/);
});

// Mac-testes: spawn falso por subcomando do tmux: `respostas[sub]` = lista de {codigo, saida} consumida em ordem (o
// ultimo se repete); o stdout sai antes do 'exit'
function spawnTmuxFalso(respostas) {
  const chamadas = [];
  const fn = (cmd, args, opts) => {
    const filho = new EventEmitter();
    filho.stdout = new EventEmitter();
    filho.unref = () => {};
    filho.kill = () => true;
    chamadas.push({ cmd, args, opts });
    const lista = respostas[args[2]] ?? [{ codigo: 0 }];
    const r = lista.length > 1 ? lista.shift() : lista[0];
    setImmediate(() => {
      filho.emit('spawn');
      if (r.saida) filho.stdout.emit('data', Buffer.from(r.saida));
      filho.emit('exit', r.codigo, null);
    });
    return filho;
  };
  fn.chamadas = chamadas;
  return fn;
}

test('M3 3b (Mac-testes). abrirCentralReal darwin: new-session recusado com a sessao de mesmo nome criada ha 3 min ou mais (a central presa sem registro) = kill-session e 1 new-session mais; mais nova, ausente ou a 2a recusa = rejeita sem 2a central', async () => {
  const AGORA_S = 1792729215;
  const base = { central: { pasta: CENTRAL }, claude: CLAUDE, estadoDir: ESTADO, env: {}, agora: () => AGORA_S * 1000 };
  const lista = (idadeS) => `${AGORA_S - 9000} outra-sessao\n${AGORA_S - idadeS} central-do-tele-control\n`;

  // orfa (3 min): fecha e abre de novo
  const linhas = [];
  const sp = spawnTmuxFalso({ 'new-session': [{ codigo: 1 }, { codigo: 0 }], 'list-sessions': [{ codigo: 0, saida: lista(180) }] });
  assert.equal(await abrirCentralReal((l) => linhas.push(l), { ...base, gravarCentral: gravarDuble(), existe: existeDuble(), spawn: sp })(), undefined);
  assert.deepEqual(sp.chamadas.map((c) => c.args[2]), ['new-session', 'list-sessions', 'kill-session', 'new-session']);
  assert.deepEqual(sp.chamadas[2].args, ['-L', 'tele-control', 'kill-session', '-t', '=central-do-tele-control']);
  assert.deepEqual(sp.chamadas[3].args, sp.chamadas[0].args, 'o mesmo new-session');
  assert.deepEqual(sp.chamadas[1].opts.env, {}, 'sem as herdadas');
  assert.ok(linhas.some((l) => /sessao tmux central-do-tele-control sobrou de uma abertura de 3 min atras/.test(l)));

  // mais nova que 3 min (ainda subindo), so outra sessao com o nome, ou list-sessions torto = a recusa de antes, sem kill
  for (const [rotulo, saida] of [['2 min', lista(179)], ['sem ela', `${AGORA_S - 900} outra-sessao\n`], ['torto', 'lixo\n']]) {
    const s = spawnTmuxFalso({ 'new-session': [{ codigo: 1 }], 'list-sessions': [{ codigo: 0, saida }] });
    await assert.rejects(abrirCentralReal(() => {}, { ...base, gravarCentral: gravarDuble(), existe: existeDuble(), spawn: s })(), /tmux saiu com 1/, rotulo);
    assert.deepEqual(s.chamadas.map((c) => c.args[2]), ['new-session', 'list-sessions'], rotulo);
  }

  // a 2a recusa (depois do kill) = rejeita, sem 3a tentativa
  const s2 = spawnTmuxFalso({ 'new-session': [{ codigo: 1 }], 'list-sessions': [{ codigo: 0, saida: lista(600) }] });
  await assert.rejects(abrirCentralReal(() => {}, { ...base, gravarCentral: gravarDuble(), existe: existeDuble(), spawn: s2 })(), /tmux saiu com 1/);
  assert.deepEqual(s2.chamadas.map((c) => c.args[2]), ['new-session', 'list-sessions', 'kill-session', 'new-session']);
});

test('M3 4. abrirSessaoEscondidaReal darwin: nova com nome (-n, -e SESSOES_WPP_ESCONDIDA=1, sufixo do agora); retomada sem nome (so --resume, sem -n); uuid invalido, nome com aspas, pasta que nao existe ou C:\\ = rejeita sem spawn', async () => {
  const ordem = [];
  const sp = spawnFalso({ ordem });
  const env = { HOME: '/Users/dono', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: UUID };
  const abrir = abrirSessaoEscondidaReal({
    spawn: sp, gravarCentral: gravarDuble(ordem), existe: existeDuble(), claude: CLAUDE, central: { nome: 'Minha Central' },
    estadoDir: ESTADO, env, agora: () => AGORA,
  });
  await abrir(PASTA, 'Projeto Atlas');
  assert.deepEqual(ordem, ['gravar', 'spawn']);
  const ajustes = path.posix.join(MONTADA, 'ajustes.json');
  const instrucoes = path.posix.join(MONTADA, 'instrucoes-sessao.md');
  assert.equal(sp.chamadas[0].cmd, 'tmux');
  assert.deepEqual(sp.chamadas[0].args, [
    '-L', 'tele-control', 'new-session', '-d', '-s', `projeto-atlas-${AGORA.toString(36)}`, '-c', PASTA,
    '-e', 'SESSOES_WPP_ESCONDIDA=1', '--',
    CLAUDE, '-n', 'Projeto Atlas', '--permission-mode', 'auto', '--settings', ajustes, '--append-system-prompt-file', instrucoes,
  ]);
  assert.deepEqual(sp.chamadas[0].opts, { stdio: 'ignore', env: { HOME: '/Users/dono' } });

  // retomada sem nome: so --resume <uuid>, sem -n; sessao tmux 'sessao-<agora>'; claude null = o claudeDoConfig do env
  const sp2 = spawnFalso();
  await abrirSessaoEscondidaReal({
    spawn: sp2, gravarCentral: gravarDuble(), existe: existeDuble(), central: { modoPermissao: 'sozinha' }, estadoDir: ESTADO,
    env: { HOME: '/Users/dono' }, agora: () => AGORA,
  })(PASTA, null, { retomar: UUID });
  assert.deepEqual(sp2.chamadas[0].args, [
    '-L', 'tele-control', 'new-session', '-d', '-s', `sessao-${AGORA.toString(36)}`, '-c', PASTA,
    '-e', 'SESSOES_WPP_ESCONDIDA=1', '--',
    '/Users/dono/.local/bin/claude', '--resume', UUID, '--permission-mode', 'bypassPermissions', '--settings', ajustes,
    '--append-system-prompt-file', instrucoes,
  ]);
  assert.ok(!sp2.chamadas[0].args.includes('-n'));

  // rejeita sem spawn (e sem montar, nos que a conferencia de antes ja pega)
  const casos = [
    ['uuid invalido', [PASTA, null, { retomar: 'nao-e-uuid' }], {}],
    ['nome com aspas', [PASTA, 'Projeto "Atlas"'], {}],
    ['pasta que nao existe', [PASTA, 'Projeto Atlas'], { existe: existeDuble(sem(PASTA)) }],
    ['montada sem instrucoes-sessao.md', [PASTA, 'Projeto Atlas'], { existe: existeDuble(sem(`${MONTADA}/instrucoes-sessao.md`)) }],
    ['pasta C:\\', ['C:\\projetos\\atlas', 'Projeto Atlas'], {}],
  ];
  for (const [rotulo, argsAbrir, extra] of casos) {
    const spx = spawnFalso();
    await assert.rejects(
      abrirSessaoEscondidaReal({ spawn: spx, gravarCentral: gravarDuble(), existe: existeDuble(), claude: CLAUDE, estadoDir: ESTADO, env: {}, ...extra })(...argsAbrir),
      (err) => err instanceof Error,
      rotulo,
    );
    assert.equal(spx.chamadas.length, 0, `${rotulo}: sem spawn`);
  }
  // o tmux saiu com 1 = rejeita
  const sp3 = spawnFalso({ codigo: 1 });
  await assert.rejects(
    abrirSessaoEscondidaReal({ spawn: sp3, gravarCentral: gravarDuble(), existe: existeDuble(), claude: CLAUDE, estadoDir: ESTADO, env: {} })(PASTA, 'Projeto Atlas'),
    /tmux saiu com 1/,
  );
});

test('M3 5. VS Code e Orca no darwin: abrirSessaoReal, abrirLinkReal e abrirNoOrcaReal rejeitam sem spawn; orcaAbertoReal = false sem execFile', async () => {
  const sp = spawnFalso();
  await assert.rejects(abrirSessaoReal({ spawn: sp, env: {} })(PASTA), NO_MAC);
  await assert.rejects(abrirLinkReal({ spawn: sp, env: {} })(3), NO_MAC);
  await assert.rejects(abrirNoOrcaReal({ spawn: sp, env: {}, existe: () => true, exe: '/Applications/Orca' })(PASTA, 'Projeto Atlas', { retomar: UUID }), NO_MAC);
  assert.equal(sp.chamadas.length, 0);
  let chamou = 0;
  const exec = (...a) => {
    chamou += 1;
    a[a.length - 1](null, '"Orca.exe","1"');
  };
  assert.equal(await orcaAbertoReal({ execFile: exec })(), false);
  assert.equal(chamou, 0);
});

test('M3 6. volta pra win32 no mesmo arquivo: abrirCentralReal chama o wscript.exe com os 5 argumentos de hoje e abrirSessaoEscondidaReal o wscript.exe com a letra do disco maiuscula (a troca desfaz)', async () => {
  const voltar = trocarPlataformaParaTeste('win32');
  try {
    assert.equal(plataforma(), 'win32');
    const montada = 'D:\\estado\\central';
    const gravar = (o) => ({ pasta: montada, modo: o.modo });
    const existe = existeDuble({});
    const sp = spawnFalso();
    await abrirCentralReal(() => {}, {
      spawn: sp, gravarCentral: gravar, existe, central: { pasta: 'C:\\projetos\\central', nome: 'Minha Central' },
      claude: 'C:\\ferramentas\\claude.exe', estadoDir: 'D:\\estado', env: {},
    })();
    assert.equal(sp.chamadas[0].cmd, 'wscript.exe');
    assert.deepEqual(sp.chamadas[0].args, [
      '//nologo', path.join(RAIZ, 'central', 'abrir-central.vbs'), 'C:\\projetos\\central', 'Minha Central',
      'C:\\ferramentas\\claude.exe', montada, 'auto',
    ]);
    assert.deepEqual(sp.chamadas[0].opts, { detached: true, stdio: 'ignore', windowsHide: true });

    const sp2 = spawnFalso();
    await abrirSessaoEscondidaReal({ spawn: sp2, gravarCentral: gravar, existe, estadoDir: 'D:\\estado', env: {} })('c:\\projetos\\atlas', 'Projeto Atlas');
    assert.equal(sp2.chamadas[0].cmd, 'wscript.exe');
    assert.deepEqual(sp2.chamadas[0].args, ['//nologo', path.join(RAIZ, 'central', 'abrir-sessao.vbs'), 'C:\\projetos\\atlas', 'Projeto Atlas']);
    assert.equal(sp2.chamadas[0].opts.env.SESSOES_WPP_MONTADA, montada);
    assert.equal(existe.chamadas.length, 0, 'no Windows o existe do Mac nao e consultado');

    // VS Code e Orca voltam a rodar no Windows (a recusa do Mac e so no darwin)
    const sp3 = spawnFalso();
    await abrirSessaoReal({ spawn: sp3, env: {} })('C:\\projetos\\atlas');
    assert.equal(sp3.chamadas[0].cmd, 'cmd.exe');
    let chamou = 0;
    const exec = (...a) => {
      chamou += 1;
      a[a.length - 1](null, '"Orca.exe","1"');
    };
    assert.equal(await orcaAbertoReal({ execFile: exec })(), true);
    assert.equal(chamou, 1);
  } finally {
    voltar();
  }
  assert.equal(plataforma(), 'darwin', 'a troca desfaz e volta pro darwin do arquivo');
});
