import assert from "node:assert/strict";
import fs from "node:fs";

const middleware = fs.readFileSync(new URL("../middleware.ts", import.meta.url), "utf8");
const invitePage = fs.readFileSync(new URL("../app/invite/[token]/page.tsx", import.meta.url), "utf8");

for (const requiredPublicPath of [
  '"/staff/sign-in"',
  '"/api/staff/context"',
  '"/api/staff/auth/"',
]) {
  assert.match(middleware, new RegExp(requiredPublicPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}
assert.match(invitePage, /error\s*\?\s*"Invitation could not be opened"/);
assert.match(invitePage, /Return to access instructions/);
assert.match(invitePage, /Return to Civya/);
assert.match(invitePage, /role="alert"/);

console.log("Staff pre-auth entry and invitation recovery contracts passed.");
