#!/usr/bin/env bash
# Fetches the pinned CUE4Parse revision, applies the patches in extractor/patches and builds the extractor. Requires the .NET 10 SDK and git.
set -euo pipefail
cd "$(dirname "$0")/../extractor"

CUE4PARSE_REPO="https://github.com/FabianFG/CUE4Parse.git"
CUE4PARSE_SHA="$(tr -d '[:space:]' < CUE4PARSE_REVISION)"   # tested revision (supports UE 5.7); single source of truth

[ -n "${DOTNET_ROOT:-}" ] && export PATH="$DOTNET_ROOT:$PATH"
command -v dotnet >/dev/null || { echo "dotnet not found. Install the .NET 10 SDK: https://dot.net"; exit 1; }
dotnet --list-sdks | grep -q '^10\.' || { echo ".NET 10 SDK required (found: $(dotnet --list-sdks | tr '\n' ' '))"; exit 1; }

if [ ! -d CUE4Parse/.git ]; then
  mkdir -p CUE4Parse
  git -C CUE4Parse init -q
  git -C CUE4Parse remote add origin "$CUE4PARSE_REPO"
fi
if [ "$(git -C CUE4Parse rev-parse HEAD 2>/dev/null || true)" != "$CUE4PARSE_SHA" ]; then
  git -C CUE4Parse fetch --depth 1 origin "$CUE4PARSE_SHA"
  git -C CUE4Parse checkout -q FETCH_HEAD
  git -C CUE4Parse submodule update --init --recursive --depth 1
fi

# Local patches to the pinned revision (each one is a plain `git diff` against it, applied once).
for patch in patches/*.patch; do
  if git -C CUE4Parse apply --check --reverse "../$patch" 2>/dev/null; then continue; fi   # already applied
  git -C CUE4Parse apply "../$patch"
done

dotnet build -c Release -v quiet
echo "Extractor built: bin/Release/net10.0/Unpack.dll"
