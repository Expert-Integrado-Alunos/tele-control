// sessoes-wpp — abas abertas no PC e quais mexeram no codigo do controle (T7a2, PLANO-T7.md, "T7a2: F6").
// Por que existe: a central nao muda o proprio controle (F6, item 11 de central/instrucoes.md). Pedido de mudanca no
// porteiro, no mensageiro, nos hooks etc. vai pra aba que desenvolve o controle, e o nome dela muda: a central acha na
// hora com `node <pasta do repositorio>/abas.mjs --controle` (abas interativas vivas que editaram arquivo da pasta deste
// repositorio, RAIZ_CONTROLE, nas ultimas 24 h, a mais recente primeiro).
// So leitura: registros `^\d+\.json$` da pasta de sessoes (os `.key` da mesma pasta sao segredo: nunca abertos) e os
// transcripts das abas. Nunca imprime conteudo de transcript: so titulo, sessionId, situacao e hora.
// Pastas: CLAUDE_SESSIONS_DIR e CLAUDE_PROJECTS_DIR (as mesmas do porteiro), senao ~/.claude/sessions e ~/.claude/projects.
// T8: `--fechadas [palavras]` = as abas FECHADAS dos ultimos 14 dias que da pra reabrir pelo celular (a central acha a
// dona fechada e pede o `porteiro.mjs reabrir-sessao`): titulo, sessionId, pasta e hora da ultima mensagem. A3a: a
// central fica fora pelo nome dela no config.json da pasta de estado (identidadeCentral; sem config = o padrao).
// A4a: as horas das 2 listas no fuso do dono (o `dono.fuso` do mesmo config, senao o do Windows).
// CLI: node abas.mjs [--controle | --fechadas [palavras]]   (exit 0 sempre; erro = 1 linha fixa, nunca stack)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { horaBRT, diaBRT, definirFuso } from './lib/formato.mjs';
import { normalizar } from './lib/roteamento.mjs';
import { pidVivo as pidVivoPadrao } from './porteiro.mjs';
import { lerConfig, identidadeCentral, PADRAO_CENTRAL, donoDoConfig } from './lib/config.mjs';

const require = createRequire(import.meta.url);
const lib = require('./hooks/lib/sessoes-wpp.js');

const ESTE_ARQUIVO = fileURLToPath(import.meta.url);

const MB = 1024 * 1024;
const JANELA_MS = 24 * 60 * 60 * 1000; // "mexeu no controle nas ultimas 24 h"
const DEGRAUS = [4 * MB, 16 * MB, 64 * MB]; // cauda do transcript: para no 1o degrau que acha a edicao
const PEDACO = 4 * MB; // leitura do transcript inteiro (titulo), em pedacos
const REGISTRO_RE = /^\d+\.json$/;
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;
const FERRAMENTAS_DE_EDICAO = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// A3a: a pasta deste repositorio (onde estiver instalado), minuscula e com a barra do fim
export const RAIZ_CONTROLE = `${path.dirname(ESTE_ARQUIVO).toLowerCase()}\\`;
export const ERRO_CLI = 'não consegui listar as abas agora';

// Caminho comparavel: barras unificadas, minusculas, `..` resolvido (Windows: C:/x e c:\X sao o mesmo arquivo).
function normalizarCaminho(p) {
  return path.win32.normalize(p).replace(/\\/g, '/').toLowerCase();
}

function msDe(ts) {
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : null;
  if (typeof ts !== 'string') return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Hora (ms) da ultima edicao de arquivo dentro de `raiz` nas entradas do transcript, ou null. So conta tool_use de
 * Edit/Write/MultiEdit/NotebookEdit numa linha `assistant` com timestamp >= desdeMs; o caminho (file_path ou
 * notebook_path) normalizado tem que comecar pela raiz COM a barra final (sessoes-wpp-outro nao e o controle).
 */
export function ultimaEdicaoNoControle(entradas, { raiz = RAIZ_CONTROLE, desdeMs = -Infinity } = {}) {
  let prefixo = normalizarCaminho(String(raiz));
  if (!prefixo.endsWith('/')) prefixo += '/';
  const desde = Number.isFinite(desdeMs) ? desdeMs : -Infinity;
  let ultima = null;
  for (const e of Array.isArray(entradas) ? entradas : []) {
    if (!e || e.type !== 'assistant') continue;
    const ts = msDe(e.timestamp);
    if (ts === null || ts < desde) continue;
    const blocos = e.message?.content;
    if (!Array.isArray(blocos)) continue;
    for (const b of blocos) {
      if (!b || b.type !== 'tool_use' || !FERRAMENTAS_DE_EDICAO.has(b.name)) continue;
      const alvo = b.name === 'NotebookEdit' ? (b.input?.notebook_path ?? b.input?.file_path) : b.input?.file_path;
      if (typeof alvo !== 'string' || !alvo) continue;
      if (normalizarCaminho(alvo).startsWith(prefixo) && (ultima === null || ts > ultima)) ultima = ts;
    }
  }
  return ultima;
}

function lerRegistro(arq) {
  try {
    const j = JSON.parse(fs.readFileSync(arq, 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

// <projectsDir>/<pasta>/<sessionId>.jsonl (a mesma busca do porteiro). Nenhum = null.
function acharTranscript(projectsDir, sessionId) {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  let pastas;
  try { pastas = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { return null; }
  for (const d of pastas) {
    if (!d.isDirectory()) continue;
    const arq = path.join(projectsDir, d.name, `${sessionId}.jsonl`);
    if (fs.existsSync(arq)) return arq;
  }
  return null;
}

// Titulo que o porteiro mostra pra aba: lib.tituloDe com o ultimo custom-title e o ultimo ai-title do transcript INTEIRO
// (lido em pedacos, so as linhas com "custom-title"/"ai-title" viram JSON) e o registro.
function tituloDaAba(arq, registro) {
  let custom = null;
  let ai = null;
  const olhar = (linha) => {
    if (!linha.includes('custom-title') && !linha.includes('ai-title')) return;
    let x;
    try { x = JSON.parse(linha); } catch { return; }
    if (x?.type === 'custom-title' && typeof x.customTitle === 'string' && x.customTitle) custom = { type: 'custom-title', customTitle: x.customTitle };
    else if (x?.type === 'ai-title' && typeof x.aiTitle === 'string' && x.aiTitle) ai = { type: 'ai-title', aiTitle: x.aiTitle };
  };
  if (arq) {
    let fd;
    try {
      fd = fs.openSync(arq, 'r');
      const buf = Buffer.alloc(PEDACO);
      let resto = Buffer.alloc(0);
      let pos = 0;
      for (;;) {
        const n = fs.readSync(fd, buf, 0, PEDACO, pos);
        if (n <= 0) break;
        pos += n;
        const bloco = resto.length ? Buffer.concat([resto, buf.subarray(0, n)]) : buf.subarray(0, n);
        const fim = bloco.lastIndexOf(10);
        if (fim === -1) {
          resto = Buffer.from(bloco);
          continue;
        }
        for (const linha of bloco.subarray(0, fim).toString('utf8').split('\n')) olhar(linha);
        resto = Buffer.from(bloco.subarray(fim + 1)); // copia: o `buf` e reusado
      }
      if (resto.length) olhar(resto.toString('utf8'));
    } catch {
      /* transcript ilegivel: fica o titulo do registro */
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* nada */ } }
    }
  }
  return lib.tituloDe([custom, ai].filter(Boolean), registro);
}

// Ultima edicao no controle (`raiz`) desde `desdeMs`, procurando na cauda em degraus de 4, 16 e 64 MB.
function edicaoNaCauda(arq, desdeMs, lerCauda, raiz) {
  if (!arq) return null;
  let tamanho;
  try { tamanho = fs.statSync(arq).size; } catch { return null; }
  for (const bytes of DEGRAUS) {
    const ms = ultimaEdicaoNoControle(lerCauda(arq, bytes), { desdeMs, raiz });
    if (ms !== null) return ms;
    if (tamanho <= bytes) break; // o degrau ja leu o arquivo inteiro
  }
  return null;
}

/**
 * Abas interativas vivas (VS Code, terminal ou Claude Desktop com canal de recado; sdk-cli fora), sem a propria (CLAUDE_CODE_SESSION_ID).
 * controle = so as que editaram arquivo do controle nas ultimas 24 h, a mais recente primeiro (`controleEm`); sem
 * controle = todas, pelo updatedAt do registro (mais recente primeiro) e controleEm null. A3a: `raiz` = a pasta do
 * controle (padrao: RAIZ_CONTROLE, a deste repositorio).
 * -> [{sessionId, nome, titulo, status, entrypoint, controleEm}]. Pasta de sessoes que nao existe = []; outro erro lanca.
 */
export function listarAbas({
  env = process.env, agora = Date.now, controle = false, lerCauda = lib.lerCauda, pidVivo = pidVivoPadrao, raiz = RAIZ_CONTROLE,
} = {}) {
  const agoraMs = typeof agora === 'function' ? agora() : Number(agora);
  const e = env || {};
  const { sessionsDir } = lib.caminhos(e);
  const projectsDir = e.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
  const eu = typeof e.CLAUDE_CODE_SESSION_ID === 'string' && e.CLAUDE_CODE_SESSION_ID ? e.CLAUDE_CODE_SESSION_ID : null;
  let nomes;
  try {
    nomes = fs.readdirSync(sessionsDir);
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  const ja = new Set();
  for (const nome of nomes.sort()) {
    if (!REGISTRO_RE.test(nome)) continue; // .key e qualquer outro arquivo: nunca abrir
    const reg = lerRegistro(path.join(sessionsDir, nome));
    if (!lib.ehInterativa(reg)) continue;
    const { sessionId } = reg;
    if (typeof sessionId !== 'string' || !sessionId || ja.has(sessionId)) continue;
    if (eu !== null && sessionId === eu) continue;
    if (!pidVivo(reg.pid)) continue;
    ja.add(sessionId);
    const arq = acharTranscript(projectsDir, sessionId);
    const controleEm = controle ? edicaoNaCauda(arq, agoraMs - JANELA_MS, lerCauda, raiz) : null;
    if (controle && controleEm === null) continue;
    out.push({
      sessionId,
      nome: typeof reg.name === 'string' ? reg.name : null,
      titulo: tituloDaAba(arq, reg),
      status: reg.status,
      entrypoint: reg.entrypoint,
      controleEm,
      ordem: controle ? controleEm : Number(reg.updatedAt) || 0,
    });
  }
  out.sort((a, b) => b.ordem - a.ordem);
  return out.map(({ ordem, ...aba }) => aba);
}

// Titulo em 1 linha so (um titulo com quebra nao vira linha falsa na lista).
const umaLinha = (s) => String(s).replace(/\s+/g, ' ').trim();

/** Texto da lista pra central (1 linha por aba). */
export function textoAbas(lista, { controle = false } = {}) {
  const abas = (Array.isArray(lista) ? lista : []).filter((x) => x && (!controle || Number.isFinite(x.controleEm)));
  if (!abas.length) return controle ? 'nenhuma aba mexeu no controle nas últimas 24 h' : 'nenhuma aba aberta';
  return abas
    .map((x) => {
      const titulo = umaLinha(x.titulo || x.nome || 'sem nome') || 'sem nome';
      const situacao = x.status === 'busy' ? 'trabalhando' : 'parada';
      const quando = controle ? `, mexeu no controle às ${horaBRT(new Date(x.controleEm).toISOString())}` : '';
      return `- ${titulo} (sessionId ${x.sessionId}, ${situacao}${quando})`;
    })
    .join('\n');
}

// ---------- T8: as abas fechadas que da pra reabrir pelo celular (PLANO-TELEGRAM.md, "T8") ----------

const FECHADAS_JANELA_MS = 14 * 24 * 60 * 60 * 1000; // ultima mensagem nos ultimos 14 dias
const FECHADAS_MAX = 20;
const ENTRYPOINTS_REABRIVEIS = new Set(['claude-vscode', 'cli']); // a aba do VS Code e a do terminal (o Desktop nao)
const CAUDA_APP = 1024 * 1024; // T31: o fim lido pro app em que a conversa vive agora (o mesmo do titulo no porteiro)
const semAcento = (s) => normalizar(s);

/**
 * Conversas de aba (VS Code ou terminal) FECHADAS com a ultima mensagem (mtime do transcript) nos ultimos 14 dias, a mais
 * recente primeiro, no maximo 20: `<projects>/<pasta>/<sessionId>.jsonl` (so o nivel de cima: subagente fica de fora).
 * Fora: sessao viva (registro `^\d+\.json$` com pid vivo; .key nunca e aberto), entrypoint que nao e cli/claude-vscode
 * (Desktop, `claude -p`; T31: o do FIM da conversa, lib.ultimoEntrypoint no ultimo CAUDA_APP, senao o da cabeca: a que
 * nasceu no Desktop e segue no VS Code entra), conversa sem pasta (cwd) e a central (titulo igual a `nomeCentral`, sem acento e sem caso; A3a:
 * padrao = PADRAO_CENTRAL.nome; nao-texto ou vazio = o padrao). `busca` = todas as palavras no titulo, sem acento e sem
 * caso (sem titulo = fora). -> [{sessionId, titulo, cwd, entrypoint, ultimaEm}]. Pasta de projetos que nao existe = [];
 * outro erro lanca.
 */
export function listarFechadas({
  env = process.env, agora = Date.now, busca = '', pidVivo = pidVivoPadrao, nomeCentral = PADRAO_CENTRAL.nome,
} = {}) {
  const agoraMs = typeof agora === 'function' ? agora() : Number(agora);
  const tituloCentral = semAcento(typeof nomeCentral === 'string' && nomeCentral.trim() ? nomeCentral : PADRAO_CENTRAL.nome);
  const e = env || {};
  const { sessionsDir } = lib.caminhos(e);
  const projectsDir = e.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
  const vivas = new Set();
  let nomes = [];
  try {
    nomes = fs.readdirSync(sessionsDir);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  for (const nome of nomes) {
    if (!REGISTRO_RE.test(nome)) continue; // .key e qualquer outro arquivo: nunca abrir
    const reg = lerRegistro(path.join(sessionsDir, nome));
    if (reg && typeof reg.sessionId === 'string' && reg.sessionId && pidVivo(reg.pid)) vivas.add(reg.sessionId);
  }
  let pastas;
  try {
    pastas = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const palavras = semAcento(busca).split(' ').filter(Boolean);
  const out = [];
  const ja = new Set();
  for (const d of pastas) {
    if (!d.isDirectory()) continue;
    let arquivos;
    try { arquivos = fs.readdirSync(path.join(projectsDir, d.name), { withFileTypes: true }); } catch { continue; }
    for (const a of arquivos) {
      if (!a.isFile() || !a.name.endsWith('.jsonl')) continue;
      const sessionId = a.name.slice(0, -'.jsonl'.length);
      if (!SESSION_ID_RE.test(sessionId) || vivas.has(sessionId) || ja.has(sessionId)) continue;
      const arq = path.join(projectsDir, d.name, a.name);
      let st;
      try { st = fs.statSync(arq); } catch { continue; }
      const ultimaEm = Math.round(st.mtimeMs);
      if (!(agoraMs - ultimaEm <= FECHADAS_JANELA_MS)) continue;
      const cab = lib.cabecaDaConversa(arq);
      if (!cab || !cab.cwd || !(ENTRYPOINTS_REABRIVEIS.has(cab.entrypoint) || cab.entrypoint === 'claude-desktop')) continue;
      const app = lib.ultimoEntrypoint(lib.lerCauda(arq, CAUDA_APP)) ?? cab.entrypoint; // T31
      if (!ENTRYPOINTS_REABRIVEIS.has(app)) continue;
      const titulo = tituloDaAba(arq, null);
      if (titulo && semAcento(titulo) === tituloCentral) continue;
      if (palavras.length) {
        const t = semAcento(titulo || '');
        if (!titulo || !palavras.every((p) => t.includes(p))) continue;
      }
      ja.add(sessionId);
      out.push({ sessionId, titulo: titulo || null, cwd: cab.cwd, entrypoint: app, ultimaEm });
    }
  }
  out.sort((a, b) => b.ultimaEm - a.ultimaEm);
  return out.slice(0, FECHADAS_MAX);
}

// DD/MM às HH:MM no fuso em uso (A4a: o diaBRT e o horaBRT do lib/formato.mjs, com o fuso do dono pelo main); hora que
// nao e numero de uma data valida = "??/?? às ??:??" (nunca lanca)
function quandoBRT(ms) {
  const d = typeof ms === 'number' ? new Date(ms) : null;
  if (d === null || Number.isNaN(d.getTime())) return '??/?? às ??:??';
  const iso = d.toISOString();
  return `${diaBRT(iso)} às ${horaBRT(iso)}`;
}

/** Texto da lista de fechadas pra central (1 linha por aba). */
export function textoFechadas(lista, { busca = '' } = {}) {
  const abas = (Array.isArray(lista) ? lista : []).filter((x) => x && typeof x.sessionId === 'string');
  if (!abas.length) {
    const b = umaLinha(busca || '');
    return b ? `nenhuma aba fechada nos últimos 14 dias com "${b}"` : 'nenhuma aba fechada nos últimos 14 dias';
  }
  return abas
    .map((x) => {
      const titulo = umaLinha(x.titulo || '') || '(sem título)';
      const pasta = path.win32.basename(String(x.cwd || '').replace(/[\\/]+$/, '')) || String(x.cwd || '');
      return `- ${titulo} (sessionId ${x.sessionId}, ${pasta}, última mensagem ${quandoBRT(x.ultimaEm)})`;
    })
    .join('\n');
}

function main(args) {
  // A4a: o config.json da pasta de estado lido 1 vez (ilegivel = {}): o fuso das horas das 2 listas (o do dono, senao o
  // do Windows) e o nome da central do --fechadas
  let cfg = {};
  try {
    cfg = lerConfig(lib.caminhos(process.env).estadoDir);
  } catch { /* sem a pasta de estado: o padrao */ }
  definirFuso(donoDoConfig(cfg).fuso);
  if (args.includes('--fechadas')) {
    const busca = args.filter((a) => a !== '--fechadas' && !a.startsWith('--')).join(' ');
    let texto;
    try {
      // A3a: o nome da central do config.json da pasta de estado (o mesmo do porteiro)
      const nomeCentral = identidadeCentral(cfg).nome;
      texto = textoFechadas(listarFechadas({ env: process.env, busca, nomeCentral }), { busca });
    } catch {
      texto = ERRO_CLI;
    }
    console.log(texto);
    process.exitCode = 0;
    return;
  }
  const controle = args.includes('--controle');
  let texto;
  try {
    texto = textoAbas(listarAbas({ env: process.env, controle }), { controle });
  } catch {
    texto = ERRO_CLI;
  }
  console.log(texto);
  process.exitCode = 0;
}

function ehPrincipal() {
  if (!process.argv[1]) return false;
  const a = path.resolve(process.argv[1]);
  return process.platform === 'win32' ? a.toLowerCase() === ESTE_ARQUIVO.toLowerCase() : a === ESTE_ARQUIVO;
}

if (ehPrincipal()) main(process.argv.slice(2));
