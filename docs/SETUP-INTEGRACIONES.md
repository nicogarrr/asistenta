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

Notas:
- Nunca uses `tailscale funnel`: eso publica el panel en Internet. `/tailscale` avisa si está encendido.
- El panel solo se abre desde tus dispositivos con Tailscale conectado. En el móvil, si no carga, abre la app Tailscale y comprueba que está «Connected».
- Dentro de Telegram entra sin pedir token: Telegram firma que eres tú (solo el dueño del bot).
