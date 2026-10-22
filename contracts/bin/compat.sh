#!/usr/bin/env bash
# Checks that contracts/ stays compatible with a base revision. Run from any
# directory: bash contracts/bin/compat.sh [<base>]
#
# <base> is a commit, a branch or a tag; by default it is the merge base of
# HEAD and main. The working copy of contracts/, uncommitted changes included,
# is compared with contracts/ of the base by bin/compat.js, under the rules of
# "Версии и совместимость сообщений" in contracts/README.md. contracts/ of the
# base comes from `git archive` through stdin and is unpacked in the
# container; a base without contracts/ is empty, so everything is new.
#
# Exit codes: 0 - no breaking change; 1 - a breaking change, or the comparison
# failed; 2 - a wrong argument, or no docker.
#
# Redocly CLI runs from Docker as bin/redocly.sh describes.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/redocly.sh"

if [[ $# -gt 1 ]]; then
  echo 'Usage: bash contracts/bin/compat.sh [<base>]' >&2
  exit 2
fi
# With MSYS_NO_PATHCONV=1 git on Windows does not read a path like /c/...,
# so the top of the repository comes from git itself, in its own form.
cd "$contracts_dir"
top="$(git rev-parse --show-toplevel)"
if [[ $# -eq 1 ]]; then
  base="$1"
  if ! sha="$(git -C "$top" rev-parse --verify --quiet "$base^{commit}")"; then
    echo "FAIL: $base is not a commit" >&2
    exit 2
  fi
else
  base='merge base of HEAD and main'
  if ! sha="$(git -C "$top" merge-base HEAD main)"; then
    echo 'FAIL: HEAD and main have no merge base; pass the base: bash contracts/bin/compat.sh <base>' >&2
    exit 2
  fi
fi
if ! command -v docker >/dev/null 2>&1; then
  echo 'FAIL: docker is not found; the comparison runs in the Redocly image' >&2
  exit 2
fi

echo "Base: $base, $sha"
if git -C "$top" cat-file -e "$sha:contracts" 2>/dev/null; then
  git -C "$top" archive --format=tar "$sha" contracts \
    | run_in_image -w /tmp --entrypoint sh -- -c \
      'mkdir /tmp/base && tar -xf - -C /tmp/base && exec node /spec/bin/compat.js /tmp/base/contracts /spec'
else
  echo 'The base has no contracts/: everything is new.'
  run_in_image -w /tmp --entrypoint sh -- -c \
    'mkdir -p /tmp/base/contracts && exec node /spec/bin/compat.js /tmp/base/contracts /spec' </dev/null
fi
