# REA: mirar cómo funciona una app por dentro

[REA](https://github.com/morluto/rea) (licencia MIT, paquete npm `rea-agents`) es una herramienta para analizar apps: programas de Windows, apps de escritorio hechas con JavaScript/Electron, programas .NET y webs. Asistenta la usa si la tienes instalada: viene **encendida** (salvo `PA_REA=0`).

Gracias al equipo de REA por publicarla con licencia MIT.

## Qué puedes pedirle

- «Mira cómo hace X esta app» (por ejemplo: «mira cómo guarda las notas esta app: C:\Programas\Notas»).
- «Analiza esta app» con la ruta del programa o la carpeta de la app.

Asistenta te enseña lo que encuentra y de dónde lo saca.

## Reglas

- Solo tú (el dueño, en tu chat privado) puedes pedirlo.
- **Cada** análisis te pide permiso antes. No hay «Siempre» para esto.
- Solo lectura: Asistenta solo usa las herramientas que REA marca como de solo lectura o que no tocan nada. Las que ejecutan la app o borran datos quedan fuera.
- REA no ve tus claves: se arranca solo con lo justo del entorno (rutas, carpeta de usuario y temporales), no con tu `.env`.
- Lo que devuelve cuenta como contenido de fuera: si luego algo fuera a salir de tu PC con ese texto, Asistenta te pregunta.

## Cómo activarlo en Windows

1. Node ya lo tienes (lo instaló `instalar.bat`).
2. Abre PowerShell y escribe `npm install --global rea-agents`. Sin esto Asistenta no descarga nada al arrancar: solo deja una línea en el registro diciendo cómo instalarlo.
3. Si prefieres no instalarlo, pon `PA_REA=1` en tu `.env` y Asistenta lo bajará sola con `npx -y rea-agents mcp` (la primera vez tarda un poco).
4. Apaga y enciende Asistenta (`levantar.bat`).

### Ghidra (opcional)

Para mirar programas nativos (.exe, .dll) a fondo REA puede usar [Ghidra](https://ghidra-sre.org/), que es gratis. Instálalo (necesita Java) y añade a tu `.env` la carpeta donde lo descomprimiste, por ejemplo `GHIDRA_INSTALL_DIR=C:\ghidra`. Sin Ghidra, REA sigue funcionando con apps JavaScript/Electron, .NET y webs.

## Para apagarlo

Pon `PA_REA=0` en el `.env` y reinicia Asistenta.
