export const PERSISTENCE_FORMATS = [
  "sqlite",
  "json",
  "yaml",
  "jsonl",
  "markdown",
  "append-only-log",
  "directory-tree",
  "binary-cache",
  "mixed-directory",
] as const;

export type PersistenceFormat = typeof PERSISTENCE_FORMATS[number];

export const PERSISTENCE_SITE_KINDS = [
  "database-open",
  "write-file",
  "append-file",
  "rename",
  "copy-file",
  "mkdir",
  "remove-path",
  "truncate-file",
  "atomic-write",
  "secret-write",
  "persistent-store-constructor",
] as const;

export type PersistenceSiteKind = typeof PERSISTENCE_SITE_KINDS[number];

export type StartupPhase =
  | "desktop_bootstrap"
  | "home_guard"
  | "epoch_read_preflight"
  | "epoch_transition"
  | "post_epoch_pre_bind"
  | "transport_bind"
  | "first_run_seed"
  | "identity_seed"
  | "engine_construct"
  | "engine_init_legacy_migrations"
  | "runtime_ready";

export interface PersistenceSiteRule {
  sourceFile: string;
  kinds?: PersistenceSiteKind[];
  linePattern?: string;
  reason: string;
}

export interface PersistenceSchemaContract {
  kind: "runtime-source" | "protocol" | "exempt";
  source: string;
  compatibility: string;
  reason?: string;
  expiresOn?: string;
}

export type PersistenceSchemaSource =
  | {
      kind: "sqlite-runtime";
      module: string;
      contract: string;
    }
  | {
      kind: "runtime-contract";
      module: string;
      contract: string;
    }
  | {
      kind: "external-versioned";
      packageName: string;
      lockfile: string;
      versionSource: string;
      extensions: string[];
    }
  | {
      kind: "directory-contract";
      module: string;
      contract: string;
    }
  | {
      kind: "narrow-exemption";
      reason: string;
      expiresOn: string;
    };

export interface StoreDescriptor {
  id: string;
  ownerModule: string;
  pathPattern: string;
  pathPatterns: string[];
  pathExclusions: string[];
  pathKind: "file" | "tree";
  format: PersistenceFormat;
  schemaSource: PersistenceSchemaSource;
  schemaContract: PersistenceSchemaContract;
  openEntry: string[];
  migrationEntry: string[];
  protocolModules: string[];
  firstPossibleOpenPhase: StartupPhase;
  firstPossibleWritePhase: StartupPhase;
  epochPolicy: "epoch-managed" | "compatible" | "regenerable" | "migration-source";
  checkpointPolicy: string;
  restorePolicy: string;
  affectedByEpochMigration: boolean;
  bootstrapSafety: null | {
    compatibility: "epoch-independent" | "regenerable";
    reason: string;
    unstampedHomeSafePaths: Array<{
      relativePath: string;
      kind: "file" | "tree";
    }>;
  };
  preCoordinatorReadProjection: null | {
    compatibility: "additive-only";
    fields: string[];
    reason: string;
  };
  identityContract: string;
  exemption: null | {
    reason: string;
    expiresOn: string;
  };
  siteRules: PersistenceSiteRule[];
}

export interface PersistenceExemption {
  id: string;
  ownerModule: string;
  reason: string;
  expiresOn: string;
  sourceFile: string;
  kinds?: PersistenceSiteKind[];
  linePattern?: string;
}

export interface DiscoveredPersistenceSite {
  sourceFile: string;
  line: number;
  kind: PersistenceSiteKind;
  excerpt: string;
  reason: string;
  storeId: string | null;
  exemptionId: string | null;
}
