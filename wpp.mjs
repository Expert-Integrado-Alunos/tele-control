// sessoes-wpp — cliente do whatsapp-agent preso a um grupo so (o do bloco `whatsapp` do config.json).
// Por que existe: o porteiro (sem IA) precisa ler o grupo e mandar aviso nele sem passar por uma sessao do Claude.
// Fala JSON-RPC direto com o MCP HTTP do whatsapp-agent, com a mesma chave do ~/.claude.json (nunca impressa nem logada).
// Destino FIXO na criacao: o grupo e as 2 instancias entram no criarWpp (A2a: do config.json, pelo wppDoConfig) e nenhum
// metodo recebe chat/numero; o unico lugar pra onde este modulo manda e esse grupo. A instancia de envio manda, le e
// confere os membros; a de conferencia (o celular do dono) so le, e so com { conferencia: true }.
// reagir/editarGrupo (F4.1) recebem so o message_id de uma mensagem que o porteiro leu ou mandou no grupo.
// Contrato: PLANO.md ("Desenho" item 4) e PLANO-ABERTO.md ("A2a — valores").
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PADRAO_WPP, RE_GRUPO_WPP, RE_NOME_WPP, WPP_DESLIGADO_NO_CONFIG } from './lib/config.mjs';

const TIMEOUT_MS = 30000;

/**
 * {url, headers} da entrada `nome` (padrao whatsapp-agent; A2a: o whatsapp.mcp do config) no ~/.claude.json. Lanca se
 * nao houver (a mensagem cita so o nome da entrada, nunca url nem headers).
 */
export function wppDoClaudeJson(caminho = join(homedir(), '.claude.json'), nome = PADRAO_WPP.mcp) {
  const cfg = JSON.parse(readFileSync(caminho, 'utf8'))?.mcpServers?.[nome];
  if (!cfg || typeof cfg.url !== 'string') throw new Error(`${String(nome).slice(0, 64)} sem url no ~/.claude.json`);
  return { url: cfg.url, headers: cfg.headers || {} };
}

/**
 * A2a: o cliente pelo config: `ident` = identidadeWhatsapp(lerConfig(...)) ligada (a entrada do ~/.claude.json pelo
 * `mcp`; o grupo e as 2 instancias do config). Desligado ou incompleto = lanca antes de ler o ~/.claude.json (a mensagem
 * traz o motivo, que so nomeia campos). `caminho` e `fetch` so pra teste.
 */
export function wppDoConfig(ident, { caminho, fetch } = {}) {
  if (!ident || ident.ligado !== true) {
    const m = ident?.motivo;
    throw new Error(m && m !== WPP_DESLIGADO_NO_CONFIG ? `WhatsApp desligado: ${m}` : 'WhatsApp desligado no config');
  }
  const { url, headers } = wppDoClaudeJson(caminho, ident.mcp);
  return criarWpp({
    url, headers, ...(fetch ? { fetch } : {}),
    grupo: ident.grupo, instanciaEnvio: ident.instanciaEnvio, instanciaConferencia: ident.instanciaConferencia,
  });
}

/**
 * O cliente preso ao `grupo`, mandando e lendo pela `instanciaEnvio` e conferindo o celular do dono pela
 * `instanciaConferencia`. Faltou um dos 3 (ou fora do formato do config: um telefone no lugar do grupo nunca passa) =
 * lanca na criacao, sem chamada e sem citar valor.
 */
export function criarWpp({ url, headers = {}, fetch = globalThis.fetch, grupo, instanciaEnvio, instanciaConferencia } = {}) {
  const faltam = [
    ['grupo', grupo, RE_GRUPO_WPP], ['instanciaEnvio', instanciaEnvio, RE_NOME_WPP], ['instanciaConferencia', instanciaConferencia, RE_NOME_WPP],
  ].filter(([, v, re]) => typeof v !== 'string' || !re.test(v)).map(([campo]) => campo);
  if (faltam.length) throw new Error(`criarWpp: falta ou fora do formato: ${faltam.join(', ')}`);
  let seq = 0;

  // Chama 1 tool e devolve o JSON que ela escreveu. Erro de transporte/JSON-RPC lanca (sem headers na mensagem).
  async function tool(name, args) {
    const r = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } }),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    const linha = t.trim().startsWith('{') ? t : (t.split('\n').find((l) => l.startsWith('data:')) || '').slice(5);
    let j;
    try { j = JSON.parse(linha); } catch { throw new Error(`${name}: resposta ilegivel`); }
    if (j.error) throw new Error(`${name}: rpc ${j.error.code} ${String(j.error.message).slice(0, 120)}`);
    const texto = (j.result?.content || []).map((c) => c.text || '').join('');
    let out;
    try { out = JSON.parse(texto); } catch { out = { ok: false, error: texto.slice(0, 200) }; }
    if (j.result?.isError && out && out.ok !== false) out = { ok: false, error: texto.slice(0, 200) };
    return out;
  }

  /**
   * Ultimas `limit` mensagens do grupo (ordem cronologica, como o read devolve). O grupo e sempre o da criacao; so a
   * instancia que le muda: a de envio (padrao) ou, SO com { conferencia: true }, a de conferencia (o ok-wpp confere a
   * copia no celular do dono). Qualquer outra opcao e ignorada (quem chama nunca escolhe instancia).
   */
  async function lerGrupo(limit = 20, { conferencia } = {}) {
    const inst = conferencia === true ? instanciaConferencia : instanciaEnvio;
    const j = await tool('read', { chat: grupo, instance: inst, limit });
    if (j && j.ok === false) throw new Error(`read: ${String(j.error || 'falhou').slice(0, 160)}`);
    return Array.isArray(j?.messages) ? j.messages : [];
  }

  /** Telefones dos membros do grupo (group-metadata do Z-API pela instancia de envio). Erro/sem lista = lanca. */
  async function membros() {
    const j = await tool('zapi_action', { action: 'group-metadata', instance: instanciaEnvio, params: { phone: grupo } });
    if (j && j.ok === false) throw new Error(`group-metadata: ${String(j.error || 'falhou').slice(0, 160)}`);
    const lista = j?.result?.participants;
    if (!Array.isArray(lista) || lista.length === 0) throw new Error('group-metadata: sem participants');
    return lista.map((p) => {
      if (p == null || p.phone == null || p.phone === '') throw new Error('group-metadata: participante sem phone');
      return String(p.phone);
    });
  }

  /** Manda texto no grupo. Nunca lanca: {ok, providerMsgId, messageId} | {ok:false, bloqueio, violacoes} | {ok:false, erro}. */
  async function enviarGrupo(texto, { citarId } = {}) {
    // force_send_after_inbound: o porteiro le o grupo antes de mandar, e a trava de "inbound recente sem resposta" barraria
    // justamente a resposta ao dono. NUNCA confirmed_voice.
    const args = { to: grupo, instance: instanciaEnvio, content: String(texto), confirmed: true, force_send_after_inbound: true };
    if (citarId) args.reply_to = citarId;
    try {
      const j = await tool('send', args);
      // Qualquer trava volta blocked:true (a de inbound volta com ok:true e NADA sai; medido 27/09 17:2x).
      if (j?.blocked) return { ok: false, bloqueio: String(j.reason || 'bloqueado'), violacoes: j.violations || [] };
      if (j?.ok === true) return { ok: true, providerMsgId: j.provider_msg_id ?? null, messageId: j.message_id ?? null };
      return { ok: false, erro: String(j?.error || j?.reason || j?.instruction || 'send sem ok').slice(0, 200) };
    } catch (e) {
      return { ok: false, erro: String(e?.message || e).slice(0, 200) };
    }
  }

  /** Reacao numa mensagem do grupo (message_id = uuid do read). Nunca lanca. */
  async function reagir(messageId, emoji) {
    try {
      const j = await tool('react', { message_id: messageId, emoji });
      return j?.ok === false ? { ok: false, erro: String(j.error || 'react falhou').slice(0, 200) } : { ok: true };
    } catch (e) {
      return { ok: false, erro: String(e?.message || e).slice(0, 200) };
    }
  }

  /**
   * F4.1: edita o texto de uma mensagem que o porteiro mandou no grupo (message_id = uuid que o send devolveu).
   * Destino = a propria mensagem: SO por message_id, nunca chat/target posicional (a msg "ultima enviada" muda no meio).
   * O servidor exige from_me, recusa depois de 15 min do message_ts e passa o texto pelo voice gate. NUNCA confirmed_voice.
   * Nunca lanca: {ok:true} | {ok:false, bloqueio, violacoes} | {ok:false, erro}. Sucesso so com ok + edited.
   */
  async function editarGrupo(messageId, texto) {
    if (typeof messageId !== 'string' || !messageId.trim()) return { ok: false, erro: 'edit_message: sem message_id' };
    try {
      const j = await tool('edit_message', { message_id: messageId, new_content: String(texto), confirmed: true });
      if (j?.blocked) return { ok: false, bloqueio: String(j.reason || 'bloqueado'), violacoes: j.violations || [] };
      if (j?.ok === true && j.edited === true) return { ok: true };
      return { ok: false, erro: String(j?.error || j?.reason || 'edit_message sem edited').slice(0, 200) };
    } catch (e) {
      return { ok: false, erro: String(e?.message || e).slice(0, 200) };
    }
  }

  return { lerGrupo, enviarGrupo, reagir, membros, editarGrupo };
}
