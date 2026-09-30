import { describe, it, expect } from "vitest";
import {
  ENVIRONMENTS,
  listExports,
  resolveExportName,
  producerOf,
  type Environment,
  type ExportEntry,
} from "./model.js";

/**
 * Cross-stack export-inventory consistency (Task 16).
 *
 * Feature: aws-ecs-cloudformation-infra — export naming consistency
 *
 * Validates: Requirements 6.2, 8.1, 8.2
 *
 * The design document defines a canonical export inventory: exactly which
 * logical exports each of the five templates produces, and mandates that every
 * export name follow the `${Environment}-<logical>` convention so that the
 * dev-resolved and prod-resolved names never collide.
 *
 * This test pins that inventory down. It asserts, for the canonical set:
 *   1. each expected logical export exists and is produced by the right
 *      template (the design's "Producer" column);
 *   2. every expected export resolves to `${env}-<logical>` for both dev and
 *      prod, with the two resolutions distinct.
 *
 * The harness (`test/harness/model.ts`) parses each template's `Outputs`,
 * exposing declared exports via `listExports()` / `producerOf()` and resolving
 * the `${Environment}` prefix via `resolveExportName(entry, env)`.
 */

// ---------------------------------------------------------------------------
// Canonical export inventory (from design.md — "Canonical export inventory")
// ---------------------------------------------------------------------------

/**
 * Producer template basename mapped to the logical export names it MUST
 * produce. The per-AZ subnet ids (PublicSubnet{N}Id / PrivateSubnet{N}Id) are
 * verified separately since AZ count varies (2-3).
 */
const CANONICAL_INVENTORY: Record<string, string[]> = {
  "00-vpc": ["VpcId", "PublicSubnetIds", "PrivateSubnetIds"],
  "01-security-groups": ["AlbSecurityGroupId", "EcsServiceSecurityGroupId"],
  "02-alb": ["AlbArn", "AlbDnsName", "HttpsListenerArn"],
  "03-ecs-cluster": ["ClusterName", "ClusterArn", "NamespaceArn"],
  // 04-ecs-service: ServiceArn is optional and service-scoped
  // (`${Environment}-${ServiceName}-ServiceArn`), so it is not part of the
  // fixed logical-name inventory and is checked separately below.
};

/** Per-AZ subnet exports the VPC template produces (AZ count is 2-3). */
const VPC_PER_AZ_EXPORTS = [
  "PublicSubnet1Id",
  "PublicSubnet2Id",
  "PublicSubnet3Id",
  "PrivateSubnet1Id",
  "PrivateSubnet2Id",
  "PrivateSubnet3Id",
];

const allExports: ExportEntry[] = listExports();

/** Find the export entry for a given producer + logical name, if present. */
function findExport(template: string, logicalName: string): ExportEntry | undefined {
  return allExports.find(
    (e) => e.template === template && e.logicalName === logicalName,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Feature: aws-ecs-cloudformation-infra — canonical export inventory", () => {
  it("discovers exports to check against the inventory", () => {
    expect(allExports.length).toBeGreaterThan(0);
  });

  describe("each canonical logical export exists on its designated producer", () => {
    for (const [template, logicalNames] of Object.entries(CANONICAL_INVENTORY)) {
      for (const logicalName of logicalNames) {
        it(`${template} produces ${logicalName}`, () => {
          const entry = findExport(template, logicalName);
          expect(
            entry,
            `expected template ${template} to export logical name ${logicalName}`,
          ).toBeDefined();
          // And it is produced by exactly this template (right producer).
          expect(producerOf(logicalName)).toBe(template);
        });
      }
    }
  });

  it("00-vpc produces per-AZ public/private subnet id exports", () => {
    for (const logicalName of VPC_PER_AZ_EXPORTS) {
      const entry = findExport("00-vpc", logicalName);
      expect(
        entry,
        `expected 00-vpc to export per-AZ subnet id ${logicalName}`,
      ).toBeDefined();
    }
  });

  describe("every canonical export resolves to `${env}-<logical>` for dev and prod", () => {
    const canonicalPairs: { template: string; logicalName: string }[] = [];
    for (const [template, logicalNames] of Object.entries(CANONICAL_INVENTORY)) {
      for (const logicalName of logicalNames) {
        canonicalPairs.push({ template, logicalName });
      }
    }
    for (const logicalName of VPC_PER_AZ_EXPORTS) {
      canonicalPairs.push({ template: "00-vpc", logicalName });
    }

    for (const { template, logicalName } of canonicalPairs) {
      it(`${template}:${logicalName} is env-prefixed in dev and prod`, () => {
        const entry = findExport(template, logicalName);
        expect(entry).toBeDefined();

        const resolved: Record<Environment, string | undefined> = {
          dev: undefined,
          prod: undefined,
        };
        for (const env of ENVIRONMENTS) {
          const name = resolveExportName(entry!, env);
          expect(name).toBeDefined();
          expect(name).toBe(`${env}-${logicalName}`);
          resolved[env] = name;
        }
        // dev and prod resolutions never collide.
        expect(resolved.dev).not.toBe(resolved.prod);
      });
    }
  });

  it("the optional 04-ecs-service ServiceArn export, when present, is env-prefixed", () => {
    // ServiceArn is optional and service-scoped
    // (`${Environment}-${ServiceName}-ServiceArn`). If declared, its resolved
    // name must still begin with the environment prefix.
    const serviceExports = allExports.filter((e) => e.template === "04-ecs-service");
    for (const entry of serviceExports) {
      for (const env of ENVIRONMENTS) {
        const name = resolveExportName(entry, env);
        expect(name).toBeDefined();
        expect(name!.startsWith(`${env}-`)).toBe(true);
      }
    }
  });

  it("every declared export across all templates is consistently env-prefixed", () => {
    // A belt-and-braces sweep over the whole set: no export escapes the
    // `${Environment}-` convention, matching the design's naming contract.
    for (const entry of allExports) {
      for (const env of ENVIRONMENTS) {
        const name = resolveExportName(entry, env);
        expect(
          name,
          `export ${entry.template}:${entry.logicalId} did not resolve for ${env}`,
        ).toBeDefined();
        expect(
          name!.startsWith(`${env}-`),
          `export ${entry.template}:${entry.logicalId} resolved to "${name}", not "${env}-…"`,
        ).toBe(true);
      }
    }
  });
});
