!include nsDialogs.nsh
!include LogicLib.nsh

; Top level, not customHeader: this file is included ahead of the generated
; script, while customHeader is inserted after the install page has expanded
; MUI_LANGDLL_SAVELANGUAGE. Defined there, the language dialog reads the value
; but nothing ever writes it, so it asks again on every interactive install.
!define MUI_LANGDLL_REGISTRY_ROOT "HKCU"
!define MUI_LANGDLL_REGISTRY_KEY "Software\WFHelper"
!define MUI_LANGDLL_REGISTRY_VALUENAME "InstallerLanguage"

!macro customUnInstall
  ${IfNot} ${isUpdated}
    DeleteRegValue HKCU "Software\WFHelper" "InstallerLanguage"
    DeleteRegKey /ifempty HKCU "Software\WFHelper"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "WFHelperWarframeWatcher"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "WFHelperWarframeWatcher"
    Delete "$APPDATA\WFHelper\warframe-watcher.json"
    Delete "$APPDATA\WFHelper\warframe-watcher.ps1"
    Delete "$APPDATA\WFHelper\warframe-watcher-task.xml"
    nsExec::Exec '"$SYSDIR\schtasks.exe" /Delete /TN "WFHelperWarframeWatcher" /F'
    Pop $0
    ReadEnvStr $0 "USERNAME"
    ${If} $0 != ""
      nsExec::Exec '"$SYSDIR\schtasks.exe" /Delete /TN "WFHelper\WarframeWatcher-$0" /F'
      Pop $0
    ${EndIf}
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER
Var HelperAutoInstall
Var HelperAutoInstallCheckbox

!macro customInit
  StrCpy $HelperAutoInstall "1"
!macroend

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
  Page custom HelperOptionsPage HelperOptionsLeave
!macroend

Function HelperOptionsPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "WFHelper can download warframe-api-helper on first launch, or you can manage the helper manually."
  Pop $0

  ${NSD_CreateCheckbox} 0 34u 100% 12u "Automatically install warframe-api-helper during first-run setup"
  Pop $HelperAutoInstallCheckbox

  ${If} $HelperAutoInstall == "1"
    ${NSD_Check} $HelperAutoInstallCheckbox
  ${EndIf}

  ${NSD_CreateLabel} 0 58u 100% 42u "Manual install path: $APPDATA\WFHelper\api-helper\warframe-api-helper.exe$\r$\nIf you skip automatic install, download the helper yourself and place it at that path."
  Pop $0

  nsDialogs::Show
FunctionEnd

Function HelperOptionsLeave
  ${NSD_GetState} $HelperAutoInstallCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $HelperAutoInstall "1"
  ${Else}
    StrCpy $HelperAutoInstall "0"
  ${EndIf}
FunctionEnd

!macro customInstall
  ; Silent auto-update skips the options page - keep the user's original choice.
  ${If} ${Silent}
  ${AndIf} ${FileExists} "$APPDATA\WFHelper\setup-preferences.json"
    Goto helperPrefsDone
  ${EndIf}
  CreateDirectory "$APPDATA\WFHelper"
  FileOpen $0 "$APPDATA\WFHelper\setup-preferences.json" w
  ${If} $HelperAutoInstall == "1"
    FileWrite $0 '{"autoInstallHelper":true}'
  ${Else}
    FileWrite $0 '{"autoInstallHelper":false}'
  ${EndIf}
  FileClose $0
  helperPrefsDone:
!macroend
!endif
