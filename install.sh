#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
command -v node >/dev/null || { echo 'Установите Node.js 24 LTS с nodejs.org и повторите запуск.'; exit 1; }
node -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)' || { echo 'Нужен Node.js 24 или новее.'; exit 1; }
npm ci
node scripts/setup.mjs
