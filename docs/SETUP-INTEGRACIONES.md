# Integraciones: lo que tienes que hacer tú (Windows)

Asistenta ya trae el código; cada integración necesita un paso tuyo una sola vez. Si algo falta, Asistenta lo dice en castellano y no se rompe nada.

## 1. Tailscale: el panel y la voz desde el móvil

Sirve para abrir el panel dentro de Telegram (`/panel`) y hablar con Asistenta desde el móvil (`/voz`), estés donde estés, sin abrir puertos del router. Gratis para uso personal.

1. **PC**: descarga e instala Tailscale desde https://tailscale.com/download/windows. Al terminar, pulsa el icono de la bandeja → «Log in» e inicia sesión (por ejemplo con tu cuenta de Google).
2. **Móvil**: instala la app «Tailscale» (App Store / Google Play) e inicia sesión **con la misma cuenta**. Déjala conectada.
3. **Navegador** (en el PC): entra en https://login.tailscale.com/admin/dns y pulsa:
   - «Enable MagicDNS» (si no está ya activo).
   - Más abajo, en «HTTPS Certificates», «Enable HTTPS».
4. **PC**, en una terminal (PowerShell): `tailscale serve --bg 8787` (si cambiaste `PA_WEB_PORT`, pon ese número). La primera vez puede tardar un minuto en sacar el certificado.
5. Escribe `/tailscale` en Telegram. Te dirá el nombre de tu PC (algo como `tu-pc.tu-red.ts.net`) y la línea exacta que falta en `.env`:
   `PA_WEB_ALLOWED_HOSTS=tu-pc.tu-red.ts.net`
   Pégala en el `.env` de Asistenta y reinicia Asistenta (en una terminal: `pa restart`).
6. Vuelve a escribir `/tailscale`: todo debe salir con ✅. Ahora `/panel` te da el botón «📱 Abrir panel».
7. **Voz desde el móvil**: escribe `/voz` y pulsa «🎙️ Hablar». La primera vez el móvil pide permiso para el micrófono (acéptalo para Telegram). Pulsas, hablas, pulsas otra vez y te contesta en voz alta. Con «Manos libres» corta sola cuando te callas y vuelve a escucharte tras responder. Si Telegram no deja usar el micro en tu móvil, abre `https://tu-pc.tu-red.ts.net/voz` en Chrome o Safari (antes abre el panel una vez allí con tu token).

Notas:
- Nunca uses `tailscale funnel`: eso publica el panel en Internet. `/tailscale` avisa si está encendido.
- El panel solo se abre desde tus dispositivos con Tailscale conectado. En el móvil, si no carga, abre la app Tailscale y comprueba que está «Connected».
- Dentro de Telegram entra sin pedir token: Telegram firma que eres tú (solo el dueño del bot).

## 2. Spotify (necesita Spotify Premium)

Con esto le dices «pon Bad Bunny», «pausa», «siguiente», «¿qué suena?», «pon la música en la tele» o `/spotify`. Gratis; el control de la música lo exige Spotify Premium.

1. Entra en https://developer.spotify.com/dashboard con tu cuenta de Spotify (la Premium) y acepta las condiciones.
2. «Create app»:
   - App name: `Asistenta`; App description: `Asistente personal`.
   - Redirect URIs: escribe exactamente `http://127.0.0.1:8888/callback` y pulsa «Add».
   - En «Which API/SDKs are you planning to use?» marca «Web API».
   - Acepta y pulsa «Save».
3. Dentro de la app, «Settings»: copia el **Client ID** (no hace falta el secret).
4. En el PC, abre el `.env` de Asistenta y añade una línea: `PA_SPOTIFY_CLIENT_ID=<el Client ID>`. Guarda y reinicia Asistenta (`pa restart`).
5. Escribe `/spotify conectar` en Telegram **estando en el PC**: se abre el navegador del PC con el permiso de Spotify; pulsa «Aceptar». Te llegará «✅ Spotify conectado».
6. Abre Spotify en el PC o el móvil y dale a play una vez (Spotify necesita un dispositivo encendido). Prueba «pon Coldplay».

Si algo falla:
- «hace falta una cuenta Premium»: la cuenta conectada no es Premium, o tu correo no está en la app → en el dashboard, tu app → «User Management» → añade tu nombre y correo de Spotify.
- «el puerto 8888 está ocupado»: pon `PA_SPOTIFY_REDIRECT_PORT=8889` en `.env` y cambia la Redirect URI de la app a `http://127.0.0.1:8889/callback`.
- `/spotify desconectar` olvida el permiso.

## 3. Google: Calendar (apuntar, mover, borrar), Contactos y Drive

Con esto le dices «apunta dentista el jueves a las 10» (sale en el calendario del móvil), «mueve la ITV al lunes», «¿cuál es el teléfono de Ana?» o «búscame en Drive los apuntes de civil». Cada cambio en el calendario te lo pregunta antes con botones. Gratis.

**A. En Google Cloud (5 min, en el PC):**
1. Entra en https://console.cloud.google.com con tu cuenta y elige tu proyecto «Asistenta» (si no tienes, créalo y sigue también el paso B).
2. «APIs y servicios» → «Biblioteca». Busca y pulsa «Habilitar» en las tres: **Google Calendar API**, **People API** y **Google Drive API**.
3. «APIs y servicios» → «Pantalla de consentimiento de OAuth»: comprueba que está «En producción» (botón «Publicar app»). Si está «En prueba», Google corta el permiso cada 7 días.

**B. Solo si nunca conectaste Google (si ya lo hiciste, salta a C):**
1. «APIs y servicios» → «Credenciales» → «Crear credenciales» → «ID de cliente de OAuth» → tipo «App de escritorio» → «Crear» → «Descargar JSON».
2. En el PC, en una terminal: `pa google conectar C:\Users\<tú>\Downloads\client_secret_….json` (acepta el permiso que se abre; con eso ya queda guardado el cliente).

**C. Dar el permiso nuevo (un clic, en el PC):**
1. Escribe `/google conectar` en Telegram **estando delante del PC**: se abre el navegador del PC con Google.
2. Elige tu cuenta. Si sale «Google no ha verificado esta aplicación»: «Configuración avanzada» → «Ir a Asistenta (no seguro)» (es tu propia app).
3. **Marca todas las casillas** (calendario, contactos, Drive) y pulsa «Continuar». Te llegará «✅ Google conectado».
4. Escribe `/google`: todo debe salir con ✅.

Si algo falla:
- «Falta activar la People API» (o Drive/Calendar): repite el paso A.2.
- «necesito que vuelvas a darle permiso»: repite C y marca todas las casillas.
- `pa google desconectar` (en el PC) retira el permiso.
