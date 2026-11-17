@echo off
rem Install Tab Limiter from the tab-limiter-*.zip in the same folder as this file.
rem
rem It extracts into a fresh folder, checks the result, and only then replaces
rem tab-limiter-extension. If anything fails the existing installation is left as
rem it was and the exit code is not zero.
rem
rem SAFETY RULE: the ZIP's file name is only ever stored with  set "TL_ZIP=..."
rem and read by PowerShell as $env:TL_ZIP. It must never be written out as
rem %TL_ZIP%, because a name containing & or ^ would then run as commands.
rem
rem Set TAB_LIMITER_NO_BROWSER and TAB_LIMITER_NO_PAUSE to skip opening Chrome and
rem the final pause.
setlocal DisableDelayedExpansion
cd /d "%~dp0"

set "TL_DEST=tab-limiter-extension"
set "TL_NEW=tab-limiter-extension.new"
set "TL_OLD=tab-limiter-extension.previous"
set "TL_ZIP="
set "TL_MORE="

for %%f in (tab-limiter-*.zip) do if not defined TL_ZIP (set "TL_ZIP=%%f") else set "TL_MORE=1"
if not defined TL_ZIP goto :nozip
if defined TL_MORE goto :morethanone

echo Installing Chrome Tab Limiter...

if exist "%TL_NEW%" rmdir /s /q "%TL_NEW%"
powershell -NoProfile -Command "try { Expand-Archive -LiteralPath $env:TL_ZIP -DestinationPath $env:TL_NEW -ErrorAction Stop } catch { exit 1 }"
if errorlevel 1 goto :extractfailed

for %%r in (manifest.json background.js popup.html options.html) do if not exist "%TL_NEW%\%%r" goto :incomplete

rem Replace the old installation only now that the new one is complete
if exist "%TL_OLD%" rmdir /s /q "%TL_OLD%"
if exist "%TL_DEST%" ren "%TL_DEST%" "%TL_OLD%" || goto :swapfailed
ren "%TL_NEW%" "%TL_DEST%" || goto :restore
if exist "%TL_OLD%" rmdir /s /q "%TL_OLD%"

echo Extension extracted.
echo.
echo Next steps:
echo 1. Open Chrome and go to: chrome://extensions/
echo 2. Enable 'Developer mode'
echo 3. Click 'Load unpacked'
echo 4. Select the folder named %TL_DEST% next to this file
echo.
if not defined TAB_LIMITER_NO_BROWSER start chrome "chrome://extensions/"
if not defined TAB_LIMITER_NO_PAUSE pause
exit /b 0

:nozip
echo No tab-limiter-*.zip found next to this file. Nothing was changed.
goto :failed

:morethanone
echo More than one tab-limiter-*.zip found; keep only the one to install. Nothing was changed.
goto :failed

:extractfailed
echo Could not extract the archive. Nothing was changed.
if exist "%TL_NEW%" rmdir /s /q "%TL_NEW%"
goto :failed

:incomplete
echo The archive is missing a required file. Nothing was changed.
if exist "%TL_NEW%" rmdir /s /q "%TL_NEW%"
goto :failed

:swapfailed
echo Could not move the old installation aside. Nothing was changed.
if exist "%TL_NEW%" rmdir /s /q "%TL_NEW%"
goto :failed

:restore
echo Could not put the new installation in place. Restoring the old one.
if exist "%TL_OLD%" ren "%TL_OLD%" "%TL_DEST%"
if exist "%TL_NEW%" rmdir /s /q "%TL_NEW%"
goto :failed

:failed
if not defined TAB_LIMITER_NO_PAUSE pause
exit /b 1
