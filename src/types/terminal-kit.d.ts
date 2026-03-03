declare module 'terminal-kit' {
  // terminal-kit is a CJS module; when dynamically imported in ESM,
  // the named export `terminal` lives on the `default` object.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _default: { terminal: any; [key: string]: any };
  export default _default;
}
