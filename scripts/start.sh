#!/usr/bin/env sh
set -e
pnpm --filter "$1" start
