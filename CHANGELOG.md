# Changelog

## [0.38.4] - 2026-08-19

### Fixed

- **Mobile-app edits now land where you typed them — root cause found.**
  The always-on diagnosis of 0.38.3 showed exactly what the reMarkable
  mobile app writes: it splits the existing text at the edit point, and
  the tail keeps the SAME left anchor as the inserted text. Placement
  that only followed left anchors put the tail before the insert, pushing
  your edit to the end of the note — with every anchor "resolved", which
  is why earlier fixes missed it. The right-hand anchor ("I sit before
  this character") is unambiguous and now decides placement, with the
  left anchor as fallback. A regression test carries the exact structure
  from the field diagnosis.


## [0.38.3] - 2026-08-19

### Changed

- **Every text import now writes its diagnosis.** "Get edited text back"
  leaves a full trace in `reMarkable Round-Trip log.md` on every run —
  plugin version, outcome, and the document's internal item map (ids,
  anchors, lengths; never your text) — not only when something could not
  be placed. One failed test now tells the whole story, also on mobile
  where there is no console.


## [0.38.2] - 2026-08-19

### Fixed

- The text-item reader now reads fields by their tag instead of by
  position, matching how the format actually works — a client that writes
  an extra or missing field (different reMarkable apps write these files
  differently) can no longer shift the anchor values that decide where
  edited text lands.

### Added

- **Diagnosis without a console.** When an edit cannot be anchored (its
  text then sits at the end of the note), the import now says so in the
  message and writes a compact map of the document's internal structure —
  ids, anchors and lengths, never your text — to
  `reMarkable Round-Trip log.md` in your vault. If placement is still
  wrong on your device, that note tells us exactly why.


## [0.38.1] - 2026-08-19

### Fixed

- **Text added in the reMarkable mobile app now comes back where you typed
  it.** The phone app stores its edits in an order the import read
  front-to-back, so an addition whose anchor point appeared later in the
  file fell back to "append at the end" — your new paragraph landed at the
  bottom of the note. Placement now keeps resolving anchors until
  everything has found its spot, uses the right-hand anchor as a fallback
  when the left one points at text that was later cleaned up, and if
  something truly cannot be placed it is still kept (at the end) and noted
  in the console rather than lost.


## [0.38.0] - 2026-08-19

### Added

- **Nested bullets in editable text.** A tab-indented `- ` line arrives as
  a real second-level bullet on the device and comes back tab-indented. A
  nested task keeps its depth too, with the `[ ]` marker travelling as
  text.

### Changed

- **The editable-text round-trip is now exact for everything.** Only the
  precise canonical spelling of each form maps to a device style — `## `
  headings, whole-line `**bold**`, `- ` bullets, `- [ ]`/`- [x]` tasks —
  and everything else travels literally, byte for byte. In particular a
  single-`#` heading no longer comes back as `##`: the device has one
  heading level, so `# ` now stays literal instead of being silently
  renamed. Documents sent as editable text with 0.36/0.37 are unaffected
  until you actually edit them on the device; re-send them once under the
  new rules to give them the exact round-trip too.


## [0.37.0] - 2026-08-19

### Added

- **The way back: your edited text returns to the note it came from.** For
  a note sent as editable text, a new command — "Get edited text back from
  reMarkable", also in the note's right-click menu — reads the edited
  document and updates the note itself, keeping its frontmatter untouched.
  Nothing is ever lost: the previous version is saved to a `previous`
  folder before the note is touched, and the message names where. When the
  note changed in your vault *and* on the device, the plugin never merges
  silently — a dialog lets you pick which version the note keeps, and the
  other one is saved either way. If only your note changed, or nothing
  changed, the note is left alone and the message says so.

### Improved

- The text reader now reassembles device edits by their internal anchors
  instead of file order, so insertions in the middle of a paragraph,
  deletions across paragraphs and multiple editing sessions all come back
  in the right place.


## [0.36.0] - 2026-08-19

### Added

- **Send a note as editable text.** A new per-send choice — right-click →
  "Send to reMarkable as editable text", or the command palette — delivers
  the note as a typed-text notebook you edit on the device with the
  keyboard, instead of a fixed page you annotate. Headings, bold label
  lines, bullets and task checkboxes arrive as real device paragraph
  styles; everything else travels as literal text, so nothing of your
  markdown is lost. Frontmatter stays home, folder mirroring applies as
  usual, re-sending replaces the previous copy, and the annotation import
  leaves these documents alone. Bringing the edited text back into your
  note is the next step on the roadmap — today the trip is one-way.

### Removed

- The hidden write-mode spike commands (and their manual `data.json` flag)
  made way for the real feature above.


## [0.35.3] - 2026-08-19

### Fixed

- **Ticks drawn the way people actually draw them are now recognized.**
  A natural tick — a small vertex on the checkbox with a tail sweeping a
  few lines upward — came back as a handwriting image instead of marking
  the task done: recognition looked at the ink's centre (which hangs
  mid-air above the box) and rejected anything larger than about a
  centimetre. Recognition now anchors on the ink's lowest point — the
  vertex of a tick, the foot of a cross — with a wider rim around the
  box, so generously sized ticks, crosses and scribbles all count. On
  stacked subtasks the nearest box wins. Strike-throughs, underlines and
  page-scale gestures are still kept apart.


## [0.35.2] - 2026-08-19

### Fixed

- Internal test documents written by the (hidden, experimental) write-mode
  spike carried a content field the cloud tree reader rejects, which made
  folder mirroring fall back to root uploads for ALL sends while such a
  document existed in the account. The spike now writes valid content. If
  folder mirroring stopped working for you after experimenting with the
  spike flag: delete the "(spike …)" documents on your device (and empty
  the device trash), and mirroring recovers on the next send.


## [0.35.1] - 2026-08-13

### Fixed

- **The plugin no longer erases keys it does not know from its own
  `data.json`.** Saving settings used to rewrite the file wholesale, which
  silently destroyed anything added by hand and any newer version's
  settings after a downgrade. Unknown keys now ride along untouched.


## [0.35.0] - 2026-08-13

### Added

- **Tick a checkbox with your pen.** Draw a tick or a cross in a task's
  drawn checkbox on the tablet, and the import marks that task done
  (`- [x]`) in the annotated copy. Strike a task line through and it comes
  back cancelled (`- [-]`). Pure geometry, no AI: the plugin typeset the
  page, so it knows exactly where every box sits — this also works for
  documents you sent with earlier versions. A partial strike over just a
  word or two keeps its usual meaning.


## [0.34.0] - 2026-08-13

### Added

- **Choose a layout for one send.** A new *…(choose layout…)* entry on the
  right-click menu — for a note, a folder, or a multi-selection — opens a
  small dialog with the layout preset, sliders and page-break mode,
  prefilled from your settings. The choice applies to that send only; your
  saved settings stay untouched. Also available from the command palette
  for the current note. Annotations on documents sent this way anchor
  exactly as always: every upload records the layout it was typeset with.


## [0.33.1] - 2026-08-13

### Fixed

- **Folder mirroring no longer fails on desktop with a large device
  library.** Listing the device's folder tree fired one burst of requests
  per document, all at once; with a few hundred items on the device,
  desktop Obsidian refused the burst (`net::ERR_INSUFFICIENT_RESOURCES`)
  and sends fell back to the device root. Requests are now queued through
  a small concurrency gate — the same discipline mobile's network stack
  applies natively — and that specific error is retried instead of
  aborting the send. Very likely the same root cause as the Android
  "unexpected end of stream" failures some users saw.
- The CORS shim now always patches the window the plugin actually runs
  in; previously a popped-out window that had focus during a settings
  change could end up patched instead, breaking folder mirroring on
  desktop until restart.

## [0.33.0] - 2026-08-13

### Added

- **Smart page breaks.** A new default for "Start a new page at headings":
  the typesetter measures each `#`/`##` section and turns the page only
  when the section would otherwise be split. A weekly log with a heading
  per day still gets each day on its own page, while a compact exercise
  card stays on one — no `\pagebreak` markers or per-note settings needed.
  The fixed options (off / `#` / `##`) are still there if you prefer them,
  and `\pagebreak` keeps working everywhere. Existing installs keep their
  current setting; the packing choice travels with each upload, so
  annotations on earlier documents stay anchored.
- **Label paragraphs keep their emphasis.** A paragraph that is entirely
  bold (`**Goal**`) or entirely italic (`*Strength block*`) — a common way
  to label sections without headings — is now typeset in bold or italic
  instead of plain text, in PDF and EPUB alike. Mixed styling inside
  sentences is still flattened. Documents sent earlier replay the plain
  look on import, so their annotations stay anchored.

## [0.32.2] - 2026-08-13

### Improved

- **A note that opens with a heading repeating its own file name no longer
  shows that title twice.** The typeset page already carries the title; a
  first `# heading` saying the same thing (any casing) is now skipped, in
  PDF and EPUB alike. Notes whose first heading says something else are
  untouched, and documents sent earlier replay the duplicate on import so
  their annotations stay anchored.


## [0.32.1] - 2026-08-13

### Improved

- **Fill-in rows are a touch tighter** (2.0 line steps instead of 2.4 —
  still ample for a pen line), so a log table more often shares a page with
  the text it belongs to instead of moving to its own. Documents sent
  earlier keep their roomier rows on import.

## [0.32.0] - 2026-08-13

### Changed

- **Obsidian 1.13 is now the minimum version.** The plugin shipped two
  renderings of its settings screen since 0.24.0 — the modern declarative
  one and a fallback for older Obsidian versions. With 1.13 now the stable
  public release, the fallback is deleted: the community scan's six
  deprecation notices are gone, the Unpair button uses the proper
  destructive styling, and pairing state updates through the 1.13 API. If
  your Obsidian is older than 1.13, you keep the current plugin version and
  receive updates again after updating the app. Nothing else changes — the
  two remaining scan notices (vault file listing, clipboard) are capability
  disclosures for features the README explains, not issues.


## [0.31.0] - 2026-08-12

### Added

- **Automatic page breaks at headings.** Under *Settings → Page layout*,
  choose to start a new page before `#` headings, or before `#` and `##` —
  a weekly log with a heading per day gets each day on its own page, no
  markers needed. The very first heading after the title stays put, and
  `\pagebreak` keeps working everywhere. Off by default.
- **Tables stay whole, headings stay with their text.** A table that fits
  on one page no longer snaps in two at a page boundary — it moves to a
  fresh page whole. And a heading no longer dangles at the bottom of a page
  with its content on the next: it needs room for at least two lines under
  it, or it moves along. No settings — just better typesetting. As always,
  documents sent with earlier versions replay their own layout on import,
  so existing annotations stay anchored.


## [0.30.0] - 2026-08-12

### Added

- **`\pagebreak` starts a new page.** Put it on its own line (Pandoc's
  convention) and the PDF turns the page there — give each day of a weekly
  log its own page. In EPUB, which reflows, it renders as a rule.
- **Pick your reMarkable model.** Pages are now sized to the screen of the
  device you choose under *Settings → Page layout* — reMarkable 1/2/Paper
  Pure or Paper Pro — so what you send fills your screen exactly. Each
  upload remembers its page size, so annotations on documents sent at
  another size still anchor correctly. (The Paper Pro Move's 9:16 screen
  needs its own ink-mapping work and a real device to validate against, so
  it is not offered yet.)
- **Layout presets.** Choose what a page is for instead of juggling sliders:
  *Easy reading* (larger type, roomy lines), *Fill-in form* (balanced, with
  writing space), *Compact* (as much on a page as fits) — or *Custom*, which
  keeps the three sliders exactly as you set them.

### Improved

- **Label rows get writing space too.** A table row where only the first
  column is filled — "Sleep (hours) | " with the value left to complete on
  the device — now gets the same writing height and faint rule as an
  all-empty row. The label is drawn as usual.

### Fixed

- **A word that exactly fills its table column is no longer broken.** The
  0.29.0 word-breaking compared measured widths that differ only by float
  noise (56.13 vs 56.129999999999995), so a two-column table sized by its
  longest word split that very word ("Achillespee/s"). Width comparisons now
  carry a hairline tolerance. Documents sent with 0.29.0 replay the old
  behaviour on import, so their annotations stay anchored.

## [0.29.0] - 2026-08-12

### Improved

- **Narrow table columns no longer collide.** A word wider than its column
  used to be drawn as-is and run into the neighbouring column — on a
  many-column table the headers merged into one unreadable string. Words now
  hard-break mid-word to fit the column, in tables and everywhere else (long
  URLs included).
- **Empty table rows become writing rows.** A table row with nothing in it is
  a fill-in row — a training log, a checklist, a form. It now gets real
  writing height and a faint rule to write on, instead of a one-line sliver
  no pen fits in.
- **Checkboxes are drawn, not spelled.** A `- [ ]` task renders as a real
  square you can tick on the tablet; `- [x]` comes with its check mark drawn
  in.
- **Real typography.** Em and en dashes, curly quotes, ellipses and bullets
  now reach the page as themselves instead of ASCII stand-ins (`--`, `...`);
  block quotes get a drawn quote bar instead of a `|` character.
- All of this only applies to documents sent from 0.29.0 on. Each upload now
  records the typesetting behaviour it was laid out with, so annotations on
  documents sent earlier still come back in exactly the right place.

## [0.28.0] - 2026-08-12

### Added

- **Sending a folder keeps its structure — even with mirroring off.** Until
  now, *Send folder to reMarkable* with "Mirror vault folders" disabled
  dropped every note flat into the device root. The sent folder now
  recreates its own subfolders on the device, rooted at the device root:
  mirroring off means "don't recreate my whole vault path", not "flatten
  everything". With mirroring on, nothing changes.
- **A subtle what's-changed notice after updates.** When the plugin steps up
  a minor or major version, a brief notice links to the release notes.
  Patch releases stay silent, a fresh install stays silent, and the notice
  can be turned off under *Settings → Updates*.

### Fixed

- **"Folder mirroring failed (root generation was stale; try put again)" now
  retries instead of failing.** When the tablet (or another client) was
  syncing at the same moment a note was sent, the cloud refused the write.
  The retry machinery existed for exactly this case but never engaged: the
  error class rmapi-js throws carries the generic `Error` name at runtime,
  so it slipped past our detection. It is now recognised directly and the
  send is tried up to four times (three retries) against a refreshed view
  of the device tree. If the cloud stays busy the message says so — wait
  for the tablet to finish syncing and send again — instead of suggesting
  you disable folder mirroring, and that explanation now also reaches the
  notice when notes fall back to the root, not just the console. Retries
  leave a console trail so reports can show whether they engaged.
- Development-toolchain dependencies patched (`npm audit` clean); the
  shipped bundle is unchanged by this.

## [0.27.0] - 2026-07-28

### Changed

- **License: MIT → GPL-3.0-or-later.** Copyleft keeps derivatives open — in
  particular of the `.rm` stroke reader, which did not exist in JavaScript
  before this plugin — and matches the author's other projects. Versions up
  to and including 0.26.2 were released under MIT and remain so; nothing
  changes for plugin *users*, only for anyone redistributing modified copies
  of the code.

## [0.26.2] - 2026-07-28

### Changed

- **The plugin is live in the community directory** — the README now points
  there for installation instead of BRAT, and the beta note reflects it.

## [0.26.1] - 2026-07-28

### Changed

- **New short description**, in the owner's words: write in your vault, review
  on reMarkable, get your remarks back in the note they came from. Also
  satisfies the registry rule that a description must not contain the word
  "Obsidian" — inside the plugin directory that context is a given.

## [0.26.0] - 2026-07-28

### Changed

- **The README and plugin description now open with the moment this plugin is
  for** — the idea you know is on the tablet and cannot find in your vault —
  instead of a summary of what the plugin does. Every promise in the new text
  maps to a shipped, tested feature; the imagination is in the showing, not in
  the claims.

## [0.25.0] - 2026-07-28

### Changed

- **Rewritten README and plugin description**, leading with the problem the
  plugin solves rather than the list of things it does. The short description
  now says what you get back rather than how the link is made.

## [0.24.0] - 2026-07-28

### Added

- **The settings are findable in Obsidian's settings search** on 1.13 and
  later, through the declarative settings API. Obsidian 1.12 and earlier keep
  the settings screen they always had — the minimum version stays 1.7.2.

Both are rendered from a single description of the screen, so a setting can
never appear in one and go missing from the other.

## [0.23.0] - 2026-07-28

### Fixed

- **No dynamic code execution in the release build.** Obsidian's plugin scan
  reported four dynamic `<script>` element creations and a `new Function`.
  None of it was this plugin's own code: it came from the `setImmediate`
  polyfills baked into JSZip, which reaches the bundle through `rmapi-js`.
  JSZip is now stubbed out — the plugin writes its own EPUB archives and reads
  device documents entry by entry, so it never needed it. The bundle is 148 KB
  smaller.
- **Pop-out windows.** The plugin patched `fetch` on the shared global and
  created its canvas on the shared document. Obsidian runs plugins per window,
  so both now target the window the plugin is actually loaded in.

### Changed

- The README explains what each capability the plugin scan reports is for —
  vault listing, clipboard, reads and writes — and what it deliberately does
  not do.
- Every build now checks the bundle for dynamic code execution and Node
  builtins, so a future dependency cannot reintroduce either quietly.

## [0.22.0] - 2026-07-28

### Added

- **Pages you add on the tablet come back.** The reMarkable can insert a blank
  page into a PDF to write on — often where the actual thinking ends up. Such
  a page now comes back whole, as an image placed after the text it follows,
  and labelled as an added page rather than a stray remark.

### Fixed

- **An inserted page no longer shifts the annotations after it.** A page added
  in the middle pushed every following page down by one, so marks on later
  pages were quoted against the wrong part of the note. The plugin now reads
  which source page each device page actually shows, instead of assuming page
  N is page N.

## [0.21.0] - 2026-07-28

### Added

- **You decide what a mark means.** Under *Settings → What a pen mark
  becomes*, each of the three inline marks — a line through words, a loop
  around them, a line under them — can be set to strikethrough, bold, italic,
  underline, highlight, or left alone. The shapes are fixed, because that is
  what a pen can draw; what they mean is your convention. Margin bars always
  quote the lines they ran alongside and handwriting always comes back as an
  image, so those have no setting.

### Changed

- The README now documents every recognised mark: what to draw, how it is
  recognised, what you get, and the rules behind it — several strokes count as
  one strike-through, the baseline decides between striking and underlining,
  and marks side by side stay separate. It also says when anchoring is not
  possible and what happens instead.

## [0.20.0] - 2026-07-28

### Fixed

- **A strike-through drawn in several passes is one strike-through.** The
  tablet records every pass separately, so the same phrase came back marked
  two or three times — and a pass that sagged below the baseline was read as
  an underline, leaving text both struck and underlined, which it can never
  be. Passes over the same words on the same row are now joined, and a
  strike-through in the group decides the kind.
- **A line right on the baseline reads as a strike-through**, not an
  underline. Only ink clearly below the letters is an underline now.
- Two separate marks side by side on one line still stay two marks — joining
  needs real overlap, not proximity.

## [0.19.0] - 2026-07-28

### Fixed

- **Marks inside another mark render again.** 0.18.0 blamed the quotes around
  a struck sentence; they were not the cause. The real rule is that markdown
  is not parsed inside an inline HTML tag — and an underline has to be
  `<u>…</u>`, because markdown has no underline. So a `~~strike~~` written
  within it stayed on screen as tildes, and the same happened to a strike
  inside a highlight. A mark that falls inside an HTML wrapper now uses its
  own HTML tag (`<s>`, `<strong>`); a mark on its own stays plain markdown.

## [0.18.0] - 2026-07-28

### Fixed

- **Striking through a quoted sentence renders again.** Marking
  `"Laten we de cijfers maar eens bekijken."` produced `~~"Laten …"~~`, and
  Obsidian left the tildes visible as text: a markdown delimiter that opens
  against a quote instead of a word is not treated as a delimiter. Marks that
  use markdown delimiters now start and end on a letter or digit, so the
  quotes fall just outside the mark — same meaning, and it renders.
- A mark covering nothing but punctuation no longer leaves an empty `~~~~`
  behind.

## [0.17.0] - 2026-07-28

### Fixed

- **Pen marks land on the line you drew them on again.** Strike-throughs,
  underlines and circles were coming back about three text rows too low. The
  cause was in this plugin's own typesetter, not in the tablet: since 0.11.0
  the document title was drawn at the body text size instead of a title size,
  which shrank the title block by 49.7 pt. Any document sent before that
  change could no longer be reproduced faithfully, so every row on page 1 sat
  fifty points too high — and every mark landed three rows below where it was
  drawn. Existing annotations come out right without re-sending anything.
- **The document title is a title again**, 19 pt rather than the same size as
  the body text.
- **No more stray `~~` in the text.** A strike-through that ran half into a
  highlight closed inside it, and markdown left the marker visible
  ("maken en~~ investeren in"). Marks are now cut at the edges of whatever
  nests around them.

## [0.16.0] - 2026-07-27

### Fixed

- **Highlight colours come back as the colours you used.** Until now every
  highlight arrived in the same shade, because the field being read was the
  highlighter *tool*, not its colour. The device report settled it: the colour
  trails the highlighted text as a 32-bit BGRA value, and it is real RGB
  rather than an index into a palette — so the copy in your vault now shows
  the exact tint the tablet did. Confirmed against yellow, pink and light
  blue from a real account.

### Known

- Pen marks can still land on the wrong line. The explanation offered in
  0.15.0 — a shifted page view — is ruled out by the same report: the device
  records no zoom or pan at all. Every mark now names the words it landed on,
  so the next check needs no screenshots, only that list.

## [0.15.0] - 2026-07-27

### Changed

- **Diagnosis for pen marks that land on the wrong line.** Comparing the
  annotated PDF with the copy in the vault showed every pen mark sitting about
  three text rows too low, while its horizontal position was exact and text
  highlights — which are placed by their own text rather than by geometry —
  were perfect. Re-typesetting the note put a number on it: a constant 55.5 pt
  downward, the same at the top of the page as two thirds down. Constant and
  not proportional means the scale is right and the origin is not.
- The import report now records what is needed to fix that rather than guess
  at it: the raw ink bounds of every mark and where they land on the page, the
  view settings the device stores in `.content` (zoom mode, custom zoom,
  transform, and any unrecognised view field), and — around each highlight —
  the bytes before the text plus any float values inside the device's
  coordinate range. If a highlight carries its own rectangles, they are what
  will calibrate the pen marks on that page.

### Known

- Pen marks are still placed too low; this release measures the cause, it does
  not yet correct it.
- Highlight colours still come back as one colour. The field that carries them
  is not one of the ones read so far.

## [0.14.0] - 2026-07-27

### Added

- **Your notes are found by their id, not by where they sit.** Move or rename
  an annotated note in Obsidian and the link to the reMarkable survives: the
  plugin looks the note up by the `remarkable-id` in its frontmatter, updates
  the recorded path, and writes the annotation note next to the note's new
  location instead of the old one.
- **A note that changed after you sent it now says so.** The annotation block
  opens with a warning, the import report names it per note, and the closing
  notice counts them. Marks from an earlier version are still imported — they
  are real — but you can see that they describe the text as it was.
- The report also distinguishes a note that moved (found again by its id) from
  one that has disappeared from the vault entirely.

### Changed

- When the source check knows a note was edited, the report says that plainly
  instead of offering "changed, or sent as EPUB" and leaving you to guess.

## [0.13.0] - 2026-07-27

### Added

- **The import report now says what ended up in your vault**, not just what
  was read from the tablet. Per note: whether it became an annotated copy of
  your text or fell back to a summary — and if it fell back, why. The previous
  version could quietly write a summary while reporting a successful import,
  which is exactly how a broken alignment stayed hidden for two test rounds.

### Changed

- More detail on highlights in the report, aimed at pinning down the colour:
  every tagged number in the highlight record, both widths, plus the bytes
  following the highlighted text. The colour is in none of the fields read so
  far, so it has to be in there.

## [0.12.1] - 2026-07-27

### Fixed

- **The annotated copy never appeared.** 0.12.0 gave up on lining the note up
  with the marks and fell back to the old summary without saying so, which
  looked like an import that did nothing. The cause: the document sent to the
  tablet opens with a title the note itself does not carry, and a word from
  that title matched somewhere further down the note — dragging the alignment
  past everything above it. Matching is now bounded to the immediate
  neighbourhood, and it first looks for the point where the two texts really
  meet.

## [0.12.0] - 2026-07-27

### Changed

- **The annotated copy is now your note, marked up — not a rebuild of it.**
  The previous version reassembled the text from the PDF layout, and so
  inherited everything the typesetter throws away: bold, italics, links, en
  dashes, heading levels. Now the plugin takes the note exactly as it is and
  only *inserts* markup where the pen touched. Your formatting is untouched,
  because it is never rewritten.

### Fixed

- **Overlapping marks of the same kind produced `~~~~`**, which markdown reads
  as nothing at all. Ranges of one kind are merged before the markup goes in.
- Headings kept their own level instead of being pushed one deeper.
- Frontmatter stays frontmatter instead of coming back as a bullet list.
- Lists keep their spacing and their numbering.

### Note

Highlight colours still come back as plain `==highlights==` on this firmware:
the field that looked like the colour reads the same value for yellow, blue
and pink, so it is the highlighter tool, not the colour. The import report
now lists every numeric field in the highlight record, which is what will
identify the real one.

## [0.11.0] - 2026-07-26

### Changed

- **Annotations now come back as an annotated copy of the document**, instead
  of a list of fragments. You get the whole text — headings, lists, quotes —
  with your marks in place:

  | On the tablet | In your vault |
  |---|---|
  | Highlight | `==text==`, or an inline `<mark>` in the colour you used |
  | Line through words | `~~text~~` |
  | Line under words | `<u>text</u>` |
  | Loop around words | `**text**` |
  | Bar in the margin | that paragraph becomes a `>` quote |
  | Anything else | a remark callout at that spot, with the ink |

  A list of fragments makes you rebuild the argument in your head; the text
  with the marks in it *is* the reading. Writing into the source note itself
  keeps the old summary form — a full copy there would double the note.

- **Only four shapes are read now**: strike-through, underline, circle and a
  bar in the margin. Arrows were guessed far too eagerly — plain handwriting
  kept coming back as "Arrow at …" — so anything that is not clearly one of
  the four is a remark at that spot.

### Fixed

- **Highlights are ordered by page**, not by the order the cloud happened to
  return the page files in.
- Highlight colours are carried through to the copy.

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
