#!/bin/sh
set -eu

RUNTIME_CONFIG_OUTPUT=/usr/share/nginx/html/runtime-config.js \
  /app/scripts/render-runtime-config.sh

exec nginx -g 'daemon off;'
