import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function writeConversationTranscript(
  stateDir: string,
  relativePath = 'projects/-workspace/conversation.jsonl',
  content = '{"type":"user","message":"persisted conversation"}\n',
): string {
  const path = resolve(stateDir, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}
