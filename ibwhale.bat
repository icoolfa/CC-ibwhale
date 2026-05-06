@echo off
cd /d "%~dp0"
set tmpvbs=%TEMP%\ibwhale_%RANDOM%.vbs
set sdir=%~dp0
(
echo Dim WshShell,shortcutPath,lnk,q,scriptDir,fso
echo scriptDir="%sdir%"
echo Set fso=CreateObject^("Scripting.FileSystemObject"^)
echo Set WshShell=CreateObject^("WScript.Shell"^)
echo q=Chr^(34^)
echo shortcutPath=fso.BuildPath^(scriptDir,"ibwhale.lnk"^)
echo Set lnk=WshShell.CreateShortcut^(shortcutPath^)
echo lnk.TargetPath=q ^& fso.BuildPath^(scriptDir,"ibwhale.bat"^) ^& q
echo lnk.WorkingDirectory=scriptDir
echo lnk.IconLocation=fso.BuildPath^(scriptDir,"img\logo.ico"^)
echo lnk.Description="ibwhale agent"
echo lnk.WindowStyle=7
echo lnk.Save
echo WshShell.Run "cmd /c npx electron .",0,False
) > %tmpvbs%
cscript //nologo %tmpvbs%
del %tmpvbs%