#!/bin/bash -eu

# setting up
yarn
rm -rf ./lib/*

# build .mjs
yarn tsc --module ESNext
for f in lib/*.js; do
  mv "$f" "${f%.js}.mjs"
done

# build .js
yarn tsc

cp package.json README.md ./lib/

cd ./lib
yarn pack
