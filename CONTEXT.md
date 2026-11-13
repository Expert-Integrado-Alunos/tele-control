# Glossário do Tele Control

| Termo | Significado |
| --- | --- |
| Tele Control | O produto: controle pelo celular das abas do Claude Code abertas no PC. Nome interno antigo: `sessoes-wpp` |
| Dono | A pessoa que usa o controle: recebe os avisos, responde e aprova. Vem do bloco `dono` do `config.json` |
| Aba | Uma conversa do Claude Code aberta no PC (VS Code, terminal, Claude Desktop com canal de recado ou Orca) |
| Porteiro | O processo sem IA que lê os canais, decide o que avisar e entrega a resposta na aba certa. Único leitor contínuo do Telegram |
| Central | A sessão do Claude Code que recebe a fala solta do dono (a que não responde a nenhuma aba) e encaminha, abre ou reabre sessões |
| Sessão escondida | Sessão do Claude Code aberta pelo porteiro num console sem janela, sem tirar o teclado de quem usa o PC |
| Parou | O evento que o hook grava quando uma aba termina a vez; é a matéria-prima do aviso |
| Aviso (chamado) | A mensagem curta no celular quando uma aba para esperando o dono: título, 1ª frase, a pergunta e as opções |
| Mais informações | O botão do aviso que abre o texto completo na mesma mensagem, sem ir até a aba |
| Modo rua | O estado em que o dono está fora do PC: o porteiro liga e a aba escreve a pergunta como texto (bloco DECISÃO) em vez de abrir botões na tela |
| Modo limpo | O jeito das mensagens no Telegram em que o que já foi resolvido sai do chat; o outro é "manter tudo", em que nada sai e o resolvido só perde os botões. Troca pelo `/modo` |
| Ajustes (mensagem) | A mensagem do bot que o `/rua`, o `/modo` e o `/voz` abrem: mostra o estado de hoje com o botão de trocar e se atualiza sozinha quando o estado muda |
| Pedido de OK | O pedido de aprovação de uma ação (deploy, disparo) que o dono responde com Sim ou Não; vale 30 min |
| Toque | O clique do dono num botão do Telegram (Sim, Não, uma opção, um nome de aba) |
| Verificar | A conferência do OK: relê o toque no servidor do Telegram antes de liberar a ação |
| Trava (do OK) | A palavra "trava" do dono no chat ou no grupo: invalida os OKs abertos |
| Recado | A mensagem que o porteiro ou outra sessão manda para dentro de uma aba pelo canal entre sessões |
| Mensageiro | O programa que entrega o recado na aba, um por vez |
| Endereço (da aba) | O nome da aba mais o código curto que a lista de sessões mostra ao lado dele (`nome [ref]`). É o que separa duas abas com o mesmo nome; vale enquanto o processo da aba vive |
| Conferência de endereço | O recado automático, sem nada do dono, que o porteiro manda pra uma de duas abas de mesmo nome pra ver em qual conversa ele cai. A aba parada responde só "ok" e nada vai pro celular |
| Painel | A mensagem única do Telegram com as abas por grupo, em 2 modos: o padrão (Esperando você, Aguardando, Trabalhando, Paradas e Paradas há mais de 2 dias) e o modo VS Code |
| Modo VS Code | O painel igual à lista de sessões do VS Code: uma seção por janela, os grupos com o nome, a ordem e o número da tela, e as arquivadas só contadas (`painel.modo: "vscode"` no `config.json`) |
| Sincronizar | O botão do painel que relê a lista e as abas abertas do VS Code na hora e refaz o painel |
| Situação | A resposta ao toque no nome de uma aba no painel: em que pé ela está e a última mensagem dela |
| Esperando você | Grupo do painel com as conversas que têm pergunta para o dono |
| Aguardando | Grupo do painel para onde o dono (ou o tempo, 48 h com a aba fechada) move a pergunta que não quer ver agora |
| Paradas | Conversas sem pergunta que mexeram nas últimas 48 h |
| Paradas há mais de 2 dias | Conversas sem pergunta paradas há mais de 48 h; abertas ou fechadas, pelos grupos do VS Code (antes "Fechadas") |
| Fechada (marca) | Conversa sem processo rodando e sem aba aberta no VS Code |
| Foco | O grupo do VS Code que limita o painel (`painel.foco` no `config.json`) |
| Reabrir | Retomar pelo celular a MESMA conversa de uma aba que fechou, escondida |
| Sonda | A conferência que apaga a duplicata de uma mensagem do bot cujo envio ficou incerto |
| Rotina | O lote de decisões do dia que o porteiro manda no Telegram: resumo fixado e cartões com botões. Na rotina, "lote" é o pacote do dia; no porteiro, "lote" é o pacote do `getUpdates` |
| Guardião | O processo do `.vbs` que confere o porteiro a cada 60 s e religa |
| Supervisor | O hook que religa o porteiro quando uma sessão do Claude Code abre |
| Desligado | O arquivo na pasta de estado que impede o guardião e o supervisor de religar o porteiro |
| Religar | Parar e subir o porteiro de novo para ele carregar código ou configuração nova |
| Fecho | A lista do que o porteiro carrega; mudou algo do fecho, tem de religar |
| Tomada | Arquivo curto em outro repositório que chama o hook deste, pelo mesmo caminho |
| Cópia aberta | A cópia do código para os alunos: o versionado menos o `export-ignore`, sem histórico |
| Ensaio | Modo de teste do porteiro, com estado próprio (`estado-ensaio.json`), que nunca lê o Telegram |
| Sabotagem | Mutação proposital do código numa cópia para provar que um teste fica vermelho |
