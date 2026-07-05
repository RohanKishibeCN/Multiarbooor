import { UnifiedMarket, MatchedEvent } from '../types';
import { AppConfig } from '../../config';

export class EventMatcher {
  private matchCache: Map<string, MatchedEvent> = new Map();
  private lastBuildTime = 0;
  private rebuildIntervalMs = 300000;

  getCachedMatches(): MatchedEvent[] {
    return Array.from(this.matchCache.values());
  }

  async buildMatchIndex(
    pmMarkets: UnifiedMarket[],
    pfMarkets: UnifiedMarket[]
  ): Promise<MatchedEvent[]> {
    const matches: MatchedEvent[] = [];
    const threshold = AppConfig.crossEventMatchThreshold;

    const pfMap = new Map<string, UnifiedMarket[]>();
    for (const pf of pfMarkets) {
      const key = this.extractKeywords(pf.question || pf.title).slice(0, 3).sort().join('_');
      if (!pfMap.has(key)) pfMap.set(key, []);
      pfMap.get(key)!.push(pf);
    }

    for (const pm of pmMarkets) {
      const pmKeywords = this.extractKeywords(pm.question || pm.title);
      const pmKeySet = new Set(pmKeywords);

      const candidates = this.findCandidates(pm, pmKeywords, pfMarkets, pfMap);
      for (const pf of candidates) {
        const similarity = this.calculateSimilarity(pm, pf);
        if (similarity >= threshold) {
          matches.push({
            id: `${pm.id}_${pf.id}`,
            pmMarket: pm,
            pfMarket: pf,
            confidence: similarity,
            titleSimilarity: similarity,
            resolutionMatch: pm.resolutionSource === pf.resolutionSource,
          });
        }
      }
    }

    matches.sort((a, b) => b.confidence - a.confidence);

    const usedPM = new Set<string>();
    const usedPF = new Set<string>();
    const deduped: MatchedEvent[] = [];

    for (const match of matches) {
      if (!usedPM.has(match.pmMarket.id) && !usedPF.has(match.pfMarket.id)) {
        deduped.push(match);
        usedPM.add(match.pmMarket.id);
        usedPF.add(match.pfMarket.id);
      }
    }

    this.matchCache = new Map(deduped.map(m => [m.id, m]));
    this.lastBuildTime = Date.now();
    return deduped;
  }

  private extractKeywords(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(w => w.length > 2 && !['the', 'and', 'for', 'will', 'what', 'this', 'that', 'with', 'from'].includes(w));
  }

  private findCandidates(
    pm: UnifiedMarket,
    pmKeywords: string[],
    pfMarkets: UnifiedMarket[],
    pfMap: Map<string, UnifiedMarket[]>
  ): UnifiedMarket[] {
    const pmKey = pmKeywords.slice(0, 3).sort().join('_');
    const direct = pfMap.get(pmKey);
    if (direct) return direct;

    return pfMarkets.filter(pf => {
      const pfKeywords = this.extractKeywords(pf.question || pf.title);
      const overlap = pmKeywords.filter(k => pfKeywords.includes(k)).length;
      return overlap >= 2;
    }).slice(0, 10);
  }

  private calculateSimilarity(a: UnifiedMarket, b: UnifiedMarket): number {
    const wordsA = new Set(this.extractKeywords(a.question || a.title));
    const wordsB = new Set(this.extractKeywords(b.question || b.title));

    const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
    const union = wordsA.size + wordsB.size - intersection;
    const jaccardSim = union > 0 ? intersection / union : 0;

    const keyPhrases = ['bitcoin', 'btc', 'ethereum', 'eth', 'price', 'above', 'below',
      'reach', 'president', 'election', 'fed', 'rate', 'cut', 'gdp', 'unemployment',
      'super', 'bowl', 'nba', 'nfl', 'oscar', 'world', 'cup', 'championship'];

    const textA = (a.question || a.title).toLowerCase();
    const textB = (b.question || b.title).toLowerCase();
    const phraseBonus = keyPhrases.reduce((sum, phrase) => {
      return sum + (textA.includes(phrase) && textB.includes(phrase) ? 0.05 : 0);
    }, 0);

    let dateBonus = 0;
    if (a.endDate > 0 && b.endDate > 0) {
      const diffDays = Math.abs(a.endDate - b.endDate) / (1000 * 60 * 60 * 24);
      if (diffDays < 1) dateBonus = 0.1;
      else if (diffDays < 7) dateBonus = 0.05;
    }

    return Math.min(1, jaccardSim + phraseBonus + dateBonus);
  }
}
