import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource, EntityManager } from "typeorm";

import { SettingsEntity } from "./settings.entity";

import { UserEntity } from "../user/user.entity";
import { AuditLogEntity } from "../audit/audit-log.entity";

export const AI_ENDPOINT_TYPES = ["chat", "responses", "anthropic", "tavily", "mcp"] as const;
export type AiEndpointType = (typeof AI_ENDPOINT_TYPES)[number];

/** An AI provider, search or MCP address a site administrator approved. */
export interface AiApprovedEndpoint {
  name: string;
  /** The API it speaks, offered to users who pick it */
  type: AiEndpointType;
  /** Requests whose URL has this origin and starts with this path are approved */
  baseUrl: string;
}

/**
 * Which AI addresses accounts may use. Private and local addresses (reachable from the server, not from the user)
 * always need an approval; public ones need one only when `customEndpoints` is "approved". Site administrators may
 * use any address.
 */
export interface AiEndpointPolicy {
  customEndpoints: "public" | "approved";
  endpoints: AiApprovedEndpoint[];
}

export const DEFAULT_AI_ENDPOINT_POLICY: Readonly<AiEndpointPolicy> = Object.freeze({
  customEndpoints: "public",
  endpoints: []
});

export const MAX_APPROVED_AI_ENDPOINTS = 50;

const POLICY_KEY = "ai-endpoints";

// Provider requests read the policy each time; other backend processes see a change this soon.
const CACHE_MILLISECONDS = 5000;

/** The canonical form of an approvable address (no credentials, query or fragment), or null. */
export function normalizeEndpointUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 500) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** Whether a request URL is under an approved endpoint: the same origin, and the path at or below its path. */
export function endpointMatches(endpoint: Pick<AiApprovedEndpoint, "baseUrl">, url: URL): boolean {
  let base: URL;
  try {
    base = new URL(endpoint.baseUrl);
  } catch {
    return false;
  }
  if (base.origin !== url.origin) return false;
  const prefix = base.pathname.replace(/\/+$/, "");
  return url.pathname === prefix || url.pathname.startsWith(`${prefix}/`) || prefix === "";
}

/** Returns the policy, or null when it isn't valid. */
export function parseAiEndpointPolicy(value: unknown): AiEndpointPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.customEndpoints !== "public" && input.customEndpoints !== "approved") return null;
  if (!Array.isArray(input.endpoints) || input.endpoints.length > MAX_APPROVED_AI_ENDPOINTS) return null;
  const endpoints: AiApprovedEndpoint[] = [];
  for (const item of input.endpoints as unknown[]) {
    if (!item || typeof item !== "object") return null;
    const { name, type, baseUrl } = item as Record<string, unknown>;
    const trimmedName = typeof name === "string" ? name.trim() : "";
    const url = normalizeEndpointUrl(baseUrl);
    if (!trimmedName || trimmedName.length > 80 || !(AI_ENDPOINT_TYPES as readonly unknown[]).includes(type) || !url)
      return null;
    if (endpoints.some(endpoint => endpoint.baseUrl === url && endpoint.type === type)) return null;
    endpoints.push({ name: trimmedName, type: type as AiEndpointType, baseUrl: url });
  }
  return { customEndpoints: input.customEndpoints, endpoints };
}

/**
 * Why an account may not send a request to `url`, as an AI error code, or null if it may. `serverApproved` is an
 * approval from the server's environment (HYHOJ_AI_PRIVATE_HOSTS).
 */
export function aiEndpointRefusal(
  policy: AiEndpointPolicy,
  url: URL,
  options: { privateDestination: boolean; administrator: boolean; serverApproved: boolean }
): "PRIVATE_ENDPOINT_BLOCKED" | "ENDPOINT_NOT_APPROVED" | null {
  if (options.administrator || options.serverApproved) return null;
  if (policy.endpoints.some(endpoint => endpointMatches(endpoint, url))) return null;
  if (options.privateDestination) return "PRIVATE_ENDPOINT_BLOCKED";
  return policy.customEndpoints === "approved" ? "ENDPOINT_NOT_APPROVED" : null;
}

@Injectable()
export class AiEndpointPolicyService {
  private cached: { policy: AiEndpointPolicy; until: number } = null;

  constructor(@InjectDataSource() private readonly connection: DataSource) {}

  private async row(manager: EntityManager, lock?: "pessimistic_write") {
    return await manager.findOne(SettingsEntity, {
      where: { key: POLICY_KEY },
      ...(lock ? { lock: { mode: lock } } : {})
    });
  }

  /** A damaged stored policy allows only approved addresses, of which it has none, rather than any address. */
  private policy(row: SettingsEntity | null): AiEndpointPolicy {
    if (!row) return { ...DEFAULT_AI_ENDPOINT_POLICY, endpoints: [] };
    return parseAiEndpointPolicy(row.value) || { customEndpoints: "approved", endpoints: [] };
  }

  async get(manager: EntityManager = this.connection.manager): Promise<AiEndpointPolicy> {
    return this.policy(await this.row(manager));
  }

  /** The policy as of at most a few seconds ago, for provider requests. */
  async current(): Promise<AiEndpointPolicy> {
    if (this.cached && this.cached.until > Date.now()) return this.cached.policy;
    const policy = await this.get();
    this.cached = { policy, until: Date.now() + CACHE_MILLISECONDS };
    return policy;
  }

  private async requireAdministrator(actor: UserEntity, manager: EntityManager) {
    if (!actor) throw new ForbiddenException();
    const current = await manager.findOne(UserEntity, { where: { id: actor.id }, lock: { mode: "pessimistic_read" } });
    if (!current?.isAdmin) throw new ForbiddenException();
    return current;
  }

  async getForAdministrator(actor: UserEntity): Promise<AiEndpointPolicy> {
    return await this.connection.transaction("READ COMMITTED", async manager => {
      await this.requireAdministrator(actor, manager);
      return await this.get(manager);
    });
  }

  async update(actor: UserEntity, value: AiEndpointPolicy, ip: string): Promise<AiEndpointPolicy> {
    const next = parseAiEndpointPolicy(value);
    if (!next) throw new BadRequestException("Invalid AI endpoint policy");
    const saved = await this.connection.transaction("READ COMMITTED", async manager => {
      const administrator = await this.requireAdministrator(actor, manager);
      await manager
        .createQueryBuilder()
        .insert()
        .into(SettingsEntity)
        .values({ key: POLICY_KEY, value: { ...DEFAULT_AI_ENDPOINT_POLICY } })
        .orIgnore()
        .execute();
      const row = await this.row(manager, "pessimistic_write");
      const previous = this.policy(row);
      row.value = next;
      await manager.save(row);
      await manager.save(AuditLogEntity, {
        userId: administrator.id,
        ip: ip || "127.0.0.1",
        time: new Date(),
        action: "site.ai_endpoints.update",
        details: { old: previous, new: next }
      });
      return next;
    });
    this.cached = null;
    return saved;
  }
}
