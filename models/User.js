import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  // Kept for future-proofing with Firebase
  firebaseUid: {
    type: String,
    required: false,
    unique: true,
    sparse: true // Allows multiple nulls if using custom registration
  },

  // FIXED: Changed to 'username' to match your Registration/Login logic
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },

  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },

  // FIXED: Added password field required for your custom auth routes
  password: {
    type: String,
    required: true
  },

  avatar: String,

  isBanned: {
    type: Boolean,
    default: false,
    index: true
  },

  // FIXED: Changed from 'genrePreferences' to 'genres' 
  // to match your Socket logic: (user.preferredGenres || [])
  preferredGenres: {
    type: [Number],
    default: () => new Array(10).fill(0)
  },

  playedQuestions: [
    { type: mongoose.Schema.Types.ObjectId, ref: "Question" }
  ],

  level: {
    type: String,
    enum: ["noob", "intermediate", "pro"],
    default: "noob",
    index: true
  },

  stats: {
    matchesPlayed: { type: Number, default: 0 },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    draws: { type: Number, default: 0 },
    totalPoints: { type: Number, default: 0 },
    correctAnswers: { type: Number, default: 0 },
    totalQuestions: { type: Number, default: 0 }
  }

}, { timestamps: true });

export default mongoose.model("User", userSchema);