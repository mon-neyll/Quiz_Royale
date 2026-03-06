import 'dotenv/config';
import express from 'express';
import fileUpload from 'express-fileupload';
import { spawn } from 'child_process';
import mongoose from 'mongoose';
import readline from 'readline';
import http from 'http';
import cors from 'cors'; 
import bcrypt from 'bcrypt';
import { createRequire } from 'module';
import Question from './models/Question.js';
import User from './models/User.js'; 
import { initSocket } from './socket/socket.js';
import path from 'path';

const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');
const app = express();
const server = http.createServer(app);

// --- 1. Middleware & Configuration ---
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'x-api-key']
}));

app.use(express.json());
app.use(fileUpload());
app.use(express.static('public'));

// FIXED: Auto-trimming middleware. This prevents "Invalid Credentials" 
// errors caused by hidden spaces in Flutter/Postman inputs.
app.use((req, res, next) => {
    if (req.body && typeof req.body === 'object') {
        for (const key in req.body) {
            if (typeof req.body[key] === 'string') {
                req.body[key] = req.body[key].trim();
            }
        }
    }
    next();
});

// --- 2. Security: API Key Guard ---
const requireApiKey = (req, res, next) => {
    const key = req.headers['x-api-key'];
    if (key !== process.env.ADMIN_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

// --- 3. Public User Routes (For Flutter Integrations) ---

const publicRouter = express.Router();

// Handle User Registration
// Handle User Registration
// --- server.js ---
publicRouter.post('/register', async (req, res) => {
    try {
        const { username, password, email } = req.body;

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ 
                success: false, 
                message: "Please enter a valid email address." 
            });
        }

        const existing = await User.findOne({ $or: [{ username }, { email }] });
        if (existing) return res.status(400).json({ 
            success: false, 
            message: "Username or email already exists" 
        });

        const hashedPassword = await bcrypt.hash(password, 10);

        const newUser = new User({
            username,
            email,
            password: hashedPassword,
            level: 'noob',
            preferredGenres: new Array(10).fill(0),
            stats: {
                matchesPlayed: 0,
                wins: 0,
                losses: 0,
                draws: 0,
                totalPoints: 0
            }
        });

        const savedUser = await newUser.save();

        res.status(201).json({
            success: true,
            message: 'Registration successful.',
            user: {
                _id: savedUser._id.toString(),
                name: savedUser.username,
                email: savedUser.email,
                level: savedUser.level,
                genres: savedUser.preferredGenres || [],
                stats: savedUser.stats
            }
        });

    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Handle User Logins
publicRouter.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        console.log(`Attempting login for: [${username}]`);

        const user = await User.findOne({ username });
        if (!user) {
            return res.status(401).json({ success: false, message: "Invalid credentials" });
        }

        const passwordMatch = await bcrypt.compare(password, user.password);
        if (!passwordMatch) {
            return res.status(401).json({ success: false, message: "Invalid credentials" });
        }

        if (user.isBanned) {
            return res.status(403).json({ success: false, message: "Account is banned" });
        }

        res.status(200).json({ 
            success: true, 
            user: {
                _id: user._id,
                name: user.username,
                email: user.email,
                level: user.level,
                genres: user.preferredGenres || [],
                stats: user.stats
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Apply the /api prefix to the public routes
app.use('/api', publicRouter);

// // Handle User Login
// app.post('/login', async (req, res) => {
//     try {
//         const { username, password } = req.body;
//         const user = await User.findOne({ username });
        
//         if (!user || user.password !== password) {
//             return res.status(401).json({ success: false, message: "Invalid credentials" });
//         }

//         if (user.isBanned) {
//             return res.status(403).json({ success: false, message: "Account is banned" });
//         }

//         // Return the formatted user object that Flutter expects
//         res.status(200).json({ 
//             success: true, 
//             user: {
//                 _id: user._id,
//                 name: user.username,
//                 email: user.email,
//                 level: user.level,
//                 genres: user.genres || [],
//                 stats: user.stats
//             }
//         });
//     } catch (err) {
//         res.status(500).json({ success: false, message: err.message });
//     }
// });

// --- 4. Helper: PDF Parser Logic ---
const parseQuizPdf = (text) => {
    const questions = [];

    // Normalize text
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Universal regex - handles:
    // 1. or 1) or Q1. or Q1) or Q.1
    // a. or a) or A. or A) or (a) or (A)
    // Answer: x or Ans: x or Correct Answer: x or ANSWER: x
    const regex = /(?:Q\.?\s*)?(\d+)[.)]\s*(.+?)\s*(?:\(a\)|a[.)]\s*|A[.)]\s*)(.+?)\s*(?:\(b\)|b[.)]\s*|B[.)]\s*)(.+?)\s*(?:\(c\)|c[.)]\s*|C[.)]\s*)(.+?)\s*(?:\(d\)|d[.)]\s*|D[.)]\s*)(.+?)\s*(?:Answer|Ans|ANSWER|Correct Answer|correct answer)\s*:\s*(.+?)(?=(?:Q\.?\s*)?\d+[.)]|$)/gs;

    let match;
    while ((match = regex.exec(normalized)) !== null) {
        const options = [
            match[3].trim(),
            match[4].trim(),
            match[5].trim(),
            match[6].trim()
        ];

        const answerRaw = match[7].trim().toLowerCase();

        // Try to find correct answer index
        let correctAnswer = 0;

        // Case 1: Answer is a letter (a, b, c, d)
        const letterMap = { a: 0, b: 1, c: 2, d: 3 };
        if (letterMap[answerRaw] !== undefined) {
            correctAnswer = letterMap[answerRaw];
        }
        // Case 2: Answer is a number (1, 2, 3, 4)
        else if (['1','2','3','4'].includes(answerRaw)) {
            correctAnswer = parseInt(answerRaw) - 1;
        }
        // Case 3: Answer is the full option text
        else {
            const idx = options.findIndex(opt =>
                opt.toLowerCase() === answerRaw ||
                opt.toLowerCase().includes(answerRaw) ||
                answerRaw.includes(opt.toLowerCase())
            );
            correctAnswer = idx !== -1 ? idx : 0;
        }

        questions.push({
            questionText: match[2].trim(),
            options,
            correctAnswer
        });
    }

    return questions;
};

// --- 5. Admin Routes ---

/** * 1. ANALYTICS & STATS */
app.get('/admin/stats', requireApiKey, async (req, res) => {
    try {
        const totalQuestions = await Question.countDocuments();
        const userCount = await User.countDocuments();
        const genreStats = await Question.distinct('genre');
        res.json({ totalQuestions, userStats: userCount, genreStats });
    } catch (err) { res.status(500).json({ error: err.message }); }
});


app.get('/admin/analytics', requireApiKey, async (req, res) => {
    try {
        const hardQuestions = await Question.find().sort({ "analytics.failRate": -1 }).limit(5);
        const topPerformers = await User.find().sort({ "stats.totalPoints": -1 }).limit(10);
        res.json({ hardQuestions, topPerformers });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

publicRouter.post('/users/update-genres', async (req, res) => {
  try {
    const { userId, preferredGenres } = req.body;

    // 1. Validate ID
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ success: false, message: "Invalid User ID" });
    }

    // 2. Ensure we are dealing with Numbers (Flutter sometimes sends strings if not careful)
    const formattedGenres = preferredGenres.map(g => Number(g));

    // 3. Force the update directly at the MongoDB driver level to bypass Mongoose logic bugs
    const result = await mongoose.model("User").collection.updateOne(
      { _id: new mongoose.Types.ObjectId(userId) },
      { $set: { preferredGenres: formattedGenres } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // 4. Fetch the fresh user to confirm
    const updatedUser = await mongoose.model("User").findById(userId);

    console.log("✅ DB Update Confirmed:", updatedUser.preferredGenres);

    res.status(200).json({
      success: true,
      user: {
        _id: updatedUser._id,
        name: updatedUser.username,
        genres: updatedUser.preferredGenres,
        stats: updatedUser.stats
      }
    });
  } catch (err) {
    console.error("Critical Update Error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});



publicRouter.get('/questions/practice', async (req, res) => {
    try {
        const { genres, limit } = req.query;

        // ── 1. Parse limit (default 5, max 20) ──────────────
        const questionLimit = Math.min(parseInt(limit) || 5, 20);

        // ── 2. Genre index → name map ────────────────────────
        // These must exactly match what your BERT pipeline writes
        // into the 'genre' field of the Question collection.
        const genreMap = {
            0: 'Society & Culture',
            1: 'Science & Mathematics',
            2: 'Health',
            3: 'Education & Reference',
            4: 'Computers & Internet',
            5: 'Sports',
            6: 'Business & Finance',
            7: 'Entertainment & Music',
            8: 'Family & Relationships',
            9: 'Politics & Government',
        };

        // ── 3. Binary vector → selected genre name strings ───
        // "1,0,1,0,0,1,0,0,0,0" → ["Society & Culture", "Health", "Sports"]
        let matchFilter = {};

        if (genres && genres.trim() !== '') {
            const vector = genres
                .split(',')
                .map(v => parseInt(v.trim()));

            const selectedGenreNames = vector
                .map((val, index) => (val === 1 ? genreMap[index] : null))
                .filter(Boolean);

            if (selectedGenreNames.length > 0) {
                // Direct $in — no regex needed since genre is stored
                // as an exact string in the Question schema
                matchFilter.genre = { $in: selectedGenreNames };
            }
        }
        // If all zeros or param missing → matchFilter = {}
        // which fetches from ALL genres as a safe fallback

        // ── 4. Fetch random questions via aggregation ────────
        const questions = await Question.aggregate([
            { $match: matchFilter },
            { $sample: { size: questionLimit } },
            {
                $project: {
                    _id: 1,
                    questionText: 1,
                    options: 1,
                    correctAnswer: 1,
                    genre: 1,
                    difficulty: 1,
                    // 'points' from schema is also available if needed
                },
            },
        ]);

        if (questions.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No questions found for your selected genres. Try updating your preferences in your profile.',
            });
        }

        res.status(200).json({
            success: true,
            count: questions.length,
            questions,
        });

    } catch (err) {
        console.error('Practice questions error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// GET: Fetch single user by ID
publicRouter.get('/users/:id', async (req, res) => {
    try {
        const user = await User.findById(req.params.id).lean();
        if (!user) return res.status(404).json({ success: false, message: "User not found" });

        res.status(200).json({
            success: true,
            user: {
                _id: user._id.toString(),
                name: user.username,
                email: user.email,
                level: user.level,
                genres: user.preferredGenres || [],
                stats: user.stats
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/** * 2. QUESTION MANAGEMENT */
app.get('/admin/questions', requireApiKey, async (req, res) => {
    try {
        const { genre, id } = req.query;
        if (id) {
            const q = await Question.findById(id);
            return res.json(q ? [q] : []);
        }

        let query = {};
        if (genre && genre !== 'All') {
            query.genre = { $regex: new RegExp(`^${genre.trim()}$`, "i") };
        }

        const questions = await Question.find(query)
            .sort({ createdAt: -1 })
            .lean();

        res.json(questions);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

app.delete('/admin/questions/bulk', requireApiKey, async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids || !Array.isArray(ids)) {
            return res.status(400).json({ error: "Invalid IDs provided" });
        }
        const result = await Question.deleteMany({ _id: { $in: ids } });
        res.json({ 
            message: `Successfully deleted ${result.deletedCount} questions`,
            count: result.deletedCount 
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/admin/questions', requireApiKey, async (req, res) => {
    try {
        const newQ = new Question({
            questionText: req.body.questionText,
            options: req.body.options,
            correctAnswer: req.body.correctAnswer,
            genre: req.body.genre,
            difficulty: req.body.difficulty || 'medium'
        });
        // const savedUser = await newUser.save();
        const savedQuestion = await newQ.save();
        res.status(201).json({
        success: true,
        data: savedQuestion
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/admin/questions/:id', requireApiKey, async (req, res) => {
    try {
        const updated = await Question.findByIdAndUpdate(
            req.params.id, 
            {
                questionText: req.body.questionText,
                options: req.body.options,
                correctAnswer: req.body.correctAnswer,
                genre: req.body.genre,
                difficulty: req.body.difficulty
            }, 
            { new: true }
        );
        res.json({ success: true, data: updated });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/admin/questions/:id', requireApiKey, async (req, res) => {
    try {
        await Question.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: "Deleted successfully" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/** * 3. USER MANAGEMENT */
app.get('/admin/users', requireApiKey, async (req, res) => {
    try {
        const users = await User.find().sort({ createdAt: -1 });

        const formatted = users.map(u => ({
            ...u.toObject(),
            isBanned: u.isBanned ?? false
        }));

        res.json(formatted);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** 3. USER MANAGEMENT */

// Ban User
app.patch('/admin/users/:id/ban', requireApiKey, async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        if (user.isBanned) {
            return res.status(400).json({ success: false, message: "User is already banned" });
        }

        user.isBanned = true;
        await user.save();

        res.json({
            success: true,
            message: "User banned successfully",
            isBanned: true
        });

    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});


// Unban User
app.patch('/admin/users/:id/unban', requireApiKey, async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        if (!user.isBanned) {
            return res.status(400).json({ success: false, message: "User is not banned" });
        }

        user.isBanned = false;
        await user.save();

        res.json({
            success: true,
            message: "User unbanned successfully",
            isBanned: false
        });

    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// POST: Process PDF with BERT AI
app.post('/admin/upload-quiz', requireApiKey, async (req, res) => {
    if (!req.files || !req.files.quizPdf) return res.status(400).json({ error: 'No file uploaded.' });

    try {
        const file = req.files.quizPdf;
        const data = await pdf(Buffer.from(file.data));
        const extracted = parseQuizPdf(data.text);
        const totalToProcess = extracted.length;
        
        console.log(`\n📂 File Received. Total Questions: ${totalToProcess}`);
        console.log(`🚀 Starting AI classification...`);

        const pythonPath = process.env.PYTHON_PATH || path.join(process.cwd(), '..', 'quiz-royale-ml', 'venv', 'Scripts', 'python.exe');
        const scriptPath = path.join(process.cwd(), 'process_questions.py');

        const pythonProcess = spawn(pythonPath, ['-u', scriptPath], {
            cwd: process.cwd(),
            env: { ...process.env, TRANSFORMERS_OFFLINE: '0', PYTHONIOENCODING: 'utf-8' } // Forced UTF-8
        });

        const rl = readline.createInterface({ input: pythonProcess.stdout, terminal: false });
        
        let totalSaved = 0;
        let batchBuffer = [];
        let pendingWrites = [];
        const DB_BATCH_SIZE = 50; 

        rl.on('line', (line) => {
            if (!line.trim()) return;
            try {
                const qData = JSON.parse(line);
                batchBuffer.push(qData);
                
                if (batchBuffer.length >= DB_BATCH_SIZE) {
                    const ops = batchBuffer.map(q => ({
                        updateOne: {
                            filter: { questionText: q.questionText },
                            update: { $set: q },
                            upsert: true
                        }
                    }));
                    
                    pendingWrites.push(Question.bulkWrite(ops));
                    totalSaved += batchBuffer.length;
                    
                    const percent = ((totalSaved / totalToProcess) * 100).toFixed(1);
                    console.log(`✅ Progress: ${totalSaved}/${totalToProcess} (${percent}%)`);
                    
                    batchBuffer = [];
                }
            } catch (e) { console.error("Parse Error:", e.message); }
        });

        pythonProcess.stderr.on('data', (d) => console.error(`❌ Python Error: ${d.toString()}`));
        pythonProcess.stdin.write(JSON.stringify(extracted));
        pythonProcess.stdin.end();

        await new Promise((resolve) => {
            pythonProcess.on('close', async (code) => {
                if (batchBuffer.length > 0) {
                    pendingWrites.push(Question.bulkWrite(batchBuffer.map(q => ({
                        updateOne: { filter: { questionText: q.questionText }, update: { $set: q }, upsert: true }
                    }))));
                    totalSaved += batchBuffer.length;
                }
                
                await Promise.all(pendingWrites);
                console.log(`\n🏁 FINISHED: All ${totalSaved} questions processed and saved. (Code ${code})`);
                resolve();
            });
        });

        if (!res.headersSent) res.json({ success: true, count: totalSaved });

    } catch (err) {
        console.error('❌ Fatal Error:', err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

app.get('/admin-panel', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});
initSocket(server);
// --- 6. Server Startup ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        console.log('MongoDB connected');
        const PORT = process.env.PORT || 4000;
        server.listen(PORT,'0.0.0.0', () => {
            console.log(`Quiz Royale Backend running on port ${PORT}`);
        });
    })
    .catch(err => console.error('DB Connection Error:', err));