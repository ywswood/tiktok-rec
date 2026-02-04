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
    PROJECT_NAME: 'TikTokRec',

    // Folders
    VOICE_FOLDER_ID: PROPS.VOICE_FOLDER_ID,
    TXT_FOLDER_ID: PROPS.TXT_FOLDER_ID,
    VIDEO_FOLDER_ID: PROPS.VIDEO_FOLDER_ID, // 予約（将来用または手動アップロード用）

    // Spreadsheet
    SPREADSHEET_ID: PROPS.SPREADSHEET_ID,
    SHEET_NAME: 'txt',

    GEMINI_MODEL: 'gemini-2.5-flash'
};

// ==========================================
// 2. Web API Entry Point (doPost)
// ==========================================
function doPost(e) {
    try {
        const data = JSON.parse(e.postData.contents);
        const action = data.action;

        if (action === 'upload_chunk') {
            return handleUploadChunk(data);
        } else if (action === 'generate_script') {
            return handleGenerateScript(data);
        } else {
            throw new Error('Invalid action: ' + action);
        }

    } catch (error) {
        return ContentService.createTextOutput(JSON.stringify({
            status: 'error',
            message: error.toString(),
            stack: error.stack
        })).setMimeType(ContentService.MimeType.JSON);
    }
}

/**
 * チャンクのアップロード処理
 */
function handleUploadChunk(data) {
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
            caption: videoPlan.caption,
            hashtags: videoPlan.hashtags.join(', '),
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
以下の要素を生成してください：
1. hook: 冒頭0.5秒で目を引く、強いキャッチコピー。
2. scenes: 動画を5〜7枚のカードに分割。各カードは10文字以内。リズムを重視。シーンごとの秒数(duration)も推定。
3. caption: 投稿本文（共感を得る文章）。
4. hashtags: 5つのトレンドタグ。
5. design: 動画のデザインテーマ。以下のバリエーションから、音声の内容や雰囲気に最も合うものを1つずつ選択（またはランダムに選択）してください。

【デザインバリエーション】
- animation: ["pop", "slide", "zoom", "fade", "typewriter"]
- effect: ["neon", "glitch", "retro", "particle", "simple"]
- font: ["impact", "mincho", "handwriting", "cyber", "scatter"]
- theme: { background: "css gradient", textColor: "hex", accentColor: "hex" }

必ずJSON形式で出力してください。Markdownのコードブロックは不要です。
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

    sheet.appendRow([
        data.id,              // ID
        data.created,         // 作成日時
        '',                   // 投稿予定日
        '',                   // 投稿日
        '下書き',             // ステータス
        data.caption,         // 本文
        data.hashtags,        // ハッシュタグ
        data.videoFileId,     // 動画ファイルID
        data.textFileId,      // 音声テキストID
        ''                    // 備考
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
