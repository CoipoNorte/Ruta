@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ===========================================
echo   RUTA - Configurar y desplegar a gh-pages
echo ===========================================
echo.

:: ---------------------------------------------------------------------------
:: 1) package.json  ->  anade los scripts predeploy / deploy
::    Se edita con Node (ya disponible si usas npm) para no romper el JSON.
:: ---------------------------------------------------------------------------
echo [1/5] Configurando package.json...
node -e "const f='package.json',fs=require('fs');const p=JSON.parse(fs.readFileSync(f,'utf8'));p.scripts=p.scripts||{};p.scripts.predeploy='npm run build';p.scripts.deploy='gh-pages -d dist';fs.writeFileSync(f,JSON.stringify(p,null,2)+'\n');console.log('      scripts predeploy/deploy OK');"
if errorlevel 1 goto error

:: ---------------------------------------------------------------------------
:: 2) vite.config.ts  ->  inserta base: "/Ruta/" si aun no existe
::    GitHub Pages sirve el repo en un subdirectorio, de ahi la ruta base.
:: ---------------------------------------------------------------------------
echo [2/5] Configurando vite.config.ts...
node -e "const f='vite.config.ts',fs=require('fs');let s=fs.readFileSync(f,'utf8');if(s.includes('base:')){console.log('      base ya existia, sin cambios');}else{s=s.replace(/defineConfig\(\{/,'defineConfig({\n  base: \"/Ruta/\",');fs.writeFileSync(f,s);console.log('      base \"/Ruta/\" anadido');}"
if errorlevel 1 goto error

:: ---------------------------------------------------------------------------
:: 3-5) Instalar, compilar y publicar
:: ---------------------------------------------------------------------------
echo.
echo [3/5] Instalando dependencias...
call npm i
if errorlevel 1 goto error

echo.
echo [4/5] Compilando...
call npm run build
if errorlevel 1 goto error

echo.
echo [5/5] Publicando en la rama gh-pages...
call npm run deploy
if errorlevel 1 goto error

echo.
echo ===========================================
echo   LISTO
echo   https://coiponorte.github.io/Ruta/
echo ===========================================
echo.
echo Recuerda: Settings - Pages - rama gh-pages / (root)
pause
exit /b 0

:error
echo.
echo *******************************************
echo   ERROR: el proceso se detuvo.
echo   Revisa el mensaje de arriba.
echo *******************************************
pause
exit /b 1
