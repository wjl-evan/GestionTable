@echo off
chcp 65001 >nul
title Plan de salle - serveur
cd /d "%~dp0"

rem Premier lancement : installation des dépendances
if not exist node_modules (
  echo Installation des dépendances...
  call npm install --omit=dev
)

rem Redémarre automatiquement le serveur s'il s'arrête (erreur, coupure...)
:boucle
node server.js
echo.
echo Le serveur s'est arrêté. Redémarrage dans 5 secondes (fermez cette fenêtre pour l'arrêter)...
timeout /t 5 /nobreak >nul
goto boucle
