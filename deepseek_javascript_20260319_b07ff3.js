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
const SQLiteStore = require('connect-sqlite3')(session);

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production' 
      ? process.env.RENDER_EXTERNAL_URL 
      : 'http://localhost:3000',
    credentials: true
  }
});

// Production configurations
const isProduction = process.env.NODE_ENV === 'production';
const dataDir = isProduction ? '/opt/render/project/src/data' : '.';

// Create necessary directories
['uploads', 'profile-pics', 'temp', path.join(dataDir, 'database')].forEach(dir => {
  const dirPath = isProduction ? path.join(dataDir, dir) : dir;
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Serve uploaded files
app.use('/uploads', express.static(isProduction ? path.join(dataDir, 'uploads') : 'uploads'));
app.use('/profile-pics', express.static(isProduction ? path.join(dataDir, 'profile-pics') : 'profile-pics'));

// Session configuration for production
const sessionConfig = {
  secret: process.env.SESSION_SECRET || 'studyhub-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    httpOnly: true,
    secure: isProduction, // true in production with HTTPS
    sameSite: 'lax'
  }
};

// Use SQLite store for sessions in production
if (isProduction) {
  sessionConfig.store = new SQLiteStore({
    dir: path.join(dataDir, 'database'),
    db: 'sessions.db'
  });
}

app.use(session(sessionConfig));

// Database setup
const dbPath = isProduction 
  ? path.join(dataDir, 'database', 'database.db')
  : 'database.db';

const db = new Database(dbPath);

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Create all tables (same as before, keep all table creation code)
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

    -- Uploaded notes files table
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
    if (subjectId) {
        chapters.forEach((chapter, index) => {
            insertChapter.run(subjectId, chapter, index + 1);
        });
    }
});

// Configure multer for file uploads with production paths
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (file.fieldname === 'profilePic') {
            const dir = isProduction ? path.join(dataDir, 'profile-pics') : 'profile-pics';
            cb(null, dir);
        } else {
            const dir = isProduction ? path.join(dataDir, 'uploads') : 'uploads';
            cb(null, dir);
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
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
    fileFilter: fileFilter
});

// [REST OF YOUR SERVER.JS CODE - All the routes and socket handlers remain exactly the same as before]
// Copy all the route handlers, socket.io code, and helper functions from the previous server.js
// Make sure to update file paths to use the production directories when needed

// For example, when handling file paths in routes:
app.get('/api/uploaded-notes/:noteId/download', requireAuth, (req, res) => {
    const { noteId } = req.params;
    
    const stmt = db.prepare('SELECT file_path, original_name FROM uploaded_notes WHERE id = ?');
    const note = stmt.get(noteId);
    
    if (note) {
        // Increment download count
        db.prepare('UPDATE uploaded_notes SET download_count = download_count + 1 WHERE id = ?').run(noteId);
        
        logActivity(req.session.userId, 'download_note', null, null, { noteId });
        
        // Use the stored file path directly
        res.download(note.file_path, note.original_name);
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT} in ${isProduction ? 'production' : 'development'} mode`);
});