# Roadmap y plan de trabajo de Asistenta

Documento de trabajo. Distingue decisiones tomadas por Nico de recomendaciones
del equipo (aun por confirmar item a item). Las fases futuras llevan sus
disparadores: hasta que no se cumplen, no se construye.

## Decidido por Nico

1. **Router de peticiones por niveles 1-4** (complejidad/coste): clasifica cada
   peticion y elige el esfuerzo segun el nivel, con el punto de extension
   preparado para elegir modelo cuando haya varios gratuitos. Aprobado con
   clasificador heuristico local (sin LLM, determinista, coste 0,
   audit-loggeado, override por prefijo).
2. **Verificacion con checklist + receipt antes de dar nada por listo**, y
   **spec antes de codigo**, dentro del ciclo semanal de auto-mejora
   (evolve): complementa score.ts; "listo" sin prueba verificable no cuenta y
   cada entrega deja receipt.
3. **Multi-agente (orquestador + EXPLORER/PLANNER/IMPLEMENTER, patron Hermes)**
   como FASE FUTURA decidida; hoy NO se construye. Disparadores: (a) Asistenta
   hace builds grandes multi-archivo de forma habitual y (b) hay un LLM local
   gratuito disponible, que elimina el coste de tokens (el argumento principal
   en contra).
4. **PWA de CavaAI** (manifest + service worker + instalable + push; coste 0):
   aprobada, vive en el backlog de CavaAI.

## Seleccionado para adaptar (recomendacion del equipo, bajo el mandato general)

Cubierto por el mandato de Nico de seguir al maximo; pendiente de su
confirmacion item a item si se quiere.

1. **Patron de memoria indice -> timeline -> detalle** (inspirado en
   claude-mem): reutilizar la memoria actual (ya tiene scopes, IDs, fechas,
   supersedes y filtro de secretos); NO montar worker Bun+SQLite+Chroma extra.
   Medir recall/tokens/latencia antes y despues.
2. **Skills de ingenieria adaptadas de mattpocock/skills**: diagnosing-bugs y
   TDD (sintoma real -> test rojo -> fix minimo -> comprobacion). Se cargan
   solo al programar. Aplican tambien a CavaAI.
3. **Checklists de verificacion y evals de ECC** (verification-loop /
   eval-harness): adaptar a comandos locales y pruebas negativas de
   permisos/secretos/pago, sin sustituir score.ts ni CI. Usar `lint:check`
   (el lint normal escribe cambios).
4. **diagram-design**: plantillas estaticas de diagramas; candidato para la
   revision de frontend de CavaAI. Decision de inclusion pendiente; anotado
   aqui para no perderlo.
5. **S5: busqueda semantica de skills/lecciones** (indice vectorial tipo
   ChromaDB + carga bajo demanda). Fase futura del aprendizaje tipo skills.
   Disparador: el volumen de lecciones supera ~50 y la carga estatica empieza
   a costar contexto.

## Descartado (con motivo)

- **cloud.nan.builders** (GPU a tarifa plana): de pago. Regla coste 0; solo
  con OK explicito de Nico.
- **claude-mem como producto**: segun el informe del 11-oct-2026, el observer
  alojado es de pago tras un periodo de prueba y su fallback puede derivar a
  pago; verificar coste/disponibilidad actual antes de cualquier uso. Se
  adapta solo el patron.
- **gods-eye-view**: visual, no aporta evidencia financiera ni capacidad.
- **REA**: investigacion puntual de apps; no mejora lo existente.
- **paperclip**: sobreestructura para dos proyectos personales.
- **karpathy-skills como paquete**: sin licencia formal detectada; se adaptan
  los principios con redaccion propia.

## En vigilancia (monitor)

- **VoiceStudio**: TTS local candidato para Asistenta; la cobertura de
  idiomas anunciada no esta verificada.
- **ppt-master**: exportar tesis/informes a PPT si algun dia hace falta.
- **DeepSeek V4-Flash**: no confirmado un tier gratuito real en la API
  oficial (verificado el 11-oct-2026 contra su documentacion de precios:
  facturacion por token); verificar coste antes de usar.
- **Xiaomi MiMo V2.5**: la web oficial lo marcaba gratis "limited time" al
  11-oct-2026; promo temporal, verificar disponibilidad antes de usar.

Fuentes: informe de analisis de los 10 repos (11-oct-2026) y conversacion con
Nico del 11-oct-2026.
