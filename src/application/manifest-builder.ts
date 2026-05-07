import { newId } from "../domain/ids.js";
import {
  ContextManifest,
  type ContextManifest as ContextManifestT,
  type ManifestEntry,
  type ManifestEntryObjectKind,
  type FetchScope,
  type ManifestPurpose,
  type ManifestTarget,
} from "../domain/schema/manifest.js";
import type { ClockPort } from "../ports/clock.js";

/**
 * AGC-CONTEXT-MANIFEST builder.
 *
 * Revision pins are resolved by an injected port so that git-tree pins and
 * persistent-store updated_at pins live behind a single seam (phase 2 will
 * add the git adapter; the FS-store adapter is sufficient for design
 * artefacts and tests).
 *
 * `recheckPins` returns the entries whose pins have drifted since manifest
 * creation. `application/agent-io.ts` (phase 2) calls this immediately
 * before persisting an envelope to enforce AGC-CONTEXT-MANIFEST's stale-
 * detection invariant.
 */

export interface ManifestEntryDraft {
  object_kind: ManifestEntryObjectKind;
  object_id: string;
  fetch_scope: FetchScope;
  required: boolean;
  purpose: string;
}

export interface RevisionPinResolver {
  resolve(entry: ManifestEntryDraft): Promise<string>;
}

export interface BuildManifestInput {
  session_id: string;
  turn_index: number;
  purpose: ManifestPurpose;
  target: ManifestTarget;
  drafts: ManifestEntryDraft[];
}

export class ManifestBuilder {
  constructor(
    private readonly resolver: RevisionPinResolver,
    private readonly clock: ClockPort,
  ) {}

  async build(input: BuildManifestInput): Promise<ContextManifestT> {
    const entries: ManifestEntry[] = [];
    for (const d of input.drafts) {
      entries.push({
        object_kind: d.object_kind,
        object_id: d.object_id,
        fetch_scope: d.fetch_scope,
        revision_pin: await this.resolver.resolve(d),
        required: d.required,
        purpose: d.purpose,
      });
    }
    return ContextManifest.parse({
      manifest_id: newId(this.clock.now()),
      session_id: input.session_id,
      turn_index: input.turn_index,
      purpose: input.purpose,
      target: input.target,
      entries,
      created_at: this.clock.isoNow(),
    });
  }

  /** Returns the entries whose current pin differs from the recorded pin. */
  async recheckPins(
    manifest: ContextManifestT,
  ): Promise<ManifestEntry[]> {
    const stale: ManifestEntry[] = [];
    for (const e of manifest.entries) {
      const current = await this.resolver.resolve({
        object_kind: e.object_kind,
        object_id: e.object_id,
        fetch_scope: e.fetch_scope,
        required: e.required,
        purpose: e.purpose,
      });
      if (current !== e.revision_pin) stale.push(e);
    }
    return stale;
  }
}
