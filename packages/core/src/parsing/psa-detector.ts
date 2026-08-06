import type { PsaEvaluation, PsaVerdict } from '../types/catalog';
import { normalizeTitle } from './normalizers';

/**
 * Decide whether a listing really is a PSA 10 Pokémon card single.
 *
 * The requirement is explicit that "PSA10" appearing in a title is not proof.
 * Shops put it in titles loosely, sellers copy each other's wording, and a
 * "PSA10相当" ("equivalent to PSA 10") listing is an ungraded card. Buying and
 * relisting one of those as a graded card is both a financial loss and an eBay
 * policy problem.
 *
 * So this weighs several independent signals and returns one of three verdicts.
 * REVIEW is a first-class outcome, not a failure mode: an ambiguous item is
 * surfaced to a human rather than silently dropped or silently accepted.
 */

export interface PsaDetectionInput {
  title: string;
  /** Category breadcrumb trail, if the shop exposes one. */
  breadcrumbs?: string[];
  description?: string | null;
  /** Category page the item was crawled from. */
  sourceCategoryUrl?: string | null;
  /** Grading company parsed from structured data, when available. */
  structuredGradingCompany?: string | null;
  structuredGrade?: number | null;
}

interface Signal {
  name: string;
  weight: number;
  detail: string;
}

/**
 * Phrases that mean "not actually graded 10", in the order they must be
 * checked — before any positive signal, because a single one of these
 * disqualifies the item regardless of what else the title says.
 */
const DISQUALIFYING_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /PSA\s*10\s*(相当|級|クラス|レベル)/i, reason: '"PSA10相当" means ungraded' },
  { pattern: /(相当|同等)品/i, reason: 'described as an equivalent, not the graded item' },
  { pattern: /PSA\s*[1-9](?!\d)/i, reason: 'a PSA grade below 10 appears in the title' },
  { pattern: /\b(BGS|CGC|SGC|ARS)\s*(10|9\.5|9)/i, reason: 'graded by a company other than PSA' },
  { pattern: /(未鑑定|未評価|生カード|raw\b)/i, reason: 'explicitly ungraded' },
  { pattern: /(BOX|ボックス|カートン)/i, reason: 'a sealed box, not a single card' },
  { pattern: /(パック|pack\b|スリーブ|デッキケース|サプライ)/i, reason: 'a pack or supply item' },
  { pattern: /(まとめ売り|セット販売|\d+枚セット)/i, reason: 'a bundle, not a single card' },
  { pattern: /(ダメージ|傷あり|折れ|キズ)/i, reason: 'damage noted — inconsistent with a 10' },
];

/**
 * Other TCGs. The scope is Pokémon only, and a PSA 10 Yu-Gi-Oh card would
 * otherwise sail through every PSA signal.
 */
const NON_POKEMON_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(遊戯王|yu-?gi-?oh)/i, reason: 'Yu-Gi-Oh' },
  { pattern: /(デュエマ|デュエル・?マスターズ|duel\s*masters)/i, reason: 'Duel Masters' },
  // "ONE PIECEカード" mixes the English title with a Japanese noun, so matching
  // on "one piece card" alone misses the common form.
  { pattern: /(ワンピース|one\s*piece)/i, reason: 'One Piece Card Game' },
  {
    pattern: /(マジック[:：]?ザ・?ギャザリング|\bMTG\b|magic.{0,3}the\s*gathering)/i,
    reason: 'MTG',
  },
  { pattern: /(ヴァイスシュヴァルツ|weiss\s*schwarz)/i, reason: 'Weiss Schwarz' },
  { pattern: /(バトルスピリッツ|battle\s*spirits)/i, reason: 'Battle Spirits' },
  { pattern: /(シャドウバース|shadowverse)/i, reason: 'Shadowverse' },
  { pattern: /(ドラゴンボール|dragon\s*ball)/i, reason: 'Dragon Ball' },
];

const POKEMON_PATTERNS = [
  /(ポケモン|ポケカ|pokemon|pok[ée]mon)/i,
  // Common Pokémon-specific card mechanics that do not appear in other TCGs.
  /\b(ex|GX|VMAX|VSTAR|V-?UNION)\b/i,
  /(リザードン|ピカチュウ|ミュウ|イーブイ|ルギア|レックウザ)/,
];

export function detectPsa10(input: PsaDetectionInput): PsaEvaluation {
  const title = normalizeTitle(input.title);
  const description = input.description ? normalizeTitle(input.description) : '';
  const breadcrumbText = normalizeTitle((input.breadcrumbs ?? []).join(' '));
  const haystack = `${title} ${breadcrumbText} ${description}`;

  const evidence: PsaEvaluation['evidence'] = [];
  const reasons: string[] = [];
  const positives: Signal[] = [];

  // --- disqualifiers ------------------------------------------------------
  // Checked against the title and description only. A category breadcrumb
  // containing the word "パック" is about the shop's navigation, not this item.
  const disqualifyHaystack = `${title} ${description}`;
  for (const { pattern, reason } of DISQUALIFYING_PATTERNS) {
    const hit = pattern.test(disqualifyHaystack);
    evidence.push({
      signal: `disqualifier:${pattern.source.slice(0, 40)}`,
      found: hit,
      weight: hit ? -1 : 0,
      detail: reason,
    });
    if (hit) reasons.push(reason);
  }
  if (reasons.length > 0) {
    return { verdict: 'REJECTED', confidence: 1, evidence, reasons };
  }

  // --- other TCGs ---------------------------------------------------------
  for (const { pattern, reason } of NON_POKEMON_PATTERNS) {
    if (pattern.test(haystack)) {
      evidence.push({ signal: 'non-pokemon', found: true, weight: -1, detail: reason });
      return {
        verdict: 'REJECTED',
        confidence: 1,
        evidence,
        reasons: [`not a Pokémon card: ${reason}`],
      };
    }
  }

  // --- positive signals ---------------------------------------------------

  // Structured data is the strongest evidence available: the shop stated it in
  // machine-readable form rather than in prose we had to interpret.
  if (input.structuredGradingCompany && input.structuredGrade != null) {
    const isPsa10 =
      /^psa$/i.test(input.structuredGradingCompany.trim()) && input.structuredGrade === 10;
    evidence.push({
      signal: 'structured_data',
      found: isPsa10,
      weight: isPsa10 ? 0.5 : 0,
      detail: `structured data reports ${input.structuredGradingCompany} ${input.structuredGrade}`,
    });
    if (isPsa10) {
      positives.push({ name: 'structured_data', weight: 0.5, detail: 'PSA 10 in structured data' });
    } else {
      return {
        verdict: 'REJECTED',
        confidence: 1,
        evidence,
        reasons: [
          `structured data says ${input.structuredGradingCompany} ${input.structuredGrade}, not PSA 10`,
        ],
      };
    }
  }

  const titlePsa10 = /PSA\s*10\b/i.test(title);
  evidence.push({
    signal: 'title_psa10',
    found: titlePsa10,
    weight: titlePsa10 ? 0.35 : 0,
    detail: titlePsa10 ? 'title contains PSA 10' : 'title does not mention PSA 10',
  });
  if (titlePsa10)
    positives.push({ name: 'title_psa10', weight: 0.35, detail: 'title says PSA 10' });

  const categoryPsa = /PSA/i.test(breadcrumbText) || /psa/i.test(input.sourceCategoryUrl ?? '');
  evidence.push({
    signal: 'category_psa',
    found: categoryPsa,
    weight: categoryPsa ? 0.25 : 0,
    detail: categoryPsa ? 'crawled from a PSA category' : 'not from a PSA-specific category',
  });
  if (categoryPsa) {
    positives.push({ name: 'category_psa', weight: 0.25, detail: 'PSA category' });
  }

  const descriptionPsa10 = /PSA\s*10\b/i.test(description) || /GEM\s*MT?\b/i.test(description);
  evidence.push({
    signal: 'description_psa10',
    found: descriptionPsa10,
    weight: descriptionPsa10 ? 0.2 : 0,
    detail: descriptionPsa10
      ? 'description corroborates PSA 10'
      : 'description does not mention it',
  });
  if (descriptionPsa10) {
    positives.push({ name: 'description_psa10', weight: 0.2, detail: 'description corroborates' });
  }

  const isPokemon = POKEMON_PATTERNS.some((p) => p.test(haystack));
  evidence.push({
    signal: 'pokemon',
    found: isPokemon,
    weight: isPokemon ? 0.2 : 0,
    detail: isPokemon ? 'identified as Pokémon' : 'no positive Pokémon signal',
  });
  if (isPokemon) positives.push({ name: 'pokemon', weight: 0.2, detail: 'Pokémon confirmed' });

  const confidence = Math.min(
    1,
    positives.reduce((sum, s) => sum + s.weight, 0),
  );

  // --- verdict ------------------------------------------------------------
  //
  // CONFIRMED requires corroboration: a PSA 10 claim plus at least one
  // independent signal, and a positive identification as Pokémon. A title on
  // its own is never enough, which is the whole point of this module.
  let verdict: PsaVerdict;
  if (!titlePsa10 && positives.every((p) => p.name !== 'structured_data')) {
    verdict = 'REJECTED';
    reasons.push('no PSA 10 claim in either the title or structured data');
  } else if (!isPokemon) {
    verdict = 'REVIEW';
    reasons.push('could not positively identify this as a Pokémon card');
  } else if (positives.length >= 3 && confidence >= 0.7) {
    verdict = 'CONFIRMED';
  } else {
    verdict = 'REVIEW';
    reasons.push('a PSA 10 claim exists but is not corroborated by enough independent signals');
  }

  return { verdict, confidence, evidence, reasons };
}
