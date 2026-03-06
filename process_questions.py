import sys
import json
import torch
import numpy as np
import os
import re
from transformers import BertTokenizer, BertForSequenceClassification
from sklearn.metrics.pairwise import cosine_similarity

sys.stdout.reconfigure(encoding='utf-8')



MODEL_PATH = os.getenv('MODEL_PATH', 'moneyll/quiz-royale-bert')
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

try:
    tokenizer = BertTokenizer.from_pretrained(MODEL_PATH)
    model = BertForSequenceClassification.from_pretrained(
        MODEL_PATH,
        torch_dtype=torch.float16
    ).to(device)
    model.eval()
except Exception as e:
    print(f"BERT Load Error: {str(e)}", file=sys.stderr)
    sys.exit(1)

GENRES = [
    "Society & Culture", "Science & Mathematics", "Health",
    "Education & Reference", "Computers & Internet",
    "Sports", "Business & Finance", "Entertainment & Music",
    "Family & Relationships", "Politics & Government"
]

# ── Vocabulary Lists ──────────────────────────────────────────────────────────

TECHNICAL_WORDS = {
    # Science
    "mitochondria", "photosynthesis", "chromosome", "isotope", "quantum",
    "entropy", "catalyst", "osmosis", "molecule", "enzyme", "protein",
    "nucleus", "electrode", "electromagnetic", "gravitational", "acceleration",
    "thermodynamics", "relativity", "biodiversity", "ecosystem", "metabolism",
    # Math
    "derivative", "integral", "polynomial", "logarithm", "factorial",
    "hypotenuse", "perpendicular", "coefficient", "denominator", "asymptote",
    # Politics/Society
    "sovereignty", "constitution", "legislature", "referendum", "geopolitical",
    "parliamentary", "bureaucracy", "oligarchy", "hegemony", "jurisdiction",
    # Business
    "depreciation", "amortization", "equilibrium", "macroeconomics",
    "microeconomics", "inflation", "recession", "dividend", "liquidity",
    # Medicine
    "cardiovascular", "neurological", "immunodeficiency", "pharmaceutical",
    "pathology", "diagnosis", "prognosis", "hypertension", "antibody",
    # Tech
    "algorithm", "cryptography", "bandwidth", "semiconductor", "encryption",
    "binary", "hexadecimal", "recursion", "polymorphism", "abstraction",
}

# Analytical = conceptual, harder
ANALYTICAL_STARTERS = {
    "why", "how", "analyze", "explain", "compare", "contrast",
    "evaluate", "justify", "what would happen", "what is the effect",
    "what causes", "what is the relationship", "describe the process"
}

# Factual = recall-based, easier
FACTUAL_STARTERS = {
    "who", "when", "where", "which", "what is", "what was",
    "how many", "how much", "name the", "identify"
}


def get_difficulty_metrics(question_text, options, conf):
    """
    Psychometric Difficulty Engine v2.0

    Factors:
    1. Syntactic Complexity     — sentence length & structure
    2. Semantic Overlap         — BERT cosine similarity of options
    3. Model Uncertainty        — AI confidence inversely = difficulty
    4. Vocabulary Complexity    — technical/rare word detection
    5. Question Type            — analytical vs factual detection
    6. Multi-Concept Detection  — number of distinct concepts
    """

    difficulty_score = 0.0
    q_lower = question_text.lower()
    words = q_lower.split()
    word_set = set(words)

    # ── Factor 1: Syntactic Complexity ───────────────────────────────────────
    word_count = len(words)
    if word_count > 20:
        difficulty_score += 2.0
    elif word_count > 15:
        difficulty_score += 1.5
    elif word_count > 8:
        difficulty_score += 0.5

    # ── Factor 2: Semantic Overlap (BERT Embeddings) ─────────────────────────
    try:
        inputs = tokenizer(
            options, return_tensors="pt", padding=True, truncation=True
        ).to(device)
        with torch.no_grad():
            outputs = model.bert(**inputs)
            embeddings = outputs.last_hidden_state[:, 0, :].cpu().numpy()

        sim_matrix = cosine_similarity(embeddings)
        n = len(options)
        avg_sim = (np.sum(sim_matrix) - n) / (n * (n - 1))

        if avg_sim > 0.90:
            difficulty_score += 3.0
        elif avg_sim > 0.85:
            difficulty_score += 2.0
        elif avg_sim > 0.70:
            difficulty_score += 1.0
        elif avg_sim < 0.40:
            difficulty_score -= 0.5   # Very different options = easier
    except:
        pass

    # ── Factor 3: Model Uncertainty ──────────────────────────────────────────
    if conf < 0.40:
        difficulty_score += 2.0
    elif conf < 0.55:
        difficulty_score += 1.5
    elif conf < 0.75:
        difficulty_score += 0.5
    elif conf > 0.95:
        difficulty_score -= 0.5

    # ── Factor 4: Vocabulary Complexity ──────────────────────────────────────
    technical_count = len(word_set.intersection(TECHNICAL_WORDS))
    if technical_count >= 3:
        difficulty_score += 2.5
    elif technical_count == 2:
        difficulty_score += 1.5
    elif technical_count == 1:
        difficulty_score += 0.8

    # Check options for technical vocabulary too
    options_words = set(" ".join(options).lower().split())
    options_technical = len(options_words.intersection(TECHNICAL_WORDS))
    if options_technical >= 2:
        difficulty_score += 1.0
    elif options_technical == 1:
        difficulty_score += 0.5

    # ── Factor 5: Question Type Detection ────────────────────────────────────
    is_analytical = any(q_lower.startswith(s) or s in q_lower
                        for s in ANALYTICAL_STARTERS)
    is_factual = any(q_lower.startswith(s)
                     for s in FACTUAL_STARTERS)

    if is_analytical:
        difficulty_score += 1.5
    elif is_factual:
        difficulty_score -= 0.5

    # ── Factor 6: Multi-Concept Detection ────────────────────────────────────
    concept_indicators = question_text.count(',') + question_text.count(';')
    and_count = words.count('and') + words.count('both') + words.count('all')

    if concept_indicators >= 3 or and_count >= 2:
        difficulty_score += 1.5
    elif concept_indicators >= 1 or and_count >= 1:
        difficulty_score += 0.5

    # ── Final Classification (3 Levels) ──────────────────────────────────────
    #
    #  Score Range  | Level   | Points
    #  -------------|---------|-------
    #  < 2.0        | easy    | 10
    #  2.0 – 4.5    | medium  | 20
    #  > 4.5        | hard    | 30
    #
    if difficulty_score >= 4.5:
        return "hard", 30
    elif difficulty_score >= 2.0:
        return "medium", 20
    else:
        return "easy", 10


def main():
    raw_input = sys.stdin.read()
    if not raw_input:
        return

    try:
        data = json.loads(raw_input)
        batch_size = 4

        for i in range(0, len(data), batch_size):
            batch = data[i: i + batch_size]
            batch_texts = [item["questionText"] for item in batch]

            inputs = tokenizer(
                batch_texts, return_tensors="pt",
                truncation=True, padding=True
            ).to(device)

            with torch.no_grad():
                logits = model(**inputs).logits
                probs = torch.softmax(logits, dim=1).cpu().numpy()

            for j, item in enumerate(batch):
                item_probs = probs[j]
                best_idx = item_probs.argmax()
                conf = float(item_probs[best_idx])

                diff_label, pts = get_difficulty_metrics(
                    item["questionText"], item["options"], conf
                )

                output = {
                    "questionText": item["questionText"],
                    "options": item["options"],
                    "correctAnswer": item["correctAnswer"],
                    "genre": GENRES[best_idx] if best_idx < len(GENRES) else "Society & Culture",
                    "difficulty": diff_label,
                    "points": pts
                }
                print(json.dumps(output, ensure_ascii=False), flush=True)

    except Exception as e:
        print(f"Runtime Error: {str(e)}", file=sys.stderr)


if __name__ == "__main__":
    main()