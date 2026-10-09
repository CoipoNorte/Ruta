@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ================================================
echo   RUTA - Verificacion en pagina de nivel superior
echo ================================================
echo.
echo Esta ventana sirve la build SIN el iframe del visor Arena.
echo Los mensajes de Permissions-Policy y dead-clicks no pueden aparecer aqui.
echo.

call npm run build
if errorlevel 1 goto error

echo Abriendo http://127.0.0.1:4173/Ruta/
echo Pulsa Ctrl+C para detener el servidor.
call npm run preview -- --host 127.0.0.1 --port 4173 --open /Ruta/
exit /b 0

:error
echo.
echo ERROR: la build fallo. Revisa el mensaje anterior.
pause
exit /b 1