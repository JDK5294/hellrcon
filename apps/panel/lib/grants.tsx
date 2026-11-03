"use client";
/**
 * The signed-in staff member's grants, available anywhere without threading them down.
 *
 * Most screens only need a yes/no that the page already computed ("can this person ban at all?"),
 * and those keep taking a boolean prop. This exists for the controls that have to ask the question
 * PER SERVER — the ban and unban pickers, which offer a set of servers and must not list one where
 * the answer would only ever be 403. Passing grants to those by hand meant four prop hops through
 * components that have no interest in them.
 */
import { createContext, useContext, type ReactNode } from "react";
import type { ClientGrant } from "./access";

const Ctx = createContext<ClientGrant[]>([]);

export function GrantsProvider({ grants, children }: { grants: ClientGrant[]; children: ReactNode }) {
  return <Ctx.Provider value={grants}>{children}</Ctx.Provider>;
}

/** The current user's grants. Empty before /api/me lands, which reads as "offer nothing yet". */
export function useGrants(): ClientGrant[] {
  return useContext(Ctx);
}
