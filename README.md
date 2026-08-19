# reMarkable Round-Trip

You review documents on your reMarkable because it's more comfortable and
intuitive than a screen. It simply feels more natural to physically strike
out a sentence, circle a phrase or mark a paragraph with a line in the
margin.

While reading, thoughts take shape — that's when I would add a remark or
keyword as a hint for later edits. I wanted the best of both worlds. Writing
and editing in Markdown with a keyboard or using dictation. Then switch to
my reMarkable to slow down, review and think.

That is why I built reMarkable Round-Trip. Send your notes to your
reMarkable with a simple command, review them and import your remarks back
into the note they came from. The sentence you struck out is struck out. The
phrase you circled is bold. The objection you scrawled sits under the
paragraph it belongs to.

This is the first version of reMarkable Round-Trip and I hope you'll enjoy
using it. If you know what it should do next — do let me know.

> **Early days.** Fresh in the community plugin directory and under active
> development. It is used daily on a real device, and rough edges get fixed
> fast — please report what you hit.

## Start here

**1. Install.** *Settings → Community plugins → Browse*, search for
**reMarkable Round-Trip** — or use
[this direct link](https://obsidian.md/plugins?id=remarkable-round-trip) —
install and enable.

**2. Pair.** Get a one-time code at
[my.remarkable.com/device/browser/connect](https://my.remarkable.com/device/browser/connect),
then open *Settings → reMarkable Round-Trip*, enter it and select **Pair**.
Self-hosting [rmfakecloud](https://ddvk.github.io/rmfakecloud/) instead? Toggle
*Self-hosted endpoint* and give your base URL.

**3. Send a note.** Right-click any note → *Send to reMarkable*. Read it, mark
it up, then run **Import annotations from reMarkable** from the command
palette.

That is the whole loop. Everything below is detail for when you want it.

## Sending notes

- **Command palette**: *Send current note to reMarkable*.
- **Right-click a note or folder**: *Send to reMarkable* — a folder sends
  everything inside it, with progress and per-file errors, and keeps its own
  subfolder structure on the device even when folder mirroring is off.
- **Right-click a multi-selection**: several notes and folders at once;
  duplicates are filtered out.
- **Choose a layout for one send**: every send entry has a *…(choose
  layout…)* twin that opens a small dialog — preset, sliders, page breaks,
  prefilled from your settings — applied to that send only. Your saved
  settings stay as they are.
- **Watch folder** (optional, off by default): notes dropped into a folder you
  choose are sent automatically, after a short quiet period. Unchanged notes
  are skipped.

What happens to your note on the way:

- Wikilinks become readable text, `![[embeds]]` are resolved inline, callouts
  become titled quotes, comments are dropped, and frontmatter is left out — or
  rendered as a small title block, if you prefer.
- Task checkboxes (`- [ ]`) become real drawn squares you can tick with the
  pen, and a table row that is empty — or holds only a label in its first
  column — becomes a fill-in row with room to write: a note with log tables
  turns into a form you complete on the device.
- A `\pagebreak` line (Pandoc's convention) forces a new page — or let the
  plugin decide: the default **Smart** setting measures each `#`/`##`
  section and turns the page only when it would otherwise be split, so a
  day-per-heading log gets a page per day while a compact card stays on
  one. Prefer a fixed rule? A new page before `#` (or `#` and `##`)
  headings is still there. Tables that fit on a page stay whole instead of
  snapping in two, and a heading never dangles at the bottom without its
  text.
- A paragraph that is entirely bold or italic — `**Goal**` as a label line —
  keeps its emphasis on the page.
- It is typeset as a PDF on your reMarkable's own page grid — pick your
  model under *Settings → Page layout* (reMarkable 1/2/Paper Pure or
  Paper Pro) — with a layout preset for what the page is for: easy
  reading, fill-in form, compact, or custom font size, line spacing and
  margins. Reading rather than annotating? Switch to
  **EPUB**: it reflows, the device picks the type size, your headings become a
  table of contents, and non-Latin scripts survive intact.
- Your vault folders are recreated on the device under a base folder you
  choose. Re-sending replaces the previous copy; the old one goes to the
  device trash.
- Each note gets a stable `remarkable-id` in its frontmatter. That id — not the
  file path — is how a document finds its note again, so you can move and
  rename freely.

## Write on it, too

Reviewing with the pen is one half of the tablet; writing without
distraction is the other. Send a note as **editable text** — right-click →
*Send to reMarkable as editable text*, or run the command — and it arrives
as a typed-text notebook you edit with the keyboard, not as a fixed page
you annotate.

- `##` headings, bold label lines, bullets (nested one level deep) and
  task checkboxes arrive as real device paragraph styles. Everything else
  — links, tables, code, single-`#` headings, inline styling — travels
  along as literal text, byte for byte, so nothing of your markdown is
  ever lost or renamed.
- Frontmatter stays home: properties are vault metadata, not text to edit.
  The note on the device is exactly the note body.
- Re-sending replaces the previous copy (the old one goes to the device
  trash), and the annotation import knows to leave these documents alone.

And the text comes back. Run **Get edited text back from reMarkable** (or
right-click the note) and the edited text lands **in the note itself**,
frontmatter untouched. With guard rails, because this is the one place the
plugin replaces your own text:

- It only ever runs when you ask, per note.
- Before the note is touched, the previous version is saved to a
  `previous` folder — the message tells you where.
- If the note changed in your vault *and* on the device, nothing is merged
  silently: a dialog lets you pick which version the note keeps, and the
  other one is saved either way.
- If only your note changed, or nothing changed, the note is left alone
  and the message says so.

## Getting your thinking back

Run **Import annotations from reMarkable**. The plugin finds the documents you
have touched since last time and writes what it read into your vault.

What you get is an **annotated copy of your note**: your own text, unchanged,
with the marks worked in where you drew them. Bold, italics, headings, links
and lists all survive, because the copy starts from your note rather than being
rebuilt from the page.

It lands in a companion note (`Your note — annotations.md`) so your source note
stays untouched; a setting puts it inside the source note instead. Either way
the plugin only ever replaces its own marked block, so anything you write
around it survives a re-import.

### Which marks are understood

The plugin typeset the page itself, so it knows where every word sits and
can tell from the shape and position of a stroke what it did and which words
it points at — read locally, from stroke geometry alone.

| Draw this on the tablet | Recognised as | Default result in your vault |
|---|---|---|
| A line **through** words | Strike-through | `~~the struck words~~` |
| A line **under** words, clear of the baseline | Underline | `<u>the underlined words</u>` |
| A **loop around** a word or phrase | Circle | `**the circled phrase**` |
| A **vertical bar in the margin** | Margin bar | The lines it ran alongside, as a `>` quote |
| The **text highlighter** | Highlight | `<mark>` in the colour you used |
| A **tick or cross in a drawn checkbox** | Task done | `- [x]` on that task line |
| A **strike through a whole task line** | Task cancelled | `- [-]` on that task line |
| Anything else — handwriting, arrows, scribbles | Remark | A cropped image in a callout, under the line it was written against |
| **A page you added** on the tablet to write on | Added page | The whole page as an image, placed after the text it follows |

Worth knowing:

- **A strike-through may be several strokes.** Go back over it as often as you
  like; passes over the same words count as one mark.
- **Through or under decides the meaning.** Ink crossing the letters is a
  strike-through, ink below them an underline. Right on the baseline,
  strike-through wins.
- **Two marks side by side on one line stay two marks.**
- **A margin bar must sit outside the text column**, and be straight — a
  stroke with a corner in it is read as a remark.
- **Highlight colours come back as the colours you used**, straight from the
  device rather than mapped to a palette.
- **A page you insert on the tablet keeps its place** — it comes back whole,
  after the text it follows, and the pages after it still line up.

### Changing what a mark means

The shapes are fixed — they are what a pen can draw. What they *mean* is your
own convention. Under **Settings → What a pen mark becomes**, each of the three
inline marks can be set to strikethrough, bold, italic, underline, highlight,
or left alone. Circle the things you want highlighted? Set *Loop around words*
to **Highlight**.

Margin bars always quote the lines they ran alongside, and handwriting always
comes back as an image; those are not styling choices.

### When placement is not possible

Placing marks needs the note to still match what was sent.

- **Edited the note since?** The annotations still come back, as a summary
  rather than a copy, with a warning saying they describe the earlier version.
  Send the note again to annotate the current one.
- **Sent it as EPUB?** EPUB reflows on the device, so there is no fixed page to
  anchor to; annotations come back at page level.
- **Moved or renamed the note?** No problem — it is found again by its
  `remarkable-id`, and the companion note moves along with it.

Every run writes a report to `reMarkable Round-Trip log.md` and copies it to
your clipboard: what was read, what ended up in your vault, and which words
each mark landed on.

## Privacy and permissions

Your notes go directly from Obsidian to the endpoint you configure — the
official reMarkable cloud or your own rmfakecloud server. No other services, no
telemetry, no analytics.

Obsidian's plugin scan flags three capabilities. Here is what each is for:

- **Reads and writes vault files.** It reads the note you send and writes the
  annotations back. Nothing else is touched: generated blocks live between
  markers, so your own text around them survives a re-import.
- **Lists all files in the vault.** Only to find a note again by its
  `remarkable-id` when its path no longer matches — that is what lets you move
  or rename an annotated note without losing the link. Paths are read,
  contents are not.
- **Writes to the clipboard.** The import report is copied there so you can
  paste it into a bug report. The same report always goes to a note in your
  vault as well, so nothing depends on the clipboard. It is never read.

Your reMarkable pairing is a device token, obtained once from a code you enter
yourself. It is stored in the plugin's own settings, and it is the only
credential the plugin holds.

## Known limitations

- Images render as placeholders in the PDF.
- Standard PDF fonts (full Latin-1 coverage; other scripts get ASCII
  fallbacks).
- Handwriting comes back as an image, not as text — reading handwriting is a
  different problem, and guessing at it would be worse than showing you what
  you wrote.
- The stroke reader is written against an undocumented format: unusual pens or
  a future firmware may not render. The import report says so when a page could
  not be read.

## License

GPL-3.0-or-later — Copyright (C) 2026 Max Kloosterman.

Versions up to and including 0.26.2 were released under MIT and remain so;
from 0.27.0 the plugin is GPL, so that derivatives — in particular of the
`.rm` stroke reader, which did not exist in JavaScript before — stay open.
