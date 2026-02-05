// Basic config
const CONFIG = {
    // Production GAS Web App URL
    API_URL: 'https://script.google.com/macros/s/AKfycbwtKHqOYcbBRqe-fEqUqiag_oFjSlnkD8K5If-pIq5UjE386qQf47Rkdfe1LTmQdjhH9Q/exec',
    MIME_TYPE: 'audio/webm;codecs=opus',
    CHUNK_DURATION: 5 * 60 * 1000, // 5分ごとにアップロード
    FILE_EXTENSION: '.webm'
};

/* =========================================
   STATE MANAGEMENT
   ========================================= */
let state = {
    isRecording: false,
    mediaRecorder: null,
    audioStream: null,
    audioChunks: [],
    uploadedChunks: 0,
    currentChunk: 0,
    sessionId: null,
    generatedData: null,
    currentSceneIndex: 0,
    animationInterval: null,
    timerInterval: null,
    chunkInterval: null,
    currentAnimationClass: ''
};

/* =========================================
   DOM ELEMENTS
   ========================================= */
const els = {
    appHeader: document.getElementById('appHeader'),
    recButton: document.getElementById('recButton'),
    recText: document.getElementById('recText'),
    status: document.getElementById('status')
};

/* =========================================
   EVENT LISTENERS
   ========================================= */
els.recButton.addEventListener('click', toggleRecording);

/* =========================================
   RECORDING LOGIC
   ========================================= */
async function toggleRecording() {
    if (!state.isRecording) {
        // START
        try {
            state.audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            state.mediaRecorder = new MediaRecorder(state.audioStream, { mimeType: CONFIG.MIME_TYPE });

            // Session ID Generation
            const now = new Date();
            state.sessionId = formatDate(now) + '_' +
                String(now.getHours()).padStart(2, '0') +
                String(now.getMinutes()).padStart(2, '0') +
                String(now.getSeconds()).padStart(2, '0');

            state.currentChunk = 0;
            state.uploadedChunks = 0;
            state.audioChunks = [];

            state.mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) state.audioChunks.push(e.data);
            };

            state.mediaRecorder.start();
            state.isRecording = true;

            // UI Update
            els.recButton.classList.add('recording');
            els.recText.innerText = 'STOP';
            els.status.innerText = '録音中... (自動保存中)';

            // Start Chunking
            scheduleNextChunk();

        } catch (err) {
            alert('マイクのアクセスに失敗しました: ' + err.message);
        }
    } else {
        // STOP
        state.isRecording = false;

        // UI Update
        els.recButton.classList.remove('recording');
        els.recText.innerText = 'WAIT...';
        els.status.innerText = '最後のデータを処理中...';

        if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
            state.mediaRecorder.stop();
            state.mediaRecorder.onstop = async () => {
                state.currentChunk++;
                await processChunk(true); // Final chunk
                cleanup();
            };
        } else {
            cleanup();
        }
    }
}

function scheduleNextChunk() {
    state.chunkInterval = setTimeout(async () => {
        if (state.isRecording && state.mediaRecorder && state.mediaRecorder.state === 'recording') {
            state.mediaRecorder.stop();
            state.mediaRecorder.onstop = async () => {
                state.currentChunk++;
                const currentChunks = [...state.audioChunks];
                state.audioChunks = [];

                // 次の録音を即座に開始
                if (state.isRecording) {
                    state.mediaRecorder.start();
                    scheduleNextChunk();
                }

                // 非同期でアップロード
                await processChunk(false, currentChunks);
            };
        }
    }, CONFIG.CHUNK_DURATION);
}

async function processChunk(isFinal = false, chunksOverride = null) {
    const chunks = chunksOverride || state.audioChunks;
    if (chunks.length === 0) {
        if (isFinal) handleFinalGeneration();
        return;
    }

    const blob = new Blob(chunks, { type: CONFIG.MIME_TYPE });
    const chunkNumber = String(state.currentChunk).padStart(2, '0');
    const fileName = `${state.sessionId}_chunk${chunkNumber}${CONFIG.FILE_EXTENSION}`;

    console.log(`Uploading chunk: ${fileName}`);

    try {
        await uploadToGAS(blob, fileName);
        state.uploadedChunks++;
        if (isFinal) {
            handleFinalGeneration();
        }
    } catch (err) {
        console.error('Upload failed', err);
        if (isFinal) handleFinalGeneration();
    }
}

async function uploadToGAS(blob, fileName) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(blob);
        reader.onloadend = async () => {
            try {
                const base64Data = reader.result.split(',')[1];
                await fetch(CONFIG.API_URL, {
                    method: 'POST',
                    mode: 'no-cors',
                    body: JSON.stringify({
                        action: 'upload_chunk',
                        fileName: fileName,
                        audioData: base64Data
                    })
                });
                resolve();
            } catch (e) { reject(e); }
        };
        reader.onerror = (e) => reject(e);
    });
}

async function handleFinalGeneration() {
    els.status.innerText = '台本を生成中...';
    try {
        const response = await fetch(CONFIG.API_URL, {
            method: 'POST',
            body: JSON.stringify({
                action: 'generate_script',
                sessionId: state.sessionId
            })
        });
        const result = await response.json();
        if (result.status === 'success') {
            els.status.innerText = '送信完了。サーバーで生成を開始しました。';
            setTimeout(() => {
                resetApp();
                els.status.innerText = '次の録音を開始できます';
            }, 3000);
        } else {
            throw new Error(result.message);
        }
    } catch (err) {
        els.status.innerText = 'エラー: ' + err.message;
        els.recText.innerText = 'RETRY';
    }
}

function cleanup() {
    if (state.chunkInterval) clearTimeout(state.chunkInterval);
    if (state.audioStream) {
        state.audioStream.getTracks().forEach(t => t.stop());
        state.audioStream = null;
    }
}

function formatDate(date) {
    const year = String(date.getFullYear()).slice(-2);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
}

function resetApp() {
    state.isRecording = false;
    state.audioChunks = [];
    els.appHeader.classList.remove('hidden');
    els.recButton.style.display = 'flex';
    els.status.innerText = 'タップして録音を開始';
    els.recText.innerText = 'RECORDING';
}
