export const calculateSimilarity = (vecA, vecB) => {
    if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length || vecA.length === 0) {
        return 0;
    }

    const A = vecA.map(Number);
    const B = vecB.map(Number);

    const dotProduct = A.reduce((sum, a, i) => sum + a * B[i], 0);

    const magA = Math.sqrt(A.reduce((sum, a) => sum + a * a, 0));
    const magB = Math.sqrt(B.reduce((sum, b) => sum + b * b, 0));

    if (magA === 0 || magB === 0) return 0;

    return Math.max(0, Math.min(1, dotProduct / (magA * magB)));
};