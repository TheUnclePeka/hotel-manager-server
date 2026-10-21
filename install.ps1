$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Установите Node.js 24 LTS с nodejs.org, затем снова запустите install.ps1.' }
if ([int](& node -p 'process.versions.node.split(".")[0]') -lt 24) { throw 'Нужен Node.js 24 или новее.' }
& npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'Не удалось установить зависимости. Проверьте соединение с интернетом.' }
& node scripts/setup.mjs
if ($LASTEXITCODE -ne 0) { throw 'Мастер завершился с ошибкой.' }
