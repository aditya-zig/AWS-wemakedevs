declare module 'node:test' {
  const test: any;
  export default test;
  export const describe: any;
  export const it: any;
  export const beforeEach: any;
}
declare module 'node:assert/strict' { const assert: any; export default assert; }
declare module 'node:crypto' { export const createHash: any; export const createHmac: any; export const randomUUID: any; export const timingSafeEqual: any; }
declare module 'node:fs/promises' { export const mkdir: any; export const readFile: any; export const writeFile: any; export const rename: any; }
declare module 'node:path' { export const dirname: any; export const join: any; }
declare module 'node:http' { export const createServer: any; export type IncomingMessage = any; export type ServerResponse = any; export type Server = any; export const request: any; }
declare module 'node:url' { export const URL: any; }
declare var process: any;

declare var Buffer: any;
