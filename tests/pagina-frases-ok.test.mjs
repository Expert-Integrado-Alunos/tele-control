// Frases do OK na pagina publica x as do codigo (sugestao de uma revisao).
// Por que existe: a secao 02 da pagina (o Telegram) diz que os textos das telas "saem das mesmas funcoes que montam as
// mensagens do bot", mas o vitrine/build.py so copia o HTML: frase mudada no codigo deixava a pagina velha em silencio.
// Cada caso monta a frase pelo codigo de hoje e procura nas 2 copias da pagina (a fonte vitrine/index.src.html e a
// publicada docs/index.html). A secao 03 (o teste real no grupo, datado de 28/09/2026 na propria pagina) fica de fora:
// registra o que saiu naquele dia, nao o formato de hoje.
// Falhou = atualizar a tela no vitrine/index.src.html -> python vitrine/build.py -> python vitrine/testar.py (CLAUDE.md,
// "Pagina"); ou o codigo, se a pagina e que esta certa.
// So le arquivos do repositorio: nada de rede, chave, config.json real nem porteiro rodando.
// Rodar: node --test --test-reporter=tap "tests/pagina-frases-ok.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { montarOkTg } from '../lib/ok-tg.mjs';
import { classificarResposta } from '../ok-wpp.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGINAS = ['vitrine/index.src.html', 'docs/index.html'];
// Na copia aberta o vitrine/ e o docs/ nao vao (export-ignore): sem nenhuma das 2 paginas, os testes pulam. Na fonte
// rodam igual (faltando so 1 delas, o teste quebra como antes).
const SEM_PAGINAS = PAGINAS.every((rel) => !fs.existsSync(path.join(REPO, rel)))
  ? 'sem a pagina (vitrine/ e docs/ ficam fora da copia aberta)'
  : false;
const ler = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
// Pedaco de HTML de uma tela -> o texto que o chat mostra: sem a hora e o recibo da bolha, <br> = quebra de linha, sem
// tags, entidades lidas.
const textoDe = (html) => html
  .replace(/<span class="(?:t|re)">[^<]*<\/span>/g, '')
  .replace(/<br\s*\/?>/g, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ENTIDADES[e])
  .normalize('NFC');

// O <section id="..."> inteiro, ate o </section> dele.
function secao(html, id) {
  const ini = html.indexOf(`<section id="${id}"`);
  assert.ok(ini >= 0, `a secao "${id}" sumiu da pagina`);
  const fim = html.indexOf('</section>', ini);
  assert.ok(fim > ini, `a secao "${id}" nao fecha`);
  return html.slice(ini, fim);
}

// A tela (<figure>) cuja legenda tem este <h3>, ate o </figure> dela.
function tela(html, titulo) {
  const f = html.split('<figure').slice(1).find((x) => x.includes(`<h3>${titulo}</h3>`));
  assert.ok(f, `a tela "${titulo}" sumiu`);
  return f.slice(0, f.indexOf('</figure>'));
}

// A 1a mensagem do bot na tela, em texto.
function primeiraBolha(fig) {
  const m = /<div class="b in">([\s\S]*?)<\/div>/.exec(fig);
  assert.ok(m, 'a tela nao tem mensagem do bot');
  return textoDe(m[1]);
}

// Os botoes do 1o teclado da tela: uma lista de rotulos por linha.
function teclado(fig) {
  const ABRE = '<div class="kb">';
  const ini = fig.indexOf(ABRE);
  assert.ok(ini >= 0, 'a tela nao tem botoes');
  const resto = fig.slice(ini + ABRE.length);
  const fim = resto.indexOf('</div></div>');
  assert.ok(fim >= 0, 'o teclado da tela nao fecha');
  return [...resto.slice(0, fim + '</div>'.length).matchAll(/<div>([\s\S]*?)<\/div>/g)]
    .map((linha) => [...linha[1].matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map((b) => textoDe(b[1])));
}

// A resposta ao toque (o aviso curto do topo da tela), em texto.
function respostaAoToque(fig) {
  const m = /<div class="toast">([^<]*)<\/div>/.exec(fig);
  assert.ok(m, 'a tela nao tem a resposta ao toque');
  return textoDe(m[1]);
}

// FRASES_TG nao e exportada (o porteiro.mjs e o processo vivo: exportar pede religar). O bloco sai do fonte, de
// "const FRASES_TG = {" ate o "};" da coluna 0, e e avaliado sozinho num contexto vazio (as frases nao usam nada de fora).
function frasesTg() {
  const m = /^const FRASES_TG = (\{[\s\S]*?^\});\r?$/m.exec(ler('porteiro.mjs'));
  assert.ok(m, 'o bloco "const FRASES_TG = {...};" mudou de forma no porteiro.mjs: ajuste este teste');
  return vm.runInNewContext(`(${m[1]})`);
}

// A validade do pedido de OK em minutos (VALIDADE_MS do ok-wpp.mjs, nao exportada).
function validadeMin() {
  const m = /^const VALIDADE_MS = (\d+) \* 60 \* 1000;\r?$/m.exec(ler('ok-wpp.mjs'));
  assert.ok(m, 'a validade do pedido (VALIDADE_MS) mudou de forma no ok-wpp.mjs: ajuste este teste');
  return Number(m[1]);
}

test('pagina-ok 1. Telegram, tela "Pedido de OK": a mensagem e os botoes sao os do montarOkTg de hoje', { skip: SEM_PAGINAS }, () => {
  // Os valores do exemplo da tela: "Aba de teste", acao sem destinatario (tipo outro), pedido 14:55, vale ate 15:25
  const { texto, botoes } = montarOkTg({
    codigo: 'ABCDEF', titulo: 'Aba de teste', tipo: 'outro', destinatarios: null,
    acao: 'Mandar o resumo do dia por e-mail pro time.',
    criadoEm: '2026-10-04T14:55:00-03:00', expiraEm: '2026-10-04T15:25:00-03:00',
  });
  const esperado = botoes.map((linha) => linha.map((b) => b.texto.normalize('NFC')));
  for (const rel of PAGINAS) {
    const fig = tela(secao(ler(rel), 'telegram'), 'Pedido de OK');
    assert.equal(primeiraBolha(fig), texto.normalize('NFC'), `${rel}: o texto do pedido de OK`);
    assert.deepEqual(teclado(fig), esperado, `${rel}: os botoes do pedido de OK`);
  }
});

test('pagina-ok 2. Telegram, a resposta ao toque no topo da tela e a do porteiro (opcaoAnotada e okAnotei)', { skip: SEM_PAGINAS }, () => {
  const F = frasesTg();
  for (const rel of PAGINAS) {
    const tg = secao(ler(rel), 'telegram');
    assert.equal(respostaAoToque(tela(tg, 'O toque é a resposta')), F.opcaoAnotada('A'), `${rel}: o toque em A) Azul`);
    assert.equal(respostaAoToque(tela(tg, 'Pedido de OK')), F.okAnotei('Sim'), `${rel}: o toque em Sim`);
  }
});

test('pagina-ok 3. a validade do OK na pagina e a do ok-wpp (VALIDADE_MS)', { skip: SEM_PAGINAS }, () => {
  const min = validadeMin();
  for (const rel of PAGINAS) {
    const html = ler(rel);
    assert.ok(html.includes(`<b>${min}<i>min</i></b><span>validade do OK`), `${rel}: o numero do topo (${min} min)`);
    assert.ok(secao(html, 'uso').includes(`Vale ${min} minutos`), `${rel}: a regra de uso ("Vale ${min} minutos")`);
  }
});

test('pagina-ok 4. as palavras de exemplo do OK citado no grupo aprovam no ok-wpp (classificarResposta citada)', { skip: SEM_PAGINAS }, () => {
  for (const rel of PAGINAS) {
    const m = /com as suas palavras \(([^)]*)\)/.exec(secao(ler(rel), 'uso'));
    assert.ok(m, `${rel}: a regra do OK citado ("com as suas palavras (...)") sumiu`);
    const palavras = [...textoDe(m[1]).matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    assert.ok(palavras.length >= 2, `${rel}: os exemplos entre aspas sumiram`);
    for (const p of palavras) {
      assert.equal(classificarResposta(p, { citada: true }), 'sim', `${rel}: "${p}" citando o pedido`);
    }
  }
});
