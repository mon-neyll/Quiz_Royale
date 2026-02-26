import sys
import json
import torch
import numpy as np
import os
import math
from transformers import BertTokenizer, BertForSequenceClassification
from sklearn.metrics.pairwise import cosine_similarity

# Ensure UTF-8 for smooth communication with Node.js
sys.stdout.reconfigure(encoding='utf-8')

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.getenv('MODEL_PATH', os.path.join(BASE_DIR, '..', 'quiz-royale-ml', 'model'))
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

try:
    tokenizer = BertTokenizer.from_pretrained(MODEL_PATH)
    model = BertForSequenceClassification.from_pretrained(MODEL_PATH).to(device)
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

def get_difficulty_metrics(question_text, options, conf):
    """
    Applied Psychometric Logic:
    1. Syntactic Complexity: Based on token-to-word ratio (Entropy).
    2. Semantic Overlap: Uses BERT embeddings to see if options are 'Deep Distractors'.
    3. Model Uncertainty: AI confidence inversely correlates with human difficulty.
    """
    difficulty_score = 0.0

    # 1. Syntactic Complexity (Sentence Weight)
    # Long questions with complex structure are harder to process under time pressure.
    words = question_text.split()
    if len(words) > 15:
        difficulty_score += 1.5
    elif len(words) > 8:
        difficulty_score += 0.5

    # 2. Semantic Overlap (The "Distractor" Factor)
    # If the options are semantically close (e.g., Apple vs Orange vs Pear), it's Hard.
    # If they are distant (e.g., Apple vs Car vs Blue), it's Easy.
    try:
        inputs = tokenizer(options, return_tensors="pt", padding=True, truncation=True).to(device)
        with torch.no_grad():
            outputs = model.bert(**inputs)
            # Use the [CLS] token for high-level semantic representation
            embeddings = outputs.last_hidden_state[:, 0, :].cpu().numpy()
        
        sim_matrix = cosine_similarity(embeddings)
        # Calculate the average similarity between all options
        avg_sim = (np.sum(sim_matrix) - len(options)) / (len(options) * (len(options) - 1))
        
        # Thresholds based on typical BERT cosine similarity distributions
        if avg_sim > 0.85: # Extremely similar options
            difficulty_score += 2.0
        elif avg_sim > 0.70: # Related options
            difficulty_score += 1.0
    except:
        pass

    # 3. Probabilistic Uncertainty
    # If the AI is struggling to classify the genre (low confidence), the question 
    # likely contains nuanced or multidisciplinary language.
    if conf < 0.50:
        difficulty_score += 1.5
    elif conf < 0.75:
        difficulty_score += 0.5

    # --- Final Classification Mapping ---
    # Easy: < 1.5 | Medium: 1.5 - 2.5 | Hard: > 2.5
    if difficulty_score >= 2.5:
        return "hard", 30
    elif difficulty_score >= 1.5:
        return "medium", 20
    else:
        return "easy", 10

def main():
    raw_input = sys.stdin.read()
    if not raw_input:
        return
    
    try:
        data = json.loads(raw_input)
        batch_size = 16 
        
        for i in range(0, len(data), batch_size):
            batch = data[i : i + batch_size]
            batch_texts = [item["questionText"] for item in batch]

            inputs = tokenizer(batch_texts, return_tensors="pt", truncation=True, padding=True).to(device)
            
            with torch.no_grad():
                logits = model(**inputs).logits
                probs = torch.softmax(logits, dim=1).cpu().numpy()
            
            for j, item in enumerate(batch):
                item_probs = probs[j]
                best_idx = item_probs.argmax()
                conf = float(item_probs[best_idx])
                
                diff_label, pts = get_difficulty_metrics(item["questionText"], item["options"], conf)

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