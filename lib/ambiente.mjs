// sessoes-wpp — o porteiro nunca roda com o ambiente da sessao do Claude que o religou.
// Por que existe (caso real): o supervisor religou o porteiro pelo SessionStart de uma sessao do Claude
// Desktop, que poe CLAUDE_CODE_HARBOR_KITE=0 no ambiente dos filhos. Esse valor desliga o recado entre sessoes em todo
// `claude` filho (central sem messagingSocketPath, `claude -p` do mensageiro sem a ListAgents) e o Telegram parou de
// responder. A lista fixa de nomes (HERDADAS do mensageiro, Remove dos .vbs) nao pegou porque o Desktop inventa nomes
// novos (tambem a identidade de outra conta: CLAUDE_CODE_ACCOUNT_UUID, USER_EMAIL, ORGANIZATION_UUID). Aqui a regra e
// por PREFIXO, e o que o usuario definiu no registro (User ou Machine) fica: o ambiente volta a ser o do login.

// Prefixos que uma sessao do Claude (VS Code, terminal, Desktop) e o plugin do Codex poem no ambiente dos filhos.
export const PREFIXOS_SESSAO = ['CLAUDE', 'ANTHROPIC_', 'CODEX_COMPANION_', 'MCP_CONNECTION_', 'MCP_SERVER_CONNECTION_'];
// Dubles do proprio sessoes-wpp (teste e override documentado): nunca vem de sessao.
const DO_SESSOES_WPP = new Set(['CLAUDE_BIN', 'CLAUDE_SESSIONS_DIR', 'CLAUDE_PROJECTS_DIR']);

/**
 * Nomes de `env` que vieram da sessao do Claude: casam um PREFIXOS_SESSAO, nao sao do sessoes-wpp e nao estao em
 * `doRegistro` (Set de nomes do HKCU/HKLM Environment; comparacao sem maiuscula, como o Windows).
 */
export function variaveisDeSessao(env, doRegistro = new Set()) {
  const reg = new Set([...doRegistro].map((n) => String(n).toUpperCase()));
  return Object.keys(env || {}).filter((nome) => {
    const n = nome.toUpperCase();
    if (DO_SESSOES_WPP.has(n) || reg.has(n)) return false;
    return PREFIXOS_SESSAO.some((p) => n.startsWith(p));
  });
}

/** Tira de `env` (o proprio objeto; no porteiro, o process.env) e devolve so os NOMES tirados, nunca o valor. */
export function limparAmbienteDeSessao(env, doRegistro = new Set()) {
  const nomes = variaveisDeSessao(env, doRegistro);
  for (const n of nomes) delete env[n];
  return nomes;
}

/** Nomes (maiuscula) da saida do `reg query <chave>`; saida vazia ou nula = Set vazio. */
export function nomesDoReg(saida) {
  const out = new Set();
  for (const linha of String(saida ?? '').split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+REG_(?:EXPAND_)?SZ\b/.exec(linha);
    if (m) out.add(m[1].toUpperCase());
  }
  return out;
}

const CHAVES_REG = ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'];

/** Nomes das variaveis de ambiente do usuario e da maquina (registro). Erro numa chave = so a outra. Nunca lanca. */
export async function nomesDoRegistroReal(execFileFn) {
  const { execFile } = execFileFn ? { execFile: execFileFn } : await import('node:child_process');
  const lidas = await Promise.all(CHAVES_REG.map((chave) => new Promise((resolver) => {
    execFile('reg', ['query', chave], { windowsHide: true, timeout: 10000 }, (err, stdout) => resolver(err ? '' : stdout));
  })));
  const out = new Set();
  for (const s of lidas) for (const n of nomesDoReg(s)) out.add(n);
  return out;
}
