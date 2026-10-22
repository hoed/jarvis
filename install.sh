#!/usr/bin/env bash
# Run from the root of the jarvis project:
#   bash install.sh
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="${1:-$(pwd)}"
SCENE="$PROJECT/src/scene"

echo "== copying scene files into $SCENE =="
cp "$SCRIPT_DIR/ReactorCore.tsx"     "$SCENE/ReactorCore.tsx"
cp "$SCRIPT_DIR/InstrumentRings.tsx" "$SCENE/InstrumentRings.tsx"
cp "$SCRIPT_DIR/OuterRings.tsx"      "$SCENE/OuterRings.tsx"
cp "$SCRIPT_DIR/Scene.tsx"           "$SCENE/Scene.tsx"

# Remove the old neural/halo files that are no longer imported
for f in NeuralCore.tsx NeuralNet.tsx NeuralHalo.tsx; do
  [ -f "$SCENE/$f" ] && { rm "$SCENE/$f"; echo "  removed $f"; } || true
done

echo "== checking VITE_USE_ELEVENLABS in .env.local =="
ENV="$PROJECT/.env.local"
if grep -q '^VITE_USE_ELEVENLABS=' "$ENV" 2>/dev/null; then
  # Make sure it's true
  sed -i 's/^VITE_USE_ELEVENLABS=.*/VITE_USE_ELEVENLABS=true/' "$ENV"
  echo "  already present — set to true"
else
  echo "" >> "$ENV"
  echo "# Tell the browser to use ElevenLabs via the bridge proxy" >> "$ENV"
  echo "VITE_USE_ELEVENLABS=true" >> "$ENV"
  echo "  added VITE_USE_ELEVENLABS=true"
fi

echo ""
echo "== type-check =="
cd "$PROJECT" && npx tsc --noEmit 2>&1 | head -30

echo ""
echo "All done. Run:  npm start"
