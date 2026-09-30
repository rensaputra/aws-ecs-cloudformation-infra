import { describe, it, expect } from "vitest";
import fc from "fast-check";

/**
 * Property 1: Subnet CIDR layout is non-overlapping and complete per AZ
 *
 * Feature: aws-ecs-cloudformation-infra, Property 1: Subnet CIDR layout is
 * non-overlapping and complete per AZ
 *
 * Validates: Requirements 1.3
 *
 * For any valid VPC CIDR (prefix /16-/26) and any Availability Zone count in
 * the supported range (2-3), the derived subnet layout contains exactly one
 * public and exactly one private subnet per AZ, and all derived subnet CIDR
 * blocks are pairwise non-overlapping and contained within the VPC CIDR.
 *
 * `templates/00-vpc.yml` derives subnet CIDRs with:
 *   PublicSubnet{N}:  CidrBlock: !Select [N-1, !Cidr [!Ref VpcCidr, 6, 3]]  (indices 0-2)
 *   PrivateSubnet{N}: CidrBlock: !Select [N+2, !Cidr [!Ref VpcCidr, 6, 3]]  (indices 3-5)
 *
 * CloudFormation is not executed here, so the Fn::Cidr derivation is replicated
 * in TypeScript below. Per the AWS Fn::Cidr semantics, `Fn::Cidr [ipBlock,
 * count, cidrBits]` returns `count` CIDR blocks, each with a subnet mask of
 * `32 - cidrBits` for IPv4 (cidrBits is the number of host/subnet bits, the
 * inverse of the mask). With cidrBits=3 each derived subnet is a /29, and the
 * `count` blocks are laid out contiguously from the base of the VPC CIDR:
 * block i starts at base + i * 2^cidrBits.
 */

// ---------------------------------------------------------------------------
// Fn::Cidr replication (IPv4)
// ---------------------------------------------------------------------------

/** Parse an "a.b.c.d/p" string into a numeric base address and prefix. */
function parseCidr(cidr: string): { base: number; prefix: number } {
  const [ip, prefixStr] = cidr.split("/");
  const prefix = Number(prefixStr);
  const octets = ip.split(".").map((o) => Number(o));
  // Unsigned 32-bit base address.
  const base =
    ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  return { base, prefix };
}

/** Format a numeric address + prefix as an "a.b.c.d/p" CIDR string. */
function formatCidr(addr: number, prefix: number): string {
  const a = (addr >>> 24) & 0xff;
  const b = (addr >>> 16) & 0xff;
  const c = (addr >>> 8) & 0xff;
  const d = addr & 0xff;
  return `${a}.${b}.${c}.${d}/${prefix}`;
}

interface DerivedCidr {
  cidr: string;
  /** Inclusive start address (unsigned 32-bit). */
  start: number;
  /** Inclusive end address (unsigned 32-bit). */
  end: number;
  prefix: number;
}

/**
 * Replicate `Fn::Cidr [ipBlock, count, cidrBits]` for IPv4.
 *
 * Returns `count` CIDR blocks, each a /(32 - cidrBits), laid out contiguously
 * from the base of `ipBlock`: block i = base + i * 2^cidrBits.
 */
function fnCidr(ipBlock: string, count: number, cidrBits: number): DerivedCidr[] {
  const { base, prefix } = parseCidr(ipBlock);
  const subnetPrefix = 32 - cidrBits;
  const blockSize = 2 ** cidrBits; // addresses per derived block
  // Normalize base to the network address for its prefix.
  const networkMask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const networkBase = (base & networkMask) >>> 0;

  const out: DerivedCidr[] = [];
  for (let i = 0; i < count; i++) {
    const start = (networkBase + i * blockSize) >>> 0;
    const end = (start + blockSize - 1) >>> 0;
    out.push({ cidr: formatCidr(start, subnetPrefix), start, end, prefix: subnetPrefix });
  }
  return out;
}

/** True if [start,end] of `a` overlaps [start,end] of `b`. */
function overlaps(a: DerivedCidr, b: DerivedCidr): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/** True if `inner` is fully contained within the [start,end] of `outer`. */
function contains(outer: { start: number; end: number }, inner: DerivedCidr): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

/** The [start,end] address range of a VPC CIDR. */
function cidrRange(cidr: string): { start: number; end: number } {
  const { base, prefix } = parseCidr(cidr);
  const networkMask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const start = (base & networkMask) >>> 0;
  const size = 2 ** (32 - prefix);
  const end = (start + size - 1) >>> 0;
  return { start, end };
}

// ---------------------------------------------------------------------------
// Template-faithful subnet derivation
// ---------------------------------------------------------------------------

/**
 * Derive the public/private subnet CIDRs exactly as templates/00-vpc.yml does:
 * `!Cidr [VpcCidr, 6, 3]` with public = indices 0..azCount-1 and
 * private = indices 3..3+azCount-1.
 */
function deriveSubnets(vpcCidr: string, azCount: number): {
  public: DerivedCidr[];
  private: DerivedCidr[];
} {
  const blocks = fnCidr(vpcCidr, 6, 3);
  const publicSubnets = blocks.slice(0, azCount); // indices 0..azCount-1
  const privateSubnets = blocks.slice(3, 3 + azCount); // indices 3..3+azCount-1
  return { public: publicSubnets, private: privateSubnets };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Generate a syntactically valid VPC CIDR with a prefix in [16, 26], with the
 * base address aligned to the prefix (a proper network address) so it matches
 * the AllowedPattern-constrained inputs the template accepts. The upper bound
 * is /26 because the template derives six /29 subnets, which only fit inside a
 * /26 or larger VPC.
 */
const vpcCidrArb: fc.Arbitrary<string> = fc
  .record({
    prefix: fc.integer({ min: 16, max: 26 }),
    addr: fc.integer({ min: 0, max: 0xffffffff }),
  })
  .map(({ prefix, addr }) => {
    const mask = (0xffffffff << (32 - prefix)) >>> 0;
    const network = (addr & mask) >>> 0;
    return formatCidr(network, prefix);
  });

/** Supported AZ counts: 2 or 3. */
const azCountArb: fc.Arbitrary<number> = fc.constantFrom(2, 3);

// ---------------------------------------------------------------------------
// Property test
// ---------------------------------------------------------------------------

describe("Feature: aws-ecs-cloudformation-infra, Property 1: Subnet CIDR layout is non-overlapping and complete per AZ", () => {
  it("derives exactly one public + one private subnet per AZ, pairwise non-overlapping and within the VPC CIDR", () => {
    fc.assert(
      fc.property(vpcCidrArb, azCountArb, (vpcCidr, azCount) => {
        const { public: publicSubnets, private: privateSubnets } = deriveSubnets(
          vpcCidr,
          azCount,
        );

        // Exactly one public and one private subnet per AZ.
        expect(publicSubnets).toHaveLength(azCount);
        expect(privateSubnets).toHaveLength(azCount);

        const all = [...publicSubnets, ...privateSubnets];
        // Total subnet count is 2 * azCount.
        expect(all).toHaveLength(2 * azCount);

        // All derived CIDRs pairwise non-overlapping.
        for (let i = 0; i < all.length; i++) {
          for (let j = i + 1; j < all.length; j++) {
            expect(overlaps(all[i], all[j])).toBe(false);
          }
        }

        // Each derived CIDR is contained within the VPC CIDR.
        const vpc = cidrRange(vpcCidr);
        for (const subnet of all) {
          expect(contains(vpc, subnet)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});
