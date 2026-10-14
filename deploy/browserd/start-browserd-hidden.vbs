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
' La configuracion es EXPLICITA (la misma que setup-browserd.ps1 -Start):
' loopback, puerto 7701 y token vacio. Escuchar fuera de loopback exigiria
' token, y eso es una decision que no le corresponde a un arranque automatico.
Option Explicit

Dim sh, fso, py, dir, logs, outLog, errLog, cmd

If WScript.Arguments.Count < 2 Then
  WScript.Echo "Uso: wscript.exe start-browserd-hidden.vbs ""<python.exe>"" ""<dir browserd>"""
  WScript.Quit 1
End If

py  = WScript.Arguments.Item(0)
dir = WScript.Arguments.Item(1)

Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

If Not fso.FileExists(py) Then
  WScript.Echo "No existe el python del venv: " & py & vbCrLf & _
    "Instala el sidecar primero: deploy\browserd\setup-browserd.ps1"
  WScript.Quit 1
End If

logs = fso.BuildPath(dir, "logs")
If Not fso.FolderExists(logs) Then fso.CreateFolder(logs)
outLog = fso.BuildPath(logs, "browserd.out.log")
errLog = fso.BuildPath(logs, "browserd.err.log")

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
sh.Run cmd, 0, False
