---
name: json-schema-emails
description: Canonical shape of the .workflow/emails/emails.json file passed between the fetch and summarize states — required fields (sender, recipient, subject, date, body), types, and field semantics. Read this whenever you write or read emails.json so producer and consumer agree on the shape.
---

# emails.json schema

The fetch state writes `.workflow/emails/emails.json` and the summarize
state reads it. The file is a single JSON array of email objects. The
canonical JSON Schema is in the sibling file `schema.json`; this document
explains the fields and their semantics.

## Top-level shape

A JSON array. Each element is an email object. The array order is
preservation order — the consumer renders emails in the order they
appear, so the producer should write them in the order it wants them
rendered (typically newest-first as returned by the API).

## Email object fields

All fields are required and must be strings unless noted.

- `sender` — the From address. Format `Name <addr@example.com>` if the
  source provides a display name, else the bare address.
- `recipient` — the To addresses, comma-separated. If the source has
  multiple To recipients they are joined with `, ` (comma + space). CC
  and BCC are not represented in this schema.
- `subject` — the email subject line, verbatim. Empty string is allowed
  if the source has no subject; do not substitute "(no subject)".
- `date` — the date as it appears in the source headers (RFC 2822 or
  whatever the API returns). Do not reformat or normalize the timezone.
- `body` — the message body as plain text. If the source is HTML, the
  producer is responsible for stripping tags before writing. Newlines
  are preserved; tabs are replaced with two spaces.

## Validating

The sibling `schema.json` is a draft-2020-12 JSON Schema. Tooling that
needs to validate the file structurally should load it from there; this
document is the human-readable companion.
