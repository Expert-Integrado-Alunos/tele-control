// sessoes-wpp — a configuracao do dono (`<estadoDir>/config.json`) lida num lugar so.
// Por que existe: o chat do dono, o id do bot, o nome do bot e a variavel da chave saem do codigo e passam a vir daqui,
// pra copia aberta servir a qualquer pessoa com o bot dela; as fases seguintes leem daqui tambem. Puro: so le o arquivo;
// nunca escreve, nunca loga e nunca lanca (config ausente ou ruim = padroes e null).
// Contrato: PLANO-ABERTO.md, "A1 — Telegram pela configuração" ("Contratos"), "A2a — valores", "A2b — WhatsApp
// desligado", "A3a — pastas de projeto, central e o claude", "A3b — apps, Orca e VS Code", "A4a — o dono no config e
// o fuso", "A4b — os textos", "A5a — os botões de funcionamento", "A5c — a trava própria e o OK numa máquina
// nova" e "A5d — a central montada" (o modoPermissao).
import fs from 'node:fs';
import path from 'node:path';
import { FUSO_PADRAO } from './formato.mjs';
import { ehMac } from './plataforma.mjs';

/** Padroes do Telegram quando o config.json nao traz um valor valido (A4a: o nome neutro; o /instalar grava o do bot). */
export const PADRAO_TG = Object.freeze({ nomeBot: 'sem nome', varChave: 'SESSOES_WPP_TELEGRAM_TOKEN' });

const MAX_NOME_BOT = 64; // caracteres do nome do bot (aparado)
export const RE_VAR_CHAVE = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/; // nome de variavel de ambiente (e o do chaveTelegram, A1b1)
const RE_ID = /^\d{1,16}$/; // id em texto: so digitos, ate 16

const ehObjeto = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** O `<estadoDir>/config.json` como objeto. Ausente, ilegivel, array ou nao-objeto = {}. Nunca lanca. */
export function lerConfig(estadoDir) {
  if (typeof estadoDir !== 'string' || !estadoDir) return {};
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(estadoDir, 'config.json'), 'utf8'));
    return ehObjeto(cfg) ? cfg : {};
  } catch {
    return {};
  }
}

/** Id do Telegram (chat ou bot): inteiro seguro > 0, em numero ou em texto so de digitos (ate 16); senao null. */
function idTelegram(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && RE_ID.test(v) ? Number(v) : Number.NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * {chatId, botId, nomeBot, varChave} a partir de `cfg.telegram`: chatId/botId = idTelegram senao null; nomeBot = texto
 * aparado de 1 a 64 senao o padrao; varChave = nome de variavel (RE_VAR_CHAVE) senao o padrao. cfg (ou cfg.telegram)
 * que nao e objeto = padroes e null. Um campo ruim nao invalida os outros.
 */
export function identidadeTelegram(cfg) {
  const t = ehObjeto(cfg) && ehObjeto(cfg.telegram) ? cfg.telegram : {};
  const nome = typeof t.nomeBot === 'string' ? t.nomeBot.trim() : '';
  const tamanho = [...nome].length;
  return {
    chatId: idTelegram(t.chatId),
    botId: idTelegram(t.botId),
    nomeBot: tamanho >= 1 && tamanho <= MAX_NOME_BOT ? nome : PADRAO_TG.nomeBot,
    varChave: typeof t.varChave === 'string' && RE_VAR_CHAVE.test(t.varChave) ? t.varChave : PADRAO_TG.varChave,
  };
}

/** A2a: a entrada do MCP do WhatsApp no ~/.claude.json quando o config.json nao traz um nome valido. */
export const PADRAO_WPP = Object.freeze({ mcp: 'whatsapp-agent' });
export const RE_GRUPO_WPP = /^\d{10,30}-group$/; // o id do grupo no whatsapp-agent
export const RE_NUMERO_WPP = /^\d{10,15}$/; // telefone so com digitos (com o pais)
export const RE_NOME_WPP = /^[A-Za-z0-9_.-]{1,64}$/; // nome de instancia ou da entrada do MCP
// Os campos que o WhatsApp exige pra ligar, na ordem do motivo
const CAMPOS_WPP = Object.freeze([
  ['grupo', RE_GRUPO_WPP], ['instanciaEnvio', RE_NOME_WPP], ['instanciaConferencia', RE_NOME_WPP],
  ['numeroDono', RE_NUMERO_WPP], ['numeroRobo', RE_NUMERO_WPP],
]);
export const WPP_DESLIGADO_NO_CONFIG = 'desligado no config';

/**
 * A2a: o WhatsApp desta maquina pelo bloco `whatsapp` do config.json -> {ligado, motivo, mcp, grupo, instanciaEnvio,
 * instanciaConferencia, numeroDono, numeroRobo}. Cada campo e texto no formato (grupo `^\d{10,30}-group$`, numeros
 * `^\d{10,15}$`, instancias e mcp `^[A-Za-z0-9_.-]{1,64}$`) ou null; o mcp ruim cai no padrao (whatsapp-agent). `ligado`
 * so com `whatsapp.ligado === true` E os 5 campos validos (sem o bloco = desligado: o padrao do produto e o Telegram);
 * `motivo` = null ligado, 'desligado no config' sem o true, senao 'falta ou fora do formato: <campos>' (so o nome dos
 * campos, nunca o valor). O grupo vem do config e nunca de quem chama: o cliente (wpp.mjs) so manda pra ele.
 */
export function identidadeWhatsapp(cfg) {
  const w = ehObjeto(cfg) && ehObjeto(cfg.whatsapp) ? cfg.whatsapp : {};
  const ident = { mcp: typeof w.mcp === 'string' && RE_NOME_WPP.test(w.mcp) ? w.mcp : PADRAO_WPP.mcp };
  for (const [campo, re] of CAMPOS_WPP) ident[campo] = typeof w[campo] === 'string' && re.test(w[campo]) ? w[campo] : null;
  const faltam = CAMPOS_WPP.map(([campo]) => campo).filter((campo) => ident[campo] === null);
  const ligado = w.ligado === true && faltam.length === 0;
  let motivo = null;
  if (w.ligado !== true) motivo = WPP_DESLIGADO_NO_CONFIG;
  else if (!ligado) motivo = `falta ou fora do formato: ${faltam.join(', ')}`;
  return { ligado, motivo, ...ident };
}

/**
 * A2b + A2a: o WhatsApp desta maquina esta ligado? = identidadeWhatsapp(cfg).ligado. Desligado = o porteiro, o ok-wpp e o
 * ler-grupo nunca leem nem escrevem no grupo (o notebook com outro bot, sem o grupo do PC; a copia aberta sem WhatsApp).
 */
export function whatsappLigado(cfg) {
  return identidadeWhatsapp(cfg).ligado;
}

// ---------- A3a: as pastas de projeto, a central e o claude.exe ----------

export const MAX_RAIZES = 20; // pastas de projeto aproveitadas do config (as primeiras boas)
/** A central quando o config.json nao traz um nome valido (o padrao do produto). */
export const PADRAO_CENTRAL = Object.freeze({ nome: 'Central do Tele Control' });
// Nome da central: so ASCII (vai pro perfil do Windows Terminal que o abrir-central.vbs grava e no -n), sem aspas, %, ;,
// | nem barra; 1 a 60 caracteres, o 1o letra ou numero
const RE_NOME_CENTRAL = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,59}$/;
// Pasta: o `;` separa comando na linha do wt.exe (a pasta da central vai la); os outros o cmd/Shell.Run nao passam
// inteiros ou o Windows nao aceita em nome de pasta. Uma regra so pras pastas de projeto e a da central.
const RUIM_NA_PASTA = /["%;<>|*?\u0000-\u001f\u007f]/;
// claude.exe: aspas fecham, % o Shell.Run expande, ; separa comando na linha do wt.exe
const RUIM_NO_CLAUDE = /["%;\u0000-\u001f\u007f]/;

/**
 * Pasta absoluta do Windows (`X:\...` ou `X:/...`, aparada) sem caractere ruim e que nao e a raiz do disco ->
 * normalizada (`.` e `..` resolvidos, `/` vira `\`, sem a barra do fim, letra do disco MAIUSCULA, a da T13) | null.
 */
function pastaDoConfig(v) {
  if (ehMac()) return pastaDoConfigMac(v);
  if (typeof v !== 'string') return null;
  const bruta = v.trim();
  if (!/^[A-Za-z]:[\\/]/.test(bruta) || RUIM_NA_PASTA.test(bruta)) return null;
  const p = path.win32.normalize(bruta).replace(/\\+$/, '');
  if (!/^[A-Za-z]:\\./.test(p)) return null; // a raiz do disco (C:\ virou C:)
  return p[0].toUpperCase() + p.slice(1);
}

/**
 * M1 (PLANO-MAC.md, linha 0): o pastaDoConfig no Mac. Pasta absoluta POSIX (`/...`, aparada) sem caractere ruim e que
 * nao e a raiz `/` -> normalizada (`path.posix.normalize`: `.`, `..` e barra dobrada resolvidos), sem a barra do fim, a
 * caixa como veio | null. `X:\` (Windows), relativo e `~` = null.
 */
function pastaDoConfigMac(v) {
  if (typeof v !== 'string') return null;
  const bruta = v.trim();
  if (!bruta.startsWith('/') || RUIM_NA_PASTA.test(bruta)) return null;
  const p = path.posix.normalize(bruta).replace(/\/+$/, '');
  return p.length > 1 ? p : null; // a raiz (`/` virou vazio)
}

/**
 * A3a: as pastas de projeto pelo bloco `sessoes` -> {raizes, soNaRaiz}. `raizes` = os itens de `sessoes.raizes` que o
 * pastaDoConfig aceita, normalizados, sem repetir (sem caso; fica o 1o), no maximo MAX_RAIZES, na ordem do config; sem
 * o bloco ou sem item bom = [] (o porteiro nao abre sessao nova nem reabre fechada). `soNaRaiz` = false so com
 * `sessoes.soNaRaiz === false`.
 */
export function sessoesDoConfig(cfg) {
  const s = ehObjeto(cfg) && ehObjeto(cfg.sessoes) ? cfg.sessoes : {};
  const raizes = [];
  const vistas = new Set();
  for (const item of Array.isArray(s.raizes) ? s.raizes : []) {
    const p = pastaDoConfig(item);
    if (p === null || vistas.has(p.toLowerCase())) continue;
    vistas.add(p.toLowerCase());
    raizes.push(p);
    if (raizes.length >= MAX_RAIZES) break;
  }
  return { raizes, soNaRaiz: s.soNaRaiz !== false };
}

/**
 * A3a: a central pelo bloco `central` -> {pasta, nome, modoPermissao}. `pasta` = `central.pasta` pelo pastaDoConfig,
 * senao o `repo` (a pasta do repositorio, onde a pessoa instalou) pela mesma regra, senao null. `nome` = `central.nome`
 * aparado no RE_NOME_CENTRAL, senao PADRAO_CENTRAL.nome. A5d: `modoPermissao` = 'sozinha' so com
 * `central.modoPermissao === "sozinha"`; ausente ou outro valor = 'pedir' (na duvida, o seguro). Um campo ruim nao
 * derruba o outro; nunca lanca.
 */
export function identidadeCentral(cfg, opcoes) {
  const c = ehObjeto(cfg) && ehObjeto(cfg.central) ? cfg.central : {};
  const repo = ehObjeto(opcoes) ? opcoes.repo : undefined;
  const nome = typeof c.nome === 'string' ? c.nome.trim() : '';
  return {
    pasta: pastaDoConfig(c.pasta) ?? pastaDoConfig(repo),
    nome: RE_NOME_CENTRAL.test(nome) ? nome : PADRAO_CENTRAL.nome,
    modoPermissao: c.modoPermissao === 'sozinha' ? 'sozinha' : 'pedir',
  };
}

// O arquivo existe (pasta nao serve); erro = nao
function ehArquivo(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * A3a: o caminho do claude.exe, nesta ordem: `claude.bin` do config, `CLAUDE_BIN` do ambiente (o duble de hoje),
 * `%USERPROFILE%\.local\bin\claude.exe` (o instalador oficial) e o 1o `claude.exe` das pastas do PATH (a chave achada sem
 * caso; pasta entre aspas perde as aspas). Cada um so se for absoluto (`X:\`), terminado em `.exe` (sem caso), sem
 * aspas, %, ; nem caractere de controle, e `existe` (arquivo; o padrao olha o disco). Nenhum = o do instalador oficial
 * mesmo assim; sem USERPROFILE = `claude.exe`. Nunca lanca (`existe` que lanca = nao existe).
 */
export function claudeDoConfig(cfg, opcoes) {
  const o = ehObjeto(opcoes) ? opcoes : {};
  const env = ehObjeto(o.env) ? o.env : {};
  const existe = typeof o.existe === 'function' ? o.existe : ehArquivo;
  if (ehMac()) return claudeDoConfigMac(cfg, env, existe);
  const bom = (p) => typeof p === 'string' && /^[A-Za-z]:\\/.test(p) && /\.exe$/i.test(p) && !RUIM_NO_CLAUDE.test(p);
  const achado = (p) => {
    if (!bom(p)) return false;
    try { return existe(p) === true; } catch { return false; }
  };
  const doCfg = ehObjeto(cfg) && ehObjeto(cfg.claude) ? cfg.claude.bin : undefined;
  const perfil = typeof env.USERPROFILE === 'string' ? env.USERPROFILE.trim() : '';
  const local = perfil ? path.win32.join(perfil, '.local', 'bin', 'claude.exe') : null;
  const chavePath = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  const doPath = (chavePath && typeof env[chavePath] === 'string' ? env[chavePath].split(';') : [])
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1').trim())
    .filter(Boolean)
    .map((d) => path.win32.join(d, 'claude.exe'));
  for (const c of [doCfg, env.CLAUDE_BIN, local, ...doPath]) {
    if (achado(c)) return c;
  }
  return local !== null && bom(local) ? local : 'claude.exe';
}

// M1: absoluto POSIX (`/...`) sem aspas, %, ; nem controle; sem exigir `.exe` (claude, orca, python no Mac)
const binarioMacBom = (p) => typeof p === 'string' && p.startsWith('/') && !RUIM_NO_CLAUDE.test(p);

/**
 * M1 (PLANO-MAC.md, linha 0): o claudeDoConfig no Mac, na mesma ordem: `claude.bin` do config, `CLAUDE_BIN`,
 * `$HOME/.local/bin/claude` (o instalador oficial; HOME aparado) e o 1o `claude` das pastas do PATH (separado por `:`,
 * aparadas, vazias fora). Cada um so se for absoluto POSIX sem aspas, %, ; nem controle (binarioMacBom) e `existe`.
 * Nenhum = o do HOME mesmo assim; sem HOME (ou HOME que nao da caminho absoluto) = `claude`.
 */
function claudeDoConfigMac(cfg, env, existe) {
  const achado = (p) => {
    if (!binarioMacBom(p)) return false;
    try { return existe(p) === true; } catch { return false; }
  };
  const doCfg = ehObjeto(cfg) && ehObjeto(cfg.claude) ? cfg.claude.bin : undefined;
  const home = typeof env.HOME === 'string' ? env.HOME.trim() : '';
  const local = home ? path.posix.join(home, '.local', 'bin', 'claude') : null;
  const doPath = (typeof env.PATH === 'string' ? env.PATH.split(':') : [])
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => path.posix.join(d, 'claude'));
  for (const c of [doCfg, env.CLAUDE_BIN, local, ...doPath]) {
    if (achado(c)) return c;
  }
  return local !== null && binarioMacBom(local) ? local : 'claude';
}

// ---------- A3b: os apps (a lista do VS Code e o Orca), o orca.exe e o banco do VS Code ----------

/** Os apps que a pessoa marca na pergunta 1 do /instalar. Rotulo so: `desktop` e `terminal` (as dicas do cartao). */
export const APPS = Object.freeze(['vscode', 'desktop', 'orca', 'terminal']);
/** Sem `apps` no config: o comportamento de antes da A3b (a lista do VS Code e o Orca ligados). */
export const PADRAO_APPS = Object.freeze(['vscode', 'desktop', 'orca']);

/**
 * A3b: os apps pelo `apps` do config -> os itens de texto que, aparados e em minuscula, estao em APPS, sem repetir, na
 * ordem do config. Lista presente manda, [] inclusive (so desconhecidos = []); ausente ou que nao e lista (ou cfg que
 * nao e objeto) = PADRAO_APPS. Lista nova a cada chamada; nunca lanca.
 */
export function appsDoConfig(cfg) {
  const bruto = ehObjeto(cfg) ? cfg.apps : undefined;
  if (!Array.isArray(bruto)) return [...PADRAO_APPS];
  const apps = [];
  for (const item of bruto) {
    const a = typeof item === 'string' ? item.trim().toLowerCase() : '';
    if (APPS.includes(a) && !apps.includes(a)) apps.push(a);
  }
  return apps;
}

/**
 * A3b: o caminho do orca.exe (a linha de comando do Orca), no molde do claudeDoConfig: `orca.bin` do config e o do
 * instalador do Orca (`%LOCALAPPDATA%\Programs\orca\resources\bin\orca.exe`); cada um so se for absoluto (`X:\`),
 * terminado em `.exe` (sem caso), sem aspas, %, ; nem caractere de controle, e `existe` (arquivo; o padrao olha o disco).
 * Nenhum = o do instalador mesmo assim; sem LOCALAPPDATA = null (o abrirNoOrcaReal rejeita: a fechada reabre escondida).
 * Nunca lanca (`existe` que lanca = nao existe).
 */
export function orcaDoConfig(cfg, opcoes) {
  const o = ehObjeto(opcoes) ? opcoes : {};
  const env = ehObjeto(o.env) ? o.env : {};
  const existe = typeof o.existe === 'function' ? o.existe : ehArquivo;
  const bom = (p) => typeof p === 'string' && /^[A-Za-z]:\\/.test(p) && /\.exe$/i.test(p) && !RUIM_NO_CLAUDE.test(p);
  const doCfg = ehObjeto(cfg) && ehObjeto(cfg.orca) ? cfg.orca.bin : undefined;
  if (ehMac()) {
    // M1: no Mac so o `orca.bin` do config (absoluto POSIX e existente); nao tem caminho padrao
    if (!binarioMacBom(doCfg)) return null;
    try { return existe(doCfg) === true ? doCfg : null; } catch { return null; }
  }
  const local = typeof env.LOCALAPPDATA === 'string' ? env.LOCALAPPDATA.trim() : '';
  const padrao = local ? path.win32.join(local, 'Programs', 'orca', 'resources', 'bin', 'orca.exe') : null;
  for (const c of [doCfg, padrao]) {
    if (!bom(c)) continue;
    try { if (existe(c) === true) return c; } catch { /* nao existe */ }
  }
  return padrao !== null && bom(padrao) ? padrao : null;
}

// Banco do VS Code: so o Node abre (sem shell); aspas e % (o config nao expande variavel) e o que o Windows nao aceita em
// caminho ficam de fora
const RUIM_NO_BANCO = /["%<>|*?\u0000-\u001f\u007f]/;

/**
 * A3b: o `vscode.banco` do config (o `state.vscdb` de outro VS Code: Insiders, Cursor...) -> aparado, absoluto (`X:\` ou
 * `X:/`), sem RUIM_NO_BANCO, normalizado (`/` vira `\`) e que nao termina em barra (pasta; a raiz do disco inclusive);
 * senao null (o leitor cai no SESSOES_WPP_VSCODE_DB e no do APPDATA). Nao olha o disco: arquivo que nao existe = a lista
 * vazia (lib/lista-vscode.mjs). Nunca lanca.
 */
export function bancoVsCodeDoConfig(cfg) {
  const v = ehObjeto(cfg) && ehObjeto(cfg.vscode) ? cfg.vscode.banco : undefined;
  if (typeof v !== 'string') return null;
  const bruto = v.trim();
  if (ehMac()) {
    // M1: absoluto POSIX, normalizado e que nao termina em `/` (pasta; a raiz inclusive)
    if (!bruto.startsWith('/') || RUIM_NO_BANCO.test(bruto)) return null;
    const p = path.posix.normalize(bruto);
    return p.endsWith('/') ? null : p;
  }
  if (!/^[A-Za-z]:[\\/]/.test(bruto) || RUIM_NO_BANCO.test(bruto)) return null;
  const p = path.win32.normalize(bruto);
  return /^[A-Za-z]:\\./.test(p) && !p.endsWith('\\') ? p : null;
}

// ---------- A4a: o dono (nome, artigo e fuso) ----------

/**
 * O dono quando o config.json nao traz um nome valido: o texto neutro ("do dono"). O /instalar sempre grava o nome (a
 * pergunta 3); o padrao vale pro config feito a mao.
 */
export const PADRAO_DONO = Object.freeze({ nome: 'dono', artigo: 'o' });

const MAX_NOME_DONO = 40; // code points do nome do dono, depois de normalizar
// O 1o e letra; os outros, letra, marca (acento combinado), digito decimal, espaco ou . ' ’ _ -
const RE_NOME_DONO = /^\p{L}[\p{L}\p{M}\p{Nd} .'’_-]*$/u;

/**
 * O nome do dono normalizado (NFC, aparado, espacos seguidos viram 1) se for texto de 1 a 40 code points no
 * RE_NOME_DONO; senao null. Nunca lanca.
 */
export function nomeDoDonoValido(v) {
  if (typeof v !== 'string') return null;
  const nome = v.normalize('NFC').trim().replace(/ {2,}/g, ' ');
  const tamanho = [...nome].length;
  return tamanho >= 1 && tamanho <= MAX_NOME_DONO && RE_NOME_DONO.test(nome) ? nome : null;
}

/**
 * O fuso na forma canonica do Intl (`resolvedOptions().timeZone`: "america/sao_paulo" vira "America/Sao_Paulo") se
 * for texto que, aparado e nao vazio, o Intl.DateTimeFormat aceita no timeZone; senao null. Nunca lanca.
 */
export function fusoValido(v) {
  if (typeof v !== 'string') return null;
  const fuso = v.trim();
  if (!fuso) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: fuso }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

// O fuso desta maquina (o do Windows, ou o TZ do processo); erro = null
function fusoDaMaquina() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * O dono pelo bloco `dono` do config.json -> {nome, artigo, fuso}:
 * - nome = nomeDoDonoValido(dono.nome); ruim ou ausente = o PADRAO_DONO inteiro, nome e artigo juntos ("do dono",
 *   nunca "da dono");
 * - artigo (com nome bom) = 'o' ou 'a' (aparado, minuscula), senao '' (sem artigo: "de Ana"); nunca inferido do nome;
 * - fuso = fusoValido(dono.fuso), senao fusoValido(opcoes.fusoMaquina) (ausente = o do Windows, pelo Intl), senao
 *   FUSO_PADRAO (Brasilia). O fuso do config vale mesmo com o nome ruim.
 * cfg torto = o padrao com o fuso da maquina; nunca lanca.
 */
export function donoDoConfig(cfg, opcoes) {
  let fusoMaquina;
  try {
    fusoMaquina = ehObjeto(opcoes) && opcoes.fusoMaquina !== undefined ? opcoes.fusoMaquina : fusoDaMaquina();
  } catch {
    fusoMaquina = null;
  }
  const daMaquina = fusoValido(fusoMaquina) ?? FUSO_PADRAO;
  try {
    const d = ehObjeto(cfg) && ehObjeto(cfg.dono) ? cfg.dono : {};
    const fuso = fusoValido(d.fuso) ?? daMaquina;
    const nome = nomeDoDonoValido(d.nome);
    if (nome === null) return { ...PADRAO_DONO, fuso };
    const artigo = typeof d.artigo === 'string' ? d.artigo.trim().toLowerCase() : '';
    return { nome, artigo: artigo === 'o' || artigo === 'a' ? artigo : '', fuso };
  } catch {
    return { ...PADRAO_DONO, fuso: daMaquina };
  }
}

// ---------- A4b: as frases do dono nos textos ----------

/**
 * As frases do dono ({nome, artigo}: o donoDoConfig ou o PADRAO_DONO) nos textos que vao pra aba -> {de, ele, Ele, dele}:
 * artigo 'o' = "do Davi"/ele/Ele/dele; 'a' = "da Ana"/ela/Ela/dela; sem artigo = "de Sam" e o proprio nome no lugar do
 * pronome ("Sam respondeu", "se precisar de Sam"). O artigo e conferido de novo (aparado, minuscula; outro valor = sem
 * artigo); nome ruim = o PADRAO_DONO inteiro ("do dono", nunca "da dono"). Nunca lanca.
 */
export function frasesDoDono(dono) {
  let nome = null;
  let artigo = '';
  try {
    if (ehObjeto(dono)) {
      nome = nomeDoDonoValido(dono.nome);
      const a = typeof dono.artigo === 'string' ? dono.artigo.trim().toLowerCase() : '';
      artigo = a === 'o' || a === 'a' ? a : '';
    }
  } catch {
    nome = null;
  }
  if (nome === null) ({ nome, artigo } = PADRAO_DONO);
  if (artigo === 'o') return { de: `do ${nome}`, ele: 'ele', Ele: 'Ele', dele: 'dele' };
  if (artigo === 'a') return { de: `da ${nome}`, ele: 'ela', Ele: 'Ela', dele: 'dela' };
  return { de: `de ${nome}`, ele: nome, Ele: nome, dele: `de ${nome}` };
}

/**
 * O id do bot pela propria chave (`<id>:<segredo>`, o formato oficial): o numero antes do 1o ":" | null. Nunca devolve
 * nem loga o resto.
 */
export function botIdDaChave(token) {
  if (typeof token !== 'string') return null;
  const i = token.indexOf(':');
  return i > 0 ? idTelegram(token.slice(0, i)) : null;
}

// ---------- A5b ----------

/** A5b: a transcricao quando o config.json nao traz o bloco `transcricao` (ou o campo bom). */
export const PADRAO_TRANSCRICAO = Object.freeze({ python: 'python', idioma: 'pt', modeloGpu: 'large-v3-turbo', modeloCpu: 'medium' });
// python.exe: as mesmas regras do claude.exe (aspas fecham, % expande, ; separa comando; controle corta a linha)
const RUIM_NO_PYTHON = /["%;\u0000-\u001f\u007f]/;
const PYTHON_MAC = 'python3'; // M1: o python padrao no Mac (o PADRAO_TRANSCRICAO.python segue o do Windows)
const RE_IDIOMA = /^[a-z]{2,3}$/; // o codigo curto do whisper (pt, en, es, yue...)
// nome do faster-whisper (tamanho, repositorio org/nome ou pasta relativa): letra ou numero no comeco, nunca opcao da
// linha de comando nem caminho absoluto; sem ".." (nunca sai da pasta)
const RE_MODELO = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

/**
 * A5b: a transcricao do audio pelo bloco `transcricao` -> {ligada, python, idioma, modeloGpu, modeloCpu}. `ligada` = so
 * `transcricao.ligada === true` (padrao desligada: quem nao escolheu audio no /instalar nao tem o Python). `python` =
 * `transcricao.python` aparado, absoluto (`X:\`), terminado em `.exe` (sem caso), sem aspas, %, ; nem controle; senao o
 * SESSOES_WPP_PYTHON de `opcoes.env` (aparado); senao `python` (o do PATH, o que o `checar --audio` conferiu). `idioma`
 * = aparado e em minuscula no RE_IDIOMA, senao `pt`. `modeloGpu`/`modeloCpu` = aparados no RE_MODELO sem `..`, senao os
 * do PADRAO_TRANSCRICAO. Um campo ruim nao derruba o outro; nunca lanca.
 */
export function transcricaoDoConfig(cfg, opcoes) {
  const t = ehObjeto(cfg) && ehObjeto(cfg.transcricao) ? cfg.transcricao : {};
  const o = ehObjeto(opcoes) ? opcoes : {};
  const env = ehObjeto(o.env) ? o.env : {};
  const aparado = (v) => (typeof v === 'string' ? v.trim() : '');
  const doCfg = aparado(t.python);
  const doEnv = aparado(env.SESSOES_WPP_PYTHON);
  // M1: no Mac, absoluto POSIX sem `.exe` (mesmo RUIM_NO_PYTHON) e o padrao e `python3` (o do PATH do macOS)
  const pyBom = ehMac()
    ? doCfg.startsWith('/') && !RUIM_NO_PYTHON.test(doCfg)
    : /^[A-Za-z]:\\/.test(doCfg) && /\.exe$/i.test(doCfg) && !RUIM_NO_PYTHON.test(doCfg);
  const pyPadrao = ehMac() ? PYTHON_MAC : PADRAO_TRANSCRICAO.python;
  const idioma = aparado(t.idioma).toLowerCase();
  const modelo = (v, padrao) => {
    const m = aparado(v);
    return RE_MODELO.test(m) && !m.includes('..') ? m : padrao;
  };
  return {
    ligada: t.ligada === true,
    python: pyBom ? doCfg : doEnv || pyPadrao,
    idioma: RE_IDIOMA.test(idioma) ? idioma : PADRAO_TRANSCRICAO.idioma,
    modeloGpu: modelo(t.modeloGpu, PADRAO_TRANSCRICAO.modeloGpu),
    modeloCpu: modelo(t.modeloCpu, PADRAO_TRANSCRICAO.modeloCpu),
  };
}

// ---------- A5c ----------

// Caminho de trava de fora: so o Node abre (sem shell); aspas, % (o config nao expande variavel) e o que o Windows nao
// aceita em caminho ficam de fora
const RUIM_NA_TRAVA = /["%<>|*?\u0000-\u001f\u007f]/;

// Arquivo absoluto (`X:\` ou `X:/`, aparado) sem RUIM_NA_TRAVA, normalizado (`.` e `..` resolvidos, `/` vira `\`) e
// terminado em `fim` (entao nunca em barra nem na raiz do disco) | null
function arquivoDeTrava(v, fim) {
  if (typeof v !== 'string') return null;
  const aparado = v.trim();
  if (ehMac()) {
    // M1: absoluto POSIX, normalizado (`path.posix.normalize`) e terminado em `fim`
    if (!aparado.startsWith('/') || RUIM_NA_TRAVA.test(aparado)) return null;
    const normalMac = path.posix.normalize(aparado);
    return fim.test(normalMac) ? normalMac : null;
  }
  if (!/^[A-Za-z]:[\\/]/.test(aparado) || RUIM_NA_TRAVA.test(aparado)) return null;
  const normal = path.win32.normalize(aparado);
  return fim.test(normal) ? normal : null;
}

/**
 * A5c: as travas de fora pelo bloco `travas` -> {lib, deployMarker, disparoLedger}. `lib` = a trava de arquivo do
 * ambiente do dono (termina em `.js` ou `.cjs`; o ok-wpp carrega so na hora de travar); `deployMarker` = o marker da
 * trava de publicacao e `disparoLedger` = o ledger da trava de disparo (terminam em `.json`). Cada um pelo
 * arquivoDeTrava; senao null (sem lib = a trava propria, lib/trava.mjs; sem marker ou ledger = o OK nao grava nele). Um
 * campo ruim nao derruba o outro. Nao olha o disco; nunca lanca.
 */
export function travasDoConfig(cfg) {
  const t = ehObjeto(cfg) && ehObjeto(cfg.travas) ? cfg.travas : {};
  return {
    lib: arquivoDeTrava(t.lib, /\.c?js$/),
    deployMarker: arquivoDeTrava(t.deployMarker, /\.json$/),
    disparoLedger: arquivoDeTrava(t.disparoLedger, /\.json$/),
  };
}

// ---------- A5a ----------
// Os botoes de funcionamento (PLANO-ABERTO.md, "A5a — os botões de funcionamento"): o modo rua, o modelo do mensageiro,
// a voz, o aviso de saude e o nome da maquina. Puras e nunca lancam: bloco ausente ou fora do formato = o padrao (o
// comportamento de antes); um campo ruim nao derruba o outro.

// O campo `k` do bloco `b` do cfg (cfg ou bloco que nao e objeto, ou leitura que lanca = undefined)
function campoDoBloco(cfg, b, k) {
  try {
    const bloco = ehObjeto(cfg) ? cfg[b] : undefined;
    return ehObjeto(bloco) ? bloco[k] : undefined;
  } catch {
    return undefined;
  }
}
// O texto aparado do campo se casar com `re`; senao null
function textoDoBloco(cfg, b, k, re) {
  const v = campoDoBloco(cfg, b, k);
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return re.test(t) ? t : null;
}

/** Padrao do modo rua: liga sozinho com o PC parado 30 min. */
export const PADRAO_MODO_RUA = Object.freeze({ automatico: true, ociosoMin: 30 });
const OCIOSO_MIN = 5; // minutos de PC parado aceitos no modoRua.ociosoMin (inteiro)
const OCIOSO_MAX = 240;

/**
 * O modo rua pelo bloco `modoRua` -> {automatico, ociosoMin}: automatico = false so com `modoRua.automatico === false`
 * (o "to na rua" e o /rua ligam sempre); ociosoMin = inteiro de 5 a 240, senao 30.
 */
export function modoRuaDoConfig(cfg) {
  const n = campoDoBloco(cfg, 'modoRua', 'ociosoMin');
  return {
    automatico: campoDoBloco(cfg, 'modoRua', 'automatico') !== false,
    ociosoMin: Number.isInteger(n) && n >= OCIOSO_MIN && n <= OCIOSO_MAX ? n : PADRAO_MODO_RUA.ociosoMin,
  };
}

/** Padrao do modelo do mensageiro (o `claude -p` que entrega o recado). */
export const PADRAO_MODELO = 'sonnet';
// Apelido ou id do modelo; comeca com letra pra nunca virar opcao da linha de comando
const RE_MODELO_CLAUDE = /^[A-Za-z][A-Za-z0-9._[\]-]{0,63}$/;

/** O modelo do mensageiro pelo `mensageiro.modelo` -> {modelo}: aparado no RE_MODELO_CLAUDE, senao "sonnet". */
export function mensageiroDoConfig(cfg) {
  return { modelo: textoDoBloco(cfg, 'mensageiro', 'modelo', RE_MODELO_CLAUDE) ?? PADRAO_MODELO };
}

/** Padrao da voz (a gratis da Microsoft; o VOZ_ANTONIO do lib/voz.mjs). */
export const PADRAO_VOZ = 'pt-BR-AntonioNeural';
const RE_VOZ = /^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/; // o VOZ_RE do lib/voz-microsoft.mjs (a lingua sai do comeco)

/** A voz da resposta em audio pelo `voz.nome` -> {nome}: aparado no RE_VOZ, senao pt-BR-AntonioNeural. */
export function vozDoConfig(cfg) {
  return { nome: textoDoBloco(cfg, 'voz', 'nome', RE_VOZ) ?? PADRAO_VOZ };
}

/**
 * T29a (PLANO-TELEGRAM.md, "T29a"): a resposta em voz pelo `voz.ligada` -> {ligada}: so `false` desliga (o /voz do menu
 * do bot grava a chave); ausente, outro valor, bloco torto ou cfg torto = ligada.
 */
export function vozLigadaDoConfig(cfg) {
  return { ligada: campoDoBloco(cfg, 'voz', 'ligada') !== false };
}

/**
 * O aviso de saude pelo `saude.varUrl` -> {varUrl}: o nome da variavel (ambiente, senao registro) com a URL do portao,
 * aparado no RE_VAR_CHAVE; senao null (sem aviso de saude: as quedas ficam so no log).
 */
export function saudeDoConfig(cfg) {
  return { varUrl: textoDoBloco(cfg, 'saude', 'varUrl', RE_VAR_CHAVE) };
}

/** Padrao do nome da maquina (no cabecalho e nos headers do aviso de saude). */
export const PADRAO_MAQUINA = 'pc';
// So ASCII (vai em header HTTP), sem _ nem * (quebram o Markdown do aviso); de 1 a 20
const RE_MAQUINA = /^[A-Za-z0-9][A-Za-z0-9.-]{0,19}$/;

/** O nome da maquina pelo `maquina.nome` -> {nome}: aparado no RE_MAQUINA, senao "pc". */
export function maquinaDoConfig(cfg) {
  return { nome: textoDoBloco(cfg, 'maquina', 'nome', RE_MAQUINA) ?? PADRAO_MAQUINA };
}
