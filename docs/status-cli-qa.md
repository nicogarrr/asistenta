# Consulta puntual del daemon

`pa status [--json]` y `pa watchdog --status [--json]` muestran PID y latido sin iniciar, matar ni reiniciar procesos. Solo se lee `agent.pid` y `agent.heartbeat`; la sonda de existencia usa señal0, no una señal de parada. No se abre configuración, bóveda, base de datos, logs ni red. No se crea el directorio de estado si falta.

Se distinguen PID ausente/inválido/ilegible, proceso existente/inexistente/desconocido y latido reciente/atrasado/ausente/futuro. Un error de permisos no se presenta como proceso muerto. Umbral120s, consistente con el módulo watchdog. PIDvivo ylatido reciente no prueban que Telegram o el modelo respondan. El estado del supervisor instalado se informa como desconocido; estos comandos NO instalan vigilancia ni reinician automáticamente. `pa watchdog` sin `--status` muestra ese límite y no hace nada.

Las docs y la descripción del instalador Windows dejan de afirmar que ese script instala un watchdog o cubre cuelgues: actualmente instala solo la tarea del daemon. El módulo de vigilancia existe, pero cablear un supervisor continuo y controlador segurostop/restart queda pendiente. No se cambia la tarea instalada de Nico ni su daemon.

43pruebas dirigidas pasan, incluyendo comandos compilados reales con estado temporal sin credenciales. Typecheck, build y Biome de todoelárbol verdes. Casos negativos: PID0/negativo/fraccionario/exponente/desbordado/no numérico, error de permisos, umbral exacto, fecha futura, estadoausente sincrearlo, bytesPIDintactos, directoriosinarchivosnuevos y opciones rechazadas sinlectura. Las pruebas existentes de watchdog y lifecycle siguen verdes. No se afirma prueba nativa Windows ni integración Telegram/LLM.

Suitecompleta nueva en contenedor Linux aislado con Node24,Git,Xvfb,xauth, rednormal y estado temporal, sin cuenta/sesiónNico: pendientealpublicar borrador, no se presenta verde sinresultado. Se usa fasegeneral2workers y fase recursos serial habitual sinrelajarumbrales. Comandos compilados están en la fase recursos existente junto al de diagnose.
