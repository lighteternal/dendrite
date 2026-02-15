/**
 * PubMed Central (PMC) API client
 * Documentation: https://www.ncbi.nlm.nih.gov/pmc/tools/developers/
 */
import { FullTextArticle } from '../types.js';
export declare class PMCClient {
    private client;
    private rateLimiter;
    constructor(apiKey?: string);
    /**
     * Get full text article from PMC
     */
    getFullText(pmcid: string): Promise<FullTextArticle>;
    /**
     * Parse full text article from PMC XML
     */
    private parseFullTextArticle;
    /**
     * Parse authors from contrib-group
     */
    private parseAuthors;
    /**
     * Parse abstract
     */
    private parseAbstract;
    /**
     * Parse publication date
     */
    private parseDate;
    /**
     * Parse body sections
     */
    private parseSections;
    /**
     * Parse individual section
     */
    private parseSection;
    /**
     * Parse figures
     */
    private parseFigures;
    /**
     * Parse tables
     */
    private parseTables;
    /**
     * Parse references
     */
    private parseReferences;
    /**
     * Extract body text from sections
     */
    private extractBodyText;
    /**
     * Check if full text is available for a PMCID
     */
    isFullTextAvailable(pmcid: string): Promise<boolean>;
}
//# sourceMappingURL=pmc.d.ts.map