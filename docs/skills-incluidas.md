# Skills incluidas: diagnosticar bugs y TDD

Asistenta trae dos skills de ingeniería (ROADMAP, «Seleccionado para adaptar» 2),
escritas con redacción propia:

- `diagnosticar-un-bug`: del síntoma real a la causa probada, sin adivinar.
- `tdd-test-rojo-antes-del-arreglo`: test que falla, arreglo mínimo, suite en verde.

Cómo funcionan:

- Al arrancar se crean en `state/skills/<id>/SKILL.md` solo si no existen. Si las
  editas a mano, tus cambios se respetan: nunca se vuelven a escribir encima.
- Se cargan solo al programar: su línea del índice `<skills>` del contexto aparece
  únicamente cuando la petición suena a código (bug, test, commit, `.ts`, `npm`…).
  En una charla normal no gastan tokens. `skills list` y `skills search` las
  encuentran siempre.
- Para no sembrarlas: `PA_BUILTIN_SKILLS=0` en el `.env`.
