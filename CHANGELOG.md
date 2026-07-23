# Changelog

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
