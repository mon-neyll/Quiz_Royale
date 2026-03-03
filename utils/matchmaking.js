export function calculateSimilarity(vecA, vecB) {
    if (!vecA || !vecB) return 0;

    const dot = vecA.reduce((sum, val, i) => sum + val * vecB[i], 0);

    const magA = Math.sqrt(vecA.reduce((sum, val) => sum + val * val, 0));
    const magB = Math.sqrt(vecB.reduce((sum, val) => sum + val * val, 0));

    if (magA === 0 || magB === 0) return 0;

    return dot / (magA * magB);
}