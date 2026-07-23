# reMarkable Round-Trip

Send notes from your [Obsidian](https://obsidian.md) vault to a reMarkable
tablet as e-ink friendly PDFs — with your vault folder structure mirrored on
the device and a stable document-ID that will link annotations back to their
source note (the round-trip, in development).

> **Status: experimental beta.** This plugin is under active development and
> not yet in the community plugin registry. Expect rough edges; please report
> issues!

## Install (via BRAT)

1. Install the community plugin
   [BRAT](https://obsidian.md/plugins?id=obsidian42-brat) (Beta Reviewers
   Auto-update Tool).
2. In BRAT: *Add beta plugin* → `maxonamission/obsidian-remarkable-round-trip`.
3. Enable **reMarkable Round-Trip** in *Settings → Community plugins*.

## Setup

1. Get a one-time pairing code at
   [my.remarkable.com/device/browser/connect](https://my.remarkable.com/device/browser/connect).
2. Open *Settings → reMarkable Round-Trip*, enter the code and select **Pair**.

Self-hosting [rmfakecloud](https://ddvk.github.io/rmfakecloud/)? Toggle
*Self-hosted endpoint* and enter your base URL instead.

## Use

- **Command palette**: *Send current note to reMarkable*.
- **Right-click a note or folder**: *Send to reMarkable* (folders send all
  notes inside, with progress and per-file error reporting).
- **Watch folder** (optional, off by default): notes dropped into a
  configurable vault folder are converted and uploaded automatically;
  unchanged notes are skipped.

What happens to your note:

- Wikilinks are flattened to readable text; `![[embeds]]` are resolved
  inline; callouts become titled quotes; comments are removed; frontmatter is
  stripped (or rendered as a title block, if you prefer).
- The note is typeset as a PDF on the reMarkable 2 page grid, with
  configurable font size, line spacing and margins.
- Your vault folders are recreated on the device under a configurable base
  folder (default `Obsidian`); re-sending a note replaces the previous copy
  (the old one goes to the device trash).
- Each note gets a stable `remarkable-id` in its frontmatter — the anchor
  that the upcoming incoming route (annotations back into Obsidian) will use.

## Privacy

Your notes go directly from Obsidian to the endpoint you configure — the
official reMarkable cloud or your own rmfakecloud server. No other services,
no telemetry.

## Known limitations (beta)

- Images render as placeholders in the PDF.
- Standard PDF fonts (full Latin-1 coverage; other scripts get ASCII
  fallbacks).
- The incoming route (highlights/annotations back into the vault) is not
  built yet — it is the next phase.

## License

MIT
