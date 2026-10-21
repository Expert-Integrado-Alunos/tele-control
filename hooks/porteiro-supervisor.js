#!/usr/bin/env node
'use strict';
/*
 * porteiro-supervisor.js — SessionStart (startup|resume|clear). Religa o porteiro do sessoes-wpp quando ele morreu.
 * Plano: PLANO.md (fase 3, pos-rodada 2 do GPT-6).
 *
 * Por que existe (GPT-6 rodada 2, 27/09/2026 23:47, achado 12): o porteiro so sobe no login (.vbs na pasta Startup) e
 * quando alguem roda `porteiro garantir`. Morreu no meio do dia (queda, taskkill, reinicio de outra aba) = o dono fica
 * sem o canal ate alguem notar. Agora abrir, retomar ou limpar qualquer sessao do Claude Code
 * confere a trava do porteiro e, com dono morto, roda o MESMO .vbs do login.
 *
 * Decisoes:
 * 1. So roda onde o sessoes-wpp existe: Windows + config.json na pasta de estado. VPS, notebook e maquina sem o recurso
 *    = silencio (a policy e da frota inteira).
 * 2. Religa pelo wscript + .vbs, nunca com spawn direto do porteiro: o .vbs tira as variaveis da aba (id, pid, socket,
 *    entrypoint) que o porteiro herdaria (caso real).
 * 3. Parado de proposito fica parado: arquivo `desligado` na pasta de estado = nao religa. (`porteiro parar` nao cria
 *    esse arquivo: religar e "parar + .vbs", e parar sem o arquivo volta na proxima sessao.)
 * 4. No maximo 1 tentativa a cada 3 min (supervisor.json): porteiro que morre ao subir nao vira laco a cada aba aberta.
 *    Duas sessoes ao mesmo tempo podem tentar juntas; a trava porteiro.lock (flag wx) deixa so um porteiro de pe.
 * 5. Nada no stdout (SessionStart poe o stdout no contexto da sessao) e sempre exit 0; o rastro vai pro log do
 *    sessoes-wpp. Espera o `spawn`/`error` do wscript (max 2 s) pra falha ao lancar nao sumir (achado 13).
 * 6. Pid vivo na trava = porteiro vivo, igual ao `garantir` (pid reaproveitado por outro processo engana os dois).
 * 7. M4a (PLANO-MAC.md, "Mapa", linha 1): no Mac (darwin) as mesmas condicoes, mas o lancador e o LaunchAgent: com o
 *    plist em ~/Library/LaunchAgents, `launchctl kickstart gui/<uid>/<LABEL_MAC>`; sem ele, 1 linha no log e nada feito.
 *    Outra plataforma (Linux da VPS) = silencio. `main(opcoes)` aceita {platform, spawn, uid, home, existe} (teste);
 *    sem argumento = o sistema, e o Windows segue o caminho de antes.
 *
 * Env (teste e override): SESSOES_WPP_DIR, SESSOES_WPP_LOG (lib/sessoes-wpp.js) e SESSOES_WPP_PORTEIRO_VBS (o .vbs).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const lib = require('./lib/sessoes-wpp.js');

const INTERVALO_MS = 3 * 60 * 1000;
const ESPERA_SPAWN_MS = 2000;
const VBS_PADRAO = path.join(__dirname, '..', 'sessoes-wpp-porteiro.vbs');

function pidVivo(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (err) { return err && err.code === 'EPERM'; }
}

function lerPid(arq) {
  try { return Number(String(fs.readFileSync(arq, 'utf8')).trim()) || null; } catch (_) { return null; }
}

function ultimaTentativa(arq) {
  try { return Number(JSON.parse(fs.readFileSync(arq, 'utf8')).em) || 0; } catch (_) { return 0; }
}

function lancar(vbs, logFile) {
  return new Promise((resolver) => {
    let filho;
    const fim = (msg) => { if (msg) lib.log(logFile, msg); resolver(); };
    const corte = setTimeout(() => fim('supervisor: wscript nao respondeu em 2 s (sem confirmacao de que subiu)'), ESPERA_SPAWN_MS);
    try {
      filho = spawn('wscript.exe', [vbs], { detached: true, stdio: 'ignore', windowsHide: true });
    } catch (err) {
      clearTimeout(corte);
      return fim(`supervisor: religar o porteiro falhou (wscript): ${String((err && err.message) || err).slice(0, 160)}`);
    }
    filho.once('spawn', () => { clearTimeout(corte); filho.unref(); fim(); });
    filho.once('error', (err) => { clearTimeout(corte); fim(`supervisor: religar o porteiro falhou (wscript): ${String((err && err.message) || err).slice(0, 160)}`); });
  });
}

// M4a (PLANO-MAC.md, "Mapa", linha 1): no Mac o lancador e o LaunchAgent do launchd. `launchctl kickstart
// gui/<uid>/<label>` sobe o agente carregado e parado (o porteiro que saiu com 0 nao volta sozinho: KeepAlive so religa
// saida com erro). Mesma espera de 2 s pelo `spawn`/`error` do .vbs.
function lancarMac(spawnFn, uid, logFile) {
  return new Promise((resolver) => {
    let filho;
    const fim = (msg) => { if (msg) lib.log(logFile, msg); resolver(); };
    const corte = setTimeout(() => fim('supervisor: launchctl nao respondeu em 2 s (sem confirmacao de que subiu)'), ESPERA_SPAWN_MS);
    try {
      filho = spawnFn('launchctl', ['kickstart', `gui/${uid}/${lib.LABEL_MAC}`], { detached: true, stdio: 'ignore' });
    } catch (err) {
      clearTimeout(corte);
      return fim(`supervisor: religar o porteiro falhou (launchctl): ${String((err && err.message) || err).slice(0, 160)}`);
    }
    filho.once('spawn', () => { clearTimeout(corte); filho.unref(); fim(); });
    filho.once('error', (err) => { clearTimeout(corte); fim(`supervisor: religar o porteiro falhou (launchctl): ${String((err && err.message) || err).slice(0, 160)}`); });
  });
}

// M4a: as mesmas condicoes do Windows (config.json, desligado, pid vivo, 3 min, supervisor.json); o lancador e o plist
// (<home>/Library/LaunchAgents/<LABEL_MAC>.plist, o mesmo caminho do caminhoDoPlist do lib/launchagent.mjs). Sem o plist
// = 1 linha no log e nada feito (sem marcar tentativa, igual ao .vbs ausente).
async function mainMac({ spawn: spawnFn = spawn, uid, home = os.homedir(), existe = fs.existsSync } = {}) {
  const C = lib.caminhos(process.env);
  if (!existe(path.join(C.estadoDir, 'config.json'))) return;
  if (existe(path.join(C.estadoDir, 'desligado'))) return;

  const pid = lerPid(path.join(C.estadoDir, 'porteiro.lock'));
  if (pid && pidVivo(pid)) return;

  const marca = path.join(C.estadoDir, 'supervisor.json');
  const antes = ultimaTentativa(marca);
  if (Date.now() - antes < INTERVALO_MS) return;

  const plist = path.posix.join(String(home), 'Library', 'LaunchAgents', `${lib.LABEL_MAC}.plist`);
  if (!existe(plist)) {
    lib.log(C.logFile, `supervisor: porteiro morto e o plist do launchd nao existe (${plist}); nada feito`);
    return;
  }
  const u = uid === undefined && typeof process.getuid === 'function' ? process.getuid() : uid;
  try { fs.writeFileSync(marca, JSON.stringify({ em: Date.now(), pidMorto: pid || null })); } catch (_) { /* segue */ }
  lib.log(C.logFile, `supervisor: porteiro ${pid ? `morto (pid ${pid})` : 'sem trava'}; religando pelo launchd (abertura de sessao)`);
  await lancarMac(spawnFn, u, C.logFile);
}

async function main(opcoes = {}) {
  const platform = opcoes.platform === undefined ? process.platform : opcoes.platform;
  if (platform === 'darwin') return mainMac(opcoes);
  if (platform !== 'win32') return;
  const C = lib.caminhos(process.env);
  if (!fs.existsSync(path.join(C.estadoDir, 'config.json'))) return;
  if (fs.existsSync(path.join(C.estadoDir, 'desligado'))) return;

  const pid = lerPid(path.join(C.estadoDir, 'porteiro.lock'));
  if (pid && pidVivo(pid)) return;

  const marca = path.join(C.estadoDir, 'supervisor.json');
  const antes = ultimaTentativa(marca);
  if (Date.now() - antes < INTERVALO_MS) return;

  const vbs = process.env.SESSOES_WPP_PORTEIRO_VBS || VBS_PADRAO;
  if (!fs.existsSync(vbs)) {
    lib.log(C.logFile, `supervisor: porteiro morto e o lancador nao existe (${vbs}); nada feito`);
    return;
  }
  try { fs.writeFileSync(marca, JSON.stringify({ em: Date.now(), pidMorto: pid || null })); } catch (_) { /* segue */ }
  lib.log(C.logFile, `supervisor: porteiro ${pid ? `morto (pid ${pid})` : 'sem trava'}; religando pelo .vbs (abertura de sessao)`);
  await lancar(vbs, C.logFile);
}

if (require.main === module) {
  main().catch((err) => {
    try { lib.log(lib.caminhos(process.env).logFile, `supervisor: erro interno (ignorado): ${String((err && err.message) || err).slice(0, 160)}`); } catch (_) { /* nada */ }
  }).finally(() => process.exit(0));
}

module.exports = { main };
