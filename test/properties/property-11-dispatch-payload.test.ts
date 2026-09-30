import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { dispatchPayloadAccepts } from "../harness/model.js";

/**
 * Feature: aws-ecs-cloudformation-infra, Property 11: Dispatch payload
 * validation accepts exactly complete, valid payloads.
 *
 * For any synthetic `client_payload`, the dispatch workflow's validation logic
 * accepts the payload if and only if `environment` is a non-empty string in
 * {dev, prod} AND `image_uri` is a non-empty string. Any missing key, an
 * environment outside the allowed set, an empty value, or a non-string value
 * must be rejected.
 *
 * Validates: Requirements 10.5, 10.6
 *
 * Strategy: generate `environment` and `image_uri` fields independently, each
 * drawn from a mix of accepting and rejecting shapes (present valid, present
 * invalid, empty, and absent/undefined). We then build a synthetic payload
 * that either includes or omits each key, compute the independent oracle
 * predicate, and assert the model's `dispatchPayloadAccepts` agrees exactly.
 */

// ---------------------------------------------------------------------------
// Field generators: each spans the accept and reject sub-spaces.
// ---------------------------------------------------------------------------

/** environment ∈ {dev, prod, "", "staging", undefined, arbitrary strings}. */
const environmentArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constantFrom("dev", "prod"), // valid values
  fc.constantFrom("", "staging", "DEV", "prod ", "development"), // invalid strings
  fc.constant(undefined), // key absent
  fc.string(), // arbitrary strings (mostly invalid)
);

/** image_uri ∈ {non-empty strings, "", undefined}. */
const imageUriArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.string({ minLength: 1 }), // non-empty (mostly valid)
  fc.constant(""), // empty (invalid)
  fc.constant(undefined), // key absent
  fc.string(), // arbitrary (may be empty)
);

/** Independent oracle: the intended accept predicate, stated directly. */
function oracleAccepts(environment: unknown, imageUri: unknown): boolean {
  const envOk =
    typeof environment === "string" &&
    environment.length > 0 &&
    (environment === "dev" || environment === "prod");
  const imageOk = typeof imageUri === "string" && imageUri.length > 0;
  return envOk && imageOk;
}

describe("Property 11: Dispatch payload validation accepts exactly complete, valid payloads", () => {
  it("accepts a payload iff environment ∈ {dev, prod} (non-empty) and image_uri is non-empty", () => {
    fc.assert(
      fc.property(
        environmentArb,
        imageUriArb,
        // Independently decide whether each key is present in the payload,
        // so "key absent" is exercised alongside "key present but invalid".
        fc.boolean(),
        fc.boolean(),
        (environment, imageUri, includeEnv, includeImage) => {
          const payload: { environment?: unknown; image_uri?: unknown } = {};
          if (includeEnv) payload.environment = environment;
          if (includeImage) payload.image_uri = imageUri;

          const effectiveEnv = includeEnv ? environment : undefined;
          const effectiveImage = includeImage ? imageUri : undefined;

          expect(dispatchPayloadAccepts(payload)).toBe(
            oracleAccepts(effectiveEnv, effectiveImage),
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});
