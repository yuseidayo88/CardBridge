/**
 * Condition descriptors for graded trading cards.
 *
 * eBay requires trading-card listings in categories 183050, 183454 and 261328
 * to use Condition ID 2750 (Graded) or 4000 (Ungraded), and 2750 requires a
 * `conditionDescriptors` array naming the grader and the grade.
 *
 * The IDs involved (27501 Professional Grader, 27502 Grade, 27503
 * Certification Number, and the value IDs beneath them) are NOT hard-coded
 * here. eBay revises these, and a stale literal produces a listing that
 * silently advertises the wrong grade — the kind of error that looks fine in
 * every review and is discovered by a buyer.
 *
 * Instead, everything is resolved from a cached `getItemConditionPolicies`
 * response. If the cache cannot answer, resolution fails loudly and the item
 * does not get listed.
 */

/** Shape of the parts of getItemConditionPolicies we rely on. */
export interface ConditionPolicyResponse {
  itemConditionPolicies?: Array<{
    categoryId?: string;
    itemConditions?: Array<{
      conditionId?: string;
      conditionDescription?: string;
      conditionDescriptors?: Array<{
        name?: string;
        conditionDescriptorId?: string;
        /** Free text rather than an enumerated value (certification number). */
        usage?: string;
        values?: Array<{
          conditionDescriptorValueId?: string;
          conditionDescriptorValueName?: string;
        }>;
      }>;
    }>;
  }>;
}

export interface ResolvedDescriptorIds {
  conditionId: string;
  graderDescriptorId: string;
  graderValueId: string;
  gradeDescriptorId: string;
  gradeValueId: string;
  /** Null when the category does not offer a certification-number field. */
  certificationNumberDescriptorId: string | null;
}

export class ConditionPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConditionPolicyError';
  }
}

/** Descriptor names as they appear in the policy response. */
const GRADER_NAMES = ['professional grader', 'grader'];
const GRADE_NAMES = ['grade'];
const CERT_NAMES = ['certification number', 'certification'];

function normalise(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/**
 * Resolve the IDs needed to describe "PSA 10" (or any grader/grade) for a
 * category, from a cached policy response.
 *
 * Every failure is explicit. Returning a partially-resolved descriptor set
 * would produce an API call that either errors opaquely or, worse, succeeds
 * with the wrong grade attached.
 */
export function resolveConditionDescriptors(
  policy: ConditionPolicyResponse,
  categoryId: string,
  gradingCompany: string,
  grade: number,
): ResolvedDescriptorIds {
  const categoryPolicy = policy.itemConditionPolicies?.find((p) => p.categoryId === categoryId);
  if (!categoryPolicy) {
    throw new ConditionPolicyError(
      `No condition policy cached for category ${categoryId}. Refresh the Metadata API cache before listing.`,
    );
  }

  // "Graded" is identified by its descriptors, not by assuming 2750 — the
  // response is the authority on what the condition ID actually is.
  const gradedCondition = categoryPolicy.itemConditions?.find((c) =>
    c.conditionDescriptors?.some((d) => GRADER_NAMES.includes(normalise(d.name))),
  );
  if (!gradedCondition?.conditionId) {
    throw new ConditionPolicyError(
      `Category ${categoryId} has no graded condition offering a professional-grader descriptor.`,
    );
  }

  const descriptors = gradedCondition.conditionDescriptors ?? [];

  const graderDescriptor = descriptors.find((d) => GRADER_NAMES.includes(normalise(d.name)));
  const gradeDescriptor = descriptors.find((d) => GRADE_NAMES.includes(normalise(d.name)));
  const certDescriptor = descriptors.find((d) => CERT_NAMES.includes(normalise(d.name)));

  if (!graderDescriptor?.conditionDescriptorId) {
    throw new ConditionPolicyError(`No professional-grader descriptor for category ${categoryId}.`);
  }
  if (!gradeDescriptor?.conditionDescriptorId) {
    throw new ConditionPolicyError(`No grade descriptor for category ${categoryId}.`);
  }

  const graderValue = graderDescriptor.values?.find(
    (v) => normalise(v.conditionDescriptorValueName) === normalise(gradingCompany),
  );
  if (!graderValue?.conditionDescriptorValueId) {
    const available = (graderDescriptor.values ?? [])
      .map((v) => v.conditionDescriptorValueName)
      .filter(Boolean)
      .join(', ');
    throw new ConditionPolicyError(
      `Grading company "${gradingCompany}" is not offered for category ${categoryId}. Available: ${available || 'none'}`,
    );
  }

  // eBay may express grade values as "10", "10.0" or "GEM MINT 10" depending
  // on the category, so match on the numeric content rather than the literal.
  const gradeText = formatGrade(grade);
  const gradeValue = gradeDescriptor.values?.find((v) => {
    const name = normalise(v.conditionDescriptorValueName);
    return (
      name === gradeText || name === grade.toFixed(1) || new RegExp(`\\b${gradeText}\\b`).test(name)
    );
  });
  if (!gradeValue?.conditionDescriptorValueId) {
    const available = (gradeDescriptor.values ?? [])
      .map((v) => v.conditionDescriptorValueName)
      .filter(Boolean)
      .join(', ');
    throw new ConditionPolicyError(
      `Grade "${gradeText}" is not offered for category ${categoryId}. Available: ${available || 'none'}`,
    );
  }

  return {
    conditionId: gradedCondition.conditionId,
    graderDescriptorId: graderDescriptor.conditionDescriptorId,
    graderValueId: graderValue.conditionDescriptorValueId,
    gradeDescriptorId: gradeDescriptor.conditionDescriptorId,
    gradeValueId: gradeValue.conditionDescriptorValueId,
    certificationNumberDescriptorId: certDescriptor?.conditionDescriptorId ?? null,
  };
}

export interface ConditionDescriptorPayload {
  name: string;
  values?: string[];
  additionalInfo?: string;
}

/**
 * Build the conditionDescriptors array.
 *
 * The certification number is optional in eBay's schema, and this system
 * deliberately omits it unless the listing is tied to one specific physical
 * slab. Sending a certification number that does not match the card actually
 * shipped would be a misdescription, so "no number" is the correct output
 * whenever the number is unknown or the image is representative.
 */
export function buildConditionDescriptors(
  resolved: ResolvedDescriptorIds,
  certificationNumber?: string | null,
): ConditionDescriptorPayload[] {
  const descriptors: ConditionDescriptorPayload[] = [
    { name: resolved.graderDescriptorId, values: [resolved.graderValueId] },
    { name: resolved.gradeDescriptorId, values: [resolved.gradeValueId] },
  ];

  if (certificationNumber && resolved.certificationNumberDescriptorId) {
    descriptors.push({
      name: resolved.certificationNumberDescriptorId,
      additionalInfo: certificationNumber,
    });
  }

  return descriptors;
}

function formatGrade(grade: number): string {
  return Number.isInteger(grade) ? String(grade) : String(grade);
}
