// A central e as pastas de projeto dos testes (A3a, PLANO-ABERTO.md "A3a — pastas de projeto, central e o claude"): o
// que o porteiro recebe no `central` e no `raizesSessao` do criarPorteiro.
// Por que existe: o nome e a pasta da central e as pastas de projeto sairam do codigo (A3a) e passaram a vir dos blocos
// `central` e `sessoes` do config.json; sem eles vale o padrao do produto (PADRAO_CENTRAL, na pasta do repositorio, e
// nenhuma pasta de projeto: nao abre nem reabre conversa). Os testes antigos foram escritos com a central e as 2 pastas
// do dono (o -n, o titulo, o cwd da raiz e as Fechadas da pasta codificada dela): montam o porteiro com estas, que sao a
// central e as pastas como o dono configura. Um lugar so: os nomes neutros moram aqui (e nos titulos dos testes que citam).
export const CENTRAL_TESTE = Object.freeze({ pasta: 'C:\\projetos', nome: 'Central de sessoes de teste' });
export const RAIZES_TESTE = Object.freeze(['C:\\projetos', 'D:\\Meus Docs\\trabalho\\Area']);
