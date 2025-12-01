@echo off
setlocal
pushd "%~dp0"

if not exist node_modules (
  echo Installing dependencies...
  npm install
)

echo Starting LocalRepos development server...
call npm start

echo.
echo If the server stopped unexpectedly, review the logs above.
pause

popd
endlocal
