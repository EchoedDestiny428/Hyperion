// Vite's "?raw" suffix imports a file's contents as a string. This tells
// TypeScript what such an import looks like.
// https://vite.dev/guide/assets#importing-asset-as-string
declare module '*.wgsl?raw' {
  const source: string;
  export default source;
}
