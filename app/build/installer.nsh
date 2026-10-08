; BeePM's additions to electron-builder's installer (electron-builder.js: nsis.include).
; BeePM starts with Windows when it runs in the background: the "com.beepm.app" Run value, which
; BeePM sets itself (main.js applyBackground).

; The installer closed BeePM to replace its files: when it runs in the background, it starts
; again now, in the tray, not only at the next sign-in. ("Run BeePM" on the last page then opens
; its window.) Silent installs are BeePM's own updates: "Restart to update" starts it again by
; itself, and an update installed as BeePM quit leaves it closed.
!macro customInstall
  ${ifNot} ${Silent}
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.beepm.app"
    ${if} $0 != ""
      ${StdUtils.ExecShellAsUser} $1 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" "--background"
    ${endIf}
  ${endIf}
!macroend

; Uninstalling BeePM, not updating it (an update runs the old uninstaller with --updated):
; Windows stops starting it
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.beepm.app"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.beepm.app"
  ${endIf}
!macroend
