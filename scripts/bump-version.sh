#!/bin/sh
# Bump the cache-busting ?v= on the page and on every module import, so browsers never
# mix a new page with old cached scripts (GitHub Pages lets them cache for ~10 minutes).
# Usage: sh scripts/bump-version.sh        (run before committing changes to css/ or js/)
set -e
cd "$(dirname "$0")/.."
V=$(( $(grep -o 'app\.js?v=[0-9]*' index.html | head -1 | cut -d= -f2) + 1 ))
sed -i -E "s/\?v=[0-9]+/?v=$V/g" index.html
for f in js/*.js; do
  # from "./x.js" / import("./x.js") → add or update ?v=
  sed -i -E "s#(from \"\./[a-z0-9-]+\.js)(\?v=[0-9]+)?\"#\1?v=$V\"#g; s#(import\(\"\./[a-z0-9-]+\.js)(\?v=[0-9]+)?\"#\1?v=$V\"#g" "$f"
done
echo "version $V"
