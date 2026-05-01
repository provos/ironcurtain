---
name: email-formatting
description: Markdown formatting conventions for email summary documents — heading depth, list style, line length, emoji policy, and a mandatory provenance footer. Read this when producing a markdown report that summarizes one or more email messages so the output matches the project's house style.
---

# Email formatting conventions

Use these conventions whenever you write a markdown file that summarizes
email content.

## Heading depth

- The document has exactly one `#` heading at the top: the report title.
- Each individual email gets a `##` heading whose text is the email subject.
- Do not use `###` or deeper for per-email metadata; use a bullet list instead.

## Per-email metadata

For each email, render metadata as an unordered list immediately under the
`##` subject heading, in this order:

- `From: <sender>`
- `To: <recipient(s), comma-separated>`
- `Date: <as it appears in the source, no reformatting>`
- `Summary: <1-2 sentences in prose>`

## Line length and whitespace

- Soft-wrap at roughly 80 columns. Don't hard-break inside a sentence.
- Exactly one blank line between sections; never two or more.
- No trailing whitespace at end of lines.

## Emoji policy

Do not use emoji in summary documents. They render inconsistently across
mail clients that may consume the markdown downstream.

## Preamble and outro

There is no preamble (no "Here is the summary..." opener) and no outro
(no "Let me know if..." closer). The document opens with the `#` title.

## Provenance footer (required)

The document MUST end with the literal HTML comment marker on a line by
itself, separated from the last email's `Summary:` bullet by exactly one
blank line:

    <!-- email-summary/v1 -->

This marker is how downstream tooling identifies the generator and
schema version. Producers that omit it are non-compliant; producers
that change the spelling, casing, or version segment break parsers
that depend on the literal string. Do not localize, prettify, or
expand the marker — it is a machine-readable token, not human prose.
