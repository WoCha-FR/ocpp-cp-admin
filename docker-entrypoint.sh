#!/bin/sh
set -eu

seed_missing_from_defaults() {
  target="$1"
  defaults="$2"

  mkdir -p "$target"

  [ -d "$defaults" ] || return 0

  # Copy only missing files/dirs so bind mounts keep user changes.
  find "$defaults" -mindepth 1 | while IFS= read -r src; do
    rel="${src#"$defaults"/}"
    dst="$target/$rel"

    if [ -d "$src" ]; then
      mkdir -p "$dst" 2>/dev/null || true
    elif [ -f "$src" ] && [ ! -e "$dst" ]; then
      mkdir -p "$(dirname "$dst")" 2>/dev/null || true
      cp "$src" "$dst" 2>/dev/null \
        || echo "[entrypoint] Warning: could not seed $rel — check the permissions of the mounted directory."
    fi
  done
}

seed_missing_from_defaults /app/config /opt/defaults/config
seed_missing_from_defaults /app/public/img /opt/defaults/public-img

# Create config.json from sample if it doesn't exist yet.
if [ ! -f /app/config/config.json ]; then
  if [ -f /app/config/config.sample.json ]; then
    cp /app/config/config.sample.json /app/config/config.json 2>/dev/null \
      && echo "[entrypoint] Created config/config.json from config.sample.json — edit it with your settings." \
      || echo "[entrypoint] Warning: could not create config.json — check the permissions of the mounted directory."
  fi
fi

exec "$@"