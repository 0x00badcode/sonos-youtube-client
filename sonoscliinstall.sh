#!/bin/bash

# Sonos YouTube CLI - Installation Script

set -e

echo "🎵 Sonos YouTube CLI - Installation"
echo "===================================="
echo ""

# Check for Deno
if ! command -v deno &> /dev/null; then
    echo "❌ Deno is not installed."
    echo ""
    echo "Install Deno with:"
    echo "  curl -fsSL https://deno.land/install.sh | sh"
    echo "Or:"
    echo "  brew install deno  # macOS"
    echo ""
    exit 1
fi

# Fix PATH for macOS if needed
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# Check for dependencies
echo "Checking dependencies..."

MISSING_DEPS=""

# Check yt-dlp
if ! command -v yt-dlp &> /dev/null; then
    if [ ! -f "/opt/homebrew/bin/yt-dlp" ] && [ ! -f "/usr/local/bin/yt-dlp" ]; then
        MISSING_DEPS="$MISSING_DEPS yt-dlp"
    fi
fi

# Check ffmpeg
if ! command -v ffmpeg &> /dev/null; then
    if [ ! -f "/opt/homebrew/bin/ffmpeg" ] && [ ! -f "/usr/local/bin/ffmpeg" ]; then
        MISSING_DEPS="$MISSING_DEPS ffmpeg"
    fi
fi

if [ ! -z "$MISSING_DEPS" ]; then
    echo "❌ Missing dependencies:$MISSING_DEPS"
    echo ""
    echo "Install missing dependencies:"
    
    if [[ "$MISSING_DEPS" == *"yt-dlp"* ]]; then
        echo "  pip install yt-dlp"
        echo "  # or"
        echo "  brew install yt-dlp  # macOS"
    fi
    
    if [[ "$MISSING_DEPS" == *"ffmpeg"* ]]; then
        echo "  brew install ffmpeg  # macOS"
        echo "  apt install ffmpeg   # Ubuntu/Debian"
        echo "  dnf install ffmpeg   # Fedora"
    fi
    
    echo ""
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

echo "✅ Dependencies OK"
echo ""

# Compile
echo "Compiling Sonos CLI..."
echo "(Using --no-check to skip TypeScript checking)"

OUTPUT_NAME="${1:-sonos-cli}"
BIN_OUT="$OUTPUT_NAME"
if [[ "$(uname)" == "Darwin" ]]; then
    BIN_OUT="${OUTPUT_NAME}.tmpbin"
fi

deno compile \
    --no-npm \
    --unstable \
    --no-check \
    --allow-net \
    --allow-run \
    --allow-env \
    --allow-read \
    --allow-write \
    --allow-sys \
    -o "$BIN_OUT" \
    sonos-youtube-cli.ts

if [ $? -ne 0 ]; then
    echo "❌ Compilation failed"
    exit 1
fi

# macOS Local Network TCC needs a real .app + Info.plist or the prompt never appears.
if [[ "$(uname)" == "Darwin" ]]; then
    APP_DIR="${OUTPUT_NAME}.app"
    echo "Packaging $APP_DIR for macOS Local Network permission..."
    rm -rf "$APP_DIR"
    mkdir -p "$APP_DIR/Contents/MacOS"
    mv "$BIN_OUT" "$APP_DIR/Contents/MacOS/sonos-cli"
    chmod +x "$APP_DIR/Contents/MacOS/sonos-cli"
    cp "$(dirname "$0")/macos/Info.plist" "$APP_DIR/Contents/Info.plist"
    codesign --force --deep --sign - --identifier com.sonosyoutube.cli "$APP_DIR" >/dev/null
    cat > "$OUTPUT_NAME" << EOF
#!/bin/sh
ROOT="\$(cd "\$(dirname "\$0")" && pwd)"
exec "\$ROOT/${OUTPUT_NAME}.app/Contents/MacOS/sonos-cli" "\$@"
EOF
    chmod +x "$OUTPUT_NAME"
fi

echo ""
echo "✅ Installation complete!"
echo ""
echo "The executable '$OUTPUT_NAME' has been created."
if [[ "$(uname)" == "Darwin" ]]; then
    echo ""
    echo "⚠️  macOS Local Network: run this from Terminal.app (not Cursor) once,"
    echo "   then click Allow. Or enable Cursor in System Settings →"
    echo "   Privacy & Security → Local Network."
fi
echo ""
echo "To install system-wide (optional):"
echo "  sudo mv $OUTPUT_NAME /usr/local/bin/"
echo ""
echo "Usage:"
echo "  ./$OUTPUT_NAME         # Start interactive CLI"
echo "  ./$OUTPUT_NAME scan    # Scan for devices"
echo "  ./$OUTPUT_NAME help    # Show help"
echo ""
echo "🎯 Quick start:"
echo "  1. Run './$OUTPUT_NAME' to enter interactive mode"
echo "  2. Type 'scan' to find your Sonos"
echo "  3. Type 'set-default 1' to set default device"
echo "  4. Type 'play <youtube-url>' to play"
echo ""
echo "⚠️  If you have issues with ffmpeg/yt-dlp not found:"
echo "  Add this to your ~/.zshrc or ~/.bash_profile:"
echo '  export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"'