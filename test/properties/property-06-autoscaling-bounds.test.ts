import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { loadArtifactModel, type TemplateModel } from "../harness/model.js";

/**
 * Feature: aws-ecs-cloudformation-infra
 * Property 6: Autoscaling accepts bounds exactly when min does not exceed max
 *
 * Validates: Requirements 5.9
 *
 * The 04-ecs-service template constrains MinTaskCount / MaxTaskCount to the
 * discrete range 1..10 (AllowedValues) and enforces MinTaskCount <= MaxTaskCount
 * at validation time through a set of Rules (MinLeqMax1..MinLeqMax10). Rule
 * functions offer no numeric comparison, so the relationship is expressed as:
 * for a given MinTaskCount value N, MaxTaskCount must be Fn::Contains-ed in the
 * set of values at or above N.
 *
 * This test derives the actual accept predicate from the parsed template
 * (AllowedValues + the MinLeqMax rules) rather than hardcoding it, then asserts
 * the derived predicate accepts a (min, max) pair iff min <= max across the
 * valid range — and that pairs outside the AllowedValues range are rejected.
 */

const SERVICE_TEMPLATE = "04-ecs-service";
const MIN_PARAM = "MinTaskCount";
const MAX_PARAM = "MaxTaskCount";

/** Coerce AllowedValues entries (numbers or numeric strings) to a number set. */
function allowedNumberSet(values: unknown[] | undefined): Set<number> {
  const set = new Set<number>();
  for (const v of values ?? []) {
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) set.add(n);
  }
  return set;
}

/** Coerce a scalar (number or numeric string) to a number, or NaN. */
function toNumber(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * From the template's Rules, build a map: MinTaskCount value -> the set of
 * MaxTaskCount values the rule permits (the Fn::Contains membership set).
 *
 * Each MinLeqMax rule has the shape:
 *   RuleCondition: Fn::Equals[ Ref MinTaskCount, "<N>" ]
 *   Assertions: [ { Assert: Fn::Contains[ [<allowed max values>], Ref MaxTaskCount ] } ]
 */
function deriveMaxSetsByMin(template: TemplateModel): Map<number, Set<number>> {
  const rules = isObject(template.raw.Rules) ? template.raw.Rules : {};
  const byMin = new Map<number, Set<number>>();

  for (const ruleDef of Object.values(rules)) {
    if (!isObject(ruleDef)) continue;

    // --- RuleCondition: which MinTaskCount value does this rule govern? ---
    const cond = ruleDef.RuleCondition;
    if (!isObject(cond)) continue;
    const equals = cond["Fn::Equals"];
    if (!Array.isArray(equals) || equals.length !== 2) continue;

    // The equality is over Ref MinTaskCount; find the literal operand.
    const refsMin = equals.some(
      (operand) => isObject(operand) && operand.Ref === MIN_PARAM,
    );
    if (!refsMin) continue;
    const literal = equals.find((operand) => !isObject(operand));
    const minValue = toNumber(literal);
    if (!Number.isFinite(minValue)) continue;

    // --- Assertion: which MaxTaskCount values are accepted for this min? ---
    const assertions = Array.isArray(ruleDef.Assertions) ? ruleDef.Assertions : [];
    const allowedMax = new Set<number>();
    for (const assertion of assertions) {
      if (!isObject(assertion)) continue;
      const assertExpr = assertion.Assert;
      if (!isObject(assertExpr)) continue;
      const contains = assertExpr["Fn::Contains"];
      if (!Array.isArray(contains) || contains.length !== 2) continue;

      const [listOperand, valueOperand] = contains;
      // The value operand must be Ref MaxTaskCount for this to bound max.
      if (!(isObject(valueOperand) && valueOperand.Ref === MAX_PARAM)) continue;
      if (!Array.isArray(listOperand)) continue;

      for (const entry of listOperand) {
        const n = toNumber(entry);
        if (Number.isFinite(n)) allowedMax.add(n);
      }
    }

    if (allowedMax.size > 0) byMin.set(minValue, allowedMax);
  }

  return byMin;
}

describe("Property 6: Autoscaling accepts bounds exactly when min does not exceed max", () => {
  const model = loadArtifactModel();
  const template = model.templates[SERVICE_TEMPLATE];

  const minAllowed = allowedNumberSet(template.parameters[MIN_PARAM]?.AllowedValues);
  const maxAllowed = allowedNumberSet(template.parameters[MAX_PARAM]?.AllowedValues);
  const maxSetsByMin = deriveMaxSetsByMin(template);

  /**
   * The template's actual accept predicate for a (min, max) pair:
   *   1. both values must be within their AllowedValues, else CloudFormation
   *      rejects them before Rules even run, and
   *   2. the MinLeqMax rule matching `min` must Fn::Contains `max`.
   */
  function templateAccepts(min: number, max: number): boolean {
    if (!minAllowed.has(min) || !maxAllowed.has(max)) return false;
    const permittedMax = maxSetsByMin.get(min);
    if (!permittedMax) return false;
    return permittedMax.has(max);
  }

  it("declares MinTaskCount/MaxTaskCount over 1..10 and one MinLeqMax rule per min", () => {
    const oneToTen = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(minAllowed).toEqual(oneToTen);
    expect(maxAllowed).toEqual(oneToTen);
    // A MinLeqMax rule must exist for every allowed MinTaskCount value.
    for (const min of oneToTen) {
      expect(maxSetsByMin.has(min)).toBe(true);
    }
  });

  it("accepts a (min, max) pair within 1..10 iff min <= max", () => {
    const inRange = fc.integer({ min: 1, max: 10 });
    fc.assert(
      fc.property(inRange, inRange, (min, max) => {
        const expected = min <= max;
        expect(templateAccepts(min, max)).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });

  it("rejects pairs whose min or max falls outside the allowed 1..10 range", () => {
    // Probe values that stray outside AllowedValues (e.g. 0, 11+, negatives).
    const outOfRange = fc.integer({ min: -5, max: 20 });
    fc.assert(
      fc.property(outOfRange, outOfRange, (min, max) => {
        const bothInRange = minAllowed.has(min) && maxAllowed.has(max);
        if (bothInRange) {
          // In-range pairs still follow the min <= max rule.
          expect(templateAccepts(min, max)).toBe(min <= max);
        } else {
          // Any value outside AllowedValues is rejected outright.
          expect(templateAccepts(min, max)).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });
});
