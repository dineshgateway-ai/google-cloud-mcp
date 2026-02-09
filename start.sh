#!/bin/bash

PORT=3000
DEBUG_PORT=9229
LISTEN_HOST="0.0.0.0"
NODE_CMD="node dist/index.js --transport=sse"
DEV_CMD="pnpm dev"
DEBUG_MODE=false
DEV_MODE=false

for i in "$@"; do
  case $i in
    --debug)
      DEBUG_MODE=true
      shift # past argument
      ;;
    --dev)
      DEV_MODE=true
      shift # past argument
      ;;
    *)
      # unknown option
      ;;
  esac
done

if $DEBUG_MODE; then
  node --inspect=$LISTEN_HOST:$DEBUG_PORT dist/index.js --transport=sse
elif $DEV_MODE; then
  pnpm dev
else
  $NODE_CMD
fi
