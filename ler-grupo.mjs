// sessoes-wpp — ler-grupo: as ultimas mensagens do grupo do WhatsApp (o do config.json, A2a), so leitura, 1 por linha.
// Pra quem: a central (e o principal) descobrirem pra qual aba e uma fala do dono sem citacao — a pista mais forte e o
// ultimo aviso de agente antes dela (fase 3, F3.9; caso real).
// T3c (PLANO-TELEGRAM.md, "Contratos", T3c): `--telegram` le o mesmo pelo Telegram, SO do estado.json do porteiro (sem
// rede e sem o wpp): as falas do dono (e.tg.recebidas, 2 h; `cita=` = o chamado em cima do qual ele respondeu) + a
// mensagem na tela do chamado de cada aba (`[Sessão X]`, "<estado>: <final>"). O id do dono e o `tg-u...` que o
// `porteiro.mjs encaminhar --msg` aceita; o do agente e o message_id do chamado (o que o `cita=` aponta).
// Uso: node ler-grupo.mjs [N=15] [--telegram]   (N ate 50; --telegram antes ou depois do N)
// Saida: "HH:MM  dono|agente|outro  id=<provider_msg_id>  [cita=<id>]  [Sessão X]  texto (ate 240 chars, 1 linha)". A4a: a
// hora no fuso do dono (o `dono.fuso` do config.json, senao o do Windows).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { horaBRT, definirFuso } from './lib/formato.mjs';
import { lerConfig, identidadeWhatsapp, WPP_DESLIGADO_NO_CONFIG, donoDoConfig } from './lib/config.mjs';

const require = createRequire(import.meta.url);
const lib = require('./hooks/lib/sessoes-wpp.js');

const ESTE_ARQUIVO = fileURLToPath(import.meta.url);
const TELEGRAM = '--telegram';
const TENTATIVAS = 3; // estado.json ocupado (o porteiro troca o arquivo com rename): ate 3 leituras
const ESPERA_MS = 200;
const OCUPADO = new Set(['EBUSY', 'EPERM', 'EACCES']);

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 1 linha no formato da leitura do grupo: partes separadas por 2 espacos, texto em 1 linha, ate 240 caracteres. */
export function linha({ hora, quem, id, cita, sessao, texto, vazio }) {
  const t = String(texto ?? '').replace(/\s+/g, ' ').trim();
  const partes = [hora, quem.padEnd(6), `id=${id}`];
  if (cita) partes.push(`cita=${cita}`);
  if (sessao) partes.push(`[Sessão ${sessao}]`);
  partes.push(t.length > 240 ? `${t.slice(0, 237)}...` : t || vazio);
  return partes.join('  ');
}

/**
 * F4g: nome da aba no cabecalho de uma mensagem do grupo: "ℹ️ *Nome*" (desde 01/10/2026) ou "*Sessão Nome (pc)*" (as
 * de antes). A frase do proprio porteiro ("🎛️ *Controle de sessões*"; antes ℹ️) nao casa o regex de
 * aba (icone diferente) = undefined; a guarda do nome "Controle de sessões" ainda cobre o historico antigo com ℹ️.
 */
export function sessaoDoCabecalho(texto) {
  const s = String(texto ?? '');
  const antigo = /^\*Sess[aã]o (.+?) \(pc\)\*/.exec(s);
  if (antigo) return antigo[1];
  const novo = /^ℹ️? ?\*([^*\n]+)\*/u.exec(s);
  return novo && novo[1] !== 'Controle de sessões' ? novo[1] : undefined;
}

/**
 * Le o estado.json do porteiro. Arquivo ocupado (EBUSY/EPERM/EACCES) = ate 3 tentativas com 200 ms entre elas.
 * -> {estado} | {estado: null} (sem arquivo) | {ruim: true} (JSON ruim) | {erro: <codigo>} (nao deu pra ler).
 * `ler` e `dormir` injetaveis (teste).
 */
export async function lerEstado(arq, {
  ler = (a) => fs.readFileSync(a, 'utf8'),
  dormir = (ms) => new Promise((ok) => setTimeout(ok, ms)),
} = {}) {
  for (let i = 1; ; i += 1) {
    let bruto;
    try {
      bruto = ler(arq);
    } catch (err) {
      if (err?.code === 'ENOENT') return { estado: null };
      if (OCUPADO.has(err?.code) && i < TENTATIVAS) {
        await dormir(ESPERA_MS);
        continue;
      }
      return { erro: String(err?.code || err?.message || err).slice(0, 80) };
    }
    try {
      return { estado: JSON.parse(bruto) };
    } catch {
      return { ruim: true };
    }
  }
}

/**
 * As `n` ultimas linhas do Telegram, em ordem de hora (puro): cada fala do dono em e.tg.recebidas + a mensagem na tela
 * do chamado de cada aba (hora = a da mensagem no chat, senao a da versao). Fica fora: chamado sem mensagem na tela, a
 * mensagem do sistema, mensagem fora de chamado e linha com hora ilegivel. Estado sem tg = nenhuma.
 */
export function linhasTelegram(estado, n) {
  const t = ehObjeto(estado) ? estado.tg : null;
  if (!ehObjeto(t)) return [];
  const itens = [];
  const recebidas = ehObjeto(t.recebidas) ? t.recebidas : {};
  for (const [id, r] of Object.entries(recebidas)) {
    if (!ehObjeto(r)) continue;
    const anexos = Array.isArray(r.anexos) ? r.anexos : [];
    itens.push({
      at: r.at,
      quem: 'dono',
      id,
      cita: Number.isSafeInteger(r.respondeA) ? r.respondeA : null, // entrada antiga sem o campo = null
      texto: typeof r.texto === 'string' ? r.texto : '',
      vazio: anexos.length ? '(anexo)' : '(sem texto)',
    });
  }
  const chamados = ehObjeto(t.chamados) ? t.chamados : {};
  const mensagens = ehObjeto(t.mensagens) ? t.mensagens : {};
  for (const [sid, c] of Object.entries(chamados)) {
    const v = ehObjeto(c) ? c.versao : null;
    const tela = ehObjeto(c) && ehObjeto(c.mensagem) ? c.mensagem.messageId : null;
    if (!ehObjeto(v) || !Number.isSafeInteger(tela)) continue;
    const m = Object.hasOwn(mensagens, String(tela)) && ehObjeto(mensagens[tela]) ? mensagens[tela] : null;
    const titulo = typeof v.titulo === 'string' ? v.titulo.replace(/\s+/g, ' ').trim() : '';
    const final = typeof v.final === 'string' ? v.final.trim() : '';
    const estadoV = String(v.estado ?? '');
    itens.push({
      at: legivel(m?.at) ? m.at : v.hora,
      quem: 'agente',
      id: tela,
      sessao: titulo || sid.slice(0, 8),
      texto: final ? `${estadoV}: ${final}` : estadoV,
      vazio: '(sem texto)',
    });
  }
  const validos = itens
    .map((x) => ({ ...x, ms: Date.parse(x.at) }))
    .filter((x) => legivel(x.at))
    .sort((a, b) => a.ms - b.ms);
  return validos.slice(-n).map((x) => linha({ ...x, hora: horaBRT(x.at) }));
}

// Hora que da pra ordenar e mostrar (ISO com hora; o horaBRT devolve "??:??" pro resto).
function legivel(at) {
  return typeof at === 'string' && Number.isFinite(Date.parse(at)) && horaBRT(at) !== '??:??';
}

async function lerDoTelegram(n) {
  const arq = path.join(lib.caminhos(process.env).estadoDir, 'estado.json');
  const r = await lerEstado(arq);
  if (r.ruim) {
    console.error('estado.json do porteiro ilegivel (JSON ruim): nada pra mostrar');
    return;
  }
  if (r.erro) {
    console.error(`nao consegui ler o estado.json do porteiro (${r.erro})`);
    process.exitCode = 1;
    return;
  }
  for (const l of linhasTelegram(r.estado, n)) console.log(l);
}

// O grupo pelo whatsapp-agent (como sempre). O wpp.mjs so entra aqui: o `--telegram` nao carrega nada que leia o home.
// A2b + A2a: WhatsApp desligado (ou incompleto) no config.json = 1 linha e sai 0, sem carregar o wpp.mjs (nem ler o
// ~/.claude.json); incompleto diz so o nome dos campos. Ligado = o grupo e a instancia de envio do config, e "dono" = a
// mensagem do numeroDono (igual, nunca "contem"). O cfg e o que o main leu.
async function lerDoGrupo(n, cfg) {
  const ident = identidadeWhatsapp(cfg);
  if (!ident.ligado) {
    console.log(ident.motivo && ident.motivo !== WPP_DESLIGADO_NO_CONFIG ? `WhatsApp desligado: ${ident.motivo}` : 'WhatsApp desligado');
    return;
  }
  const { wppDoConfig } = await import('./wpp.mjs');
  const wpp = wppDoConfig(ident);
  let msgs;
  try {
    msgs = await wpp.lerGrupo(n);
  } catch (e) {
    console.error(`nao consegui ler o grupo: ${String(e?.message || e).slice(0, 160)}`);
    process.exit(1);
  }
  for (const m of msgs) {
    const sessao = sessaoDoCabecalho(m.content);
    const quem = m.from_me ? 'agente' : String(m.sender_phone ?? '') === ident.numeroDono ? 'dono' : 'outro';
    console.log(linha({
      hora: horaBRT(m.message_ts),
      quem,
      id: m.provider_msg_id ?? m.id ?? '?',
      cita: m.quoted_msg_id,
      sessao,
      texto: m.content ?? m.transcription ?? '',
      vazio: `(${m.message_type || 'sem texto'})`,
    }));
  }
}

async function main(args) {
  // A4a: o config.json da pasta de estado lido 1 vez (ilegivel = {}): o fuso das horas (o do dono, senao o do Windows)
  // e o WhatsApp do grupo
  const cfg = lerConfig(lib.caminhos(process.env).estadoDir);
  definirFuso(donoDoConfig(cfg).fuso);
  const telegram = args.includes(TELEGRAM);
  const n = Math.min(50, Math.max(1, Number(args.find((a) => a !== TELEGRAM)) || 15));
  if (telegram) return lerDoTelegram(n);
  return lerDoGrupo(n, cfg);
}

function ehPrincipal() {
  if (!process.argv[1]) return false;
  const a = path.resolve(process.argv[1]);
  return process.platform === 'win32' ? a.toLowerCase() === ESTE_ARQUIVO.toLowerCase() : a === ESTE_ARQUIVO;
}

if (ehPrincipal()) await main(process.argv.slice(2));
