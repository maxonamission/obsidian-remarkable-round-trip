# Contributing

Thanks for being here. This is a small project maintained by one person
in the evenings, and every report, idea and patch is read.

Before you spend real time on something, there are two things about this
repository worth knowing.

## This repository is a mirror

Development happens in a private repository. Each release copies the
source here wholesale — the previous contents are removed and replaced.

That has one consequence you need to know about: **a pull request merged
here would be undone by the next release.** Nothing personal about your
change; the plumbing simply overwrites everything.

So pull requests are not merged here. They are read, discussed here in
the open, and anything accepted is carried into the development
repository **with your commits and your authorship intact**, and credited
in the changelog. The pull request is then closed with a link to the
release it landed in.

If that feels unusual: it is. It is the price of developing in private
and publishing in the open, and it is on me rather than on you.

## Open an issue before building something large

Small fixes are welcome as a pull request straight away.

For anything bigger, please open an issue first and sketch what you have
in mind. Not as a formality — it is so you don't spend an evening on
something that turns out not to fit, which is a miserable way to
discover a project's boundaries.

The boundary most worth knowing: this plugin is a **round-trip for
reviewing**, not a general-purpose sync tool. You choose what goes to
the tablet and when, and you choose what comes back. Features that make
the plugin decide those things for you — continuous syncing, mirroring
deletions, automatically replacing a document you may still have
unimported ink on — run against the grain of the design, however useful
they seem. That is a deliberate choice, and one worth arguing with in an
issue before it becomes code.

## Practical notes

If you do send a pull request:

- **Base it on the current `main`.** Releases land here as squashed
  snapshots, so an old base produces a diff full of phantom deletions.
- **Don't run a formatter over the code.** There is no Prettier or
  similar config here; lines run to roughly 100 columns. Reformatting
  buries the actual change in rewrapped text.
- **Keep commits focused.** One idea per commit makes it possible to
  accept part of a contribution while still discussing the rest.
- **Run the checks**: `npm test`, `npm run lint` and `npm run build`.
  The build refuses Node built-ins on purpose — the plugin has to work
  on mobile, so everything in the main path uses web APIs only.
- Changes that touch the reMarkable API or token handling get an extra
  security pass before they land, so those take a little longer.

## Reporting a bug

The import writes a full report to `reMarkable Round-Trip log.md` in your
vault and copies it to your clipboard. Attaching that report answers most
of the questions I would otherwise have to ask. It contains file names,
page numbers and stroke geometry — no document contents — but do read it
over before posting if you work with sensitive material.

## License

This plugin is GPL-3.0-or-later. Contributions are made under the same
license: opening a pull request against this repository licenses your
work under the project's terms, as GitHub's terms of service describe.
A `Signed-off-by` line on your commits is appreciated but not required.
