import assert from "node:assert/strict";
import fs from "node:fs";

const route = fs.readFileSync(new URL("../app/api/case/[caseId]/route.ts", import.meta.url), "utf8");
const page = fs.readFileSync(new URL("../app/case/[caseId]/page.tsx", import.meta.url), "utf8");

assert.match(route, /from\("tenants"\)/);
assert.match(route, /tenantResult\.data\.fictional === true/);
assert.match(route, /Controlled launch/);
assert.match(route, /fictional,\s*environment:/s);
assert.doesNotMatch(route, /sandbox:\s*\{\s*fictional:\s*true/);
assert.match(page, /view\.authorityNotice/);
assert.match(page, /const fictional = view\.sandbox\?\.fictional === true/);
assert.match(page, /\{fictional \? \(/);
assert.doesNotMatch(page, /<div className="cv-banner" role="note">\s*Demonstration only/s);

console.log("Case authority projection remains truthful for fictional and production tenants.");
