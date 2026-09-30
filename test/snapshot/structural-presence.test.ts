import { describe, it, expect } from "vitest";
import {
  loadArtifactModel,
  type TemplateModel,
  type TemplateResource,
} from "../harness/model.js";

/**
 * Feature: aws-ecs-cloudformation-infra — Structural-presence tests (Task 15.1)
 *
 * These are structural-presence assertions over the parsed template resources
 * (NOT fast-check property tests). Each test traverses the in-memory model
 * produced by `loadArtifactModel()` and asserts that the concrete resources,
 * properties, and intrinsic wiring required by the referenced acceptance
 * criteria are actually present in the templates.
 *
 * Validates:
 *   - 00-vpc.yml:            Requirements 1.4, 1.5, 1.6, 1.7
 *   - 01-security-groups.yml Requirements 2.1, 2.2, 2.3
 *   - 02-alb.yml:            Requirements 3.1, 3.2, 3.3, 3.5
 *   - 03-ecs-cluster.yml:    Requirements 4.1, 4.2, 4.3
 *   - 04-ecs-service.yml:    Requirements 5.4, 5.5
 *
 * The templates express cross-stack wiring with CloudFormation intrinsic
 * functions, which the harness normalizes to plain objects of the form
 * `{ "Fn::ImportValue": ... }`, `{ "Ref": ... }`, `{ "Fn::Sub": ... }`, etc.
 * The helpers below traverse those objects so the assertions match whatever
 * short/long intrinsic form the author used.
 */

// ---------------------------------------------------------------------------
// Generic traversal helpers (intrinsics are plain objects in the parsed model)
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** All resources of a given CloudFormation type within a template. */
function resourcesOfType(
  template: TemplateModel,
  type: string,
): TemplateResource[] {
  return Object.values(template.resources).filter((r) => r.type === type);
}

/**
 * Extract the target logical id of a `!Ref` (i.e. `{ Ref: "Logical" }`).
 * Returns undefined for anything that is not a simple ref.
 */
function refTarget(node: unknown): string | undefined {
  if (isObject(node) && typeof node["Ref"] === "string") {
    return node["Ref"] as string;
  }
  return undefined;
}

/**
 * Extract the argument of an `Fn::Sub` expression as a string. Handles both the
 * scalar form (`{ "Fn::Sub": "..." }`) and the list form
 * (`{ "Fn::Sub": ["...", { vars }] }`). Returns undefined otherwise.
 */
function subString(node: unknown): string | undefined {
  if (!isObject(node) || !("Fn::Sub" in node)) return undefined;
  const sub = node["Fn::Sub"];
  if (typeof sub === "string") return sub;
  if (Array.isArray(sub) && typeof sub[0] === "string") return sub[0];
  return undefined;
}

/**
 * Recursively determine whether a subtree contains an `Fn::ImportValue` whose
 * resolved argument string contains `needle` (e.g. an export logical name like
 * "AlbSecurityGroupId"). Matches regardless of the `${Environment}-` prefix.
 */
function importsName(node: unknown, needle: string): boolean {
  if (Array.isArray(node)) {
    return node.some((item) => importsName(item, needle));
  }
  if (isObject(node)) {
    if ("Fn::ImportValue" in node) {
      const arg = node["Fn::ImportValue"];
      const asSub = subString(arg);
      if (typeof asSub === "string" && asSub.includes(needle)) return true;
      if (typeof arg === "string" && arg.includes(needle)) return true;
    }
    return Object.values(node).some((v) => importsName(v, needle));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const model = loadArtifactModel();

// ===========================================================================
// 00-vpc.yml — Requirements 1.4, 1.5, 1.6, 1.7
// ===========================================================================

describe("Structural presence: 00-vpc.yml networking (Requirements 1.4-1.7)", () => {
  const vpc = model.templates["00-vpc"];

  it("has a VPCGatewayAttachment attaching the IGW to the VPC (1.4)", () => {
    const attachments = resourcesOfType(vpc, "AWS::EC2::VPCGatewayAttachment");
    expect(
      attachments.length,
      "expected at least one AWS::EC2::VPCGatewayAttachment",
    ).toBeGreaterThan(0);

    // The IGW logical ids in the template (there is exactly one).
    const igwIds = resourcesOfType(vpc, "AWS::EC2::InternetGateway").map(
      (r) => r.logicalId,
    );
    const vpcIds = resourcesOfType(vpc, "AWS::EC2::VPC").map((r) => r.logicalId);

    // Some attachment must reference the IGW (InternetGatewayId) and the VPC.
    const attaches = attachments.some((att) => {
      const igwRef = refTarget(att.properties["InternetGatewayId"]);
      const vpcRef = refTarget(att.properties["VpcId"]);
      return (
        igwRef !== undefined &&
        igwIds.includes(igwRef) &&
        vpcRef !== undefined &&
        vpcIds.includes(vpcRef)
      );
    });
    expect(
      attaches,
      "a VPCGatewayAttachment must attach the IGW (InternetGatewayId) to the VPC (VpcId)",
    ).toBe(true);
  });

  it("places every NAT gateway in a public subnet (1.5)", () => {
    const nats = resourcesOfType(vpc, "AWS::EC2::NatGateway");
    expect(nats.length, "expected at least one NAT gateway").toBeGreaterThan(0);

    // Logical ids of public subnets (named Public*).
    const publicSubnetIds = resourcesOfType(vpc, "AWS::EC2::Subnet")
      .filter((s) => /^Public/.test(s.logicalId))
      .map((s) => s.logicalId);
    expect(publicSubnetIds.length).toBeGreaterThan(0);

    for (const nat of nats) {
      const subnetRef = refTarget(nat.properties["SubnetId"]);
      expect(
        subnetRef,
        `NAT gateway ${nat.logicalId} must Ref a SubnetId`,
      ).toBeDefined();
      expect(
        publicSubnetIds.includes(subnetRef as string),
        `NAT gateway ${nat.logicalId} is placed in ${subnetRef}, which is not a public subnet`,
      ).toBe(true);
    }
  });

  it("has a public route 0.0.0.0/0 -> IGW via GatewayId (1.6)", () => {
    const igwIds = resourcesOfType(vpc, "AWS::EC2::InternetGateway").map(
      (r) => r.logicalId,
    );
    const routes = resourcesOfType(vpc, "AWS::EC2::Route");

    const hasIgwDefaultRoute = routes.some((route) => {
      const dest = route.properties["DestinationCidrBlock"];
      const gwRef = refTarget(route.properties["GatewayId"]);
      return (
        dest === "0.0.0.0/0" &&
        gwRef !== undefined &&
        igwIds.includes(gwRef)
      );
    });
    expect(
      hasIgwDefaultRoute,
      "expected a route with 0.0.0.0/0 -> GatewayId referencing the IGW",
    ).toBe(true);
  });

  it("has private default routes 0.0.0.0/0 -> NAT gateway via NatGatewayId (1.7)", () => {
    const natIds = resourcesOfType(vpc, "AWS::EC2::NatGateway").map(
      (r) => r.logicalId,
    );
    const routes = resourcesOfType(vpc, "AWS::EC2::Route");

    const natDefaultRoutes = routes.filter((route) => {
      const dest = route.properties["DestinationCidrBlock"];
      const natRef = refTarget(route.properties["NatGatewayId"]);
      return (
        dest === "0.0.0.0/0" &&
        natRef !== undefined &&
        natIds.includes(natRef)
      );
    });
    expect(
      natDefaultRoutes.length,
      "expected at least one private route 0.0.0.0/0 -> NatGatewayId",
    ).toBeGreaterThan(0);

    // There should be one private default route per NAT gateway (per AZ).
    expect(
      natDefaultRoutes.length,
      "expected a private default route for each NAT gateway (one per AZ)",
    ).toBe(natIds.length);
  });
});

// ===========================================================================
// 01-security-groups.yml — Requirements 2.1, 2.2, 2.3
// ===========================================================================

describe("Structural presence: 01-security-groups.yml (Requirements 2.1-2.3)", () => {
  const sg = model.templates["01-security-groups"];

  it("declares exactly two security groups (2.1)", () => {
    const groups = resourcesOfType(sg, "AWS::EC2::SecurityGroup");
    expect(groups.length, "expected exactly two AWS::EC2::SecurityGroup").toBe(2);
  });

  it("ALB security group allows ingress TCP 443 from the AlbIngressCidr param (2.2)", () => {
    // The ALB SG is the one whose ingress references the AlbIngressCidr param.
    const groups = resourcesOfType(sg, "AWS::EC2::SecurityGroup");

    const hasHttpsIngress = groups.some((group) => {
      const ingress = group.properties["SecurityGroupIngress"];
      if (!Array.isArray(ingress)) return false;
      return ingress.some((rule) => {
        if (!isObject(rule)) return false;
        const proto = rule["IpProtocol"];
        const from = rule["FromPort"];
        const to = rule["ToPort"];
        const cidrRef = refTarget(rule["CidrIp"]);
        return (
          proto === "tcp" &&
          from === 443 &&
          to === 443 &&
          cidrRef === "AlbIngressCidr"
        );
      });
    });
    expect(
      hasHttpsIngress,
      "expected an ALB SG ingress rule: tcp 443-443 from CidrIp Ref AlbIngressCidr",
    ).toBe(true);
  });

  it("ECS service SG admits the container port from the ALB SG (SourceSecurityGroupId) (2.3)", () => {
    const groups = resourcesOfType(sg, "AWS::EC2::SecurityGroup");
    const albSgIds = groups
      .filter((g) => /alb/i.test(g.logicalId))
      .map((g) => g.logicalId);
    const ecsSgIds = groups
      .filter((g) => /ecs/i.test(g.logicalId))
      .map((g) => g.logicalId);
    expect(albSgIds.length, "expected an ALB security group").toBeGreaterThan(0);
    expect(ecsSgIds.length, "expected an ECS security group").toBeGreaterThan(0);

    // Look for a standalone SecurityGroupIngress that targets the ECS SG and
    // sources from the ALB SG on the container listener port.
    const standalone = resourcesOfType(
      sg,
      "AWS::EC2::SecurityGroupIngress",
    ).some((rule) => {
      const groupRef = refTarget(rule.properties["GroupId"]);
      const sourceRef = refTarget(rule.properties["SourceSecurityGroupId"]);
      const proto = rule.properties["IpProtocol"];
      const fromRef = refTarget(rule.properties["FromPort"]);
      const toRef = refTarget(rule.properties["ToPort"]);
      return (
        proto === "tcp" &&
        groupRef !== undefined &&
        ecsSgIds.includes(groupRef) &&
        sourceRef !== undefined &&
        albSgIds.includes(sourceRef) &&
        fromRef === "ContainerListenerPort" &&
        toRef === "ContainerListenerPort"
      );
    });

    // Also accept an inline ingress rule on the ECS SG that sources from the
    // ALB SG (SourceSecurityGroupId), covering the alternative authoring style.
    const inline = groups.some((group) => {
      if (!ecsSgIds.includes(group.logicalId)) return false;
      const ingress = group.properties["SecurityGroupIngress"];
      if (!Array.isArray(ingress)) return false;
      return ingress.some((rule) => {
        if (!isObject(rule)) return false;
        const sourceRef = refTarget(rule["SourceSecurityGroupId"]);
        return (
          rule["IpProtocol"] === "tcp" &&
          sourceRef !== undefined &&
          albSgIds.includes(sourceRef)
        );
      });
    });

    expect(
      standalone || inline,
      "expected the container port allowed into the ECS SG from the ALB SG via SourceSecurityGroupId",
    ).toBe(true);
  });
});

// ===========================================================================
// 02-alb.yml — Requirements 3.1, 3.2, 3.3, 3.5
// ===========================================================================

describe("Structural presence: 02-alb.yml (Requirements 3.1, 3.2, 3.3, 3.5)", () => {
  const alb = model.templates["02-alb"];

  const loadBalancers = resourcesOfType(
    alb,
    "AWS::ElasticLoadBalancingV2::LoadBalancer",
  );
  const listeners = resourcesOfType(
    alb,
    "AWS::ElasticLoadBalancingV2::Listener",
  );

  it("provisions an internet-facing load balancer referencing the imported ALB SG (3.1, 3.2)", () => {
    expect(loadBalancers.length, "expected exactly one ALB").toBe(1);
    const lb = loadBalancers[0];
    expect(lb.properties["Scheme"], "ALB Scheme must be internet-facing").toBe(
      "internet-facing",
    );

    // SecurityGroups must import the ALB security group id.
    expect(
      importsName(lb.properties["SecurityGroups"], "AlbSecurityGroupId"),
      "ALB SecurityGroups must Fn::ImportValue the AlbSecurityGroupId export",
    ).toBe(true);
  });

  it("has an HTTPS listener on 443 using the CertificateArn parameter (3.3)", () => {
    const https = listeners.find(
      (l) => l.properties["Port"] === 443 && l.properties["Protocol"] === "HTTPS",
    );
    expect(https, "expected an HTTPS listener on port 443").toBeDefined();

    const certs = (https as TemplateResource).properties["Certificates"];
    expect(Array.isArray(certs), "HTTPS listener must declare Certificates").toBe(
      true,
    );
    const usesCertArn = (certs as unknown[]).some((c) => {
      if (!isObject(c)) return false;
      return refTarget(c["CertificateArn"]) === "CertificateArn";
    });
    expect(
      usesCertArn,
      "HTTPS listener Certificates must reference the CertificateArn parameter",
    ).toBe(true);
  });

  it("has an HTTP listener on 80 that 301-redirects to HTTPS/443 preserving host/path/query (3.5)", () => {
    const http = listeners.find(
      (l) => l.properties["Port"] === 80 && l.properties["Protocol"] === "HTTP",
    );
    expect(http, "expected an HTTP listener on port 80").toBeDefined();

    const actions = (http as TemplateResource).properties["DefaultActions"];
    expect(Array.isArray(actions), "HTTP listener must have DefaultActions").toBe(
      true,
    );

    const redirect = (actions as unknown[]).find(
      (a) => isObject(a) && a["Type"] === "redirect",
    ) as Record<string, unknown> | undefined;
    expect(redirect, "HTTP listener must have a redirect default action").toBeDefined();

    const cfg = (redirect as Record<string, unknown>)["RedirectConfig"];
    expect(isObject(cfg), "redirect action must have RedirectConfig").toBe(true);
    const rc = cfg as Record<string, unknown>;

    expect(rc["Protocol"], "redirect must target HTTPS").toBe("HTTPS");
    expect(String(rc["Port"]), "redirect must target port 443").toBe("443");
    expect(rc["StatusCode"], "redirect must be a 301").toBe("HTTP_301");

    // Preserve original host, path, and query via the ALB placeholders.
    expect(rc["Host"], "redirect must preserve host (#{host})").toBe("#{host}");
    expect(
      rc["Path"] === "#{path}" || rc["Path"] === "/#{path}",
      "redirect must preserve path (#{path} or /#{path})",
    ).toBe(true);
    expect(rc["Query"], "redirect must preserve query (#{query})").toBe(
      "#{query}",
    );
  });
});

// ===========================================================================
// 03-ecs-cluster.yml — Requirements 4.1, 4.2, 4.3
// ===========================================================================

describe("Structural presence: 03-ecs-cluster.yml (Requirements 4.1-4.3)", () => {
  const cluster = model.templates["03-ecs-cluster"];

  it("associates the FARGATE and FARGATE_SPOT capacity providers (4.1)", () => {
    const assocs = resourcesOfType(
      cluster,
      "AWS::ECS::ClusterCapacityProviderAssociations",
    );
    expect(
      assocs.length,
      "expected a ClusterCapacityProviderAssociations resource",
    ).toBeGreaterThan(0);

    const providers = assocs[0].properties["CapacityProviders"];
    expect(Array.isArray(providers), "CapacityProviders must be a list").toBe(
      true,
    );
    const list = providers as unknown[];
    expect(list, "expected FARGATE capacity provider").toContain("FARGATE");
    expect(list, "expected FARGATE_SPOT capacity provider").toContain(
      "FARGATE_SPOT",
    );
  });

  it("provisions an AWS::ServiceDiscovery::HttpNamespace (4.2)", () => {
    const namespaces = resourcesOfType(
      cluster,
      "AWS::ServiceDiscovery::HttpNamespace",
    );
    expect(
      namespaces.length,
      "expected an AWS::ServiceDiscovery::HttpNamespace",
    ).toBeGreaterThan(0);
  });

  it("enables Container Insights on the cluster (4.3)", () => {
    const clusters = resourcesOfType(cluster, "AWS::ECS::Cluster");
    expect(clusters.length, "expected exactly one ECS cluster").toBe(1);

    const settings = clusters[0].properties["ClusterSettings"];
    expect(Array.isArray(settings), "cluster must declare ClusterSettings").toBe(
      true,
    );
    const insightsEnabled = (settings as unknown[]).some((s) => {
      if (!isObject(s)) return false;
      return s["Name"] === "containerInsights" && s["Value"] === "enabled";
    });
    expect(
      insightsEnabled,
      "expected ClusterSettings containerInsights=enabled",
    ).toBe(true);
  });
});

// ===========================================================================
// 04-ecs-service.yml — Requirements 5.4, 5.5
// ===========================================================================

describe("Structural presence: 04-ecs-service.yml (Requirements 5.4, 5.5)", () => {
  const service = model.templates["04-ecs-service"];

  it("declares a named port mapping with AppProtocol http2 and enables Service Connect (5.4)", () => {
    const taskDefs = resourcesOfType(service, "AWS::ECS::TaskDefinition");
    expect(taskDefs.length, "expected a task definition").toBeGreaterThan(0);

    const containers = taskDefs[0].properties["ContainerDefinitions"];
    expect(
      Array.isArray(containers),
      "task definition must declare ContainerDefinitions",
    ).toBe(true);

    const hasHttp2NamedMapping = (containers as unknown[]).some((c) => {
      if (!isObject(c)) return false;
      const mappings = c["PortMappings"];
      if (!Array.isArray(mappings)) return false;
      return mappings.some((m) => {
        if (!isObject(m)) return false;
        return (
          typeof m["Name"] === "string" &&
          (m["Name"] as string).length > 0 &&
          m["AppProtocol"] === "http2"
        );
      });
    });
    expect(
      hasHttp2NamedMapping,
      "expected a named PortMapping with AppProtocol http2",
    ).toBe(true);

    // Service Connect must be enabled on the ECS service.
    const services = resourcesOfType(service, "AWS::ECS::Service");
    expect(services.length, "expected an ECS service").toBeGreaterThan(0);
    const scc = services[0].properties["ServiceConnectConfiguration"];
    expect(
      isObject(scc),
      "service must declare ServiceConnectConfiguration",
    ).toBe(true);
    expect(
      (scc as Record<string, unknown>)["Enabled"],
      "ServiceConnectConfiguration.Enabled must be true",
    ).toBe(true);
  });

  it("wires a target group to the imported HTTPS listener and to the service load balancer (5.5)", () => {
    // A target group must exist.
    const targetGroups = resourcesOfType(
      service,
      "AWS::ElasticLoadBalancingV2::TargetGroup",
    );
    expect(targetGroups.length, "expected a target group").toBeGreaterThan(0);
    const tgIds = targetGroups.map((t) => t.logicalId);

    // A listener rule must reference the imported HttpsListenerArn and forward
    // to the target group.
    const rules = resourcesOfType(
      service,
      "AWS::ElasticLoadBalancingV2::ListenerRule",
    );
    expect(rules.length, "expected a listener rule").toBeGreaterThan(0);

    const ruleWiresListenerAndTg = rules.some((rule) => {
      const referencesListener = importsName(
        rule.properties["ListenerArn"],
        "HttpsListenerArn",
      );
      const actions = rule.properties["Actions"];
      const forwardsToTg =
        Array.isArray(actions) &&
        actions.some((a) => {
          if (!isObject(a)) return false;
          return tgIds.includes(refTarget(a["TargetGroupArn"]) ?? "");
        });
      return referencesListener && forwardsToTg;
    });
    expect(
      ruleWiresListenerAndTg,
      "a ListenerRule must reference the imported HttpsListenerArn and forward to the target group",
    ).toBe(true);

    // The ECS service's LoadBalancers must wire the target group.
    const services = resourcesOfType(service, "AWS::ECS::Service");
    expect(services.length, "expected an ECS service").toBeGreaterThan(0);
    const loadBalancers = services[0].properties["LoadBalancers"];
    expect(
      Array.isArray(loadBalancers),
      "service must declare LoadBalancers",
    ).toBe(true);
    const wiresTg = (loadBalancers as unknown[]).some((lb) => {
      if (!isObject(lb)) return false;
      return tgIds.includes(refTarget(lb["TargetGroupArn"]) ?? "");
    });
    expect(
      wiresTg,
      "service LoadBalancers must reference the target group (TargetGroupArn)",
    ).toBe(true);
  });
});
