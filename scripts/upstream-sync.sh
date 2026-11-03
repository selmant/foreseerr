#!/usr/bin/env bash
# Track upstream Seerr (seerr-team/seerr) now that Foreseerr can't merge it.
#
#   scripts/upstream-sync.sh report        Markdown list of the upstream commits
#                                          not reviewed yet, by what to do
#                                          with them, plus Seerr API changes.
#   scripts/upstream-sync.sh bump <sha>    Mark everything through <sha> as
#                                          reviewed: pin its seerr-api.yml and
#                                          fix the x-foreseerr markers.
#
# Reads the upstream history from the ref in $UPSTREAM_REF (default
# upstream/develop), so fetch it first:
#   git remote add upstream https://github.com/seerr-team/seerr.git
#   git fetch upstream develop
#
# `report` runs oasdiff through Docker unless $OASDIFF names a binary.
# See upstream/README.md for the process.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

UPSTREAM_REF=${UPSTREAM_REF:-upstream/develop}
UPSTREAM_URL=https://github.com/seerr-team/seerr
OASDIFF_IMAGE=tufin/oasdiff:v1.11.7@sha256:d6f1e645251cc1da527311955347d8ce8bd2b7ed09bcce07176b2577b8daf19c
SYNC=upstream/sync.json

reviewed() {
  sed -n 's/.*"reviewedThrough": *"\([0-9a-f]*\)".*/\1/p' "$SYNC"
}

# oasdiff <subcommand> <base> <revision> [flags]: files under $PWD or $tmp.
oasdiff() {
  if [ -n "${OASDIFF:-}" ]; then
    "$OASDIFF" "$@"
  else
    docker run --rm -v "$PWD:$PWD:ro" -v "$tmp:$tmp:ro" -w "$PWD" \
      "$OASDIFF_IMAGE" "$@"
  fi
}

line() {
  local sha=$1 subject=$2
  # shellcheck disable=SC2016 # literal backticks: Markdown code
  printf -- '- [ ] [`%s`](%s/commit/%s) %s\n' "${sha:0:9}" "$UPSTREAM_URL" "$sha" "$subject"
}

report() {
  local base head
  base=$(reviewed)
  head=$(git rev-parse "$UPSTREAM_REF")
  if [ "$base" = "$head" ]; then
    echo "Foreseerr has reviewed upstream Seerr through \`${head:0:9}\`, its current head. Nothing to do."
    return
  fi
  if ! git merge-base --is-ancestor "$base" "$head"; then
    echo "::error::reviewed commit $base is not an ancestor of $UPSTREAM_REF" >&2
    exit 1
  fi

  local security='' backend='' frontend='' i18n='' other='' count=0
  local sha subject files
  while IFS=$'\t' read -r sha subject; do
    count=$((count + 1))
    files=$(git diff-tree --no-commit-id --name-only -r -m "$sha" | sort -u)
    entry=$(line "$sha" "$subject")
    # Advisory fixes land as "Merge commit from fork" (GitHub's private-fork
    # merge); port them first.
    if [[ $subject == "Merge commit from fork"* ]] ||
      grep -qiE '(security|GHSA-|CVE-)' <<<"$subject"; then
      security+="$entry"$'\n'
      continue
    fi
    local placed=''
    if grep -qE '^(server/|seerr-api\.yml$)' <<<"$files"; then
      backend+="$entry"$'\n'
      placed=1
    fi
    if grep -E '^src/' <<<"$files" | grep -qvE '^src/i18n/'; then
      frontend+="$entry"$'\n'
      placed=1
    fi
    if grep -qE '^src/i18n/' <<<"$files"; then
      i18n+="$entry"$'\n'
      placed=1
    fi
    [ -n "$placed" ] || other+="$entry"$'\n'
  done < <(git log --reverse --format=$'%H\t%s' "$base..$head")

  echo "Upstream Seerr has **$count** commit(s) Foreseerr hasn't reviewed: \`${base:0:9}..${head:0:9}\` ([compare]($UPSTREAM_URL/compare/$base...$head))."
  echo
  section() {
    [ -n "$2" ] || return 0
    printf '### %s\n\n%s\n%s\n' "$1" "$3" "$2"
  }
  section 'Security' "$security" 'Upstream advisory fixes. Check whether the Rust backend has the same flaw and port the fix first.'
  section 'Backend: port to Rust' "$backend" "Changes to upstream's Node \`server/\` or its API spec. Port the logic into \`backend-rs/\` where Foreseerr has the same code path."
  section 'Frontend: cherry-pick' "$frontend" "\`src/\` is still Seerr-derived; most fixes apply with \`git cherry-pick -x\` (only the \`src/\` part when the commit also touches \`server/\`)."
  section 'Translations' "$i18n" 'Bring over translation values for keys Foreseerr shares with the same English text.'
  section 'Other (usually skip)' "$other" 'CI, docs, charts, tooling.'

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' RETURN
  git show "$head:seerr-api.yml" >"$tmp/seerr-api.yml"
  echo '### Seerr API'
  echo
  if cmp -s "$tmp/seerr-api.yml" upstream/seerr-api.yml; then
    echo 'No changes to the Seerr API spec.'
  else
    echo 'Changes to the Seerr API since the pinned spec:'
    echo
    echo '```'
    oasdiff changelog upstream/seerr-api.yml "$tmp/seerr-api.yml" --format text
    echo '```'
    echo
    echo "Where the new Seerr API breaks Foreseerr's (each must be implemented, or accepted in \`upstream/accepted-breaking.txt\` with a reason):"
    echo
    echo '```'
    oasdiff breaking "$tmp/seerr-api.yml" seerr-api.yml \
      --err-ignore upstream/accepted-breaking.txt --format text
    echo '```'
  fi
  echo
  echo "When everything above is ported or skipped: \`scripts/upstream-sync.sh bump ${head:0:9}\` (see [upstream/README.md](https://github.com/selmant/foreseerr/blob/develop/upstream/README.md))."
}

bump() {
  local sha
  sha=$(git rev-parse --verify "${1:?usage: upstream-sync.sh bump <sha>}^{commit}")
  if ! git merge-base --is-ancestor "$(reviewed)" "$sha"; then
    echo "$sha does not descend from the reviewed commit $(reviewed)" >&2
    exit 1
  fi
  git show "$sha:seerr-api.yml" >upstream/seerr-api.yml
  sed -i "s/\"reviewedThrough\": *\"[0-9a-f]*\"/\"reviewedThrough\": \"$sha\"/" "$SYNC"
  bun scripts/check-seerr-api.ts --fix
  echo "Reviewed through ${sha:0:9}. Commit upstream/ and seerr-api.yml; CI runs the compatibility checks."
}

case "${1:-}" in
  report) report ;;
  bump) bump "${2:-}" ;;
  *)
    echo 'usage: scripts/upstream-sync.sh report | bump <sha>' >&2
    exit 2
    ;;
esac
