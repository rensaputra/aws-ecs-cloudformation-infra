import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  loadArtifactModel,
  ALL_TEMPLATE_NAMES,
  ENVIRONMENTS,
  type Environment,
} from "../harness/model.js";

/**
 * Feature: aws-ecs-cloudformation-infra, Property 7: Every deployed template
 * has matching parameter files in each environment
 *
 * Validates: Requirements 7.1, 7.2
 *
 * Every deployed template must have exactly one matching parameter file in each
 * environment, and there must be no orphan parameter files (files that do not
 * correspond to a deployed template). The manual Deploy_Workflow deploys
 * 00-03, and the service template (04) is deployed via the dispatch workflow;
 * both dev and prod carry parameter files for all five templates (00-04).
 *
 * The property asserts a bijection, per environment, between the set of
 * templates and the parameter files present under `parameters/{env}/`:
 *   - injective + total from templates to param files: each of the five
 *     templates has exactly one param file, and
 *   - surjective with no orphans: every param file names one of the five
 *     templates (no extra/dangling files).
 *
 * fast-check quantifies over the environments (min 100 runs) so the invariant
 * is exercised uniformly across every supported environment.
 */

/** All five template basenames the bijection must cover. */
const EXPECTED_TEMPLATES = new Set<string>(ALL_TEMPLATE_NAMES);

/**
 * The parameter-file basenames present for a given environment, as a list so
 * duplicates (which would break a bijection) remain observable.
 */
function paramTemplatesForEnv(
  env: Environment,
  files: ReturnType<typeof loadArtifactModel>["parameterFiles"],
): string[] {
  return files
    .filter((f) => f.environment === env)
    .map((f) => f.template);
}

describe("Property 7: Every deployed template has matching parameter files in each environment", () => {
  const model = loadArtifactModel();

  it("declares parameter files for both supported environments", () => {
    for (const env of ENVIRONMENTS) {
      expect(paramTemplatesForEnv(env, model.parameterFiles).length).toBeGreaterThan(0);
    }
  });

  it("holds a bijection between templates and parameter files for each environment", () => {
    fc.assert(
      fc.property(fc.constantFrom<Environment>(...ENVIRONMENTS), (env) => {
        const paramTemplates = paramTemplatesForEnv(env, model.parameterFiles);
        const paramSet = new Set(paramTemplates);

        // No duplicate param files for the same template (keeps the map a
        // function: at most one param file per template).
        expect(paramSet.size).toBe(paramTemplates.length);

        // Injective + total: every template has a matching param file.
        for (const template of EXPECTED_TEMPLATES) {
          expect(paramSet.has(template)).toBe(true);
        }

        // Surjective, no orphans: every param file names a known template.
        for (const template of paramSet) {
          expect(EXPECTED_TEMPLATES.has(template)).toBe(true);
        }

        // Exact bijection: the two sets are equal in size (and thus content).
        expect(paramSet.size).toBe(EXPECTED_TEMPLATES.size);
      }),
      { numRuns: 100 },
    );
  });
});
