# Inspeccion LG webOS sin cambios

La herramienta `tv` admite `action=inspect`. Lee una vez el inventario y el primer plano
por SSAP y, si existe, `GET /api/stats` de Glasshouse. No empareja, instala, abre apps,
manda teclas, captura imagenes, muestra avisos, cambia adblock ni reinicia servicios.
Necesita el emparejamiento SSAP ya guardado; no hace setup automatico.

Cada fuente devuelve `status=ok` con su valor o `status=unavailable`. Un fallo parcial no
borra los resultados de las otras fuentes ni se interpreta como cero, inventario vacio
o tele apagada. No se devuelven errores de red ni el JSON crudo de Glasshouse.
`complete` indica que todas las fuentes devolvieron datos utilizables, no que todos los
campos de telemetria existan. Los campos desconocidos son `null`. Los tiempos del informe
son los de consulta en el PC, no los de produccion de cada dato; las lecturas no son atomicas
y Glasshouse puede devolver su cache. `usedKiB` es total menos disponible, no RSS por app.

Es una base para medir ANTES de proponer optimizaciones. No declara apps como bloatware,
no crea un backup restaurable de ajustes y no ejecuta limpieza. No promete ahorros de RAM.

## Referencias y compatibilidad

- https://github.com/bryanroscoe/shield_optimizer : Android TV por ADB. No usar sus
  comandos, APKs, launchers ni listas de paquetes en LG webOS.
- https://github.com/Fardeen26/tv-vibe-kit : tambien Android TV. Se aprovecha la idea de
  inventario primero y cambios revisados con restauracion, no su ejecutor.
- https://github.com/rorygallagher2024/glasshouse : transporte ya integrado en Asistenta.
  El colector `server/lib/telemetry.js` expone `mem.total/avail` y `swap.total/free` desde
  `/proc/meminfo` en KiB, temperatura y uptime. Revisado en
  `1c59034e0ec0a2fc50925ad48968515eba803ea4`; la version instalada puede no tenerlos.

La cifra 192 MB a 83 MB de una captura de redes no mide esta LG. El salvapantallas de arte
ya tiene kit en `tools/tv-screensaver`; no se ha verificado su montaje en la C5/webOS 26.
No reemplazar Home ni instalar un modelo en la TV por analogia con Android. El control por
intencion y voz debe usar los adaptadores webOS y el PC ya existentes, sin comandos ADB.

## Prueba

En Node 24 con dependencias instaladas:

```
npx vitest run test/tv-*.test.ts --maxWorkers=2 --fileParallelism=false
npm run typecheck
npm run build
```

Tras integrar y reiniciar Asistenta en una ventana autorizada, pedir una inspeccion de la
TV y comprobar `readOnly=true`, `changesApplied=false` y estados de cada fuente. Verificar
visualmente que no cambie la app ni aparezcan avisos. No interpretar los mocks como prueba
real en la TV. Adblock sigue apagado por defecto.
