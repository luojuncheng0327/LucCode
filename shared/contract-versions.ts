import contractVersions from "./contract-versions.json";

// ESM entry for the renderer/browser graph. The literal values live in
// shared/contract-versions.json (the single source); the Node-side
// shared/contract-versions.cjs re-exports the same JSON for require()
// consumers. Importing the JSON directly (instead of the .cjs) keeps the
// browser dependency graph free of CommonJS: Vite's dev server serves source
// files individually and does NOT synthesize a `default` export for an
// un-pre-bundled .cjs, so a `default` import of the .cjs breaks the whole
// static import graph in dev; JSON is transformed to ESM natively by Vite in
// both dev and build. No duplicated literals — same three constants, one source.
export const { PRELOAD_API_VERSION, SERVER_PROTOCOL_VERSION, DATA_EPOCH } = contractVersions;
