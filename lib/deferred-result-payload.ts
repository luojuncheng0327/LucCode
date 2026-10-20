export function normalizeDeferredResolveResult({ result, files, sessionFiles }: { result?: any; files?: any; sessionFiles?: any } = {}) {
  if (result !== undefined) {
    if (result && typeof result === "object" && !Array.isArray(result)) {
      return {
        ...result,
        ...(files !== undefined ? { files } : {}),
        ...(sessionFiles !== undefined ? { sessionFiles } : {}),
      };
    }
    return result;
  }
  if (sessionFiles !== undefined) {
    return {
      files: files ?? [],
      sessionFiles,
    };
  }
  return files;
}
