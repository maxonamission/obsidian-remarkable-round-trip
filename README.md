# reMarkable Round-Trip

Send notes from your [Obsidian](https://obsidian.md) vault to a reMarkable
tablet as e-ink friendly PDFs, annotate them on the tablet, and get those
annotations back **in the note they came from** — as markdown you can search,
link and edit. That return trip is what this plugin is for.

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
- Each note gets a stable `remarkable-id` in its frontmatter. That id, not the
  file path, is how a document finds its note again — move or rename the note
  and the link survives.

## Privacy and permissions

Your notes go directly from Obsidian to the endpoint you configure — the
official reMarkable cloud or your own rmfakecloud server. No other services,
no telemetry, no analytics.

Obsidian's plugin scan flags three capabilities. Here is what each is for:

- **Reads and writes vault files.** It reads the note you send and writes the
  annotations back. Nothing else is touched: generated blocks live between
  markers, so your own text around them survives a re-import.
- **Lists all files in the vault.** Only to find a note again by the
  `remarkable-id` in its frontmatter, when its path no longer matches — that
  is what lets you move or rename an annotated note without losing the link.
  Paths are read, contents are not.
- **Writes to the clipboard.** The import report is copied there so you can
  paste it into a bug report. The same report is always written to
  `reMarkable Round-Trip log.md` in your vault, so nothing depends on the
  clipboard. It is never read.

Your reMarkable pairing is a device token, obtained once from a code you enter
yourself. It is stored in the plugin's own settings, and it is the only
credential the plugin holds.

## Getting annotations back

Annotate a document on your reMarkable, then run **Import annotations from
reMarkable** from the command palette. The plugin finds the documents that
changed since the last import and writes what it read into your vault.

What you get is an **annotated copy of the note**: your own text, unchanged,
with the marks woven in where you drew them. Bold, italics, headings, links
and lists all survive, because the copy starts from your note rather than
being rebuilt from the page.

By default it lands in a companion note (`Your note — annotations.md`) so your
source note stays untouched; a setting switches to a section inside the source
note itself. Either way the plugin only ever replaces its own marked block, so
anything you write around it survives a re-import.

### Which marks are understood

No OCR and no model: the plugin typeset the page itself, so it knows where
every word sits and can tell from the *shape and position* of a stroke what it
did and which words it points at.

| Draw this on the tablet | Recognised as | Default result in your vault |
|---|---|---|
| A line **through** words | Strike-through | `~~the struck words~~` |
| A line **under** words, clear of the baseline | Underline | `<u>the underlined words</u>` |
| A **loop around** a word or phrase | Circle | `**the circled phrase**` |
| A **vertical bar in the margin** | Margin bar | The lines it ran alongside, as a `>` quote |
| The **text highlighter** | Highlight | `<mark>` in the colour you used |
| Anything else — handwriting, arrows, scribbles | Remark | A cropped image in a callout, under the line it was written against |
| **A page you added** on the tablet to write on | Added page | The whole page as an image, placed after the text it follows |

Rules worth knowing:

- **A strike-through may be several strokes.** Go back over it as often as you
  like: passes over the same words count as one mark.
- **Through or under decides the meaning.** Ink crossing the letters is a
  strike-through, ink below them an underline. In the doubtful band right on
  the baseline, strike-through wins.
- **Two marks side by side on one line stay two marks.** Joining needs real
  overlap, not proximity.
- **A margin bar must be outside the text column**, and straight — a stroke
  with a corner in it is read as a remark, not a bar.
- **Highlight colours come back as the colours you used**, straight from the
  device rather than mapped to a palette.
- **A page you insert on the tablet keeps its place.** The reMarkable can add
  a blank page to a PDF to write on; it comes back whole, after the text it
  follows, and the pages after it still line up with the right part of your
  note.

### Changing what a mark means

The shapes are fixed — they are what a pen can draw — but what they *mean* is
your own convention. Under **Settings → What a pen mark becomes**, each of the
three inline marks can be set to strikethrough, bold, italic, underline,
highlight, or left alone entirely. Circle everything you want to highlight?
Set *Loop around words* to **Highlight** and it comes back that way.

Margin bars always quote the lines they ran alongside, and handwriting always
comes back as an image — those are not styling choices.

### When anchoring is not possible

Placing marks needs the note to still match what was sent.

- **Edited the note since?** The annotations still come back, but as a summary
  rather than a copy, with a warning at the top of the block saying they
  describe the earlier version. Send the note again to annotate the current
  one.
- **Sent it as EPUB?** EPUB reflows on the device, so there is no fixed page
  to anchor to; annotations come back at page level.
- **Moved or renamed the note?** That is fine — it is found again by its
  `remarkable-id`, and the companion note moves along with it.

The import report (written to `reMarkable Round-Trip log.md` and copied to
your clipboard) says per note what happened: what was read, what ended up in
the vault, and which words each mark landed on.

## Known limitations (beta)

- Images render as placeholders in the PDF.
- Standard PDF fonts (full Latin-1 coverage; other scripts get ASCII
  fallbacks).
- The stroke reader is written against an undocumented format: unusual pens
  or a future firmware may not render. The import report says so when a page
  could not be read.

## License

MIT
