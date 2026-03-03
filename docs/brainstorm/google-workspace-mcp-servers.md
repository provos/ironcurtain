# Google Workspace MCP Servers — Research

**Date:** 2026-03-03
**Status:** Research
**Purpose:** Evaluate available Google Workspace MCP servers for potential IronCurtain integration

## Context

IronCurtain's architecture was designed to mediate access to services like Gmail, Calendar, and Google Docs. This document surveys the MCP server landscape for Google Workspace to understand what's available and whether the tool surfaces are granular enough for policy enforcement.

---

## Key Finding

There is **no official Google MCP server that interacts with Gmail, Calendar, Docs, or Sheets user data**. The official `workspace-developer.goog/mcp` endpoint is documentation-search only. The `gemini-cli-extensions/workspace` server is the closest to official (referenced from `google/mcp`, Apache-licensed, Google-adjacent org).

---

## Available Servers

### 1. gemini-cli-extensions/workspace (Google-adjacent, TypeScript)

- **Repository**: [github.com/gemini-cli-extensions/workspace](https://github.com/gemini-cli-extensions/workspace)
- **Stars**: 401 | **Forks**: 64 | **License**: Apache 2.0
- **Updated**: 2026-03-03 (actively maintained)
- **Language**: TypeScript
- **Transport**: stdio
- **Authentication**: OAuth 2.0 (browser-based login)
- **Services**: Calendar, Drive, Gmail, Docs, Sheets, Slides, Chat, People (Contacts), Time
- **Tools**: 53 across 10 services

#### Tool List

**Auth (2):** `auth.clear`, `auth.refreshToken`

**Gmail (11):** `gmail.search`, `gmail.get`, `gmail.downloadAttachment`, `gmail.modify`, `gmail.batchModify`, `gmail.modifyThread`, `gmail.send`, `gmail.createDraft`, `gmail.sendDraft`, `gmail.listLabels`, `gmail.createLabel`

**Calendar (8):** `calendar.list`, `calendar.createEvent`, `calendar.listEvents`, `calendar.getEvent`, `calendar.findFreeTime`, `calendar.updateEvent`, `calendar.respondToEvent`, `calendar.deleteEvent`

**Drive (4):** `drive.findFolder`, `drive.createFolder`, `drive.search`, `drive.downloadFile`

**Docs (8):** `docs.create`, `docs.insertText`, `docs.find`, `docs.move`, `docs.getText`, `docs.appendText`, `docs.replaceText`, `docs.extractIdFromUrl`

**Sheets (4):** `sheets.getText`, `sheets.getRange`, `sheets.find`, `sheets.getMetadata`

**Slides (5):** `slides.getText`, `slides.find`, `slides.getMetadata`, `slides.getImages`, `slides.getSlideThumbnail`

**Chat (8):** `chat.listSpaces`, `chat.findSpaceByName`, `chat.sendMessage`, `chat.getMessages`, `chat.sendDm`, `chat.findDmByEmail`, `chat.listThreads`, `chat.setUpSpace`

**People (3):** `people.getUserProfile`, `people.getMe`, `people.getUserRelations`

**Time (3):** `time.getCurrentDate`, `time.getCurrentTime`, `time.getTimeZone`

---

### 2. taylorwilsdon/google_workspace_mcp (Community, Python)

- **Repository**: [github.com/taylorwilsdon/google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp)
- **Website**: [workspacemcp.com](https://workspacemcp.com)
- **Stars**: 1,643 | **Forks**: 492 | **License**: MIT
- **Updated**: 2026-03-03 (very actively maintained)
- **Language**: Python
- **Package**: `workspace-mcp` on PyPI
- **Transport**: stdio and Streamable HTTP
- **Authentication**: OAuth 2.0 & 2.1 with automatic token refresh, multi-user support
- **Services**: Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms, Tasks, Contacts, Chat, Custom Search, Apps Script (12 services)
- **Tools**: 129 total (tiered: `--tool-tier core`, `extended`, `complete`)

#### Tool List

**Gmail (15):** `search_gmail_messages`, `get_gmail_message_content`, `get_gmail_messages_content_batch`, `send_gmail_message`, `get_gmail_thread_content`, `modify_gmail_message_labels`, `list_gmail_labels`, `list_gmail_filters`, `manage_gmail_label`, `manage_gmail_filter`, `draft_gmail_message`, `get_gmail_threads_content_batch`, `batch_modify_gmail_message_labels`, `get_gmail_attachment_content`, `start_google_auth`

**Calendar (3):** `list_calendars`, `get_events`, `manage_event`

**Drive (16):** `search_drive_files`, `get_drive_file_content`, `get_drive_file_download_url`, `create_drive_file`, `create_drive_folder`, `import_to_google_doc`, `get_drive_shareable_link`, `list_drive_items`, `copy_drive_file`, `update_drive_file`, `manage_drive_access`, `set_drive_file_permissions`, `get_drive_file_permissions`, `check_drive_file_public_access`

**Docs (18):** `get_doc_content`, `create_doc`, `modify_doc_text`, `search_docs`, `find_and_replace_doc`, `list_docs_in_folder`, `insert_doc_elements`, `update_paragraph_style`, `get_doc_as_markdown`, `export_doc_to_pdf`, `insert_doc_image`, `update_doc_headers_footers`, `batch_update_doc`, `inspect_doc_structure`, `create_table_with_data`, `debug_table_structure`, `list_document_comments`, `manage_document_comment`

**Sheets (10):** `read_sheet_values`, `modify_sheet_values`, `create_spreadsheet`, `list_spreadsheets`, `get_spreadsheet_info`, `format_sheet_range`, `create_sheet`, `list_spreadsheet_comments`, `manage_spreadsheet_comment`, `manage_conditional_formatting`

**Slides (7):** `create_presentation`, `get_presentation`, `batch_update_presentation`, `get_page`, `get_page_thumbnail`, `list_presentation_comments`, `manage_presentation_comment`

**Forms (6):** `create_form`, `get_form`, `list_form_responses`, `set_publish_settings`, `get_form_response`, `batch_update_form`

**Tasks (6):** `list_tasks`, `get_task`, `manage_task`, `list_task_lists`, `get_task_list`, `manage_task_list`

**Contacts (8):** `search_contacts`, `get_contact`, `list_contacts`, `manage_contact`, `list_contact_groups`, `get_contact_group`, `manage_contacts_batch`, `manage_contact_group`

**Chat (6):** `get_messages`, `send_message`, `search_messages`, `create_reaction`, `list_spaces`, `download_chat_attachment`

**Custom Search (2):** `search_custom`, `get_search_engine_info`

**Apps Script (9):** `list_script_projects`, `get_script_project`, `get_script_content`, `create_script_project`, `update_script_content`, `run_script_function`, `list_deployments`, `manage_deployment`, `list_script_processes`

---

### 3. @presto-ai/google-workspace-mcp (Community, TypeScript/npm)

- **Repository**: [github.com/jrenaldi79/google-workspace-mcp](https://github.com/jrenaldi79/google-workspace-mcp)
- **npm**: `@presto-ai/google-workspace-mcp`
- **Stars**: 1 | **License**: unspecified
- **Language**: TypeScript
- **Transport**: stdio (`npx -y @presto-ai/google-workspace-mcp`)
- **Authentication**: OAuth 2.0 (browser-based)
- **Services**: Gmail, Calendar, Drive, Docs, Sheets, Slides, Chat, People, Time
- **Tools**: 53 (nearly identical surface to gemini-cli-extensions/workspace)

---

### 4. MarkusPfundstein/mcp-gsuite (Community, Python)

- **Repository**: [github.com/MarkusPfundstein/mcp-gsuite](https://github.com/MarkusPfundstein/mcp-gsuite)
- **Stars**: 477 | **Forks**: 96 | **License**: MIT
- **Updated**: 2026-02-28
- **Package**: `mcp-gsuite` on PyPI
- **Transport**: stdio
- **Authentication**: OAuth 2.0
- **Services**: Gmail and Calendar only
- **Tools**: 12

**Gmail (8):** `query_gmail_emails`, `get_gmail_email`, `bulk_get_gmail_emails`, `create_gmail_draft`, `delete_gmail_draft`, `reply_gmail_email`, `get_gmail_attachment`, `bulk_save_gmail_attachments`

**Calendar (4):** `list_calendars`, `get_calendar_events`, `create_calendar_event`, `delete_calendar_event`

---

### 5. aaronsb/google-workspace-mcp (Community, TypeScript)

- **Repository**: [github.com/aaronsb/google-workspace-mcp](https://github.com/aaronsb/google-workspace-mcp)
- **Stars**: 120 | **Forks**: 34 | **License**: MIT
- **Updated**: 2026-02-24
- **Transport**: stdio (Docker container recommended)
- **Authentication**: OAuth 2.0 with automatic token refresh
- **Services**: Gmail, Calendar, Drive, Contacts
- **Tools**: 22

---

### 6. Other Smaller Servers

- **j3k0/mcp-google-workspace** — 21 stars, TypeScript/npm, Gmail + Calendar, 14 tools
- **epaproditus/google-workspace-mcp-server** — 27 stars, JavaScript, Gmail + Calendar, 8 tools
- **@modelcontextprotocol/server-gdrive** — archived Anthropic reference server, Google Drive read-only, 1 tool

---

## API Surface Analysis

### Policy Granularity

All servers expose **separate tools for read vs. send vs. modify**, making IronCurtain policy rules straightforward:

| Operation | Separate tool? | Example |
|-----------|---------------|---------|
| Read email | Yes | `gmail.get` / `search_gmail_messages` |
| Send email | Yes | `gmail.send` / `send_gmail_message` |
| Draft email | Yes | `gmail.createDraft` / `draft_gmail_message` |
| Modify labels | Yes | `gmail.modify` / `modify_gmail_message_labels` |
| Read calendar | Yes | `calendar.listEvents` / `get_events` |
| Create event | Yes | `calendar.createEvent` / `manage_event` |
| Read docs | Yes | `docs.getText` / `get_doc_content` |
| Write docs | Yes | `docs.insertText` / `modify_doc_text` |
| Search drive | Yes | `drive.search` / `search_drive_files` |
| Create files | Yes | `drive.createFolder` / `create_drive_file` |
| Manage permissions | Yes | `manage_drive_access` / `set_drive_file_permissions` |

### Semantic Understanding

Tool arguments include:
- **Email**: recipient addresses (to, cc, bcc), subject, body, thread IDs, label names
- **Calendar**: event titles, attendees, start/end times, calendar IDs
- **Drive**: file names, folder paths, permission levels, sharing settings
- **Docs**: document IDs, text content, formatting

This is sufficient for IronCurtain's ArgumentRole system to classify arguments (e.g., `email-recipient`, `calendar-attendee`, `drive-path`) and write policy rules like "allow sending email to contacts, escalate for unknown recipients."

### Key Gaps

- **No contact-list lookup within the MCP server** — policy rules like "allow email to contacts" would need IronCurtain to maintain a contacts cache or make a separate `search_contacts` call during policy evaluation
- **taylorwilsdon's `manage_event`** consolidates create/update/delete into one tool — less granular for policy (would need argument inspection to distinguish operations)
- **Attachment handling** varies significantly across servers

---

## Recommendation for IronCurtain

| Use case | Best option |
|----------|------------|
| TypeScript/npm, broadest coverage | `gemini-cli-extensions/workspace` (53 tools, Google-adjacent) or `@presto-ai/google-workspace-mcp` |
| Maximum tool coverage | `taylorwilsdon/google_workspace_mcp` (129 tools, Python) |
| Gmail + Calendar focused | `MarkusPfundstein/mcp-gsuite` (12 tools, Python, well-tested) |
| Docker-based deployment | `aaronsb/google-workspace-mcp` (22 tools, Docker-first) |

For IronCurtain's architecture, the TypeScript stdio servers (`gemini-cli-extensions/workspace` or `@presto-ai`) integrate most naturally. The Python `taylorwilsdon` server is the richest but adds a Python runtime dependency (acceptable in Docker mode).

---

## Sources

- [Google MCP Repository](https://github.com/google/mcp)
- [gemini-cli-extensions/workspace](https://github.com/gemini-cli-extensions/workspace)
- [taylorwilsdon/google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp) / [workspacemcp.com](https://workspacemcp.com)
- [MarkusPfundstein/mcp-gsuite](https://github.com/MarkusPfundstein/mcp-gsuite)
- [aaronsb/google-workspace-mcp](https://github.com/aaronsb/google-workspace-mcp)
- [@modelcontextprotocol/server-gdrive (archived)](https://github.com/modelcontextprotocol/servers-archived/tree/main/src/gdrive)
