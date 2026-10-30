# Sandbox opcional para la herramienta shell (F12)

`PA_SHELL_SANDBOX=off` (por defecto): la herramienta shell ejecuta PowerShell en el PC, como siempre (con aprobación de la Gate).

`PA_SHELL_SANDBOX=docker`: cada comando corre en un contenedor desechable (`docker run --rm`) con:
- sin red (`--network none`), raíz de solo lectura y `/tmp` temporal de 64 MB;
- sin capacidades (`--cap-drop ALL`, `no-new-privileges`), usuario 1000 (no root);
- 1 CPU, 512 MB, 256 procesos como mucho;
- solo la carpeta de trabajo montada en `/work`.

Imagen: `PA_SHELL_SANDBOX_IMAGE` (por defecto `mcr.microsoft.com/powershell:latest`). Si se agota el tiempo se mata el contenedor por nombre.

Si docker no está instalado o el valor de `PA_SHELL_SANDBOX` no se reconoce, el comando se **rechaza**: nunca se ejecuta en el PC sin aislamiento a escondidas.

`wsl` no se ofrece: WSL ve todo `C:` en `/mnt/c` y tiene red, así que no aislaría nada.
La sandbox no sustituye a las aprobaciones: la Gate sigue preguntando igual.
