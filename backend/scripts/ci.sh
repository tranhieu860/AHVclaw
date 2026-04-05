#!/bin/bash
set -e

echo "=== Go Build ==="
cd /opt/ahvclaw/backend
go build -o /dev/null .

echo "=== Go Tests ==="
go test ./tools/ ./autonomous/ -v -count=1

echo "=== Frontend Build ==="
cd /opt/ahvclaw/frontend
npm run build

echo "=== Frontend Lint ==="
npx eslint .

echo "=== All Checks Passed ==="
