; Dungeon Tiger installer (NSIS). Built by installer/build.sh.
; Per-user install: no admin rights needed.
Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

Var IsUpdate

!ifndef VERSION
  !define VERSION "1.0.0"
!endif
!define APPNAME "Dungeon Tiger"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\DungeonTiger"

Name "${APPNAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\Dungeon Tiger"
InstallDirRegKey HKCU "Software\DungeonTiger" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "Dungeon Tiger ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APPNAME}"
VIAddVersionKey "FileDescription" "Dungeon Tiger installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "yetimafia"
VIAddVersionKey "LegalCopyright" "yetimafia"

!define MUI_ICON "..\launcher\dungeon.ico"
!define MUI_UNICON "..\launcher\dungeon.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Welcome to Dungeon Tiger"
!define MUI_WELCOMEPAGE_TEXT "A pick-up D&D dungeon crawl: random adventurers, five floors, a battle map, a Discord bot and a GM page. It works with Note Tiger for characters, rules and recaps.$\r$\n$\r$\nNo admin rights needed.$\r$\n$\r$\nClick Next to continue."
!define MUI_COMPONENTSPAGE_SMALLDESC
!define MUI_FINISHPAGE_RUN "$INSTDIR\Dungeon Tiger.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Start Dungeon Tiger now"
!define MUI_FINISHPAGE_TEXT "Dungeon Tiger is installed.$\r$\n$\r$\nThe Dungeon Tiger window opens, and a door icon by the clock shows it's running. If Note Tiger is on this PC, click Link Note Tiger. Add the Discord bot's token in Settings."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; Ask a running copy to shut down, then make sure it's gone.
!macro StopRunningCopy
  nsExec::Exec `powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3090/api/stop -ContentType 'application/json' -Body '{}' -TimeoutSec 3 | Out-Null; Start-Sleep -Seconds 2 } catch {}"`
  Pop $0
  nsExec::Exec `taskkill /F /IM "Dungeon Tiger.exe"`
  Pop $0
  nsExec::Exec `taskkill /F /IM "Dungeon Tiger Window.exe"`
  Pop $0
  Sleep 800
!macroend

Section "Dungeon Tiger (required)" SecMain
  SectionIn RO
  !insertmacro StopRunningCopy

  SetOutPath "$INSTDIR"
  File "..\launcher\dungeon.ico"
  File "${STAGE}\Dungeon Tiger.exe"
  File "${STAGE}\Dungeon Tiger Window.exe"

  RMDir /r "$INSTDIR\runtime"
  SetOutPath "$INSTDIR\runtime"
  File "${STAGE}\runtime\*.*"

  ; Replace the app code but keep the settings (.env) and logs.
  RMDir /r "$INSTDIR\app\node_modules"
  RMDir /r "$INSTDIR\app\src"
  SetOutPath "$INSTDIR\app"
  File /r "${STAGE}\app\*.*"

  CreateDirectory "$SMPROGRAMS\Dungeon Tiger"
  CreateShortcut "$SMPROGRAMS\Dungeon Tiger\Dungeon Tiger.lnk" "$INSTDIR\Dungeon Tiger.exe" "" "$INSTDIR\dungeon.ico"
  CreateShortcut "$SMPROGRAMS\Dungeon Tiger\Uninstall Dungeon Tiger.lnk" "$INSTDIR\Uninstall.exe"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\DungeonTiger" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "Dungeon Tiger"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "yetimafia"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\dungeon.ico"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
SectionEnd

Section "Desktop shortcut" SecDesktop
  CreateShortcut "$DESKTOP\Dungeon Tiger.lnk" "$INSTDIR\Dungeon Tiger.exe" "" "$INSTDIR\dungeon.ico"
SectionEnd

Section /o "Start with Windows" SecStartup
  CreateShortcut "$SMSTARTUP\Dungeon Tiger.lnk" "$INSTDIR\Dungeon Tiger.exe" "" "$INSTDIR\dungeon.ico"
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain} "The game, its window, and everything it needs to run."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "Put a Dungeon Tiger icon on your desktop."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecStartup} "Start Dungeon Tiger automatically when you log in to Windows."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; Started by the app's Update button: a quiet install that keeps your shortcuts and starts Dungeon Tiger again.
Function .onInit
  StrCpy $IsUpdate 0
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/UPDATE" $R1
  ${IfNot} ${Errors}
    StrCpy $IsUpdate 1
    SectionSetFlags ${SecDesktop} 0
    SectionSetFlags ${SecStartup} 0
  ${EndIf}
FunctionEnd

Section "-Restart after update"
  ${If} $IsUpdate == 1
    Exec '"$INSTDIR\Dungeon Tiger.exe"'
  ${EndIf}
SectionEnd

Section "Uninstall"
  !insertmacro StopRunningCopy
  Delete "$DESKTOP\Dungeon Tiger.lnk"
  Delete "$SMSTARTUP\Dungeon Tiger.lnk"
  RMDir /r "$SMPROGRAMS\Dungeon Tiger"
  Delete "$INSTDIR\Dungeon Tiger.exe"
  Delete "$INSTDIR\Dungeon Tiger Window.exe"
  RMDir /r "$LOCALAPPDATA\DungeonTiger\WebView2"
  RMDir "$LOCALAPPDATA\DungeonTiger"
  Delete "$INSTDIR\dungeon.ico"
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\app\node_modules"
  RMDir /r "$INSTDIR\app\src"
  RMDir /r "$INSTDIR\app\data"
  RMDir /r "$INSTDIR\app\public"
  RMDir /r "$INSTDIR\app\logs"
  RMDir /r "$INSTDIR\app\bin"
  RMDir /r "$INSTDIR\app\cache"
  Delete "$INSTDIR\app\*.json"
  Delete "$INSTDIR\app\*.md"
  Delete "$INSTDIR\app\.env.example"
  MessageBox MB_YESNO|MB_ICONQUESTION "Also delete your settings (Discord bot token and Note Tiger link)?$\r$\n$\r$\nChoose No to keep them for a future install." /SD IDNO IDNO keepData
    Delete "$INSTDIR\app\.env"
  keepData:
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR\app"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\DungeonTiger"
SectionEnd
