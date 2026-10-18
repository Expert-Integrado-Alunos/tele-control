# sessoes-wpp — transcricao LOCAL de 1 audio do dono (fase 5a, T4a: PLANO-TELEGRAM.md "Fatos medidos" e "### T4"; A5b:
# PLANO-ABERTO.md "A5b — a transcrição").
# Por que existe: o audio que o dono manda no Telegram vira fala sem sair do PC. O porteiro roda isto 1 por vez, em
# segundo plano (prazo 180 s), e le a ULTIMA linha do stdout; so com `transcricao.ligada` no config.json.
# Uso: python transcrever.py <arquivo> [idioma] [modelo_gpu] [modelo_cpu]
#   So o arquivo = os padroes (pt, large-v3-turbo, medium). O porteiro passa os 4 (lib/config.mjs transcricaoDoConfig).
#   idioma = aparado e em minuscula, 2 ou 3 letras (pt, en, yue); modelo = aparado, letra ou numero no comeco, depois
#   letra, numero, . _ / -, ate 100 caracteres, sem ".." (as mesmas regras do transcricaoDoConfig).
# Saida: 1 linha JSON (ensure_ascii) no stdout e nada mais:
#   {"ok": true, "texto": "...", "modelo": "large-v3-turbo", "dispositivo": "cuda", "segundos": 3.2}
#   {"ok": false, "erro": "<curto>"}
# Exit 0 nos dois; sem argumento = {"ok": false, "erro": "uso: transcrever.py <arquivo> ..."} e exit 2. Argumento fora
# das regras = {"ok": false, "erro": "<campo> invalido"} (idioma, modelo_gpu ou modelo_cpu), exit 0 (o porteiro le o erro),
# ANTES de olhar o arquivo e antes do import pesado.
# Nunca rede: HF_HUB_OFFLINE=1 antes do import e local_files_only=True (sem isso o faster-whisper consulta a internet e
# dobra o tempo de carregar). As DLLs cublas/cudnn de site-packages/nvidia/*/bin entram no PATH ANTES do import (gotcha
# do Windows: sem isso a GPU nao acha as DLLs da CUDA). GPU (modelo_gpu, float16) com erro = CPU (modelo_cpu, int8).
# Aviso de biblioteca vai pro stderr: o stdout fica so com a linha JSON.
import glob
import json
import os
import re
import sys
import time

MODELO_GPU = "large-v3-turbo"
MODELO_CPU = "medium"
IDIOMA = "pt"
RE_IDIOMA = re.compile(r"[a-z]{2,3}")
RE_MODELO = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,99}")


def responder(obj, codigo=0):
    """A unica escrita no stdout de verdade (o fd 1 original, guardado antes do trabalho)."""
    linha = json.dumps(obj, ensure_ascii=True) + "\n"
    if _STDOUT_ORIGINAL is not None:
        os.write(_STDOUT_ORIGINAL, linha.encode("ascii"))
    else:
        sys.__stdout__.write(linha)
        sys.__stdout__.flush()
    sys.exit(codigo)


def curto(e):
    s = "%s: %s" % (type(e).__name__, e)
    return " ".join(s.split())[:160]


def idioma_bom(v):
    return RE_IDIOMA.fullmatch(v) is not None


def modelo_bom(v):
    return RE_MODELO.fullmatch(v) is not None and ".." not in v


def argumento(argv, i, nome, padrao, normalizar, bom):
    """O argumento `i` normalizado; ausente = o padrao; fora da regra = responde "<nome> invalido" (e sai)."""
    if len(argv) <= i:
        return padrao
    v = normalizar(str(argv[i]))
    if not bom(v):
        responder({"ok": False, "erro": "%s invalido" % nome})
    return v


def preparar_dlls():
    base = os.path.join(os.path.dirname(sys.executable), "Lib", "site-packages", "nvidia")
    for sub in ("cublas", "cudnn"):
        for d in glob.glob(os.path.join(base, sub, "bin")):
            try:
                os.add_dll_directory(d)
            except (OSError, AttributeError):
                pass
            os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")


def transcrever_com(WhisperModel, arquivo, modelo, dispositivo, tipo, idioma):
    m = WhisperModel(modelo, device=dispositivo, compute_type=tipo, local_files_only=True)
    segmentos, _info = m.transcribe(arquivo, language=idioma, beam_size=5, vad_filter=True)
    # o gerador e preguicoso: o erro de GPU (DLL, memoria) aparece aqui, na leitura dos segmentos
    partes = [s.text.strip() for s in segmentos if s.text and s.text.strip()]
    return " ".join(partes).strip()


def principal(argv):
    if len(argv) < 2 or not str(argv[1]).strip():
        responder({"ok": False, "erro": "uso: transcrever.py <arquivo> [idioma] [modelo_gpu] [modelo_cpu]"}, 2)
    arquivo = argv[1]
    # A5b: os argumentos antes do arquivo e do import (argumento ruim nunca carrega nada)
    idioma = argumento(argv, 2, "idioma", IDIOMA, lambda v: v.strip().lower(), idioma_bom)
    modelo_gpu = argumento(argv, 3, "modelo_gpu", MODELO_GPU, lambda v: v.strip(), modelo_bom)
    modelo_cpu = argumento(argv, 4, "modelo_cpu", MODELO_CPU, lambda v: v.strip(), modelo_bom)
    if not os.path.isfile(arquivo):
        responder({"ok": False, "erro": "arquivo nao existe"})
    inicio = time.monotonic()
    os.environ["HF_HUB_OFFLINE"] = "1"
    preparar_dlls()
    try:
        from faster_whisper import WhisperModel
    except Exception as e:  # noqa: BLE001
        responder({"ok": False, "erro": "faster_whisper indisponivel (%s)" % curto(e)})
    try:
        texto = transcrever_com(WhisperModel, arquivo, modelo_gpu, "cuda", "float16", idioma)
        modelo, dispositivo = modelo_gpu, "cuda"
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("GPU falhou (%s): caindo pra CPU (%s)\n" % (curto(e), modelo_cpu))
        try:
            texto = transcrever_com(WhisperModel, arquivo, modelo_cpu, "cpu", "int8", idioma)
            modelo, dispositivo = modelo_cpu, "cpu"
        except Exception as e2:  # noqa: BLE001
            responder({"ok": False, "erro": "transcricao falhou (%s)" % curto(e2)})
    responder({
        "ok": True,
        "texto": texto,
        "modelo": modelo,
        "dispositivo": dispositivo,
        "segundos": round(time.monotonic() - inicio, 2),
    })


# O stdout de verdade fica guardado; durante o trabalho o fd 1 aponta pro stderr (biblioteca em C que escreve no fd 1
# tambem vai pro stderr). So o `responder` escreve no fd guardado.
_STDOUT_ORIGINAL = None

if __name__ == "__main__":
    try:
        sys.stdout.flush()
        _STDOUT_ORIGINAL = os.dup(1)
        os.dup2(2, 1)
        sys.stdout = sys.stderr
    except OSError:
        _STDOUT_ORIGINAL = None
    principal(sys.argv)
