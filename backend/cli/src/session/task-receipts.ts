import z from "zod"
import { CallAudit } from "./call-audit"

export namespace TaskReceipts {
  const Receipt = z.object({
    receipt_id: z.string(),
    hold_id: z.string(),
    charged_microusd: z
      .string()
      .max(20)
      .regex(/^[0-9]+$/),
    settled_at: z.string().datetime({ offset: true }),
    provider: z.string(),
    model: z.string(),
  })
  const Call = z.object({
    call_id: z.string().uuid(),
    state: z.enum(["missing", "pending", "not_charged", "settled", "inconsistent", "unknown"]),
    hold_id: z.string().nullable(),
    receipt_id: z.string().nullable(),
  })
  const Remote = z.object({
    schema_version: z.literal(1),
    checked_at: z.string().datetime({ offset: true }),
    calls: Call.array(),
    receipts: Receipt.array(),
  })
  export const Info = z.object({
    rootSessionID: z.string(),
    sessions: z.number().int().nonnegative(),
    managedCalls: z.number().int().nonnegative(),
    missingCallIDs: z.number().int().nonnegative(),
    state: z.enum(["available", "unavailable"]),
    reason: z
      .enum(["signed_out", "unsupported", "unauthorized", "server_unavailable", "invalid_report", "account_changed"])
      .optional(),
    checkedAt: z.string().datetime({ offset: true }).optional(),
    chargedMicrousd: z
      .string()
      .regex(/^[0-9]+$/)
      .optional(),
    calls: Call.array(),
    receipts: Receipt.array(),
  })

  export async function check(rootSessionID: string): Promise<z.infer<typeof Info>> {
    const audit = await CallAudit.report(rootSessionID)
    const managed = audit.calls.filter((call) => call.route === "managed")
    const identifiers = [
      ...new Set(
        managed.flatMap((call) => (z.string().uuid().safeParse(call.httpCall).success ? [call.httpCall!] : [])),
      ),
    ]
    const info: z.infer<typeof Info> = {
      rootSessionID,
      sessions: audit.sessions.length,
      managedCalls: managed.length,
      missingCallIDs: managed.filter((call) => !z.string().uuid().safeParse(call.httpCall).success).length,
      state: "unavailable",
      calls: [],
      receipts: [],
    }
    // Local-first build: managed call receipts belonged to the removed
    // Synthetic Sciences account. This build never contacts a receipts
    // endpoint; the local audit above is the whole record.
    return { ...info, reason: "signed_out" }
  }
}
