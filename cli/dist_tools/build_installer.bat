@echo off
cd ..
echo Building BeePM Installer...
echo.

echo Step 1: Building executable with PyInstaller...
pyinstaller --onefile --name=beepm --console beepm/cli.py
if errorlevel 1 (
    echo ERROR: Failed to build executable!
    pause
    exit /b 1
)
echo.

echo Step 2: Building Windows installer with NSIS...
makensis dist_tools\installer.nsi
if errorlevel 1 (
    echo ERROR: Failed to build installer!
    echo Make sure NSIS is installed: https://nsis.sourceforge.io/Download
    pause
    exit /b 1
)
echo.

echo ========================================
echo Build complete!
echo ========================================
echo.
echo Installer created: dist\BeePM-Setup.exe
echo.
echo You can now distribute dist\BeePM-Setup.exe
echo Users can run it to install BeePM with automatic PATH setup!
echo.
pause

