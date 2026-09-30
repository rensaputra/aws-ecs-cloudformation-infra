import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { loadArtifactModel } from "../harness/model.js";

/**
 * Feature: aws-ecs-cloudformation-infra, Property 8: Parameter-file keys
 * correspond to declared template parameters.
 *
 * For any parameter file and any key it contains, that key names a parameter
 * declared in the `Parameters` section of the template the file targets.
 *
 * Validates: Requirements 7.3
 *
 * Strategy: the harness model already parses every parameter file
 * (`model.parameterFiles`) into a `{ template, keys }` shape and every
 * template (`model.templates`) into a `{ parameters }` map keyed by declared
 * parameter name. We enumerate all (parameterFile, key) pairs, then use
 * fast-check to quantify over them: for each pair, the targeted template must
 * exist and must declare a parameter matching the key.
 */

interface ParamKeyPair {
  /** Parameter file, e.g. "parameters/dev/00-vpc.json" (for readable failures). */
  file: string;
  /** Template basename the file targets, e.g. "00-vpc". */
  template: string;
  /** A single key present in the parameter file. */
  key: string;
}

describe("Feature: aws-ecs-cloudformation-infra, Property 8: Parameter-file keys correspond to declared template parameters", () => {
  const model = loadArtifactModel();

  // Flatten every parameter file into (file, template, key) triples so the
  // property can quantify over individual (paramFile, key) pairs.
  const pairs: ParamKeyPair[] = model.parameterFiles.flatMap((pf) =>
    pf.keys.map((key) => ({ file: pf.file, template: pf.template, key })),
  );

  it("has at least one (parameter file, key) pair to check", () => {
    // Guard: an empty pair set would make the property vacuously true.
    expect(pairs.length).toBeGreaterThan(0);
  });

  it("every parameter-file key names a declared parameter in the targeted template", () => {
    fc.assert(
      fc.property(fc.constantFrom(...pairs), ({ file, template, key }) => {
        const targeted = model.templates[template];
        // The file must target a template the model knows about.
        expect(targeted, `template "${template}" targeted by ${file} exists`).toBeDefined();
        // The key must name a declared Parameters entry in that template.
        expect(
          Object.prototype.hasOwnProperty.call(targeted.parameters, key),
          `key "${key}" in ${file} is a declared parameter of template "${template}"`,
        ).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
