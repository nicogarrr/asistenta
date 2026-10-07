# Vigilante: páginas públicas y avisos por Asistenta

Tras actualizar: git pull, npm ci, npm run build y reiniciar Asistenta.
Playwright Chromium debe estar instalado (`npx playwright install chromium`).
Amazon, MediaMarkt y PcComponentes usan un Chromium por ciclo, contexto público
nuevo por página. Las demás tiendas mantienen su lector HTTP. No hay solver,
login, cookies persistentes ni cambio de cliente ante negativa. Ante 403/429/503,
Akamai o captcha la tienda se pausa con el backoff existente. Un HTTP200 sin
productos legibles tampoco cuenta como listado correcto. Esto no promete acceso
a tiendas bloqueadas.

Cada document/script/xhr/fetch autorizado consume presupuesto diario y pasa robots.
Recursos externos, imágenes y media se bloquean. Límite por tienda invariable;
las páginas con JS pueden consumirlo antes y quedarse pausadas. Relectura de robots
es comprobación operativa aparte, cacheada por proceso. No borrar historial sqlite.

Para que los avisos usen el bot principal si el token del vigilante falla401 o falta:
`telegram.useMainBotFallback: true` en pricewatch.json, junto con enabled/chatId.
Desactivado por defecto. Usa solo el token ya cargado del vault en el daemon y el
mismo chatId; no copiar ni comunicar secretos. La CLI manual no dispone del token
principal. No fallback en403,429 o errores de red, para evitar duplicados.

Verificar en el PC: log `pricewatch barrido` (pages/cards/failures/blocked/noCards),
y recepción del aviso por el bot elegido. Daemon vivo no implica tiendas legibles
ni Telegram operativo. Silencio no es prueba de ausencia de errores de precio.
