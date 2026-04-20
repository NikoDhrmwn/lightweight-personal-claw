@echo off
echo.
echo   Starting LiteClaw...
echo.

cd /d "%~dp0"

:: Check if node_modules exists
if not exist "node_modules" (
    echo   Installing dependencies...
    npm install
)

:: Run with tsx for development
npx tsx src/index.ts

pause
