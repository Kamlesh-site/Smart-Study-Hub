const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const archiver = require('archiver');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
app.use('/profile-pics', express.static('profile-pics'));
app.use(session({
    secret: 'studyhub-secret-key-2024-advanced',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        httpOnly: true,
        secure: false // Set to true in production with HTTPS
    }
}));

// Create directories if they don't exist
['uploads', 'profile-pics', 'temp'].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir);
    }
});

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (file.fieldname === 'profilePic') {
            cb(null, 'profile-pics/');
        } else {
            cb(null, 'uploads/');
        }
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, uniqueSuffix + ext);
    }
});

const fileFilter = (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Only JPEG, PNG, and PDF files are allowed'), false);
    }
};

const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit for multiple files
    fileFilter: fileFilter
});

// Database setup
const db = new Database('database.db');

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Create all tables
db.exec(`
    -- Users table with additional fields
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        email TEXT UNIQUE,
        profile_pic TEXT DEFAULT 'default.png',
        bio TEXT,
        last_active DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen DATETIME,
        online_status BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        reset_token TEXT,
        reset_expires DATETIME
    );

    -- Subjects table
    CREATE TABLE IF NOT EXISTS subjects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        display_order INTEGER
    );

    -- Chapters table
    CREATE TABLE IF NOT EXISTS chapters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject_id INTEGER,
        name TEXT,
        chapter_order INTEGER,
        FOREIGN KEY(subject_id) REFERENCES subjects(id),
        UNIQUE(subject_id, name)
    );

    -- Notes table (collaborative notes)
    CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        subject_id INTEGER,
        chapter_id INTEGER,
        content TEXT,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(subject_id) REFERENCES subjects(id),
        FOREIGN KEY(chapter_id) REFERENCES chapters(id),
        UNIQUE(user_id, subject_id, chapter_id)
    );

    -- Uploaded notes files table (for PDFs and images)
    CREATE TABLE IF NOT EXISTS uploaded_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        subject_id INTEGER,
        chapter_name TEXT,
        optional_subject_id INTEGER,
        file_path TEXT,
        file_name TEXT,
        original_name TEXT,
        file_type TEXT,
        file_size INTEGER,
        description TEXT,
        tags TEXT,
        date_of_notes DATE,
        is_favorite BOOLEAN DEFAULT 0,
        download_count INTEGER DEFAULT 0,
        uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(subject_id) REFERENCES subjects(id),
        FOREIGN KEY(optional_subject_id) REFERENCES subjects(id)
    );

    -- Messages table with enhanced features
    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id INTEGER,
        receiver_id INTEGER,
        message TEXT,
        is_read BOOLEAN DEFAULT 0,
        is_edited BOOLEAN DEFAULT 0,
        is_deleted BOOLEAN DEFAULT 0,
        read_at DATETIME,
        edited_at DATETIME,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(sender_id) REFERENCES users(id),
        FOREIGN KEY(receiver_id) REFERENCES users(id)
    );

    -- User activity tracking
    CREATE TABLE IF NOT EXISTS user_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        activity_type TEXT,
        subject_id INTEGER,
        chapter_id INTEGER,
        metadata TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    );

    -- User favorites/bookmarks
    CREATE TABLE IF NOT EXISTS favorites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        item_type TEXT,
        item_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id),
        UNIQUE(user_id, item_type, item_id)
    );

    -- Typing status tracking
    CREATE TABLE IF NOT EXISTS typing_status (
        user_id INTEGER PRIMARY KEY,
        chat_partner_id INTEGER,
        is_typing BOOLEAN DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(chat_partner_id) REFERENCES users(id)
    );

    -- Sessions for auto-logout
    CREATE TABLE IF NOT EXISTS user_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        session_id TEXT,
        login_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN DEFAULT 1,
        FOREIGN KEY(user_id) REFERENCES users(id)
    );

    -- Password reset tokens
    CREATE TABLE IF NOT EXISTS password_resets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        token TEXT UNIQUE,
        expires_at DATETIME,
        used BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    );
`);

// Insert predefined subjects
const subjects = [
    'Mathematics', 'Physics', 'Chemistry', 'Biology', 'English',
    'History', 'Geography', 'Civics', 'Economics', 'Information Technology'
];

const insertSubject = db.prepare('INSERT OR IGNORE INTO subjects (name, display_order) VALUES (?, ?)');
subjects.forEach((subject, index) => {
    insertSubject.run(subject, index + 1);
});

// Get subject IDs mapping
const subjectIds = {};
const getSubjects = db.prepare('SELECT id, name FROM subjects');
getSubjects.all().forEach(row => {
    subjectIds[row.name] = row.id;
});

// Insert chapters for each subject
const chaptersData = {
    'Mathematics': ['Number Systems', 'Polynomials', 'Coordinate Geometry', 'Linear Equations', 'Euclid\'s Geometry', 'Lines and Angles', 'Triangles', 'Quadrilaterals', 'Circles', 'Heron\'s Formula'],
    'Physics': ['Motion', 'Force and Laws of Motion', 'Gravitation', 'Work and Energy', 'Sound'],
    'Chemistry': ['Matter in Our Surroundings', 'Is Matter Around Us Pure', 'Atoms and Molecules', 'Structure of Atom'],
    'Biology': ['Cell: The Unit of Life', 'Tissues', 'Diversity in Living Organisms', 'Why Do We Fall Ill', 'Natural Resources'],
    'English': ['The Fun They Had', 'The Sound of Music', 'The Little Girl', 'A Truly Beautiful Mind', 'The Snake and the Mirror', 'My Childhood', 'Packing', 'Reach for the Top'],
    'History': ['The French Revolution', 'Socialism in Europe', 'Nazism and Hitler', 'Forest Society', 'Pastoralists', 'Peasants and Farmers'],
    'Geography': ['India: Size and Location', 'Physical Features', 'Drainage', 'Climate', 'Natural Vegetation', 'Population'],
    'Civics': ['Democracy', 'Constitutional Design', 'Electoral Politics', 'Working of Institutions', 'Democratic Rights'],
    'Economics': ['The Story of Village Palampur', 'People as Resource', 'Poverty', 'Food Security'],
    'Information Technology': ['Introduction to IT', 'Computer System', 'Word Processing', 'Spreadsheet', 'Presentation', 'Email', 'Internet', 'Cyber Safety']
};

const insertChapter = db.prepare('INSERT OR IGNORE INTO chapters (subject_id, name, chapter_order) VALUES (?, ?, ?)');

Object.entries(chaptersData).forEach(([subject, chapters]) => {
    const subjectId = subjectIds[subject];
    chapters.forEach((chapter, index) => {
        insertChapter.run(subjectId, chapter, index + 1);
    });
});

// Authentication middleware
const requireAuth = (req, res, next) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Update last activity
    const updateStmt = db.prepare('UPDATE user_sessions SET last_activity = CURRENT_TIMESTAMP WHERE user_id = ? AND is_active = 1');
    updateStmt.run(req.session.userId);
    
    next();
};

// Check session timeout (30 minutes)
const checkSessionTimeout = (req, res, next) => {
    if (req.session.userId) {
        const sessionStmt = db.prepare('SELECT last_activity FROM user_sessions WHERE user_id = ? AND is_active = 1 ORDER BY login_time DESC LIMIT 1');
        const session = sessionStmt.get(req.session.userId);
        
        if (session) {
            const lastActivity = new Date(session.last_activity);
            const now = new Date();
            const diffMinutes = (now - lastActivity) / (1000 * 60);
            
            if (diffMinutes > 30) { // 30 minutes timeout
                db.prepare('UPDATE user_sessions SET is_active = 0 WHERE user_id = ?').run(req.session.userId);
                req.session.destroy();
                return res.status(401).json({ error: 'Session expired' });
            }
        }
    }
    next();
};

app.use(checkSessionTimeout);

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('New client connected');
    
    socket.on('user-login', (userId) => {
        socket.join(`user-${userId}`);
        socket.userId = userId;
        
        // Update online status
        db.prepare('UPDATE users SET online_status = 1, last_active = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
        
        // Track session
        const sessionId = socket.id;
        db.prepare('INSERT INTO user_sessions (user_id, session_id) VALUES (?, ?)').run(userId, sessionId);
        
        broadcastOnlineUsers();
    });
    
    socket.on('join-chat', (room) => {
        if (room === 'global') {
            socket.join('global-chat');
        }
    });
    
    socket.on('typing', (data) => {
        const { receiverId, isTyping } = data;
        
        // Update typing status
        db.prepare(`
            INSERT INTO typing_status (user_id, chat_partner_id, is_typing, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id) DO UPDATE SET
                chat_partner_id = excluded.chat_partner_id,
                is_typing = excluded.is_typing,
                updated_at = excluded.updated_at
        `).run(socket.userId, receiverId, isTyping ? 1 : 0);
        
        // Send typing indicator to receiver
        io.to(`user-${receiverId}`).emit('typing-indicator', {
            userId: socket.userId,
            isTyping
        });
    });
    
    socket.on('send-message', async (data) => {
        const { receiverId, message } = data;
        
        let result;
        if (receiverId === 'global') {
            // Save global message
            const stmt = db.prepare('INSERT INTO messages (sender_id, receiver_id, message) VALUES (?, NULL, ?)');
            result = stmt.run(socket.userId, message);
        } else {
            // Save private message
            const stmt = db.prepare('INSERT INTO messages (sender_id, receiver_id, message) VALUES (?, ?, ?)');
            result = stmt.run(socket.userId, receiverId, message);
        }
        
        // Get sender info
        const userStmt = db.prepare('SELECT username, profile_pic FROM users WHERE id = ?');
        const user = userStmt.get(socket.userId);
        
        const messageData = {
            id: result.lastInsertRowid,
            sender_id: socket.userId,
            sender_name: user.username,
            sender_pic: user.profile_pic,
            message,
            timestamp: new Date().toISOString(),
            is_read: false
        };
        
        if (receiverId === 'global') {
            io.to('global-chat').emit('new-message', { ...messageData, type: 'global' });
        } else {
            // Emit to sender and receiver
            io.to(`user-${socket.userId}`).to(`user-${receiverId}`).emit('new-message', {
                ...messageData,
                type: 'private',
                receiver_id: receiverId
            });
        }
    });
    
    socket.on('mark-read', (data) => {
        const { messageIds } = data;
        
        if (messageIds && messageIds.length > 0) {
            const placeholders = messageIds.map(() => '?').join(',');
            const stmt = db.prepare(`UPDATE messages SET is_read = 1, read_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders}) AND receiver_id = ?`);
            stmt.run(...messageIds, socket.userId);
        }
    });
    
    socket.on('edit-message', (data) => {
        const { messageId, newMessage } = data;
        
        // Check if user owns the message
        const checkStmt = db.prepare('SELECT sender_id FROM messages WHERE id = ?');
        const message = checkStmt.get(messageId);
        
        if (message && message.sender_id === socket.userId) {
            const stmt = db.prepare('UPDATE messages SET message = ?, is_edited = 1, edited_at = CURRENT_TIMESTAMP WHERE id = ?');
            stmt.run(newMessage, messageId);
            
            // Get updated message
            const getStmt = db.prepare('SELECT * FROM messages WHERE id = ?');
            const updatedMsg = getStmt.get(messageId);
            
            // Broadcast edit
            io.emit('message-edited', {
                messageId,
                newMessage,
                edited_at: updatedMsg.edited_at
            });
        }
    });
    
    socket.on('delete-message', (data) => {
        const { messageId } = data;
        
        // Check if user owns the message
        const checkStmt = db.prepare('SELECT sender_id FROM messages WHERE id = ?');
        const message = checkStmt.get(messageId);
        
        if (message && message.sender_id === socket.userId) {
            const stmt = db.prepare('UPDATE messages SET is_deleted = 1 WHERE id = ?');
            stmt.run(messageId);
            
            // Broadcast deletion
            io.emit('message-deleted', { messageId });
        }
    });
    
    socket.on('join-note', (data) => {
        socket.join(`note-${data.subjectId}-${data.chapterId}`);
    });
    
    socket.on('leave-note', (data) => {
        socket.leave(`note-${data.subjectId}-${data.chapterId}`);
    });
    
    socket.on('note-update', (data) => {
        socket.to(`note-${data.subjectId}-${data.chapterId}`).emit('note-changed', data);
    });
    
    socket.on('disconnect', () => {
        if (socket.userId) {
            // Update online status
            db.prepare('UPDATE users SET online_status = 0, last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(socket.userId);
            
            // End session
            db.prepare('UPDATE user_sessions SET is_active = 0 WHERE user_id = ? AND session_id = ?').run(socket.userId, socket.id);
            
            // Clear typing status
            db.prepare('DELETE FROM typing_status WHERE user_id = ?').run(socket.userId);
            
            broadcastOnlineUsers();
        }
        console.log('Client disconnected');
    });
});

// Broadcast online users to all connected clients
function broadcastOnlineUsers() {
    const users = [];
    for (let [id, socket] of io.sockets.sockets) {
        if (socket.userId) {
            const stmt = db.prepare('SELECT id, username, profile_pic FROM users WHERE id = ?');
            const user = stmt.get(socket.userId);
            if (user) {
                users.push(user);
            }
        }
    }
    io.emit('online-users', users);
}

// Helper function to log activity
function logActivity(userId, type, subjectId = null, chapterId = null, metadata = null) {
    const stmt = db.prepare(`
        INSERT INTO user_activity (user_id, activity_type, subject_id, chapter_id, metadata)
        VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(userId, type, subjectId, chapterId, metadata ? JSON.stringify(metadata) : null);
}

// API Routes

// Authentication routes
app.post('/api/signup', async (req, res) => {
    const { username, password, email } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }
    
    if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    
    if (email && !/^\S+@\S+\.\S+$/.test(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
    }
    
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const stmt = db.prepare('INSERT INTO users (username, password, email) VALUES (?, ?, ?)');
        const result = stmt.run(username, hashedPassword, email || null);
        
        logActivity(result.lastInsertRowid, 'signup');
        
        res.json({ success: true, userId: result.lastInsertRowid });
    } catch (error) {
        if (error.message.includes('UNIQUE')) {
            res.status(400).json({ error: 'Username or email already exists' });
        } else {
            res.status(500).json({ error: 'Server error' });
        }
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    
    const stmt = db.prepare('SELECT * FROM users WHERE username = ?');
    const user = stmt.get(username);
    
    if (user && await bcrypt.compare(password, user.password)) {
        req.session.userId = user.id;
        req.session.username = user.username;
        
        // Update last active and online status
        db.prepare('UPDATE users SET last_active = CURRENT_TIMESTAMP, online_status = 1 WHERE id = ?').run(user.id);
        
        logActivity(user.id, 'login');
        
        res.json({ 
            success: true, 
            user: { 
                id: user.id, 
                username: user.username,
                email: user.email,
                profile_pic: user.profile_pic,
                bio: user.bio
            }
        });
    } else {
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

app.post('/api/logout', requireAuth, (req, res) => {
    // Update online status
    db.prepare('UPDATE users SET online_status = 0, last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(req.session.userId);
    
    // End all active sessions
    db.prepare('UPDATE user_sessions SET is_active = 0 WHERE user_id = ?').run(req.session.userId);
    
    logActivity(req.session.userId, 'logout');
    
    req.session.destroy();
    res.json({ success: true });
});

// Get current user
app.get('/api/user', requireAuth, (req, res) => {
    const stmt = db.prepare(`
        SELECT id, username, email, profile_pic, bio, created_at, last_active, last_seen, online_status
        FROM users WHERE id = ?
    `);
    const user = stmt.get(req.session.userId);
    res.json(user);
});

// Update profile
app.post('/api/user/profile', requireAuth, upload.single('profilePic'), (req, res) => {
    const { bio } = req.body;
    let profilePic = null;
    
    if (req.file) {
        profilePic = req.file.filename;
    }
    
    let query = 'UPDATE users SET bio = ?';
    const params = [bio];
    
    if (profilePic) {
        query += ', profile_pic = ?';
        params.push(profilePic);
    }
    
    query += ' WHERE id = ?';
    params.push(req.session.userId);
    
    db.prepare(query).run(...params);
    
    logActivity(req.session.userId, 'profile_update');
    
    res.json({ success: true, profilePic });
});

// Change password
app.post('/api/user/change-password', requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    
    const stmt = db.prepare('SELECT password FROM users WHERE id = ?');
    const user = stmt.get(req.session.userId);
    
    if (!await bcrypt.compare(currentPassword, user.password)) {
        return res.status(400).json({ error: 'Current password is incorrect' });
    }
    
    if (newPassword.length < 6) {
        return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }
    
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashedPassword, req.session.userId);
    
    logActivity(req.session.userId, 'password_change');
    
    res.json({ success: true });
});

// Forgot password - generate reset token
app.post('/api/forgot-password', async (req, res) => {
    const { email } = req.body;
    
    const stmt = db.prepare('SELECT id FROM users WHERE email = ?');
    const user = stmt.get(email);
    
    if (user) {
        const token = crypto.randomBytes(32).toString('hex');
        const expires = new Date();
        expires.setHours(expires.getHours() + 1); // 1 hour expiry
        
        db.prepare('INSERT INTO password_resets (user_id, token, expires_at) VALUES (?, ?, ?)')
            .run(user.id, token, expires.toISOString());
        
        // In a real app, send email here
        console.log(`Password reset token for ${email}: ${token}`);
        
        // For demo, return token in response
        res.json({ success: true, token });
    } else {
        // Don't reveal that email doesn't exist
        res.json({ success: true });
    }
});

// Reset password with token
app.post('/api/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;
    
    const stmt = db.prepare(`
        SELECT user_id FROM password_resets 
        WHERE token = ? AND expires_at > CURRENT_TIMESTAMP AND used = 0
    `);
    const reset = stmt.get(token);
    
    if (!reset) {
        return res.status(400).json({ error: 'Invalid or expired token' });
    }
    
    if (newPassword.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashedPassword, reset.user_id);
    db.prepare('UPDATE password_resets SET used = 1 WHERE token = ?').run(token);
    
    logActivity(reset.user_id, 'password_reset');
    
    res.json({ success: true });
});

// Get all subjects
app.get('/api/subjects', (req, res) => {
    const stmt = db.prepare('SELECT id, name FROM subjects ORDER BY display_order');
    const subjects = stmt.all();
    res.json(subjects);
});

// Get chapters for a subject
app.get('/api/subjects/:subjectId/chapters', (req, res) => {
    const stmt = db.prepare('SELECT id, name FROM chapters WHERE subject_id = ? ORDER BY chapter_order');
    const chapters = stmt.all(req.params.subjectId);
    res.json(chapters);
});

// Get collaborative note
app.get('/api/notes/:subjectId/:chapterId', requireAuth, (req, res) => {
    const stmt = db.prepare('SELECT content, last_updated FROM notes WHERE user_id = ? AND subject_id = ? AND chapter_id = ?');
    let note = stmt.get(req.session.userId, req.params.subjectId, req.params.chapterId);
    
    if (!note) {
        // Get chapter name for default content
        const chapterStmt = db.prepare('SELECT name FROM chapters WHERE id = ?');
        const chapter = chapterStmt.get(req.params.chapterId);
        
        const defaultContent = `# ${chapter.name}\n\nStart writing your notes here...`;
        const insertStmt = db.prepare('INSERT INTO notes (user_id, subject_id, chapter_id, content) VALUES (?, ?, ?, ?)');
        insertStmt.run(req.session.userId, req.params.subjectId, req.params.chapterId, defaultContent);
        note = { content: defaultContent, last_updated: new Date().toISOString() };
    }
    
    logActivity(req.session.userId, 'view_note', req.params.subjectId, req.params.chapterId);
    
    res.json(note);
});

// Save collaborative note
app.post('/api/notes/:subjectId/:chapterId', requireAuth, (req, res) => {
    const { content } = req.body;
    
    const stmt = db.prepare(`
        INSERT INTO notes (user_id, subject_id, chapter_id, content, last_updated) 
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, subject_id, chapter_id) 
        DO UPDATE SET content = excluded.content, last_updated = excluded.last_updated
    `);
    
    stmt.run(req.session.userId, req.params.subjectId, req.params.chapterId, content);
    
    logActivity(req.session.userId, 'edit_note', req.params.subjectId, req.params.chapterId);
    
    res.json({ success: true });
});

// Upload notes (multiple files)
app.post('/api/upload-notes', requireAuth, upload.array('files', 10), (req, res) => {
    const { subjectId, chapterName, optionalSubjectId, description, dateOfNotes, tags } = req.body;
    const files = req.files;
    
    if (!files || files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
    }
    
    const results = [];
    const insertStmt = db.prepare(`
        INSERT INTO uploaded_notes 
        (user_id, subject_id, chapter_name, optional_subject_id, file_path, file_name, original_name, file_type, file_size, description, tags, date_of_notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    files.forEach(file => {
        const fileType = file.mimetype.split('/')[1];
        const result = insertStmt.run(
            req.session.userId,
            subjectId,
            chapterName,
            optionalSubjectId || null,
            file.path,
            file.filename,
            file.originalname,
            fileType,
            file.size,
            description || null,
            tags || null,
            dateOfNotes || null
        );
        
        results.push({
            id: result.lastInsertRowid,
            filename: file.filename,
            originalName: file.originalname
        });
    });
    
    logActivity(req.session.userId, 'upload_notes', subjectId, null, { fileCount: files.length });
    
    res.json({ success: true, files: results });
});

// Get uploaded notes with filters
app.get('/api/uploaded-notes', requireAuth, (req, res) => {
    const { subjectId, chapter, date, sortBy = 'uploaded_at', order = 'DESC', tag } = req.query;
    
    let query = `
        SELECT un.*, u.username, u.profile_pic,
               s.name as subject_name, os.name as optional_subject_name
        FROM uploaded_notes un
        JOIN users u ON un.user_id = u.id
        JOIN subjects s ON un.subject_id = s.id
        LEFT JOIN subjects os ON un.optional_subject_id = os.id
        WHERE 1=1
    `;
    const params = [];
    
    if (subjectId) {
        query += ' AND un.subject_id = ?';
        params.push(subjectId);
    }
    
    if (chapter) {
        query += ' AND un.chapter_name LIKE ?';
        params.push(`%${chapter}%`);
    }
    
    if (date) {
        query += ' AND date(un.date_of_notes) = ?';
        params.push(date);
    }
    
    if (tag) {
        query += ' AND un.tags LIKE ?';
        params.push(`%${tag}%`);
    }
    
    // Validate sort column to prevent SQL injection
    const validSortColumns = ['uploaded_at', 'date_of_notes', 'download_count', 'file_name'];
    const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'uploaded_at';
    const sortOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    
    query += ` ORDER BY un.${sortColumn} ${sortOrder} LIMIT 50`;
    
    const stmt = db.prepare(query);
    const notes = stmt.all(...params);
    
    res.json(notes);
});

// Get recent uploaded notes
app.get('/api/uploaded-notes/recent', requireAuth, (req, res) => {
    const stmt = db.prepare(`
        SELECT un.*, u.username, s.name as subject_name
        FROM uploaded_notes un
        JOIN users u ON un.user_id = u.id
        JOIN subjects s ON un.subject_id = s.id
        ORDER BY un.uploaded_at DESC
        LIMIT 20
    `);
    const notes = stmt.all();
    res.json(notes);
});

// Get user's uploaded notes
app.get('/api/my-uploaded-notes', requireAuth, (req, res) => {
    const stmt = db.prepare(`
        SELECT un.*, s.name as subject_name, os.name as optional_subject_name
        FROM uploaded_notes un
        JOIN subjects s ON un.subject_id = s.id
        LEFT JOIN subjects os ON un.optional_subject_id = os.id
        WHERE un.user_id = ?
        ORDER BY un.uploaded_at DESC
    `);
    const notes = stmt.all(req.session.userId);
    res.json(notes);
});

// Toggle favorite for uploaded note
app.post('/api/uploaded-notes/:noteId/favorite', requireAuth, (req, res) => {
    const { noteId } = req.params;
    
    // Check if already favorited
    const checkStmt = db.prepare('SELECT id FROM favorites WHERE user_id = ? AND item_type = "uploaded_note" AND item_id = ?');
    const existing = checkStmt.get(req.session.userId, noteId);
    
    if (existing) {
        // Remove favorite
        db.prepare('DELETE FROM favorites WHERE user_id = ? AND item_type = "uploaded_note" AND item_id = ?')
            .run(req.session.userId, noteId);
        db.prepare('UPDATE uploaded_notes SET is_favorite = 0 WHERE id = ?').run(noteId);
    } else {
        // Add favorite
        db.prepare('INSERT INTO favorites (user_id, item_type, item_id) VALUES (?, "uploaded_note", ?)')
            .run(req.session.userId, noteId);
        db.prepare('UPDATE uploaded_notes SET is_favorite = 1 WHERE id = ?').run(noteId);
    }
    
    res.json({ success: true, isFavorite: !existing });
});

// Get favorite notes
app.get('/api/favorites', requireAuth, (req, res) => {
    const stmt = db.prepare(`
        SELECT un.*, s.name as subject_name
        FROM favorites f
        JOIN uploaded_notes un ON f.item_id = un.id
        JOIN subjects s ON un.subject_id = s.id
        WHERE f.user_id = ? AND f.item_type = 'uploaded_note'
        ORDER BY f.created_at DESC
    `);
    const favorites = stmt.all(req.session.userId);
    res.json(favorites);
});

// Download note (increment count)
app.get('/api/uploaded-notes/:noteId/download', requireAuth, (req, res) => {
    const { noteId } = req.params;
    
    const stmt = db.prepare('SELECT file_path, original_name FROM uploaded_notes WHERE id = ?');
    const note = stmt.get(noteId);
    
    if (note) {
        // Increment download count
        db.prepare('UPDATE uploaded_notes SET download_count = download_count + 1 WHERE id = ?').run(noteId);
        
        logActivity(req.session.userId, 'download_note', null, null, { noteId });
        
        res.download(note.file_path, note.original_name);
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

// Download multiple notes as zip
app.get('/api/uploaded-notes/download-multiple', requireAuth, async (req, res) => {
    const { ids } = req.query;
    const noteIds = ids.split(',').map(id => parseInt(id));
    
    if (!noteIds || noteIds.length === 0) {
        return res.status(400).json({ error: 'No notes selected' });
    }
    
    const placeholders = noteIds.map(() => '?').join(',');
    const stmt = db.prepare(`SELECT file_path, original_name FROM uploaded_notes WHERE id IN (${placeholders})`);
    const notes = stmt.all(...noteIds);
    
    if (notes.length === 0) {
        return res.status(404).json({ error: 'Notes not found' });
    }
    
    // Create zip file
    const zipFileName = `notes-${Date.now()}.zip`;
    const zipPath = path.join('temp', zipFileName);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    archive.pipe(output);
    
    notes.forEach(note => {
        archive.file(note.file_path, { name: note.original_name });
    });
    
    await archive.finalize();
    
    output.on('close', () => {
        res.download(zipPath, 'study-notes.zip', (err) => {
            if (!err) {
                // Clean up temp file after download
                fs.unlink(zipPath, () => {});
            }
        });
    });
});

// Delete uploaded note
app.delete('/api/uploaded-notes/:noteId', requireAuth, (req, res) => {
    const { noteId } = req.params;
    
    // Check ownership
    const checkStmt = db.prepare('SELECT user_id, file_path FROM uploaded_notes WHERE id = ?');
    const note = checkStmt.get(noteId);
    
    if (!note) {
        return res.status(404).json({ error: 'Note not found' });
    }
    
    if (note.user_id !== req.session.userId) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    // Delete physical file
    try {
        fs.unlinkSync(note.file_path);
    } catch (err) {
        console.error('File deletion error:', err);
    }
    
    // Delete from database
    db.prepare('DELETE FROM uploaded_notes WHERE id = ?').run(noteId);
    db.prepare('DELETE FROM favorites WHERE item_type = "uploaded_note" AND item_id = ?').run(noteId);
    
    logActivity(req.session.userId, 'delete_upload', null, null, { noteId });
    
    res.json({ success: true });
});

// Rename file
app.post('/api/uploaded-notes/:noteId/rename', requireAuth, (req, res) => {
    const { noteId } = req.params;
    const { newName } = req.body;
    
    // Check ownership
    const checkStmt = db.prepare('SELECT user_id FROM uploaded_notes WHERE id = ?');
    const note = checkStmt.get(noteId);
    
    if (!note || note.user_id !== req.session.userId) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    db.prepare('UPDATE uploaded_notes SET original_name = ? WHERE id = ?').run(newName, noteId);
    
    res.json({ success: true });
});

// Get messages with pagination (infinite scroll)
app.get('/api/messages/:type/:id?', requireAuth, (req, res) => {
    const { type, id } = req.params;
    const { before, limit = 50 } = req.query;
    
    if (type === 'global') {
        let query = `
            SELECT m.*, u.username as sender_name, u.profile_pic as sender_pic
            FROM messages m
            JOIN users u ON m.sender_id = u.id
            WHERE m.receiver_id IS NULL AND m.is_deleted = 0
        `;
        const params = [];
        
        if (before) {
            query += ' AND m.id < ?';
            params.push(before);
        }
        
        query += ' ORDER BY m.id DESC LIMIT ?';
        params.push(parseInt(limit));
        
        const stmt = db.prepare(query);
        const messages = stmt.all(...params).reverse();
        res.json(messages);
        
    } else if (type === 'private' && id) {
        let query = `
            SELECT m.*, u1.username as sender_name, u1.profile_pic as sender_pic,
                   u2.username as receiver_name, u2.profile_pic as receiver_pic
            FROM messages m
            JOIN users u1 ON m.sender_id = u1.id
            JOIN users u2 ON m.receiver_id = u2.id
            WHERE ((m.sender_id = ? AND m.receiver_id = ?)
               OR (m.sender_id = ? AND m.receiver_id = ?))
               AND m.is_deleted = 0
        `;
        const params = [req.session.userId, id, id, req.session.userId];
        
        if (before) {
            query += ' AND m.id < ?';
            params.push(before);
        }
        
        query += ' ORDER BY m.id DESC LIMIT ?';
        params.push(parseInt(limit));
        
        const stmt = db.prepare(query);
        const messages = stmt.all(...params).reverse();
        
        // Mark messages as read
        const unreadIds = messages
            .filter(m => m.receiver_id === req.session.userId && !m.is_read)
            .map(m => m.id);
        
        if (unreadIds.length > 0) {
            const placeholders = unreadIds.map(() => '?').join(',');
            db.prepare(`UPDATE messages SET is_read = 1, read_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`)
                .run(...unreadIds);
        }
        
        res.json(messages);
    } else {
        res.status(400).json({ error: 'Invalid request' });
    }
});

// Get unread message count
app.get('/api/messages/unread-count', requireAuth, (req, res) => {
    const stmt = db.prepare(`
        SELECT COUNT(*) as count FROM messages
        WHERE receiver_id = ? AND is_read = 0 AND is_deleted = 0
    `);
    const result = stmt.get(req.session.userId);
    res.json({ count: result.count });
});

// Get all users (for private chat)
app.get('/api/users', requireAuth, (req, res) => {
    const stmt = db.prepare(`
        SELECT id, username, profile_pic, online_status, last_seen, bio
        FROM users WHERE id != ? ORDER BY online_status DESC, username
    `);
    const users = stmt.all(req.session.userId);
    
    // Add unread counts for each user
    users.forEach(user => {
        const countStmt = db.prepare(`
            SELECT COUNT(*) as count FROM messages
            WHERE sender_id = ? AND receiver_id = ? AND is_read = 0
        `);
        const result = countStmt.get(user.id, req.session.userId);
        user.unreadCount = result.count;
    });
    
    res.json(users);
});

// Get typing status
app.get('/api/typing/:userId', requireAuth, (req, res) => {
    const stmt = db.prepare('SELECT is_typing, updated_at FROM typing_status WHERE user_id = ? AND chat_partner_id = ?');
    const status = stmt.get(req.params.userId, req.session.userId);
    res.json({ isTyping: status ? Boolean(status.is_typing) : false });
});

// Get user activity feed
app.get('/api/activity', requireAuth, (req, res) => {
    const stmt = db.prepare(`
        SELECT a.*, u.username, u.profile_pic,
               s.name as subject_name, c.name as chapter_name
        FROM user_activity a
        JOIN users u ON a.user_id = u.id
        LEFT JOIN subjects s ON a.subject_id = s.id
        LEFT JOIN chapters c ON a.chapter_id = c.id
        ORDER BY a.timestamp DESC
        LIMIT 50
    `);
    const activity = stmt.all();
    res.json(activity);
});

// Get user's recent subjects
app.get('/api/recent-subjects', requireAuth, (req, res) => {
    const stmt = db.prepare(`
        SELECT DISTINCT s.id, s.name, MAX(a.timestamp) as last_viewed
        FROM user_activity a
        JOIN subjects s ON a.subject_id = s.id
        WHERE a.user_id = ? AND a.activity_type = 'view_note'
        GROUP BY s.id
        ORDER BY last_viewed DESC
        LIMIT 5
    `);
    const subjects = stmt.all(req.session.userId);
    res.json(subjects);
});

// Search everything
app.get('/api/search', requireAuth, (req, res) => {
    const query = req.query.q;
    if (!query || query.length < 2) {
        return res.json([]);
    }
    
    const searchTerm = `%${query}%`;
    const results = [];
    
    // Search in uploaded notes
    const notesStmt = db.prepare(`
        SELECT 'note' as type, un.id, un.original_name as title, un.description,
               s.name as subject, un.chapter_name as chapter,
               u.username as uploaded_by, un.uploaded_at as date,
               un.tags
        FROM uploaded_notes un
        JOIN users u ON un.user_id = u.id
        JOIN subjects s ON un.subject_id = s.id
        WHERE un.original_name LIKE ? OR un.description LIKE ? OR un.tags LIKE ?
        ORDER BY un.uploaded_at DESC
        LIMIT 20
    `);
    const notes = notesStmt.all(searchTerm, searchTerm, searchTerm);
    results.push(...notes);
    
    // Search in collaborative notes
    const collabStmt = db.prepare(`
        SELECT 'collab' as type, n.id, s.name as subject, c.name as chapter,
               n.content, n.last_updated
        FROM notes n
        JOIN subjects s ON n.subject_id = s.id
        JOIN chapters c ON n.chapter_id = c.id
        WHERE n.content LIKE ?
        ORDER BY n.last_updated DESC
        LIMIT 10
    `);
    const collab = collabStmt.all(searchTerm);
    results.push(...collab);
    
    res.json(results);
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File too large' });
        }
        return res.status(400).json({ error: err.message });
    }
    
    res.status(500).json({ error: 'Something went wrong!' });
});

// 404 handler
app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
        res.status(404).json({ error: 'API endpoint not found' });
    } else {
        res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
    }
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});