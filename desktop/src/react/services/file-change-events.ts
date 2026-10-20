type FileChangeHandler = (filePath: string) => void;

export function subscribeResourceFileChanges(_handler: FileChangeHandler): () => void {
  return () => {};
}
