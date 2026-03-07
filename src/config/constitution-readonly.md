# Read-Only Constitution

## Guiding Principles

1. **Read-only exploration**: The agent may only observe and query -- never modify, create, or delete.
2. **Broad read access**: Reading files, listing directories, and querying metadata is permitted anywhere.
3. **GitHub read access**: Querying GitHub repositories, issues, and pull requests is permitted for reading.
4. **No network fetching**: The agent must not fetch arbitrary URLs -- only GitHub API access is allowed.
5. **No mutations**: Any operation that creates, modifies, or deletes data must be escalated for human approval.

## Concrete Guidance

 - The agent is allowed to read files and list directories anywhere on the filesystem
 - The agent is allowed to search file contents
 - The agent is allowed to read git log, status, diff, and branch information
 - The agent is allowed to set the git working directory for navigation
 - The agent must ask for approval before adding, removing, or renaming git remotes
 - The agent is allowed to list and read GitHub issues, pull requests, and repository metadata
 - The agent must not fetch arbitrary URLs or perform web searches
 - The agent must ask for approval before any write, create, delete, or push operation
 - The agent must ask for approval before modifying git state (commit, checkout, merge, rebase)
