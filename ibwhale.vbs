Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "D:\CC ibwhale\ibwhale"
WshShell.Run """D:\CC ibwhale\ibwhale\node_modules\electron\dist\electron.exe"" .", 0, False
Set WshShell = Nothing
