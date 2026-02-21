#!/bin/bash
# launch_browser.sh - Launch Chrome with remote debugging enabled
# Required for chatgpt.js to connect via Chrome DevTools Protocol

set -euo pipefail

PORT=9222
PROFILE_DIR="$HOME/.chrome-debug-profile"

# Kill any existing Chrome instances
echo "Killing existing Chrome processes..."
pkill -9 -f chrome 2>/dev/null || true
sleep 2

# Ensure profile directory exists
mkdir -p "$PROFILE_DIR"

# Launch Chrome with remote debugging
echo "Launching Chrome with remote debugging on port $PORT..."
/opt/google/chrome/chrome \
  --user-data-dir="$PROFILE_DIR" \
  --remote-debugging-port="$PORT" \
  --no-first-run \
  --no-default-browser-check &

# Wait for the debug port to become available
echo "Waiting for debug port..."
for i in $(seq 1 10); do
  if curl -s "http://localhost:$PORT/json/version" | grep -q "Browser"; then
    echo "Chrome is ready. Debug port $PORT is active."
    curl -s "http://localhost:$PORT/json/version"
    echo ""
    echo "Open https://chatgpt.com and then run: node chatgpt.js \"Your question\""
    exit 0
  fi
  sleep 1
done

echo "Warning: Chrome started but debug port not responding yet. Check manually:"
echo "  curl -s http://localhost:$PORT/json/version"
