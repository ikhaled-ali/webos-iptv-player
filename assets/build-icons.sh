#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

node scripts/build-icons.mjs
node scripts/build-splash.mjs
