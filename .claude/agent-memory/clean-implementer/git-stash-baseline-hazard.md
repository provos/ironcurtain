# Git stash for baseline comparison: hazard

When comparing "does my edit introduce NEW errors vs baseline," do NOT use
`git stash push -- <files>` + `git stash pop` to swap to the committed
version, especially in a repo that already has OTHER stashes in the list.

What went wrong (real incident):
- Ran `git stash push -- <two docs>` where one doc was UNTRACKED (`??`).
  `git stash push -- <path>` silently skips untracked files unless `-u`, so
  only the tracked file got stashed.
- A later `git stash pop` hit a conflict, "kept" the stash, and the working
  tree ended up with an UNRELATED pre-existing stash (`stash@{0}`,
  someone else's "oauth-keychain-refresh") applied as `UU` merge conflicts
  in files I never touched (src/docker/*, src/session/preflight.ts). `tsc`
  then flooded TS1185 "Merge conflict marker encountered."

Recovery that worked (the unrelated stash was preserved in the list):
- `git checkout HEAD -- <the wrongly-conflicted files>` to restore them
  (they had NO uncommitted changes at session start — verify that first via
  the session-start `git status` snapshot).
- `git restore --staged <any wrongly-staged file>`.
- Confirm `grep -rln '^<<<<<<<|^>>>>>>>' src/ test/` returns NONE and
  `git stash list` still shows the unrelated stash intact.

Better approaches for baseline-error comparison (no stash):
- Run the analyzer against `git show HEAD:<file>` (copy to /tmp and edit /tmp).
- Or: `cp <file> /tmp/backup` before editing and `cp` back to test
  discrimination (this is what I used for source-file discrimination checks
  and it was clean).
- Always check `git stash list` BEFORE any stash op; if other stashes exist,
  avoid bare `git stash pop` (it pops the top, which may not be yours).

## BEST for whole-program tsc baselines: a throwaway HEAD worktree
`tsc -p tsconfig.eslint.json --noEmit --rootDir .` emits ~1760 PRE-EXISTING
errors in this repo, so "did I add errors?" is unanswerable by eyeballing.
Recipe (works even when ANOTHER agent is concurrently editing src/ — their
in-flight breakage shows up as clearly-attributed added lines):
```
git -C <repo> worktree add -f <scratch>/baseline HEAD
ln -s <repo>/node_modules <scratch>/baseline/node_modules   # required; no npm i
cd <scratch>/baseline && npx tsc -p tsconfig.eslint.json --noEmit --rootDir . \
  2>&1 | grep -Ev TS6059 > ../before.txt
# same command in the real repo -> after.txt, then: diff before.txt after.txt
git -C <repo> worktree remove --force <scratch>/baseline
```
Read the diff carefully: DELETING a line shifts every later error in that file
by one, so an unchanged pre-existing error legitimately appears as a
`file.ts(117,..)` -> `file.ts(116,..)` rewrite. That is not a new error.

## zsh gotcha in the Bash tool: unquoted `$VAR` does NOT word-split
The shell here is zsh, not bash. `FILES="a.ts b.ts"; npx eslint $FILES` passes
ONE argument (the whole string) and fails with "No files matching the pattern".
Use a zsh array instead — `files=(a.ts b.ts); npx eslint $files` — or `${=FILES}`.
