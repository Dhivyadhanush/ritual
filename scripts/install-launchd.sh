#!/usr/bin/env bash
# Install / refresh the launchd service for this app.
#   ./scripts/install-launchd.sh
#   HOST=127.0.0.1 PORT=4322 ./scripts/install-launchd.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
LABEL="com.ritual.health"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-4322}"
DATA_DIR="${DATA_DIR:-$ROOT/data}"
WEATHER_STATE_FILE="${WEATHER_STATE_FILE:-$HOME/weather-ntfy/data/state.json}"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>$PORT</string>
    <key>HOST</key><string>$HOST</string>
    <key>DATA_DIR</key><string>$DATA_DIR</string>
    <key>WEATHER_STATE_FILE</key><string>$WEATHER_STATE_FILE</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/ritual.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/ritual.err.log</string>
</dict>
</plist>
PLISTEOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true

# launchd occasionally needs a moment to release the old job.
for _ in $(seq 1 20); do
  pgrep -f "$ROOT/server.js" >/dev/null || break
  sleep 0.2
done

ok=0
for _ in $(seq 1 5); do
  sleep 0.4
  if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then ok=1; break; fi
done
if [ "$ok" -ne 1 ]; then
  echo "bootstrap failed; trying launchctl load" >&2
  launchctl load -w "$PLIST"
fi
launchctl enable "gui/$(id -u)/$LABEL"
sleep 1

echo "installed $LABEL -> http://127.0.0.1:$PORT"
launchctl print "gui/$(id -u)/$LABEL" | grep -E 'state =|pid =' | head -3
