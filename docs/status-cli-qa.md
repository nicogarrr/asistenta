# `pa status`: cómo está Asistenta, sin tocar nada

`pa status` dice en castellano llano si Asistenta está en marcha y, si no, qué hacer. Ejemplos de lo que puede salir:

- En marcha y respondiendo: lo dice en la primera línea.
- «No hay archivo de PID: Asistenta no parece estar en marcha.» → «Para arrancarla: levantar.bat o pa iniciar.»
- «Asistenta no está en marcha: se cerró sin avisar.» → la misma pista para arrancarla.
- Latido atrasado → «Si sigue así: pa stop y vuelve a arrancarla (levantar.bat o pa iniciar).»
- «No pude comprobar si Asistenta está en marcha.» cuando un permiso impide mirarlo (no se da por muerta).

Siempre añade que estar en marcha no garantiza que Telegram y el modelo respondan (para eso, `pa doctor`), y que esta orden solo mira: no inicia ni reinicia nada y no comprueba el autoarranque (para eso, `pa autostart status`, que también enseña la última revisión del vigilante).

`pa status --json` no cambia: es para scripts y conserva los campos técnicos (pidState, heartbeatSource, ageMs…).

Qué lee: solo `agent.pid` y `agent.heartbeat` del directorio de estado; la comprobación del proceso usa la señal 0. No abre configuración, bóveda, base de datos, registros ni red, y no crea el directorio de estado si falta. Un latido que solo se puede deducir de la fecha del archivo se marca como no verificado, nunca como reciente.

`pa restart` para Asistenta con una parada limpia y la vuelve a arrancar; si no puede confirmarlo, lo dice y no mata ningún proceso.
