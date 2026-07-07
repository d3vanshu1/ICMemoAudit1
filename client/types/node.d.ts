// Override @types/node to prevent Node.js globals in client code
// This prevents accidental usage of Node.js APIs that won't exist in the browser

declare const process: never;
declare const Buffer: never;
declare const __dirname: never;
declare const __filename: never;
declare const global: never;
declare const require: never;
