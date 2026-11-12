@echo off
chcp 65001 >nul
title Construction du launcher SEL3A
cd /d "%~dp0"
echo.
echo  === Construction du launcher SEL3A (avec Midnight City) ===
echo.
where npm >nul 2>nul
if errorlevel 1 (
  echo  Node.js n'est pas installé : voir GUIDE.md, étape 1.
  pause
  exit /b 1
)
if not exist node_modules (
  echo  Installation des outils, une seule fois...
  call npm install
  if errorlevel 1 goto echec
)
echo  Construction en cours : 1 à 3 minutes...
call npm run dist
if errorlevel 1 goto echec
set "SETUP="
for %%f in ("dist\SEL3A-Launcher-Setup-*.exe") do set "SETUP=%%f"
if not defined SETUP goto echec
echo.
echo  Terminé ! Installation de la nouvelle version du launcher...
start "" "%SETUP%"
exit /b 0
:echec
echo.
echo  La construction a échoué : copie le message ci-dessus et envoie-le à Claude.
pause
exit /b 1
