import { describe, expect, it } from 'vitest';
import {
  ConditionPolicyError,
  buildConditionDescriptors,
  resolveConditionDescriptors,
  type ConditionPolicyResponse,
} from './condition-descriptors';

/**
 * A stand-in for a cached getItemConditionPolicies response.
 *
 * The IDs here mirror the shape eBay documents for trading cards (27501
 * Professional Grader, 27502 Grade, 27503 Certification Number), but the point
 * of these tests is that the code READS them rather than assuming them — so
 * the second suite deliberately uses completely different IDs and expects the
 * same behaviour.
 */
const policy = (over?: Partial<ConditionPolicyResponse>): ConditionPolicyResponse => ({
  itemConditionPolicies: [
    {
      categoryId: '183454',
      itemConditions: [
        {
          conditionId: '2750',
          conditionDescription: 'Graded',
          conditionDescriptors: [
            {
              name: 'Professional Grader',
              conditionDescriptorId: '27501',
              values: [
                { conditionDescriptorValueId: '275010', conditionDescriptorValueName: 'PSA' },
                { conditionDescriptorValueId: '275011', conditionDescriptorValueName: 'BGS' },
                { conditionDescriptorValueId: '275012', conditionDescriptorValueName: 'CGC' },
              ],
            },
            {
              name: 'Grade',
              conditionDescriptorId: '27502',
              values: [
                { conditionDescriptorValueId: '275020', conditionDescriptorValueName: '10' },
                { conditionDescriptorValueId: '275021', conditionDescriptorValueName: '9.5' },
                { conditionDescriptorValueId: '275022', conditionDescriptorValueName: '9' },
              ],
            },
            {
              name: 'Certification Number',
              conditionDescriptorId: '27503',
              usage: 'FREE_TEXT',
            },
          ],
        },
        { conditionId: '4000', conditionDescription: 'Ungraded' },
      ],
    },
  ],
  ...over,
});

describe('resolveConditionDescriptors — reads the policy, never assumes', () => {
  it('resolves PSA 10 from a cached policy', () => {
    const resolved = resolveConditionDescriptors(policy(), '183454', 'PSA', 10);

    expect(resolved.conditionId).toBe('2750');
    expect(resolved.graderDescriptorId).toBe('27501');
    expect(resolved.graderValueId).toBe('275010');
    expect(resolved.gradeDescriptorId).toBe('27502');
    expect(resolved.gradeValueId).toBe('275020');
    expect(resolved.certificationNumberDescriptorId).toBe('27503');
  });

  it('follows the policy when eBay changes the IDs', () => {
    // The whole point: nothing is hard-coded, so a revised numbering scheme is
    // picked up automatically rather than silently mislabelling the grade.
    const renumbered: ConditionPolicyResponse = {
      itemConditionPolicies: [
        {
          categoryId: '183454',
          itemConditions: [
            {
              conditionId: '9999',
              conditionDescriptors: [
                {
                  name: 'Professional Grader',
                  conditionDescriptorId: '88801',
                  values: [
                    { conditionDescriptorValueId: 'X-PSA', conditionDescriptorValueName: 'PSA' },
                  ],
                },
                {
                  name: 'Grade',
                  conditionDescriptorId: '88802',
                  values: [
                    { conditionDescriptorValueId: 'X-10', conditionDescriptorValueName: '10' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const resolved = resolveConditionDescriptors(renumbered, '183454', 'PSA', 10);
    expect(resolved.conditionId).toBe('9999');
    expect(resolved.graderValueId).toBe('X-PSA');
    expect(resolved.gradeValueId).toBe('X-10');
    expect(resolved.certificationNumberDescriptorId).toBeNull();
  });

  it('matches a grade expressed as "GEM MINT 10"', () => {
    const verbose = policy();
    verbose.itemConditionPolicies![0]!.itemConditions![0]!.conditionDescriptors![1]!.values = [
      { conditionDescriptorValueId: 'G10', conditionDescriptorValueName: 'GEM MINT 10' },
    ];
    expect(resolveConditionDescriptors(verbose, '183454', 'PSA', 10).gradeValueId).toBe('G10');
  });

  it('is case-insensitive about the grading company', () => {
    expect(resolveConditionDescriptors(policy(), '183454', 'psa', 10).graderValueId).toBe('275010');
  });
});

describe('resolveConditionDescriptors — fails loudly', () => {
  it('refuses when no policy is cached for the category', () => {
    expect(() => resolveConditionDescriptors(policy(), '999999', 'PSA', 10)).toThrow(
      ConditionPolicyError,
    );
    expect(() => resolveConditionDescriptors(policy(), '999999', 'PSA', 10)).toThrow(
      /Refresh the Metadata API cache/,
    );
  });

  it('refuses an unsupported grading company and says what is available', () => {
    expect(() => resolveConditionDescriptors(policy(), '183454', 'ARS', 10)).toThrow(
      /not offered.*Available: PSA, BGS, CGC/s,
    );
  });

  it('refuses an unsupported grade', () => {
    expect(() => resolveConditionDescriptors(policy(), '183454', 'PSA', 8)).toThrow(
      /Grade "8" is not offered/,
    );
  });

  it('refuses when the category offers no graded condition', () => {
    const ungradedOnly: ConditionPolicyResponse = {
      itemConditionPolicies: [{ categoryId: '183454', itemConditions: [{ conditionId: '4000' }] }],
    };
    expect(() => resolveConditionDescriptors(ungradedOnly, '183454', 'PSA', 10)).toThrow(
      /no graded condition/,
    );
  });

  it('refuses an empty policy rather than defaulting', () => {
    expect(() => resolveConditionDescriptors({}, '183454', 'PSA', 10)).toThrow(
      ConditionPolicyError,
    );
  });
});

describe('buildConditionDescriptors', () => {
  const resolved = resolveConditionDescriptors(policy(), '183454', 'PSA', 10);

  it('emits grader and grade in eBay Inventory API form', () => {
    expect(buildConditionDescriptors(resolved)).toEqual([
      { name: '27501', values: ['275010'] },
      { name: '27502', values: ['275020'] },
    ]);
  });

  it('omits the certification number when there is none', () => {
    const descriptors = buildConditionDescriptors(resolved, null);
    expect(descriptors).toHaveLength(2);
    expect(descriptors.some((d) => d.name === '27503')).toBe(false);
  });

  it('includes the certification number when the listing is tied to one slab', () => {
    const descriptors = buildConditionDescriptors(resolved, 'A233434');
    expect(descriptors).toContainEqual({ name: '27503', additionalInfo: 'A233434' });
  });

  it('omits the certification number when the category has no such field', () => {
    const noCert = { ...resolved, certificationNumberDescriptorId: null };
    expect(buildConditionDescriptors(noCert, 'A233434')).toHaveLength(2);
  });

  it('treats an empty certification number as absent', () => {
    expect(buildConditionDescriptors(resolved, '')).toHaveLength(2);
  });
});
