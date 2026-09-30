import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  loadArtifactModel,
  listImportEdges,
  producerOf,
  getDeployOrder,
  type ImportEdge,
} from "../harness/model.js";

/**
 * Feature: aws-ecs-cloudformation-infra, Property 9: Deploy order is a valid
 * topological order of the dependency graph
 *
 * For any import edge (a consumer template imports an export produced by a
 * producer template), the Deploy_Workflow's deployment sequence places the
 * producer template strictly before the consumer template.
 *
 * Validates: Requirements 9.1
 *
 * Strategy: enumerate the cross-stack import edges from the artifact model
 * (`listImportEdges`), resolve each edge's producer via `producerOf`, and read
 * the manual deploy sequence from deploy-infra.yml via `getDeployOrder`
 * ([00-vpc, 01-security-groups, 02-alb, 03-ecs-cluster]).
 *
 * The service template `04-ecs-service` is NOT deployed by the manual
 * Deploy_Workflow — it ships via the dispatch workflow — so it never appears in
 * the deploy order. This property constrains only the manual deploy sequence,
 * so we restrict the check to edges where BOTH the producer and the consumer
 * appear in the deploy order. For each such relevant edge we assert
 * index(producer) < index(consumer): the producer is deployed strictly before
 * its consumer, which is exactly the topological-order guarantee.
 *
 * The property is quantified over the relevant edges with fast-check
 * (`fc.constantFrom` over the edges, min 100 runs), and every relevant edge is
 * also checked exhaustively so no edge is skipped by sampling.
 */

describe("Feature: aws-ecs-cloudformation-infra, Property 9: Deploy order is a valid topological order of the dependency graph", () => {
  const model = loadArtifactModel();
  const deployOrder = getDeployOrder(model);
  const indexOf = (template: string): number => deployOrder.indexOf(template);

  const allEdges = listImportEdges(model);

  /**
   * The edges this property constrains: those whose producer and consumer both
   * appear in the manual deploy sequence. Edges into the dispatch-only service
   * template (04-ecs-service) are excluded because it is not part of the manual
   * deploy order.
   */
  const relevantEdges = allEdges.filter((edge) => {
    const producer = producerOf(edge.logicalName, model);
    return (
      producer !== undefined &&
      indexOf(producer) !== -1 &&
      indexOf(edge.consumer) !== -1
    );
  });

  /**
   * Assert the producer of an edge is deployed strictly before its consumer.
   */
  function assertProducerBeforeConsumer(edge: ImportEdge): void {
    const producer = producerOf(edge.logicalName, model);
    expect(
      producer,
      `import "${edge.logicalName}" consumed by ${edge.consumer} has no producer`,
    ).toBeDefined();

    const producerIdx = indexOf(producer as string);
    const consumerIdx = indexOf(edge.consumer);

    expect(
      producerIdx !== -1,
      `producer ${producer} of "${edge.logicalName}" is not in the deploy order`,
    ).toBe(true);
    expect(
      consumerIdx !== -1,
      `consumer ${edge.consumer} of "${edge.logicalName}" is not in the deploy order`,
    ).toBe(true);

    expect(
      producerIdx < consumerIdx,
      `producer ${producer} (index ${producerIdx}) must deploy strictly before ` +
        `consumer ${edge.consumer} (index ${consumerIdx}) for import "${edge.logicalName}"`,
    ).toBe(true);
  }

  it("the deploy order is a non-empty sequence", () => {
    // Guards the property below: without a deploy sequence the index checks
    // would be vacuous.
    expect(deployOrder.length).toBeGreaterThan(0);
  });

  it("has at least one relevant intra-deploy-order import edge to quantify over", () => {
    // Guards the property below: with no relevant edges, fc.constantFrom would
    // throw and the ordering assertions would be vacuous.
    expect(relevantEdges.length).toBeGreaterThan(0);
  });

  it("every relevant import edge places its producer strictly before its consumer (fast-check over the edge set)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...relevantEdges), (edge) => {
        assertProducerBeforeConsumer(edge);
      }),
      { numRuns: 100 },
    );
  });

  it("every relevant import edge places its producer strictly before its consumer (exhaustive)", () => {
    // Explicitly cover every relevant edge so no edge is missed by sampling.
    for (const edge of relevantEdges) {
      assertProducerBeforeConsumer(edge);
    }
  });
});
