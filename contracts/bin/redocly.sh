# The Redocly CLI image of the checks and how they run it. check.sh and
# compat.sh source this file; it sets contracts_dir and defines
# run_in_image.
#
# Redocly CLI 2.60.0 runs from Docker, pinned by digest; an update of the
# image is a pull request of its own. A run is isolated: no network, no
# capabilities, a read-only root file system with a tmpfs /tmp, and the
# unprivileged user nobody; contracts/ is mounted read-only at /spec. In Git
# Bash on Windows MSYS_NO_PATHCONV=1 keeps the paths in docker arguments as
# they are, and the volume path comes from `pwd -W`.

readonly IMAGE='redocly/cli:2.60.0@sha256:309a2bf4f7474b76258e144ff3633ef3f2073d83d1048daa142d1aa3743e950c'

contracts_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mount_dir="$(cd "$contracts_dir" && { pwd -W 2>/dev/null || pwd; })"
export MSYS_NO_PATHCONV=1

# Runs the image isolated, with stdin attached:
#   run_in_image [-e NAME=VALUE | -w DIR | --entrypoint PROGRAM]... -- <command>...
# Only these options are taken: docker run applies a later --network, --user
# or -v over the isolation flags, so any other option is refused.
run_in_image() {
  local options=()
  while [[ $# -gt 0 && "$1" != '--' ]]; do
    case "$1" in
      -e | -w | --entrypoint)
        if [[ $# -lt 2 ]]; then
          echo "run_in_image: $1 needs a value" >&2
          return 2
        fi
        options+=("$1" "$2")
        shift 2
        ;;
      *)
        echo "run_in_image: option $1 is not allowed" >&2
        return 2
        ;;
    esac
  done
  if [[ $# -eq 0 ]]; then
    echo 'run_in_image: -- before the command is missing' >&2
    return 2
  fi
  shift
  docker run --rm -i \
    --network none \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --read-only \
    --tmpfs /tmp \
    --user 65534:65534 \
    -e HOME=/tmp \
    -e REDOCLY_TELEMETRY=off \
    -e REDOCLY_SUPPRESS_UPDATE_NOTICE=true \
    -v "$mount_dir:/spec:ro" \
    "${options[@]}" \
    "$IMAGE" "$@"
}
