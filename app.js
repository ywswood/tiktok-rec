// Basic config
const CONFIG = {
    // Production GAS Web App URL
    API_URL: 'https://script.google.com/macros/s/AKfycbwtKHqOYcbBRqe-fEqUqiag_oFjSlnkD8K5If-pIq5UjE386qQf47Rkdfe1LTmQdjhH9Q/exec',
    MIME_TYPE: 'audio/webm;codecs=opus'
};

/* =========================================
   STATE MANAGEMENT
   ========================================= */
let state = {
    isRecording: false,
    mediaRecorder: null,
    audioChunks: [],
    generatedData: null,
    currentSceneIndex: 0,
    animationInterval: null,
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
    // If result is showing, button logic might change, but we hide it via UI. 
    // Safety check:
    if (state.generatedData) return;

    if (!state.isRecording) {
        // START
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            state.mediaRecorder = new MediaRecorder(stream, { mimeType: CONFIG.MIME_TYPE });
            state.audioChunks = [];

            state.mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) state.audioChunks.push(e.data);
            };

            state.mediaRecorder.onstop = processAudio;

            state.mediaRecorder.start();
            state.isRecording = true;

            // UI Update
            els.recButton.classList.add('recording');
            els.recText.innerText = 'STOP';
            els.status.innerText = '録音中... タップして停止＆生成';

        } catch (err) {
            alert('マイクのアクセスに失敗しました: ' + err.message);
        }
    } else {
        // STOP
        state.mediaRecorder.stop();
        state.isRecording = false;

        // UI Update
        els.recButton.classList.remove('recording');
        els.recText.innerText = 'WAIT...';
        els.status.innerText = 'AIが動画を生成中... (30〜60秒かかります)';
        // Here you could add a spinner animation to the button ring if desired
    }
}

/* =========================================
   PROCESSING LOGIC
   ========================================= */
async function processAudio() {
    const blob = new Blob(state.audioChunks, { type: CONFIG.MIME_TYPE });

    // Convert Blob to Base64
    const reader = new FileReader();
    reader.readAsDataURL(blob);
    reader.onloadend = async () => {
        const base64data = reader.result.split(',')[1];

        try {
            if (CONFIG.API_URL === 'YOUR_GAS_WEB_APP_URL_HERE') {
                throw new Error('GASのURLが設定されていません。backend.jsをデプロイしてください。');
            }

            const response = await fetch(CONFIG.API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    audioData: base64data,
                    mimeType: CONFIG.MIME_TYPE
                })
            });

            const result = await response.json();

            if (result.status === 'success') {
                handleSuccess(result.data);
            } else {
                throw new Error(result.message || 'Unknown Error');
            }

        } catch (err) {
            console.error(err);
            els.status.innerText = 'エラー: ' + err.message;
            els.recText.innerText = 'RETRY';
        }
    };
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
