import type { ContextManifest, ManifestEntry } from "../domain/schema/manifest.js";
import type { StorePort } from "../ports/store.js";
import { Milestone } from "../domain/schema/milestone.js";
import { FeatureRequest } from "../domain/schema/feature-request.js";
import { layout } from "./persistence-layout.js";

/**
 * Manifest body resolution layer (incident-1b Bug B).
 *
 * `composePrompt` inlines the manifest header JSON but never the bodies the
 * entries reference. Without this resolution layer the LLM correctly refused
 * to fabricate scope (Discovery atlas turn 0 returned `failure.need_context`).
 *
 * `resolveManifestEntries` walks each entry, fetches the body via
 * `StorePort` according to (object_kind, fetch_scope), and returns a parallel
 * list of `ResolvedEntry` records that the prompt composer renders verbatim
 * under a new `# Inputs` section.
 *
 * Scope (incident-1b minimal):
 *   - `milestone` + `body` — load `milestones/<id>.json`, render title + intake
 *     source body (when the intake source is a `feature_request` we fetch the
 *     `feature_requests/<id>.json` body). Optionally append `milestones/<id>/spec.md`
 *     when present.
 *   - Other (object_kind, fetch_scope) combinations throw an explicit
 *     "unsupported" error. The caller decides:
 *       - `required=true` → surface the error (caller turns into AGC-INVALID),
 *       - `required=false` → skip silently (entry omitted from `# Inputs`,
 *         prompt still renders so the agent can decide).
 *
 * Caller is `agent-io.callAgent` via the new optional `store` dep.
 */

export interface ResolvedEntry {
  /** 0-based index into `manifest.entries` — preserves ordering for rendering. */
  manifest_entry_index: number;
  body: string;
}

export interface ResolveOptions {
  /**
   * If true, throws when an entry cannot be resolved AND `entry.required`. When
   * false, the entry is simply omitted from the result. Default: true.
   */
  strict?: boolean;
}

class UnsupportedManifestEntryError extends Error {
  constructor(entry: ManifestEntry, hint: string) {
    super(
      `unsupported manifest entry: object_kind=${entry.object_kind} fetch_scope=${entry.fetch_scope} object_id=${entry.object_id} (${hint})`,
    );
  }
}

export async function resolveManifestEntries(
  store: StorePort,
  manifest: ContextManifest,
  options: ResolveOptions = {},
): Promise<ResolvedEntry[]> {
  const strict = options.strict ?? true;
  const out: ResolvedEntry[] = [];
  for (let i = 0; i < manifest.entries.length; i++) {
    const entry = manifest.entries[i]!;
    try {
      const body = await resolveEntry(store, entry);
      if (body != null) out.push({ manifest_entry_index: i, body });
    } catch (e) {
      if (strict && entry.required) throw e;
      // non-required → skip; the prompt will render a sentinel placeholder
    }
  }
  return out;
}

async function resolveEntry(
  store: StorePort,
  entry: ManifestEntry,
): Promise<string | null> {
  if (entry.object_kind === "milestone" && entry.fetch_scope === "body") {
    return resolveMilestoneBody(store, entry.object_id);
  }
  // Other (kind, scope) pairs are out of scope for incident-1b. For
  // `required=true` entries the resolver throws so the caller can surface an
  // AGC-INVALID outcome (no silent empty prompt). For non-required entries
  // the caller catches and skips (entry omitted from `# Inputs`). Future work
  // can extend this switch with slice / slice_merge / dialogue_session /
  // session_turn / verification_run resolution.
  if (entry.required) {
    throw new UnsupportedManifestEntryError(
      entry,
      "resolver supports only (milestone, body) at incident-1b minimum",
    );
  }
  return null;
}

async function resolveMilestoneBody(
  store: StorePort,
  milestoneId: string,
): Promise<string | null> {
  const raw = await store.readText(layout.milestone(milestoneId));
  if (raw == null) return null;
  const milestone = Milestone.parse(JSON.parse(raw));
  const sections: string[] = [`title: ${milestone.title}`];

  // Intake source body — feature_request currently the only kind in production.
  if (milestone.intake_source_kind === "feature_request") {
    const frRaw = await store.readText(layout.featureRequest(milestone.intake_source_id));
    if (frRaw != null) {
      const fr = FeatureRequest.parse(JSON.parse(frRaw));
      sections.push(`intake_source (feature_request ${fr.request_id}):\n${fr.body}`);
    }
  }

  // Optional approved spec body (M_SPEC_APPROVED onward).
  const specRaw = await store.readText(layout.milestoneSpec(milestoneId));
  if (specRaw != null && specRaw.length > 0) {
    sections.push(`spec.md:\n${specRaw}`);
  }

  return sections.join("\n\n");
}
