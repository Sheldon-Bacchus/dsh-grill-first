import { type Intensity, type RecommendationCategory, type RecommendationMode } from '../config.js';
export declare const PROTOCOL_SECTION_NAME = "dsh-grill-first:protocol";
export declare const PROTOCOL_SECTION_ORDER = 60;
export declare const PROTOCOL_CHAR_LIMIT = 900;
export interface ProtocolOptions {
    maxRounds: number;
    maxQuestionsPerRound: number;
    bypassKeywords: readonly string[];
    intensity: Intensity;
    researchMode?: 'off' | 'auto' | 'always';
    recommendationMode?: RecommendationMode;
    recommendationCategories?: readonly RecommendationCategory[];
}
export declare function protocolLength(text: string): number;
export declare function buildProtocolText(options: ProtocolOptions): string;
