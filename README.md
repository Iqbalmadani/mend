# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Iqbalmadani/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Iqbalmadani/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies the edits AI models write — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and text-editor tool calls as JSON — to a tree of files, exactly as `SPEC.md` in this repository specifies. It finds the lines an edit names even when the model drifted their whitespace or indentation (three-tier line matching, with re-indentation at the loosest tier), honours each file's own line breaks and final-newline state, and changes every file or none. Node 22, standard library only, deterministic. On the public practice set it passes 100 of 100 checks.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

The patch is read from the file named by `PATCH`, or from standard input when `PATCH` is absent or `-`. `--format` forces one format (`unified`, `search-replace`, `v4a`, `json`); the default `auto` detects it. `--check` reports what would change without writing; `--strict` matches lines exactly. See `SPEC.md` for the full contract: output lines, exit codes and failure codes.

## The files

- `main.ts` — the CLI itself: command line, output and exit codes, safe paths, format detection, all four format readers, three-tier line matching, and the all-or-nothing write. Its last lines hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts` — the trial runner, kept as the kit ships it.
- `check.ts` — runs the public practice set against `main.ts`.
- `SPEC.md` — the specification mend implements.
- `LICENSE` — MIT.

---
<sub>Entered on [make.fun](https://make.fun/?ref=83wdz4pp&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
