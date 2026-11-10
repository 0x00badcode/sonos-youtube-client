# SonosTube

A small native Mac app: search YouTube or paste a link, and it plays on your Sonos.

- Search YouTube or paste/drop a link; the audio downloads once and plays on the speaker
- Library of everything you've played; double-click to replay
- Star tracks to keep them as favorites, and filter the list to favorites only
- Play/pause, seek and volume, plus a speaker picker (speakers are found automatically)
- Picks up whatever the speaker is doing when you relaunch

## Install

Download `SonosTube-1.0.zip` from the [latest release](https://github.com/0x00badcode/sonos-youtube-client/releases/latest), unzip it, and move the app to Applications.

Requires macOS 26 on Apple silicon, and:

```bash
brew install yt-dlp ffmpeg
```

The app is not notarized: on first launch, right-click it and choose Open. Then allow Local Network access so it can find your speakers.

Keep the app running while music plays; it serves the audio to the speaker. Closing the window is fine, quitting stops the music.

## Build from source

Needs the Xcode Command Line Tools (no Xcode).

```bash
./build.sh
open build/SonosTube.app
```

Self-check: `.build/release/SonosTube --self-test`

---

# Terminal CLI (legacy)

The original Deno CLI is still in the repo. Everything below describes it.

## Features

- 🎵 Play YouTube videos directly on Sonos devices
- 📡 Automatic device discovery on your network
- 📻 Music catalog to save and manage favorite tracks
- 🎛️ Full playback control (play, pause, resume, stop, queue)
- 💻 Beautiful TUI (Text User Interface) with modals

## Requirements

- **Deno** (v1.0+): [Install Deno](https://deno.land)
- **yt-dlp**: `pip install yt-dlp` or `brew install yt-dlp`
- **ffmpeg**: `brew install ffmpeg` (macOS) or your package manager

## Installation

1. Clone this repository:
```bash
git clone <the-repo-url>
cd sonosyoutubeplay
```

2. Run the installation script:
```bash
chmod +x sonoscliinstall.sh
./sonoscliinstall.sh
```

This will:
- Check for required dependencies
- Compile the TypeScript source into a standalone executable (`sonos-cli`)

3. (Optional) Install system-wide:
```bash
sudo mv sonos-cli /usr/local/bin/
```

## Quick Start

1. Start the interactive CLI:
```bash
./sonos-cli
# or if installed system-wide:
sonos-cli
```

2. Discover your Sonos devices:
```
sonos> scan
```

3. Set a default device:
```
sonos> set-default 1
```

4. Play a YouTube video:
```
sonos> play https://youtu.be/VIDEO_ID
```

## Usage

### Interactive Mode

The CLI starts in interactive mode with a TUI. Available commands:

- `scan` - Discover Sonos devices on your network
- `list` or `devices` - Manage saved devices
- `play <URL> [device]` - Play a YouTube URL
- `pause` / `resume` / `stop` - Control playback
- `music` - Manage your music catalog
- `help` - Show context-aware help
- `status` - Show system status
- `exit` or `quit` - Exit the application

### Direct Commands

You can also run commands directly without entering interactive mode:

```bash
./sonos-cli scan
./sonos-cli play https://youtu.be/VIDEO_ID
./sonos-cli help
```

## Device Management

In the devices modal (`list` command):
- `add <name> <ip>` - Add a new device manually
- `edit <n> <name>` - Change device name
- `edit <n> <ip>` - Change device IP
- `delete <n>` - Remove a device
- `set-default <n>` - Set default device
- `help` - Show device commands
- `done` or `q` - Close modal

## Music Catalog

In the music catalog (`music` command):
- `add <url>` - Add YouTube URL to catalog
- `delete <n>` - Remove track from catalog
- `play <n> [device]` - Play track #n
- `next <n> [device]` - Queue track #n
- `help` - Show music commands
- `done` or `q` - Close modal

## Configuration

The CLI stores configuration in:
- **macOS/Linux**: `~/.config/sonos-youtube-cli/`
- **Windows**: `%APPDATA%/sonos-youtube-cli/`

This includes:
- Saved devices
- Music catalog
- Default device preference

## Troubleshooting

### "Command not found" errors

If `yt-dlp` or `ffmpeg` are not found, add to your shell profile (`~/.zshrc` or `~/.bash_profile`):

```bash
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
```

### Device discovery issues

- Ensure your Sonos devices are on the same network
- Try `scan --verbose` for detailed discovery info
- Manually add devices with `add <name> <ip>` if needed

### Playback issues

- Check that `yt-dlp` and `ffmpeg` are properly installed
- Verify your Sonos device is reachable: `ping <device-ip>`
- Try specifying the device explicitly: `play <url> <device-ip>`

## Contributing

Feel free to open PRs or issues if something is not working / you wanna add some stuff.

