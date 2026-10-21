#!/usr/bin/env bash
# bin/chave-mac.sh — guarda a chave do bot no Keychain do Mac sem por o valor na linha de comando (PLANO-MAC.md,
# "Mapa", linha 6; M4b). O porteiro le a chave de la (security find-generic-password -s <NOME> -w, lib/registro.mjs) e o
# tools/mac/instalar-mac.sh confere no passo 5 que ela existe; NOME = o telegram.varChave do config.json.
#
# Uso: <comando que imprime a chave> | bin/chave-mac.sh <NOME>
#   NOME: A-Z, 0-9 e _, 3 a 64, comecando por letra. A chave: 1 linha do stdin (o \r do fim sai), 10 a 4096 de
#   A-Za-z0-9:_./+=- (sem espaco nem aspas).
# Como o valor nunca aparece no `ps`: a linha "add-generic-password -U -a <usuario> -s <NOME> -w <valor>" vai pelo STDIN
# do `security -i` (o modo interativo le os comandos do stdin; o printf e do proprio bash, nao vira processo). A
# conferencia final roda find-generic-password SEM -w (o valor nao sai). Nada impresso traz o valor.
# Saida: 0 = "guardada: <NOME>"; 1 = "nao guardou: <NOME>"; 2 = fora do macOS, nome ou valor ruim.
# SO PARA TESTE: CHAVE_MAC_FORCAR=1 pula a conferencia do macOS; SECURITY_BIN troca o /usr/bin/security por um duble.
set -uo pipefail

if [ "$#" -ne 1 ]; then
  echo "uso: <comando que imprime a chave> | bin/chave-mac.sh <NOME>" >&2
  exit 2
fi
NOME="$1"

if [ "${CHAVE_MAC_FORCAR:-}" != 1 ] && [ "$(uname -s 2>/dev/null)" != Darwin ]; then
  echo "chave-mac: so no macOS (esta maquina e $(uname -s 2>/dev/null))" >&2
  exit 2
fi

if ! [[ "$NOME" =~ ^[A-Z][A-Z0-9_]{2,63}$ ]]; then
  echo "chave-mac: nome ruim (A-Z, 0-9 e _, 3 a 64, comecando por letra)" >&2
  exit 2
fi

# 1 linha do stdin; no terminal, sem eco (a chave nao aparece na tela)
VALOR=""
if [ -t 0 ]; then
  IFS= read -rs VALOR || true
  echo >&2
else
  IFS= read -r VALOR || true
fi
VALOR="${VALOR%$'\r'}"
# = ^[A-Za-z0-9:_./+=-]{10,4096}$, em 2 partes: o ERE do bash e do macOS nao aceita repeticao acima de 255 (RE_DUP_MAX)
if ! [[ "$VALOR" =~ ^[A-Za-z0-9:_./+=-]+$ ]] || [ "${#VALOR}" -lt 10 ] || [ "${#VALOR}" -gt 4096 ]; then
  echo "chave-mac: a chave lida do stdin esta fora do formato (10 a 4096 de A-Za-z0-9:_./+=-); nada foi guardado" >&2
  exit 2
fi

SEC="${SECURITY_BIN:-/usr/bin/security}"
USUARIO="${USER:-$(id -un 2>/dev/null)}"
# a saida do security -i vai pro lixo: o modo interativo pode ecoar a linha (com o valor)
printf 'add-generic-password -U -a %s -s %s -w %s\n' "$USUARIO" "$NOME" "$VALOR" | "$SEC" -i >/dev/null 2>&1
VALOR=""

if "$SEC" find-generic-password -s "$NOME" </dev/null >/dev/null 2>&1; then
  echo "guardada: $NOME"
  exit 0
fi
echo "nao guardou: $NOME" >&2
exit 1
