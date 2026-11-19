import assert from "node:assert/strict";
import { test } from "node:test";
import { can, navForRole, PERMISSIONS, ROLES, type Action, type Role } from "../src/server/auth/permissions";

// Blueprint Section E, written out independently of the implementation table.
const EXPECTED: Record<Action, Role[]> = {
  "catalog.view": ["FR_SPORTS", "ASO", "STOREKEEPER", "PROCUREMENT", "MANAGEMENT", "RECIPIENT"],
  "dashboard.view": ["FR_SPORTS", "ASO", "STOREKEEPER", "PROCUREMENT", "MANAGEMENT"],
  "inventory.view": ["FR_SPORTS", "ASO", "STOREKEEPER", "PROCUREMENT", "MANAGEMENT"],
  "item.manage": ["FR_SPORTS", "ASO"],
  "stock.receive": ["FR_SPORTS", "ASO", "PROCUREMENT"],
  "request.create": ["FR_SPORTS", "ASO", "STOREKEEPER", "PROCUREMENT", "RECIPIENT"],
  "request.approveIssue": ["FR_SPORTS", "ASO"],
  "request.markReady": ["FR_SPORTS", "ASO", "STOREKEEPER"],
  "request.reject": ["FR_SPORTS", "ASO"],
  "return.record": ["FR_SPORTS", "ASO", "STOREKEEPER"],
  "damaged.markUsable": ["FR_SPORTS", "ASO"],
  "incident.report": ["FR_SPORTS", "ASO", "STOREKEEPER"],
  "verification.count": ["FR_SPORTS", "ASO", "STOREKEEPER"],
  "adjustment.request": ["ASO", "STOREKEEPER"],
  "adjustment.approve": ["FR_SPORTS"],
  "discard.request": ["ASO", "STOREKEEPER"],
  "discard.approve": ["FR_SPORTS"],
  "movement.reverse": ["FR_SPORTS"],
  "reports.view": ["FR_SPORTS", "ASO", "STOREKEEPER", "PROCUREMENT", "MANAGEMENT"],
  "audit.view": ["FR_SPORTS", "MANAGEMENT"],
  "users.manage": ["FR_SPORTS"],
  "masterdata.manage": ["FR_SPORTS"],
};

test("permission matrix matches the approved blueprint for every role and action", () => {
  assert.deepEqual(Object.keys(PERMISSIONS).sort(), Object.keys(EXPECTED).sort());
  for (const action of Object.keys(EXPECTED) as Action[]) {
    for (const role of ROLES) {
      assert.equal(can(role, action), EXPECTED[action].includes(role), `${role} / ${action}`);
    }
  }
});

test("only FR Sports approves discards and corrections; management can change nothing", () => {
  const writeActions = (Object.keys(PERMISSIONS) as Action[]).filter(
    (a) => !["catalog.view", "dashboard.view", "inventory.view", "reports.view", "audit.view"].includes(a),
  );
  for (const a of writeActions) assert.equal(can("MANAGEMENT", a), false, a);
  assert.equal(can("ASO", "discard.approve"), false);
  assert.equal(can("ASO", "adjustment.approve"), false);
  assert.equal(can("STOREKEEPER", "request.approveIssue"), false);
});

test("navigation follows permissions", () => {
  const hrefs = (r: Role) => navForRole(r).map((n) => n.href);
  assert.deepEqual(hrefs("RECIPIENT"), ["/browse", "/my"]);
  assert.ok(hrefs("FR_SPORTS").includes("/admin/users"));
  assert.ok(!hrefs("ASO").includes("/admin/users"));
  assert.ok(hrefs("MANAGEMENT").includes("/admin/audit"));
  assert.ok(!hrefs("MANAGEMENT").includes("/returns"));
  assert.ok(!hrefs("PROCUREMENT").includes("/requests"));
});
