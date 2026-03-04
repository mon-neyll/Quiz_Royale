import { Server } from 'socket.io';
import mongoose from 'mongoose';
import Question from '../models/Question.js';
import User from '../models/User.js';
import { calculateSimilarity } from '../utils/matchmaking.js';

export const initSocket = (server) => {
    const io = new Server(server, { cors: { origin: "*" } });
    let lobby = [];
    const activeGames = {};
    const challengeRooms = {};

    const generateRoomCode = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
    };

    const SERVER_LEADERBOARD_LIMIT = 50;

    const broadcastLeaderboard = async (io) => {
    try {
        const players = await User.find(
            { isBanned: false },
            { username: 1, level: 1, stats: 1 }
        )
            .sort({ 'stats.totalPoints': -1 })
            .limit(SERVER_LEADERBOARD_LIMIT)
            .lean();

        const leaderboard = players.map((u, index) => ({
            rank:          index + 1,
            userId:        u._id.toString(),
            name:          u.username,
            tier:          u.level,
            points:        u.stats?.totalPoints    ?? 0,
            wins:          u.stats?.wins           ?? 0,
            losses:        u.stats?.losses         ?? 0,
            draws:         u.stats?.draws          ?? 0,
            matchesPlayed: u.stats?.matchesPlayed  ?? 0,
            winRate: u.stats?.matchesPlayed > 0
                ? ((u.stats.wins / u.stats.matchesPlayed) * 100).toFixed(1)
                : '0.0',
        }));

        io.emit('leaderboard_update', { leaderboard });
    } catch (err) {
        console.error('Leaderboard broadcast error:', err);
    }
    };

    io.on('connection', (socket) => {
        console.log("User Connected: " + socket.id);

        socket.on('get_leaderboard', async (data) => {
        try {
            // Client sends a limit; cap it at SERVER_LEADERBOARD_LIMIT so clients
            // can never request more than you allow. Falls back to the server limit
            // if client sends nothing.
            const requestedLimit = data?.limit ?? SERVER_LEADERBOARD_LIMIT;
            const limit = Math.min(requestedLimit, SERVER_LEADERBOARD_LIMIT);

            const players = await User.find(
                { isBanned: false },
                { username: 1, level: 1, stats: 1 }
            )
                .sort({ 'stats.totalPoints': -1 })
                .limit(limit)
                .lean();

            const leaderboard = players.map((u, index) => ({
                rank:          index + 1,
                userId:        u._id.toString(),
                name:          u.username,
                tier:          u.level,
                points:        u.stats?.totalPoints    ?? 0,
                wins:          u.stats?.wins           ?? 0,
                losses:        u.stats?.losses         ?? 0,
                draws:         u.stats?.draws          ?? 0,
                matchesPlayed: u.stats?.matchesPlayed  ?? 0,
                winRate: u.stats?.matchesPlayed > 0
                    ? ((u.stats.wins / u.stats.matchesPlayed) * 100).toFixed(1)
                    : '0.0',
            }));

            socket.emit('leaderboard_update', { leaderboard });
        } catch (err) {
            console.error('get_leaderboard error:', err);
            socket.emit('error', { message: 'Could not load leaderboard.' });
        }
        });

        socket.on('create_room', async ({ userId }) => {
            try {
                const user = await User.findById(userId).lean();
                if (!user || user.isBanned) {
                    socket.emit('error', { message: 'Account restricted or not found.' });
                    return;
                }

                // Generate a unique 6-char code
                let code;
                let attempts = 0;
                do {
                    code = generateRoomCode();
                    attempts++;
                } while (challengeRooms[code] && attempts < 20);

                challengeRooms[code] = {
                    code,
                    host: {
                        socketId: socket.id,
                        userId: user._id.toString(),
                        name: user.username,
                        level: user.level,
                        genrePreferences: user.preferredGenres || new Array(10).fill(0),
                        playedQuestions: user.playedQuestions || [],
                    },
                    createdAt: Date.now(),
                };

                socket.join(`challenge_${code}`);
                socket.emit('room_created', { code });

                // Auto-expire after 60 seconds if friend never joins
                setTimeout(() => {
                    if (challengeRooms[code]) {
                        socket.emit('room_expired', {
                            message: 'Room expired. No one joined in time.',
                        });
                        socket.leave(`challenge_${code}`);
                        delete challengeRooms[code];
                        console.log(`Challenge room ${code} expired.`);
                    }
                }, 60000);

                console.log(`Challenge room created: ${code} by ${user.username}`);
            } catch (err) {
                console.error('create_room error:', err);
                socket.emit('error', { message: 'Could not create room.' });
            }
        });

        const startDuel = async (roomId) => {
            const game = activeGames[roomId];
            if (!game || game.duelStarted) return;
            game.duelStarted = true;

            try {
                // Questions are swapped: p1 plays what p2 selected, and vice versa
                const p1History = game.p2.selections.map(q => new mongoose.Types.ObjectId(q._id));
                const p2History = game.p1.selections.map(q => new mongoose.Types.ObjectId(q._id));

                // Save these to playedQuestions immediately to prevent future repeats
                await Promise.all([
                    User.updateOne({ _id: game.p1.userId }, { $addToSet: { playedQuestions: { $each: p1History } } }),
                    User.updateOne({ _id: game.p2.userId }, { $addToSet: { playedQuestions: { $each: p2History } } })
                ]);
            } catch (dbErr) { console.error("History Update Error:", dbErr); }

            io.to(roomId).emit('start_duel', {
                p1Questions: game.p2.selections, 
                p2Questions: game.p1.selections, 
                timer: 60
            });
        };


        socket.on('join_room', async ({ userId, code }) => {
            try {
                const trimmedCode = (code || '').trim().toUpperCase();
                const room = challengeRooms[trimmedCode];

                if (!room) {
                    socket.emit('error', { message: 'Invalid or expired room code.' });
                    return;
                }

                if (room.host.socketId === socket.id) {
                    socket.emit('error', { message: 'You cannot join your own room.' });
                    return;
                }

                const user = await User.findById(userId).lean();
                if (!user || user.isBanned) {
                    socket.emit('error', { message: 'Account restricted or not found.' });
                    return;
                }

                // Room is valid — cancel expiry by deleting it from challengeRooms
                // before the setTimeout fires (the timeout checks challengeRooms[code])
                delete challengeRooms[trimmedCode];

                const host = room.host;
                const guest = {
                    socketId: socket.id,
                    userId: user._id.toString(),
                    name: user.username,
                    level: user.level,
                    genrePreferences: user.preferredGenres || new Array(10).fill(0),
                    playedQuestions: user.playedQuestions || [],
                };

                const roomId = `challenge_${trimmedCode}`;
                socket.join(roomId);

                // Reuse Quick Match difficulty logic
                const difficultyMap = { noob: 'Easy', intermediate: 'Medium', pro: 'Hard' };
                // Use host's level as the baseline (both players see same difficulty)
                const targetDifficulty = difficultyMap[host.level] || 'Easy';

                const combinedHistory = [
                    ...(host.playedQuestions || []),
                    ...(guest.playedQuestions || []),
                ];

                const allQuestions = await Question.aggregate([
                    {
                        $match: {
                            difficulty: { $regex: new RegExp(`^${targetDifficulty}$`, 'i') },
                            _id: { $nin: combinedHistory.map(id => new mongoose.Types.ObjectId(id)) },
                        },
                    },
                    { $sample: { size: 20 } },
                ]);

                if (allQuestions.length < 20) {
                    io.to(roomId).emit('error', {
                        message: `Not enough ${targetDifficulty} questions available.`,
                    });
                    return;
                }

                const p1Inv = allQuestions.slice(0, 10);
                const p2Inv = allQuestions.slice(10, 20);

                // Store in activeGames — same structure as Quick Match so
                // submit_selection, startDuel, submit_score, finishGame all work unchanged
                activeGames[roomId] = {
                    roomId,
                    p1: {
                        socketId: host.socketId,
                        userId: host.userId,
                        name: host.name,
                        level: host.level,
                        scoreObj: null,
                        inventory: p1Inv,
                    },
                    p2: {
                        socketId: guest.socketId,
                        userId: guest.userId,
                        name: guest.name,
                        level: guest.level,
                        scoreObj: null,
                        inventory: p2Inv,
                    },
                    duelStarted: false,
                };

                // Fire start_selection — identical payload to Quick Match
                io.to(roomId).emit('start_selection', {
                    roomId,
                    timer: 20,
                    p1: { id: host.userId,  name: host.name,  inventory: p1Inv },
                    p2: { id: guest.userId, name: guest.name, inventory: p2Inv },
                });

                // Auto-pick timeout (same 22s as Quick Match)
                setTimeout(async () => {
                    const game = activeGames[roomId];
                    if (game && !game.duelStarted) {
                        if (!game.p1.selections) game.p1.selections = game.p1.inventory.slice(0, 5);
                        if (!game.p2.selections) game.p2.selections = game.p2.inventory.slice(0, 5);
                        await startDuel(roomId);
                    }
                }, 22000);

                console.log(`Challenge match started: ${host.name} vs ${guest.name} (room ${trimmedCode})`);
            } catch (err) {
                console.error('join_room error:', err);
                socket.emit('error', { message: 'Could not join room.' });
            }
        });

        socket.on('cancel_room', ({ code }) => {
            const trimmedCode = (code || '').trim().toUpperCase();
            if (challengeRooms[trimmedCode]) {
                socket.leave(`challenge_${trimmedCode}`);
                delete challengeRooms[trimmedCode];
                console.log(`Challenge room ${trimmedCode} cancelled by host.`);
            }
        });



        socket.on('join_match', async ({ userId }) => {
            try {
                const user = await User.findById(userId).lean();
                if (!user || user.isBanned) {
                    console.log(`Connection rejected: User ${userId} is banned or not found.`);
                    socket.emit('error', { message: "Account restricted or not found." });
                    return;
                }

                // Normalizing field names based on schema: preferredGenres and level
                const currentGenres = 
                (user.preferredGenres && user.preferredGenres.length === 10)
                ? user.preferredGenres
                : new Array(10).fill(0);
                const currentName = user.username || "Anonymous"; 
                const currentLevel = user.level || "noob";

                console.log(`Lobby Entry: ${currentName} | Level: ${currentLevel} | Genres: [${currentGenres}]`);

                // Matchmaking Logic using Level and Cosine Similarity
                const opponentIndex = lobby.findIndex(p => {
                    if (p.userId === userId) return false;
                    
                    // Strict requirement: Players must be in the same level tier
                    if (p.level !== currentLevel) return false;

                    const toVector = (selectedIndices) => {
                    const vector = new Array(10).fill(0); // 10 is the total number of genres
                    selectedIndices.forEach(idx => {
                        if (idx >= 0 && idx < 10) vector[idx] = 1;
                    });
                    return vector;
                    };

                    // Matchmaking based on Cosine Similarity (min threshold 0.65)
                    const vectorA = p.genrePreferences;
                    const vectorB = currentGenres;
                    const similarity = calculateSimilarity(vectorA, vectorB);

                    console.log(`Matching Attempt: ${currentName} vs ${p.name} | Sim: ${similarity.toFixed(2)}`);
                    return similarity >= 0.65;
                });

                if (opponentIndex !== -1) {
                    const opponent = lobby.splice(opponentIndex, 1)[0];
                    const roomId = `match_${socket.id}_${opponent.socketId}`;
                    
                    socket.join(roomId);
                    const opponentSocket = io.sockets.sockets.get(opponent.socketId);
                    if (opponentSocket) opponentSocket.join(roomId);

                    // 1. Determine target difficulty based on level
                    // Logic: Noob -> Easy, Intermediate -> Medium, Pro -> Hard
                    const difficultyMap = {
                        'noob': 'Easy',
                        'intermediate': 'Medium',
                        'pro': 'Hard'
                    };
                    const targetDifficulty = difficultyMap[currentLevel] || 'Easy';

                    // Combine histories to ensure NO player receives a repeated question
                    const combinedHistory = [
                        ...(user.playedQuestions || []),
                        ...(opponent.playedQuestions || [])
                    ];

                    // Fetch 20 unique questions (10 for each player to pick from)
                    const allQuestions = await Question.aggregate([
                     { 
                    $match: { 
                        difficulty: { 
                            $regex: new RegExp(`^${targetDifficulty}$`, 'i') 
                                    },
                        _id: { 
                            $nin: combinedHistory.map(id => new mongoose.Types.ObjectId(id)) 
                             } 
                            } 
                    }, 
                        { $sample: { size: 20 } }
                    ]);
                    if (allQuestions.length < 20) {
                    // console.log(`Fallback: Not enough ${targetDifficulty} questions. Fetching general questions.`);
                    // const fallbackQuestions = await Question.aggregate([
                    //     { $match: { _id: { $nin: combinedHistory.map(id => new mongoose.Types.ObjectId(id)) } } },
                    //     { $sample: { size: 20 } }
                    // ]);
                    // allQuestions.push(...fallbackQuestions.slice(0, 20 - allQuestions.length));
                    console.log(`❌ Not enough ${targetDifficulty} questions.`);
                    socket.emit('error', {
                        message: `Not enough ${targetDifficulty} questions available.`
                    });
                    return;
                    }

                    const p1Inv = allQuestions.slice(0, 10);
                    const p2Inv = allQuestions.slice(10, 20);

                    activeGames[roomId] = {
                        roomId,
                        p1: { 
                            socketId: socket.id, 
                            userId, 
                            name: currentName, 
                            level: currentLevel, 
                            scoreObj: null, 
                            inventory: p1Inv 
                        },
                        p2: { 
                            socketId: opponent.socketId, 
                            userId: opponent.userId, 
                            name: opponent.name, 
                            level: opponent.level, 
                            scoreObj: null, 
                            inventory: p2Inv 
                        },
                        duelStarted: false
                    };

                    // Trigger Selection Screen in Flutter
                    io.to(roomId).emit('start_selection', {
                        roomId,
                        timer: 20,
                        // p1: { id: userId, inventory: p1Inv },
                        // p2: { id: opponent.userId, inventory: p2Inv }
                        p1: { id: userId, name: currentName, inventory: p1Inv },
                        p2: { id: opponent.userId, name: opponent.name, inventory: p2Inv }
                    });

                    // Timeout: If players don't select, auto-pick the first 5
                    setTimeout(async () => {
                        const game = activeGames[roomId];
                        if (game && !game.duelStarted) {
                            if (!game.p1.selections) game.p1.selections = game.p1.inventory.slice(0, 5);
                            if (!game.p2.selections) game.p2.selections = game.p2.inventory.slice(0, 5);
                            await startDuel(roomId);
                        }
                    }, 22000);

                } else {
                    // No match found: Add current user to lobby
                    lobby = lobby.filter(p => p.userId !== userId);
                    lobby.push({
                        socketId: socket.id,
                        userId: user._id.toString(),
                        name: currentName,
                        level: currentLevel,
                        genrePreferences: currentGenres,
                        playedQuestions: user.playedQuestions || []
                    });
                    socket.emit('waiting', { status: "Searching for an opponent..." });
                }
            } catch (err) { console.error("Matchmaking error:", err); }
        });

        // Event: Player submits their 5 chosen questions for the opponent
        socket.on('submit_selection', async ({ roomId, userId, selectedIds }) => {
            const game = activeGames[roomId];
            if (!game || game.duelStarted) return;

            const player = game.p1.userId === userId ? game.p1 : game.p2;
            player.selections = player.inventory.filter(q => selectedIds.includes(q._id.toString())).slice(0, 5);

            console.log(`User ${userId} submitted ${player.selections.length} selections`);

            if (game.p1.selections && game.p2.selections) {
                await startDuel(roomId);
            }
        });

        const finishGame = async (roomId) => {
            const game = activeGames[roomId];
            if (!game) return;

            const s1 = game.p1.finalMatchScore || 0;
            const s2 = game.p2.finalMatchScore || 0;
            let winnerId = s1 > s2 ? game.p1.userId : (s2 > s1 ? game.p2.userId : null);
            let isDraw = s1 === s2;

            try {
                for (const p of [game.p1, game.p2]) {
                    const isWinner = p.userId === winnerId;
                    
                    let statChange = 0;
                    if (!isDraw) {
                        if (isWinner) {
                            if (p.level === "noob") statChange = 20;
                            else if (p.level === "intermediate") statChange = 15;
                            else if (p.level === "pro") statChange = 10;
                        } else {
                            if (p.level === "noob") statChange = -5;
                            else if (p.level === "intermediate") statChange = -10;
                            else if (p.level === "pro") statChange = -15;
                        }
                    }

                    let updatedUser = await User.findByIdAndUpdate(p.userId, {
                        $inc: {
                            "stats.matchesPlayed": 1,
                            "stats.wins": isWinner ? 1 : 0,
                            "stats.losses": (!isWinner && !isDraw) ? 1 : 0,
                            "stats.draws": isDraw ? 1 : 0,
                            "stats.totalPoints": statChange,
                        }
                    }, { returnDocument: 'after' });
                    
                    if (updatedUser) {
                        let targetLevel = updatedUser.level;
                        if (updatedUser.stats.totalPoints >= 500 && updatedUser.level === "intermediate") {
                            targetLevel = "pro";
                        } else if (updatedUser.stats.totalPoints >= 200 && updatedUser.level === "noob") {
                            targetLevel = "intermediate";
                        }

                        if (targetLevel !== updatedUser.level) {
                            updatedUser = await User.findByIdAndUpdate(p.userId, { level: targetLevel }, { new: true });
                        }

                        io.to(p.socketId).emit('stats_update', {
                            points: updatedUser.stats.totalPoints,
                            tier: updatedUser.level,
                            matchesPlayed: updatedUser.stats.matchesPlayed,
                            wins: updatedUser.stats.wins,         
                            losses: updatedUser.stats.losses,
                            draws: updatedUser.stats.draws,//added
                        });
                    }
                }
            } catch (err) { console.error("Finalizing error:", err); }

            io.to(roomId).emit('game_over', { 
                results: [
                        { userId: game.p1.userId, name: game.p1.name, matchScore: s1, correct: game.p1.scoreObj?.correct ?? 0, total: 5 }, 
                        { userId: game.p2.userId, name: game.p2.name, matchScore: s2, correct: game.p2.scoreObj?.correct ?? 0, total: 5 }
                    ],  
                winner: winnerId 
            });
            delete activeGames[roomId];
            await broadcastLeaderboard(io);
        };


        socket.on('submit_score', ({ roomId, userId, score }) => {
            const game = activeGames[roomId];
            if (!game) return;

            const p = game.p1.userId === userId ? game.p1 : game.p2;
            p.scoreObj = score;
            p.finalMatchScore = (score.correct * 10) + (score.wrong * -5);

            if (game.p1.scoreObj !== null && game.p2.scoreObj !== null) {
                finishGame(roomId);
            }
        });

        socket.on('disconnect', () => {
            lobby = lobby.filter(p => p.socketId !== socket.id);
            for (const roomId in activeGames) {
                const game = activeGames[roomId];
                if (game.p1.socketId === socket.id || game.p2.socketId === socket.id) {
                    const oppId = game.p1.socketId === socket.id ? game.p2.socketId : game.p1.socketId;
                    io.to(oppId).emit('opponent_left', { message: "Opponent disconnected." });
                    delete activeGames[roomId];
                    break;
                }
            }
            for (const code in challengeRooms) {
                if (challengeRooms[code].host.socketId === socket.id) {
                    delete challengeRooms[code];
                    console.log(`Challenge room ${code} removed (host disconnected).`);
                }
            }
        });
    });
};