import crypto from "crypto";
import dns from "dns";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { capabilityDenied, ResourceIOError } from "../errors.ts";
import { resourceKeyForRef } from "../resource-refs.ts";
import type {
  MaterializeResult,
  ResourceDescriptor,
  ResourceMutationResult,
  ResourceReadResult,
  ResourceRef,
  ResourceStat,
  ResourceVersion,
} from "../types.ts";

type Options = {
  fetch?: typeof fetch;
  resolveHostname?: (hostname: string) => Promise<string[]>;
  materializeRoot?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
};

export class UrlProvider {
  readonly id = "url" as const;

  declare fetchImpl: typeof fetch;
  declare resolveHostname: (hostname: string) => Promise<string[]>;
  declare materializeRoot: string;
  declare timeoutMs: number;
  declare maxBytes: number;
  declare maxRedirects: number;

  constructor({
    fetch: fetchImpl = globalThis.fetch,
    resolveHostname = defaultResolveHostname,
    materializeRoot = path.join(os.tmpdir(), "luc-resource-io-url"),
    timeoutMs = 10_000,
    maxBytes = 10 * 1024 * 1024,
    maxRedirects = 3,
  }: Options = {}) {
    if (typeof fetchImpl !== "function") throw new Error("fetch is required for UrlProvider");
    this.fetchImpl = fetchImpl;
    this.resolveHostname = resolveHostname;
    this.materializeRoot = materializeRoot;
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
    this.maxRedirects = maxRedirects;
  }

  capabilities() {
    return {
      stat: true,
      read: true,
      materialize: true,
      writeExpectedVersion: false,
      write: false,
      edit: false,
      list: false,
      search: false,
      watch: false,
      copy: false,
      rename: false,
      move: false,
      trash: false,
      delete: false,
      mkdir: false,
    };
  }

  async stat(ref: ResourceRef): Promise<ResourceStat> {
    const read = await this.read(ref);
    return {
      resourceKey: read.resourceKey,
      resource: read.resource,
      exists: true,
      isDirectory: false,
      version: read.version,
    };
  }

  async read(ref: ResourceRef): Promise<ResourceReadResult> {
    const normalized = normalizeUrlRef(ref);
    const fetched = await this.fetchSafe(normalized.url);
    return {
      resourceKey: resourceKeyForRef(normalized),
      resource: descriptorForUrl(normalized.url, fetched.finalUrl),
      content: fetched.content,
      version: {
        size: fetched.content.byteLength,
        ...(fetched.etag ? { etag: fetched.etag } : {}),
      },
    };
  }

  async materialize(ref: ResourceRef): Promise<MaterializeResult> {
    const normalized = normalizeUrlRef(ref);
    const read = await this.read(normalized);
    fs.mkdirSync(this.materializeRoot, { recursive: true });
    const ext = extensionFromUrl(normalized.url);
    const filePath = path.join(
      this.materializeRoot,
      `${crypto.createHash("sha256").update(normalized.url).digest("hex")}${ext}`,
    );
    fs.writeFileSync(filePath, read.content);
    return {
      resourceKey: read.resourceKey,
      resource: read.resource,
      filePath,
      version: read.version,
    };
  }

  async write(_ref?: ResourceRef, _content?: string | Buffer): Promise<ResourceMutationResult> { throw capabilityDenied("write", this.id); }
  async writeExpectedVersion(_ref?: ResourceRef, _content?: string | Buffer, _expectedVersion?: ResourceVersion): Promise<never> { throw capabilityDenied("writeExpectedVersion", this.id); }
  async edit(_ref?: ResourceRef, _edits?: unknown[]): Promise<ResourceMutationResult> { throw capabilityDenied("edit", this.id); }
  async list(_ref?: ResourceRef): Promise<never> { throw capabilityDenied("list", this.id); }
  async search(_ref?: ResourceRef): Promise<never> { throw capabilityDenied("search", this.id); }
  async copy(_from?: ResourceRef, _to?: ResourceRef): Promise<never> { throw capabilityDenied("copy", this.id); }
  async rename(_from?: ResourceRef, _to?: ResourceRef): Promise<never> { throw capabilityDenied("rename", this.id); }
  async move(_from?: ResourceRef, _to?: ResourceRef): Promise<never> { throw capabilityDenied("move", this.id); }
  async trash(_ref?: ResourceRef): Promise<never> { throw capabilityDenied("trash", this.id); }
  async delete(_ref?: ResourceRef): Promise<ResourceMutationResult> { throw capabilityDenied("delete", this.id); }
  async mkdir(_ref?: ResourceRef): Promise<ResourceMutationResult> { throw capabilityDenied("mkdir", this.id); }

  async fetchSafe(inputUrl: string) {
    let current = await this.assertSafeUrl(inputUrl);
    for (let redirect = 0; redirect <= this.maxRedirects; redirect += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(current.href, {
          redirect: "manual",
          signal: controller.signal,
        });
        if (isRedirect(response.status)) {
          if (redirect === this.maxRedirects) {
            throw new ResourceIOError("URL redirect limit exceeded", {
              code: "url_redirect_limit",
              status: 400,
            });
          }
          const location = response.headers.get("location");
          if (!location) {
            throw new ResourceIOError("URL redirect missing location", {
              code: "invalid_url_redirect",
              status: 400,
            });
          }
          current = await this.assertSafeUrl(new URL(location, current).href);
          continue;
        }
        if (!response.ok) {
          throw new ResourceIOError(`URL read failed: HTTP ${response.status}`, {
            code: "url_fetch_failed",
            status: response.status,
          });
        }
        const contentLength = Number(response.headers.get("content-length") || "");
        if (Number.isFinite(contentLength) && contentLength > this.maxBytes) {
          throw new ResourceIOError("URL response too large", {
            code: "url_response_too_large",
            status: 413,
          });
        }
        const content = Buffer.from(await response.arrayBuffer());
        if (content.byteLength > this.maxBytes) {
          throw new ResourceIOError("URL response too large", {
            code: "url_response_too_large",
            status: 413,
          });
        }
        return {
          finalUrl: current.href,
          content,
          etag: response.headers.get("etag") || undefined,
          lastModified: response.headers.get("last-modified") || undefined,
        };
      } finally {
        clearTimeout(timer);
      }
    }
    throw new ResourceIOError("URL redirect limit exceeded", {
      code: "url_redirect_limit",
      status: 400,
    });
  }

  async assertSafeUrl(inputUrl: string): Promise<URL> {
    let url: URL;
    try {
      url = new URL(inputUrl);
    } catch {
      throw new ResourceIOError("invalid URL", {
        code: "invalid_url",
        status: 400,
      });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ResourceIOError("only http and https URLs are supported", {
        code: "invalid_url_scheme",
        status: 400,
      });
    }
    const hostname = url.hostname.toLowerCase();
    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
      throw new ResourceIOError("private URLs are blocked", {
        code: "blocked_private_url",
        status: 403,
      });
    }
    const addresses = net.isIP(hostname) ? [hostname] : await this.resolveHostname(hostname);
    if (!addresses.length || addresses.some(isBlockedAddress)) {
      throw new ResourceIOError("private URLs are blocked", {
        code: "blocked_private_url",
        status: 403,
      });
    }
    return url;
  }
}

function normalizeUrlRef(ref: ResourceRef): Extract<ResourceRef, { kind: "url" }> {
  if (ref.kind !== "url") {
    throw new ResourceIOError(`url provider cannot resolve ${ref.kind}`, {
      code: "invalid_resource_ref",
      status: 400,
    });
  }
  return ref;
}

function descriptorForUrl(sourceUrl: string, finalUrl: string): ResourceDescriptor {
  return {
    kind: "url",
    url: sourceUrl,
    provider: "url",
    displayName: finalUrl,
  };
}

async function defaultResolveHostname(hostname: string): Promise<string[]> {
  const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function isBlockedAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (net.isIPv6(address)) {
    const value = address.toLowerCase();
    return value === "::1"
      || value === "::"
      || value.startsWith("fc")
      || value.startsWith("fd")
      || value.startsWith("fe8")
      || value.startsWith("fe9")
      || value.startsWith("fea")
      || value.startsWith("feb");
  }
  return true;
}

function extensionFromUrl(url: string): string {
  const ext = path.extname(new URL(url).pathname);
  return ext && /^[.][a-zA-Z0-9]{1,12}$/.test(ext) ? ext : ".bin";
}
