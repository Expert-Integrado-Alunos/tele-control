// sessoes-wpp — a plataforma do processo (darwin ou win32) num lugar so.
// Por que existe: o porte pro Mac (PLANO-MAC.md, "Mapa", linha 0, e "Decisoes") guarda aqui a plataforma do processo,
// e os caminhos de config e de pasta perguntam a ela, sem parametro novo em todas as chamadas. So `darwin` vira Mac;
// qualquer outra plataforma (win32, linux...) = `win32`, o comportamento de antes do porte.
// O teste troca a plataforma POR ARQUIVO (cada arquivo de teste roda num processo proprio) com trocarPlataformaParaTeste.
import path from 'node:path';

const PLATAFORMAS = Object.freeze(['darwin', 'win32']);

let atual = process.platform === 'darwin' ? 'darwin' : 'win32';

/** A plataforma do processo: 'darwin' so quando process.platform e 'darwin'; qualquer outra = 'win32'. */
export function plataforma() {
  return atual;
}

/** true so no Mac (plataforma() === 'darwin'). */
export function ehMac() {
  return atual === 'darwin';
}

/** O modulo de caminho da plataforma: path.posix no darwin, path.win32 no resto. */
export function caminhos() {
  return atual === 'darwin' ? path.posix : path.win32;
}

/**
 * SO PARA TESTE (nunca chamar no codigo de producao): troca a plataforma deste processo pra `p` ('darwin' ou 'win32';
 * outra coisa lanca) e devolve a funcao que desfaz a troca (volta a plataforma de antes da chamada). O teste chama no
 * `before` e desfaz no `after`; como cada arquivo de teste roda num processo proprio, a troca nao vaza pra outro arquivo.
 */
export function trocarPlataformaParaTeste(p) {
  if (!PLATAFORMAS.includes(p)) throw new TypeError(`plataforma de teste ruim: ${String(p)} (so darwin ou win32)`);
  const antes = atual;
  atual = p;
  return () => {
    atual = antes;
  };
}
