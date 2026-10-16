# Ayuda y menú de Telegram en español

- El menú nativo pasa de11a38comandos canónicos existentes, sin añadir rutas de ejecución ni aliases redundantes. Todos tienen un case en el dispatcher y caben en los límites de Telegram.
- `/watch` sigue grabando vídeo. La ayuda ya no promete `/watch live`: el directo real es `/screen live [intervalo_segundos]`, con `/screen off` para detenerlo. El handler conserva su intervalo de2a30segundos,5por defecto, y máximo15minutos.
- Mensaje de asistente privado y botones antiguos Permitir/Denegar en español. Payloads de aprobación y scopes intactos.
-20tests dirigidos verdes: catálogo3, botones13, reconexión4. Comprueban inventario sin duplicados, case de cada comando, distinción vídeo/foto y etiquetas.
- Typecheck verde. Build/lint y suite completa se registran en el cuerpo del PR.
- No se habló con el bot de Nico ni se modificó su menú real: el cambio se aplica cuando reinicie su daemon con este código.
- No cambia las funciones TV ni src/mail/client.js. No traduce todavía todos los motivos internos del gate: queda en bloque separado para conservar el alcance.
