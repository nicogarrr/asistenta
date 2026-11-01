' Arranca Asistenta en segundo plano, sin ventanas de consola: abre el icono de la
' bandeja (bandeja.ps1) oculto, y el icono enciende Asistenta si hace falta.
Option Explicit
Dim sh, fso, aqui, app
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
aqui = fso.GetParentFolderName(WScript.ScriptFullName)
app = fso.GetParentFolderName(fso.GetParentFolderName(aqui))
sh.CurrentDirectory = app
' 0 = ventana oculta; False = no espera.
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & aqui & "\bandeja.ps1""", 0, False
