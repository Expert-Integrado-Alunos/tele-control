// Guarda do projeto aberto (PLANO-ABERTO.md, "A1 — Telegram pela configuração", teste 12; "Execução final", a guarda):
// a copia aberta (o que vai pro repositorio dos alunos: o versionado menos o `export-ignore` do .gitattributes) nao tem
// nenhum termo proibido. A lista e a do robo publicador (tools/publicar/proibidos.json) e a varredura e a mesma dele
// (tools/publicar/varrer.mjs: texto e caminho em minusculas, binario fora, export-ignore por pasta).
// Por que existe: id, numero, nome ou caminho do dono chumbado amarra o sistema de novo a ele e expoe o dado dele; a
// guarda pega na bateria, antes do publicador recusar (ou de um termo novo escapar da lista).
// Na copia aberta o tools/ nao vai (export-ignore): sem a lista e o varredor, a guarda pula (o publicador confere la);
// o 12d (a copia se basta) roda la tambem.
// So le o repositorio (e uma pasta temporaria com um git de amostra): nada de rede, chave nem config.json real.
// Rodar: node --test --test-reporter=tap "tests/guarda-aberto.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pastaTemp } from './lib/pasta-temp.cjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROIBIDOS = path.join(REPO, 'tools', 'publicar', 'proibidos.json');
const VARRER = path.join(REPO, 'tools', 'publicar', 'varrer.mjs');
const FORA_DA_COPIA = fs.existsSync(PROIBIDOS) && fs.existsSync(VARRER)
  ? false
  : 'sem tools/publicar (fica fora da copia aberta; o publicador confere na publicacao)';

const termos = () => JSON.parse(fs.readFileSync(PROIBIDOS, 'utf8')).termos;
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8', windowsHide: true });
const varrer = (raiz) => {
  const r = spawnSync(process.execPath, [VARRER, raiz, '--json'], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 });
  return { status: r.status, saida: r.status === 0 || r.status === 1 ? JSON.parse(r.stdout) : null, erro: r.stderr };
};

test('A1 12a. guarda: a lista e a do publicador e cobre os ids, os numeros e os nomes de antes (amostra)', { skip: FORA_DA_COPIA }, () => {
  const t = termos();
  assert.ok(Array.isArray(t) && t.length >= 70, `lista com ${t?.length} termos`);
  for (const x of t) assert.equal(x, x.toLowerCase(), `termo fora de minusculas: ${x}`);
  // a amostra sai da propria lista (montada por pedacos: o termo inteiro nao pode aparecer neste arquivo, que vai pra copia)
  for (const pedacos of [['1028', '671416'], ['8692', '587773'], ['telegram_claude', '_pc_bot_token'], ['claude-', 'workspace']]) {
    assert.ok(t.includes(pedacos.join('')), `a lista tem ${pedacos.join('…')}`);
  }
});

test('A1 12b. guarda: o varredor acha termo no texto e no caminho, ignora binario e o export-ignore por pasta (git de amostra)', { skip: FORA_DA_COPIA }, () => {
  const raiz = pastaTemp('guarda-');
  assert.equal(git(raiz, 'init', '-q').status, 0);
  const termo = termos()[0];
  fs.writeFileSync(path.join(raiz, '.gitattributes'), '/interno export-ignore\n');
  fs.writeFileSync(path.join(raiz, 'limpo.mjs'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(raiz, 'sujo.mjs'), `// linha 1\nconst y = '${termo.toUpperCase()}';\n`);
  fs.mkdirSync(path.join(raiz, 'interno'));
  fs.writeFileSync(path.join(raiz, 'interno', 'notas.md'), `${termo}\n`);
  fs.writeFileSync(path.join(raiz, 'bin.dat'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(termo)]));
  const r = varrer(raiz);
  assert.equal(r.status, 1, r.erro);
  assert.deepEqual(r.saida.achados.map((a) => `${a.arquivo}:${a.linha}`), ['sujo.mjs:2']);
  fs.rmSync(path.join(raiz, 'sujo.mjs'));
  assert.equal(varrer(raiz).status, 0, 'sem o arquivo sujo a amostra fica limpa');
});

// O varredor e o publicador pulam arquivo com NUL no comeco (binario); texto em UTF-16 (o padrao do Out-File do
// PowerShell 5) tem NUL e passaria sem ser lido. Nenhum arquivo de texto do repositorio pode estar assim.
test('A1 12c. guarda: nenhum arquivo de texto versionado esta em UTF-16 (o varredor pularia como binario)', { skip: FORA_DA_COPIA }, () => {
  const TEXTO = new Set(['.mjs', '.js', '.cjs', '.vbs', '.ps1', '.py', '.md', '.json', '.txt', '.cmd', '.bat', '.yml', '.html', '.css']);
  const r = git(REPO, 'ls-files', '-z');
  assert.equal(r.status, 0, r.stderr);
  const lidos = r.stdout.split('\0').filter((f) => f && TEXTO.has(path.extname(f).toLowerCase()) && fs.existsSync(path.join(REPO, f)));
  assert.ok(lidos.length > 50, `${lidos.length} arquivos de texto`);
  const comNul = lidos.filter((f) => fs.readFileSync(path.join(REPO, f)).subarray(0, 8000).includes(0));
  assert.deepEqual(comNul, [], 'arquivo de texto com NUL (UTF-16?)');
});

// A copia aberta se basta: nenhum codigo dela importa arquivo que fica fora (export-ignore) ou que nao existe. Caso real
// (18/10/2026, a copia do aluno extraida do git archive): o tests/religar.test.mjs importava o tools/integrar/religar.mjs
// e a suite quebrava na copia (hoje ele tem export-ignore). Roda tambem na copia: com git, a copia = o versionado (e os
// novos) menos o export-ignore, do mesmo jeito do varredor; sem git (a copia ja extraida), os arquivos da pasta.
// Linha que comeca com aspas e texto de amostra dentro de um teste (nao e import de verdade): fica de fora.
const CODIGO = new Set(['.mjs', '.js', '.cjs']);
const RE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"\n]+)['"]/g;
const prefixos = (f) => f.split('/').map((_, i, p) => p.slice(0, i + 1).join('/'));
function arquivosDaCopia(raiz) {
  const ls = git(raiz, 'ls-files', '-z', '-c', '-o', '--exclude-standard');
  if (ls.status !== 0) {
    const todos = [];
    const andar = (rel) => {
      for (const d of fs.readdirSync(path.join(raiz, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${d.name}` : d.name;
        if (!d.isDirectory()) todos.push(r);
        else if (d.name !== 'node_modules' && d.name !== '.git') andar(r);
      }
    };
    andar('');
    return new Set(todos);
  }
  const arqs = ls.stdout.split('\0').filter((f) => f && fs.existsSync(path.join(raiz, f)));
  const perguntas = [...new Set(arqs.flatMap(prefixos))];
  const attr = spawnSync('git', ['-C', raiz, 'check-attr', '-z', 'export-ignore', '--stdin'],
    { input: perguntas.join('\0') + '\0', encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 }).stdout.split('\0');
  const ignorado = new Set();
  for (let i = 0; i + 2 < attr.length; i += 3) if (attr[i + 2] === 'set') ignorado.add(attr[i]);
  return new Set(arqs.filter((f) => !prefixos(f).some((p) => ignorado.has(p))));
}

test('A1 12d. guarda: a copia aberta se basta (nenhum codigo dela importa arquivo que fica fora dela ou que nao existe)', () => {
  const copia = arquivosDaCopia(REPO);
  assert.ok(copia.size > 50, `a copia tem ${copia.size} arquivos`);
  assert.ok(copia.has('porteiro.mjs') && copia.has('tests/guarda-aberto.test.mjs'), 'a copia tem o porteiro e esta guarda');
  const quebrados = [];
  let imports = 0;
  for (const f of copia) {
    if (!CODIGO.has(path.extname(f))) continue;
    for (const linha of fs.readFileSync(path.join(REPO, f), 'utf8').split('\n')) {
      if (/^\s*['"`]/.test(linha)) continue;
      for (const m of linha.matchAll(RE_IMPORT)) {
        imports++;
        if (!copia.has(path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1])))) quebrados.push(`${f} -> ${m[1]}`);
      }
    }
  }
  assert.ok(imports > 100, `${imports} imports relativos lidos (a leitura passou pelo codigo?)`);
  assert.deepEqual(quebrados, [], 'a copia aberta importa arquivo que nao vai junto');
});

test('A1 12. guarda: a copia aberta deste repositorio nao tem nenhum termo proibido (codigo, testes, skill, README)', { skip: FORA_DA_COPIA }, () => {
  const r = varrer(REPO);
  assert.ok(r.saida, `o varredor falhou: ${r.erro}`);
  assert.ok(r.saida.arquivos > 50, `a copia tem ${r.saida.arquivos} arquivos (a varredura passou pelo repositorio?)`);
  assert.deepEqual(r.saida.achados.map((a) => `${a.arquivo}:${a.linha}: ${a.termo}`), [], 'termo proibido na copia aberta');
});
