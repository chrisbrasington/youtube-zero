#!/usr/bin/env bash
set -euo pipefail

git pull
docker compose up -d --build
docker compose ps
