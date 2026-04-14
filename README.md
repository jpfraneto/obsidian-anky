# Anky — Obsidian Plugin

an implementation of the [anky protocol](https://anky.app/protocol.md) for obsidian.

forward-only writing. no backspace. no editing. no performance. just you and the blank page.

## what it does

press `Cmd+Shift+A` (or `Ctrl+Shift+A`) and a full-screen writing session begins. the screen goes dark. a cursor blinks. you write.

the rules are simple:

- **forward only.** no backspace, no delete, no arrow keys, no enter, no paste. typos stay. hesitations stay. the mess stays.
- **8-second silence ends the session.** stop typing for 8 seconds and the session is sealed. you can't go back.
- **8 minutes is the threshold.** the progress bar fills over 8 minutes. sessions that cross this line are called *ankys*. everything shorter is just a session.

when the session ends, your keystrokes are saved as an `.anky` file — one line per keystroke, with millisecond-precision timing. the filename is the SHA-256 hash of the file contents. the file is never modified after creation.

## the .anky format

each file follows the [anky protocol](https://anky.app/protocol.md) spec:

```
1776098721818 w       <- first line: unix epoch ms + character
48 r                  <- subsequent lines: delta ms + character
131 i
173 SPACE             <- spaces are encoded as SPACE
```

no metadata. no headers. no comments. every line is a real keystroke from a real moment.

## filesystem layout

sessions are stored in your vault:

```
ankys/
  2026/
    04/
      13/
        a1b2c3d4...f0.anky
        e5f6a7b8...d9.anky
```

the folder is configurable in plugin settings (default: `ankys`).

## features

### writing session (`Cmd+Shift+A`)

- full-screen, distraction-free writing environment
- orange idle bar appears after 3 seconds of silence, depletes over the remaining 5 seconds
- rainbow progress bar tracks the 8-minute journey
- countdown timer flips to count-up after 8 minutes
- all editing keys are blocked — you can only move forward

### session viewer

- opens automatically when you click any `.anky` file
- shows the reconstructed text with session stats (date, duration, word count, flow score)
- navigate between sessions with arrow keys
- delete sessions you don't want

### anky map (`Open anky map` command)

- visual grid of all your sessions — purple squares for ankys (8+ min), dark squares for shorter sessions
- hover or arrow-key navigate to preview any session
- press space to open the full session view

### flow score

each session gets a flow score (0-100%) based on:

- **rhythm** (30%) — consistency of typing cadence
- **velocity** (25%) — words per minute relative to 60 wpm baseline
- **attention** (25%) — absence of long pauses (3s+)
- **duration** (20%) — how close to the 8-minute mark

## installation

1. clone or download this repository
2. install dependencies and build:
   ```
   npm install && npm run build
   ```
3. copy `main.js` and `manifest.json` into your vault:
   ```
   {your-vault}/.obsidian/plugins/anky/
   ```
4. enable the plugin in obsidian settings > community plugins
5. press `Cmd+Shift+A` and write

## the full experience

this plugin captures the core writing practice. for the full anky experience — reflections, ai-generated insights, chain anchoring, and more — download the mobile app:

**[download on testflight](https://testflight.apple.com/join/WcRYyCm5)**

## the protocol

the anky protocol is a minimal specification for capturing forward-only keystroke sessions as immutable, hash-verifiable plain text files. one file format. one hash function. one optional public anchor.

read the full spec: [anky.app/protocol.md](https://anky.app/protocol.md)

*the writing is the seed. everything else is fruit.*
