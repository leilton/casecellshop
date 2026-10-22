---
name: git-flow
description: Run the project's Git flow — start/finish a feature, cut a release (version bump, CHANGELOG, tag) or a hotfix. Use when the user asks to start work, open a PR, release or hotfix.
---

# Git flow

Branches: `main` (tagged releases), `develop` (integration), `feature/*`, `release/*`, `hotfix/*`.
Never commit on `main`/`develop`. Ask the user before any push, merge into `main`, or tag.

## Start a feature

```bash
git switch develop && git pull --ff-only
git switch -c feature/<scope>-<short-desc>
```

## Finish a feature

1. `npm run check && npm test`.
2. Add an entry under `## [Unreleased]` in `CHANGELOG.md`.
3. `git fetch && git rebase origin/develop`.
4. Push the branch and open a PR to `develop` (squash merge). Title in Conventional Commits format.

## Release

1. Decide the version with SemVer from the commits since the last tag (`feat` → minor, `fix` → patch, `!` → major).
2. `git switch develop && git switch -c release/<x.y.z>`.
3. `npm version <x.y.z> --no-git-tag-version`; move `Unreleased` items in `CHANGELOG.md` under
   `## [<x.y.z>] - <YYYY-MM-DD>`; update `service.version` in `docker-compose.yml` and `info.version` in
   `docs/openapi.yaml`.
4. Commit `chore(release): <x.y.z>`.
5. After user approval:

   ```bash
   git switch main && git merge --no-ff release/<x.y.z>
   git tag -a v<x.y.z> -m "v<x.y.z>"
   git switch develop && git merge --no-ff release/<x.y.z>
   ALLOW_PROTECTED_PUSH=1 git push origin main develop --follow-tags
   git branch -d release/<x.y.z>
   ```

## Hotfix

1. `git switch main && git switch -c hotfix/<desc>`; fix + test; commit `fix(<scope>): ...`.
2. Bump patch version and CHANGELOG as in Release step 3.
3. Merge into `main` (tag) and `develop` exactly as Release step 5.
