import type { ResidentProfile } from "@/lib/types";
import { loadProfiles } from "./dataset";

/**
 * Address matching tolerant of spoken input: "forty one seventy two Maplewood"
 * won't match, but "4172 Maplewood", "4172 maplewood st detroit" will.
 * Strategy: normalize, then require the street number plus the street name
 * stem to both appear.
 */
const STREET_WORDS = new Set([
  "street", "st", "avenue", "ave", "road", "rd", "drive", "dr",
  "boulevard", "blvd", "lane", "ln", "court", "ct", "place", "pl", "way",
]);

function normalizeAddress(text: string): { number: string | null; words: string[] } {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = cleaned.split(" ").filter(Boolean);
  const number = tokens.find((t) => /^\d{2,6}$/.test(t)) ?? null;
  const words = tokens.filter(
    (t) => !/^\d+$/.test(t) && !STREET_WORDS.has(t),
  );
  return { number, words };
}

export interface AddressMatch {
  profile: ResidentProfile;
  confidence: "exact" | "high";
}

export function matchAddress(input: string): AddressMatch | null {
  const q = normalizeAddress(input);
  if (!q.number && q.words.length === 0) return null;

  for (const profile of loadProfiles()) {
    const p = normalizeAddress(`${profile.address} ${profile.city}`);
    const numberMatches = q.number !== null && q.number === p.number;
    // Street-name stem match: every profile street word (minus city) present?
    const streetWords = normalizeAddress(profile.address).words;
    const streetHit =
      streetWords.length > 0 &&
      streetWords.every((w) =>
        q.words.some((qw) => qw === w || qw.startsWith(w.slice(0, 6))),
      );
    if (numberMatches && streetHit) {
      return { profile, confidence: "exact" };
    }
    // Spoken input often drops the number — allow street+city.
    const cityHit = q.words.includes(profile.city.toLowerCase());
    if (streetHit && cityHit) {
      return { profile, confidence: "high" };
    }
  }
  return null;
}
