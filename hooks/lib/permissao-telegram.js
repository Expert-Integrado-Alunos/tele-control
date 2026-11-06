'use strict';
/*
 * permissao-telegram — o pedido de permissao do app ("Permitir uma vez") repassado pro Telegram com Sim e Nao.
 *
 * Por que existe (06/11/2026): a aba do Claude Desktop ficou 6 h parada num pedido de permissao do proprio app
 * (abrir sessao nova) com o dono na rua, e nada chegou no Telegram. Caso real: "aquela opcao de permitir uma vez ... nao
 * apareceu isso pra mim la no Telegram e deveria aparecer de forma que eu conseguisse fazer tudo por la".
 *
 * Quem chama: o hook PermissionRequest do ambiente do dono (as travas globais carregam este arquivo pela tomada; sem este
 * repositorio na maquina, nada muda). O hook roda JUNTO com a janela do app: quem responde primeiro vale. Responder na
 * tela encerra o hook; o sinal de encerramento cancela o pedido (motivo na-tela) e a mensagem some do chat.
 *
 * Fluxo: (1) disponivel() confere tudo sem efeito (Telegram e OK ligados, porteiro vivo, sessao interativa, sem trava);
 * (2) repassar() espera 45 s (o dono pode estar no computador; com o modo rua ligado ou na sessao escondida, na hora),
 * pede pelo `ok-wpp pedir --tipo permissao` (so Telegram, validade curta), espera o toque anotado pelo porteiro no
 * estado.json e confere pelo `ok-wpp verificar` (a prova do toque continua relida no servidor do Telegram: arquivo e
 * estado so apontam, nunca concedem). Sim conferido = allow; Nao = deny; ninguem no prazo = cancela (sem-resposta) e deny.
 * Qualquer falha antes do pedido sair = null (quem chama segue o caminho de antes).
 *
 * Respondido na tela: o app do Claude Desktop NAO encerra o hook quando a janela e respondida (medido 06/11/2026: a
 * ferramenta rodou 1 s depois do pedido sair e o hook seguiu vivo esperando o Telegram). Quem avisa e a conversa: a
 * chamada da ferramenta (tool_use, achada pelo nome e pela entrada no fim do transcript) ganha resultado (tool_result)
 * = a tela respondeu. Na espera dos 45 s isso para tudo (nada vai pro Telegram); com o pedido no ar, cancela (na-tela) e a
 * mensagem some do chat. O sinal de encerramento continua valendo (o terminal e o VS Code podem encerrar o hook).
 *
 * O texto do pedido (o que a ferramenta quer fazer) sai mascarado: senha, chave e sequencia com cara de chave viram ***.
 * Log sem o texto da acao. Nunca lanca pra fora (falha = null).
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const lib = require('./sessoes-wpp.js');

const RAIZ = path.resolve(__dirname, '..', '..');
const OK_WPP = path.join(RAIZ, 'ok-wpp.mjs');
const NOME = 'permissao-telegram';

// Ferramentas que tem caminho proprio (a pergunta vai pelo pergunta-modo-rua; o plano e decisao de quem esta na tela)
const FORA = new Set(['AskUserQuestion', 'ExitPlanMode']);
const ATRASO_MS = 45 * 1000; // o dono pode estar no computador: responde la e nada vai pro Telegram
const TETO_MS = 640 * 1000; // o timeout do hook na policy e 660 s: decide antes
const VALIDADE_MAX_MIN = 10;
const POLL_MS = 1500;
const DE_NOVO_MS = 3000; // verificar pendente (Telegram ocupado): tenta de novo
const PORTEIRO_FRESCO_MS = 60 * 1000; // o mesmo do ok-wpp: o Sim so vale com o porteiro vivo
const FOLGA_RELOGIO_MS = 5 * 1000;
const MAX_ACAO = 700;
const ESPERA_OK_WPP_MS = 45 * 1000;
const RE_SESSAO = /^[A-Za-z0-9_-]{1,100}$/;
const RE_CODIGO = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/; // o ALFABETO do ok-wpp
const CAUDA_TELA = 512 * 1024; // a chamada acabou de ser gravada: o fim do transcript basta

// Motivos padrao (sem nome de ninguem: quem chama pode trocar pelo texto do dono)
const MOTIVO = Object.freeze({
  nao: 'A pessoa negou esta ação pelo Telegram. Não repita: siga sem ela e registre o que queria fazer.',
  semResposta: 'Ninguém respondeu este pedido de permissão em 10 minutos (nem na tela, nem no Telegram). Não repita: deixe na lista da volta e siga com o resto.',
  trava: 'O controle pelo Telegram está travado pela pessoa. Não repita: deixe na lista da volta e siga com o resto.',
});

function lerJson(arq) {
  try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch (_) { return null; }
}
const ehObjeto = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

function pidVivo(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return Boolean(err) && err.code === 'EPERM'; }
}

// Porteiro vivo = pid do porteiro.lock vivo E estado.json gravado ha no maximo 60 s (a regra do verificar pro Sim)
function porteiroVivo(estadoDir, agoraMs) {
  let pid;
  try { pid = Number.parseInt(fs.readFileSync(path.join(estadoDir, 'porteiro.lock'), 'utf8').trim(), 10); } catch (_) { return false; }
  if (!pidVivo(pid)) return false;
  let gravado;
  try { gravado = fs.statSync(path.join(estadoDir, 'estado.json')).mtimeMs; } catch (_) { return false; }
  const idade = agoraMs - gravado;
  return Number.isFinite(idade) && idade >= -FOLGA_RELOGIO_MS && idade <= PORTEIRO_FRESCO_MS;
}

// O config pede o repasse: Telegram e OK pelo Telegram ligados, chat do dono e a chave de volta (telegram.ok.permissao false)
function configLiga(estadoDir) {
  const cfg = lerJson(path.join(estadoDir, 'config.json'));
  const t = ehObjeto(cfg) && ehObjeto(cfg.telegram) ? cfg.telegram : null;
  if (!t || t.ligado !== true || !ehObjeto(t.ok) || t.ok.ligado !== true) return 'OK pelo Telegram desligado';
  if (!(Number.isSafeInteger(t.chatId) && t.chatId > 0)) return 'sem o chat do dono no config';
  if (t.ok.permissao === false) return 'repasse de permissao desligado no config';
  return null;
}

/**
 * O pedido pode ir pro Telegram? {ok: true} | {ok: false, motivo}. Sem efeito: so le. So o fio principal (sem agent_id),
 * ferramenta fora da pergunta e do plano, sessao interativa com registro, Telegram ligado, porteiro vivo e sem trava.
 */
function disponivel(entrada, { env = process.env, agora = Date.now } = {}) {
  const nao = (motivo) => ({ ok: false, motivo });
  try {
    if (!ehObjeto(entrada)) return nao('entrada ilegivel');
    if (entrada.hook_event_name !== 'PermissionRequest') return nao('nao e pedido de permissao');
    if (entrada.agent_id !== undefined && entrada.agent_id !== null && String(entrada.agent_id).trim() !== '') return nao('ajudante');
    const ferramenta = typeof entrada.tool_name === 'string' ? entrada.tool_name : '';
    if (!ferramenta || FORA.has(ferramenta)) return nao('ferramenta com caminho proprio');
    if (typeof entrada.session_id !== 'string' || !RE_SESSAO.test(entrada.session_id)) return nao('sem sessao');
    if (env.SESSOES_WPP_PERMISSAO_TG === '0') return nao('desligado pelo ambiente');
    const c = lib.caminhos(env);
    const semConfig = configLiga(c.estadoDir);
    if (semConfig) return nao(semConfig);
    const estado = lerJson(path.join(c.estadoDir, 'estado.json'));
    if (!ehObjeto(estado)) return nao('estado do porteiro ilegivel');
    if (estado.trava === true) return nao('travado pelo dono');
    if (!porteiroVivo(c.estadoDir, agora())) return nao('porteiro parado');
    if (!lib.ehInterativa(lib.acharRegistro(entrada.session_id, c.sessionsDir))) return nao('sessao nao interativa');
    return { ok: true };
  } catch (err) {
    return nao(`erro: ${String((err && err.message) || err).slice(0, 80)}`);
  }
}

// ---------- o texto do pedido ----------

// Mascara o que tem cara de segredo (o mesmo criterio do resumo da trava de permissao do ambiente do dono)
function mascarar(s) {
  return String(s == null ? '' : s)
    .replace(/(:\/\/[^\s:@/]{1,100}:)[^\s@/]{1,200}@/g, '$1***@')
    .replace(/((?:--?(?:password|passwd|token|secret|api[-_]?key)|\b[A-Za-z0-9_]{0,40}(?:PASSWORD|PASSWD|TOKEN|SECRET|_KEY))[= ])\S{1,400}/gi, '$1***')
    .replace(/\b(Bearer|Basic) \S{1,400}/gi, '$1 ***')
    .replace(/[A-Za-z0-9_\-+=]{32,}/g, '***');
}

function cortar(s, max) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  const pts = Array.from(t);
  if (pts.length <= max) return t;
  const corte = pts.slice(0, max - 1).join('');
  const espaco = corte.lastIndexOf(' ');
  return `${espaco > max * 0.6 ? corte.slice(0, espaco) : corte}…`;
}

const texto = (x) => (typeof x === 'string' && x.trim() ? x.trim() : '');

// mcp__servidor__ferramenta -> "ferramenta (servidor)"
function nomeLegivel(ferramenta) {
  const m = /^mcp__(.+?)__(.+)$/.exec(ferramenta);
  return m ? `${m[2]} (${m[1]})` : ferramenta;
}

/** O texto do pedido no Telegram: o que a ferramenta quer fazer, mascarado e em ate 700 caracteres. */
function descrever(ferramenta, input) {
  const i = ehObjeto(input) ? input : {};
  let frase;
  if (ferramenta === 'Bash') {
    frase = `rodar no terminal: ${texto(i.command) || '(sem comando)'}${texto(i.description) ? ` (${texto(i.description)})` : ''}`;
  } else if (/__start_session$/.test(ferramenta)) {
    frase = `abrir uma sessão nova${texto(i.title) ? `: ${texto(i.title)}` : ''}`;
  } else if (/__preview_start$/.test(ferramenta)) {
    const alvo = texto(i.url) || texto(i.name);
    frase = `abrir o navegador do app${alvo ? ` em ${alvo}` : ''}`;
  } else if (/__run_in_terminal$/.test(ferramenta)) {
    frase = `rodar no terminal do app: ${texto(i.command) || '(sem comando)'}`;
  } else if (ferramenta === 'Write' || ferramenta === 'Edit' || ferramenta === 'NotebookEdit') {
    frase = `${ferramenta === 'Write' ? 'gravar' : 'editar'} o arquivo ${texto(i.file_path) || texto(i.notebook_path) || '(sem caminho)'}`;
  } else if (ferramenta === 'WebFetch') {
    frase = `abrir a página ${texto(i.url) || '(sem endereço)'}`;
  } else {
    let resto = '';
    try { resto = JSON.stringify(i); } catch (_) { resto = ''; }
    frase = `usar ${nomeLegivel(String(ferramenta || '')) || 'uma ferramenta'}${resto && resto !== '{}' ? `: ${resto}` : ''}`;
  }
  return cortar(`A aba quer ${mascarar(frase)}`, MAX_ACAO);
}

// ---------- a tela respondeu? (o transcript da conversa) ----------

// JSON com as chaves em ordem (a entrada da ferramenta no transcript e no hook podem vir em ordens diferentes)
function canonico(x) {
  if (Array.isArray(x)) return `[${x.map(canonico).join(',')}]`;
  if (ehObjeto(x)) return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canonico(x[k])}`).join(',')}}`;
  return JSON.stringify(x === undefined ? null : x);
}

const blocos = (linha) => {
  const c = ehObjeto(linha) && ehObjeto(linha.message) ? linha.message.content : null;
  return Array.isArray(c) ? c.filter(ehObjeto) : [];
};

function transcriptDe(entrada) {
  const t = entrada && entrada.transcript_path;
  return typeof t === 'string' && path.isAbsolute(t) && t.endsWith('.jsonl') ? t : null;
}

/** O id da chamada que pediu a permissao: o tool_use_id da entrada ou o ultimo tool_use igual (nome e entrada) sem resultado. */
function idDaChamada(entrada, { cauda = CAUDA_TELA } = {}) {
  if (entrada && typeof entrada.tool_use_id === 'string' && entrada.tool_use_id) return entrada.tool_use_id;
  const arq = transcriptDe(entrada);
  if (!arq) return null;
  const linhas = lib.lerCauda(arq, cauda);
  const alvo = canonico(ehObjeto(entrada.tool_input) ? entrada.tool_input : {});
  const comResultado = new Set();
  for (let i = linhas.length - 1; i >= 0; i--) {
    for (const b of blocos(linhas[i])) {
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') comResultado.add(b.tool_use_id);
      if (b.type === 'tool_use' && b.name === entrada.tool_name && typeof b.id === 'string' && !comResultado.has(b.id)
        && canonico(ehObjeto(b.input) ? b.input : {}) === alvo) return b.id;
    }
  }
  return null;
}

/** A chamada ja tem resultado no transcript = a tela respondeu (permitiu ou negou) antes do Telegram. */
function respondidaNaTela(entrada, id, { cauda = CAUDA_TELA } = {}) {
  const arq = transcriptDe(entrada);
  if (!arq || !id) return false;
  const linhas = lib.lerCauda(arq, cauda);
  for (let i = linhas.length - 1; i >= 0; i--) {
    if (blocos(linhas[i]).some((b) => b.type === 'tool_result' && b.tool_use_id === id)) return true;
  }
  return false;
}

// ---------- o ok-wpp ----------

// Roda o ok-wpp (node) com a sessao da aba; -> {codigo de saida, json da 1a linha} | {code: null, json: null}
function rodarOkWpp(args, { env, sessionId, esperaMs = ESPERA_OK_WPP_MS } = {}) {
  return new Promise((resolve) => {
    let saida = '';
    let fim = false;
    const terminar = (code) => {
      if (fim) return;
      fim = true;
      let json = null;
      try { json = JSON.parse(saida.trim().split('\n').pop()); } catch (_) { json = null; }
      resolve({ code, json });
    };
    let filho;
    try {
      filho = spawn(process.execPath, [OK_WPP, ...args], {
        env: { ...env, CLAUDE_CODE_SESSION_ID: sessionId },
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch (_) {
      resolve({ code: null, json: null });
      return;
    }
    const relogio = setTimeout(() => { try { filho.kill(); } catch (_) { /* nada */ } terminar(null); }, esperaMs);
    filho.stdout.on('data', (b) => { saida += b; });
    filho.on('error', () => { clearTimeout(relogio); terminar(null); });
    filho.on('close', (code) => { clearTimeout(relogio); terminar(code); });
  });
}

// Cancelar no sinal de encerramento: sincrono (o processo sai logo depois)
function cancelarJa(codigo, motivo, { env, sessionId }) {
  try {
    spawnSync(process.execPath, [OK_WPP, 'cancelar', codigo, '--motivo', motivo], {
      env: { ...env, CLAUDE_CODE_SESSION_ID: sessionId }, stdio: 'ignore', timeout: 8000, windowsHide: true,
    });
  } catch (_) { /* o porteiro fecha a mensagem quando o pedido vencer */ }
}

const esperar = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * Repassa o pedido pro Telegram e espera a decisao. -> {decisao: 'allow'|'deny', por: 'sim'|'nao'|'sem-resposta'|'trava',
 * motivo, codigo} | null (nao repassou: quem chama segue o caminho de antes). Nunca lanca.
 * opts (testes): env, agora, dormir, atrasoMs, tetoMs, pollMs, okWpp(args) -> {code, json}, cancelarSync(cod, motivo),
 * sinais (o objeto que recebe os handlers; padrao process), sair (padrao process.exit).
 */
async function repassar(entrada, {
  env = process.env,
  agora = Date.now,
  dormir = esperar,
  atrasoMs = ATRASO_MS,
  tetoMs = TETO_MS,
  pollMs = POLL_MS,
  okWpp = null,
  cancelarSync = null,
  sinais = process,
  sair = (c) => process.exit(c),
} = {}) {
  let c;
  try { c = lib.caminhos(env); } catch (_) { return null; }
  const log = (msg) => lib.log(c.logFile, `${NOME}: ${msg}`);
  const sessionId = entrada && entrada.session_id;
  const curto = String(sessionId || '-').slice(0, 8);
  const ferramenta = String((entrada && entrada.tool_name) || '').replace(/[^\w:.-]/g, '').slice(0, 60);
  const chamar = okWpp || ((args) => rodarOkWpp(args, { env, sessionId }));
  const cancelar = cancelarSync || ((cod, motivo) => cancelarJa(cod, motivo, { env, sessionId }));
  const handlers = [];
  const soltarSinais = () => {
    for (const [s, h] of handlers) { try { sinais.removeListener(s, h); } catch (_) { /* nada */ } }
    handlers.length = 0;
  };
  try {
    const inicio = agora();
    const rua = lib.lerModoRua(c.estadoDir, inicio).efetivo === true;
    const escondida = env.SESSOES_WPP_ESCONDIDA === '1';
    const atraso = rua || escondida ? 0 : Math.max(0, atrasoMs);
    log(`${ferramenta} na aba ${curto}: ${atraso ? `espero ${Math.round(atraso / 1000)} s a tela antes do Telegram` : `direto pro Telegram (${rua ? 'modo rua' : 'sessao escondida'})`}`);
    const chamada = idDaChamada(entrada);
    if (!chamada) log(`${ferramenta} na aba ${curto}: sem a chamada no transcript (a resposta na tela so se ve pelo sinal)`);
    const naTela = () => Boolean(chamada) && respondidaNaTela(entrada, chamada);
    for (let fimAtraso = inicio + atraso; agora() < fimAtraso;) {
      await dormir(Math.min(pollMs, fimAtraso - agora()));
      if (naTela()) { log(`${ferramenta} na aba ${curto}: respondido na tela; nada vai pro Telegram`); return null; }
    }
    const d = disponivel(entrada, { env, agora });
    if (!d.ok) {
      log(`${ferramenta} na aba ${curto}: nao repassei (${d.motivo})`);
      return null;
    }
    const restante = tetoMs - (agora() - inicio);
    const validadeMin = Math.min(VALIDADE_MAX_MIN, Math.floor(restante / 60000));
    if (validadeMin < 1) return null;
    const acao = descrever(entrada.tool_name, entrada.tool_input);
    const r = await chamar(['pedir', '--tipo', 'permissao', '--validade-min', String(validadeMin), '--acao', acao]);
    const codigo = r && r.json && r.json.status === 'pedido' && RE_CODIGO.test(String(r.json.codigo)) ? r.json.codigo : null;
    if (!codigo) {
      log(`${ferramenta} na aba ${curto}: o pedido nao saiu (${(r && r.json && r.json.motivo) || 'sem resposta do ok-wpp'})`);
      return null;
    }
    const expira = Date.parse(r.json.expiraEm);
    const prazo = Math.min(inicio + tetoMs, Number.isFinite(expira) ? expira : inicio + tetoMs);
    log(`${ferramenta} na aba ${curto}: pedido ${codigo} no Telegram (vale ${validadeMin} min)`);

    // A tela respondeu antes = o app encerra este processo: cancela (a mensagem some do chat) e sai
    let saindo = false;
    for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
      const h = () => {
        if (saindo) return;
        saindo = true;
        log(`pedido ${codigo}: respondido na tela (${s}); cancelo no Telegram`);
        cancelar(codigo, 'na-tela');
        sair(0);
      };
      handlers.push([s, h]);
      try { sinais.on(s, h); } catch (_) { /* sem sinal */ }
    }

    const fim = (decisao, por) => ({ decisao, por, motivo: MOTIVO[por === 'sem-resposta' ? 'semResposta' : por] || null, codigo });
    const oksArq = path.join(c.estadoDir, 'oks', `${codigo}.json`);
    const estadoArq = path.join(c.estadoDir, 'estado.json');
    let ultimoUpdate = null;
    let proximaConferencia = 0;
    for (;;) {
      if (saindo) return null;
      if (naTela()) {
        log(`pedido ${codigo}: respondido na tela; cancelo no Telegram`);
        await chamar(['cancelar', codigo, '--motivo', 'na-tela']);
        return null;
      }
      const agoraMs = agora();
      const venceu = agoraMs >= prazo;
      const p = lerJson(oksArq);
      if (ehObjeto(p) && p.status === 'usado') { log(`pedido ${codigo}: ja conferido (Sim)`); return fim('allow', 'sim'); }
      if (ehObjeto(p) && p.status === 'recusado') { log(`pedido ${codigo}: ja recusado`); return fim('deny', 'nao'); }
      if (ehObjeto(p) && p.status === 'cancelado') { log(`pedido ${codigo}: cancelado por fora`); return null; }
      const estado = lerJson(estadoArq);
      const m = ehObjeto(estado) && ehObjeto(estado.okTg) && ehObjeto(estado.okTg.mensagens) ? estado.okTg.mensagens[codigo] : null;
      const t = ehObjeto(m) && ehObjeto(m.toque) ? m.toque : null;
      const tocado = t && (t.acao === 'sim' || t.acao === 'nao') && !t.soltoEm && Number.isSafeInteger(t.updateId);
      if (tocado && (agoraMs >= proximaConferencia || venceu)) {
        const v = await chamar(['verificar', codigo]);
        const st = v && v.json ? v.json.status : null;
        const motivo = v && v.json && typeof v.json.motivo === 'string' ? v.json.motivo : '';
        if (st === 'ok') { log(`pedido ${codigo}: Sim conferido no Telegram`); return fim('allow', 'sim'); }
        if (st === 'recusado') { log(`pedido ${codigo}: Nao no Telegram`); return fim('deny', 'nao'); }
        if (st === 'invalido') {
          if (motivo === 'ja usado') return fim('allow', 'sim');
          if (motivo === 'ja recusado') return fim('deny', 'nao');
          if (motivo === 'travado pelo dono') { log(`pedido ${codigo}: travado`); return fim('deny', 'trava'); }
          if (motivo === 'expirou') { log(`pedido ${codigo}: expirou na conferencia`); return fim('deny', 'sem-resposta'); }
          log(`pedido ${codigo}: a conferencia nao valeu (${motivo.slice(0, 80)}); cancelo e devolvo pra tela`);
          await chamar(['cancelar', codigo, '--motivo', 'sem-resposta']);
          return null;
        }
        // pendente (Telegram ocupado, porteiro sem ler ainda) ou sem resposta: tenta de novo
        if (t.updateId !== ultimoUpdate) log(`pedido ${codigo}: toque ${t.acao} ainda sem conferir (${(motivo || st || 'sem resposta').slice(0, 80)}); tento de novo`);
        ultimoUpdate = t.updateId;
        proximaConferencia = agora() + DE_NOVO_MS;
      }
      if (venceu) {
        const rc = await chamar(['cancelar', codigo, '--motivo', 'sem-resposta']);
        const st = rc && rc.json ? rc.json.status : null;
        log(`pedido ${codigo}: ninguem respondeu no prazo (cancelar: ${st || 'sem resposta'})`);
        return fim('deny', 'sem-resposta');
      }
      await dormir(pollMs);
    }
  } catch (err) {
    log(`erro: ${String((err && err.message) || err).slice(0, 160)}`);
    return null;
  } finally {
    soltarSinais();
  }
}

module.exports = { disponivel, repassar, descrever, mascarar, idDaChamada, respondidaNaTela, MOTIVO, ATRASO_MS, TETO_MS, FORA };
