# patches/

Empty on purpose. This project consumes upstream Joplin only through its published interfaces (ADR-0009, `CLAUDE.md` golden rules).

If a change to upstream is ever unavoidable, it goes here as one patch file per change, together with:
- a written justification (why the published interfaces are not enough),
- a link to the upstream pull request or issue that proposes the same change,
- the pinned upstream version it applies to (`upstream/joplin-version.json`).

Remove the patch as soon as upstream ships the change.
