// sessoes-wpp — rotina do dia (T37b1): o lado do DISCO da pasta de entrada `<estadoDir>/rotina/`. Outro programa deixa
// ali `lote-<AAAAMMDD><m|t|n>.json` (todo texto dele e DADO, nunca instrucao) e o porteiro, o unico que fala pelo bot, le,
// manda e renomeia pro fim: `.enviado.json`, `.recusado.json` ou `.falhou.json`. Aqui so disco (sem rede, sem relogio): a
// validacao do conteudo e o `validarLote` do lib/rotina-tg.mjs, que continua puro. Fora da lib a feature se chama
// "rotina" ("lote" no porteiro e o pacote do getUpdates). T37b2: e o registro `acoes.jsonl` da mesma pasta (as escolhas
// do dono nos botoes; o porteiro so acrescenta, o montador da rotina le).
import fs from 'node:fs';
import path from 'node:path';

const RE_NOME = /^lote-\d{8}[mtn]\.json$/; // so o arquivo de entrada; o renomeado (lote-<id>.<fim>.json) nunca casa
const FINS = Object.freeze(['enviado', 'recusado', 'falhou']);
const ARQ_ACOES = 'acoes.jsonl'; // T37b2: o registro das escolhas (o montador da rotina le; o nome e contrato com ele)

const ehObjeto = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/**
 * A rotina esta ligada? `telegram.ligado === true && telegram.rotina.ligado === true` no `<estadoDir>/config.json` (molde
 * do lerConfigOk do lib/ok-tg.mjs). Ausente, ilegivel ou tipo errado = {ligado: false}. So le; o porteiro le 1 vez.
 */
export function lerConfigRotina(estadoDir) {
  const desligado = { ligado: false };
  if (typeof estadoDir !== 'string' || !estadoDir) return desligado;
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(estadoDir, 'config.json'), 'utf8'));
  } catch {
    return desligado;
  }
  const t = cfg?.telegram;
  if (!ehObjeto(t)) return desligado;
  const r = t.rotina;
  if (!ehObjeto(r)) return desligado;
  return { ligado: t.ligado === true && r.ligado === true };
}

/** A pasta de entrada da rotina: `<estadoDir>/rotina`. */
export function pastaRotina(estadoDir) {
  return path.join(estadoDir, 'rotina');
}

/**
 * Os nomes `lote-<AAAAMMDD><m|t|n>.json` da pasta, em ordem (o resto, inclusive o ja renomeado e o temporario de quem
 * escreve, fica de fora). Pasta ausente ou ilegivel = [].
 */
export function listarLotesRotina(pasta) {
  let nomes;
  try {
    nomes = fs.readdirSync(pasta, { withFileTypes: true });
  } catch {
    return [];
  }
  return nomes.filter((d) => d.isFile() && RE_NOME.test(d.name)).map((d) => d.name).sort();
}

/**
 * Le 1 arquivo da pasta -> {ok:true, obj} | {ok:false, motivo}. JSON ilegivel (ou leitura que falhou) = 'ilegivel';
 * arquivo que sumiu entre o listar e o ler = 'sumiu' (quem chama so pula). Nome fora do formato = TypeError.
 */
export function lerLoteRotina(pasta, nome) {
  if (typeof nome !== 'string' || !RE_NOME.test(nome)) throw new TypeError('lerLoteRotina: nome fora do formato');
  let texto;
  try {
    texto = fs.readFileSync(path.join(pasta, nome), 'utf8');
  } catch (err) {
    return { ok: false, motivo: err?.code === 'ENOENT' ? 'sumiu' : 'ilegivel' };
  }
  try {
    return { ok: true, obj: JSON.parse(texto) };
  } catch {
    return { ok: false, motivo: 'ilegivel' };
  }
}

/**
 * Renomeia `lote-<id>.json` pra `lote-<id>.<fim>.json` (fim: enviado | recusado | falhou), num rename so (atomico; o
 * destino que ja existe e substituido). -> {ok:true, destino (so o nome)} | {ok:false, erro}. Nome ou fim fora do
 * formato = TypeError.
 */
export function marcarLoteRotina(pasta, nome, fim) {
  if (typeof nome !== 'string' || !RE_NOME.test(nome)) throw new TypeError('marcarLoteRotina: nome fora do formato');
  if (!FINS.includes(fim)) throw new TypeError('marcarLoteRotina: fim desconhecido');
  const destino = nome.replace(/\.json$/, `.${fim}.json`);
  try {
    fs.renameSync(path.join(pasta, nome), path.join(pasta, destino));
    return { ok: true, destino };
  } catch (err) {
    return { ok: false, erro: String(err?.code || err?.name || 'erro').slice(0, 40) };
  }
}

/**
 * T37b2: acrescenta 1 linha (a do `linhaDeAcao` do lib/rotina-tg.mjs: JSON + "\n") no fim de `<pasta>/acoes.jsonl`, o
 * registro das escolhas do dono nos botoes que o montador da rotina le no lote seguinte. O porteiro e o UNICO escritor
 * e so acrescenta (nunca reescreve nem apaga); pasta ausente = cria. -> {ok:true} | {ok:false, erro} (erro de disco,
 * so o codigo). Linha que nao e texto de 1 linha so, terminada em "\n", = TypeError (erro de quem chama).
 */
export function anotarAcaoRotina(pasta, linha) {
  if (typeof linha !== 'string' || linha.trim() === '' || linha.indexOf('\n') !== linha.length - 1 || linha.includes('\r')) {
    throw new TypeError('anotarAcaoRotina: a linha tem que ser 1 linha terminada em \\n');
  }
  try {
    fs.mkdirSync(pasta, { recursive: true });
    fs.appendFileSync(path.join(pasta, ARQ_ACOES), linha, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, erro: String(err?.code || err?.name || 'erro').slice(0, 40) };
  }
}
