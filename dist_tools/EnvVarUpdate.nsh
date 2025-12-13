/**
 *  EnvVarUpdate.nsh
 *    : Environmental Variables: append, prepend, and remove entries
 *
 *     WARNING: If you use StrFunc.nsh header then include it before this file
 *              with all required definitions. This is to avoid conflicts
 *
 *  Usage:
 *    ${EnvVarUpdate} "ResultVar" "EnvVarName" "Action" "RegLoc" "PathString"
 *
 *  Credits:
 *  Version 1.0 
 *  * Cal Turney (turnec2)
 *  * Amir Szekely (KiCHiK) and e-circ for developing the forerunners of this
 *    function: AddToPath, un.RemoveFromPath, AddToEnvVar, un.RemoveFromEnvVar,
 *    WriteEnvStr, and un.DeleteEnvStr
 *  * Diego Pedroso (deguix) for StrTok
 *  * Kevin English (kenglish_hi) for StrContains
 *  * Hendri Adriaens (Smile2Me), Diego Pedroso (deguix), and Dan Fuhry  
 *    (dandaman32) for StrReplace
 */

!ifndef ENVVARUPDATE_FUNCTION
!define ENVVARUPDATE_FUNCTION
!verbose push
!verbose 3
!include "LogicLib.nsh"
!include "WinMessages.NSH"
!include "StrFunc.nsh"

; ---- StrStr ----
${StrTok}
${StrStr}
${StrRep}

; -------- Error detection & reporting macros --------
!macro _ENVUPD_RETURN_ERROR _ERR_MSG
  DetailPrint "EnvVarUpdate error: ${_ERR_MSG}"
  return 
!macroend

Function EnvVarUpdate
  Push $0
  Exch 4
  Exch $1
  Exch 3
  Exch $2
  Exch 2
  Exch $3
  Exch
  Exch $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  Push $R0

  ; Store the parameters on the stack
  Push $4 ; RegLoc
  Push $3 ; PathStr
  Push $2 ; Action
  Push $1 ; VarName
  
  Pop $1 ; pop VarName
  Pop $2 ; pop Action
  Pop $3 ; pop PathStr
  Pop $4 ; pop RegLoc

  ; Read current value
  ${If} $4 == "HKLM"
    ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" $1
  ${ElseIf} $4 == "HKCU"
    ReadRegStr $0 HKCU "Environment" $1
  ${Else}
    !insertmacro _ENVUPD_RETURN_ERROR "Invalid registry location: $4"
  ${EndIf}

  ; Action
  ${If} $2 == "A" ; Append
    ${If} $0 == ""
      StrCpy $0 $3
    ${Else}
      ${StrStr} $R0 $0 $3
      ${If} $R0 == ""
        StrCpy $0 "$0;$3"
      ${EndIf}
    ${EndIf}
  ${ElseIf} $2 == "P" ; Prepend
    ${If} $0 == ""
      StrCpy $0 $3
    ${Else}
      ${StrStr} $R0 $0 $3
      ${If} $R0 == ""
        StrCpy $0 "$3;$0"
      ${EndIf}
    ${EndIf}
  ${ElseIf} $2 == "R" ; Remove
    ${StrRep} $0 $0 ";$3" ""
    ${StrRep} $0 $0 "$3;" ""
    ${StrRep} $0 $0 "$3" ""
  ${Else}
    !insertmacro _ENVUPD_RETURN_ERROR "Invalid action: $2"
  ${EndIf}

  ; Write back
  ${If} $4 == "HKLM"
    WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" $1 $0
  ${ElseIf} $4 == "HKCU"
    WriteRegExpandStr HKCU "Environment" $1 $0
  ${EndIf}

  ; Broadcast change
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000

  Pop $R0
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

!define EnvVarUpdate '!insertmacro EnvVarUpdateCall'

!macro EnvVarUpdateCall _RESULT_VAR _ENV_VAR_NAME _ACTION _REG_LOC _PATH_STR
  Push `${_PATH_STR}`
  Push `${_REG_LOC}`
  Push `${_ACTION}`
  Push `${_ENV_VAR_NAME}`
  Call EnvVarUpdate
  Pop ${_RESULT_VAR}
!macroend

; Uninstaller
Function un.EnvVarUpdate
  Push $0
  Exch 4
  Exch $1
  Exch 3
  Exch $2
  Exch 2
  Exch $3
  Exch
  Exch $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  Push $R0

  Push $4
  Push $3
  Push $2
  Push $1
  
  Pop $1
  Pop $2
  Pop $3
  Pop $4

  ${If} $4 == "HKLM"
    ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" $1
  ${ElseIf} $4 == "HKCU"
    ReadRegStr $0 HKCU "Environment" $1
  ${Else}
    !insertmacro _ENVUPD_RETURN_ERROR "Invalid registry location: $4"
  ${EndIf}

  ${If} $2 == "R"
    ${StrRep} $0 $0 ";$3" ""
    ${StrRep} $0 $0 "$3;" ""
    ${StrRep} $0 $0 "$3" ""
  ${Else}
    !insertmacro _ENVUPD_RETURN_ERROR "Invalid action: $2"
  ${EndIf}

  ${If} $4 == "HKLM"
    WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" $1 $0
  ${ElseIf} $4 == "HKCU"
    WriteRegExpandStr HKCU "Environment" $1 $0
  ${EndIf}

  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000

  Pop $R0
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

!define un.EnvVarUpdate '!insertmacro un.EnvVarUpdateCall'

!macro un.EnvVarUpdateCall _RESULT_VAR _ENV_VAR_NAME _ACTION _REG_LOC _PATH_STR
  Push `${_PATH_STR}`
  Push `${_REG_LOC}`
  Push `${_ACTION}`
  Push `${_ENV_VAR_NAME}`
  Call un.EnvVarUpdate
  Pop ${_RESULT_VAR}
!macroend

!verbose pop
!endif

