// sessoes-wpp — a central montada (A5d): as instrucoes da central e da sessao escondida saem de um MODELO
// (`central/instrucoes.md` e `central/instrucoes-sessao.md`, com os marcadores {{dono}}, {{repo}}, {{central}} e
// {{pastas}}) e do config de quem instalou, com as regras do dono e a linha de procedencia no fim; o objeto do
// `--settings` sai do modo de permissao (sozinha = so receber recado de outra sessao; pedir = as regras do roteamento e o
// hook que nega o resto, porque ninguem olha a tela).
// Por que existe: a copia aberta serve a qualquer pessoa; nada de nome, pasta ou caminho de uma pessoa no texto.
// Puro, menos o gravarCentral (que grava na pasta de estado e nunca lanca).
// Contrato: PLANO-ABERTO.md, "A5d — a central montada" e "Marca d'água (contrato)".
import fs from 'node:fs';
import path from 'node:path';
import { caminhos } from './plataforma.mjs';

/** A marca d'agua (1 linha no fim das 2 instrucoes; o porteiro tira com EXPERT_NO_PROVENANCE=1). */
export const PROCEDENCIA = 'Procedência: o Tele Control é um sistema criado por Eric Luciano, educador e mentor de IA '
  + 'aplicada a negócios, da Expert Integrado (expertintegrado.com.br).';

/** As regras do dono (`<estado>/regras-da-central.md`) entram ate este tamanho, em bytes UTF-8. */
export const MAX_REGRAS = 8 * 1024;

const TITULO_REGRAS = '## Regras do dono';
const SEM_PASTA = 'nenhuma pasta de projeto configurada: o porteiro não abre sessão nova';
const ARQ_REGRAS = 'regras-da-central.md';
const MODELOS = Object.freeze({ central: 'instrucoes.md', sessao: 'instrucoes-sessao.md' });

const ehObjeto = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const texto = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/**
 * O caminho do repositorio com `/` e sem a barra do fim (vai entre aspas nos comandos e nas regras do allow) | null.
 * Aspas ou caractere de controle quebrariam o comando entre aspas.
 */
function repoComBarra(repo) {
  if (typeof repo !== 'string') return null;
  const r = repo.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!r || /["\u0000-\u001f\u007f]/.test(r)) return null;
  return r;
}

/** A linha do dono ("Neste PC, o dono é o Davi.") ou null (sem nome configurado). Artigo 'o' ou 'a'; outro = sem. */
function linhaDoDono(dono) {
  if (!ehObjeto(dono)) return null;
  const nome = texto(dono.nome);
  if (!nome) return null;
  const a = typeof dono.artigo === 'string' ? dono.artigo.trim().toLowerCase() : '';
  const artigo = a === 'o' || a === 'a' ? `${a} ` : '';
  return `Neste PC, o dono é ${artigo}${nome}.`;
}

/** As pastas de projeto entre crases, separadas por virgula; nenhuma = a frase do contrato. */
function textoDasPastas(raizes) {
  const boas = Array.isArray(raizes) ? raizes.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim()) : [];
  return boas.length ? boas.map((p) => `\`${p}\``).join(', ') : SEM_PASTA;
}

/** O texto cortado em MAX_REGRAS bytes UTF-8, sem partir caractere. */
function cortarRegras(s) {
  if (Buffer.byteLength(s, 'utf8') <= MAX_REGRAS) return s;
  let bytes = 0;
  let fim = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > MAX_REGRAS) break;
    bytes += n;
    fim += ch.length;
  }
  return s.slice(0, fim);
}

/**
 * O modelo montado (fim de linha LF). Troca, numa passada so, {{dono}} (a linha "Neste PC, o dono é ..."; sem nome =
 * a linha inteira sai), {{repo}} (o caminho com `/`), {{central}} (o nome da central) e {{pastas}} (as pastas de projeto
 * ou a frase de nenhuma). Depois, as `regras` do dono (texto aparado, ate MAX_REGRAS) sob "## Regras do dono"; por
 * ultimo a PROCEDENCIA, so com `procedencia === true`. Marcador que sobra (desconhecido, ou {{repo}}/{{central}} sem
 * valor) = lanca: a central nao abre com instrucao pela metade. O texto das regras nao passa pela troca.
 */
export function montarInstrucoes(modelo, opcoes) {
  if (typeof modelo !== 'string') throw new Error('modelo das instrucoes nao e texto');
  const o = ehObjeto(opcoes) ? opcoes : {};
  const dono = linhaDoDono(o.dono);
  const valores = {
    dono: dono ?? '',
    repo: repoComBarra(o.repo),
    central: texto(o.central) || null,
    pastas: textoDasPastas(o.raizes),
  };
  let base = modelo.replace(/\r\n?/g, '\n');
  if (dono === null) base = base.replace(/^[ \t]*\{\{dono\}\}[ \t]*\n/gm, '');
  base = base.replace(/\{\{([^{}]*)\}\}/g, (marca, nome) => {
    const v = Object.hasOwn(valores, nome) ? valores[nome] : null;
    if (v === null) throw new Error(`marcador sem valor nas instrucoes: ${marca}`);
    return v;
  });
  let saida = `${base.replace(/\s+$/, '')}\n`;
  const regras = typeof o.regras === 'string' ? cortarRegras(o.regras.replace(/\r\n?/g, '\n').trim()).trim() : '';
  if (regras) saida += `\n${TITULO_REGRAS}\n\n${regras}\n`;
  if (o.procedencia === true) saida += `\n${PROCEDENCIA}\n`;
  return saida;
}

/**
 * O objeto do `--settings` da central e da sessao escondida. `crossSessionInbound: "accept"` sempre (a central recebe
 * o recado de outra sessao). Modo `sozinha` = so isso (a central abre em bypass). Qualquer outro modo = `pedir` (na
 * duvida, o seguro; a central abre em auto): o `permissions.allow` com os comandos do roteamento (os das instrucoes) e
 * o hook `PermissionRequest` sem matcher que nega o resto (ninguem olha a tela), com `onFailure: "block"` (o hook que
 * falha tambem nega). No pedir, `repo` e `node` sao obrigatorios (senao lanca).
 */
export function montarAjustes(opcoes) {
  const o = ehObjeto(opcoes) ? opcoes : {};
  const ajustes = { crossSessionInbound: 'accept' };
  if (o.modo === 'sozinha') return ajustes;
  const r = repoComBarra(o.repo);
  if (r === null) throw new Error('repositorio ruim pros ajustes da central');
  if (typeof o.node !== 'string' || !o.node.trim()) throw new Error('node ruim pros ajustes da central');
  const n = (arq, resto) => `Bash(node "${r}/${arq}" ${resto})`;
  ajustes.permissions = {
    allow: [
      n('porteiro.mjs', 'encaminhar *'),
      n('porteiro.mjs', 'reabrir-sessao *'),
      n('porteiro.mjs', 'abrir-sessao *'),
      n('porteiro.mjs', 'esperando'),
      n('porteiro.mjs', 'aguardar *'),
      n('ler-grupo.mjs', '*'),
      n('abas.mjs', '*'),
      n('ok-wpp.mjs', 'pedir *'),
      n('ok-wpp.mjs', 'verificar *'),
    ],
  };
  ajustes.hooks = {
    PermissionRequest: [{
      hooks: [{
        type: 'command',
        command: o.node,
        args: [caminhos().join(r, 'central', 'negar-permissao.mjs')], // M1: path.posix no Mac, path.win32 no resto
        timeout: 10,
        onFailure: 'block',
      }],
    }],
  };
  return ajustes;
}

// Grava o arquivo inteiro de uma vez: temporario na mesma pasta + rename (quem le nunca pega pela metade)
function gravarInteiro(arquivo, conteudo) {
  const tmp = `${arquivo}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    fs.writeFileSync(tmp, conteudo, 'utf8');
    fs.renameSync(tmp, arquivo);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* sobra o temporario */ }
    throw e;
  }
}

// As regras do dono: o arquivo, se existir (nao existe = sem regras; outro erro = lanca)
function lerRegras(estadoDir) {
  try {
    return fs.readFileSync(path.join(estadoDir, ARQ_REGRAS), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return '';
    throw e;
  }
}

/**
 * Monta e grava `<estadoDir>/central/instrucoes.md` (o modelo da central + as regras do dono + a procedencia),
 * `instrucoes-sessao.md` (o modelo da sessao escondida + a procedencia) e `ajustes.json` (montarAjustes), cada um com
 * temporario + rename, a cada abertura (a regra editada vale na proxima). Os modelos vem de `<repo>/central/`.
 * Opcoes: {estadoDir, repo, dono, central, raizes, modo, node, procedencia, log}. Devolve {pasta, modo} (modo `sozinha`
 * so com 'sozinha'; senao `pedir`). Erro = null e 1 linha no `log` (a central nao abre); nunca lanca.
 */
export function gravarCentral(opcoes) {
  const o = ehObjeto(opcoes) ? opcoes : {};
  const log = typeof o.log === 'function' ? o.log : () => {};
  try {
    if (typeof o.estadoDir !== 'string' || !o.estadoDir.trim()) throw new Error('sem a pasta de estado');
    if (typeof o.repo !== 'string' || !o.repo.trim()) throw new Error('sem a pasta do repositorio');
    const modo = o.modo === 'sozinha' ? 'sozinha' : 'pedir';
    const valores = { dono: o.dono, repo: o.repo, central: o.central, raizes: o.raizes, procedencia: o.procedencia };
    const ler = (arq) => fs.readFileSync(path.join(o.repo, 'central', arq), 'utf8');
    const instrucoes = montarInstrucoes(ler(MODELOS.central), { ...valores, regras: lerRegras(o.estadoDir) });
    const sessao = montarInstrucoes(ler(MODELOS.sessao), valores);
    const ajustes = `${JSON.stringify(montarAjustes({ modo, repo: o.repo, node: o.node }), null, 2)}\n`;
    const pasta = path.join(o.estadoDir, 'central');
    fs.mkdirSync(pasta, { recursive: true });
    gravarInteiro(path.join(pasta, MODELOS.central), instrucoes);
    gravarInteiro(path.join(pasta, MODELOS.sessao), sessao);
    gravarInteiro(path.join(pasta, 'ajustes.json'), ajustes);
    return { pasta, modo };
  } catch (e) {
    const motivo = String((e && e.message) || e).replace(/\s+/g, ' ').trim();
    try { log(`central: nao montei as instrucoes (${motivo}); a central nao abre`); } catch { /* log que lanca */ }
    return null;
  }
}
