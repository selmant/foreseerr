# Upstream Seerr

Foreseerr started as a fork of [Seerr](https://github.com/seerr-team/seerr). Since v0.15.0 its backend is a Rust rewrite (`backend-rs/`), so upstream can no longer be merged. Two things are still kept in step with upstream:

1. **The Seerr API.** Foreseerr serves Seerr's `/api/v1` so existing clients keep working: same paths, methods, parameters, authentication (session cookie or `X-Api-Key`), status codes and response shapes. Foreseerr may add fields and operations, but it must not break an operation Seerr has.
2. **Upstream fixes.** Upstream backend fixes are ported into Rust by hand. Upstream frontend fixes are cherry-picked, because `src/` is still Seerr-derived.

## What's here

| File                      | What it is                                                                                                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seerr-api.yml`           | Upstream's spec, byte-for-byte, at the pinned commit. This is the Seerr contract. Don't edit it by hand.                                                                                                          |
| `sync.json`               | `reviewedThrough`: the last upstream commit whose changes have all been ported, cherry-picked or deliberately skipped.                                                                                            |
| `accepted-breaking.txt`   | Known, explained differences from the Seerr contract, in oasdiff's ignore format (`METHOD /path` plus the oasdiff message). Every line is a compatibility gap, so keep it short and remove lines once they're fixed. |

## What CI enforces

- **No breaking changes** (`Seerr API compatibility` workflow): `oasdiff breaking upstream/seerr-api.yml seerr-api.yml` fails on any breaking change or warning not listed in `accepted-breaking.txt`.
- **Extensions are marked** (same workflow, `bun scripts/check-seerr-api.ts`): every operation in `seerr-api.yml` that Seerr doesn't have carries `x-foreseerr: true`, and no Seerr operation does. Run it with `--fix` to add or remove the markers.
- **Everything documented is served** (`Rust backend` workflow, `routes::spec_coverage`): every operation in `seerr-api.yml` has a Rust handler, and every handler is documented. The one exception is listed in the test with its reason.

## Weekly sync

The `Upstream Seerr sync` workflow runs every Monday, and on demand from the Actions tab. It lists every upstream commit after `reviewedThrough`, sorted into security fixes, backend changes (port to Rust), frontend changes (cherry-pick), translations and other, together with any Seerr API changes. The list goes into a single open issue labelled `upstream-sync`.

You can produce the same report locally:

```sh
git remote add upstream https://github.com/seerr-team/seerr.git  # once
git fetch upstream develop
scripts/upstream-sync.sh report
```

To work through it:

1. **Security fixes first.** Upstream advisory fixes land as `Merge commit from fork`. Check whether the Rust code has the same flaw.
2. **Backend:** read the upstream diff and port the intent into `backend-rs/`, where Foreseerr has the same code path. Note "Ported from seerr-team/seerr#NNNN" in the commit message.
3. **Frontend:** `git cherry-pick -x <sha>`, or `git show <sha> -- src | git apply -3` when the commit also touches `server/`.
4. **API changes:** implement any new or changed Seerr operation in Rust and document it in `seerr-api.yml`.
5. Once everything is ported or deliberately skipped, run `scripts/upstream-sync.sh bump <sha>`. This pins upstream's spec at that commit, updates `sync.json` and fixes the `x-foreseerr` markers. Commit the result. If CI then reports a breaking change, implement the missing piece; add it to `accepted-breaking.txt` only if the difference is intended, and give the reason.

The weekly issue is regenerated from `sync.json`. Ticking its boxes doesn't change the list; bumping the reviewed commit does.
