import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  ENVIRONMENTS,
  listExports,
  resolveExportName,
  type Environment,
  type ExportEntry,
} from "../harness/model.js";

/**
 * Property 3: Every export name is environment-prefixed
 *
 * Feature: aws-ecs-cloudformation-infra, Property 3: Every export name is
 * environment-prefixed
 *
 * Validates: Requirements 1.8, 2.5, 3.6, 4.5, 4.6, 4.7, 6.2
 *
 * For any export declared by any template, and any environment in {dev, prod},
 * the resolved export name begins with the environment identifier followed by a
 * hyphen (`<env>-`), so that the dev-resolved and prod-resolved names for the
 * same logical export are always distinct.
 *
 * The harness (`test/harness/model.ts`) parses every template's `Outputs` and
 * exposes each `Output.Export.Name` via `listExports()`, plus a
 * `resolveExportName(entry, env)` helper that substitutes `${Environment}` in
 * the raw export-name expression. This test quantifies over the (export, env)
 * space and asserts the prefix + distinctness invariants.
 */

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const exports: ExportEntry[] = listExports();

/** Every export declared across all templates. */
const exportArb: fc.Arbitrary<ExportEntry> = fc.constantFrom(...exports);

/** Every supported environment. */
const envArb: fc.Arbitrary<Environment> = fc.constantFrom(...ENVIRONMENTS);

// ---------------------------------------------------------------------------
// Property test
// ---------------------------------------------------------------------------

describe("Feature: aws-ecs-cloudformation-infra, Property 3: Every export name is environment-prefixed", () => {
  // Guard: the property is only meaningful if the model discovered exports.
  it("discovers at least one export to quantify over", () => {
    expect(exports.length).toBeGreaterThan(0);
  });

  it("resolves every export name to begin with `<env>-`, with distinct dev/prod names", () => {
    fc.assert(
      fc.property(exportArb, envArb, (entry, env) => {
        const resolved = resolveExportName(entry, env);

        // The name must resolve for a supported environment.
        expect(resolved).toBeDefined();
        // The resolved name is environment-prefixed.
        expect(resolved!.startsWith(`${env}-`)).toBe(true);

        // The dev-resolved and prod-resolved names for the same logical export
        // are always distinct.
        const devName = resolveExportName(entry, "dev");
        const prodName = resolveExportName(entry, "prod");
        expect(devName).toBeDefined();
        expect(prodName).toBeDefined();
        expect(devName).not.toBe(prodName);
      }),
      { numRuns: 100 },
    );
  });
});
