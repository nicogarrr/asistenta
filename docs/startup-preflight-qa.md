# Arranque y error antes del primer hilo

## Alcance

- `serve` construye el proveedor antes de crear stores, canales y threads: detecta la falta de clave sin pedir una respuesta al modelo.
- Telegram se comprueba con getMe, con límite de10s y errores en español. No imprime el token ni la URL que lo contiene. El canal deQA aislado no consulta Telegram.
- El callback autorizado de entrada tiene una última frontera de error: si falla crear el primer hilo, contesta en el chat original, registra un mensaje saneado y no repite la tarea. Los callbacks Telegram devuelven la promesa para que grammY pueda observar su error.
- No valida que la clave del modelo sea aceptada: hacerlo requeriría una llamada al proveedor y podría consumir saldo. No cambia `src/mail/client.js` ni funciones de TV.

## Verificación local

-39tests dirigidos: startup9, cableado serve2, reconexión Telegram4, memoria/cableado CLI24.
- Casos: sin clave, token401/404, red caída, JSON inválido, respuesta no confirmada, éxito, error antes del hilo, fallo de la propia respuesta y no filtrado de texto arbitrario.
- Ningún test dirigido llama a Telegram ni al modelo: tokens y mensajes de fixture.
- Primer entorno sinred/git/pantalla:2255pasadas/35fallidas/19skip, más55recursosserial pasadas. Se reprodujeron exactamente los35nombres fallidos en main d5dee03 sin cambios en los mismos7archivos. No se afirma suite verde en ese entorno.
- Reejecución en contenedor desechable sin secretos, congit/red/Xvfb+xauth:2293pasadas/18omitidas (174archivosOK y1omitido), recursos55/55, exit0.
- No se reinició el daemon del usuario ni se enviaron mensajes a su Telegram.
