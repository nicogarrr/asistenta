# Evidencia visual del selector Hy4

hy4-selector.png: captura del panel local real con datos sinteticos
(model hy4-flash-free, provider opencode-go y lista MODELOS_PANEL).
Chrome headless, viewport1100x900; captura de tarjeta Estado513x339.
Inspeccionada: selector Hy4 Flash (Go), aviso de promocion temporal,
coste comprobado por llamada y sin respaldo. No es captura del PC de Nico,
ni prueba de instalacion, despliegue o inferencia real. No contiene secretos.

Tests reproducibles de cobertura de los tres ficheros cambiados:

    npx vitest run test/provider*.test.ts test/hy4-zero.test.ts test/models.test.ts test/modelos-panel.test.ts --coverage --coverage.include=src/core/provider.ts --coverage.include=src/core/hy4-zero.ts --coverage.include=src/modelos-panel.ts --coverage.reporter=text --maxWorkers=2

70 tests/10archivos; provider96,55%lineas90,11%ramas;
guard100/90,38;selector100/96,55. Full TSC pendiente de CI.
