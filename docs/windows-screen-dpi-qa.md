# Captura y coordenadas Windows con escalado DPI

## Causa reproducible

En main `cec9fe4`, la captura escribía sus dimensiones como `1280 x 853`, mientras JavaScript buscaba `/(\d+)x(\d+)/`. No había coincidencia por los espacios. El fallback declaraba el tamaño nativo como tamaño de la imagen, aunque el JPEG fuese menor. El modelo veía 1280x853 pero la herramienta creía 2160x1440: el clic no recibía la conversión correcta. El defecto no depende de Amazon ni de que el panel sea 16:9 o 3:2.

Además, cada captura, consulta de tamaño y movimiento usaba un proceso PowerShell nuevo sin declarar ni verificar el contexto DPI. En Windows, las API de geometría pueden devolver coordenadas virtualizadas según ese contexto. Esto hace posible una captura parcial en paneles escalados. Es un riesgo real del código, pero no se ha inspeccionado el incidente concreto ni el escritorio del Huawei de Nico.

## Corrección

- Captura, tamaño y movimiento establecen y verifican el contexto de hilo Per Monitor Aware V2 antes de consultar el monitor o mover el cursor. Se restaura el contexto anterior en `finally`. Si Windows no lo admite o no se puede verificar, falla sin captura/clic. No cambia la configuración DPI del usuario.
- La geometría física procede de `GetMonitorInfo` del monitor primario. No se utiliza el `PrimaryScreen.Bounds` lógico cacheado de WinForms. Se sigue capturando solo el monitor primario, no se añade soporte multimonitor.
- El mismo proceso que captura y reduce emite JSON con dimensiones nativas y de salida. No se combinan dimensiones de dos procesos ni se adivina un fallback.
- JavaScript valida ese JSON, el aspecto y el tamaño SOF del JPEG real. Una incoherencia obliga a capturar otra vez; no se usa la geometría falsa para hacer clic.
- El modelo sigue dando píxeles de la imagen. El mapeo existente usa por eje `pixelImagen * tamañoFisico / tamañoImagen`; no multiplica otra vez por el porcentaje DPI. La entrada de cursor usa `SetCursorPos` bajo el mismo contexto físico. Teclado y clipboard no necesitan ni reciben el nuevo preámbulo DPI.

Ejemplo sintético: panel físico2160x1440 a150% equivale a1440x960 lógicos; a200%,1080x720. En ambos casos se captura el panel completo2160x1440 y se entrega1280x853 si el límite es1280. El punto de imagen1180,803 se traduce a1991,1356 físicos, no a1180,803 ni a coordenadas multiplicadas dos veces por DPI.

## Verificación y límites

Canarios de backend+computer screenshot/click/move/drag con2160x1440 y escalas simuladas150/200%, regresión de espacios, JPEG distinto, metadatos inválidos y aspecto incoherente. Pruebas nativas Windows usan el script real de reducción y codificación, sustituyendo únicamente la fuente de escritorio por un bitmap sintético2160x1440 de cuatro esquinas de colores. Comprueban las cuatro esquinas en el JPEG1280x853 y suben esos frames sintéticos como artifact. No cambian el escalado real del runner ni mueven su ratón. No son una prueba física del Huawei.

La prueba visual local es también sintética y está identificada como tal. Después del merge hará falta actualizar/recompilar/reiniciar Asistenta y probar una captura en el PC durante una ventana aprobada. Este PR no accede al PC ni a su sesión de Amazon y no autoriza compras.

Fuentes API:
- https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setthreaddpiawarenesscontext
- https://learn.microsoft.com/en-us/windows/win32/hidpi/high-dpi-desktop-application-development-on-windows
