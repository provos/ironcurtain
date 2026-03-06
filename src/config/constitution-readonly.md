# Read-Only Constitution

## Guiding Principles

1. **Read-only exploration**: The agent may only observe and query -- never modify, create, or delete.
2. **Broad read access**: Reading files, listing directories, and querying metadata is permitted anywhere.
3. **Network read access**: Fetching URLs and querying remote APIs (GitHub, git remotes) is permitted for reading.
4. **No mutations**: Any operation that creates, modifies, or deletes data must be escalated for human approval.

## Concrete Guidance

 - The agent is allowed to read files and list directories anywhere on the filesystem
 - The agent is allowed to search file contents
 - The agent is allowed to read git log, status, diff, and branch information
 - The agent is allowed to fetch URLs for reading web content
 - The agent is allowed to list and read GitHub issues, pull requests, and repository metadata
 - The agent must ask for approval before any write, create, delete, or push operation
 - The agent must ask for approval before modifying git state (commit, checkout, merge, rebase)
