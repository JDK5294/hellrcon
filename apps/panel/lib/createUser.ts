/**
 * "Add a user" with starting access, as the Users screen's form does it.
 *
 * Two calls, because the API has two: create the account, then give it its starting role or preset.
 * The second can be refused where the first was not — a preset or role carrying what only an owner
 * may hand out, pressed by a user admin who is not one — and it used to leave the account behind
 * with no access at all: a login that reads as made and does nothing, under a name the next attempt
 * then collides with. So a refused second step takes the account back out, and the error says
 * which of the two happened.
 */
type Api = <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;

export type StartingAccess =
  | { roleId: string }
  | { grants: { capability: string; level: string }[]; limits: Record<string, number> }
  | null;

export async function createUserWithAccess(
  api: Api,
  account: { username: string; password: string },
  start: StartingAccess,
): Promise<{ id: string }> {
  const { user } = await api<{ user: { id: string } }>("/users", { method: "POST", body: account });
  if (!start) return user;
  try {
    if ("roleId" in start) {
      await api(`/users/${user.id}/roles`, { method: "PUT", body: { roleIds: [start.roleId] } });
    } else {
      await api(`/users/${user.id}/grants`, {
        method: "PUT",
        body: { grants: start.grants.map((g) => ({ capability: g.capability, scopeType: "global", level: g.level })), limits: start.limits },
      });
    }
  } catch (err) {
    const reason = (err as Error).message;
    // Nothing else can have touched an account made a moment ago, so deleting it is undoing it.
    const undone = await api(`/users/${user.id}`, { method: "DELETE" }).then(() => true, () => false);
    throw new Error(undone
      ? `${reason} — the account was not created`
      : `${reason} — the account "${account.username}" was created without access; set its access below or delete it`, { cause: err });
  }
  return user;
}
