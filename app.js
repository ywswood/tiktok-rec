// Basic config
const CONFIG = {
    // Production GAS Web App URL
    API_URL: 'https://script.google.com/macros/s/AKfycbwtKHqOYcbBRqe-fEqUqiag_oFjSlnkD8K5If-pIq5UjE386qQf47Rkdfe1LTmQdjhH9Q/exec',
    MIME_TYPE: 'audio/webm;codecs=opus',
    CHUNK_DURATION: 30 * 1000, // 30秒ごとにアップロード（TikTok用なので短めに設定）
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
    videoContainer: document.getElementById('videoContainer'),
    videoScreen: document.getElementById('videoScreen'),
    videoBg: document.getElementById('videoBg'),
    sceneText: document.getElementById('sceneText'),
    status: document.getElementById('status'),
    resultControls: document.getElementById('resultControls'),
    resetBtn: document.getElementById('resetBtn'),
    copyBtn: document.getElementById('copyBtn'),
    resHook: document.getElementById('resHook'),
    resTags: document.getElementById('resTags'),
    resCaption: document.getElementById('resCaption')
};

/* =========================================
   EVENT LISTENERS
   ========================================= */
els.recButton.addEventListener('click', toggleRecording);
els.resetBtn.addEventListener('click', resetApp);
els.copyBtn.addEventListener('click', copyToClipboard);

/* =========================================
   RECORDING LOGIC
   ========================================= */
async function toggleRecording() {
    if (state.generatedData) return;

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
            handleSuccess(result.data);
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

/* =========================================
   RENDERING LOGIC
   ========================================= */
function handleSuccess(data) {
    state.generatedData = data;

    // 1. Switch UI Mode
    els.appHeader.classList.add('hidden');
    els.recButton.parentNode.style.display = 'none'; // Hide main-area's recButton part safely
    // Actually, we need to hide just the button, show the video container.
    // The video container is INSIDE main-area.
    els.recButton.style.display = 'none';

    els.videoContainer.classList.remove('hidden');
    els.videoContainer.style.display = 'flex';

    els.resultControls.classList.remove('hidden');
    els.status.innerText = '再生中';

    // 2. Fill Data
    els.resHook.innerText = data.hook || '';
    els.resTags.innerText = (data.hashtags || []).join(' ');
    els.resCaption.innerText = data.caption || '';

    // 3. Apply Design & Play
    applyTheme(data.design);
    playVideoSequence();
}

function applyTheme(design) {
    if (!design) return;

    // Background
    if (design.theme && design.theme.background) {
        els.videoBg.style.background = design.theme.background;
    }

    // Text Style
    els.sceneText.style.color = (design.theme && design.theme.textColor) ? design.theme.textColor : '#ffffff';

    // Classes
    els.sceneText.className = 'scene-text'; // Reset
    if (design.font) els.sceneText.classList.add(`font-${design.font}`);
    if (design.effect) els.sceneText.classList.add(`effect-${design.effect}`);

    state.currentAnimationClass = `anim-${design.animation || 'pop'}`;
}

function playVideoSequence() {
    if (!state.generatedData || !state.generatedData.scenes) return;

    const scenes = state.generatedData.scenes;
    let idx = 0;

    clearTimeout(state.animationInterval);

    function showNextScene() {
        if (idx >= scenes.length) {
            els.status.innerText = '再生終了';
            // Loop or stop? Let's stop for now.
            return;
        }

        const scene = scenes[idx];

        // Set Text
        els.sceneText.innerText = scene.text;
        els.sceneText.setAttribute('data-text', scene.text);

        // Animate
        els.sceneText.classList.remove(state.currentAnimationClass);
        void els.sceneText.offsetWidth; // Reflow
        els.sceneText.classList.add(state.currentAnimationClass);

        // Default duration calculation if missing
        const dur = (scene.duration || 2) * 1000;

        idx++;
        state.animationInterval = setTimeout(showNextScene, dur);
    }

    showNextScene();
}

function resetApp() {
    // Reset State
    state.generatedData = null;
    state.isRecording = false;
    state.audioChunks = [];
    clearTimeout(state.animationInterval);

    // Reset UI
    els.videoContainer.classList.add('hidden');
    els.videoContainer.style.display = 'none';

    els.appHeader.classList.remove('hidden');

    els.recButton.style.display = 'flex'; // Restore button
    els.recButton.parentNode.style.display = 'flex'; // Restore wrapper area if hidden

    els.resultControls.classList.add('hidden');

    els.status.innerText = 'タップして録音を開始';
    els.recText.innerText = 'RECORDING';
}

function copyToClipboard() {
    if (!state.generatedData) return;
    const data = state.generatedData;
    const text = `${data.caption}\n\n${(data.hashtags || []).join(' ')}`;
    navigator.clipboard.writeText(text).then(() => {
        alert('キャプションとタグをコピーしました！');
    });
}
