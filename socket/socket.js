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
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code = '';
        for (let i = 0; i < 6; i++) {
            code += chars[Math.floor(Math.random() * chars.length)];
        }
        return code;
    };

    const applyMatchResult = async (io, player, isWinner, isDraw = false) => {
        let pointChange = 0;
        if (!isDraw) {
            pointChange = isWinner
                ? (player.level === 'noob' ? 20 : player.level === 'intermediate' ? 15 : 10)
                : (player.level === 'noob' ? -5 : player.level === 'intermediate' ? -10 : -15);
        }

        let updated = await User.findByIdAndUpdate(player.userId, {
            $inc: {
                'stats.matchesPlayed': 1,
                'stats.wins':   isWinner && !isDraw ? 1 : 0,
                'stats.losses': !isWinner && !isDraw ? 1 : 0,
                'stats.draws':  isDraw ? 1 : 0,
                'stats.totalPoints': pointChange,
            }
        }, { new: true });

        if (updated) {
            let targetLevel = updated.level;
            if (updated.stats.totalPoints >= 500 && updated.level === 'intermediate') targetLevel = 'pro';
            else if (updated.stats.totalPoints >= 200 && updated.level === 'noob') targetLevel = 'intermediate';

            if (targetLevel !== updated.level) {
                updated = await User.findByIdAndUpdate(player.userId, { level: targetLevel }, { new: true });
            }

            io.to(player.socketId).emit('stats_update', {
                points:        updated.stats.totalPoints,
                tier:          updated.level,
                matchesPlayed: updated.stats.matchesPlayed,
                wins:          updated.stats.wins,
                losses:        updated.stats.losses,
                draws:         updated.stats.draws,
            });
        }
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

                setTimeout(() => {
                    if (challengeRooms[code]) {
                        if (socket.connected) {
                            socket.emit('room_expired', { message: 'Room expired. No one joined in time.' });
                        }
                        socket.leave(`challenge_${code}`);
                        delete challengeRooms[code];
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
                const p1History = game.p2.selections.map(q => new mongoose.Types.ObjectId(q._id));
                const p2History = game.p1.selections.map(q => new mongoose.Types.ObjectId(q._id));

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

                const difficultyMap = { noob: 'Easy', intermediate: 'Medium', pro: 'Hard' };
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

                io.to(roomId).emit('start_selection', {
                    roomId,
                    timer: 20,
                    p1: { id: host.userId,  name: host.name,  inventory: p1Inv },
                    p2: { id: guest.userId, name: guest.name, inventory: p2Inv },
                });

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

                const currentGenres =
                    (user.preferredGenres && user.preferredGenres.length === 10)
                        ? user.preferredGenres
                        : new Array(10).fill(0);
                const currentName  = user.username || "Anonymous";
                const currentLevel = user.level || "noob";

                console.log(`Lobby Entry: ${currentName} | Level: ${currentLevel} | Genres: [${currentGenres}]`);

                const opponentIndex = lobby.findIndex(p => {
                    if (p.userId === userId) return false;
                    if (p.level !== currentLevel) return false;
                    const similarity = calculateSimilarity(p.genrePreferences, currentGenres);
                    console.log(`Matching Attempt: ${currentName} vs ${p.name} | Sim: ${similarity.toFixed(2)}`);
                    return similarity >= 0.65;
                });

                if (opponentIndex !== -1) {
                    const opponent = lobby.splice(opponentIndex, 1)[0];
                    const roomId = `match_${socket.id}_${opponent.socketId}`;

                    socket.join(roomId);
                    const opponentSocket = io.sockets.sockets.get(opponent.socketId);
                    if (opponentSocket) opponentSocket.join(roomId);

                    const difficultyMap = { noob: 'Easy', intermediate: 'Medium', pro: 'Hard' };
                    const targetDifficulty = difficultyMap[currentLevel] || 'Easy';

                    const combinedHistory = [
                        ...(user.playedQuestions || []),
                        ...(opponent.playedQuestions || [])
                    ];

                    const allQuestions = await Question.aggregate([
                        {
                            $match: {
                                difficulty: { $regex: new RegExp(`^${targetDifficulty}$`, 'i') },
                                _id: { $nin: combinedHistory.map(id => new mongoose.Types.ObjectId(id)) }
                            }
                        },
                        { $sample: { size: 20 } }
                    ]);

                    if (allQuestions.length < 20) {
                        console.log(`❌ Not enough ${targetDifficulty} questions.`);
                        socket.emit('error', { message: `Not enough ${targetDifficulty} questions available.` });
                        return;
                    }

                    const p1Inv = allQuestions.slice(0, 10);
                    const p2Inv = allQuestions.slice(10, 20);

                    activeGames[roomId] = {
                        roomId,
                        p1: { socketId: socket.id,        userId,              name: currentName,    level: currentLevel,    scoreObj: null, inventory: p1Inv },
                        p2: { socketId: opponent.socketId, userId: opponent.userId, name: opponent.name, level: opponent.level, scoreObj: null, inventory: p2Inv },
                        duelStarted: false
                    };

                    io.to(roomId).emit('start_selection', {
                        roomId,
                        timer: 20,
                        p1: { id: userId,              name: currentName,    inventory: p1Inv },
                        p2: { id: opponent.userId,     name: opponent.name,  inventory: p2Inv }
                    });

                    setTimeout(async () => {
                        const game = activeGames[roomId];
                        if (game && !game.duelStarted) {
                            if (!game.p1.selections) game.p1.selections = game.p1.inventory.slice(0, 5);
                            if (!game.p2.selections) game.p2.selections = game.p2.inventory.slice(0, 5);
                            await startDuel(roomId);
                        }
                    }, 22000);

                } else {
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

        socket.on('leave_lobby', ({ userId }) => {
            lobby = lobby.filter(p => p.userId !== userId);
            console.log(`User ${userId} left the lobby.`);
        });

        const finishGame = async (roomId) => {
            const game = activeGames[roomId];
            if (!game) return;

            // ── Winner decided purely by number of correct answers ──
            const c1 = game.p1.scoreObj?.correct ?? 0;
            const c2 = game.p2.scoreObj?.correct ?? 0;

            const isDraw    = c1 === c2;
            const winnerId  = isDraw ? null : (c1 > c2 ? game.p1.userId : game.p2.userId);

            try {
                await Promise.all([game.p1, game.p2].map(p =>
                    applyMatchResult(io, p, p.userId === winnerId, isDraw)
                ));
            } catch (err) { console.error("Finalizing error:", err); }

            io.to(roomId).emit('game_over', {
                results: [
                    { userId: game.p1.userId, name: game.p1.name, correct: c1, total: 5, matchScore: c1 },
                    { userId: game.p2.userId, name: game.p2.name, correct: c2, total: 5, matchScore: c2 },
                ],
                winner: winnerId
            });

            delete activeGames[roomId];
            await broadcastLeaderboard(io);
        };

        socket.on('forfeit', async ({ roomId, userId }) => {
            const game = activeGames[roomId];
            if (!game || game.forfeited) return;
            game.forfeited = true;

            const winner = game.p1.userId === userId ? game.p2 : game.p1;
            const loser  = game.p1.userId === userId ? game.p1 : game.p2;

            if (!loser.scoreObj) {
                loser.scoreObj = { correct: 0, wrong: 0 };
            }

            setTimeout(() => {
                if (activeGames[roomId]) finishGame(roomId);
            }, 120000);

            io.to(winner.socketId).emit('opponent_forfeited', {
                message: 'Opponent forfeited. Finish your questions to see the results.'
            });

            if (winner.scoreObj !== null) {
                await finishGame(roomId);
            }
        });

        socket.on('submit_selection', async ({ roomId, userId, selectedIds }) => {
            const game = activeGames[roomId];
            if (!game || game.duelStarted) return;

            const player = game.p1.userId === userId ? game.p1 : game.p2;

            const normalizedSelectedIds = selectedIds.map(id =>
                typeof id === 'object' ? id.toString() : String(id)
            );

            player.selections = player.inventory
                .filter(q => {
                    const qId = q._id?.$oid ?? q._id?.toString() ?? String(q._id);
                    return normalizedSelectedIds.includes(qId);
                })
                .slice(0, 5);

            if (player.selections.length === 0) {
                console.warn(`Selection filter returned 0 for ${userId}, using fallback`);
                player.selections = player.inventory.slice(0, 5);
            }

            console.log(`${userId} selections: ${player.selections.length}`);

            if (game.p1.selections && game.p2.selections) {
                await startDuel(roomId);
            }
        });

        socket.on('submit_score', async ({ roomId, userId, score }) => {
            const game = activeGames[roomId];
            if (!game) return;

            const p = game.p1.userId === userId ? game.p1 : game.p2;
            // Store the raw score object — correct count is what decides the winner
            p.scoreObj = score;

            if (game.p1.scoreObj !== null && game.p2.scoreObj !== null) {
                await finishGame(roomId);
            }
        });

        socket.on('disconnect', () => {
            lobby = lobby.filter(p => p.socketId !== socket.id);

            for (const roomId in activeGames) {
                const game = activeGames[roomId];
                if (game.p1.socketId === socket.id || game.p2.socketId === socket.id) {
                    if (game.forfeited) break;

                    game.forfeited = true;

                    const winner = game.p1.socketId === socket.id ? game.p2 : game.p1;
                    const loser  = game.p1.socketId === socket.id ? game.p1 : game.p2;

                    if (!loser.scoreObj) {
                        loser.scoreObj = { correct: 0, wrong: 0 };
                    }

                    setTimeout(() => {
                        if (activeGames[roomId]) finishGame(roomId);
                    }, 120000);

                    io.to(winner.socketId).emit('opponent_left', {
                        message: 'Opponent disconnected. Finish your questions to see the results.',
                    });

                    if (winner.scoreObj !== null) {
                        (async () => {
                            try {
                                await finishGame(roomId);
                            } catch (err) {
                                console.error('Disconnect finishGame error:', err);
                            }
                        })();
                    }

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