import mongoose from "mongoose";

const questionSchema = new mongoose.Schema({
  questionText: {
    type: String,
    required: true,
    unique: true, 
    trim: true
  },
  options: {
    type: [String],
    required: true,
    validate: {
      validator: function(v) {
        return v.length === 4;
      },
      message: 'A question must have exactly 4 options.'
    }
  },
  correctAnswer: {
    type: Number,
    required: true 
  },
  genre: {
    type: String,
    required: true,
    index: true
  },
  difficulty: {
    type: String,
    enum: ["easy", "medium", "hard"],
    required: true,
    index: true
  },
  points: {
    type: Number,
    // The default function now safely checks if 'this' exists
    default: function () {
      if (!this || !this.difficulty) return 10; // Fallback default
      
      return this.difficulty === "easy" ? 10 :
             this.difficulty === "medium" ? 20 : 30;
    }
  }
}, { 
  timestamps: true // Automatically creates createdAt and updatedAt fields
});

// Create an index for faster searching by text
questionSchema.index({ questionText: 'text' });

export default mongoose.model("Question", questionSchema);