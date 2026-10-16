# TV vision (piccap + magic_mapper) - plan de ejecucion

Autoridad: Nico, 12/10 01:13-01:16 (WhatsApp, originales en el canal): trabajar la
tele por la noche con ella apagada cuando se termine; preparar TODO en repo para
que manana sea "tele encendida -> ejecutar"; orden: autostart tailscaled PRIMERO,
luego piccap/magic_mapper. Silencio total (duerme). Si se enciende, apagarla al acabar.

## Estado del camino de red (12/10 01:14, verificado)
- lgwebostv: nodo tailscale 100.126.88.124, OFFLINE 2h (autostart roto - esto se arregla).
- laptop Nico (Windows): nodo tailscale OFFLINE 1h; no anuncia rutas subred.
- VM (cavaai-vm 100.108.180.24): cloud OCI, SIN acceso L2 a la LAN; 192.168.1.237 muere en el gateway.
- Por tanto: WoL imposible esta noche; ejecucion cuando la TV o el laptop despierten
  (wake en cadencia vigilando `tailscale status`).

## Prerequisitos a verificar EN la tele (ssh root@192.168.1.237)
1. `cat /var/info/modelname` y version webOS: piccap 0.5.3 requiere webOS >= 4.0 (manifiesto oficial; el script lo comprueba y aborta si no).
2. Homebrew Channel presente y actualizado (Glasshouse ya funciona = homebrew OK).
3. `/media/developer/bin/tailscaled` existe (estuvo online antes = instalado).

## Ejecucion (orden exacto)
1. **Autostart tailscaled**: `sh scripts/tv/install-tailscaled-autostart.sh 192.168.1.237`
   - Escribe /var/lib/webosbrew/init.d/tailscaled (run-parts; nombre sin puntos).
   - Lo arranca y verifica pidof. Verificar desde la VM: `tailscale status | grep -i lgwebostv`.
2. **PicCap**: `sh scripts/tv/install-piccap.sh 192.168.1.237`
    - Release 0.5.3: URL verificada por API y digest OFICIAL sha256
     ad6b06766cea01dbe8ea0ac9dbbbd9c1a6c030e72df6cd96214199f50d38e486 - el
     script descarga, hashea y ABORTA si no coincide.
   - hbchannel exige ipkUrl+ipkHash; completion real = finished:true /
     statusText Finished. (statusValue 30 es solo el packageInstall interno).
   - Prerequisito webOS >= 4.0 FAIL-CLOSED: si os_info.json falta o es ilegible,
     aborta. Verificacion final: launchPoints + getAppInfo version 0.5.3.
   - Si el install no llega a finished: camino manual por la UI de Homebrew.
   - UI: esperar elevate; configurar receptor = IP tailscale de la VM AL EJECUTAR
     (`tailscale ip -4` en la VM; a 12/10 era 100.108.180.24, VERIFICAR), puerto
     flatbuffers 19400 (HyperHDR en la VM).
3. **Receptor de frames (VM, EUR0)**: HyperHDR/Hyperion en docker en la VM.
   - NOTA HONESTA: imagen docker concreta N/D hasta verificar en Docker Hub al
     ejecutar (candidatas: hyperion-project/hyperion.ng; HyperHDR no publica
     imagen oficial - confirmar). El puerto a abrir: 19400 (flatbuffers).
   - Pieza pendiente (diseno propio): como la asistenta lee frames del receptor
     (poll de la API JSON del receptor o suscripcion flatbuffers). Va en su propia PR.
4. **magic_mapper**: `TV_BUTTON_TOKEN=<mismo valor que tv:buttonToken en el vault> sh scripts/tv/install-magic-mapper.sh 192.168.1.237 <ip-laptop> --button rakuten`
   - Transporte TELNET por defecto (la tele solo abre telnet 23, root sin
     contrasena); `--transport ssh` queda como opcion. Driver:
     scripts/tv/telnet-sh.py (exit code remoto por centinela/trap EXIT).
   - TOKEN OBLIGATORIO (TV_BUTTON_TOKEN o --token-file; nunca como argumento
     posicional). Termina en /home/root/.tv-button-curl.conf (0600) y magic_mapper
     lo usa via `curl --config` (parche propio sobre v1.1.0): NUNCA en claro por
     telnet (la tele hace pull por TLS de un servidor one-shot del PC,
     scripts/tv/tv-token-server.py, con cert efimero fijado por --cacert), ni en
     la config JSON, ni en logs (el parche quita el -v y el print del argv).
   - El boton EXIGE flag explicito del operador (decision del owner en ejecucion;
     sin --button el script aborta). Candidatos: 0-9 (pierden long-press), guide, info.
   - Staging en el fs propio de cada destino, backup de los 5 (incluye el
     archivo privado del token) + listados forenses de init.d y /dev/input.
     No toca 50-tvweb ni nada ajeno. El rollback
     (/home/root/mm-rollback-<ts>.sh) se genera desde scripts/tv/templates/
     mapper-rollback.sh (cubierto por scripts/tv/test-tv-rollback-mock.sh) y se
     VERIFICA ejecutable ANTES de mutar nada; el servicio viejo se para y se
     confirma NO-VIVO antes del rename (pgrep TRI-ESTADO: 0=vivo, 1=muerto,
     cualquier otro exit = aborta visible). El rollback garantiza SOLO lo que
     el codigo verifica: valida el backup (MANIFEST) ANTES de stop/rm - sin
     MANIFEST o con ficheros ausentes aborta sin tocar nada; EMPTY = no habia
     instalacion previa (rm limpio, distinto de backup perdido); stop sin
     ||true, guard no-vivo antes de tocar ficheros y restore con fallos
     visibles (set -e; nunca declara hecho un restore roto).
     Rollback automatico ante fallos post-backup. Tests mock:
     scripts/tv/test-tv-rollback-mock.sh (10/10, filesystem falso real) y
     scripts/tv/test-tv-token-patch-mock.sh (11/11: parche, telnet y canal TLS).
   - --button se valida contra la lista oficial de botones de v1.1.0
     (magic_mapper.py BUTTONS); magic_mapper_settings esta reservado y se rechaza.
   - PREFLIGHT DURO: el script ABORTA si el listener de la asistenta
     (:8765/tv/button-health) no responde - el boton NO se activa sin listener.
   - Rollback tailscaled: /home/root/tailscaled-autostart-rollback-<ts>.sh desde
     templates/tailscaled-rollback.sh (mismo test mock). Lee el pre-state de
     /home/root/tailscaled-autostart-<ts>.state (valores con quoting; multi-PID
     no rompe el source) y deshace SOLO lo propio: mata el daemon solo si la
     instalacion lo lanzo, PID a PID (kill "$(pidof)" falla con varios),
     desmonta solo si ella monto, restaura+relanza el init previo si existia.
     set -e: cada undo falla visible, sin "rollback hecho" falso.
     Verificado ejecutable ANTES de mutar.
   - Version fijada v1.1.0 por sha256 de los 3 ficheros (verificado EN LA
     tele con python3) + parche determinista (templates/patch-magic-mapper.py,
     anclas exactas o aborta); config renderizada con la IP real.
   - Boton: SIN defecto - se decide en ejecucion via --button (owner).
   - Listener HTTP YA EXISTE (src/tv/button-listener.ts): :8765/tv/button con
     Bearer opcional desde el vault (tv:buttonToken) y /tv/button-health abierto
     para el preflight. El instalador EXIGE token y cablea token_file: el boton
     nunca queda sin autenticacion.
5. **Apagar la tele** (orden de Nico) y reportar que quedo instalado.

## Semantica exclusive_mode (verificado upstream 12/10)
magic_mapper toma control exclusivo del dispositivo de entrada del mando pero solo
intercepta los botones MAPEADOS; los demas se reenvian al dispositivo de salida.
Riesgos upstream: si un boton no mapeado se comporta raro, ajustar
output_device_name o poner exclusive_mode=false (entonces no se pueden sobreescribir
botones con funcion). OJO: los botones 0-9 tienen long-press (acceso rapido) -
mapear "0" elimina su long-press. ir_input_enabled queda en false (no tocamos IR).

## Que boton usar (decidir con Nico)
Los botones de color YA tienen funciones utiles en la config de ejemplo (OLED light,
eye comfort) - NO tocarlos sin permiso. Candidatos de la lista oficial de botones:
"0"-"9", "guide", "info", "exit"... El boton se decide EN EJECUCION via --button (N/D cual; candidatos: 0-9 con
caveat long-press verificado upstream, guide, info). El paso 4 exige ademas el
listener :8765/tv/button desplegado (preflight duro). Cambiarlo = editar la clave de config/tv/magic_mapper_config.json
y volver a desplegar (restart del script).

## Rollback
- piccap: luna-send luna://org.webosbrew.hbchannel.service/uninstall '{"id":"org.webosbrew.piccap"}'
 - magic_mapper: el instalador hace rollback AUTOMATICO si el start/verify falla
  tras el backup. Manual: stop + restaurar los 4 ficheros desde
  /home/root/mm-backup-<ts>/ a sus rutas + start (comando exacto impreso por el
  script al desplegar). Sin instalacion previa: stop + rm de los 4.
- tailscaled: sh /home/root/tailscaled-autostart-rollback-<ts>.sh (ownership
  horneado al generarse: no toca daemon/DNS/init ajenos a la instalacion).

## Fuentes (verificadas 12/10 01:17)
- PicCap: https://repo.webosbrew.org/apps/org.webosbrew.piccap/ y https://github.com/TBSniller/piccap
- magic_mapper: https://github.com/andrewfraley/magic_mapper (README + config v1.1.0)
- init.d webosbrew: https://www.webosbrew.org/develop/guides/startup-script/
- tailscaled en webOS: https://gist.github.com/mariotaku/f7228c5459fc7ad2172a2b69dd51a4eb
