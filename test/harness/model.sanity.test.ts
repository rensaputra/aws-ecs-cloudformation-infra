import { describe, it, expect } from "vitest";
import {
  loadArtifactModel,
  listExports,
  listImportEdges,
  getDeployOrder,
  deployTargets,
  resolveExportName,
  producerOf,
  dispatchPayloadAccepts,
  ALL_TEMPLATE_NAMES,
  DEPLOY_ORDER,
} from "./model.js";

/**
 * Sanity checks for the shared artifact-parsing model (Task 13). These are not
 * the correctness properties themselves — they confirm the harness parses all
 * artifacts and exposes the substrate Properties 1-11 quantify over.
 */
describe("artifact model harness", () => {
  const model = loadArtifactModel();

  it("parses all five CloudFormation templates", () => {
    expect(Object.keys(model.templates).sort()).toEqual([...ALL_TEMPLATE_NAMES].sort());
    for (const name of ALL_TEMPLATE_NAMES) {
      const t = model.templates[name];
      expect(t).toBeDefined();
      expect(Object.keys(t.resources).length).toBeGreaterThan(0);
      expect(Object.keys(t.parameters).length).toBeGreaterThan(0);
    }
  });

  it("exposes per-template parameter constraints", () => {
    const vpc = model.templates["00-vpc"];
    expect(vpc.parameters.Environment.AllowedValues).toEqual(["dev", "prod"]);
    expect(vpc.parameters.VpcCidr.AllowedPattern).toBeTypeOf("string");

    const sg = model.templates["01-security-groups"];
    expect(sg.parameters.ContainerListenerPort.MinValue).toBe(1);
    expect(sg.parameters.ContainerListenerPort.MaxValue).toBe(65535);

    const svc = model.templates["04-ecs-service"];
    expect(svc.parameters.TaskCpu.AllowedValues).toContain("256");
    expect(svc.parameters.TargetCpuUtilization.MinValue).toBe(1);
    expect(svc.parameters.TargetCpuUtilization.MaxValue).toBe(100);
  });

  it("collects exports across templates and resolves env-prefixed names", () => {
    const exports = listExports(model);
    expect(exports.length).toBeGreaterThan(0);

    // Known exports from the canonical inventory must be present.
    const logicalNames = new Set(exports.map((e) => e.logicalName));
    for (const expected of [
      "VpcId",
      "PublicSubnetIds",
      "PrivateSubnetIds",
      "AlbSecurityGroupId",
      "EcsServiceSecurityGroupId",
      "AlbArn",
      "HttpsListenerArn",
      "ClusterName",
      "NamespaceArn",
    ]) {
      expect(logicalNames).toContain(expected);
    }

    const vpcId = exports.find((e) => e.logicalName === "VpcId")!;
    expect(resolveExportName(vpcId, "dev")).toBe("dev-VpcId");
    expect(resolveExportName(vpcId, "prod")).toBe("prod-VpcId");
    expect(producerOf("VpcId", model)).toBe("00-vpc");
  });

  it("collects cross-stack import edges", () => {
    const edges = listImportEdges(model);
    expect(edges.length).toBeGreaterThan(0);

    // Security groups import the VPC id.
    expect(edges).toContainEqual(
      expect.objectContaining({ consumer: "01-security-groups", logicalName: "VpcId" }),
    );
    // The service imports several cross-stack values.
    const svcImports = new Set(
      edges.filter((e) => e.consumer === "04-ecs-service").map((e) => e.logicalName),
    );
    for (const expected of [
      "PrivateSubnetIds",
      "EcsServiceSecurityGroupId",
      "HttpsListenerArn",
      "ClusterName",
      "NamespaceArn",
    ]) {
      expect(svcImports).toContain(expected);
    }
  });

  it("parses both environments' parameter files", () => {
    const dev = model.parameterFiles.filter((p) => p.environment === "dev");
    const prod = model.parameterFiles.filter((p) => p.environment === "prod");
    expect(dev.length).toBe(ALL_TEMPLATE_NAMES.length);
    expect(prod.length).toBe(ALL_TEMPLATE_NAMES.length);

    const vpcDev = dev.find((p) => p.template === "00-vpc")!;
    expect(vpcDev.keys).toContain("Environment");
    expect(vpcDev.values.Environment).toBe("dev");
  });

  it("parses the three workflows with triggers and deploy structure", () => {
    expect(Object.keys(model.workflows).sort()).toEqual(
      ["cfn-validate", "deploy-dispatch", "deploy-infra"].sort(),
    );

    expect(model.workflows["cfn-validate"].triggerNames).toContain("pull_request");
    expect(model.workflows["deploy-infra"].triggerNames).toContain("workflow_dispatch");
    expect(model.workflows["deploy-dispatch"].triggerNames).toContain("repository_dispatch");

    // Deploy order from deploy-infra.yml matches the declared layer order.
    expect(getDeployOrder(model)).toEqual([...DEPLOY_ORDER]);

    // The dispatch workflow targets only the service stack.
    expect(deployTargets("deploy-dispatch", model)).toEqual(["04-ecs-service"]);
  });

  it("models the dispatch payload-validation predicate", () => {
    expect(dispatchPayloadAccepts({ environment: "dev", image_uri: "x" })).toBe(true);
    expect(dispatchPayloadAccepts({ environment: "prod", image_uri: "x" })).toBe(true);
    expect(dispatchPayloadAccepts({ environment: "staging", image_uri: "x" })).toBe(false);
    expect(dispatchPayloadAccepts({ environment: "dev" })).toBe(false);
    expect(dispatchPayloadAccepts({ image_uri: "x" })).toBe(false);
    expect(dispatchPayloadAccepts({ environment: "dev", image_uri: "" })).toBe(false);
  });
});
