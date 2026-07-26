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
- **Right-click a multi-selection**: select several notes and/or folders in
  the file explorer and send them in one batch; duplicates are filtered out.
- **Watch folder** (optional, off by default): notes dropped into a
  configurable vault folder are converted and uploaded automatically;
  unchanged notes are skipped.

What happens to your note:

- Wikilinks are flattened to readable text; `![[embeds]]` are resolved
  inline; callouts become titled quotes; comments are removed; frontmatter is
  stripped (or rendered as a title block, if you prefer).
- The note is typeset as a PDF on the reMarkable 2 page grid, with
  configurable font size, line spacing and margins. Prefer reading comfort
  over annotation anchoring? Switch the format to **EPUB**: it reflows, the
  device sets the type size, you get a table of contents from your headings,
  and non-Latin scripts survive intact.
- Your vault folders are recreated on the device under a configurable base
  folder (default `Obsidian`); re-sending a note replaces the previous copy
  (the old one goes to the device trash).
- Each note gets a stable `remarkable-id` in its frontmatter — the anchor
  that the upcoming incoming route (annotations back into Obsidian) will use.

## Privacy

Your notes go directly from Obsidian to the endpoint you configure — the
official reMarkable cloud or your own rmfakecloud server. No other services,
no telemetry.

## Getting annotations back

Annotate a document on your reMarkable, then run **Import annotations from
reMarkable** from the command palette. The plugin finds the documents that
changed since the last import, pulls their text highlights, and writes them
into your vault — grouped per page, with colours, linked to the note they
came from.

By default they go into a companion note (`Your note — annotations.md`) so
your source note stays untouched; a setting switches to a section inside the
source note. Either way the plugin only replaces its own marked block, so
your own writing around it survives a re-import.

Pen marks come back as **text**. Because the plugin typeset the page, it knows
where every word sits — so it can read what a mark did and name the words it
points at:

| On the tablet | In your vault |
|---|---|
| Line through words | ~~the struck words~~ — struck through |
| Line under words | the underlined words — underlined |
| Loop around a phrase | **the circled phrase** — circled |
| Bar in the margin | Marked in the margin, with those lines quoted |
| Arrow | Arrow: "from here" → "to here" |

No OCR, no model: it is geometry over the plugin's own layout. Handwritten
*words* stay images — there the ink is the content — rendered to PNG, cropped
to the ink, and quoted with the sentence they were written against.

Quoting needs the note to still match what was sent. Edited it since? The
images come back without quotes rather than with the wrong ones, and the
import report tells you to send the note again. EPUB reflows on the device,
so there the annotations stay at page level.

## Known limitations (beta)

- Images render as placeholders in the PDF.
- Standard PDF fonts (full Latin-1 coverage; other scripts get ASCII
  fallbacks).
- The stroke reader is written against an undocumented format: unusual pens
  or a future firmware may not render. The import report says so when a page
  could not be read.

## License

MIT
