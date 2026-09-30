import { describe, it, expect } from "vitest";
import fc from "fast-check";
import yaml from "js-yaml";

/**
 * Smoke test for the shared test harness scaffolding.
 *
 * Confirms the test runner executes and that the core harness dependencies
 * (fast-check for property-based testing, js-yaml for parsing CloudFormation
 * templates and workflows) are wired up and usable. Real property/example/
 * edge/snapshot tests over the artifact model are added in later tasks.
 */
describe("test harness scaffolding", () => {
  it("runs the test runner", () => {
    expect(true).toBe(true);
  });

  it("has fast-check available for property-based tests", () => {
    fc.assert(
      fc.property(fc.integer(), (n) => n === n),
      { numRuns: 100 },
    );
  });

  it("has js-yaml available for parsing YAML artifacts", () => {
    const parsed = yaml.load("Resources:\n  Example:\n    Type: AWS::EC2::VPC\n") as {
      Resources: Record<string, { Type: string }>;
    };
    expect(parsed.Resources.Example.Type).toBe("AWS::EC2::VPC");
  });
});
