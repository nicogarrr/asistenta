# Homehook: abrir el Home de Nico cuando LG Home pasa al frente

Portado de [rudra-avatar/Hearth](https://github.com/rudra-avatar/Hearth) (MIT, ver
`../THIRD_PARTY_NOTICES.md`). Complementa al servicio `--watch` (tecla HOME 773,
**sin verificar en webOS 26**): el watcher NO depende del código de tecla. Escucha
`getForegroundAppInfo` y, cuando la TV pone LG Home al frente (botón Home, salir de
una app con Back, arranque), abre `tld.my.customhome` y **comprueba que de verdad se
mostró** (fichero `/tmp/customhome-hb/alive` + hasta 3 reintentos). Nada de LG Home se
reemplaza ni se monta.

## Qué se instala (solo en la ventana de Nico, por SSH root)

- `/media/developer/customhome-homehook/{lib.sh,watch.sh,apply.sh,stock.sh,diagnose.sh,version}`
- Enlace de arranque OPCIONAL `/var/lib/webosbrew/init.d/48-customhome-homehook` → `apply.sh`

Convive con los enlaces existentes (autostart del servicio de tv-home, tailscaled):
son ficheros distintos en el mismo directorio y lanzar una app ya al frente es un no-op.
**Antes de tocar `/var/lib/webosbrew/init.d/` en la ventana: backup del directorio
completo y manifiesto verificado (regla R10).** Un solo instalador por ventana.

## Pasos (repasar línea a línea antes de ejecutar; abortar ante cualquier salida inesperada)

```sh
# 0. Backup R10 del directorio compartido
tar -czf /tmp/initd-backup-$(date +%Y%m%d-%H%M%S).tgz /var/lib/webosbrew/init.d/
ls -l /var/lib/webosbrew/init.d/

# 1. Copiar los scripts (desde el PC: scp, o base64 como en el runbook de ventana)
mkdir -p /media/developer/customhome-homehook
# ... copiar lib.sh watch.sh apply.sh stock.sh diagnose.sh (ninguno escribible por grupo/otros: chmod 755) ...
chmod +x /media/developer/customhome-homehook/*.sh
echo 1 > /media/developer/customhome-homehook/version

# 2. Sintaxis en la shell DE LA TV antes de activar nada
for f in lib.sh watch.sh apply.sh stock.sh diagnose.sh; do sh -n "/media/developer/customhome-homehook/$f" || exit 1; done

# 3. Activar (arranca el watcher ya; el enlace lo arranca también en cada boot)
sh /media/developer/customhome-homehook/apply.sh        # debe imprimir: applied
ln -sf /media/developer/customhome-homehook/apply.sh /var/lib/webosbrew/init.d/48-customhome-homehook

# 4. Probar: pulsar Home estando en una app → debe abrirse el Home de Nico.
#    Si algo falla: sh /media/developer/customhome-homehook/diagnose.sh
```

## Rollback completo

```sh
pid="$(cut -d" " -f1 /var/run/customhome-homehook/watch.pid 2>/dev/null)"
[ -n "$pid" ] && kill -9 "$pid" 2>/dev/null
pkill -9 -f '[c]ustomhome-homehook/watch.sh' 2>/dev/null
rm -f /var/lib/webosbrew/init.d/48-customhome-homehook
rm -rf /var/run/customhome-homehook /tmp/customhome-hb
rm -f /tmp/customhome-homehook-watch.pid /tmp/customhome-allow-stock-home /tmp/customhome-alive   # restos de versiones anteriores
rm -rf /media/developer/customhome-homehook
```
LG Home nunca se toca: con el watcher parado, la TV vuelve a comportarse de fábrica.

## Ver LG Home de verdad (escape hatch)

`sh /media/developer/customhome-homehook/stock.sh` deja pasar LG Home hasta salir de él
(el watcher cede ~10 s). No hay tile "LG Home" en la UI todavía (tv-home no lo tiene);
si se quiere, es un añadido aparte que lance `com.webos.app.home` tras ejecutar stock.sh.

## Notas de seguridad

- Los scripts NO reciben entrada externa: solo leen informes de `getForegroundAppInfo`
  (pattern-match, nunca se evalúa como shell) y lanzan un appId FIJO.
- El watcher solo actúa si `tld.my.customhome` está instalada; si se desinstala, no hace nada.
- `apply.sh` es idempotente y se niega (`launcher-missing` / `files-missing`) si falta algo.
- Sin red: solo `luna-send` local. Nada se ejecuta fuera de la ventana de Nico.
- Estado de root en un directorio privado (`/var/run/customhome-homehook`, modo 0700): se
  crea sin seguir enlaces y los scripts se niegan (`state-unsafe`) si es un enlace, si su padre
  es escribible por todos sin sticky, si no es de root o no es 0700. No se escribe en rutas
  predecibles de `/tmp`.
- Instancia unica: todo cambio del cerrojo/pid ocurre bajo un segundo cerrojo atomico (`mkdir`), asi que
  nadie puede quitar un cerrojo recien tomado. El PID se valida con `/proc` (pid + hora de arranque + linea
  de comandos), no con `kill -0`. FALLA CERRADO: sin identidad `/proc` propia no arranca, y si el dueño del
  cerrojo no se puede comprobar no se le quita. Cerrojo huerfano (kill -9): lo recupera el siguiente arranque.
- Los scripts no se arrancan si son escribibles por grupo/otros ni si no son del mismo usuario (`files-writable`).
- El heartbeat app→root es un solo fichero con una marca de tiempo en `/tmp/customhome-hb/`
  (el servicio lo escribe con O_NOFOLLOW y comprueba el dueno del directorio); root solo lo lee,
  ignora enlaces, y lo unico que decide es si reintenta abrir el Home.
- NO verificado en TV real: busybox/webOS (`ls -ldn`, `read`, `/proc`), que `/var/run` sea tmpfs,
  permisos de `/media/developer`, y el modelo de privilegios del canal de Homebrew.
