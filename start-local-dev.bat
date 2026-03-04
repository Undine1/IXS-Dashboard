@echo off
setlocal

cd /d "%~dp0"

echo Starting local dev server on http://localhost:3001
echo.
npm run dev -- -p 3001

endlocal
