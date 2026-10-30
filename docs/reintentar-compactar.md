# /reintentar y /compactar

- `/reintentar` repite tu último mensaje de esta conversación (con sus imágenes) y antes quita del historial la respuesta anterior y lo que hizo ese turno, para que no influya. Si entre medias el historial se resumió o la conversación se reinició, se repite sin quitar nada y te lo digo. Ojo: las acciones que ya se hicieron (un correo enviado, un archivo escrito) no se deshacen; para eso está `/deshacer` donde aplique.
- `/compactar` resume ya el historial de esta conversación con el mismo resumen (y extracción de hechos a memoria) que el automático, y dice los tokens antes → después.

## /modelo

`/modelo` enseña el modelo de esta conversación y los configurados (`PA_MODEL`,
que es el principal, y `PA_FALLBACK_MODEL` si lo hay). `/modelo 2` o
`/modelo <nombre>` cambia el modelo solo para esta conversación; `/modelo normal`
vuelve al principal. Solo el dueño y desde su chat privado. Nunca acepta un
modelo que no esté configurado, y el cambio se guarda (`modelos.json` en el estado) y se mantiene aunque el asistente reinicie; si ese modelo deja de estar configurado, la conversación vuelve al principal.

Para tener más modelos entre los que elegir con `/modelo`, ponlos en `PA_MODELS` (separados por comas). Solo se usan si los eliges; el respaldo automático sigue siendo `PA_FALLBACK_MODEL`.

Al cambiar con `/modelo`, si el modelo nuevo tiene la mitad o menos de ventana de contexto que el anterior, o no ve imágenes y el anterior sí, la respuesta lo avisa («Ojo: …»). El cambio se hace igual.
