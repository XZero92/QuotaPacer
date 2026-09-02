!macro NSIS_HOOK_POSTUNINSTALL
  ; Tauri removes the Run entry itself. Remove Windows' separate startup
  ; approval state as well so uninstalling does not leave a stale login item.
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${PRODUCTNAME}"
  ${EndIf}
!macroend
