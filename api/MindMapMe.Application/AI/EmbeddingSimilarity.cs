using System;
using System.Collections.Generic;

namespace MindMapMe.Application.AI
{
    public static class EmbeddingSimilarity
    {
        public static double CosineSimilarity(IReadOnlyList<float> a, IReadOnlyList<float> b)
        {
            if (a == null || b == null) return 0;
            if (a.Count == 0 || b.Count == 0) return 0;
            if (a.Count != b.Count) return 0;

            double dot = 0;
            double normA = 0;
            double normB = 0;

            for (int i = 0; i < a.Count; i++)
            {
                var x = a[i];
                var y = b[i];

                dot += x * y;
                normA += x * x;
                normB += y * y;
            }

            if (normA == 0 || normB == 0) return 0;

            return dot / (Math.Sqrt(normA) * Math.Sqrt(normB));
        }
    }
}
