/**
 * Calculates the Cosine Similarity between two vectors.
 * In this app, vectors represent the player's genre preferences.
 * Formula: (A · B) / (||A|| * ||B||)
 */
export const calculateSimilarity = (vecA, vecB) => {
    // 1. Structural Validation
    if (!vecA || !vecB || vecA.length === 0 || vecA.length !== vecB.length) {
        return 0;
    }

    try {
        // 2. Calculate Dot Product (A · B)
        // Ensure values are treated as Numbers to prevent string concatenation
        const dotProduct = vecA.reduce((sum, a, i) => {
            return sum + (Number(a) * Number(vecB[i] || 0));
        }, 0);

        // 3. Calculate Magnitudes (||A|| and ||B||)
        const magA = Math.sqrt(vecA.reduce((sum, a) => sum + (Number(a) * Number(a)), 0));
        const magB = Math.sqrt(vecB.reduce((sum, b) => sum + (Number(b) * Number(b)), 0));

        // 4. Avoid division by zero
        if (magA === 0 || magB === 0) return 0;

        // 5. Final Cosine Similarity Calculation
        const similarity = dotProduct / (magA * magB);

        // Clamping value between 0 and 1 for consistency
        return Math.max(0, Math.min(1, similarity));
        
    } catch (error) {
        console.error("Error in calculateSimilarity:", error);
        return 0;
    }
};