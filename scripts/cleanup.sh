#!/usr/bin/env bash
# Remove Docker resources created for this project.
#
#   ./scripts/cleanup.sh              # containers + project images
#   ./scripts/cleanup.sh --volumes    # also remove project data volumes
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENVF="$ROOT/.env"
REMOVE_VOLUMES=false

for arg in "$@"; do
  case "$arg" in
    --volumes) REMOVE_VOLUMES=true ;;
    *)
      printf 'usage: %s [--volumes]\n' "$(basename "$0")" >&2
      exit 1
      ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  printf 'error: docker is not installed\n' >&2
  exit 1
fi

COMPOSE_ARGS=(--project-directory "$ROOT" --profile voice)
[[ -f "$ENVF" ]] && COMPOSE_ARGS+=(--env-file "$ENVF")

printf 'Cleaning Docker resources for project: interview\n'
printf '  containers: remove\n'
printf '  images:     remove\n'
if [[ "$REMOVE_VOLUMES" == true ]]; then
  printf '  volumes:    remove\n'
else
  printf '  volumes:    keep (use --volumes to remove them)\n'
fi

DOWN_ARGS=(down --remove-orphans --rmi all)
[[ "$REMOVE_VOLUMES" == true ]] && DOWN_ARGS+=(--volumes)

docker compose "${COMPOSE_ARGS[@]}" "${DOWN_ARGS[@]}"
