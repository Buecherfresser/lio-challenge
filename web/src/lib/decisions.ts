import type { DecisionCard, Signature } from "@shared/api.ts"

/** Everyone who signs. Older cards name only the approver, so that becomes the one signature. */
export function signatureList(decision: DecisionCard): Signature[] {
  return decision.signatures.length > 0
    ? decision.signatures
    : [
        {
          role: decision.approver.role,
          person: decision.approver.person,
          stands_in_for: null,
          signed_by: null,
          signed_at: null,
        },
      ]
}

/** Who signs next: the first open signature, or the last one when all have signed. */
export function nextSigner(decision: DecisionCard): Signature | undefined {
  const list = signatureList(decision)
  return list.find((signature) => !signature.signed_by) ?? list.at(-1)
}

/**
 * What approving a card does outside the person's own click. "external": a mail goes to a supplier. "handover": a
 * colleague gets it as a task. "self": the person who signs is the one who does it, so the signature is the step.
 * The last two never leave Soony.
 */
export type DecisionReach = "external" | "handover" | "self"

export function decisionReach(decision: DecisionCard): DecisionReach {
  const draft = decision.mail_draft
  if (draft?.supplier_id) return "external"
  const doer = draft?.person?.trim().toLowerCase()
  if (!doer) return "self"
  const signers = signatureList(decision).flatMap((signature) => [signature.person, signature.signed_by])
  return signers.some((name) => name?.trim().toLowerCase() === doer) ? "self" : "handover"
}

/** "Grand Heist 6 – Standard Edition (game card)" becomes "Standard". Short enough for a tag. */
export function shortEdition(name: string): string {
  const tail = name.includes("–") ? name.split("–").pop()! : name.includes(" - ") ? name.split(" - ").pop()! : name
  return (
    tail
      .replace(/\(.*?\)/g, "")
      .replace(/\bEdition\b/i, "")
      .trim() || name
  )
}
