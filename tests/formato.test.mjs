// Testes de lib/formato.mjs (node:test, sem dependencia).
// Rodar: node --test "tests/*.test.mjs"  (no Node 24 a pasta sozinha nao expande)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  horaBRT,
  limparParaWhatsApp,
  precisaDoDono,
  montarAviso,
  montarResposta,
  montarConcluido,
  cabecalho,
  pedeDetalhe,
  ICONE,
  ICONE_CONTROLE,
  partesCurtas,
  diaBRT,
} from '../lib/formato.mjs';

const EMOJI = /\p{Extended_Pictographic}|\uFE0F/u;
// F4g (pedido do dono): cabecalho = icone de informacao + nome em negrito; sem "(pc)" e sem rodape.
const CAB = (nome) => `\u2139\uFE0F *${nome}*`;
const semCabecalho = (texto) => texto.split('\n').slice(1).join('\n');

function evento(extra = {}) {
  return {
    v: 1,
    tipo: 'parou',
    at: '2026-09-27T18:05:20.000Z',
    sessionId: 's-faro',
    pid: 123,
    nome: 'projetos-f3',
    titulo: 'Faro',
    cwd: 'C:\\projetos',
    entrypoint: 'claude-vscode',
    final: 'ok',
    finalTs: '2026-09-27T18:05:19.799Z',
    marcas: { decisao: false, fica: false, pergunta: false },
    ...extra,
  };
}

// ---------- horaBRT ----------

test('horaBRT: ISO UTC vira HH:MM em Brasilia', () => {
  assert.equal(horaBRT('2026-09-27T18:05:19.799Z'), '15:05');
  assert.equal(horaBRT('2026-09-27T19:09:29.001+00:00'), '16:09');
  assert.equal(horaBRT('2026-09-28T03:00:00Z'), '00:00'); // meia-noite = 00, nunca 24
  assert.equal(horaBRT('2026-09-27T12:07:00-03:00'), '12:07');
});

// O formatador nasce quando o modulo carrega: mudar process.env.TZ depois nao prova nada (e o PC ja e BRT).
// Prova de verdade = processo filho que JA nasce em outro fuso.
test('horaBRT: nao depende do TZ do processo', () => {
  const url = new URL('../lib/formato.mjs', import.meta.url).href;
  const codigo = `import(${JSON.stringify(url)}).then((m) => process.stdout.write(m.horaBRT('2026-09-27T18:05:19.799Z')))`;
  for (const TZ of ['Asia/Tokyo', 'UTC']) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', codigo], { encoding: 'utf8', env: { ...process.env, TZ } });
    assert.equal(r.stdout, '15:05', `TZ=${TZ}: ${r.stderr}`);
  }
});

test('horaBRT: ISO invalido vira ??:??', () => {
  for (const ruim of ['abc', '', null, undefined, 42, {}, '2026-13-45T99:99:00Z', '2026-09-27']) {
    assert.equal(horaBRT(ruim), '??:??', `entrada ${JSON.stringify(ruim)}`);
  }
});

// ---------- limparParaWhatsApp ----------

test('limpar a) negrito, sublinhado, tachado e titulos', () => {
  assert.equal(limparParaWhatsApp('um **forte** e __outro__ e ~~riscado~~'), 'um *forte* e _outro_ e ~riscado~');
  assert.equal(limparParaWhatsApp('# Titulo\n## Sub\n### Menor'), '*Titulo*\n*Sub*\n*Menor*');
  assert.equal(limparParaWhatsApp('## **Resumo**'), '*Resumo*'); // sem asterisco dobrado
  assert.equal(limparParaWhatsApp('#hashtag nao e titulo'), '#hashtag nao e titulo');
  assert.equal(limparParaWhatsApp('texto # nao e titulo'), 'texto # nao e titulo');
});

test('limpar b) link vira texto (url)', () => {
  assert.equal(
    limparParaWhatsApp('veja [o painel](https://x.exemplo.com.br/a?b=1) agora'),
    'veja o painel (https://x.exemplo.com.br/a?b=1) agora',
  );
});

test('limpar c) regua some, tabela vira lista', () => {
  assert.equal(limparParaWhatsApp('antes\n---\nmeio\n***\nfim\n___\nx'), 'antes\nmeio\nfim\nx');
  assert.equal(
    limparParaWhatsApp('| Item | Estado |\n|---|:---:|\n| A | **ok** |\n| B |  |'),
    '- Item | Estado\n- A | *ok*\n- B |',
  );
});

test('limpar d) emoji: farois somem, sinais viram palavra, resto some', () => {
  assert.equal(limparParaWhatsApp('🔴 **DECISÃO:** sobe?'), '*DECISÃO:* sobe?');
  assert.equal(limparParaWhatsApp('🟢 no ar\n🟡 lento'), 'no ar\nlento');
  assert.equal(limparParaWhatsApp('⚠️ risco pequeno'), 'Atenção: risco pequeno');
  assert.equal(limparParaWhatsApp('⚠ sem seletor'), 'Atenção: sem seletor');
  assert.equal(limparParaWhatsApp('✅ testes\n❌ deploy'), 'ok: testes\nnão: deploy');
  assert.equal(limparParaWhatsApp('feito 🎉 hoje 👍🏽 e 👨‍💻 e 🇧🇷 e ❤️'), 'feito hoje e e e');
  assert.equal(limparParaWhatsApp('📌 Nota'), 'Nota');
  assert.doesNotMatch(limparParaWhatsApp('a 🚀 b ✨ c 1️⃣ d'), EMOJI);
});

test('limpar e) travessao vira hifen', () => {
  assert.equal(limparParaWhatsApp('a — b – c'), 'a - b - c');
});

test('limpar f) crase, bloco e citacao ficam; espacos e linhas vazias', () => {
  const md = [
    'use `**nao mexe**` aqui',
    '> citacao fica',
    '```bash',
    '# comentario do bash fica',
    '| a | b |',
    'x = **y**',
    '```',
    'depois **sim**   ',
    '',
    '',
    '',
    '',
    'fim',
  ].join('\n');
  const esperado = [
    'use `**nao mexe**` aqui',
    '> citacao fica',
    '```bash',
    '# comentario do bash fica',
    '| a | b |',
    'x = **y**',
    '```',
    'depois *sim*',
    '',
    'fim',
  ].join('\n');
  assert.equal(limparParaWhatsApp(md), esperado);
  assert.equal(limparParaWhatsApp('a\n\n\nb'), 'a\n\nb'); // no maximo 1 linha vazia
  assert.equal(limparParaWhatsApp('a\r\nb  \r\n'), 'a\nb');
  assert.equal(limparParaWhatsApp(null), '');
});

// ---------- precisaDoDono ----------

test('precisaDoDono: decisao, fica ou pergunta', () => {
  assert.equal(precisaDoDono(evento()), false);
  assert.equal(precisaDoDono(evento({ marcas: { decisao: true, fica: false, pergunta: false } })), true);
  assert.equal(precisaDoDono(evento({ marcas: { decisao: false, fica: true, pergunta: false } })), true);
  assert.equal(precisaDoDono(evento({ marcas: { decisao: false, fica: false, pergunta: true } })), true);
  assert.equal(precisaDoDono({}), false);
  assert.equal(precisaDoDono(null), false);
});

// ---------- cabecalho (F4g) ----------

test('F4g cabecalho: icone de informacao + nome em negrito; nome limpo numa linha, sem "(pc)"', () => {
  assert.equal(ICONE, 'ℹ️');
  assert.equal(cabecalho('Controle de sessões'), 'ℹ️ *Controle de sessões*');
  assert.equal(ICONE_CONTROLE, '🎛️');
  assert.equal(cabecalho('Controle de sessões', ICONE_CONTROLE), '🎛️ *Controle de sessões*'); // voz do controle (pedido do dono)
  assert.equal(cabecalho('🚀 **Lançamento** — site'), 'ℹ️ *Lançamento - site*');
  assert.equal(cabecalho('ℹ️ Já tem ícone'), 'ℹ️ *Já tem ícone*', 'icone do nome some: nunca 2');
  assert.equal(cabecalho('  muitas\n  linhas  '), 'ℹ️ *muitas linhas*');
  assert.equal(cabecalho(''), 'ℹ️ *sem nome*');
  assert.equal(cabecalho(null), 'ℹ️ *sem nome*');
});

// ---------- montarAviso (F4g: no maximo 2 linhas, sem rodape) ----------

const DEC = { decisao: true, fica: false, pergunta: false };

test('F4g 1. o exemplo do dono: o que aconteceu + a pergunta da DECISAO em negrito + as opcoes; sem farol, regua, hora, rodape', () => {
  const final = [
    '🟢 A função xyz foi finalizada.',
    '- **Testes:** 12 verdes, nada mudou na tela.',
    '',
    '---',
    '🔴 **DECISÃO:** Posso publicar?',
    'A) Publicar agora (recomendado) / B) Esperar a live',
  ].join('\n');
  const aviso = montarAviso(evento({ final, marcas: DEC }));
  assert.equal(aviso, [
    CAB('Faro'),
    'A função xyz foi finalizada.',
    '',
    '*Posso publicar?*',
    'A) Publicar agora (recomendado) / B) Esperar a live',
  ].join('\n'));
  assert.doesNotMatch(semCabecalho(aviso), EMOJI);
  assert.doesNotMatch(aviso, /\(pc\)|Parou às|Responde citando|15:05|Testes/);
});

test('F4g 2. o que aconteceu = 1a frase da 1a linha, sem negrito; opcoes uma por linha viram 1 linha com "/"', () => {
  const final = [
    '🟡 **Dá pra chegar perto de 40 h, mas abrir mais abas não resolve.** O que segura o prazo é a ordem entre os módulos.',
    '- **Por que hoje dá ~75 h:** o motor anda numa frente só.',
    '',
    '---',
    '🔴 **DECISÃO:** Acelero ao máximo pra meta de 40 h?',
    'A) 2º agente no PC: ~40 h, algum retrabalho (recomendado)',
    'B) 3 frentes, na ordem do plano: ~50 h',
  ].join('\n');
  assert.equal(montarAviso(evento({ final, marcas: DEC })), [
    CAB('Faro'),
    'Dá pra chegar perto de 40 h, mas abrir mais abas não resolve.',
    '',
    '*Acelero ao máximo pra meta de 40 h?*',
    'A) 2º agente no PC: ~40 h, algum retrabalho (recomendado) / B) 3 frentes, na ordem do plano: ~50 h',
  ].join('\n'));
});

test('F4g 3. negrito que abraca 2 frases nao fica aberto; abreviatura (Dr.) nao corta a frase; frase curta junta a seguinte', () => {
  const doisNegrito = montarAviso(evento({
    final: '🟡 **A página está pronta e passou nas 57 verificações. Nada foi publicado.** Faltam 2 coisas suas.\n\n🔴 **DECISÃO:** Publico?\nA) Sim / B) Não',
    marcas: DEC,
  }));
  assert.equal(doisNegrito.split('\n')[1], 'A página está pronta e passou nas 57 verificações.');
  const dr = montarAviso(evento({ final: '🟢 Mandei a proposta pro Dr. Paulo às 10h. Ele confirmou às 11h.', marcas: DEC }));
  assert.equal(dr.split('\n')[1], 'Mandei a proposta pro Dr. Paulo às 10h.');
  const curta = montarAviso(evento({ final: '🟢 Pronto. A função X está no ar desde 10h. Nada mudou na tela.', marcas: DEC }));
  assert.equal(curta.split('\n')[1], 'Pronto. A função X está no ar desde 10h.');
});

test('F4g 4. "Fica com você" (lista embaixo ou na mesma linha) vira a linha da pergunta; DECISAO tem prioridade', () => {
  const lista = montarAviso(evento({
    final: [
      '🟡 Ainda não apareceu nada na pasta de Downloads (o PC principal). O arquivo mais recente é de hoje às 18h29.',
      '- Pode ser que o download ainda esteja terminando.',
      '',
      'Fica com você:',
      '- Se baixou em outro aparelho, arraste o zip pra pasta Downloads. Qualquer pasta do Drive também serve.',
      '- Depois me avise aqui.',
    ].join('\n'),
    marcas: { decisao: false, fica: true, pergunta: false },
  }));
  assert.equal(lista, [
    CAB('Faro'),
    'Ainda não apareceu nada na pasta de Downloads (o PC principal).',
    '',
    '*Fica com você:* Se baixou em outro aparelho, arraste o zip pra pasta Downloads; Depois me avise aqui.',
  ].join('\n'));
  const mesmaLinha = montarAviso(evento({
    final: '🟡 Está tudo pronto pro cofre, mas **as 2 aprovações** expiraram. Parei.\n\nFica com você: me avisar quando estiver na frente do app. Vão aparecer **6 aprovações**.',
    marcas: { decisao: false, fica: true, pergunta: false },
  }));
  assert.equal(mesmaLinha, [
    CAB('Faro'),
    'Está tudo pronto pro cofre, mas as 2 aprovações expiraram.',
    '',
    '*Fica com você:* me avisar quando estiver na frente do app.',
  ].join('\n'));
  // cabecalho com o "quando" antes dos dois pontos (uso real 28-30/09): fica no texto
  assert.equal(
    montarAviso(evento({ final: '🟡 O login travou.\n\nFica com você, no celular:\n- Aprovar o login no app.', marcas: { decisao: false, fica: true, pergunta: false } })),
    [CAB('Faro'), 'O login travou.', '', '*Fica com você, no celular:* Aprovar o login no app.'].join('\n'),
  );
  // "fica com você" no meio da frase (minuscula) nao e o bloco "Fica com você:": vira a linha do que esta com ele (F4g 5b)
  assert.equal(
    montarAviso(evento({ final: '🟢 Separei os cards.\n- **Fornecedor:** fica com você no privado.', marcas: DEC })),
    [CAB('Faro'), 'Separei os cards.', '', '*Fornecedor: fica com você no privado.*'].join('\n'),
  );
  const asDuas = montarAviso(evento({
    final: '🟡 A página está pronta.\n\n🔴 **DECISÃO:** Publico quando os ingressos existirem?\nA) Sim (recomendado) / B) Me chama antes\n\nFica com você:\n- Criar os 2 ingressos na loja.',
    marcas: { decisao: true, fica: true, pergunta: false },
  }));
  assert.equal(asDuas, [
    CAB('Faro'), 'A página está pronta.', '', '*Publico quando os ingressos existirem?*', 'A) Sim (recomendado) / B) Me chama antes',
  ].join('\n'));
});

test('F4g 5. sem DECISAO nem "Fica com você": a ultima linha com "?" vira a pergunta (com as opcoes de baixo)', () => {
  assert.equal(
    montarAviso(evento({ final: 'Achei os 3 arquivos na pasta do Drive.\n\nQuer que eu junte num PDF só?', marcas: { decisao: false, fica: false, pergunta: true } })),
    [CAB('Faro'), 'Achei os 3 arquivos na pasta do Drive.', '', '*Quer que eu junte num PDF só?*'].join('\n'),
  );
  assert.equal(
    montarAviso(evento({ final: 'Achei 2 versões do contrato.\nQual eu sigo?\nA) A de agosto\nB) A de setembro', marcas: { decisao: false, fica: false, pergunta: false } })),
    [CAB('Faro'), 'Achei 2 versões do contrato.', '', '*Qual eu sigo?*', 'A) A de agosto / B) A de setembro'].join('\n'),
  );
  // a mensagem e so a pergunta: nao repete
  assert.equal(montarAviso(evento({ final: 'Publico agora?' })), [CAB('Faro'), '*Publico agora?*'].join('\n'));
  // "decisao" no meio do texto, sem o bloco: so o que aconteceu
  assert.equal(montarAviso(evento({ final: '🟢 A decisão do layout ficou com o time.\nNada pra você.', marcas: DEC })),
    [CAB('Faro'), 'A decisão do layout ficou com o time.'].join('\n'));
  // "fica com você" no meio da frase (uso real 30/09 01:31): nao e o "Fica com você:"; a frase vira a linha de baixo e a
  // 1a frase da MESMA linha continua sendo o que aconteceu
  assert.equal(
    montarAviso(evento({ final: '🟡 Bateria rodando (170 suítes, ~3 min). Reporto a decisão que fica com você assim que ela terminar.', marcas: DEC })),
    [CAB('Faro'), 'Bateria rodando (170 suítes, ~3 min).', '', '*Reporto a decisão que fica com você assim que ela terminar.*'].join('\n'),
  );
});

test('F4g 5b. sem pergunta, mas com o que esta com ele ("continua com você", "seu OK", "sua decisão", "em aberto"): a ULTIMA frase assim vai embaixo, em negrito', () => {
  assert.equal(
    montarAviso(evento({ final: '🟢 Retomei as duas abas da obra.\n- Anotei no diário.\n\nContinuam com você as 2 pendências de antes: a versão do app de voz e o plano da etapa 2.', marcas: DEC })),
    [CAB('Faro'), 'Retomei as duas abas da obra.', '', '*Continuam com você as 2 pendências de antes: a versão do app de voz e o plano da etapa 2.*'].join('\n'),
  );
  // frase que termina em ":" leva a lista (sem ";" dobrado)
  assert.equal(
    montarAviso(evento({ final: '🟢 A correção está no ar.\n\nContinuam em aberto, esperando uma decisão sua:\n- ligar cada pessoa à vaga;\n- a lista B;\n- a reunião de 06/10.', marcas: DEC })),
    [CAB('Faro'), 'A correção está no ar.', '', '*Continuam em aberto, esperando uma decisão sua: ligar cada pessoa à vaga; a lista B; a reunião de 06/10.*'].join('\n'),
  );
  // a ultima linha assim ganha; a frase certa da linha (nao a 1a)
  assert.equal(
    montarAviso(evento({ final: '🟢 Tudo no ar.\nO seu OK de ontem valeu.\n\nNada travou. A parte dos textos continua esperando o seu OK.', marcas: DEC })),
    [CAB('Faro'), 'Tudo no ar.', '', '*A parte dos textos continua esperando o seu OK.*'].join('\n'),
  );
  // a frase do que esta com ele e a 1a da linha (ou vem colada numa frase curta): nao sai 2 vezes
  assert.equal(
    montarAviso(evento({ final: 'A parte dos textos continua esperando o seu OK.', marcas: DEC })),
    [CAB('Faro'), '*A parte dos textos continua esperando o seu OK.*'].join('\n'),
  );
  assert.equal(
    montarAviso(evento({ final: 'Pronto. Continua esperando o seu OK.', marcas: DEC })),
    [CAB('Faro'), '*Continua esperando o seu OK.*'].join('\n'),
  );
  // tabela e citacao nao viram a linha de baixo (so texto e item)
  assert.equal(
    montarAviso(evento({ final: '🟢 Conferi a fila.\n\n| Item | Estado |\n|---|---|\n| Texto | pendente |\n\n> Continua com você, disse a Ana.', marcas: DEC })),
    [CAB('Faro'), 'Conferi a fila.'].join('\n'),
  );
  // "conversa com você" nao conta
  assert.equal(
    montarAviso(evento({ final: '🟢 Medi a gravação.\nConversa de 26/09 com você: 6 cortes.', marcas: DEC })),
    [CAB('Faro'), 'Medi a gravação.'].join('\n'),
  );
  // "DECISÃO (ainda aberta):" e o bloco da DECISÃO
  assert.equal(
    montarAviso(evento({ final: 'A aba da live mandou 2 pedidos.\n\n**DECISÃO (ainda aberta):** a regra entra no Hub quando?\nA) Depois da live / B) Já', marcas: DEC })),
    [CAB('Faro'), 'A aba da live mandou 2 pedidos.', '', '*A regra entra no Hub quando?*', 'A) Depois da live / B) Já'].join('\n'),
  );
});

test('F4g 6. frase que termina em ":" leva os itens da lista de baixo; titulo, tabela, citacao e bloco de codigo nao viram o que aconteceu', () => {
  assert.equal(
    montarAviso(evento({ final: '🟢 Terminei 3 coisas:\n- o login\n- o **deploy**\n- o DNS\n\n🔴 **DECISÃO:** Aviso o time?\nA) Sim / B) Não', marcas: DEC })),
    [CAB('Faro'), 'Terminei 3 coisas: o login; o deploy; o DNS', '', '*Aviso o time?*', 'A) Sim / B) Não'].join('\n'),
  );
  const final = [
    '## Resumo', '', '```bash', 'npm test', '```', '| Item | Estado |', '|---|---|', '| A | ok |', '> citação de rascunho',
    'Fiz **tudo** — ✅ testes', '', '---', '', '🔴 **DECISÃO:** Posso subir?', 'A) Sim (recomendado) / B) Não',
  ].join('\n');
  const aviso = montarAviso(evento({ final, marcas: DEC }));
  assert.equal(aviso, [CAB('Faro'), 'Fiz tudo - ok: testes', '', '*Posso subir?*', 'A) Sim (recomendado) / B) Não'].join('\n'));
  assert.doesNotMatch(semCabecalho(aviso), EMOJI);
  assert.doesNotMatch(aviso, /[—–]|\*\*/);
  // "Escrito pra:" (pra quem e a peca, uso real 28/09 16:36) nao e o que aconteceu
  assert.equal(
    montarAviso(evento({ final: 'Escrito pra: você agora, e pro time.\n\nA página ficou pronta.\n\n🔴 **DECISÃO:** Onde publico?\nA) Interna / B) Pública', marcas: DEC })),
    [CAB('Faro'), 'A página ficou pronta.', '', '*Onde publico?*', 'A) Interna / B) Pública'].join('\n'),
  );
});

test('F4g 7. DECISAO com as opcoes na mesma linha, com negrito dentro, com minuscula no comeco ou com a pergunta na linha de baixo', () => {
  assert.equal(montarAviso(evento({ final: 'Feito.\n🔴 **DECISÃO:** Publico? A) Sim / B) Não', marcas: DEC })),
    [CAB('Faro'), 'Feito.', '', '*Publico?*', 'A) Sim / B) Não'].join('\n'));
  assert.equal(montarAviso(evento({ final: 'Feito.\n🔴 **DECISAO:** volto o endereço **agora**?\nA) Os dois / B) Só o do Paulo', marcas: DEC })),
    [CAB('Faro'), 'Feito.', '', '*Volto o endereço agora?*', 'A) Os dois / B) Só o do Paulo'].join('\n'));
  assert.equal(montarAviso(evento({ final: 'Feito.\n🔴 **DECISÃO:**\nSigo com o plano?\n- A) Sim\n- B) Não', marcas: DEC })),
    [CAB('Faro'), 'Feito.', '', '*Sigo com o plano?*', 'A) Sim / B) Não'].join('\n'));
  // 2 linhas com DECISÃO (a de ontem citada no texto): vale a ULTIMA
  assert.equal(montarAviso(evento({ final: 'Ontem, **DECISÃO:** ficou a A.\nHoje terminei o login.\n\n🔴 **DECISÃO:** Publico?\nA) Sim / B) Não', marcas: DEC })),
    [CAB('Faro'), 'Hoje terminei o login.', '', '*Publico?*', 'A) Sim / B) Não'].join('\n'));
});

test('F4g 8. tetos: o que aconteceu ate 200 caracteres (corte em palavra + "..."), pergunta ate 300, opcoes ate 400', () => {
  const longa = `🟢 ${'palavra '.repeat(60)}fim.`;
  const linha1 = montarAviso(evento({ final: longa })).split('\n')[1];
  assert.ok(Array.from(linha1).length <= 200, `${linha1.length}`);
  assert.ok(linha1.endsWith('palavra...'), linha1);
  const pergunta = `🔴 **DECISÃO:** ${'decido '.repeat(80)}isso?\nA) ${'opcao '.repeat(100)}`;
  const [, p, o] = montarAviso(evento({ final: pergunta, marcas: DEC })).split('\n'); // sem o que aconteceu: so a pergunta
  assert.ok(p.startsWith('*') && p.endsWith('...*') && Array.from(p).length <= 302, p);
  assert.ok(o.endsWith('...') && Array.from(o).length <= 400, `${o.length}`);
});

test('F4g 9. sem texto: aviso = "Parou esperando você."; resposta = "Respondeu sem texto."; nome cai pro nome e pro "sem nome"', () => {
  assert.equal(montarAviso(evento({ final: '' })), [CAB('Faro'), 'Parou esperando você.'].join('\n'));
  // so um bloco ``` (o prompt pra copiar do uso real de 28-29/09): diz o que e
  assert.equal(montarAviso(evento({ final: '```\nVamos criar uma skill.\nLeia o plano.\n```' })), [CAB('Faro'), 'Deixou um texto pra copiar.'].join('\n'));
  assert.equal(montarResposta(evento({ final: '```\nso codigo\n```' })), [CAB('Faro'), 'Deixou um texto pra copiar.'].join('\n'));
  assert.equal(montarResposta(evento({ final: '' })), [CAB('Faro'), 'Respondeu sem texto.'].join('\n'));
  assert.match(montarAviso(evento({ titulo: null, nome: 'projetos-42' })), /^ℹ️ \*projetos-42\*\n/);
  assert.match(montarAviso(evento({ titulo: null, nome: '' })), /^ℹ️ \*sem nome\*\n/);
  assert.match(montarAviso(evento({ titulo: '🚀 Lançamento — site' })), /^ℹ️ \*Lançamento - site\*\n/);
});

// ---------- montarResposta (D3b + F4g) ----------

test('F4g 10. resposta: mesmo formato curto do aviso; a linha de citacao da fala nao vai', () => {
  const final = '> WhatsApp do Davi (07:50): «publica»\n🟢 Publiquei a função X no ar. Conferi o endereço.\n\n---\n🔴 **DECISÃO:** Aviso o time?\nA) Sim / B) Não';
  const esperado = [CAB('Faro'), 'Publiquei a função X no ar.', '', '*Aviso o time?*', 'A) Sim / B) Não'].join('\n');
  assert.equal(montarResposta(evento({ final })), esperado);
  assert.equal(montarResposta(evento({ final, marcas: DEC })), esperado, 'com ou sem marcas');
  assert.equal(montarResposta(evento({ final: '**Feito**: 12 testes verdes — ok' })), [CAB('Faro'), 'Feito: 12 testes verdes - ok'].join('\n'));
  assert.match(montarResposta(evento({ titulo: null, nome: 'projetos-42' })), /^ℹ️ \*projetos-42\*\nok$/);
});

test('F4g 11. resposta completa (o dono pediu detalhe): texto inteiro limpo, sem a linha de citacao e sem rodape; longo corta 1000 + (...) + 2300', () => {
  const final = '> WhatsApp do Davi (07:50): «detalha»\n🟢 **Feito**: 12 testes verdes — ok\n\n- Mudou o login.\n- Mudou o deploy.';
  assert.equal(montarResposta(evento({ final }), { completo: true }),
    [CAB('Faro'), '*Feito*: 12 testes verdes - ok', '', '- Mudou o login.', '- Mudou o deploy.'].join('\n'));
  const longo = 'INICIO ' + 'x'.repeat(5000) + '\nFIM: 3 arquivos mudados.';
  const r = montarResposta(evento({ final: longo }), { completo: true });
  assert.equal(r, `${CAB('Faro')}\n${longo.slice(0, 1000)}\n(...)\n${longo.slice(-2300)}`);
  const curto = 'z'.repeat(3500);
  assert.equal(montarResposta(evento({ final: curto }), { completo: true }), `${CAB('Faro')}\n${curto}`);
  assert.equal(montarResposta(evento({ final: '' }), { completo: true }), [CAB('Faro'), 'Respondeu sem texto.'].join('\n'));
  assert.equal(montarResposta(evento({ final }), { completo: 'sim' }), montarResposta(evento({ final })), 'so true abre');
});

test('F4g 12. pedeDetalhe: "detalh" em qualquer caixa (detalha, detalhe, detalhes); o resto nao', () => {
  for (const t of ['detalha', 'Detalhe isso pra mim', 'me manda os DETALHES', 'quero detalhado']) assert.equal(pedeDetalhe(t), true, t);
  for (const t of ['publica', 'ok', 'sim, pode', '', null, undefined, 42]) assert.equal(pedeDetalhe(t), false, String(t));
});

test('F4g 13. concluido: cabecalho novo + "Concluído: você respondeu às HH:MM."', () => {
  assert.equal(montarConcluido({ titulo: 'Faro', nome: 'projetos-42' }, '16:03'), `${CAB('Faro')}\nConcluído: você respondeu às 16:03.`);
  assert.equal(montarConcluido({ titulo: null, nome: 'projetos-42' }, '09:05'), `${CAB('projetos-42')}\nConcluído: você respondeu às 09:05.`);
  assert.equal(montarConcluido({}, '25h'), `${CAB('sem nome')}\nConcluído: você respondeu às ??:??.`);
});

// ---------- partesCurtas (T5a, PLANO-TELEGRAM.md: a regra das 2 linhas num lugar so, pro WhatsApp e pro Telegram) ----------

test('T5a 1. partesCurtas: o que aconteceu, a pergunta em partes (forte, resto, opcoes) e o bloco de copiar', () => {
  const dec = '🟢 A função xyz foi finalizada.\n\n---\n🔴 **DECISÃO:** Posso publicar?\nA) Agora (recomendado) / B) Depois';
  assert.deepEqual(partesCurtas(dec), {
    fato: 'A função xyz foi finalizada.',
    pergunta: { forte: 'Posso publicar?', resto: '', opcoes: 'A) Agora (recomendado) / B) Depois' },
    temBloco: false,
  });
  assert.deepEqual(partesCurtas('Deixei pronto.\n\nFica com você, no celular:\n- aprovar no **1Password**\n- abrir o app'), {
    fato: 'Deixei pronto.',
    pergunta: { forte: 'Fica com você, no celular:', resto: 'aprovar no 1Password; abrir o app', opcoes: '' },
    temBloco: false,
  });
  assert.deepEqual(partesCurtas('Terminei o `T2`.\nPosso seguir?'), {
    fato: 'Terminei o `T2`.',
    pergunta: { forte: 'Posso seguir?', resto: '', opcoes: '' },
    temBloco: false,
  });
  assert.deepEqual(partesCurtas('Publiquei a página nova do site. O deploy continua com você.'), {
    fato: 'Publiquei a página nova do site.',
    pergunta: { forte: 'O deploy continua com você.', resto: '', opcoes: '' },
    temBloco: false,
  });
  assert.deepEqual(partesCurtas('Feito. Tudo no ar desde 10h.'), { fato: 'Feito. Tudo no ar desde 10h.', pergunta: null, temBloco: false });
  assert.deepEqual(partesCurtas('```\nprompt pra copiar\n```'), { fato: '', pergunta: null, temBloco: true });
  for (const vazio of ['', null, undefined]) assert.deepEqual(partesCurtas(vazio), { fato: '', pergunta: null, temBloco: false });
});

// T9 (PLANO-TELEGRAM.md, contrato 4; medido 05/10/2026: "Depoimentos (20:11): Pendências da sessão" no pendências): o
// bloco "Pendências da sessão" do fim da mensagem = a pergunta e o item logo abaixo do titulo, nunca o titulo.
test('T9 1. "Pendências da sessão": a pergunta e o item de baixo; 2 itens juntos; DECISAO, "Fica com você" e "?" em texto vem antes; titulo sem item nao vira pergunta', () => {
  const real = 'Deixei o passo a passo anotado no card do evento.\n\n**Pendências da sessão**\n- Horário do dia 17: a página diz "das 8h às 20h", mas você falou em 9h. Troco pra 9h às 19h?';
  assert.deepEqual(partesCurtas(real), {
    fato: 'Deixei o passo a passo anotado no card do evento.',
    pergunta: { forte: 'Horário do dia 17: a página diz "das 8h às 20h", mas você falou em 9h. Troco pra 9h às 19h?', resto: '', opcoes: '' },
    temBloco: false,
  });
  // com dois-pontos, como titulo de markdown e sem negrito: o mesmo
  for (const titulo of ['Pendências da sessão:', '### Pendências da sessão', 'Pendencias da sessao']) {
    const p = partesCurtas(`Feito.\n\n${titulo}\n- Página: troco o vídeo?`).pergunta;
    assert.deepEqual(p, { forte: 'Página: troco o vídeo?', resto: '', opcoes: '' }, titulo);
  }
  assert.equal(
    partesCurtas('Feito.\n\n**Pendências da sessão**\n- Página: troco o vídeo?\n- Live: marco a data?').pergunta.forte,
    'Página: troco o vídeo?; Live: marco a data?',
  );
  // a DECISAO depois do bloco vence (caso real do Ingressos Valley, 05/10/2026 21:42)
  const comDec = 'Pronto.\n\n**Pendências da sessão**\n- Formulário: foi o do Projeto Atlas?\n\n---\n🔴 **DECISÃO:** mando isto à Ana?\nA) Sim / B) Não';
  assert.equal(partesCurtas(comDec).pergunta.forte, 'Mando isto à Ana?');
  // "Fica com você" vence
  assert.equal(partesCurtas('Feito.\n\nFica com você: assinar o termo.\n\n**Pendências da sessão**\n- Live: marco a data?').pergunta.forte, 'Fica com você:');
  // pergunta em texto na ultima linha (sem marcador) = a regra do "?" de sempre
  assert.equal(partesCurtas('Feito.\n\n**Pendências da sessão**\nLive: marco a data?').pergunta.forte, 'Live: marco a data?');
  // titulo sem item embaixo: nao vira pergunta (antes saia "Pendências da sessão")
  assert.deepEqual(partesCurtas('Feito, tudo no ar desde 10h.\n\n**Pendências da sessão**'), {
    fato: 'Feito, tudo no ar desde 10h.', pergunta: null, temBloco: false,
  });
  // o aviso do grupo leva a pergunta de verdade
  assert.equal(montarAviso(evento({ final: real })).split('\n').at(-1), '*Horário do dia 17: a página diz "das 8h às 20h", mas você falou em 9h. Troco pra 9h às 19h?*');
});

test('T9 2. diaBRT: "dd/mm" de Brasilia (independe do fuso do processo); invalido = "??/??"', () => {
  assert.equal(diaBRT('2026-10-06T02:30:00.000Z'), '05/10', '23:30 de Brasilia ainda e dia 05');
  assert.equal(diaBRT('2026-10-06T03:00:00.000Z'), '06/10');
  assert.equal(diaBRT('2026-10-06T00:30:00-03:00'), '06/10');
  for (const ruim of ['', 'ontem', null, undefined, 123]) assert.equal(diaBRT(ruim), '??/??', String(ruim));
});

test('T5a 2. o aviso e a resposta do WhatsApp sao as partesCurtas montadas (cabecalho / fato / linha vazia / *forte* resto / opcoes)', () => {
  const montar = (final, vazio) => {
    const p = partesCurtas(final);
    const linhas = [CAB('Faro')];
    if (p.fato) linhas.push(p.fato);
    if (p.pergunta) {
      if (p.fato) linhas.push('');
      linhas.push(`*${p.pergunta.forte}*${p.pergunta.resto ? ` ${p.pergunta.resto}` : ''}`);
      if (p.pergunta.opcoes) linhas.push(p.pergunta.opcoes);
    }
    if (linhas.length === 1) linhas.push(p.temBloco ? 'Deixou um texto pra copiar.' : vazio);
    return linhas.join('\n');
  };
  const finais = [
    '🟢 A função xyz foi finalizada.\n- **Testes:** 12 verdes.\n\n---\n🔴 **DECISÃO:** Posso publicar?\nA) Publicar agora (recomendado) / B) Esperar a live',
    'Ainda não apareceu nada.\n\nFica com você:\n- Arraste o zip pra pasta. Qualquer pasta serve.\n- Depois me avise aqui.',
    'Fica com você: logar no painel.',
    '> Telegram do Davi (12:50): «pode seguir»\n\nFeito o ajuste. Quer que eu publique?\nA) Sim / B) Não',
    'Mandei pro Dr. Paulo. A resposta continua com você.',
    '## Resumo\n| a | b |\n|---|---|\n| 1 | 2 |',
    '```\nso o bloco\n```',
    '',
    'Pronto.',
  ];
  for (const final of finais) {
    assert.equal(montarAviso(evento({ final })), montar(final, 'Parou esperando você.'), final);
    assert.equal(montarResposta(evento({ final })), montar(final, 'Respondeu sem texto.'), final);
  }
});

