// O sessoes-wpp-porteiro.vbs acha o porteiro.mjs pela propria pasta e o node.exe pelo PATH (PLANO-ABERTO-INVENTARIO.md,
// item 16: antes os 2 caminhos eram fixos da maquina de origem e o inicio automatico de um repositorio clonado em outra
// pasta nunca subia o porteiro). Roda o .vbs de verdade (cscript) numa COPIA em pasta temporaria, so no modo ensaio
// (SESSOES_WPP_VBS_ENSAIO=1: escreve o node e o porteiro e sai). Sem o ensaio antes de tudo o .vbs renasceria pelo WMI e
// deixaria um guardiao vivo com o ambiente do login: o teste confere o fonte antes e recusa rodar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pastaTemp } from './lib/pasta-temp.cjs';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');
const VBS = path.join(REPO, 'sessoes-wpp-porteiro.vbs');
const CSCRIPT = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cscript.exe');
const SO_WINDOWS = { skip: process.platform !== 'win32' ? 'so no Windows (cscript)' : false };

// O ensaio vem antes de qualquer Run e do renascer pelo WMI (senao rodar o .vbs subiria um guardiao de verdade).
function ensaioAntesDeTudo(fonte) {
  const ensaio = fonte.indexOf('SESSOES_WPP_VBS_ENSAIO") = "1"');
  const perigos = [fonte.indexOf('If RenascerPeloWmi()'), fonte.indexOf('sh.Run ')].filter((i) => i >= 0);
  return ensaio >= 0 && perigos.length === 2 && perigos.every((i) => ensaio < i);
}

// Copia o .vbs pra `pastaDoRepo` e roda o ensaio com o PATH e o ProgramFiles dados. A saida do cscript sai na pagina de
// codigo do console (850 no Brasil, 437 nos EUA): le byte a byte e compara letra fora do ASCII com "qualquer byte".
function rodarEnsaio(pastaDoRepo, { PATH, ProgramFiles = 'C:\\Programas Falsos', extra = {} }) {
  const fonte = fs.readFileSync(VBS, 'utf8');
  if (!ensaioAntesDeTudo(fonte)) throw new Error('sessoes-wpp-porteiro.vbs sem o ensaio antes do Run e do WMI: o teste nao roda o .vbs (subiria um guardiao de verdade)');
  fs.mkdirSync(pastaDoRepo, { recursive: true });
  const copia = path.join(pastaDoRepo, 'sessoes-wpp-porteiro.vbs');
  fs.copyFileSync(VBS, copia);
  const env = {
    SystemRoot: process.env.SystemRoot, windir: process.env.windir, TEMP: pastaDoRepo, TMP: pastaDoRepo,
    PATH, ProgramFiles, SESSOES_WPP_VBS_ENSAIO: '1', ...extra,
  };
  const r = spawnSync(CSCRIPT, ['//nologo', copia], { env, timeout: 30000, windowsHide: true });
  return { status: r.status, linhas: Buffer.from(r.stdout || '').toString('latin1').split(/\r?\n/).filter(Boolean), stderr: String(r.stderr || '') };
}

function casa(lido, esperado) {
  const re = new RegExp('^' + [...esperado].map((c) => (c.charCodeAt(0) > 127 ? '[\\s\\S]' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('') + '$', 'i');
  return re.test(lido);
}

function nodeFalso(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'node.exe'), '');
  return path.join(dir, 'node.exe');
}

test('vbs 1. o porteiro.mjs e o da pasta do proprio .vbs (pasta com espaco e acento, fora de qualquer caminho fixo)', SO_WINDOWS, () => {
  const raiz = pastaTemp('porteiro-vbs-');
  const repo = path.join(raiz, 'Área de trabalho', 'tele control');
  const bin = path.join(raiz, 'bin');
  nodeFalso(bin);
  const r = rodarEnsaio(repo, { PATH: bin });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.linhas.length, 2, r.linhas.join('\n'));
  assert.ok(casa(r.linhas[1], path.join(repo, 'porteiro.mjs')), r.linhas[1]);
});

test('vbs 2. o node e o PRIMEIRO node.exe do PATH: pula pasta sem node, aceita entrada com aspas, com espaco e acento', SO_WINDOWS, () => {
  const raiz = pastaTemp('porteiro-vbs-');
  const repo = path.join(raiz, 'repo');
  const semNode = path.join(raiz, 'sem node');
  fs.mkdirSync(semNode, { recursive: true });
  const primeiro = nodeFalso(path.join(raiz, 'bin com espaço'));
  nodeFalso(path.join(raiz, 'segundo'));
  const r = rodarEnsaio(repo, { PATH: [semNode, `"${path.dirname(primeiro)}"`, path.join(raiz, 'segundo')].join(';') });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(casa(r.linhas[0], primeiro), r.linhas[0]);
});

test('vbs 3. entrada do PATH com %VARIAVEL% vale (expandida pelo ambiente)', SO_WINDOWS, () => {
  const raiz = pastaTemp('porteiro-vbs-');
  const repo = path.join(raiz, 'repo');
  const exe = nodeFalso(path.join(raiz, 'node via variavel'));
  const r = rodarEnsaio(repo, { PATH: `${path.join(raiz, 'nada')};%DIR_DO_NODE%`, extra: { DIR_DO_NODE: path.dirname(exe) } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(casa(r.linhas[0], exe), r.linhas[0]);
});

test('vbs 4. nenhum node.exe no PATH = o da pasta padrao do instalador do Node (%ProgramFiles%\\nodejs)', SO_WINDOWS, () => {
  const raiz = pastaTemp('porteiro-vbs-');
  const repo = path.join(raiz, 'repo');
  const r = rodarEnsaio(repo, { PATH: path.join(raiz, 'vazia'), ProgramFiles: 'X:\\Programas Falsos' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(casa(r.linhas[0], 'X:\\Programas Falsos\\nodejs\\node.exe'), r.linhas[0]);
});

test('vbs 5. o fonte nao tem caminho de maquina fixo (nem a pasta de repositorios nem o node.exe da pasta padrao)', () => {
  const fonte = fs.readFileSync(VBS, 'utf8');
  assert.ok(ensaioAntesDeTudo(fonte), 'o ensaio vem antes do Run e do WMI');
  assert.doesNotMatch(fonte, /^[^'\r\n]*[A-Z]:\\[^'\r\n]*$/im, 'linha de codigo com caminho de disco fixo');
  assert.doesNotMatch(fonte, /Program Files\\nodejs/i);
});
