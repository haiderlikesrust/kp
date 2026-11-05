#!/bin/sh
# Container entrypoint. exec makes Node PID 1, so it receives SIGTERM and can hand over cleanly.
set -e
node deploy/publish-web.mjs
exec node --import tsx server/index.ts
