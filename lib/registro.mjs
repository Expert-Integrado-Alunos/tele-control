// sessoes-wpp — leitura de variavel do usuario no registro do Windows (HKCU\Environment) e a chave do bot.
// Por que existe: o porteiro e o ok-wpp (T7b1b, o OK pelo botao no chat do bot) precisam da MESMA chave pela MESMA
// regra, e o ok-wpp nao pode importar o porteiro. Saiu do porteiro.mjs na T7b1a (o porteiro reexporta valorDoReg e
// chaveTelegram). Processo nascido antes do setx nao ve o user env: por isso o registro. O valor nunca vai pro log.
import { execFile } from 'node:child_process';
import { PADRAO_TG, RE_VAR_CHAVE } from './config.mjs';

const escaparRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A5a: sem nome padrao; nome bom = texto que nao e vazio nem so espaco (quem chama ja conferiu o formato)
const nomeBom = (nome) => typeof nome === 'string' && nome.trim() !== '';

/**
 * Valor da variavel `nome` na saida do `reg query HKCU\Environment /v <nome>`. Nao achou (ou sem nome bom) = null. T3a:
 * o mesmo serve pra chave do bot (a variavel do telegram.varChave); A5a: e pro portao do aviso (o saude.varUrl).
 */
export function valorDoReg(saida, nome) {
  if (!nomeBom(nome)) return null;
  const re = new RegExp(`^\\s*${escaparRe(nome)}\\s+REG_(?:EXPAND_)?SZ\\s+(.+?)\\s*$`, 'm');
  const m = re.exec(String(saida ?? ''));
  return m ? m[1] : null;
}

// Processo nascido antes do setx nao ve o user env: le o registro (como o gateway_url). Erro = null. O valor nunca vai
// pro log (a chave do bot e segredo). A5a: sem nome bom = null sem rodar o reg.
export function lerRegistroReal(nome) {
  if (!nomeBom(nome)) return Promise.resolve(null);
  return new Promise((resolver) => {
    execFile('reg', ['query', 'HKCU\\Environment', '/v', nome], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      resolver(err ? null : valorDoReg(stdout, nome));
    });
  });
}

/**
 * Chave do bot do Telegram: a variavel do telegram.varChave (`varChave`; sem ela, PADRAO_TG.varChave) do env (aparada)
 * ou, sem ela, do registro HKCU\Environment pelo MESMO nome (processo nascido antes do setx). Nenhuma = null. A1b1:
 * `varChave` fora do formato (RE_VAR_CHAVE, a regra do identidadeTelegram) = null sem ler o env nem chamar o registro.
 * `lerRegistro(nome)` injetavel (teste: duble). Nunca lanca.
 */
export async function chaveTelegram({ env = process.env, lerRegistro = lerRegistroReal, varChave = PADRAO_TG.varChave } = {}) {
  if (typeof varChave !== 'string' || !RE_VAR_CHAVE.test(varChave)) return null;
  const doEnv = typeof env?.[varChave] === 'string' ? env[varChave].trim() : '';
  if (doEnv) return doEnv;
  let doReg = null;
  try { doReg = await lerRegistro(varChave); } catch { doReg = null; }
  const v = typeof doReg === 'string' ? doReg.trim() : '';
  return v || null;
}
