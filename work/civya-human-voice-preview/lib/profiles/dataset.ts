import type { ResidentProfile } from "@/lib/types";
// Static import so the JSON is bundled into serverless functions.
import residents from "@/data/profiles/residents.json";

export function loadProfiles(): ResidentProfile[] {
  return residents as unknown as ResidentProfile[];
}

export function getProfile(profileId: string): ResidentProfile | undefined {
  return loadProfiles().find((p) => p.profile_id === profileId);
}
