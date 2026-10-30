# Panel desde el móvil, sin abrir puertos (F14)

El panel web solo escucha en `127.0.0.1` y pide token. Para abrirlo desde el móvil fuera de casa, la vía recomendada es **Tailscale Serve**: el panel queda accesible solo para tus dispositivos de tu red Tailscale, con https, y el router no abre nada.

1. Activa el panel en `.env`: `PA_WEB_PORT=8787` y `PA_WEB_TOKEN=` con 24+ caracteres al azar.
2. Instala Tailscale en el PC y en el móvil, con la misma cuenta.
3. En el PC: `tailscale serve --bg 8787`. Tailscale te dice la dirección, del estilo `https://tu-pc.tu-red.ts.net`.
4. Añade ese nombre (sin `https://` ni puerto) a `PA_WEB_ALLOWED_HOSTS=tu-pc.tu-red.ts.net` y reinicia Asistenta. Sin esto el panel rechaza la petición (defensa contra DNS rebinding).
5. `pa doctor` debe mostrar `panel remoto    tu-pc.tu-red.ts.net (Tailscale: solo tus dispositivos)`.

No uses `tailscale funnel` ni abras el puerto en el router: eso lo publica en Internet. `pa doctor` avisa si en `PA_WEB_ALLOWED_HOSTS` hay un nombre que no es de Tailscale, si el token es corto o si hay comodines (se ignoran).
