/// <reference types="svelte" />

// Side-effect CSS imports (e.g. `@xterm/xterm/css/xterm.css`) are handled by
// Vite at build time; declare them so the TypeScript / svelte-check pass does
// not error on the missing module.
declare module '*.css';
