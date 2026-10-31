#!/usr/bin/env bash
#
# injoy - free local AI, on the host, forever.
#
#   sudo bash deploy/ollama.sh
#
# Installs Ollama, pulls the largest Qwen coder model the host can hold, and
# points the injoy service at it over 127.0.0.1. No API key, no per-token bill,
# nothing leaves the machine.
#
# Size table (includes the KV cache at 8k context):
#   qwen2.5-coder:7b     ~5.0 GB    the good one; 16 GB RAM and up
#   qwen2.5-coder:3b     ~2.3 GB    6 GB and up
#   qwen2.5-coder:1.5b   ~1.2 GB    below that; slow on one core, but it runs
#
# Environment:
#   AI_MODEL=  force a model instead of sizing to RAM
#
# Safe to re-run: it skips the install, reuses a pulled model, and rewrites both
# drop-ins.
set -euo pipefail

APP_SERVICE=injoy
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_DROPIN=/etc/systemd/system/ollama.service.d/injoy.conf
APP_DROPIN_DIR=/etc/systemd/system/$APP_SERVICE.service.d
APP_DROPIN=$APP_DROPIN_DIR/ai.conf

if [ "$(id -u)" -ne 0 ]; then
  echo "run me with sudo" >&2
  exit 1
fi

echo "== ollama =="
if ! command -v ollama >/dev/null 2>&1; then
  curl -fsSL https://ollama.com/install.sh | sh
else
  echo "   already installed: $(ollama --version 2>/dev/null | head -n 1)"
fi

# Keep the weights resident. On a dedicated box an unloaded model just adds
# forty seconds to the next message for no saved RAM that anything else uses.
install -d -m 0755 "$(dirname "$OLLAMA_DROPIN")"
cat > "$OLLAMA_DROPIN" <<'EOF'
# Written by deploy/ollama.sh - keep the model warm, one request at a time.
[Service]
Environment=OLLAMA_KEEP_ALIVE=-1
Environment=OLLAMA_NUM_PARALLEL=1
EOF

systemctl daemon-reload
systemctl enable ollama >/dev/null 2>&1 || true
systemctl restart ollama

ok=0
for _ in $(seq 1 60); do
  if curl -fsS "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [ "$ok" -ne 1 ]; then
  echo "ollama did not start - journalctl -u ollama -n 60" >&2
  exit 1
fi

echo "== model =="
RAM_KB="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
RAM_GB=$(( ${RAM_KB:-0} / 1024 / 1024 ))
if [ -n "${AI_MODEL:-}" ]; then
  MODEL="$AI_MODEL"
elif [ "$RAM_GB" -ge 16 ]; then
  MODEL=qwen2.5-coder:7b
elif [ "$RAM_GB" -ge 6 ]; then
  MODEL=qwen2.5-coder:3b
else
  MODEL=qwen2.5-coder:1.5b
fi
echo "   host ram ${RAM_GB}GB -> $MODEL"

PULLED="$(ollama list 2>/dev/null | awk 'NR > 1 {print $1}')" || true
if printf '%s\n' "$PULLED" | grep -Fxq "$MODEL"; then
  echo "   already pulled"
else
  ollama pull "$MODEL"
fi

echo "== wire injoy to it =="
install -d -m 0755 "$APP_DROPIN_DIR"
cat > "$APP_DROPIN" <<EOF
# Written by deploy/ollama.sh - free local model, no cloud key.
[Service]
Environment=AI_API_KEY=ollama
Environment=AI_BASE_URL=$OLLAMA_URL/v1
Environment=AI_MODEL=$MODEL
EOF

systemctl daemon-reload
systemctl restart "$APP_SERVICE"

echo "== warm the model =="
# Load the weights now so the first admin message is fast.
curl -fsS -m 600 "$OLLAMA_URL/v1/chat/completions" \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer ollama' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with one word: ready\"}]}" \
  >/dev/null || echo "   warm-up skipped"

echo ""
echo "  free local AI is live: $MODEL"
echo "  admin -> AI settings should show source: env"
echo "  logs   journalctl -u ollama -f"
