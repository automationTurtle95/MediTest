#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-55000}"
export ASPNETCORE_URLS="${ASPNETCORE_URLS:-http://127.0.0.1:$PORT}"
export DOTNET_URLS="${DOTNET_URLS:-http://127.0.0.1:$PORT}"

dotnet run --configuration Release --no-launch-profile
