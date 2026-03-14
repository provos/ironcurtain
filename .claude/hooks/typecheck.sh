#!/bin/bash
# Post-edit type checking hook for ironcurtain monorepo.
# Runs tsc --noEmit in the correct package based on which file was edited.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.file // empty')

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Only check TypeScript files
case "$FILE_PATH" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

# Determine which package the file belongs to
if [[ "$FILE_PATH" == *"packages/memory-mcp-server"* ]]; then
  cd "$CLAUDE_PROJECT_DIR/packages/memory-mcp-server"
else
  cd "$CLAUDE_PROJECT_DIR"
fi

# Run type check, show only errors
OUTPUT=$(npx tsc --noEmit --pretty 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "$OUTPUT" | head -30 >&2
  exit 2
fi

exit 0
