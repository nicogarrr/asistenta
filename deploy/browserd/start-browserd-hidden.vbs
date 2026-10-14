' start-browserd-hidden.vbs - arranque oculto del sidecar browserd.
'
' Lo invoca el Planificador de tareas (ver install-browserd-autostart.ps1):
'   wscript.exe start-browserd-hidden.vbs "<python.exe del venv>" "<dir browserd>"
'
' Por que existe este archivo: una tarea AtLogOn con principal interactivo que
' ejecuta python.exe directamente abre una ventana de consola en cada inicio de
' sesion. wscript.exe no tiene consola y Run con intWindowStyle=0 hereda esa
' invisibilidad para el hijo. pythonw.exe no vale: deja sys.stdout/sys.stderr
' a None y el logging de uvicorn se rompe.
'
' DECISION DE SUPERVISION (auditoria): Run se llama con waitOnReturn=True y el
' codigo de salida de Python se devuelve con WScript.Quit. El Planificador
' supervisa ESTE proceso (wscript): mientras viva, vive Python. Asi valen las
' garantias de la tarea: RestartCount reinicia el sidecar si Python muere,
' IgnoreNew evita duplicados y el LastTaskResult refleja el exito real. Con
' waitOnReturn=False, wscript terminaria OK al instante y ninguna de esas
' garantias tocaria al sidecar.
'
' IDEMPOTENCIA FAIL-CLOSED (auditoria): antes de arrancar nada se sondea
' /health con probe_health.py, que valida el CONTRATO JSON real y solo
' devuelve "puerto libre" (2) ante una conexion RECHAZADA:
'   0 (browserd valido)  -> adopta: sale con 0 sin crear otro proceso. OJO: la
'     instancia previa NO queda supervisada por la tarea; la supervision cubre
'     solo instancias arrancadas por la propia tarea.
'   2 (puerto libre)     -> arranca.
'   cualquier otro codigo (1 = contrato no cumplido, timeout, error de
'     protocolo; u otro inesperado = helper caido o ausente) -> NO arranca y
'     sale con 1. Un timeout con el puerto ocupado no es "libre".
'
' La configuracion es EXPLICITA (la misma que setup-browserd.ps1 -Start):
' loopback, puerto 7701 y token vacio. Escuchar fuera de loopback exigiria
' token, y eso es una decision que no le corresponde a un arranque automatico.
Option Explicit

Dim sh, fso, py, dir, logs, outLog, errLog, cmd, exitCode, probe, probeScript

Const HEALTH_URL = "http://127.0.0.1:7701/health"

If WScript.Arguments.Count < 2 Then
  WScript.Echo "Uso: wscript.exe start-browserd-hidden.vbs ""<python.exe>"" ""<dir browserd>"""
  WScript.Quit 1
End If

py  = WScript.Arguments.Item(0)
dir = WScript.Arguments.Item(1)

Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

Sub LogLine(path, msg)
  Dim ts
  Set ts = fso.OpenTextFile(path, 8, True) ' 8 = ForAppending
  ts.WriteLine FormatDateTime(Now, 2) & " " & FormatDateTime(Now, 4) & " " & msg
  ts.Close
End Sub

logs = fso.BuildPath(dir, "logs")
If Not fso.FolderExists(logs) Then fso.CreateFolder(logs)
outLog = fso.BuildPath(logs, "browserd.out.log")
errLog = fso.BuildPath(logs, "browserd.err.log")

If Not fso.FileExists(py) Then
  LogLine errLog, "No existe el python del venv: " & py & ". Instala el sidecar: deploy\browserd\setup-browserd.ps1"
  WScript.Quit 1
End If

' Sin el validador del contrato no hay arranque seguro: fallar cerrado.
probeScript = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "probe_health.py")
If Not fso.FileExists(probeScript) Then
  LogLine errLog, "No existe probe_health.py junto al launcher; no arranco sin validar el contrato."
  WScript.Quit 1
End If

' Sondeo del contrato: 0 = browserd valido, 2 = puerto libre, otro = no arrancar.
cmd = "cmd /c " & Chr(34) & _
      """" & py & """ """ & probeScript & """ """ & HEALTH_URL & """" & _
      Chr(34)
probe = sh.Run(cmd, 0, True)

If probe = 0 Then
  LogLine outLog, "Ya responde un browserd valido en 127.0.0.1:7701; no arranco otra instancia (esa instancia NO queda supervisada por la tarea)."
  WScript.Quit 0
End If
If probe <> 2 Then
  LogLine errLog, "127.0.0.1:7701 no esta libre ni responde el contrato browserd (codigo " & probe & "); no arranco."
  WScript.Quit 1
End If

' Variables de entorno del proceso hijo: nada de heredar sorpresas del logon.
sh.Environment("PROCESS")("BROWSERD_HOST")  = "127.0.0.1"
sh.Environment("PROCESS")("BROWSERD_PORT")  = "7701"
sh.Environment("PROCESS")("BROWSERD_TOKEN") = ""

' La redireccion a log exige cmd /c. El par de comillas exterior extra es el
' workaround documentado: sin el, cmd /c se come las comillas interiores de
' rutas con espacios.
cmd = "cmd /c " & Chr(34) & _
      """" & py & """ -m browserd" & _
      " >> """ & outLog & """ 2>> """ & errLog & """" & _
      Chr(34)

sh.CurrentDirectory = dir
exitCode = sh.Run(cmd, 0, True)
WScript.Quit exitCode
