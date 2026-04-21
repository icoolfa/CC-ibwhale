Dim fso, scriptDir, electronPath
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
electronPath = fso.BuildPath(scriptDir, "node_modules\electron\dist\electron.exe")

Dim WshShell
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = scriptDir
WshShell.Run """" & electronPath & """ .", 0, False

Set WshShell = Nothing
