// sessoes-wpp — roteamento da mensagem do dono no grupo (pra qual sessao vai, ou se e comando).
// Modulo PURO: sem I/O, sem rede, sem disco, sem process.env. Contrato: PLANO.md ("Desenho" item 4).
// Quem filtra remetente/grupo e quem entrega e o porteiro (D3); aqui so se decide o destino.

const COMANDOS = new Map([
  ['status', 'status'],
  ['pendencias', 'pendencias'],
  ['pendencia', 'pendencias'],
  ['to na rua', 'rua'],
  ['na rua', 'rua'],
  ['voltei', 'pc'],
  ['to no pc', 'pc'],
  ['trava', 'trava'],
  // F3.9/F3.10 (fase 3): reabre a central do terminal se ela foi fechada (o porteiro responde se ja esta aberta)
  ['abre central', 'central'],
  ['abrir central', 'central'],
  ['abre a central', 'central'], // o dono fala por audio: a transcricao traz o artigo
  ['abrir a central', 'central'],
]);

// "<nome>: <resto>" — nome de 1 a 60 chars, sem quebra de linha antes dos dois pontos.
const RE_NOME = /^([^\n:]{1,60}):([\s\S]*)$/;

/** Minusculas, sem acento, espacos colapsados, trim, sem pontuacao final (.,!?;:). */
export function normalizar(s) {
  if (s == null) return '';
  return String(s)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s.,!?;:]+$/, '');
}

// ---------- aviso de rua em frase livre ----------
// Pedido do dono: "quando eu pedir... posso so mandar um audio falando o, to na rua ai se precisar de alguma coisa me
// avisa, e ai ja vai ligar". Casa na frase normalizada (sem acento, minuscula, pontuacao virou espaco).
// Caso real: «Eu tô aqui na sala, se precisar ... me avisa aqui.» e «Estou fora de casa.» nao ligavam: entram "fora de
// casa", "sai(ndo) de casa", "to (aqui) na sala" (so com o sujeito: "a reuniao e na sala 3" nao conta), carro, dirigindo.
const RE_RUA = new RegExp(String.raw`\b(?:na rua|(?:fora|longe) do (?:pc|computador)|sai(?:ndo)? do (?:pc|computador)`
  + String.raw`|(?:to|tou|estou) saindo|vou sair|fora de casa|sai(?:ndo)? de casa|(?:to|tou|estou) (?:aqui )?na sala`
  + String.raw`|(?:to|tou|estou) (?:no carro|dirigindo))\b`, 'g');
// Palavras que so enfeitam o aviso ("se precisar de alguma coisa me avisa", "volto as 15h"). Sobrou palavra fora daqui =
// tem pedido junto: o modo rua liga E a mensagem segue o roteamento normal (na duvida, nunca engolir o pedido).
const ENFEITE_RUA = new Set(`
  o oi ola ai ei entao bom gente pessoal galera ok okay blz beleza ta to tou estou eu ja agora aqui la viu fui tchau falou
  flw vou ir indo fico ficar estarei vai ate e que se precisar precisarem precisa de do da das dos alguma algum algo coisa
  qualquer qq me avisa avise avisem chama chame manda mande fala pelo pela no na nos em com por whats whatsapp celular
  telefone tipo ne certo combinado obrigado valeu um uma pouco pouquinho pra para pro as os a volto voltar voltando daqui
  logo mais tarde noite manha hoje cedo depois hora horas minuto minutos min meia almoco almocar reuniao cafe rapidinho
  rapido sair saindo sai fora longe rua pc computador meu minha isso so vc voce voces mim caminho dirigindo
  casa precise interagir interacao
`.split(/\s+/).filter(Boolean));
const RE_HORA = /^\d{1,2}(?:h\d{0,2}|hs)?$/;

/**
 * Aviso de rua numa frase livre (texto ou transcricao): null = nao e aviso de rua (ou esta negado: "nao to na rua");
 * 'so' = so o aviso (vira o comando "to na rua"); 'pedido' = aviso de rua com pedido junto.
 * "na Rua Augusta" (nome de rua: maiuscula ou numero logo depois) nao conta.
 */
export function intencaoRua(texto) {
  if (texto == null) return null;
  const semNomeDeRua = String(texto)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\b(na\s+rua)(\s+)(\S)/gi, (tudo, _a, esp, ch) => (/[A-Z0-9]/.test(ch) ? `nomederua${esp}${ch}` : tudo));
  const s = normalizar(semNomeDeRua).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  let achou = false;
  for (const m of s.matchAll(RE_RUA)) {
    const antes = s.slice(0, m.index).trim().split(' ').slice(-3);
    if (!antes.includes('nao')) achou = true;
  }
  if (!achou) return null;
  const sobra = s.replace(RE_RUA, ' ').split(' ').filter(Boolean);
  return sobra.every((p) => ENFEITE_RUA.has(p) || RE_HORA.test(p)) ? 'so' : 'pedido';
}

/** O texto (ou a transcricao) e o comando "trava", frase inteira? (F3.3: ela vence tudo, citando ou nao.) */
export function ehTrava(texto) {
  return COMANDOS.get(normalizar(texto)) === 'trava';
}

/** Linha do read do whatsapp-agent -> {texto, audio}. Audio/ptt usa a transcricao. */
export function textoDaMensagem(m) {
  const tipo = typeof m?.message_type === 'string' ? m.message_type.toLowerCase() : '';
  if (tipo === 'audio' || tipo === 'ptt') {
    return { texto: typeof m.transcription === 'string' ? m.transcription : '', audio: true };
  }
  return { texto: typeof m?.content === 'string' ? m.content : '', audio: false };
}

function chavesDaSessao(s) {
  return [s.titulo, s.nome]
    .filter((x) => typeof x === 'string')
    .map(normalizar)
    .filter(Boolean);
}

/**
 * Sessoes que casam `nome` (JA normalizado): igual exato (titulo ou nome) primeiro; sem exato, as que comecam com ele.
 * sessionId repetido conta 1 vez. Exportada pro porteiro resolver o destino do "encaminhar" da central (F3.9) com a
 * mesma regra do "Nome: texto".
 */
export function casarSessoes(nome, sessoes) {
  const unicas = new Map();
  for (const s of sessoes) {
    if (s && typeof s === 'object' && s.sessionId && !unicas.has(s.sessionId)) unicas.set(s.sessionId, s);
  }
  const lista = [...unicas.values()];
  const exatas = lista.filter((s) => chavesDaSessao(s).includes(nome));
  if (exatas.length) return exatas;
  return lista.filter((s) => chavesDaSessao(s).some((k) => k.startsWith(nome)));
}

/**
 * Decide o destino de 1 mensagem do dono. Ordem: "trava" -> citacao de aviso -> comando -> so o aviso de rua em frase
 * livre -> "Nome: texto" -> central.
 * ctx = {avisos: {[providerMsgId]: {sessionId, titulo, nome}}, sessoes: [{sessionId, titulo, nome}]}.
 * Sempre devolve `audio` (true quando o texto veio da transcricao). `rua: true` (so quando vale) = a mensagem segue pro
 * destino E traz aviso de rua ("to na rua, me manda X"): quem entrega liga o modo rua.
 */
export function rotear(m, ctx) {
  const { texto: bruto, audio } = textoDaMensagem(m);
  const texto = bruto.trim();
  const avisos = ctx && ctx.avisos && typeof ctx.avisos === 'object' ? ctx.avisos : {};
  const sessoes = Array.isArray(ctx?.sessoes) ? ctx.sessoes : [];
  const citada = m?.quoted_msg_id || null;
  const rua = intencaoRua(texto);
  const comRua = (r) => (rua ? { ...r, rua: true } : r);

  // 0. F3.3: "trava" vence tudo, inclusive a citacao de aviso (so ela; os outros comandos citando aviso sao repasse)
  if (ehTrava(texto)) return { tipo: 'comando', cmd: 'trava', audio };

  // 1. citou um aviso (chave propria do objeto; nunca herdada do prototipo)
  if (citada && Object.hasOwn(avisos, citada)) {
    const aviso = avisos[citada];
    if (aviso && aviso.sessionId) {
      return comRua({ tipo: 'repasse', via: 'citacao', sessionId: aviso.sessionId, texto, audio });
    }
  }

  // 2. comando (a frase inteira)
  const cmd = COMANDOS.get(normalizar(texto));
  if (cmd) return { tipo: 'comando', cmd, audio };

  // 2b. so o aviso de rua em frase livre ("o, to na rua ai, se precisar me avisa") = o comando "to na rua"
  if (rua === 'so') return { tipo: 'comando', cmd: 'rua', audio };

  // 3. "Nome: texto"
  const partes = RE_NOME.exec(texto);
  if (partes) {
    const nome = normalizar(partes[1]);
    const resto = partes[2].trim();
    if (nome && resto) {
      const achadas = casarSessoes(nome, sessoes);
      if (achadas.length === 1) {
        return comRua({ tipo: 'repasse', via: 'nome', sessionId: achadas[0].sessionId, texto: resto, audio });
      }
      if (achadas.length > 1) {
        const candidatos = achadas.map((s) => ({
          sessionId: s.sessionId,
          titulo: s.titulo ?? null,
          nome: s.nome ?? null,
        }));
        return comRua({ tipo: 'ambiguo', candidatos, texto, audio });
      }
    }
  }

  // 4. resto -> sessao central
  return comRua({ tipo: 'central', texto, quoted_msg_id: citada, audio });
}
