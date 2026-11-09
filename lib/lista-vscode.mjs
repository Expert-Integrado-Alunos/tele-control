// sessoes-wpp — a lista de abas do VS Code (T11, PLANO-TELEGRAM.md, "T11 — as abas fechadas da lista do VS Code no
// painel"). A extensao do Claude Code guarda no banco global do VS Code (state.vscdb, tabela ItemTable, chave
// `Anthropic.claude-code`; medido 06/10/2026 23h1x, extensao 2.1.287): `hiddenSessionIds` = as conversas arquivadas e
// `sessionGroups:<pasta da janela>` = os grupos de cada janela ({id, name, collapsed, sessionIds}, na ordem da tela).
// So leitura (o banco abre readOnly e fecha na hora) e so a chave da extensao: nenhuma outra chave do banco e lida.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { normalizar } from './roteamento.mjs';
import { ehMac } from './plataforma.mjs';

const require = createRequire(import.meta.url);

const CHAVE = 'anthropic.claude-code'; // a chave no banco (comparada sem caixa: o VS Code grava "Anthropic.claude-code")
const PREFIXO_GRUPOS = 'sessionGroups:';
const ESPERA_MS = 1000; // banco ocupado (o VS Code gravando): espera ate isso antes de desistir

/**
 * Banco do VS Code: `banco` (A3b: o `vscode.banco` do config, ja conferido pelo bancoVsCodeDoConfig), senao
 * SESSOES_WPP_VSCODE_DB, senao `%APPDATA%/Code/User/globalStorage/state.vscdb`; sem nenhum = null.
 * M2 (PLANO-MAC.md, "Mapa", linha 5): no Mac, depois do SESSOES_WPP_VSCODE_DB, o
 * `<HOME>/Library/Application Support/Code/User/globalStorage/state.vscdb`; sem HOME = null (o APPDATA nao vale no Mac).
 */
export function caminhoBancoVsCode(env = process.env, banco = null) {
  if (typeof banco === 'string' && banco) return banco;
  const e = env || {};
  if (typeof e.SESSOES_WPP_VSCODE_DB === 'string' && e.SESSOES_WPP_VSCODE_DB) return e.SESSOES_WPP_VSCODE_DB;
  if (ehMac()) {
    if (typeof e.HOME !== 'string' || !e.HOME) return null;
    return path.posix.join(e.HOME, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'state.vscdb');
  }
  if (typeof e.APPDATA === 'string' && e.APPDATA) return path.join(e.APPDATA, 'Code', 'User', 'globalStorage', 'state.vscdb');
  return null;
}

/**
 * Pasta comparavel (a chave do grupo grava `c:\projetos`): barras do Windows, sem a barra do fim, minuscula. M2: no Mac,
 * path.posix.normalize, sem as barras do fim (menos a raiz `/`), minuscula (o APFS padrao nao diferencia caixa).
 */
export function raizNormal(p) {
  if (ehMac()) {
    const n = path.posix.normalize(String(p ?? ''));
    return (n.replace(/\/+$/, '') || '/').toLowerCase();
  }
  return path.win32.normalize(String(p ?? '')).replace(/[\\/]+$/, '').toLowerCase();
}

/**
 * Nome do grupo sem o icone do comeco ("❗Prioridade" -> "Prioridade"; so icone = ""). Emoji conta como icone mesmo
 * quando o Unicode o chama de letra ("ℹ️" e U+2139, categoria Ll).
 */
export function nomeDoGrupo(nome) {
  return String(nome ?? '')
    .replace(/^(?:\p{Extended_Pictographic}|[^\p{L}\p{N}])+/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Grupo de concluidas: "conclu" no nome, sem acento e sem caixa ("✔️ CONCLUÍDO"). */
export function ehConcluido(nome) {
  return typeof nome === 'string' && normalizar(nome).includes('conclu');
}

/**
 * A3b: a lista sem nada (nenhuma arquivada, nenhum grupo), objeto novo a cada chamada. E o que o lerListaVsCode devolve
 * pra quem nao tem o VS Code (ou o Claude Code nele) e o leitor que o rodar passa quando o `apps` nao tem o `vscode`: as
 * fechadas saem so das conversas das pastas de projeto, sem grupo, e o painel nao mostra erro.
 */
export function listaVsCodeVazia() {
  return { arquivadas: new Set(), grupos: new Map() };
}

/**
 * O valor da chave da extensao num banco do VS Code que existe -> objeto | undefined (sem a linha da chave) | null (banco
 * que nao abre, ocupado alem de ESPERA_MS, Node sem node:sqlite, sem a tabela, valor nulo, valor que nao e JSON de
 * objeto). Abre readOnly e fecha na hora. Nunca lanca. Serve ao banco global (lerListaVsCode) e ao de cada janela
 * (lerAbasVsCode, T38).
 */
function valorDaChave(arquivo) {
  let bruto;
  try {
    const { DatabaseSync } = require('node:sqlite'); // so aqui: quem nao le a lista nao carrega o sqlite
    const db = new DatabaseSync(arquivo, { readOnly: true, timeout: ESPERA_MS });
    try {
      bruto = db.prepare('SELECT value FROM ItemTable WHERE lower(key) = ?').get(CHAVE)?.value;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
  if (bruto === undefined) return undefined;
  if (bruto === null) return null;
  let v;
  try {
    v = JSON.parse(typeof bruto === 'string' ? bruto : Buffer.from(bruto).toString('utf8'));
  } catch {
    return null;
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

/**
 * A lista do VS Code -> {arquivadas: Set<sessionId>, grupos: Map<raizNormal, [{nome, ids}]>} | null. A3b: banco que nao
 * existe (o VS Code nunca rodou ali; nao cria o arquivo) e banco sem a linha da chave da extensao (VS Code sem o Claude
 * Code) = listaVsCodeVazia(). null (erro) = sem caminho, banco que nao abre (ocupado alem de ESPERA_MS, nao e banco, Node
 * sem node:sqlite), sem a tabela, valor nulo, valor que nao e JSON de objeto, ou hiddenSessionIds que nao e lista. Grupo
 * torto (sem nome de texto ou sem lista de ids) sai; id que nao e texto sai. Nunca lanca.
 */
export function lerListaVsCode(arquivo) {
  if (typeof arquivo !== 'string' || !arquivo) return null;
  if (!fs.existsSync(arquivo)) return listaVsCodeVazia();
  const v = valorDaChave(arquivo);
  if (v === undefined) return listaVsCodeVazia(); // sem a linha da chave: o Claude Code nunca rodou nesse VS Code
  if (v === null) return null;
  if (v.hiddenSessionIds !== undefined && !Array.isArray(v.hiddenSessionIds)) return null;
  const arquivadas = new Set((v.hiddenSessionIds ?? []).filter((x) => typeof x === 'string' && x));
  const grupos = new Map();
  for (const [k, lista] of Object.entries(v)) {
    if (!k.startsWith(PREFIXO_GRUPOS) || !Array.isArray(lista)) continue;
    const raiz = k.slice(PREFIXO_GRUPOS.length);
    if (!raiz.trim()) continue;
    const gs = lista
      .filter((g) => g && typeof g === 'object' && typeof g.name === 'string' && Array.isArray(g.sessionIds))
      .map((g) => ({ nome: g.name, ids: g.sessionIds.filter((x) => typeof x === 'string' && x) }));
    grupos.set(raizNormal(raiz), gs);
  }
  return { arquivadas, grupos };
}

/**
 * T38 (PLANO-TELEGRAM.md, "T38"): a pasta dos bancos de cada janela do VS Code, o `workspaceStorage` irmao do
 * `globalStorage` (`.../Code/User/globalStorage/state.vscdb` -> `.../Code/User/workspaceStorage`). Vale com o
 * `vscode.banco` do config e no Mac (path.posix). Entrada que nao e texto nao vazio = null.
 */
export function caminhoAbasVsCode(bancoGlobal) {
  if (typeof bancoGlobal !== 'string' || !bancoGlobal) return null;
  const p = ehMac() ? path.posix : path;
  return p.join(p.dirname(p.dirname(bancoGlobal)), 'workspaceStorage');
}

// A pasta do `folder` do workspace.json (`file:///c%3A/projetos` -> `c:/projetos`), decodificada a mao (o fileURLToPath segue a
// plataforma do Node, e o teste do Mac roda no Windows): so `file://` sem host; `%` torto, outro esquema ou host = null.
function pastaDoFolder(folder) {
  if (typeof folder !== 'string' || !/^file:\/\//i.test(folder)) return null;
  const resto = folder.slice('file://'.length);
  if (!resto.startsWith('/')) return null; // file://servidor/...: pasta de rede, nunca e a raiz de uma janela daqui
  let p;
  try {
    p = decodeURIComponent(resto);
  } catch {
    return null;
  }
  return ehMac() ? p : p.replace(/^\/(?=[A-Za-z]:)/, ''); // Windows: /c:/projetos -> c:/projetos
}

// mtime do state.vscdb da subpasta (sem o banco = -Infinity: perde pra qualquer subpasta com banco)
function mtimeDoBanco(sub) {
  try {
    return fs.statSync(path.join(sub, 'state.vscdb')).mtimeMs;
  } catch {
    return -Infinity;
  }
}

/**
 * T38 (PLANO-TELEGRAM.md, "T38"): as abas abertas de cada janela do VS Code -> Map<raizNormal(raiz), Set<sessionId>> |
 * null. Varre as subpastas de `pastaWs` (o caminhoAbasVsCode): o `workspace.json` diz a pasta da janela (`folder`; JSON
 * torto, sem `folder`, so `workspace` multi-pasta, esquema que nao e `file://` ou com host = a subpasta fica de fora) e
 * o `state.vscdb` dela guarda, na chave da extensao, o `panelTabSessions` ({sessionId, title, fullEditor}; o
 * `panelSessionIds` e outra coisa). So entram as `raizes` pedidas (lista; outra coisa = nenhuma), casadas pelo
 * raizNormal; raiz sem subpasta fica fora do Map. Duas subpastas da mesma raiz (hash velho) = vale a do state.vscdb mais
 * novo. Sem o banco, sem a linha da chave ou sem o campo = Set vazio. null (erro) = `pastaWs` que nao e texto, pasta que
 * nao se le, banco que nao abre, valor que nao e JSON de objeto ou `panelTabSessions` que nao e lista. Pasta que nao
 * existe (o VS Code nunca rodou) = Map vazio. So leitura (os bancos abrem readOnly, como o lerListaVsCode). Nunca lanca.
 */
export function lerAbasVsCode(pastaWs, raizes) {
  if (typeof pastaWs !== 'string' || !pastaWs) return null;
  const pedidas = new Set((Array.isArray(raizes) ? raizes : []).filter((r) => typeof r === 'string' && r.trim()).map(raizNormal));
  let subs;
  try {
    if (!fs.existsSync(pastaWs)) return new Map();
    subs = fs.readdirSync(pastaWs, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(pastaWs, d.name));
  } catch {
    return null;
  }
  const escolhidas = new Map(); // raiz -> {sub, mtime}
  for (const sub of subs) {
    let ws;
    try {
      ws = JSON.parse(fs.readFileSync(path.join(sub, 'workspace.json'), 'utf8'));
    } catch {
      continue;
    }
    if (!ws || typeof ws !== 'object' || Array.isArray(ws)) continue;
    const pasta = pastaDoFolder(ws.folder);
    if (pasta === null) continue;
    const raiz = raizNormal(pasta);
    if (!pedidas.has(raiz)) continue;
    const mtime = mtimeDoBanco(sub);
    const antes = escolhidas.get(raiz);
    if (!antes || mtime > antes.mtime) escolhidas.set(raiz, { sub, mtime });
  }
  const saida = new Map();
  for (const [raiz, { sub }] of escolhidas) {
    const arq = path.join(sub, 'state.vscdb');
    if (!fs.existsSync(arq)) {
      saida.set(raiz, new Set());
      continue;
    }
    const v = valorDaChave(arq);
    if (v === null) return null;
    const tabs = v === undefined ? undefined : v.panelTabSessions;
    if (tabs !== undefined && !Array.isArray(tabs)) return null;
    saida.set(raiz, new Set((tabs ?? []).map((t) => t?.sessionId).filter((x) => typeof x === 'string' && x)));
  }
  return saida;
}
