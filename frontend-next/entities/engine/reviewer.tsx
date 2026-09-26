"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { HiOutlineIdentification } from "react-icons/hi2";

/** Who signs off a decision. Recorded with every approve / reject / resolve /
 * merge and kept in the incident archive for the review a day later. Once
 * authentication exists, this comes from the session instead of the form. */
export type Reviewer = { name: string; email: string };

const KEY = "nexus.reviewer";
const EMAIL = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/;

export const isValidEmail = (email: string) => EMAIL.test(email.trim());

/** Why this reviewer cannot sign off yet, or null if they can. */
export function signOffProblem(r: Reviewer): string | null {
  if (!r.name.trim()) return "Enter your name to sign off";
  if (!r.email.trim()) return "Enter your email to sign off";
  if (!isValidEmail(r.email)) return "That email address doesn't look right";
  return null;
}

function load(): Reviewer | null {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v.name === "string" && typeof v.email === "string" ? v : null;
  } catch {
    return null;
  }
}

/** The signed-in or remembered reviewer. Typed once, reused on every page. */
export function useReviewer() {
  const { data: session } = useSession();
  const [reviewer, setState] = useState<Reviewer>({ name: "", email: "" });

  const sessionName = session?.user?.name ?? "";
  const sessionEmail = session?.user?.email ?? "";

  useEffect(() => {
    const saved = load();
    // Only a real sign-in can vouch for who someone is. The no-auth mode's
    // placeholder session ("Reviewer" / "keep") is not an identity, so it is
    // never used to prefill a sign-off.
    const signedIn = isValidEmail(sessionEmail);
    setState({
      name: saved?.name || (signedIn ? sessionName : ""),
      email: saved?.email || (signedIn ? sessionEmail : ""),
    });
  }, [sessionName, sessionEmail]);

  const setReviewer = useCallback((next: Reviewer) => {
    setState(next);
    try {
      localStorage.setItem(KEY, JSON.stringify({ name: next.name, email: next.email }));
    } catch {
      /* private window: remembered for this page only */
    }
  }, []);

  return { reviewer, setReviewer, problem: signOffProblem(reviewer) };
}

/** Name + email, side by side. Shows why a sign-off is not possible yet. */
export function SignOffFields({ reviewer, onChange, className }: {
  reviewer: Reviewer; onChange: (r: Reviewer) => void; className?: string;
}) {
  const emailBad = reviewer.email.trim() !== "" && !isValidEmail(reviewer.email);
  return (
    <div className={className} role="group" aria-label="Sign off as">
      <div className="flex flex-wrap items-center gap-2">
        <HiOutlineIdentification className="text-gray-500 shrink-0" aria-hidden />
        <input value={reviewer.name} onChange={(e) => onChange({ ...reviewer, name: e.target.value })}
          placeholder="Your name" aria-label="Reviewer name" autoComplete="name"
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm w-40 focus:outline-none focus:border-green-500" />
        <input value={reviewer.email} onChange={(e) => onChange({ ...reviewer, email: e.target.value })}
          placeholder="you@company.com" aria-label="Reviewer email" type="email" autoComplete="email"
          aria-invalid={emailBad}
          className={`rounded-lg border bg-white px-3 py-1.5 text-sm w-56 focus:outline-none ${emailBad ? "border-red-400 focus:border-red-500" : "border-gray-300 focus:border-green-500"}`} />
      </div>
      {emailBad && <p className="mt-1 text-[11px] text-red-700">That email address doesn&apos;t look right.</p>}
    </div>
  );
}
