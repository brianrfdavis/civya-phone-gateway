import { InMemorySingleUseLinkStore, SecureLinkService } from "./index";
import { getRuntimeConfig } from "@/lib/config/runtime";

const syntheticStore = new InMemorySingleUseLinkStore();
let service: SecureLinkService | null = null;
let configurationKey = "";

/**
 * Synthetic runtime only. Production must inject a durable atomic store so
 * single-use protection survives processes, deployments, and regions.
 */
export function getSyntheticSecureLinkService(): SecureLinkService {
  if (getRuntimeConfig().providers.paymentHandoff !== "synthetic") {
    throw new Error("Secure-link route shell is disabled outside synthetic provider mode.");
  }
  const secret = process.env.CIVYA_SECURE_LINK_SECRET ?? "";
  const localBaseUrl = process.env.CIVYA_PUBLIC_ORIGIN ?? "";
  const allowedOrigins = (process.env.CIVYA_HANDOFF_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const nextKey = JSON.stringify({ secret, localBaseUrl, allowedOrigins });
  if (!service || configurationKey !== nextKey) {
    service = new SecureLinkService({ secret, localBaseUrl, allowedOrigins, store: syntheticStore });
    configurationKey = nextKey;
  }
  return service;
}
