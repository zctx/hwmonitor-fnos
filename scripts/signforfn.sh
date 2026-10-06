#!/usr/bin/env bash
set -euo pipefail
# usage: signforfn.sh <dlkey> <url>

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <dlkey> <url>" >&2
  exit 1
fi

DLKEY="$1"
URL="$2"
DLKEY_PADDED="$DLKEY"
while (( ${#DLKEY_PADDED} % 4 != 0 )); do
  DLKEY_PADDED+="="
done
KEY=$(
  echo -n "$DLKEY_PADDED" |
  base64 -d 2>/dev/null |
  perl -pe 's/(.)/chr(ord($1)^0x5e)/seg'
)
PATH_PART=$(printf '%s\n' "$URL" | sed -E 's#^[a-zA-Z]+://[^/]+##')
T=$(date +%s)
SIGN=$(printf '%s' "${KEY}${PATH_PART}${T}" | md5sum | awk '{print $1}')
printf '%s?sign=%s&t=%s\n' "$URL" "$SIGN" "$T"
