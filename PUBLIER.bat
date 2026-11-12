@echo off
chcp 65001 >nul
title Publier SEL3A pour tout le monde
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js n'est pas installé : voir GUIDE.md, étape 1.
  pause
  exit /b 1
)
node tools\publier.js %1
echo.
pause
