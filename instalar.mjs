// instalar.mjs — o instalador do Tele Control, 1 passo por chamada (PLANO-ABERTO.md, "Instalador (contrato técnico)").
// Quem chama: a skill /instalar (.claude/skills/instalar/SKILL.md), que faz as perguntas de clique e roda os passos.
// Uso: node instalar.mjs <passo> [opcoes]   (passos em PASSOS; `node instalar.mjs ajuda` lista)
// Saida: 1 objeto JSON {ok, passo, ...} no stdout; codigo 0 = ok, 1 = falhou (motivo em `erro`), 2 = uso errado.
// Nunca imprime a chave do bot. Todo arquivo que muda ganha copia antes em <estado>/instalacao/copias/ e o que foi
// feito fica em <estado>/instalacao/feito.json (o `desinstalar` e o `cartao` leem).
// Pastas (teste e override): SESSOES_WPP_DIR (estado), SESSOES_WPP_LOG, SESSOES_WPP_CLAUDE_DIR (padrao ~/.claude),
// SESSOES_WPP_STARTUP_DIR (padrao a pasta Inicializar do usuario).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as I from './lib/instalar.mjs';
import { identidadeTelegram, APPS, appsDoConfig, nomeDoDonoValido, fusoValido, sessoesDoConfig } from './lib/config.mjs';
import { chaveTelegram, lerRegistroReal } from './lib/registro.mjs';

const REPO = path.dirname(fileURLToPath(import.meta.url));
export const PASSOS = Object.freeze(['checar', 'pastas', 'telegram-chave', 'telegram-chat', 'config', 'hooks',
  'inicializar', 'claude-md', 'ligar', 'cartao', 'desinstalar']);
const FLAGS = new Set(['--tirar', '--so-conferir', '--trocar', '--tudo', '--audio', '--json']);
const COM_VALOR = new Set(['--dados', '--confirmar']);
export const OPCOES = Object.freeze([...FLAGS, ...COM_VALOR]); // o teste confere que a skill so usa estas
export const TEXTO_TESTE = 'Tele Control ligado neste PC. Responda aqui pra testar.';
export const CREDITO = 'Tele Control: criado por Eric Luciano, educador e mentor de IA aplicada a negócios, da Expert Integrado (expertintegrado.com.br).';
const ARQ_INICIO = 'tele-control.vbs';
const ESPERA_SUBIR_MS = 90 * 1000;

const ehObjeto = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const ok = (dados = {}) => ({ codigo: 0, saida: { ok: true, ...dados } });
const falha = (erro, dados = {}) => ({ codigo: 1, saida: { ok: false, erro, ...dados } });
const uso = (erro) => ({ codigo: 2, saida: { ok: false, erro } });

function pastasDe(env) {
  const base = path.join(os.homedir(), '.claude');
  const estado = env.SESSOES_WPP_DIR || path.join(base, 'sessoes-wpp');
  const roaming = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return {
    estado,
    instalacao: path.join(estado, 'instalacao'),
    log: env.SESSOES_WPP_LOG || path.join(base, 'logs', 'sessoes-wpp.log'),
    claudeDir: env.SESSOES_WPP_CLAUDE_DIR || base,
    inicio: env.SESSOES_WPP_STARTUP_DIR || path.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
  };
}

function lerArgs(argv) {
  const [passo, ...resto] = argv;
  const opcoes = {};
  for (let i = 0; i < resto.length; i++) {
    const a = resto[i];
    if (FLAGS.has(a)) opcoes[a.slice(2)] = true;
    else if (COM_VALOR.has(a) && i + 1 < resto.length) opcoes[a.slice(2)] = resto[++i];
    else return { passo, erro: `opção desconhecida ou sem valor: ${a}` };
  }
  return { passo, opcoes };
}

// ---------- arquivos ----------

function carimbo(agora) {
  const d = new Date(agora());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Copia o arquivo (se existe) pra <instalacao>/copias/<data>-<nome>; devolve o destino ou null. */
function copiar(arquivo, P, agora) {
  if (!fs.existsSync(arquivo)) return null;
  const dir = path.join(P.instalacao, 'copias');
  fs.mkdirSync(dir, { recursive: true });
  const base = `${carimbo(agora)}-${path.basename(arquivo)}`;
  let destino = path.join(dir, base);
  for (let n = 2; fs.existsSync(destino); n++) destino = path.join(dir, `${carimbo(agora)}-${n}-${path.basename(arquivo)}`);
  fs.copyFileSync(arquivo, destino);
  return destino;
}

/** Grava por arquivo temporario + rename (quem le nunca pega o arquivo pela metade). */
function gravar(arquivo, conteudo, codificacao = 'utf8') {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const tmp = `${arquivo}.tele-control-${process.pid}.tmp`;
  fs.writeFileSync(tmp, conteudo, codificacao);
  fs.renameSync(tmp, arquivo);
}

/** {existe, valor} ou {existe, ruim: true} pra JSON ilegivel ou que nao e objeto. */
function lerJson(arquivo) {
  if (!fs.existsSync(arquivo)) return { existe: false, valor: {} };
  try {
    const v = JSON.parse(fs.readFileSync(arquivo, 'utf8').replace(/^﻿/, ''));
    return ehObjeto(v) ? { existe: true, valor: v } : { existe: true, ruim: true };
  } catch {
    return { existe: true, ruim: true };
  }
}

function lerFeito(P) {
  const r = lerJson(path.join(P.instalacao, 'feito.json'));
  return r.ruim ? {} : r.valor;
}

function registrar(P, passo, dados, agora) {
  const feito = lerFeito(P);
  feito[passo] = { em: new Date(agora()).toISOString(), ...dados };
  gravar(path.join(P.instalacao, 'feito.json'), JSON.stringify(feito, null, 2) + '\n');
}

// Junta no config.json (copia antes; so grava se muda). {ok, acrescentadas, conflitos, trocadas} | {ok: false, erro}.
function gravarConfig(P, dados, { trocar = false } = {}, agora) {
  const arq = path.join(P.estado, 'config.json');
  const atual = lerJson(arq);
  if (atual.ruim) return { ok: false, erro: 'o config.json atual não é um JSON de objeto válido; não mexi nele' };
  const r = I.juntarConfig(atual.valor, dados, { trocar });
  if (r.acrescentadas.length || r.trocadas.length) {
    copiar(arq, P, agora);
    gravar(arq, JSON.stringify(r.config, null, 2) + '\n');
  }
  return { ok: true, acrescentadas: r.acrescentadas, conflitos: r.conflitos, trocadas: r.trocadas };
}

// ---------- passos ----------

function passoChecar(o, d) {
  const r = I.checar({
    plataforma: d.plataforma, release: d.release, versaoNode: d.versaoNode, rodar: d.rodar, existe: d.existe,
    env: d.env, audio: Boolean(o.audio),
  });
  // O nome do usuario do Windows: a sugestao da pergunta "como o sistema te chama" (so o nome, nada da pasta).
  const nomeDoWindows = d.env.USERNAME || (() => { try { return os.userInfo().username; } catch { return null; } })();
  if (r.ok) return ok({ itens: r.itens, nomeDoWindows });
  const faltas = Object.entries(r.itens).filter(([, i]) => !i.ok).map(([k, i]) => `${k}: ${i.falta}`);
  return falha(`falta coisa no PC (${faltas.join('; ')})`, { itens: r.itens, nomeDoWindows });
}

// Sugere as pastas de projeto pelo cwd das conversas antigas do Claude Code (so o cwd; o resto da conversa nao e lido).
function passoPastas(o, d, P) {
  const projetos = d.env.CLAUDE_PROJECTS_DIR || path.join(P.claudeDir, 'projects');
  const itens = d.lerCwds(projetos);
  const casa = d.env.USERPROFILE || os.homedir();
  const conversas = itens.reduce((s, i) => s + i.conversas, 0);
  return ok({ pastas: I.pastasSugeridas(itens, { casa, existe: d.existePasta }), conversas });
}

function varChaveDe(P) {
  const cfg = lerJson(path.join(P.estado, 'config.json'));
  return identidadeTelegram(cfg.ruim ? {} : cfg.valor).varChave;
}

// A chave so pelo registro do usuario (env vazio): o processo do instalador nasceu antes da janela gravar a variavel, e
// um valor velho no ambiente nao pode passar na frente do novo.
const chaveDoRegistro = (d, varChave) => chaveTelegram({ env: {}, lerRegistro: d.lerRegistro, varChave });

async function passoTelegramChave(o, d, P) {
  const varChave = varChaveDe(P);
  if (!o['so-conferir']) {
    const j = await d.abrirJanelaChave({ varChave, script: path.join(d.repo, 'bin', 'chave-telegram.ps1') });
    if (j?.codigo === 2) return falha('o que foi colado não parecia a chave de um bot (o formato é número:letras)');
    if (j?.codigo !== 0) return falha('cancelado');
  }
  const token = await chaveDoRegistro(d, varChave);
  if (!token) return falha('cancelado');
  const r = await I.conferirChave({ fetch: d.fetch, token });
  if (!r.ok) return falha(r.erro);
  // Chave nova = bot novo: o id e o nome do bot vao pro config (com troca), o porteiro confere a chave por eles.
  const telegram = { botId: r.bot.id, varChave };
  const nome = typeof r.bot.nome === 'string' ? [...r.bot.nome.trim()].slice(0, 64).join('') : '';
  if (nome) telegram.nomeBot = nome;
  const g = gravarConfig(P, { telegram }, { trocar: true }, d.agora);
  if (!g.ok) return falha(g.erro);
  registrar(P, 'telegram-chave', { bot: r.bot.usuario, varChave }, d.agora);
  return ok({ bot: r.bot, varChave });
}

async function passoTelegramChat(o, d, P) {
  const varChave = varChaveDe(P);
  const token = await chaveDoRegistro(d, varChave);
  if (!token) return falha('falta a chave do bot: rode o passo telegram-chave antes');
  const r = await I.lerChats({ fetch: d.fetch, token });
  if (!r.ok) return falha(r.erro);
  if (o.confirmar === undefined) return ok({ chats: r.chats });
  const id = Number(o.confirmar);
  const chat = r.chats.find((c) => c.id === id);
  if (!chat) return falha('essa conversa não está entre as que falaram com o bot: mande uma mensagem pro bot e tente de novo', { chats: r.chats });
  const g = gravarConfig(P, { telegram: { chatId: id } }, { trocar: true }, d.agora);
  if (!g.ok) return falha(g.erro);
  if (r.ultimo !== null) await I.marcarLidas({ fetch: d.fetch, token, offset: r.ultimo + 1 });
  registrar(P, 'telegram-chat', { chat: chat.nome }, d.agora);
  return ok({ chat });
}

function passoConfig(o, d, P) {
  if (typeof o.dados !== 'string') return uso('o passo config precisa de --dados \'<json>\'');
  let dados;
  try {
    dados = JSON.parse(o.dados);
  } catch {
    return uso('--dados não é um JSON válido');
  }
  if (!ehObjeto(dados)) return uso('--dados tem que ser um objeto JSON');
  // A3b: o `apps` (a pergunta 1) so com os 4 conhecidos; vai em minuscula e sem repetir
  if (Object.hasOwn(dados, 'apps')) {
    const ok = Array.isArray(dados.apps) && dados.apps.every((a) => typeof a === 'string' && APPS.includes(a.trim().toLowerCase()));
    if (!ok) return uso('apps tem que ser uma lista com vscode, desktop, orca ou terminal');
    dados.apps = appsDoConfig({ apps: dados.apps });
  }
  // T23c: o telegram.resolvidas (o modo das mensagens resolvidas, a pergunta 10) so "apagar" ou "manter"; a troca e o
  // --trocar de sempre (sem ele, valor diferente do gravado = conflito)
  if (ehObjeto(dados.telegram) && Object.hasOwn(dados.telegram, 'resolvidas') && !['apagar', 'manter'].includes(dados.telegram.resolvidas)) {
    return uso('telegram.resolvidas tem que ser "apagar" ou "manter"');
  }
  // A4a: o `dono` (as perguntas 3 e 3b) tem que ser objeto, com o nome bom no nomeDoDonoValido, o artigo "o", "a" ou ""
  // ("" = "de <nome>"; aparado, minuscula) e o fuso bom no fusoValido (os 2 podem faltar). Vai normalizado: o nome, o
  // artigo em minuscula e o fuso canonico; campo desconhecido fica como veio
  if (Object.hasOwn(dados, 'dono')) {
    const bruto = dados.dono;
    if (!ehObjeto(bruto)) return uso('dono tem que ser um objeto JSON (nome, artigo e fuso)');
    const nome = nomeDoDonoValido(bruto.nome);
    if (nome === null) return uso('dono.nome tem que ter de 1 a 40 letras, começar com letra e só usar letras, números, espaço e . \' ’ _ -');
    const dono = { ...bruto, nome };
    if (Object.hasOwn(bruto, 'artigo')) {
      const artigo = typeof bruto.artigo === 'string' ? bruto.artigo.trim().toLowerCase() : null;
      if (artigo !== 'o' && artigo !== 'a' && artigo !== '') return uso('dono.artigo tem que ser "o", "a" ou "" (sem artigo: "de <nome>")');
      dono.artigo = artigo;
    }
    if (Object.hasOwn(bruto, 'fuso')) {
      const fuso = fusoValido(bruto.fuso);
      if (fuso === null) return uso('dono.fuso tem que ser um fuso como "America/Sao_Paulo"');
      dono.fuso = fuso;
    }
    dados.dono = dono;
  }
  // T9 (madrugada 18/10/2026): o Git Bash (o terminal do Claude Code no Windows) troca a barra invertida dupla do JSON por
  // uma so ("D:\\rede" chega "D:\rede" e o \r vira caractere invisivel) e a pasta quebrada passava calada: o porteiro a
  // descarta e nao abre nem reabre conversa. Cada pasta de projeto passa pela regra do porteiro (sessoesDoConfig) e tem
  // que existir neste PC; vai normalizada (barra normal vira invertida), sem repetir
  if (ehObjeto(dados.sessoes) && Object.hasOwn(dados.sessoes, 'raizes')) {
    if (!Array.isArray(dados.sessoes.raizes)) return uso('sessoes.raizes tem que ser uma lista de pastas');
    for (const bruta of dados.sessoes.raizes) {
      const [p] = sessoesDoConfig({ sessoes: { raizes: [bruta] } }).raizes;
      if (!p) return uso(`a pasta ${JSON.stringify(bruta)} não serve: escreva o caminho completo com barra normal, como "C:/projetos" (no terminal a barra invertida some)`);
      if (!d.existePasta(p)) return uso(`a pasta ${p} não existe neste PC`);
    }
    dados.sessoes = { ...dados.sessoes, raizes: sessoesDoConfig({ sessoes: { raizes: dados.sessoes.raizes } }).raizes };
  }
  const g = gravarConfig(P, dados, { trocar: Boolean(o.trocar) }, d.agora);
  if (!g.ok) return falha(g.erro);
  registrar(P, 'config', { acrescentadas: g.acrescentadas, trocadas: g.trocadas }, d.agora);
  return ok({ acrescentadas: g.acrescentadas, conflitos: g.conflitos, trocadas: g.trocadas });
}

function passoHooks(o, d, P) {
  const arq = path.join(P.claudeDir, 'settings.json');
  const atual = lerJson(arq);
  if (atual.ruim) return falha('o settings.json do Claude Code não é um JSON de objeto válido; não mexi nele');
  let r;
  try {
    r = o.tirar ? I.tirarHooks(atual.valor, d.repo) : I.juntarHooks(atual.valor, d.repo);
  } catch {
    return falha('os hooks do settings.json têm um formato que eu não conheço; não mexi nele');
  }
  const mudou = o.tirar ? r.tirados.length > 0 : r.acrescentados.length > 0;
  if (mudou) {
    copiar(arq, P, d.agora);
    gravar(arq, JSON.stringify(r.settings, null, 2) + '\n');
  }
  if (o.tirar) return ok({ tirados: r.tirados });
  registrar(P, 'hooks', { acrescentados: r.acrescentados, jaTinha: r.jaTinha }, d.agora);
  return ok({ acrescentados: r.acrescentados, jaTinha: r.jaTinha });
}

function passoInicializar(o, d, P) {
  const arq = path.join(P.inicio, ARQ_INICIO);
  const existe = fs.existsSync(arq);
  if (o.tirar) {
    if (!existe) return ok({ tirou: false });
    if (!I.ehVbsNosso(fs.readFileSync(arq))) return falha(`o ${ARQ_INICIO} da pasta Inicializar não foi feito por mim; não apaguei`);
    fs.unlinkSync(arq);
    return ok({ tirou: true });
  }
  if (existe && !I.ehVbsNosso(fs.readFileSync(arq))) return falha(`já existe um ${ARQ_INICIO} que não é meu na pasta Inicializar; não mexi`);
  let texto;
  try {
    texto = I.vbsDeInicio(d.repo);
  } catch (e) {
    return falha(e.message);
  }
  gravar(arq, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(texto, 'utf16le')]), null);
  registrar(P, 'inicializar', { arquivo: arq }, d.agora);
  return ok({ arquivo: arq });
}

function passoClaudeMd(o, d, P) {
  const arq = path.join(P.claudeDir, 'CLAUDE.md');
  const existe = fs.existsSync(arq);
  const atual = existe ? fs.readFileSync(arq, 'utf8') : '';
  const novo = o.tirar ? I.tirarBloco(atual).texto : I.porBloco(atual);
  if (novo !== atual) {
    if (existe) copiar(arq, P, d.agora);
    gravar(arq, novo);
  }
  if (o.tirar) return ok({ tirou: novo !== atual });
  registrar(P, 'claude-md', { arquivo: arq }, d.agora);
  return ok({ arquivo: arq, mudou: novo !== atual });
}

async function passoLigar(o, d, P) {
  const cfg = lerJson(path.join(P.estado, 'config.json'));
  if (cfg.ruim) return falha('o config.json atual não é um JSON de objeto válido');
  if (cfg.valor.telegram?.ligado !== true) return falha('o Telegram não está ligado no config: rode o passo config com telegram.ligado = true antes');
  const id = identidadeTelegram(cfg.valor);
  if (!id.chatId) return falha('falta a conversa do Telegram: rode telegram-chat --confirmar antes');
  const token = await chaveDoRegistro(d, id.varChave);
  if (!token) return falha('falta a chave do bot: rode o passo telegram-chave antes');
  try { fs.unlinkSync(path.join(P.estado, 'desligado')); } catch { /* nao tinha */ }
  // O porteiro so le o config ao subir: o que ja estava ligado para e sobe de novo com o config novo.
  const antes = d.pararPorteiro();
  if (antes === 'não consegui parar') return falha('o Tele Control que já estava ligado não parou; não religuei');
  const desde = (() => { try { return fs.statSync(P.log).size; } catch { return 0; } })();
  d.rodarVbs(path.join(d.repo, 'sessoes-wpp-porteiro.vbs'));
  const r = await d.esperarSubida(P.log, desde, ESPERA_SUBIR_MS);
  if (!r.ok) return falha(r.erro);
  const porteiro = antes === 'parado' ? 'religado' : 'ligado';
  const m = await I.mandarTexto({ fetch: d.fetch, token, chatId: id.chatId, texto: TEXTO_TESTE });
  registrar(P, 'ligar', { mensagemDeTeste: m.ok }, d.agora);
  return m.ok ? ok({ porteiro, mensagemDeTeste: true })
    : falha(`o porteiro ligou, mas a mensagem de teste não saiu (${m.erro})`, { porteiro });
}

function passoCartao(o, d, P) {
  const feito = lerFeito(P);
  const cfg = lerJson(path.join(P.estado, 'config.json'));
  const apps = Array.isArray(cfg.valor?.apps) ? cfg.valor.apps : [];
  const ligado = [];
  if (feito.ligar) ligado.push('o Tele Control, falando com o seu bot do Telegram');
  if (feito.hooks) ligado.push('os avisos do Claude Code (conversa parada, pergunta, abertura de sessão)');
  if (feito['claude-md']) ligado.push('a regra das perguntas no seu CLAUDE.md');
  if (feito.inicializar) ligado.push('liga sozinho quando o Windows entra');
  const dicas = [];
  if (apps.includes('orca')) dicas.push('Orca: nas configurações do Orca, desligue o acompanhamento de status dos agentes (ou só o do Claude). Senão, a cada abertura, o Orca grava 13 hooks no settings.json do Claude Code, que rodam em toda conversa do PC e deixam tudo mais lento. O Tele Control não depende deles.');
  if (apps.includes('desktop')) dicas.push('Claude Desktop: as conversas da aba Code entram sozinhas no controle quando têm o canal de recado ligado.');
  if (apps.includes('vscode')) dicas.push('VS Code: as conversas fechadas aparecem no painel pelos grupos da lista do Claude Code. As conversas arquivadas e as de um grupo com "Concluído" no nome ficam fora do painel.');
  return ok({
    ligado,
    dicas,
    // O arquivo "desligado" so impede o guardiao e o supervisor de religar; o porteiro que roda para pelo `parar`
    comoDesligar: [
      `Pausar: crie um arquivo chamado "desligado" na pasta ${P.estado} (assim ele não volta sozinho) e pare o que está rodando com: node "${path.join(d.repo, 'porteiro.mjs')}" parar. Pra voltar: node instalar.mjs ligar`,
      'Tirar tudo: node instalar.mjs desinstalar',
    ],
    credito: CREDITO,
  });
}

async function passoDesinstalar(o, d, P) {
  fs.mkdirSync(P.estado, { recursive: true });
  fs.writeFileSync(path.join(P.estado, 'desligado'), 'desligado pelo instalar.mjs desinstalar\n');
  const porteiro = d.pararPorteiro();
  const hooks = passoHooks({ tirar: true }, d, P).saida;
  const inicio = passoInicializar({ tirar: true }, d, P).saida;
  const claudeMd = passoClaudeMd({ tirar: true }, d, P).saida;
  const resultado = { porteiro, hooks, inicializar: inicio, claudeMd };
  if (o.tudo) {
    const varChave = varChaveDe(P);
    const arq = path.join(P.estado, 'config.json');
    resultado.config = copiar(arq, P, d.agora) ? 'tirado (cópia guardada)' : 'não tinha';
    try { fs.unlinkSync(arq); } catch { /* nao tinha */ }
    resultado.chave = d.apagarVariavel(varChave) ? 'tirada' : 'não tirada';
  }
  return ok(resultado);
}

// ---------- dependencias reais ----------

const JANELA_PASTAS_MS = 60 * 24 * 60 * 60 * 1000; // so conta conversa mexida nos ultimos 60 dias
const AMOSTRA_POR_PASTA = 40;
const BYTES_DO_COMECO = 64 * 1024;
// Conversa que a pessoa abriu (VS Code, terminal, Claude Desktop); `claude -p` de rotina (sdk-cli) nao conta.
const ENTRYPOINTS_DE_GENTE = new Set(['cli', 'claude-vscode', 'claude-desktop']);

// O 1o cwd e o 1o entrypoint do comeco (64 KB) de uma conversa: so as linhas inteiras que tem o nome do campo viram JSON.
function comecoDaConversa(arquivo) {
  const fd = fs.openSync(arquivo, 'r');
  const buf = Buffer.alloc(BYTES_DO_COMECO);
  let lidos = 0;
  try { lidos = fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
  const texto = buf.subarray(0, lidos).toString('utf8');
  const linhas = lidos < BYTES_DO_COMECO ? texto.split('\n') : texto.split('\n').slice(0, -1); // a ultima pode vir cortada
  const out = { cwd: null, entrypoint: null };
  for (const linha of linhas) {
    if (out.cwd !== null && out.entrypoint !== null) break;
    if (!linha.includes('"cwd"') && !linha.includes('"entrypoint"')) continue;
    let x;
    try { x = JSON.parse(linha); } catch { continue; }
    if (!x || typeof x !== 'object') continue;
    if (out.cwd === null && typeof x.cwd === 'string' && x.cwd) out.cwd = x.cwd;
    if (out.entrypoint === null && typeof x.entrypoint === 'string' && x.entrypoint) out.entrypoint = x.entrypoint;
  }
  return out;
}

// Cada pasta de projeto do Claude Code vira {cwd, conversas}: conversas = .jsonl mexidos nos ultimos 60 dias que a
// pessoa abriu (a proporcao sai das 40 mais recentes; conversa sem entrypoint conta como dela); o cwd e o da mais
// recente dela. So o cwd e o entrypoint sao lidos; o resto da conversa nao.
function lerCwdsReal(projetos, agora = Date.now()) {
  const itens = [];
  let pastas = [];
  try { pastas = fs.readdirSync(projetos, { withFileTypes: true }).filter((p) => p.isDirectory()); } catch { return itens; }
  for (const pasta of pastas) {
    const dir = path.join(projetos, pasta.name);
    let recentes = [];
    try {
      recentes = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'))
        .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
        .filter((a) => agora - a.t <= JANELA_PASTAS_MS).sort((a, b) => b.t - a.t);
    } catch { continue; }
    let cwd = null;
    let lidas = 0;
    let delas = 0;
    for (const { n } of recentes.slice(0, AMOSTRA_POR_PASTA)) {
      let c;
      try { c = comecoDaConversa(path.join(dir, n)); } catch { continue; } // conversa ilegivel: pula
      lidas += 1;
      if (c.entrypoint !== null && !ENTRYPOINTS_DE_GENTE.has(c.entrypoint)) continue;
      delas += 1;
      if (cwd === null && c.cwd) cwd = c.cwd;
    }
    const conversas = lidas ? Math.round(recentes.length * (delas / lidas)) : 0;
    if (cwd !== null && conversas > 0) itens.push({ cwd, conversas });
  }
  return itens;
}

function rodarReal(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 20000 });
}

// Janela propria do PowerShell (visivel) com a entrada escondida; espera fechar e devolve o codigo dela.
function abrirJanelaChaveReal({ varChave, script }) {
  const aspas = (s) => String(s).replace(/'/g, "''");
  const ps = `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','"${aspas(script)}"','-Variavel','${aspas(varChave)}') -Wait -PassThru; exit $p.ExitCode`;
  // 9 min: cabe no prazo maximo de um comando do Claude Code (10 min); passou = cancelado (a janela pode seguir aberta
  // e gravar a chave depois: o --so-conferir pega).
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true, timeout: 9 * 60 * 1000 });
  return { codigo: r.status };
}

function rodarVbsReal(vbs) {
  const filho = spawn('wscript.exe', ['//nologo', vbs], { detached: true, stdio: 'ignore', windowsHide: true });
  filho.unref();
}

// Espera nas linhas NOVAS do log (a partir do byte `desde`) a subida do porteiro com o Telegram; so olha essas chaves.
// Le so as linhas NOVAS do log (a partir de `desde`, em bytes) ate a subida com o Telegram ligado ou uma falha conhecida.
// Exportada pro teste (com log de mentira e prazo curto).
export async function esperarSubidaReal(log, desde, prazoMs) {
  const fim = Date.now() + prazoMs;
  let subiu = false;
  while (Date.now() < fim) {
    let novo = '';
    try {
      const fd = fs.openSync(log, 'r');
      try {
        const tam = fs.fstatSync(fd).size;
        if (tam > desde) {
          const buf = Buffer.alloc(tam - desde);
          fs.readSync(fd, buf, 0, buf.length, desde);
          novo = buf.toString('utf8');
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch { /* log ainda nao existe */ }
    if (/ subiu \(pid \d+\)/.test(novo)) subiu = true;
    if (/Telegram: ligado \(bot /.test(novo) && subiu) return { ok: true };
    if (/Telegram: ligado no config\.json, mas sem/.test(novo)) return { ok: false, erro: 'o porteiro subiu sem o Telegram (falta a conversa ou a chave do bot)' };
    if (/Telegram: a chave nao e do bot/.test(novo)) return { ok: false, erro: 'a chave guardada não é do bot do config: rode o passo telegram-chave de novo' };
    if (/Telegram: getMe falhou/.test(novo)) return { ok: false, erro: 'o Telegram não aceitou a chave do bot ou não respondeu' };
    if (/Telegram: desligado \(config/.test(novo)) return { ok: false, erro: 'o Telegram está desligado no config' };
    if (/sem canal ligado/.test(novo)) return { ok: false, erro: 'o porteiro não achou nenhum canal ligado (Telegram)' };
    await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(50, fim - Date.now()))));
  }
  const s = Math.round(prazoMs / 1000);
  return { ok: false, erro: subiu ? `o porteiro subiu, mas o Telegram não ligou em ${s} s` : `o porteiro não subiu em ${s} s` };
}

// 'parado' | 'nenhum ligado' | 'não consegui parar' (o `porteiro.mjs parar` diz "nenhum porteiro vivo" quando nao tinha)
function pararPorteiroReal(repo) {
  const r = spawnSync(process.execPath, [path.join(repo, 'porteiro.mjs'), 'parar'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (r.status !== 0) return 'não consegui parar';
  return /nenhum porteiro vivo/.test(String(r.stdout)) ? 'nenhum ligado' : 'parado';
}

function apagarVariavelReal(nome) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(nome)) return false;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `[Environment]::SetEnvironmentVariable('${nome}', $null, 'User')`], { windowsHide: true, timeout: 20000 });
  return r.status === 0;
}

// ---------- entrada ----------

/** Roda 1 passo: {codigo, saida}. `deps` troca o mundo de fora (teste); o que faltar e o real. */
export async function executar(argv, deps = {}) {
  const d = {
    env: process.env, fetch: globalThis.fetch, lerRegistro: lerRegistroReal, repo: REPO, agora: Date.now,
    plataforma: process.platform, release: os.release(), versaoNode: process.version, rodar: rodarReal,
    existe: fs.existsSync, abrirJanelaChave: abrirJanelaChaveReal, rodarVbs: rodarVbsReal,
    esperarSubida: esperarSubidaReal, apagarVariavel: apagarVariavelReal, lerCwds: (p) => lerCwdsReal(p),
    existePasta: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
    ...deps,
  };
  d.pararPorteiro ??= () => pararPorteiroReal(d.repo);
  const { passo, opcoes, erro } = lerArgs(argv);
  const comPasso = (r) => ({ codigo: r.codigo, saida: { passo: passo ?? null, ...r.saida } });
  if (!passo || passo === 'ajuda' || !PASSOS.includes(passo)) {
    return comPasso(uso(`passo ${passo ? `desconhecido: ${passo}` : 'faltando'}; os passos são: ${PASSOS.join(', ')}`));
  }
  if (erro) return comPasso(uso(erro));
  const P = pastasDe(d.env);
  try {
    switch (passo) {
      case 'checar': return comPasso(passoChecar(opcoes, d));
      case 'pastas': return comPasso(passoPastas(opcoes, d, P));
      case 'telegram-chave': return comPasso(await passoTelegramChave(opcoes, d, P));
      case 'telegram-chat': return comPasso(await passoTelegramChat(opcoes, d, P));
      case 'config': return comPasso(passoConfig(opcoes, d, P));
      case 'hooks': return comPasso(passoHooks(opcoes, d, P));
      case 'inicializar': return comPasso(passoInicializar(opcoes, d, P));
      case 'claude-md': return comPasso(passoClaudeMd(opcoes, d, P));
      case 'ligar': return comPasso(await passoLigar(opcoes, d, P));
      case 'cartao': return comPasso(passoCartao(opcoes, d, P));
      case 'desinstalar': return comPasso(await passoDesinstalar(opcoes, d, P));
      default: return comPasso(uso(`passo desconhecido: ${passo}`));
    }
  } catch (e) {
    return comPasso(falha(`erro inesperado no passo ${passo}: ${e?.code || e?.name || 'erro'}`));
  }
}

const ehPrincipal = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (ehPrincipal) {
  const r = await executar(process.argv.slice(2));
  process.stdout.write(JSON.stringify(r.saida, null, 2) + '\n');
  process.exitCode = r.codigo;
}
