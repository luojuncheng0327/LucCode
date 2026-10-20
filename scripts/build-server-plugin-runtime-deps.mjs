import fs from "fs";
import { builtinModules } from "module";
import path from "path";
import ts from "typescript";

export const BUNDLED_PLUGIN_ALLOWED_HOST_DIRS = ["core", "lib", "shared"];

const PLUGIN_RUNTIME_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts"]);
const TRACEABLE_SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts"]);
const IGNORED_RUNTIME_DIRS = new Set(["tests", "__tests__", "node_modules"]);
const RESOLVE_EXTENSIONS = [".ts", ".js", ".mjs", ".cjs", ".json"];
const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function isNodeModulesRelativePath(relativePath) {
  return relativePath.split(/[\\/]/).includes("node_modules");
}

function isPluginRuntimeEntry(relativePath) {
  const parts = relativePath.split(/[\\/]/);
  if (parts.some((part) => IGNORED_RUNTIME_DIRS.has(part))) return false;
  const base = parts.at(-1) || "";
  if (/\.(?:test|spec)\.[cm]?js$/i.test(base)) return false;
  return PLUGIN_RUNTIME_EXTENSIONS.has(path.extname(base));
}

function isTraceableSourceFile(filePath) {
  return TRACEABLE_SOURCE_EXTENSIONS.has(path.extname(filePath));
}

function isRelativeSpecifier(specifier) {
  return specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");
}

function packageNameFromSpecifier(specifier) {
  if (!specifier || isRelativeSpecifier(specifier) || path.isAbsolute(specifier)) return null;
  if (NODE_BUILTINS.has(specifier)) return null;
  const parts = specifier.split("/");
  if (!parts[0]) return null;
  if (!parts[0].startsWith("@")) return parts[0];
  return parts[1] ? `${parts[0]}/${parts[1]}` : parts[0];
}

function scriptKindForFile(filePath) {
  switch (path.extname(filePath)) {
    case ".ts":
      return ts.ScriptKind.TS;
    case ".mjs":
    case ".cjs":
    case ".js":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.Unknown;
  }
}

function stringLiteralValue(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
    return node.text;
  }
  return null;
}

function listPluginRuntimeEntries(rootDir) {
  const pluginsDir = path.join(rootDir, "plugins");
  if (!fs.existsSync(pluginsDir)) return [];
  const entries = [];

  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      const relative = path.relative(pluginsDir, fullPath);
      if (entry.isDirectory()) {
        if (IGNORED_RUNTIME_DIRS.has(entry.name)) continue;
        visit(fullPath);
      } else if (entry.isFile() && isPluginRuntimeEntry(relative)) {
        entries.push(fullPath);
      }
    }
  }

  visit(pluginsDir);
  return entries.sort();
}

function extractRuntimeImportSpecifiers(filePath) {
  if (!isTraceableSourceFile(filePath)) return [];
  const sourceText = fs.readFileSync(filePath, "utf-8");
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForFile(filePath),
  );
  const specifiers = [];

  function add(value) {
    if (typeof value === "string" && value.length > 0) specifiers.push(value);
  }

  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      if (!node.importClause?.isTypeOnly) add(stringLiteralValue(node.moduleSpecifier));
      return;
    }
    if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly) add(stringLiteralValue(node.moduleSpecifier));
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference;
      if (!node.isTypeOnly && ts.isExternalModuleReference(ref) && ref.expression) {
        add(stringLiteralValue(ref.expression));
      }
      return;
    }
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const firstArg = node.arguments[0];
      if (
        expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(expression) && expression.text === "require")
      ) {
        add(stringLiteralValue(firstArg));
      }
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return specifiers;
}

function existingFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function existingDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function resolveRelativeRuntimeImport(fromFile, specifier) {
  const basePath = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [];
  if (path.extname(basePath)) {
    candidates.push(basePath);
  } else {
    for (const ext of RESOLVE_EXTENSIONS) candidates.push(`${basePath}${ext}`);
  }
  if (existingDirectory(basePath)) {
    for (const ext of RESOLVE_EXTENSIONS) candidates.push(path.join(basePath, `index${ext}`));
  }
  return candidates.find(existingFile) || null;
}

function assertInsideRoot(rootDir, filePath, fromFile, specifier) {
  const relative = path.relative(rootDir, filePath);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
  throw new Error(
    `[build-server] bundled plugin import resolves outside server root: ${specifier} from ${path.relative(rootDir, fromFile)}`,
  );
}

function assertAllowedHostDependency(relativePath, allowedHostDirs) {
  const topLevelDir = relativePath.split(/[\\/]/)[0];
  if (allowedHostDirs.includes(topLevelDir)) return;
  throw new Error(
    `[build-server] bundled plugin imports unsupported host runtime dependency: ${relativePath}. `
      + `Allowed roots: ${allowedHostDirs.join(", ")}`,
  );
}

function collectBundledPluginRuntimeGraph({ rootDir, allowedHostDirs }) {
  const resolvedRootDir = path.resolve(rootDir);
  const pluginEntries = listPluginRuntimeEntries(resolvedRootDir);
  const dependencies = new Set();
  const packages = new Set();
  const queue = [...pluginEntries];
  const visited = new Set();

  while (queue.length > 0) {
    const currentFile = path.resolve(queue.shift());
    if (visited.has(currentFile)) continue;
    visited.add(currentFile);

    for (const specifier of extractRuntimeImportSpecifiers(currentFile)) {
      const packageName = packageNameFromSpecifier(specifier);
      if (packageName) {
        packages.add(packageName);
        continue;
      }
      if (!isRelativeSpecifier(specifier)) continue;

      const resolvedImport = resolveRelativeRuntimeImport(currentFile, specifier);
      if (!resolvedImport) {
        throw new Error(
          `[build-server] bundled plugin import cannot be resolved: ${specifier} from ${path.relative(resolvedRootDir, currentFile)}`,
        );
      }

      const nativeRelative = assertInsideRoot(resolvedRootDir, resolvedImport, currentFile, specifier);
      const relative = toPosixPath(nativeRelative);
      if (relative.startsWith("plugins/")) {
        if (isTraceableSourceFile(resolvedImport)) queue.push(resolvedImport);
        continue;
      }
      if (isNodeModulesRelativePath(relative)) continue;

      assertAllowedHostDependency(nativeRelative, allowedHostDirs);
      dependencies.add(nativeRelative);
      if (isTraceableSourceFile(resolvedImport)) queue.push(resolvedImport);
    }
  }

  return {
    dependencies: [...dependencies].sort(),
    packages: [...packages].sort(),
    nftRoots: [
      ...pluginEntries.map((entry) => toPosixPath(path.relative(resolvedRootDir, entry))),
      ...[...dependencies]
        .filter((relativePath) => isTraceableSourceFile(relativePath))
        .map(toPosixPath),
    ].filter((value, index, all) => all.indexOf(value) === index).sort(),
  };
}

export async function collectBundledPluginRuntimeDependencies({
  rootDir,
  allowedHostDirs = BUNDLED_PLUGIN_ALLOWED_HOST_DIRS,
} = {}) {
  if (!rootDir) throw new Error("[build-server] collectBundledPluginRuntimeDependencies requires rootDir");
  return collectBundledPluginRuntimeGraph({ rootDir, allowedHostDirs }).dependencies;
}

export async function collectBundledPluginPackageDependencies({ rootDir } = {}) {
  if (!rootDir) throw new Error("[build-server] collectBundledPluginPackageDependencies requires rootDir");
  return collectBundledPluginRuntimeGraph({
    rootDir,
    allowedHostDirs: BUNDLED_PLUGIN_ALLOWED_HOST_DIRS,
  }).packages;
}

/**
 * Returns every source-form runtime entry copied into the packaged server for
 * bundled plugins. These roots are intentionally broader than the static
 * plugin import graph: tool modules are discovered by manifest conventions at
 * runtime, so each plugin source file must be visible to nft even when no
 * bundled server entry imports it directly. Host modules copied beside those
 * plugins are roots too, preserving their package dependency closure.
 */
export async function collectBundledPluginNftRoots({
  rootDir,
  allowedHostDirs = BUNDLED_PLUGIN_ALLOWED_HOST_DIRS,
} = {}) {
  if (!rootDir) throw new Error("[build-server] collectBundledPluginNftRoots requires rootDir");
  return collectBundledPluginRuntimeGraph({ rootDir, allowedHostDirs }).nftRoots;
}

export async function copyBundledPluginRuntimeDependencies({
  rootDir,
  outDir,
  allowedHostDirs = BUNDLED_PLUGIN_ALLOWED_HOST_DIRS,
} = {}) {
  if (!outDir) throw new Error("[build-server] copyBundledPluginRuntimeDependencies requires outDir");
  const dependencies = await collectBundledPluginRuntimeDependencies({ rootDir, allowedHostDirs });

  for (const relativePath of dependencies) {
    const source = path.join(rootDir, relativePath);
    const target = path.join(outDir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }

  return dependencies;
}
