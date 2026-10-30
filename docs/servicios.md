# Servicios adoptados ("modo Gertru")

Capacidad general: a petición de Nico ("adopta Kanvas", "instala X y pásame el
enlace"), Asistenta adopta una herramienta externa, la usa con datos de él y le
sirve el resultado por un enlace PRIVADO de la tailnet, diciendo con honestidad
qué verificó y qué no.

No es un caso suelto: el flujo es el mismo para cualquier herramienta. Kanvas
(XMihura/Kanvas) es el primer piloto.

## Reglas de la casa, hechas código

- **Coste 0.** `proponer` rechaza cualquier propuesta cuyo texto huela a precio,
  suscripción o tarjeta (`costSmell`). Si algo cuesta, se para y se avisa.
- **Aprobación antes de instalar.** `servicio:instalar` es always-ask en la Gate
  (`ask-servicio-instalar` en permissions.ts): Nico ve el plan y dice sí cada vez.
- **Privado por construcción.** El único exposure que el código puede construir
  es `tailscale serve` (solo tailnet). NO existe builder de funnel/público:
  hacerlo público requiere el OK explícito de Nico y un cambio de código, no un
  parámetro. El compose generado bindea a 127.0.0.1, nunca 0.0.0.0.
- **Sin secretos en el registro.** Cada ficha pasa el mismo guard del vault que
  los playbooks: un valor actual del vault en el contenido bloquea el guardado
  y la lectura.
- **Reporte honesto.** Toda adopción cierra con dos listas: "Verificado de
  verdad" (el puerto respondió, el contenedor está en marcha, `tailscale serve
  status` muestra la URL) y "NO verificado" (la conexión real desde el móvil de
  Nico, que el PC anfitrión debe seguir encendido).

## Flujo

1. `proponer`: el modelo investiga la fuente (licencia real, coste real,
   mantenimiento) con fetch/web y declara lo leído. Se registra la propuesta
   con estado `propuesto` y se muestra el plan. Nada se instala.
2. `instalar` (pregunta siempre): docker → genera `services/<nombre>/docker-compose.yml`
   (bind 127.0.0.1) y `docker compose up -d`; local → ejecuta el comando
   declarado (argv, sin shell). Verifica: proceso/contenedor y probe HTTP al
   puerto si lo hay. Lo que no se pudo confirmar se dice y se registra.
3. `servir`: `tailscale serve --bg --https=443 http://127.0.0.1:<puerto>` y
   confirmación con `tailscale serve status`. La URL se lee de esa salida, no
   se inventa. Cueva fija: Tailscale encendido en el móvil; la conexión real
   del móvil la prueba Nico.
4. `parar`: retira el forwarding de tailscale (si lo había) y `docker compose
   stop`. Para servicios locales lo dice y da el comando, no lo fuerza.
5. `listar` / `estado` y el comando `/servicios` en Telegram.

## Registro

Un Markdown por servicio en `<state>/services/<nombre>.md`, editable a mano,
mismo patrón que playbooks y skills. El conocimiento por SITIO web sigue yendo
a los playbooks del gestor; la ficha de servicio guarda la adopción y su
verificación, no selectores ni logins.

## Piloto: Kanvas (datos verificados 2026-10-28, revisados 2026-10-30)

- Fuente: https://github.com/XMihura/Kanvas — licencia MIT, €0, paquete
  `kanvas-board` en PyPI (0.4.0 estable desde el 27-10-2026), Python >= 3.8,
  sin dependencias. Funciona en Windows (CI en Windows; servicio con el
  Programador de tareas, sin permisos de administrador).
- Qué es: un tablero de tareas para proyectos con agentes de código (Claude
  Code, Cursor, Codex…). Los agentes proponen y avanzan tareas con una CLI;
  la persona aprueba y revisa en el navegador. No es una interfaz de chat ni
  sustituye al panel de Asistenta ni a Telegram.
- Método: local (`uvx kanvas-board serve` o `uv tool install kanvas-board`).
- **Exposición: NO con `tailscale serve`.** Kanvas solo responde a sus nombres
  locales (`localhost`, `127.0.0.1`, `[::1]`) y a su propia dirección de
  Tailscale cuando la abre él; a una petición reenviada por `tailscale serve`
  (Host `*.ts.net`) le contesta 403 «Host not allowed» (comprobado el
  2026-10-30 con 0.4.0). Para el móvil, usar su modo propio:
  `kanvas service install --tailscale` (escucha en loopback y en la IP de
  Tailscale, nunca en la LAN). Ojo: sin contraseña, cualquiera de la tailnet
  puede editar los tableros.
- Pendiente por construcción: la aprobación de Nico en `instalar`, y la prueba
  real del enlace desde su móvil.
