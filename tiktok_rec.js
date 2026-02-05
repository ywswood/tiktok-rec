/**
 * ========================================================================
 * 🎬 TikTokRec Backend (backend.js)
 * 認証: api-bank (Gemini 3 Flash)
 * 機能: 音声 -> 書き起こし -> コンテンツ生成 (JSON) -> Drive/Sheet保存
 * ========================================================================
 */

// ==========================================
// 1. Initial Setup
// ==========================================
const PROPS = PropertiesService.getScriptProperties().getProperties();
const CONFIG = {
    BANK_URL: PROPS.BANK_URL,
    BANK_PASS: PROPS.BANK_PASS,
    PROJECT_NAME: PROPS.PROJECT_NAME || 'tiktok-rec',

    // Folders
    VOICE_FOLDER_ID: PROPS.VOICE_FOLDER_ID,
    TXT_FOLDER_ID: PROPS.TXT_FOLDER_ID,
    VIDEO_FOLDER_ID: PROPS.VIDEO_FOLDER_ID,
    BGM_FOLDER_ID: '1BXb_30bw7BOd9ujqdteinIua8Lu3AOLb',
    BGM_ENERGY_ID: '1YgMO7vUiYirDdTVb2v4eIksyN6A9KDEx',
    BGM_CHILL_ID: '1EI_4DLWI8jrBREt0c-d5eD4tkl8dtxY5',

    // Spreadsheet
    SPREADSHEET_ID: PROPS.SPREADSHEET_ID,
    SHEET_NAME: 'txt',
};

// ==========================================
// 2. Web API Entry Point (doPost)
// ==========================================
function doPost(e) {
    try {
        if (!e || !e.postData || !e.postData.contents) {
            throw new Error('Missing postData. Please call this as a POST request from the app.');
        }

        const data = JSON.parse(e.postData.contents);
        const action = data.action;
        console.log('Queuing action:', action);

        // すべてのアクションを非同期タスクとしてキューイング
        return queueTask(data);

    } catch (error) {
        console.error('doPost error:', error.toString());
        return ContentService.createTextOutput(JSON.stringify({
            status: 'error',
            message: error.toString()
        })).setMimeType(ContentService.MimeType.JSON);
    }
}

/**
 * チャンクのアップロード処理
 */
function handleUploadChunk(data) {
    if (!data) {
        throw new Error('handleUploadChunk: data is undefined. If running from editor, please select doPost instead and use test parameters.');
    }
    const audioData = data.audioData;
    const fileName = data.fileName;

    if (!audioData || !fileName) throw new Error('Missing audioData or fileName');

    const decoded = Utilities.base64Decode(audioData);
    const blob = Utilities.newBlob(decoded, 'audio/webm', fileName);

    const voiceFolder = DriveApp.getFolderById(CONFIG.VOICE_FOLDER_ID);
    voiceFolder.createFile(blob);

    return ContentService.createTextOutput(JSON.stringify({
        status: 'success',
        message: 'Chunk uploaded: ' + fileName
    })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * 台本生成処理 (全チャンクを集約)
 */
function handleGenerateScript(data) {
    const sessionId = data.sessionId;
    if (!sessionId) throw new Error('Missing sessionId');

    const now = new Date();
    const formattedDate = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');

    // 1. 全てのチャンクを取得して結合
    const voiceFolder = DriveApp.getFolderById(CONFIG.VOICE_FOLDER_ID);
    const files = voiceFolder.getFiles();
    let chunks = [];

    while (files.hasNext()) {
        const file = files.next();
        const name = file.getName();
        // マッチ: sessionId_chunkXX.webm
        if (name.startsWith(sessionId) && name.endsWith('.webm')) {
            chunks.push(file);
        }
    }

    if (chunks.length === 0) throw new Error('No chunks found for session: ' + sessionId);

    // チャンク順にソート
    chunks.sort((a, b) => a.getName().localeCompare(b.getName()));

    // 2. 各チャンクを文字起こしして結合
    let fullTranscript = '';
    let errors = [];

    chunks.forEach(file => {
        const result = transcribeAudio(file.getBlob());
        if (result.text) {
            fullTranscript += result.text + '\n';
        } else {
            errors.push(`${file.getName()}: ${result.error || 'Unknown error'}`);
            if (result.details) Logger.log(JSON.stringify(result.details));
        }
    });

    if (!fullTranscript.trim()) {
        throw new Error('Transcription failed for all chunks. Errors: ' + errors.join(', '));
    }

    // 3. 動画プラン生成
    const videoPlan = generateVideoPlan(fullTranscript);
    if (!videoPlan) throw new Error('Content generation failed');

    // 3.5. TTS生成 & BGM選定 (New logic)
    let audioFileId = '';
    try {
        // AIが要約・翻訳した各シーンの英語テキストを抽出して結合
        const ttsText = videoPlan.scenes.map(s => s.text_en || s.text || '').join(' ');
        const voiceBlob = generateTTS(ttsText);
        if (voiceBlob) {
            const voiceFolder = DriveApp.getFolderById(CONFIG.VOICE_FOLDER_ID);
            const audioFile = voiceFolder.createFile(voiceBlob).setName(`${sessionId}_voice.wav`);
            audioFileId = audioFile.getId();
        }
    } catch (e) {
        Logger.log('TTS Generation Error: ' + e);
    }

    let bgmFileId = '';
    try {
        bgmFileId = selectBGM(videoPlan.bgm);
    } catch (e) {
        Logger.log('BGM Selection Error: ' + e);
    }

    // 4. テキストファイル保存 (結合された内容)
    let textFileId = '';
    try {
        const txtFolder = DriveApp.getFolderById(CONFIG.TXT_FOLDER_ID);
        const textContent = `【ID】${sessionId}\n【日時】${formattedDate}\n\n【書き起こし】\n${fullTranscript}\n\n【生成構成】\n${JSON.stringify(videoPlan, null, 2)}`;
        const textFile = txtFolder.createFile(`${sessionId}.txt`, textContent, MimeType.PLAIN_TEXT);
        textFileId = textFile.getId();
    } catch (e) {
        Logger.log('Text Save Error: ' + e);
    }

    // 5. スプレッドシート保存
    try {
        saveToSpreadsheet({
            id: sessionId,
            created: formattedDate,
            caption_ja: videoPlan.caption_ja,
            caption_en: videoPlan.caption_en,
            hashtags: videoPlan.hashtags.join(', '),
            bgm: videoPlan.bgm,
            bgmFileId: bgmFileId,    // 追加
            audioFileId: audioFileId, // 追加
            textFileId: textFileId,
            videoFileId: ''
        });
    } catch (e) {
        Logger.log('Sheet Save Error: ' + e);
    }

    // 6. 使用済みチャンクを削除 (またはアーカイブ)
    chunks.forEach(file => file.setTrashed(true));

    return ContentService.createTextOutput(JSON.stringify({
        status: 'success',
        data: videoPlan,
        meta: {
            id: sessionId,
            textId: textFileId
        }
    })).setMimeType(ContentService.MimeType.JSON);
}

// ==========================================
// 3. API Bank Transcription (Align with sns_rec)
// ==========================================
function transcribeAudio(blob) {
    let previousModel = null;
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 2000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            // 1. APIキー取得
            let bankUrl = `${CONFIG.BANK_URL}?pass=${CONFIG.BANK_PASS}&project=${CONFIG.PROJECT_NAME}&type=stt`;
            if (previousModel) {
                bankUrl += `&error_503=true&previous_model=${encodeURIComponent(previousModel)}`;
            }

            const bankRes = UrlFetchApp.fetch(bankUrl, { muteHttpExceptions: true });
            const bankData = JSON.parse(bankRes.getContentText());

            if (bankData.status !== 'success') {
                throw new Error(bankData.message);
            }

            const { api_key, model_name } = bankData;

            // 2. Gemini呼び出し
            const base64Audio = Utilities.base64Encode(blob.getBytes());
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model_name}:generateContent?key=${api_key}`;

            const payload = {
                contents: [{
                    parts: [
                        { text: "音声を書き起こしてください。フィラー（えー、あー）は取り除いてください。" },
                        { inline_data: { mime_type: blob.getContentType(), data: base64Audio } }
                    ]
                }]
            };

            const geminiRes = UrlFetchApp.fetch(apiUrl, {
                method: 'post',
                contentType: 'application/json',
                payload: JSON.stringify(payload),
                muteHttpExceptions: true
            });

            const statusCode = geminiRes.getResponseCode();

            if (statusCode === 503) {
                previousModel = model_name;
                Utilities.sleep(RETRY_DELAY);
                continue;
            }

            const geminiData = JSON.parse(geminiRes.getContentText());
            if (geminiData.error) {
                reportError(api_key);
                throw new Error(JSON.stringify(geminiData.error));
            }

            return { text: geminiData.candidates[0].content.parts[0].text };

        } catch (error) {
            if (attempt === MAX_RETRIES) return { error: error.toString() };
            Utilities.sleep(RETRY_DELAY);
        }
    }
}

/**
 * 動画プランを生成する (Gemini LLM)
 */
function generateVideoPlan(transcript) {
    const SYSTEM_PROMPT = `
以下の要素を英語ベース（キャプションは日英併記）で生成してください：
1. hook: 英語。冒頭0.5秒で目を引く、強いキャッチコピー。
2. scenes: 音声を「英語」に翻訳・要約し、15〜30秒に収まるように5〜8つのシーンに分割。
   各シーンは以下の3要素を含める：
   - text_en: 英語（メイン字幕）。15文字以内。
   - text_ja: 日本語（サブ字幕）。最短要約。
   - duration: そのシーンの継続秒数（合計15〜30秒）。
3. caption_ja: 日本語の投稿本文（共感を得る文章）。
4. caption_en: 英語の投稿本文。
5. hashtags: 5つのトレンドタグ（英語）。
6. bgm: 動画の内容に最も合うBGMジャンルを1つ選択 ["chill", "energy"]。
7. design: 動画のデザインテーマ（バリエーションから選択）。
   - animation: ["pop", "slide", "zoom", "fade", "typewriter"]
   - effect: ["neon", "glitch", "retro", "particle", "simple"]
   - font: ["impact", "mincho", "handwriting", "cyber", "scatter"]
   - theme: { background: "css gradient", textColor: "hex", accentColor: "hex" }

【ルール】
- 無駄な言葉は徹底的に削除し、TikTokで好まれるリズム感のある現代的な表現にすること。
- 必ずJSON形式で出力してください。Markdownのコードブロックは不要です。
`;

    let previousModel = null;
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 2000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            // 1. APIキー取得
            let bankUrl = `${CONFIG.BANK_URL}?pass=${CONFIG.BANK_PASS}&project=${CONFIG.PROJECT_NAME}`;
            if (previousModel) {
                bankUrl += `&error_503=true&previous_model=${encodeURIComponent(previousModel)}`;
            }

            const bankRes = UrlFetchApp.fetch(bankUrl, { muteHttpExceptions: true });
            const bankData = JSON.parse(bankRes.getContentText());

            if (bankData.status !== 'success') {
                throw new Error(bankData.message);
            }

            const { api_key, model_name } = bankData;

            // 2. Gemini呼び出し
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model_name}:generateContent?key=${api_key}`;
            const payload = {
                contents: [{ parts: [{ text: SYSTEM_PROMPT + "\n\n【音声内容】\n" + transcript }] }],
                generationConfig: { response_mime_type: "application/json" }
            };

            const geminiRes = UrlFetchApp.fetch(apiUrl, {
                method: 'post',
                contentType: 'application/json',
                payload: JSON.stringify(payload),
                muteHttpExceptions: true
            });

            const statusCode = geminiRes.getResponseCode();

            if (statusCode === 503) {
                previousModel = model_name;
                Utilities.sleep(RETRY_DELAY);
                continue;
            }

            const geminiData = JSON.parse(geminiRes.getContentText());
            if (geminiData.error) {
                reportError(api_key);
                throw new Error(JSON.stringify(geminiData.error));
            }

            const rawText = geminiData.candidates[0].content.parts[0].text;
            const cleanText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(cleanText);

        } catch (error) {
            if (attempt === MAX_RETRIES) {
                Logger.log('Content Generation Error: ' + error);
                return null;
            }
            Utilities.sleep(RETRY_DELAY);
        }
    }
}

// ==========================================
// 4. Spreadsheet Logic
// ==========================================
function saveToSpreadsheet(data) {
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
    if (!sheet) throw new Error(`Sheet '${CONFIG.SHEET_NAME}' not found`);

    // カラム構成: ID, 作成日時, 投稿予定日, 投稿日, ステータス, 本文（和）, 本文（英）, ハッシュタグ, BGM, 音声テキストID, 動画ファイルID, 備考
    // 拡張カラム考慮: [BGM_FILE_ID, AUDIO_FILE_ID] を追加
    sheet.appendRow([
        data.id,              // ID
        data.created,         // 作成日時
        '',                   // 投稿予定日
        '',                   // 投稿日
        '下書き',             // ステータス
        data.caption_ja,      // 本文（和）
        data.caption_en,      // 本文（英）
        data.hashtags,        // ハッシュタグ
        data.videoFileId,     // 動画ファイルID (Col I)
        data.textFileId,      // 音声テキストID (Col J)
        data.bgm,             // BGM (Col K)
        '',                   // 備考 (Col L)
        data.bgmFileId,       // BGMファイルID (Col M)
        data.audioFileId      // 音声ファイルID (Col N)
    ]);
}

// ==========================================
// 5. API Bank Utilities
// ==========================================
function reportError(key) {
    try {
        UrlFetchApp.fetch(CONFIG.BANK_URL, {
            method: 'post',
            contentType: 'application/json',
            payload: JSON.stringify({ pass: CONFIG.BANK_PASS, api_key: key })
        });
    } catch (e) { }
}

/**
 * 音声合成 (TTS) を実行する (Gemini Multimodal TTS)
 */
function generateTTS(text) {
    let previousModel = null;
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 1000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            // 1. APIキー取得 (type=tts)
            let bankUrl = `${CONFIG.BANK_URL}?pass=${CONFIG.BANK_PASS}&project=${CONFIG.PROJECT_NAME}&type=tts`;
            if (previousModel) {
                bankUrl += `&error_503=true&previous_model=${encodeURIComponent(previousModel)}`;
            }

            const bankRes = UrlFetchApp.fetch(bankUrl, { muteHttpExceptions: true });
            const bankData = JSON.parse(bankRes.getContentText());

            if (bankData.status !== 'success') throw new Error(bankData.message);

            const { api_key, model_name } = bankData;

            // 2. Gemini呼び出し (Multimodal TTS)
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model_name}:generateContent?key=${api_key}`;
            const payload = {
                contents: [{ parts: [{ text: text }] }],
                generationConfig: {
                    responseModalities: ["AUDIO"],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: {
                                voiceName: "Puck" // TikTokで人気の高い男性ボイス
                            }
                        }
                    }
                }
            };

            const res = UrlFetchApp.fetch(apiUrl, {
                method: 'post',
                contentType: 'application/json',
                payload: JSON.stringify(payload),
                muteHttpExceptions: true
            });

            if (res.getResponseCode() === 503) {
                previousModel = model_name;
                Utilities.sleep(RETRY_DELAY);
                continue;
            }

            const resData = JSON.parse(res.getContentText());
            if (resData.error) {
                reportError(api_key);
                throw new Error(JSON.stringify(resData.error));
            }

            // 音声バイナリの抽出
            const base64Audio = resData.candidates[0].content.parts[0].inlineData.data;
            const audioBytes = Utilities.base64Decode(base64Audio);

            return Utilities.newBlob(audioBytes, 'audio/wav', 'voice.wav');

        } catch (error) {
            if (attempt === MAX_RETRIES) throw error;
            Utilities.sleep(RETRY_DELAY);
        }
    }
}

/**
 * 指定されたジャンルのBGMをDriveから選択
 */
function selectBGM(genre) {
    const genreUpper = (genre || 'CHILL').toUpperCase();
    const folderId = CONFIG[`BGM_${genreUpper}_ID`] || CONFIG.BGM_FOLDER_ID;

    try {
        const folder = DriveApp.getFolderById(folderId);
        const files = folder.getFiles();
        let list = [];
        while (files.hasNext()) {
            list.push(files.next());
        }
        if (list.length === 0) return '';
        const selected = list[Math.floor(Math.random() * list.length)];
        return selected.getId();
    } catch (e) {
        Logger.log('BGM Select Error: ' + e);
        return '';
    }
}

/**
 * タスクをキューに入れ、トリガーを設定する
 */
function queueTask(params) {
    const props = PropertiesService.getScriptProperties();
    const taskId = 'TASK_' + Utilities.getUuid();

    // タスク内容を保存
    props.setProperty(taskId, JSON.stringify(params));

    // キューリストに追加
    let queue = JSON.parse(props.getProperty('TASK_QUEUE') || '[]');
    queue.push(taskId);
    props.setProperty('TASK_QUEUE', JSON.stringify(queue));

    // トリガー作成（既存の実行待ちがあれば削除して再作成）
    deleteExistingTriggers('processTaskQueue');
    ScriptApp.newTrigger('processTaskQueue')
        .timeBased()
        .after(500) // 0.5秒後に開始
        .create();

    return ContentService.createTextOutput(JSON.stringify({
        status: 'success',
        message: 'Task queued',
        taskId: taskId
    })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * トリガーによって実行されるタスク処理（メインワーカー）
 */
function processTaskQueue() {
    const props = PropertiesService.getScriptProperties();
    let queue = JSON.parse(props.getProperty('TASK_QUEUE') || '[]');

    if (queue.length === 0) return;

    // 1つの実行で最大3つのタスクを処理（効率化のため。ただしタイムアウトに注意）
    for (let i = 0; i < 3 && queue.length > 0; i++) {
        const taskId = queue.shift();
        props.setProperty('TASK_QUEUE', JSON.stringify(queue));

        const paramsStr = props.getProperty(taskId);
        if (!paramsStr) continue;

        const params = JSON.parse(paramsStr);
        try {
            console.log(`Processing ${params.action} (${taskId})...`);

            if (params.action === 'upload_chunk') {
                handleUploadChunk(params);
            } else if (params.action === 'generate_script') {
                handleGenerateScript(params);
            }

            console.log(`Completed ${params.action}`);
        } catch (e) {
            console.error(`Task ${taskId} failed: ${e.toString()}`);
        } finally {
            props.deleteProperty(taskId);
        }
    }

    // まだキューが残っていれば次のトリガーを設定（1秒後）
    if (queue.length > 0) {
        ScriptApp.newTrigger('processTaskQueue')
            .timeBased()
            .after(1000)
            .create();
    }
}

/**
 * 特定の関数名を持つトリガーをすべて削除
 */
function deleteExistingTriggers(functionName) {
    const triggers = ScriptApp.getProjectTriggers();
    triggers.forEach(t => {
        if (t.getHandlerFunction() === functionName) {
            ScriptApp.deleteTrigger(t);
        }
    });
}
