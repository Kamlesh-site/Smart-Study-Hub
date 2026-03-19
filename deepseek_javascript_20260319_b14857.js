// Global variables
let socket = null;
let currentUser = null;
let currentSubject = null;
let currentChapter = null;
let currentSubjectId = null;
let currentChapterId = null;
let saveTimeout = null;
let selectedPrivateUser = null;
let darkMode = localStorage.getItem('darkMode') === 'true';
let unreadCount = 0;
let typingTimeout = null;
let filterTimeout = null;
let currentChatPartner = null;
let messagesEndRef = null;
let isLoadingMessages = false;
let hasMoreMessages = true;
let lastMessageId = null;

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
    // Load theme
    if (darkMode) {
        document.documentElement.setAttribute('data-theme', 'dark');
    }
    
    // Check authentication
    await checkAuth();
    
    // Initialize socket connection
    initializeSocket();
    
    // Setup event listeners
    setupEventListeners();
    
    // Load unread message count
    loadUnreadCount();
    
    // Start session activity monitor
    startActivityMonitor();
    
    // Load page-specific data
    const path = window.location.pathname;
    if (path === '/dashboard') {
        loadDashboard();
    } else if (path === '/notes') {
        loadSubjects();
        loadUploadSubjects();
        loadRecentUploadedNotes();
    } else if (path === '/chat') {
        loadGlobalMessages();
        loadUsersList();
        switchChat('global');
    } else if (path === '/profile') {
        loadProfile();
    }
});

// Activity monitor for auto-logout
function startActivityMonitor() {
    let activityTimer;
    
    const resetTimer = () => {
        clearTimeout(activityTimer);
        activityTimer = setTimeout(() => {
            // Check if user is still active
            fetch('/api/user').catch(() => {
                // If request fails, redirect to login
                window.location.href = '/';
            });
        }, 25 * 60 * 1000); // 25 minutes
    };
    
    // Reset timer on user activity
    ['click', 'keypress', 'scroll', 'mousemove'].forEach(event => {
        document.addEventListener(event, resetTimer);
    });
    
    resetTimer();
}

// Check authentication
async function checkAuth() {
    try {
        const response = await fetch('/api/user');
        if (response.ok) {
            currentUser = await response.json();
            
            // Update UI with user info
            const usernameSpan = document.getElementById('username');
            if (usernameSpan) usernameSpan.textContent = currentUser.username;
            
            const userInfo = document.getElementById('userInfo');
            if (userInfo) userInfo.textContent = currentUser.username;
            
            const userAvatar = document.getElementById('userAvatar');
            if (userAvatar) {
                userAvatar.src = currentUser.profile_pic ? 
                    `/profile-pics/${currentUser.profile_pic}` : 
                    '/profile-pics/default.png';
            }
            
            // Emit login event to socket
            if (socket) {
                socket.emit('user-login', currentUser.id);
            }
        } else if (window.location.pathname !== '/') {
            // Redirect to home if not authenticated and not on landing page
            window.location.href = '/';
        }
    } catch (error) {
        console.error('Auth check failed:', error);
        if (window.location.pathname !== '/') {
            window.location.href = '/';
        }
    }
}

// Initialize Socket.IO
function initializeSocket() {
    socket = io();
    
    socket.on('connect', () => {
        console.log('Connected to server');
        if (currentUser) {
            socket.emit('user-login', currentUser.id);
        }
        if (window.location.pathname === '/chat') {
            socket.emit('join-chat', 'global');
        }
    });
    
    socket.on('new-message', (message) => {
        displayNewMessage(message);
        updateUnreadCount();
    });
    
    socket.on('message-edited', (data) => {
        updateEditedMessage(data);
    });
    
    socket.on('message-deleted', (data) => {
        removeDeletedMessage(data.messageId);
    });
    
    socket.on('typing-indicator', (data) => {
        showTypingIndicator(data.userId, data.isTyping);
    });
    
    socket.on('note-changed', (data) => {
        if (currentSubjectId === data.subjectId && currentChapterId === data.chapterId) {
            const notesArea = document.getElementById('notesContent');
            if (notesArea && document.activeElement !== notesArea) {
                notesArea.value = data.content;
                showSaveStatus('Updated by ' + data.username);
            }
        }
    });
    
    socket.on('online-users', (users) => {
        updateOnlineUsers(users);
    });
    
    socket.on('disconnect', () => {
        console.log('Disconnected from server');
        showToast('Connection lost. Reconnecting...', 'warning');
    });
    
    socket.on('reconnect', () => {
        console.log('Reconnected to server');
        showToast('Connected', 'success');
        if (currentUser) {
            socket.emit('user-login', currentUser.id);
        }
    });
}

// Setup event listeners
function setupEventListeners() {
    // Menu toggle for mobile
    const menuToggle = document.getElementById('menuToggle');
    if (menuToggle) {
        menuToggle.addEventListener('click', () => {
            document.getElementById('sidebar').classList.add('active');
        });
    }
    
    // Close sidebar
    const closeSidebar = document.querySelector('.close-sidebar');
    if (closeSidebar) {
        closeSidebar.addEventListener('click', () => {
            document.getElementById('sidebar').classList.remove('active');
        });
    }
    
    // Dark mode toggle
    const darkModeToggle = document.getElementById('darkModeToggle');
    if (darkModeToggle) {
        darkModeToggle.textContent = darkMode ? '☀️ Light Mode' : '🌙 Dark Mode';
        darkModeToggle.addEventListener('click', toggleDarkMode);
    }
    
    // Search input
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('input', debounce(handleSearch, 500));
    }
    
    // Auto-save notes
    const notesContent = document.getElementById('notesContent');
    if (notesContent) {
        notesContent.addEventListener('input', () => {
            clearTimeout(saveTimeout);
            showSaveStatus('Saving...');
            saveTimeout = setTimeout(autoSaveNotes, 1000);
        });
    }
    
    // Upload form
    const uploadForm = document.getElementById('uploadForm');
    if (uploadForm) {
        uploadForm.addEventListener('submit', handleFileUpload);
    }
    
    // Drag and drop
    const dropzone = document.getElementById('dropzone');
    if (dropzone) {
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropzone.addEventListener(eventName, preventDefaults, false);
        });
        
        ['dragenter', 'dragover'].forEach(eventName => {
            dropzone.addEventListener(eventName, highlight, false);
        });
        
        ['dragleave', 'drop'].forEach(eventName => {
            dropzone.addEventListener(eventName, unhighlight, false);
        });
        
        dropzone.addEventListener('drop', handleDrop, false);
    }
    
    // File input change
    const fileInput = document.getElementById('fileInput');
    if (fileInput) {
        fileInput.addEventListener('change', handleFileSelect);
    }
    
    // Global message input with typing indicator
    const globalInput = document.getElementById('globalMessageInput');
    if (globalInput) {
        globalInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendGlobalMessage();
        });
        globalInput.addEventListener('input', handleTyping);
    }
    
    // Private message input with typing indicator
    const privateInput = document.getElementById('privateMessageInput');
    if (privateInput) {
        privateInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendPrivateMessage();
        });
        privateInput.addEventListener('input', () => handleTyping(true));
    }
    
    // Infinite scroll in chat
    const globalMessages = document.getElementById('globalMessages');
    if (globalMessages) {
        globalMessages.addEventListener('scroll', handleChatScroll);
    }
    
    const privateMessages = document.getElementById('privateMessages');
    if (privateMessages) {
        privateMessages.addEventListener('scroll', handleChatScroll);
    }
    
    // Click outside to close modals
    window.addEventListener('click', (e) => {
        const modal = document.getElementById('uploadModal');
        if (e.target === modal) {
            hideUploadModal();
        }
    });
}

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

function highlight() {
    document.getElementById('dropzone').classList.add('highlight');
}

function unhighlight() {
    document.getElementById('dropzone').classList.remove('highlight');
}

function handleDrop(e) {
    const dt = e.dataTransfer;
    const files = dt.files;
    handleFiles(files);
}

function handleFileSelect(e) {
    const files = e.target.files;
    handleFiles(files);
}

function handleFiles(files) {
    const previewArea = document.getElementById('filePreview');
    previewArea.innerHTML = '';
    
    Array.from(files).forEach(file => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const preview = document.createElement('div');
            preview.className = 'file-preview-item';
            
            if (file.type.startsWith('image/')) {
                preview.innerHTML = `
                    <img src="${e.target.result}" alt="${file.name}">
                    <span class="file-name">${file.name}</span>
                    <span class="file-size">${formatFileSize(file.size)}</span>
                `;
            } else {
                preview.innerHTML = `
                    <div class="file-icon">📄</div>
                    <span class="file-name">${file.name}</span>
                    <span class="file-size">${formatFileSize(file.size)}</span>
                `;
            }
            
            previewArea.appendChild(preview);
        };
        reader.readAsDataURL(file);
    });
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Toggle dark mode
function toggleDarkMode() {
    darkMode = !darkMode;
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
    localStorage.setItem('darkMode', darkMode);
    
    const toggle = document.getElementById('darkModeToggle');
    if (toggle) {
        toggle.textContent = darkMode ? '☀️ Light Mode' : '🌙 Dark Mode';
    }
}

// Debounce function
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Show toast notification
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.remove();
    }, 3000);
}

// Show save status in notes editor
function showSaveStatus(status) {
    const statusEl = document.getElementById('saveStatus');
    if (statusEl) {
        statusEl.textContent = status;
    }
}

// Auto-save notes
async function autoSaveNotes() {
    if (!currentSubjectId || !currentChapterId) return;
    
    const content = document.getElementById('notesContent').value;
    
    try {
        const response = await fetch(`/api/notes/${currentSubjectId}/${currentChapterId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
        });
        
        if (response.ok) {
            showSaveStatus('Saved');
            
            // Emit note update to other users
            if (socket) {
                socket.emit('note-update', {
                    subjectId: currentSubjectId,
                    chapterId: currentChapterId,
                    content,
                    username: currentUser.username
                });
            }
        }
    } catch (error) {
        console.error('Auto-save failed:', error);
        showSaveStatus('Save failed');
    }
}

// Save notes manually
function saveNotes() {
    clearTimeout(saveTimeout);
    autoSaveNotes();
}

// Switch notes tabs
function switchNotesTab(tab) {
    document.querySelectorAll('.notes-tabs .tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.notes-view').forEach(view => view.classList.remove('active'));
    
    document.querySelector(`[onclick="switchNotesTab('${tab}')"]`).classList.add('active');
    document.getElementById(`${tab}View`).classList.add('active');
    
    if (tab === 'uploaded') {
        filterUploadedNotes();
    } else if (tab === 'favorites') {
        loadFavorites();
    }
}

// Upload modal functions
function showUploadModal() {
    document.getElementById('uploadModal').style.display = 'block';
    loadUploadSubjects();
}

function hideUploadModal() {
    document.getElementById('uploadModal').style.display = 'none';
    document.getElementById('uploadForm').reset();
    document.getElementById('filePreview').innerHTML = '';
}

// Load subjects for upload form
async function loadUploadSubjects() {
    try {
        const response = await fetch('/api/subjects');
        const subjects = await response.json();
        
        const subjectSelect = document.getElementById('uploadSubject');
        const optionalSelect = document.getElementById('uploadOptionalSubject');
        
        subjectSelect.innerHTML = '<option value="">Select Subject</option>';
        optionalSelect.innerHTML = '<option value="">None</option>';
        
        subjects.forEach(s => {
            subjectSelect.innerHTML += `<option value="${s.id}">${s.name}</option>`;
            optionalSelect.innerHTML += `<option value="${s.id}">${s.name}</option>`;
        });
    } catch (error) {
        console.error('Failed to load subjects:', error);
    }
}

// Handle file upload
async function handleFileUpload(e) {
    e.preventDefault();
    
    const formData = new FormData(e.target);
    const files = document.getElementById('fileInput').files;
    
    if (files.length === 0) {
        showToast('Please select files to upload', 'error');
        return;
    }
    
    const subjectId = document.getElementById('uploadSubject').value;
    const chapterName = document.getElementById('uploadChapter').value;
    
    if (!subjectId || !chapterName) {
        showToast('Subject and chapter name are required', 'error');
        return;
    }
    
    // Validate file sizes
    for (let file of files) {
        if (file.size > 50 * 1024 * 1024) {
            showToast(`${file.name} exceeds 50MB limit`, 'error');
            return;
        }
    }
    
    const uploadBtn = document.getElementById('uploadBtn');
    uploadBtn.disabled = true;
    uploadBtn.textContent = 'Uploading...';
    
    try {
        const response = await fetch('/api/upload-notes', {
            method: 'POST',
            body: formData
        });
        
        if (response.ok) {
            showToast(`${files.length} file(s) uploaded successfully`, 'success');
            hideUploadModal();
            filterUploadedNotes(); // Refresh the list
        } else {
            const data = await response.json();
            showToast(data.error || 'Upload failed', 'error');
        }
    } catch (error) {
        console.error('Upload failed:', error);
        showToast('Upload failed', 'error');
    } finally {
        uploadBtn.disabled = false;
        uploadBtn.textContent = 'Upload Files';
    }
}

// Filter uploaded notes
async function filterUploadedNotes() {
    const subjectId = document.getElementById('filterSubject').value;
    const chapter = document.getElementById('filterChapter').value;
    const date = document.getElementById('filterDate').value;
    const tag = document.getElementById('filterTag').value;
    const sortBy = document.getElementById('sortBy').value;
    
    let url = '/api/uploaded-notes?';
    if (subjectId) url += `&subjectId=${subjectId}`;
    if (chapter) url += `&chapter=${encodeURIComponent(chapter)}`;
    if (date) url += `&date=${date}`;
    if (tag) url += `&tag=${encodeURIComponent(tag)}`;
    if (sortBy) url += `&sortBy=${sortBy}`;
    
    try {
        const response = await fetch(url);
        const notes = await response.json();
        
        displayUploadedNotes(notes);
    } catch (error) {
        console.error('Failed to load notes:', error);
    }
}

function debounceFilter() {
    clearTimeout(filterTimeout);
    filterTimeout = setTimeout(filterUploadedNotes, 500);
}

// Display uploaded notes
function displayUploadedNotes(notes) {
    const container = document.getElementById('uploadedNotesGrid');
    
    if (notes.length === 0) {
        container.innerHTML = '<p class="no-results">No notes found</p>';
        return;
    }
    
    container.innerHTML = notes.map(note => createNoteCard(note)).join('');
}

// Create note card HTML
function createNoteCard(note) {
    const isImage = note.file_type === 'jpg' || note.file_type === 'jpeg' || note.file_type === 'png';
    const isOwner = note.user_id === currentUser?.id;
    
    return `
        <div class="file-card" data-id="${note.id}">
            <div class="file-header">
                <span class="file-type">${note.file_type.toUpperCase()}</span>
                ${note.is_favorite ? '<span class="favorite-star">⭐</span>' : ''}
            </div>
            <div class="file-preview" onclick="${isImage ? `previewImage('${note.file_path}')` : ''}">
                ${isImage ? 
                    `<img src="/${note.file_path}" alt="${note.original_name}" class="file-thumbnail">` : 
                    '<div class="file-icon-large">📄</div>'
                }
            </div>
            <div class="file-details">
                <h4 title="${note.original_name}">${truncateString(note.original_name, 30)}</h4>
                <p class="file-subject">${note.subject_name} - ${note.chapter_name}</p>
                <p class="file-meta">
                    Uploaded by ${note.username}<br>
                    ${new Date(note.uploaded_at).toLocaleDateString()}
                </p>
                ${note.tags ? `<p class="file-tags">${note.tags}</p>` : ''}
            </div>
            <div class="file-actions">
                <button onclick="toggleFavorite(${note.id})" class="btn-icon ${note.is_favorite ? 'favorite-active' : ''}">
                    ⭐
                </button>
                <a href="/api/uploaded-notes/${note.id}/download" class="btn-icon">📥</a>
                ${isImage ? `<button onclick="previewImage('/${note.file_path}', '${note.original_name}')" class="btn-icon">👁️</button>` : ''}
                <a href="/${note.file_path}" target="_blank" class="btn-icon">📂</a>
                ${isOwner ? `
                    <button onclick="deleteUploadedNote(${note.id})" class="btn-icon delete">🗑️</button>
                ` : ''}
            </div>
            <div class="file-stats">
                <span>📥 ${note.download_count || 0} downloads</span>
            </div>
        </div>
    `;
}

// Load favorites
async function loadFavorites() {
    try {
        const response = await fetch('/api/favorites');
        const favorites = await response.json();
        
        const container = document.getElementById('favoritesGrid');
        
        if (favorites.length === 0) {
            container.innerHTML = '<p class="no-results">No favorites yet</p>';
            return;
        }
        
        container.innerHTML = favorites.map(note => createNoteCard(note)).join('');
    } catch (error) {
        console.error('Failed to load favorites:', error);
    }
}

// Toggle favorite
async function toggleFavorite(noteId) {
    try {
        const response = await fetch(`/api/uploaded-notes/${noteId}/favorite`, {
            method: 'POST'
        });
        
        if (response.ok) {
            const data = await response.json();
            showToast(data.isFavorite ? 'Added to favorites' : 'Removed from favorites', 'success');
            
            // Refresh current view
            if (document.getElementById('favoritesView').classList.contains('active')) {
                loadFavorites();
            } else {
                filterUploadedNotes();
            }
        }
    } catch (error) {
        console.error('Failed to toggle favorite:', error);
    }
}

// Delete uploaded note
async function deleteUploadedNote(noteId) {
    if (!confirm('Delete this note?')) return;
    
    try {
        const response = await fetch(`/api/uploaded-notes/${noteId}`, {
            method: 'DELETE'
        });
        
        if (response.ok) {
            showToast('Note deleted', 'success');
            
            // Remove from UI
            document.querySelector(`.file-card[data-id="${noteId}"]`).remove();
        }
    } catch (error) {
        console.error('Delete failed:', error);
        showToast('Delete failed', 'error');
    }
}

// Preview image
function previewImage(path, title) {
    document.getElementById('previewImage').src = path;
    document.getElementById('previewTitle').textContent = title || 'Image Preview';
    document.getElementById('downloadPreviewBtn').href = path;
    document.getElementById('imagePreviewModal').style.display = 'block';
}

function hideImagePreview() {
    document.getElementById('imagePreviewModal').style.display = 'none';
}

// Load recent uploaded notes
async function loadRecentUploadedNotes() {
    try {
        const response = await fetch('/api/uploaded-notes/recent');
        const notes = await response.json();
        
        // Could display in a sidebar or section
        console.log('Recent notes:', notes);
    } catch (error) {
        console.error('Failed to load recent notes:', error);
    }
}

// Load unread message count
async function loadUnreadCount() {
    try {
        const response = await fetch('/api/messages/unread-count');
        const data = await response.json();
        
        unreadCount = data.count;
        const badge = document.getElementById('unreadBadge');
        
        if (badge) {
            if (unreadCount > 0) {
                badge.style.display = 'inline';
                badge.textContent = unreadCount > 99 ? '99+' : unreadCount;
            } else {
                badge.style.display = 'none';
            }
        }
    } catch (error) {
        console.error('Failed to load unread count:', error);
    }
}

function updateUnreadCount() {
    unreadCount++;
    const badge = document.getElementById('unreadBadge');
    if (badge) {
        badge.style.display = 'inline';
        badge.textContent = unreadCount > 99 ? '99+' : unreadCount;
    }
}

// Handle typing indicator
function handleTyping(isPrivate = false) {
    if (!currentChatPartner && isPrivate) return;
    
    if (typingTimeout) clearTimeout(typingTimeout);
    
    const receiverId = isPrivate ? currentChatPartner : 'global';
    
    socket.emit('typing', {
        receiverId,
        isTyping: true
    });
    
    typingTimeout = setTimeout(() => {
        socket.emit('typing', {
            receiverId,
            isTyping: false
        });
    }, 1000);
}

function showTypingIndicator(userId, isTyping) {
    // Implementation depends on UI
    console.log(`User ${userId} is ${isTyping ? 'typing' : 'not typing'}`);
}

// Handle chat scroll for infinite loading
function handleChatScroll(e) {
    const element = e.target;
    if (element.scrollTop === 0 && !isLoadingMessages && hasMoreMessages) {
        loadMoreMessages();
    }
}

async function loadMoreMessages() {
    isLoadingMessages = true;
    
    const currentView = document.querySelector('.chat-container.active');
    const isGlobal = currentView.id === 'globalChat';
    
    try {
        let url;
        if (isGlobal) {
            url = `/api/messages/global?before=${lastMessageId}`;
        } else if (selectedPrivateUser) {
            url = `/api/messages/private/${selectedPrivateUser.id}?before=${lastMessageId}`;
        } else {
            return;
        }
        
        const response = await fetch(url);
        const messages = await response.json();
        
        if (messages.length < 50) {
            hasMoreMessages = false;
        }
        
        if (messages.length > 0) {
            lastMessageId = messages[0].id;
            displayOlderMessages(messages, isGlobal);
        }
    } catch (error) {
        console.error('Failed to load more messages:', error);
    } finally {
        isLoadingMessages = false;
    }
}

// Display older messages (for infinite scroll)
function displayOlderMessages(messages, isGlobal) {
    const container = isGlobal ? 
        document.getElementById('globalMessages') : 
        document.getElementById('privateMessages';
    
    const scrollHeight = container.scrollHeight;
    
    messages.forEach(msg => {
        container.insertAdjacentHTML('afterbegin', createMessageHTML(msg, isGlobal ? 'global' : 'private'));
    });
    
    // Maintain scroll position
    container.scrollTop = container.scrollHeight - scrollHeight;
}

// Update edited message in UI
function updateEditedMessage(data) {
    const messageEl = document.querySelector(`.message[data-id="${data.messageId}"] .message-content`);
    if (messageEl) {
        messageEl.innerHTML = escapeHtml(data.newMessage) + ' <span class="edited-indicator">(edited)</span>';
    }
}

// Remove deleted message from UI
function removeDeletedMessage(messageId) {
    const messageEl = document.querySelector(`.message[data-id="${messageId}"]`);
    if (messageEl) {
        messageEl.innerHTML = '<div class="message-content deleted-message">This message was deleted</div>';
    }
}

// Typing indicator functions
function handleTyping(isPrivate = false) {
    if (!currentChatPartner && isPrivate) return;
    
    if (typingTimeout) clearTimeout(typingTimeout);
    
    const receiverId = isPrivate ? currentChatPartner : 'global';
    
    socket.emit('typing', {
        receiverId,
        isTyping: true
    });
    
    typingTimeout = setTimeout(() => {
        socket.emit('typing', {
            receiverId,
            isTyping: false
        });
    }, 1000);
}

function showTypingIndicator(userId, isTyping) {
    if (currentChatPartner === userId) {
        const indicator = document.getElementById('typingIndicator');
        if (indicator) {
            indicator.style.display = isTyping ? 'block' : 'none';
        }
    }
}

// Dashboard functions
async function loadDashboard() {
    try {
        // Load recent subjects
        const subjectsResponse = await fetch('/api/recent-subjects');
        const subjects = await subjectsResponse.json();
        
        const recentSubjects = document.getElementById('recentSubjects');
        if (recentSubjects) {
            if (subjects.length === 0) {
                recentSubjects.innerHTML = '<p class="text-secondary">No recent subjects</p>';
            } else {
                recentSubjects.innerHTML = subjects.map(s => `
                    <div class="subject-item" onclick="navigateToSubject(${s.id})">
                        ${s.name}
                    </div>
                `).join('');
            }
        }
        
        // Load recent uploaded notes
        const notesResponse = await fetch('/api/uploaded-notes/recent');
        const notes = await notesResponse.json();
        
        const recentUploads = document.getElementById('recentUploads');
        if (recentUploads) {
            if (notes.length === 0) {
                recentUploads.innerHTML = '<p class="text-secondary">No recent uploads</p>';
            } else {
                recentUploads.innerHTML = notes.slice(0, 5).map(n => `
                    <div class="upload-item" onclick="viewUploadedNote(${n.id})">
                        <span class="upload-icon">${n.file_type === 'pdf' ? '📄' : '🖼️'}</span>
                        <span class="upload-name">${truncateString(n.original_name, 30)}</span>
                        <span class="upload-meta">${n.subject_name}</span>
                    </div>
                `).join('');
            }
        }
        
        // Load activity
        const activityResponse = await fetch('/api/activity');
        const activity = await activityResponse.json();
        
        const recentActivity = document.getElementById('recentActivity');
        if (recentActivity) {
            if (activity.length === 0) {
                recentActivity.innerHTML = '<p class="text-secondary">No recent activity</p>';
            } else {
                recentActivity.innerHTML = activity.slice(0, 5).map(a => `
                    <div class="activity-item">
                        <img src="/profile-pics/${a.profile_pic || 'default.png'}" class="activity-avatar" onerror="this.src='/profile-pics/default.png'">
                        <div class="activity-content">
                            <span class="activity-text">${getActivityText(a)}</span>
                            <span class="activity-time">${timeAgo(a.timestamp)}</span>
                        </div>
                    </div>
                `).join('');
            }
        }
        
        // Update counts
        document.getElementById('notesCount').textContent = subjects.length || '0';
        document.getElementById('uploadsCount').textContent = notes.length || '0';
        
    } catch (error) {
        console.error('Failed to load dashboard:', error);
    }
}

function getActivityText(activity) {
    switch(activity.activity_type) {
        case 'view_note': return `viewed ${activity.subject_name} - ${activity.chapter_name}`;
        case 'edit_note': return `edited notes for ${activity.subject_name}`;
        case 'upload_notes': return `uploaded notes for ${activity.subject_name}`;
        case 'login': return 'logged in';
        case 'logout': return 'logged out';
        default: return 'was active';
    }
}

function timeAgo(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const seconds = Math.floor((now - date) / 1000);
    
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
    return date.toLocaleDateString();
}

function truncateString(str, length) {
    return str.length > length ? str.substring(0, length) + '...' : str;
}

// Notes functions
async function loadSubjects() {
    try {
        const response = await fetch('/api/subjects');
        const subjects = await response.json();
        
        const subjectsList = document.getElementById('subjectsList');
        if (subjectsList) {
            subjectsList.innerHTML = subjects.map(s => `
                <div class="subject-item" onclick="selectSubject(${s.id}, '${s.name}')">
                    ${s.name}
                </div>
            `).join('');
        }
    } catch (error) {
        console.error('Failed to load subjects:', error);
    }
}

function selectSubject(subjectId, subjectName) {
    currentSubjectId = subjectId;
    currentSubject = subjectName;
    document.getElementById('currentSubjectTitle').textContent = subjectName;
    
    // Show chapter sidebar on mobile
    if (window.innerWidth <= 768) {
        document.querySelector('.subject-sidebar').classList.remove('active');
        document.querySelector('.chapter-sidebar').classList.add('active');
        document.getElementById('mobileBack').style.display = 'block';
    }
    
    loadChapters(subjectId);
}

async function loadChapters(subjectId) {
    try {
        const response = await fetch(`/api/subjects/${subjectId}/chapters`);
        const chapters = await response.json();
        
        const chaptersList = document.getElementById('chaptersList');
        if (chaptersList) {
            chaptersList.innerHTML = chapters.map(ch => `
                <div class="chapter-item" onclick="selectChapter(${ch.id}, '${ch.name}')">
                    ${ch.name}
                </div>
            `).join('');
        }
        
        document.getElementById('chapterSidebar').style.display = 'block';
    } catch (error) {
        console.error('Failed to load chapters:', error);
    }
}

async function selectChapter(chapterId, chapterName) {
    currentChapterId = chapterId;
    currentChapter = chapterName;
    document.getElementById('chapterTitle').textContent = `${currentSubject} - ${chapterName}`;
    
    // Show notes editor on mobile
    if (window.innerWidth <= 768) {
        document.querySelector('.chapter-sidebar').classList.remove('active');
        document.querySelector('.notes-editor').classList.add('active');
        document.getElementById('mobileBack').style.display = 'block';
    }
    
    try {
        const response = await fetch(`/api/notes/${currentSubjectId}/${chapterId}`);
        const note = await response.json();
        
        document.getElementById('notesContent').value = note.content;
        document.getElementById('notesEditor').style.display = 'block';
        
        // Join note room for real-time updates
        if (socket) {
            socket.emit('join-note', { 
                subjectId: currentSubjectId, 
                chapterId: currentChapterId 
            });
        }
        
        // Log activity
        logActivity('view_note', currentSubjectId, chapterId);
        
    } catch (error) {
        console.error('Failed to load note:', error);
    }
}

// Log activity
async function logActivity(type, subjectId, chapterId) {
    try {
        await fetch('/api/log-activity', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, subjectId, chapterId })
        });
    } catch (error) {
        console.error('Failed to log activity:', error);
    }
}

// Navigation
function navigateToSubject(subjectId) {
    window.location.href = `/notes?subject=${subjectId}`;
}

function viewUploadedNote(noteId) {
    window.location.href = `/notes?note=${noteId}`;
}

function goBack() {
    if (window.innerWidth <= 768) {
        if (document.querySelector('.notes-editor.active')) {
            document.querySelector('.notes-editor').classList.remove('active');
            document.querySelector('.chapter-sidebar').classList.add('active');
            document.getElementById('mobileBack').style.display = 'block';
        } else if (document.querySelector('.chapter-sidebar.active')) {
            document.querySelector('.chapter-sidebar').classList.remove('active');
            document.querySelector('.subject-sidebar').classList.add('active');
            document.getElementById('mobileBack').style.display = 'none';
        } else {
            window.location.href = '/dashboard';
        }
    }
}

// Chat functions
async function loadGlobalMessages() {
    try {
        const response = await fetch('/api/messages/global');
        const messages = await response.json();
        
        const container = document.getElementById('globalMessages');
        if (container) {
            container.innerHTML = messages.map(msg => createMessageHTML(msg, 'global')).join('');
            container.scrollTop = container.scrollHeight;
            
            if (messages.length > 0) {
                lastMessageId = messages[0].id;
            }
        }
    } catch (error) {
        console.error('Failed to load messages:', error);
    }
}

async function sendGlobalMessage() {
    const input = document.getElementById('globalMessageInput');
    const message = input.value.trim();
    
    if (!message) return;
    
    // Send typing stopped
    socket.emit('typing', {
        receiverId: 'global',
        isTyping: false
    });
    
    socket.emit('send-message', {
        receiverId: 'global',
        message
    });
    input.value = '';
}

async function loadUsersList() {
    try {
        const response = await fetch('/api/users');
        const users = await response.json();
        
        const usersList = document.getElementById('usersList');
        if (usersList) {
            usersList.innerHTML = users.map(user => `
                <div class="user-item ${user.online_status ? 'online' : 'offline'}" 
                     onclick="selectPrivateUser(${user.id}, '${user.username}')"
                     data-id="${user.id}">
                    <img src="/profile-pics/${user.profile_pic || 'default.png'}" 
                         class="user-avatar" 
                         onerror="this.src='/profile-pics/default.png'">
                    <span class="user-name">${user.username}</span>
                    ${user.unreadCount > 0 ? `<span class="unread-badge">${user.unreadCount}</span>` : ''}
                    <span class="online-status ${user.online_status ? 'online' : 'offline'}"></span>
                </div>
            `).join('');
        }
    } catch (error) {
        console.error('Failed to load users:', error);
    }
}

async function loadPrivateMessages(userId) {
    try {
        const response = await fetch(`/api/messages/private/${userId}`);
        const messages = await response.json();
        
        const container = document.getElementById('privateMessages');
        if (container) {
            container.innerHTML = messages.map(msg => createMessageHTML(msg, 'private')).join('');
            container.scrollTop = container.scrollHeight;
            
            if (messages.length > 0) {
                lastMessageId = messages[0].id;
            }
            
            // Mark messages as read
            const unreadIds = messages
                .filter(m => m.receiver_id === currentUser.id && !m.is_read)
                .map(m => m.id);
            
            if (unreadIds.length > 0) {
                socket.emit('mark-read', { messageIds: unreadIds });
            }
        }
    } catch (error) {
        console.error('Failed to load private messages:', error);
    }
}

function selectPrivateUser(userId, username) {
    currentChatPartner = userId;
    selectedPrivateUser = { id: userId, username };
    
    // Update UI
    document.querySelectorAll('.user-item').forEach(item => item.classList.remove('selected'));
    event.target.closest('.user-item').classList.add('selected');
    
    // Update chat header
    document.getElementById('privateChatHeader').textContent = `Chat with ${username}`;
    
    // Enable input
    document.getElementById('privateMessageInput').disabled = false;
    document.querySelector('#privateChat .btn-primary').disabled = false;
    
    // Load messages
    loadPrivateMessages(userId);
}

function sendPrivateMessage() {
    if (!selectedPrivateUser) return;
    
    const input = document.getElementById('privateMessageInput');
    const message = input.value.trim();
    
    if (!message) return;
    
    // Send typing stopped
    socket.emit('typing', {
        receiverId: selectedPrivateUser.id,
        isTyping: false
    });
    
    socket.emit('send-message', {
        receiverId: selectedPrivateUser.id,
        message
    });
    input.value = '';
}

function displayNewMessage(message) {
    if (message.type === 'global') {
        const container = document.getElementById('globalMessages');
        if (container) {
            container.insertAdjacentHTML('beforeend', createMessageHTML(message, 'global'));
            container.scrollTop = container.scrollHeight;
            
            // Show notification
            if (window.location.pathname !== '/chat' || 
                !document.getElementById('globalChat').classList.contains('active')) {
                showToast(`New message from ${message.sender_name}`, 'info');
                updateUnreadCount();
            }
        }
    } else if (message.type === 'private') {
        if (selectedPrivateUser && 
            (message.sender_id === selectedPrivateUser.id || message.receiver_id === selectedPrivateUser.id)) {
            const container = document.getElementById('privateMessages');
            if (container) {
                container.insertAdjacentHTML('beforeend', createMessageHTML(message, 'private'));
                container.scrollTop = container.scrollHeight;
                
                // Mark as read if it's for current user
                if (message.receiver_id === currentUser.id) {
                    socket.emit('mark-read', { messageIds: [message.id] });
                }
            }
        }
        
        // Show notification
        if (window.location.pathname !== '/chat' || 
            !document.getElementById('privateChat').classList.contains('active')) {
            showToast(`Private message from ${message.sender_name}`, 'info');
            updateUnreadCount();
        }
    }
}

function createMessageHTML(message, type) {
    const isOwnMessage = message.sender_id === currentUser?.id;
    const senderName = type === 'global' ? message.sender_name : 
                      (isOwnMessage ? 'You' : message.sender_name);
    const time = new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    return `
        <div class="message ${isOwnMessage ? 'own-message' : ''}" data-id="${message.id}">
            <div class="message-avatar">
                <img src="/profile-pics/${message.sender_pic || 'default.png'}" 
                     onerror="this.src='/profile-pics/default.png'">
            </div>
            <div class="message-content-wrapper">
                <div class="message-header">
                    <span class="sender">${senderName}</span>
                    <span class="time">${time}</span>
                </div>
                <div class="message-content ${message.is_deleted ? 'deleted' : ''}">
                    ${escapeHtml(message.message)}
                    ${message.is_edited ? '<span class="edited-indicator"> (edited)</span>' : ''}
                </div>
                ${!isOwnMessage && message.is_read ? '<span class="read-indicator">✓✓</span>' : ''}
            </div>
        </div>
    `;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function switchChat(type) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.chat-container').forEach(container => container.classList.remove('active'));
    
    if (type === 'global') {
        document.querySelector('[onclick="switchChat(\'global\')"]').classList.add('active');
        document.getElementById('globalChat').classList.add('active');
        
        // Hide unread badge for global chat
        document.getElementById('unreadBadge').style.display = 'none';
    } else {
        document.querySelector('[onclick="switchChat(\'private\')"]').classList.add('active');
        document.getElementById('privateChat').classList.add('active');
    }
}

function updateOnlineUsers(users) {
    // Update online count on dashboard
    const onlineCount = document.getElementById('onlineCount');
    if (onlineCount) {
        onlineCount.textContent = users.length;
    }
    
    // Update users list in chat
    const onlineIds = new Set(users.map(u => u.id));
    
    document.querySelectorAll('.user-item').forEach(item => {
        const userId = parseInt(item.dataset.id);
        const statusDot = item.querySelector('.online-status');
        
        if (onlineIds.has(userId)) {
            item.classList.add('online');
            item.classList.remove('offline');
            if (statusDot) statusDot.className = 'online-status online';
        } else {
            item.classList.add('offline');
            item.classList.remove('online');
            if (statusDot) statusDot.className = 'online-status offline';
        }
    });
}

// Search function
async function handleSearch(e) {
    const query = e.target.value.trim();
    
    if (query.length < 2) return;
    
    try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        const results = await response.json();
        
        displaySearchResults(results);
    } catch (error) {
        console.error('Search failed:', error);
    }
}

function displaySearchResults(results) {
    // Implementation for search results dropdown
    console.log('Search results:', results);
}

// Profile functions
async function loadProfile() {
    try {
        const response = await fetch('/api/user');
        const user = await response.json();
        
        document.getElementById('profileUsername').textContent = user.username;
        document.getElementById('profileEmail').value = user.email || '';
        document.getElementById('profileBio').value = user.bio || '';
        document.getElementById('profileAvatar').src = user.profile_pic ? 
            `/profile-pics/${user.profile_pic}` : '/profile-pics/default.png';
        document.getElementById('joinDate').textContent = new Date(user.created_at).toLocaleDateString();
        
    } catch (error) {
        console.error('Failed to load profile:', error);
    }
}

async function updateProfile() {
    const formData = new FormData();
    const bio = document.getElementById('profileBio').value;
    const profilePic = document.getElementById('profilePicInput').files[0];
    
    formData.append('bio', bio);
    if (profilePic) {
        formData.append('profilePic', profilePic);
    }
    
    try {
        const response = await fetch('/api/user/profile', {
            method: 'POST',
            body: formData
        });
        
        if (response.ok) {
            showToast('Profile updated successfully', 'success');
            setTimeout(() => location.reload(), 1500);
        }
    } catch (error) {
        console.error('Failed to update profile:', error);
        showToast('Update failed', 'error');
    }
}

async function changePassword() {
    const currentPassword = document.getElementById('currentPassword').value;
    const newPassword = document.getElementById('newPassword').value;
    const confirmPassword = document.getElementById('confirmPassword').value;
    
    if (newPassword !== confirmPassword) {
        showToast('Passwords do not match', 'error');
        return;
    }
    
    if (newPassword.length < 6) {
        showToast('Password must be at least 6 characters', 'error');
        return;
    }
    
    try {
        const response = await fetch('/api/user/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPassword, newPassword })
        });
        
        if (response.ok) {
            showToast('Password changed successfully', 'success');
            document.getElementById('passwordForm').reset();
        } else {
            const data = await response.json();
            showToast(data.error, 'error');
        }
    } catch (error) {
        console.error('Password change failed:', error);
        showToast('Password change failed', 'error');
    }
}

// Logout
async function logout() {
    try {
        await fetch('/api/logout', { method: 'POST' });
        window.location.href = '/';
    } catch (error) {
        console.error('Logout failed:', error);
    }
}

// Handle URL params
const urlParams = new URLSearchParams(window.location.search);
const subjectParam = urlParams.get('subject');
if (subjectParam && window.location.pathname === '/notes') {
    selectSubject(parseInt(subjectParam), '');
}

// Initialize emoji picker (if you want to add emoji support)
function initEmojiPicker() {
    // This would integrate a library like emoji-picker-element
    // For now, just a simple implementation
    const emojiButton = document.getElementById('emojiButton');
    if (emojiButton) {
        emojiButton.addEventListener('click', () => {
            // Show emoji picker
        });
    }
}