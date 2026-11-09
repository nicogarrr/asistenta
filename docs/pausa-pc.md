# ⏸️ Parar todo en el PC / ▶️ Levantar todo (desde Telegram)

Para cuando quieras que Asistenta deje el portátil tranquilo (reunión, juego, batería…) sin tocarlo.

## Cómo se usa
1. En Telegram, en tu chat privado con Asistenta: **/pausa_pc**, o el botón **«⏸️ Parar todo en el PC»** que sale debajo de **/estado** y de **/actualizacion**.
2. Te enseña lo que está en marcha y pregunta. Pulsa **«✅ Sí, parar todo»** (el botón caduca a los 5 minutos; **«❌ No»** no para nada).
3. En 1–2 minutos llega **«⏸️ PC en pausa»** con lo que se paró y lo que no se pudo parar (con el motivo), y el botón **«▶️ Levantar todo»**.
4. Para volver: **«▶️ Levantar todo»** (o escribe **/levantar**). En 1–2 minutos llega **«▶️ Todo levantado»** con el estado de cada pieza (✅/❌).

Solo funciona para ti (el dueño), en tu chat privado. A cualquier otro el bot no le contesta mientras está en pausa.

## Qué para
- **Todo lo de dentro de Asistenta**, por el mismo cierre limpio de `pa stop`: cancela lo que esté haciendo, rutinas, recordatorios, objetivos y avisos, el vigilante, la vigilancia del correo, el micrófono y la palabra de activación, la voz, el panel web, el botón de la tele, los navegadores que abrió y el control del escritorio.
- **Lo de fuera**: UxPlay (pantalla del iPhone), el ayudante Bluetooth del iPhone y hidagent (el puente del ESP32 en WSL), si estaban abiertos.
- **La autoactualización**: mientras estés en pausa no se actualiza ni se reinicia.

La pausa **sobrevive a un reinicio**: si el PC se reinicia, Asistenta arranca otra vez en pausa hasta que pulses Levantar.

## Qué NO para
- **El bot de Telegram en sí**. Queda un modo mínimo que solo escucha «Levantar» (sin modelo, sin rutinas, sin micrófono, sin panel). Si se parara el bot entero, no podrías levantarlo desde Telegram. Por eso no está en el botón. Si algún día lo quieres apagar del todo, es `pa stop` en el PC (y para volver, `pa iniciar` o reiniciar el PC).
- La tarea «Asistenta-vigilante» de Windows sigue programada: solo comprueba que el modo pausa esté vivo y lo arranca si no lo está.
- Programas que no abrió Asistenta (tu navegador normal, etc.).

## Al levantar
- Asistenta arranca normal, con tu `.env` de siempre, así que vuelve exactamente lo que tenías configurado.
- UxPlay se vuelve a abrir si estaba abierto.
- El ayudante Bluetooth se abre solo la primera vez que uses el iPhone.
- **hidagent no se relanza solo**: va en su terminal de WSL (`bash deploy/iphone/run.sh`).
- Si estaba haciendo algo cuando lo paraste, al volver te avisa de lo que se cortó; dile «sigue».

## Sin comprobar en un Windows real (solo con pruebas simuladas)
- El ciclo completo cierre → arranque en pausa → levantar con la tarea de inicio de verdad.
- Que `taskkill` cierre UxPlay si se abrió como administrador: si no puede, sale en «No se pudo parar».
- Lo de hidagent en WSL: usa `wsl -d Ubuntu -- pkill -f "python -m hidagent"`. Si tu distro no se llama Ubuntu, no lo encuentra y no sale en el informe.
- Que UxPlay vuelva a abrirse con los mismos argumentos que `preparar-windows.ps1 -Arrancar` (`-n Asistenta -nh`).
