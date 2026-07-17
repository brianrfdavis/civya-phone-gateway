import { POST as authoritativePost } from "@/app/api/conversations/turn/route";

/**
 * Compatibility alias. The canonical, authenticated interface is
 * /api/conversations/turn and accepts a TurnEnvelope. Browser-supplied case
 * and resident IDs are deliberately ignored by that handler.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = authoritativePost;
