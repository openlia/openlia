import type { DocumentPasswordProfile, PasswordSuggestion } from "./api";

/**
 * Standard Levenshtein edit distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
  const s1 = a.toLowerCase();
  const s2 = b.toLowerCase();
  if (s1 === s2) return 0;
  if (s1.length === 0) return s2.length;
  if (s2.length === 0) return s1.length;

  let prev = Array.from({ length: s2.length + 1 }, (_, i) => i);
  const curr = new Array<number>(s2.length + 1);

  for (let i = 0; i < s1.length; i++) {
    curr[0] = i + 1;
    for (let j = 0; j < s2.length; j++) {
      const cost = s1[i] === s2[j] ? 0 : 1;
      const insertion = (curr[j] ?? 0) + 1;
      const deletion = (prev[j + 1] ?? 0) + 1;
      const substitution = (prev[j] ?? 0) + cost;
      curr[j + 1] = Math.min(insertion, deletion, substitution);
    }
    prev = [...curr];
  }

  return prev[s2.length] ?? 0;
}

/**
 * Normalized string similarity from 0.0 (completely different) to 1.0 (identical).
 */
export function stringSimilarity(a: string, b: string): number {
  const s1 = a.toLowerCase().trim();
  const s2 = b.toLowerCase().trim();
  if (!s1 && !s2) return 1.0;
  if (!s1 || !s2) return 0.0;
  if (s1 === s2) return 1.0;
  const maxLen = Math.max(s1.length, s2.length);
  const dist = levenshteinDistance(s1, s2);
  return Math.max(0, 1 - dist / maxLen);
}

/**
 * Converts a string into cleaned tokens, omitting common extensions, dates, and short words.
 */
export function extractKeywords(text: string): string[] {
  if (!text) return [];
  // Strip file extension if present (.pdf, .xlsx, etc.)
  const stripped = text.replace(/\.[a-z0-9]{1,8}$/i, "");
  // Tokenize on non-alphanumeric
  const rawTokens = stripped
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);

  // Filter out pure timestamps/dates like 2026, 20261018, etc. if accompanied by words
  const words = rawTokens.filter((t) => !/^\d{4,8}$/.test(t));
  return words.length > 0 ? words : rawTokens;
}

/**
 * Simple glob wildcard match supporting '*' and '?'.
 */
export function matchesGlob(pattern: string, text: string): boolean {
  if (!pattern || !text) return false;
  const regexStr =
    "^" +
    pattern
      .toLowerCase()
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".") +
    "$";
  try {
    const rx = new RegExp(regexStr, "i");
    return rx.test(text.toLowerCase());
  } catch {
    return false;
  }
}

export interface PasswordSuggestionInput {
  filename?: string | undefined;
  title?: string | undefined;
  correspondent?: string | undefined;
  message?: string | undefined;
}

/**
 * Evaluates candidate password profiles against file and message context,
 * computing a composite match score (0-100) using pattern globs, token Levenshtein
 * distance, and semantic keyword overlap.
 */
export function suggestPasswordProfiles(
  input: PasswordSuggestionInput,
  profiles: DocumentPasswordProfile[],
): PasswordSuggestion[] {
  if (!profiles || profiles.length === 0) return [];

  const filename = (input.filename || "").trim();
  const title = (input.title || "").trim();
  const correspondent = (input.correspondent || "").trim();
  const message = (input.message || "").trim();

  // Combine query text for token and keyword extraction
  const queryCombined = [filename, title, correspondent, message]
    .filter(Boolean)
    .join(" ");
  const queryTokens = extractKeywords(queryCombined);

  const results: PasswordSuggestion[] = [];

  for (const profile of profiles) {
    let score = 0;
    const reasons: string[] = [];

    // 1. Pattern Glob Matching (up to 50 pts)
    if (profile.patterns && profile.patterns.length > 0 && filename) {
      for (const pat of profile.patterns) {
        if (matchesGlob(pat, filename)) {
          score += 50;
          reasons.push(`Pattern match: "${pat}"`);
          break;
        }
      }
    }

    // 2. Tokenized Levenshtein Similarity on Label and Profile ID (up to 40 pts)
    const profileTokens = [
      ...extractKeywords(profile.label),
      ...extractKeywords(profile.profile_id),
    ];

    let bestSimilarity = 0;
    let matchedTokenPair = "";

    // Direct token-to-token similarity
    for (const qToken of queryTokens) {
      for (const pToken of profileTokens) {
        if (qToken === pToken) {
          bestSimilarity = 1.0;
          matchedTokenPair = `Exact word match "${qToken}"`;
          break;
        }
        // Substring check for compound words (e.g. "bankofamerica" vs "bank")
        if (qToken.includes(pToken) || pToken.includes(qToken)) {
          const subSim = 0.85;
          if (subSim > bestSimilarity) {
            bestSimilarity = subSim;
            matchedTokenPair = `Partial match "${qToken}" ~ "${pToken}"`;
          }
        }
        // Levenshtein distance check
        const sim = stringSimilarity(qToken, pToken);
        if (sim > bestSimilarity && sim >= 0.7) {
          bestSimilarity = sim;
          matchedTokenPair = `Similar word "${qToken}" ~ "${pToken}" (${Math.round(sim * 100)}%)`;
        }
      }
      if (bestSimilarity === 1.0) break;
    }

    if (bestSimilarity > 0) {
      const similarityScore = Math.round(bestSimilarity * 40);
      score += similarityScore;
      reasons.push(matchedTokenPair);
    }

    // Whole label comparison if query title or filename matches well
    const fullSim = Math.max(
      stringSimilarity(filename.replace(/\.[^.]+$/, ""), profile.label),
      title ? stringSimilarity(title, profile.label) : 0,
      correspondent ? stringSimilarity(correspondent, profile.label) : 0,
    );
    if (fullSim >= 0.7 && !reasons.some((r) => r.startsWith("Full name"))) {
      const labelScore = Math.round(fullSim * 20);
      score = Math.max(score, labelScore + 20);
      reasons.push(`Full name similarity (${Math.round(fullSim * 100)}%)`);
    }

    // 3. Semantic / Description / Hint Keyword Overlap (up to 20 pts)
    const descText = `${profile.description || ""} ${profile.hint || ""}`;
    if (descText.trim()) {
      const descTokens = extractKeywords(descText);
      const commonDescTokens = queryTokens.filter(
        (t) => descTokens.includes(t) && !profileTokens.includes(t),
      );
      if (commonDescTokens.length > 0) {
        score += Math.min(20, commonDescTokens.length * 10);
        reasons.push(
          `Context match in description: "${commonDescTokens.slice(0, 2).join('", "')}"`,
        );
      }
    }

    const finalScore = Math.min(100, Math.max(0, score));
    if (finalScore > 0) {
      results.push({
        profile,
        score: finalScore,
        match_reasons: reasons,
      });
    }
  }

  // Sort descending by score, then by profile label
  return results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.profile.label.localeCompare(b.profile.label);
  });
}
