# RUNBOOK ÚNICO — Ventana de instalación (Home + arte + Always Ready)

Una sola ventana con la TV libre. Piezas: (A) Home de Nico, (B) salvapantallas
de arte (kit tools/tv-screensaver), (C) Always Ready apagado. Cada pieza tiene
su deshacer; se pueden instalar en este orden y parar entre piezas.

Reglas duras: antes de la ventana solo lectura/invisible; adblock OFF; €0;
nada se borra del sistema (todo es montar encima o instalar apps; deshacer
devuelve el estado anterior).

## ANTES de la ventana (sin tocar la TV / invisible)

En el PC (Git Bash, Node 24, Python 3):

```sh
# A) Build del Home
cd tools/tv-home
npm ci && npm run build
ares-package dist service -o . --no-minify      # genera tld.my.customhome_0.1.0_all.ipk

# B) Arte (80 obras CC0, máx 3840x2160)
cd ../tv-screensaver
pip install pillow
python download_art.py --per-source 40
python make_qml.py --seconds 90
```

Preflight SOLO LECTURA por telnet (vale incluso viendo la tele):

```sh
# Estado del sistema y apps reales (confirma appIds del dock)
luna-send -n 1 'luna://com.webos.service.tv.systemproperty/getSystemInfo' '{}'
luna-send -n 1 'luna://com.webos.applicationManager/listLaunchPoints' '{}'
# ¿Existe el screensaver que el kit monta? Si NO existe, el arte NO va en este firmware
ls /usr/palm/applications/com.webos.app.screensaver/qml/main.qml
# Estado actual del kit de arte (¿ya montado?, ¿cuántas obras y de qué tamaño?)
mount | grep -i screensaver
ls /media/developer/art-kit 2>/dev/null
ls /media/developer/art 2>/dev/null | wc -l
ls /var/lib/webosbrew/init.d/
# Código del botón HOME (el watcher usa 773; confirmar en esta TV)
```

Pegar la salida a Instinct. Si `main.qml` no existe: instalar solo A y C.

Subida invisible de arte (solo disco, vale con la tele encendida):
`python deploy.py` (SIN --apply).

## DURANTE la ventana (visible, en orden)

1. **Always Ready OFF (C)**: Nico lo apaga a mano en Ajustes de la TV
   (General → Always Ready). Es un toggle; deshacer = volver a encenderlo.
2. **Arte (B)**: `python deploy.py --apply` (bind mount + autoarranque).
   Prueba: `luna-send -n 1 'luna://com.webos.service.tvpower/power/turnOnScreenSaver' '{}'`
   → debe verse un cuadro a pantalla completa con fundido. Foto de Nico.
   Deshacer B: `sh /media/developer/art-kit/tv_rollback.sh` (+ reinicio si queda rara).
3. **Home (A)**: instalar el ipk (ares-install o servicio del Homebrew
   Channel), lanzarlo a mano y probar: flechas, OK lanza apps reales, tiempo de
   Gijón, ambient a los 60 s. Nico mete su clave TMDB en Ajustes → Clave TMDB.
   Deshacer A parcial: desinstalar la app (todo vuelve; el Home de LG sigue ahí).
4. **Toma del Home (A+)**: solo si el paso 3 va fino: `sh
   /media/developer/apps/usr/palm/services/tld.my.customhome.service/autostart.sh`
   → botón HOME abre el Home de Nico + arranque en boot. Probar botón HOME y
   UN reinicio. Deshacer A+: `sh tools/tv-home/installer/tv-uninstall.sh`.
5. **Casar arte y Home**: con ambos verificados, en el Home: Ajustes →
   Salvapantallas → "Arte (sistema)". Así: 60 s → reloj ambient del Home; al
   rato (timeout del sistema) → arte a pantalla completa. Si el arte no tira,
   volver a "Reloj (app)".

## Después

- Foto/verificación de Nico: botón HOME, un par de apps, arte en reposo.
- Hotfixes: cambios pequeños → rebuild + ares-install (solo en ventana).
