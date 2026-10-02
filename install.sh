#!/bin/sh
# Install sensei: fetch the pinned pi host and link the `sensei` command globally.
set -eu
cd "$(dirname "$0")"
npm install --ignore-scripts
npm link
echo "sensei installed. Run: sensei"
