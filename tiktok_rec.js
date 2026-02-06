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
    ARCH_FOLDER_ID: PROPS.ARCH_FOLDER_ID, // 追加 (biz-rec準拠)
    VIDEO_FOLDER_ID: PROPS.VIDEO_FOLDER_ID,
    TTS_FOLDER_ID: PROPS.TTS_FOLDER_ID,
    BGM_FOLDER_ID: '1BXb_30bw7BOd9ujqdteinIua8Lu3AOLb',
    BGM_ENERGY_ID: '1YgMO7vUiYirDdTVb2v4eIksyN6A9KDEx',
    BGM_CHILL_ID: '1EI_4DLWI8jrBREt0c-d5eD4tkl8dtxY5',

    // Spreadsheet
    SPREADSHEET_ID: PROPS.SPREADSHEET_ID,
    SHEET_NAME: 'txt',

    // Transcription settings (merged from biz-rec)
    MAX_RETRIES: 3,
    RETRY_DELAY: 2000,
    MIN_TEXT_LENGTH: 10
};

// ==========================================
// 2. Web API Entry Point (doPost)
// ==========================================
function doPost(e) {
    try {
        if (!e || !e.postData || !e.postData.contents) {
            throw new Error('Missing postData.');
        }

        const data = JSON.parse(e.postData.contents);
        const action = data.action;
        console.log('Action execution:', action);

        // 即時実行方式に変更 (スクリプトプロパティの蓄積を避けるため)
        if (action === 'upload_chunk') {
            return handleUploadChunk(data);
        } else if (action === 'generate_script') {
            return handleGenerateScript(data);
        } else {
            throw new Error('Unknown action: ' + action);
        }

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

    // 1. 既存のバックグラウンド処理済みテキストを検索 (sessionIdをキーに)
    let fullTranscript = '';
    const txtFolder = DriveApp.getFolderById(CONFIG.TXT_FOLDER_ID);
    const txtFiles = txtFolder.getFilesByType(MimeType.PLAIN_TEXT);
    while (txtFiles.hasNext()) {
        const f = txtFiles.next();
        if (f.getDescription() === sessionId && !f.isTrashed()) {
            fullTranscript = f.getBlob().getDataAsString() + "\n\n";
            Logger.log(`📄 既存の文字起こしテキストを利用します: ${f.getName()}`);
            break;
        }
    }

    // 2. 残っている音声チャンクを取得して不足分を補完
    const voiceFolder = DriveApp.getFolderById(CONFIG.VOICE_FOLDER_ID);
    const files = voiceFolder.getFiles();
    let chunks = [];
    while (files.hasNext()) {
        const file = files.next();
        const name = file.getName();
        if (name.startsWith(sessionId) && name.endsWith('.webm')) {
            chunks.push(file);
        }
    }

    // 3. どちらも見つからない場合はエラー
    if (!fullTranscript && chunks.length === 0) {
        throw new Error('No transcript or audio chunks found for session: ' + sessionId);
    }

    // 4. 残っているチャンクがあれば文字起こし実行
    if (chunks.length > 0) {
        chunks.sort((a, b) => a.getName().localeCompare(b.getName()));
        chunks.forEach(file => {
            const text = transcribeAudio(file.getBlob());
            if (text) {
                if (text.includes('SKIP') || text.length < CONFIG.MIN_TEXT_LENGTH) {
                    Logger.log(`⚠️ 有意な内容なしにつきスキップ: ${file.getName()}`);
                    return;
                }
                fullTranscript += text + '\n';
            }
        });
    }

    if (!fullTranscript.trim()) {
        throw new Error('Transcription failed for all chunks. Errors: ' + errors.join(', '));
    }

    // 3. 動画プラン生成
    const videoPlan = generateVideoPlan(fullTranscript);
    if (!videoPlan) throw new Error('Content generation failed');

    // 3.5. TTS生成 & BGM選定 (New logic)
    let audioFileId = '';
    try {
        // AIが調整したフル英語テキストをTTSに使用
        const ttsText = videoPlan.full_text_en || '';
        const voiceBlob = generateTTS(ttsText);
        if (voiceBlob) {
            const ttsFolder = DriveApp.getFolderById(CONFIG.TTS_FOLDER_ID);
            const audioFile = ttsFolder.createFile(voiceBlob).setName(`${sessionId}_voice.wav`);
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

    for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
        try {
            // 1. APIキー取得
            let bankUrl = `${CONFIG.BANK_URL}?pass=${CONFIG.BANK_PASS}&project=${CONFIG.PROJECT_NAME}`;
            if (previousModel) {
                bankUrl += `&error_503=true&previous_model=${encodeURIComponent(previousModel)}`;
            }

            const bankRes = UrlFetchApp.fetch(bankUrl, { muteHttpExceptions: true });
            const bankData = JSON.parse(bankRes.getContentText());

            // レート制限のハンドリング (biz-recより移植)
            if (bankData.status === 'rate_limited') {
                const waitMs = bankData.wait_ms || CONFIG.RETRY_DELAY;
                Logger.log(`⏳ レート制限: ${waitMs}ms 待機します`);
                Utilities.sleep(waitMs);
                attempt--;
                continue;
            }

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
                        { text: "音声を書き起こしてください。フィラー（えー、あー）は取り除いてください。もし無音、ノイズのみ、または「テストです」「あーあー」などの無意味な発言、あるいは挨拶のみで内容がない場合は、書き起こさずに「SKIP」とだけ返してください。理由などの付随するコメントは一切不要です。" },
                        { inline_data: { mime_type: 'audio/webm', data: base64Audio } }
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
                Utilities.sleep(CONFIG.RETRY_DELAY);
                continue;
            }

            const geminiData = JSON.parse(geminiRes.getContentText());
            if (geminiData.error) {
                reportError(api_key);
                throw new Error(JSON.stringify(geminiData.error));
            }

            return geminiData.candidates[0].content.parts[0].text;

        } catch (error) {
            Logger.log(`❌ 試行 ${attempt}/${CONFIG.MAX_RETRIES}: ${error.message}`);
            if (attempt === CONFIG.MAX_RETRIES) throw error;
            Utilities.sleep(CONFIG.RETRY_DELAY);
        }
    }
}

/**
 * 動画プランを生成する (Gemini LLM)
 */
function generateVideoPlan(transcript) {
    const SYSTEM_PROMPT = `
以下のステップを厳守して、TikTok用の動画台本をJSON形式で生成してください。意訳は一切禁止し、話し手の生のニュアンスを死守すること。
【重要】ここでは絶対にシーン分割（タイムスタンプ分け）をしないでください。一続きの「フルテキスト」として出力してください。

【処理プロセス】
1. そのまま英訳: 入力された日本語の書き起こし内容を、生のニュアンスを一切損なわず、そのまま忠実に英語へ翻訳してください（意訳厳禁）。
2. ボリューム調整: その英語をベースに、動画尺が【25秒前後】、英語語数が【75〜85語】、日本語文字数が【450〜500文字】程度になるよう、生の言葉を活かしたまま分量を調整してください。
3. 日本語訳: ステップ2で調整が完了した「一続きの英語」をベースに、元の熱量と口癖などを維持したまま日本語訳を作成してください。

【出力要件】
- hook: 調整後のテキストから抽出した、冒頭0.5秒で惹きつける英語のキャッチコピー。
- full_text_en: ステップ2で作成した、25秒相当（75〜85語）の一続きのフル英語テキスト（分割厳禁）。
- full_text_ja: ステップ3で作成した、一続きの日本語テキスト（分割厳禁）。
- caption_ja: 話し手の生のニュアンスや熱量をそのまま反映した日本語の投稿本文。
- caption_en: 英語の投稿本文。
- hashtags: 英語のトレンドタグ5つ。
- bgm: ジャンル選択 ["chill", "energy"]。
- design: デザインテーマ設定。

【ルール】
- 意訳・きれいな要約は厳禁です。
- 指定された語数（75-85語）と文字数（450-500文字）のバランスを極限まで追求してください。
- ここでは一切のタイムスタンプやシーン分けの情報を出力しないでください。
- Markdownコードブロックは不要。純粋なJSONのみを出力。
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

    for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
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
                Utilities.sleep(CONFIG.RETRY_DELAY);
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
            if (attempt === CONFIG.MAX_RETRIES) throw error;
            Utilities.sleep(CONFIG.RETRY_DELAY);
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

// ==========================================
// 6. Polling & Background Processing (Merged from biz-rec)
// ==========================================

/**
 * トリガー実行用: 音声ファイルをスキャンして逐次文字起こし
 */
function processVoiceFiles() {
    const voiceFolder = DriveApp.getFolderById(CONFIG.VOICE_FOLDER_ID);
    const fileEntries = [];
    const files = voiceFolder.getFiles();

    // 1. ファイルを一旦リスト化して名前（時刻順）でソート
    while (files.hasNext()) {
        const file = files.next();
        if (file.getName().endsWith('.webm')) {
            fileEntries.push(file);
        }
    }

    // 昇順ソート（古い録音から順に処理）
    fileEntries.sort((a, b) => a.getName().localeCompare(b.getName()));

    Logger.log(`=== 処理開始: 音声ファイルスキャン (${fileEntries.length}件) ===`);
    let count = 0;

    for (const file of fileEntries) {
        const fileName = file.getName();
        try {
            Logger.log(`🎤 処理開始: ${fileName}`);

            // 文字起こし実行
            const text = transcribeAudio(file.getBlob());

            // 有意性判定
            if (!text || text.includes('SKIP') || text.length < CONFIG.MIN_TEXT_LENGTH) {
                Logger.log(`⚠️ 有意な内容なしと判定し破棄します: "${text || '(空文字)'}"`);
                file.setTrashed(true);
                continue;
            }

            // テキスト保存（排他制御・高速検索・インデックス遅延対策）
            saveTextToSessionFile(fileName, text);

            // 処理済み音声ファイルは即時削除
            file.setTrashed(true);
            Logger.log(`🗑️ 元音声ファイル削除: ${fileName}`);

            count++;
        } catch (e) {
            Logger.log(`❌ エラー (${fileName}): ${e.message}`);
        }
    }

    Logger.log(`=== 処理完了: ${count}件 ===`);
}

/**
 * チャンクごとのテキストをセッションファイルに保存 (biz-recより移植)
 */
function saveTextToSessionFile(originalFileName, text) {
    const lock = LockService.getScriptLock();
    try {
        lock.waitLock(30000);
    } catch (e) {
        throw new Error('Lock timeout');
    }

    try {
        const txtFolder = DriveApp.getFolderById(CONFIG.TXT_FOLDER_ID);

        // SessionIDの特定 (対応形式: 20240206_120000_chunk01.webm または 240206_120000_chunk01.webm)
        const sessionMatch = originalFileName.match(/^(.+)_chunk\d{2}\.webm$/);
        const sessionId = sessionMatch ? sessionMatch[1] : originalFileName.replace('.webm', '');

        // 日付文字列の取得 (YYMMDD)
        const dateMatch = sessionId.match(/^(\d{2,4})(\d{2})(\d{2})/);
        const dateStr = dateMatch ? (dateMatch[1].slice(-2) + dateMatch[2] + dateMatch[3]) : '000000';

        const chunkMatch = originalFileName.match(/_chunk(\d{2})\.webm$/);
        const chunkNum = chunkMatch ? chunkMatch[1] : '00';
        const appendContent = `\n\n--- Chunk ${chunkNum} (${new Date().toLocaleTimeString()}) ---\n${text}`;

        // 1. 既存セッションファイルの検索
        let targetFile = null;
        const allFiles = txtFolder.getFiles();

        while (allFiles.hasNext()) {
            const f = allFiles.next();
            // 名前でまず絞り込み (YYMMDD_XX.txt)
            if (f.getName().indexOf(dateStr + "_") !== -1 && !f.isTrashed()) {
                // メタデータのSessionIDをチェック
                if (f.getDescription() === sessionId) {
                    targetFile = f;
                    break;
                }
                // インデックス反映遅延対策：中身に含まれるIDをチェック
                if (new Date().getTime() - f.getLastUpdated().getTime() < 120000) {
                    const content = f.getBlob().getDataAsString();
                    if (content.indexOf(`Original Session: ${sessionId}`) !== -1) {
                        targetFile = f;
                        if (!targetFile.getDescription()) targetFile.setDescription(sessionId);
                        break;
                    }
                }
            }
        }

        if (targetFile) {
            // 追記
            const currentContent = targetFile.getBlob().getDataAsString();
            targetFile.setContent(currentContent + appendContent);
            Logger.log(`📝 既存ファイル(${targetFile.getName()})に追記: ${sessionId}`);
        } else {
            // 新規作成: txtフォルダとarchフォルダをスキャンして最大連番を特定
            let maxNum = 0;
            const foldersToScan = [CONFIG.TXT_FOLDER_ID, CONFIG.ARCH_FOLDER_ID];

            foldersToScan.forEach(folderId => {
                if (!folderId) return;
                try {
                    const folder = DriveApp.getFolderById(folderId);
                    const files = folder.getFiles();
                    while (files.hasNext()) {
                        const f = files.next();
                        const fName = f.getName();
                        if (fName.indexOf(dateStr + "_") === 0 && fName.endsWith(".txt") && !f.isTrashed()) {
                            const m = fName.match(/_(\d{2})\.txt$/);
                            if (m) {
                                const n = parseInt(m[1], 10);
                                if (n > maxNum) maxNum = n;
                            }
                        }
                    }
                } catch (err) {
                    Logger.log(`⚠️ フォルダスキャン失敗: ${err.message}`);
                }
            });

            const nextNum = (maxNum + 1).toString().padStart(2, '0');
            const targetFileName = `${dateStr}_${nextNum}.txt`;

            const header = `=== 録音記録 ===\nOriginal Session: ${sessionId}\nFile Name: ${targetFileName}\n作成開始: ${new Date().toLocaleString()}\n`;
            const newFile = txtFolder.createFile(targetFileName, header + appendContent, MimeType.PLAIN_TEXT);

            newFile.setDescription(sessionId);
            Logger.log(`🆕 新規セッションファイル作成: ${targetFileName} (Session: ${sessionId})`);
        }

    } finally {
        lock.releaseLock();
    }
}

// ==========================================
// 7. Utility: Generate TTS from existing transcript file
// ==========================================

/**
 * スプレッドシートのG列（本文 英）から台本を読み取り、TTS(音声)を生成してN列に保存する
 */
function generateAudioFromSheet(sessionId) {
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
    const data = sheet.getDataRange().getValues();

    let targetRow = -1;
    let ttsText = "";

    // 最新の行（下から）を優先して検索
    for (let i = data.length - 1; i >= 1; i--) {
        if (data[i][0] == sessionId) {
            targetRow = i + 1;
            ttsText = data[i][6]; // G列 (Index 6): 本文（英）
            break;
        }
    }

    if (targetRow === -1) throw new Error("指定されたSessionIDがスプレッドシートに見つかりません: " + sessionId);
    if (!ttsText) throw new Error("G列（本文 英）が空です。");

    Logger.log(`🎤 スプレッドシートから台本取得成功 (Row: ${targetRow})`);
    Logger.log(`📜 本文(英): ${ttsText.substring(0, 50)}...`);
    Logger.log(`📏 Word Count: ${ttsText.split(' ').length}`);

    // TTS生成
    const voiceBlob = generateTTS(ttsText);
    if (!voiceBlob) throw new Error("TTS生成に失敗しました。");

    const ttsFolder = DriveApp.getFolderById(CONFIG.TTS_FOLDER_ID);
    const audioFile = ttsFolder.createFile(voiceBlob).setName(`${sessionId}_voice.wav`);
    const audioFileId = audioFile.getId();

    // N列 (Index 13) に音声IDを書き込み
    sheet.getRange(targetRow, 14).setValue(audioFileId);

    Logger.log(`✅ 音声ファイル作成完了 & シート更新成功: ${audioFileId}`);

    return {
        status: 'success',
        row: targetRow,
        audioFileId: audioFileId
    };
}

/**
 * テスト実行用: シートの最新の英文から音声を生成
 */
function runGenerateAudioFromLastSheetRow() {
    const sessionId = "260206_153443"; // ターゲットのID
    const result = generateAudioFromSheet(sessionId);
    Logger.log(result);
}
