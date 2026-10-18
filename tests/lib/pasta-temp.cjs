// Pasta temporaria dos testes (caso real, "PC lento": 286 mil pastas de teste com mais de 1 dia no
// %TEMP%, ~2,9 mil novas por hora; a limpeza do Windows entrou 6 vezes na madrugada pra percorrer essas pastas e parou em
// todas). Cada processo de teste cria 1 raiz no TEMP (`sessoes-wpp-testes-<pid>-XXXXXX`) e as pastas dos testes nascem
// dentro dela; quando o processo termina (evento 'exit', sincrono) a raiz sai inteira. Arquivo ainda preso no Windows
// (EBUSY/EPERM/ENOTEMPTY: um filho que nao fechou) = algumas novas tentativas e, se nao der, sobra a raiz: o fim do
// processo nunca falha por isso. Teste que precisa de pasta temporaria usa SO isto (tests/pasta-temp.test.mjs barra o
// resto). CommonJS de proposito: serve aos testes .mjs (import) e aos hooks/tests .js (require).
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let raiz = null;

function apagarRaiz() {
  if (raiz === null) return;
  const r = raiz;
  raiz = null;
  try {
    fs.rmSync(r, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // arquivo ainda preso: sobra esta raiz (a bateria e o sabotar ainda apagam o TEMP deles inteiro)
  }
}

/** Pasta nova e vazia `<prefixo>XXXXXX` dentro da raiz deste processo; a raiz sai inteira quando o processo termina. */
function pastaTemp(prefixo) {
  if (raiz === null) {
    raiz = fs.mkdtempSync(path.join(os.tmpdir(), `sessoes-wpp-testes-${process.pid}-`));
    process.once('exit', apagarRaiz);
  }
  return fs.mkdtempSync(path.join(raiz, String(prefixo)));
}

exports.pastaTemp = pastaTemp;
