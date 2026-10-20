# Home de Nico — plan y estado (fase 1)

Fork de zzeppieri/webos-custom-home (MIT) + esquema UX de free-my-tv
(simbasjungles, MIT) adaptado a webOS. Referencia visual: post de
@SimbasJungles que mandó Nico (hero grande + pósters + dock con colores de
marca, estilo Apple TV).

## Qué es la v0.1.0-nico (esta PR)

Pantalla única, en español, limpia:

- **"Para ti"** — hero grande + 2 pósters pequeños: 3 recomendaciones TMDB por
  franja ("Para esta mañana/tarde/noche"), trending semanal + novedades,
  filtradas a SUS apps de streaming y región ES. OK sobre una tarjeta abre la
  app del proveedor. Sin clave TMDB la sección se esconde y queda el saludo.
- **Dock** abajo: todas sus apps visibles (Streaming, Media, HDMI, Apps) con
  color de marca, foco con glow, OK lanza. Ajustes es el último tile.
- **Reloj + tiempo** (Open-Meteo, Gijón, °C, 24h) arriba a la derecha.
- **Ambient** a los 60 s sin input (reloj que deriva, guardia OLED), eARC guard
  y toma del botón Home + arranque (heredados de la base, sin tocar).
- **Ajustes** en la TV: formato hora, °C/°F, ciudad, Recomendaciones on/off,
  **Clave TMDB** (se pega en la TV, vive solo en localStorage — nunca en git),
  fondo, ocultar apps, reset de orden.

Decisiones de diseño (desviaciones conscientes de free-my-tv):
- Fondo siempre casi negro: es OLED (quemado + consumo). free-my-tv aclara de
  día porque es LCD. El tema día/noche queda como iteración si Nico lo pide.
- Back no sale del Home (es la raíz).
- Sin texto explicativo innecesario; etiquetas cortas en español.

## Verificado en esta fase (sin tocar la TV)

- `npm run build` OK (Vite + Lightning CSS, target Chrome 108; webOS 26 lleva
  Chromium 132 — fuente oficial LG — así que va sobrado).
- `tsc --noEmit`: limpio salvo un error PREEXISTENTE de la base
  (godui/elastic-text.tsx, no se usa en esta pantalla).
- Capturas 1920×1080 (Chrome headless, off-webOS): estado sin clave (saludo +
  dock), estado "Para ti" con 3 picks, foco en hero, overlay de Ajustes.
- Lógica de lanzamientos off-webOS es stub; el lanzado real (LunaService) se
  verifica en la TV en fase 2.

## NO verificado aún (fase 2, todo solo lectura salvo OK de Nico)

- appIds marcados VERIFICAR en `src/lib/apps.ts` y `PROVIDER_MATCH` en
  `src/service/tmdb.ts` (Max, Movistar+, DAZN, SkyShowtime, Nuvio, Stremio,
  Kodi, IBO, GeForce NOW, YouTube AdFree). Las apps que falten aparecen solas
  en el dock por descubrimiento en caliente, pero con monograma.
- Iconos: solo hay arte para Netflix, Prime, Disney+, Max(HBO), Apple TV,
  YouTube, Homebrew y Ajustes. El resto, monograma hasta copiar iconos reales.
- Código de tecla HOME (773) y comportamiento en webOS 26: primer arranque real.

## Fase 2 — instalación y debloat (requiere ventana de Nico)

Reglas de la TV: mientras la ve, SOLO lectura y nada visible; adblock apagado
por defecto; cambios visibles solo con ventana explícita. Acceso desde su PC
(Asistenta) por telnet 23 (SSH pide contraseña que no acepta sus claves).

1. Inventario de solo lectura: `luna-send -n 1 luna://com.webos.applicationManager/listApps '{}'`
   y `listLaunchPoints` → confirma appIds, genera iconos reales.
2. Instalación reversible: build (`npm run build`) + `ares-package dist service
   --no-minify` + instalar el .ipk por el servicio del Homebrew Channel, o el
   instalador por telnet. La app no toca archivos del sistema; desinstalar lo
   revierte TODO (incluido el Home de LG, que sigue instalado: solo deja de
   mostrarse).
3. Toma del Home: primero probar la app como app normal; la toma del botón Home
   y del arranque (init.d de webosbrew) se activa en un paso aparte y se deshace
   con `installer/tv-uninstall.sh`.
4. "Bloatware" en webOS: las apps del sistema viven en partición de solo
   lectura — no se desinstalan sin riesgo. Lo seguro y efectivo:
   - no aparecen en el Home de Nico (ya);
   - desactivar "Always Ready" (decisión de Nico: choca con su salvapantallas);
   - desactivar autolanzadores en segundo plano que el inventario encuentre;
   - opt-outs de anuncios/recomendaciones en Ajustes de LG.
   Cada paso con respaldo y deshacer documentado. Nada de borrar del sistema.

## Iteración (modelo hotfix que pidió Nico)

Cambios pequeños y reversibles: catálogo en `src/lib/apps.ts` (datos), textos en
componentes, flags en `src/lib/config.ts`. Deploy rápido: `npm run deploy` con
ares (o rebuild + ares-install) cuando la TV esté libre. Ideas ya apuntadas:
pósters con acciones (OK ya lanza), fila "seguir viendo", tema por amanecer/
atardecer (Open-Meteo ya devuelve is_day/sunrise/sunset), cripto (Binance) si lo
pide, botones de Asistenta, salvapantallas con pósters de los picks.
