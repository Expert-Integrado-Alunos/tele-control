// Dados sinteticos do WhatsApp pros testes (A2a, PLANO-ABERTO.md "A2a — valores"): o grupo, as 2 instancias e os 2
// numeros que o config.json de teste traz no bloco `whatsapp`.
// Por que existe: o grupo e os numeros do dono sairam do codigo (A2a) e saem tambem dos testes (adianta a parte do
// WhatsApp da fase B): todo teste que precisa do WhatsApp tira daqui. Nenhum existe de verdade (DDD 00 nao existe).
export const GRUPO = '120300000000000001-group';
export const INSTANCIA_ENVIO = 'envio-teste';
export const INSTANCIA_CONFERENCIA = 'conferencia-teste';
export const NUMERO_DONO = '5500900000001';
export const NUMERO_ROBO = '5500900000002';

/** O bloco `whatsapp` completo do config.json de teste (ligado). */
export const WHATSAPP = Object.freeze({
  ligado: true,
  mcp: 'whatsapp-agent',
  grupo: GRUPO,
  instanciaEnvio: INSTANCIA_ENVIO,
  instanciaConferencia: INSTANCIA_CONFERENCIA,
  numeroDono: NUMERO_DONO,
  numeroRobo: NUMERO_ROBO,
});

/** O que o criarWpp recebe alem de url, headers e fetch. */
export const DESTINO_WPP = Object.freeze({
  grupo: GRUPO,
  instanciaEnvio: INSTANCIA_ENVIO,
  instanciaConferencia: INSTANCIA_CONFERENCIA,
});
