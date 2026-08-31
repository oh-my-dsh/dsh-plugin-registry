# Discovery candidates

`candidates.json` is generated from public GitHub repository metadata, immutable root-file evidence,
and configurable star-ranked sampling. It is an unreviewed lead list, not a registration database.

The crawler combines paired DSH topics with GitHub code search for `package.json#dsh.bundle`. It ranks
immutable code evidence ahead of topic-only evidence, then ranks by stars inside each evidence tier and
inspects the selected percentage. This avoids a popular unrelated repository outranking a smaller plugin
that exposes a real Harness bundle marker. `classification` has three evidence levels:

- `declared`: a root `dsh-plugin.naming.json` uses `dsh-plugin-naming/v1`;
- `bundle`: a root `package.json` contains `dsh.bundle`;
- `topical`: only GitHub topic or search-text evidence was found.

None of these levels reserves an ID. Move a candidate into `registry/entries/` only through a reviewed
registration PR with a pinned source commit and complete contextual claims. The crawler reads JSON and
metadata through the GitHub API; it never clones, installs, imports, or executes candidate code.

A `dsh.bundle` package provides package-identity evidence, but its patch path does not by itself prove
Loader, service, tool, command, Skill, event, settings, or route IDs. The crawler records those runtime
names only when the same directory contains a valid `dsh-plugin.naming.json`; reviewers must not infer
formal claims from prose, patch comments, or repository names.

`--coverage` is a percentage of the evidence-ranked discovered sample after the `--max-results` cap. It
is not a claim about the top percentile of every repository on GitHub. Star count only prioritizes
inspection within an evidence tier and is not evidence of compatibility, safety, maintenance quality,
or ownership.
