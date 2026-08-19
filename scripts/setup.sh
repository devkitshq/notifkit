#!/usr/bin/env bash
set -euo pipefail

node_version=$(node --version | cut -c2-)
required_version="22.0.0"

if [ "$(printf '%s\n' "$required_version" "$node_version" | sort -V | head -n1)" != "$required_version" ]; then
  echo "Node.js >= 22.0.0 is required. Found: $node_version"
  exit 1
fi

if ! command -v npm &>/dev/null; then
  echo "npm is required."
  exit 1
fi

npm install
npm run build
