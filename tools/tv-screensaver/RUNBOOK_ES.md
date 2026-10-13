# Salvapantallas de arte en la LG OLED C5 (sin pagar Gallery+)

Para pegar a Asistenta tal cual. Carpeta del kit: la que contiene este fichero. Todo corre en el PC con Windows; la TV solo recibe ficheros por SSH.

## Reglas de Nico (no saltarse)
- Si Nico esta viendo la TV: SOLO lectura. Nada visible: sin avisos, sin abrir apps, sin reinicios, sin `turnOnScreenSaver`.
- Adblock sigue OFF. No tocar actualizaciones de LG (siguen Bloqueadas) ni Glasshouse.
- Coste 0 EUR.

## Estado real (leer antes)
- VERIFICADO: la descarga de obras (Met y Rijksmuseum) funciona y deja JPG de buena calidad (probado con 4 obras de Van Gogh).
- NO VERIFICADO (la parte de Glasshouse): la pestana Salvapantallas de Glasshouse NO sirve para esto. Solo trae reloj, estrellas, fuegos artificiales, bokeh y datos del panel, sin imagenes propias, y su documentacion dice que no esta disponible en webOS 10 o superior (la TV es webOS 11.2). Por eso no se usa Glasshouse para el arte.
- NO VERIFICADO: el metodo alternativo (bind mount de un main.qml propio sobre el salvapantallas de webOS, igual que hace webosbrew/custom-screensaver) no esta probado en webOS 26 / C5. Por la discusion de la comunidad, el salvapantallas de Gallery+ solo sale en modo Always Ready con galeria, o al usar la TV como altavoz BT, y puede que el clasico tampoco se dispare. El paso 4 lo comprueba antes de contar con ello.
- NO VERIFICADO: la contrasena SSH (probar `root` sin clave o la que Homebrew Channel muestre) y que `scp` este disponible en el PC (Windows 10/11 trae OpenSSH).

## Pasos
1. En el PC, en la carpeta del kit: `pip install pillow` y `python download_art.py --per-source 40`
   Crea `art/` con unas 80 obras a max 3840x2160 (descarta las de menos de 2400 px de lado largo). Tarda unos minutos.
   Extra manual opcional: Museo Van Gogh (scraper gist RyanEager) y dezoomify-rs para Google Arts & Culture. Dejar los JPG en `art/`. Respetar licencias: las dos fuentes de arriba son dominio publico/CC0.
2. `python make_qml.py --seconds 90` crea `screensaver-main.qml` con la lista de imagenes. 90 s por cuadro con fundido.
3. PREFLIGHT (solo lectura, seguro aunque Nico mire la tele): `ssh root@192.168.1.237 "sh -s" < tv_preflight.sh`
   Pegar la salida a Instinct. Si NO existe `/usr/palm/applications/com.webos.app.screensaver/qml/main.qml`, PARAR: este metodo no vale en este firmware.
4. Subir ficheros (invisible; si la TV esta en uso esta bien, solo es disco): `python deploy.py` (sin `--apply`). Sube `art/` a `/media/developer/art/` y los scripts a `/media/developer/art-kit/`. Mira que haya espacio (hay ~3,5 GB libres; 80 obras son unos 100 MB).
5. Aplicar SOLO cuando Nico no este viendo la TV (fuera o en la cama): `python deploy.py --apply`. Hace el bind mount y deja un script de autoarranque en `/var/lib/webosbrew/init.d/`.
   Efecto: nada visible hasta que la TV entre en reposo.
6. Always Ready (NO VERIFICADO por script): la forma segura es que Nico lo apague a mano en Ajustes cuando quiera. No intentar adivinar claves de `luna-send`/settingsservice. Con Always Ready encendido LG muestra su propia pantalla al apagar y puede tapar el salvapantallas.
7. Prueba visible (solo con permiso de Nico, o si esta en la cama y luego se apaga la TV): `ssh root@192.168.1.237 "luna-send -n 1 'luna://com.webos.service.tvpower/power/turnOnScreenSaver' '{}'"`. Debe salir un cuadro a pantalla completa con fundido. Pedir a Nico captura/foto.

## Si algo falla (rollback)
- `ssh root@192.168.1.237 "sh /media/developer/art-kit/tv_rollback.sh"`: desmonta y quita el autoarranque.
- Si la pantalla se queda en negro o rara: reiniciar la TV. Sin el autoarranque, el bind mount no sobrevive al reinicio. Si el reinicio ya lo hizo montar de nuevo, correr rollback primero.
- Borrar imagenes (opcional): `rm -rf /media/developer/art /media/developer/art-kit`.
- Nunca se modifica ningun fichero del sistema de LG: solo se monta encima y se desmonta.

## Riesgos
- Las imagenes 4K en una TV con 2 GB de RAM (unos 320 MB libres, con swap alto): el QML carga una a la vez (`cache: false`). Si el salvapantallas se cierra o la TV se queda lenta, bajar a 2560x1440 cambiando `MAX_W, MAX_H` en `download_art.py` y repetir pasos 1, 2 y 4.
- Un cambio de firmware de LG puede romper el bind mount. Las actualizaciones estan bloqueadas.

---
Origen: kit preparado por Instinct 2026-10-13 a petición de Nico; método bind mount no verificado aún en webOS 26/C5; ejecutar preflight primero.
