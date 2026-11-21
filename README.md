# Read Aloud for iPhone

A Safari extension for iPhone that reads highlighted text aloud. Highlight text on any page, tap the
round speaker button, and it reads it with the current word marked on the page. A bar at the bottom
pauses, skips by sentence, changes speed and stops.

It uses the iPhone's own voices, so it works with no server. In Safari's puzzle-piece menu under
Read Aloud you can pick a voice, read the whole page, or switch on your own speech server: any
server with OpenAI's `/audio/speech` API (speaches, Kokoro-FastAPI, OpenAI). If the server fails it
falls back to the iPhone voice.

## Install

Every push to `main` builds an unsigned IPA (`readaloud-ipa` artifact) on a macOS runner.

Install the IPA with **SideStore, AltStore or Sideloadly**, keeping app extensions. Not inside
LiveContainer: apps there can't register extensions with iOS, so Safari would never see it.

Then turn it on: Settings › Apps › Safari › Extensions › Read Aloud, and set All Websites to Allow.

## Build on a Mac

`brew install xcodegen && xcodegen generate`, then open `ReadAloud.xcodeproj`.

## Layout

- `App/`: the container app, which only explains how to turn the extension on.
- `Extension/SafariWebExtensionHandler.swift`: the native handler Safari requires.
- `Extension/Resources/`: the web extension (manifest, content script, menu, background fetcher).

## License

MIT
