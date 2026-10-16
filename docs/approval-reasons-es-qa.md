# Motivos de aprobación en español

Traducción de12motivos conocidos en la capa de presentación `formatApproval`, no en el gate. Motivos desconocidos o ya en español se conservan literalmente. No cambia comandos, argumentos, payloads, scopes ni decisiones.

-46tests dirigidos verdes: traducción7, approval-text20, browser-free19. El canario conserva un comando que contiene la misma frase inglesa y prueba args sin modificación.
- Typecheck/build/lint completos EXIT0/0/0.
- Mantiene la detección de secretos y el límite de texto; no traduce ni reescribe las operaciones que la persona aprueba.
- No usa Telegram real ni datos/cuentas del usuario.
- No se afirma traducción completa del producto: mensajes CLI y motivos personalizados quedan para su propio alcance.
