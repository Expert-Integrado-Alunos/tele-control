// sessoes-wpp — a lista de abas do VS Code (T11, PLANO-TELEGRAM.md, "T11 — as abas fechadas da lista do VS Code no
// painel"). A extensao do Claude Code guarda no banco global do VS Code (state.vscdb, tabela ItemTable, chave
// `Anthropic.claude-code`; medido 06/10/2026 23h1x, extensao 2.1.287): `hiddenSessionIds` = as conversas arquivadas e
// `sessionGroups:<pasta da janela>` = os grupos de cada janela ({id, name, collapsed, sessionIds}, na ordem da tela).
// So leitura (o banco abre readOnly e fecha na hora) e so a chave da extensao: nenhuma outra chave do banco e lida.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { normalizar } from './roteamento.mjs';

const require = createRequire(import.meta.url);

const CHAVE = 'anthropic.claude-code'; // a chave no banco (comparada sem caixa: o VS Code grava "Anthropic.claude-code")
const PREFIXO_GRUPOS = 'sessionGroups:';
const ESPERA_MS = 1000; // banco ocupado (o VS Code gravando): espera ate isso antes de desistir

/**
 * Banco do VS Code: `banco` (A3b: o `vscode.banco` do config, ja conferido pelo bancoVsCodeDoConfig), senao
 * SESSOES_WPP_VSCODE_DB, senao `%APPDATA%/Code/User/globalStorage/state.vscdb`; sem nenhum = null.
 */
export function caminhoBancoVsCode(env = process.env, banco = null) {
  if (typeof banco === 'string' && banco) return banco;
  const e = env || {};
  if (typeof e.SESSOES_WPP_VSCODE_DB === 'string' && e.SESSOES_WPP_VSCODE_DB) return e.SESSOES_WPP_VSCODE_DB;
  if (typeof e.APPDATA === 'string' && e.APPDATA) return path.join(e.APPDATA, 'Code', 'User', 'globalStorage', 'state.vscdb');
  return null;
}

/** Pasta comparavel (a chave do grupo grava `c:\projetos`): barras do Windows, sem a barra do fim, minuscula. */
export function raizNormal(p) {
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
 * A lista do VS Code -> {arquivadas: Set<sessionId>, grupos: Map<raizNormal, [{nome, ids}]>} | null. A3b: banco que nao
 * existe (o VS Code nunca rodou ali; nao cria o arquivo) e banco sem a linha da chave da extensao (VS Code sem o Claude
 * Code) = listaVsCodeVazia(). null (erro) = sem caminho, banco que nao abre (ocupado alem de ESPERA_MS, nao e banco, Node
 * sem node:sqlite), sem a tabela, valor nulo, valor que nao e JSON de objeto, ou hiddenSessionIds que nao e lista. Grupo
 * torto (sem nome de texto ou sem lista de ids) sai; id que nao e texto sai. Nunca lanca.
 */
export function lerListaVsCode(arquivo) {
  if (typeof arquivo !== 'string' || !arquivo) return null;
  if (!fs.existsSync(arquivo)) return listaVsCodeVazia();
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
  if (bruto === undefined) return listaVsCodeVazia(); // sem a linha da chave: o Claude Code nunca rodou nesse VS Code
  if (bruto === null) return null;
  let v;
  try {
    v = JSON.parse(typeof bruto === 'string' ? bruto : Buffer.from(bruto).toString('utf8'));
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
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
