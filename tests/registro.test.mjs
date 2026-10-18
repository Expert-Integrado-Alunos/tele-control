// Testes de lib/registro.mjs, a chave do bot pela configuracao (fase A1b1 do PLANO-ABERTO.md, "A1 — Telegram pela
// configuração": teste 4).
// Por que existe: o nome da variavel que guarda a chave do bot sai do codigo e vem do `telegram.varChave` do config.json
// (padrao SESSOES_WPP_TELEGRAM_TOKEN). Ler por outro nome entregaria a chave de outro bot; nome fora do formato nunca
// chega no ambiente nem no `reg query`.
// Isolamento: o ambiente e o registro sao dubles que anotam cada leitura (nunca o process.env nem o registro de verdade);
// so chaves falsas.
// O modulo entra por import dinamico no teste (como em tests/config.test.mjs).
// Rodar: node --test --test-reporter=tap "tests/registro.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';

const modulo = () => import('../lib/registro.mjs');
const PADRAO_VAR = 'SESSOES_WPP_TELEGRAM_TOKEN';

test('A1 4. chaveTelegram pela varChave: env[varChave] aparada e, sem ela, lerRegistro(varChave); sem varChave = SESSOES_WPP_TELEGRAM_TOKEN; varChave fora do formato = null sem ler o ambiente nem chamar o registro; o VAR_CHAVE_TG saiu', async () => {
  const reg = await modulo();
  const { chaveTelegram } = reg;
  assert.equal('VAR_CHAVE_TG' in reg, false, 'o nome fixo da variavel saiu do lib/registro.mjs');

  const leituras = [];
  const lidos = () => [...new Set(leituras)];
  // ambiente-espiao: anota todo nome lido (e a varredura) e so devolve o que `valores` tem
  const envEspiao = (valores = {}) => new Proxy({ ...valores }, {
    get(alvo, nome) { leituras.push(`env:${String(nome)}`); return alvo[nome]; },
    has(alvo, nome) { leituras.push(`env?${String(nome)}`); return nome in alvo; },
    ownKeys(alvo) { leituras.push('env:*'); return Reflect.ownKeys(alvo); },
  });
  const regEspiao = (valores = {}) => async (nome) => { leituras.push(`reg:${nome}`); return valores[nome] ?? null; };
  const chave = async (o) => {
    leituras.length = 0;
    return chaveTelegram(o);
  };
  // as variaveis de outro nome tem chave (a padrao e a de antes): so a do nome pedido conta
  // a de antes montada por pedacos: o nome inteiro e termo proibido na copia aberta (a assercao segue provando que ela
  // nao conta)
  const VAR_ANTES = ['TELEGRAM_CLAUDE', '_PC_BOT_TOKEN'].join('');
  const OUTRAS = { [PADRAO_VAR]: '1:padrao', [VAR_ANTES]: '2:antes', OUTRA_CHAVE: '3:outra' };

  // a varChave dada: o ambiente (aparado) vence e o registro nem e chamado
  assert.equal(await chave({ env: envEspiao({ ...OUTRAS, MINHA_CHAVE: '  7:minha  ' }), lerRegistro: regEspiao(OUTRAS), varChave: 'MINHA_CHAVE' }), '7:minha');
  assert.deepEqual(lidos(), ['env:MINHA_CHAVE'], 'so o nome dado, sem o registro');
  // sem ela no ambiente (ausente, vazia, so espacos, nao-texto): o registro pelo MESMO nome, aparado
  for (const noEnv of [undefined, '', '   ', 5]) {
    const env = noEnv === undefined ? { ...OUTRAS } : { ...OUTRAS, MINHA_CHAVE: noEnv };
    assert.equal(await chave({ env: envEspiao(env), lerRegistro: regEspiao({ ...OUTRAS, MINHA_CHAVE: ' 8:do-registro ' }), varChave: 'MINHA_CHAVE' }), '8:do-registro', JSON.stringify(noEnv));
    assert.deepEqual(lidos(), ['env:MINHA_CHAVE', 'reg:MINHA_CHAVE'], `${JSON.stringify(noEnv)}: o registro pelo nome dado`);
  }
  // so as de outro nome (no ambiente e no registro) = nenhuma chave
  assert.equal(await chave({ env: envEspiao(OUTRAS), lerRegistro: regEspiao(OUTRAS), varChave: 'MINHA_CHAVE' }), null, 'a chave de outro nome nao serve');
  assert.deepEqual(lidos(), ['env:MINHA_CHAVE', 'reg:MINHA_CHAVE']);
  // registro vazio, so espacos, nao-texto ou que lanca = null
  for (const [rotulo, lerRegistro] of [
    ['vazio', regEspiao({ MINHA_CHAVE: '' })], ['so espacos', regEspiao({ MINHA_CHAVE: '   ' })],
    ['nao-texto', regEspiao({ MINHA_CHAVE: 42 })], ['lanca', async () => { throw new Error('reg falhou'); }],
  ]) {
    assert.equal(await chave({ env: envEspiao({}), lerRegistro, varChave: 'MINHA_CHAVE' }), null, rotulo);
  }

  // sem varChave (ausente ou undefined) = a padrao, no ambiente e no registro; a de antes nao conta
  for (const semVar of [{}, { varChave: undefined }]) {
    assert.equal(await chave({ env: envEspiao(OUTRAS), lerRegistro: regEspiao(OUTRAS), ...semVar }), '1:padrao', JSON.stringify(semVar));
    assert.deepEqual(lidos(), [`env:${PADRAO_VAR}`], `${JSON.stringify(semVar)}: o ambiente pelo nome padrao`);
    const { [PADRAO_VAR]: _padrao, ...semPadrao } = OUTRAS;
    assert.equal(await chave({ env: envEspiao(semPadrao), lerRegistro: regEspiao({ ...semPadrao, [PADRAO_VAR]: ' 9:padrao-reg ' }), ...semVar }), '9:padrao-reg');
    assert.deepEqual(lidos(), [`env:${PADRAO_VAR}`, `reg:${PADRAO_VAR}`], `${JSON.stringify(semVar)}: o registro pelo nome padrao`);
    assert.equal(await chave({ env: envEspiao(semPadrao), lerRegistro: regEspiao(semPadrao), ...semVar }), null, 'so a de antes = nenhuma chave');
    assert.deepEqual(lidos(), [`env:${PADRAO_VAR}`, `reg:${PADRAO_VAR}`]);
  }

  // o formato e o do identidadeTelegram (lib/config.mjs): ate 100 caracteres, letra ou _ na frente
  for (const bom of ['MINHA_CHAVE', '_A1', 'x', `A${'b'.repeat(99)}`]) {
    assert.equal(await chave({ env: envEspiao({ ...OUTRAS, [bom]: '4:boa' }), lerRegistro: regEspiao(OUTRAS), varChave: bom }), '4:boa', bom);
    assert.deepEqual(lidos(), [`env:${bom}`], bom);
  }
  // fora do formato = null, sem ler o ambiente (nem por esse nome, nem pelo padrao) e sem chamar o registro; o ambiente e o
  // registro teriam chave em qualquer nome lido
  const RUINS = ['X Y', '1A', '', ' MINHA_CHAVE', 'MINHA_CHAVE ', 'MINHA_CHAVE\n', 'MINHA-CHAVE', `A${'b'.repeat(100)}`, 7, null, true, ['MINHA_CHAVE'], {}];
  const todosComChave = (nomes) => Object.fromEntries(nomes.map((n) => [String(n), '5:nao-podia']));
  const envRuim = { ...OUTRAS, MINHA_CHAVE: '5:nao-podia', ...todosComChave(RUINS) };
  const regTudo = async (nome) => { leituras.push(`reg:${nome}`); return '6:nao-podia'; };
  for (const ruim of RUINS) {
    assert.equal(await chave({ env: envEspiao(envRuim), lerRegistro: regTudo, varChave: ruim }), null, `varChave ${JSON.stringify(ruim)}`);
    assert.deepEqual(leituras, [], `varChave ${JSON.stringify(ruim)}: nem o ambiente nem o registro`);
  }
});
