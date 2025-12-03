@echo off
setlocal
pushd "%~dp0"

if not exist node_modules (
  echo Installing dependencies...
  npm install
)

echo Starting LocalRepos development server...
echo This window will remain open after startup. Use Ctrl+C to stop the server when you're finished.
cmd /k "npm start"

popd
endlocal
