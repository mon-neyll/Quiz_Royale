import 'dotenv/config';
import express from 'express';
import fileUpload from 'express-fileupload';
import { spawn } from 'child_process';
import mongoose from 'mongoose';
import readline from 'readline';
import http from 'http';
import cors from 'cors'; 
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

// --- 3. Public User Routes (For Flutter Integration) ---

const publicRouter = express.Router();

// Handle User Registration
// Handle User Registration
// --- server.js ---
publicRouter.post('/register', async (req, res) => {
    try {
        const { username, password, email } = req.body; 
        const existing = await User.findOne({ $or: [{ username }, { email }] });
        if (existing) return res.status(400).json({ success: false, message: "Username already exists" });

        const newUser = new User({ 
            username, 
            email, 
            password, 
            level: 'noob',
            preferredGenres: [], 
            stats: { matchesPlayed: 0, wins: 0, losses: 0, draws: 0, totalPoints: 0 }
        });
        
        const savedUser = await newUser.save();

        // MANDATORY: Return the user object so Flutter can navigate
        res.status(201).json({ 
            success: true, 
            user: {
                _id: savedUser._id.toString(), // Ensure ID is a string
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

// Handle User Login
publicRouter.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        console.log(`Attempting login for: [${username}] with password: [${password}]`);
        const user = await User.findOne({ username });
        
        if (!user || user.password !== password) {
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
    const regex = /(\d+)[\.\)]\s*(.+?)\s*[aA][\.\)]\s*(.+?)\s*[bB][\.\)]\s*(.+?)\s*[cC][\.\)]\s*(.+?)\s*[dD][\.\)]\s*(.+?)\s*Answer:\s*([a-dA-D])[\.\)]?/gs;
    const answerMap = { a: 0, b: 1, c: 2, d: 3, A: 0, B: 1, C: 2, D: 3 };
    const questions = [];
    let matches;
    while ((matches = regex.exec(text)) !== null) {
        questions.push({
            questionText: matches[2].trim(),
            options: [matches[3].trim(), matches[4].trim(), matches[5].trim(), matches[6].trim()],
            correctAnswer: answerMap[matches[7]]
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

// --- MISSING ROUTE: Update User Genres ---
publicRouter.post('/users/update-genres', async (req, res) => {
    try {
        const { userId, preferredGenres } = req.body;

        // Find user and update their genres
        const updatedUser = await User.findByIdAndUpdate(
            userId,
            { preferredGenres: preferredGenres },
            { new: true } // This returns the user AFTER the update
        );

        if (!updatedUser) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        // Return the object in the format Flutter expects
        res.status(200).json({
            success: true,
            user: {
                _id: updatedUser._id.toString(),
                name: updatedUser.username,
                email: updatedUser.email,
                level: updatedUser.level,
                genres: updatedUser.preferredGenres || [],
                stats: updatedUser.stats
            }
        });
    } catch (err) {
        console.error("Genre Update Error:", err);
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
            difficulty: req.body.difficulty || 'intermediate'
        });
        const savedUser = await newUser.save();
        res.status(201).json({ 
            success: true, 
            user: {
                _id: savedUser._id,
                name: savedUser.username,
                email: savedUser.email,
                level: savedUser.level,
                genres: savedUser.preferredGenres || [],
                stats: savedUser.stats
            }
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
            env: { ...process.env, TRANSFORMERS_OFFLINE: '1', PYTHONIOENCODING: 'utf-8' } // Forced UTF-8
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
app.get('/dashboard', async (req, res) => {
    const totalQuestions = await Question.countDocuments();
    const userCount = await User.countDocuments();
    
    // Sending HTML directly so it looks like a webpage
    res.send(`
        <html>
            <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1>Quiz Royale Admin Dashboard</h1>
                <p>Total Questions: <strong>${totalQuestions}</strong></p>
                <p>Total Players: <strong>${userCount}</strong></p>
            </body>
        </html>
    `);
});
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