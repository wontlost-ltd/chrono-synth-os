/**
 * PII detector + data-classification tagging.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §4.1 P1-Q-1
 *
 * Distinct from src/conversation/pii-redactor.ts:
 *   - redactor: mutates text (replaces matches with [REDACTED_*])
 *   - detector: returns match metadata WITHOUT mutating — used for
 *     classification, evidence tagging, scanner reports
 *
 * Why both, not one:
 *   The redactor's job is to make output safe for downstream sinks
 *   (logs, LLM providers). The detector's job is to *label* — auditors
 *   need "this field contains PII of these types" for data-residency,
 *   DSAR, and SOC2 CC6.1 evidence. A single API trying to do both
 *   creates a footgun: you risk redacting content you only meant to
 *   classify.
 *
 * Patterns intentionally share the source-of-truth regex with the
 * redactor — see PII_PATTERNS export. Keeping detection and redaction
 * in sync prevents drift where a string passes the detector but the
 * redactor misses it (or vice versa).
 */

export type PiiCategory =
  | 'phone' | 'email' | 'id_card' | 'card_no'
  | 'ipv4' | 'jwt' | 'api_key' | 'ssn';

/** Sensitivity tier — drives data-residency + retention policy. */
export type SensitivityTier = 'public' | 'internal' | 'pii' | 'phi' | 'pci';

/**
 * Classification tag — attached to a field at schema/runtime time. The
 * combination of category + sensitivity drives downstream policy:
 *   - residency: PHI / PCI never leave the original region
 *   - retention: PII default 365d, PCI tokenized only
 *   - logging: pii+ never to stdout-log unless redacted
 */
export interface FieldTag {
  category: PiiCategory | 'none';
  sensitivity: SensitivityTier;
}

interface DetectorPattern {
  category: PiiCategory;
  regex: RegExp;
}

/**
 * Source-of-truth patterns. Mirror src/conversation/pii-redactor.ts;
 * **do not** diverge — drift between detector and redactor means we
 * classify a string as PII but fail to redact it on egress (or vice
 * versa). When changing a pattern here, update the redactor in the
 * same PR.
 *
 * Patterns are intentionally conservative (over-match preferred over
 * miss). For detection that's the safer bias — false-positive
 * classification triggers extra ceremony, false-negative leaks PII.
 */
export const PII_PATTERNS: readonly DetectorPattern[] = [
  /* 中国大陆手机号 */
  { category: 'phone', regex: /(?:\+?86[\s-]?)?1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}\b/g },
  /* 通用国际手机号（+ 国家码 + 至少 9 位） */
  { category: 'phone', regex: /\+\d{1,3}[\s-]\d{2,4}[\s-]\d{3,4}[\s-]\d{3,4}\b/g },
  /* 邮箱 */
  { category: 'email', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  /* 中国身份证 18 位 */
  { category: 'id_card', regex: /\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g },
  /* 银行卡（visa / master / amex / 银联） */
  { category: 'card_no', regex: /\b(?:4\d{12}(?:\d{3})?|5[1-5]\d{14}|3[47]\d{13}|62\d{14,17})\b/g },
  /* IPv4 — informational; auditors may treat IP as PII under GDPR */
  { category: 'ipv4', regex: /\b(?:25[0-5]|2[0-4]\d|1?\d\d?)(?:\.(?:25[0-5]|2[0-4]\d|1?\d\d?)){3}\b/g },
  /* JWT (3 base64url segments). Restrict to substantial length to avoid
   * matching base64-encoded SHA-256 fingerprints that just happen to
   * contain two dots. */
  { category: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  /* API keys with common vendor prefixes */
  { category: 'api_key', regex: /\b(?:sk|pk|ghp|xoxb|AKIA|AIza|gho|ya29)[_-][A-Za-z0-9_-]{16,}\b/g },
  /* US SSN — added beyond the redactor surface since SOC2 audit
   * fixtures use US data and procurement reviewers ask about it. */
  { category: 'ssn', regex: /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
];

/** One match found in the input. */
export interface Detection {
  category: PiiCategory;
  /** Index in the input where the match starts. */
  start: number;
  /** Index immediately after the match. */
  end: number;
  /** The matched substring — note: for downstream evidence rows do NOT
   *  log this directly; the whole point of detection is to NOT
   *  proliferate the PII. */
  matched: string;
}

export interface DetectionReport {
  text: string;
  detections: Detection[];
  /** Distinct categories that matched at least once. */
  categories: ReadonlySet<PiiCategory>;
  /** Per-category match counts. */
  counts: ReadonlyMap<PiiCategory, number>;
}

/**
 * Scan input for PII matches. Pure function — no I/O, no mutation of
 * input. Returns every match with start/end offsets so callers can:
 *   - decide whether to redact (and where)
 *   - tag the storing field with `sensitivity: 'pii'`
 *   - emit a classification evidence row counting matches by category
 *     (without storing the matched text itself)
 */
export function detectPii(text: string | null | undefined): DetectionReport {
  const detections: Detection[] = [];
  const counts = new Map<PiiCategory, number>();
  if (!text) return { text: text ?? '', detections, categories: new Set(), counts };

  for (const pat of PII_PATTERNS) {
    /* Reset lastIndex for each scan since regexes are shared module-level
     * with the `g` flag — without reset, repeated calls would silently
     * skip earlier matches. */
    pat.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.regex.exec(text)) !== null) {
      detections.push({
        category: pat.category,
        start: m.index,
        end: m.index + m[0].length,
        matched: m[0],
      });
      counts.set(pat.category, (counts.get(pat.category) ?? 0) + 1);
    }
  }
  /* Sort by start offset so callers can iterate in document order. */
  detections.sort((a, b) => a.start - b.start);
  return {
    text,
    detections,
    categories: new Set(counts.keys()),
    counts,
  };
}

/**
 * Map a free-form text body to the strongest classification tag found.
 * Used at schema-definition time to label fields, and at runtime when
 * an inbound record arrives without an a-priori classification.
 *
 * Priority (strongest first): pci > phi > pii > internal > public.
 * Today we only detect pii / pci-adjacent (card_no); phi requires
 * dictionary-based detection that v1 doesn't ship. So in practice
 * `tag.sensitivity` is either 'public' or 'pii' for now.
 */
export function classifyText(text: string | null | undefined): FieldTag {
  const report = detectPii(text);
  if (report.categories.has('card_no')) return { category: 'card_no', sensitivity: 'pci' };
  if (report.categories.size > 0) {
    const first = report.categories.values().next().value!;
    return { category: first, sensitivity: 'pii' };
  }
  return { category: 'none', sensitivity: 'public' };
}

/**
 * Build the evidence payload for a classification scan — counts only, no
 * matched text. Auditors get "field X contained N matches of categories
 * [phone, email]" without us proliferating PII in the audit log.
 */
export function classificationEvidence(report: DetectionReport): {
  totalMatches: number;
  byCategory: Record<string, number>;
} {
  const byCategory: Record<string, number> = {};
  for (const [cat, n] of report.counts) byCategory[cat] = n;
  return { totalMatches: report.detections.length, byCategory };
}
