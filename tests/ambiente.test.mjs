// lib/ambiente.mjs: o porteiro nunca roda com o ambiente da sessao do Claude que o religou (incidente 11/10/2026: a
// sessao do Claude Desktop poe CLAUDE_CODE_HARBOR_KITE=0, que desliga o recado entre sessoes em todo claude filho).
import test from 'node:test';
import assert from 'node:assert/strict';
import { variaveisDeSessao, limparAmbienteDeSessao, nomesDoReg } from '../lib/ambiente.mjs';

// O que a sessao do Claude Desktop pos no Bash dela em 11/10/2026 (nomes reais; valores de mentira).
const DESKTOP = {
  CLAUDECODE: '1', CLAUDE_CODE_HARBOR_KITE: '0', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', CLAUDE_CODE_SESSION_ID: 'x',
  CLAUDE_CODE_ACCOUNT_UUID: 'y', CLAUDE_CODE_USER_EMAIL: 'z@exemplo', CLAUDE_CODE_ORGANIZATION_UUID: 'w',
  CLAUDE_CODE_OAUTH_SCOPES: 'user:inference', CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1', CLAUDE_PID: '1',
  CLAUDE_EFFORT: 'xhigh', CLAUDE_AGENT_SDK_VERSION: '0.3', CLAUDE_PLUGIN_DATA: 'p', CLAUDE_PREVIEW_CLASSIFIER_FLOOR: '1',
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128000', ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
  CODEX_COMPANION_SESSION_ID: 's', MCP_CONNECTION_NONBLOCKING: 'true', MCP_SERVER_CONNECTION_BATCH_SIZE: '8',
};
const LOGIN = { PATH: 'C:\\Windows', USERPROFILE: 'C:\\Users\\eu', SESSOES_WPP_TELEGRAM_TOKEN: 'segredo', SESSOES_WPP_DIR: 'd' };

test('variaveisDeSessao: pega toda variavel de sessao do Claude (inclusive as que o Desktop inventou) e deixa o resto', () => {
  const nomes = variaveisDeSessao({ ...LOGIN, ...DESKTOP });
  assert.deepEqual(nomes.sort(), Object.keys(DESKTOP).sort());
});

test('variaveisDeSessao: variavel que o usuario tem no registro (User ou Machine) fica, sem diferenca de maiuscula', () => {
  const nomes = variaveisDeSessao({ ...LOGIN, ...DESKTOP }, new Set(['claude_code_max_output_tokens']));
  assert.ok(!nomes.includes('CLAUDE_CODE_MAX_OUTPUT_TOKENS'));
  assert.ok(nomes.includes('CLAUDE_CODE_HARBOR_KITE'));
});

test('variaveisDeSessao: os dubles do proprio sessoes-wpp (CLAUDE_BIN, CLAUDE_SESSIONS_DIR, CLAUDE_PROJECTS_DIR) ficam', () => {
  const env = { CLAUDE_BIN: 'b', CLAUDE_SESSIONS_DIR: 's', CLAUDE_PROJECTS_DIR: 'p', CLAUDECODE: '1' };
  assert.deepEqual(variaveisDeSessao(env), ['CLAUDECODE']);
});

test('variaveisDeSessao: ambiente de login = nada a tirar', () => {
  assert.deepEqual(variaveisDeSessao(LOGIN), []);
});

test('limparAmbienteDeSessao: tira do proprio objeto e devolve os NOMES (nunca o valor)', () => {
  const env = { ...LOGIN, ...DESKTOP };
  const tiradas = limparAmbienteDeSessao(env, new Set(['CLAUDE_CODE_MAX_OUTPUT_TOKENS']));
  assert.equal(env.CLAUDE_CODE_HARBOR_KITE, undefined);
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '128000');
  assert.equal(env.SESSOES_WPP_TELEGRAM_TOKEN, 'segredo');
  assert.ok(tiradas.includes('CLAUDE_CODE_HARBOR_KITE'));
  assert.ok(tiradas.every((n) => !n.includes('=')));
});

test('nomesDoReg: le os nomes da saida do reg query (REG_SZ e REG_EXPAND_SZ), em maiuscula', () => {
  const saida = [
    '',
    'HKEY_CURRENT_USER\\Environment',
    '    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin',
    '    CLAUDE_CODE_MAX_OUTPUT_TOKENS    REG_SZ    64000',
    '    SESSOES_WPP_TELEGRAM_TOKEN    REG_SZ    x',
    '',
  ].join('\r\n');
  assert.deepEqual([...nomesDoReg(saida)].sort(), ['CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'PATH', 'SESSOES_WPP_TELEGRAM_TOKEN']);
  assert.deepEqual([...nomesDoReg('')], []);
  assert.deepEqual([...nomesDoReg(null)], []);
});
