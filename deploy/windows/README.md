# Arranque automático en Windows

El daemon (`pa serve`) tiene que estar corriendo antes de que nadie le hable, así que
tiene que volver solo después de un reinicio. Este script lo registra en el **Planificador
de tareas de Windows** (Task Scheduler) con un disparador `AtLogOn`.

El script **no se ha ejecutado** en esta máquina: está escrito y verificado sintácticamente,
pero registrar la tarea es una acción que debe hacer la persona que lo va a usar.

## Requisitos

- Node instalado y en el `PATH` (o pasarle `-NodeExe "C:\ruta\node.exe"`).
- El proyecto compilado: `npm run build` deja `dist\cli.js`. El script lo comprueba y se
  niega a crear la tarea si no existe — una tarea que falla en cada arranque sin que nadie
  lo note es mucho peor que una que no se crea.
- El vault ya inicializado (`pa vault init`) y con sus secretos: la tarea solo arranca el
  daemon, no lo configura.

## Instalarlo

```powershell
npm run build
powershell -ExecutionPolicy Bypass -File deploy\windows\install-autostart.ps1
```

Y para no esperar al próximo inicio de sesión:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\install-autostart.ps1 -Start
```

Opciones que importan:

| Parámetro | Para qué |
| --- | --- |
| `-TaskName` | Nombre de la tarea. Por defecto `personal-agent-daemon`. |
| `-RepoDir` | Raíz del repo si el script no está donde se espera. |
| `-NodeExe` | Ruta exacta a `node.exe`, si no quieres depender del `PATH`. |
| `-Command` | Subcomando a lanzar. Por defecto `serve`. |
| `-Force` | Reemplaza una tarea existente en vez de negarse. |
| `-Start` | Arranca la tarea nada más registrarla. |

**No hace falta elevación.** La tarea se registra en la carpeta del propio usuario
(`\DOMINIO\USUARIO\`) con `-RunLevel Limited`, así que una consola normal basta. Si el
script dice que no puede registrar la tarea y el motivo es un permiso del *Task Scheduler*,
entonces sí: consola de administrador. El script lo avisa en ese caso en vez de fallar con
un error de COM.

## Cómo verificar que arranca

Tres comprobaciones, de la más rápida a la más completa:

1. **La tarea existe y está en el estado que toca**

   ```powershell
   powershell -ExecutionPolicy Bypass -File deploy\windows\install-autostart.ps1 -Status
   ```

   Imprime estado, comando, disparador, última ejecución con su código de resultado,
   próxima, número de reinicios y límite de tiempo. Un `LastTaskResult` que no sea `0x0`
   significa que la última ejecución terminó con error.

2. **El heartbeat se está escribiendo** (esta es la buena: el fichero solo lo escribe un
   daemon vivo)

   ```powershell
   Get-Item "$HOME\.local\share\personal-agent\agent.heartbeat" | Select-Object LastWriteTime
   ```

   `LastWriteTime` debe moverse cada 15 segundos. Si el fichero no existe, el daemon no ha
   arrivado a arrancar: mira el log de hoy en `$HOME\.local\share\personal-agent\log\`.

3. **Enredarse donde se ven las cosas**

   ```powershell
   taskschd.msc
   ```

   Biblioteca → `\DOMINIO\USUARIO\` → `personal-agent-daemon`. Botón derecho → Ejecutar para
   arrancarla a mano, y la pestaña *Historial* para ver cada ejecución con su resultado.

Y para el diagnóstico completo —con evidencia, en texto para pegar en otro chat— está
`src/diagnose.ts`: `diagnose()` devuelve `{ text, data }`, con `text` en español pensado para
pegarlo en un chat y `data` con los mismos hechos como objetos. Enchúfalo en un comando
`/diagnose` y se manda tal cual.

## Qué deja la tarea

- **Disparador**: `AtLogOn` del usuario que instala. Nada más: no cada X minutos, no al
  arrancar el sistema. El daemon debe arrancar cuando la persona está delante, porque
  necesita su sesión de escritorio.
- **Acción**: `node.exe dist\cli.js serve`, con la raíz del repo como directorio de trabajo
  (las rutas relativas del daemon dependen de ello).
- **`RestartCount` 999, `RestartInterval` 1 minuto**: si el proceso *sale* —crash,OOM,
  alguien lo mata—, se relanza al minuto. Es lo que cubre las caídas.
- **`ExecutionTimeLimit` = `[TimeSpan]::Zero`**: sin límite. Por defecto Task Scheduler mata
  cualquier tarea a las 72 horas, y eso mataría un daemon sano un día sí y otro no.
- **Batería**: `-AllowStartIfOnBatteries` y `-DontStopIfGoingOnBatteries`. En un portátil
  sin cargador el agente debería seguir siendo un agente.
- **`StartWhenAvailable`**: si el equipo estaba apagado a la hora del disparo, arranca en
  cuanto puede en vez de saltarse ese ciclo.
- **`MultipleInstances IgnoreNew`**: si ya hay un `node serve` corriendo, no se lanza otro.
  El propio daemon además se niega (`assertNotRunning`), pero mejor que dos capas.

## Lo que esta tarea NO cubre

**Un daemon vivo pero colgado.** Si el proceso existe y no hace nada —un turno
bloqueado, un `await` que no vuelve, un evento loop tapado por un `await` síncrono— Task
Scheduler lo ve perfectamente sano, porque para él la tarea es el proceso y el proceso
está ahí. Por eso existe el watchdog (`src/watchdog.ts`): lee
`agent.heartbeat` y, si pasan 3 intervalos de escritura (con un suelo de 120 s) sin que se
escriba, da el daemon por muerto y lo relanza. Y si relanza más de 5 veces en 15 minutos,
deja de relanzar y avisa: un bucle de fallos tiene que llegar a una persona, no gastarse
en un bucle infinito.

Los dos mecanismos se complementan y no se sustituyen: Task Scheduler ve el proceso, el
watchdog ve el pulso.

## Desinstalarlo

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\install-autostart.ps1 -Uninstall
```

Para la tarea y la detiene si estaba corriendo. Es idempotente: si no hay ninguna tarea,
lo dice y sale con éxito. Esto **no** borra el estado del daemon (base de datos, memoria,
vault); para eso, borrar `$HOME\.local\share\personal-agent`.

## Por qué Task Scheduler y no la clave `Run` del registro

La alternativa de toda la vida es `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.
Funciona, y para un programa que arranca una vez al iniciar sesión es exactamente
suficiente. Aun así, aquí Task Scheduler es mejor por cuatro razones concretas:

1. **Se ve y se toca.** Una entrada `Run` es una línea de texto opaca en el registro: no
   tiene historial, no tiene estado, no tiene errores y no aparece en ninguna interfaz.
   Una tarea aparece en `taskschd.msc`, se puede arrancar a mano, se puede exportar y
   tiene una pestaña *Historial* con el resultado de cada ejecución. Para un daemon que
   nadie ve funcionar, esa visibilidad es la diferencia entre "está apagado" y "está
   apagado y nadie sabe por qué".
2. **Sobrevive a las actualizaciones de Windows.** El registro es una de las superficies
   que más tocan los instaladores y las herramientas de limpieza de PC; una clave que
   desaparece sin aviso deja al agente muerto y sin explicación. El servicio de Task
   Scheduler es una pieza del sistema que Windows actualiza con Windows.
3. **Reinicia de verdad.** `RestartCount` es una opción propia de una tarea. Una
   entrada `Run` no se relanza: si el proceso muere, se queda muerto hasta el siguiente
   inicio de sesión, que puede ser al día siguiente.
4. **Se ejecuta en tu sesión de escritorio, no en la sesión 0.** Este es el punto
   decisivo aquí. Una tarea configurada como "ejecutar tanto si el usuario ha iniciado
   sesión como si no" corre en la sesión 0, donde no hay escritorio: sin pantalla, sin
   ratón, sin micrófono. Un agente sin escritorio es un agente que no puede hacer lo único
   para lo que existe. Task Scheduler con `-LogonType Interactive` y el disparador del
   usuario mantiene el proceso dentro de su sesión, que es justo lo que necesitan las
   herramientas de escritorio.

El coste de Task Scheduler es que hay que abrir `taskschd.msc` para tocarlo, y eso ya lo
ha hecho cualquiera que haya buscad alguna vez un programa que no arranca en Windows.
