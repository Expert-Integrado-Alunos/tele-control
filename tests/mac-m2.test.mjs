// Testes do M2 do porte pro Mac (PLANO-MAC.md, "Mapa", linhas 2 a 6): o ocioso pelo ioreg, os processos pelo ps/kill
// (linhasDoPsMac, arvoreDe, processosReais), o canal de recado por socket Unix (temCanalDeRecado), o procStartMs, as
// pastas do VS Code no Mac (caminhoBancoVsCode, raizNormal, janelasVsCodeReal) e a chave do bot pelo Keychain
// (lerRegistroReal).
// Isolamento: a plataforma e trocada pra darwin no `before` e desfeita no `after` (cada arquivo de teste roda num
// processo proprio: a troca nao vaza); o teste 6 volta pra win32 dentro do arquivo e prova que a troca desfaz. Nada roda
// programa de verdade: exec, execSync, kill, ehSocket e execFile sao dubles; dado sintetico. So o teste 5 olha o disco,
// numa pasta temporaria (pastaTemp).
// Rodar: node --test --test-reporter=tap "tests/mac-m2.test.mjs"
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { plataforma, trocarPlataformaParaTeste } from '../lib/plataforma.mjs';
import {
  ociosoReal, linhasDoPsMac, arvoreDe, descendentesDe, processosReais, temCanalDeRecado, procStartMs, janelasVsCodeReal,
} from '../porteiro.mjs';
import { caminhoBancoVsCode, raizNormal } from '../lib/lista-vscode.mjs';
import { lerRegistroReal } from '../lib/registro.mjs';
import { pastaTemp } from './lib/pasta-temp.cjs';

const ORIGINAL = process.platform === 'darwin' ? 'darwin' : 'win32';
let desfazer = null;

before(() => {
  desfazer = trocarPlataformaParaTeste('darwin');
});

after(() => {
  desfazer?.();
  assert.equal(plataforma(), ORIGINAL, 'o after devolve a plataforma do processo');
});

// Duble do execFile (bin, args, opts, cb): guarda a chamada e responde no proximo tique
function execDuble(roteiro, chamadas) {
  return (bin, args, opts, cb) => {
    chamadas.push({ bin, args, opts });
    setImmediate(() => cb(roteiro.err ?? null, roteiro.stdout ?? '', roteiro.stderr ?? ''));
  };
}
// Relogio falso: devolve os tempos na ordem e repete o ultimo
const relogio = (...ts) => {
  const fila = [...ts];
  return () => (fila.length > 1 ? fila.shift() : fila[0]);
};
const msDe = (...a) => new Date(...a).getTime();

const IOREG_ARGS = ['-c', 'IOHIDSystem', '-d', '4', '-r', '-k', 'HIDIdleTime'];

test('M2 1. darwin: ociosoReal roda o ioreg (args e prazo de 20 s), o 1o HIDIdleTime em ns vira ms inteiro; sem ele = formato; killed = prazo', async () => {
  const chamadas = [];
  const rodar = (roteiro) => ociosoReal({ exec: execDuble(roteiro, chamadas), agora: relogio(1000, 1250) });
  const saida = [
    '+-o IOHIDSystem  <class IOHIDSystem, id 0x100000123, registered, matched, active, busy 0 (0 ms), retain 30>',
    '    {',
    '      "HIDIdleTime" = 1234567890',
    '      "HIDIdleTime" = 9999999999',
    '    }',
    '',
  ].join('\n');
  assert.equal(await rodar({ stdout: saida }), 1234, 'o 1o valor, ns -> ms (divisao inteira)');
  assert.deepEqual(chamadas, [{ bin: 'ioreg', args: IOREG_ARGS, opts: { timeout: 20000 } }]);
  assert.equal(await rodar({ stdout: '  "HIDIdleTime" = 9007199254740993999\n' }), 9007199254740, 'valor maior que 2^53 em ns: BigInt');
  assert.equal(await rodar({ stdout: '"HIDIdleTime"=0' }), 0);
  // sem HIDIdleTime = formato (a saida do powershell nao vale no Mac); stderr so a 1a linha
  assert.deepEqual(await rodar({ stdout: 'status=ok idle_ms=5\n', stderr: 'aviso do ioreg\nlinha 2' }), {
    falha: { motivo: 'formato', codigo: null, stderr: 'aviso do ioreg', duracaoMs: 250 },
  });
  assert.deepEqual(await rodar({ stdout: '"HIDIdleTime" = -5' }), { falha: { motivo: 'formato', codigo: null, stderr: '', duracaoMs: 250 } });
  // o execFile matou no prazo = prazo; codigo numerico = saida; ENOENT (sem ioreg) = abrir
  const morto = Object.assign(new Error('prazo'), { killed: true, signal: 'SIGTERM' });
  assert.deepEqual(await rodar({ err: morto }), { falha: { motivo: 'prazo', codigo: null, stderr: '', duracaoMs: 250 } });
  assert.equal((await rodar({ err: Object.assign(new Error('x'), { code: 1 }), stderr: 'ruim' })).falha.motivo, 'saida');
  assert.deepEqual((await rodar({ err: Object.assign(new Error('x'), { code: 'ENOENT' }) })).falha.codigo, 'ENOENT');
  assert.equal(chamadas.length, 8);
  assert.ok(chamadas.every((c) => c.bin === 'ioreg'), 'sempre o ioreg no Mac');
});

// Saida sintetica do `ps -o pid=,ppid=,lstart=,comm=` (LC_ALL=C)
const PS_LINHAS = [
  '  812     1 Tue Oct 20 23:45:01 2026 /Users/dono/.local/bin/claude',
  '  900   812 Tue Oct 20 23:45:03 2026 -zsh',
  '  950   900 Wed Oct 21 00:01:09 2026 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)',
  '  901   812 Tue Oct 20 23:45:01 2026 2.1.300',
  '  960   812 Tue Oct  6 09:05:01 2026 /bin/sh', // nasceu antes do pai: nao conta como filho
  'lixo',
  '  10 x Tue Oct 20 23:45:01 2026 /bin/sh', // ppid torto
  '  11   1 Tue Foo 20 23:45:01 2026 /bin/sh', // mes desconhecido
  '  12   1 Tue Feb 31 10:00:00 2026 /bin/sh', // data que nao existe
  '  13   1 Tue Oct 20 23:45:01 2026 -', // nome vazio
  '  14   1 Tue Oct 20 23:45:01 2026', // sem comm
  '',
].join('\r\n');

test('M2 2. linhasDoPsMac (pid, ppid, hora local, basename, -zsh, nome com espaco, torta fora) e arvoreDe/descendentesDe (o de hoje no formato do Windows)', () => {
  assert.equal(linhasDoPsMac(PS_LINHAS), [
    `812|1|${msDe(2026, 9, 20, 23, 45, 1)}|claude`,
    `900|812|${msDe(2026, 9, 20, 23, 45, 3)}|zsh`,
    `950|900|${msDe(2026, 9, 21, 0, 1, 9)}|Code Helper (Plugin)`,
    `901|812|${msDe(2026, 9, 20, 23, 45, 1)}|2.1.300`,
    `960|812|${msDe(2026, 9, 6, 9, 5, 1)}|sh`,
  ].join('\n'));
  assert.equal(linhasDoPsMac('  7 1 Mon Jan  5 01:02:03 2026 /bin/bash  '), `7|1|${msDe(2026, 0, 5, 1, 2, 3)}|bash`, 'dia com espaco, mes Jan = 0, espaco do fim fora');
  assert.equal(linhasDoPsMac(''), '');
  assert.equal(linhasDoPsMac(undefined), '');
  // arvoreDe na saida do Mac: filhos antes dos netos; o nascido antes do pai fica fora
  const mac = linhasDoPsMac(PS_LINHAS);
  assert.deepEqual(arvoreDe(mac, 812), [{ pid: 900, nome: 'zsh' }, { pid: 901, nome: '2.1.300' }, { pid: 950, nome: 'Code Helper (Plugin)' }]);
  assert.deepEqual(descendentesDe(mac, 812), ['zsh', '2.1.300', 'Code Helper (Plugin)']);
  assert.deepEqual(arvoreDe(mac, 950), []);
  assert.equal(arvoreDe(mac, 4242), null, 'pid fora da lista = null');
  // formato do Windows (o de hoje, conferido na BASE antes do refactor): mesmos nomes, ciclo nao trava, torta fora
  const win = ['100|4|1000|claude.exe', '200|100|1000|bash.exe', '300|200|2000|node.exe', '400|100|500|velho.exe', '500|400|3000|neto.exe',
    '600|700|3000|a.exe', '700|600|3000|b.exe', 'torta', '800|600|2999|c.exe'].join('\r\n');
  assert.deepEqual([100, 600, 700, 999, 300].map((p) => descendentesDe(win, p)), [['bash.exe', 'node.exe'], ['b.exe'], ['a.exe'], null, []]);
  assert.deepEqual(arvoreDe(win, 100), [{ pid: 200, nome: 'bash.exe' }, { pid: 300, nome: 'node.exe' }]);
  assert.deepEqual(arvoreDe(win, 600), [{ pid: 700, nome: 'b.exe' }]);
});

test('M2 3. darwin: processosReais com execSync/kill dubles: ps com LC_ALL=C, info (status 1 = null), filhos com nomes, matarArvore do mais fundo pro pid (ESRCH ignorado)', () => {
  const PS_UM = '  812     1 Tue Oct 20 23:45:01 2026 /Users/dono/.local/bin/claude\n';
  const PS_TODOS = [
    '    1     0 Tue Oct 20 08:00:00 2026 /sbin/launchd',
    '  812     1 Tue Oct 20 23:45:01 2026 /Users/dono/.local/bin/claude',
    '  900   812 Tue Oct 20 23:45:03 2026 -zsh',
    '  950   900 Tue Oct 20 23:46:00 2026 /usr/bin/python3',
    '  901   812 Tue Oct 20 23:45:02 2026 /bin/bash',
  ].join('\n');
  const chamadas = [];
  let resposta = null;
  const execSync = (bin, args, opts) => {
    chamadas.push({ bin, args, opts });
    if (resposta instanceof Error) throw resposta;
    return resposta;
  };
  const mortes = [];
  let falhaDoKill = {};
  const kill = (p, sinal) => {
    mortes.push([p, sinal]);
    if (falhaDoKill[p]) throw Object.assign(new Error('kill'), { code: falhaDoKill[p] });
  };
  const pr = processosReais({ execSync, kill });

  // info: ps -o ... -p <pid>, LC_ALL=C sobre o env do processo, 20 s, utf8
  resposta = PS_UM;
  assert.deepEqual(pr.info(812), { nome: 'claude', paiPid: 1, criadoEm: msDe(2026, 9, 20, 23, 45, 1) });
  const c0 = chamadas[0];
  assert.equal(c0.bin, 'ps');
  assert.deepEqual(c0.args, ['-o', 'pid=,ppid=,lstart=,comm=', '-p', '812']);
  assert.equal(c0.opts.timeout, 20000);
  assert.equal(c0.opts.encoding, 'utf8');
  assert.equal(c0.opts.env.LC_ALL, 'C');
  assert.ok(Object.entries(process.env).every(([k, v]) => k === 'LC_ALL' || c0.opts.env[k] === v), 'o resto do env do processo');
  assert.equal(c0.opts.maxBuffer, undefined);
  assert.equal(pr.info(4242), null, 'saida de outro pid = null');
  resposta = Object.assign(new Error('ps'), { status: 1 });
  assert.equal(pr.info(812), null, 'status 1 (pid nao existe) = null');
  resposta = Object.assign(new Error('ps quebrou'), { status: 2 });
  assert.throws(() => pr.info(812), /ps quebrou/, 'outro erro lanca');
  const antes = chamadas.length;
  assert.equal(pr.info(0), null);
  assert.equal(pr.info(1.5), null);
  assert.equal(chamadas.length, antes, 'pid ruim nem roda o ps');

  // filhos: ps -axo inteiro, 16 MB
  resposta = PS_TODOS;
  assert.deepEqual(pr.filhos(812), ['zsh', 'bash', 'python3']);
  const c1 = chamadas.at(-1);
  assert.deepEqual(c1.args, ['-axo', 'pid=,ppid=,lstart=,comm=']);
  assert.equal(c1.opts.maxBuffer, 16 * 1024 * 1024);
  assert.equal(c1.opts.env.LC_ALL, 'C');
  assert.equal(c1.opts.timeout, 20000);
  assert.equal(pr.filhos(4242), null, 'pid fora da lista = null');

  // matarArvore: do mais fundo pro mais raso, o pid por ultimo; ESRCH ignorado
  falhaDoKill = { 901: 'ESRCH' };
  assert.equal(pr.matarArvore(812), true);
  assert.deepEqual(mortes, [[950, 'SIGKILL'], [901, 'SIGKILL'], [900, 'SIGKILL'], [812, 'SIGKILL']]);
  mortes.length = 0;
  assert.equal(pr.matarArvore(4242), true, 'fora da lista = so ele');
  assert.deepEqual(mortes, [[4242, 'SIGKILL']]);
  mortes.length = 0;
  falhaDoKill = { 950: 'EPERM' };
  assert.throws(() => pr.matarArvore(812), (e) => e.code === 'EPERM', 'outro erro lanca');
  assert.equal(pr.matarArvore(-3), false);
  assert.deepEqual(mortes, [[950, 'SIGKILL']]);
});

test('M2 4. darwin: temCanalDeRecado pelo ehSocket (pipes ignorado; \\\\.\\pipe\\ = null; ausente = false) e procStartMs = null', () => {
  const vistos = [];
  const socket = (r) => (p) => {
    vistos.push(p);
    return r;
  };
  const reg = { messagingSocketPath: '/Users/dono/.claude/run/m2.sock' };
  assert.equal(temCanalDeRecado(reg, null, socket(true)), true);
  assert.equal(temCanalDeRecado(reg, new Set(['m2.sock']), socket(false)), false, 'o pipes nao vale no Mac');
  assert.equal(temCanalDeRecado(reg, new Set(), socket(null)), null, 'nao sabe = null');
  assert.deepEqual(vistos, Array(3).fill(reg.messagingSocketPath));
  const nunca = () => {
    throw new Error('nao devia olhar o disco');
  };
  assert.equal(temCanalDeRecado({ messagingSocketPath: '\\\\.\\pipe\\x' }, new Set(['x']), nunca), null, 'pipe do Windows = null');
  assert.equal(temCanalDeRecado({ messagingSocketPath: 'run/m2.sock' }, null, nunca), null, 'relativo = null');
  assert.equal(temCanalDeRecado({}, null, nunca), false, 'campo ausente = false');
  assert.equal(temCanalDeRecado({ messagingSocketPath: '' }, null, nunca), false);
  assert.equal(temCanalDeRecado({ messagingSocketPath: null }, null, nunca), false);
  assert.equal(temCanalDeRecado(null, null, nunca), false);
  assert.equal(temCanalDeRecado({ messagingSocketPath: 42 }, null, nunca), null, 'nao-string = null');
  // o padrao (ehSocketReal): caminho que nao existe = false (ENOENT)
  assert.equal(temCanalDeRecado({ messagingSocketPath: '/nao-existe-m2/run/x.sock' }), false);
  // procStartMs: null sempre no Mac (HIPOTESE: formato do procStart ainda nao medido)
  assert.equal(procStartMs('134353489160112846'), null);
  assert.equal(procStartMs(undefined), null);
});

// Monta uma raiz de logs do VS Code: a sessao mais nova sem main.log (o `code` cria vazia), a viva com window1 (com a
// extensao do Claude) e window3, e uma mais velha
function montarLogs(raiz) {
  const criar = (...partes) => fs.mkdirSync(path.join(raiz, ...partes), { recursive: true });
  criar('20261020T100000');
  criar('20261020T090000', 'window1', 'exthost', 'Anthropic.claude-code');
  criar('20261020T090000', 'window3');
  fs.writeFileSync(path.join(raiz, '20261020T090000', 'main.log'), 'x');
  criar('20261020T080000');
  fs.writeFileSync(path.join(raiz, '20261020T080000', 'main.log'), 'x');
}

test('M2 5. darwin: caminhoBancoVsCode pelo HOME (sem HOME = null; SESSOES_WPP_VSCODE_DB ganha; APPDATA nao vale), raizNormal POSIX e janelasVsCodeReal', () => {
  const banco = '/Users/dono/Library/Application Support/Code/User/globalStorage/state.vscdb';
  assert.equal(caminhoBancoVsCode({ HOME: '/Users/dono' }), banco);
  assert.equal(caminhoBancoVsCode({}), null, 'sem HOME = null');
  assert.equal(caminhoBancoVsCode({ HOME: '' }), null);
  assert.equal(caminhoBancoVsCode(null), null);
  assert.equal(caminhoBancoVsCode({ APPDATA: 'C:\\Users\\dono\\AppData\\Roaming' }), null, 'APPDATA nao vale no Mac');
  assert.equal(caminhoBancoVsCode({ HOME: '/Users/dono', SESSOES_WPP_VSCODE_DB: '/tmp/m2.vscdb' }), '/tmp/m2.vscdb', 'a variavel ganha');
  assert.equal(caminhoBancoVsCode({ HOME: '/Users/dono' }, '/x/banco.vscdb'), '/x/banco.vscdb', 'o banco do config ganha');
  // raizNormal: POSIX, sem as barras do fim (menos a raiz), minuscula
  assert.equal(raizNormal('/Users/Dono/Repos/'), '/users/dono/repos');
  assert.equal(raizNormal('/Users/dono/./a//b/../c///'), '/users/dono/a/c');
  assert.equal(raizNormal('/'), '/');
  assert.equal(raizNormal('//'), '/');
  assert.equal(raizNormal('/Users/dono/repos'), raizNormal('/users/DONO/repos/'));
  // janelasVsCodeReal: SESSOES_WPP_VSCODE_LOGS ganha; sem ela, o HOME do Mac; o APPDATA nao vale
  const base = pastaTemp('m2-vscode-');
  const logs = path.join(base, 'logs');
  const home = path.join(base, 'home');
  const appdata = path.join(base, 'appdata');
  montarLogs(logs);
  montarLogs(path.join(home, 'Library', 'Application Support', 'Code', 'logs'));
  montarLogs(path.join(appdata, 'Code', 'logs'));
  const esperado = { sessao: '20261020T090000', ids: [1, 3], comClaude: [1] };
  assert.deepEqual(janelasVsCodeReal({ env: { SESSOES_WPP_VSCODE_LOGS: logs, HOME: '/nao-existe-m2' } }), esperado, 'a variavel ganha do HOME');
  assert.deepEqual(janelasVsCodeReal({ env: { HOME: home, APPDATA: '/nao-existe-m2' } }), esperado, 'o HOME do Mac');
  assert.equal(janelasVsCodeReal({ env: { APPDATA: appdata } }), null, 'APPDATA nao vale no Mac');
  assert.equal(janelasVsCodeReal({ env: {} }), null, 'sem HOME = null');
});

test('M2 6. darwin: lerRegistroReal pelo Keychain (security; vazio e erro = null); volta pra win32: reg query, pipes, FILETIME, APPDATA e powershell', async () => {
  const chamadas = [];
  const rodar = (roteiro) => execDuble(roteiro, chamadas);
  assert.equal(await lerRegistroReal('TG_CHAVE_M2', rodar({ stdout: '  valor-de-teste\n' })), 'valor-de-teste');
  assert.deepEqual(chamadas[0], { bin: 'security', args: ['find-generic-password', '-s', 'TG_CHAVE_M2', '-w'], opts: { timeout: 10000 } });
  assert.equal(await lerRegistroReal('TG_CHAVE_M2', rodar({ stdout: ' \n' })), null, 'vazio = null');
  assert.equal(await lerRegistroReal('TG_CHAVE_M2', rodar({ err: new Error('nao achou'), stdout: 'lixo' })), null, 'erro = null');
  assert.equal(await lerRegistroReal('  ', rodar({ stdout: 'x' })), null, 'nome ruim = null');
  assert.equal(chamadas.length, 3, 'nome ruim nem roda o security');

  assert.throws(() => trocarPlataformaParaTeste('linux'), TypeError);
  const voltar = trocarPlataformaParaTeste('win32');
  try {
    assert.equal(plataforma(), 'win32');
    const saidaReg = '\r\nHKEY_CURRENT_USER\\Environment\r\n    TG_CHAVE_M2    REG_SZ    valor-win\r\n\r\n';
    assert.equal(await lerRegistroReal('TG_CHAVE_M2', rodar({ stdout: saidaReg })), 'valor-win');
    assert.deepEqual(chamadas.at(-1), {
      bin: 'reg', args: ['query', 'HKCU\\Environment', '/v', 'TG_CHAVE_M2'], opts: { windowsHide: true, timeout: 10000 },
    });
    const nunca = () => {
      throw new Error('o Windows nao olha socket');
    };
    assert.equal(temCanalDeRecado({ messagingSocketPath: '\\\\.\\pipe\\Claude-M2' }, new Set(['claude-m2']), nunca), true, 'usa o pipes');
    assert.equal(temCanalDeRecado({ messagingSocketPath: '\\\\.\\pipe\\Claude-M2' }, new Set(), nunca), false);
    assert.equal(temCanalDeRecado({ messagingSocketPath: '\\\\.\\pipe\\Claude-M2' }, null, nunca), null, 'listagem falhou');
    assert.equal(temCanalDeRecado({ messagingSocketPath: '/Users/dono/m2.sock' }, new Set(['m2.sock']), nunca), null, 'socket nao vale no Windows');
    assert.equal(procStartMs('134353489160112846'), 1790875316011, 'o FILETIME de hoje');
    const roaming = 'C:\\Users\\dono\\AppData\\Roaming';
    assert.equal(caminhoBancoVsCode({ APPDATA: roaming, HOME: '/Users/dono' }), path.join(roaming, 'Code', 'User', 'globalStorage', 'state.vscdb'));
    assert.equal(caminhoBancoVsCode({ HOME: '/Users/dono' }), null, 'o HOME nao vale no Windows');
    assert.equal(raizNormal('C:/Projetos/'), 'c:\\projetos');
    const ch = [];
    assert.equal(await ociosoReal({ exec: execDuble({ stdout: 'status=ok idle_ms=77\r\n' }, ch), agora: relogio(0) }), 77);
    assert.equal(ch[0].bin, 'powershell', 'o ocioso volta pro bin/ocioso.ps1');
    assert.deepEqual(ch[0].opts, { windowsHide: true, timeout: 20000 });
  } finally {
    voltar();
  }
  assert.equal(plataforma(), 'darwin', 'desfazer volta pro darwin');
  assert.equal(procStartMs('134353489160112846'), null);
});
