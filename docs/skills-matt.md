# Skills de Matt Pocock adaptadas a Asistenta

Origen: [mattpocock/skills](https://github.com/mattpocock/skills), de Matt Pocock,
licencia MIT (Copyright (c) 2026 Matt Pocock). Adaptamos las ideas con redacción
propia en castellano para un asistente personal por Telegram.

## Preguntas antes de lo grande (grill-me / grilling)

Cuando le pides algo grande o abierto, Asistenta no se lanza a ciegas: te hace
**una ronda de 3 a 5 preguntas cortas**, numeradas y con su propuesta entre
paréntesis (contestar «sí» acepta las propuestas). Luego te resume en 2–3 líneas
lo que va a hacer y **solo empieza cuando dices «sí»**.

- Se pregunta: pedirle una función nueva («aprende a avisarme de la lluvia»),
  un plan («organízame la semana», «planifícame un viaje») o un encargo de varios
  pasos («busca vuelos, luego hoteles y después hazme un presupuesto»).
- No se pregunta nunca lo pequeño y claro: «pon la tele», «qué tiempo hace»,
  «recuérdame a las 9…».
- Para saltártelo: añade «hazlo ya» o «sin preguntas». Con la ronda abierta,
  «hazlo ya» empieza con lo que haya y «no» lo cancela.
- Una orden pequeña en medio («pon la tele») se atiende sin cerrar la ronda,
  que caduca a los 30 minutos.
- Solo en tu chat privado. Si el modelo no responde, usa tres preguntas fijas.

Código: `src/skills/grill.ts` (decide cuándo preguntar sin modelo).

## «No te he entendido» (wait-what)

Si justo después de una respuesta le dices «no te entiendo», «¿cómo?», «no lo
pillo» o «explícamelo más fácil», Asistenta te lo vuelve a explicar: primero en
una frase de qué hablabais y luego lo importante con palabras sencillas, sin jerga
y en pocas líneas. Lo reconoce el código (solo mensajes cortos) y no cambia nada
más. Código: `src/skills/wait-what.ts`.

## Cuestionario para otra persona (to-questionnaire)

Cuando necesitas algo de alguien que sabe lo que tú no («prepárame las preguntas
para el gestor», «qué le pregunto al casero»), Asistenta te pregunta solo a quién
va y qué necesitas saber, y te prepara las preguntas ordenadas por importancia,
una idea por pregunta. No lo envía a nadie sin tu permiso. Es una de las
habilidades generales (`src/skills/general.ts`).
