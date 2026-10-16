#!/usr/bin/env python3
"""Parche determinista de magic_mapper v1.1.0 (upstream andrewfraley).

Verifica el sha256 fijado del fichero ORIGINAL y aplica sustituciones EXACTAS:
cada ancla debe aparecer exactamente una vez, o aborta sin escribir nada.
Si el upstream cambia, el hash no cuadra y aborta ANTES de tocar el fichero.
El resultado se reparsea con ast antes de escribirse.

Cambios (seguridad del token del boton TV):

1. `curl -vs` -> `curl -s`: con -v, curl vuelca TODAS las cabeceras (la
   Authorization incluida) a stderr, y magic_mapper imprime esa salida en su
   log. El token acabaria en texto plano en /home/root/magic_mapper.log.
2. El print del comando completo pasa a anunciar solo metodo + url: ese print
   concatenaba argv entero, cabeceras incluidas.
3. Soporte `token_file` en inputs de la funcion curl: ruta a un archivo de
   configuracion de curl PRIVADO (0600, fuera del JSON de config y de los
   logs) que aporta la cabecera Authorization via `curl --config`. El token
   nunca viaja en argv del proceso, ni en magic_mapper_config.json, ni en
   logs. El instalador (install-magic-mapper.sh) es quien escribe ese
   archivo y EXIGE token: sin el no se despliega el mapeo.
"""
import ast
import hashlib
import sys

# sha256 de magic_mapper.py tal cual en andrewfraley/magic_mapper tag v1.1.0.
EXPECTED_SHA256 = "36839ef0468c094ea64e0c3fc8811c701fb8f7961ff7f6b905a41c39c58232f0"

REPLACEMENTS = [
    (
        'command_string = "curl -vs -X %s" % method',
        'command_string = "curl -s -X %s" % method',
    ),
    (
        "    command = command_string.split()\n",
        "    command = command_string.split()\n"
        "\n"
        '    token_file = inputs.get("token_file")\n'
        "    if token_file:\n"
        '        command.append("--config")\n'
        "        command.append(token_file)\n",
    ),
    (
        'print("Running curl command: %s" % " ".join(command))',
        'print("Running curl request: %s %s" % (method, url))',
    ),
]


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print(__doc__)
        return 2
    path = sys.argv[1]
    expect = EXPECTED_SHA256
    if len(sys.argv) > 2:
        # Override SOLO para los tests mock (fixtures sin el hash del upstream).
        # El instalador nunca lo pasa: ahi manda la constante fijada.
        if sys.argv[2].startswith("--expect-sha="):
            expect = sys.argv[2].split("=", 1)[1]
        else:
            print("argumento desconocido: %s" % sys.argv[2])
            return 2

    with open(path, "r", encoding="utf-8") as fh:
        src = fh.read()

    actual = hashlib.sha256(src.encode("utf-8")).hexdigest()
    if actual != expect:
        print(
            "ABORTA: sha256 de %s no cuadra (%s != %s) - upstream cambio, "
            "no se parchea a ciegas" % (path, actual, expect)
        )
        return 1

    for old, new in REPLACEMENTS:
        count = src.count(old)
        if count != 1:
            print(
                "ABORTA: ancla del parche aparece %d veces (esperaba 1): %r"
                % (count, old[:60])
            )
            return 1
        src = src.replace(old, new)

    ast.parse(src)  # syntax error aqui = aborta antes de escribir

    with open(path, "w", encoding="utf-8") as fh:
        fh.write(src)
    print("parche aplicado: curl sin -v, log sin argv, token_file via curl --config")
    return 0


if __name__ == "__main__":
    sys.exit(main())
