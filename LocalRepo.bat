@echo off
setlocal
pushd "%~dp0"

if not exist node_modules (
  echo Installing dependencies...
  npm install
)

echo Starting LocalRepos development server...
npm start

popd
endlocal
