// sessoes-wpp — a trava de arquivo propria: exclusao entre PROCESSOS no ler-alterar-gravar de um arquivo de estado
// compartilhado (o pedido de OK, o marker da trava de publicacao e o ledger da trava de disparo).
//
// Por que existe (A5c, PLANO-ABERTO.md "A5c — a trava própria e o OK numa máquina nova"): o ok-wpp carregava a trava de
// arquivo do ambiente do dono, instalada fora deste repositorio; numa maquina sem ela todo verificar caia e o OK nao
// funcionava numa instalacao nova. Esta e a mesma trava, no MESMO protocolo: as duas implementacoes se excluem no mesmo
// arquivo (o ambiente do dono pode seguir travando com a dele o marker e o ledger que este repositorio tambem grava).
// Sem ela, dois processos leem a mesma versao do JSON e o segundo a gravar apaga a mudanca do primeiro (OK perdido, "uso
// unico" consumido duas vezes); o rename atomico so impede o arquivo pela metade.
//
// Protocolo: `<arquivo>.lock` criado com open 'wx' (so cria se nao existe) com {pid, at, token}. Quem nao pega (EEXIST,
// ou EPERM/EACCES/EBUSY: no Windows a trava de outro processo sendo apagada) espera em passos de 20 ms ate `esperaMs`;
// estourou = lanca erro com code TRAVA_OCUPADA (quem chama decide: nunca grava sem a trava). Trava de dono morto, mais
// velha que `velhaMs` ou ilegivel ha mais de 1 s = abandonada: remove so se ainda e a mesma que foi julgada e tenta de
// novo. Solta so a trava com o PROPRIO token, tambem no process.exit dentro do trecho (que nao roda `finally`).
//
// Limite: entre ler e apagar uma trava abandonada ha uma janela de microssegundos em que dois processos recuperando a
// MESMA trava morta podem entrar juntos. So acontece depois de um processo morrer segurando a trava (o trecho dura
// milissegundos).
//
// Sincrono de proposito: o ok-wpp chama dentro de um passo sem await.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PASSO_MS = 20;
const OCUPADA = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);
const ILEGIVEL_TOLERANCIA_MS = 1000; // quem acabou de criar ainda pode estar escrevendo o conteudo

function dormir(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** O processo `pid` esta vivo? (EPERM = existe, mas e de outro usuario: vivo.) */
export function pidVivo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return Boolean(e) && e.code === 'EPERM';
  }
}

function lerDono(lock) {
  let bruto;
  let mtime = 0;
  try {
    bruto = fs.readFileSync(lock, 'utf8');
    mtime = fs.statSync(lock).mtimeMs;
  } catch {
    return { sumiu: true };
  }
  try {
    const j = JSON.parse(bruto);
    if (j && typeof j === 'object' && typeof j.token === 'string') return { dono: j, mtime };
  } catch { /* ilegivel */ }
  return { ilegivel: true, mtime, bruto };
}

function abandonada(info, velhaMs) {
  if (info.sumiu) return false;
  if (info.ilegivel) return Date.now() - info.mtime > ILEGIVEL_TOLERANCIA_MS;
  const idade = Date.now() - Number(info.dono.at || 0);
  return !(idade <= velhaMs) || !pidVivo(Number(info.dono.pid));
}

// Apaga so se o arquivo ainda e o mesmo que foi julgado abandonado (outro processo pode ter recuperado antes).
function removerAbandonada(lock, info) {
  const agora = lerDono(lock);
  if (agora.sumiu) return;
  const mesmo = info.ilegivel
    ? agora.ilegivel && agora.bruto === info.bruto
    : agora.dono && agora.dono.token === info.dono.token;
  if (!mesmo) return;
  try { fs.unlinkSync(lock); } catch { /* outro removeu */ }
}

function soltar(lock, token) {
  const info = lerDono(lock);
  if (info.dono && info.dono.token === token) {
    try { fs.unlinkSync(lock); } catch { /* ja saiu */ }
  }
}

/**
 * Roda `fn` (sincrono) com `<arquivo>.lock` na mao e devolve o que ele devolver; o erro do `fn` sobe igual, com a trava
 * solta. `velhaMs` = idade que tira a trava de um dono AINDA VIVO (dono morto sai na hora): 2 min, porque um dono vivo
 * suspenso no meio do trecho por mais tempo que isso perderia a trava pra outro e os 2 gravariam; o trecho dura
 * milissegundos e um pid reaproveitado pelo Windows segura no maximo 2 min (negando, nunca gravando junto).
 * Ocupada alem de `esperaMs` = Error com code 'TRAVA_OCUPADA'.
 */
export function comTrava(arquivo, fn, { esperaMs = 3000, velhaMs = 120000 } = {}) {
  const lock = `${arquivo}.lock`;
  const token = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  const limite = Date.now() + esperaMs;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (;;) {
    let fd = null;
    try {
      fd = fs.openSync(lock, 'wx');
    } catch (e) {
      if (!e || !OCUPADA.has(e.code)) throw e;
    }
    if (fd !== null) {
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token }));
      } finally {
        fs.closeSync(fd);
      }
      break;
    }
    const info = lerDono(lock);
    if (abandonada(info, velhaMs)) {
      removerAbandonada(lock, info);
      continue;
    }
    if (Date.now() >= limite) {
      const err = new Error(`trava ocupada: ${path.basename(lock)} (esperou ${esperaMs} ms)`);
      err.code = 'TRAVA_OCUPADA';
      throw err;
    }
    dormir(PASSO_MS);
  }
  const aoSair = () => soltar(lock, token);
  process.on('exit', aoSair);
  try {
    return fn();
  } finally {
    process.removeListener('exit', aoSair);
    soltar(lock, token);
  }
}
