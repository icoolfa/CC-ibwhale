Dim fso, scriptDir
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

Dim WshShell, shortcutPath, lnk, q
q = Chr(34)
shortcutPath = fso.BuildPath(scriptDir, "ibwhale.lnk")
Set WshShell = CreateObject("WScript.Shell")
Set lnk = WshShell.CreateShortcut(shortcutPath)
lnk.TargetPath = q & fso.BuildPath(scriptDir, "ibwhale.vbs") & q
lnk.WorkingDirectory = scriptDir
lnk.IconLocation = fso.BuildPath(scriptDir, "img\logo.ico")
lnk.Description = "ibwhale agent"
lnk.WindowStyle = 7
lnk.Save

WshShell.CurrentDirectory = scriptDir
WshShell.Run "cmd /c npx electron .", 0, False

Set lnk = Nothing
Set WshShell = Nothing
