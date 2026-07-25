# Changelog

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
