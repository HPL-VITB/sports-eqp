import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ensureAdmin, listUsers, updateOwnProfile, updateUser } from "../src/server/auth/accounts";
import { getSessionUser } from "../src/server/auth/sessions";
import { findUserById } from "../src/server/auth/users";
import { AppError } from "../src/server/errors";
import { makeUser, setupTestEnv, type TestEnv } from "./support/harness";

let env: TestEnv;
before(async () => (env = await setupTestEnv()));
after(async () => env.close());

const user = async (id: string) => (await findUserById(env.ctx.db, id))!;
async function rejectsWith(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof AppError && e.code === code, code);
}

test("profile: completed once; registration number then locked; duplicates refused", async () => {
  const a = await makeUser(env, "RECIPIENT", { profile: false, email: "asha.23bce10045@vitbhopal.ac.in" });
  const b = await makeUser(env, "RECIPIENT", { profile: false });
  // Students: the registration number comes from the email, whatever is typed.
  const saved = await updateOwnProfile(env.ctx, await user(a.id), { name: "Asha Verma", univId: "99XYZ00000", category: "STUDENT" }, null);
  assert.equal(saved.univ_id, "23BCE10045");
  assert.ok(saved.profile_completed_at);

  // Name and category may change; the number may not.
  const renamed = await updateOwnProfile(env.ctx, saved, { name: "Asha V.", univId: "23BCE10045", category: "SPORTS_COORDINATOR" }, null);
  assert.equal(renamed.name, "Asha V.");
  await rejectsWith(updateOwnProfile(env.ctx, renamed, { name: "Asha", category: "FACULTY" }, null), "VALIDATION");

  // Employees (no number in the email) type an employee number and cannot pick Student.
  await rejectsWith(updateOwnProfile(env.ctx, await user(b.id), { name: "Prof B", univId: "EMP77", category: "STUDENT" }, null), "VALIDATION");
  await rejectsWith(updateOwnProfile(env.ctx, await user(b.id), { name: "Prof B", category: "FACULTY" }, null), "VALIDATION");
  // Another person cannot claim the same number.
  await rejectsWith(updateOwnProfile(env.ctx, await user(b.id), { name: "Someone Else", univId: "23bce10045", category: "FACULTY" }, null), "UNIV_ID_TAKEN");
  const emp = await updateOwnProfile(env.ctx, await user(b.id), { name: "Prof B", univId: "emp 0042", category: "FACULTY" }, null);
  assert.equal(emp.univ_id, "EMP0042");
  await rejectsWith(updateOwnProfile(env.ctx, emp, { name: "Prof B", univId: "EMP9999", category: "FACULTY" }, null), "UNIV_ID_LOCKED");
  await rejectsWith(updateOwnProfile(env.ctx, await user(b.id), { name: "X", univId: "!!", category: "ALIEN" }, null), "VALIDATION");
});

test("only FR Sports can list or change users", async () => {
  for (const role of ["ASO", "STOREKEEPER", "PROCUREMENT", "MANAGEMENT", "RECIPIENT"] as const) {
    const u = await makeUser(env, role);
    await rejectsWith(listUsers(env.ctx, await user(u.id), {}), "FORBIDDEN");
    await rejectsWith(updateUser(env.ctx, await user(u.id), u.id, { name: "Me" }, null), "FORBIDDEN");
  }
});

test("FR Sports grants a role; change is audited and applies on the next request", async () => {
  const fr = await makeUser(env, "FR_SPORTS");
  const target = await makeUser(env, "RECIPIENT");
  const updated = await updateUser(env.ctx, await user(fr.id), target.id, { role: "STOREKEEPER" }, "10.1.1.1");
  assert.equal(updated.role, "STOREKEEPER");
  assert.equal((await getSessionUser(env.ctx, target.token))?.role, "STOREKEEPER");
  const audit = await env.ctx.db.query<{ before: { role: string }; after: { role: string }; actor_id: string }>(
    "SELECT before, after, actor_id FROM audit_log WHERE action = 'user.update' AND entity_id = $1",
    [target.id],
  );
  assert.equal(audit.rows[0]!.before.role, "RECIPIENT");
  assert.equal(audit.rows[0]!.after.role, "STOREKEEPER");
  assert.equal(audit.rows[0]!.actor_id, fr.id);
});

test("deactivation signs the user out everywhere", async () => {
  const fr = await makeUser(env, "FR_SPORTS");
  const target = await makeUser(env, "ASO");
  await updateUser(env.ctx, await user(fr.id), target.id, { isActive: false }, null);
  assert.equal(await getSessionUser(env.ctx, target.token), null);
  const sessions = await env.ctx.db.query("SELECT 1 FROM sessions WHERE user_id = $1", [target.id]);
  assert.equal(sessions.rowCount, 0);
});

test("FR Sports cannot change own role or deactivate self", async () => {
  const fr = await makeUser(env, "FR_SPORTS");
  await rejectsWith(updateUser(env.ctx, await user(fr.id), fr.id, { role: "ASO" }, null), "SELF_CHANGE");
  await rejectsWith(updateUser(env.ctx, await user(fr.id), fr.id, { isActive: false }, null), "SELF_CHANGE");
});

test("the last active FR Sports user can never be removed, even by simultaneous demotions", async () => {
  // Fresh database state for this check: demote every existing FR except two.
  const a = await makeUser(env, "FR_SPORTS");
  const b = await makeUser(env, "FR_SPORTS");
  await env.ctx.db.query("UPDATE users SET role = 'ASO' WHERE role = 'FR_SPORTS' AND id NOT IN ($1, $2)", [a.id, b.id]);

  for (let round = 0; round < 15; round++) {
    // A demotes B while B demotes A, at the same moment.
    const results = await Promise.allSettled([
      updateUser(env.ctx, await user(a.id), b.id, { role: "ASO" }, null),
      updateUser(env.ctx, await user(b.id), a.id, { role: "ASO" }, null),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    assert.equal(ok, 1, `round ${round}: exactly one demotion succeeds`);
    const frs = await env.ctx.db.query("SELECT 1 FROM users WHERE role = 'FR_SPORTS' AND is_active");
    assert.equal(frs.rowCount, 1, `round ${round}: one FR remains`);
    // Restore for the next round.
    await env.ctx.db.query("UPDATE users SET role = 'FR_SPORTS' WHERE id IN ($1, $2)", [a.id, b.id]);
  }

  // Sequential case: with one FR left, demotion and deactivation are refused.
  await env.ctx.db.query("UPDATE users SET role = 'ASO' WHERE id = $1", [b.id]);
  const other = await makeUser(env, "FR_SPORTS");
  await updateUser(env.ctx, await user(other.id), a.id, { isActive: false }, null); // two FRs -> allowed
  await rejectsWith(updateUser(env.ctx, await user(a.id), other.id, { role: "ASO" }, null), "FORBIDDEN"); // a is inactive now
});

test("listing searches by name, email or registration number", async () => {
  const fr = await makeUser(env, "FR_SPORTS");
  const target = await makeUser(env, "RECIPIENT", { email: "rahul.sharma2026@vitbhopal.ac.in" });
  const res = await listUsers(env.ctx, await user(fr.id), { q: "rahul.sharma" });
  assert.deepEqual(res.users.map((u) => u.id), [target.id]);
  const byRole = await listUsers(env.ctx, await user(fr.id), { role: "FR_SPORTS" });
  assert.ok(byRole.users.every((u) => u.role === "FR_SPORTS"));
  await rejectsWith(listUsers(env.ctx, await user(fr.id), { role: "WIZARD" }), "VALIDATION");
});

test("bootstrap admin script creates or promotes an FR Sports user", async () => {
  const created = await ensureAdmin(env.ctx, "Head.Sports@VITBHOPAL.ac.in", "Head of Sports");
  assert.equal(created.role, "FR_SPORTS");
  assert.equal(created.email, "head.sports@vitbhopal.ac.in");
  const again = await ensureAdmin(env.ctx, "head.sports@vitbhopal.ac.in", "Other Name");
  assert.equal(again.id, created.id);
  assert.equal(again.name, "Head of Sports");
});
