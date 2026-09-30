import yaml from "js-yaml";

/**
 * CloudFormation-tag-aware js-yaml schema.
 *
 * CloudFormation templates use short-form intrinsic functions (`!Ref`,
 * `!Sub`, `!GetAtt`, `!ImportValue`, ...). Plain YAML parsing chokes on these
 * custom tags, so we register a `yaml.Type` for each one. Every short form is
 * represented as the object `{ "<Fn::Name>": <data> }` — exactly the long form
 * CloudFormation itself uses. That keeps the parsed tree uniform and, crucially,
 * lets the model traverse `Fn::ImportValue` / `Export.Name` structures without
 * caring whether the author wrote the short or long form.
 *
 * `!GetAtt` is special: the scalar short form `!GetAtt Resource.Attribute`
 * expands to `{ "Fn::GetAtt": ["Resource", "Attribute"] }`, matching how
 * CloudFormation normalizes it.
 */

/** The intrinsic short tags and the `Fn::`-prefixed key each maps to. */
const FN_TAGS: Record<string, string> = {
  Ref: "Ref",
  Condition: "Condition",
  Base64: "Fn::Base64",
  Cidr: "Fn::Cidr",
  FindInMap: "Fn::FindInMap",
  GetAtt: "Fn::GetAtt",
  GetAZs: "Fn::GetAZs",
  ImportValue: "Fn::ImportValue",
  Join: "Fn::Join",
  Select: "Fn::Select",
  Split: "Fn::Split",
  Sub: "Fn::Sub",
  Transform: "Fn::Transform",
  And: "Fn::And",
  Equals: "Fn::Equals",
  If: "Fn::If",
  Not: "Fn::Not",
  Or: "Fn::Or",
  Contains: "Fn::Contains",
  EachMemberEquals: "Fn::EachMemberEquals",
  EachMemberIn: "Fn::EachMemberIn",
  RefAll: "Fn::RefAll",
  ValueOf: "Fn::ValueOf",
  ValueOfAll: "Fn::ValueOfAll",
  Length: "Fn::Length",
  ToJsonString: "Fn::ToJsonString",
};

/**
 * `Ref` and `Condition` are always scalars; everything else can appear in
 * scalar, sequence, or mapping form depending on the author's style. We build a
 * `yaml.Type` for each (tag, kind) pair so js-yaml accepts them all.
 */
function buildCfnTypes(): yaml.Type[] {
  const kinds: Array<"scalar" | "sequence" | "mapping"> = [
    "scalar",
    "sequence",
    "mapping",
  ];

  const types: yaml.Type[] = [];

  for (const [shortName, fnKey] of Object.entries(FN_TAGS)) {
    for (const kind of kinds) {
      types.push(
        new yaml.Type(`!${shortName}`, {
          kind,
          // Accept any data of this kind; representation is uniform below.
          construct(data) {
            // `!GetAtt Resource.Attribute` (scalar) => ["Resource","Attribute"].
            if (shortName === "GetAtt" && typeof data === "string") {
              const dotIndex = data.indexOf(".");
              const parts =
                dotIndex === -1
                  ? [data]
                  : [data.slice(0, dotIndex), data.slice(dotIndex + 1)];
              return { [fnKey]: parts };
            }
            return { [fnKey]: data };
          },
        }),
      );
    }
  }

  return types;
}

/** A js-yaml schema extending the default schema with all CFN intrinsics. */
export const CFN_SCHEMA: yaml.Schema = yaml.DEFAULT_SCHEMA.extend(
  buildCfnTypes(),
);

/** Parse a CloudFormation YAML document into a plain JS object tree. */
export function parseCfnYaml(source: string): unknown {
  return yaml.load(source, { schema: CFN_SCHEMA });
}
