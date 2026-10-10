import type { ResolvedKernelConfig } from "./compress-settings.js";

export const EXTERNAL_SUMMARY_NOTE = "\n\n[External summary mode: the conversation model selects consumed ranges; the configured independent summary service generates the authoritative summary. Use object-form content: [{startId, endId, topic?}]. summary is optional and, if supplied, only a non-authoritative hint, not the committed summary. Selected source text and read-only context are sent to the configured service using its separate credentials. All candidates failing leaves originals unchanged. This mode overrides instructions above requiring you to write the final summary.]";

/** External-summary mode for one request, decided by the request's own
 *  resolved Config (three-level cascade, same as every other compress field):
 *  `config.externalSummary?.enabled === true`. The settings ride the
 *  ResolvedKernelConfig rail from resolveRequestConfig → storeEffectiveConfig,
 *  so no consumer re-reads the config file. */
export function externalSummaryEnabled(config: unknown): boolean {
    return (config as ResolvedKernelConfig | undefined)?.externalSummary?.enabled === true;
}

/** [#autoFold] Growth folding is active for a request when the rail carries
 *  an ENABLED external chain that switched autoFold on. An unresolvable
 *  target collapses the chain to enabled=false (expandExternalSummaryChain
 *  -Tolerant), so this flips false and classic nudges come back — the
 *  fail-open path. */
function autoFoldActive(config: unknown): boolean {
    const ext = (config as ResolvedKernelConfig | undefined)?.externalSummary;
    return ext?.enabled === true && ext.autoFold === true;
}

/** [#autoFold] Backoff: when a growth-armed fold cannot reach its target
 *  (external chain down), pausing auto-fold for a while restores BOTH the
 *  classic overflow-only preflight AND the wire nudges — without this, a
 *  dead chain would leave the session with no compression channel at all
 *  (nudges suppressed, folds failing). Structural session type keeps this
 *  module import-leaf clean. */
export const AUTO_FOLD_BACKOFF_MS = 10 * 60_000;

function autoFoldBackoffActive(session: { metadata?: Record<string, unknown> } | undefined): boolean {
    const until = session?.metadata?.autoFoldBackoffUntil;
    return typeof until === "number" && until > Date.now();
}

export function armAutoFoldBackoff(session: { metadata?: Record<string, unknown> } | undefined): void {
    if (!session) return;
    (session.metadata ?? (session.metadata = {})).autoFoldBackoffUntil = Date.now() + AUTO_FOLD_BACKOFF_MS;
}

/** Nudge suppression + growth trigger share this gate: auto-fold is only
 *  "engaged" while the chain is on AND not in backoff. */
export function autoFoldEngaged(config: unknown, session: { metadata?: Record<string, unknown> } | undefined): boolean {
    return autoFoldActive(config) && !autoFoldBackoffActive(session);
}

function adaptSchema(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(adaptSchema);
    if (!value || typeof value !== "object") return value;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
        result[key] = key === "required" && Array.isArray(child) ? child.filter((name) => name !== "summary") : adaptSchema(child);
    }
    const properties = result.properties as Record<string, unknown> | undefined;
    if (properties?.summary) properties.summary = { type: "string", description: "Optional non-authoritative hint; the independent service generates the committed summary." };
    return result;
}

/** Preserve protocol wrappers and unrelated tools; never mutate shared kernel constants. */
export function withExternalSummaryTools<T>(tools: readonly T[], enabled: boolean): T[] {
    if (!enabled) return [...tools];
    return tools.map((tool) => {
        const copy = structuredClone(tool) as T & { name?: string; description?: string; parameters?: unknown; input_schema?: unknown; function?: { name?: string; description?: string; parameters?: unknown } };
        const declaration = copy.function ?? copy;
        if (declaration.name !== "compress") return tool;
        declaration.description = "Compress selected consumed ranges using the configured independent summary service." + EXTERNAL_SUMMARY_NOTE;
        if (declaration.parameters) declaration.parameters = adaptSchema(declaration.parameters);
        if (copy.input_schema) copy.input_schema = adaptSchema(copy.input_schema);
        return copy;
    });
}
