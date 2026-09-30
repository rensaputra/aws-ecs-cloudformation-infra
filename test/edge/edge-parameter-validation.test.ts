import { describe, it, expect } from "vitest";
import {
  loadArtifactModel,
  type ParameterConstraints,
} from "../harness/model.js";

/**
 * Edge-case parameter-validation tests (Task 15.2).
 *
 * These tests exercise the *constraints declared in the templates* — the
 * `AllowedPattern` regexes and `MinValue`/`MaxValue` numeric bounds — by
 * reading each constraint out of the parsed artifact model (never hardcoding
 * the regex or bounds here) and applying it to boundary and malformed example
 * inputs. This mirrors what CloudFormation itself does at validation time:
 * reject a stack operation before any resource is created when a supplied
 * parameter value violates its constraint.
 *
 * Requirements covered:
 *   - 1.2  VpcCidr AllowedPattern (valid /16-/28 IPv4 CIDRs only)
 *   - 2.6  AlbIngressCidr AllowedPattern (valid /0-/32 IPv4 CIDRs only)
 *   - 3.4  CertificateArn AllowedPattern (valid, non-empty ACM cert ARNs only)
 *   - 5.2  ContainerPort MinValue=1 / MaxValue=65535
 *   - 5.7  TargetCpuUtilization MinValue=1 / MaxValue=100
 */

// ---------------------------------------------------------------------------
// Constraint helpers — compiled from the parsed model, never hardcoded.
// ---------------------------------------------------------------------------

/**
 * Compile a parameter's declared `AllowedPattern` into an anchored RegExp.
 *
 * CloudFormation applies `AllowedPattern` as a full-string match, so we anchor
 * with ^...$ if the author did not already. The pattern text comes straight
 * from the parsed template model, so the test tracks the template rather than a
 * hardcoded copy.
 */
function compileAllowedPattern(constraint: ParameterConstraints): RegExp {
  const pattern = constraint.AllowedPattern;
  if (typeof pattern !== "string") {
    throw new Error("parameter has no AllowedPattern to compile");
  }
  const anchored =
    (pattern.startsWith("^") ? "" : "^") +
    pattern +
    (pattern.endsWith("$") ? "" : "$");
  return new RegExp(anchored);
}

/** A value satisfies an AllowedPattern constraint iff it matches the regex. */
function patternAccepts(
  constraint: ParameterConstraints,
  value: string,
): boolean {
  return compileAllowedPattern(constraint).test(value);
}

/**
 * A numeric value satisfies MinValue/MaxValue bounds iff it is a finite number
 * within [MinValue, MaxValue]. Bounds are read from the parsed constraint; a
 * missing bound is treated as unbounded on that side.
 */
function boundsAccept(
  constraint: ParameterConstraints,
  value: number,
): boolean {
  if (!Number.isFinite(value)) return false;
  if (constraint.MinValue !== undefined && value < constraint.MinValue) {
    return false;
  }
  if (constraint.MaxValue !== undefined && value > constraint.MaxValue) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Model lookups
// ---------------------------------------------------------------------------

const model = loadArtifactModel();

function param(template: string, name: string): ParameterConstraints {
  const t = model.templates[template];
  expect(t, `template ${template} should be parsed`).toBeDefined();
  const p = t.parameters[name];
  expect(p, `parameter ${name} should exist on ${template}`).toBeDefined();
  return p;
}

// ---------------------------------------------------------------------------
// Requirement 1.2 — VpcCidr AllowedPattern (valid /16-/26 IPv4 CIDRs only)
// ---------------------------------------------------------------------------

describe("VpcCidr AllowedPattern (templates/00-vpc.yml) — Req 1.2", () => {
  const vpcCidr = param("00-vpc", "VpcCidr");

  it("declares an AllowedPattern constraint", () => {
    expect(vpcCidr.AllowedPattern).toBeTypeOf("string");
  });

  it.each([
    "10.0.0.0/16",
    "10.0.0.0/26", // lower boundary of the accepted prefix range
    "172.16.0.0/20",
    "10.255.255.0/24",
    "1.2.3.0/16",
  ])("accepts valid /16-/26 CIDR %s", (cidr) => {
    expect(patternAccepts(vpcCidr, cidr)).toBe(true);
  });

  it.each([
    "10.0.0.0/15", // prefix too small
    "192.168.0.0/27", // prefix too large (six /29 subnets no longer fit)
    "192.168.0.0/28", // prefix too large (six /29 subnets no longer fit)
    "10.0.0.0/29", // prefix too large
    "10.0.0.0/32", // host route, out of /16-/26 range
    "10.0.0.0/8", // out of range
    "256.0.0.0/16", // octet > 255
    "10.0.0.256/16", // octet > 255
    "10.0.0/16", // missing octet
    "10.0.0.0", // missing prefix
    "10.0.0.0/", // empty prefix
    "", // empty string
    "not-a-cidr",
  ])("rejects invalid/boundary CIDR %j", (cidr) => {
    expect(patternAccepts(vpcCidr, cidr)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Requirement 2.6 — AlbIngressCidr AllowedPattern (valid /0-/32 CIDRs only)
// ---------------------------------------------------------------------------

describe("AlbIngressCidr AllowedPattern (templates/01-security-groups.yml) — Req 2.6", () => {
  const albCidr = param("01-security-groups", "AlbIngressCidr");

  it("declares an AllowedPattern constraint", () => {
    expect(albCidr.AllowedPattern).toBeTypeOf("string");
  });

  it.each([
    "0.0.0.0/0", // any-source
    "203.0.113.0/24",
    "10.0.0.5/32", // single host
    "192.168.1.0/28",
    "255.255.255.255/32",
  ])("accepts valid CIDR %s", (cidr) => {
    expect(patternAccepts(albCidr, cidr)).toBe(true);
  });

  it.each([
    "0.0.0.0/33", // prefix too large
    "203.0.113.0/-1", // negative prefix
    "256.0.0.0/24", // octet > 255
    "203.0.113.0", // missing prefix
    "203.0.113/24", // missing octet
    "", // empty string
    "10.0.0.0/24 ", // trailing whitespace (anchored match rejects)
    "not-a-cidr",
  ])("rejects malformed CIDR %j", (cidr) => {
    expect(patternAccepts(albCidr, cidr)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Requirement 3.4 — CertificateArn AllowedPattern (valid ACM cert ARNs only)
// ---------------------------------------------------------------------------

describe("CertificateArn AllowedPattern (templates/02-alb.yml) — Req 3.4", () => {
  const certArn = param("02-alb", "CertificateArn");

  it("declares an AllowedPattern constraint", () => {
    expect(certArn.AllowedPattern).toBeTypeOf("string");
  });

  it.each([
    "arn:aws:acm:us-east-1:123456789012:certificate/abcd1234-ab12-cd34-ef56-abcdef123456",
    "arn:aws:acm:eu-west-1:000000000000:certificate/12345678-1234-1234-1234-123456789012",
    "arn:aws:acm:ap-southeast-2:210987654321:certificate/deadbeef",
  ])("accepts valid ACM certificate ARN %s", (arn) => {
    expect(patternAccepts(certArn, arn)).toBe(true);
  });

  it.each([
    "", // empty string is rejected
    "arn:aws:acm:us-east-1:123456789012:certificate/", // missing certificate id
    "arn:aws:acm:us-east-1:12345:certificate/abcd", // account id not 12 digits
    "arn:aws:iam::123456789012:certificate/abcd", // wrong service
    "arn:aws:acm:us-east-1:123456789012:cert/abcd", // wrong resource type
    "arn:aws:acm::123456789012:certificate/abcd", // empty region
    "acm:us-east-1:123456789012:certificate/abcd", // missing arn: prefix
    "not-an-arn",
  ])("rejects empty/malformed ARN %j", (arn) => {
    expect(patternAccepts(certArn, arn)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Requirement 5.2 — ContainerPort MinValue=1 / MaxValue=65535
// ---------------------------------------------------------------------------

describe("ContainerPort bounds (templates/04-ecs-service.yml) — Req 5.2", () => {
  const containerPort = param("04-ecs-service", "ContainerPort");

  it("declares MinValue=1 and MaxValue=65535", () => {
    expect(containerPort.MinValue).toBe(1);
    expect(containerPort.MaxValue).toBe(65535);
  });

  it.each([1, 8080, 65535])("accepts in-range port %d", (port) => {
    expect(boundsAccept(containerPort, port)).toBe(true);
  });

  it.each([0, 65536, -1, 100000])(
    "rejects out-of-range port %d",
    (port) => {
      expect(boundsAccept(containerPort, port)).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// Requirement 5.7 — TargetCpuUtilization MinValue=1 / MaxValue=100
// ---------------------------------------------------------------------------

describe("TargetCpuUtilization bounds (templates/04-ecs-service.yml) — Req 5.7", () => {
  const targetCpu = param("04-ecs-service", "TargetCpuUtilization");

  it("declares MinValue=1 and MaxValue=100", () => {
    expect(targetCpu.MinValue).toBe(1);
    expect(targetCpu.MaxValue).toBe(100);
  });

  it.each([1, 60, 100])("accepts in-range utilization %d", (pct) => {
    expect(boundsAccept(targetCpu, pct)).toBe(true);
  });

  it.each([0, 101, -1, 200])(
    "rejects out-of-range utilization %d",
    (pct) => {
      expect(boundsAccept(targetCpu, pct)).toBe(false);
    },
  );
});
