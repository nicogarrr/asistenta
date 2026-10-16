# Setup local parcial

## Uso

Con Node 24, dependencias instaladas y build actual:

```sh
node --env-file=.env dist/cli.js setup
```

Solo admite cambios en Linux, modo servidor y backend portable, con terminal local interactiva y `flock`. En Windows muestra una guía y no escribe configuración. No es un instalador Windows ni configura DPAPI.

## Qué hace

1. Comprueba requisitos y estado previo antes de pedir cambios. La evidencia de daemon antiguo o metadata ambigua bloquea el wizard: no sondea PID, no reclama locks y no borra pruebas previas.
2. Pide consentimiento inicial, adquiere propiedad exclusiva del daemon y después el lock del vault. Un daemon activo impide configurar.
3. Lee un snapshot fresco del almacén, sin copiar variables de entorno al archivo. Cada campo indica solo si viene del entorno, del archivo o falta.
4. Pregunta por Telegram token, IDs permitidos y clave del proveedor. Los valores no se imprimen. Las teclas de edición no se guardan como parte del secreto. Un campo existente exige elegir reemplazo; dejarlo vacío lo conserva. Un campo gestionado por entorno no se reemplaza desde el wizard.
5. Muestra solo los nombres que cambiarían y pide confirmación final. Escribe el lote en una operación atómica; si cambia el archivo o el entorno durante la revisión, aborta sin guardar el lote.

Cancelar antes de confirmar no escribe secretos. Puede quedar el directorio privado y el archivo de lock de propiedad, pero no se consideran prueba de daemon detenido. Ctrl+C, EOF, SIGTERM, SIGHUP y timeout de entrada cancelan y restauran el terminal. No se promete recuperación frente a SIGKILL o pérdida de energía.

No llama a Telegram ni al proveedor, no valida credenciales contra la red, no descarga modelos, no cambia proveedor, no arranca servicios y no activa autostart ni watchdog. Los campos son opcionales: guardar alguno no significa que `serve` ya tenga todos los requisitos. No se usa el PC ni la cuenta de Nico para QA.

## Pruebas

- Unitarias del flujo: consentimiento, plataforma, cancelación, reemplazo, entorno, resumen final y propiedad.
- Snapshot del vault: lectura fresca, preservación de claves ajenas, merge atómico, rechazo ante cambio externo y sin persistir overrides de entorno.
- Subprocesos del CLI construido: rechazo no-TTY y argumentos sin filtrar entrada ni crear estado.
- PTY Linux sintético: éxito, retroceso, flechas, pegado delimitado, Ctrl+C, EOF, SIGTERM y SIGHUP; comprueba ausencia de eco, valor exacto y restauración de ECHO/ICANON/ISIG. No usa secretos reales.

Las pruebas PTY requieren Python 3 y se ejecutan en la fase de recursos, después del build. No prueban un emulador gráfico concreto ni hardware Windows.
