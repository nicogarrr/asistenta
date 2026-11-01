# Conectar tu Google Calendar

Gratis y sin servicios de pago: usas tu propio cliente de Google. Se hace una sola vez, en el PC donde corre Asistenta. Asistenta solo **lee** tu calendario: no crea, mueve ni borra eventos.

## Crear tu cliente de Google (10 minutos, una vez)

1. Entra en https://console.cloud.google.com con tu cuenta de Google y crea un proyecto (por ejemplo «Asistenta»).
2. Menú «APIs y servicios» → «Biblioteca»: activa «Google Calendar API».
3. «APIs y servicios» → «Pantalla de consentimiento de OAuth»: tipo «Externo», pon un nombre y tu correo. En «Usuarios de prueba» añade tu propio correo.
4. En esa misma pantalla pulsa «Publicar app». Si la dejas «en prueba», Google corta el permiso cada 7 días.
5. «APIs y servicios» → «Credenciales» → «Crear credenciales» → «ID de cliente de OAuth» → tipo «App de escritorio». Descarga el JSON.
6. En el PC, en una terminal: `pa google conectar C:\ruta\al\client_secret.json`
7. Sale un enlace: ábrelo en el navegador de ese mismo PC. Google avisará de que la app no está verificada (es tuya): «Configuración avanzada» → «Ir a Asistenta». Acepta el permiso de ver tu calendario.

Desde ese momento tu agenda, el resumen de la mañana y «¿qué tengo esta semana?» incluyen tu Google Calendar, al momento (sin el retraso de la dirección secreta iCal).

El id y el secreto del cliente y el permiso se guardan en la bóveda; nunca en el log ni en el chat. Asistenta solo habla con los servidores oficiales de Google, y tu calendario solo se lee en tu chat privado.

## Comandos

- `pa google conectar` — vuelve a conectar (el cliente ya guardado se reutiliza).
- `pa google estado` — dice si está conectado y qué puede leer.
- `pa google desconectar` — retira el permiso en Google y lo borra de la bóveda.
