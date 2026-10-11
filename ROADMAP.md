# Roadmap y fases futuras de Asistenta

Decisiones de Nico. Este fichero es la fuente de verdad de lo que entra, lo que
espera y lo que no entra. Cada fase futura lleva sus disparadores: hasta que no
se cumplen, no se construye.

## Backlog aprobado (en orden)

1. **Router de peticiones por niveles 1-4** (complejidad/coste): clasifica cada
   peticion y elige modelo/esfuerzo segun el nivel. Parte de la auditoria de
   context engineering. Es la palanca principal de coste de contexto.
2. **Verificacion con checklist + receipt antes de dar nada por listo**, y
   **spec antes de codigo** (patron project-spec-workflow), dentro del ciclo
   semanal de auto-mejora (evolve): complementa score.ts; "listo" sin prueba
   verificable no cuenta y cada entrega deja receipt.
3. **Patron de memoria indice -> timeline -> detalle** (inspirado en
   claude-mem): reutilizar la memoria actual (ya tiene scopes, IDs, fechas,
   supersedes y filtro de secretos); NO montar worker Bun+SQLite+Chroma extra.
   Medir recall/tokens/latencia antes y despues.
4. **Skills de ingenieria adaptadas de mattpocock/skills**: diagnosing-bugs y
   TDD (sintoma real -> test rojo -> fix minimo -> comprobacion). Se cargan
   solo al programar. Aplican tambien a CavaAI.
5. **Checklists de verificacion y evals de ECC** (verification-loop /
   eval-harness): adaptar a comandos locales y pruebas negativas de
   permisos/secretos/pago, sin sustituir score.ts ni CI. Usar `lint:check`
   (el lint normal escribe cambios).

## Fases futuras decididas (con disparadores)

- **Multi-agente (orquestador + EXPLORER/PLANNER/IMPLEMENTER, patron Hermes).**
  Decidido como fase futura (11-oct-2026); hoy NO se construye.
  Disparadores: (a) Asistenta hace builds grandes multi-archivo de forma
  habitual y (b) hay un LLM local gratuito disponible, que elimina el coste de
  tokens (el argumento principal en contra).
- **S5: busqueda semantica de skills/lecciones** (indice vectorial tipo
  ChromaDB + carga bajo demanda). Fase futura del aprendizaje tipo skills.
  Disparador: el volumen de lecciones supera ~50 y la carga estatica empieza
  a costar contexto.

## Descartado (con motivo)

- **cloud.nan.builders** (GPU a tarifa plana): de pago. Regla coste 0; solo
  con OK explicito de Nico.
- **claude-mem como producto**: observer alojado = prueba 30 dias y luego plan
  de pago; su fallback puede derivar a pago. Se adapta solo el patron.
- **gods-eye-view**: visual, no aporta evidencia financiera ni capacidad.
- **REA**: investigacion puntual de apps; no mejora lo existente.
- **paperclip**: sobreestructura para dos proyectos personales.
- **karpathy-skills como paquete**: sin licencia formal; se adaptan los
  principios con redaccion propia.

## En vigilancia (monitor)

- **VoiceStudio**: TTS local candidato para Asistenta; lo de "646 idiomas" no
  esta demostrado.
- **ppt-master**: exportar tesis/informes a PPT si algun dia hace falta.
- **DeepSeek V4-Flash**: la API oficial es de pago por token; el supuesto tier
  gratis de 500M tokens/mes no existe fuera de proxies de terceros.
- **Xiaomi MiMo V2.5**: gratis "limited time" (promo, puede dejar de serlo).
