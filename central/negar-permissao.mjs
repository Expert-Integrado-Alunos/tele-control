// sessoes-wpp — o hook PermissionRequest da central e da sessao escondida no modo "pedir" (A5d): ninguem olha a tela,
// entao todo pedido de licenca que sobra (fora das regras do roteamento no permissions.allow) e negado com uma mensagem
// que diz ao Claude o que fazer: contar ao dono, na resposta, o que precisava e por que.
// Le a entrada (o JSON do evento) ate o fim, com prazo de 2 s, e responde o deny; exit 0 sempre (exit 2 NAO nega; o
// hook que falha nega pelo `onFailure: "block"` dos ajustes).
// Contrato: PLANO-ABERTO.md, "A5d — a central montada".
const MENSAGEM = 'Negado: esta sessão roda sem ninguém no PC e não pede licença na tela. Não tente de novo nem por outro '
  + 'caminho: diga ao dono, na sua resposta, o que precisava fazer e por quê.';
const PRAZO_MS = 2000;

let respondeu = false;
function responder() {
  if (respondeu) return;
  respondeu = true;
  const saida = {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: MENSAGEM } },
  };
  process.stdout.write(`${JSON.stringify(saida)}\n`, () => process.exit(0));
}

setTimeout(responder, PRAZO_MS);
process.stdin.on('data', () => {});
process.stdin.on('end', responder);
process.stdin.on('error', responder);
process.stdin.resume();
