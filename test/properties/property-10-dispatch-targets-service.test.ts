import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  loadArtifactModel,
  deployTargets,
  DEPLOY_ORDER,
  type DeployAction,
} from "../harness/model.js";

/**
 * Feature: aws-ecs-cloudformation-infra, Property 10: The dispatch workflow
 * targets only the service stack.
 *
 * For every deploy/update action in the Dispatch_Workflow
 * (`.github/workflows/deploy-dispatch.yml`), the action must act on the service
 * template `04-ecs-service`, and no infrastructure-layer template
 * (00-vpc / 01-security-groups / 02-alb / 03-ecs-cluster) may be referenced by
 * any deploy action. This keeps a dispatch-triggered image rollout confined to
 * the Web_App_Service_Stack, leaving the VPC, security groups, ALB, and cluster
 * stacks unchanged.
 *
 * Validates: Requirements 10.1, 10.2
 *
 * Strategy: the harness model parses `deploy-dispatch.yml` into
 * `workflows["deploy-dispatch"].deployActions`, each carrying the template
 * basename its `aws cloudformation deploy` command targets. We quantify with
 * fast-check over those deploy actions (`fc.constantFrom`, min 100 runs) and
 * assert each targets `04-ecs-service`. `DEPLOY_ORDER` gives the exact set of
 * non-service (infra) templates that must never appear among the dispatch
 * workflow's deploy targets.
 */

const SERVICE_TEMPLATE = "04-ecs-service" as const;

describe("Feature: aws-ecs-cloudformation-infra, Property 10: The dispatch workflow targets only the service stack", () => {
  const model = loadArtifactModel();
  const workflow = model.workflows["deploy-dispatch"];
  const deployActions: DeployAction[] = workflow?.deployActions ?? [];
  const targets = deployTargets("deploy-dispatch", model);

  it("the deploy-dispatch workflow is present with at least one deploy action", () => {
    // Guard: a missing workflow or empty action set would make the property
    // vacuously true, so assert we actually have something to quantify over.
    expect(workflow, "deploy-dispatch workflow exists").toBeDefined();
    expect(deployActions.length).toBeGreaterThan(0);
  });

  it("every deploy action in the dispatch workflow targets 04-ecs-service", () => {
    fc.assert(
      fc.property(fc.constantFrom(...deployActions), (action) => {
        expect(
          action.template,
          `deploy action "${action.stepName}" (job "${action.jobId}") targets ${SERVICE_TEMPLATE}`,
        ).toBe(SERVICE_TEMPLATE);
      }),
      { numRuns: 100 },
    );
  });

  it("no VPC / security-group / ALB / cluster template is referenced by any dispatch deploy action", () => {
    // DEPLOY_ORDER is exactly the four non-service infra templates:
    // 00-vpc, 01-security-groups, 02-alb, 03-ecs-cluster.
    for (const infraTemplate of DEPLOY_ORDER) {
      expect(
        targets.includes(infraTemplate),
        `dispatch workflow does not deploy infra template "${infraTemplate}"`,
      ).toBe(false);
    }
    // The only target the dispatch workflow deploys is the service template.
    expect(targets).toEqual([SERVICE_TEMPLATE]);
  });
});
