'use strict';
/*
 * sessoes-wpp — lib compartilhada (plano: PLANO.md).
 *
 * Por que existe: o dono, da rua, conversa pelo grupo do WhatsApp com as abas do
 * Claude Code abertas no VS Code do PC. Dois hooks (sessao-parou.js no Stop, pergunta-modo-rua.js
 * no PreToolUse) e o porteiro (ESM, fase seguinte) precisam das MESMAS regras de leitura: onde
 * mora o estado, como achar o registro da sessao, como ler so a cauda de um transcript de dezenas
 * de MB, qual e o titulo salvo, qual foi a ultima resposta e quais marcas ela tem. Uma copia so
 * dessas regras evita que hook e porteiro discordem sobre a mesma sessao.
 *
 * Contratos que o porteiro usa (nomes fixos): caminhos, acharRegistro, lerCauda, cabecaDaConversa (T8), ultimoEntrypoint
 * (T31), tituloDe,
 * ultimaResposta, respostaFresca, marcas, lerModoRua, anexarEvento, log.
 *
 * Seguranca: os arquivos `<pid>.<sha>.key` da pasta de registro sao SEGREDO. So nomes
 * `^\d+\.json$` sao abertos; qualquer outro arquivo da pasta nunca e lido.
 *
 * Sem dependencia externa. CommonJS (o porteiro ESM importa via createRequire/import default).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const CAUDA_PADRAO = 2 * 1024 * 1024;
const FRESCO_MS = 5 * 60 * 1000;
const REGISTRO_RE = /^\d+\.json$/;
// M4a (PLANO-MAC.md, "Mapa", linha 1): o nome do LaunchAgent do porteiro no Mac. Fonte unica: o porteiro, o
// lib/launchagent.mjs (createRequire), o hooks/porteiro-supervisor.js e o tools/mac/instalar-mac.sh (node -e) leem daqui.
const LABEL_MAC = 'com.expertintegrado.tele-control';

// Pastas e arquivo de log. Env manda (teste e override); sem env = ~/.claude.
function caminhos(env) {
  const e = env || process.env;
  const base = path.join(os.homedir(), '.claude');
  return {
    estadoDir: e.SESSOES_WPP_DIR || path.join(base, 'sessoes-wpp'),
    sessionsDir: e.CLAUDE_SESSIONS_DIR || path.join(base, 'sessions'),
    logFile: e.SESSOES_WPP_LOG || path.join(base, 'logs', 'sessoes-wpp.log'),
  };
}

// Sessoes que o dono usa com as maos: aba do VS Code e, desde a fase 3 (F3.9, central no Windows Terminal), sessao
// interativa do terminal (medido 27/09/2026: grava entrypoint "cli"). Desde a F4i (pedido do dono: "funcionar tambem
// com o Claude Desktop"), a sessao do Claude Desktop (entrypoint "claude-desktop"), mas SO com canal de recado
// (messagingSocketPath): medido 05/10/2026, 1 de 3 sessoes vivas do Desktop sem o campo e fora do ListAgents; sem canal,
// o aviso prometeria uma resposta que nao chega. Ficam FORA: `claude -p` (sdk-cli; o proprio mensageiro e um), sdk-py.
// Um lugar so pra os hooks, o porteiro, o ok-wpp e o abas.mjs nao divergirem.
const ENTRYPOINTS_INTERATIVOS = new Set(["claude-vscode", "cli", "claude-desktop"]);
function ehInterativa(registro) {
  if (!registro || !ENTRYPOINTS_INTERATIVOS.has(registro.entrypoint)) return false;
  if (registro.entrypoint !== 'claude-desktop') return true;
  return typeof registro.messagingSocketPath === 'string' && registro.messagingSocketPath !== '';
}

// Registro vivo da sessao (~/.claude/sessions/<pid>.json) pelo sessionId. JSON corrompido = pula.
// Mais de um casando (pid reciclado) = o de updatedAt mais novo.
function acharRegistro(sessionId, sessionsDir) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  let nomes;
  try { nomes = fs.readdirSync(sessionsDir); } catch (_) { return null; }
  let achado = null;
  for (const nome of nomes) {
    if (!REGISTRO_RE.test(nome)) continue; // .key e qualquer outro arquivo: nunca abrir
    let reg;
    try { reg = JSON.parse(fs.readFileSync(path.join(sessionsDir, nome), 'utf8')); } catch (_) { continue; }
    if (!reg || typeof reg !== 'object' || reg.sessionId !== sessionId) continue;
    if (!achado || (Number(reg.updatedAt) || 0) > (Number(achado.updatedAt) || 0)) achado = reg;
  }
  return achado;
}

// Ultimos `bytes` do arquivo JSONL como objetos. Le 1 byte a mais antes do corte: se ele for
// '\n', a 1a linha da janela esta inteira e fica; senao ela comecou no meio e e descartada.
// Linha que nao e JSON = pula. Arquivo inexistente ou ilegivel = [].
function lerCauda(arquivo, bytes = CAUDA_PADRAO) {
  let fd;
  try {
    fd = fs.openSync(arquivo, 'r');
    const tamanho = fs.fstatSync(fd).size;
    const janela = Math.max(0, Math.floor(Number(bytes) || 0));
    let inicio = Math.max(0, tamanho - janela);
    const cortou = inicio > 0;
    if (cortou) inicio -= 1;
    const buf = Buffer.alloc(tamanho - inicio);
    let lido = 0;
    while (lido < buf.length) {
      const n = fs.readSync(fd, buf, lido, buf.length - lido, inicio + lido);
      if (n <= 0) break;
      lido += n;
    }
    let texto = buf.subarray(0, lido).toString('utf8');
    if (cortou) {
      const nl = texto.indexOf('\n');
      texto = nl === -1 ? '' : texto.slice(nl + 1);
    }
    const saida = [];
    for (const bruta of texto.split('\n')) {
      const linha = bruta.endsWith('\r') ? bruta.slice(0, -1) : bruta;
      if (!linha.trim()) continue;
      try {
        const obj = JSON.parse(linha);
        if (obj && typeof obj === 'object') saida.push(obj);
      } catch (_) { /* linha ruim: pula */ }
    }
    return saida;
  } catch (_) {
    return [];
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) { /* nada */ } }
  }
}

// T8 (PLANO-TELEGRAM.md, "T8"): de onde a conversa e. Le o comeco do transcript em pedacos (no maximo CABECA_MAX) ate
// achar o 1o `entrypoint` e o 1o `cwd`, cada um da primeira linha que tem o campo (texto); so as linhas com o nome do
// campo viram JSON (uma linha gigante de anexo antes nao pesa). -> {entrypoint|null, cwd|null}; arquivo que nao abre = null.
const CABECA_MAX = 16 * 1024 * 1024;
const CABECA_PEDACO = 1024 * 1024;
function cabecaDaConversa(arquivo) {
  let fd;
  try {
    fd = fs.openSync(arquivo, 'r');
  } catch (_) {
    return null;
  }
  const out = { entrypoint: null, cwd: null };
  const olhar = (linha) => {
    const temE = out.entrypoint === null && linha.includes('"entrypoint"');
    const temC = out.cwd === null && linha.includes('"cwd"');
    if (!temE && !temC) return;
    let x;
    try { x = JSON.parse(linha); } catch (_) { return; }
    if (!x || typeof x !== 'object') return;
    if (temE && typeof x.entrypoint === 'string' && x.entrypoint) out.entrypoint = x.entrypoint;
    if (temC && typeof x.cwd === 'string' && x.cwd) out.cwd = x.cwd;
  };
  try {
    const buf = Buffer.alloc(CABECA_PEDACO);
    let resto = Buffer.alloc(0);
    let pos = 0;
    while (pos < CABECA_MAX && (out.entrypoint === null || out.cwd === null)) {
      const n = fs.readSync(fd, buf, 0, CABECA_PEDACO, pos);
      if (n <= 0) {
        if (resto.length) olhar(resto.toString('utf8'));
        resto = Buffer.alloc(0);
        break;
      }
      pos += n;
      const bloco = resto.length ? Buffer.concat([resto, buf.subarray(0, n)]) : buf.subarray(0, n);
      const fim = bloco.lastIndexOf(10);
      if (fim === -1) {
        resto = Buffer.from(bloco);
        continue;
      }
      for (const linha of bloco.subarray(0, fim).toString('utf8').split('\n')) {
        olhar(linha);
        if (out.entrypoint !== null && out.cwd !== null) break;
      }
      resto = Buffer.from(bloco.subarray(fim + 1)); // copia: o `buf` e reusado
    }
  } catch (_) {
    /* leitura que falha no meio: fica o que ja achou */
  } finally {
    try { fs.closeSync(fd); } catch (_) { /* nada */ }
  }
  return out;
}

// T31 (PLANO-TELEGRAM.md, "T31"): o app em que a conversa vive AGORA = o `entrypoint` da ULTIMA linha que tem o campo
// entre as linhas do fim (as do lerCauda). A cabeca (cabecaDaConversa) diz onde ela NASCEU: caso real 18/10/2026, uma
// aba nasceu no Claude Desktop e seguiu 6 semanas no VS Code; pela cabeca, o porteiro recusava reabrir ("ela e do
// Claude Desktop"). -> string | null (nenhuma linha do fim tem o campo: quem chama usa o da cabeca).
function ultimoEntrypoint(linhas) {
  if (!Array.isArray(linhas)) return null;
  for (let i = linhas.length - 1; i >= 0; i--) {
    const x = linhas[i];
    if (x && typeof x === 'object' && typeof x.entrypoint === 'string' && x.entrypoint) return x.entrypoint;
  }
  return null;
}

// Titulo da aba: ultimo custom-title; senao name do registro quando o proprio dono nomeou; senao ultimo ai-title.
function tituloDe(entradas, registro) {
  const ents = Array.isArray(entradas) ? entradas : [];
  for (let i = ents.length - 1; i >= 0; i--) {
    const e = ents[i];
    if (e && e.type === 'custom-title' && typeof e.customTitle === 'string' && e.customTitle) return e.customTitle;
  }
  if (registro && registro.nameSource === 'user' && typeof registro.name === 'string' && registro.name) return registro.name;
  // Aba sem nome dado mostra o titulo automatico (ai-title, reescrito a cada vez; vale o ultimo). Medido 27/09/2026.
  for (let i = ents.length - 1; i >= 0; i--) {
    const e = ents[i];
    if (e && e.type === 'ai-title' && typeof e.aiTitle === 'string' && e.aiTitle) return e.aiTitle;
  }
  return null;
}

// Ultima entrada "assistant" com pelo menos 1 bloco text; textos juntados com "\n".
function ultimaResposta(entradas) {
  const ents = Array.isArray(entradas) ? entradas : [];
  for (let i = ents.length - 1; i >= 0; i--) {
    const e = ents[i];
    if (!e || e.type !== 'assistant' || !e.message) continue;
    const conteudo = e.message.content;
    let textos = [];
    if (typeof conteudo === 'string') textos = [conteudo];
    else if (Array.isArray(conteudo)) {
      textos = conteudo.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text);
    }
    if (!textos.length) continue;
    return { texto: textos.join('\n'), ts: e.timestamp || null };
  }
  return null;
}

// F4f b (01/10/2026): a resposta da vez ja chegou no transcript? Do fim pro comeco, a 1a entrada que conta decide:
// "user" (pedido, recado de outra sessao ou resultado de ferramenta) = nao; "assistant" com tool_use = nao (a vez nunca
// termina num tool_use); "assistant" com texto = sim. So pensamento e as outras entradas (attachment, titulo, system)
// nao contam. Nada que conte = sim (nada a esperar).
function respostaFresca(entradas) {
  const ents = Array.isArray(entradas) ? entradas : [];
  for (let i = ents.length - 1; i >= 0; i--) {
    const e = ents[i];
    if (!e) continue;
    if (e.type === 'user') return false;
    if (e.type !== 'assistant' || !e.message) continue;
    const conteudo = e.message.content;
    if (typeof conteudo === 'string') return true;
    if (!Array.isArray(conteudo)) continue;
    if (conteudo.some((b) => b && b.type === 'tool_use')) return false;
    if (conteudo.some((b) => b && b.type === 'text' && typeof b.text === 'string')) return true;
  }
  return true;
}

// T16 (PLANO-TELEGRAM.md, "T16"): a vez de agora no fim do transcript (a situacao da aba trabalhando). A vez comeca na
// ultima entrada "user" com conteudo (texto, imagem ou documento; sem tool_result) que vem logo depois de uma "assistant",
// ou sem nada antes nas entradas lidas: a fala do dono no PC, o recado de outra sessao ou do porteiro (peer), o aviso de
// tarefa, o pedido agendado, o resumo da compactacao. "user" logo depois de outra "user" e da mesma vez (o texto da
// skill depois do resultado da ferramenta, o "[Image ...]" depois do pedido com imagem). Sem comeco = tudo o que foi lido
// e desta vez. So "user" e "assistant" com message contam. -> {inicioTs, texto, textoTs, passo, passoTs}: o texto mais
// novo da vez (os blocos text da entrada juntados com "\n", como no ultimaResposta) e a descricao (input.description) do
// tool_use mais novo da vez que tem uma, so quando vem depois do texto. O que falta = null.
function temConteudo(e) {
  const c = e.message.content;
  if (typeof c === 'string') return c.trim() !== '';
  if (!Array.isArray(c) || c.some((b) => b && b.type === 'tool_result')) return false;
  return c.some((b) => b && ((b.type === 'text' && typeof b.text === 'string' && b.text.trim()) || b.type === 'image' || b.type === 'document'));
}
function textoDaEntrada(e) {
  const c = e.message.content;
  if (typeof c === 'string') return c.trim() ? c : null;
  if (!Array.isArray(c)) return null;
  const textos = c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text);
  return textos.length && textos.join('\n').trim() ? textos.join('\n') : null;
}
function descricaoDaEntrada(e) {
  const c = e.message.content;
  if (!Array.isArray(c)) return null;
  let d = null;
  for (const b of c) {
    if (b && b.type === 'tool_use' && b.input && typeof b.input.description === 'string' && b.input.description.trim()) d = b.input.description;
  }
  return d;
}
function vezAtual(entradas) {
  const ents = (Array.isArray(entradas) ? entradas : []).filter((e) => e && (e.type === 'user' || e.type === 'assistant') && e.message);
  let inicio = -1;
  for (let i = 0; i < ents.length; i++) {
    if (ents[i].type === 'user' && temConteudo(ents[i]) && (i === 0 || ents[i - 1].type === 'assistant')) inicio = i;
  }
  const ts = (e) => (e && typeof e.timestamp === 'string' ? e.timestamp : null);
  const out = { inicioTs: inicio >= 0 ? ts(ents[inicio]) : null, texto: null, textoTs: null, passo: null, passoTs: null };
  let iTexto = -1;
  for (let i = ents.length - 1; i > inicio; i--) {
    if (ents[i].type !== 'assistant') continue;
    const t = textoDaEntrada(ents[i]);
    if (t === null) continue;
    out.texto = t;
    out.textoTs = ts(ents[i]);
    iTexto = i;
    break;
  }
  for (let i = ents.length - 1; i > Math.max(inicio, iTexto); i--) {
    if (ents[i].type !== 'assistant') continue;
    const d = descricaoDaEntrada(ents[i]);
    if (d === null) continue;
    out.passo = d;
    out.passoTs = ts(ents[i]);
    break;
  }
  return out;
}

// Marcas do texto final (PLANO.md, secao Contratos):
//   decisao  = contem DECISÃO ou DECISAO, qualquer caixa
//   fica     = contem "Fica com você" ou "Fica com voce"
//   pergunta = a ultima linha nao vazia termina em "?"
function marcas(texto) {
  const t = String(texto == null ? '' : texto).normalize('NFC');
  const baixo = t.toLowerCase();
  const decisao = baixo.includes('decisão') || baixo.includes('decisao');
  const fica = t.includes('Fica com você') || t.includes('Fica com voce');
  const linhas = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const pergunta = linhas.length > 0 && linhas[linhas.length - 1].endsWith('?');
  return { decisao, fica, pergunta };
}

// Modo rua lido do estado.json do porteiro. Fresco = atualizadoEm a no maximo 5 min de agora
// (nos dois sentidos: data no futuro distante tambem e estado podre). Porteiro morto = os
// botoes do dono no PC nunca ficam presos.
function lerModoRua(estadoDir, agoraMs = Date.now()) {
  const nada = { ligado: false, fresco: false, efetivo: false };
  let estado;
  try { estado = JSON.parse(fs.readFileSync(path.join(estadoDir, 'estado.json'), 'utf8')); } catch (_) { return nada; }
  const m = estado && typeof estado === 'object' ? estado.modoRua : null;
  if (!m || typeof m !== 'object') return nada;
  const ligado = m.ligado === true;
  const t = Date.parse(m.atualizadoEm);
  const fresco = Number.isFinite(t) && Math.abs(agoraMs - t) <= FRESCO_MS;
  return { ligado, fresco, efetivo: ligado && fresco };
}

// 1 linha JSON no fim de eventos.jsonl (append-only). Erro sobe pro chamador registrar no log.
function anexarEvento(estadoDir, ev) {
  fs.mkdirSync(estadoDir, { recursive: true });
  fs.appendFileSync(path.join(estadoDir, 'eventos.jsonl'), JSON.stringify(ev) + '\n');
}

// Log de diagnostico. Nunca lanca.
function log(logFile, msg) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${String(msg).replace(/\r?\n/g, ' | ')}\n`);
  } catch (_) { /* log nunca derruba o hook */ }
}

module.exports = {
  caminhos,
  LABEL_MAC,
  ENTRYPOINTS_INTERATIVOS,
  ehInterativa,
  acharRegistro,
  lerCauda,
  cabecaDaConversa,
  ultimoEntrypoint,
  tituloDe,
  ultimaResposta,
  respostaFresca,
  vezAtual,
  marcas,
  lerModoRua,
  anexarEvento,
  log,
};
