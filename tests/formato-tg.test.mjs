// Testes de lib/formato-tg.mjs (node:test, sem dependencia). Modulo puro: nada de rede nem disco aqui.
// Rodar: node --test --test-reporter=tap "tests/telegram.test.mjs" "tests/formato-tg.test.mjs"
// (no Node 24 a pasta sozinha nao expande)
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  esc,
  mdParaHtml,
  mdParaTexto,
  paraRich,
  lerFinal,
  montarChamado,
  montarSistema,
  montarPainel,
  montarSituacao,
  dadosBotao,
  lerDadosBotao,
  novoIdChamado,
  rotuloBotao,
  ICONE_SISTEMA,
  TITULO_SISTEMA,
} from '../lib/formato-tg.mjs';

const ID = 'ABCDEFGH';
const RE_ID = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;
const MAIS = [{ texto: 'Mais informações', dados: `i:${ID}` }]; // T7c1: no lugar do "Mais contexto" (c:<ID>)

// Texto que o Telegram mostra: sem tags e com as entidades desfeitas (e nele que vale o limite de 4096).
function visivel(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

const FINAL = [
  'Terminei a revisão do `<pid>.json`.',
  '',
  '---',
  '🔴 **DECISÃO:** Faço X? A) Sim, tudo hoje (recomendado) / B) Só as correções',
].join('\n');

const DETALHE_FINAL =
  'Terminei a revisão do <code>&lt;pid&gt;.json</code>.<br><br>━━━━━━━━━━<br>' +
  '🔴 <b>DECISÃO:</b> Faço X? A) Sim, tudo hoje (recomendado) / B) Só as correções';
const QUOTE_FINAL =
  'Terminei a revisão do &lt;pid&gt;.json.\n\n━━━━━━━━━━\n' +
  '🔴 DECISÃO: Faço X? A) Sim, tudo hoje (recomendado) / B) Só as correções';

// ---------- 6. lerFinal ----------

describe('6. lerFinal', () => {
  test('DECISAO na mesma linha: pergunta, opcoes A/B, recomendada; contexto vazio (1o paragrafo ja e o bloco)', () => {
    assert.deepEqual(lerFinal('🔴 **DECISÃO:** Faço X? A) Sim, tudo hoje (recomendado) / B) Só as correções'), {
      tipo: 'decisao',
      contexto: '',
      pergunta: 'Faço X?',
      opcoes: [
        { letra: 'A', texto: 'Sim, tudo hoje (recomendado)', recomendado: true },
        { letra: 'B', texto: 'Só as correções', recomendado: false },
      ],
      fica: [],
    });
    const seis = lerFinal('DECISÃO: Qual? A) a / B) b / C) c / D) d / E) e / F) f');
    assert.deepEqual(seis.opcoes.map((o) => `${o.letra}=${o.texto}`), ['A=a', 'B=b', 'C=c', 'D=d', 'E=e', 'F=f']);
    // NFD (a + til combinante) e caixa mista contam como DECISAO
    const nfd = lerFinal('Decisa\u0303o: Qual? A) um / B) dois');
    assert.equal(nfd.tipo, 'decisao');
    assert.equal(nfd.pergunta, 'Qual?');
    assert.deepEqual(nfd.opcoes.map((o) => o.texto), ['um', 'dois']);
  });

  test('opcoes em linhas separadas (**A)**, "- ", " /" no fim); contexto = 1o paragrafo antes do ---', () => {
    const final = [
      'Terminei a revisão do deploy.',
      'Os testes passaram.',
      '',
      'Detalhe que não entra no contexto.',
      '',
      '---',
      '🔴 **DECISÃO:** Publico hoje?',
      '**A)** Sim, agora (Recomendado)',
      '- **B)** Amanhã cedo /',
      '- **C)** Só semana que vem',
    ].join('\n');
    assert.deepEqual(lerFinal(final), {
      tipo: 'decisao',
      contexto: 'Terminei a revisão do deploy.\nOs testes passaram.',
      pergunta: 'Publico hoje?',
      opcoes: [
        { letra: 'A', texto: 'Sim, agora (Recomendado)', recomendado: true },
        { letra: 'B', texto: 'Amanhã cedo', recomendado: false },
        { letra: 'C', texto: 'Só semana que vem', recomendado: false },
      ],
      fica: [],
    });
  });

  test('linha de citacao do dono (Telegram ou WhatsApp) fica fora do contexto', () => {
    const tg = lerFinal(
      '> Telegram do Davi (12:50): «pode seguir»\n\nFeito o ajuste no porteiro.\n\n' +
        '🔴 **DECISÃO:** Sigo pro T2? A) Sim (recomendado) / B) Não',
    );
    assert.equal(tg.contexto, 'Feito o ajuste no porteiro.');
    assert.equal(tg.pergunta, 'Sigo pro T2?');
    assert.equal(tg.opcoes.length, 2);
    const wpp = lerFinal('> WhatsApp do Davi (09:10): «ok»\nFeito.\n\nFica com você: logar no painel');
    assert.equal(wpp.contexto, 'Feito.');
    assert.equal(wpp.tipo, 'fica');
    assert.deepEqual(wpp.fica, ['logar no painel']);
  });

  test('"Fica com você:" + lista (sem marcador) e o resto da propria linha', () => {
    assert.deepEqual(
      lerFinal('Deixei tudo pronto.\n\n**Fica com você:**\n- aprovar no 1Password\n* abrir o app\n\nDepois eu sigo.'),
      { tipo: 'fica', contexto: 'Deixei tudo pronto.', pergunta: '', opcoes: [], fica: ['aprovar no 1Password', 'abrir o app'] },
    );
    const r = lerFinal('Pronto. Fica com voce: logar no painel.\n- depois conferir o e-mail');
    assert.equal(r.tipo, 'fica');
    assert.deepEqual(r.fica, ['logar no painel.', 'depois conferir o e-mail']);
    assert.equal(r.contexto, '');
  });

  test('pergunta = ultima linha nao vazia terminada em "?", sem markdown; o contexto nao repete a pergunta', () => {
    assert.deepEqual(lerFinal('Terminei o deploy do site.\n**Posso** seguir com o `T2`?\n\n  '), {
      tipo: 'pergunta',
      contexto: 'Terminei o deploy do site.',
      pergunta: 'Posso seguir com o T2?',
      opcoes: [],
      fica: [],
    });
    assert.equal(lerFinal('Tudo certo?\nfeito.').tipo, null); // "?" que nao esta na ultima linha nao conta
  });

  test('sem nada -> tipo null; 1 opcao so ou letras fora de ordem -> opcoes [] e a pergunta continua', () => {
    const vazio = { tipo: null, contexto: '', pergunta: '', opcoes: [], fica: [] };
    assert.deepEqual(lerFinal('Feito. Tudo no ar.'), { ...vazio, contexto: 'Feito. Tudo no ar.' });
    assert.deepEqual(lerFinal(''), vazio);
    assert.deepEqual(lerFinal(null), vazio);
    const uma = lerFinal('🔴 **DECISÃO:** Sigo com o plano? A) Sim');
    assert.equal(uma.tipo, 'decisao');
    assert.deepEqual(uma.opcoes, []);
    assert.equal(uma.pergunta, 'Sigo com o plano? A) Sim');
    const pulo = lerFinal('🔴 DECISÃO: Qual? A) um / C) três');
    assert.deepEqual(pulo.opcoes, []);
    assert.equal(pulo.pergunta, 'Qual? A) um / C) três');
    assert.deepEqual(lerFinal('decisao: B) x / C) y').opcoes, []); // nao comeca no A
  });

  test('DECISAO: a ultima linha de ROTULO vence "decisao" em prosa, em opcao e na linha de risco depois', () => {
    const final = [
      'A decisão de ontem segue valendo.',
      '',
      '---',
      '🔴 **DECISÃO:** Qual caminho?',
      'A) Deixo a decisão pra amanhã (recomendado)',
      'B) Decido agora',
      '⚠️ sem decisão até 18h, sigo com A',
    ].join('\n');
    const r = lerFinal(final);
    assert.equal(r.tipo, 'decisao');
    assert.equal(r.pergunta, 'Qual caminho?');
    assert.deepEqual(r.opcoes, [
      { letra: 'A', texto: 'Deixo a decisão pra amanhã (recomendado)', recomendado: true },
      { letra: 'B', texto: 'Decido agora', recomendado: false },
    ]);
    assert.equal(r.contexto, 'A decisão de ontem segue valendo.');
    // sem rotulo em lugar nenhum: vale a ultima linha que contem a palavra
    const sem = lerFinal('Preciso da sua decisão: A) seguir / B) parar');
    assert.equal(sem.pergunta, 'Preciso da sua decisão');
    assert.deepEqual(sem.opcoes.map((o) => o.texto), ['seguir', 'parar']);
  });

  test('opcoes depois de linha vazia (17 de 1064 blocos reais): o bloco continua; linha vazia antes de B) nao', () => {
    const r = lerFinal('Feito.\n\n🔴 **DECISÃO:** Publico hoje?\n\nA) Sim (recomendado)\nB) Amanhã');
    assert.equal(r.tipo, 'decisao');
    assert.equal(r.pergunta, 'Publico hoje?');
    assert.deepEqual(r.opcoes.map((o) => `${o.letra}=${o.texto}`), ['A=Sim (recomendado)', 'B=Amanhã']);
    assert.equal(r.opcoes[0].recomendado, true);
    assert.equal(r.contexto, 'Feito.');
    const mesma = lerFinal('🔴 **DECISÃO:** Qual?\n\n\n**A)** um / **B)** dois');
    assert.deepEqual(mesma.opcoes.map((o) => o.texto), ['um', 'dois']);
    const texto = lerFinal('🔴 **DECISÃO:** Qual caminho?\nPesa o prazo.\n\nA) um / B) dois');
    assert.equal(texto.pergunta, 'Qual caminho? Pesa o prazo.');
    assert.equal(texto.opcoes.length, 2);
    // linha vazia e depois algo que nao abre em A): fica como estava (sem botoes)
    const b = lerFinal('🔴 **DECISÃO:** Sigo? A) Sim\n\nB) Não');
    assert.deepEqual(b.opcoes, []);
    assert.equal(b.pergunta, 'Sigo? A) Sim');
    const nada = lerFinal('🔴 **DECISÃO:** Sigo?\n\nDepois eu vejo.');
    assert.deepEqual(nada.opcoes, []);
    assert.equal(nada.pergunta, 'Sigo?');
  });

  test('contexto: no maximo 3 linhas e 400 caracteres, cortado com "..."', () => {
    assert.equal(lerFinal('l1\nl2\nl3\nl4\nl5\n\nFica com você: x').contexto, 'l1\nl2\nl3...');
    const r = lerFinal(`${'y'.repeat(600)}\n\n🔴 DECISÃO: Sigo? A) Sim / B) Não`);
    assert.equal(r.contexto, `${'y'.repeat(397)}...`);
    assert.equal(Array.from(r.contexto).length, 400);
  });
});

// ---------- 7. montarChamado ----------

describe('7. montarChamado', () => {
  const base = { titulo: 'Faro', chamadoId: ID };

  // T5a (F4g no Telegram): ℹ️ + nome / a 1a frase do que aconteceu / a pergunta em negrito (as mesmas partesCurtas do
  // WhatsApp); sem "Parou às"/"Respondeu às"; botoes e mensagem completa recolhida como antes.
  test('aviso: ℹ️ + nome, o que aconteceu, a pergunta em negrito, a mensagem completa recolhida; escape do <pid>.json; botoes (success na recomendada, Mais contexto por ultimo)', () => {
    const c = montarChamado({ ...base, estado: 'aviso', hora: '12:45', final: FINAL });
    // T7c1: a mensagem completa sai do chamado (sem <details> e sem <blockquote expandable>)
    assert.equal(
      c.html,
      '<h2>ℹ️ Faro</h2>' +
        '<p>Terminei a revisão do <code>&lt;pid&gt;.json</code>.</p>' +
        '<p><b>Faço X?</b></p>',
    );
    assert.equal(
      c.classico,
      '<b>ℹ️ Faro</b>\n' +
        'Terminei a revisão do <code>&lt;pid&gt;.json</code>.\n\n' +
        '<b>Faço X?</b>',
    );
    assert.deepEqual(c.botoes, [
      [{ texto: 'A) Sim, tudo hoje (recomendado)', dados: `o:${ID}:0`, estilo: 'success' }],
      [{ texto: 'B) Só as correções', dados: `o:${ID}:1`, estilo: undefined }],
      MAIS,
    ]);
    assert.ok(!c.html.includes('<pid>') && !c.classico.includes('<pid>'));
    assert.ok(!/Parou às|Respondeu às|12:45/.test(c.html + c.classico), 'sem a linha da hora');
  });

  test('resposta = aviso (a hora o Telegram ja mostra); fica, pergunta e a frase do que esta com ele; sem opcoes = so Mais contexto', () => {
    const aviso = montarChamado({ ...base, estado: 'aviso', hora: '12:45', final: FINAL });
    const resp = montarChamado({ ...base, estado: 'resposta', hora: '12:47', final: FINAL });
    assert.equal(resp.html, aviso.html);
    assert.equal(resp.classico, aviso.classico);
    assert.deepEqual(resp.botoes, aviso.botoes);

    const fica = montarChamado({
      ...base,
      estado: 'aviso',
      hora: '09:00',
      final: 'Deixei tudo pronto.\n\nFica com você:\n- aprovar no **1Password**\n- abrir o app',
    });
    // T7c1: sem a mensagem completa recolhida (<details> / <blockquote expandable>) no aviso e na resposta
    assert.equal(fica.html, '<h2>ℹ️ Faro</h2><p>Deixei tudo pronto.</p><p><b>Fica com você:</b> aprovar no 1Password; abrir o app</p>');
    assert.equal(fica.classico, '<b>ℹ️ Faro</b>\nDeixei tudo pronto.\n\n<b>Fica com você:</b> aprovar no 1Password; abrir o app');
    assert.deepEqual(fica.botoes, [MAIS]);

    const perg = montarChamado({ ...base, estado: 'aviso', hora: '09:00', final: 'Terminei.\nPosso seguir?' });
    assert.equal(perg.html, '<h2>ℹ️ Faro</h2><p>Terminei.</p><p><b>Posso seguir?</b></p>');
    assert.deepEqual(perg.botoes, [MAIS]);

    const comEle = montarChamado({ ...base, estado: 'aviso', final: 'Publiquei a página nova do site. O deploy continua com você.' });
    assert.equal(comEle.html, '<h2>ℹ️ Faro</h2><p>Publiquei a página nova do site.</p><p><b>O deploy continua com você.</b></p>');

    // so o fato (sem pergunta) e so a pergunta (sem fato): 1 paragrafo; no classico a pergunta cola no titulo, como no WhatsApp
    const soFato = montarChamado({ ...base, estado: 'resposta', final: 'Feito. Tudo no ar desde 10h.' });
    assert.equal(soFato.html, '<h2>ℹ️ Faro</h2><p>Feito. Tudo no ar desde 10h.</p>');
    const soPergunta = montarChamado({ ...base, estado: 'aviso', final: '🔴 **DECISÃO:** Sigo? A) Sim / B) Não' });
    assert.equal(soPergunta.html, '<h2>ℹ️ Faro</h2><p><b>Sigo?</b></p>');
    assert.equal(soPergunta.classico, '<b>ℹ️ Faro</b>\n<b>Sigo?</b>');
  });

  test('opcoes que nao viram botao (1 so, letras fora de ordem) saem em texto embaixo da pergunta; as que viram botao, nao', () => {
    const uma = montarChamado({ ...base, estado: 'aviso', final: 'Revisei o plano.\n\n🔴 **DECISÃO:** Sigo com o plano? A) Sim' });
    // T7c1: sem a mensagem completa recolhida
    assert.equal(uma.html, '<h2>ℹ️ Faro</h2><p>Revisei o plano.</p><p><b>Sigo com o plano?</b><br>A) Sim</p>');
    assert.equal(uma.classico, '<b>ℹ️ Faro</b>\nRevisei o plano.\n\n<b>Sigo com o plano?</b>\nA) Sim');
    assert.deepEqual(uma.botoes, [MAIS]);
    const pulo = montarChamado({ ...base, estado: 'aviso', final: '🔴 DECISÃO: Qual? A) um / C) três' });
    assert.ok(pulo.html.startsWith('<h2>ℹ️ Faro</h2><p><b>Qual?</b><br>A) um / C) três</p>'), pulo.html);
    const esc = montarChamado({ ...base, estado: 'aviso', final: 'Revisei.\n\n🔴 **DECISÃO:** Apago o `<pid>.json` & sigo? A) Sim / B) Não' });
    assert.ok(esc.html.includes('<p><b>Apago o &lt;pid&gt;.json &amp; sigo?</b></p>'), esc.html);
    // T7c1: sem o <blockquote expandable> depois, a pergunta e a ultima linha do classico
    assert.ok(esc.classico.endsWith('\n<b>Apago o &lt;pid&gt;.json &amp; sigo?</b>'), 'a pergunta em texto puro escapado');
    const doisBotoes = montarChamado({ ...base, estado: 'aviso', final: FINAL });
    assert.ok(!doisBotoes.html.split('<details>')[0].includes('A) Sim'), 'com botao a linha das opcoes nao sai');
    assert.ok(!doisBotoes.classico.split('<blockquote')[0].includes('A) Sim'));
  });

  test('sem nada pra mostrar: "Parou esperando você." / "Respondeu sem texto." / "Deixou um texto pra copiar."', () => {
    // T7c1: sem final nao ha o que abrir nem opcao = sem botao nenhum (null)
    assert.deepEqual(montarChamado({ ...base, estado: 'aviso', hora: '09:00', final: '' }), {
      html: '<h2>ℹ️ Faro</h2><p>Parou esperando você.</p>',
      classico: '<b>ℹ️ Faro</b>\nParou esperando você.',
      botoes: null,
    });
    assert.deepEqual(montarChamado({ ...base, estado: 'resposta', hora: '09:00' }), {
      html: '<h2>ℹ️ Faro</h2><p>Respondeu sem texto.</p>',
      classico: '<b>ℹ️ Faro</b>\nRespondeu sem texto.',
      botoes: null,
    });
    // T7c1: o texto pra copiar sai do chamado (so no Mais informações)
    const bloco = montarChamado({ ...base, estado: 'resposta', final: '```\nprompt pra copiar\n```' });
    assert.equal(bloco.html, '<h2>ℹ️ Faro</h2><p>Deixou um texto pra copiar.</p>');
    assert.ok(!bloco.html.includes('<pre><code>prompt pra copiar</code></pre>'), 'o texto pra copiar so aparece no Mais informações');
    assert.equal(bloco.classico, '<b>ℹ️ Faro</b>\nDeixou um texto pra copiar.');
    assert.deepEqual(bloco.botoes, [MAIS]);
  });

  test('resposta completa (ele pediu detalhe): o texto inteiro aberto, sem as 2 linhas e sem recolher; botoes iguais; so na resposta e so com true', () => {
    const c = montarChamado({ ...base, estado: 'resposta', final: FINAL, completo: true });
    assert.equal(c.html, `<h2>ℹ️ Faro</h2><p>${DETALHE_FINAL}</p>`);
    assert.equal(c.classico, `<b>ℹ️ Faro</b>\n\n${QUOTE_FINAL}`);
    // T7c1: aberto = os botoes das opcoes, sem o Mais informações (a ultima linha do curto)
    assert.deepEqual(c.botoes, montarChamado({ ...base, estado: 'resposta', final: FINAL }).botoes.slice(0, -1));
    const comLinha = montarChamado({ ...base, estado: 'resposta', final: `> Telegram do Davi (12:50): «detalha»\n\n${FINAL}`, completo: true });
    assert.equal(comLinha.html, c.html, 'sem a linha de citacao do dono, como no WhatsApp');
    assert.equal(comLinha.classico, c.classico);
    assert.deepEqual(montarChamado({ ...base, estado: 'resposta', final: '', completo: true }), {
      html: '<h2>ℹ️ Faro</h2><p>Respondeu sem texto.</p>',
      classico: '<b>ℹ️ Faro</b>\nRespondeu sem texto.',
      botoes: null,
    });
    const curto = montarChamado({ ...base, estado: 'resposta', final: FINAL });
    assert.deepEqual(montarChamado({ ...base, estado: 'resposta', final: FINAL, completo: 'sim' }), curto, 'so true abre');
    // T7c1: `completo: true` vale tambem no aviso (o toque em Mais informações abre o aviso)
    assert.deepEqual(montarChamado({ ...base, estado: 'aviso', final: FINAL, completo: true }), c, 'o aviso tambem abre');
  });

  test('enviando, entregue e contexto: textos exatos; fala em 1 linha ate 300 code points; audio', () => {
    const env = montarChamado({ ...base, estado: 'enviando', hora: '12:50', fala: 'A) Azul' });
    assert.deepEqual(env, {
      html: '<h2>ℹ️ Faro</h2><p>Você respondeu às 12:50: «A) Azul»</p><p><i>Passando pra aba.</i></p>',
      classico: '<b>ℹ️ Faro</b>\nVocê respondeu às 12:50: «A) Azul»\n<i>Passando pra aba.</i>',
      botoes: null,
    });
    const aud = montarChamado({ ...base, estado: 'enviando', hora: '12:50', fala: 'manda bala', audio: true });
    assert.equal(aud.html, '<h2>ℹ️ Faro</h2><p>Você disse (áudio) às 12:50: «manda bala»</p><p><i>Passando pra aba.</i></p>');
    const ent = montarChamado({ ...base, estado: 'entregue', hora: '12:50', horaEntrega: '12:51', fala: 'A) Azul' });
    assert.deepEqual(ent, {
      html: '<h2>ℹ️ Faro</h2><p>Você respondeu às 12:50: «A) Azul»</p><p><i>Entregue na aba às 12:51. Aguardando a resposta.</i></p>',
      classico: '<b>ℹ️ Faro</b>\nVocê respondeu às 12:50: «A) Azul»\n<i>Entregue na aba às 12:51. Aguardando a resposta.</i>',
      botoes: null,
    });
    const ctx = montarChamado({ ...base, estado: 'contexto', hora: '2026-09-29T15:52:00Z' }); // ISO vira HH:MM de Brasilia
    assert.deepEqual(ctx, {
      html: '<h2>ℹ️ Faro</h2><p>Você pediu mais contexto às 12:52.</p><p><i>Passando pra aba.</i></p>',
      classico: '<b>ℹ️ Faro</b>\nVocê pediu mais contexto às 12:52.\n<i>Passando pra aba.</i>',
      botoes: null,
    });
    const longa = montarChamado({ ...base, estado: 'enviando', hora: '12:50', fala: `a\nb <pid>.json ${'x'.repeat(400)}` });
    const fala = /«(.*)»/.exec(visivel(longa.html))[1];
    assert.equal(Array.from(fala).length, 300);
    assert.ok(fala.startsWith('a b <pid>.json x') && fala.endsWith('...') && !fala.includes('\n'));
    assert.ok(longa.html.includes('«a b &lt;pid&gt;.json x'));
  });

  test('problema, encerrado e movido: textos exatos; titulo limpo em 1 linha, ate 80, "sem nome" se vazio', () => {
    const frase = 'A aba <pid> não está mais aberta.';
    assert.deepEqual(montarChamado({ ...base, estado: 'problema', hora: '12:50', fala: 'oi', frase }), {
      html: '<h2>ℹ️ Faro</h2><p>Você respondeu às 12:50: «oi»</p><p>A aba &lt;pid&gt; não está mais aberta.</p>',
      classico: '<b>ℹ️ Faro</b>\nVocê respondeu às 12:50: «oi»\nA aba &lt;pid&gt; não está mais aberta.',
      botoes: null,
    });
    assert.equal(montarChamado({ ...base, estado: 'problema', frase }).html, '<h2>ℹ️ Faro</h2><p>A aba &lt;pid&gt; não está mais aberta.</p>');
    assert.deepEqual(montarChamado({ ...base, estado: 'encerrado', hora: '13:00', motivo: 'whatsapp', final: 'Feito.' }), {
      html: '<h2>ℹ️ Faro</h2><p><i>Encerrada às 13:00: você respondeu pelo WhatsApp.</i></p>' +
        '<details><summary>Mensagem completa</summary><p>Feito.</p></details>',
      classico: '<b>ℹ️ Faro</b>\n<i>Encerrada às 13:00: você respondeu pelo WhatsApp.</i>\n\n<blockquote expandable>Feito.</blockquote>',
      botoes: null,
    });
    assert.deepEqual(montarChamado({ ...base, estado: 'encerrado', hora: '13:00', motivo: 'pc' }), {
      html: '<h2>ℹ️ Faro</h2><p><i>Encerrada às 13:00: a aba seguiu no PC.</i></p>',
      classico: '<b>ℹ️ Faro</b>\n<i>Encerrada às 13:00: a aba seguiu no PC.</i>',
      botoes: null,
    });
    assert.deepEqual(montarChamado({ ...base, estado: 'movido' }), {
      html: '<p><b>ℹ️ Faro</b>: chamado movido pra baixo.</p>',
      classico: '<b>ℹ️ Faro</b>: chamado movido pra baixo.',
      botoes: null,
    });
    // o movido da mensagem do sistema leva o icone dela (pedido do dono: o titulo e depois o icone 🎛️); vazio = o ICONE
    assert.deepEqual(montarChamado({ estado: 'movido', titulo: TITULO_SISTEMA, icone: ICONE_SISTEMA }), {
      html: '<p><b>🎛️ Controle de Sessões</b>: chamado movido pra baixo.</p>',
      classico: '<b>🎛️ Controle de Sessões</b>: chamado movido pra baixo.',
      botoes: null,
    });
    assert.equal(montarChamado({ ...base, estado: 'movido', icone: '' }).classico, '<b>ℹ️ Faro</b>: chamado movido pra baixo.');
    const t = (titulo) => /^<p><b>ℹ️ (.*)<\/b>: chamado/.exec(montarChamado({ estado: 'movido', titulo }).html)[1];
    assert.equal(t('  **Aba\nnova**  '), 'Aba nova');
    assert.equal(t('  '), 'sem nome');
    assert.equal(t(undefined), 'sem nome');
    assert.equal(t('<pid>.json'), '&lt;pid&gt;.json');
    const longo = t('x'.repeat(100));
    assert.equal(Array.from(longo).length, 80);
    assert.ok(longo.endsWith('…'));
    for (const estado of ['aviso', 'resposta', 'enviando', 'entregue', 'contexto', 'problema', 'encerrado']) {
      assert.ok(montarChamado({ ...base, estado, hora: '10:00', fala: 'x', frase: 'y', final: FINAL }).html.startsWith('<h2>ℹ️ '), estado);
    }
    assert.throws(() => montarChamado({ ...base, estado: 'outro' }), TypeError);
  });

  test('final de 20 mil: details com cabeca 4000 + "(...)" + cauda 8000; classico <= 4096 visiveis', () => {
    const cabeca = `INICIO ${'a<b>&c '.repeat(1000)}`;
    const final = `${cabeca}${'z'.repeat(20000 - cabeca.length)}\n\n🔴 **DECISÃO:** Faço X? A) Sim / B) Não`;
    const cps = Array.from(final);
    const cortado = `${cps.slice(0, 4000).join('')}\n(...)\n${cps.slice(-8000).join('')}`;
    // T7c1: o aviso e a resposta nao levam mais a mensagem completa (so o encerrado guarda o recolhido)
    for (const estado of ['aviso', 'resposta']) {
      const c = montarChamado({ ...base, estado, hora: '10:00', final });
      assert.ok(!c.html.includes('<details>') && !c.classico.includes('<blockquote'), estado);
      assert.ok(visivel(c.classico).length <= 4096, estado);
    }
    for (const estado of ['encerrado']) {
      const c = montarChamado({ ...base, estado, hora: '10:00', final });
      assert.ok(c.html.includes(`<details><summary>Mensagem completa</summary><p>${paraRich(mdParaHtml(cortado))}</p></details>`), estado);
      assert.ok(c.html.includes('<br>(...)<br>'), estado);
      assert.ok(c.html.endsWith('Faço X? A) Sim / B) Não</p></details>'), estado);
      const v = visivel(c.classico).length;
      assert.ok(v <= 4096, `${estado}: ${v} visiveis`);
      assert.ok(v > 4000, `${estado}: sobrou espaco demais (${v})`);
      assert.ok(c.classico.includes('\n(...)\n'), estado);
      assert.ok(c.classico.endsWith('Faço X? A) Sim / B) Não</blockquote>'), estado);
      assert.ok(!c.classico.includes('<b>&c') && c.classico.includes('&lt;b&gt;&amp;c'), estado);
    }
    // T5a: resposta completa (aberta) tambem cabe: rich com o mesmo corte, classico <= 4096 visiveis, sem blockquote
    const aberta = montarChamado({ ...base, estado: 'resposta', hora: '10:00', final, completo: true });
    assert.equal(aberta.html, `<h2>ℹ️ Faro</h2><p>${paraRich(mdParaHtml(cortado))}</p>`);
    const va = visivel(aberta.classico).length;
    assert.ok(va <= 4096 && va > 4000, `aberta: ${va} visiveis`);
    assert.ok(aberta.classico.includes('\n(...)\n') && !aberta.classico.includes('<blockquote'), 'aberta');
    assert.ok(aberta.classico.endsWith('Faço X? A) Sim / B) Não'), 'aberta: a DECISAO fica no fim');
    // ate 12000 code points o final vai inteiro
    const doze = montarChamado({ ...base, estado: 'encerrado', hora: '10:00', final: 'q'.repeat(12000) });
    assert.ok(!doze.html.includes('(...)'));
    assert.ok(montarChamado({ ...base, estado: 'encerrado', hora: '10:00', final: 'q'.repeat(12001) }).html.includes('(...)'));
  });
});

// ---------- 8. botoes, rich e sistema ----------

describe('8. dadosBotao, rotuloBotao, paraRich e montarSistema', () => {
  test('dadosBotao/lerDadosBotao: ida e volta, <= 64 bytes, lixo -> null, entrada invalida -> TypeError', () => {
    for (let i = 0; i <= 9; i++) {
      const d = dadosBotao({ chamadoId: ID, acao: 'opcao', indice: i });
      assert.equal(d, `o:${ID}:${i}`);
      assert.ok(Buffer.byteLength(d, 'utf8') <= 64);
      assert.deepEqual(lerDadosBotao(d), { acao: 'opcao', chamadoId: ID, indice: i });
    }
    // T7c1: Mais informações = i:<ID>; o c:<ID> (legado do "Mais contexto") le como informacoes; acao 'contexto' saiu
    assert.equal(dadosBotao({ chamadoId: ID, acao: 'informacoes' }), `i:${ID}`);
    assert.deepEqual(lerDadosBotao(`c:${ID}`), { acao: 'informacoes', chamadoId: ID });
    for (const lixo of [
      `o:${ID}:10`, `o:${ID}`, `c:${ID}:1`, `x:${ID}`, ` c:${ID}`, `c:${ID}\n`, 'c:abcdefgh', 'c:ABCDEFGI', 'c:ABCDEFG',
      '', null, undefined, 5, {},
    ]) {
      assert.equal(lerDadosBotao(lixo), null, String(lixo));
    }
    for (const ruim of [
      { chamadoId: 'abcdefgh', acao: 'opcao', indice: 0 },
      { chamadoId: 'ABCDEFGI', acao: 'contexto' },
      { chamadoId: ID, acao: 'opcao', indice: 10 },
      { chamadoId: ID, acao: 'opcao', indice: -1 },
      { chamadoId: ID, acao: 'opcao', indice: 1.5 },
      { chamadoId: ID, acao: 'opcao' },
      { chamadoId: ID, acao: 'outra' },
      { chamadoId: ID, acao: 'contexto' },
      {},
    ]) {
      assert.throws(() => dadosBotao(ruim), TypeError, JSON.stringify(ruim));
    }
    const id = novoIdChamado();
    assert.match(id, RE_ID);
    assert.notEqual(novoIdChamado(), id); // 31^8 combinacoes: repetir seria defeito
    const fixo = (v) => ({ getRandomValues: (a) => a.fill(v) });
    assert.equal(novoIdChamado(fixo(0)), 'AAAAAAAA');
    assert.equal(novoIdChamado(fixo(30)), '99999999');
  });

  test('rotuloBotao corta em 40 code points com "…"', () => {
    assert.equal(rotuloBotao('B', 'curto'), 'B) curto');
    const r = rotuloBotao('A', 'x'.repeat(50));
    assert.equal(Array.from(r).length, 40);
    assert.equal(r, `A) ${'x'.repeat(36)}…`);
    const e = rotuloBotao('C', '🔴'.repeat(45));
    assert.equal(Array.from(e).length, 40);
    assert.ok(e.endsWith('…'));
  });

  test('paraRich: \\n vira <br> fora de <pre> e fica dentro; copia do tgfmt converte e escapa', () => {
    assert.equal(
      paraRich('a\nb<pre><code>x\ny</code></pre>c\nd'),
      'a<br>b<pre><code>x\ny</code></pre>c<br>d',
    );
    assert.equal(paraRich(mdParaHtml('um\n```js\nx\ny\n```\ndois')), 'um<br><pre><code class="language-js">x\ny</code></pre><br>dois');
    assert.equal(mdParaHtml('**a** `<b>` & c'), '<b>a</b> <code>&lt;b&gt;</code> &amp; c');
    assert.equal(mdParaTexto('**a** `x` [site](https://e.com)'), 'a x site (https://e.com)');
    assert.equal(esc('<a> & "b"'), '&lt;a&gt; &amp; "b"');
  });

  test('T15 1. montarSistema mostra SO a ultima linha (o "Voltei" = "Modo rua desligado." e pronto, sem as velhas), escapa e quebra linha', () => {
    const linhas = [
      { hora: '10:00', texto: 'um' },
      { hora: '10:01', texto: 'O pedido de OK se responde nos botões Sim e Não da mensagem dele.' },
      { hora: '10:02', texto: 'tres\nlinhas <x>' },
    ];
    assert.deepEqual(montarSistema(linhas), {
      html: '<h3>🎛️ Controle de Sessões</h3><p>10:02 tres<br>linhas &lt;x&gt;</p>',
      classico: '<b>🎛️ Controle de Sessões</b>\n10:02 tres\nlinhas &lt;x&gt;',
    });
    assert.deepEqual(montarSistema([...linhas, { hora: '11:25', texto: 'Modo rua desligado.' }]), {
      html: '<h3>🎛️ Controle de Sessões</h3><p>11:25 Modo rua desligado.</p>',
      classico: '<b>🎛️ Controle de Sessões</b>\n11:25 Modo rua desligado.',
    });
    assert.deepEqual(montarSistema([]), { html: '<h3>🎛️ Controle de Sessões</h3>', classico: '<b>🎛️ Controle de Sessões</b>' });
  });
});

// T7d2b (PLANO-T7.md, T7d2, teste 22): a resposta do "pendências" (ate ~3400 cp) sai inteira no Telegram. A ULTIMA
// linha ate 3500 cp. T15 (08/10/2026): so a ultima aparece (antes: as anteriores ate 1000 e as velhas saiam acima de 3900).
describe('T7d2b 22. montarSistema: a ultima linha ate 3500 cp (T15: as anteriores nunca aparecem)', () => {
  const CAB_SIS = '<b>🎛️ Controle de Sessões</b>';
  const base = '- Aba (12:01): Posso <apagar> & seguir? ação ';
  const ultima = base.repeat(Math.ceil(3000 / base.length)).slice(0, 3000); // 3000 cp (tudo no BMP)

  test('ultima linha de 3000 cp sai inteira (escapada); as 2 velhas de 1500 nao cabem com ela e saem; o classico cabe em 4096', () => {
    assert.equal(Array.from(ultima).length, 3000);
    const r = montarSistema([
      { hora: '10:00', texto: 'a'.repeat(1500) },
      { hora: '10:01', texto: 'b'.repeat(1500) },
      { hora: '10:02', texto: ultima },
    ]);
    assert.equal(r.classico, `${CAB_SIS}\n10:02 ${esc(ultima)}`);
    assert.equal(r.html, `<h3>🎛️ Controle de Sessões</h3><p>10:02 ${esc(ultima)}</p>`);
    assert.ok(visivel(r.classico).length <= 4096, String(visivel(r.classico).length));
  });

  test('a ultima com quebras de linha (o "pendências") sai inteira: \\n no classico, <br> no html', () => {
    const lista = ['- Alfa (12:01): Posso seguir?', `- Bravo (12:02): ${'x'.repeat(2500)}`, '(e mais 2)'].join('\n');
    const r = montarSistema([{ hora: '10:00', texto: 'Modo rua ligado.' }, { hora: '10:01', texto: lista }]);
    assert.equal(r.classico, `${CAB_SIS}\n10:01 ${lista}`);
    assert.equal(r.html, `<h3>🎛️ Controle de Sessões</h3><p>10:01 ${lista.replace(/\n/g, '<br>')}</p>`);
  });

  test('ultima linha de 5000 cp = cortada em 3500; a curta de antes nao aparece; o classico cabe em 4096', () => {
    const r = montarSistema([{ hora: '10:00', texto: 'um' }, { hora: '10:01', texto: 'c'.repeat(5000) }]);
    assert.equal(r.classico, `${CAB_SIS}\n10:01 ${'c'.repeat(3497)}...`);
    assert.ok(visivel(r.classico).length <= 4096, String(visivel(r.classico).length));
  });

  test('visivel conta a entidade desfeita: 3000 "&" na ultima (15000 no html) cabem; nenhuma linha velha entra acima de 3900', () => {
    const r = montarSistema([{ hora: '10:00', texto: 'z'.repeat(900) }, { hora: '10:01', texto: '&'.repeat(3000) }]);
    assert.equal(r.classico, `${CAB_SIS}\n10:01 ${'&amp;'.repeat(3000)}`);
    assert.ok(visivel(r.classico).length <= 3900, String(visivel(r.classico).length));
  });
});

// ---------- T7c1 (PLANO-T7.md, "### T7c1"): Mais informações no formato ----------
// F3/F4 (pedido do dono): no aviso e na resposta, so as 2 linhas + os botoes das opcoes e, embaixo, "Mais
// informações" (dados i:<ID8>); o texto inteiro sai do chamado (nada de <details> nem <blockquote expandable>) e so
// aparece aberto (`completo: true`, no aviso e na resposta), sem o Mais informações. O encerrado continua recolhido.
const INFO = [{ texto: 'Mais informações', dados: `i:${ID}` }];
const BOTOES_FINAL = [
  [{ texto: 'A) Sim, tudo hoje (recomendado)', dados: `o:${ID}:0`, estilo: 'success' }],
  [{ texto: 'B) Só as correções', dados: `o:${ID}:1`, estilo: undefined }],
];
const CURTO_HTML = '<h2>ℹ️ Faro</h2><p>Terminei a revisão do <code>&lt;pid&gt;.json</code>.</p><p><b>Faço X?</b></p>';
const CURTO_CLASSICO = '<b>ℹ️ Faro</b>\nTerminei a revisão do <code>&lt;pid&gt;.json</code>.\n\n<b>Faço X?</b>';
const DETALHE = 'Detalhe que só sai em Mais informações.';
const FINAL_LONGO = [
  'Terminei a revisão do `<pid>.json`.',
  '',
  DETALHE,
  '',
  '---',
  '🔴 **DECISÃO:** Faço X? A) Sim, tudo hoje (recomendado) / B) Só as correções',
].join('\n');
function semRecolher(c, rotulo) {
  for (const s of [c.html, c.classico]) {
    assert.ok(!s.includes('<details') && !s.includes('Mensagem completa'), `${rotulo}: sem <details>`);
    assert.ok(!s.includes('<blockquote'), `${rotulo}: sem <blockquote> (nem o expandable)`);
  }
}

describe('T7c1: Mais informações no formato (aviso e resposta compactos; aberto so com completo)', () => {
  const base = { titulo: 'Faro', chamadoId: ID };

  test('T7c1 39. aviso com DECISÃO: as 2 linhas sem <details> nem <blockquote expandable>; botoes A (success), B e Mais informações i:<ID> na ultima linha', () => {
    const c = montarChamado({ ...base, estado: 'aviso', hora: '12:45', final: FINAL });
    assert.deepEqual(c, { html: CURTO_HTML, classico: CURTO_CLASSICO, botoes: [...BOTOES_FINAL, INFO] });
    semRecolher(c, 'aviso');
    const longo = montarChamado({ ...base, estado: 'aviso', hora: '12:45', final: FINAL_LONGO });
    assert.deepEqual(longo, { html: CURTO_HTML, classico: CURTO_CLASSICO, botoes: [...BOTOES_FINAL, INFO] });
    semRecolher(longo, 'aviso longo');
    assert.ok(!longo.html.includes('Detalhe que') && !longo.classico.includes('Detalhe que'), 'o resto do texto fica fora do chamado');
    // a resposta com DECISAO sai igual ao aviso
    assert.deepEqual(montarChamado({ ...base, estado: 'resposta', hora: '12:47', final: FINAL_LONGO }), longo);
    // Mais informacoes: 1 so, sozinho na ultima linha; nada do "Mais contexto" nem do c:
    assert.equal(longo.botoes.flat().filter((b) => b.texto === 'Mais informações').length, 1);
    assert.deepEqual(longo.botoes.at(-1), INFO);
    assert.ok(!JSON.stringify(longo.botoes).includes('Mais contexto') && !JSON.stringify(longo.botoes).includes('"c:'));
  });

  test('T7c1 40. resposta sem opcoes = fato + pergunta e [[Mais informações]]; sem final = botoes null; opcoes em texto so quando nenhuma virou botao', () => {
    const perg = montarChamado({ ...base, estado: 'resposta', hora: '09:00', final: 'Terminei.\nPosso seguir?' });
    assert.deepEqual(perg, {
      html: '<h2>ℹ️ Faro</h2><p>Terminei.</p><p><b>Posso seguir?</b></p>',
      classico: '<b>ℹ️ Faro</b>\nTerminei.\n\n<b>Posso seguir?</b>',
      botoes: [INFO],
    });
    semRecolher(perg, 'resposta sem opcoes');
    const fica = montarChamado({ ...base, estado: 'aviso', final: 'Deixei tudo pronto.\n\nFica com você:\n- aprovar no **1Password**\n- abrir o app' });
    assert.deepEqual(fica, {
      html: '<h2>ℹ️ Faro</h2><p>Deixei tudo pronto.</p><p><b>Fica com você:</b> aprovar no 1Password; abrir o app</p>',
      classico: '<b>ℹ️ Faro</b>\nDeixei tudo pronto.\n\n<b>Fica com você:</b> aprovar no 1Password; abrir o app',
      botoes: [INFO],
    });
    assert.deepEqual(montarChamado({ ...base, estado: 'resposta', final: 'Feito. Tudo no ar desde 10h.' }).botoes, [INFO], 'so o fato tambem abre');
    const bloco = montarChamado({ ...base, estado: 'resposta', final: '```\nprompt pra copiar\n```' });
    assert.deepEqual(bloco, {
      html: '<h2>ℹ️ Faro</h2><p>Deixou um texto pra copiar.</p>',
      classico: '<b>ℹ️ Faro</b>\nDeixou um texto pra copiar.',
      botoes: [INFO],
    }, 'o texto pra copiar so aparece no Mais informações');
    // sem final: nada pra abrir e nenhuma opcao = sem botao nenhum
    assert.deepEqual(montarChamado({ ...base, estado: 'resposta', hora: '09:00' }), {
      html: '<h2>ℹ️ Faro</h2><p>Respondeu sem texto.</p>', classico: '<b>ℹ️ Faro</b>\nRespondeu sem texto.', botoes: null,
    });
    assert.deepEqual(montarChamado({ ...base, estado: 'aviso', final: '  \n ' }), {
      html: '<h2>ℹ️ Faro</h2><p>Parou esperando você.</p>', classico: '<b>ℹ️ Faro</b>\nParou esperando você.', botoes: null,
    });
    // final que e so a linha de citacao do dono: nada pra abrir (o aberto tira essa linha) = sem botao
    assert.equal(montarChamado({ ...base, estado: 'resposta', final: '> Telegram do Davi (12:50): «oi»' }).botoes, null);
    // 1 opcao so ou letras fora de ordem (nao viram botao): a linha das opcoes sai em texto; com botoes, nao
    assert.deepEqual(montarChamado({ ...base, estado: 'aviso', final: 'Revisei o plano.\n\n🔴 **DECISÃO:** Sigo com o plano? A) Sim' }), {
      html: '<h2>ℹ️ Faro</h2><p>Revisei o plano.</p><p><b>Sigo com o plano?</b><br>A) Sim</p>',
      classico: '<b>ℹ️ Faro</b>\nRevisei o plano.\n\n<b>Sigo com o plano?</b>\nA) Sim',
      botoes: [INFO],
    });
    assert.deepEqual(montarChamado({ ...base, estado: 'resposta', final: '🔴 DECISÃO: Qual? A) um / C) três' }), {
      html: '<h2>ℹ️ Faro</h2><p><b>Qual?</b><br>A) um / C) três</p>',
      classico: '<b>ℹ️ Faro</b>\n<b>Qual?</b>\nA) um / C) três',
      botoes: [INFO],
    });
    for (const estado of ['aviso', 'resposta']) {
      const dois = montarChamado({ ...base, estado, final: FINAL });
      assert.ok(!dois.html.includes('A) Sim') && !dois.classico.includes('A) Sim'), `${estado}: opcoes que viraram botao nao saem em texto`);
    }
  });

  test('T7c1 41. completo: true no aviso e na resposta = completa (sem a linha "> Telegram do Davi (") e so os botoes das opcoes', () => {
    const comLinha = `> Telegram do Davi (12:50): «detalha»\n\n${FINAL}`;
    for (const estado of ['aviso', 'resposta']) {
      for (const final of [FINAL, comLinha]) {
        const c = montarChamado({ ...base, estado, hora: '12:50', final, completo: true });
        assert.deepEqual(c, {
          html: `<h2>ℹ️ Faro</h2><p>${DETALHE_FINAL}</p>`,
          classico: `<b>ℹ️ Faro</b>\n\n${QUOTE_FINAL}`,
          botoes: BOTOES_FINAL,
        }, estado);
        assert.ok(!c.html.includes('Telegram do Davi') && !c.classico.includes('Telegram do Davi'), `${estado}: sem a linha de citacao`);
      }
      const aberto = montarChamado({ ...base, estado, final: FINAL_LONGO, completo: true });
      assert.ok(aberto.html.includes(DETALHE) && aberto.classico.includes(DETALHE), `${estado}: aberto mostra o resto do texto`);
      assert.deepEqual(aberto.botoes, BOTOES_FINAL, `${estado}: sem Mais informações depois de aberto`);
      assert.ok(!JSON.stringify(aberto.botoes).includes('"i:'), estado);
      // sem opcoes: aberto e sem botao de opcao (T29c: so o "Menos informações", que volta pro compacto)
      assert.deepEqual(montarChamado({ ...base, estado, final: 'Terminei.\nPosso seguir?', completo: true }), {
        html: '<h2>ℹ️ Faro</h2><p>Terminei.<br>Posso seguir?</p>',
        classico: '<b>ℹ️ Faro</b>\n\nTerminei.\nPosso seguir?',
        botoes: [[{ texto: 'Menos informações', dados: `m:${ID}` }]],
      }, estado);
      // so true abre
      const quase = montarChamado({ ...base, estado, final: FINAL, completo: 'sim' });
      assert.deepEqual(quase, { html: CURTO_HTML, classico: CURTO_CLASSICO, botoes: [...BOTOES_FINAL, INFO] }, `${estado}: so true abre`);
    }
    // completo sem texto pra abrir: o curto de sempre, sem botao
    assert.deepEqual(montarChamado({ ...base, estado: 'resposta', final: '', completo: true }), {
      html: '<h2>ℹ️ Faro</h2><p>Respondeu sem texto.</p>', classico: '<b>ℹ️ Faro</b>\nRespondeu sem texto.', botoes: null,
    });
  });

  test('T7c1 42. encerrado com final continua com <details> e <blockquote expandable>; enviando, entregue, problema, contexto e movido nao mudam', () => {
    assert.deepEqual(montarChamado({ ...base, estado: 'encerrado', hora: '13:00', motivo: 'whatsapp', final: FINAL }), {
      html: '<h2>ℹ️ Faro</h2><p><i>Encerrada às 13:00: você respondeu pelo WhatsApp.</i></p>' +
        `<details><summary>Mensagem completa</summary><p>${DETALHE_FINAL}</p></details>`,
      classico: '<b>ℹ️ Faro</b>\n<i>Encerrada às 13:00: você respondeu pelo WhatsApp.</i>\n\n' +
        `<blockquote expandable>${QUOTE_FINAL}</blockquote>`,
      botoes: null,
    });
    assert.deepEqual(montarChamado({ ...base, estado: 'encerrado', hora: '13:00', motivo: 'pc' }), {
      html: '<h2>ℹ️ Faro</h2><p><i>Encerrada às 13:00: a aba seguiu no PC.</i></p>',
      classico: '<b>ℹ️ Faro</b>\n<i>Encerrada às 13:00: a aba seguiu no PC.</i>',
      botoes: null,
    });
    assert.deepEqual(montarChamado({ ...base, estado: 'enviando', hora: '12:50', fala: 'A) Azul' }), {
      html: '<h2>ℹ️ Faro</h2><p>Você respondeu às 12:50: «A) Azul»</p><p><i>Passando pra aba.</i></p>',
      classico: '<b>ℹ️ Faro</b>\nVocê respondeu às 12:50: «A) Azul»\n<i>Passando pra aba.</i>',
      botoes: null,
    });
    assert.deepEqual(montarChamado({ ...base, estado: 'entregue', hora: '12:50', horaEntrega: '12:51', fala: 'A) Azul' }), {
      html: '<h2>ℹ️ Faro</h2><p>Você respondeu às 12:50: «A) Azul»</p><p><i>Entregue na aba às 12:51. Aguardando a resposta.</i></p>',
      classico: '<b>ℹ️ Faro</b>\nVocê respondeu às 12:50: «A) Azul»\n<i>Entregue na aba às 12:51. Aguardando a resposta.</i>',
      botoes: null,
    });
    assert.deepEqual(montarChamado({ ...base, estado: 'problema', hora: '12:50', fala: 'oi', frase: 'A aba <pid> não está mais aberta.' }), {
      html: '<h2>ℹ️ Faro</h2><p>Você respondeu às 12:50: «oi»</p><p>A aba &lt;pid&gt; não está mais aberta.</p>',
      classico: '<b>ℹ️ Faro</b>\nVocê respondeu às 12:50: «oi»\nA aba &lt;pid&gt; não está mais aberta.',
      botoes: null,
    });
    assert.deepEqual(montarChamado({ ...base, estado: 'contexto', hora: '12:52' }), {
      html: '<h2>ℹ️ Faro</h2><p>Você pediu mais contexto às 12:52.</p><p><i>Passando pra aba.</i></p>',
      classico: '<b>ℹ️ Faro</b>\nVocê pediu mais contexto às 12:52.\n<i>Passando pra aba.</i>',
      botoes: null,
    });
    assert.deepEqual(montarChamado({ ...base, estado: 'movido' }), {
      html: '<p><b>ℹ️ Faro</b>: chamado movido pra baixo.</p>',
      classico: '<b>ℹ️ Faro</b>: chamado movido pra baixo.',
      botoes: null,
    });
    // final e completo nao mexem nesses estados (o encerrado nao abre)
    for (const estado of ['enviando', 'entregue', 'contexto', 'problema', 'movido', 'encerrado']) {
      const p = { ...base, estado, hora: '12:50', horaEntrega: '12:51', fala: 'A) Azul', frase: 'x', motivo: 'pc' };
      assert.deepEqual(montarChamado({ ...p, final: FINAL, completo: true }), montarChamado({ ...p, final: FINAL }), estado);
    }
  });

  test('T7c1 43. dadosBotao informacoes = i:<ID> (10 bytes), contexto = TypeError; lerDadosBotao de i: e do legado c: = informacoes; 7, 6 letras, minusculas, sufixo e i: sozinho = null', () => {
    const d = dadosBotao({ chamadoId: ID, acao: 'informacoes' });
    assert.equal(d, `i:${ID}`);
    assert.equal(Buffer.byteLength(d, 'utf8'), 10);
    assert.throws(() => dadosBotao({ chamadoId: ID, acao: 'contexto' }), TypeError);
    assert.throws(() => dadosBotao({ chamadoId: 'abcdefgh', acao: 'informacoes' }), TypeError);
    assert.throws(() => dadosBotao({ acao: 'informacoes' }), TypeError);
    assert.deepEqual(lerDadosBotao(`i:${ID}`), { acao: 'informacoes', chamadoId: ID });
    assert.deepEqual(lerDadosBotao(`c:${ID}`), { acao: 'informacoes', chamadoId: ID }, 'legado: botao "Mais contexto" que ainda esta na tela');
    const outro = novoIdChamado();
    assert.deepEqual(lerDadosBotao(dadosBotao({ chamadoId: outro, acao: 'informacoes' })), { acao: 'informacoes', chamadoId: outro });
    assert.deepEqual(lerDadosBotao(`o:${ID}:3`), { acao: 'opcao', chamadoId: ID, indice: 3 }, 'opcao igual');
    for (const lixo of [
      'i:ABCDEFG', 'c:ABCDEFG', // 7 letras
      'i:abcdefgh', 'c:abcdefgh', 'i:ABCDefgh', // minusculas
      'i:ABCDEF', 'c:ABCDEF', // 6 letras
      `i:${ID}J`, `i:${ID}:0`, `c:${ID}:1`, `i:${ID}\n`, `c:${ID} `, `i:${ID}x`, // sufixo
      ` i:${ID}`, `xi:${ID}`, `I:${ID}`, `C:${ID}`, `ii:${ID}`, `x:${ID}`, // prefixo
      'i:', 'c:', 'i', '', // i: sozinho
      'i:ABCDEFGI', 'i:ABCDEFGL', 'i:ABCDEFGO', 'i:ABCDEFG0', 'i:ABCDEFG1', // fora do alfabeto
      null, undefined, 5, {},
    ]) {
      assert.equal(lerDadosBotao(lixo), null, JSON.stringify(lixo));
    }
    // o botao que o chamado monta e o leitor concordam
    const c = montarChamado({ estado: 'aviso', titulo: 'x', chamadoId: ID, final: FINAL });
    assert.deepEqual(lerDadosBotao(c.botoes.at(-1)[0].dados), { acao: 'informacoes', chamadoId: ID });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T9 (PLANO-TELEGRAM.md, contrato 3): o painel unico (status + pendencias) do Telegram, em rich e no recuo classico.

const AGORA = '2026-10-06T00:58:00.000Z'; // 21:58 de Brasilia, 05/10
const PAINEL = {
  hora: AGORA,
  modoRua: false,
  abertas: 5,
  esperando: [
    { titulo: 'Depoimentos', hora: '2026-10-05T23:11:00.000Z', texto: 'Página de Projeto Atlas: troco o vídeo?' },
    { titulo: 'Planilha de Custos', hora: '2026-10-06T00:52:00.000Z', texto: 'Fica com você: assinar a carta no gov.br' },
  ],
  trabalhando: ['Imersão Projeto Atlas', 'Roteiro de Vídeo'],
  paradas: ['Live 01/10'],
};

describe('T9 3. montarPainel', () => {
  // T10b (pedido do dono: "tem que ter acordeon pra todas [...] com bolinha, tudo igualzinho"): os grupos em
  // acordeao com bolinha, esperando ja aberto, 1 aba por paragrafo com o nome em negrito. T14: o grupo Fechadas saiu.
  test('rich: titulo, modo rua com a hora; os 3 grupos em acordeao com bolinha (esperando aberto); 1 aba por paragrafo, nome em negrito', () => {
    const { html } = montarPainel(PAINEL);
    assert.equal(html, [
      '<h3>Abas abertas: 5</h3>',
      '<p>Modo rua: desligado · atualizado às 21:58</p>',
      '<details open><summary>🔴 Esperando você (2)</summary>',
      '<p><b>Depoimentos</b> · 20:11<br>Página de Projeto Atlas: troco o vídeo?</p>',
      '<p><b>Planilha de Custos</b> · 21:52<br>Fica com você: assinar a carta no gov.br</p></details>',
      '<details><summary>🟡 Trabalhando (2)</summary><p><b>Imersão Projeto Atlas</b></p><p><b>Roteiro de Vídeo</b></p></details>',
      '<details><summary>🟢 Paradas (1)</summary><p><b>Live 01/10</b></p></details>',
    ].join(''));
  });

  test('classico: cada grupo num <blockquote> (esperando aberto, os outros expandable)', () => {
    const { classico } = montarPainel({ ...PAINEL, modoRua: true });
    assert.equal(classico, [
      '<b>Abas abertas: 5</b>',
      'Modo rua: ligado · atualizado às 21:58',
      '',
      '<blockquote><b>🔴 Esperando você (2)</b>',
      '<b>Depoimentos</b> · 20:11',
      'Página de Projeto Atlas: troco o vídeo?',
      '',
      '<b>Planilha de Custos</b> · 21:52',
      'Fica com você: assinar a carta no gov.br</blockquote>',
      '<blockquote expandable><b>🟡 Trabalhando (2)</b>',
      '<b>Imersão Projeto Atlas</b>',
      '<b>Roteiro de Vídeo</b></blockquote>',
      '<blockquote expandable><b>🟢 Paradas (1)</b>',
      '<b>Live 01/10</b></blockquote>',
    ].join('\n'));
  });

  test('nada esperando = a frase; grupo vazio nao aparece; nenhuma aba aberta', () => {
    const vazio = { hora: AGORA, modoRua: false, abertas: 0, esperando: [], trabalhando: [], paradas: [] };
    const { html, classico } = montarPainel(vazio);
    assert.equal(html, '<h3>Abas abertas: 0</h3><p>Modo rua: desligado · atualizado às 21:58</p><p>Nada esperando resposta sua.</p>');
    assert.equal(classico, '<b>Abas abertas: 0</b>\nModo rua: desligado · atualizado às 21:58\n\nNada esperando resposta sua.');
    // so paradas: sem trabalhando; nada esperando = a frase antes dos acordeoes
    const so = montarPainel({ ...vazio, abertas: 1, paradas: ['Faro'] });
    assert.ok(so.html.endsWith('<p>Nada esperando resposta sua.</p><details><summary>🟢 Paradas (1)</summary><p><b>Faro</b></p></details>'), so.html);
    assert.ok(!so.html.includes('Trabalhando') && !so.html.includes('Fechadas'), so.html);
    assert.ok(so.classico.endsWith('Nada esperando resposta sua.\n<blockquote expandable><b>🟢 Paradas (1)</b>\n<b>Faro</b></blockquote>'), so.classico);
  });

  test('todo texto de fora escapado; hora ilegivel = ??:??; entrada torta nao lanca', () => {
    const d = {
      ...PAINEL,
      esperando: [{ titulo: 'A <b> & B', hora: 'ontem', texto: 'apagar <script>x</script> & sair?' }],
      trabalhando: ['<i>T</i>'],
      paradas: [],
    };
    const { html, classico } = montarPainel(d);
    for (const s of [html, classico]) {
      assert.ok(s.includes('A &lt;b&gt; &amp; B'), s);
      assert.ok(s.includes('apagar &lt;script&gt;x&lt;/script&gt; &amp; sair?'), s);
      assert.ok(s.includes('&lt;i&gt;T&lt;/i&gt;'), s);
      assert.ok(s.includes(' · ??:??'), s);
      assert.ok(!/<script>|<i>T/.test(s), s);
    }
    for (const torto of [null, undefined, {}, { esperando: 'x', trabalhando: [null, 3], fechadas: [null] }]) {
      const r = montarPainel(torto);
      assert.equal(typeof r.html, 'string');
      assert.ok(r.html.startsWith('<h3>Abas abertas: '), r.html);
    }
  });

  // o recuo do classico (paradas primeiro, depois as esperando do fim) esta no "T14 2"
});

// ---------------------------------------------------------------------------------------------------------------
// T10 (PLANO-TELEGRAM.md, "T10 — nome da aba clicável no painel"): o nome da aba aberta vira link pro bot
// (https://t.me/<bot>?start=a_<sessionId>); o toque traz a situacao da aba (montarSituacao).

const BOT_T10 = 'Teste_ControleBot';
const SID_T10 = (n) => `3d5d0b90-c744-418d-aaec-8c9cb31e82${String(n).padStart(2, '0')}`;
const HREF_T10 = (n) => `https://t.me/${BOT_T10}?start=a_${SID_T10(n)}`;

describe('T10 1. montarPainel: o nome da aba aberta vira link', () => {
  test('rich e classico: esperando (a fechada tambem, T14), trabalhando e paradas com link; nome escapado dentro do link; texto sem id fica sem link', () => {
    const d = {
      ...PAINEL,
      bot: BOT_T10,
      esperando: [
        { titulo: 'Depoimentos', hora: '2026-10-05T23:11:00.000Z', texto: 'Troco o vídeo?', sid: SID_T10(1) },
        { titulo: 'Ajuste do Painel', hora: '2026-10-04T22:41:00.000Z', texto: 'Publicar?', sid: SID_T10(4), fechada: true },
      ],
      trabalhando: [{ titulo: 'A <b> & B', sid: SID_T10(2) }, 'Sem id'],
      paradas: [{ titulo: 'Live 01/10', sid: SID_T10(3) }],
    };
    const { html, classico } = montarPainel(d);
    for (const s of [html, classico]) {
      assert.ok(s.includes(`<b><a href="${HREF_T10(1)}">Depoimentos</a></b> · 20:11`), s);
      assert.ok(s.includes(`<b><a href="${HREF_T10(2)}">A &lt;b&gt; &amp; B</a></b>`), s);
      assert.ok(s.includes('<b>Sem id</b>'), s);
      assert.ok(s.includes(`<b><a href="${HREF_T10(3)}">Live 01/10</a></b>`), s);
      assert.ok(s.includes(`<b><a href="${HREF_T10(4)}">Ajuste do Painel</a></b> (fechada) · 04/10 19:41`), s); // T14: fechada com link e marca
    }
    assert.ok(html.includes('<details><summary>🟢 Paradas (1)</summary><p><b><a href='), html);
    assert.ok(html.includes('<summary>🟡 Trabalhando (2)</summary><p><b><a href='), html);
    assert.ok(visivel(classico).length <= 4096);
  });

  test('sem bot valido, ou id fora do formato, = o nome sem link (como na T9)', () => {
    for (const bot of [undefined, null, '', 'a b', 'x'.repeat(40), 'bot"><i>', 7]) {
      const { html, classico } = montarPainel({ ...PAINEL, bot, trabalhando: [{ titulo: 'T', sid: SID_T10(1) }] });
      assert.ok(!html.includes('<a ') && !classico.includes('<a '), String(bot));
      assert.ok(html.includes('<summary>🟡 Trabalhando (1)</summary><p><b>T</b></p>'), html);
    }
    for (const sid of ['', 'a b', 'x'.repeat(63), '"><i>', 5, null, undefined]) {
      const { html } = montarPainel({ ...PAINEL, bot: BOT_T10, paradas: [{ titulo: 'P', sid }] });
      assert.ok(!html.includes('<a '), String(sid));
      assert.ok(html.includes('<summary>🟢 Paradas (1)</summary><p><b>P</b></p>'), html);
    }
    // objeto sem titulo valido sai do grupo (como o texto vazio)
    const r = montarPainel({ ...PAINEL, bot: BOT_T10, trabalhando: [{ sid: SID_T10(1) }, { titulo: '  ', sid: SID_T10(2) }], paradas: [] });
    assert.ok(!r.html.includes('Trabalhando'), r.html);
  });
});

describe('T10 2. montarSituacao', () => {
  // T10b (pedido do dono: "a mesma formatação que a gente tem quando o pedido chega por conta própria"): o titulo do
  // aviso (h2 com o icone), a situacao em italico embaixo e as 2 linhas do aviso (as opcoes em texto, sem botao)
  test('formato do aviso: titulo com o icone, a situacao em italico e a ultima mensagem nas 2 linhas (fato; pergunta em negrito; opcoes embaixo)', () => {
    const final = 'Terminei a revisão do roteiro.\n\n---\n🔴 **DECISÃO:** Publico hoje?\nA) Sim (recomendado) / B) Amanhã';
    const { html, classico } = montarSituacao({ titulo: 'Depoimentos', situacao: 'Esperando você desde 08:12.', final });
    assert.equal(html, [
      '<h2>ℹ️ Depoimentos</h2>',
      '<p><i>Esperando você desde 08:12.</i></p>',
      '<p>Terminei a revisão do roteiro.</p>',
      '<p><b>Publico hoje?</b><br>A) Sim (recomendado) / B) Amanhã</p>',
    ].join(''));
    assert.equal(classico, [
      '<b>ℹ️ Depoimentos</b>',
      '<i>Esperando você desde 08:12.</i>',
      'Terminei a revisão do roteiro.',
      '',
      '<b>Publico hoje?</b>',
      'A) Sim (recomendado) / B) Amanhã',
    ].join('\n'));
    // o titulo e o mesmo do aviso da aba (montarChamado)
    assert.ok(montarChamado({ estado: 'aviso', titulo: 'Depoimentos', final, chamadoId: 'ABCDEFGH' }).html.startsWith('<h2>ℹ️ Depoimentos</h2>'));
  });

  test('"Fica com você" com o resto fora do negrito; so o fato; sem mensagem nenhuma', () => {
    const fica = montarSituacao({ titulo: 'Site', situacao: 'Parada.', final: 'Subi a página.\n\nFica com você: conferir o domínio.' });
    assert.equal(fica.html, '<h2>ℹ️ Site</h2><p><i>Parada.</i></p><p>Subi a página.</p><p><b>Fica com você:</b> conferir o domínio.</p>');
    const so = montarSituacao({ titulo: 'Planilha', situacao: 'Trabalhando agora.', final: 'Rodando a bateria agora.' });
    assert.equal(so.html, '<h2>ℹ️ Planilha</h2><p><i>Trabalhando agora.</i></p><p>Rodando a bateria agora.</p>');
    assert.equal(so.classico, '<b>ℹ️ Planilha</b>\n<i>Trabalhando agora.</i>\nRodando a bateria agora.');
    for (const final of [null, undefined, '', '   ']) {
      const v = montarSituacao({ titulo: 'Nova', situacao: 'Trabalhando agora.', final });
      assert.equal(v.html, '<h2>ℹ️ Nova</h2><p><i>Trabalhando agora.</i></p><p>Ainda sem mensagem dela.</p>', String(final));
      assert.equal(v.classico, '<b>ℹ️ Nova</b>\n<i>Trabalhando agora.</i>\nAinda sem mensagem dela.');
    }
    // sem situacao legivel = so o titulo e a mensagem
    assert.equal(montarSituacao({ titulo: 'Nova', situacao: 7, final: 'Feito.' }).html, '<h2>ℹ️ Nova</h2><p>Feito.</p>');
  });

  test('todo texto de fora escapado; entrada torta nao lanca; classico ate 4096 visiveis', () => {
    const r = montarSituacao({ titulo: 'A <b> & B', situacao: '<i>x</i>', final: 'Rodei <script>x</script> & pronto.' });
    for (const s of [r.html, r.classico]) {
      assert.ok(s.includes('A &lt;b&gt; &amp; B') && s.includes('&lt;i&gt;x&lt;/i&gt;'), s);
      assert.ok(s.includes('Rodei &lt;script&gt;x&lt;/script&gt; &amp; pronto.'), s);
      assert.ok(!/<script>|<i>x/.test(s), s);
    }
    for (const torto of [null, undefined, {}, { titulo: 5, situacao: [], final: {} }]) {
      const v = montarSituacao(torto);
      assert.ok(v.html.startsWith('<h2>ℹ️ '), v.html);
      assert.equal(typeof v.classico, 'string');
    }
    const longo = montarSituacao({ titulo: 'x'.repeat(500), situacao: 'parada', final: `${'palavra '.repeat(800)}\n\n${'Posso seguir '.repeat(100)}?` });
    assert.ok(visivel(longo.classico).length <= 4096, String(visivel(longo.classico).length));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T10c (PLANO-TELEGRAM.md, "T10c"; pedido do dono: "Sim, igual ao aviso"): a situacao com id sai com o html e os
// botoes do aviso (montarChamado), mais a situacao em italico embaixo do titulo.

describe('T10c 1. montarSituacao com id = o aviso (html e botoes) + a situacao em italico', () => {
  const FIN = 'Terminei a revisão do roteiro.\n\n---\n🔴 **DECISÃO:** Publico hoje?\nA) Sim (recomendado) / B) Amanhã';
  const SIT = 'Esperando você desde 08:12.';
  // T14c: a situacao nao tem o Concluir (saiu)
  const comItalico = (r) => ({
    html: r.html.replace('</h2>', `</h2><p><i>${SIT}</i></p>`),
    classico: r.classico.replace(/^(<b>[^\n]*<\/b>)/, `$1\n<i>${SIT}</i>`),
    botoes: r.botoes,
  });

  test('curta: as 2 linhas, os botoes das opcoes (a recomendada em verde) e Mais informações; as opcoes saem do texto', () => {
    const sit = montarSituacao({ titulo: 'Depoimentos', situacao: SIT, final: FIN, chamadoId: ID });
    const aviso = montarChamado({ estado: 'aviso', titulo: 'Depoimentos', final: FIN, chamadoId: ID });
    assert.deepEqual(sit, comItalico(aviso));
    assert.ok(!sit.html.includes('A) Sim') && !sit.classico.includes('A) Sim'), 'as opcoes viraram botao');
    assert.deepEqual(sit.botoes.map((l) => l[0].dados), [`o:${ID}:0`, `o:${ID}:1`, `i:${ID}`]);
    assert.equal(sit.botoes[0][0].estilo, 'success');
  });

  test('aberta (completo): o texto inteiro com a situacao embaixo do titulo e so os botoes das opcoes', () => {
    const sit = montarSituacao({ titulo: 'Depoimentos', situacao: SIT, final: FIN, chamadoId: ID, completo: true });
    const aviso = montarChamado({ estado: 'aviso', titulo: 'Depoimentos', final: FIN, chamadoId: ID, completo: true });
    assert.deepEqual(sit, comItalico(aviso));
    assert.ok(!sit.botoes.flat().some((b) => b.dados.startsWith('i:')), 'sem Mais informações');
    const longa = montarSituacao({ titulo: 'x', situacao: SIT, final: `${'palavra '.repeat(3000)}\n\nPublico?`, chamadoId: ID, completo: true });
    assert.ok(visivel(longa.classico).length <= 4096, String(visivel(longa.classico).length));
  });

  test('sem pergunta: so "Mais informações"; sem mensagem: sem botao; id invalido = sem botao (as opcoes em texto, como na T10b)', () => {
    const so = montarSituacao({ titulo: 'Planilha', situacao: 'Trabalhando agora.', final: 'Rodando a bateria agora.', chamadoId: ID });
    assert.deepEqual(so.botoes, [MAIS]);
    const nada = montarSituacao({ titulo: 'Nova', situacao: 'Parada.', final: '', chamadoId: ID });
    assert.equal(nada.botoes, null);
    assert.equal(nada.html, '<h2>ℹ️ Nova</h2><p><i>Parada.</i></p><p>Ainda sem mensagem dela.</p>');
    for (const ruim of [undefined, null, '', 'abc', 'ABCDEFGI', 7]) {
      const r = montarSituacao({ titulo: 'Depoimentos', situacao: SIT, final: FIN, chamadoId: ruim });
      assert.equal(r.botoes, null, String(ruim));
      assert.ok(r.html.includes('<br>A) Sim (recomendado) / B) Amanhã</p>'), r.html);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T16 (PLANO-TELEGRAM.md, "T16"; pedido do dono: "quando eu clico numa aba que está trabalhando [...] ele puxa a
// última decisão que tinha sido pedida"): a situacao da aba trabalhando (`trabalhando: true`) sai sem os botoes das
// opcoes (a vez nao acabou: as opcoes ficam em texto) e com "Mais informações" quando ha texto.

describe('T16 1. montarSituacao com trabalhando: true = sem os botoes das opcoes; "Mais informações" com texto', () => {
  const FIN = 'Terminei a revisão do roteiro.\n\n---\n🔴 **DECISÃO:** Publico hoje?\nA) Sim (recomendado) / B) Amanhã';
  const SIT = 'Trabalhando agora, desde 22:41. Último passo às 23:05: Rodar a bateria';

  test('curta: o mesmo texto da situacao sem id (as opcoes em texto) e so o "Mais informações"', () => {
    const r = montarSituacao({ titulo: 'Aula', situacao: SIT, final: FIN, chamadoId: ID, trabalhando: true });
    const semId = montarSituacao({ titulo: 'Aula', situacao: SIT, final: FIN });
    assert.equal(r.html, semId.html);
    assert.equal(r.classico, semId.classico);
    assert.ok(r.html.startsWith(`<h2>ℹ️ Aula</h2><p><i>${SIT}</i></p>`), r.html);
    assert.ok(r.html.includes('<br>A) Sim (recomendado) / B) Amanhã</p>'), r.html);
    assert.deepEqual(r.botoes, [MAIS]);
  });

  test('aberta (completo): o texto inteiro com a situacao embaixo do titulo e sem botao de opcao (T29c: so o "Menos informações")', () => {
    const r = montarSituacao({ titulo: 'Aula', situacao: SIT, final: FIN, chamadoId: ID, trabalhando: true, completo: true });
    const aberta = montarSituacao({ titulo: 'Aula', situacao: SIT, final: FIN, chamadoId: ID, completo: true });
    assert.equal(r.html, aberta.html);
    assert.equal(r.classico, aberta.classico);
    assert.deepEqual(r.botoes, [[{ texto: 'Menos informações', dados: `m:${ID}` }]]);
  });

  test('sem texto: "Ainda sem mensagem neste trabalho." e sem botao; so true liga (o resto = os botoes do aviso, como antes)', () => {
    for (const final of [null, undefined, '', '   ']) {
      const r = montarSituacao({ titulo: 'Aula', situacao: 'Trabalhando agora.', final, chamadoId: ID, trabalhando: true });
      assert.equal(r.html, '<h2>ℹ️ Aula</h2><p><i>Trabalhando agora.</i></p><p>Ainda sem mensagem neste trabalho.</p>', String(final));
      assert.equal(r.classico, '<b>ℹ️ Aula</b>\n<i>Trabalhando agora.</i>\nAinda sem mensagem neste trabalho.');
      assert.equal(r.botoes, null);
    }
    for (const v of [false, 'true', 1, null, undefined]) {
      const r = montarSituacao({ titulo: 'Aula', situacao: SIT, final: FIN, chamadoId: ID, trabalhando: v });
      assert.deepEqual(r.botoes.map((l) => l[0].dados), [`o:${ID}:0`, `o:${ID}:1`, `i:${ID}`], String(v));
      assert.equal(montarSituacao({ titulo: 'Nova', situacao: 'Parada.', final: '', trabalhando: v }).html,
        '<h2>ℹ️ Nova</h2><p><i>Parada.</i></p><p>Ainda sem mensagem dela.</p>', String(v));
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T14 (PLANO-TELEGRAM.md, "T14 — o painel por pergunta e por movimento"; pedido do dono, "A) Sim, as 4
// mudanças"): o grupo "Fechadas" sai. Esperando = toda conversa com pergunta (a fechada com a marca "(fechada)"
// depois do nome); Paradas = abertas e fechadas que mexeram nas ultimas 48 h (a fechada com a marca). Os nomes de grupo
// do VS Code (T11/T11b) saem junto com o grupo. A situacao ganhou o botao "Concluir" (z:<id>), que saiu na T14c.

const ln = (n, t) => `<b><a href="${HREF_T10(n)}">${t}</a></b>`;

describe('T14 1. montarPainel: sem o grupo Fechadas; a marca "(fechada)" no Esperando e nas Paradas', () => {
  const D = {
    ...PAINEL,
    bot: BOT_T10,
    esperando: [
      { titulo: 'Depoimentos', hora: '2026-10-05T23:11:00.000Z', texto: 'Troco o vídeo?', sid: SID_T10(1) },
      { titulo: 'Ajuste do Painel', hora: '2026-10-04T22:41:00.000Z', texto: 'Publicar?', sid: SID_T10(4), fechada: true },
    ],
    trabalhando: [{ titulo: 'Roteiro de Vídeo', sid: SID_T10(2) }],
    paradas: [{ titulo: 'Live 01/10', sid: SID_T10(3) }, { titulo: 'A <b> & B', sid: SID_T10(8), fechada: true }],
  };

  test('rich: a fechada leva "(fechada)" depois do nome, no Esperando (antes da hora) e nas Paradas; nenhum "Fechadas"', () => {
    const { html } = montarPainel(D);
    assert.equal(html, [
      '<h3>Abas abertas: 5</h3>',
      '<p>Modo rua: desligado · atualizado às 21:58</p>',
      '<details open><summary>🔴 Esperando você (2)</summary>',
      `<p>${ln(1, 'Depoimentos')} · 20:11<br>Troco o vídeo?</p>`,
      `<p>${ln(4, 'Ajuste do Painel')} (fechada) · 04/10 19:41<br>Publicar?</p></details>`,
      `<details><summary>🟡 Trabalhando (1)</summary><p>${ln(2, 'Roteiro de Vídeo')}</p></details>`,
      `<details><summary>🟢 Paradas (2)</summary><p>${ln(3, 'Live 01/10')}</p><p>${ln(8, 'A &lt;b&gt; &amp; B')} (fechada)</p></details>`,
    ].join(''));
  });

  test('classico: a mesma marca; nenhum "Fechadas"', () => {
    const { classico } = montarPainel(D);
    assert.equal(classico, [
      '<b>Abas abertas: 5</b>',
      'Modo rua: desligado · atualizado às 21:58',
      '',
      '<blockquote><b>🔴 Esperando você (2)</b>',
      `${ln(1, 'Depoimentos')} · 20:11`,
      'Troco o vídeo?',
      '',
      `${ln(4, 'Ajuste do Painel')} (fechada) · 04/10 19:41`,
      'Publicar?</blockquote>',
      '<blockquote expandable><b>🟡 Trabalhando (1)</b>',
      `${ln(2, 'Roteiro de Vídeo')}</blockquote>`,
      '<blockquote expandable><b>🟢 Paradas (2)</b>',
      ln(3, 'Live 01/10'),
      `${ln(8, 'A &lt;b&gt; &amp; B')} (fechada)</blockquote>`,
    ].join('\n'));
  });

  test('o campo fechadasLista (T11) nao aparece mais; fechada que nao e true = sem marca; paradas em texto seguem valendo', () => {
    const antes = montarPainel(D);
    const velho = montarPainel({ ...D, fechadasLista: [{ titulo: 'Z', sid: SID_T10(10), grupo: 'Ativos' }] });
    assert.deepEqual(velho, antes);
    for (const s of [velho.html, velho.classico]) assert.ok(!s.includes('Fechadas') && !s.includes('Ativos'), s);
    const sem = montarPainel({ ...D, esperando: [{ ...D.esperando[1], fechada: 'sim' }], paradas: ['Só texto', { titulo: 'P', sid: SID_T10(3), fechada: 1 }] });
    assert.ok(!sem.html.includes('(fechada)'), sem.html);
    assert.ok(sem.html.includes('<p><b>Só texto</b></p>'), sem.html);
  });

  test('lista do VS Code ilegivel: a linha no fim, no rich e no classico; sem ela, nenhuma linha', () => {
    const r = montarPainel({ ...D, listaErro: true });
    assert.ok(r.html.endsWith('</details><p>Não consegui ler a lista do VS Code agora.</p>'), r.html.slice(-160));
    assert.ok(r.classico.endsWith('</blockquote>\nNão consegui ler a lista do VS Code agora.'), r.classico.slice(-160));
    const vazio = montarPainel({ hora: AGORA, modoRua: false, abertas: 0, esperando: [], trabalhando: [], paradas: [], listaErro: true });
    assert.ok(vazio.html.endsWith('<p>Nada esperando resposta sua.</p><p>Não consegui ler a lista do VS Code agora.</p>'), vazio.html);
    for (const s of [montarPainel({ ...D, listaErro: 'sim' }), montarPainel(D)]) {
      assert.ok(!s.html.includes('lista do VS Code') && !s.classico.includes('lista do VS Code'));
    }
  });
});

describe('T14 2. montarPainel: muitas paradas', () => {
  test('rich leva ate 150 paradas com "(e mais N)"; o classico cabe nos 4096 visiveis cortando as paradas primeiro, depois as esperando do fim', () => {
    const paradas = Array.from({ length: 200 }, (_, i) => ({ titulo: `Conversa parada numero ${i}`, sid: SID_T10(i % 90), fechada: i % 2 === 0 }));
    const longo = (i) => `Pergunta ${i}: ${'palavra '.repeat(40)}?`;
    const esperando = Array.from({ length: 6 }, (_, i) => ({ titulo: `Aba ${i}`, hora: AGORA, texto: longo(i) }));
    const { html, classico } = montarPainel({ ...PAINEL, esperando, paradas });
    assert.ok(html.includes('🟢 Paradas (200)'), 'N = todas');
    assert.ok(html.includes('<b>Conversa parada numero 149</b>') && !html.includes('<b>Conversa parada numero 150</b>'), 'rich: 150');
    assert.ok(html.endsWith('<p>(e mais 50)</p></details>'), html.slice(-120));
    assert.ok(visivel(classico).length <= 4096, String(visivel(classico).length));
    assert.ok(classico.includes('<b>Aba 5</b>'), 'as 6 esperando ficam: as paradas saem primeiro');
    assert.match(classico, /\n\(e mais \d+\)<\/blockquote>$/);
    // esperando demais: o classico corta do fim, com "(e mais N)" no grupo; o rich leva todas
    const muitas = Array.from({ length: 60 }, (_, i) => ({ titulo: `Aba ${i}`, hora: AGORA, texto: longo(i), fechada: i % 3 === 0 }));
    const c2 = montarPainel({ ...PAINEL, esperando: muitas, paradas: [] });
    assert.ok(visivel(c2.classico).length <= 4096, String(visivel(c2.classico).length));
    assert.ok(c2.classico.includes('<b>Aba 0</b> (fechada)'));
    assert.match(c2.classico, /\n\(e mais \d+\)<\/blockquote>\n/);
    assert.equal(c2.html.split('<p><b>Aba ').length - 1, 60, 'rich leva todas as esperando');
  });
});

// T14c (pedido do dono, "o que vc acha?" sobre tirar o botao): o "Concluir" saiu da situacao.
describe('T14 3 (T14c). montarSituacao: sem o botao "Concluir"', () => {
  const FIN = 'Terminei a revisão do roteiro.\n\n---\n🔴 **DECISÃO:** Publico hoje?\nA) Sim (recomendado) / B) Amanhã';
  test('nem com concluir: true: curta, aberta, sem pergunta e sem mensagem saem so com os botoes do aviso; id invalido = sem botao', () => {
    const curta = montarSituacao({ titulo: 'Depoimentos', situacao: 'Parada.', final: FIN, chamadoId: ID, concluir: true });
    assert.deepEqual(curta.botoes.map((l) => l[0].dados), [`o:${ID}:0`, `o:${ID}:1`, `i:${ID}`]);
    const aberta = montarSituacao({ titulo: 'Depoimentos', situacao: 'Parada.', final: FIN, chamadoId: ID, completo: true, concluir: true });
    assert.deepEqual(aberta.botoes.map((l) => l[0].dados), [`o:${ID}:0`, `o:${ID}:1`]);
    assert.deepEqual(montarSituacao({ titulo: 'P', situacao: 'Parada.', final: 'Rodando.', chamadoId: ID, concluir: true }).botoes, [MAIS]);
    assert.equal(montarSituacao({ titulo: 'Nova', situacao: 'Parada.', final: '', chamadoId: ID, concluir: true }).botoes, null);
    for (const ruim of [undefined, null, '', 'abc', 'ABCDEFGI', 7]) {
      assert.equal(montarSituacao({ titulo: 'D', situacao: 'Parada.', final: FIN, chamadoId: ruim, concluir: true }).botoes, null, String(ruim));
    }
  });

  test('o aviso da aba (montarChamado) tambem nao tem o Concluir', () => {
    const aviso = montarChamado({ estado: 'aviso', titulo: 'Depoimentos', final: FIN, chamadoId: ID });
    assert.ok(!aviso.botoes.flat().some((b) => b.dados.startsWith('z:')));
  });
});

describe('T14 4 (T14c). dadosBotao e lerDadosBotao sem o Concluir', () => {
  test('z:<id> = null na leitura (o botao de uma situacao de antes vira toque velho); dadosBotao com acao concluir = TypeError; o resto continua', () => {
    for (const z of [`z:${ID}`, 'z:', `z:${ID}:1`]) assert.equal(lerDadosBotao(z), null, z);
    assert.throws(() => dadosBotao({ chamadoId: ID, acao: 'concluir' }), TypeError);
    assert.deepEqual(lerDadosBotao(`i:${ID}`), { acao: 'informacoes', chamadoId: ID });
    assert.deepEqual(lerDadosBotao(`o:${ID}:1`), { acao: 'opcao', chamadoId: ID, indice: 1 });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T14b (PLANO-TELEGRAM.md, "T14b"; pedido do dono: "antes eu conseguia ver todas as fechadas, agora eu
// nao consigo mais" / "eu preciso conseguir ver as mensagens que eu fechei"): o "⚪ Fechadas" volta, recolhido no fim, com
// o que saiu do Esperando e das Paradas (as paradas ha mais de 48 h; ate a T14c, as concluidas), pelos grupos do VS Code (T11b: o
// nome do grupo em titulo; "Sem grupo" no fim), 1 aba por paragrafo com o link, sem a marca "(fechada)".

const FECHADAS_T14B = [
  { titulo: 'Relatório Mensal', sid: SID_T10(5), grupo: 'Prioridade' },
  { titulo: 'Site Novo', sid: SID_T10(6), grupo: 'Prioridade' },
  { titulo: 'Loja Online', sid: SID_T10(7), grupo: 'Ativos' },
  { titulo: 'A <b> & B', sid: SID_T10(8), grupo: null },
];

describe('T14b 1. montarPainel: o grupo Fechadas no fim, pelos grupos do VS Code', () => {
  const D = { ...PAINEL, bot: BOT_T10, fechadas: FECHADAS_T14B };

  test('rich: depois das Paradas, recolhido, N = todas; o nome do grupo em titulo (h4 negrito) a cada troca, "Sem grupo" como veio; 1 aba por paragrafo com link e sem marca', () => {
    const { html } = montarPainel(D);
    assert.ok(html.endsWith([
      '<details><summary>🟢 Paradas (1)</summary><p><b>Live 01/10</b></p></details>',
      '<details><summary>⚪ Fechadas (4)</summary>',
      '<h4><b>Prioridade</b></h4>',
      `<p>${ln(5, 'Relatório Mensal')}</p>`,
      `<p>${ln(6, 'Site Novo')}</p>`,
      '<h4><b>Ativos</b></h4>',
      `<p>${ln(7, 'Loja Online')}</p>`,
      '<h4><b>Sem grupo</b></h4>',
      `<p>${ln(8, 'A &lt;b&gt; &amp; B')}</p>`,
      '</details>',
    ].join('')), html);
    assert.ok(!html.includes('(fechada)'), html);
  });

  test('classico: o mesmo grupo (expandable), o nome do grupo com linha em branco antes e negrito sublinhado', () => {
    const { classico } = montarPainel(D);
    assert.ok(classico.endsWith([
      '<blockquote expandable><b>🟢 Paradas (1)</b>',
      '<b>Live 01/10</b></blockquote>',
      '<blockquote expandable><b>⚪ Fechadas (4)</b>',
      '<b><u>Prioridade</u></b>',
      ln(5, 'Relatório Mensal'),
      ln(6, 'Site Novo'),
      '',
      '<b><u>Ativos</u></b>',
      ln(7, 'Loja Online'),
      '',
      '<b><u>Sem grupo</u></b>',
      `${ln(8, 'A &lt;b&gt; &amp; B')}</blockquote>`,
    ].join('\n')), classico);
  });

  test('nome do grupo de fora: escapado e cortado; vazio ou nao texto = "Sem grupo"; item torto sai; sem fechadas = sem o grupo; a linha da lista ilegivel depois dele', () => {
    const g = montarPainel({ ...PAINEL, fechadas: [{ titulo: 'X', sid: SID_T10(1), grupo: '<i>Z</i>' }, { titulo: 'Y', sid: SID_T10(2), grupo: '  ' }, { titulo: 'W', grupo: 7 }, null, 3, 'texto', { sid: SID_T10(3) }] }).html;
    assert.ok(g.includes('<summary>⚪ Fechadas (3)</summary><h4><b>&lt;i&gt;Z&lt;/i&gt;</b></h4><p><b>X</b></p><h4><b>Sem grupo</b></h4><p><b>Y</b></p><p><b>W</b></p></details>'), g);
    for (const fl of [undefined, null, 'x', []]) {
      const r = montarPainel({ ...PAINEL, fechadas: fl });
      assert.ok(!r.html.includes('Fechadas') && !r.classico.includes('Fechadas'), String(fl));
    }
    const e = montarPainel({ ...D, listaErro: true });
    assert.ok(e.html.endsWith('</details><p>Não consegui ler a lista do VS Code agora.</p>'), e.html.slice(-120));
    assert.ok(e.html.includes('⚪ Fechadas (4)'));
    // so fechadas (nada esperando, sem paradas): a frase e o grupo
    const so = montarPainel({ hora: AGORA, modoRua: false, abertas: 0, esperando: [], trabalhando: [], paradas: [], fechadas: FECHADAS_T14B.slice(2, 3) });
    assert.ok(so.html.endsWith('<p>Nada esperando resposta sua.</p><details><summary>⚪ Fechadas (1)</summary><h4><b>Ativos</b></h4><p><b>Loja Online</b></p></details>'), so.html);
  });
});

describe('T14b 2. montarPainel: muitas fechadas', () => {
  test('rich leva ate 150 fechadas com "(e mais N)"; o classico corta as fechadas primeiro, depois as paradas, depois as esperando', () => {
    const fechadas = Array.from({ length: 200 }, (_, i) => ({ titulo: `Conversa fechada numero ${i}`, sid: SID_T10(i % 90), grupo: i < 100 ? 'Ativos' : null }));
    const longo = (i) => `Pergunta ${i}: ${'palavra '.repeat(40)}?`;
    const esperando = Array.from({ length: 6 }, (_, i) => ({ titulo: `Aba ${i}`, hora: AGORA, texto: longo(i) }));
    const paradas = Array.from({ length: 40 }, (_, i) => ({ titulo: `Parada ${i}`, sid: SID_T10(i) }));
    const { html, classico } = montarPainel({ ...PAINEL, esperando, paradas, fechadas });
    assert.ok(html.includes('⚪ Fechadas (200)'), 'N = todas');
    assert.ok(html.includes('<b>Conversa fechada numero 149</b>') && !html.includes('<b>Conversa fechada numero 150</b>'), 'rich: 150');
    assert.ok(html.endsWith('<p>(e mais 50)</p></details>'), html.slice(-120));
    assert.ok(visivel(classico).length <= 4096, String(visivel(classico).length));
    assert.ok(classico.includes('<b>Parada 39</b>') && classico.includes('<b>Aba 5</b>'), 'as paradas e as esperando ficam: as fechadas saem primeiro');
    assert.match(classico, /\n\(e mais \d+\)<\/blockquote>$/);
    // fechadas e paradas demais: as fechadas saem inteiras antes de cortar as paradas
    const muitasParadas = Array.from({ length: 300 }, (_, i) => ({ titulo: `Parada comprida numero ${i}`, sid: SID_T10(i % 90) }));
    const c2 = montarPainel({ ...PAINEL, esperando, paradas: muitasParadas, fechadas }).classico;
    assert.ok(visivel(c2).length <= 4096, String(visivel(c2).length));
    assert.ok(!c2.includes('Conversa fechada numero 0'), 'nenhuma fechada antes de cortar as paradas');
    assert.ok(c2.includes('<b>⚪ Fechadas (200)</b>\n(e mais 200)</blockquote>'), c2.slice(-200));
    assert.ok(c2.includes('<b>Aba 5</b>'));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// T24 (PLANO-TELEGRAM.md, "T24"; pedido do dono, pelo Telegram: «transforma os que eu não quiser mais mexer agora
// em aguardando ou em alguma coisa assim»): o grupo "🔵 Aguardando (N)", recolhido, logo depois do Esperando, com as
// linhas no formato dele. d.aguardando = [{titulo, hora, texto, sid, fechada?, em}] (o `em` e da situacao, nao do painel).

const AGUARDANDO_T24 = [
  { titulo: 'Relatório semanal', hora: '2026-10-05T22:02:00.000Z', texto: 'Fecho o card?', sid: SID_T10(11), em: AGORA },
  { titulo: 'Ajuste do site', hora: '2026-10-03T15:30:00.000Z', texto: 'Fica com você: aprovar o acesso', sid: SID_T10(12), fechada: true, em: AGORA },
];

describe('T24 1. montarPainel: o grupo Aguardando logo depois do Esperando, recolhido', () => {
  const D = { ...PAINEL, bot: BOT_T10, aguardando: AGUARDANDO_T24 };

  test('rich: "🔵 Aguardando (2)" entre o Esperando e o Trabalhando, <details> sem open; as linhas do Esperando (link, "(fechada)", hora com o dia quando e outro, pergunta)', () => {
    const { html } = montarPainel(D);
    assert.equal(html, [
      '<h3>Abas abertas: 5</h3>',
      '<p>Modo rua: desligado · atualizado às 21:58</p>',
      '<details open><summary>🔴 Esperando você (2)</summary>',
      '<p><b>Depoimentos</b> · 20:11<br>Página de Projeto Atlas: troco o vídeo?</p>',
      '<p><b>Planilha de Custos</b> · 21:52<br>Fica com você: assinar a carta no gov.br</p></details>',
      '<details><summary>🔵 Aguardando (2)</summary>',
      `<p>${ln(11, 'Relatório semanal')} · 19:02<br>Fecho o card?</p>`,
      `<p>${ln(12, 'Ajuste do site')} (fechada) · 03/10 12:30<br>Fica com você: aprovar o acesso</p></details>`,
      '<details><summary>🟡 Trabalhando (2)</summary><p><b>Imersão Projeto Atlas</b></p><p><b>Roteiro de Vídeo</b></p></details>',
      '<details><summary>🟢 Paradas (1)</summary><p><b>Live 01/10</b></p></details>',
    ].join(''));
  });

  test('classico: o grupo num <blockquote expandable> logo depois do Esperando (aberto), com as linhas dele', () => {
    const { classico } = montarPainel(D);
    assert.equal(classico, [
      '<b>Abas abertas: 5</b>',
      'Modo rua: desligado · atualizado às 21:58',
      '',
      '<blockquote><b>🔴 Esperando você (2)</b>',
      '<b>Depoimentos</b> · 20:11',
      'Página de Projeto Atlas: troco o vídeo?',
      '',
      '<b>Planilha de Custos</b> · 21:52',
      'Fica com você: assinar a carta no gov.br</blockquote>',
      '<blockquote expandable><b>🔵 Aguardando (2)</b>',
      `${ln(11, 'Relatório semanal')} · 19:02`,
      'Fecho o card?',
      '',
      `${ln(12, 'Ajuste do site')} (fechada) · 03/10 12:30`,
      'Fica com você: aprovar o acesso</blockquote>',
      '<blockquote expandable><b>🟡 Trabalhando (2)</b>',
      '<b>Imersão Projeto Atlas</b>',
      '<b>Roteiro de Vídeo</b></blockquote>',
      '<blockquote expandable><b>🟢 Paradas (1)</b>',
      '<b>Live 01/10</b></blockquote>',
    ].join('\n'));
  });

  test('N = 0 = sem o grupo (o painel de antes); Esperando vazio = a frase e o Aguardando embaixo; item torto sai; texto de fora escapado', () => {
    for (const ag of [undefined, null, 'x', 7, [], [null, 3, 'texto', ['a']]]) {
      assert.deepEqual(montarPainel({ ...PAINEL, aguardando: ag }), montarPainel(PAINEL), String(ag));
    }
    const so = montarPainel({ hora: AGORA, modoRua: false, abertas: 1, esperando: [], trabalhando: [], paradas: [], aguardando: AGUARDANDO_T24.slice(0, 1) });
    assert.ok(so.html.endsWith('<p>Nada esperando resposta sua.</p><details><summary>🔵 Aguardando (1)</summary><p><b>Relatório semanal</b> · 19:02<br>Fecho o card?</p></details>'), so.html);
    assert.ok(so.classico.endsWith('Nada esperando resposta sua.\n<blockquote expandable><b>🔵 Aguardando (1)</b>\n<b>Relatório semanal</b> · 19:02\nFecho o card?</blockquote>'), so.classico);
    const fora = montarPainel({ ...PAINEL, aguardando: [{ titulo: 'A <b> & B', hora: 'ontem', texto: 'apagar <script>x</script>?' }] });
    for (const s of [fora.html, fora.classico]) {
      assert.ok(s.includes('🔵 Aguardando (1)') && s.includes('A &lt;b&gt; &amp; B') && s.includes('apagar &lt;script&gt;x&lt;/script&gt;?'), s);
      assert.ok(s.includes('A &lt;b&gt; &amp; B</b> · ??:??'), s);
      assert.ok(!/<script>/.test(s), s);
    }
  });
});

describe('T24 2. montarPainel: o classico longo corta as Fechadas, as Paradas, o Aguardando e por ultimo o Esperando', () => {
  test('rich leva todas do Aguardando; o classico cabe nos 4096 visiveis e so corta o Aguardando depois das Fechadas e das Paradas, e antes do Esperando', () => {
    const longo = (i) => `Pergunta ${i}: ${'palavra '.repeat(40)}?`;
    const esperando = Array.from({ length: 4 }, (_, i) => ({ titulo: `Aba ${i}`, hora: AGORA, texto: longo(i) }));
    const aguardando = Array.from({ length: 30 }, (_, i) => ({ titulo: `Guardada ${i}`, hora: AGORA, texto: longo(i), sid: SID_T10(i), em: AGORA }));
    const paradas = Array.from({ length: 40 }, (_, i) => ({ titulo: `Parada ${i}`, sid: SID_T10(i) }));
    const fechadas = Array.from({ length: 40 }, (_, i) => ({ titulo: `Fechada ${i}`, sid: SID_T10(i), grupo: null }));
    const { html, classico } = montarPainel({ ...PAINEL, esperando, aguardando, paradas, fechadas });
    assert.equal(html.split('<p><b>Guardada ').length - 1, 30, 'rich leva todas');
    assert.ok(visivel(classico).length <= 4096, String(visivel(classico).length));
    assert.ok(classico.includes('<b>⚪ Fechadas (40)</b>\n(e mais 40)</blockquote>'), 'as fechadas saem inteiras primeiro');
    assert.ok(classico.includes('<b>🟢 Paradas (40)</b>\n(e mais 40)</blockquote>'), 'depois as paradas');
    assert.ok(classico.includes('<b>Guardada 0</b>'), 'o Aguardando so perde o fim');
    assert.match(classico, /\n\(e mais \d+\)<\/blockquote>\n<blockquote expandable><b>🟡 Trabalhando/, 'o Aguardando cortado do fim, com "(e mais N)"');
    assert.ok(classico.includes('<b>Aba 3</b>'), 'as esperando ficam inteiras');
    // esperando demais: o Aguardando sai inteiro antes de cortar o Esperando
    const muitas = Array.from({ length: 30 }, (_, i) => ({ titulo: `Aba ${i}`, hora: AGORA, texto: longo(i) }));
    const c2 = montarPainel({ ...PAINEL, esperando: muitas, aguardando, paradas: [], fechadas: [] }).classico;
    assert.ok(visivel(c2).length <= 4096, String(visivel(c2).length));
    assert.ok(c2.includes('<b>🔵 Aguardando (30)</b>\n(e mais 30)</blockquote>'), c2.slice(-400));
    assert.ok(c2.includes('<b>Aba 0</b>'));
    assert.match(c2, /\n\(e mais \d+\)<\/blockquote>\n<blockquote expandable><b>🔵 Aguardando \(30\)<\/b>/);
  });
});

// ---------- T26a (PLANO-TELEGRAM.md, "T26a"): o estado 'ok' e o chamado com o OK dentro ----------

describe('T26a montarChamadoComOk e o estado ok', () => {
  // as funcoes novas pelo modulo inteiro: sem elas, so estes testes falham
  const COD = 'ABC234';
  const BOT_T = 700900800;
  const DONO_T = 700100200;
  const CRIADO = '2026-10-02T13:00:00.700Z'; // 10:00 em Brasilia
  const pedidoOk = (extra = {}) => ({
    v: 1, codigo: COD, titulo: 'Nome', tipo: 'publicacao', acao: 'subir o site X em produção', destinatarios: null,
    criadoEm: CRIADO, expiraEm: '2026-10-02T13:30:00.700Z', status: 'pendente', ...extra,
  });
  const blocosDe = (p) => ({ compacto: okTg.montarBlocoOk({ ...p, completo: false }), completo: okTg.montarBlocoOk({ ...p, completo: true }) });
  const SIM_NAO = [[{ texto: 'Sim', dados: `k:${COD}:s`, estilo: 'success' }, { texto: 'Não', dados: `k:${COD}:n`, estilo: 'danger' }]];
  const COMPACTO = [...SIM_NAO, [{ texto: 'Mais informações', dados: `k:${COD}:i` }]];
  // A parte da aba do FINAL (resposta/aviso nas 2 linhas, opcoes em texto, sem botao)
  const PARTE = '<b>ℹ️ Nome</b>\nTerminei a revisão do <code>&lt;pid&gt;.json</code>.\n\n<b>Faço X?</b>\nA) Sim, tudo hoje (recomendado) / B) Só as correções';
  const PARTE_ABERTA = '<b>ℹ️ Nome</b>\n\nTerminei a revisão do &lt;pid&gt;.json.\n\n━━━━━━━━━━\n🔴 DECISÃO: Faço X? A) Sim, tudo hoje (recomendado) / B) Só as correções';
  // O toque como o getUpdates devolve, na mensagem que o porteiro mandou (texto = o visivel do classico)
  const toqueNa = (classico, botoes, p, letra = 's') => ({
    update_id: 900,
    callback_query: {
      id: 'cbq-1', from: { id: DONO_T, is_bot: false, first_name: 'Davi' }, chat_instance: '-1', data: `k:${p.codigo}:${letra}`,
      message: {
        message_id: 77, from: { id: BOT_T, is_bot: true, first_name: 'Bot' }, chat: { id: DONO_T, type: 'private' },
        date: Math.floor(Date.parse(p.criadoEm) / 1000) + 2, text: visivel(classico),
        ...(botoes ? { reply_markup: { inline_keyboard: botoes.map((l) => l.map((b) => ({ text: b.texto, callback_data: b.dados, ...(b.estilo ? { style: b.estilo } : {}) }))) } } : {}),
      },
    },
  });
  const conferir = (classico, botoes, p, letra) => okTg.conferirToque(toqueNa(classico, botoes, p, letra), { pedido: p, botId: BOT_T, chatDono: DONO_T });

  test('T26a 1: montarChamado estado ok = so o cabecalho (h2 / b), sem botao, mesmo com final e chamadoId', () => {
    assert.deepEqual(montarChamado({ estado: 'ok', titulo: 'Nome' }), { html: '<h2>ℹ️ Nome</h2>', classico: '<b>ℹ️ Nome</b>', botoes: null });
    assert.deepEqual(montarChamado({ estado: 'ok', titulo: 'A <b> & B', final: FINAL, chamadoId: ID, completo: true }), {
      html: '<h2>ℹ️ A &lt;b&gt; &amp; B</h2>', classico: '<b>ℹ️ A &lt;b&gt; &amp; B</b>', botoes: null,
    });
    assert.deepEqual(montarChamado({ estado: 'ok', titulo: 'Nome', icone: '🎛️' }).classico, '<b>🎛️ Nome</b>');
    assert.throws(() => montarChamado({ estado: 'OK', titulo: 'Nome' }), TypeError);
  });

  test('T26a 2: o chamado de hoje (sem reserva) sai byte a byte igual (golden da base 684232d)', () => {
    const LONGO = `${Array.from({ length: 300 }, (_, i) => `linha ${i} & <tag> ${'x'.repeat(40)} 🔴`).join('\n')}\n\n**Posso seguir?** A) Sim / B) Não`;
    const saidas = [];
    for (const estado of ['aviso', 'resposta']) {
      for (const final of [FINAL, LONGO, '', 'Feito.']) {
        for (const completo of [false, true]) {
          saidas.push(montarChamado({ estado, titulo: 'Nome <b>', final, completo, chamadoId: 'ABCDEFGH' }));
          saidas.push(montarSituacao({ titulo: 'Nome', final, completo, situacao: 'Esperando você desde 10:00.', chamadoId: 'ABCDEFGH' }));
          saidas.push(montarSituacao({ titulo: 'Nome', final, completo, trabalhando: true }));
        }
      }
    }
    // T29c: o "Menos informações" (m:) e a unica diferenca desde a base: so no aberto sem botao de opcao (LONGO, cujo
    // "A) / B)" sem DECISAO nao vira botao, e 'Feito.'; chamado e situacao com id); sem ele, o resto sai byte a byte igual
    const comMenos = saidas.map((s, i) => [i, JSON.stringify(s.botoes ?? null).includes('"m:')]).filter(([, m]) => m).map(([i]) => i);
    assert.deepEqual(comMenos, [9, 10, 21, 22, 33, 34, 45, 46], JSON.stringify(comMenos));
    for (const i of comMenos) assert.deepEqual(saidas[i].botoes, [[{ texto: 'Menos informações', dados: 'm:ABCDEFGH' }]]);
    const semMenos = saidas.map((s) => {
      const linhas = Array.isArray(s.botoes) ? s.botoes.filter((l) => !l.some((b) => String(b.dados).startsWith('m:'))) : s.botoes;
      return { ...s, botoes: Array.isArray(linhas) && linhas.length === 0 ? null : linhas };
    });
    assert.equal(crypto.createHash('sha256').update(JSON.stringify(semMenos)).digest('hex'), '5f2a7c3b0a8d4701e30d280aac65b9d9d16f21022633d172ce22172b20b2f50e');
  });

  test('T26a 3: resposta/aviso + bloco compacto: a parte da aba (opcoes em texto, sem botao de opcao) + o bloco escapado no fim, botoes do bloco', () => {
    const p = pedidoOk();
    const bloco = blocosDe(p);
    const ok = { bloco };
    for (const estado of ['resposta', 'aviso']) {
      const r = formatoTg.montarChamadoComOk({ estado, titulo: 'Nome', final: FINAL, chamadoId: ID }, ok);
      assert.deepEqual(Object.keys(r).sort(), ['botoes', 'classico'], 'sem html: sai sempre no classico');
      assert.equal(r.classico, `${PARTE}\n\n${esc(bloco.compacto.texto)}`, estado);
      assert.deepEqual(r.botoes, COMPACTO, estado);
      assert.ok(r.botoes.flat().every((b) => b.dados.startsWith('k:')), 'nenhum botao de opcao nem Mais informacoes do chamado');
    }
    // a parte da aba e a mesma da situacao sem botao
    assert.equal(formatoTg.montarChamadoComOk({ estado: 'resposta', titulo: 'Nome', final: FINAL }, ok).classico,
      `${montarSituacao({ titulo: 'Nome', final: FINAL }).classico}\n\n${esc(bloco.compacto.texto)}`);
    // sem texto: a frase de sempre de cada estado
    assert.equal(formatoTg.montarChamadoComOk({ estado: 'aviso', titulo: 'Nome', final: '' }, ok).classico, `<b>ℹ️ Nome</b>\nParou esperando você.\n\n${esc(bloco.compacto.texto)}`);
    assert.equal(formatoTg.montarChamadoComOk({ estado: 'resposta', titulo: 'Nome', final: ' ' }, ok).classico, `<b>ℹ️ Nome</b>\nRespondeu sem texto.\n\n${esc(bloco.compacto.texto)}`);
    assert.equal(formatoTg.montarChamadoComOk({ estado: 'resposta', titulo: 'Nome', final: 'Feito.' }, ok).classico, `<b>ℹ️ Nome</b>\nFeito.\n\n${esc(bloco.compacto.texto)}`);
  });

  test('T26a 4: qualquer outro estado = so o cabecalho + o bloco', () => {
    const p = pedidoOk();
    const bloco = blocosDe(p);
    // T28: o encerrado com o bloco ganha a linha dele (describe "T28 montarChamadoComOk", f4)
    for (const estado of ['enviando', 'entregue', 'contexto', 'problema', 'movido', 'ok', undefined, 'xyz']) {
      const r = formatoTg.montarChamadoComOk({ estado, titulo: 'Nome', final: FINAL, fala: 'oi', frase: 'algo', hora: '10:00', chamadoId: ID }, { bloco });
      assert.equal(r.classico, `<b>ℹ️ Nome</b>\n\n${esc(bloco.compacto.texto)}`, String(estado));
      assert.deepEqual(r.botoes, COMPACTO, String(estado));
    }
    assert.equal(formatoTg.montarChamadoComOk({ estado: 'ok', titulo: 'X', icone: '🎛️' }, { bloco }).classico, `<b>🎛️ X</b>\n\n${esc(bloco.compacto.texto)}`);
  });

  test('T26a 5: completo: ok.completo = bloco completo [[Sim, Nao]] e a parte aberta; versao.completo abre so a parte', () => {
    const p = pedidoOk();
    const bloco = blocosDe(p);
    const v = { estado: 'resposta', titulo: 'Nome', final: FINAL, chamadoId: ID };
    const k = formatoTg.montarChamadoComOk(v, { bloco, completo: true });
    assert.equal(k.classico, `${PARTE_ABERTA}\n\n${esc(bloco.completo.texto)}`);
    assert.deepEqual(k.botoes, SIM_NAO);
    const a = formatoTg.montarChamadoComOk({ ...v, completo: true }, { bloco });
    assert.equal(a.classico, `${PARTE_ABERTA}\n\n${esc(bloco.compacto.texto)}`);
    assert.deepEqual(a.botoes, COMPACTO);
    // so o cabecalho continua so o cabecalho
    assert.equal(formatoTg.montarChamadoComOk({ estado: 'entregue', titulo: 'Nome', final: FINAL }, { bloco, completo: true }).classico,
      `<b>ℹ️ Nome</b>\n\n${esc(bloco.completo.texto)}`);
  });

  test('T26a 6: fechado = o texto do ok.fechado, sem botoes; toque = o bloco aberto sem botoes', () => {
    const p = pedidoOk();
    const bloco = blocosDe(p);
    const v = { estado: 'resposta', titulo: 'Nome', final: FINAL, chamadoId: ID };
    const fechado = okTg.montarBlocoOkFechado({ ...p, linha: 'Você tocou em Sim às 10:05. A aba conferiu às 10:06.' });
    for (const completo of [false, true]) {
      const f = formatoTg.montarChamadoComOk(v, { bloco, completo, fechado });
      assert.equal(f.classico, `${completo ? PARTE_ABERTA : PARTE}\n\n${esc(fechado)}`);
      assert.equal(f.botoes, null);
      const t = formatoTg.montarChamadoComOk(v, { bloco, completo, toque: true });
      assert.equal(t.classico, `${completo ? PARTE_ABERTA : PARTE}\n\n${esc(completo ? bloco.completo.texto : bloco.compacto.texto)}`);
      assert.equal(t.botoes, null);
      // a mensagem fechada nao se toca; a tocada (sem teclado) ainda confere (T7i)
      assert.equal(conferir(f.classico, null, p).valido, false);
      assert.deepEqual(conferir(t.classico, null, p), { valido: true, acao: 'sim', completo, updateId: 900, toqueId: 'cbq-1', messageId: 77 });
    }
  });

  test('T26a 7: <pid> e & na acao: escapados no classico; o texto visivel confere no conferirToque com o teclado devolvido', () => {
    const acoes = ['subir o site X em produção', 'apagar <pid>.json & "x" &amp; y &lt;z&gt; <b>negrito</b>', 'R&D <script>alert(1)</script>'];
    for (const acao of acoes) {
      for (const tipo of ['publicacao', 'mensagem', 'disparo']) {
        const p = pedidoOk({ acao, tipo, destinatarios: tipo === 'publicacao' ? null : ['Ana & <Bia>'] });
        const bloco = blocosDe(p);
        for (const estado of ['resposta', 'aviso', 'entregue', 'ok']) {
          for (const completo of [false, true]) {
            for (const aberta of [false, true]) {
              const nome = JSON.stringify([acao, tipo, estado, completo, aberta]);
              const r = formatoTg.montarChamadoComOk({ estado, titulo: 'Nome & <x>', final: FINAL, completo: aberta, chamadoId: ID }, { bloco, completo });
              const b = completo ? bloco.completo : bloco.compacto;
              assert.ok(r.classico.endsWith(`\n\n${esc(b.texto)}`), nome);
              assert.ok(visivel(r.classico).endsWith(`\n${b.texto}`), nome);
              assert.deepEqual(r.botoes, b.botoes, nome);
              for (const letra of completo ? ['s', 'n'] : ['s', 'n', 'i']) {
                const c = conferir(r.classico, r.botoes, p, letra);
                assert.equal(c.valido, true, `${nome} ${letra}: ${c.motivo}`);
                assert.equal(c.completo, completo, nome);
              }
            }
          }
        }
      }
    }
  });

  test('T26a 8: corte de 4096: so na parte da aba, nunca no bloco (acao de 1500 com resposta aberta longa)', () => {
    const LONGO = Array.from({ length: 400 }, (_, i) => `linha ${i} & <tag> ${'x'.repeat(40)}`).join('\n');
    const acao = `${'ação <b>&amp; '.repeat(107)}fim!`.slice(0, 1500);
    const p = pedidoOk({ acao, titulo: 'x'.repeat(200), tipo: 'outro', destinatarios: ['Ana', 'Bia'] });
    const bloco = blocosDe(p);
    for (const [completo, aberta, estado] of [[true, true, 'resposta'], [false, true, 'resposta'], [true, false, 'aviso'], [false, false, 'resposta'], [true, true, 'entregue']]) {
      const nome = JSON.stringify([completo, aberta, estado]);
      const r = formatoTg.montarChamadoComOk({ estado, titulo: 'y'.repeat(200), final: LONGO, completo: aberta }, { bloco, completo });
      const b = completo ? bloco.completo : bloco.compacto;
      const vis = visivel(r.classico);
      assert.ok(vis.length <= 4096, `${nome}: ${vis.length}`);
      assert.ok(r.classico.endsWith(`\n\n${esc(b.texto)}`), `${nome}: o bloco inteiro no fim`);
      assert.ok(vis.includes(limparAcao(acao)), nome);
      assert.equal(conferir(r.classico, r.botoes, p).valido, true, nome);
      if (aberta && estado !== 'entregue') {
        // a parte aberta foi cortada no miolo e usa a sobra inteira
        assert.ok(vis.includes('\n(...)\n'), nome);
        assert.ok(vis.length >= 4090, `${nome}: ${vis.length}`);
        assert.ok(vis.includes('linha 0 '), `${nome}: cabeca`);
        assert.ok(vis.includes('linha 399 '), `${nome}: cauda`);
      }
    }
    // sem o OK, o mesmo chamado aberto continua com a sobra de sempre (4096)
    const sem = montarChamado({ estado: 'resposta', titulo: 'y'.repeat(200), final: LONGO, completo: true, chamadoId: ID });
    assert.equal(visivel(sem.classico).length, 4096);
    // bloco que quase enche a mensagem: o aberto ainda corta no miolo enquanto houver sobra (total = 4096)...
    const grande = `Pedido de OK (CRM): ${'a & <b> '.repeat(520)}`;
    const apertado = grande.slice(0, 4050);
    const ra = formatoTg.montarChamadoComOk({ estado: 'resposta', titulo: 'Nome', final: LONGO, completo: true }, { bloco, fechado: apertado });
    assert.ok(ra.classico.endsWith(`\n\n${esc(apertado)}`));
    assert.ok(ra.classico.includes('\n(...)\n'));
    assert.equal(visivel(ra.classico).length, 4096);
    // ... e a parte da aba que nao cabe vira so o cabecalho (o bloco fica inteiro)
    const enorme = grande.slice(0, 4080);
    for (const [estado, aberta] of [['resposta', true], ['resposta', false], ['aviso', true], ['aviso', false]]) {
      const r = formatoTg.montarChamadoComOk({ estado, titulo: 'Nome', final: LONGO, completo: aberta }, { bloco, fechado: enorme });
      assert.equal(r.classico, `<b>ℹ️ Nome</b>\n\n${esc(enorme)}`, `${estado} ${aberta}`);
      assert.ok(visivel(r.classico).length <= 4096);
    }
  });

  test('T26a 9: ok sem o bloco do que vai mostrar = TypeError', () => {
    const p = pedidoOk();
    const bloco = blocosDe(p);
    const v = { estado: 'resposta', titulo: 'Nome', final: FINAL };
    assert.throws(() => formatoTg.montarChamadoComOk(v, undefined), TypeError);
    assert.throws(() => formatoTg.montarChamadoComOk(v, {}), TypeError);
    assert.throws(() => formatoTg.montarChamadoComOk(v, { bloco: { compacto: bloco.compacto } , completo: true }), TypeError);
    assert.throws(() => formatoTg.montarChamadoComOk(v, { bloco: { completo: bloco.completo } }), TypeError);
    // fechado nao precisa do bloco
    assert.equal(formatoTg.montarChamadoComOk(v, { fechado: 'Pedido de OK (CRM): a\n\nfim' }).botoes, null);
  });
});

// A acao como o bloco mostra (a mesma limpeza do grupo)
function limparAcao(acao) {
  return limparParaWhatsApp(acao);
}

// ---------------------------------------------------------------------------------------------------------------
// T28 (PLANO-TELEGRAM.md, "T28"; pedido do dono 16/10/2026 08:29; troca do 18/10 15:49: «Deixa sem os X vermelhos, só em
// negrito»): o bloco fechado de vencido sai com a linha do fecho em NEGRITO (vinda de um campo estruturado, `forte`: o
// texto do pedido continua escapado), o botao "🔄 Tentar novamente" (`botoesFechado`) e, depois do toque, a 2a linha
// (`depois`); o encerrado com o bloco mostra a linha dele. Por que existe: o negrito nunca pode vir de HTML dentro do texto
// do pedido (seria injecao de marcacao) e o vencido sumia sem rastro no encerrar.
describe('T28 montarChamadoComOk: o fechado de vencido', () => {
  const COD = 'ABC234';
  const p = {
    codigo: COD, tipo: 'publicacao', acao: 'subir <b>X</b> & Y', destinatarios: null,
    criadoEm: '2026-10-02T13:00:00.700Z', expiraEm: '2026-10-02T13:30:00.700Z',
  };
  const LINHA = 'Expirou às 10:30 sem resposta.';
  const FECHADO = okTg.montarBlocoOkFechado({ ...p, linha: LINHA });
  const BOTAO = [[{ texto: '🔄 Tentar novamente', dados: `r:${COD}` }]];
  const visivel = (html) => String(html).replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const v = { estado: 'ok', titulo: 'Nome' };

  test('T28 f1: forte no fim do fechado = a linha em <b>, o resto escapado (sem <b> vindo do pedido), sem ❌; botoesFechado = os botoes', () => {
    const r = formatoTg.montarChamadoComOk(v, { fechado: FECHADO, forte: LINHA, botoesFechado: BOTAO });
    assert.equal(r.classico, `<b>ℹ️ Nome</b>\n\nPedido de OK (publicação): subir &lt;b&gt;X&lt;/b&gt; &amp; Y\n\n<b>${LINHA}</b>`);
    assert.deepEqual(r.botoes, BOTAO);
    assert.ok(!r.classico.includes('❌'));
    assert.ok(visivel(r.classico).endsWith(`\n${FECHADO}`), 'o texto visivel termina no bloco fechado');
  });

  // T28s (sabotagem #17 da t28.mjs): o forte tambem sai escapado
  test('T28s: o forte com < e & sai escapado dentro do <b>', () => {
    const forte = 'Expirou às 10:30 <sem> & resposta.';
    const r = formatoTg.montarChamadoComOk(v, { fechado: `Pedido de OK (publicação): x\n\n${forte}`, forte });
    assert.ok(r.classico.endsWith('\n\n<b>Expirou às 10:30 &lt;sem&gt; &amp; resposta.</b>'), r.classico);
  });

  test('T28 f2: sem forte (ou forte que nao fecha o texto) = sem negrito; sem botoesFechado (ou vazio) = sem botoes (os outros fechos, como hoje)', () => {
    const sem = formatoTg.montarChamadoComOk(v, { fechado: FECHADO });
    assert.equal(sem.classico, '<b>ℹ️ Nome</b>\n\nPedido de OK (publicação): subir &lt;b&gt;X&lt;/b&gt; &amp; Y\n\nExpirou às 10:30 sem resposta.');
    assert.equal(sem.botoes, null);
    const torto = formatoTg.montarChamadoComOk(v, { fechado: FECHADO, forte: 'outra linha', botoesFechado: [] });
    assert.equal(torto.classico, sem.classico);
    assert.equal(torto.botoes, null);
    const injetado = formatoTg.montarChamadoComOk(v, { fechado: FECHADO, forte: '<i>x</i>' });
    assert.ok(!injetado.classico.includes('<i>x</i>'));
  });

  test('T28 f3: depois = a 2a linha embaixo do fecho (escapada, sem negrito); com o botao fora', () => {
    const r = formatoTg.montarChamadoComOk(v, { fechado: FECHADO, forte: LINHA, depois: 'Pedi de novo à aba às 11:02.' });
    assert.ok(r.classico.endsWith(`\n\n<b>${LINHA}</b>\nPedi de novo à aba às 11:02.`), r.classico);
    assert.equal(r.botoes, null);
    const x = formatoTg.montarChamadoComOk(v, { fechado: FECHADO, forte: LINHA, depois: 'Não consegui pedir de novo à aba: a <tag> & "x".' });
    assert.ok(x.classico.endsWith('\nNão consegui pedir de novo à aba: a &lt;tag&gt; &amp; "x".'), x.classico);
  });

  test('T28 f4: o encerrado com o bloco = cabecalho, a linha do encerrado em italico e o bloco com o botao (pc e whatsapp)', () => {
    const pc = formatoTg.montarChamadoComOk({ estado: 'encerrado', titulo: 'Nome', hora: '2026-10-02T13:40:00.000Z', motivo: 'pc', final: 'Fiz.' },
      { fechado: FECHADO, forte: LINHA, botoesFechado: BOTAO });
    assert.equal(pc.classico, `<b>ℹ️ Nome</b>\n<i>Encerrada às 10:40: a aba seguiu no PC.</i>\n\nPedido de OK (publicação): subir &lt;b&gt;X&lt;/b&gt; &amp; Y\n\n<b>${LINHA}</b>`);
    assert.deepEqual(pc.botoes, BOTAO);
    const wpp = formatoTg.montarChamadoComOk({ estado: 'encerrado', titulo: 'Nome', hora: '2026-10-02T13:40:00.000Z', motivo: 'whatsapp' }, { fechado: FECHADO });
    assert.ok(wpp.classico.startsWith('<b>ℹ️ Nome</b>\n<i>Encerrada às 10:40: você respondeu pelo WhatsApp.</i>\n\n'), wpp.classico);
    // a linha do encerrado e a mesma do montarChamado
    assert.ok(montarChamado({ estado: 'encerrado', titulo: 'Nome', hora: '2026-10-02T13:40:00.000Z', motivo: 'pc' }).classico.includes('<i>Encerrada às 10:40: a aba seguiu no PC.</i>'));
  });
});
import crypto from 'node:crypto';
import * as formatoTg from '../lib/formato-tg.mjs';
import * as okTg from '../lib/ok-tg.mjs';
import { limparParaWhatsApp } from '../lib/formato.mjs';

// ---------- T29c: "Menos informações" (PLANO-TELEGRAM.md, "T29c") ----------
// Pedido do dono (18/10/2026 19:04, audio no Telegram): «quando eu clico em mais informações, ele expande [...] eu queria
// que tivesse um botão de comprimir de volta, a não ser quando tem um botão de pergunta e resposta». O aberto SEM botao
// de resposta (nenhuma opcao na tela, fora do OK) ganha, na ultima linha, "Menos informações" (m:<ID>); com opcao, como
// hoje. O OK dentro da mensagem (montarChamadoComOk) fica de fora.

describe('T29c. "Menos informações" no aberto sem botao de resposta', () => {
  const MENOS = [{ texto: 'Menos informações', dados: `m:${ID}` }];
  const LONGO = 'Publiquei o site.\n\nO deploy levou 2 min e o cache foi limpo.\n\nTudo conferido no ar.';
  const base = { titulo: 'Faro', hora: '2026-09-29T15:00:00.000Z', chamadoId: ID };

  test('dadosBotao menos = m:<ID> (10 bytes), prefixo que nao colide; lerDadosBotao de m: = menos; lixo = null; entrada invalida = TypeError', () => {
    const d = dadosBotao({ chamadoId: ID, acao: 'menos' });
    assert.equal(d, `m:${ID}`);
    assert.ok(Buffer.byteLength(d, 'utf8') <= 64);
    assert.deepEqual(lerDadosBotao(d), { acao: 'menos', chamadoId: ID });
    const outro = 'Z2Z2Z2Z2';
    assert.deepEqual(lerDadosBotao(dadosBotao({ chamadoId: outro, acao: 'menos' })), { acao: 'menos', chamadoId: outro });
    assert.ok(!['o', 'i', 'c', 'r', 'k', 'z'].includes(d.split(':')[0]), 'o prefixo nao e de outro botao (opcao, informacoes, legado, OK)');
    // os outros continuam
    assert.deepEqual(lerDadosBotao(`i:${ID}`), { acao: 'informacoes', chamadoId: ID });
    assert.deepEqual(lerDadosBotao(`o:${ID}:2`), { acao: 'opcao', chamadoId: ID, indice: 2 });
    for (const lixo of [`m:${ID}:1`, 'm:', `m:${ID.toLowerCase()}`, 'm:ABCDEFGI', 'm:ABCDEFG', ` m:${ID}`, `m:${ID}\n`, `M:${ID}`, `mm:${ID}`]) {
      assert.equal(lerDadosBotao(lixo), null, JSON.stringify(lixo));
    }
    for (const ruim of [{ chamadoId: 'abcdefgh', acao: 'menos' }, { acao: 'menos' }, { chamadoId: ID, acao: 'Menos' }]) {
      assert.throws(() => dadosBotao(ruim), TypeError, JSON.stringify(ruim));
    }
  });

  test('chamado: aberto sem opcao = so o "Menos informações"; aberto com opcao = so as opcoes (como hoje); compacto = como hoje (o "Mais informações", sem o Menos)', () => {
    for (const estado of ['aviso', 'resposta']) {
      const aberto = montarChamado({ ...base, estado, final: LONGO, completo: true });
      assert.deepEqual(aberto.botoes, [MENOS], estado);
      assert.ok(aberto.html.includes('Tudo conferido no ar.'), 'o texto inteiro');
      const compacto = montarChamado({ ...base, estado, final: LONGO });
      assert.deepEqual(compacto.botoes, [MAIS], `${estado} compacto`);
      const comOpcao = montarChamado({ ...base, estado, final: FINAL, completo: true });
      assert.deepEqual(comOpcao.botoes.flat().map((b) => b.dados), [`o:${ID}:0`, `o:${ID}:1`], `${estado} com opcao`);
      const comOpcaoCurto = montarChamado({ ...base, estado, final: FINAL });
      assert.deepEqual(comOpcaoCurto.botoes.flat().map((b) => b.dados), [`o:${ID}:0`, `o:${ID}:1`, `i:${ID}`]);
    }
    // sem texto pra abrir: nem Mais nem Menos (o completo nao abre nada)
    assert.equal(montarChamado({ ...base, estado: 'aviso', final: '', completo: true }).botoes, null);
    // os outros estados nao tem botao, abertos ou nao
    for (const estado of ['enviando', 'entregue', 'contexto', 'problema', 'encerrado']) {
      assert.equal(montarChamado({ ...base, estado, final: LONGO, completo: true, fala: 'x', motivo: 'pc' }).botoes, null, estado);
    }
  });

  test('o OK dentro da mensagem (montarChamadoComOk) fica de fora: aberto, sem opcao, nenhum "Menos informações"', () => {
    const v = { ...base, estado: 'resposta', final: LONGO, completo: true };
    const simNao = [[{ texto: 'Sim', dados: 'k:ABC123:s' }, { texto: 'Não', dados: 'k:ABC123:n' }]];
    const bloco = { compacto: { texto: 'Pedido de OK: x', botoes: simNao }, completo: { texto: 'Pedido de OK: x (inteiro)', botoes: simNao } };
    for (const completo of [false, true]) {
      const r = formatoTg.montarChamadoComOk(v, { bloco, completo });
      assert.deepEqual(r.botoes, simNao, `ok.completo ${completo}`);
    }
    assert.equal(formatoTg.montarChamadoComOk(v, { fechado: 'Pedido de OK: x\n\nfim' }).botoes, null);
  });

  test('situacao: aberta sem opcao = "Menos informações"; com opcao = so as opcoes; a de aba trabalhando (opcoes em texto) aberta = "Menos informações"; compacta = como hoje; sem id = sem botao', () => {
    const s = { titulo: 'Faro', situacao: 'Parada.', chamadoId: ID };
    assert.deepEqual(montarSituacao({ ...s, final: LONGO, completo: true }).botoes, [MENOS]);
    assert.deepEqual(montarSituacao({ ...s, final: LONGO }).botoes, [MAIS]);
    assert.deepEqual(montarSituacao({ ...s, final: FINAL, completo: true }).botoes.flat().map((b) => b.dados), [`o:${ID}:0`, `o:${ID}:1`]);
    const trab = { ...s, situacao: 'Trabalhando agora.', final: FINAL, trabalhando: true };
    assert.deepEqual(montarSituacao({ ...trab, completo: true }).botoes, [MENOS], 'T16: as opcoes ficam em texto, nao e botao de resposta');
    assert.deepEqual(montarSituacao(trab).botoes, [MAIS]);
    assert.equal(montarSituacao({ ...s, final: LONGO, completo: true, chamadoId: 'abc' }).botoes, null, 'sem id = sem botao');
    assert.equal(montarSituacao({ ...s, final: '', completo: true }).botoes, null, 'sem texto pra abrir');
  });
});

// ---------- T29d: a busca no painel (PLANO-TELEGRAM.md, "T29d") ----------
// Pedido do dono (18/10/2026 19:04, audio no Telegram): «uma função de buscar alguma palavra dentro daquela própria
// mensagem». O painel ganha o botao "Buscar" (p:b); com a busca, so as abas que batem no nome, no grupo ou na
// pergunta/1a frase, sem maiuscula e acento, em todos os grupos (antes do corte "e mais N"); topo "Busca: «x» (N abas)";
// nada = "Nenhuma aba com «x»."; o botao vira "Limpar busca" (p:l).

describe('T29d. a busca no painel', () => {
  const AG = '2026-10-18T22:00:00.000Z';
  const D = {
    hora: AG, modoRua: true, abertas: 9,
    esperando: [
      { titulo: 'Revisão do site', hora: AG, texto: 'Publico agora?', sid: 'e1' },
      { titulo: 'Faro', hora: AG, texto: 'Mando a proposta pro cliente São Paulo?', sid: 'e2' },
    ],
    aguardando: [{ titulo: 'Contrato', hora: AG, texto: 'Assino?', sid: 'a1', em: AG }],
    trabalhando: [{ titulo: 'Bateria do porteiro', sid: 't1' }, 'Outra coisa'],
    paradas: [{ titulo: 'Site novo', sid: 'p1' }, 'Planilha'],
    fechadas: [{ titulo: 'Velha', sid: 'f1', grupo: 'Clientes' }, { titulo: 'Solta', sid: 'f2', grupo: null }],
  };
  const { montarPainel, filtrarPainel, botoesPainel, palavraDaBusca, PERGUNTA_BUSCA, EXEMPLO_BUSCA } = formatoTg;

  test('o botao: sem busca "Buscar" (p:b), com busca "Limpar busca" (p:l); dados que nao colidem; leitura estrita', () => {
    assert.deepEqual(botoesPainel(null), [[{ texto: 'Buscar', dados: 'p:b' }]]);
    assert.deepEqual(botoesPainel('   '), [[{ texto: 'Buscar', dados: 'p:b' }]]);
    assert.deepEqual(botoesPainel('faro'), [[{ texto: 'Limpar busca', dados: 'p:l' }]]);
    assert.equal(dadosBotao({ acao: 'buscar' }), 'p:b');
    assert.equal(dadosBotao({ acao: 'limparBusca' }), 'p:l');
    assert.deepEqual(lerDadosBotao('p:b'), { acao: 'buscar' });
    assert.deepEqual(lerDadosBotao('p:l'), { acao: 'limparBusca' });
    for (const lixo of ['p:', 'p:x', 'p:bb', 'P:b', ' p:b', 'p:b\n', 'p:l ', `p:${ID}`]) assert.equal(lerDadosBotao(lixo), null, JSON.stringify(lixo));
    assert.equal(PERGUNTA_BUSCA, 'Qual palavra?');
    assert.equal(EXEMPLO_BUSCA, 'nome da aba ou palavra');
  });

  test('sem busca o painel e o de hoje (busca vazia ou so espaco = sem busca)', () => {
    const hoje = montarPainel(D);
    assert.deepEqual(montarPainel(D, {}), hoje);
    assert.deepEqual(montarPainel(D, { busca: '  ' }), hoje);
    assert.deepEqual(montarPainel(D, { busca: null }), hoje);
    assert.ok(hoje.html.includes('Abas abertas: 9'));
  });

  test('so as que batem, sem maiuscula e acento; topo "Busca: «x» (N abas)"; nome, pergunta mostrada e grupo', () => {
    const r = montarPainel(D, { busca: 'SITE' });
    assert.ok(r.html.startsWith('<h3>Busca: «SITE» (2 abas)</h3>'), r.html);
    assert.ok(r.classico.startsWith('<b>Busca: «SITE» (2 abas)</b>'), r.classico);
    for (const s of [r.html, r.classico]) {
      assert.ok(s.includes('Revisão do site') && s.includes('Site novo'), s);
      for (const fora of ['Faro', 'Contrato', 'Bateria', 'Outra coisa', 'Planilha', 'Velha', 'Solta', 'Abas abertas', 'Nada esperando']) assert.ok(!s.includes(fora), `${fora}: ${s}`);
    }
    assert.ok(r.html.includes('🔴 Esperando você (1)') && r.html.includes('🟢 Paradas (1)'), r.html);
    // acento e maiuscula dos dois lados; a pergunta mostrada (nao o nome)
    const sp = montarPainel(D, { busca: 'sao paulo' });
    assert.ok(sp.html.includes('(1 aba)') && sp.html.includes('Faro') && !sp.html.includes('Revisão'), sp.html);
    assert.ok(montarPainel(D, { busca: 'revisao' }).html.includes('Revisão do site'));
    assert.ok(montarPainel(D, { busca: 'ASSINO' }).html.includes('🔵 Aguardando (1)'), 'o aguardando pela pergunta');
    // o grupo das Fechadas (e o "Sem grupo")
    const cl = montarPainel(D, { busca: 'clientes' });
    assert.ok(cl.html.includes('Velha') && !cl.html.includes('Solta') && cl.html.includes('⚪ Fechadas (1)'), cl.html);
    assert.ok(montarPainel(D, { busca: 'sem grupo' }).html.includes('Solta'));
    assert.ok(montarPainel(D, { busca: 'porteiro' }).html.includes('🟡 Trabalhando (1)'));
    assert.equal(filtrarPainel(D, 'site').n, 2);
    assert.equal(filtrarPainel(D, '').n, null);
  });

  test('a Fechada escondida no "e mais N" aparece (o filtro olha os dados inteiros, antes do corte)', () => {
    const fechadas = Array.from({ length: 200 }, (_, i) => ({ titulo: i === 190 ? 'Zebra única' : `Aba ${i}`, sid: `z${i}`, grupo: 'G' }));
    const d = { ...D, esperando: [], aguardando: [], trabalhando: [], paradas: [], fechadas };
    const hoje = montarPainel(d);
    assert.ok(!hoje.html.includes('Zebra') && hoje.html.includes('(e mais 50)'), 'hoje ela fica no "e mais N"');
    const r = montarPainel(d, { busca: 'zebra unica' });
    assert.ok(r.html.includes('Zebra única') && r.classico.includes('Zebra única'), r.classico);
    assert.ok(r.html.includes('(1 aba)') && !r.html.includes('e mais'), r.html);
  });

  test('nada achado = "Nenhuma aba com «x»." sem grupos; a palavra escapada; o classico cabe', () => {
    const r = montarPainel(D, { busca: 'xyz' });
    assert.ok(r.html.startsWith('<h3>Nenhuma aba com «xyz».</h3>'), r.html);
    assert.ok(r.classico.startsWith('<b>Nenhuma aba com «xyz».</b>'), r.classico);
    for (const s of [r.html, r.classico]) for (const fora of ['Esperando', 'Aguardando', 'Paradas', 'Fechadas', 'Nada esperando']) assert.ok(!s.includes(fora), s);
    const tag = montarPainel(D, { busca: '<b>' });
    assert.ok(tag.html.includes('«&lt;b&gt;»') && !tag.html.includes('«<b>»'), tag.html);
    const amp = montarPainel({ ...D, paradas: ['P&D'] }, { busca: 'p&d' }); // a palavra escapada tambem no topo com aba achada
    assert.ok(amp.html.startsWith('<h3>Busca: «p&amp;d» (1 aba)</h3>') && amp.classico.startsWith('<b>Busca: «p&amp;d» (1 aba)</b>'), amp.html);
    assert.equal(palavraDaBusca('  a   b  '), 'a b');
    assert.equal(palavraDaBusca('x'.repeat(100)).length, 64);
    const muitas = { ...D, fechadas: Array.from({ length: 400 }, (_, i) => ({ titulo: `Site ${i} ${'x'.repeat(40)}`, sid: `s${i}`, grupo: 'G' })) };
    assert.ok(visivel(montarPainel(muitas, { busca: 'site' }).classico).length <= 4096);
  });
});
