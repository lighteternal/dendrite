/**
 * Utility functions for PubMed API operations
 */
/**
 * Rate limiter class to manage API request rates
 */
export declare class RateLimiter {
    private queue;
    private processing;
    private lastRequestTime;
    private requestInterval;
    constructor(requestsPerSecond: number);
    execute<T>(fn: () => Promise<T>): Promise<T>;
    private processQueue;
    private sleep;
}
/**
 * Parse XML response to JSON
 */
export declare function parseXML(xml: string): Promise<any>;
/**
 * Extract text content from XML nodes
 */
export declare function extractText(node: any): string;
/**
 * Format date to YYYY/MM/DD for PubMed API
 */
export declare function formatDateForAPI(date: Date | string): string;
/**
 * Parse PubMed date string to ISO format
 */
export declare function parsePubMedDate(dateStr: string): string;
/**
 * Validate PMID format
 */
export declare function isValidPMID(pmid: string): boolean;
/**
 * Validate DOI format
 */
export declare function isValidDOI(doi: string): boolean;
/**
 * Validate PMC ID format
 */
export declare function isValidPMCID(pmcid: string): boolean;
/**
 * Clean and normalize PMCID
 */
export declare function normalizePMCID(pmcid: string): string;
/**
 * Build query string from parameters
 */
export declare function buildQueryString(params: Record<string, any>): string;
/**
 * Chunk array into smaller arrays
 */
export declare function chunkArray<T>(array: T[], size: number): T[][];
/**
 * Retry function with exponential backoff
 */
export declare function retryWithBackoff<T>(fn: () => Promise<T>, maxRetries?: number, baseDelay?: number): Promise<T>;
/**
 * Sanitize search term for PubMed query
 */
export declare function sanitizeSearchTerm(term: string): string;
/**
 * Build field-specific search query
 */
export declare function buildFieldQuery(term: string, field: string): string;
/**
 * Combine search terms with boolean operators
 */
export declare function combineSearchTerms(terms: string[], operator?: 'AND' | 'OR' | 'NOT'): string;
/**
 * Extract error message from various error types
 */
export declare function extractErrorMessage(error: unknown): string;
/**
 * Format citation in various styles
 */
export declare function formatCitation(article: {
    authors: Array<{
        lastName: string;
        foreName?: string;
        initials?: string;
    }>;
    title: string;
    journal: string;
    publicationDate: string;
    volume?: string;
    issue?: string;
    pages?: string;
    doi?: string;
}, style: 'apa' | 'mla' | 'chicago' | 'bibtex' | 'ris'): string;
//# sourceMappingURL=utils.d.ts.map