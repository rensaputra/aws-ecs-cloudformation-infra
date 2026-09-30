import { describe, it, expect } from "vitest";
import {
  loadArtifactModel,
  type WorkflowModel,
  type WorkflowJob,
  type WorkflowStep,
} from "../harness/model.js";

/**
 * Feature: aws-ecs-cloudformation-infra — Workflow example / control-flow tests
 * (Task 15.3)
 *
 * These are structural / control-flow assertions over the parsed GitHub Actions
 * workflow YAML (NOT fast-check property tests). They traverse the in-memory
 * models produced by `loadArtifactModel()` (`workflows -> jobs -> steps`, each
 * step carrying `uses` / `run` / `name` / `continueOnError`, plus the raw
 * workflow tree for trigger inspection) and assert the control-flow guarantees
 * the referenced acceptance criteria require:
 *
 *   - deploy-infra.yml (Deploy_Workflow):
 *       - workflow_dispatch `environment` input is a `choice` over [dev, prod]
 *         (Requirements 9.2, 9.3)
 *       - OIDC auth (aws-actions/configure-aws-credentials) precedes any
 *         `aws cloudformation deploy` step (Requirement 9.4)
 *       - no deploy step sets `continue-on-error: true` — the layers run
 *         sequentially fail-fast (Requirement 9.6)
 *       - each deploy step's script pre-checks its parameter file and fails
 *         naming the missing file (Requirements 7.5)
 *   - cfn-validate.yml (CI_Workflow):
 *       - the validate job declares `timeout-minutes: 15` (Requirement 8.6)
 *   - deploy-dispatch.yml (Dispatch_Workflow):
 *       - the payload environment / image_uri are read from
 *         github.event.client_payload (Requirement 10.3)
 *       - OIDC auth precedes the cloudformation deploy/update step
 *         (Requirement 10.4)
 *
 * Validates: Requirements 7.5, 8.6, 9.2, 9.3, 9.4, 9.6, 10.3, 10.4
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OIDC_AUTH_ACTION = "aws-actions/configure-aws-credentials";
const DEPLOY_CMD = /aws\s+cloudformation\s+deploy/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Flatten every step of a workflow into `[jobId, stepIndex, step]` tuples. */
function allSteps(
  workflow: WorkflowModel,
): Array<{ jobId: string; index: number; step: WorkflowStep }> {
  const out: Array<{ jobId: string; index: number; step: WorkflowStep }> = [];
  for (const job of Object.values(workflow.jobs)) {
    job.steps.forEach((step, index) => out.push({ jobId: job.id, index, step }));
  }
  return out;
}

/** True when a step uses the OIDC credential-configuration action. */
function isAuthStep(step: WorkflowStep): boolean {
  return typeof step.uses === "string" && step.uses.includes(OIDC_AUTH_ACTION);
}

/** True when a step's run script invokes `aws cloudformation deploy`. */
function isDeployStep(step: WorkflowStep): boolean {
  return typeof step.run === "string" && DEPLOY_CMD.test(step.run);
}

/**
 * The absolute document position of a step across the whole workflow, so we can
 * compare ordering even when auth and deploy live in different jobs. Jobs are
 * ordered by their declaration order in `workflow.jobs`, steps by index.
 */
function stepPositions(
  workflow: WorkflowModel,
): Array<{ jobId: string; index: number; step: WorkflowStep; position: number }> {
  let position = 0;
  const out: Array<{
    jobId: string;
    index: number;
    step: WorkflowStep;
    position: number;
  }> = [];
  for (const job of Object.values(workflow.jobs)) {
    job.steps.forEach((step, index) => {
      out.push({ jobId: job.id, index, step, position: position++ });
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const model = loadArtifactModel();
const deployInfra = model.workflows["deploy-infra"];
const cfnValidate = model.workflows["cfn-validate"];
const deployDispatch = model.workflows["deploy-dispatch"];

// ---------------------------------------------------------------------------
// deploy-infra.yml (Deploy_Workflow)
// ---------------------------------------------------------------------------

describe("Feature: aws-ecs-cloudformation-infra — deploy-infra.yml control flow", () => {
  it("the deploy-infra workflow is present", () => {
    expect(deployInfra, "deploy-infra workflow exists").toBeDefined();
  });

  it("workflow_dispatch `environment` input is a choice over [dev, prod] (9.2, 9.3)", () => {
    // `on:` may parse as the boolean-`true` key; the harness normalizes it to
    // `triggers`. Read the workflow_dispatch input definition from there.
    const dispatch = deployInfra.triggers["workflow_dispatch"];
    expect(dispatch, "workflow_dispatch trigger is defined").toBeDefined();
    expect(isObject(dispatch)).toBe(true);

    const inputs = isObject(dispatch) ? dispatch["inputs"] : undefined;
    expect(isObject(inputs), "workflow_dispatch has inputs").toBe(true);

    const envInput = isObject(inputs) ? inputs["environment"] : undefined;
    expect(isObject(envInput), "`environment` input is defined").toBe(true);

    const type = isObject(envInput) ? envInput["type"] : undefined;
    expect(type, "`environment` input is a choice").toBe("choice");

    const options = isObject(envInput) ? envInput["options"] : undefined;
    expect(Array.isArray(options), "`environment` input declares options").toBe(true);
    // Exactly dev and prod may be selected — nothing outside {dev, prod}.
    expect(options).toEqual(["dev", "prod"]);
  });

  it("OIDC auth precedes every `aws cloudformation deploy` step (9.4)", () => {
    const positioned = stepPositions(deployInfra);

    const authPositions = positioned
      .filter((p) => isAuthStep(p.step))
      .map((p) => p.position);
    const deployPositions = positioned
      .filter((p) => isDeployStep(p.step))
      .map((p) => p.position);

    // Guard: both an auth step and at least one deploy step must exist,
    // otherwise the ordering assertion would be vacuously true.
    expect(authPositions.length, "an OIDC auth step exists").toBeGreaterThan(0);
    expect(deployPositions.length, "at least one deploy step exists").toBeGreaterThan(0);

    const firstAuth = Math.min(...authPositions);
    const firstDeploy = Math.min(...deployPositions);
    expect(
      firstAuth,
      "OIDC auth appears before the first cloudformation deploy step",
    ).toBeLessThan(firstDeploy);
  });

  it("no deploy step sets continue-on-error: true — sequential fail-fast (9.6)", () => {
    const deploySteps = allSteps(deployInfra).filter((s) => isDeployStep(s.step));
    expect(deploySteps.length, "there are deploy steps to check").toBeGreaterThan(0);

    for (const { jobId, index, step } of deploySteps) {
      expect(
        step.continueOnError,
        `deploy step "${step.name ?? `${jobId}#${index}`}" does not continue-on-error`,
      ).toBe(false);
    }
  });

  it("each deploy step pre-checks its parameter file and fails naming the missing file (7.5)", () => {
    const deploySteps = allSteps(deployInfra).filter((s) => isDeployStep(s.step));
    expect(deploySteps.length, "there are deploy steps to check").toBeGreaterThan(0);

    for (const { jobId, index, step } of deploySteps) {
      const script = step.run ?? "";
      const label = `deploy step "${step.name ?? `${jobId}#${index}`}"`;

      // A file-existence pre-check that guards the deploy against a missing
      // parameter file: `if [ ! -f "${PARAM_FILE}" ]; then`.
      expect(
        /\[\s*!\s*-f\s+["']?\$\{?PARAM_FILE\}?["']?\s*\]/.test(script),
        `${label} checks the parameter file exists before deploying`,
      ).toBe(true);

      // On a missing file the step emits a GitHub `::error::` annotation and
      // names the file (the ${PARAM_FILE} path) before exiting non-zero.
      expect(
        /::error::[^\n]*\$\{?PARAM_FILE\}?/.test(script),
        `${label} emits an ::error:: naming the missing parameter file`,
      ).toBe(true);
      expect(
        /exit\s+1/.test(script),
        `${label} exits non-zero when the parameter file is missing`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// cfn-validate.yml (CI_Workflow)
// ---------------------------------------------------------------------------

describe("Feature: aws-ecs-cloudformation-infra — cfn-validate.yml control flow", () => {
  it("the cfn-validate workflow is present", () => {
    expect(cfnValidate, "cfn-validate workflow exists").toBeDefined();
  });

  it("the validate job declares timeout-minutes: 15 (8.6)", () => {
    const jobs: WorkflowJob[] = Object.values(cfnValidate.jobs);
    expect(jobs.length, "cfn-validate has at least one job").toBeGreaterThan(0);

    // At least one job (the validate job) must cap its runtime at 15 minutes so
    // an over-running scan terminates with a failing status.
    const timeouts = jobs.map((j) => j.timeoutMinutes);
    expect(
      timeouts,
      "a job declares timeout-minutes: 15",
    ).toContain(15);
  });
});

// ---------------------------------------------------------------------------
// deploy-dispatch.yml (Dispatch_Workflow)
// ---------------------------------------------------------------------------

describe("Feature: aws-ecs-cloudformation-infra — deploy-dispatch.yml control flow", () => {
  it("the deploy-dispatch workflow is present", () => {
    expect(deployDispatch, "deploy-dispatch workflow exists").toBeDefined();
  });

  it("reads environment and image_uri from github.event.client_payload (10.3)", () => {
    // The payload values are surfaced into step env vars via
    // `github.event.client_payload.<field>` expressions. Search the raw
    // serialized workflow so we catch them wherever they are wired.
    const raw = JSON.stringify(deployDispatch.raw);

    expect(
      /github\.event\.client_payload\.environment/.test(raw),
      "reads environment from github.event.client_payload",
    ).toBe(true);
    expect(
      /github\.event\.client_payload\.image_uri/.test(raw),
      "reads image_uri from github.event.client_payload",
    ).toBe(true);
  });

  it("OIDC auth precedes the cloudformation deploy/update step (10.4)", () => {
    const positioned = stepPositions(deployDispatch);

    const authPositions = positioned
      .filter((p) => isAuthStep(p.step))
      .map((p) => p.position);
    const deployPositions = positioned
      .filter((p) => isDeployStep(p.step))
      .map((p) => p.position);

    expect(authPositions.length, "an OIDC auth step exists").toBeGreaterThan(0);
    expect(deployPositions.length, "a deploy/update step exists").toBeGreaterThan(0);

    const firstAuth = Math.min(...authPositions);
    const firstDeploy = Math.min(...deployPositions);
    expect(
      firstAuth,
      "OIDC auth appears before the cloudformation deploy/update step",
    ).toBeLessThan(firstDeploy);
  });
});
