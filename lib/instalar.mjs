// Tele Control — as funcoes do instalador (instalar.mjs): juntar o config.json, os hooks do settings.json, o bloco do
// CLAUDE.md, o .vbs da pasta Inicializar, a conversa com o Telegram (getMe, getUpdates) e a checagem do PC.
// Por que existe: a versao aberta (PLANO-ABERTO.md, "Onboarding" e "Instalador (contrato técnico)") se instala por uma
// conversa com o Claude Code (skill /instalar) que chama o instalar.mjs; aqui fica o que da pra testar sem tocar no PC:
// funcoes puras ou com as dependencias injetadas (fetch, rodar, existe). Nunca grava arquivo, nunca loga e nunca devolve
// a chave do bot.
import path from 'node:path';

const ehObjeto = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const iguais = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Versoes minimas que o Tele Control conhece. O Claude Code mais novo que a testada passa (nao da pra saber antes). Node
 * (A3b, doc oficial lida em 14/10/2026): o node:sqlite da lista do VS Code sai da flag no 22.13.0 e o prazo da leitura
 * (o `timeout` do DatabaseSync, com o VS Code gravando) entra no 22.16.0. Claude Code (A5d): o `onFailure` do hook (o
 * PermissionRequest da central no modo pedir: o hook que falha tambem nega) pede o 2.1.295.
 */
export const MINIMO = Object.freeze({ node: '22.16.0', claude: '2.1.295', python: '3.10.0', buildWindows: 19041 });

// ---------- versao ----------

/** O primeiro "x.y.z" do texto ("2.1.299 (Claude Code)", "v22.13.1", "Python 3.12.10"); sem = null. */
export function versaoDe(texto) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(texto ?? ''));
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** -1, 0 ou 1 comparando grupo a grupo; texto sem "x.y.z" = null. */
export function compararVersao(a, b) {
  const va = versaoDe(a);
  const vb = versaoDe(b);
  if (!va || !vb) return null;
  const pa = va.split('.').map(Number);
  const pb = vb.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  return 0;
}

// ---------- config.json ----------

/**
 * Junta `novo` no config `atual` sem mexer no original: chave ausente entra (acrescentadas); objeto com objeto desce um
 * nivel; valor igual (JSON) passa; valor diferente vira conflito e NAO muda (com `trocar`, muda e vai pra trocadas).
 * Caminhos com ponto ("telegram.chatId"). `novo` que nao e objeto = TypeError.
 */
export function juntarConfig(atual, novo, { trocar = false } = {}) {
  if (!ehObjeto(novo)) throw new TypeError('os dados do config tem que ser um objeto JSON');
  const config = ehObjeto(atual) ? structuredClone(atual) : {};
  const acrescentadas = [];
  const conflitos = [];
  const trocadas = [];
  const andar = (alvo, fonte, prefixo) => {
    for (const [chave, valor] of Object.entries(fonte)) {
      const caminho = prefixo ? `${prefixo}.${chave}` : chave;
      if (!Object.hasOwn(alvo, chave)) {
        alvo[chave] = structuredClone(valor);
        acrescentadas.push(caminho);
      } else if (ehObjeto(alvo[chave]) && ehObjeto(valor)) {
        andar(alvo[chave], valor, caminho);
      } else if (!iguais(alvo[chave], valor)) {
        if (trocar) {
          alvo[chave] = structuredClone(valor);
          trocadas.push(caminho);
        } else {
          conflitos.push({ caminho, atual: alvo[chave], novo: valor });
        }
      }
    }
  };
  andar(config, novo, '');
  return { config, acrescentadas, conflitos, trocadas };
}

// ---------- hooks do settings.json ----------

/** Os 3 hooks do Tele Control: evento, matcher (null = sem) e o arquivo em <repo>/hooks/. */
export const HOOKS = Object.freeze([
  Object.freeze({ evento: 'SessionStart', matcher: 'startup|resume|clear', arquivo: 'porteiro-supervisor.js' }),
  Object.freeze({ evento: 'Stop', matcher: null, arquivo: 'sessao-parou.js' }),
  Object.freeze({ evento: 'PreToolUse', matcher: 'AskUserQuestion', arquivo: 'pergunta-modo-rua.js' }),
]);

/** "<repo>/hooks/<arquivo>" com barra normal (o formato que o settings.json do Claude Code usa no Windows). */
export function caminhoHook(repoDir, arquivo) {
  return `${String(repoDir).replace(/\\/g, '/').replace(/\/+$/, '')}/hooks/${arquivo}`;
}

const barraNormal = (s) => String(s ?? '').replace(/\\/g, '/');

function validarSettings(settings) {
  if (!ehObjeto(settings)) throw new TypeError('o settings.json nao e um objeto');
  if (settings.hooks === undefined) return;
  if (!ehObjeto(settings.hooks)) throw new TypeError('o "hooks" do settings.json nao e um objeto');
  for (const h of HOOKS) {
    const lista = settings.hooks[h.evento];
    if (lista !== undefined && !Array.isArray(lista)) throw new TypeError(`o "hooks.${h.evento}" do settings.json nao e uma lista`);
  }
}

// Algum hook da lista chama um arquivo com este nome numa pasta "hooks" (no comando ou nos args)?
function chamaArquivo(lista, arquivo) {
  const alvo = `/hooks/${arquivo}`.toLowerCase();
  return (lista ?? []).some((e) => ehObjeto(e) && Array.isArray(e.hooks) && e.hooks.some((x) => ehObjeto(x)
    && [x.command, ...(Array.isArray(x.args) ? x.args : [])].some((t) => barraNormal(t).toLowerCase().includes(alvo))));
}

/**
 * Acrescenta os 3 hooks com o caminho do repo, sem mexer no original. Evento que ja chama um arquivo com o mesmo nome
 * (por qualquer caminho) = jaTinha, nada muda nele. settings que nao e objeto ou hooks torto = TypeError.
 */
export function juntarHooks(settings, repoDir) {
  validarSettings(settings);
  const s = structuredClone(settings);
  const acrescentados = [];
  const jaTinha = [];
  for (const h of HOOKS) {
    const lista = s.hooks?.[h.evento];
    if (chamaArquivo(lista, h.arquivo)) {
      jaTinha.push(h.evento);
      continue;
    }
    const entrada = h.matcher ? { matcher: h.matcher } : {};
    entrada.hooks = [{ type: 'command', command: 'node', args: [caminhoHook(repoDir, h.arquivo)], timeout: 5 }];
    s.hooks ??= {};
    s.hooks[h.evento] = [...(lista ?? []), entrada];
    acrescentados.push(h.evento);
  }
  return { settings: s, acrescentados, jaTinha };
}

/** Tira so os hooks que chamam o arquivo pelo caminho deste repo; entrada e evento que ficam vazios saem. */
export function tirarHooks(settings, repoDir) {
  validarSettings(settings);
  const s = structuredClone(settings);
  const tirados = [];
  for (const h of HOOKS) {
    const lista = s.hooks?.[h.evento];
    if (!lista) continue;
    const alvo = caminhoHook(repoDir, h.arquivo).toLowerCase();
    const nosso = (x) => ehObjeto(x) && Array.isArray(x.args) && barraNormal(x.args[0]).toLowerCase() === alvo;
    let tirou = false;
    const nova = [];
    for (const e of lista) {
      if (!ehObjeto(e) || !Array.isArray(e.hooks) || !e.hooks.some(nosso)) {
        nova.push(e);
        continue;
      }
      tirou = true;
      const resto = e.hooks.filter((x) => !nosso(x));
      if (resto.length) nova.push({ ...e, hooks: resto });
    }
    if (!tirou) continue;
    tirados.push(h.evento);
    if (nova.length) s.hooks[h.evento] = nova;
    else delete s.hooks[h.evento];
  }
  if (tirados.length && ehObjeto(s.hooks) && Object.keys(s.hooks).length === 0) delete s.hooks;
  return { settings: s, tirados };
}

// ---------- bloco do CLAUDE.md ----------

export const MARCA_INICIO = '<!-- tele-control:inicio -->';
export const MARCA_FIM = '<!-- tele-control:fim -->';

/**
 * O que o bloco ensina: fechar a resposta do jeito que o hooks/sessao-parou.js reconhece (texto com "DECISÃO", texto
 * com "Fica com você" ou a ultima linha terminando em "?"); sem isso, quase nada chega no celular.
 */
export const BLOCO_CLAUDE_MD = `## Tele Control (perguntas que chegam no celular)
- Quando eu precisar decidir algo, termine a resposta com uma linha que começa com "DECISÃO:", a pergunta e as opções.
- Quando eu tiver que fazer alguma coisa fora daqui (login, aprovar, olhar uma tela), termine com "Fica com você:" e a lista.
- Pergunta curta pra mim: deixe a pergunta sozinha na última linha, terminando com "?".
- Sem nada pra mim, não termine a resposta com pergunta.`;

const fimDeLinha = (t) => (t.includes('\r\n') ? '\r\n' : '\n');

/** O texto com o bloco marcado: no fim (com 1 linha em branco antes) ou, se ja tem, so o miolo trocado. */
export function porBloco(texto, miolo = BLOCO_CLAUDE_MD) {
  const t = String(texto ?? '');
  const eol = fimDeLinha(t);
  const corpo = String(miolo).trim().replace(/\r?\n/g, eol);
  const bloco = `${MARCA_INICIO}${eol}${corpo}${eol}${MARCA_FIM}`;
  const i = t.indexOf(MARCA_INICIO);
  const f = t.indexOf(MARCA_FIM);
  if (i >= 0 && f > i) return t.slice(0, i) + bloco + t.slice(f + MARCA_FIM.length);
  if (!t.trim()) return bloco + eol;
  return t.replace(/\s+$/, '') + eol + eol + bloco + eol;
}

/** Tira o bloco marcado, a linha em branco antes e a quebra depois; sem bloco = o texto como esta. */
export function tirarBloco(texto) {
  const t = String(texto ?? '');
  const i = t.indexOf(MARCA_INICIO);
  const f = t.indexOf(MARCA_FIM);
  if (i < 0 || f < i) return { texto: t, tirou: false };
  const antes = t.slice(0, i).replace(/(\r?\n)\r?\n$/, '$1');
  const depois = t.slice(f + MARCA_FIM.length).replace(/^\r?\n/, '');
  return { texto: antes + depois, tirou: true };
}

// ---------- .vbs da pasta Inicializar ----------

export const MARCA_VBS = "' tele-control: inicio automatico (gerado pelo instalar.mjs)";

/**
 * O .vbs da pasta Inicializar: so chama o sessoes-wpp-porteiro.vbs do repositorio (que acha o resto sozinho), escondido
 * e sem esperar. CRLF; quem grava usa UTF-16 com BOM (caminho com acento). Caminho com aspas = Error.
 */
export function vbsDeInicio(repoDir) {
  const repo = String(repoDir).replace(/\//g, '\\').replace(/\\+$/, '');
  if (repo.includes('"')) throw new Error('caminho com aspas nao serve pro .vbs de inicio');
  const alvo = `${repo}\\sessoes-wpp-porteiro.vbs`;
  return [
    MARCA_VBS,
    "' Liga o Tele Control quando o Windows entra. Pra desligar: node instalar.mjs inicializar --tirar",
    `CreateObject("WScript.Shell").Run "wscript.exe //nologo ""${alvo}""", 0, False`,
    '',
  ].join('\r\n');
}

/** Texto ou Buffer (UTF-16 com BOM ou UTF-8) comeca pela marca do vbsDeInicio? */
export function ehVbsNosso(conteudo) {
  let t = conteudo;
  if (Buffer.isBuffer(conteudo)) {
    t = conteudo.length >= 2 && conteudo[0] === 0xff && conteudo[1] === 0xfe
      ? conteudo.subarray(2).toString('utf16le')
      : conteudo.toString('utf8').replace(/^﻿/, '');
  }
  return String(t ?? '').startsWith(MARCA_VBS);
}

// ---------- Telegram ----------

const API = 'https://api.telegram.org';
/** Formato da chave de bot: numero, dois pontos e o segredo (o BotFather manda assim). */
export const RE_CHAVE = /^\d{5,16}:[A-Za-z0-9_-]{20,}$/;

/**
 * Uma chamada a Bot API por POST com JSON. Nunca lanca e nunca devolve a chave: erro de rede vira descricao fixa (a
 * mensagem do erro pode trazer a URL, que tem a chave); a descricao do Telegram passa com a chave tirada.
 */
export async function chamarTelegram({ fetch, token, metodo, corpo = {}, timeoutMs = 15000 }) {
  const semChave = (s) => (s == null ? null : String(s).split(String(token)).join('***'));
  try {
    const resp = await fetch(`${API}/bot${token}/${metodo}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let j = null;
    try { j = await resp.json(); } catch { j = null; }
    if (resp.status === 200 && j?.ok === true) return { ok: true, status: 200, result: j.result };
    return { ok: false, status: resp.status, descricao: semChave(j?.description) };
  } catch {
    return { ok: false, status: null, descricao: 'sem conexão com o Telegram' };
  }
}

/** getMe: a chave e de um bot que existe? {ok, bot: {id, usuario, nome}} | {ok: false, erro}. Formato ruim nem chama. */
export async function conferirChave({ fetch, token }) {
  if (typeof token !== 'string' || !RE_CHAVE.test(token)) return { ok: false, erro: 'isso não parece a chave de um bot' };
  const r = await chamarTelegram({ fetch, token, metodo: 'getMe' });
  if (r.ok && ehObjeto(r.result)) {
    return { ok: true, bot: { id: r.result.id ?? null, usuario: r.result.username ?? null, nome: r.result.first_name ?? null } };
  }
  if (r.status === 401 || r.status === 404) return { ok: false, erro: 'chave recusada pelo Telegram' };
  return { ok: false, erro: r.descricao || 'o Telegram não respondeu' };
}

/**
 * As conversas privadas de gente (nao bot) que mandaram mensagem ao bot, a mais recente primeiro, sem repetir:
 * [{id, nome, usuario}]. Grupo, canal, bot e update sem mensagem ficam fora (v1: o canal e a conversa privada).
 */
export function chatsDoGetUpdates(updates) {
  if (!Array.isArray(updates)) return [];
  const porId = new Map();
  for (const u of updates) {
    const m = u?.message;
    if (!ehObjeto(m) || m.chat?.type !== 'private' || m.from?.is_bot === true) continue;
    const id = m.chat.id;
    if (!Number.isSafeInteger(id)) continue;
    const ordem = Number(u.update_id) || 0;
    const ant = porId.get(id);
    if (!ant || ordem > ant.ordem) {
      porId.set(id, { id, nome: m.from?.first_name ?? m.chat.first_name ?? null, usuario: m.from?.username ?? null, ordem });
    }
  }
  return [...porId.values()].sort((a, b) => b.ordem - a.ordem).map(({ id, nome, usuario }) => ({ id, nome, usuario }));
}

/** O maior update_id da lista (pra marcar como lidas); vazia = null. */
export function ultimoUpdateId(updates) {
  const ids = (Array.isArray(updates) ? updates : []).map((u) => u?.update_id).filter(Number.isSafeInteger);
  return ids.length ? Math.max(...ids) : null;
}

/**
 * 1 getUpdates sem espera (antes do porteiro existir): {ok, chats, ultimo} | {ok: false, erro}. Nunca manda
 * allowed_updates (o Telegram guarda essa escolha e o porteiro deixaria de receber os botoes).
 */
export async function lerChats({ fetch, token }) {
  const r = await chamarTelegram({ fetch, token, metodo: 'getUpdates', corpo: { timeout: 0 } });
  if (r.ok) return { ok: true, chats: chatsDoGetUpdates(r.result), ultimo: ultimoUpdateId(r.result) };
  if (r.status === 409) return { ok: false, erro: 'outro programa está lendo este bot agora (o Tele Control já ligado ou outro robô): pare ele e tente de novo' };
  if (r.status === 401 || r.status === 404) return { ok: false, erro: 'chave recusada pelo Telegram' };
  return { ok: false, erro: r.descricao || 'o Telegram não respondeu' };
}

/** Marca como lidas as mensagens ate offset-1 (o porteiro nao responde depois ao /start da instalacao). */
export async function marcarLidas({ fetch, token, offset }) {
  const r = await chamarTelegram({ fetch, token, metodo: 'getUpdates', corpo: { offset, timeout: 0, limit: 1 } });
  return { ok: r.ok };
}

/** Manda 1 mensagem de texto pelo bot (o teste do fim da instalacao). */
export async function mandarTexto({ fetch, token, chatId, texto }) {
  const r = await chamarTelegram({ fetch, token, metodo: 'sendMessage', corpo: { chat_id: chatId, text: texto } });
  return r.ok ? { ok: true } : { ok: false, erro: r.descricao || 'o Telegram não aceitou a mensagem' };
}

// ---------- checagem do PC ----------

/**
 * O PC tem o que o Tele Control precisa? Dependencias injetadas: `rodar(cmd, args)` no formato do spawnSync ({status,
 * stdout}), `existe(caminho)`, `env`. Cada item {ok, versao?, onde?, falta?}; `falta` diz o que fazer. Python so com
 * `audio` (a transcricao local).
 */
export function checar({ plataforma, release, versaoNode, rodar, existe, env = {}, audio = false }) {
  const itens = {};
  const roda = (cmd, args) => {
    try {
      const r = rodar(cmd, args);
      return r && r.status === 0 ? String(r.stdout ?? '') : null;
    } catch {
      return null;
    }
  };

  if (plataforma !== 'win32') {
    itens.windows = { ok: false, falta: 'o Tele Control roda no Windows 10 ou 11 (por enquanto)' };
  } else {
    const build = Number(String(release ?? '').split('.')[2]) || 0;
    const versao = `${build >= 22000 ? 'Windows 11' : 'Windows 10'} (${build})`;
    itens.windows = build >= MINIMO.buildWindows ? { ok: true, versao }
      : { ok: false, versao, falta: 'atualize o Windows (precisa do Windows 10 versão 2004 ou mais novo)' };
  }

  const vNode = versaoDe(versaoNode);
  itens.node = vNode && compararVersao(vNode, MINIMO.node) >= 0 ? { ok: true, versao: vNode }
    : { ok: false, versao: vNode, falta: 'instale o Node.js 22.16 ou mais novo (nodejs.org, a versão LTS)' };

  const candidatos = ['claude'];
  if (env.USERPROFILE) candidatos.push(path.win32.join(env.USERPROFILE, '.local', 'bin', 'claude.exe'));
  itens.claude = { ok: false, falta: 'instale o Claude Code (claude.ai/code)' };
  for (const c of candidatos) {
    const saida = roda(c, ['--version']);
    if (saida === null) continue;
    const v = versaoDe(saida);
    const ok = Boolean(v) && compararVersao(v, MINIMO.claude) >= 0;
    itens.claude = { ok, versao: v, onde: c === 'claude' ? 'PATH' : c };
    if (!ok) itens.claude.falta = 'atualize o Claude Code (no terminal: claude update)';
    break;
  }

  const wt = env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'wt.exe') : null;
  itens.terminal = (wt && existe(wt)) || roda('where', ['wt.exe']) !== null ? { ok: true }
    : { ok: false, falta: 'instale o Windows Terminal (Microsoft Store)' };

  const ps = env.SystemRoot ? path.win32.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null;
  itens.powershell = ps && existe(ps) ? { ok: true } : { ok: false, falta: 'o Windows PowerShell não foi achado' };

  if (audio) {
    const vPy = versaoDe(roda('python', ['--version']));
    if (!vPy || compararVersao(vPy, MINIMO.python) < 0) {
      itens.python = { ok: false, versao: vPy, falta: 'instale o Python 3.10 ou mais novo (python.org) pra transcrever áudio' };
    } else if (roda('python', ['-c', 'import faster_whisper']) === null) {
      itens.python = { ok: false, versao: vPy, falta: 'instale o transcritor: python -m pip install faster-whisper' };
    } else {
      itens.python = { ok: true, versao: vPy };
    }
  }

  return { ok: Object.values(itens).every((i) => i.ok), itens };
}

// ---------- pastas de projeto ----------

// Pasta que nunca e raiz de projeto: temporaria, de programa ou do Windows (qualquer trecho do caminho).
const TRECHOS_FORA = new Set(['appdata', 'temp', 'tmp', 'windows', '$recycle.bin', 'program files', 'program files (x86)', 'programdata']);

/**
 * Ate 3 pastas pra sugerir como raiz dos projetos, pela pasta (cwd) das conversas antigas. `itens` = cwds (texto, peso 1)
 * ou {cwd, conversas}. Cada pasta e a de cima concorrem; vence a que junta mais conversas (empate: a mais funda);
 * subpasta de uma escolhida nao entra. Nunca entram: a pasta da pessoa (casa) e as de cima dela, a raiz do disco, pasta
 * temporaria/de programa/do Windows (TRECHOS_FORA) e pasta que `existe` diz que nao existe mais. [{pasta, conversas}].
 */
export function pastasSugeridas(itens, { casa, existe = () => true } = {}) {
  // O VS Code grava a letra do disco minuscula e o terminal maiuscula: sai sempre maiuscula.
  const norm = (p) => path.win32.normalize(String(p)).replace(/\\+$/, '').replace(/^[a-z](?=:)/, (l) => l.toUpperCase());
  const chave = (p) => p.toLowerCase();
  const lista = (Array.isArray(itens) ? itens : [])
    .map((i) => (typeof i === 'string' ? { cwd: i, conversas: 1 } : i))
    .filter((i) => i && typeof i.cwd === 'string' && i.cwd.trim() && Number(i.conversas) > 0)
    .map((i) => ({ cwd: norm(i.cwd), conversas: Number(i.conversas) }));
  const casaK = casa ? chave(norm(casa)) : null;
  const ehRaizDoDisco = (p) => /^[a-z]:$/i.test(p);
  const acimaDaCasa = (p) => casaK !== null && (casaK === chave(p) || casaK.startsWith(chave(p) + '\\'));
  const temTrechoFora = (p) => chave(p).split('\\').some((t) => TRECHOS_FORA.has(t));
  const dentro = (filho, pai) => chave(filho) === chave(pai) || chave(filho).startsWith(chave(pai) + '\\');

  const candidatos = new Map();
  for (const { cwd } of lista) {
    for (const p of [cwd, norm(path.win32.dirname(cwd))]) {
      if (candidatos.has(chave(p)) || ehRaizDoDisco(p) || acimaDaCasa(p) || temTrechoFora(p)) continue;
      candidatos.set(chave(p), p);
    }
  }
  const pontuados = [...candidatos.values()].filter((p) => {
    try { return existe(p); } catch { return false; }
  }).map((p) => ({
    pasta: p,
    conversas: lista.filter((i) => dentro(i.cwd, p)).reduce((s, i) => s + i.conversas, 0),
    fundura: p.split('\\').length,
  }));
  pontuados.sort((a, b) => b.conversas - a.conversas || b.fundura - a.fundura || a.pasta.localeCompare(b.pasta));
  const escolhidos = [];
  for (const c of pontuados) {
    if (escolhidos.length >= 3) break;
    if (escolhidos.some((e) => dentro(c.pasta, e.pasta) || dentro(e.pasta, c.pasta))) continue;
    escolhidos.push(c);
  }
  return escolhidos.map(({ pasta, conversas }) => ({ pasta, conversas }));
}
