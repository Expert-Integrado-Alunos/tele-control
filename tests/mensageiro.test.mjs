// Testes de mensageiro.mjs (node:test, spawn dublado; nada de claude real, rede ou ~/.claude real).
// Rodar: node --test "tests/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pastaTemp } from './lib/pasta-temp.cjs';
import { criarMensageiro, montarRecado, lerSaida, ambienteDoMensageiro } from '../mensageiro.mjs';

const PEDIDO = {
  sessionId: 's-faro', nome: 'projetos-f3', titulo: 'Faro', texto: 'sim, pode preencher só os campos vazios',
  audio: false, hora: '15:05', providerMsgId: '3EB0AAAA0000BBBB1111CC', messageId: 'uuid-1', anexos: [],
};
const saida = (result, extra = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, ...extra });

// spawn dublado: cada chamada consome 1 roteiro {stdout, code, atrasoMs, trava} e guarda (bin, args, opts, inicio, fim).
function dubleSpawn(roteiros) {
  const chamadas = [];
  const fila = [...roteiros];
  function spawn(bin, args, opts) {
    const r = fila.shift() || { stdout: saida('ENVIADO') };
    const filho = new EventEmitter();
    filho.stdout = new EventEmitter();
    filho.stderr = new EventEmitter();
    if (r.pid !== undefined) filho.pid = r.pid; // R2 5: pid do claude -p (sem ele = spawn sem pid)
    const c = { bin, args, opts, inicio: Date.now(), fim: null, morto: false };
    chamadas.push(c);
    filho.kill = () => { c.morto = true; setImmediate(() => { c.fim = Date.now(); filho.emit('close', null, 'SIGTERM'); }); return true; };
    if (!r.trava) {
      setTimeout(() => {
        if (r.durante) r.durante();
        if (r.stdout) filho.stdout.emit('data', Buffer.from(r.stdout));
        if (r.stderr) filho.stderr.emit('data', Buffer.from(r.stderr));
        c.fim = Date.now();
        filho.emit('close', r.code ?? 0, null);
      }, r.atrasoMs ?? 5);
    }
    return filho;
  }
  return { spawn, chamadas };
}

function novo(roteiros, extra = {}) {
  const estadoDir = pastaTemp('mens-');
  const d = dubleSpawn(roteiros);
  const m = criarMensageiro({ claudeBin: 'C:/x/claude.exe', spawn: d.spawn, estadoDir, dormir: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))), ...extra });
  return { m, d, estadoDir };
}

test('1. ENVIADO: status enviado; args exatos, sem shell; PROMPT com o nome e a linha da fala', async () => {
  const { m, d, estadoDir } = novo([{ stdout: saida('ENVIADO') }]);
  const r = await m.entregar(PEDIDO);
  assert.equal(r.status, 'enviado');
  const c = d.chamadas[0];
  assert.equal(c.bin, 'C:/x/claude.exe');
  const prompt = c.args[1];
  assert.deepEqual(c.args, ['-p', prompt, '--model', 'sonnet', '--allowedTools', 'SendMessage,ListAgents,ToolSearch',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--output-format', 'json']);
  assert.notEqual(c.opts.shell, true);
  assert.equal(c.opts.cwd, estadoDir);
  assert.equal(c.opts.env.SESSOES_WPP_MENSAGEIRO, '1');
  assert.equal(c.opts.env.CLAUDE_CODE_SESSION_ID, undefined, 'nunca herda a identidade da aba que abriu o porteiro');
  assert.match(prompt, /nome é exatamente "projetos-f3"/);
  assert.match(prompt, /to "projetos-f3"/);
  assert.ok(prompt.includes('> WhatsApp do dono (15:05): «sim, pode preencher só os campos vazios»'));
  assert.ok(prompt.includes('WhatsApp do dono (15:05, id 3EB0AAAA0000BBBB1111CC)'));
  assert.equal(existsSync(join(estadoDir, 'mensageiro.lock')), false, 'trava liberada no fim');
});

test('2. NAO_ACHEI / DUPLICADO / is_error / exit 1 / saida estranha / timeout -> status certo, sem despejar stdout', async () => {
  const lixo = 'x'.repeat(5000);
  const { m } = novo([
    { stdout: saida('NAO_ACHEI') },
    { stdout: saida('DUPLICADO') },
    { stdout: saida('ENVIADO', { is_error: true }) },
    { stdout: saida('ENVIADO'), code: 1 },
    { stdout: lixo },
    { trava: true },
  ], { timeoutMs: 30 });
  assert.equal((await m.entregar(PEDIDO)).status, 'nao_achei');
  assert.equal((await m.entregar(PEDIDO)).status, 'duplicado');
  for (let i = 0; i < 4; i++) {
    const r = await m.entregar(PEDIDO);
    assert.equal(r.status, 'erro');
    assert.ok(String(r.detalhe).length <= 300, 'detalhe curto');
  }
});

test('lerSaida: 1 token so; dois tokens diferentes = erro', () => {
  assert.equal(lerSaida(saida('ENVIADO'), 0).status, 'enviado');
  assert.equal(lerSaida(saida('Pronto: ENVIADO'), 0).status, 'enviado');
  assert.equal(lerSaida(saida('NAO_ACHEI ou ENVIADO'), 0).status, 'erro');
  assert.equal(lerSaida('', 0).status, 'erro');
});

test('3. duas entregas ao mesmo tempo: a 2a so dispara depois da 1a terminar; trava velha de pid morto sai', async () => {
  const { m, d } = novo([{ stdout: saida('ENVIADO'), atrasoMs: 60 }, { stdout: saida('ENVIADO'), atrasoMs: 5 }]);
  const [a, b] = await Promise.all([m.entregar(PEDIDO), m.entregar(PEDIDO)]);
  assert.equal(a.status, 'enviado');
  assert.equal(b.status, 'enviado');
  assert.ok(d.chamadas[1].inicio >= d.chamadas[0].fim, 'sequencial');

  const x = novo([{ stdout: saida('ENVIADO') }], { esperaTravaMs: 300 });
  writeFileSync(join(x.estadoDir, 'mensageiro.lock'), JSON.stringify({ pid: 999999, at: new Date().toISOString() }));
  assert.equal((await x.m.entregar(PEDIDO)).status, 'enviado');
});

test('3b. trava viva de outro processo por mais que o limite -> erro sem disparar', async () => {
  const x = novo([{ stdout: saida('ENVIADO') }], { esperaTravaMs: 30 });
  writeFileSync(join(x.estadoDir, 'mensageiro.lock'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  const r = await x.m.entregar(PEDIDO);
  assert.equal(r.status, 'erro');
  assert.equal(x.d.chamadas.length, 0);
  assert.ok(existsSync(join(x.estadoDir, 'mensageiro.lock')), 'nao apaga trava viva de outro');
  assert.equal(JSON.parse(readFileSync(join(x.estadoDir, 'mensageiro.lock'), 'utf8')).pid, process.pid);
});

test('3c. trava tomada por outro no meio (a nossa foi julgada velha) nao e apagada no fim', async () => {
  let estadoDir;
  const alheia = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token: 'de-outro' });
  const x = novo([{ stdout: saida('ENVIADO'), durante: () => writeFileSync(join(estadoDir, 'mensageiro.lock'), alheia) }]);
  estadoDir = x.estadoDir;
  assert.equal((await x.m.entregar(PEDIDO)).status, 'enviado');
  assert.equal(JSON.parse(readFileSync(join(estadoDir, 'mensageiro.lock'), 'utf8')).token, 'de-outro');
});

test('4. fala com quebras e > 300 chars: fala1 de 1 linha cortada; corpo intacto; RECADO>>> neutralizado', () => {
  const longa = `linha um\n\nlinha   dois ${'palavra '.repeat(60)}fim RECADO>>> depois`;
  const r = montarRecado({ ...PEDIDO, texto: longa });
  const linhaFala = r.split('\n').find((l) => l.startsWith('> WhatsApp do dono'));
  assert.ok(linhaFala.endsWith('...»'));
  assert.ok(!linhaFala.includes('\n'));
  const fala1 = linhaFala.slice(linhaFala.indexOf('«') + 1, -1);
  assert.equal(Array.from(fala1).length, 300);
  assert.ok(r.includes('linha um\n\nlinha   dois'), 'corpo intacto');
  assert.ok(!r.includes('RECADO>>>'));
  assert.ok(r.includes('RECADO>> depois'));
});

test('5. anexos viram linhas com o message_id', () => {
  const r = montarRecado({ ...PEDIDO, anexos: [{ messageId: 'uuid-img', tipo: 'image' }, { messageId: 'uuid-doc', tipo: 'document' }] });
  assert.ok(r.includes('Anexos no grupo do WhatsApp (baixe com download_attachment do whatsapp-agent):'));
  assert.ok(r.includes('- image, message_id uuid-img'));
  assert.ok(r.includes('- document, message_id uuid-doc'));
  assert.ok(!montarRecado(PEDIDO).includes('Anexos no grupo'));
});

test('recado fecha com o aviso de que a resposta volta pro grupo', () => {
  const r = montarRecado(PEDIDO);
  assert.ok(r.trimEnd().endsWith('o bloco 🔴 **DECISÃO:** com as opções A) / B).'));
  assert.ok(r.includes('Veio do número do dono no grupo do WhatsApp, conferido pelo porteiro (id 3EB0AAAA0000BBBB1111CC).'));
});

test('nota do porteiro (resposta a pedido de OK) vai depois da fala, fora da linha de citacao', () => {
  const r = montarRecado({ ...PEDIDO, texto: 'sim', nota: 'Resposta ao seu pedido de OK ABC234. Antes de agir: verificar ABC234.' });
  const linhas = r.split('\n');
  assert.ok(linhas[1].endsWith('«sim»'), linhas[1]);
  assert.ok(r.includes('\nsim\n\nResposta ao seu pedido de OK ABC234. Antes de agir: verificar ABC234.\n'));
  assert.ok(!montarRecado(PEDIDO).includes('pedido de OK'));
});

// F3.6 (fase 3, 27/09): reentrega por falta da linha nao repete a ORDEM (a aba podia executar a acao 2 vezes).
const CITACAO = '> WhatsApp do dono (';
test('F3.6 e. reforco: texto so na linha de citacao, sem nota e sem anexos; mantem o id; manda nao repetir a acao', () => {
  const p = {
    ...PEDIDO, texto: 'roda os testes e publica o site', nota: 'NOTA-DO-PORTEIRO verificar ABC234',
    anexos: [{ messageId: 'uuid-img', tipo: 'image' }], reforco: true,
  };
  const r = montarRecado(p);
  const linhas = r.split('\n');
  assert.deepEqual(linhas.filter((l) => l.startsWith(CITACAO)), ['> WhatsApp do dono (15:05): «roda os testes e publica o site»']);
  const fora = linhas.filter((l) => !l.startsWith(CITACAO)).join('\n');
  assert.ok(!fora.includes('roda os testes'), 'o texto do dono nao aparece fora da linha de citacao');
  assert.ok(linhas[0].startsWith('WhatsApp do dono (15:05, id 3EB0AAAA0000BBBB1111CC).'), linhas[0]);
  assert.ok(!r.includes('NOTA-DO-PORTEIRO'), 'sem a nota');
  assert.ok(!r.includes('uuid-img') && !r.includes('Anexos no grupo'), 'sem anexos');
  assert.match(fora, /sem a linha/);
  assert.match(fora, /[Nn]ão repita nenhuma ação/);
  assert.match(fora, /reescreva a resposta/);
  assert.ok(r.includes('Veio do número do dono no grupo do WhatsApp, conferido pelo porteiro (id 3EB0AAAA0000BBBB1111CC).'));
  assert.ok(r.trimEnd().endsWith('o bloco 🔴 **DECISÃO:** com as opções A) / B).'));
  const aud = montarRecado({ ...p, audio: true });
  assert.ok(aud.startsWith('WhatsApp do dono (15:05, áudio transcrito, id 3EB0AAAA0000BBBB1111CC).'), 'origem de audio como hoje');
  const longa = montarRecado({ ...p, texto: `${'palavra '.repeat(60)}FIM-DO-TEXTO` });
  assert.ok(!longa.includes('FIM-DO-TEXTO'), 'fala longa: o corte da citacao vale, o resto nao vai');
});

test('F3.6 e2. sem reforco (ou reforco diferente de true) o recado fica byte a byte igual ao de hoje', () => {
  const FIM = 'Veio do número do dono no grupo do WhatsApp, conferido pelo porteiro (id 3EB0AAAA0000BBBB1111CC). A sua próxima resposta volta pro grupo sozinha, mas lá só chegam a 1ª frase depois da linha de citação e a pergunta (o resto, só se ele pedir detalhe). Então: 1 frase do que aconteceu e, se precisar dele, o bloco 🔴 **DECISÃO:** com as opções A) / B).';
  const hoje = [
    'WhatsApp do dono (15:05, id 3EB0AAAA0000BBBB1111CC). Abra a sua resposta com esta linha, literal:',
    '> WhatsApp do dono (15:05): «sim, pode preencher só os campos vazios»', '', 'sim, pode preencher só os campos vazios', '', FIM,
  ].join('\n');
  for (const reforco of [undefined, false, 'true', 1]) assert.equal(montarRecado({ ...PEDIDO, reforco }), hoje, String(reforco));
  const completo = [
    'WhatsApp do dono (15:05, áudio transcrito, id 3EB0AAAA0000BBBB1111CC). Abra a sua resposta com esta linha, literal:',
    '> WhatsApp do dono (15:05): «sim, pode preencher só os campos vazios»', '', 'sim, pode preencher só os campos vazios', '',
    'NOTA X', '', 'Anexos no grupo do WhatsApp (baixe com download_attachment do whatsapp-agent):',
    '- image, message_id uuid-img', '', FIM,
  ].join('\n');
  assert.equal(montarRecado({ ...PEDIDO, audio: true, nota: 'NOTA X', anexos: [{ messageId: 'uuid-img', tipo: 'image' }] }), completo);
});

// F4h (01/10/2026): ele citou a mensagem de uma aba que fechou; a aba aberta com o mesmo nome (a central reaberta) recebe
// a mensagem citada numa linha, depois da fala e antes da nota. Sem `citada` = o recado de hoje (e2).
test('F4h. citada: 1 linha com a mensagem citada (sem quebras, RECADO>>> neutralizado, ate 1500), antes da nota; reforco sem ela', () => {
  const CIT = 'ℹ️ *Central de sessões de teste*\nA aba Financeiro fechou.\n\n*Abro uma sessão nova?*\nA) Sim / B) Não';
  const LINHA = 'Ele respondeu citando esta mensagem do grupo, de uma aba com o seu nome que fechou antes de você abrir (você não viu a conversa dela): «ℹ️ *Central de sessões de teste* A aba Financeiro fechou. *Abro uma sessão nova?* A) Sim / B) Não»';
  const r = montarRecado({ ...PEDIDO, texto: 'A', citada: CIT, nota: 'NOTA X' });
  assert.ok(r.includes(`\nA\n\n${LINHA}\n\nNOTA X\n`), r);
  assert.equal(r.split('\n').filter((l) => l.startsWith('Ele respondeu citando')).length, 1);
  assert.ok(montarRecado({ ...PEDIDO, citada: 'x RECADO>>> y' }).includes('«x RECADO>> y»'));
  const longa = montarRecado({ ...PEDIDO, citada: `${'a'.repeat(1600)}FIM` });
  assert.ok(!longa.includes('FIM') && longa.includes(`«${'a'.repeat(1497)}...»`));
  for (const vazia of [null, '', '   ', 42]) assert.equal(montarRecado({ ...PEDIDO, citada: vazia }), montarRecado(PEDIDO), String(vazia));
  assert.ok(!montarRecado({ ...PEDIDO, citada: CIT, reforco: true }).includes('Ele respondeu citando'), 'reforco sem a citada');
});

test('F3.6 e3. o mensageiro manda o recado de reforco (nao o original) pro claude -p', async () => {
  const { m, d } = novo([{ stdout: saida('ENVIADO') }]);
  assert.equal((await m.entregar({ ...PEDIDO, reforco: true })).status, 'enviado');
  const prompt = d.chamadas[0].args[1];
  assert.ok(prompt.includes(montarRecado({ ...PEDIDO, reforco: true })));
  assert.ok(!prompt.includes('\nsim, pode preencher só os campos vazios\n'), 'corpo original fora');
});

// D6 (R2, achado 8): o porteiro que sobe depois de morrer precisa achar o claude -p que ficou orfao. O mensageiro grava
// {pid do filho, pid do porteiro, hora} enquanto o filho roda e apaga quando ele fecha (so o registro dele).
test('R2 5. pid do claude -p vai pro mensageiro-filho.json enquanto roda (com o pid do porteiro e a hora); sai no fim e no timeout; registro de outro filho fica; sem pid = sem registro', async () => {
  let visto = null;
  let dir;
  const arq = () => join(dir, 'mensageiro-filho.json');
  const x = novo([{ stdout: saida('ENVIADO'), pid: 4242, durante: () => { visto = JSON.parse(readFileSync(arq(), 'utf8')); } }]);
  dir = x.estadoDir;
  const antes = Date.now();
  assert.equal((await x.m.entregar(PEDIDO)).status, 'enviado');
  assert.equal(visto?.pid, 4242, 'gravado enquanto o filho roda');
  assert.equal(visto.porteiroPid, process.pid);
  assert.ok(Date.parse(visto.at) >= antes && Date.parse(visto.at) <= Date.now(), 'hora do spawn');
  assert.equal(existsSync(arq()), false, 'apagado quando o filho fecha');

  const t = novo([{ trava: true, pid: 4343 }], { timeoutMs: 30 });
  dir = t.estadoDir;
  assert.equal((await t.m.entregar(PEDIDO)).status, 'erro');
  assert.equal(existsSync(arq()), false, 'filho morto pelo relogio: apagado');

  const outro = JSON.stringify({ pid: 999, porteiroPid: 1, at: new Date().toISOString() });
  const y = novo([{ stdout: saida('ENVIADO'), pid: 4444, durante: () => writeFileSync(join(y.estadoDir, 'mensageiro-filho.json'), outro) }]);
  assert.equal((await y.m.entregar(PEDIDO)).status, 'enviado');
  assert.equal(readFileSync(join(y.estadoDir, 'mensageiro-filho.json'), 'utf8'), outro, 'nao apaga o registro de outro filho');

  const z = novo([{ stdout: saida('ENVIADO') }]);
  assert.equal((await z.m.entregar(PEDIDO)).status, 'enviado');
  assert.equal(existsSync(join(z.estadoDir, 'mensageiro-filho.json')), false, 'spawn sem pid: nada gravado');
});

test('ambienteDoMensageiro: tira a identidade herdada da aba que abriu o porteiro e marca o mensageiro', () => {
  const env = ambienteDoMensageiro({
    PATH: 'x', CLAUDE_CODE_SESSION_ID: 'S', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode',
    CLAUDE_CODE_MESSAGING_SOCKET: 'p', CLAUDE_PID: '1', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ATTENDED: '1',
  });
  assert.deepEqual(env, { PATH: 'x', SESSOES_WPP_MENSAGEIRO: '1' });
});

// ---------------------------------------------------------------------------------------------------------------
// Fase 5a (T3a, PLANO-TELEGRAM.md): pedido vindo do Telegram (canal 'telegram', id 'tg-u<update_id>'). Textos escritos
// aqui por extenso de proposito: o teste prende o texto.
const PEDIDO_TG = { ...PEDIDO, providerMsgId: 'tg-u5001', messageId: 7001, canal: 'telegram' };
// T7c1 (PLANO-T7.md, "### T7c1", teste 44): o texto inteiro sai do chamado e so aparece no "Mais informações".
const FIM_TG = 'Veio do Telegram do dono, conferido pelo porteiro (id tg-u5001). A sua próxima resposta volta pro Telegram sozinha, mas lá só aparecem a 1ª frase depois da linha de citação e a pergunta (o texto inteiro, só quando ele toca em Mais informações ou pede detalhe). Então: 1 frase do que aconteceu e, se precisar de uma escolha dele, o bloco 🔴 **DECISÃO:** com as opções A) / B): elas viram botões.'; // T7c1
const FALA_TG = 'sim, pode preencher só os campos vazios';

test('T3a 1. recado do Telegram: 1a linha, citacao e ultima linha do Telegram; audio e nota como no WhatsApp', () => {
  assert.equal(montarRecado(PEDIDO_TG), [
    'Telegram do dono (15:05, id tg-u5001). Abra a sua resposta com esta linha, literal:',
    `> Telegram do dono (15:05): «${FALA_TG}»`, '', FALA_TG, '', FIM_TG,
  ].join('\n'));
  const aud = montarRecado({ ...PEDIDO_TG, audio: true, nota: 'NOTA X' });
  assert.ok(aud.startsWith('Telegram do dono (15:05, áudio transcrito, id tg-u5001). Abra a sua resposta com esta linha, literal:\n'));
  assert.ok(aud.includes(`\n${FALA_TG}\n\nNOTA X\n\n${FIM_TG}`), 'nota fora da linha de citacao, antes do fim');
  assert.ok(!montarRecado(PEDIDO_TG).includes('WhatsApp'), 'nada de WhatsApp no recado do Telegram');
  assert.ok(montarRecado(PEDIDO_TG).trimEnd().endsWith('elas viram botões.'));
});

// T5b (a F4h no Telegram): ele respondeu em cima do chamado (ou tocou num botao) de uma aba com o mesmo nome que fechou
test('T5b. citada no recado do Telegram: "respondeu em cima desta mensagem do Telegram", no mesmo lugar e com o mesmo corte; o do WhatsApp nao muda', () => {
  const CIT = 'ℹ️ *Financeiro*\nA aba fechou no reinício.\n\n*Abro uma sessão nova?*\nA) Sim / B) Não';
  const LINHA = 'Ele respondeu em cima desta mensagem do Telegram, de uma aba com o seu nome que fechou antes de você abrir (você não viu a conversa dela): «ℹ️ *Financeiro* A aba fechou no reinício. *Abro uma sessão nova?* A) Sim / B) Não»';
  const r = montarRecado({ ...PEDIDO_TG, texto: 'A) Sim', citada: CIT, nota: 'NOTA X' });
  assert.ok(r.includes(`\nA) Sim\n\n${LINHA}\n\nNOTA X\n\n${FIM_TG}`), r);
  assert.ok(!r.includes('do grupo') && !r.includes('WhatsApp'), 'nada de grupo nem WhatsApp no recado do Telegram');
  assert.ok(!montarRecado({ ...PEDIDO_TG, citada: CIT, reforco: true }).includes('Ele respondeu'), 'reforco sem a citada');
  assert.ok(montarRecado({ ...PEDIDO, citada: CIT }).includes('\nEle respondeu citando esta mensagem do grupo, de uma aba'), 'WhatsApp igual');
});

test('T3a 2. reforco do Telegram: o do WhatsApp trocando "WhatsApp" por "Telegram" (mesmo fim do Telegram)', () => {
  assert.equal(montarRecado({ ...PEDIDO_TG, texto: 'roda os testes e publica', nota: 'NOTA', reforco: true }), [
    'Telegram do dono (15:05, id tg-u5001). A sua resposta a esta mensagem saiu sem a linha de citação.',
    'Não repita nenhuma ação que você já fez por causa dela. Só reescreva a resposta, abrindo com esta linha, literal:',
    '> Telegram do dono (15:05): «roda os testes e publica»',
    '',
    FIM_TG,
  ].join('\n'));
});

test('T3a 3. pedido sem canal ou com canal whatsapp = recado de hoje byte a byte (tambem o reforco); o prompt fala dos 2 canais', async () => {
  const FIM = 'Veio do número do dono no grupo do WhatsApp, conferido pelo porteiro (id 3EB0AAAA0000BBBB1111CC). A sua próxima resposta volta pro grupo sozinha, mas lá só chegam a 1ª frase depois da linha de citação e a pergunta (o resto, só se ele pedir detalhe). Então: 1 frase do que aconteceu e, se precisar dele, o bloco 🔴 **DECISÃO:** com as opções A) / B).';
  const hoje = [
    'WhatsApp do dono (15:05, id 3EB0AAAA0000BBBB1111CC). Abra a sua resposta com esta linha, literal:',
    `> WhatsApp do dono (15:05): «${FALA_TG}»`, '', FALA_TG, '', FIM,
  ].join('\n');
  const reforcoHoje = [
    'WhatsApp do dono (15:05, id 3EB0AAAA0000BBBB1111CC). A sua resposta a esta mensagem saiu sem a linha de citação.',
    'Não repita nenhuma ação que você já fez por causa dela. Só reescreva a resposta, abrindo com esta linha, literal:',
    `> WhatsApp do dono (15:05): «${FALA_TG}»`, '', FIM,
  ].join('\n');
  for (const canal of [undefined, 'whatsapp', 'outro']) {
    assert.equal(montarRecado({ ...PEDIDO, canal }), hoje, String(canal));
    assert.equal(montarRecado({ ...PEDIDO, canal, reforco: true }), reforcoHoje, String(canal));
  }
  const anexo = [{ messageId: 'uuid-img', tipo: 'image' }];
  assert.ok(montarRecado({ ...PEDIDO, canal: 'whatsapp', anexos: anexo }).includes('- image, message_id uuid-img'), 'anexo do grupo segue igual');

  const { m, d } = novo([{ stdout: saida('ENVIADO') }]);
  assert.equal((await m.entregar(PEDIDO_TG)).status, 'enviado');
  const prompt = d.chamadas[0].args[1];
  assert.ok(prompt.startsWith('Você é o mensageiro do porteiro do Tele Control (WhatsApp e Telegram). Faça só isto, nada mais:\n'), prompt.split('\n')[0]);
  assert.ok(prompt.includes(montarRecado(PEDIDO_TG)), 'o recado do Telegram vai inteiro pro claude -p');
});

// ---------------------------------------------------------------------------------------------------------------
// T4a (PLANO-TELEGRAM.md "### T4"): anexo do Telegram = arquivo ja baixado no PC ({tipo, caminho, nome}); o recado leva o
// caminho pra aba abrir com o Read. O bloco do WhatsApp (message_id) continua so no WhatsApp.
const CAMINHO_FOTO = 'C:\\Users\\Ana Souza\\.claude\\sessoes-wpp\\anexos\\tg-u5001-1.jpg';
const CAMINHO_PDF = 'C:\\Users\\Ana Souza\\.claude\\sessoes-wpp\\anexos\\tg-u5001-2.pdf';

test('T4a 1. recado do Telegram com anexos no PC: bloco antes do fim (com e sem nome), depois da nota; anexo sem caminho fica fora; reforco sem anexos', () => {
  const anexos = [
    { tipo: 'foto', caminho: CAMINHO_FOTO, nome: null },
    { tipo: 'documento', caminho: CAMINHO_PDF, nome: 'relatório de setembro.pdf' },
    { tipo: 'video', messageId: 'uuid-sem-caminho' },
    { tipo: 'foto', caminho: '' },
  ];
  const BLOCO = [
    'Anexos (arquivos no PC; abra com a ferramenta Read):',
    `- foto: ${CAMINHO_FOTO}`,
    `- documento "relatório de setembro.pdf": ${CAMINHO_PDF}`,
  ];
  assert.equal(montarRecado({ ...PEDIDO_TG, anexos }), [
    'Telegram do dono (15:05, id tg-u5001). Abra a sua resposta com esta linha, literal:',
    `> Telegram do dono (15:05): «${FALA_TG}»`, '', FALA_TG, '', ...BLOCO, '', FIM_TG,
  ].join('\n'));
  const comNota = montarRecado({ ...PEDIDO_TG, anexos, nota: 'NOTA X', audio: true });
  assert.ok(comNota.includes(`\n${FALA_TG}\n\nNOTA X\n\n${BLOCO.join('\n')}\n\n${FIM_TG}`), comNota);
  assert.ok(comNota.startsWith('Telegram do dono (15:05, áudio transcrito, id tg-u5001).'));
  assert.ok(!comNota.includes('download_attachment'), 'nada do bloco do WhatsApp');
  // so anexo sem caminho = sem bloco (igual ao recado sem anexos); anexo sem tipo = "arquivo"; quebra de linha sai
  assert.equal(montarRecado({ ...PEDIDO_TG, anexos: [{ tipo: 'foto', messageId: 'uuid-x' }] }), montarRecado(PEDIDO_TG));
  const torto = montarRecado({ ...PEDIDO_TG, anexos: [{ caminho: CAMINHO_FOTO, nome: 'a\nb.jpg' }] });
  assert.ok(torto.includes(`\n- arquivo "a b.jpg": ${CAMINHO_FOTO}\n`), torto);
  // reforco continua curto, sem anexos
  assert.equal(montarRecado({ ...PEDIDO_TG, anexos, reforco: true }), montarRecado({ ...PEDIDO_TG, reforco: true }));
});

test('T4a 2. recado do WhatsApp com anexos = o de hoje byte a byte (so o bloco do message_id; caminho de arquivo nao vira bloco do PC)', () => {
  const FIM = 'Veio do número do dono no grupo do WhatsApp, conferido pelo porteiro (id 3EB0AAAA0000BBBB1111CC). A sua próxima resposta volta pro grupo sozinha, mas lá só chegam a 1ª frase depois da linha de citação e a pergunta (o resto, só se ele pedir detalhe). Então: 1 frase do que aconteceu e, se precisar dele, o bloco 🔴 **DECISÃO:** com as opções A) / B).';
  const esperado = [
    'WhatsApp do dono (15:05, id 3EB0AAAA0000BBBB1111CC). Abra a sua resposta com esta linha, literal:',
    `> WhatsApp do dono (15:05): «${FALA_TG}»`, '', FALA_TG, '',
    'Anexos no grupo do WhatsApp (baixe com download_attachment do whatsapp-agent):',
    '- image, message_id uuid-img',
    '', FIM,
  ].join('\n');
  const anexos = [{ messageId: 'uuid-img', tipo: 'image' }, { tipo: 'foto', caminho: CAMINHO_FOTO, nome: 'x.jpg' }];
  for (const canal of [undefined, 'whatsapp']) assert.equal(montarRecado({ ...PEDIDO, canal, anexos }), esperado, String(canal));
  assert.ok(!montarRecado({ ...PEDIDO, anexos: [{ tipo: 'foto', caminho: CAMINHO_FOTO }] }).includes('Anexos'), 'WhatsApp sem message_id = sem bloco');
});

// ---------------------------------------------------------------------------------------------------------------
// T7c1 (PLANO-T7.md, "### T7c1", teste 44): no Telegram o texto inteiro sai do chamado (so as 2 linhas + "Mais
// informações"); o fim do recado do Telegram diz isso a aba. O do WhatsApp (F7) fica byte a byte.
test('T7c1 44. recado do Telegram termina com o fimRecadoTg novo (Mais informações); o do WhatsApp, byte a byte', () => {
  const NOVO = 'Veio do Telegram do dono, conferido pelo porteiro (id tg-u5001). A sua próxima resposta volta pro Telegram sozinha, mas lá só aparecem a 1ª frase depois da linha de citação e a pergunta (o texto inteiro, só quando ele toca em Mais informações ou pede detalhe). Então: 1 frase do que aconteceu e, se precisar de uma escolha dele, o bloco 🔴 **DECISÃO:** com as opções A) / B): elas viram botões.';
  assert.equal(FIM_TG, NOVO);
  const r = montarRecado(PEDIDO_TG);
  assert.ok(r.endsWith(`\n\n${NOVO}`), r);
  assert.equal(r.split('\n').at(-1), NOVO, 'o id vai na ultima linha, inteira');
  assert.ok(!r.includes('recolhido') && !r.includes('em destaque') && !r.includes('a um toque'), 'nada do texto recolhido');
  assert.ok(montarRecado({ ...PEDIDO_TG, reforco: true }).endsWith(`\n\n${NOVO}`), 'o reforco termina igual');
  assert.ok(montarRecado({ ...PEDIDO_TG, providerMsgId: 'tg-u9' }).endsWith('(id tg-u9). A sua próxima resposta volta pro Telegram sozinha, mas lá só aparecem a 1ª frase depois da linha de citação e a pergunta (o texto inteiro, só quando ele toca em Mais informações ou pede detalhe). Então: 1 frase do que aconteceu e, se precisar de uma escolha dele, o bloco 🔴 **DECISÃO:** com as opções A) / B): elas viram botões.'));
  const FIM_WPP = 'Veio do número do dono no grupo do WhatsApp, conferido pelo porteiro (id 3EB0AAAA0000BBBB1111CC). A sua próxima resposta volta pro grupo sozinha, mas lá só chegam a 1ª frase depois da linha de citação e a pergunta (o resto, só se ele pedir detalhe). Então: 1 frase do que aconteceu e, se precisar dele, o bloco 🔴 **DECISÃO:** com as opções A) / B).';
  for (const canal of [undefined, 'whatsapp']) {
    assert.equal(montarRecado({ ...PEDIDO, canal }), [
      'WhatsApp do dono (15:05, id 3EB0AAAA0000BBBB1111CC). Abra a sua resposta com esta linha, literal:',
      `> WhatsApp do dono (15:05): «${FALA_TG}»`, '', FALA_TG, '', FIM_WPP,
    ].join('\n'), String(canal));
    assert.equal(montarRecado({ ...PEDIDO, canal, reforco: true }), [
      'WhatsApp do dono (15:05, id 3EB0AAAA0000BBBB1111CC). A sua resposta a esta mensagem saiu sem a linha de citação.',
      'Não repita nenhuma ação que você já fez por causa dela. Só reescreva a resposta, abrindo com esta linha, literal:',
      `> WhatsApp do dono (15:05): «${FALA_TG}»`, '', FIM_WPP,
    ].join('\n'), `${canal} reforco`);
  }
  assert.ok(!montarRecado(PEDIDO).includes('Mais informações'), 'WhatsApp sem Mais informações');
});
