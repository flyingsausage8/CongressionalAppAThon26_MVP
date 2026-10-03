# Driving Game

A voice-only story game that keeps drivers awake. The player listens to a cast of
AI-voiced characters and responds out loud. Generative AI writes the script as it goes.

## How it works

```
mic -> speech-to-text -> context -> AI -> script lines -> text-to-speech -> speakers
                            ^                                                  |
                            |__________________ loop __________________________|
```

The AI receives **context** and returns **script lines**. Nothing else.

### Context in

- **Cast bios** - who exists and how each one talks (`content/cast.json`)
- **Per-character memory** - what each has said, learned, and how they feel about the driver
- **Recent transcript** - the last few exchanges, verbatim

### Script out

```json
[
  { "voice": "narrator", "text": "The off-ramp slides past." },
  { "voice": "sfx",      "name": "turn_signal" },
  { "voice": "mara",     "text": "You missed it. On purpose?" }
]
```

`sfx` is the only reserved word. Every other `voice` must be a key in `cast.json`,
so the AI cannot invent a character that has no voice assigned.

The narrator is not special - it is just another entry in the cast.

## Setup

Copy `.env.example` to `.env` and fill in the Azure keys. `.env` is gitignored.

## Status

MVP, built for a hackathon.
