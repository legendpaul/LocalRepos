@echo off
setlocal
pushd "%~dp0"

if not exist node_modules (
  echo Installing dependencies...
  call npm install
)

echo Starting LocalRepos development server...
call npm start

popd
endlocal
