---
name: bump-and-release
description: Run this repository's GitHub Actions version bump and release flow with gh. Use when the user asks to bump the zcode-acp version by patch, minor, or major, merge the generated release PR, monitor the automatic Release workflow, and report the final GitHub Releases URL.
---

# Bump and Release

Automate the zcode-acp release flow through GitHub Actions:

1. Run `.github/workflows/version-bump.yml` (`Version Bump`) with `release_type=patch|minor|major`.
2. Wait for the generated `release/vX.Y.Z` PR.
3. Merge that PR.
4. Wait for `.github/workflows/release.yml` (`Release`) to finish.
5. Confirm the GitHub Release exists.
6. Pull `origin/main` into the local `main` branch with `git pull --ff-only`.
7. Report the GitHub Releases page URL for `vX.Y.Z`.

## Guardrails

- Require an explicit release type: `patch`, `minor`, or `major`. If it is missing or ambiguous, ask the user before triggering anything.
- Use `gh` for GitHub operations. Do not use web browsing or manual GitHub UI steps.
- Stop on failed workflows, failed checks, missing PRs, or missing releases. Report the run or PR URL that needs attention.
- Merge only the release PR created for the expected `release/vX.Y.Z` branch.
- After the release exists, sync the local `main` branch with `origin/main`. If the sync fails, report that the release succeeded and include the release URL.
- Do not manually create tags or releases unless the user explicitly asks for recovery work after a failure.

## Preferred Path

Run the bundled script from the repository root:

```bash
.codex/skills/bump-and-release/scripts/bump_and_release.sh patch
```

Replace `patch` with `minor` or `major` as requested. The script prints:

- the expected new version,
- the Version Bump workflow run URL,
- the generated PR URL,
- the Release workflow run URL,
- `LOCAL_MAIN_SYNCED=true` after the local `main` branch is fast-forwarded,
- `RELEASE_URL=<url>` when complete.

Relay the final release URL to the user.

## Manual Fallback

Use this only if the script cannot run and the user still wants to proceed.

```bash
gh auth status
gh workflow run version-bump.yml -f release_type=<patch|minor|major>
gh run list --workflow version-bump.yml --event workflow_dispatch --limit 10
gh run watch <bump-run-id> --exit-status --interval 10
gh pr list --state open --label release --json number,title,headRefName,url
gh pr merge <pr-number> --squash --delete-branch
gh run list --workflow release.yml --event pull_request --limit 10
gh run watch <release-run-id> --exit-status --interval 10
gh release view vX.Y.Z --json url --jq .url
git switch main
git pull --ff-only origin main
```

When using the fallback, compute or confirm `X.Y.Z` from the release PR title or branch before reporting the URL.
