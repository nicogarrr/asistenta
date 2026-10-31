;; Instalador de Asistenta (plantilla de scripts/windows-app/build-installer.mjs). Por usuario.
;; Desinstalar NO borra tu .env, tus claves ni tu memoria salvo que marques la casilla.
Unicode true
!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!define APP "Asistenta"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Asistenta"
Name "${APP}"
OutFile "@@OUTFILE@@"
InstallDir "$LOCALAPPDATA\Asistenta"
InstallDirRegKey HKCU "Software\Asistenta" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "${APP} @@VERSION@@"
Var BorrarDatos
Var CasillaDatos
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
UninstPage custom un.PaginaDatos un.SalirDatos
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Spanish"
Section "Asistenta"
  ; Encendida, Windows no deja sobrescribir sus archivos: primero se apaga.
  ${If} ${FileExists} "$INSTDIR\app\dist\cli.js"
    SetOutPath "$INSTDIR\app"
    nsExec::Exec '"$INSTDIR\node\node.exe" "$INSTDIR\app\dist\cli.js" stop'
    Pop $0
  ${EndIf}
  ; Fuera el programa viejo; .env y tus datos se quedan donde están.
@@REMOVE_APP@@
  RMDir /r "$INSTDIR\node"
  SetOutPath "$INSTDIR\node"
  File /r "@@STAGE@@/node/*"
  SetOutPath "$INSTDIR\app"
  File /r "@@STAGE@@/app/*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  ; Accesos directos con la carpeta app como carpeta de trabajo (ahí vive .env).
  CreateDirectory "$SMPROGRAMS\Asistenta"
  CreateShortcut "$SMPROGRAMS\Asistenta\Desinstalar Asistenta.lnk" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Asistenta" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "Asistenta"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "@@VERSION@@"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "Asistenta (nicogarrr)"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\Uninstall.exe,0"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" @@SIZE_KB@@
SectionEnd
Function un.PaginaDatos
  !insertmacro MUI_HEADER_TEXT "Tus datos" "Por defecto se conservan"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 36u "Se quita el programa. Tu configuración (.env), tus claves y tu memoria se quedan, por si vuelves a instalar Asistenta."
  Pop $0
  ${NSD_CreateCheckbox} 0 44u 100% 12u "Borrar también mis datos, claves y configuración (no se puede deshacer)"
  Pop $CasillaDatos
  ${NSD_SetState} $CasillaDatos ${BST_UNCHECKED}
  nsDialogs::Show
FunctionEnd
Function un.SalirDatos
  ${NSD_GetState} $CasillaDatos $BorrarDatos
FunctionEnd
Section "Uninstall"
  ${If} ${FileExists} "$INSTDIR\app\dist\cli.js"
    SetOutPath "$INSTDIR\app"
    nsExec::Exec '"$INSTDIR\node\node.exe" "$INSTDIR\app\dist\cli.js" stop'
    Pop $0
  ${EndIf}
  SetOutPath "$TEMP"
@@REMOVE_APP@@
  RMDir /r "$INSTDIR\node"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir /r "$SMPROGRAMS\Asistenta"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\Asistenta"
  ${If} $BorrarDatos == ${BST_CHECKED}
    ; Solo con la casilla marcada: .env, carpeta app y datos de serie.
    Delete "$INSTDIR\app\.env"
    RMDir /r "$INSTDIR\app"
    RMDir /r "$PROFILE\.local\share\personal-agent"
  ${EndIf}
  ; Sin /r: si queda algo tuyo (como .env), la carpeta se queda.
  RMDir "$INSTDIR\app"
  RMDir "$INSTDIR"
SectionEnd
