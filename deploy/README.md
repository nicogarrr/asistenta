# Despliegue en Linux (modo servidor)

1. `git clone https://github.com/nicogarrr/asistenta && cd asistenta`
2. `bash deploy/setup-env.sh` (pide token, API key y user ID sin eco; crea `~/asistenta.env` con 600)
3. `docker compose -f deploy/docker-compose.yml up -d --build`
4. `docker logs -f asistenta`

El estado (base de datos, memoria, perfiles de navegador) vive en el volumen `asistenta-data`.
Sin escritorio: no hay pantalla, cámara, micro, voz ni shell; sí Telegram, modelo, navegador headless, ficheros, memoria y calendario.
