@echo off
setlocal
chcp 65001 >nul 2>nul
title YouTube Archive Engine V5
cd /d "%~dp0"

REM Put the app folder first on PATH so local yt-dlp.exe / ffmpeg.exe are found.
set "PATH=%~dp0;%PATH%"

REM Prefer the standalone exe (no Bun needed to run it). "bun run build:win"
REM writes it to dist\, so check there first, then the app folder itself in
REM case it was copied next to this script.
set "ARCHIVE_EXE="
if exist "%~dp0dist\youtube-archive.exe" set "ARCHIVE_EXE=%~dp0dist\youtube-archive.exe"
if not defined ARCHIVE_EXE (
  if exist "%~dp0archive.exe" set "ARCHIVE_EXE=%~dp0archive.exe"
)

if defined ARCHIVE_EXE (
  "%ARCHIVE_EXE%"
  if errorlevel 1 pause
  exit /b %errorlevel%
)

where bun >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Neither the standalone exe nor Bun was found.
  echo.
  echo   Option A: Build the standalone exe:   bun run build:win:all
  echo            ^(it lands in dist\youtube-archive.exe^)
  echo   Option B: Install Bun:                https://bun.sh
  echo.
  pause
  exit /b 1
)

bun run batch_playlist_downloader.ts
if errorlevel 1 (
  echo.
  echo   The engine exited with an error. See messages above / error.log.
  pause
)
endlocal
