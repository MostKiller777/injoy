' injoy - run a PowerShell script with no visible console window.
'
' Task Scheduler still flashes a console for `powershell.exe -WindowStyle
' Hidden` on some Windows builds. WScript's Run with window style 0 starts the
' same process with no window at all, so the tunnel watchdog cannot pop over
' whatever is on the desktop.
'
' Usage: wscript.exe silent.vbs "C:\path\to\script.ps1"

Option Explicit

Dim shell, script, command
Set shell = CreateObject("WScript.Shell")

If WScript.Arguments.Count < 1 Then
  WScript.Quit 1
End If

script = WScript.Arguments(0)
command = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & script & """"

' 0 = hidden window, False = do not wait for it to finish.
shell.Run command, 0, False
