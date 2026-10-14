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
' IDEMPOTENCIA (auditoria): antes de arrancar nada se sondea /health:
'   - si YA responde un browserd con su contrato, este launcher sale con 0 sin
'     crear otro proceso (un segundo bind a 127.0.0.1:7701 fallaria en bucle
'     con el reinicio por minuto de la tarea). OJO: esa instancia previa NO
'     queda supervisada por la tarea; la supervision cubre solo instancias
'     arrancadas por la propia tarea.
'   - si el puerto responde pero NO es un browserd valido, sale con 1 sin
'     arrancar: competir por el puerto tampoco levantaria nada sano.
'
' La configuracion es EXPLICITA (la misma que setup-browserd.ps1 -Start):
' loopback, puerto 7701 y token vacio. Escuchar fuera de loopback exigiria
' token, y eso es una decision que no le corresponde a un arranque automatico.
Option Explicit

Dim sh, fso, py, dir, logs, outLog, errLog, cmd, exitCode, probe

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

' 0 = nadie escucha; 1 = browserd valido (contrato); 2 = responde algo ajeno.
Function ProbeHealth(url)
  Dim http, body
  On Error Resume Next
  Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
  http.SetTimeouts 2000, 2000, 2000, 2000
  http.Open "GET", url, False
  http.Send
  If Err.Number <> 0 Then
    ProbeHealth = 0
    Err.Clear
    On Error GoTo 0
    Exit Function
  End If
  On Error GoTo 0
  body = http.ResponseText
  If http.Status = 200 And InStr(body, "browserd") > 0 And InStr(body, "read") > 0 Then
    ProbeHealth = 1
  Else
    ProbeHealth = 2
  End If
End Function

If Not fso.FileExists(py) Then
  WScript.Echo "No existe el python del venv: " & py & vbCrLf & _
    "Instala el sidecar primero: deploy\browserd\setup-browserd.ps1"
  WScript.Quit 1
End If

logs = fso.BuildPath(dir, "logs")
If Not fso.FolderExists(logs) Then fso.CreateFolder(logs)
outLog = fso.BuildPath(logs, "browserd.out.log")
errLog = fso.BuildPath(logs, "browserd.err.log")

probe = ProbeHealth(HEALTH_URL)
If probe = 1 Then
  LogLine outLog, "Ya responde un browserd valido en 127.0.0.1:7701; no arranco otra instancia (esa instancia NO queda supervisada por la tarea)."
  WScript.Quit 0
ElseIf probe = 2 Then
  LogLine errLog, "127.0.0.1:7701 responde pero NO es un browserd valido; no arranco. Cierra ese proceso."
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
