#!/usr/bin/env bash
#
# Local regression tests for r2-webdav.
#
# Two areas are covered:
#
#   1. Implicit R2 collections (sections 1-11). An implicit collection is a
#      directory that exists only as a key prefix: for example
#      `photos/deep.txt` written straight into R2 by the dashboard, the S3 API
#      or `wrangler r2 object put`. No marker object was ever created for
#      `photos/`, yet RFC 4918 §5.2 requires that collection to exist.
#      See docs/2026-10-06-implicit-collection-plan.md.
#
#   2. DAV:displayname derivation (section 12), see docs/CHANGES-20261006.md.
#
# litmus never creates these layouts (it always uses MKCOL, and it never sets a
# Content-Disposition header), so these cases need their own suite.
#
# Usage:
#   bash tests/implicit-collections.sh
#   DAV_URL=http://172.23.96.1:8787 bash tests/implicit-collections.sh
#
# If DAV_URL is unreachable the script starts `wrangler dev` itself and stops it
# again on exit. If it is already reachable (for example `npm run dev` is
# running locally, or CI already started a server) the existing one is reused.
#
# Environment:
#   DAV_URL        default http://127.0.0.1:8787
#   TEST_USERNAME  default test
#   TEST_PASSWORD  default test
#   WRANGLER_BIN   default npx wrangler
#   PERSIST_TO     optional, passed through to wrangler as --persist-to
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

DAV_URL="${DAV_URL:-http://127.0.0.1:8787}"
TEST_USERNAME="${TEST_USERNAME:-test}"
TEST_PASSWORD="${TEST_PASSWORD:-test}"
WRANGLER_BIN="${WRANGLER_BIN:-npx wrangler}"
PERSIST_TO="${PERSIST_TO:-}"
PREFIX="_regress"
ROOTFILE="_regress-root.txt"
BUCKET="$(sed -n 's/^bucket_name[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' wrangler.toml | head -1)"
BUCKET="${BUCKET:-mydav}"

PASS=0
FAIL=0
WORKDIR="$(mktemp -d)"
WRANGLER_PID=""

cleanup() {
	curl -sS -u "$TEST_USERNAME:$TEST_PASSWORD" -o /dev/null -X DELETE "$DAV_URL/$PREFIX/" 2>/dev/null
	curl -sS -u "$TEST_USERNAME:$TEST_PASSWORD" -o /dev/null -X DELETE "$DAV_URL/$ROOTFILE" 2>/dev/null
	rm -rf "$WORKDIR"
	if [[ -n "$WRANGLER_PID" ]]; then
		kill "$WRANGLER_PID" 2>/dev/null
	fi
}
trap cleanup EXIT

ok() {
	PASS=$((PASS + 1))
	printf '  pass  %s\n' "$1"
}

no() {
	FAIL=$((FAIL + 1))
	printf '  FAIL  %s\n' "$1"
	[[ -n "${2:-}" ]] && printf '        %s\n' "$2"
}

check() {
	local label="$1" actual="$2" expected="$3"
	if [[ "$actual" == "$expected" ]]; then
		ok "$label"
	else
		no "$label" "expected [$expected], got [$actual]"
	fi
}

check_contains() {
	local label="$1" haystack="$2" needle="$3"
	if [[ "$haystack" == *"$needle"* ]]; then
		ok "$label"
	else
		no "$label" "expected to contain [$needle]"
	fi
}

check_absent() {
	local label="$1" haystack="$2" needle="$3"
	if [[ "$haystack" != *"$needle"* ]]; then
		ok "$label"
	else
		no "$label" "expected NOT to contain [$needle]"
	fi
}

# --- helpers -----------------------------------------------------------------

wrangler_r2() {
	if [[ -n "$PERSIST_TO" ]]; then
		$WRANGLER_BIN r2 "$@" --persist-to "$PERSIST_TO" >/dev/null 2>&1
	else
		$WRANGLER_BIN r2 "$@" >/dev/null 2>&1
	fi
}

# Writes an object straight into R2, bypassing WebDAV: this is the whole point
# of the suite, MKCOL must NOT be involved.
put_direct() {
	local key="$1" file="$2" content_disposition="${3:-}"
	if [[ -n "$content_disposition" ]]; then
		wrangler_r2 object put "$BUCKET/$key" --file="$file" --content-disposition "$content_disposition" --local
	else
		wrangler_r2 object put "$BUCKET/$key" --file="$file" --local
	fi
}

dav() {
	local method="$1" path="$2"
	shift 2
	curl -sS -u "$TEST_USERNAME:$TEST_PASSWORD" -X "$method" \
		-H 'Content-Type: application/xml' \
		--data '<propfind xmlns="DAV:"><prop><resourcetype/><getcontentlength/></prop></propfind>' \
		"$@" "$DAV_URL$path"
}

dav_status() {
	local method="$1" path="$2"
	shift 2
	curl -sS -o /dev/null -w '%{http_code}' -u "$TEST_USERNAME:$TEST_PASSWORD" -X "$method" "$@" "$DAV_URL$path"
}

hrefs() {
	printf '%s' "$1" | grep -o '<href>[^<]*</href>' | sed 's|<href>||; s|</href>||'
}

# Raw PROPFIND response asking only for DAV:displayname.
displayname_response() {
	curl -sS -u "$TEST_USERNAME:$TEST_PASSWORD" -X PROPFIND \
		-H 'Depth: 0' -H 'Content-Type: application/xml' \
		--data '<propfind xmlns="DAV:"><prop><displayname/></prop></propfind>' \
		"$DAV_URL$1"
}

# Value of DAV:displayname, empty when the server reports it as 404.
displayname() {
	displayname_response "$1" | sed -n 's/^[[:space:]]*<displayname>\(.*\)<\/displayname>[[:space:]]*$/\1/p'
}

# --- start a server if needed ------------------------------------------------

if ! curl -fsS -u "$TEST_USERNAME:$TEST_PASSWORD" -o /dev/null --max-time 5 "$DAV_URL/"; then
	echo "no server at $DAV_URL, starting 'wrangler dev' ..."
	$WRANGLER_BIN dev --port "$(printf '%s' "$DAV_URL" | sed 's|.*:||; s|/.*||')" >"$WORKDIR/wrangler.log" 2>&1 &
	WRANGLER_PID=$!
	for _ in $(seq 1 60); do
		curl -fsS -u "$TEST_USERNAME:$TEST_PASSWORD" -o /dev/null --max-time 3 "$DAV_URL/" && break
		sleep 1
	done
	if ! curl -fsS -u "$TEST_USERNAME:$TEST_PASSWORD" -o /dev/null --max-time 3 "$DAV_URL/"; then
		echo "FATAL: server did not become ready"
		cat "$WORKDIR/wrangler.log"
		exit 1
	fi
fi

echo "target: $DAV_URL  bucket: $BUCKET  prefix: /$PREFIX/"

# --- 0. clean slate ----------------------------------------------------------

curl -sS -u "$TEST_USERNAME:$TEST_PASSWORD" -o /dev/null -X DELETE "$DAV_URL/$PREFIX/" 2>/dev/null
curl -sS -u "$TEST_USERNAME:$TEST_PASSWORD" -o /dev/null -X DELETE "$DAV_URL/$ROOTFILE" 2>/dev/null

printf 'plain\n' >"$WORKDIR/file.txt"

# --- 1. root level objects ---------------------------------------------------

put_direct "$ROOTFILE" "$WORKDIR/file.txt"
check_contains "1a. bucket root object is listed" \
	"$(hrefs "$(dav PROPFIND / -H 'Depth: 1')")" "/$ROOTFILE"

put_direct "$PREFIX/root.txt" "$WORKDIR/file.txt"
root_listing="$(hrefs "$(dav PROPFIND / -H 'Depth: 1')")"
check_contains "1b. implicit collection /$PREFIX/ appears at bucket root" "$root_listing" "/$PREFIX/"
check_contains "1c. direct object inside a collection is listed" \
	"$(hrefs "$(dav PROPFIND "/$PREFIX/" -H 'Depth: 1')")" "/$PREFIX/root.txt"

# --- 2/3/4. implicit collection ---------------------------------------------

put_direct "$PREFIX/photos/deep.txt" "$WORKDIR/file.txt"
check_contains "2. implicit collection appears in its parent" \
	"$(hrefs "$(dav PROPFIND "/$PREFIX/" -H 'Depth: 1')")" "/$PREFIX/photos/"

photos_listing="$(dav PROPFIND "/$PREFIX/photos/" -H 'Depth: 1')"
check "3a. PROPFIND on implicit collection returns 207" \
	"$(dav_status PROPFIND "/$PREFIX/photos/" -H 'Depth: 1')" "207"
check_contains "3b. implicit collection lists its member" "$(hrefs "$photos_listing")" "/$PREFIX/photos/deep.txt"
check_contains "3c. implicit collection reports resourcetype collection" "$photos_listing" "<collection />"

check_contains "4. GET on implicit collection returns an HTML listing" \
	"$(curl -sS -u "$TEST_USERNAME:$TEST_PASSWORD" "$DAV_URL/$PREFIX/photos/")" 'href="/_regress/photos/deep.txt"'

# --- 5. nested implicit collections -----------------------------------------

put_direct "$PREFIX/a/b/c/deep.txt" "$WORKDIR/file.txt"
check_contains "5a. first implicit level is listed" \
	"$(hrefs "$(dav PROPFIND "/$PREFIX/" -H 'Depth: 1')")" "/$PREFIX/a/"
check_contains "5b. second implicit level is listed" \
	"$(hrefs "$(dav PROPFIND "/$PREFIX/a/" -H 'Depth: 1')")" "/$PREFIX/a/b/"
check_contains "5c. third implicit level is listed" \
	"$(hrefs "$(dav PROPFIND "/$PREFIX/a/b/" -H 'Depth: 1')")" "/$PREFIX/a/b/c/"

# --- 6. explicit + implicit with the same name must not duplicate ------------

put_direct "$PREFIX/mix/x.txt" "$WORKDIR/file.txt"
dav_status MKCOL "/$PREFIX/mix/" >/dev/null
mix_occurrences="$(hrefs "$(dav PROPFIND "/$PREFIX/" -H 'Depth: 1')" | grep -c "^/$PREFIX/mix/$")"
check "6a. collection present twice in R2 is reported once" "$mix_occurrences" "1"
check_contains "6b. its member is still reachable" \
	"$(hrefs "$(dav PROPFIND "/$PREFIX/mix/" -H 'Depth: 1')")" "/$PREFIX/mix/x.txt"

# --- 7. explicit empty collection does not regress ---------------------------

check "7a. MKCOL of an empty collection succeeds" "$(dav_status MKCOL "/$PREFIX/empty/")" "201"
check_contains "7b. explicit empty collection is listed" \
	"$(hrefs "$(dav PROPFIND "/$PREFIX/" -H 'Depth: 1')")" "/$PREFIX/empty/"

# --- 8. implicit collection can be deleted ----------------------------------

check "8a. DELETE of an implicit collection succeeds" "$(dav_status DELETE "/$PREFIX/photos/")" "204"
check "8b. it is gone afterwards" "$(dav_status PROPFIND "/$PREFIX/photos/" -H 'Depth: 1')" "404"
check "8c. its member is gone as well" "$(dav_status GET "/$PREFIX/photos/deep.txt")" "404"

# --- 9. MOVE / COPY of an implicit collection -------------------------------

check "9a. MOVE of an implicit collection succeeds" \
	"$(dav_status MOVE "/$PREFIX/mix/" -H "Destination: $DAV_URL/$PREFIX/mix-moved/" -H 'Depth: infinity')" "201"
check_contains "9b. MOVE result lists the member" \
	"$(hrefs "$(dav PROPFIND "/$PREFIX/mix-moved/" -H 'Depth: 1')")" "/$PREFIX/mix-moved/x.txt"
check "9c. MOVE removed the source" "$(dav_status PROPFIND "/$PREFIX/mix/" -H 'Depth: 1')" "404"

check "9d. COPY of an implicit collection succeeds" \
	"$(dav_status COPY "/$PREFIX/a/" -H "Destination: $DAV_URL/$PREFIX/a-copy/" -H 'Depth: infinity')" "201"
check_contains "9e. COPY result lists the member" \
	"$(hrefs "$(dav PROPFIND "/$PREFIX/a-copy/" -H 'Depth: 1')")" "/$PREFIX/a-copy/b/"
check_contains "9f. COPY result keeps the original" \
	"$(hrefs "$(dav PROPFIND "/$PREFIX/a/" -H 'Depth: 1')")" "/$PREFIX/a/b/"
check_contains "9g. COPY into an implicit parent succeeds" \
	"$(dav_status COPY "/$PREFIX/root.txt" -H "Destination: $DAV_URL/$PREFIX/a/root-copy.txt")" "201"

# --- 10. no duplicate href in any listing ------------------------------------

for path in "/" "/$PREFIX/" "/$PREFIX/a/"; do
	dupes="$(hrefs "$(dav PROPFIND "$path" -H 'Depth: 1')" | sort | uniq -d)"
	check "10. no duplicate href in PROPFIND $path" "$dupes" ""
done

# --- 11. a plain object wins over a same-named implicit collection -----------

put_direct "$PREFIX/clash" "$WORKDIR/file.txt"
put_direct "$PREFIX/clash/inner.txt" "$WORKDIR/file.txt"
clash_listing="$(hrefs "$(dav PROPFIND "/$PREFIX/" -H 'Depth: 1')")"
check "11a. the plain object is reported once" "$(printf '%s\n' "$clash_listing" | grep -c "^/$PREFIX/clash$")" "1"
check_absent "11b. no same-named collection is reported" "$clash_listing" "/$PREFIX/clash/"

# --- 12. DAV:displayname ------------------------------------------------------

put_direct "$PREFIX/plain-name.txt" "$WORKDIR/file.txt"
check "12a. object without Content-Disposition is named by its key" \
	"$(displayname "/$PREFIX/plain-name.txt")" "plain-name.txt"

put_direct "$PREFIX/opaque-hash" "$WORKDIR/file.txt" 'attachment; filename="report 2026.pdf"'
quoted_name="$(displayname "/$PREFIX/opaque-hash")"
check "12b. quoted filename is extracted from Content-Disposition" "$quoted_name" "report 2026.pdf"
check_absent "12c. the raw Content-Disposition value is never exposed" \
	"$(displayname_response "/$PREFIX/opaque-hash")" "attachment"

put_direct "$PREFIX/bare-token-hash" "$WORKDIR/file.txt" 'inline; filename=bare-token.txt'
check "12d. bare token filename is extracted" "$(displayname "/$PREFIX/bare-token-hash")" "bare-token.txt"

put_direct "$PREFIX/no-filename-hash" "$WORKDIR/file.txt" 'attachment'
check "12e. header without a filename parameter falls back to the key" \
	"$(displayname "/$PREFIX/no-filename-hash")" "no-filename-hash"

dav_status MKCOL "/$PREFIX/named-dir/" >/dev/null
check "12f. explicit collection is named after the key" \
	"$(displayname "/$PREFIX/named-dir/")" "named-dir"

put_direct "$PREFIX/named-implicit/inner.txt" "$WORKDIR/file.txt"
check "12g. implicit collection is named after the key" \
	"$(displayname "/$PREFIX/named-implicit/")" "named-implicit"

check_absent "12h. the root collection still reports no displayname" \
	"$(displayname_response '/')" "<displayname>"

# --- summary -----------------------------------------------------------------

echo
echo "$PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
