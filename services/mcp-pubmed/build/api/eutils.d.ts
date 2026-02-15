/**
 * E-utilities API client for PubMed
 * Documentation: https://www.ncbi.nlm.nih.gov/books/NBK25501/
 */
import { SearchParams, FetchParams, LinkParams, SummaryParams, SearchResult, PubMedArticle } from '../types.js';
export declare class EUtilsClient {
    private client;
    private rateLimiter;
    private config;
    constructor(apiKey?: string, email?: string);
    /**
     * Build common query parameters
     */
    private buildCommonParams;
    /**
     * ESearch - Search and retrieve PMIDs
     */
    search(params: SearchParams): Promise<SearchResult>;
    /**
     * EFetch - Retrieve article records
     */
    fetch(params: FetchParams): Promise<any>;
    /**
     * ELink - Find related articles and citations
     */
    link(params: LinkParams): Promise<any>;
    /**
     * ESummary - Get document summaries
     */
    summary(params: SummaryParams): Promise<any>;
    /**
     * Parse article from PubmedArticle XML
     */
    parseArticle(articleData: any): PubMedArticle;
    /**
     * Get full article details by PMID
     */
    getArticleDetails(pmid: string): Promise<PubMedArticle>;
    /**
     * Get multiple articles by PMIDs
     */
    getArticlesBatch(pmids: string[]): Promise<PubMedArticle[]>;
    /**
     * Get cited by articles (articles that cite this PMID)
     */
    getCitedBy(pmid: string): Promise<string[]>;
    /**
     * Get references (articles cited by this PMID)
     */
    getReferences(pmid: string): Promise<string[]>;
    /**
     * Get similar articles
     */
    getSimilarArticles(pmid: string, maxResults?: number): Promise<string[]>;
}
//# sourceMappingURL=eutils.d.ts.map