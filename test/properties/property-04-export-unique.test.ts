import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  loadArtifactModel,
  listExports,
  resolveExportName,
  ENVIRONMENTS,
  type Environment,
} from "../harness/model.js";

/**
 * Feature: aws-ecs-cloudformation-infra, Property 4: Export names are unique
 * within an environment.
 *
 * For any supported environment, resolving every export name declared across
 * all templates (`${Environment}-<Logical>`) yields a set of names that are
 * pairwise unique — no two exports collide within the same environment.
 *
 * Validates: Requirements 6.5
 *
 * Strategy: quantify over the supported environments with fast-check
 * (fc.constantFrom over ENVIRONMENTS). For each drawn environment we resolve
 * every export's `Export.Name` via the harness's resolveExportName (which
 * substitutes the `${Environment}-` prefix using each export's raw expression),
 * then assert the resolved names are pairwise unique — i.e. the number of
 * distinct names equals the number of exports. When a collision is detected we
 * surface the offending name(s) to make failures diagnosable.
 */

describe("Feature: aws-ecs-cloudformation-infra, Property 4: Export names are unique within an environment", () => {
  const model = loadArtifactModel();
  const exports = listExports(model);

  it("exposes at least one export to check", () => {
    // Guards the property: if no exports were parsed the uniqueness check would
    // pass vacuously, hiding a broken model.
    expect(exports.length).toBeGreaterThan(0);
  });

  it("resolves pairwise-unique export names across all templates for any environment", () => {
    fc.assert(
      fc.property(fc.constantFrom<Environment>(...ENVIRONMENTS), (environment) => {
        const resolved = exports.map((entry) => {
          const name = resolveExportName(entry, environment);
          // Every export must resolve to a concrete name for the environment.
          expect(
            name,
            `export ${entry.template}/${entry.logicalId} must resolve in ${environment}`,
          ).toBeDefined();
          return name as string;
        });

        // Detect duplicates and report the conflicting names for diagnosability.
        const seen = new Set<string>();
        const duplicates = new Set<string>();
        for (const name of resolved) {
          if (seen.has(name)) duplicates.add(name);
          seen.add(name);
        }

        expect(
          [...duplicates],
          `duplicate export names in ${environment}`,
        ).toEqual([]);
        // The set of unique names must cover every export exactly once.
        expect(seen.size).toBe(resolved.length);
      }),
      { numRuns: 100 },
    );
  });
});
