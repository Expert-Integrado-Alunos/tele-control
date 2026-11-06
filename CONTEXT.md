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
| Pedido de OK | O pedido de aprovação de uma ação (deploy, disparo) que o dono responde com Sim ou Não; vale 30 min |
| Toque | O clique do dono num botão do Telegram (Sim, Não, uma opção, um nome de aba) |
| Verificar | A conferência do OK: relê o toque no servidor do Telegram antes de liberar a ação |
| Trava (do OK) | A palavra "trava" do dono no chat ou no grupo: invalida os OKs abertos |
| Recado | A mensagem que o porteiro ou outra sessão manda para dentro de uma aba pelo canal entre sessões |
| Mensageiro | O programa que entrega o recado na aba, um por vez |
| Painel | A mensagem única do Telegram com todas as abas por grupo: Esperando você, Aguardando, Trabalhando, Paradas e Fechadas |
| Situação | A resposta ao toque no nome de uma aba no painel: em que pé ela está e a última mensagem dela |
| Esperando você | Grupo do painel com as conversas que têm pergunta para o dono |
| Aguardando | Grupo do painel para onde o dono (ou o tempo, 48 h com a aba fechada) move a pergunta que não quer ver agora |
| Paradas | Conversas sem pergunta que mexeram nas últimas 48 h |
| Fechadas | Conversas sem pergunta paradas há mais de 48 h; abertas ou fechadas, pelos grupos do VS Code |
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
