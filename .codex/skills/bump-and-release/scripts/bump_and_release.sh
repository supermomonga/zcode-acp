#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  bump_and_release.sh <patch|minor|major>

Runs the Version Bump workflow, merges the generated release PR, waits for
the Release workflow, syncs local main, and prints RELEASE_URL=<url>.
USAGE
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"
}

run_url() {
  gh run view "$1" --json url --jq '.url'
}

wait_for_run_id() {
  local workflow="$1"
  local event="$2"
  local since_iso="$3"
  local branch="${4:-}"
  local query
  query="[.[] | select(.createdAt >= $(json_escape "$since_iso")) | .databaseId][0] // \"\""

  for _ in $(seq 1 60); do
    local id
    if [[ -n "$branch" ]]; then
      id="$(gh run list \
        --workflow "$workflow" \
        --event "$event" \
        --branch "$branch" \
        --limit 30 \
        --json databaseId,createdAt \
        --jq "$query")"
    else
      id="$(gh run list \
        --workflow "$workflow" \
        --event "$event" \
        --limit 30 \
        --json databaseId,createdAt \
        --jq "$query")"
    fi
    if [[ -n "$id" ]]; then
      echo "$id"
      return 0
    fi
    sleep 5
  done
  return 1
}

next_version() {
  local version="$1"
  local release_type="$2"
  IFS=. read -r major minor patch <<<"$version"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ && "$patch" =~ ^[0-9]+$ ]] ||
    die "Could not parse current version: $version"

  case "$release_type" in
    patch) patch=$((patch + 1)) ;;
    minor) minor=$((minor + 1)); patch=0 ;;
    major) major=$((major + 1)); minor=0; patch=0 ;;
    *) die "release_type must be patch, minor, or major: $release_type" ;;
  esac

  printf '%s.%s.%s\n' "$major" "$minor" "$patch"
}

wait_for_pr() {
  local branch="$1"
  for _ in $(seq 1 60); do
    local pr_line
    pr_line="$(gh pr list \
      --state open \
      --head "$branch" \
      --json number,url \
      --jq '.[0] | select(.number != null) | "\(.number) \(.url)"')"
    if [[ -n "$pr_line" ]]; then
      echo "$pr_line"
      return 0
    fi
    sleep 5
  done
  return 1
}

wait_for_pr_merged() {
  local pr="$1"
  for _ in $(seq 1 120); do
    local merged_at
    merged_at="$(gh pr view "$pr" --json mergedAt --jq '.mergedAt // ""')"
    if [[ -n "$merged_at" ]]; then
      echo "$merged_at"
      return 0
    fi
    sleep 10
  done
  return 1
}

sync_local_main() {
  local branch="$1"
  local release_page="$2"
  local current_branch
  current_branch="$(git branch --show-current)"

  [[ "$current_branch" == "$branch" ]] ||
    die "Release succeeded (${release_page}) but local sync requires current branch ${branch}; current branch is ${current_branch:-detached HEAD}"

  echo "Syncing local ${branch} with origin/${branch}..."
  if ! git pull --ff-only origin "$branch"; then
    die "Release succeeded (${release_page}) but failed to sync local ${branch} with origin/${branch}"
  fi
}

main() {
  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
  fi

  local release_type="${1:-}"
  [[ "$release_type" =~ ^(patch|minor|major)$ ]] || {
    usage >&2
    die "release type is required and must be patch, minor, or major"
  }

  command -v gh >/dev/null 2>&1 || die "gh is not installed"
  command -v git >/dev/null 2>&1 || die "git is not installed"
  command -v python3 >/dev/null 2>&1 || die "python3 is required"
  command -v base64 >/dev/null 2>&1 || die "base64 is required"
  gh auth status >/dev/null

  local repo default_branch repo_url
  repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
  default_branch="$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')"
  repo_url="$(gh repo view --json url --jq '.url')"
  [[ "$default_branch" == "main" ]] || die "Expected default branch main, got $default_branch"

  local current_version
  current_version="$(
    gh api "repos/${repo}/contents/package.json?ref=main" --jq '.content' |
      base64 --decode |
      python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])'
  )"
  [[ "$current_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
    die "Could not read current version from main: $current_version"

  local version branch bump_started bump_run_id bump_url
  version="$(next_version "$current_version" "$release_type")"
  branch="release/v${version}"
  bump_started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  echo "Repository: $repo"
  echo "Current version: $current_version"
  echo "Expected new version: $version"
  echo "Triggering Version Bump workflow..."
  gh workflow run version-bump.yml -f "release_type=${release_type}"

  bump_run_id="$(wait_for_run_id version-bump.yml workflow_dispatch "$bump_started" main)"
  [[ -n "$bump_run_id" ]] || die "Could not find Version Bump workflow run after $bump_started"
  bump_url="$(run_url "$bump_run_id")"
  echo "Version Bump run: $bump_url"
  gh run watch "$bump_run_id" --exit-status --interval 10

  echo "Waiting for release PR on ${branch}..."
  local pr_line pr_number pr_url
  pr_line="$(wait_for_pr "$branch")"
  [[ -n "$pr_line" ]] || die "Could not find generated release PR for ${branch}. Version Bump run: ${bump_url}"
  pr_number="${pr_line%% *}"
  pr_url="${pr_line#* }"
  echo "Release PR: $pr_url"

  local pr_title pr_head pr_files
  pr_title="$(gh pr view "$pr_number" --json title --jq '.title')"
  pr_head="$(gh pr view "$pr_number" --json headRefName --jq '.headRefName')"
  [[ "$pr_title" == "Release v${version}" ]] || die "Unexpected PR title: $pr_title"
  [[ "$pr_head" == "$branch" ]] || die "Unexpected PR branch: $pr_head"

  pr_files="$(gh pr view "$pr_number" --json files --jq '[.files[].path] | sort | join("\n")')"
  [[ "$pr_files" == $'package.json\nsrc/version.ts' ]] ||
    die "Release PR changed unexpected files: ${pr_files//$'\n'/, }"

  echo "Merging release PR..."
  if ! gh pr merge "$pr_number" --squash --delete-branch; then
    echo "Immediate merge failed; enabling auto-merge and waiting for merge..."
    gh pr merge "$pr_number" --squash --delete-branch --auto
  fi

  local merged_at release_started release_run_id release_url release_page
  merged_at="$(wait_for_pr_merged "$pr_number")" ||
    die "PR did not merge in time: $pr_url"
  release_started="$merged_at"
  echo "PR merged at: $merged_at"
  echo "Waiting for Release workflow..."

  release_run_id="$(wait_for_run_id release.yml pull_request "$release_started")"
  [[ -n "$release_run_id" ]] || die "Could not find Release workflow run after PR merge: $pr_url"
  release_url="$(run_url "$release_run_id")"
  echo "Release run: $release_url"
  gh run watch "$release_run_id" --exit-status --interval 10

  release_page="$(gh release view "v${version}" --json url --jq '.url')"
  [[ -n "$release_page" ]] || die "Release workflow succeeded but release was not found: v${version}"

  echo "Release complete: $release_page"
  sync_local_main "$default_branch" "$release_page"
  echo "LOCAL_MAIN_SYNCED=true"
  echo "RELEASE_VERSION=v${version}"
  echo "RELEASE_URL=${release_page}"
  echo "REPOSITORY_URL=${repo_url}"
}

main "$@"
