interface ParsedTradedName {
  baseName: string;
  rank: number | null;
  riven: { weapon: string; suffix: string } | null;
}

const PAREN_SUFFIX = /^(.*?)\s*\(([^()]*)\)\s*$/;
const RANK_VALUE = /\b(\d+)\b/;
const RIVEN_RANK = /riven\s+rank/i;
const VEILED_RIVEN = /riven\s+mod$/i;

export function parseTradedItemName(displayName: string): ParsedTradedName {
  const name = String(displayName || "").trim();
  const parts = PAREN_SUFFIX.exec(name);
  if (!parts) return { baseName: name, rank: null, riven: null };

  const baseName = parts[1].trim();
  const suffix = parts[2].trim();
  if (!baseName) return { baseName: name, rank: null, riven: null };

  const rankMatch = RANK_VALUE.exec(suffix);
  const rank = rankMatch ? Number(rankMatch[1]) : null;
  if (!RIVEN_RANK.test(suffix)) return { baseName, rank, riven: null };

  // Veiled mods use normal listings; unveiled rivens use auctions.
  const cut = baseName.lastIndexOf(" ");
  if (VEILED_RIVEN.test(baseName) || cut <= 0) return { baseName, rank, riven: null };
  return {
    baseName,
    rank,
    riven: { weapon: baseName.slice(0, cut).trim(), suffix: baseName.slice(cut + 1).trim() },
  };
}
