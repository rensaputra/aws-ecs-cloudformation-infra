import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { loadArtifactModel, type TemplateModel } from "../harness/model.js";

/**
 * Feature: aws-ecs-cloudformation-infra, Property 5: Fargate CPU/memory
 * combinations are accepted exactly when valid.
 *
 * For any (CPU, memory) pair, the Service_Template's validation logic accepts
 * the pair if and only if it appears in the official set of valid Fargate
 * CPU/memory combinations.
 *
 * Validates: Requirements 5.1, 5.8
 *
 * Strategy: the template enforces the pairing three ways that must all agree:
 *   1. `TaskCpu.AllowedValues` restricts CPU to the discrete Fargate set.
 *   2. `TaskMemory.AllowedValues` restricts memory to the discrete MiB set.
 *   3. A `Rules` section with a per-CPU `RuleCondition` (!Equals TaskCpu <n>)
 *      plus an `Fn::Contains` assertion restricts memory to the values valid
 *      for that CPU.
 * We reconstruct the template's validation predicate by parsing (1)-(3) out of
 * the template model's raw tree (nothing is hard-coded), then cross-check it
 * against the official Fargate matrix derived independently from design.md.
 */

// ---------------------------------------------------------------------------
// Official Fargate CPU -> allowed memory matrix (from design.md Data Models).
// Derived independently of the template so the property has something to
// cross-check the template-parsed predicate against.
//   256  -> {512, 1024, 2048}
//   512  -> 1024..4096  step 1024
//   1024 -> 2048..8192  step 1024
//   2048 -> 4096..16384 step 1024
//   4096 -> 8192..30720 step 1024
// ---------------------------------------------------------------------------

/** Build a sorted list of MiB strings from `start` to `end` inclusive, step 1024. */
function range(start: number, end: number): string[] {
  const out: string[] = [];
  for (let m = start; m <= end; m += 1024) out.push(String(m));
  return out;
}

const OFFICIAL_MATRIX: Record<string, string[]> = {
  "256": ["512", "1024", "2048"],
  "512": range(1024, 4096),
  "1024": range(2048, 8192),
  "2048": range(4096, 16384),
  "4096": range(8192, 30720),
};

/** The official set of valid (cpu, memory) pairs as a `cpu|memory` key set. */
function officialValidSet(): Set<string> {
  const set = new Set<string>();
  for (const [cpu, mems] of Object.entries(OFFICIAL_MATRIX)) {
    for (const mem of mems) set.add(`${cpu}|${mem}`);
  }
  return set;
}

// ---------------------------------------------------------------------------
// Reconstruct the template's validation predicate from its raw tree.
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** AllowedValues for a parameter, normalized to strings. */
function allowedValues(template: TemplateModel, param: string): string[] {
  const values = template.parameters[param]?.AllowedValues ?? [];
  return values.map((v) => String(v));
}

/**
 * Parse the per-CPU memory assertions out of the `Rules` section. Each relevant
 * rule looks like:
 *   RuleCondition: !Equals [!Ref TaskCpu, "<cpu>"]
 *   Assertions:
 *     - Assert: !Contains [[<allowed memory list>], !Ref TaskMemory]
 * Returns a map cpu -> Set(allowed memory), built entirely from the template.
 */
function parseCpuMemoryRules(template: TemplateModel): Record<string, Set<string>> {
  const rules = isObject(template.raw.Rules) ? template.raw.Rules : {};
  const map: Record<string, Set<string>> = {};

  for (const ruleDef of Object.values(rules)) {
    if (!isObject(ruleDef)) continue;

    // RuleCondition must be `!Equals [ {Ref: TaskCpu}, "<cpu>" ]`.
    const cond = ruleDef.RuleCondition;
    const cpu = cpuFromEquals(cond);
    if (cpu === undefined) continue;

    const assertions = Array.isArray(ruleDef.Assertions) ? ruleDef.Assertions : [];
    for (const assertion of assertions) {
      if (!isObject(assertion)) continue;
      const mems = memoriesFromContains(assertion.Assert, "TaskMemory");
      if (mems === undefined) continue;
      const set = map[cpu] ?? (map[cpu] = new Set<string>());
      for (const m of mems) set.add(m);
    }
  }

  return map;
}

/** Extract the string operand of `!Equals [ !Ref <param>, "<value>" ]` for TaskCpu. */
function cpuFromEquals(expr: unknown): string | undefined {
  if (!isObject(expr)) return undefined;
  const eq = expr["Fn::Equals"];
  if (!Array.isArray(eq) || eq.length !== 2) return undefined;
  const [left, right] = eq;
  if (!isRefTo(left, "TaskCpu")) return undefined;
  return typeof right === "string" ? right : undefined;
}

/**
 * Extract the allowed-value list of `!Contains [ [<list>], !Ref <param> ]`
 * when the second operand refs `param`. Returns the list as strings.
 */
function memoriesFromContains(expr: unknown, param: string): string[] | undefined {
  if (!isObject(expr)) return undefined;
  const contains = expr["Fn::Contains"];
  if (!Array.isArray(contains) || contains.length !== 2) return undefined;
  const [list, needle] = contains;
  if (!isRefTo(needle, param)) return undefined;
  if (!Array.isArray(list)) return undefined;
  return list.map((v) => String(v));
}

/** True when `expr` is `{ Ref: name }`. */
function isRefTo(expr: unknown, name: string): boolean {
  return isObject(expr) && expr.Ref === name;
}

/**
 * The template's validation predicate: a (cpu, memory) pair is accepted iff
 *   - cpu is in TaskCpu.AllowedValues, AND
 *   - memory is in TaskMemory.AllowedValues, AND
 *   - the Rules assertion for that cpu allows that memory.
 */
function makeTemplatePredicate(template: TemplateModel): (cpu: string, mem: string) => boolean {
  const cpuAllowed = new Set(allowedValues(template, "TaskCpu"));
  const memAllowed = new Set(allowedValues(template, "TaskMemory"));
  const rules = parseCpuMemoryRules(template);

  return (cpu: string, mem: string): boolean => {
    if (!cpuAllowed.has(cpu)) return false;
    if (!memAllowed.has(mem)) return false;
    const allowedForCpu = rules[cpu];
    // A CPU with no rule would accept any allowed memory; the template defines
    // a rule for every CPU, so a missing rule means the pair is not covered.
    if (allowedForCpu === undefined) return false;
    return allowedForCpu.has(mem);
  };
}

describe("Property 5: Fargate CPU/memory combinations are accepted exactly when valid", () => {
  const model = loadArtifactModel();
  const service = model.templates["04-ecs-service"];

  it("template-parsed Rules match the official Fargate matrix", () => {
    // Guards the predicate: the mapping the template encodes must equal the
    // official matrix, otherwise the iff check below would be self-fulfilling.
    const parsed = parseCpuMemoryRules(service);
    for (const [cpu, mems] of Object.entries(OFFICIAL_MATRIX)) {
      expect(parsed[cpu], `rule present for CPU ${cpu}`).toBeDefined();
      expect([...parsed[cpu]].sort()).toEqual([...mems].sort());
    }
    // No extra CPU rules beyond the official set.
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(OFFICIAL_MATRIX).sort());
  });

  it("accepts a (CPU, memory) pair iff it is in the official valid set", () => {
    const accepts = makeTemplatePredicate(service);
    const validSet = officialValidSet();

    // Candidate CPU/memory values: the union of the template's allowed values
    // and a few clearly-invalid ones, so both valid and invalid pairs are drawn.
    const cpuCandidates = [
      ...allowedValues(service, "TaskCpu"),
      "128", // below range
      "8192", // above range / not a Fargate CPU value
    ];
    const memoryCandidates = [
      ...allowedValues(service, "TaskMemory"),
      "256", // below the smallest allowed memory
      "1024000", // absurdly large
      "600", // not a multiple / not in the discrete set
    ];

    fc.assert(
      fc.property(
        fc.constantFrom(...cpuCandidates),
        fc.constantFrom(...memoryCandidates),
        (cpu, memory) => {
          const inOfficial = validSet.has(`${cpu}|${memory}`);
          expect(accepts(cpu, memory)).toBe(inOfficial);
        },
      ),
      { numRuns: 200 },
    );
  });
});
