# Changelog

## [0.10.0] - 2026-07-26

### Added

- **Text highlights come back at last.** They were never missing from your
  tablet — they were hiding somewhere this plugin did not look. On current
  firmware the "smart" highlighter does not write a separate highlight file;
  the highlighted text lives inside the page's own pen-stroke file, right
  next to your handwriting. The plugin now reads it there, with its colour
  and page number.

### Fixed

- **An arrow drawn down the margin was reported as a margin mark.** It is
  tall, narrow and nearly straight, so it looked like a bar. A bar has no
  corner and an arrow does — that is now the test.

### Note

The import report lists the block types found in each page file. If a
highlight still does not come back, that line says whether the page contained
one at all.

## [0.9.1] - 2026-07-26

### Fixed

- **A network failure was reported as a possible pairing problem.** When your
  device cannot look up the reMarkable server at all — no connection, or a
  VPN, private DNS or ad-blocking resolver in the way — it never reaches
  reMarkable, so pairing cannot be the cause. Messages now say which of the
  three it is: a network problem, refused credentials, or an error from the
  cloud itself. This applies to sending, importing, and the read-only cloud
  check alike.

## [0.9.0] - 2026-07-26

### Added

- **Pen marks come back as text, not as pictures of ink.** A circle around a
  phrase used to return as an empty oval; a strike-through as a stray line.
  The plugin now reads what the mark *did* — from its shape and from where it
  sits on the page — and writes that:

  | On the tablet | In your vault |
  |---|---|
  | Line through words | ~~the struck words~~ — struck through |
  | Line under words | the underlined words — underlined |
  | Loop around a phrase | **the circled phrase** — circled |
  | Bar in the margin | Marked in the margin, with those lines quoted |
  | Arrow | Arrow: "from here" → "to here" |

  Searchable, linkable markdown that names the exact words. No OCR and no
  model involved: because the plugin typeset the page, it already knows where
  every word is. Handwritten *words* still come back as an image with the
  sentence they were written against — there the ink is the content.

### Fixed

- **Annotations arrived in the wrong order** (page 2, then 4, then 3, then 1):
  they followed the order the cloud listed the files in rather than the order
  of the document.

### Note

The import report now lists every file the cloud returned for a document.
That is deliberate: if your text highlights do not come back, the report
shows whether the device sent a highlight file at all.

## [0.8.0] - 2026-07-26

### Added

- **Handwriting now comes back with the sentence it belongs to.** A remark
  written next to a paragraph used to return as a cropped drawing with no
  context. The plugin typesets your PDF itself, so it knows which line sits
  at which height on which page — imported ink is projected back onto that
  layout and quoted:

  > the sentence you wrote next to
  >
  > ![your handwriting]

- **One image per remark, not one per page.** Ink is grouped by where it sits
  on the page, so a note beside the second paragraph and an underline in the
  fifth come back as two images with their own quotes.

### Fixed

- **Page numbers were wrong.** Annotations were numbered by the order of the
  files the device returned, and only annotated pages get a file — so a
  remark on page 7 of a document reported as "page 1". Page numbers now come
  from the document's own page order. This also restores the page headings
  for text highlights, which had been missing entirely.

### Note

Quoting needs the note to still match what was sent; if you edited it since,
the images come back without quotes rather than with the wrong ones, and the
import report says so. Send the note again to restore the link. EPUB reflows
on the device and has no fixed page layout, so it stays at page level.

## [0.7.1] - 2026-07-25

### Fixed

- **The import report contradicted itself.** After a run that rendered your
  handwriting, the summary still claimed importing handwriting "is not built
  yet" — advice from before 0.7.0 that the report never stopped giving. It
  now counts the rendered pages: they show up per note, and the closing
  sentence tells you the pages came back as images. When strokes are found
  but nothing is rendered, it says whether the setting is off or the pages
  could not be read, instead of blaming a missing feature.

## [0.7.0] - 2026-07-25

### Added

- **Handwriting comes back too.** Handwritten notes and freehand marks are
  pen strokes rather than text, so they need rendering: each written page is
  now drawn to a PNG and embedded with your annotations, cropped to the ink
  so it stays readable. Switchable off, with a configurable folder for the
  images. Re-importing overwrites a page instead of piling up copies.

With that, the round trip is closed: send a note, annotate it by hand or by
highlighting text, and both come back linked to the note they came from.

### Note

The reMarkable stroke format is not officially documented and no JavaScript
library for it existed, so this reader was written from scratch and verified
against real device files. Unusual pens or a future firmware may still
surprise it; the import report tells you when a page could not be read.

## [0.6.0] - 2026-07-25

### Fixed

- **Importing annotations found nothing.** The plugin asked the cloud for a
  document's file list under the wrong name, so it always got an empty list
  — no highlights could ever be found. It now uses the same address the
  reMarkable API expects.

### Added

- **Every import writes a report**: to `reMarkable Round-Trip log.md` in
  your vault and to your clipboard. Per note it says what was found — how
  many files, how many highlight files, how many pen strokes — and ends
  with the most likely explanation when nothing came back. No console
  needed, which matters on mobile.
- New command **Re-import all annotations (ignore what was already
  imported)**, for when a normal import skips everything because it has
  seen those documents before.

### Note

Only *text* highlights come back: the reMarkable writes a highlight file
when you select text and highlight it. Freehand marks and handwriting are
pen strokes; importing those is the next step and the report now tells you
when that is what your document contains.

## [0.5.2] - 2026-07-25

### Added

- New command **Check reMarkable cloud status (read-only)**. If your tablet
  reports a sync error, this tells you whether the problem sits in your
  cloud account or on the device itself — useful when you only have a phone
  at hand. It reads and reports; it never writes, uploads or deletes. The
  report is copied to your clipboard so you can paste it somewhere.

## [0.5.1] - 2026-07-25

### Fixed

- Uploads no longer fail when the reMarkable cloud is busy. If your tablet
  (or another app) writes to the cloud at the same time, the server refuses
  the change — "failed to upload root schema". The plugin now refreshes its
  view of your document tree and retries, and only gives up after several
  attempts, with an explanation instead of a raw error.

### Changed

- Every message from this plugin is now prefixed with **reMarkable
  Round-Trip**, so you can tell at a glance whether a notification came from
  here, from Obsidian, or from the reMarkable app.

## [0.5.0] - 2026-07-25

### Added

- **The round trip begins: annotations come back.** New command *Import
  annotations from reMarkable* reads the text highlights you made on the
  device and writes them into your vault, linked to the note they came
  from. Documents you have not touched since the last import are skipped.
- Highlights land in a **companion note** by default (`Note — annotations.md`),
  which leaves your source note untouched and links back to it. You can
  switch to a section inside the source note instead — either way the plugin
  only ever replaces its own marked block, so anything you write around it
  survives a re-import.
- Highlights are grouped per page and keep their colour.

Handwritten annotations are not included yet — that is the next step.

## [0.4.0] - 2026-07-25

### Added

- **EPUB as an alternative format** (*Settings → Document format*). PDF
  keeps a fixed page layout, which is what annotations anchor to — still the
  default, and the right choice if you plan to write on the document. EPUB
  reflows, so the device picks the font size, it carries a table of contents
  built from your headings, and it keeps non-Latin scripts intact where the
  PDF path falls back to ASCII. Best for reading only.
- The PDF typography settings are hidden while EPUB is selected: an EPUB is
  laid out by the reader, not by the plugin.

## [0.3.0] - 2026-07-25

### Added

- Send a multi-selection: select several notes (and/or folders) in the file
  explorer, right-click, and send them in one batch. Folders in the
  selection are expanded recursively, and a note that is both selected and
  inside a selected folder is sent only once.

## [0.2.3] - 2026-07-25

### Fixed

- "Frontmatter as title block" now actually shows your fields: list values
  (`tags:` with `- items`, or `[a, b]`) were silently dropped, and `tags`
  and `aliases` were hidden by default — so the block could come out empty.
  Only the plugin's own `remarkable-id` and Obsidian styling keys stay
  hidden now.

### Changed

- Clearer wording for the "Frontmatter as title block" setting: frontmatter
  is left out of the PDF unless you turn this on.

## [0.2.2] - 2026-07-24

### Fixed

- Sending no longer fails on mobile when the connection to the reMarkable
  folder API drops ("unexpected end of stream"): requests are retried, and
  if folder mirroring stays unreachable your notes are delivered to the
  device root instead of the send being refused.

## [0.2.1] - 2026-07-23

First beta feedback — thank you!

### Fixed

- Tables no longer truncate cell text: cells now wrap across lines, column
  widths follow the content (narrow columns stay readable, wide ones wrap),
  and the header row gets a separator line.

## [0.2.0] - 2026-07-22

First public beta (via BRAT).

### Added

- Send a note or folder to your reMarkable from the command palette or the
  file context menu, with per-file error reporting for batches.
- Obsidian-flavored markdown preprocessing: wikilinks flattened, embeds
  resolved inline (with cycle guards), callouts as titled quotes, comments
  removed, frontmatter stripped or rendered as a title block.
- E-ink friendly PDF typesetting on the reMarkable 2 page grid with
  configurable font size, line spacing and margins.
- Vault folder mirroring on the device under a configurable base folder;
  re-sending replaces the previous copy (old copy moves to the device trash).
- Stable `remarkable-id` in the note frontmatter + PDF metadata: the
  foundation for the upcoming round-trip of annotations.
- Watch folder (off by default): auto-convert and upload notes dropped into a
  configurable vault folder; unchanged notes are skipped.
- Official reMarkable cloud (one-time pairing code) or self-hosted
  rmfakecloud endpoint.

## [0.1.0] - 2026-07-22

Internal development build (not released).
