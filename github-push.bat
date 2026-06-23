@echo off
chcp 65001 > nul
SET "LINEBOTDIR=C:\Users\sharo\OneDrive\claude\穿搭小助手\line-bot"

cd /d "%LINEBOTDIR%"

echo Initializing git...
git init
git add .
git commit -m "Initial commit: outfit LINE Bot"

echo.
echo Enter your GitHub repo URL (from the repo page, green Code button):
echo Example: https://github.com/yourname/outfit-line-bot.git
echo.
set /p REPO_URL="Repo URL: "

git remote remove origin 2>nul
git remote add origin %REPO_URL%
git branch -M main
git push -u origin main

echo.
echo Done! Check GitHub to confirm.
pause
