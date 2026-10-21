// sessoes-wpp — o LaunchAgent do porteiro no Mac (PLANO-MAC.md, "Mapa", linha 1; disparo M4a).
// Por que existe: no Windows o porteiro sobe no login pelo sessoes-wpp-porteiro.vbs (pasta Startup + guardiao de 60 s).
// No Mac quem faz isso e o launchd: o plist em ~/Library/LaunchAgents sobe o `porteiro.mjs rodar` no login (RunAtLoad)
// e religa quando ele cai com erro (KeepAlive com SuccessfulExit false). Saida 0 (o `parar`, o "outro porteiro vivo",
// o arquivo `desligado`) = o launchd nao religa: parar e parar.
// Puro: so monta texto (nada de disco nem processo). Quem grava o plist e o tools/mac/instalar-mac.sh (pelo
// tools/mac/gerar-plist.mjs); quem le o caminho e o garantirMac do porteiro e o hooks/porteiro-supervisor.js.
// O label vem do hooks/lib/sessoes-wpp.js (LABEL_MAC, fonte unica); o parametro `label` existe so pro ensaio num Mac do
// GitHub (M6), com um label de teste.
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LABEL_MAC } = require('../hooks/lib/sessoes-wpp.js');

export { LABEL_MAC };

// Label do launchd: nome reverso de dominio (letras, digitos, ponto, hifen, sublinhado); vira nome de arquivo e alvo do
// launchctl (gui/<uid>/<label>), entao barra, espaco e o resto ficam fora.
const RE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function exigirCaminho(nome, v) {
  if (typeof v !== 'string' || !path.posix.isAbsolute(v) || v.includes('\0')) {
    throw new TypeError(`${nome} tem que ser caminho absoluto POSIX (veio ${JSON.stringify(v)})`);
  }
  return v;
}

function exigirLabel(label) {
  if (typeof label !== 'string' || !RE_LABEL.test(label) || label.includes('..')) {
    throw new TypeError(`label do launchd ruim: ${JSON.stringify(label)}`);
  }
  return label;
}

/** Texto pro XML: & < > " ' viram entidade. */
export function escaparXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** O plist do LaunchAgent: <home>/Library/LaunchAgents/<label>.plist (path.posix). home fora do POSIX absoluto = TypeError. */
export function caminhoDoPlist(home, label = LABEL_MAC) {
  exigirCaminho('home', home);
  return path.posix.join(home, 'Library', 'LaunchAgents', `${exigirLabel(label)}.plist`);
}

const str = (v) => `<string>${escaparXml(v)}</string>`;

/**
 * O XML do plist do porteiro: Label; ProgramArguments [node, <repo>/porteiro.mjs, rodar]; WorkingDirectory = repo;
 * RunAtLoad; KeepAlive {SuccessfulExit: false}; ThrottleInterval 60; ProcessType Interactive; EnvironmentVariables
 * (HOME, PATH com o Homebrew e o ~/.local/bin do claude nativo, LANG); StandardOutPath e StandardErrorPath = logFile.
 * node, repo, home e logFile fora do caminho absoluto POSIX = TypeError; label ruim = TypeError.
 */
export function plistDoPorteiro({ node, repo, home, logFile, label = LABEL_MAC } = {}) {
  exigirCaminho('node', node);
  exigirCaminho('repo', repo);
  exigirCaminho('home', home);
  exigirCaminho('logFile', logFile);
  exigirLabel(label);
  const caminho = ['/opt/homebrew/bin', '/usr/local/bin', path.posix.join(home, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>Label</key>',
    `\t${str(label)}`,
    '\t<key>ProgramArguments</key>',
    '\t<array>',
    `\t\t${str(node)}`,
    `\t\t${str(path.posix.join(repo, 'porteiro.mjs'))}`,
    `\t\t${str('rodar')}`,
    '\t</array>',
    '\t<key>WorkingDirectory</key>',
    `\t${str(repo)}`,
    '\t<key>RunAtLoad</key>',
    '\t<true/>',
    '\t<key>KeepAlive</key>',
    '\t<dict>',
    '\t\t<key>SuccessfulExit</key>',
    '\t\t<false/>',
    '\t</dict>',
    '\t<key>ThrottleInterval</key>',
    '\t<integer>60</integer>',
    '\t<key>ProcessType</key>',
    `\t${str('Interactive')}`,
    '\t<key>EnvironmentVariables</key>',
    '\t<dict>',
    '\t\t<key>HOME</key>',
    `\t\t${str(home)}`,
    '\t\t<key>PATH</key>',
    `\t\t${str(caminho)}`,
    '\t\t<key>LANG</key>',
    `\t\t${str('en_US.UTF-8')}`,
    '\t</dict>',
    '\t<key>StandardOutPath</key>',
    `\t${str(logFile)}`,
    '\t<key>StandardErrorPath</key>',
    `\t${str(logFile)}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}
