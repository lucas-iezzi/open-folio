#!/bin/bash
cd "$(dirname "$0")"

if ! command -v node &>/dev/null; then
  echo ""
  echo "  Node.js is not installed."
  echo ""

  if command -v brew &>/dev/null; then
    echo "  Installing Node.js via Homebrew..."
    brew install node
  else
    echo "  Installing Homebrew (this may take a few minutes)..."
    echo "  You may be prompted for your Mac password."
    echo ""
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"; fi
    if command -v brew &>/dev/null; then brew install node; fi
  fi

  if ! command -v node &>/dev/null; then
    echo ""
    echo "  Could not install Node.js automatically."
    echo "  Download it from: https://nodejs.org"
    open "https://nodejs.org/en/download" 2>/dev/null || true
    read -rp "  Press Enter to exit..."; exit 1
  fi
fi

if [ ! -d "node_modules/express" ]; then
  echo ""
  echo "  Installing dependencies (first run only — takes about 30 seconds)..."
  echo ""
  npm install --no-fund --no-audit
  if [ $? -ne 0 ]; then
    echo ""
    echo "  npm install failed. Check the output above."
    read -rp "  Press Enter to exit..."; exit 1
  fi
fi

node scripts/start.js
if [ $? -ne 0 ]; then
  read -rp "  Press Enter to exit..."
fi
