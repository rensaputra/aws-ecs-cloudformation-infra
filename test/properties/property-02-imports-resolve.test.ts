import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  loadArtifactModel,
  listExports,
  listImportEdges,
  producerOf,
  type ImportEdge,
} from "../harness/model.js";

/**
 * Feature: aws-ecs-cloudformation-infra, Property 2: Every import resolves to a
 * produced export
 *
 * For any template in the artifact set and any value it consumes that is
 * produced by another template, the value is consumed through an
 * `Fn::ImportValue` whose imported name matches an `Export.Name` declared by
 * some OTHER template in the set — never through a duplicated parameter
 * carrying the producer's value.
 *
 * Validates: Requirements 2.4, 5.3, 5.5, 5.6, 6.1, 6.3
 *
 * Strategy: enumerate the cross-stack import edges from the artifact model
 * (`listImportEdges`), each an (consumer, logicalName) pair with the
 * `${Environment}-` prefix stripped. For every edge we assert two things:
 *
 *   1. Resolution: some template declares a matching `Export.Name` for that
 *      logical name, and the producing template is a DIFFERENT template than
 *      the consumer (producer !== consumer). An import that resolves to the
 *      consumer's own export, or to nothing, is a violation.
 *
 *   2. No duplicated parameter: the consuming template does NOT also declare a
 *      parameter named after the imported logical name. If the value were
 *      carried as a parameter as well, the cross-stack value would be
 *      duplicated instead of flowing solely through the import.
 *
 * The property is quantified over the set of import edges with fast-check
 * (`fc.constantFrom` over the edges, min 100 runs), and every edge is also
 * checked explicitly so no edge is skipped by sampling.
 */

describe("Feature: aws-ecs-cloudformation-infra, Property 2: Every import resolves to a produced export", () => {
  const model = loadArtifactModel();
  const edges = listImportEdges(model);
  const exports = listExports(model);

  /**
   * Assert both invariants for a single import edge:
   *   - a matching export exists in another template (producer !== consumer)
   *   - the imported value is not also a parameter of the consuming template
   */
  function assertEdgeResolves(edge: ImportEdge): void {
    // (1) A matching export must exist, produced by a DIFFERENT template.
    const matching = exports.filter((e) => e.logicalName === edge.logicalName);
    expect(
      matching.length,
      `import "${edge.logicalName}" consumed by ${edge.consumer} has no matching Export.Name`,
    ).toBeGreaterThan(0);

    const producer = producerOf(edge.logicalName, model);
    expect(
      producer,
      `import "${edge.logicalName}" consumed by ${edge.consumer} has no producer`,
    ).toBeDefined();
    expect(
      producer !== edge.consumer,
      `import "${edge.logicalName}" is produced by its own consumer ${edge.consumer}`,
    ).toBe(true);

    // Every matching export is declared by some template other than the
    // consumer (there is a real cross-stack producer).
    expect(
      matching.some((e) => e.template !== edge.consumer),
      `import "${edge.logicalName}" consumed by ${edge.consumer} is only exported by itself`,
    ).toBe(true);

    // (2) The imported value must not be duplicated as a parameter of the
    // consuming template.
    const consumer = model.templates[edge.consumer];
    expect(
      consumer,
      `consuming template ${edge.consumer} not found in model`,
    ).toBeDefined();
    expect(
      Object.prototype.hasOwnProperty.call(consumer.parameters, edge.logicalName),
      `import "${edge.logicalName}" is also declared as a parameter of ${edge.consumer} (duplicated value)`,
    ).toBe(false);
  }

  it("has at least one cross-stack import edge to quantify over", () => {
    // Guards the property below: with no edges, fc.constantFrom would throw and
    // the iff assertions would be vacuous.
    expect(edges.length).toBeGreaterThan(0);
  });

  it("every import edge resolves to an export in another template (fast-check over the edge set)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...edges), (edge) => {
        assertEdgeResolves(edge);
      }),
      { numRuns: 100 },
    );
  });

  it("every import edge resolves and is not a duplicated parameter (exhaustive)", () => {
    // Explicitly cover every edge so no edge is missed by sampling.
    for (const edge of edges) {
      assertEdgeResolves(edge);
    }
  });
});
