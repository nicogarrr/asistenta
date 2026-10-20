# Prueba de Cua Driver en Windows (solo lectura, aislada)

Estado: preparada, NO ejecutada en Windows. Verificado solo en Linux aislado (cua-driver 0.37.0: daemon, health_report, list_windows, captura; sin AT-SPI). Nada de esto prueba Windows.

- Fuentes: https://cua.ai/docs/cua-driver, https://cua.ai/docs/cua-driver/guides/operate, https://github.com/trycua/cua/blob/main/LICENSING.md (Driver y SDK base MIT; Spaces FSL).
- NO se usa el instalador oficial: trae migraciones/repair, mata procesos, toca tareas programadas y PATH (AutoStart ON por defecto) y descarga un modulo mutable de cua.ai sin hash.
- En su lugar: ZIP fijado https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.37.0/cua-driver-rs-0.37.0-windows-x86_64.zip con SHA256 fijado 109ab57e5c0a6e13a73e2ce2daf01b338027366eb1a20c6e0b413a10610bc8e2 (igual que SHA256SUMS de la release; hash comprobado, la firma sigstore del ZIP no se ha verificado) y Authenticode "Cua AI, Inc." exigido a cada .exe. La release figura como prerelease en GitHub.
- Aislamiento: carpeta en %TEMP%, preflight que ABORTA si hay tarea cua-driver-serve, procesos cua-driver*/cua-driver-uia, carpetas .cua-driver, .cua-driver-rs, Programs\Cua, Programs\trycua, cua-driver en PATH o variables CUA_DRIVER_RS_*. Al acabar solo para procesos de esa carpeta y borra solo esa carpeta. Si el exe deja estado en ~\.cua-driver o ~\.cua-driver-rs, NO se borra (podria ser ajeno): el script lo avisa y se revisa a mano.
- Telemetria: activada por defecto en Cua; el script la apaga en el entorno antes de ejecutar nada y luego con `telemetry disable`.
- Solo lectura: health_report, get_screen_size, list_windows. Sin capturas, clics ni teclado. Resultado completo en %TEMP%\cua-trial-*\resultado.txt (puede tener titulos de ventana); por pantalla solo un resumen.
- No verificado: sintaxis `serve`/`call` en Windows, ficheros de estado en Windows, formato de list_windows.
- Pendiente tras el resultado real: decidir si merece un adaptador opcional tras flag. No se escribe sin ese contrato verificado.
