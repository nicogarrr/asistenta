# Prueba de Cua Driver en Windows (solo lectura)

Estado: preparada, NO ejecutada en Windows. Verificado solo en Linux aislado (cua-driver 0.37.0: daemon, health_report, list_windows, captura; sin AT-SPI). Nada de esto prueba Windows.

- Fuentes: https://cua.ai/docs/cua-driver, https://cua.ai/docs/cua-driver/guides/operate, https://github.com/trycua/cua/blob/main/LICENSING.md (Driver y SDK base MIT; Spaces FSL).
- Script: `scripts/windows/cua-driver-trial.ps1`. Lo ejecuta Asistenta con su aprobacion normal de comandos (muestra el comando exacto). Coste 0 EUR, sin relay ni cloud de Spaces.
- Lo que el instalador oficial hace por defecto y el script cambia: registra una tarea programada de autostart (se pasa `-NoAutoStart`) y anade al PATH de usuario (se pasa `-NoPathUpdate`).
- Telemetria: activada por defecto en Cua; el script la apaga en el entorno antes de ejecutar nada y luego con `telemetry disable`.
- Solo llamadas de lectura: health_report, get_screen_size, list_windows. Sin capturas, clics ni teclado.
- Salida: fichero local en %TEMP%\cua-trial-*\resultado.txt. Lo que se comparta debe ser el resumen (puede haber titulos de ventana privados).
- Pendiente tras ver el resultado real: decidir si merece un adaptador opcional tras flag. No se escribe sin ese contrato verificado en Windows.
