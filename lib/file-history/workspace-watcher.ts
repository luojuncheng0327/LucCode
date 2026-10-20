// 工作区常驻递归监听：捕获绕过 ResourceIO 的写入（shell、桌面编辑器 IPC 直写、外部程序）。
// 每个工作区只向操作系统注册一个递归监听（macOS FSEvents / Windows RDCW / Linux inotify），
// 描述符开销与文件数无关；过滤放在事件回调里做。此前的实现是每个文件单独监听，
// 大工作区会把进程的文件描述符表撑满，撑满之后连开子进程都会直接失败。
// 已知取舍：递归监听不跟随 symlink 目录，与周期性基线扫描一致（扫描本就不进 symlink）。
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { isIgnoredRelPath } from "./text-file-policy.ts";

export type WorkspaceWatcher = {
  ready: Promise<void>;
  close: () => Promise<void>;
};

export function createWorkspaceWatcher({ root, onChanged, onDeleted, onError }: {
  root: string;
  onChanged: (relPath: string) => void;
  onDeleted: (relPath: string) => void;
  onError: (err: Error) => void;
}): WorkspaceWatcher {
  let resolvedRoot = root;
  try { resolvedRoot = fs.realpathSync(root); } catch { /* 不存在时保持原样，watch 会报错 */ }

  const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

  const handleEvent = (_eventType: string, filename: string | Buffer | null) => {
    if (filename == null) {
      // 平台在事件里没给出文件名时无从定位，交给上层记日志并触发基线扫描兜底
      onError(new Error("workspace watch event without filename"));
      return;
    }
    // 递归事件的 filename 已是相对 root 的路径；Windows 用反斜杠，统一成 posix 形式
    const rel = String(filename).split(path.sep).join("/");
    if (!rel) return;
    // 只按父目录段判定，绝不把末段当目录，避免误伤 .gitignore / .env 这类点开头文件
    if (isIgnoredRelPath(rel)) return;

    const absPath = path.join(resolvedRoot, ...rel.split("/"));
    fsp.stat(absPath).then(
      (stat) => {
        // 目录本身的变动由基线扫描兜底，这里只关心文件
        if (stat.isFile()) onChanged(rel);
      },
      () => {
        // 路径已消失（或不可访问）：按删除上报，由上层再过策略表
        onDeleted(rel);
      },
    );
  };

  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(resolvedRoot, { recursive: true, persistent: true }, handleEvent);
  } catch (err) {
    // 监听建不起来时降级成"只靠基线扫描"，报错要看得见但不能炸掉启动
    queueMicrotask(() => onError(toError(err)));
    return { ready: Promise.resolve(), close: async () => {} };
  }

  watcher.on("error", (err: unknown) => onError(toError(err)));

  return {
    ready: Promise.resolve(),
    close: async () => { watcher.close(); },
  };
}
